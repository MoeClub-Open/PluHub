import { DatabaseSync } from "node:sqlite";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { fixture } from "./helpers.js";

it("records the host-created parent and node identity for an actual child dispatch", async () => {
  const f = await fixture(
    ["users", "auth", "observability"],
    {},
    async (kernel, directory) => {
      const path = join(directory, "workflow-caller");
      await mkdir(path);
      const manifest = {
        schemaVersion: 1,
        id: "test.workflow-caller",
        version: "1.0.0",
        host: ">=0.1.0-alpha.1",
        runtime: { kind: "native", entry: "index.js" },
        provides: [],
        requires: [],
        permissions: ["http.route", "http.dispatch.child"],
      };
      await writeFile(
        join(path, "package.json"),
        JSON.stringify({ type: "module" }),
      );
      await writeFile(join(path, "manifest.json"), JSON.stringify(manifest));
      await writeFile(
        join(path, "index.js"),
        `export default { setup(host) {
      host.route({ method: "POST", path: "/v1/chat/completions", access: "authenticated",
        async handle(request, ctx) {
          const observation = ctx.state.get("ai.observation");
          Object.assign(observation, { model: "test-model", upstream: "test-provider", finished: true,
            usage: { input: 1, output: 2 } });
          if (ctx.parent) return Response.json({ id: ctx.id, parent: ctx.parent });
          const child = await host.dispatchChild(new Request("http://localhost/v1/chat/completions", {
            method: "POST", headers: { "content-type": "application/json" }, body: "{}"
          }), { nodeId: "trusted-node" });
          return Response.json({ child: await child.json() });
        }
      });
    } }`,
      );
      await kernel.add(path, { grants: manifest.permissions });
    },
  );
  try {
    const admin = await f.admin();
    const response = await f.request(
      "/v1/chat/completions",
      "POST",
      {},
      {
        ...admin,
        "x-parent-request-id": "forged",
        "x-workflow-node-id": "forged",
      },
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const rootId = response.headers.get("x-pluhub-request-id");
    const { child } = await response.json();
    expect(child.parent).toEqual({
      requestId: rootId,
      nodeId: "trusted-node",
      depth: 1,
    });
    const request = await f.request(
      `/api/plugins/official.observability/requests?requestId=${child.id}`,
      "GET",
      undefined,
      admin,
    );
    const data = await request.json();
    expect(data.data).toHaveLength(1);
    expect(data.data[0]).toMatchObject({
      parent_request_id: rootId,
      workflow_node_id: "trusted-node",
      input_tokens: 1,
      output_tokens: 2,
    });
    const children = await f.request(
      `/api/plugins/official.observability/requests/children?parentId=${rootId}`,
      "GET",
      undefined,
      admin,
    );
    expect((await children.json()).data.map((row: any) => row.id)).toEqual([
      child.id,
    ]);
  } finally {
    await f.close();
  }
});

it("keeps workflow call logs scoped to their owner and includes nested costs without counting extra requests", async () => {
  const f = await fixture(["users", "auth", "billing", "observability"]);
  const api = "/api/plugins/official.observability";
  try {
    const admin = await f.admin();
    async function create(username: string) {
      const response = await f.request(
        "/api/plugins/official.auth/users",
        "POST",
        { username, password: "workflow-log-password" },
        admin,
      );
      expect(response.status, await response.clone().text()).toBe(201);
      const user = await response.json();
      const login = await f.request(
        "/api/plugins/official.auth/login",
        "POST",
        {
          username,
          password: "workflow-log-password",
        },
      );
      await login.text();
      return {
        id: user.id,
        headers: { cookie: login.headers.get("set-cookie")!.split(";")[0]! },
      };
    }
    const owner = await create("workflow-log-owner");
    const outsider = await create("workflow-log-outsider");
    const at = Date.now() - 1000;
    const records = [
      {
        id: "root-call",
        user: owner.id,
        parent: null,
        node: null,
        input: 1,
        output: 10,
        cost: 100,
      },
      {
        id: "child-call",
        user: owner.id,
        parent: "root-call",
        node: "classify",
        input: 2,
        output: 20,
        cost: 200,
        model: "internal-model",
        upstream: "internal-provider",
        error: "internal_failure",
      },
      {
        id: "grandchild-call",
        user: owner.id,
        parent: "child-call",
        node: "rewrite",
        input: 3,
        output: 30,
        cost: 300,
      },
      {
        id: "orphan-call",
        user: owner.id,
        parent: "missing-call",
        node: "orphan",
        input: 6,
        output: 60,
        cost: 600,
      },
      {
        id: "workflow-root",
        user: owner.id,
        parent: null,
        node: null,
        input: 1000,
        output: 2000,
        cost: 1000,
        mode: "workflow",
      },
      {
        id: "workflow-child",
        user: owner.id,
        parent: "workflow-root",
        node: "summarize",
        input: 7,
        output: 70,
        cost: 700,
      },
      {
        id: "other-root",
        user: outsider.id,
        parent: null,
        node: null,
        input: 4,
        output: 40,
        cost: 400,
      },
      // A bad cross-user link must never make another user's record visible.
      {
        id: "other-child",
        user: outsider.id,
        parent: "root-call",
        node: "foreign",
        input: 5,
        output: 50,
        cost: 500,
        model: "internal-model",
        upstream: "internal-provider",
        error: "internal_failure",
      },
    ];
    const logs = new DatabaseSync(
      join(f.config.dataDir, "official.observability/requests.sqlite"),
    );
    const insert = logs.prepare(`INSERT INTO requests
      (id,user_id,created_at,model,upstream,protocol,status,http_status,latency_ms,input_tokens,output_tokens,cost_micro_usd,stream,billing_mode,consumption_source,parent_request_id,workflow_node_id,error_code)
      VALUES(?,?,?,?,?,'openai-chat',?,?,10,?,?,?,0,?,'platform',?,?,?)`);
    for (const [i, row] of records.entries())
      insert.run(
        row.id,
        row.user,
        at + i,
        row.model ?? "model",
        row.upstream ?? "provider",
        row.error ? "error" : "success",
        row.error ? 502 : 200,
        row.input,
        row.output,
        row.cost,
        row.mode ?? "platform",
        row.parent,
        row.node,
        row.error ?? null,
      );
    logs.close();
    const billing = new DatabaseSync(
      join(f.config.dataDir, "official.billing/billing.sqlite"),
    );
    for (const row of records) {
      if (row.mode === "workflow") continue;
      billing
        .prepare(
          "INSERT INTO reservations(id,user_id,amount,status,actual,created_at) VALUES(?,?,?,'settled',?,?)",
        )
        .run(row.id, row.user, row.cost, row.cost, at);
      billing
        .prepare(
          "INSERT INTO ledger(user_id,amount,source,created_at) VALUES(?,?,?,?)",
        )
        .run(row.user, -row.cost, "request:" + row.id, at);
    }
    billing.close();

    async function read(path: string, headers = owner.headers) {
      const response = await f.request(api + path, "GET", undefined, headers);
      expect(response.status, await response.clone().text()).toBe(200);
      return response.json();
    }
    const roots = await read("/requests");
    expect(roots.total).toBe(3);
    expect(roots.data.map((row: any) => row.id).sort()).toEqual([
      "orphan-call",
      "root-call",
      "workflow-root",
    ]);
    expect(
      (await read("/requests", outsider.headers)).data
        .map((row: any) => row.id)
        .sort(),
    ).toEqual(["other-child", "other-root"]);
    const children = await read("/requests/children?parentId=root-call");
    expect(
      children.data.map((row: any) => [
        row.id,
        row.workflow_node_id,
        row.charged_micro_usd,
      ]),
    ).toEqual([["child-call", "classify", 200]]);
    const grandchildren = await read("/requests/children?parentId=child-call");
    expect(
      grandchildren.data.map((row: any) => [
        row.id,
        row.workflow_node_id,
        row.charged_micro_usd,
      ]),
    ).toEqual([["grandchild-call", "rewrite", 300]]);
    expect(
      (await read("/requests?requestId=child-call")).data[0].parent_request_id,
    ).toBe("root-call");
    expect(
      (
        await f.request(
          api + "/requests/children?parentId=root-call",
          "GET",
          undefined,
          outsider.headers,
        )
      ).status,
    ).toBe(404);
    const summary = await read("/summary?requestId=root-call");
    expect(summary.requests).toBe(1);
    expect(summary.inputTokens).toBe(6);
    expect(summary.outputTokens).toBe(60);
    expect(summary.wallet.chargedUSD).toBeCloseTo(0.0006);
    const allOwner = await read("/summary");
    expect(allOwner.requests).toBe(3);
    expect(allOwner.inputTokens).toBe(19);
    expect(allOwner.outputTokens).toBe(190);
    expect(allOwner.wallet.chargedUSD).toBeCloseTo(0.0019);
    const workflow = await read("/summary?requestId=workflow-root");
    expect(workflow.requests).toBe(1);
    expect(workflow.inputTokens).toBe(7);
    expect(workflow.outputTokens).toBe(70);
    expect(workflow.wallet.chargedUSD).toBeCloseTo(0.0007);
    expect(workflow.wallet.unknownRequests).toBe(0);
    expect(workflow.consumption[0].estimatedCostUSD).toBeCloseTo(0.0007);
    for (const filter of [
      "model=internal-model",
      "upstream=internal-provider",
      "errorCode=internal_failure",
    ]) {
      const matches = await read("/requests?" + filter);
      expect(matches.total).toBe(1);
      expect(matches.data.map((row: any) => row.id)).toEqual(["child-call"]);
      const filtered = await read("/summary?" + filter);
      expect(filtered.requests).toBe(1);
      expect(filtered.inputTokens).toBe(2);
      expect(filtered.outputTokens).toBe(20);
      expect(filtered.wallet.chargedUSD).toBeCloseTo(0.0002);
      expect(
        (await read("/requests?" + filter, outsider.headers)).data.map(
          (row: any) => row.id,
        ),
      ).toEqual(["other-child"]);
    }
    const exported = await f.request(
      api + "/requests/export?requestId=root-call",
      "GET",
      undefined,
      admin,
    );
    expect(exported.status, await exported.clone().text()).toBe(200);
    const csv = await exported.text();
    expect(csv).toContain("parent_request_id");
    expect(csv).toContain("workflow_node_id");
    expect(csv).toContain("root-call");
    expect(csv).toContain("child-call");
    expect(csv).toContain("grandchild-call");
    expect(csv).not.toContain("other-child");
    const filteredExport = await f.request(
      api + "/requests/export?model=internal-model",
      "GET",
      undefined,
      owner.headers,
    );
    expect(filteredExport.status, await filteredExport.clone().text()).toBe(
      200,
    );
    const filteredCsv = await filteredExport.text();
    expect(filteredCsv).toContain("child-call");
    expect(filteredCsv).not.toContain("grandchild-call");
    expect(filteredCsv).not.toContain("other-child");

    // A child is visible while its parent has not yet finalized, then moves under it.
    const lateParent = new DatabaseSync(
      join(f.config.dataDir, "official.observability/requests.sqlite"),
    );
    lateParent
      .prepare(
        `INSERT INTO requests(id,user_id,created_at,model,protocol,status,http_status,latency_ms,stream,billing_mode)
      VALUES(?,?,?,'model','openai-chat','success',200,10,0,'workflow')`,
      )
      .run("missing-call", owner.id, at);
    lateParent.close();
    const afterParent = await read("/requests");
    expect(afterParent.total).toBe(3);
    expect(afterParent.data.map((row: any) => row.id).sort()).toEqual([
      "missing-call",
      "root-call",
      "workflow-root",
    ]);
    expect(
      (await read("/requests/children?parentId=missing-call")).data.map(
        (row: any) => row.id,
      ),
    ).toEqual(["orphan-call"]);
  } finally {
    await f.close();
  }
});
