import { it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { writeFile, chmod } from "node:fs/promises";
import { fixture } from "./helpers.js";
import { verifyData } from "../apps/cli/dist/verify-data.js";
const auth = "/api/plugins/official.auth",
  billing = "/api/plugins/official.billing",
  logs = "/api/plugins/official.observability";

it("searches and paginates the full wallet ledger, isolates owners and exports exact integer amounts", async () => {
  const f = await fixture(["users", "auth", "billing"]);
  try {
    const admin = await f.admin(),
      me = await (
        await f.request(auth + "/me", "GET", undefined, admin)
      ).json();
    for (let i = 0; i < 125; i++)
      await f.kernel.invoke("billing.credit@1", {
        userId: me.id,
        amount: i + 1,
        source: "entry-" + String(i).padStart(3, "0"),
      });
    await f.kernel.invoke("billing.credit@1", {
      userId: me.id,
      amount: 1,
      source: '=HYPERLINK("https://example.invalid")',
    });
    const read = async (query: string, headers = admin) => {
      const r = await f.request(
        billing + "/ledger/history?" + query,
        "GET",
        undefined,
        headers,
      );
      expect(r.status).toBe(200);
      return r.json();
    };
    expect((await read("limit=20")).total).toBe(126);
    expect((await read("limit=20&offset=120")).items).toHaveLength(6);
    expect((await read("q=entry-000")).items[0]).toMatchObject({
      source: "entry-000",
      amount: 1,
    });
    expect((await read("q=%25")).total).toBe(0);
    expect((await read("kind=debit")).total).toBe(0);
    const other = await f.kernel.invoke<any>("users.manage@1", {
      action: "create",
      username: "ledger-other",
      role: "user",
    });
    await f.kernel.invoke("auth.bootstrap@1", {
      userId: other.id,
      password: "ledger-other-password",
    });
    const login = await f.request(auth + "/login", "POST", {
      username: "ledger-other",
      password: "ledger-other-password",
    });
    await login.text();
    const own = { cookie: login.headers.get("set-cookie")!.split(";")[0]! };
    expect((await read("userId=" + me.id, own)).total).toBe(0);
    const csv = await f.request(
      billing + "/ledger/export",
      "GET",
      undefined,
      admin,
    );
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    const text = await csv.text();
    expect(text).toContain('"entry-000","1","USD"');
    expect(text).toContain("\"'=HYPERLINK");
    expect(
      (await f.request(billing + "/ledger/export", "GET", undefined, admin))
        .status,
    ).toBe(429);
    for (const query of [
      "limit=101",
      "offset=-1",
      "kind=unknown",
      "from=2&to=1",
      "from=bad",
    ]) {
      const r = await f.request(
        billing + "/ledger/history?" + query,
        "GET",
        undefined,
        admin,
      );
      expect(r.status).toBe(400);
      await r.text();
    }
    expect(
      (
        await (
          await f.request(billing + "/ledger", "GET", undefined, admin)
        ).json()
      ).length,
    ).toBe(100);
  } finally {
    await f.close();
  }
});

it("lists revocable device sessions without exposing token hashes and enforces ownership and recent authentication", async () => {
  const f = await fixture(["users", "auth", "ai-router"]);
  try {
    const admin = await f.admin();
    const create = await f.request(
      auth + "/users",
      "POST",
      { username: "session-user", password: "session-test-password" },
      admin,
    );
    expect(create.status).toBe(201);
    const user = await create.json();
    const signIn = async (device: string) => {
      const r = await f.request(
        auth + "/login",
        "POST",
        { username: user.username, password: "session-test-password" },
        { "user-agent": device },
      );
      expect(r.status).toBe(200);
      await r.text();
      return { cookie: r.headers.get("set-cookie")!.split(";")[0]! };
    };
    const first = await signIn("Browser one"),
      second = await signIn("Browser two");
    const sessions = await (
      await f.request(auth + "/sessions", "GET", undefined, first)
    ).json();
    expect(sessions.items).toHaveLength(2);
    expect(sessions.items[0]).toMatchObject({
      current: true,
      device: "Browser one",
      method: "password",
    });
    expect(JSON.stringify(sessions)).not.toMatch(
      /"hash"|pluhub_session|session-test-password/,
    );
    const target = sessions.items.find((row: any) => !row.current);
    const alien = await f.request(
      auth + "/sessions/revoke",
      "POST",
      { id: target.id },
      admin,
    );
    expect(alien.status).toBe(404);
    await alien.text();
    const key = await (
      await f.request(auth + "/keys", "POST", { name: "session-scope" }, first)
    ).json();
    const keyDenied = await f.request(auth + "/sessions", "GET", undefined, {
      authorization: "Bearer " + key.token,
    });
    expect(keyDenied.status).toBe(403);
    await keyDenied.text();
    const db = new DatabaseSync(
      join(f.config.dataDir, "official.auth/auth.sqlite"),
    );
    db.prepare(
      "UPDATE sessions SET auth_at=0 WHERE user_id=? AND device=?",
    ).run(user.id, "Browser one");
    const stale = await f.request(
      auth + "/sessions/revoke",
      "POST",
      { id: target.id },
      first,
    );
    expect(stale.status).toBe(403);
    await stale.text();
    db.prepare("UPDATE sessions SET auth_at=? WHERE user_id=?").run(
      Date.now(),
      user.id,
    );
    db.close();
    const revoked = await f.request(
      auth + "/sessions/revoke",
      "POST",
      { id: target.id },
      first,
    );
    expect(revoked.status).toBe(200);
    await revoked.text();
    expect(
      (await f.request(auth + "/me", "GET", undefined, second)).status,
    ).toBe(401);
    const third = await signIn("Browser three");
    const others = await f.request(
      auth + "/sessions/revoke-others",
      "POST",
      {},
      first,
    );
    expect((await others.json()).revoked).toBe(1);
    expect(
      (await f.request(auth + "/me", "GET", undefined, third)).status,
    ).toBe(401);
    const current = (
      await (
        await f.request(auth + "/sessions", "GET", undefined, first)
      ).json()
    ).items[0];
    const self = await f.request(
      auth + "/sessions/revoke",
      "POST",
      { id: current.id },
      first,
    );
    expect((await self.json()).current).toBe(true);
    expect(self.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(
      (await f.request(auth + "/me", "GET", undefined, first)).status,
    ).toBe(401);
  } finally {
    await f.close();
  }
});

it("caps active devices and allows a signed-in user to recover by revoking other sessions", async () => {
  const f = await fixture(["users", "auth", "ai-router"]);
  try {
    const admin = await f.admin(),
      me = await (
        await f.request(auth + "/me", "GET", undefined, admin)
      ).json();
    const db = new DatabaseSync(
      join(f.config.dataDir, "official.auth/auth.sqlite"),
    );
    const insert = db.prepare(
      "INSERT INTO sessions(hash,user_id,expires,id) VALUES(?,?,?,?)",
    );
    for (let i = 0; i < 49; i++)
      insert.run(
        "test-session-hash-" + i,
        me.id,
        Date.now() + 86400000,
        "test-device-id-" + i,
      );
    db.close();
    const denied = await f.request(auth + "/login", "POST", {
      username: "admin",
      password: "correct-admin-password",
    });
    expect(denied.status).toBe(409);
    await denied.text();
    const revoke = await f.request(
      auth + "/sessions/revoke-others",
      "POST",
      {},
      admin,
    );
    expect((await revoke.json()).revoked).toBe(49);
    const recovered = await f.request(auth + "/login", "POST", {
      username: "admin",
      password: "correct-admin-password",
    });
    expect(recovered.status).toBe(200);
    await recovered.text();
  } finally {
    await f.close();
  }
});

it("exports only the current log scope, rejects oversized exports, and bounds retained request history", async () => {
  const f = await fixture(["users", "auth", "ai-router", "observability"]);
  try {
    const admin = await f.admin();
    const company = await f.kernel.invoke<any>("users.manage@1", {
      action: "create",
      username: "export-company",
      role: "user",
      accountType: "enterprise",
    });
    const child = await f.kernel.invoke<any>("users.manage@1", {
      action: "create",
      username: "export-child",
      role: "user",
      parentId: company.id,
    });
    const outsider = await f.kernel.invoke<any>("users.manage@1", {
      action: "create",
      username: "export-outside",
      role: "user",
    });
    const signIn = async (user: any) => {
      await f.kernel.invoke("auth.bootstrap@1", {
        userId: user.id,
        password: "export-test-password",
      });
      const response = await f.request(auth + "/login", "POST", {
        username: user.username,
        password: "export-test-password",
      });
      await response.text();
      return { cookie: response.headers.get("set-cookie")!.split(";")[0]! };
    };
    const owner = await signIn(company),
      own = await signIn(child);
    const db = new DatabaseSync(
        join(f.config.dataDir, "official.observability/requests.sqlite"),
      ),
      at = Date.now() - 1000;
    const insert = db.prepare(
      "INSERT INTO requests(id,user_id,created_at,model,protocol,status,http_status,latency_ms,stream) VALUES(?,?,?,?,'openai-chat','success',200,10,0)",
    );
    for (const [i, user] of [company, child, outsider].entries())
      insert.run("scope-" + i, user.id, at, "model-" + i);
    const exported = await f.request(
      logs + "/requests/export",
      "GET",
      undefined,
      owner,
    );
    expect(exported.status).toBe(200);
    const text = await exported.text();
    expect(text).toContain("scope-0");
    expect(text).toContain("scope-1");
    expect(text).not.toContain("scope-2");
    const denial = await f.request(
      logs + "/requests/export?userId=" + outsider.id,
      "GET",
      undefined,
      own,
    );
    expect(denial.status).toBe(403);
    await denial.text();
    const key = await (
      await f.request(auth + "/keys", "POST", { name: "export-key" }, owner)
    ).json();
    const selfCsv = await f.request(
      logs + "/requests/export?scope=all",
      "GET",
      undefined,
      { authorization: "Bearer " + key.token },
    );
    // Export quotas are per owner, including the owner's API keys.
    expect(selfCsv.status).toBe(429);
    await selfCsv.text();
    db.exec("BEGIN");
    for (let i = 0; i < 10001; i++)
      insert.run("bulk-" + i, outsider.id, at, "bulk");
    db.exec("COMMIT");
    db.close();
    const oversized = await f.request(
      logs + "/requests/export",
      "GET",
      undefined,
      admin,
    );
    expect(oversized.status).toBe(413);
    await oversized.text();
    await f.kernel.shutdown();
    f.kernel.configure({ "official.observability": { maxRows: 1000 } });
    await f.kernel.start();
    const summary = await (
      await f.request(logs + "/summary", "GET", undefined, admin)
    ).json();
    expect(summary.requests).toBe(1000);
    expect(summary.maxRows).toBe(1000);
  } finally {
    await f.close();
  }
});

it("verifies restored SQLite data offline and rejects corrupted databases without repairing them", async () => {
  const f = await fixture(["users", "auth", "ai-router"]);
  try {
    await f.admin();
    await f.kernel.shutdown();
    const valid = await verifyData(f.config);
    expect(valid.passed).toBe(true);
    expect(
      valid.databases.some((row: any) => row.path.endsWith("auth.sqlite")),
    ).toBe(true);
    const path = join(f.config.dataDir, "corrupt.sqlite");
    await writeFile(path, "not a SQLite database", { mode: 0o600 });
    await chmod(path, 0o600);
    await expect(verifyData(f.config)).rejects.toThrow();
    // A failed validation must leave the original bytes available for diagnosis.
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(path, "utf8")).toBe("not a SQLite database");
  } finally {
    await f.close();
  }
});

it("requires an exact browser origin for secure-cookie mutations while preserving API key calls", async () => {
  const f = await fixture(["users", "auth", "ai-router"]);
  try {
    const admin = await f.admin();
    f.kernel.configure({ "official.auth": { secureCookie: true } });
    for (const headers of [
      admin,
      { ...admin, origin: "https://attacker.invalid" },
      { ...admin, referer: "not a URL" },
      { ...admin, referer: "http://localhost/, http://attacker.invalid/" },
    ]) {
      const response = await f.request(
        auth + "/sessions/revoke-others",
        "POST",
        {},
        headers,
      );
      expect(response.status).toBe(403);
      await response.text();
    }
    for (const headers of [
      { ...admin, origin: "http://localhost" },
      { ...admin, referer: "http://localhost/account" },
    ]) {
      const response = await f.request(
        auth + "/sessions/revoke-others",
        "POST",
        {},
        headers,
      );
      expect(response.status).toBe(200);
      await response.json();
    }
    const key = await (
      await f.request(
        auth + "/keys",
        "POST",
        { name: "secure-key" },
        { ...admin, origin: "http://localhost" },
      )
    ).json();
    const me = await f.request(auth + "/me", "GET", undefined, {
      authorization: "Bearer " + key.token,
    });
    expect(me.status).toBe(200);
    await me.json();
  } finally {
    await f.close();
  }
});
