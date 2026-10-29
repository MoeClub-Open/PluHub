import { defaultChannelFlow } from "../deploy/migrations/channel-graphs.ts";
import { migrateModelRedirects } from "../deploy/migrations/model-redirects.ts";
import { it, expect } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./helpers.js";
let respond: (input: any) => Response | Promise<Response>;
async function mock(kernel: any, directory: string) {
  (globalThis as any).__pluhubPricingTransport = (input: any) => respond(input);
  const dir = join(directory, "transport");
  await mkdir(dir);
  await writeFile(
    join(dir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "test.pricing-transport",
      version: "1.0.0",
      host: ">=0.1.0-alpha.1",
      runtime: { kind: "native", entry: "index.mjs" },
      provides: ["http.transport@1"],
      requires: [],
      permissions: [],
      configReload: "snapshot",
    }),
  );
  await writeFile(
    join(dir, "index.mjs"),
    'export default { setup(host) { host.provide("http.transport@1", (i)=>globalThis.__pluhubPricingTransport(i)); } };',
  );
  await kernel.add(dir, { grants: [] });
}
const route = {
  upstream: "primary",
  model: "m",
  inputPrice: 3,
  outputPrice: 15,
  pricing: {
    cacheRead: 0.3,
    cacheWrite: 3.75,
    cacheWrite1h: 6,
    tiers: [{ above: 200000, input: 6, output: 22.5 }],
  },
};
const router = {
  upstreams: {
    primary: {
      protocol: "openai-chat",
      baseUrl: "https://test.example",
      keyRef: "env:PLUHUB_TEST_UPSTREAM_KEY",
      flow: defaultChannelFlow(),
      consumptionMultiplier: 0.5,
    },
  },
  models: {
    demo: route,
    fixed: {
      upstream: "primary",
      model: "fixed",
      pricing: { mode: "request", request: 0.002 },
    },
  },
  redirects: { alias: { target: "demo", mode: "implicit" } },
};
migrateModelRedirects(router as any);

const usage = {
  prompt_tokens: 1000,
  completion_tokens: 100,
  prompt_tokens_details: { cached_tokens: 600 },
  completion_tokens_details: { reasoning_tokens: 40 },
};
async function setup(enabled = true) {
  process.env.PLUHUB_TEST_UPSTREAM_KEY = "pricing-fixture-only";
  respond = () =>
    Response.json({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage,
    });
  const f = await fixture(
    [
      "users",
      "auth",
      "billing",
      "ai-router",
      "observability",
      "model-catalog",
      "rate-limit",
      "ingress-openai-chat",
      "upstream-openai-chat",
      "upstream-openai-responses",
      "upstream-anthropic",
      "upstream-gemini",
      "upstream-openai-media",
    ],
    {
      billing: { enabled },
      "ai-router": router,
    },
    mock,
  );
  const admin = await f.admin();
  const me = await (
    await f.request("/api/plugins/official.auth/me", "GET", undefined, admin)
  ).json();
  await f.kernel.invoke("billing.credit@1", {
    userId: me.id,
    amount: 1_000_000,
    source: "test:pricing",
  });
  const invoke = (model = "demo", stream = false) =>
    f.request(
      "/v1/chat/completions",
      "POST",
      { model, messages: [{ role: "user", content: "hello" }], stream },
      admin,
    );
  const balance = () =>
    f.kernel.invoke<any>("billing.balance@1", { userId: me.id });
  return { ...f, admin, me, invoke, balance };
}
it("resolves quotes and execution through the same conditional route and entry/group multipliers", async () => {
  const f = await setup();
  let calls = 0;
  respond = () => {
    calls++;
    return Response.json({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage,
    });
  };
  try {
    f.kernel.configure({
      "official.ai-router": {
        ...router,
        groups: { default: { name: "Default", multiplier: 2 } },
        upstreams: {
          primary: { ...router.upstreams.primary, consumptionMultiplier: 9 },
          entry: {
            consumptionMultiplier: 0.5,
            flow: {
              entry: "s",
              nodes: [
                { id: "s", type: "start", next: ["branch"] },
                {
                  id: "branch",
                  type: "branch",
                  condition: false,
                  yes: "fixed",
                  no: "token",
                },
                {
                  id: "branch-predicate",
                  type: "compare",
                  valueType: "number",
                  operator: "gt",
                  left: 0,
                  right: 0,
                },
                {
                  id: "fixed",
                  type: "upstream",
                  target: "fixed",
                  mode: "implicit",
                },
                {
                  id: "token",
                  type: "upstream",
                  target: "demo",
                  mode: "implicit",
                },
              ],
              bindings: [
                {
                  source: "s",
                  output: "textLength",
                  target: "branch-predicate",
                  input: "left",
                },
                {
                  source: "branch-predicate",
                  output: "result",
                  target: "branch",
                  input: "condition",
                },
              ],
            },
          },
        },
        models: {
          ...router.models,
          embeddings: {
            upstream: "primary",
            model: "embed-vendor",
            operations: ["embeddings"],
            inputPrice: 1,
            outputPrice: 0,
          },
          entry: {
            upstream: "entry",
            model: "unused",
            inputPrice: 999,
            outputPrice: 999,
          },
        },
      },
    });
    const quote = (request?: unknown) =>
      f.request(
        "/api/plugins/official.billing/quote",
        "POST",
        {
          model: "entry",
          usage: { input: 1000, output: 100, cacheRead: 600 },
          request,
        },
        f.admin,
      );
    const missing = await quote();
    expect(missing.status).toBe(409);
    expect(await missing.json()).toMatchObject({
      error: { code: "quote_request_required" },
    });
    const quoted = await quote({
      messages: [{ role: "user", content: "hello" }],
    });
    expect(quoted.status).toBe(200);
    expect((await quoted.json()).amount).toBe(2000);
    expect(calls).toBe(0);
    const mediaQuote = await f.request(
      "/api/plugins/official.billing/quote",
      "POST",
      { model: "embeddings", usage: { input: 1000, output: 0 } },
      f.admin,
    );
    expect(mediaQuote.status).toBe(200);
    expect((await mediaQuote.json()).amount).toBe(18000);
    expect(calls).toBe(0);
    const candidate = await f.kernel.invoke<any>("ai.targets@1", {
      target: "fixed",
      consumptionMultiplier: 0.5,
      request: { model: "fixed", messages: [], tools: [], stream: false },
    });
    expect(candidate.plan.pricing.multiplier).toBe(1);
    const result = await f.invoke("entry");
    expect(result.status).toBe(200);
    await result.json();
    expect(calls).toBe(1);
    expect(await f.balance()).toMatchObject({ balance: 998000, held: 0 });
  } finally {
    await f.close();
  }
});

