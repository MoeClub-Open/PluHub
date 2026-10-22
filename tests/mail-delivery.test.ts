import { it, expect, vi } from "vitest";
import { securityFixture } from "./security-helpers.js";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

const auth = "/api/plugins/official.auth";
const mailer = "/api/plugins/official.mailer";
it("previews and sends the same branded samples in the current account language without creating login proofs", async () => {
  const f = await securityFixture({
    name: "Moe & API",
    defaultLanguage: "zh-CN",
  });
  try {
    const session = await f.admin();
    const admin = await f.kernel.invoke<any>("users.lookup@1", {
      username: "admin",
    });
    const db = new DatabaseSync(
      join(f.directory, "data", "official.auth", "auth.sqlite"),
    );
    try {
      const before = db
        .prepare("SELECT count(*) AS n FROM auth_challenges")
        .get()!.n;
      for (const language of ["en-US", "zh-CN"]) {
        await f.kernel.invoke("users.manage@1", {
          action: "preferences",
          id: admin.id,
          language,
        });
        for (const template of ["test", "register", "login", "bind", "reset"]) {
          const input = {
            template,
            language: language === "en-US" ? "zh-CN" : "en-US",
          };
          const response = await f.request(
            mailer + "/preview",
            "POST",
            input,
            session,
          );
          expect(response.status).toBe(200);
          expect(response.headers.get("cache-control")).toBe("no-store");
          const preview = await response.json();
          expect(preview.language).toBe(language);
          expect(preview.template).toBe(template);
          expect(preview.html).toContain(`lang="${language}"`);
          expect(preview.html).toContain("Moe &amp; API");
          expect(preview.to).toBeUndefined();
          const deliveryCount = f.deliveries.length;
          expect(
            (
              await f.request(
                mailer + "/test",
                "POST",
                { ...input, to: "sample@example.test" },
                session,
              )
            ).status,
          ).toBe(200);
          expect(f.deliveries).toHaveLength(deliveryCount + 1);
          const mail = f.deliveries.at(-1)!;
          expect(mail.subject).toBe(preview.subject);
          expect(mail.html.replaceAll("\r\n", "\n").trimEnd()).toBe(
            preview.html.trimEnd(),
          );
          expect(mail.text.replaceAll("\r\n", "\n").trimEnd()).toBe(
            preview.text.trimEnd(),
          );
          expect(mail.raw).toMatch(/Content-Type: multipart\/alternative/i);
          expect(mail.subject).not.toContain("123456");
        }
      }
      expect(
        db.prepare("SELECT count(*) AS n FROM auth_challenges").get()!.n,
      ).toBe(before);
      const count = f.deliveries.length;
      for (const path of ["/preview", "/test"])
        for (const template of ["<img>", null, {}, "unknown"])
          expect(
            (
              await f.request(
                mailer + path,
                "POST",
                { template, to: "sample@example.test" },
                session,
              )
            ).status,
          ).toBe(400);
      expect(f.deliveries).toHaveLength(count);
      f.kernel.configure({ "official.mailer": { enabled: false } });
      expect(
        (
          await f.request(
            mailer + "/preview",
            "POST",
            { template: "register" },
            session,
          )
        ).status,
      ).toBe(200);
      expect(f.deliveries).toHaveLength(count);
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
});
it("restricts preview and sample delivery to administrators without leaking account languages", async () => {
  const f = await securityFixture();
  try {
    const start = await (
      await f.request(auth + "/email/request", "POST", {
        email: "member@example.test",
        purpose: "register",
      })
    ).json();
    const registered = await f.request(auth + "/register", "POST", {
      username: "mail-member",
      email: "member@example.test",
      password: "correct-member-password",
      challenge: start.challenge,
      code: f.code(),
      language: "en-US",
    });
    expect(registered.status).toBe(200);
    const session = {
      cookie: registered.headers.get("set-cookie")!.split(";")[0]!,
    };
    const count = f.deliveries.length;
    for (const path of ["/preview", "/test"]) {
      expect(
        (await f.request(mailer + path, "POST", { to: "sample@example.test" }))
          .status,
      ).toBe(401);
      expect(
        (
          await f.request(
            mailer + path,
            "POST",
            { to: "sample@example.test" },
            session,
          )
        ).status,
      ).toBe(403);
    }
    expect(f.deliveries).toHaveLength(count);
  } finally {
    await f.close();
  }
});
it("delivers branded MIME alternatives and follows browser, site and recipient account languages", async () => {
  const f = await securityFixture({
    name: "Moe & API",
    defaultLanguage: "en-US",
    accentColor: "#2463eb",
  });
  const clock = vi.spyOn(Date, "now");
  let now = Date.now();
  clock.mockImplementation(() => now);
  try {
    expect(
      (
        await f.request(auth + "/email/request", "POST", {
          email: "browser@example.test",
          purpose: "register",
          language: "zh-CN",
        })
      ).status,
    ).toBe(200);
    const chinese = f.deliveries.at(-1)!;
    expect(chinese.subject).toBe("Moe & API · 验证注册邮箱");
    expect(chinese.text).toContain("创建你的 Moe & API 账号");
    expect(chinese.html).toContain('lang="zh-CN"');
    expect(chinese.html).toContain("Moe &amp; API");
    expect(chinese.raw).toMatch(/Content-Type: multipart\/alternative/i);
    expect(chinese.raw).toMatch(/Content-Type: text\/plain; charset=utf-8/i);
    expect(chinese.raw).toMatch(/Content-Type: text\/html; charset=utf-8/i);
    expect(chinese.html).toContain(f.code());
    expect(chinese.subject).not.toContain(f.code());

    const sent = await (
      await f.request(auth + "/email/request", "POST", {
        email: "recipient@example.test",
        purpose: "register",
      })
    ).json();
    expect(f.deliveries.at(-1)?.subject).toBe("Moe & API · Verify your email");
    const created = await f.request(auth + "/register", "POST", {
      username: "recipient",
      password: "correct-recipient-password",
      email: "recipient@example.test",
      challenge: sent.challenge,
      code: f.code(),
      language: "en-US",
    });
    expect(created.status).toBe(200);
    const user = await created.json();
    expect(user.language).toBe("en-US");
    now += 61000;
    await f.request(auth + "/email/request", "POST", {
      email: "recipient@example.test",
      purpose: "login",
      language: "zh-CN",
    });
    expect(f.deliveries.at(-1)?.subject).toBe("Moe & API · Your sign-in code");
    expect(f.deliveries.at(-1)?.html).toContain('lang="en-US"');

    await f.kernel.invoke("users.manage@1", {
      action: "preferences",
      id: user.id,
      language: "zh-CN",
    });
    now += 61000;
    const login = await (
      await f.request(auth + "/email/request", "POST", {
        email: "recipient@example.test",
        purpose: "login",
        language: "en-US",
      })
    ).json();
    expect(f.deliveries.at(-1)?.subject).toBe("Moe & API · 登录验证码");
    expect(
      (
        await f.request(auth + "/email/login", "POST", {
          email: "recipient@example.test",
          challenge: login.challenge,
          code: f.code(),
        })
      ).status,
    ).toBe(200);
    const before = f.deliveries.length;
    now += 61000;
    await f.kernel.invoke("users.manage@1", {
      action: "update",
      id: user.id,
      enabled: false,
    });
    const disabled = await (
      await f.request(auth + "/email/request", "POST", {
        email: "recipient@example.test",
        purpose: "login",
        language: "en-US",
      })
    ).json();
    const unknown = await (
      await f.request(auth + "/email/request", "POST", {
        email: "unknown@example.test",
        purpose: "login",
        language: "en-US",
      })
    ).json();
    expect(disabled.message).toBe(unknown.message);
    expect(disabled.ok).toBe(true);
    expect(f.deliveries).toHaveLength(before);
  } finally {
    clock.mockRestore();
    await f.close();
  }
});
it("uses the authenticated account language for email binding and administrator test emails", async () => {
  const f = await securityFixture({ name: "Moe", defaultLanguage: "zh-CN" });
  try {
    const session = await f.admin();
    const admin = await f.kernel.invoke<any>("users.lookup@1", {
      username: "admin",
    });
    await f.kernel.invoke("users.manage@1", {
      action: "preferences",
      id: admin.id,
      language: "en-US",
    });
    expect(
      (
        await f.request(
          auth + "/email/request",
          "POST",
          { email: "bound@example.test", purpose: "bind", language: "zh-CN" },
          session,
        )
      ).status,
    ).toBe(200);
    expect(f.deliveries.at(-1)?.subject).toBe(
      "Moe · Confirm your email address",
    );
    expect(
      (
        await f.request(
          "/api/plugins/official.mailer/test",
          "POST",
          { to: "local@example.test", language: "zh-CN" },
          session,
        )
      ).status,
    ).toBe(200);
    expect(f.deliveries.at(-1)?.subject).toBe("Moe · Email delivery test");
    expect(f.deliveries.at(-1)?.html).toContain('lang="en-US"');
    const before = f.deliveries.length;
    expect(
      (
        await f.request("/api/plugins/official.mailer/test", "POST", {
          to: "local@example.test",
          language: "en-US",
        })
      ).status,
    ).toBe(401);
    expect(f.deliveries).toHaveLength(before);
  } finally {
    await f.close();
  }
});
it("keeps plain mail callers compatible and rejects invalid HTML before SMTP delivery", async () => {
  const f = await securityFixture();
  try {
    await f.kernel.invoke("mail.send@1", {
      to: "local@example.test",
      subject: "Plain mail",
      text: "Legacy text",
    });
    expect(f.deliveries.at(-1)).toMatchObject({
      subject: "Plain mail",
      text: "Legacy text\r\n",
      html: "",
    });
    for (const html of [42, "x".repeat(262145)])
      await expect(
        f.kernel.invoke("mail.send@1", {
          to: "local@example.test",
          subject: "Invalid HTML",
          text: "Text",
          html,
        }),
      ).rejects.toMatchObject({ code: "invalid_request" });
    expect(f.deliveries).toHaveLength(1);
  } finally {
    await f.close();
  }
});
