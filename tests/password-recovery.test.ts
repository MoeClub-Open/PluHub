import { it, expect, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import {
  securityFixture,
  cookie,
  otp,
  authenticator,
} from "./security-helpers.js";

const auth = "/api/plugins/official.auth";
const originalPassword = "recovery-original-password";
const replacementPassword = "recovery-replacement-password";
async function recoveryFixture() {
  const f = await securityFixture({ name: "Moe", defaultLanguage: "zh-CN" });
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  const post = (
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) => f.request(auth + path, "POST", body, headers);
  const read = async (response: Response, status = 200) => {
    expect(response.status).toBe(status);
    return response.json();
  };
  let config = f.config.plugins.find((p: any) =>
    p.path.endsWith("auth"),
  ).config;
  const configure = (patch: Record<string, unknown>) => {
    config = { ...config, ...patch };
    f.kernel.configure({ "official.auth": config });
  };
  try {
    const admin = await f.admin();
    const email = "recovery@example.test";
    const start = await read(
      await post("/email/request", { email, purpose: "register" }),
    );
    const registered = await post("/register", {
      username: "recovery-user",
      password: originalPassword,
      email,
      challenge: start.challenge,
      code: f.code(),
      language: "en-US",
    });
    const user = await read(registered),
      session = cookie(registered);
    const login = (password: string, username = user.username) =>
      post("/login", { username, password });
    const requestReset = async (extra: Record<string, unknown> = {}) => {
      now += 61001;
      const sent = await post("/email/request", {
        email,
        purpose: "reset",
        language: "zh-CN",
        ...extra,
      });
      const start = await read(sent);
      return {
        headers: cookie(sent),
        input: {
          email,
          challenge: start.challenge,
          code: f.code(),
          password: replacementPassword,
        },
        response: sent,
      };
    };
    const addTotp = async () => {
      const setup = await read(await post("/totp/setup", {}, session));
      const confirmed = await read(
        await post(
          "/totp/confirm",
          {
            challenge: setup.challenge,
            code: otp(setup.secret),
          },
          session,
        ),
      );
      return {
        secret: setup.secret as string,
        codes: confirmed.recoveryCodes as string[],
      };
    };
    const addKey = async (ownerSession = session) => {
      const key = authenticator();
      const options = await read(
        await post(
          "/passkeys/register/options",
          { name: "Recovery device" },
          ownerSession,
        ),
      );
      await read(
        await post(
          "/passkeys/register/verify",
          {
            challenge: options.challenge,
            response: key.register(options.options),
            name: "Recovery device",
          },
          ownerSession,
        ),
      );
      return key;
    };
    const keyLogin = async (
      key: ReturnType<typeof authenticator>,
      body: unknown,
      headers: Record<string, string>,
      userId = user.id,
    ) => {
      const start = await post("/passkeys/login/options", body, headers);
      const options = await read(start);
      const verified = await post(
        "/passkeys/login/verify",
        {
          challenge: options.challenge,
          response: key.login(options.options, userId),
        },
        {
          cookie: [headers.cookie, cookie(start).cookie]
            .filter(Boolean)
            .join("; "),
        },
      );
      await read(verified);
      return cookie(verified);
    };
    return {
      ...f,
      email,
      user,
      session,
      admin,
      post,
      read,
      login,
      requestReset,
      configure,
      addTotp,
      addKey,
      keyLogin,
      advance: (ms: number) => {
        now += ms;
      },
      db: () =>
        new DatabaseSync(
          join(f.directory, "data", "official.auth", "auth.sqlite"),
        ),
      async close() {
        clock.mockRestore();
        await f.close();
      },
    };
  } catch (error) {
    clock.mockRestore();
    await f.close();
    throw error;
  }
}

it("resets only the verified owner, revokes all their sessions, preserves API keys and follows their language", async () => {
  const f = await recoveryFixture();
  try {
    await f.read(
      await f.request(
        auth + "/preferences",
        "PATCH",
        { language: "en-US" },
        f.session,
      ),
    );
    const second = await f.login(originalPassword);
    await f.read(second);
    const secondSession = cookie(second);
    const key = await f.read(
      await f.post("/keys", { name: "preserved-key" }, f.session),
      201,
    );
    const proof = await f.requestReset();
    expect(f.deliveries.at(-1)?.subject).toBe("Moe · Reset your password");
    expect(f.deliveries.at(-1)?.html).toContain('lang="en-US"');
    const admin = await (
      await f.request(auth + "/me", "GET", undefined, f.admin)
    ).json();
    const completed = await f.post(
      "/password/reset",
      {
        ...proof.input,
        userId: admin.id,
        username: "admin",
        role: "admin",
      },
      proof.headers,
    );
    expect(await f.read(completed)).toEqual({
      ok: true,
      username: f.user.username,
    });
    expect(completed.headers.get("cache-control")).toBe("no-store");
    expect(
      completed.headers.getSetCookie().every((c) => c.includes("Max-Age=0")),
    ).toBe(true);
    for (const session of [f.session, secondSession]) {
      const r = await f.request(auth + "/me", "GET", undefined, session);
      await f.read(r, 401);
    }
    await f.read(await f.login(originalPassword), 401);
    const loggedIn = await f.read(await f.login(replacementPassword));
    expect(loggedIn.id).toBe(f.user.id);
    expect(loggedIn.role).toBe("user");
    const keyUser = await f.read(
      await f.request(auth + "/me", "GET", undefined, {
        authorization: "Bearer " + key.token,
      }),
    );
    expect(keyUser.id).toBe(f.user.id);
    expect(
      (await f.read(await f.request(auth + "/me", "GET", undefined, f.admin)))
        .id,
    ).toBe(admin.id);
    await f.read(
      await f.post("/password/reset", proof.input, proof.headers),
      400,
    );
  } finally {
    await f.close();
  }
});

it("gives indistinguishable reset responses for unknown and disabled emails without sending mail", async () => {
  const f = await recoveryFixture();
  try {
    await f.kernel.invoke("users.manage@1", {
      action: "update",
      id: f.user.id,
      enabled: false,
    });
    const before = f.deliveries.length;
    f.advance(61001);
    const responses = [];
    for (const email of [f.email, "unknown@example.test"]) {
      const response = await f.post("/email/request", {
        email,
        purpose: "reset",
      });
      responses.push(await f.read(response));
      expect(response.headers.getSetCookie()).toHaveLength(1);
    }
    expect(responses[0].ok).toBe(true);
    expect(responses[0].message).toBe(responses[1].message);
    expect(Object.keys(responses[0])).toEqual(Object.keys(responses[1]));
    expect(f.deliveries).toHaveLength(before);
    await f.read(
      await f.post("/password/reset", {
        email: f.email,
        code: "000000",
        challenge: responses[0].challenge,
        password: replacementPassword,
      }),
      400,
    );
  } finally {
    await f.close();
  }
});

it("binds recovery to one browser, rejects duplicate cookies and does not consume a proof for a weak password", async () => {
  const f = await recoveryFixture();
  try {
    const proof = await f.requestReset();
    await f.read(await f.post("/password/reset", proof.input), 400);
    await f.read(
      await f.post("/password/reset", proof.input, {
        cookie: "pluhub_reset=" + "x".repeat(43),
      }),
      400,
    );
    await f.read(
      await f.post("/password/reset", proof.input, {
        cookie: proof.headers.cookie + "; " + proof.headers.cookie,
      }),
      400,
    );
    await f.read(
      await f.post(
        "/password/reset",
        { ...proof.input, password: "short" },
        proof.headers,
      ),
      400,
    );
    await f.read(await f.login(originalPassword));
    await f.read(await f.post("/password/reset", proof.input, proof.headers));
    await f.read(await f.login(replacementPassword));
  } finally {
    await f.close();
  }
});

it("does not accept login, registration or binding email proofs as password recovery", async () => {
  const f = await recoveryFixture();
  try {
    for (const purpose of ["login", "register", "bind"]) {
      f.advance(61001);
      const email = purpose === "login" ? f.email : purpose + "@example.test";
      const sent = await f.read(
        await f.post(
          "/email/request",
          { email, purpose },
          purpose === "bind" ? f.session : {},
        ),
      );
      await f.read(
        await f.post("/password/reset", {
          email,
          challenge: sent.challenge,
          code: f.code(),
          password: replacementPassword,
        }),
        400,
      );
    }
    await f.read(await f.login(originalPassword));
  } finally {
    await f.close();
  }
});

it("requires enrolled TOTP before changing the password and ignores client-selected replacement fields at MFA completion", async () => {
  const f = await recoveryFixture();
  try {
    const factor = await f.addTotp(),
      proof = await f.requestReset();
    const pending = await f.read(
      await f.post("/password/reset", proof.input, proof.headers),
    );
    expect(pending.mfaRequired).toBe(true);
    expect(pending.methods).toEqual(["totp", "recovery"]);
    expect((await f.read(await f.login(originalPassword))).mfaRequired).toBe(
      true,
    );
    await f.read(await f.login(replacementPassword), 401);
    await f.read(
      await f.post(
        "/password/reset/finish",
        { challenge: pending.challenge, code: "abcdef" },
        proof.headers,
      ),
      401,
    );
    const completed = await f.post(
      "/password/reset/finish",
      {
        challenge: pending.challenge,
        code: otp(factor.secret),
        password: "injected-replacement-password",
        userId: "admin",
      },
      proof.headers,
    );
    expect((await f.read(completed)).ok).toBe(true);
    expect(
      completed.headers.getSetCookie().every((c) => c.includes("Max-Age=0")),
    ).toBe(true);
    await f.read(await f.login(originalPassword), 401);
    await f.read(await f.login("injected-replacement-password"), 401);
    const newLogin = await f.login(replacementPassword),
      challenge = await f.read(newLogin);
    expect(challenge.mfaRequired).toBe(true);
    await f.read(
      await f.post(
        "/login/mfa",
        { challenge: challenge.challenge, code: otp(factor.secret) },
        cookie(newLogin),
      ),
      401,
    );
    await f.read(
      await f.post(
        "/login/mfa",
        { challenge: challenge.challenge, recoveryCode: factor.codes[0] },
        cookie(newLogin),
      ),
    );
  } finally {
    await f.close();
  }
});

it("rolls back recovery-code consumption and session revocation when password storage fails", async () => {
  const f = await recoveryFixture();
  const db = f.db();
  try {
    const factor = await f.addTotp(),
      proof = await f.requestReset();
    const pending = await f.read(
      await f.post("/password/reset", proof.input, proof.headers),
    );
    const stored = db
      .prepare(
        "SELECT secret FROM auth_challenges WHERE kind='password-reset-mfa'",
      )
      .get() as any;
    expect(stored.secret.includes(replacementPassword)).toBe(false);
    expect(stored.secret.includes("passwordHash")).toBe(false);
    db.exec(
      "CREATE TRIGGER deny_password_update BEFORE UPDATE ON passwords BEGIN SELECT RAISE(ABORT,'test write failure'); END",
    );
    await f.read(
      await f.post(
        "/password/reset/finish",
        { challenge: pending.challenge, recoveryCode: factor.codes[0] },
        proof.headers,
      ),
      500,
    );
    expect(
      (
        db
          .prepare("SELECT count(*) n FROM recovery_codes WHERE user_id=?")
          .get(f.user.id) as any
      ).n,
    ).toBe(10);
    expect(
      (await f.read(await f.request(auth + "/me", "GET", undefined, f.session)))
        .id,
    ).toBe(f.user.id);
    db.exec("DROP TRIGGER deny_password_update");
    await f.read(
      await f.post(
        "/password/reset/finish",
        { challenge: pending.challenge, recoveryCode: factor.codes[0] },
        proof.headers,
      ),
    );
    expect(
      (
        db
          .prepare("SELECT count(*) n FROM recovery_codes WHERE user_id=?")
          .get(f.user.id) as any
      ).n,
    ).toBe(9);
    await f.read(
      await f.post(
        "/password/reset/finish",
        { challenge: pending.challenge, recoveryCode: factor.codes[1] },
        proof.headers,
      ),
      400,
    );
    const login = await f.login(replacementPassword),
      challenge = await f.read(login);
    await f.read(
      await f.post(
        "/login/mfa",
        { challenge: challenge.challenge, recoveryCode: factor.codes[0] },
        cookie(login),
      ),
      401,
    );
    await f.read(
      await f.post(
        "/login/mfa",
        { challenge: challenge.challenge, recoveryCode: factor.codes[1] },
        cookie(login),
      ),
    );
  } finally {
    db.close();
    await f.close();
  }
});

it("rejects an old Passkey session even when it was issued in the same millisecond, and accepts fresh user verification", async () => {
  const f = await recoveryFixture();
  try {
    const key = await f.addKey();
    await f.addTotp();
    const proof = await f.requestReset();
    const old = await f.keyLogin(
      key,
      { username: f.user.username },
      proof.headers,
    );
    const pending = await f.read(
      await f.post("/password/reset", proof.input, proof.headers),
    );
    await f.read(
      await f.post(
        "/password/reset/finish",
        { challenge: pending.challenge },
        { cookie: proof.headers.cookie + "; " + old.cookie },
      ),
      401,
    );
    const fresh = await f.keyLogin(
      key,
      { resetChallenge: pending.challenge },
      proof.headers,
    );
    await f.read(
      await f.post(
        "/password/reset/finish",
        { challenge: pending.challenge },
        { cookie: proof.headers.cookie + "; " + fresh.cookie },
      ),
    );
    await f.read(await f.request(auth + "/me", "GET", undefined, fresh), 401);
    expect((await f.read(await f.login(replacementPassword))).mfaRequired).toBe(
      true,
    );
  } finally {
    await f.close();
  }
});

it("authorizes Passkey recovery only after CAPTCHA and verified email, without allowing another credential owner", async () => {
  const f = await recoveryFixture();
  try {
    const targetKey = await f.addKey(),
      otherKey = await f.addKey(f.admin);
    await f.addTotp();
    f.kernel.configure({
      "official.turnstile": {
        enabled: true,
        siteKey: "public-test",
        secretRef: "env:PLUHUB_TEST_TURNSTILE",
        secretRefs: ["env:PLUHUB_TEST_TURNSTILE"],
        hostnames: ["localhost"],
      },
    });
    f.configure({ captcha: { login: true } });
    await f.read(
      await f.post("/email/request", { email: f.email, purpose: "reset" }),
      400,
    );
    const proof = await f.requestReset({
      captchaToken: "valid-login-recovery",
    });
    const pending = await f.read(
      await f.post("/password/reset", proof.input, proof.headers),
    );
    const checked = f.validations();
    await f.read(
      await f.post(
        "/passkeys/login/options",
        { username: f.user.username },
        proof.headers,
      ),
      400,
    );
    await f.read(
      await f.post(
        "/passkeys/login/options",
        { resetChallenge: "forged" },
        proof.headers,
      ),
      400,
    );
    const start = await f.post(
      "/passkeys/login/options",
      { resetChallenge: pending.challenge, username: "admin" },
      proof.headers,
    );
    const options = await f.read(start);
    expect(options.options.allowCredentials.map((c: any) => c.id)).toEqual([
      targetKey.id,
    ]);
    const admin = await f.read(
      await f.request(auth + "/me", "GET", undefined, f.admin),
    );
    await f.read(
      await f.post(
        "/passkeys/login/verify",
        {
          challenge: options.challenge,
          response: otherKey.login(options.options, admin.id),
        },
        { cookie: proof.headers.cookie + "; " + cookie(start).cookie },
      ),
      401,
    );
    const fresh = await f.keyLogin(
      targetKey,
      { resetChallenge: pending.challenge },
      proof.headers,
    );
    await f.read(
      await f.post(
        "/password/reset/finish",
        { challenge: pending.challenge },
        {
          cookie: proof.headers.cookie + "; " + fresh.cookie,
          origin: "http://localhost",
        },
      ),
    );
    expect(f.validations()).toBe(checked);
  } finally {
    await f.close();
  }
});

it("invalidates pending recovery after the verified mailbox changes", async () => {
  const f = await recoveryFixture();
  try {
    const factor = await f.addTotp(),
      proof = await f.requestReset();
    const pending = await f.read(
      await f.post("/password/reset", proof.input, proof.headers),
    );
    const email = "replacement@example.test";
    const start = await f.read(
      await f.post("/email/request", { email, purpose: "bind" }, f.session),
    );
    await f.read(
      await f.post(
        "/email/bind",
        { email, challenge: start.challenge, code: f.code() },
        f.session,
      ),
    );
    await f.read(
      await f.post(
        "/password/reset/finish",
        { challenge: pending.challenge, recoveryCode: factor.codes[0] },
        proof.headers,
      ),
      400,
    );
    expect((await f.read(await f.login(originalPassword))).mfaRequired).toBe(
      true,
    );
  } finally {
    await f.close();
  }
});

it("invalidates both email proofs and MFA recovery when another password change wins", async () => {
  const f = await recoveryFixture();
  try {
    const proof = await f.requestReset();
    await f.kernel.invoke("auth.bootstrap@1", {
      userId: f.user.id,
      password: "changed-by-administrator",
    });
    await f.read(
      await f.post("/password/reset", proof.input, proof.headers),
      400,
    );
    const login = await f.login("changed-by-administrator");
    await f.read(login);
    const session = cookie(login);
    const setup = await f.read(await f.post("/totp/setup", {}, session));
    const factors = await f.read(
      await f.post(
        "/totp/confirm",
        { challenge: setup.challenge, code: otp(setup.secret) },
        session,
      ),
    );
    const next = await f.requestReset();
    const pending = await f.read(
      await f.post("/password/reset", next.input, next.headers),
    );
    await f.kernel.invoke("auth.bootstrap@1", {
      userId: f.user.id,
      password: "another-administrator-change",
    });
    await f.read(
      await f.post(
        "/password/reset/finish",
        {
          challenge: pending.challenge,
          recoveryCode: factors.recoveryCodes[0],
        },
        next.headers,
      ),
      400,
    );
  } finally {
    await f.close();
  }
});

it("limits guesses, expires email proofs, and rejects an owner disabled after issuance", async () => {
  const f = await recoveryFixture();
  try {
    const proof = await f.requestReset();
    for (let i = 0; i < 5; i++)
      await f.read(
        await f.post(
          "/password/reset",
          { ...proof.input, code: "000000" },
          proof.headers,
        ),
        401,
      );
    await f.read(
      await f.post("/password/reset", proof.input, proof.headers),
      400,
    );
    const expired = await f.requestReset();
    f.advance(600001);
    await f.read(
      await f.post("/password/reset", expired.input, expired.headers),
      400,
    );
    const pending = await f.requestReset();
    await f.kernel.invoke("users.manage@1", {
      action: "update",
      id: f.user.id,
      enabled: false,
    });
    await f.read(
      await f.post("/password/reset", pending.input, pending.headers),
      401,
    );
  } finally {
    await f.close();
  }
});

it("preserves encrypted MFA recovery across restart, enforces its expiry and rechecks feature and user state", async () => {
  const f = await recoveryFixture();
  try {
    const factor = await f.addTotp(),
      proof = await f.requestReset();
    const pending = await f.read(
      await f.post("/password/reset", proof.input, proof.headers),
    );
    f.configure({ passwordResetEnabled: false });
    await f.read(
      await f.post(
        "/password/reset/finish",
        { challenge: pending.challenge, recoveryCode: factor.codes[0] },
        proof.headers,
      ),
      403,
    );
    f.configure({ passwordResetEnabled: true, emailLoginEnabled: false });
    expect(
      (await f.read(await f.request(auth + "/options"))).passwordResetEnabled,
    ).toBe(true);
    await f.kernel.shutdown();
    await f.kernel.start();
    await f.read(
      await f.post(
        "/password/reset/finish",
        { challenge: pending.challenge, recoveryCode: factor.codes[0] },
        proof.headers,
      ),
    );
    const next = await f.requestReset();
    const challenge = await f.read(
      await f.post("/password/reset", next.input, next.headers),
    );
    f.advance(300001);
    await f.read(
      await f.post(
        "/password/reset/finish",
        { challenge: challenge.challenge, recoveryCode: factor.codes[1] },
        next.headers,
      ),
      400,
    );
    const last = await f.requestReset();
    const lastChallenge = await f.read(
      await f.post("/password/reset", last.input, last.headers),
    );
    await f.kernel.invoke("users.manage@1", {
      action: "update",
      id: f.user.id,
      enabled: false,
    });
    await f.read(
      await f.post(
        "/password/reset/finish",
        { challenge: lastChallenge.challenge, recoveryCode: factor.codes[1] },
        last.headers,
      ),
      401,
    );
  } finally {
    await f.close();
  }
});

it("uses a Host-prefixed secure cookie and never accepts its unprefixed alternative", async () => {
  const f = await recoveryFixture();
  try {
    f.configure({ secureCookie: true });
    const proof = await f.requestReset();
    expect(proof.headers.cookie.startsWith("__Host-pluhub_reset=")).toBe(true);
    const setCookie = proof.response.headers.getSetCookie()[0]!;
    for (const part of ["Secure", "HttpOnly", "SameSite=Strict", "Path=/"])
      expect(setCookie).toContain(part);
    expect(setCookie).not.toContain("Domain=");
    await f.read(
      await f.post("/password/reset", proof.input, {
        cookie: proof.headers.cookie.replace("__Host-", ""),
      }),
      400,
    );
    const completed = await f.post(
      "/password/reset",
      proof.input,
      proof.headers,
    );
    await f.read(completed);
    expect(
      completed.headers
        .getSetCookie()
        .some(
          (c) =>
            c.startsWith("__Host-pluhub_reset=;") && c.includes("Max-Age=0"),
        ),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

it("commits only one concurrent recovery and limits guesses at the second factor", async () => {
  const f = await recoveryFixture();
  try {
    const proof = await f.requestReset();
    const results = await Promise.all([
      f.post("/password/reset", proof.input, proof.headers),
      f.post(
        "/password/reset",
        { ...proof.input, password: "concurrent-other-password" },
        proof.headers,
      ),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    for (const r of results) await r.json();
    const successfulPassword =
      results[0]!.status === 200
        ? replacementPassword
        : "concurrent-other-password";
    const login = await f.login(successfulPassword);
    await f.read(login);
    const session = cookie(login);
    const setup = await f.read(await f.post("/totp/setup", {}, session));
    const confirmed = await f.read(
      await f.post(
        "/totp/confirm",
        { challenge: setup.challenge, code: otp(setup.secret) },
        session,
      ),
    );
    const next = await f.requestReset();
    const pending = await f.read(
      await f.post("/password/reset", next.input, next.headers),
    );
    for (let i = 0; i < 5; i++)
      await f.read(
        await f.post(
          "/password/reset/finish",
          { challenge: pending.challenge, code: "abcdef" },
          next.headers,
        ),
        401,
      );
    await f.read(
      await f.post(
        "/password/reset/finish",
        {
          challenge: pending.challenge,
          recoveryCode: confirmed.recoveryCodes[0],
        },
        next.headers,
      ),
      400,
    );
    expect((await f.read(await f.login(successfulPassword))).mfaRequired).toBe(
      true,
    );
    const db = f.db();
    try {
      expect(
        (
          db
            .prepare("SELECT count(*) n FROM recovery_codes WHERE user_id=?")
            .get(f.user.id) as any
        ).n,
      ).toBe(10);
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
});
