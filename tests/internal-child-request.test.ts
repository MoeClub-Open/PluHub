import { describe, expect, it } from "vitest";
import { mockHost } from "../packages/testkit/dist/index.js";
import type { Manifest } from "../packages/sdk/dist/index.js";

const manifest = (
  id: string,
  permissions: string[],
  provides: string[] = [],
): Manifest => ({
  schemaVersion: 1,
  id,
  version: "1.0.0",
  host: ">=0.1.0-alpha.1",
  runtime: { kind: "native", entry: "index.mjs" },
  provides,
  requires: [],
  permissions,
  configReload: "snapshot",
});

const router = `
export default { setup(h) {
  let identityCalls = 0, waiting = false, childStarted = false, resume;
  let finalizeWaiting = false, cancelReturned = false, resumeFinalize;
  const finalized = [], completions = [];
  h.identity(async request => {
    identityCalls++;
    return request.headers.has('authorization') ? { id: 'alice', permissions: ['*'] } : undefined;
  });
  h.hook({id:'finish',phase:'Finalize',async handle(ctx) {
    if(ctx.state.get('delay-finalize')) {
      finalizeWaiting = true;
      await new Promise(resolve => { resumeFinalize = resolve; });
    }
    if(ctx.parent?.nodeId === 'node-a') ctx.state.set('internal.result',{usage:{input:3,output:4}});
    finalized.push({id:ctx.id,parent:ctx.parent,status:ctx.state.get('http.status'),cancelled:ctx.state.get('http.cancelled'),error:ctx.state.get('http.errorCode')});
  }});
  h.provide('test.child-state@1',()=>({identityCalls, finalized, completions, waiting, childStarted, finalizeWaiting, cancelReturned}));
  h.provide('test.child-resume@1',()=>resume?.());
  h.provide('test.finalize-resume@1',()=>resumeFinalize?.());
  h.provide('test.get-context@1',()=>h.requestContext({callers:['test.router','test.ingress']}));
  h.provide('ai.workflow-execution@1',()=>({ok:true}),{callers:['test.router','test.ingress']});
  h.route({method:'POST',path:'/outer',access:'authenticated',async handle(request,ctx) {
    const { action } = await request.json();
    ctx.state.set('parent-only','secret');
    const contextMatches = h.requestContext({callers:['test.router','test.ingress']}) === ctx && h.requestContext({callers:['test.router','test.ingress']}).principal.id === 'alice';
    if(action === 'snapshot') { waiting = true; await new Promise(resolve => { resume = resolve; }); }
    const childAbort = new AbortController();
    const child = await h.dispatchChild(new Request('http://test/internal/workflow/provider', {
      method:'POST', body:JSON.stringify({action}), headers:{'content-type':'application/json'}, signal:childAbort.signal
    }), {nodeId:'node-a', plan:{selected:'bound'}, delegatedModel:'authorized-model',
      onComplete: outcome => completions.push({outcome,childWasFinalized:finalized.some(row=>row.parent?.requestId===ctx.id)})});
    if(action === 'delayed-cancel') {
      childAbort.abort();
      while(!finalizeWaiting) await new Promise(resolve => setTimeout(resolve,0));
      await child.body.cancel(); cancelReturned = true; return Response.json({parentId:ctx.id});
    }
    if(action === 'cancel') { await child.body.cancel(); return Response.json({parentId:ctx.id,childStatus:child.status,contextMatches}); }
    return Response.json({parentId:ctx.id,parentVersion:ctx.graphVersion,childStatus:child.status,contextMatches,child:await child.json()});
  }});
  h.route({internal:true,childCallers:['test.router'],method:'POST',path:'/internal/workflow/provider',access:'authenticated',async handle(request,ctx) {
    const {action} = await request.json();
    if(action === 'failure') throw Object.assign(new Error('failure'),{status:502,code:'upstream_error'});
    if(action === 'delayed-cancel') { ctx.state.set('delay-finalize',true); return new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array([1]))}})); }
    if(action === 'cancel') return new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array([1]))}}));
    if(action === 'parent-cancel') return new Response(new ReadableStream({start(){childStarted=true}}));
    if(action === 'recurse') {
      const next = await h.dispatchChild(new Request('http://test/internal/workflow/provider',{
        method:'POST',body:JSON.stringify({action})
      }),{nodeId:'nested'});
      return Response.json({depth:ctx.parent.depth,nextStatus:next.status,next:await next.json()});
    }
    return Response.json({id:ctx.id,parent:ctx.parent,version:ctx.graphVersion,principal:ctx.principal.id,
      hasParentState:ctx.state.has('parent-only'),plan:ctx.state.get('internal.plan'),delegatedModel:ctx.state.get('internal.delegatedModel'),config:h.config().value});
  }});
}}`;

