import { it, expect, vi } from "vitest";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { fixture } from "./helpers.js";
async function gateway() {
  let calls = 0;
  const server = createServer(async (request, response) => {
    calls++;
    expect(request.headers.authorization).toBe("Bearer upstream-only-secret");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const text = body.messages.at(-1)?.content;
    if (text === "fail") {
      response.writeHead(503);
      response.end("upstream unavailable");
      return;
    }
    if (!body.stream) {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          choices: [
            { message: { content: "你好，PluHub" }, finish_reason: "stop" },
          ],
          ...(text === "no-usage"
            ? {}
            : { usage: { prompt_tokens: 12, completion_tokens: 8 } }),
        }),
      );
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      'data: {"choices":[{"index":0,"delta":{"content":"你好"}}]}\n\n',
    );
    if (text === "slow") {
      const timer = setInterval(() => response.write(": keepalive\n\n"), 50);
      response.on("close", () => clearInterval(timer));
      return;
    }
    if (text === "truncated") {
      response.end();
      return;
    }
    response.end(
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":8}}\n\ndata: [DONE]\n\n',
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const f = await fixture([
    "http-transport",
    "users",
    "auth",
    "ai-router",
    "observability",
    "model-catalog",
    "playground",
    "rate-limit",
    "ingress-openai-chat",
    "upstream-openai-chat",
  ]);
  process.env.PLUHUB_TEST_UPSTREAM_KEY = "upstream-only-secret";
  const router = {
    upstreams: {
      primary: {
        protocol: "openai-chat",
        baseUrl: "http://127.0.0.1:" + (server.address() as any).port,
        keyRef: "env:PLUHUB_TEST_UPSTREAM_KEY",
      },
    },
    models: {
      demo: {
        upstream: "primary",
        model: "vendor-model",
        name: "My model",
        provider: "Custom",
        contextWindow: 128000,
        inputPrice: 2,
        outputPrice: 4,
      },
      other: { upstream: "primary", model: "vendor-other" },
      hidden: { upstream: "primary", model: "hidden", enabled: false },
    },
  };
  f.kernel.configure({ "official.ai-router": router });
  const admin = await f.admin();
  async function user(username: string) {
    const value = await f.kernel.invoke<any>("users.manage@1", {
      action: "create",
      username,
      role: "user",
    });
    await f.kernel.invoke("auth.bootstrap@1", {
      userId: value.id,
      password: "user-test-password-123",
    });
    const login = await f.request("/api/plugins/official.auth/login", "POST", {
      username,
      password: "user-test-password-123",
    });
    const cookie = { cookie: login.headers.get("set-cookie")!.split(";")[0]! };
    await login.json();
    return { ...cookie, userId: value.id };
  }
  async function key(
    cookie: Record<string, string>,
    policy: Record<string, unknown> = {},
  ) {
    const response = await f.request(
      "/api/plugins/official.auth/keys",
      "POST",
      { name: "app", ...policy },
      cookie,
    );
    expect(response.status).toBe(201);
    return response.json();
  }
  const invoke = (
    headers: Record<string, string>,
    text = "hello",
    model = "demo",
    stream = false,
  ) =>
    f.request(
      "/v1/chat/completions",
      "POST",
      { model, messages: [{ role: "user", content: text }], stream },
      headers,
    );
  return {
    ...f,
    admin,
    user,
    key,
    invoke,
    router,
    calls: () => calls,
    async close() {
      delete process.env.PLUHUB_TEST_UPSTREAM_KEY;
      await f.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
it("serves a sanitized catalog, applies channel switches, and sends explicit channel probes", async () => {
  const f = await gateway();
  try {
    const models = await (
      await f.request(
        "/api/plugins/official.model-catalog/models",
        "GET",
        undefined,
        f.admin,
      )
    ).json();
    expect(models.map((m: any) => m.id)).toEqual(["demo", "other"]);
    expect(models[0]).toMatchObject({
      provider: "Custom",
      inputPrice: 2,
      contextWindow: 128000,
    });
    expect(JSON.stringify(models)).not.toMatch(
      /upstream-only-secret|keyRef|baseUrl|vendor-model/,
    );
    const probe = await f.request(
      "/api/plugins/official.ai-router/test",
      "POST",
      { upstream: "primary", model: "vendor-model" },
      f.admin,
    );
    expect(probe.status).toBe(200);
    expect(await probe.json()).toMatchObject({
      ok: true,
      usage: { input: 12, output: 8 },
    });
    const before = f.calls();
    const cookie = await f.user("alice");
    expect(
      (
        await f.request(
          "/api/plugins/official.ai-router/test",
          "POST",
          { upstream: "primary", model: "vendor-model" },
          cookie,
        )
      ).status,
    ).toBe(403);
    expect(f.calls()).toBe(before);
    f.kernel.configure({
      "official.ai-router": {
        ...f.router,
        upstreams: {
          primary: { ...f.router.upstreams.primary, enabled: false },
        },
      },
    });
    expect(
      await (
        await f.request(
          "/api/plugins/official.model-catalog/models",
          "GET",
          undefined,
          cookie,
        )
      ).json(),
    ).toEqual([]);
    expect((await f.invoke(cookie)).status).toBe(503);
  } finally {
    await f.close();
  }
});
it("enforces API key model scopes, expiry and request limits without allowing credential escalation", async () => {
  const f = await gateway();
  try {
    const cookie = await f.user("alice");
    const key = await f.key(cookie, { models: ["demo"], requestsPerMinute: 1 });
    const bearer = { authorization: "Bearer " + key.token };
    const list = await (
      await f.request("/v1/models", "GET", undefined, bearer)
    ).json();
    expect(list.data.map((m: any) => m.id)).toEqual(["demo"]);
    expect((await f.invoke(bearer, "hello", "other")).status).toBe(403);
    expect(f.calls()).toBe(0);
    const success = await f.invoke(bearer);
    expect(success.status).toBe(200);
    await success.json();
    expect((await f.invoke(bearer)).status).toBe(429);
    expect(f.calls()).toBe(1);
    expect(
      (
        await f.request(
          "/api/plugins/official.auth/keys",
          "POST",
          { name: "escape" },
          bearer,
        )
      ).status,
    ).toBe(403);
    const adminKey = await f.key(f.admin);
    expect(
      (
        await f.request("/api/host/config", "GET", undefined, {
          authorization: "Bearer " + adminKey.token,
        })
      ).status,
    ).toBe(403);
    const future = Date.now() + 60000;
    const expiring = await f.key(cookie, { expiresAt: future });
    const clock = vi.spyOn(Date, "now").mockReturnValue(future + 1);
    try {
      expect(
        (
          await f.request("/v1/models", "GET", undefined, {
            authorization: "Bearer " + expiring.token,
          })
        ).status,
      ).toBe(401);
    } finally {
      clock.mockRestore();
    }
    const invalid = await f.request(
      "/api/plugins/official.auth/keys",
      "POST",
      { name: "bad", models: "*" },
      cookie,
    );
    expect(invalid.status).toBe(400);
    await f.kernel.shutdown();
    const legacy = new DatabaseSync(
      join(f.config.dataDir, "official.auth/auth.sqlite"),
    );
    for (const field of [
      "models_json",
      "expires_at",
      "requests_per_minute",
      "last_used_at",
      "secret",
      "channel_ids_json",
    ])
      legacy.exec("ALTER TABLE api_keys DROP COLUMN " + field);
    // Reconstruct the complete historical schema, including pre-MFA sessions.
    legacy.exec("DROP INDEX sessions_id; DROP INDEX sessions_user_expiry;");
    for (const field of [
      "id",
      "created_at",
      "last_active_at",
      "device",
      "ip",
      "method",
    ])
      legacy.exec("ALTER TABLE sessions DROP COLUMN " + field);
    legacy.exec(
      "ALTER TABLE sessions DROP COLUMN auth_at; ALTER TABLE sessions DROP COLUMN credential_id;",
    );
    for (const table of [
      "auth_challenges",
      "email_credentials",
      "totp_credentials",
      "recovery_codes",
      "passkeys",
      "auth_limits",
      "setup_admin",
      "security_events",
    ])
      legacy.exec("DROP TABLE " + table);
    legacy.exec("PRAGMA user_version=1");
    legacy.close();
    await f.kernel.start();
    const migrated = await f.request("/v1/models", "GET", undefined, {
      authorization: "Bearer " + adminKey.token,
    });
    expect(migrated.status).toBe(200);
    expect((await migrated.json()).data.map((m: any) => m.id)).toEqual([
      "demo",
      "other",
    ]);
  } finally {
    await f.close();
  }
});
it("records final stream outcomes, preserves unknown usage, isolates users and retains logs after restart", async () => {
  const f = await gateway();
  try {
    const alice = await f.user("alice");
    const bob = await f.user("bob");
    const success = await f.invoke(alice);
    const id = success.headers.get("x-pluhub-request-id");
    await success.json();
    const noUsage = await f.invoke(alice, "no-usage");
    await noUsage.json();
    const failure = await f.invoke(alice, "fail");
    expect(failure.status).toBe(502);
    await failure.json();
    expect(failure.headers.get("x-pluhub-request-id")).toBeTruthy();
    const truncated = await f.invoke(alice, "truncated", "demo", true);
    expect(await truncated.text()).toContain("error");
    const streaming = await f.invoke(alice, "hello", "demo", true);
    expect(await streaming.text()).toContain("[DONE]");
    const abort = new AbortController();
    const slow = await f.kernel.fetch(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        signal: abort.signal,
        headers: { cookie: alice.cookie, "content-type": "application/json" },
        body: JSON.stringify({
          model: "demo",
          stream: true,
          messages: [{ role: "user", content: "slow" }],
        }),
      }),
    );
    const reader = slow.body!.getReader();
    await reader.read();
    abort.abort();
    await reader.cancel();
    await vi.waitFor(async () => {
      const summary = await (
        await f.request(
          "/api/plugins/official.observability/summary",
          "GET",
          undefined,
          alice,
        )
      ).json();
      expect(summary).toMatchObject({
        requests: 6,
        successes: 3,
        errors: 2,
        cancelled: 1,
        usageKnownRequests: 2,
        pricedRequests: 2,
      });
    });
    const log = await (
      await f.request(
        "/api/plugins/official.observability/requests",
        "GET",
        undefined,
        alice,
      )
    ).json();
    expect(log.data.find((r: any) => r.id === id)).toMatchObject({
      status: "success",
      input_tokens: 12,
      output_tokens: 8,
      cost_micro_usd: 56,
      upstream: "primary",
    });
    expect(
      log.data.some(
        (r: any) =>
          r.status === "success" &&
          r.input_tokens === null &&
          r.cost_micro_usd === null,
      ),
    ).toBe(true);
    expect(
      log.data.some((r: any) => r.error_code === "upstream_truncated"),
    ).toBe(true);
    expect(JSON.stringify(log)).not.toMatch(
      /upstream-only-secret|messages|prompt_tokens|你好/,
    );
    const other = await (
      await f.request(
        "/api/plugins/official.observability/requests?scope=all",
        "GET",
        undefined,
        bob,
      )
    ).json();
    expect(other.total).toBe(0);
    const filtered = await (
      await f.request(
        "/api/plugins/official.observability/requests?status=error&limit=1",
        "GET",
        undefined,
        f.admin,
      )
    ).json();
    expect(filtered.total).toBe(2);
    expect(filtered.data).toHaveLength(1);
    const byId = await (
      await f.request(
        "/api/plugins/official.observability/requests?requestId=" +
          encodeURIComponent(id),
        "GET",
        undefined,
        f.admin,
      )
    ).json();
    expect(byId.total).toBe(1);
    const privateId = await (
      await f.request(
        "/api/plugins/official.observability/requests?requestId=" +
          encodeURIComponent(id),
        "GET",
        undefined,
        bob,
      )
    ).json();
    expect(privateId.total).toBe(0);
    const upstreamErrors = await (
      await f.request(
        "/api/plugins/official.observability/requests?upstream=primary&errorCode=upstream_truncated",
        "GET",
        undefined,
        f.admin,
      )
    ).json();
    expect(upstreamErrors.total).toBeGreaterThan(0);
    const runtimeErrors = await (
      await f.request(
        "/api/host/logs?level=error&q=upstream_truncated",
        "GET",
        undefined,
        f.admin,
      )
    ).json();
    expect(runtimeErrors.total).toBeGreaterThan(0);
    expect(
      (
        await f.request(
          "/api/plugins/official.observability/requests?limit=-1",
          "GET",
          undefined,
          f.admin,
        )
      ).status,
    ).toBe(400);
    await f.kernel.shutdown();
    await f.kernel.start();
    const persisted = await (
      await f.request(
        "/api/plugins/official.observability/requests",
        "GET",
        undefined,
        alice,
      )
    ).json();
    expect(persisted.total).toBe(6);
  } finally {
    await f.close();
  }
});
