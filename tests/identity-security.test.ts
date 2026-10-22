import { it, expect, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  securityFixture,
  cookie,
  otp,
  authenticator,
} from "./security-helpers.js";
const auth = "/api/plugins/official.auth";
it("invalidates email login proofs when the verified address changes", async () => {
  const f = await securityFixture();
  try {
    const admin = await f.admin();
    const bind = async (email: string) => {
      const start = await (
        await f.request(
          auth + "/email/request",
          "POST",
          { email, purpose: "bind" },
          admin,
        )
      ).json();
      expect(
        (
          await f.request(
            auth + "/email/bind",
            "POST",
            { email, challenge: start.challenge, code: f.code() },
            admin,
          )
        ).status,
      ).toBe(200);
    };
    await bind("old@example.test");
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61000);
    try {
      const proof = await (
          await f.request(auth + "/email/request", "POST", {
            email: "old@example.test",
            purpose: "login",
          })
        ).json(),
        oldCode = f.code();
      await bind("new@example.test");
      expect(
        (
          await f.request(auth + "/email/login", "POST", {
            email: "old@example.test",
            challenge: proof.challenge,
            code: oldCode,
          })
        ).status,
      ).toBe(401);
    } finally {
      clock.mockRestore();
    }
  } finally {
    await f.close();
  }
});
it("expires email challenges and rejects unsafe SMTP or WebAuthn configuration", async () => {
  const f = await securityFixture();
  try {
    const start = await (
        await f.request(auth + "/email/request", "POST", {
          email: "expired@example.test",
          purpose: "register",
        })
      ).json(),
      code = f.code();
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 600001);
    try {
      expect(
        (
          await f.request(auth + "/register", "POST", {
            username: "expired",
            password: "expired-user-password",
            email: "expired@example.test",
            challenge: start.challenge,
            code,
          })
        ).status,
      ).toBe(400);
    } finally {
      clock.mockRestore();
    }
    expect(() =>
      f.kernel.configure({
        "official.mailer": {
          enabled: true,
          host: "smtp.example.test",
          from: "from@example.test",
          allowInsecure: true,
        },
      }),
    ).toThrow();
    expect(() =>
      f.kernel.configure({
        "official.auth": {
          webauthn: {
            enabled: true,
            rpID: "hub.example.test",
            origins: ["http://hub.example.test"],
          },
        },
      }),
    ).toThrow();
    expect(() =>
      f.kernel.configure({
        "official.auth": {
          webauthn: {
            enabled: true,
            rpID: "hub.example.test",
            origins: ["https://evil.test"],
          },
          secureCookie: true,
        },
      }),
    ).toThrow();
    await expect(
      f.kernel.invoke("mail.send@1", {
        to: "valid@example.test",
        subject: "Bad\r\nBcc: other@example.test",
        text: "test",
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  } finally {
    await f.close();
  }
});
it("registers only verified email owners, sends through SMTP and never accepts a client-selected role", async () => {
  const f = await securityFixture();
  try {
    const sent = await f.request(auth + "/email/request", "POST", {
      email: "alice@example.test",
      purpose: "register",
    });
    expect(sent.status).toBe(200);
    const challenge = (await sent.json()).challenge;
    expect(f.deliveries[0]?.to).toContain("alice@example.test");
    const code = f.code();
    const input = {
      username: "alice",
      password: "alice-long-password",
      email: "alice@example.test",
      challenge,
      code,
      role: "admin",
    };
    expect(
      (
        await f.request(auth + "/register", "POST", {
          ...input,
          code: "000000",
        })
      ).status,
    ).toBe(401);
    const registered = await f.request(auth + "/register", "POST", input);
    expect(registered.status).toBe(200);
    expect(await registered.clone().json()).toMatchObject({
      username: "alice",
      role: "user",
      email: "alice@example.test",
    });
    const session = cookie(registered);
    expect((await f.request(auth + "/register", "POST", input)).status).toBe(
      400,
    );
    expect(
      (await f.request("/api/host/config", "GET", undefined, session)).status,
    ).toBe(403);
    expect(
      (
        await f.request(auth + "/email/request", "POST", {
          email: "alice@example.test",
          purpose: "register",
        })
      ).status,
    ).toBe(429);
    const db = new DatabaseSync(
      join(f.config.dataDir, "official.auth/auth.sqlite"),
    );
    try {
      expect(
        JSON.stringify(db.prepare("SELECT * FROM auth_challenges").all()),
      ).not.toContain(code);
      expect(
        JSON.stringify(db.prepare("SELECT * FROM passwords").all()),
      ).not.toContain(input.password);
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
});
it("limits email OTP guesses and hides unknown login addresses without sending to them", async () => {
  const f = await securityFixture();
  try {
    const unknown = await f.request(auth + "/email/request", "POST", {
      email: "unknown@example.test",
      purpose: "login",
    });
    expect(unknown.status).toBe(200);
    const challenge = (await unknown.json()).challenge;
    expect(f.deliveries).toHaveLength(0);
    expect(
      (
        await f.request(auth + "/email/login", "POST", {
          email: "unknown@example.test",
          challenge,
          code: "123456",
        })
      ).status,
    ).toBe(400);
    const start = await (
        await f.request(auth + "/email/request", "POST", {
          email: "new@example.test",
          purpose: "register",
        })
      ).json(),
      code = f.code();
    for (let i = 0; i < 5; i++)
      expect(
        (
          await f.request(auth + "/register", "POST", {
            username: "newuser",
            password: "new-user-password",
            email: "new@example.test",
            challenge: start.challenge,
            code: code === "111111" ? "222222" : "111111",
          })
        ).status,
      ).toBe(401);
    expect(
      (
        await f.request(auth + "/register", "POST", {
          username: "newuser",
          password: "new-user-password",
          email: "new@example.test",
          challenge: start.challenge,
          code,
        })
      ).status,
    ).toBe(400);
  } finally {
    await f.close();
  }
});
it("enrolls encrypted TOTP, withholds sessions until MFA, rejects replay and consumes recovery codes once", async () => {
  const f = await securityFixture();
  try {
    const admin = await f.admin(),
      setup = await (
        await f.request(auth + "/totp/setup", "POST", {}, admin)
      ).json();
    expect(setup.qrDataURL).toMatch(/^data:image\/png;base64,/);
    const step = Math.floor(Date.now() / 30000),
      confirmed = await f.request(
        auth + "/totp/confirm",
        "POST",
        { challenge: setup.challenge, code: otp(setup.secret, step) },
        admin,
      );
    expect(confirmed.status).toBe(200);
    const recovery = (await confirmed.json()).recoveryCodes;
    expect(recovery).toHaveLength(10);
    const login = () =>
      f.request(auth + "/login", "POST", {
        username: "admin",
        password: "correct-admin-password",
      });
    const primary = await login();
    const pending = await primary.json();
    expect(pending.mfaRequired).toBe(true);
    expect(primary.headers.get("set-cookie")).not.toContain("pluhub_session=");
    const binding = cookie(primary);
    expect(
      (await f.request(auth + "/me", "GET", undefined, binding)).status,
    ).toBe(401);
    expect(
      (
        await f.request(
          auth + "/login/mfa",
          "POST",
          { challenge: pending.challenge, code: otp(setup.secret, step) },
          binding,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await f.request(auth + "/login/mfa", "POST", {
          challenge: pending.challenge,
          recoveryCode: recovery[0],
        })
      ).status,
    ).toBe(400);
    const mfa = await f.request(
      auth + "/login/mfa",
      "POST",
      { challenge: pending.challenge, recoveryCode: recovery[0] },
      binding,
    );
    expect(mfa.status).toBe(200);
    const session = cookie(mfa);
    const again = await login(),
      next = await again.json();
    expect(
      (
        await f.request(
          auth + "/login/mfa",
          "POST",
          { challenge: next.challenge, recoveryCode: recovery[0] },
          cookie(again),
        )
      ).status,
    ).toBe(401);
    const good = await f.request(
      auth + "/login/mfa",
      "POST",
      { challenge: next.challenge, code: otp(setup.secret, step + 1) },
      cookie(again),
    );
    expect(good.status).toBe(200);
    const db = new DatabaseSync(
      join(f.config.dataDir, "official.auth/auth.sqlite"),
    );
    try {
      expect(
        JSON.stringify(db.prepare("SELECT * FROM totp_credentials").all()),
      ).not.toContain(setup.secret);
      expect(
        JSON.stringify(db.prepare("SELECT * FROM recovery_codes").all()),
      ).not.toContain(recovery[1].replaceAll("-", ""));
    } finally {
      db.close();
    }
    await f.kernel.shutdown();
    await f.kernel.start();
    expect(
      (
        await (
          await f.request(auth + "/security", "GET", undefined, session)
        ).json()
      ).totpEnabled,
    ).toBe(true);
  } finally {
    await f.close();
  }
});
it("binds email only from a recent session and email login still requires enrolled TOTP", async () => {
  const f = await securityFixture();
  try {
    const admin = await f.admin(),
      sent = await (
        await f.request(
          auth + "/email/request",
          "POST",
          { email: "admin@example.test", purpose: "bind" },
          admin,
        )
      ).json();
    expect(
      (
        await f.request(
          auth + "/email/bind",
          "POST",
          {
            email: "admin@example.test",
            challenge: sent.challenge,
            code: f.code(),
          },
          admin,
        )
      ).status,
    ).toBe(200);
    const setup = await (
      await f.request(auth + "/totp/setup", "POST", {}, admin)
    ).json();
    const confirm = await f.request(
      auth + "/totp/confirm",
      "POST",
      { challenge: setup.challenge, code: otp(setup.secret) },
      admin,
    );
    expect(confirm.status).toBe(200);
    const recovery = (await confirm.json()).recoveryCodes;
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61000);
    try {
      const start = await (
          await f.request(auth + "/email/request", "POST", {
            email: "admin@example.test",
            purpose: "login",
          })
        ).json(),
        code = f.code();
      const login = await f.request(auth + "/email/login", "POST", {
        email: "admin@example.test",
        challenge: start.challenge,
        code,
      });
      expect(login.status).toBe(200);
      const pending = await login.json();
      expect(pending.mfaRequired).toBe(true);
      expect(
        (
          await f.request(
            auth + "/login/mfa",
            "POST",
            { challenge: pending.challenge, recoveryCode: recovery[0] },
            cookie(login),
          )
        ).status,
      ).toBe(200);
    } finally {
      clock.mockRestore();
    }
    const key = await (
      await f.request(
        auth + "/keys",
        "POST",
        { name: "no-security-escalation" },
        admin,
      )
    ).json();
    expect(
      (
        await f.request(
          auth + "/totp/setup",
          "POST",
          {},
          { authorization: "Bearer " + key.token },
        )
      ).status,
    ).toBe(403);
    const stale = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 360000);
    try {
      expect(
        (await f.request(auth + "/totp/setup", "POST", {}, admin)).status,
      ).toBe(403);
    } finally {
      stale.mockRestore();
    }
  } finally {
    await f.close();
  }
});
it("requires Turnstile server verification before password login or registration email delivery", async () => {
  const f = await securityFixture();
  try {
    await f.admin();
    f.kernel.configure({
      "official.turnstile": {
        enabled: true,
        siteKey: "public-test",
        secretRef: "env:PLUHUB_TEST_TURNSTILE",
        secretRefs: ["env:PLUHUB_TEST_TURNSTILE"],
        hostnames: ["localhost"],
      },
      "official.auth": {
        registrationEnabled: true,
        emailLoginEnabled: true,
        captcha: { login: true, register: true },
      },
    });
    const input = { username: "admin", password: "correct-admin-password" };
    expect((await f.request(auth + "/login", "POST", input)).status).toBe(400);
    expect(
      (
        await f.request(auth + "/login", "POST", {
          ...input,
          turnstileToken: "invalid",
        })
      ).status,
    ).toBe(400);
    const token = "valid-login-unique";
    expect(
      (
        await f.request(auth + "/login", "POST", {
          ...input,
          turnstileToken: token,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await f.request(auth + "/login", "POST", {
          ...input,
          turnstileToken: token,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await f.request(auth + "/email/request", "POST", {
          email: "bot@example.test",
          purpose: "register",
        })
      ).status,
    ).toBe(400);
    expect(f.deliveries).toHaveLength(0);
    expect(
      (
        await f.request(auth + "/email/request", "POST", {
          email: "human@example.test",
          purpose: "register",
          turnstileToken: "valid-register-unique",
        })
      ).status,
    ).toBe(200);
    expect(f.deliveries).toHaveLength(1);
  } finally {
    await f.close();
  }
});
it("verifies real WebAuthn signatures, origin, RP, UV, challenge replay and credential revocation", async () => {
  const f = await securityFixture();
  try {
    const admin = await f.admin(),
      user = await (
        await f.request(auth + "/me", "GET", undefined, admin)
      ).json(),
      key = authenticator();
    const begin = async () =>
      await (
        await f.request(
          auth + "/passkeys/register/options",
          "POST",
          { name: "Virtual FIDO2", kind: "hardware" },
          admin,
        )
      ).json();
    const wrong = await begin();
    expect(wrong.options.authenticatorSelection).toMatchObject({
      authenticatorAttachment: "cross-platform",
      userVerification: "required",
    });
    expect(
      (
        await f.request(
          auth + "/passkeys/register/verify",
          "POST",
          {
            challenge: wrong.challenge,
            response: key.register(wrong.options, "https://evil.test"),
          },
          admin,
        )
      ).status,
    ).toBe(400);
    const registration = await begin();
    expect(
      (
        await f.request(
          auth + "/passkeys/register/verify",
          "POST",
          {
            challenge: registration.challenge,
            response: key.register(registration.options),
          },
          admin,
        )
      ).status,
    ).toBe(200);
    const start = async () => {
      const r = await f.request(auth + "/passkeys/login/options", "POST", {});
      return { r, ...(await r.json()) };
    };
    for (const override of [
      { origin: "https://evil.test" },
      { rpID: "evil.test" },
      { uv: false },
      { crossOrigin: true },
    ]) {
      const request = await start();
      expect(
        (
          await f.request(
            auth + "/passkeys/login/verify",
            "POST",
            {
              challenge: request.challenge,
              response: key.login(request.options, user.id, override),
            },
            cookie(request.r),
          )
        ).status,
      ).toBe(401);
    }
    const request = await start(),
      body = {
        challenge: request.challenge,
        response: key.login(request.options, user.id),
      },
      response = await f.request(
        auth + "/passkeys/login/verify",
        "POST",
        body,
        cookie(request.r),
      );
    expect(response.status).toBe(200);
    const session = cookie(response);
    expect(
      (
        await f.request(
          auth + "/passkeys/login/verify",
          "POST",
          body,
          cookie(request.r),
        )
      ).status,
    ).toBe(400);
    const rollback = await start();
    expect(
      (
        await f.request(
          auth + "/passkeys/login/verify",
          "POST",
          {
            challenge: rollback.challenge,
            response: key.login(rollback.options, user.id, { counter: 1 }),
          },
          cookie(rollback.r),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await f.request(
          auth + "/passkeys?id=" + encodeURIComponent(key.id),
          "DELETE",
          undefined,
          admin,
        )
      ).status,
    ).toBe(200);
    expect(
      (await f.request(auth + "/me", "GET", undefined, session)).status,
    ).toBe(401);
  } finally {
    await f.close();
  }
});
it("rejects disabled users after a pending MFA challenge and provides local-only factor recovery", async () => {
  const f = await securityFixture();
  try {
    const admin = await f.admin(),
      alice = await f.kernel.invoke<any>("users.manage@1", {
        action: "create",
        username: "alice",
      });
    await f.request(
      auth + "/password",
      "POST",
      { userId: alice.id, password: "alice-long-password" },
      admin,
    );
    const login = await f.request(auth + "/login", "POST", {
        username: "alice",
        password: "alice-long-password",
      }),
      session = cookie(login),
      setup = await (
        await f.request(auth + "/totp/setup", "POST", {}, session)
      ).json(),
      confirmed = await (
        await f.request(
          auth + "/totp/confirm",
          "POST",
          { challenge: setup.challenge, code: otp(setup.secret) },
          session,
        )
      ).json();
    const primary = await f.request(auth + "/login", "POST", {
        username: "alice",
        password: "alice-long-password",
      }),
      pending = await primary.json();
    await f.kernel.invoke("users.manage@1", {
      action: "update",
      id: alice.id,
      enabled: false,
    });
    expect(
      (
        await f.request(
          auth + "/login/mfa",
          "POST",
          {
            challenge: pending.challenge,
            recoveryCode: confirmed.recoveryCodes[0],
          },
          cookie(primary),
        )
      ).status,
    ).toBe(401);
    await f.kernel.shutdown();
    const recovered = await promisify(execFile)(process.execPath, [
      join(process.cwd(), "apps/cli/dist/index.js"),
      "call",
      "auth.reset-factors@1",
      JSON.stringify({ username: "alice" }),
      "--config",
      f.file,
    ]);
    expect(JSON.parse(recovered.stdout)).toEqual({ ok: true });
    await f.kernel.start();
    await f.kernel.invoke("users.manage@1", {
      action: "update",
      id: alice.id,
      enabled: true,
    });
    expect(
      (
        await f.request(auth + "/login", "POST", {
          username: "alice",
          password: "alice-long-password",
        })
      ).headers.get("set-cookie"),
    ).toContain("pluhub_session=");
    expect(
      (
        await f.request(
          auth + "/reset-factors",
          "POST",
          { username: "alice" },
          admin,
        )
      ).status,
    ).toBe(404);
  } finally {
    await f.close();
  }
});