it("charges cache-aware usage with the channel multiplier and exposes an immutable own receipt", async () => {
  const f = await setup();
  try {
    const response = await f.invoke("alias");
    expect(response.status).toBe(200);
    expect(
      (await response.json()).usage.prompt_tokens_details.cached_tokens,
    ).toBe(600);
    // (400*3 + 100*15 + 600*.3) * .5 = 1440.
    expect(await f.balance()).toMatchObject({ balance: 998560, held: 0 });
    const ledger = await (
      await f.request(
        "/api/plugins/official.billing/ledger",
        "GET",
        undefined,
        f.admin,
      )
    ).json();
    const receipt = JSON.parse(ledger[0].receipt);
    expect(receipt).toMatchObject({
      amount: 1440,
      pricing: {
        multiplier: 0.5,
      },
      usage: { cacheRead: 600, reasoning: 40 },
    });
    const requests = await (
      await f.request(
        "/api/plugins/official.observability/requests",
        "GET",
        undefined,
        f.admin,
      )
    ).json();
    expect(requests.data[0].cost_micro_usd).toBe(1440);
    expect(JSON.parse(requests.data[0].usage_json)).toMatchObject({
      cacheRead: 600,
      reasoning: 40,
    });
    expect(JSON.parse(requests.data[0].pricing_json)).toMatchObject({
      input: 3,
      output: 15,
    });
    const quote = await f.request(
      "/api/plugins/official.billing/quote",
      "POST",
      { model: "demo", usage: { input: 1000, output: 100, cacheRead: 600 } },
      f.admin,
    );
    expect((await quote.json()).amount).toBe(1440);
  } finally {
    await f.close();
  }
});
it("keeps a successful response and exact wallet settlement when observation storage fails", async () => {
  const f = await setup();
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(
      join(f.config.dataDir, "official.observability/requests.sqlite"),
    );
    db.exec("DROP TABLE requests");
    db.close();
    const response = await f.invoke();
    expect(response.status).toBe(200);
    await response.json();
    expect(await f.balance()).toMatchObject({ balance: 998560, held: 0 });
    const status = await (
      await f.request(
        "/api/plugins/official.observability/status",
        "GET",
        undefined,
        f.admin,
      )
    ).json();
    expect(status).toMatchObject({ available: false, dropped: 1, failures: 1 });
    const logs = await f.request(
      "/api/plugins/official.observability/requests",
      "GET",
      undefined,
      f.admin,
    );
    expect(logs.status).toBe(503);
    await logs.json();
  } finally {
    await f.close();
  }
});
it("reserves the effective channel output budget and includes inserted prompts in the input bound", async () => {
  const f = await setup();
  try {
    respond = () =>
      Response.json({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: {
          ...usage,
          completion_tokens: 8,
          completion_tokens_details: { reasoning_tokens: 0 },
        },
      });
    const adjusted = await f.request(
      "/api/plugins/official.billing/adjust",
      "POST",
      {
        userId: f.me.id,
        amount: -980000,
        id: "effective-budget",
        reason: "Effective reservation test",
      },
      f.admin,
    );
    expect(adjusted.status).toBe(200);
    await adjusted.json();
    const next = structuredClone(router) as any;
    next.upstreams.primary.flow = {
      entry: "start",
      nodes: [
        { id: "start", type: "start", next: ["budget"] },
        { id: "budget", type: "maxTokens", limit: 8, next: "provider" },
        { id: "provider", type: "provider" },
      ],
    };
    f.kernel.configure({ "official.ai-router": next });
    const response = await f.request(
      "/v1/chat/completions",
      "POST",
      {
        model: "demo",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 65536,
      },
      f.admin,
    );
    expect(response.status).toBe(200);
    await response.json();
    expect((await f.balance()).held).toBe(0);
    next.upstreams.primary.flow.nodes[0].next = ["prompt"];
    next.upstreams.primary.flow.nodes.push({
      id: "prompt",
      type: "prompt",
      text: "x".repeat(14000),
      next: "budget",
    });
    f.kernel.configure({ "official.ai-router": next });
    const denied = await f.invoke();
    expect(denied.status).toBe(402);
    await denied.json();
    expect((await f.balance()).held).toBe(0);
  } finally {
    await f.close();
  }
});
it("settles request prices without usage or output limits and settles unknown token usage at the reserved amount", async () => {
  const f = await setup();
  try {
    respond = () =>
      Response.json({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      });
    const fixed = await f.invoke("fixed");
    expect(fixed.status).toBe(200);
    await fixed.json();
    expect(await f.balance()).toMatchObject({ balance: 999000, held: 0 });
    const unknown = await f.invoke();
    expect(unknown.status).toBe(200);
    await unknown.json();
    expect((await f.balance()).balance).toBeLessThan(999000);
    expect((await f.balance()).held).toBe(0);
    const [charge] = await f.kernel.invoke<any[]>("billing.request-charges@1", {
      requests: [
        {
          id: unknown.headers.get("x-pluhub-request-id"),
          userId: (
            await (
              await f.request(
                "/api/plugins/official.auth/me",
                "GET",
                undefined,
                f.admin,
              )
            ).json()
          ).id,
        },
      ],
    });
    expect(charge).toMatchObject({
      status: "settled",
      held: 0,
      receipt: { mode: "reserved" },
    });
  } finally {
    await f.close();
  }
});
it("snapshots prices and billing policy before a streamed request executes", async () => {
  const f = await setup();
  try {
    respond = () => {
      f.kernel.configure({
        "official.billing": {
          enabled: true,
        },
        "official.ai-router": {
          ...router,
          models: { ...router.models, demo: { ...route, inputPrice: 300 } },
        },
      });
      return new Response(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }], usage })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    };
    const r = await f.invoke("demo", true);
    expect(r.status).toBe(200);
    await r.text();
    expect(await f.balance()).toMatchObject({ balance: 998560, held: 0 });
  } finally {
    await f.close();
  }
});
it("rejects invalid pricing tiers without changing balances", async () => {
  const f = await setup();
  try {
    expect(() =>
      f.kernel.configure({
        "official.ai-router": {
          ...router,
          models: {
            demo: {
              ...route,
              pricing: {
                tiers: [
                  { above: 20, input: 1, output: 1 },
                  { above: 10, input: 1, output: 1 },
                ],
              },
            },
          },
        },
      }),
    ).toThrow("strictly increasing");
    expect(await f.balance()).toMatchObject({ balance: 1000000, held: 0 });
  } finally {
    await f.close();
  }
});
it("rejects malformed usage and settles its reservation without trusting the invalid report", async () => {
  const f = await setup();
  try {
    respond = () =>
      Response.json({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { ...usage, prompt_tokens_details: { cached_tokens: 1001 } },
      });
    const response = await f.invoke();
    expect(response.status).toBe(502);
    await response.text();
    expect((await f.balance()).balance).toBeLessThan(1000000);
    expect((await f.balance()).held).toBe(0);
  } finally {
    await f.close();
  }
});

