import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { fixture, pluginsRoot } from "./helpers.js";

it("keeps internal provider calls private and settles each child independently", async () => {
  const f = await fixture(
    ["users", "auth", "billing", "rate-limit", "observability"],
    { billing: { enabled: true, reserveOutputTokens: 64 } },
    async (kernel, directory) => {
      const router = join(directory, "router");
      await mkdir(router);
      await cp(join(pluginsRoot, "ai-router", "dist"), join(router, "dist"), {
        recursive: true,
      });
      const manifest = JSON.parse(
        await readFile(join(pluginsRoot, "ai-router", "manifest.json"), "utf8"),
      );
      manifest.permissions = [
        ...new Set([...manifest.permissions, "http.dispatch.child"]),
      ];
      manifest.provides.push("test.workflow-provider-results@1");
      manifest.runtime.entry = "wrapper.mjs";
      await writeFile(join(router, "manifest.json"), JSON.stringify(manifest));
      await writeFile(
        join(router, "wrapper.mjs"),
        `
        import router from ${JSON.stringify(pathToFileURL(join(router, "dist", "index.js")).href)};
        export default { async setup(host) {
          await router.setup(host);
          const outcomes=[];
          host.provide('test.workflow-provider-results@1',()=>outcomes);
          host.route({method:'POST',path:'/v1/test-workflow-parent',access:'authenticated',async handle(req,ctx) {
            const {stream=false,cancel=false} = await req.json();
            const task = {model:'public',messages:[{role:'user',text:cancel?'cancel':'hello'}],tools:[],stream,maxTokens:16};
            const plan = await host.call('ai.routing@2', {model:task.model,request:task,
              ingressProtocol:'openai-chat',features:['text','usage'],principalId:ctx.principal.id}, ctx.signal);
            const child = await host.dispatchChild(new Request('http://localhost/internal/workflow/provider', {
              method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({request:task,protocol:'openai-chat'})
            }), {nodeId:'provider',plan,onComplete: outcome=>outcomes.push(outcome)});
            const childId = child.headers.get('x-pluhub-request-id');
            if (cancel && child.body) {
              const reader = child.body.getReader();
              await reader.read();
              await reader.cancel('test cancellation');
              return Response.json({childId,status:child.status});
            }
            const headers = new Headers(child.headers);
            headers.set('x-child-request-id',childId);
            return new Response(child.body,{status:child.status,headers});
          }});
        }};
      `,
      );
      await kernel.add(router, {
        grants: manifest.permissions,
        config: {
          upstreams: {
            p: {
              protocol: "openai-chat",
              baseUrl: "https://example.invalid/v1",
              keyRef: "secret:test",
            },
          },
          models: {
            public: {
              upstream: "p",
              model: "actual",
              inputPrice: 2,
              outputPrice: 3,
            },
          },
        },
      });
      const mock = join(directory, "mock-upstream");
      await mkdir(mock);
      await writeFile(
        join(mock, "manifest.json"),
        JSON.stringify({
          schemaVersion: 1,
          id: "test.workflow-provider",
          version: "1.0.0",
          host: ">=0.1.0-alpha.1",
          runtime: { kind: "native", entry: "index.mjs" },
          provides: ["ai.upstream.openai-chat@1"],
          requires: [],
          permissions: [],
          configReload: "snapshot",
        }),
      );
      await writeFile(
        join(mock, "index.mjs"),
        `
        export default {setup(host){host.provide('ai.upstream.openai-chat@1', ({request}, signal) => (async function*(){
          yield {type:'text',text:'hello'};
          if(request.messages[0].text === 'cancel') await new Promise((resolve,reject) => {
            if(signal.aborted) reject(signal.reason);
            else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
          });
          yield {type:'usage',usage:{input:5,output:3}};
          yield {type:'finish',reason:'stop'};
        })());}};
      `,
      );
      await kernel.add(mock, { grants: [] });
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
      source: "workflow-provider-test",
    });
    const direct = await f.request(
      "/internal/workflow/provider",
      "POST",
      {},
      admin,
    );
    expect(direct.status).toBe(404);
    await direct.text();

    const children: string[] = [];
    for (const stream of [false, true]) {
      const result = await f.request(
        "/v1/test-workflow-parent",
        "POST",
        { stream },
        admin,
      );
      expect(result.status, await result.clone().text()).toBe(200);
      const child = result.headers.get("x-child-request-id")!;
      expect(child).toBeTruthy();
      expect(child).not.toBe(result.headers.get("x-pluhub-request-id"));
      expect(await result.text()).toContain("hello");
      children.push(child);
    }
    const cancelled = await f.request(
      "/v1/test-workflow-parent",
      "POST",
      { stream: true, cancel: true },
      admin,
    );
    expect(cancelled.status, await cancelled.clone().text()).toBe(200);
    const cancelledBody = await cancelled.json();
    expect(cancelledBody.status).toBe(200);
    children.push(cancelledBody.childId);
    const outcomes = await f.kernel.invoke<any[]>(
      "test.workflow-provider-results@1",
    );
    expect(outcomes).toHaveLength(3);
    expect(outcomes.slice(0, 2)).toEqual([
      expect.objectContaining({
        status: 200,
        cancelled: false,
        result: { finished: true },
      }),
      expect.objectContaining({
        status: 200,
        cancelled: false,
        result: { finished: true },
      }),
    ]);
    expect(outcomes[2]).toMatchObject({
      status: 200,
      cancelled: true,
      result: { finished: false },
    });

    const db = new DatabaseSync(
      join(f.config.dataDir, "official.billing", "billing.sqlite"),
    );
    try {
      const rows = children.map(
        (id) =>
          db
            .prepare("SELECT status, actual FROM reservations WHERE id=?")
            .get(id) as any,
      );
      expect(rows.slice(0, 2)).toEqual([
        expect.objectContaining({ status: "settled", actual: 19 }),
        expect.objectContaining({ status: "settled", actual: 19 }),
      ]);
      expect(rows[2].status).toBe("settled");
    } finally {
      db.close();
    }
    const logs = new DatabaseSync(
      join(f.config.dataDir, "official.observability", "requests.sqlite"),
    );
    try {
      for (const id of children) {
        const row = logs
          .prepare(
            "SELECT parent_request_id,workflow_node_id FROM requests WHERE id=?",
          )
          .get(id) as any;
        expect(row.parent_request_id).toBeTruthy();
        expect(row.parent_request_id).not.toBe(id);
        expect(row.workflow_node_id).toBe("provider");
      }
    } finally {
      logs.close();
    }
  } finally {
    await f.close();
  }
});
