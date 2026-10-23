import { it, expect } from "vitest";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { fixture } from "./helpers.js";

const api = "/api/plugins/official.byok",
  auth = "/api/plugins/official.auth";
async function setup() {
  const sent: any[] = [];
  let disconnected = false;
  const server = createServer(async (request, response) => {
    if (request.url === "/api/ratio_config") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          success: true,
          data: {
            model_ratio: { "provider-model": 1.25, free: 0, fixed: 3 },
            completion_ratio: { "provider-model": 4, free: 2, fixed: 1 },
            model_price: { fixed: 0.2 },
          },
        }),
      );
      return;
    }
    if (request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          data: [{ id: "provider-model" }, { id: "other-model" }],
        }),
      );
      return;
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    sent.push({ body, headers: request.headers, path: request.url });
    if (body.messages?.some((m: any) => m.content === "cancel")) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const timer = setInterval(
        () =>
          response.write(
            'data: {"choices":[{"index":0,"delta":{"content":"x"}}]}\n\n',
          ),
        20,
      );
      response.on("close", () => {
        disconnected = true;
        clearInterval(timer);
      });
      return;
    }
    if (request.url === "/v1/messages") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          id: "m",
          content: [{ type: "text", text: "personal OK" }],
          usage: { input_tokens: 7, output_tokens: 4 },
          stop_reason: "end_turn",
        }),
      );
      return;
    }
    if (request.url?.startsWith("/v1beta/")) {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          candidates: [
            {
              content: { parts: [{ text: "personal OK" }] },
              finishReason: "STOP",
            },
          ],
          usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 4 },
        }),
      );
      return;
    }
    if (request.url === "/v1/responses") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          id: "r",
          status: "completed",
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "personal OK" }],
            },
          ],
          usage: { input_tokens: 7, output_tokens: 4 },
        }),
      );
      return;
    }
    const usage = { prompt_tokens: 7, completion_tokens: 4 };
    if (body.stream) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        "data: " +
          JSON.stringify({
            choices: [
              {
                index: 0,
                delta: { content: "personal OK" },
                finish_reason: "stop",
              },
            ],
            usage,
          }) +
          "\n\ndata: [DONE]\n\n",
      );
    } else {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          choices: [
            { message: { content: "personal OK" }, finish_reason: "stop" },
          ],
          usage,
        }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  process.env.PLUHUB_TEST_UPSTREAM_KEY = "platform-secret";
  const f = await fixture(undefined, {
    byok: { allowedPrivateOrigins: [origin] },
    billing: { enabled: true },
    "ai-router": {
      upstreams: {
        preset: {
          protocol: "openai-chat",
          baseUrl: origin,
          keyRef: "env:PLUHUB_TEST_UPSTREAM_KEY",
        },
        other: {
          protocol: "openai-chat",
          baseUrl: origin,
          keyRef: "env:PLUHUB_TEST_UPSTREAM_KEY",
        },
      },
      models: {
        platform: {
          upstream: "preset",
          model: "platform-target",
          inputPrice: 0,
          outputPrice: 0,
        },
        second: {
          upstream: "other",
          model: "second-target",
          inputPrice: 0,
          outputPrice: 0,
        },
      },
    },
  });
  const admin = await f.admin();
  async function user(username: string) {
    const u = await f.kernel.invoke<any>("users.manage@1", {
      action: "create",
      username,
      role: "user",
    });
    await f.kernel.invoke("auth.bootstrap@1", {
      userId: u.id,
      password: "personal-test-password",
    });
    const response = await f.request(auth + "/login", "POST", {
      username,
      password: "personal-test-password",
    });
    await response.text();
    return {
      id: u.id,
      cookie: { cookie: response.headers.get("set-cookie")!.split(";")[0]! },
    };
  }
  const alice = await user("alice"),
    bob = await user("bob");
  async function channel(owner = alice, override: any = {}) {
    const response = await f.request(
      api + "/personal-channels",
      "POST",
      {
        name: "Mine",
        preset: "newapi",
        protocol: "openai-chat",
        baseUrl: origin,
        key: "alice-upstream-secret",
        models: {
          demo: { model: "provider-model", inputPrice: 2.5, outputPrice: 10 },
        },
        ...override,
      },
      owner.cookie,
    );
    expect(response.status).toBe(201);
    return response.json();
  }
  async function key(owner = alice, binding: any = {}) {
    const response = await f.request(
      auth + "/keys",
      "POST",
      { name: "client", ...binding },
      owner.cookie,
    );
    expect(response.status).toBe(201);
    return response.json();
  }
  const invoke = (
    token: string,
    stream = false,
    extra = {},
    model = "demo",
    content = "hello",
  ) =>
    f.request(
      "/v1/chat/completions",
      "POST",
      { model, messages: [{ role: "user", content }], stream, max_tokens: 30 },
      { authorization: "Bearer " + token, ...extra },
    );
  return {
    ...f,
    admin,
    alice,
    bob,
    origin,
    channel,
    key,
    invoke,
    sent,
    disconnected: () => disconnected,
    close: async () => {
      await f.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

it("applies personal channel protocol gates to bound API keys and validates preview and edits", async () => {
  const f = await setup();
  try {
    const flow = {
      entry: "s",
      nodes: [
        { id: "s", type: "start", next: "gate" },
        {
          id: "gate",
          type: "protocol",
          allow: ["openai-chat", "openai-responses"],
          conversion: "disabled",
          next: "p",
        },
        { id: "p", type: "provider" },
      ],
    };
    const channel = await f.channel(f.alice, { flow });
    const key = await f.key(f.alice, { channelIds: [channel.id] });
    const denied = await f.request(
      "/v1/responses",
      "POST",
      { model: "demo", input: "hi" },
      { authorization: "Bearer " + key.token },
    );
    expect(denied.status).toBe(400);
    expect(await denied.text()).toContain("protocol_conversion_forbidden");
    expect(f.sent).toHaveLength(0);
    const preview = await f.request(
      api + "/personal-channels/preview",
      "POST",
      {
        id: channel.id,
        ingressProtocol: "anthropic",
        request: { model: "demo", messages: [], tools: [], stream: false },
      },
      f.alice.cookie,
    );
    expect(preview.status).toBe(400);
    expect(await preview.text()).toContain("protocol_not_allowed");
    const ok = await f.invoke(key.token);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("personal OK");
    expect(f.sent).toHaveLength(1);
    const invalid = await f.request(
      api + "/personal-channels",
      "POST",
      {
        name: "invalid",
        protocol: "openai-chat",
        baseUrl: f.origin,
        key: "test-only",
        models: { demo: { model: "provider-model" } },
        flow: {
          ...flow,
          nodes: flow.nodes.map((n) =>
            n.type === "protocol" ? { ...n, allow: [] } : n,
          ),
        },
      },
      f.alice.cookie,
    );
    expect(invalid.status).toBe(400);
    await invalid.text();
  } finally {
    await f.close();
  }
});

it("creates isolated preset/custom channels and binds keys for actual JSON/SSE calls without extra headers or platform charges", async () => {
  const f = await setup();
  try {
    const presets = await (
      await f.request(api + "/presets", "GET", undefined, f.alice.cookie)
    ).json();
    expect(presets.map((p: any) => p.id)).toEqual(
      expect.arrayContaining(["custom", "openai", "anthropic", "newapi"]),
    );
    const channel = await f.channel();
    expect(channel.models.demo).toMatchObject({
      inputMultiplier: 1,
      outputMultiplier: 1,
    });
    expect(JSON.stringify(channel)).not.toContain("alice-upstream-secret");
    expect(
      await (
        await f.request(
          api + "/personal-channels",
          "GET",
          undefined,
          f.bob.cookie,
        )
      ).json(),
    ).toEqual([]);
    const db = new DatabaseSync(
      join(f.config.dataDir, "official.byok", "credentials.sqlite"),
    );
    expect(
      JSON.stringify(db.prepare("SELECT * FROM credentials").all()),
    ).not.toContain("alice-upstream-secret");
    db.close();
    const key = await f.key(f.alice, {
      channelIds: [channel.id],
      models: ["demo"],
    });
    for (const stream of [false, true]) {
      const response = await f.invoke(key.token, stream);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain("personal OK");
      expect(text).toContain('"completion_tokens":4');
      expect(f.sent.at(-1)).toMatchObject({
        body: { model: "provider-model" },
        headers: { authorization: "Bearer alice-upstream-secret" },
      });
    }
    const catalog = await (
      await f.request("/v1/models", "GET", undefined, {
        authorization: "Bearer " + key.token,
      })
    ).json();
    expect(catalog.data.map((m: any) => m.id)).toEqual(["demo"]);
    expect((await f.invoke(key.token, false, {}, "platform")).status).toBe(403);
    const wallet = await (
      await f.request(
        "/api/plugins/official.billing/wallet",
        "GET",
        undefined,
        f.alice.cookie,
      )
    ).json();
    expect(wallet).toMatchObject({ balance: 0, held: 0 });
    const logs = await (
      await f.request(
        "/api/plugins/official.observability/requests",
        "GET",
        undefined,
        f.alice.cookie,
      )
    ).json();
    expect(JSON.stringify(logs)).not.toContain("alice-upstream-secret");
    const obs = new DatabaseSync(
      join(f.config.dataDir, "official.observability", "requests.sqlite"),
    );
    const rows = obs
      .prepare(
        "SELECT cost_micro_usd FROM requests WHERE upstream=? AND input_tokens IS NOT NULL",
      )
      .all(channel.id) as any[];
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.cost_micro_usd === 58)).toBe(true);
    obs.close();
    const custom = await f.channel(f.alice, {
      preset: "custom",
      name: "Custom",
      key: "custom-secret",
    });
    const changed = await f.request(
      auth + "/keys",
      "PUT",
      {
        id: key.id,
        name: "Personal key",
        models: ["demo"],
        channelIds: [custom.id],
      },
      f.alice.cookie,
    );
    expect(changed.status).toBe(200);
    await changed.text();
    expect((await f.invoke(key.token)).status).toBe(200);
    expect(f.sent.at(-1).headers.authorization).toBe("Bearer custom-secret");
  } finally {
    await f.close();
  }
});