it("settles cache-only Anthropic and thought-inclusive Gemini/Responses calls through protocol conversion", async () => {
  const f = await setup();
  try {
    const cases = [
      {
        protocol: "anthropic",
        amount: 34,
        body: {
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 10,
          },
        },
      },
      {
        protocol: "gemini",
        amount: 444,
        body: {
          candidates: [
            { content: { parts: [{ text: "ok" }] }, finishReason: "STOP" },
          ],
          usageMetadata: {
            promptTokenCount: 100,
            candidatesTokenCount: 0,
            thoughtsTokenCount: 50,
            cachedContentTokenCount: 60,
          },
        },
      },
      {
        protocol: "openai-responses",
        amount: 444,
        body: {
          status: "completed",
          output: [
            { type: "message", content: [{ type: "output_text", text: "ok" }] },
          ],
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            input_tokens_details: { cached_tokens: 60 },
            output_tokens_details: { reasoning_tokens: 20 },
          },
        },
      },
    ];
    for (const test of cases) {
      f.kernel.configure({
        "official.ai-router": {
          ...router,
          upstreams: {
            primary: { ...router.upstreams.primary, protocol: test.protocol },
          },
        },
      });
      const before = await f.balance();
      respond = () => Response.json(test.body);
      const response = await f.invoke();
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.usage.prompt_tokens_details.cached_tokens).toBeGreaterThan(0);
      expect((await f.balance()).balance).toBe(before.balance - test.amount);
    }
  } finally {
    await f.close();
  }
});
