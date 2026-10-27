import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { fixture, pluginsRoot } from "./helpers.js";

it("meters a System One platform fallback only after an explicit personal rejection", async () => {
  let personalCalls = 0;
  let platformCalls = 0;
  let behavior: "reject" | "unknown" = "reject";
  const f = await fixture(
    ["users", "auth", "billing", "rate-limit", "observability", "byok"],
    { billing: { enabled: true, reserveOutputTokens: 64 } },
    async (kernel, directory) => {
      (globalThis as any).__jevFallbackTransport = (input: any) => {
        const request = JSON.parse(input.body);
        if (input.url.includes("personal.example")) {
          personalCalls++;
          if (behavior === "unknown")
            throw new Error("response unavailable after dispatch");
          return new Response("rejected", { status: 429 });
        }
        platformCalls++;
        expect(request.model).toBe("platform-jev");
        expect(input.headers.authorization).toBe("Bearer platform-secret");
        return Response.json({
          model: "platform-jev",
          answers: { route: { type: "choice", choice: "fast" } },
          usage: { input_tokens: 5, output_tokens: 3 },
        });
      };
      const transport = join(directory, "transport");
      await mkdir(transport);
      await writeFile(
        join(transport, "manifest.json"),
        JSON.stringify({
          schemaVersion: 1,
          id: "test.jev-fallback-transport",
          version: "1.0.0",
          host: ">=0.1.0-alpha.1",
          runtime: { kind: "native", entry: "index.js" },
          provides: ["http.transport@1"],
          requires: [],
          permissions: [],
          configReload: "snapshot",
        }),
      );
      await writeFile(
        join(transport, "index.js"),
        'export default {setup(h){h.provide("http.transport@1",i=>globalThis.__jevFallbackTransport(i));}}',
      );
      await kernel.add(transport, { grants: [] });

      const router = join(directory, "router");
      await mkdir(router);
      await cp(join(pluginsRoot, "ai-router", "dist"), join(router, "dist"), {
        recursive: true,
      });
      const manifest = JSON.parse(
        await readFile(join(pluginsRoot, "ai-router", "manifest.json"), "utf8"),
      );
      manifest.runtime.entry = "wrapper.mjs";
      await writeFile(join(router, "manifest.json"), JSON.stringify(manifest));
      await writeFile(
        join(router, "wrapper.mjs"),
        `
        import router from ${JSON.stringify(pathToFileURL(join(router, "dist", "index.js")).href)};
        export default { async setup(host) {
          await router.setup(host);
          host.route({method:'POST',path:'/v1/test-jev-fallback',access:'authenticated',async handle(req) {
            const {channelId,...payload} = await req.json();
            const response = await host.dispatchChild(new Request('http://localhost/internal/workflow/jev', {
              method:'POST',headers:{'content-type':'application/json','x-pluhub-channel':channelId},body:JSON.stringify(payload)
            }), {nodeId:'decision'});
            const headers = new Headers(response.headers);
            headers.set('x-child-request-id', response.headers.get('x-pluhub-request-id'));
            return new Response(response.body,{status:response.status,headers});
          }});
        }};
      `,
      );
      kernel.secrets.put("platform-secret", "secret:PLATFORM_JEV");
      await kernel.add(router, {
        grants: manifest.permissions,
        config: {
          secretRefs: ["secret:PLATFORM_JEV"],
          upstreams: {
            paid: {
              protocol: "systemone",
              baseUrl: "https://platform.example/v1",
              keyRef: "secret:PLATFORM_JEV",
            },
          },
          models: {
            "paid-model": {
              upstream: "paid",
              model: "platform-jev",
              inputPrice: 2,
              outputPrice: 3,
            },
          },
          groups: { team: { name: "Team", channelIds: ["paid"] } },
        },
      });
    },
  );
  try {
    const admin = await f.admin();
    const me = await f.kernel.invoke<any>("users.lookup@1", {
      username: "admin",
    });
    await f.kernel.invoke("billing.credit@1", {
      userId: me.id,
      amount: 1_000_000,
      source: "jev-fallback",
    });
    const created = await f.request(
      "/api/plugins/official.byok/personal-channels",
      "POST",
      {
        name: "Personal Jev",
        preset: "custom",
        protocol: "systemone",
        baseUrl: "https://personal.example/v1",
        key: "personal-secret",
        models: { "personal-model": { model: "personal-jev" } },
        flow: {
          entry: "start",
          nodes: [
            { id: "start", type: "start", next: "provider" },
            { id: "provider", type: "provider", fallback: "group" },
            {
              id: "group",
              type: "platform",
              groupId: "team",
              model: "paid-model",
            },
          ],
        },
      },
      admin,
    );
    expect(created.status, await created.clone().text()).toBe(201);
    const channel = await created.json();
    const payload = {
      model: "personal-model",
      channelId: channel.id,
      state: "question",
      questions: {
        route: {
          type: "choice",
          instructions: "choose",
          criteria: { fast: "simple" },
        },
      },
    };
    const response = await f.request(
      "/v1/test-jev-fallback",
      "POST",
      payload,
      admin,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const childId = response.headers.get("x-child-request-id")!;
    const parentId = response.headers.get("x-pluhub-request-id")!;
    expect((await response.json()).answers.route.choice).toBe("fast");
    expect([personalCalls, platformCalls]).toEqual([1, 1]);
    expect(
      await f.kernel.invoke<any>("billing.balance@1", { userId: me.id }),
    ).toMatchObject({ balance: 999981, held: 0 });
    const logs = new DatabaseSync(
      join(f.config.dataDir, "official.observability", "requests.sqlite"),
    );
    try {
      expect(
        logs
          .prepare(
            "SELECT parent_request_id,workflow_node_id,billing_mode,consumption_source,input_tokens,output_tokens FROM requests WHERE id=?",
          )
          .get(childId),
      ).toMatchObject({
        parent_request_id: parentId,
        workflow_node_id: "decision",
        billing_mode: "platform",
        consumption_source: "platform",
        input_tokens: 5,
        output_tokens: 3,
      });
    } finally {
      logs.close();
    }

    behavior = "unknown";
    const uncertain = await f.request(
      "/v1/test-jev-fallback",
      "POST",
      payload,
      admin,
    );
    expect(uncertain.status).toBeGreaterThanOrEqual(400);
    await uncertain.text();
    expect([personalCalls, platformCalls]).toEqual([2, 1]);
    expect(
      (await f.kernel.invoke<any>("billing.balance@1", { userId: me.id }))
        .balance,
    ).toBe(999981);
  } finally {
    delete (globalThis as any).__jevFallbackTransport;
    await f.close();
  }
});
