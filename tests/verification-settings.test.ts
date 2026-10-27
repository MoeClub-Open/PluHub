import { it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fixture } from "./helpers.js";
import {
  applyVerification,
  readVerification,
} from "../../PluHub-Plugins/plugins/console/verification.js";

it("validates and persists verification services and policies in one transaction and rejects invalid combined settings", async () => {
  const f = await fixture();
  try {
    const admin = await f.admin();
    const config = await (
      await f.request("/api/host/config", "GET", undefined, admin)
    ).json();
    const baseline = readVerification(config),
      drafts = structuredClone(baseline);
    Object.assign(drafts.mailer!, {
      enabled: true,
      host: "localhost",
      port: 2525,
      from: "noreply@example.com",
      allowInsecure: true,
    });
    Object.assign(drafts.turnstile!, {
      enabled: true,
      provider: "hcaptcha",
      siteKey: "test-only-site-key",
      secretRef: "secret:TEST_VERIFICATION_SECRET",
      hostnames: ["localhost"],
    });
    Object.assign(drafts.auth!, {
      emailLoginEnabled: true,
      registrationEnabled: true,
      captcha: { login: true, email: true, register: true },
    });
    expect(applyVerification(config, baseline, drafts)).toBe(3);
    const result = await f.request("/api/host/config", "PUT", config, admin);
    expect(result.status, await result.clone().text()).toBe(200);
    await result.text();
    const saved = await readFile(f.file, "utf8");
    expect(
      JSON.parse(saved).plugins.find((p: any) => /[\\/]turnstile$/.test(p.path))
        .config.secretRefs,
    ).toEqual(["secret:TEST_VERIFICATION_SECRET"]);
    const options = (await (
      await f.request("/api/plugins/official.auth/options")
    ).json()) as any;
    expect(options.captchaProvider).toEqual({
      enabled: true,
      provider: "hcaptcha",
      siteKey: "test-only-site-key",
    });
    expect(options.turnstile).toBeUndefined();
    expect(JSON.stringify(options)).not.toContain("TEST_VERIFICATION_SECRET");
    const invalid = structuredClone(config);
    invalid.plugins.find((p: any) => /[\\/]mailer$/.test(p.path)).config.host =
      "remote.example";
    invalid.plugins.find((p: any) =>
      /[\\/]auth$/.test(p.path),
    ).config.registrationEnabled = false;
    const rejected = await f.request("/api/host/config", "PUT", invalid, admin);
    expect(rejected.status).toBe(400);
    await rejected.text();
    expect(await readFile(f.file, "utf8")).toBe(saved);
  } finally {
    await f.close();
  }
});

it("protects system metrics from anonymous and ordinary users and returns no config, paths or credentials", async () => {
  const f = await fixture(["users", "auth"]);
  try {
    const anonymous = await f.request("/api/host/status");
    expect(anonymous.status).toBe(401);
    await anonymous.text();
    const admin = await f.admin();
    const response = await f.request(
      "/api/host/status",
      "GET",
      undefined,
      admin,
    );
    expect(response.status).toBe(200);
    const status = await response.json();
    expect(status).toMatchObject({
      plugins: { total: 2, active: 2, failed: 0 },
    });
    expect(status.runtime.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(status.memory.rss).toBeGreaterThan(0);
    expect(status.audit).toEqual({
      available: true,
      failures: 0,
      writeFailures: 0,
      unresolved: 0,
      retentionDays: 90,
    });
    expect(Object.keys(status.storage).sort()).toEqual([
      "available",
      "availableBytes",
      "lowSpace",
      "totalBytes",
    ]);
    expect(status.storage.available).toBe(true);
    expect(status.storage.totalBytes).toBeGreaterThan(0);
    expect(status.storage.availableBytes).toBeGreaterThanOrEqual(0);
    expect(status.storage.availableBytes).toBeLessThanOrEqual(
      status.storage.totalBytes,
    );
    expect(status.status).toBe(
      status.storage.lowSpace ? "degraded" : "running",
    );
    expect(Object.keys(status).sort()).toEqual([
      "audit",
      "graphVersion",
      "memory",
      "plugins",
      "runtime",
      "status",
      "storage",
      "time",
    ]);
    expect(JSON.stringify(status)).not.toContain(f.directory);
    const reader = await f.kernel.invoke<any>("users.manage@1", {
      action: "create",
      username: "status-reader",
      role: "user",
    });
    const password = await f.request(
      "/api/plugins/official.auth/password",
      "POST",
      { userId: reader.id, password: "reader-test-password" },
      admin,
    );
    expect(password.status).toBe(200);
    await password.text();
    const login = await f.request("/api/plugins/official.auth/login", "POST", {
      username: "status-reader",
      password: "reader-test-password",
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    await login.text();
    const denied = await f.request("/api/host/status", "GET", undefined, {
      cookie,
    });
    expect(denied.status).toBe(403);
    await denied.text();
  } finally {
    await f.close();
  }
});