async function fixture() {
  const f = await mockHost();
  await f.plugin(
    manifest(
      "test.router",
      [
        "http.route",
        "http.dispatch.child",
        "identity.provide",
        "hooks.register",
      ],
      [
        "test.child-state@1",
        "test.child-resume@1",
        "test.finalize-resume@1",
        "test.get-context@1",
        "ai.workflow-execution@1",
      ],
    ),
    router,
  );
  await f.plugin(
    {
      ...manifest(
        "test.other",
        ["http.route", "http.dispatch.child"],
        ["test.proxy-context@1"],
      ),
      requires: ["ai.workflow-execution@1", "test.get-context@1"],
    },
    `
export default {setup(h){h.provide('test.proxy-context@1',()=>h.call('test.get-context@1'));h.route({method:'POST',path:'/other',access:'authenticated',async handle(){
  try { await h.dispatchChild(new Request('http://test/internal/workflow/provider',{method:'POST'}),{nodeId:'x',plan:{price:0}}); return new Response('allowed'); }
  catch(error) { return Response.json({code:error.code},{status:error.status}); }
}});h.route({method:'POST',path:'/other-delegate',access:'authenticated',async handle(){
  try { await h.dispatchChild(new Request('http://test/v1/chat/completions',{method:'POST'}),{nodeId:'x',delegatedModel:'forged'}); return new Response('allowed'); }
  catch(error) { return Response.json({code:error.code},{status:error.status}); }
}});h.route({method:'POST',path:'/other-context',access:'authenticated',async handle(){
  try { await h.call('test.get-context@1'); return new Response('allowed'); }
  catch(error) { return Response.json({code:error.code},{status:error.status}); }
}});h.route({method:'POST',path:'/other-call',access:'authenticated',async handle(){
  try { return Response.json(await h.call('ai.workflow-execution@1')); }
  catch(error) { return Response.json({code:error.code},{status:error.status}); }
}})}}`,
  );
  await f.plugin(
    {
      ...manifest("test.ingress", ["http.route"]),
      requires: ["ai.workflow-execution@1", "test.proxy-context@1"],
    },
    `
export default {setup(h){h.route({method:'POST',path:'/trusted-call',access:'authenticated',async handle(){
  return Response.json(await h.call('ai.workflow-execution@1'));
}});h.route({method:'POST',path:'/trusted-proxy',access:'authenticated',async handle(){
  try { await h.call('test.proxy-context@1'); return new Response('allowed'); }
  catch(error) { return Response.json({code:error.code},{status:error.status}); }
}})}}`,
  );
  await f.plugin(
    manifest("test.ungranted", ["http.route"]),
    `
export default {setup(h){h.route({method:'POST',path:'/ungranted',access:'authenticated',async handle(){
  try { await h.dispatchChild(new Request('http://test/v1/chat/completions',{method:'POST'}),{nodeId:'x'}); return new Response('allowed'); }
  catch(error) { return Response.json({code:error.code},{status:error.status}); }
}})}}`,
  );
  f.kernel.configure({ "test.router": { value: "old" } });
  await f.kernel.start();
  return f;
}

function outer(action: string) {
  return new Request("http://test/outer", {
    method: "POST",
    headers: {
      authorization: "Bearer test",
      "content-type": "application/json",
    },
    body: JSON.stringify({ action }),
  });
}

