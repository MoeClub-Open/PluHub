import { it, expect } from "vitest";
import { fixture } from "./helpers.js";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
it("supports sessions, users, own API keys, revocation, disabling and persistent data", async () => {
  const f = await fixture(["users", "auth", "ai-router"]);
  try {
    const admin = await f.admin();
    const malformed = await f.kernel.fetch(
      new Request("http://localhost/api/plugins/official.auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "null",
      }),
    );
    expect(malformed.status).toBe(400);
    await malformed.json();
    expect((await f.request("/api/host/plugins")).status).toBe(401);
    const denied = await f.request("/api/plugins/official.auth/login", "POST", {
      username: "admin",
      password: "wrong-password",
    });
    expect(denied.status).toBe(401);
    await denied.json();
    const created = await f.request(
      "/api/plugins/official.users/users",
      "POST",
      { username: "alice", role: "user" },
      admin,
    );
    expect(created.status).toBe(201);
    const alice = await created.json();
    const pw = await f.request(
      "/api/plugins/official.auth/password",
      "POST",
      { userId: alice.id, password: "alice-password-123" },
      admin,
    );
    expect(pw.status).toBe(200);
    await pw.json();
    const login = await f.request("/api/plugins/official.auth/login", "POST", {
      username: "alice",
      password: "alice-password-123",
    });
    const cookie = { cookie: login.headers.get("set-cookie")!.split(";")[0]! };
    await login.json();
    expect(
      (await f.request("/api/host/plugins", "GET", undefined, cookie)).status,
    ).toBe(403);
    const adminUser = await f.kernel.invoke<any>("users.lookup@1", {
      username: "admin",
    });
    const reset = await f.request(
      "/api/plugins/official.auth/password",
      "POST",
      {
        userId: adminUser.id,
        currentPassword: "alice-password-123",
        password: "stolen-password-123",
      },
      cookie,
    );
    expect(reset.status).toBe(403);
    await reset.json();
    const keyResponse = await f.request(
      "/api/plugins/official.auth/keys",
      "POST",
      { name: "test" },
      cookie,
    );
    const key = await keyResponse.json();
    expect(key.token).toMatch(/^ph_/);
    const bearer = { authorization: "Bearer " + key.token };
    expect(
      (
        await f.request(
          "/api/plugins/official.auth/me",
          "GET",
          undefined,
          bearer,
        )
      ).status,
    ).toBe(200);
    const listed = await (
      await f.request(
        "/api/plugins/official.auth/keys",
        "GET",
        undefined,
        cookie,
      )
    ).json();
    expect(JSON.stringify(listed)).not.toContain(key.token);
    const cross = await f.request(
      "/api/plugins/official.auth/keys",
      "POST",
      { name: "csrf" },
      { ...cookie, origin: "https://other.test" },
    );
    expect(cross.status).toBe(403);
    const disabled = await f.request(
      "/api/plugins/official.users/users",
      "PATCH",
      { id: alice.id, enabled: false },
      admin,
    );
    expect(disabled.status).toBe(200);
    await disabled.json();
    expect(
      (
        await f.request(
          "/api/plugins/official.auth/me",
          "GET",
          undefined,
          bearer,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await f.request(
          "/api/plugins/official.auth/me",
          "GET",
          undefined,
          cookie,
        )
      ).status,
    ).toBe(401);
    await (
      await f.request(
        "/api/plugins/official.users/users",
        "PATCH",
        { id: alice.id, enabled: true },
        admin,
      )
    ).json();
    await (
      await f.request(
        "/api/plugins/official.auth/keys?id=" + key.id,
        "DELETE",
        undefined,
        cookie,
      )
    ).json();
    expect(
      (
        await f.request(
          "/api/plugins/official.auth/me",
          "GET",
          undefined,
          bearer,
        )
      ).status,
    ).toBe(401);
    const logout = await f.request(
      "/api/plugins/official.auth/logout",
      "POST",
      {},
      cookie,
    );
    await logout.json();
    expect(
      (
        await f.request(
          "/api/plugins/official.auth/me",
          "GET",
          undefined,
          cookie,
        )
      ).status,
    ).toBe(401);
    const db = new DatabaseSync(
      join(f.config.dataDir, "official.auth/auth.sqlite"),
    );
    expect(
      JSON.stringify(db.prepare("SELECT * FROM passwords").all()),
    ).not.toContain("alice-password-123");
    expect(db.prepare("SELECT COUNT(*) n FROM passwords").get()).toMatchObject({
      n: 2,
    });
    db.close();
    await f.kernel.shutdown();
    await f.kernel.start();
    expect(
      await f.kernel.invoke("users.lookup@1", { id: alice.id }),
    ).toMatchObject({ username: "alice", enabled: true });
  } finally {
    await f.close();
  }
});