it("rejects cross-user binding, header overrides, revoked credentials, disabled/deleted channels and stale edits", async () => {
  const f = await setup();
  try {
    const channel = await f.channel(),
      key = await f.key(f.alice, { channelIds: [channel.id] });
    const bobKey = await f.key(f.bob);
    for (const [path, method, body] of [
      [auth + "/keys", "POST", { name: "stolen", channelIds: [channel.id] }],
      [
        auth + "/keys",
        "PUT",
        { id: bobKey.id, name: "stolen", channelIds: [channel.id] },
      ],
      [api + "/personal-channels", "PUT", { ...channel, name: "steal" }],
      [
        api + "/personal-channels?id=" + encodeURIComponent(channel.id),
        "DELETE",
        undefined,
      ],
      [
        api + "/personal-channels/sync",
        "POST",
        { id: channel.id, action: "models" },
      ],
    ] as const) {
      expect(
        (await f.request(path, method, body, f.bob.cookie)).status,
      ).toBeGreaterThanOrEqual(400);
    }
    for (const headers of [{ "x-pluhub-channel": "preset" }])
      expect((await f.invoke(key.token, false, headers)).status).toBe(403);
    expect(
      (await f.invoke(bobKey.token, false, { "x-pluhub-channel": channel.id }))
        .status,
    ).toBe(404);
    expect(f.sent).toHaveLength(0);
    const disabledResponse = await f.request(
      api + "/personal-channels",
      "PUT",
      { ...channel, enabled: false },
      f.alice.cookie,
    );
    expect(disabledResponse.status).toBe(200);
    const disabled = await disabledResponse.json();
    expect((await f.invoke(key.token)).status).toBe(403);
    expect(
      (
        await f.request(
          api + "/personal-channels",
          "PUT",
          channel,
          f.alice.cookie,
        )
      ).status,
    ).toBe(409);
    const enabledResponse = await f.request(
      api + "/personal-channels",
      "PUT",
      { ...disabled, enabled: true },
      f.alice.cookie,
    );
    expect(enabledResponse.status).toBe(200);
    await enabledResponse.text();
    const revoke = await f.request(
      api + "/revoke",
      "POST",
      { id: channel.id },
      f.alice.cookie,
    );
    expect(revoke.status).toBe(200);
    await revoke.text();
    expect((await f.invoke(key.token)).status).toBe(403);
    const removed = await f.request(
      api + "/personal-channels?id=" + encodeURIComponent(channel.id),
      "DELETE",
      undefined,
      f.alice.cookie,
    );
    expect(removed.status).toBe(200);
    await removed.text();
    expect((await f.invoke(key.token)).status).toBe(404);
    expect(f.sent).toHaveLength(0);
  } finally {
    await f.close();
  }
});