describe("internal child requests", () => {
  it("inherits the authenticated identity and pinned snapshot while isolating state and finalization", async () => {
    const f = await fixture();
    try {
      const pending = f.kernel.fetch(outer("snapshot"));
      for (
        let i = 0;
        i < 50 && !(await f.kernel.invoke<any>("test.child-state@1")).waiting;
        i++
      )
        await new Promise((resolve) => setTimeout(resolve, 2));
      expect((await f.kernel.invoke<any>("test.child-state@1")).waiting).toBe(
        true,
      );
      f.kernel.configure({ "test.router": { value: "new" } });
      await f.kernel.invoke("test.child-resume@1");
      const result = (await (await pending).json()) as any;
      expect(result.childStatus).toBe(200);
      expect(result.contextMatches).toBe(true);
      expect(result.child).toMatchObject({
        principal: "alice",
        config: "old",
        hasParentState: false,
        plan: { selected: "bound" },
        delegatedModel: "authorized-model",
        version: result.parentVersion,
        parent: { requestId: result.parentId, nodeId: "node-a", depth: 1 },
      });
      expect(result.child.id).not.toBe(result.parentId);
      const state = await f.kernel.invoke<any>("test.child-state@1");
      expect(state.identityCalls).toBe(1);
      expect(
        state.finalized.filter((entry: any) => entry.id === result.child.id),
      ).toHaveLength(1);
      expect(
        state.finalized.filter((entry: any) => entry.id === result.parentId),
      ).toHaveLength(1);
      expect(state.completions).toEqual([
        {
          childWasFinalized: true,
          outcome: {
            status: 200,
            cancelled: false,
            result: { usage: { input: 3, output: 4 } },
          },
        },
      ]);
    } finally {
      await f.close();
    }
  });

  it("finalizes failed and cancelled child calls and prevents public or unrelated-plugin access", async () => {
    const f = await fixture();
    try {
      expect(
        (
          await f.kernel.fetch(
            new Request("http://test/internal/workflow/provider", {
              method: "POST",
              headers: {
                authorization: "Bearer test",
                "x-parent-id": "forged",
              },
            }),
          )
        ).status,
      ).toBe(404);
      const unrelated = await f.kernel.fetch(
        new Request("http://test/other", {
          method: "POST",
          headers: { authorization: "Bearer test" },
        }),
      );
      expect(unrelated.status).toBe(403);
      await unrelated.body?.cancel();
      for (const path of ["/other-delegate", "/other-context"]) {
        const denied = await f.kernel.fetch(
          new Request("http://test" + path, {
            method: "POST",
            headers: { authorization: "Bearer test" },
          }),
        );
        expect(denied.status).toBe(403);
        await denied.body?.cancel();
      }
      await expect(f.kernel.invoke("test.get-context@1")).rejects.toMatchObject(
        { code: "permission_denied" },
      );
      const ungranted = await f.kernel.fetch(
        new Request("http://test/ungranted", {
          method: "POST",
          headers: { authorization: "Bearer test" },
        }),
      );
      expect(ungranted.status).toBe(403);
      await ungranted.body?.cancel();
      const failure = (await (
        await f.kernel.fetch(outer("failure"))
      ).json()) as any;
      expect(failure.childStatus).toBe(502);
      const cancelled = (await (
        await f.kernel.fetch(outer("cancel"))
      ).json()) as any;
      expect(cancelled.childStatus).toBe(200);
      const entries = (await f.kernel.invoke<any>("test.child-state@1"))
        .finalized;
      expect(
        entries.filter(
          (entry: any) => entry.parent?.requestId === failure.parentId,
        ),
      ).toMatchObject([{ status: 502, error: "upstream_error" }]);
      expect(
        entries.filter(
          (entry: any) => entry.parent?.requestId === cancelled.parentId,
        ),
      ).toMatchObject([{ status: 200, cancelled: true }]);
      expect(
        (await f.kernel.invoke<any>("test.child-state@1")).completions,
      ).toEqual([
        {
          childWasFinalized: true,
          outcome: {
            status: 502,
            errorCode: "upstream_error",
            cancelled: false,
            result: { usage: { input: 3, output: 4 } },
          },
        },
        {
          childWasFinalized: true,
          outcome: {
            status: 200,
            cancelled: true,
            result: { usage: { input: 3, output: 4 } },
          },
        },
      ]);
    } finally {
      await f.close();
    }
  });

  it("only permits authorized ingress plugins to invoke workflow execution", async () => {
    const f = await fixture();
    try {
      const headers = { authorization: "Bearer test" };
      const trusted = await f.kernel.fetch(
        new Request("http://test/trusted-call", { method: "POST", headers }),
      );
      expect(trusted.status).toBe(200);
      expect(await trusted.json()).toEqual({ ok: true });
      const denied = await f.kernel.fetch(
        new Request("http://test/other-call", { method: "POST", headers }),
      );
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({ code: "permission_denied" });
      const proxy = await f.kernel.fetch(
        new Request("http://test/trusted-proxy", { method: "POST", headers }),
      );
      expect(proxy.status).toBe(403);
      expect(await proxy.json()).toEqual({ code: "permission_denied" });
    } finally {
      await f.close();
    }
  });

  it("finalizes a child when its parent is aborted", async () => {
    const f = await fixture();
    try {
      const abort = new AbortController();
      const pending = f.kernel.fetch(
        new Request(outer("parent-cancel"), { signal: abort.signal }),
      );
      for (
        let i = 0;
        i < 50 &&
        !(await f.kernel.invoke<any>("test.child-state@1")).childStarted;
        i++
      )
        await new Promise((resolve) => setTimeout(resolve, 2));
      expect(
        (await f.kernel.invoke<any>("test.child-state@1")).childStarted,
      ).toBe(true);
      abort.abort();
      const response = await pending;
      await response.body?.cancel();
      const state = await f.kernel.invoke<any>("test.child-state@1");
      expect(
        state.finalized.filter(
          (entry: any) => entry.parent?.nodeId === "node-a",
        ),
      ).toMatchObject([{ cancelled: true }]);
      expect(state.completions).toEqual([
        {
          childWasFinalized: true,
          outcome: {
            status: 200,
            cancelled: true,
            result: { usage: { input: 3, output: 4 } },
          },
        },
      ]);
    } finally {
      await f.close();
    }
  });

  it("waits for an already running Finalize and completion callback when cancellation releases twice", async () => {
    const f = await fixture();
    try {
      const pending = f.kernel.fetch(outer("delayed-cancel"));
      for (
        let i = 0;
        i < 50 &&
        !(await f.kernel.invoke<any>("test.child-state@1")).finalizeWaiting;
        i++
      )
        await new Promise((resolve) => setTimeout(resolve, 2));
      expect(
        (await f.kernel.invoke<any>("test.child-state@1")).finalizeWaiting,
      ).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const during = await f.kernel.invoke<any>("test.child-state@1");
      expect(during.cancelReturned).toBe(false);
      expect(during.completions).toHaveLength(0);
      await f.kernel.invoke("test.finalize-resume@1");
      const result = (await (await pending).json()) as any;
      const after = await f.kernel.invoke<any>("test.child-state@1");
      expect(after.cancelReturned).toBe(true);
      expect(
        after.finalized.filter(
          (entry: any) => entry.parent?.requestId === result.parentId,
        ),
      ).toHaveLength(1);
      expect(after.completions).toEqual([
        {
          childWasFinalized: true,
          outcome: {
            status: 200,
            cancelled: true,
            result: { usage: { input: 3, output: 4 } },
          },
        },
      ]);
    } finally {
      await f.kernel.invoke("test.finalize-resume@1").catch(() => {});
      await f.close();
    }
  });

  it("limits nested child calls", async () => {
    const f = await fixture();
    try {
      const result = (await (
        await f.kernel.fetch(outer("recurse"))
      ).json()) as any;
      let current = result.child;
      for (let depth = 1; depth < 7; depth++) {
        expect(current.depth).toBe(depth);
        expect(current.nextStatus).toBe(200);
        current = current.next;
      }
      expect(current.depth).toBe(7);
      expect(current.nextStatus).toBe(400);
      expect(current.next.error.code).toBe("invalid_child_request");
      const entries = (await f.kernel.invoke<any>("test.child-state@1"))
        .finalized;
      expect(
        entries.filter((entry: any) => entry.parent?.depth === 8),
      ).toMatchObject([{ status: 400, error: "invalid_child_request" }]);
    } finally {
      await f.close();
    }
  });
});
