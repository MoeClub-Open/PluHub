import { createServer } from "node:http";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { fixture, pluginsRoot } from "./helpers.js";

it("authorizes, records and settles each Jev workflow request independently", async () => {
  let behavior: "success" | "missing-usage" | "rejected" | "malformed" =
    "success";
  const received: {
    body: any;
    authorization: string | undefined;
    path: string | undefined;
  }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({
      body: JSON.parse(Buffer.concat(chunks).toString()),
      authorization: req.headers.authorization,
      path: req.url,
    });
    if (behavior === "rejected") {
      res.writeHead(429);
      res.end();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        model: "jev-gray",
        answers:
          behavior === "malformed"
            ? {}
            : { route: { type: "choice", choice: "fast" } },
        ...(behavior !== "missing-usage"
          ? { usage: { input_tokens: 5, output_tokens: 3 } }
          : {}),
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const f = await fixture(
    [
      "users",
      "auth",
      "billing",
      "rate-limit",
      "observability",
      "http-transport",
      "byok",
    ],
    {
      billing: { enabled: true, reserveOutputTokens: 64 },
      byok: {
        allowedPrivateOrigins: [
          `http://127.0.0.1:${(server.address() as any).port}`,
        ],
      },
    },
    async (kernel, directory) => {
      const router = join(directory, "router");
      await mkdir(router);
      await cp(join(pluginsRoot, "ai-router", "dist"), join(router, "dist"), {
        recursive: true,
      });
      const manifest = JSON.parse(
        await readFile(join(pluginsRoot, "ai-router", "manifest.json"), "utf8"),
      );
      manifest.runtime.entry = "wrapper.mjs";
      manifest.permissions = [
        ...new Set([...manifest.permissions, "http.dispatch.child"]),
      ];
      await writeFile(join(router, "manifest.json"), JSON.stringify(manifest));
      await writeFile(
        join(router, "wrapper.mjs"),
        `
        import router from ${JSON.stringify(pathToFileURL(join(router, "dist", "index.js")).href)};
        export default { async setup(host) {
          await router.setup(host);
          host.route({method:'POST',path:'/v1/test-jev-parent',access:'authenticated',async handle(req) {
            const {channelId,...payload} = await req.json();
            const child = await host.dispatchChild(new Request('http://localhost/internal/workflow/jev', {
              method:'POST',headers:{'content-type':'application/json',...(channelId?{'x-pluhub-channel':channelId}:{})},body:JSON.stringify(payload)
            }), {nodeId:'classify'});
            const headers = new Headers(child.headers);
            headers.set('x-child-request-id', child.headers.get('x-pluhub-request-id'));
            return new Response(child.body,{status:child.status,headers});
          }});
        }};
      `,
      );
      kernel.secrets.put("jev-test-key", "secret:JEV_TEST");
      await kernel.add(router, {
        grants: manifest.permissions,
        config: {
          secretRefs: ["secret:JEV_TEST"],
          upstreams: {
            decision: {
              protocol: "systemone",
              baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
              keyRef: "secret:JEV_TEST",
            },
          },
          models: {
            jev: {
              upstream: "decision",
              model: "jev-upstream",
              inputPrice: 2,
              outputPrice: 3,
            },
          },
        },
      });
    },
  );
  try {
    const admin = await f.admin();
    const user = await f.kernel.invoke<any>("users.lookup@1", {
      username: "admin",
    });
    await f.kernel.invoke("billing.credit@1", {
      userId: user.id,
      amount: 1_000_000,
      source: "workflow-jev-test",
    });
    const payload = {
      model: "jev",
      state: { input: "classify this" },
      questions: {
        route: {
          type: "choice",
          instructions: "choose",
          criteria: { fast: "simple", strong: "difficult" },
        },
      },
    };
    const direct = await f.request(
      "/internal/workflow/jev",
      "POST",
      payload,
      admin,
    );
    expect(direct.status).toBe(404);
    await direct.text();
    expect(received).toHaveLength(0);

    const rows: { id: string; parent: string; response: any }[] = [];
    for (const next of [
      "success",
      "missing-usage",
      "rejected",
      "malformed",
    ] as const) {
      behavior = next;
      const response = await f.request(
        "/v1/test-jev-parent",
        "POST",
        payload,
        admin,
      );
      const id = response.headers.get("x-child-request-id")!;
      const parent = response.headers.get("x-pluhub-request-id")!;
      expect(id).toBeTruthy();
      expect(id).not.toBe(parent);
      if (next === "success" || next === "missing-usage")
        expect(response.status, await response.clone().text()).toBe(200);
      else expect(response.status).toBeGreaterThanOrEqual(400);
      rows.push({ id, parent, response: await response.json() });
    }
    expect(rows[0]!.response).toMatchObject({
      model: "jev-gray",
      answers: { route: { choice: "fast" } },
      usage: { input: 5, output: 3 },
    });
    expect(rows[1]!.response).not.toHaveProperty("usage");
    expect(received).toHaveLength(4);
    expect(received[0]).toMatchObject({
      path: "/v1/systemone",
      authorization: "Bearer jev-test-key",
      body: { ...payload, model: "jev-upstream" },
    });

    const billing = new DatabaseSync(
      join(f.config.dataDir, "official.billing", "billing.sqlite"),
    );
    try {
      const reservations = rows.map(
        ({ id }) =>
          billing
            .prepare(
              "SELECT status,actual,reported_usage,budget FROM reservations WHERE id=?",
            )
            .get(id) as any,
      );
      expect(reservations.map((r) => r.status)).toEqual([
        "settled",
        "review",
        "released",
        "review",
      ]);
      expect(reservations[0].actual).toBe(19);
      expect(JSON.parse(reservations[0].budget).mode).toBe("estimate");
      expect(JSON.parse(reservations[3].reported_usage)).toMatchObject({
        input: 5,
        output: 3,
      });
    } finally {
      billing.close();
    }
    const logs = new DatabaseSync(
      join(f.config.dataDir, "official.observability", "requests.sqlite"),
    );
    try {
      for (const { id, parent } of rows) {
        const row = logs.prepare("SELECT * FROM requests WHERE id=?").get(id);
        expect(row).toMatchObject({
          parent_request_id: parent,
          workflow_node_id: "classify",
          protocol: "systemone",
        });
        expect(JSON.stringify(row)).not.toContain("classify this");
        expect(JSON.stringify(row)).not.toContain("jev-test-key");
      }
    } finally {
      logs.close();
    }

    const keyResponse = await f.request(
      "/api/plugins/official.auth/keys",
      "POST",
      { name: "restricted", models: ["other"] },
      admin,
    );
    expect(keyResponse.status).toBe(201);
    const key = await keyResponse.json();
    const denied = await f.request("/v1/test-jev-parent", "POST", payload, {
      authorization: `Bearer ${key.token}`,
    });
    expect(denied.status).toBe(403);
    await denied.text();
    expect(received).toHaveLength(4);

    const personalSettings = {
      name: "Personal Jev",
      preset: "custom",
      protocol: "systemone",
      baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
      key: "personal-jev-key",
      models: { "jev-personal": { model: "personal-upstream" } },
      flow: {
        entry: "start",
        nodes: [
          { id: "start", type: "start", next: "provider" },
          { id: "provider", type: "provider" },
        ],
      },
    };
    const ordinaryInterface = {
      incoming: ["openai-chat"],
      protocol: "openai-chat",
    };
    const mixedTopLevel = await f.request(
      "/api/plugins/official.byok/personal-channels",
      "POST",
      {
        ...personalSettings,
        interfaces: [ordinaryInterface],
      },
      admin,
    );
    expect(mixedTopLevel.status).toBe(400);
    await mixedTopLevel.text();
    const mixedNode = await f.request(
      "/api/plugins/official.byok/personal-channels",
      "POST",
      {
        ...personalSettings,
        flow: {
          entry: "start",
          nodes: [
            { id: "start", type: "start", next: "provider" },
            {
              id: "provider",
              type: "provider",
              interfaces: [ordinaryInterface],
            },
          ],
        },
      },
      admin,
    );
    expect(mixedNode.status).toBe(400);
    await mixedNode.text();
    const forbiddenPrivate = await f.request(
      "/api/plugins/official.byok/personal-channels",
      "POST",
      {
        ...personalSettings,
        baseUrl: `http://127.0.0.2:${(server.address() as any).port}/v1`,
      },
      admin,
    );
    expect(forbiddenPrivate.status).toBeGreaterThanOrEqual(400);
    await forbiddenPrivate.text();
    const created = await f.request(
      "/api/plugins/official.byok/personal-channels",
      "POST",
      personalSettings,
      admin,
    );
    expect(created.status, await created.clone().text()).toBe(201);
    const personal = await created.json();
    behavior = "success";
    const personalRequest = {
      ...payload,
      model: "jev-personal",
      channelId: personal.id,
    };
    const before = await f.kernel.invoke<any>("billing.balance@1", {
      userId: user.id,
    });
    const personalResult = await f.request(
      "/v1/test-jev-parent",
      "POST",
      personalRequest,
      admin,
    );
    expect(personalResult.status, await personalResult.clone().text()).toBe(
      200,
    );
    const personalId = personalResult.headers.get("x-child-request-id")!;
    await personalResult.text();
    expect(received.at(-1)).toMatchObject({
      authorization: "Bearer personal-jev-key",
      body: { ...payload, model: "personal-upstream" },
    });
    expect(
      (await f.kernel.invoke<any>("billing.balance@1", { userId: user.id }))
        .balance,
    ).toBe(before.balance);
    const personalLog = new DatabaseSync(
      join(f.config.dataDir, "official.observability", "requests.sqlite"),
    );
    try {
      expect(
        personalLog
          .prepare(
            "SELECT billing_mode,consumption_source FROM requests WHERE id=?",
          )
          .get(personalId),
      ).toMatchObject({
        billing_mode: "personal",
        consumption_source: "byoapi",
      });
    } finally {
      personalLog.close();
    }

    const other = await f.kernel.invoke<any>("users.manage@1", {
      action: "create",
      username: "other",
      role: "user",
    });
    await f.kernel.invoke("auth.bootstrap@1", {
      userId: other.id,
      password: "other-test-password",
    });
    const login = await f.request("/api/plugins/official.auth/login", "POST", {
      username: "other",
      password: "other-test-password",
    });
    const otherCookie = login.headers.get("set-cookie")!.split(";")[0]!;
    await login.text();
    const foreign = await f.request(
      "/v1/test-jev-parent",
      "POST",
      personalRequest,
      { cookie: otherCookie },
    );
    expect(foreign.status).toBeGreaterThanOrEqual(400);
    await foreign.text();
    expect(received).toHaveLength(5);
  } finally {
    await f.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
