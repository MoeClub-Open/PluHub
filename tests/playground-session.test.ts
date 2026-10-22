import { it, expect } from "vitest";
import { createServer } from "node:http";
import { fixture } from "./helpers.js";

async function setup(rpm = 1) {
  const upstreamRequests: any[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    upstreamRequests.push({ body, headers: request.headers });
    const result = {
      choices: [
        {
          index: 0,
          delta: { content: "session reply" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 8 },
    };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end("data: " + JSON.stringify(result) + "\n\ndata: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + (server.address() as any).port;
  process.env.PLUHUB_TEST_UPSTREAM_KEY = "provider-only-secret";
  const f = await fixture(
    [
      "http-transport",
      "users",
      "auth",
      "ai-router",
      "model-catalog",
      "playground",
      "observability",
      "billing",
      "rate-limit",
      "byok",
      "ingress-openai-chat",
      "upstream-openai-chat",
    ],
    {
      "ai-router": {
        upstreams: {
          primary: {
            protocol: "openai-chat",
            baseUrl: origin,
            keyRef: "env:PLUHUB_TEST_UPSTREAM_KEY",
          },
        },
        models: {
          demo: {
            upstream: "primary",
            model: "provider-model",
            inputPrice: 2,
            outputPrice: 4,
          },
        },
      },
      billing: { enabled: true },
      "rate-limit": { user: { rpm } },
      byok: { allowedPrivateOrigins: [origin] },
    },
  );
  await f.admin();
  async function user(username: string) {
    const account: any = await f.kernel.invoke("users.manage@1", {
      action: "create",
      username,
      role: "user",
    });
    await f.kernel.invoke("auth.bootstrap@1", {
      userId: account.id,
      password: "local-playground-session-password",
    });
    const login = await f.request("/api/plugins/official.auth/login", "POST", {
      username,
      password: "local-playground-session-password",
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    await login.json();
    return { id: account.id, cookie: { cookie, origin: "http://localhost" } };
  }
  const alice = await user("alice"),
    bob = await user("bob");
  const invoke = (headers: Record<string, string>) =>
    f.request(
      "/v1/chat/completions",
      "POST",
      {
        model: "demo",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 32,
        stream: true,
      },
      headers,
    );
  return {
    ...f,
    alice,
    bob,
    origin,
    upstreamRequests,
    invoke,
    async close() {
      await f.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      delete process.env.PLUHUB_TEST_UPSTREAM_KEY;
    },
  };
}
it("streams with the signed-in account without creating API keys, charges its wallet and retains account limits and logs", async () => {
  const f = await setup();
  try {
    await f.kernel.invoke("billing.credit@1", {
      userId: f.alice.id,
      amount: 1000000,
      source: "playground-test-credit",
    });
    const catalog = await f.request(
      "/api/plugins/official.playground/models",
      "GET",
      undefined,
      f.alice.cookie,
    );
    expect((await catalog.json()).map((m: any) => m.id)).toEqual(["demo"]);
    const result = await f.invoke(f.alice.cookie);
    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toContain("text/event-stream");
    const text = await result.text();
    expect(text).toContain("session reply");
    expect(text).toContain("[DONE]");
    expect(f.upstreamRequests).toHaveLength(1);
    expect(f.upstreamRequests[0].headers.authorization).toBe(
      "Bearer provider-only-secret",
    );
    expect(f.upstreamRequests[0].headers.cookie).toBeUndefined();
    const wallet = await f.request(
      "/api/plugins/official.billing/wallet",
      "GET",
      undefined,
      f.alice.cookie,
    );
    expect(await wallet.json()).toMatchObject({
      balance: 999944,
      held: 0,
      available: 999944,
    });
    expect(
      await (
        await f.request(
          "/api/plugins/official.billing/wallet",
          "GET",
          undefined,
          f.bob.cookie,
        )
      ).json(),
    ).toMatchObject({ balance: 0 });
    expect(
      await (
        await f.request(
          "/api/plugins/official.auth/keys",
          "GET",
          undefined,
          f.alice.cookie,
        )
      ).json(),
    ).toEqual([]);
    const logs = await (
      await f.request(
        "/api/plugins/official.observability/requests?scope=me",
        "GET",
        undefined,
        f.alice.cookie,
      )
    ).json();
    expect(logs.data).toHaveLength(1);
    expect(logs.data[0]).toMatchObject({
      user_id: f.alice.id,
      key_id: null,
      status: "success",
    });
    const limited = await f.invoke(f.alice.cookie);
    expect(limited.status).toBe(429);
    await limited.text();
    expect(f.upstreamRequests).toHaveLength(1);
  } finally {
    await f.close();
  }
});
it("rejects anonymous, cross-origin and disabled sessions and preserves personal-channel ownership without API keys", async () => {
  const f = await setup(10);
  try {
    expect((await f.invoke({})).status).toBe(401);
    expect(
      (await f.invoke({ ...f.alice.cookie, origin: "https://evil.test" }))
        .status,
    ).toBe(403);
    const created = await f.request(
      "/api/plugins/official.byok/personal-channels",
      "POST",
      {
        name: "Alice personal",
        preset: "newapi",
        protocol: "openai-chat",
        baseUrl: f.origin,
        key: "personal-provider-secret",
        models: {
          demo: { model: "personal-model", inputPrice: 2, outputPrice: 4 },
        },
      },
      f.alice.cookie,
    );
    expect(created.status).toBe(201);
    const channel = await created.json();
    const other = await f.invoke({
      ...f.bob.cookie,
      "x-pluhub-channel": channel.id,
    });
    expect([403, 404]).toContain(other.status);
    await other.text();
    expect(f.upstreamRequests).toHaveLength(0);
    const own = await f.invoke({
      ...f.alice.cookie,
      "x-pluhub-channel": channel.id,
    });
    expect(own.status).toBe(200);
    expect(await own.text()).toContain("session reply");
    expect(f.upstreamRequests[0].headers.authorization).toBe(
      "Bearer personal-provider-secret",
    );
    expect(
      await (
        await f.request(
          "/api/plugins/official.billing/wallet",
          "GET",
          undefined,
          f.alice.cookie,
        )
      ).json(),
    ).toMatchObject({ balance: 0, held: 0 });
    await f.kernel.invoke("users.manage@1", {
      action: "update",
      id: f.alice.id,
      enabled: false,
    });
    expect((await f.invoke(f.alice.cookie)).status).toBe(401);
    expect(f.upstreamRequests).toHaveLength(1);
  } finally {
    await f.close();
  }
});