it("previews new-api prices/models, preserves unknown/free prices, updates credentials and persists across restart", async () => {
  const f = await setup();
  try {
    const channel = await f.channel(),
      key = await f.key(f.alice, { channelIds: [channel.id] });
    const synced = await (
      await f.request(
        api + "/personal-channels/sync",
        "POST",
        { id: channel.id, action: "prices" },
        f.alice.cookie,
      )
    ).json();
    expect(synced.prices).toEqual({
      "provider-model": { inputPrice: 2.5, outputPrice: 10 },
      free: { inputPrice: 0, outputPrice: 0 },
    });
    const listed = await (
      await f.request(
        api + "/personal-channels/sync",
        "POST",
        { id: channel.id, action: "models" },
        f.alice.cookie,
      )
    ).json();
    expect(listed.models).toEqual(["provider-model", "other-model"]);
    const update = await f.request(
      api + "/personal-channels",
      "PUT",
      {
        ...channel,
        key: "rotated-secret",
        models: {
          demo: { model: "other-model" },
          free: { model: "free", inputPrice: 0, outputPrice: 0 },
        },
      },
      f.alice.cookie,
    );
    expect(update.status).toBe(200);
    const changed = await update.json();
    expect(changed.models.demo).toMatchObject({
      inputMultiplier: null,
      outputMultiplier: null,
    });
    expect(changed.models.free).toMatchObject({
      inputMultiplier: 1,
      outputMultiplier: 1,
    });
    await f.kernel.shutdown();
    await f.kernel.start();
    const restored = await (
      await f.request(
        api + "/personal-channels",
        "GET",
        undefined,
        f.alice.cookie,
      )
    ).json();
    expect(restored[0]).toMatchObject(changed);
    const response = await f.invoke(key.token);
    expect(response.status).toBe(200);
    await response.text();
    expect(f.sent.at(-1)).toMatchObject({
      body: { model: "other-model" },
      headers: { authorization: "Bearer rotated-secret" },
    });
    const list = await (
      await f.request(auth + "/keys", "GET", undefined, f.alice.cookie)
    ).json();
    expect(list[0]).toMatchObject({
      channelIds: [channel.id],
    });
  } finally {
    await f.close();
  }
});

