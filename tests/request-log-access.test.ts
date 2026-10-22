import { it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { fixture } from "./helpers.js";

it("isolates personal and enterprise request logs, aggregates and filter options using current membership", async () => {
  const f = await fixture(["users", "auth", "observability"]);
  const api = "/api/plugins/official.observability";
  try {
    const admin = await f.admin();
    const create = async (username: string, extra: any = {}) => {
      const response = await f.request(
        "/api/plugins/official.auth/users",
        "POST",
        { username, password: "log-access-password", ...extra },
        admin,
      );
      expect(response.status, await response.clone().text()).toBe(201);
      const user = await response.json();
      const login = await f.request(
        "/api/plugins/official.auth/login",
        "POST",
        { username, password: "log-access-password" },
      );
      await login.text();
      return {
        ...user,
        headers: { cookie: login.headers.get("set-cookie")!.split(";")[0]! },
      };
    };
    const enterprise = await create("log-company", {
      accountType: "enterprise",
    });
    const child = await create("log-child", { parentId: enterprise.id });
    const sibling = await create("log-sibling", { parentId: enterprise.id });
    const outsider = await create("log-outsider");
    const another = await create("log-company-two", {
      accountType: "enterprise",
    });
    const db = new DatabaseSync(
      join(f.config.dataDir, "official.observability/requests.sqlite"),
    );
    const at = Date.now() - 10000;
    for (const [i, user] of [
      enterprise,
      child,
      sibling,
      outsider,
      another,
    ].entries())
      db.prepare(
        "INSERT INTO requests(id,user_id,key_id,created_at,model,upstream,protocol,status,http_status,latency_ms,input_tokens,output_tokens,stream,error_code) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        "req-" + i,
        user.id,
        "key-" + i,
        at + i,
        "model-a",
        "provider-a",
        "openai-chat",
        i === 1 ? "error" : "success",
        i === 1 ? 502 : 200,
        50,
        10,
        20,
        0,
        i === 1 ? "upstream_error" : null,
      );
    db.close();
    const read = async (suffix: string, headers: any) => {
      const r = await f.request(api + suffix, "GET", undefined, headers);
      expect(r.status, await r.clone().text()).toBe(200);
      return r.json();
    };
    expect((await read("/requests", outsider.headers)).total).toBe(1);
    expect((await read("/requests?scope=all", child.headers)).total).toBe(1);
    expect((await read("/requests", enterprise.headers)).total).toBe(3);
    expect((await read("/summary", enterprise.headers)).requests).toBe(3);
    expect((await read("/summary", enterprise.headers)).inputTokens).toBe(30);
    expect((await read("/requests?scope=me", enterprise.headers)).total).toBe(
      1,
    );
    expect((await read("/requests", admin)).total).toBe(5);
    expect(
      (await read("/requests?userId=" + child.id, enterprise.headers)).total,
    ).toBe(1);
    for (const endpoint of ["requests", "summary"]) {
      expect(
        (
          await f.request(
            api + "/" + endpoint + "?userId=" + outsider.id,
            "GET",
            undefined,
            enterprise.headers,
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await f.request(
            api + "/" + endpoint + "?userId=" + sibling.id,
            "GET",
            undefined,
            child.headers,
          )
        ).status,
      ).toBe(403);
    }
    const scope = await read("/log-scope", enterprise.headers);
    expect(scope.scope).toBe("enterprise");
    expect(scope.users.map((u: any) => u.id).sort()).toEqual(
      [enterprise.id, child.id, sibling.id].sort(),
    );
    expect(
      JSON.stringify(await read("/log-scope", child.headers)),
    ).not.toContain(outsider.id);
    const filters = new URLSearchParams({
      userId: child.id,
      protocol: "openai-chat",
      model: "model-a",
      upstream: "provider-a",
      errorCode: "upstream_error",
      keyId: "key-1",
      requestId: "req-1",
      from: String(at - 1),
      to: String(at + 100),
    });
    expect((await read("/requests?" + filters, enterprise.headers)).total).toBe(
      1,
    );
    expect((await read("/summary?" + filters, enterprise.headers)).errors).toBe(
      1,
    );
    const key = await (
      await f.request(
        "/api/plugins/official.auth/keys",
        "POST",
        { name: "enterprise-key" },
        enterprise.headers,
      )
    ).json();
    expect(
      (await read("/requests", { authorization: "Bearer " + key.token })).total,
    ).toBe(1);
    for (const update of [
      { id: enterprise.id, accountType: "personal" },
      { id: enterprise.id, parentId: enterprise.id },
      { id: child.id, accountType: "enterprise" },
      { id: child.id, role: "admin" },
    ])
      expect(
        (
          await f.request(
            "/api/plugins/official.users/users",
            "PATCH",
            update,
            admin,
          )
        ).status,
      ).toBeGreaterThanOrEqual(400);
    expect(
      (
        await f.request(
          "/api/plugins/official.users/users",
          "PATCH",
          { id: outsider.id, parentId: enterprise.id },
          outsider.headers,
        )
      ).status,
    ).toBe(403);
    const changed = await f.request(
      "/api/plugins/official.users/users",
      "PATCH",
      {
        id: child.id,
        parentId: another.id,
        reason: "Move child to another enterprise",
      },
      admin,
    );
    expect(changed.status).toBe(200);
    await changed.text();
    expect((await read("/requests", enterprise.headers)).total).toBe(2);
    expect((await read("/requests", another.headers)).total).toBe(2);
    const audit = await (
      await f.request(
        "/api/host/audit?userId=" + child.id,
        "GET",
        undefined,
        admin,
      )
    ).json();
    expect(
      audit.items.some(
        (e: any) =>
          e.reason === "Move child to another enterprise" && e.status === 200,
      ),
    ).toBe(true);
    expect(
      (await f.request("/api/host/audit", "GET", undefined, enterprise.headers))
        .status,
    ).toBe(403);
    for (const query of [
      "from=2&to=1",
      "from=foo&to=1",
      "from=1",
      "from=0&to=9999999999999",
    ])
      expect(
        (await f.request(api + "/requests?" + query, "GET", undefined, admin))
          .status,
      ).toBe(400);
    await f.kernel.shutdown();
    await f.kernel.start();
    expect((await read("/requests", another.headers)).total).toBe(2);
  } finally {
    await f.close();
  }
});
