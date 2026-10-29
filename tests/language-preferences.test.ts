import { it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./helpers.js";

const auth = "/api/plugins/official.auth";
it("saves only the signed-in account language, isolates users and restores it after restart", async () => {
  const f = await fixture(["users", "auth", "ai-router"]);
  try {
    const admin = await f.admin();
    const me = await (
      await f.request(auth + "/me", "GET", undefined, admin)
    ).json();
    expect(me.language).toBeNull();
    const alice = await (
      await f.request(
        auth + "/users",
        "POST",
        {
          username: "alice",
          password: "alice-password-123",
          role: "user",
        },
        admin,
      )
    ).json();
    const login = await f.request(auth + "/login", "POST", {
      username: "alice",
      password: "alice-password-123",
    });
    const session = { cookie: login.headers.get("set-cookie")!.split(";")[0]! };
    await login.json();
    expect(
      (
        await f.request(
          auth + "/preferences",
          "PATCH",
          { language: "en-US" },
          session,
        )
      ).status,
    ).toBe(200);
    expect(
      await (await f.request(auth + "/me", "GET", undefined, session)).json(),
    ).toMatchObject({ id: alice.id, role: "user", language: "en-US" });
    expect(
      await (await f.request(auth + "/me", "GET", undefined, admin)).json(),
    ).toMatchObject({ id: me.id, language: null });
    await f.kernel.shutdown();
    await f.kernel.start();
    expect(
      await (await f.request(auth + "/me", "GET", undefined, session)).json(),
    ).toMatchObject({ language: "en-US" });
    expect(
      (
        await f.request(
          auth + "/preferences",
          "PATCH",
          { language: "zh-CN" },
          session,
        )
      ).status,
    ).toBe(200);
    expect(
      await f.kernel.invoke("users.lookup@1", { id: alice.id }),
    ).toMatchObject({ language: "zh-CN" });
  } finally {
    await f.close();
  }
});

it("rejects anonymous, API-key, cross-origin, invalid and cross-account preference writes", async () => {
  const f = await fixture(["users", "auth", "ai-router"]);
  try {
    const admin = await f.admin();
    const saved = await (
      await f.request(auth + "/me", "GET", undefined, admin)
    ).json();
    for (const language of [
      undefined,
      "site",
      "en-GB",
      "<script>bad</script>",
      1,
    ])
      expect(
        (await f.request(auth + "/preferences", "PATCH", { language }, admin))
          .status,
      ).toBe(400);
    expect(
      (
        await f.request(
          auth + "/preferences",
          "PATCH",
          { language: "en-US", userId: "other" },
          admin,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await f.request(
          auth + "/preferences",
          "PATCH",
          { language: "en-US", role: "admin" },
          admin,
        )
      ).status,
    ).toBe(400);
    expect(
      (await f.request(auth + "/preferences", "PATCH", { language: "en-US" }))
        .status,
    ).toBe(401);
    expect(
      (
        await f.request(
          auth + "/preferences",
          "PATCH",
          { language: "en-US" },
          { ...admin, origin: "https://other.test" },
        )
      ).status,
    ).toBe(403);
    const key = await (
      await f.request(
        auth + "/keys",
        "POST",
        { name: "preference-test" },
        admin,
      )
    ).json();
    expect(
      (
        await f.request(
          auth + "/preferences",
          "PATCH",
          { language: "en-US" },
          { authorization: "Bearer " + key.token },
        )
      ).status,
    ).toBe(403);
    expect(
      await (await f.request(auth + "/me", "GET", undefined, admin)).json(),
    ).toMatchObject({ id: saved.id, language: null });
    expect(
      (
        await f.request(
          auth + "/preferences",
          "PATCH",
          { language: "en-US" },
          admin,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await f.request(
          auth + "/preferences",
          "PATCH",
          { language: null },
          admin,
        )
      ).status,
    ).toBe(200);
    expect(
      await (await f.request(auth + "/me", "GET", undefined, admin)).json(),
    ).toMatchObject({ language: null });
  } finally {
    await f.close();
  }
});

it("migrates legacy users without losing facts and still allows account creation", async () => {
  const f = await fixture(
    ["users", "auth", "ai-router"],
    {},
    async (_kernel, directory) => {
      const data = join(directory, "data", "official.users");
      await mkdir(data, { recursive: true });
      const db = new DatabaseSync(join(data, "users.sqlite"));
      db.exec(
        "CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,role TEXT NOT NULL,enabled INTEGER NOT NULL,created_at TEXT NOT NULL); PRAGMA user_version=1;",
      );
      db.prepare("INSERT INTO users VALUES(?,?,?,?,?)").run(
        "legacy",
        "legacy-user",
        "user",
        1,
        "2026-01-01",
      );
      db.close();
    },
  );
  try {
    expect(
      await f.kernel.invoke("users.lookup@1", { id: "legacy" }),
    ).toMatchObject({
      username: "legacy-user",
      role: "user",
      enabled: true,
      createdAt: "2026-01-01",
      language: null,
    });
    await f.admin();
    expect(
      await f.kernel.invoke("users.manage@1", {
        action: "preferences",
        id: "legacy",
        language: "en-US",
      }),
    ).toMatchObject({ id: "legacy", language: "en-US" });
  } finally {
    await f.close();
  }
});