it("runs personal channel graphs, enforces platform bindings and cancels an upstream stream", async () => {
  const f = await setup();
  try {
    const flow = {
      entry: "s",
      nodes: [
        { id: "s", type: "start", next: "p" },
        { id: "p", type: "prompt", text: "Be concise", next: "budget" },
        { id: "budget", type: "maxTokens", limit: 10, next: "provider" },
        { id: "provider", type: "provider" },
      ],
    };
    const channel = await f.channel(f.alice, { flow }),
      key = await f.key(f.alice, { channelIds: [channel.id] });
    const response = await f.invoke(key.token);
    expect(response.status).toBe(200);
    await response.text();
    expect(f.sent.at(-1).body).toMatchObject({
      max_completion_tokens: 10,
      messages: [
        { role: "system", content: "Be concise" },
        { role: "user", content: "hello" },
      ],
    });
    const platformKey = await f.key(f.alice, { channelIds: ["preset"] });
    const forbidden = await f.invoke(platformKey.token, false, {}, "second");
    expect(forbidden.status).toBe(403);
    await forbidden.text();
    const models = await (
      await f.request("/v1/models", "GET", undefined, {
        authorization: "Bearer " + platformKey.token,
      })
    ).json();
    expect(models.data.map((m: any) => m.id)).toEqual(["platform"]);
    const cancelled = await f.invoke(key.token, true, {}, "demo", "cancel");
    expect(cancelled.status).toBe(200);
    const reader = cancelled.body!.getReader();
    await reader.read();
    await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(f.disconnected()).toBe(true);
  } finally {
    await f.close();
  }
});

