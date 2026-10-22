import { it, expect } from "vitest";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./helpers.js";
import { createKernel } from "../packages/control/dist/index.js";
const sub = "/api/plugins/official.upstream-codex",
  own = sub + "/personal",
  byok = "/api/plugins/official.byok",
  auth = "/api/plugins/official.auth";
let transport: (
  input: any,
  signal: AbortSignal,
) => Response | Promise<Response> = () => {
  throw new Error("Unexpected provider request");
};
const providers = ["codex", "claude-subscription", "antigravity"];
async function setup() {
  let extraPath = "";
  (globalThis as any).__byoTransport = (input: any, signal: AbortSignal) =>
    transport(input, signal);
  const f = await fixture(
    [
      "users",
      "auth",
      "billing",
      "observability",
      "ai-router",
      "byok",
      "protocol-converter",
      ...["openai-chat", "openai-responses", "anthropic", "gemini"].flatMap(
        (p) => ["ingress-" + p, "upstream-" + p],
      ),
      ...providers.map((p) => "upstream-" + p),
    ],
    {
      billing: { enabled: true },
      byok: {
        oauth: {
          platform: {
            clientId: "client",
            tokenUrl: "https://oauth.example/token",
          },
        },
      },
      "ai-router": {
        upstreams: {
          platform: {
            protocol: "openai-chat",
            baseUrl: "https://api.example",
            keyRef: "env:PLUHUB_TEST_UPSTREAM_KEY",
          },
        },
        models: {
          paid: {
            upstream: "platform",
            model: "paid",
            inputPrice: 2,
            outputPrice: 4,
          },
        },
      },
    },
    async (kernel, dir) => {
      const path = join(dir, "transport");
      extraPath = path;
      await mkdir(path);
      await writeFile(
        join(path, "manifest.json"),
        JSON.stringify({
          schemaVersion: 1,
          id: "test.byo-transport",
          version: "1.0.0",
          host: ">=0.1.0-alpha.1",
          runtime: { kind: "native", entry: "index.mjs" },
          provides: ["http.transport@1"],
          requires: [],
          permissions: [],
        }),
      );
      await writeFile(
        join(path, "index.mjs"),
        'export default {setup(host){host.provide("http.transport@1",(i,s)=>globalThis.__byoTransport(i,s));}}',
      );
      await kernel.add(path);
    },
  );
  f.config.plugins.push({ path: extraPath, grants: [] });
  const admin = await f.admin();
  async function user(username: string) {
    const value = await f.kernel.invoke<any>("users.manage@1", {
      action: "create",
      username,
      role: "user",
    });
    await f.kernel.invoke("auth.bootstrap@1", {
      userId: value.id,
      password: "byo-test-password",
    });
    const r = await f.request(auth + "/login", "POST", {
      username,
      password: "byo-test-password",
    });
    await r.json();
    return {
      id: value.id,
      headers: { cookie: r.headers.get("set-cookie")!.split(";")[0]! },
    };
  }
  const alice = await user("alice"),
    bob = await user("bob");
  const accountProviders = new Map<string, string>();
  async function account(
    provider = "codex",
    owner = alice,
    override: any = {},
  ) {
    const r = await f.request(
      "/api/plugins/official.upstream-" + provider + "/personal/accounts",
      "POST",
      {
        provider,
        name: "My " + provider,
        authorization: {
          access_token: "personal-token",
          refresh_token: "personal-refresh",
          expires_in: 3600,
          account_id: "chat-account",
          project_id: "project-1",
        },
        ...override,
      },
      owner.headers,
    );
    expect(r.status, await r.clone().text()).toBe(200);
    const account = await r.json();
    accountProviders.set(account.id, provider);
    return account;
  }
  async function channel(a: any, owner = alice, override: any = {}) {
    const r = await f.request(
      byok + "/personal-channels",
      "POST",
      {
        name: "Mine",
        protocol: a.provider,
        preset: a.provider,
        subscriptionAccountId: a.id,
        models: { demo: { model: "vendor", inputPrice: 2, outputPrice: 4 } },
        ...override,
      },
      owner.headers,
    );
    expect(r.status, await r.clone().text()).toBe(201);
    return r.json();
  }
  async function key(channelId?: string, owner = alice) {
    const r = await f.request(
      auth + "/keys",
      "POST",
      { name: "client", channelId, models: ["demo"] },
      owner.headers,
    );
    expect(r.status).toBe(201);
    return r.json();
  }
  const action = (id: string, action: string, owner = alice, extra = {}) =>
    f.request(
      "/api/plugins/official.upstream-" +
        (accountProviders.get(id) ?? "codex") +
        "/personal/account",
      "POST",
      { id, action, ...extra },
      owner.headers,
    );
  const invoke = (token: string, stream = false) =>
    f.request(
      "/v1/chat/completions",
      "POST",
      { model: "demo", messages: [{ role: "user", content: "hi" }], stream },
      { authorization: "Bearer " + token },
    );
  const balance = () =>
    f.kernel.invoke<any>("billing.balance@1", { userId: alice.id });
  return {
    ...f,
    admin,
    alice,
    bob,
    account,
    channel,
    key,
    action,
    invoke,
    balance,
  };
}
const frame = (data: any) => "data: " + JSON.stringify(data) + "\n\n";
function response(provider: string, stream: boolean) {
  const usage = { input_tokens: 7, output_tokens: 4 };
  const data =
    provider === "codex"
      ? {
          status: "completed",
          output: [
            {
              type: "message",
              id: "m1",
              content: [{ type: "output_text", text: "BYO_OK" }],
            },
          ],
          usage,
        }
      : provider === "claude-subscription"
        ? {
            content: [{ type: "text", text: "BYO_OK" }],
            stop_reason: "end_turn",
            usage,
          }
        : {
            candidates: [
              {
                index: 0,
                content: { parts: [{ text: "BYO_OK" }] },
                finishReason: "STOP",
              },
            ],
            usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 4 },
          };
  if (!stream)
    return Response.json(
      provider === "antigravity" ? { response: data } : data,
    );
  const wire =
    provider === "codex"
      ? frame({ type: "response.completed", response: data })
      : provider === "claude-subscription"
        ? frame({ type: "message_start", message: { usage } }) +
          frame({
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "BYO_OK" },
          }) +
          frame({ type: "content_block_stop", index: 0 }) +
          frame({
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage,
          }) +
          frame({ type: "message_stop" })
        : frame({ response: data });
  return new Response(wire, {
    headers: { "content-type": "text/event-stream" },
  });
}
it("isolates personal subscription management, platform accounts and bearer keys", async () => {
  const f = await setup();
  try {
    const a = await f.account();
    const b = await f.account("codex", f.bob);
    const platform = await (
      await f.request(
        sub + "/accounts",
        "POST",
        {
          provider: "codex",
          name: "Platform",
          authorization: { access_token: "platform-secret" },
        },
        f.admin,
      )
    ).json();
    const list = await (
      await f.request(own + "/accounts", "GET", undefined, f.alice.headers)
    ).json();
    expect(list.map((r: any) => r.id)).toEqual([a.id]);
    expect(JSON.stringify(list)).not.toMatch(
      /personal-token|personal-refresh|cipher/,
    );
    expect(
      (
        await (
          await f.request(sub + "/accounts", "GET", undefined, f.admin)
        ).json()
      ).map((r: any) => r.id),
    ).toEqual([platform.id]);
    expect((await f.action(b.id, "delete")).status).toBe(404);
    expect((await f.action(platform.id, "refresh")).status).toBe(404);
    expect(
      (
        await f.request(
          sub + "/account",
          "POST",
          { id: a.id, action: "delete" },
          f.admin,
        )
      ).status,
    ).toBe(404);
    const k = await f.key();
    expect(
      (
        await f.request(own + "/accounts", "GET", undefined, {
          authorization: "Bearer " + k.token,
        })
      ).status,
    ).toBe(403);
    for (const [id, ownerId] of [
      [a.id, undefined],
      [a.id, f.bob.id],
      [platform.id, f.alice.id],
    ])
      await expect(
        f.kernel.invoke("ai.subscription.codex@1", {
          action: "acquire",
          provider: "codex",
          ids: [id],
          ownerId,
        }),
      ).rejects.toMatchObject({ code: "subscription_not_found" });
    const db = await readFile(
      join(f.config.dataDir, "official.upstream-codex/accounts.sqlite"),
    );
    expect(db.includes(Buffer.from("personal-token"))).toBe(false);
  } finally {
    await f.close();
  }
});
it.each(providers)(
  "uses a personal %s subscription across all entry formats without platform charges",
  async (provider) => {
    const f = await setup();
    let calls = 0;
    try {
      const a = await f.account(provider),
        c = await f.channel(a),
        k = await f.key(c.id);
      transport = (i) => {
        calls++;
        const body = JSON.parse(i.body);
        expect(i.headers.authorization).toBe("Bearer personal-token");
        expect(i.publicOnly).toBe(true);
        if (provider === "codex") {
          expect(i.headers["chatgpt-account-id"]).toBe("chat-account");
          expect(body.max_output_tokens).toBeUndefined();
        }
        if (provider === "antigravity") expect(body.project).toBe("project-1");
        return response(
          provider,
          body.stream || i.url.includes("streamGenerateContent"),
        );
      };
      for (const entry of [
        "openai-chat",
        "openai-responses",
        "anthropic",
        "gemini",
      ])
        for (const stream of [false, true]) {
          const path =
            entry === "openai-chat"
              ? "/v1/chat/completions"
              : entry === "openai-responses"
                ? "/v1/responses"
                : entry === "anthropic"
                  ? "/v1/messages"
                  : "/v1beta/models/demo:" +
                    (stream
                      ? "streamGenerateContent?alt=sse"
                      : "generateContent");
          const body =
            entry === "openai-chat"
              ? {
                  model: "demo",
                  messages: [{ role: "user", content: "hi" }],
                  stream,
                }
              : entry === "openai-responses"
                ? { model: "demo", input: "hi", stream }
                : entry === "anthropic"
                  ? {
                      model: "demo",
                      messages: [{ role: "user", content: "hi" }],
                      stream,
                    }
                  : { contents: [{ role: "user", parts: [{ text: "hi" }] }] };
          const r = await f.request(path, "POST", body, {
            authorization: "Bearer " + k.token,
          });
          expect(r.status, await r.clone().text()).toBe(200);
          const text = await r.text();
          expect(text).toContain("BYO_OK");
          expect(text).not.toContain("Upstream stream failed");
        }
      expect(calls).toBe(8);
      expect(await f.balance()).toMatchObject({ balance: 0, held: 0 });
      expect(
        (
          await (
            await f.request("/v1/models", "GET", undefined, {
              authorization: "Bearer " + k.token,
            })
          ).json()
        ).data.map((m: any) => m.id),
      ).toEqual(["demo"]);
      const accounts = await (
        await f.request(
          "/api/plugins/official.upstream-" + provider + "/personal/accounts",
          "GET",
          undefined,
          f.alice.headers,
        )
      ).json();
      expect(accounts[0].active).toBe(0);
    } finally {
      await f.close();
    }
  },
);
it("rejects borrowed, mismatched, disabled and deleted subscriptions without platform fallback", async () => {
  const f = await setup();
  let calls = 0;
  try {
    const a = await f.account(),
      c = await f.channel(a),
      k = await f.key(c.id);
    transport = () => {
      calls++;
      return response("codex", true);
    };
    for (const [provider, owner] of [
      ["claude-subscription", f.alice],
      ["codex", f.bob],
    ] as const) {
      const r = await f.request(
        byok + "/personal-channels",
        "POST",
        {
          name: "Borrowed",
          protocol: provider,
          subscriptionAccountId: a.id,
          models: { demo: { model: "vendor" } },
        },
        owner.headers,
      );
      expect(r.status).toBe(404);
      await r.json();
    }
    expect(
      (await f.action(a.id, "update", f.alice, { enabled: false })).status,
    ).toBe(200);
    const denied = await f.invoke(k.token);
    expect(denied.status).toBe(403);
    await denied.json();
    expect(calls).toBe(0);
    await (await f.action(a.id, "update", f.alice, { enabled: true })).json();
    const good = await f.invoke(k.token);
    expect(await good.text()).toContain("BYO_OK");
    expect(calls).toBe(1);
    await (await f.action(a.id, "delete")).json();
    const removed = await f.invoke(k.token);
    expect(removed.status).toBe(404);
    await removed.json();
    expect(calls).toBe(1);
    const rotate = await f.request(
      byok + "/personal-channels",
      "PUT",
      {
        ...c,
        protocol: "openai-chat",
        subscriptionAccountId: undefined,
        authMode: undefined,
        baseUrl: "https://api.example",
        key: undefined,
      },
      f.alice.headers,
    );
    expect(rotate.status).toBe(400);
    await rotate.json();
  } finally {
    await f.close();
  }
});
it("binds personal PKCE callbacks to their owner and scope", async () => {
  const f = await setup();
  let calls = 0;
  try {
    const r = await f.request(
      own + "/oauth/start",
      "POST",
      { name: "Mine", provider: "codex" },
      f.alice.headers,
    );
    expect(r.status).toBe(200);
    const flow = await r.json(),
      url = new URL(flow.url),
      callback = new URL(url.searchParams.get("redirect_uri")!);
    callback.searchParams.set("code", "code");
    callback.searchParams.set("state", url.searchParams.get("state")!);
    for (const [path, headers] of [
      [own, f.bob.headers],
      [sub, f.admin],
    ] as const) {
      const denied = await f.request(
        path + "/oauth/finish",
        "POST",
        { id: flow.id, callback: callback.href },
        headers,
      );
      expect(denied.status).toBe(409);
      await denied.json();
    }
    transport = (i) => {
      calls++;
      expect(i.url).toContain("oauth/token");
      expect(new URLSearchParams(i.body).get("code_verifier")).toBeTruthy();
      return Response.json({
        access_token: "personal-token",
        refresh_token: "personal-refresh",
        expires_in: 3600,
      });
    };
    const done = await f.request(
      own + "/oauth/finish",
      "POST",
      { id: flow.id, callback: callback.href },
      f.alice.headers,
    );
    expect(done.status).toBe(200);
    const a = await done.json();
    expect(a.provider).toBe("codex");
    expect(calls).toBe(1);
    expect(
      (
        await f.request(
          own + "/oauth/finish",
          "POST",
          { id: flow.id, callback: callback.href },
          f.alice.headers,
        )
      ).status,
    ).toBe(409);
  } finally {
    await f.close();
  }
});
it("refreshes the same personal account once after 401 and applies cooldown metadata", async () => {
  const f = await setup();
  let modelCalls = 0,
    refreshes = 0;
  try {
    const a = await f.account(),
      c = await f.channel(a),
      k = await f.key(c.id);
    transport = (i) => {
      if (i.url.includes("oauth/token")) {
        refreshes++;
        return Response.json({
          access_token: "fresh-personal",
          refresh_token: "rotated",
          expires_in: 3600,
        });
      }
      modelCalls++;
      if (modelCalls === 1) return new Response("denied", { status: 401 });
      expect(i.headers.authorization).toBe("Bearer fresh-personal");
      return response("codex", true);
    };
    expect(await (await f.invoke(k.token)).text()).toContain("BYO_OK");
    expect([refreshes, modelCalls]).toEqual([1, 2]);
    transport = () =>
      new Response("slow", { status: 429, headers: { "retry-after": "30" } });
    const denied = await f.invoke(k.token);
    expect(denied.status).toBe(429);
    await denied.json();
    const accounts = await (
      await f.request(own + "/accounts", "GET", undefined, f.alice.headers)
    ).json();
    expect(accounts[0]).toMatchObject({
      active: 0,
      status: "cooldown",
      lastStatus: 429,
    });
    expect(accounts[0].cooldownUntil).toBeGreaterThan(Date.now());
    expect(await f.balance()).toMatchObject({ balance: 0, held: 0 });
  } finally {
    await f.close();
  }
});
it("releases a personal subscription lease when the converted stream is cancelled", async () => {
  const f = await setup();
  let cancelled = false;
  try {
    const a = await f.account(),
      c = await f.channel(a),
      k = await f.key(c.id);
    transport = () =>
      new Response(
        new ReadableStream({
          start(ctrl) {
            ctrl.enqueue(
              new TextEncoder().encode(
                frame({
                  type: "response.output_text.delta",
                  item_id: "m",
                  delta: "partial",
                }),
              ),
            );
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    const response = await f.invoke(k.token, true);
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    await expect.poll(() => cancelled).toBe(true);
    const list = await (
      await f.request(own + "/accounts", "GET", undefined, f.alice.headers)
    ).json();
    expect(list[0].active).toBe(0);
  } finally {
    await f.close();
  }
});
it("discovers unsaved API models without storing or returning credentials", async () => {
  const f = await setup();
  let calls = 0;
  try {
    transport = (i) => {
      calls++;
      expect(i.method).toBe("GET");
      expect(i.url).toBe("https://api.example/v1/models");
      expect(i.headers.authorization).toBe("Bearer api-private-key");
      expect(i.publicOnly).toBe(true);
      return Response.json({
        data: [{ id: "m1" }, { id: "m1" }, { id: "m2" }],
      });
    };
    const body = {
      protocol: "openai-chat",
      baseUrl: "https://api.example/v1",
      key: "api-private-key",
    };
    const r = await f.request(
      byok + "/personal-channels/discover",
      "POST",
      body,
      f.alice.headers,
    );
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ models: ["m1", "m2"] });
    expect(
      await (
        await f.request(
          byok + "/personal-channels",
          "GET",
          undefined,
          f.alice.headers,
        )
      ).json(),
    ).toEqual([]);
    const denied = await f.request(
      byok + "/personal-channels/discover",
      "POST",
      { ...body, baseUrl: "http://127.0.0.1" },
      f.alice.headers,
    );
    expect(denied.status).toBe(403);
    await denied.json();
    expect(calls).toBe(1);
  } finally {
    await f.close();
  }
});
it("keeps shared legacy refresh alive after one caller cancels and never recreates revoked credentials", async () => {
  const f = await setup();
  let release: () => void = () => {};
  let started: () => void = () => {};
  const beginning = new Promise<void>((r) => {
    started = r;
  });
  let calls = 0;
  try {
    const r = await f.request(
      byok + "/credentials",
      "POST",
      {
        name: "Legacy",
        channel: "platform",
        kind: "oauth",
        oauth: {
          access_token: "expired",
          refresh_token: "refresh",
          expires_at: Date.now() - 1000,
        },
      },
      f.alice.headers,
    );
    expect(r.status).toBe(201);
    const cred = await r.json();
    transport = async () => {
      calls++;
      started();
      await new Promise<void>((r) => {
        release = r;
      });
      return Response.json({ access_token: "fresh", expires_in: 3600 });
    };
    const ctrl = new AbortController();
    const first = f.kernel
      .invoke(
        "credentials.resolve@1",
        { id: cred.id, userId: f.alice.id },
        ctrl.signal,
      )
      .catch((e) => e);
    const second = f.kernel.invoke<any>("credentials.resolve@1", {
      id: cred.id,
      userId: f.alice.id,
    });
    await beginning;
    ctrl.abort();
    await first;
    release();
    expect((await second).secret).toBe("fresh");
    expect(calls).toBe(1);
    const r2 = await f.request(
      byok + "/credentials",
      "POST",
      {
        name: "Revoked",
        channel: "platform",
        kind: "oauth",
        oauth: {
          access_token: "expired",
          refresh_token: "refresh",
          expires_at: Date.now() - 1000,
        },
      },
      f.alice.headers,
    );
    const cred2 = await r2.json();
    let onStart: () => void = () => {};
    const ready = new Promise<void>((r) => {
      onStart = r;
    });
    transport = async () => {
      onStart();
      await new Promise<void>((r) => {
        release = r;
      });
      return Response.json({
        access_token: "should-not-exist",
        expires_in: 3600,
      });
    };
    const pending = f.kernel
      .invoke("credentials.resolve@1", { id: cred2.id, userId: f.alice.id })
      .catch((e) => e);
    await ready;
    await (
      await f.request(
        byok + "/revoke",
        "POST",
        { id: cred2.id },
        f.alice.headers,
      )
    ).json();
    release();
    expect((await pending).code).toBe("credential_not_found");
    expect(
      (
        await (
          await f.request(
            byok + "/credentials",
            "GET",
            undefined,
            f.alice.headers,
          )
        ).json()
      ).some((c: any) => c.id === cred2.id),
    ).toBe(false);
  } finally {
    release();
    await f.close();
  }
});
it("preserves personal account ownership, channel and key binding after restart", async () => {
  const f = await setup();
  let fresh: any;
  try {
    const a = await f.account(),
      c = await f.channel(a),
      k = await f.key(c.id);
    await f.kernel.shutdown();
    fresh = await createKernel(f.config);
    await fresh.start();
    transport = () => response("codex", true);
    const r = await fresh.fetch(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer " + k.token,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "demo",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("BYO_OK");
    await expect(
      fresh.invoke("ai.subscription.codex@1", {
        action: "inspect",
        id: a.id,
        ownerId: f.bob.id,
      }),
    ).rejects.toMatchObject({ code: "subscription_not_found" });
  } finally {
    await fresh?.shutdown();
    await f.close();
  }
});
