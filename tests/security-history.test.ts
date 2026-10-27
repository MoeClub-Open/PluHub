import { it, expect, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { fixture } from "./helpers.js";
import {
  securityFixture,
  cookie,
  otp,
  authenticator,
} from "./security-helpers.js";
import {
  createKernel,
  attachManagement,
} from "../packages/control/dist/index.js";

const auth = "/api/plugins/official.auth";
const database = (f: { directory: string }) =>
  new DatabaseSync(join(f.directory, "data", "official.auth", "auth.sqlite"));
const source = {
  "x-pluhub-peer": "203.0.113.10",
  "user-agent": "Chrome/123 Windows private-ua",
};
async function member(
  f: Awaited<ReturnType<typeof fixture>>,
  admin: Record<string, string>,
  username = "history-user",
  extra = {},
) {
  const created = await f.request(
    auth + "/users",
    "POST",
    { username, password: "history-user-password", ...extra },
    admin,
  );
  expect(created.status).toBe(201);
  const user = await created.json();
  const login = await f.request(
    auth + "/login",
    "POST",
    { username, password: "history-user-password" },
    source,
  );
  expect(login.status).toBe(200);
  await login.text();
  return { user, session: cookie(login) };
}
async function history(
  f: Awaited<ReturnType<typeof fixture>>,
  session: Record<string, string>,
  query = "",
  administrative = false,
) {
  const response = await f.request(
    auth +
      (administrative ? "/admin/security-history" : "/security/history") +
      "?" +
      query,
    "GET",
    undefined,
    session,
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return response.json();
}

it("attributes concurrent known and unknown login failures without persisting credentials, arbitrary UA or forwarded headers", async () => {
  const f = await fixture(["users", "auth", "ai-router"]);
  try {
    const admin = await f.admin();
    const a = await member(f, admin),
      b = await member(f, admin, "history-other");
    const attempts = await Promise.all(
      [a.user.username, b.user.username, "history-unknown"].map((username) =>
        f.request(
          auth + "/login",
          "POST",
          { username, password: "private-wrong-password" },
          { ...source, "x-forwarded-for": "198.51.100.20" },
        ),
      ),
    );
    const rows = (
      await history(
        f,
        admin,
        "action=login&outcome=failure&method=password",
        true,
      )
    ).items;
    for (const [index, response] of attempts.entries()) {
      expect(response.status).toBe(401);
      const event = rows.find(
        (r: any) =>
          r.request_id === response.headers.get("x-pluhub-request-id"),
      );
      expect(event).toMatchObject({
        user_id: [a.user.id, b.user.id, null][index],
        actor_id: null,
        outcome: "failure",
        method: "password",
        error_code: "invalid_credentials",
        ip: source["x-pluhub-peer"],
        device: "Chrome / Windows",
      });
    }
    const own = await history(f, a.session, "action=login");
    expect(own.items).toHaveLength(2);
    expect(
      own.items.every(
        (r: any) =>
          !Object.hasOwn(r, "user_id") && !Object.hasOwn(r, "actor_id"),
      ),
    ).toBe(true);
    await f.kernel.invoke("users.manage@1", {
      action: "update",
      id: b.user.id,
      enabled: false,
    });
    expect(
      (
        await f.request(auth + "/login", "POST", {
          username: b.user.username,
          password: "history-user-password",
        })
      ).status,
    ).toBe(401);
    const db = database(f);
    try {
      const persisted = JSON.stringify(
        db.prepare("SELECT * FROM security_events").all(),
      );
      for (const secret of [
        "history-user-password",
        "private-wrong-password",
        "private-ua",
        "198.51.100.20",
        a.session.cookie.split("=")[1]!,
      ])
        expect(persisted).not.toContain(secret);
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
});

it("isolates personal histories from administrators, enterprise parents, API keys and forged administrator targets", async () => {
  const f = await fixture(["users", "auth", "ai-router"]);
  try {
    const admin = await f.admin(),
      parent = await member(f, admin, "history-parent", {
        accountType: "enterprise",
      });
    const child = await member(f, admin, "history-child", {
      parentId: parent.user.id,
    });
    for (const path of [
      "/security/history",
      "/admin/security-history",
      "/admin/security-history/status",
    ])
      expect((await f.request(auth + path)).status).toBe(401);
    for (const path of [
      "/admin/security-history",
      "/admin/security-history/status",
    ])
      expect(
        (await f.request(auth + path, "GET", undefined, parent.session)).status,
      ).toBe(403);
    expect(
      (
        await f.request(
          auth + "/security/history?userId=" + child.user.id,
          "GET",
          undefined,
          parent.session,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await f.request(
          auth + "/security/history?actorId=" + parent.user.id,
          "GET",
          undefined,
          parent.session,
        )
      ).status,
    ).toBe(403);
    const key = await (
      await f.request(auth + "/keys", "POST", { name: "history-key" }, admin)
    ).json();
    for (const path of [
      "/security/history",
      "/admin/security-history",
      "/admin/security-history/status",
    ])
      expect(
        (
          await f.request(auth + path, "GET", undefined, {
            authorization: "Bearer " + key.token,
          })
        ).status,
      ).toBe(403);
    const forged = await f.request(
      auth + "/password",
      "POST",
      { userId: child.user.id, password: "forged-user-password" },
      parent.session,
    );
    expect(forged.status).toBe(403);
    expect(
      (
        await history(
          f,
          child.session,
          "requestId=" + forged.headers.get("x-pluhub-request-id"),
        )
      ).total,
    ).toBe(0);
    const reset = await f.request(
      auth + "/password",
      "POST",
      { userId: child.user.id, password: "new-history-password" },
      { ...admin, ...source },
    );
    expect(reset.status).toBe(200);
    const id = reset.headers.get("x-pluhub-request-id")!;
    const administrative = await history(f, admin, "requestId=" + id, true);
    expect(administrative.items[0]).toMatchObject({
      user_id: child.user.id,
      action: "password.admin_reset",
      ip: source["x-pluhub-peer"],
    });
    const login = await f.request(auth + "/login", "POST", {
      username: child.user.username,
      password: "new-history-password",
    });
    expect(login.status).toBe(200);
    const own = await history(f, cookie(login), "requestId=" + id);
    expect(own.items[0]).toMatchObject({
      other_actor: true,
      ip: null,
      device: "",
    });
    expect(JSON.stringify(own.items)).not.toContain(
      administrative.items[0].actor_id,
    );
  } finally {
    await f.close();
  }
});

it("distinguishes MFA challenges, rejected codes, recovery codes and independently signed Passkey logins", async () => {
  const f = await securityFixture();
  try {
    const admin = await f.admin();
    const setup = await (
      await f.request(auth + "/totp/setup", "POST", {}, admin)
    ).json();
    const confirmed = await (
      await f.request(
        auth + "/totp/confirm",
        "POST",
        { challenge: setup.challenge, code: otp(setup.secret) },
        admin,
      )
    ).json();
    const primary = await f.request(auth + "/login", "POST", {
      username: "admin",
      password: "correct-admin-password",
    });
    const challenge = await primary.json();
    expect(challenge.mfaRequired).toBe(true);
    expect(primary.headers.get("set-cookie")).not.toContain("pluhub_session=");
    expect(
      (
        await history(
          f,
          admin,
          "requestId=" + primary.headers.get("x-pluhub-request-id"),
        )
      ).items[0],
    ).toMatchObject({
      action: "login",
      outcome: "challenge",
      method: "password",
    });
    const bad = await f.request(
      auth + "/login/mfa",
      "POST",
      {
        challenge: challenge.challenge,
        code: "000000",
        recoveryCode: "bad-recovery-code",
      },
      cookie(primary),
    );
    expect(bad.status).toBe(401);
    const done = await f.request(
      auth + "/login/mfa",
      "POST",
      {
        challenge: challenge.challenge,
        recoveryCode: confirmed.recoveryCodes[0],
      },
      cookie(primary),
    );
    expect(done.status).toBe(200);
    expect(
      (
        await history(
          f,
          cookie(done),
          "requestId=" + done.headers.get("x-pluhub-request-id"),
        )
      ).items[0],
    ).toMatchObject({ outcome: "success", method: "recovery" });
    const key = authenticator();
    const options = await (
      await f.request(
        auth + "/passkeys/register/options",
        "POST",
        { name: "Security key" },
        cookie(done),
      )
    ).json();
    expect(
      (
        await f.request(
          auth + "/passkeys/register/verify",
          "POST",
          {
            challenge: options.challenge,
            response: key.register(options.options),
          },
          cookie(done),
        )
      ).status,
    ).toBe(200);
    const start = await f.request(auth + "/passkeys/login/options", "POST", {
      username: "admin",
    });
    const enrolled = (await history(f, cookie(done), "action=passkey.register"))
      .items[0];
    expect(enrolled.resource_id).toMatch(/^passkey:[a-f0-9]{64}$/);
    expect(enrolled.resource_id).not.toContain(key.id);
    const assertion = await start.json();
    const me = await (
      await f.request(auth + "/me", "GET", undefined, cookie(done))
    ).json();
    const passed = await f.request(
      auth + "/passkeys/login/verify",
      "POST",
      {
        challenge: assertion.challenge,
        response: key.login(assertion.options, me.id),
      },
      cookie(start),
    );
    expect(passed.status).toBe(200);
    expect(
      (
        await history(
          f,
          cookie(passed),
          "requestId=" + passed.headers.get("x-pluhub-request-id"),
        )
      ).items[0],
    ).toMatchObject({ outcome: "success", method: "passkey" });
    expect(
      (
        await f.request(
          auth + "/passkeys?id=" + key.id,
          "DELETE",
          undefined,
          cookie(done),
        )
      ).status,
    ).toBe(200);
    expect(
      (await history(f, cookie(done), "action=passkey.remove")).items[0]
        .resource_id,
    ).toBe(enrolled.resource_id);
    const db = database(f);
    try {
      const persisted = JSON.stringify(
        db.prepare("SELECT * FROM security_events").all(),
      );
      for (const secret of [
        setup.secret,
        challenge.challenge,
        confirmed.recoveryCodes[0],
        options.challenge,
        assertion.challenge,
        "bad-recovery-code",
      ])
        expect(persisted).not.toContain(secret);
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
});

it("records verified registration, email binding, email login and password recovery without email or verification proof contents", async () => {
  const f = await securityFixture();
  const clock = vi.spyOn(Date, "now");
  let now = Date.now();
  clock.mockImplementation(() => now);
  try {
    const admin = await f.admin(),
      email = "history-mail@example.test";
    const start = await (
      await f.request(auth + "/email/request", "POST", {
        email,
        purpose: "register",
      })
    ).json();
    const code = f.code();
    const registered = await f.request(auth + "/register", "POST", {
      username: "history-mail",
      password: "history-mail-password",
      email,
      challenge: start.challenge,
      code,
    });
    expect(registered.status).toBe(200);
    const session = cookie(registered);
    const bind = await (
      await f.request(
        auth + "/email/request",
        "POST",
        { email: "history-bound@example.test", purpose: "bind" },
        session,
      )
    ).json();
    expect(
      (
        await f.request(
          auth + "/email/bind",
          "POST",
          {
            email: "history-bound@example.test",
            challenge: bind.challenge,
            code: f.code(),
          },
          session,
        )
      ).status,
    ).toBe(200);
    now += 61001;
    const login = await (
      await f.request(auth + "/email/request", "POST", {
        email: "history-bound@example.test",
        purpose: "login",
      })
    ).json();
    const loggedIn = await f.request(auth + "/email/login", "POST", {
      email: "history-bound@example.test",
      challenge: login.challenge,
      code: f.code(),
    });
    expect(loggedIn.status).toBe(200);
    now += 61001;
    const requestReset = await f.request(auth + "/email/request", "POST", {
      email: "history-bound@example.test",
      purpose: "reset",
    });
    const reset = await requestReset.json();
    const completed = await f.request(
      auth + "/password/reset",
      "POST",
      {
        email: "history-bound@example.test",
        challenge: reset.challenge,
        code: f.code(),
        password: "history-new-password",
      },
      cookie(requestReset),
    );
    expect(completed.status).toBe(200);
    const events = (await history(f, admin, "", true)).items;
    for (const action of ["register", "email.bind", "password.reset"])
      expect(
        events.some((e: any) => e.action === action && e.outcome === "success"),
      ).toBe(true);
    expect(
      events.some(
        (e: any) =>
          e.action === "login" &&
          e.method === "email" &&
          e.outcome === "success",
      ),
    ).toBe(true);
    const db = database(f);
    try {
      const saved = JSON.stringify(
        db.prepare("SELECT * FROM security_events").all(),
      );
      for (const secret of [
        email,
        "history-bound@example.test",
        code,
        start.challenge,
        reset.challenge,
        "history-new-password",
        session.cookie.split("=")[1]!,
      ])
        expect(saved).not.toContain(secret);
    } finally {
      db.close();
    }
  } finally {
    clock.mockRestore();
    await f.close();
  }
});

it("records key IDs and validates intersecting filters and inclusive timestamps", async () => {
  const f = await fixture(["users", "auth", "ai-router"]);
  try {
    const admin = await f.admin();
    const response = await f.request(
      auth + "/keys",
      "POST",
      { name: "history-key" },
      admin,
    );
    const key = await response.json(),
      requestId = response.headers.get("x-pluhub-request-id")!;
    const created = (await history(f, admin, "requestId=" + requestId))
      .items[0];
    expect(created).toMatchObject({
      action: "key.create",
      resource_id: key.id,
      outcome: "success",
    });
    const filtered = await history(
      f,
      admin,
      new URLSearchParams({
        action: "key.create",
        method: "session",
        outcome: "success",
        requestId,
        from: String(created.created_at),
        to: String(created.created_at),
      }).toString(),
    );
    expect(filtered.total).toBe(1);
    expect(
      (await history(f, admin, "action=login&requestId=" + requestId)).total,
    ).toBe(0);
    expect(
      (await f.request(auth + "/keys?id=" + key.id, "DELETE", undefined, admin))
        .status,
    ).toBe(200);
    const db = database(f);
    try {
      expect(
        JSON.stringify(db.prepare("SELECT * FROM security_events").all()),
      ).not.toContain(key.token);
    } finally {
      db.close();
    }
    for (const q of [
      "limit=101",
      "offset=-1",
      "offset=Infinity",
      "from=NaN",
      "from=2&to=1",
      "action=constructor",
      "outcome=unknown",
      "method=unknown",
      "requestId=" + "x".repeat(129),
    ])
      expect(
        (
          await f.request(
            auth + "/security/history?" + q,
            "GET",
            undefined,
            admin,
          )
        ).status,
      ).toBe(400);
  } finally {
    await f.close();
  }
});

it("keeps authentication usable when history writes fail and exposes failures without database diagnostics", async () => {
  const f = await fixture(["users", "auth", "ai-router"]);
  const db = database(f);
  try {
    const admin = await f.admin();
    db.exec(
      "CREATE TRIGGER fail_security_insert BEFORE INSERT ON security_events BEGIN SELECT RAISE(ABORT,'private sqlite diagnostic'); END;",
    );
    const login = await f.request(auth + "/login", "POST", {
      username: "admin",
      password: "correct-admin-password",
    });
    expect(login.status).toBe(200);
    const session = cookie(login);
    const status = await (
      await f.request(
        auth + "/admin/security-history/status",
        "GET",
        undefined,
        session,
      )
    ).json();
    expect(status).toMatchObject({ available: true, dropped: 1, failures: 1 });
    expect((await history(f, admin)).storage.dropped).toBe(1);
    db.exec(
      "DROP TRIGGER fail_security_insert; ALTER TABLE security_events RENAME TO displaced_security_events;",
    );
    const failed = await f.request(
      auth + "/security/history",
      "GET",
      undefined,
      session,
    );
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toMatch(
      /sqlite|SELECT|private|auth\.sqlite/,
    );
    expect(
      (await f.kernel.invoke<any>("auth.security-history@1", {})).available,
    ).toBe(false);
    db.exec("ALTER TABLE displaced_security_events RENAME TO security_events;");
    expect((await history(f, session)).storage.available).toBe(true);
  } finally {
    db.close();
    await f.close();
  }
});

it("prunes expired and excess events, persists history on restart and migrates the previous auth schema without altering sessions", async () => {
  const f = await fixture(["users", "auth", "ai-router"]);
  const db = database(f);
  try {
    const admin = await f.admin();
    db.prepare("UPDATE security_events SET created_at=?").run(
      Date.now() - 91 * 86400000,
    );
    expect((await history(f, admin)).total).toBe(0);
    f.kernel.configure({ "official.auth": { securityHistoryMaxRows: 1000 } });
    const owner = await (
      await f.request(auth + "/me", "GET", undefined, admin)
    ).json();
    const insert = db.prepare(
      "INSERT INTO security_events VALUES(?,?,?,NULL,'login','failure','password',NULL,'',401,'invalid_credentials',NULL,NULL)",
    );
    db.exec("BEGIN");
    for (let n = 0; n < 1005; n++)
      insert.run("capacity-" + n, Date.now() + n, owner.id);
    db.exec("COMMIT");
    expect((await history(f, admin)).total).toBe(1000);
    const page = await history(f, admin, "limit=3&offset=998");
    expect(page.items).toHaveLength(2);
    await f.kernel.shutdown();
    let restarted = await createKernel(f.config);
    attachManagement(restarted, f.file, f.config);
    await restarted.start();
    try {
      const r = await restarted.fetch(
        new Request("http://localhost" + auth + "/security/history", {
          headers: admin,
        }),
      );
      expect(r.status).toBe(200);
      expect((await r.json()).total).toBe(1000);
    } finally {
      await restarted.shutdown();
    }
    db.exec(
      "DROP TABLE security_events; ALTER TABLE api_keys ADD COLUMN channel_id TEXT; ALTER TABLE api_keys ADD COLUMN credential_id TEXT; ALTER TABLE api_keys DROP COLUMN channel_ids_json; ALTER TABLE api_keys DROP COLUMN group_id; ALTER TABLE api_keys DROP COLUMN secret; PRAGMA user_version=6;",
    );
    restarted = await createKernel(f.config);
    attachManagement(restarted, f.file, f.config);
    await restarted.start();
    try {
      expect(
        (db.prepare("PRAGMA user_version").get() as any).user_version,
      ).toBe(12);
      const r = await restarted.fetch(
        new Request("http://localhost" + auth + "/security/history", {
          headers: admin,
        }),
      );
      expect(r.status).toBe(200);
      expect((await r.json()).total).toBe(0);
    } finally {
      await restarted.shutdown();
    }
  } finally {
    db.close();
    await f.close();
  }
});