it("calculates input/output consumption from original prices, keeps catalog originals and records effective costs", async () => {
  const f = await setup();
  try {
    const channel = await f.channel(f.alice, {
      models: {
        demo: {
          model: "provider-model",
          inputPrice: 10,
          outputPrice: 40,
          upstreamInputPrice: 2.5,
          upstreamOutputPrice: 8,
        },
      },
    });
    expect(channel.models.demo).toMatchObject({
      inputPrice: 10,
      outputPrice: 40,
      inputMultiplier: 0.25,
      outputMultiplier: 0.2,
    });
    const key = await f.key(f.alice, { channelIds: [channel.id] });
    const catalog = await (
      await f.request(
        "/api/plugins/official.model-catalog/models?channel=" +
          encodeURIComponent(channel.id),
        "GET",
        undefined,
        f.alice.cookie,
      )
    ).json();
    expect(catalog[0]).toMatchObject({ inputPrice: 10, outputPrice: 40 });
    const task = {
      model: "demo",
      messages: [{ role: "user", text: "hello" }],
      stream: false,
      tools: [],
    };
    expect(
      await f.kernel.invoke("ai.routing@2", {
        channelId: channel.id,
        principalId: f.alice.id,
        model: "demo",
        request: task,
        features: ["text"],
      }),
    ).toMatchObject({ pricing: { input: 2.5, output: 8 } });
    const response = await f.invoke(key.token);
    expect(response.status).toBe(200);
    await response.text();
    const manual = await f.request(
      api + "/personal-channels",
      "PUT",
      { ...channel, consumptionMode: "manual", consumptionMultiplier: 0.3 },
      f.alice.cookie,
    );
    expect(manual.status).toBe(200);
    const updated = await manual.json();
    expect(updated.models.demo).toMatchObject({
      inputPrice: 10,
      outputPrice: 40,
      inputMultiplier: 0.3,
      outputMultiplier: 0.3,
    });
    expect(
      await f.kernel.invoke("ai.routing@2", {
        channelId: channel.id,
        principalId: f.alice.id,
        model: "demo",
        request: task,
        features: ["text"],
      }),
    ).toMatchObject({ pricing: { input: 3, output: 12 } });
    const result = await f.invoke(key.token);
    expect(result.status).toBe(200);
    await result.text();
    const db = new DatabaseSync(
      join(f.config.dataDir, "official.observability", "requests.sqlite"),
    );
    expect(
      (
        db
          .prepare(
            "SELECT cost_micro_usd FROM requests WHERE upstream=? ORDER BY created_at",
          )
          .all(channel.id) as any[]
      ).map((r) => r.cost_micro_usd),
    ).toEqual([50, 69]);
    db.close();
  } finally {
    await f.close();
  }
});

it("uses each personal provider protocol through the common client ingress and blocks arbitrary/private upstream settings", async () => {
  const f = await setup();
  try {
    for (const protocol of [
      "openai-chat",
      "openai-responses",
      "anthropic",
      "gemini",
    ]) {
      const channel = await f.channel(f.alice, { protocol, preset: "custom" }),
        key = await f.key(f.alice, { channelIds: [channel.id] });
      const response = await f.invoke(key.token);
      expect(response.status).toBe(200);
      expect((await response.json()).choices[0].message.content).toBe(
        "personal OK",
      );
      const headers = f.sent.at(-1).headers;
      expect(
        protocol === "anthropic"
          ? headers["x-api-key"]
          : protocol === "gemini"
            ? headers["x-goog-api-key"]
            : headers.authorization,
      ).toBe(
        protocol === "anthropic" || protocol === "gemini"
          ? "alice-upstream-secret"
          : "Bearer alice-upstream-secret",
      );
    }
    const base = {
      name: "blocked",
      protocol: "openai-chat",
      key: "secret",
      models: { demo: { model: "m" } },
    };
    for (const baseUrl of [
      "http://127.0.0.1:1",
      "http://2130706433:1",
      "http://169.254.169.254",
      "http://[::ffff:127.0.0.1]",
      "https://localhost",
      "https://example.com/?key=secret",
      "https://user:pass@example.com",
    ]) {
      const response = await f.request(
        api + "/personal-channels",
        "POST",
        { ...base, baseUrl },
        f.alice.cookie,
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
      await response.text();
    }
    const direct = await f.kernel.invoke<Response>("http.transport@1", {
      url: f.origin,
      publicOnly: true,
    });
    await direct.text();
    throw new Error("Transport should reject private IP");
  } catch (error: any) {
    expect(error.code).toBe("private_upstream");
  } finally {
    await f.close();
  }
});
