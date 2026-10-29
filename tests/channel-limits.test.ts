import { it, expect } from "vitest";
import { createServer } from "node:http";
import { fixture } from "./helpers.js";
import { planRoute } from "../../PluHub-Plugins/plugins/ai-router/planning.js";
import { defaultChannelFlow } from "../../PluHub-Plugins/lib/ai/channel-config.js";

async function setup(rule: any = { rpm: 1 }) {
  let calls = 0;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls++;
    if (body.messages.some((m: any) => m.content === "error")) {
      res.writeHead(502).end("upstream failed");
      return;
    }
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        'data: {"choices":[{"index":0,"delta":{"content":"hello"}}]}\n\n',
      );
      // Keep the stream open until the consumer cancels.
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      }),
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const flow: any = {
    entry: "s",
    nodes: [
      { id: "s", type: "start", next: ["branch"] },
      {
        id: "branch",
        type: "branch",
        condition: false,
        yes: "limit",
        no: "provider",
      },
      {
        id: "branch-predicate",
        type: "compare",
        valueType: "boolean",
        operator: "eq",
        left: false,
        right: true,
      },
      { id: "limit", type: "rateLimit", rule, next: "provider" },
      { id: "provider", type: "provider" },
    ],
    bindings: [
      {
        source: "s",
        output: "stream",
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
  };
  const router: any = {
    upstreams: {
      c: {
        protocol: "openai-chat",
        baseUrl: "http://127.0.0.1:" + (server.address() as any).port,
        keyRef: "env:PLUHUB_TEST_UPSTREAM_KEY",
        flow,
      },
    },
    models: { public: { upstream: "c", model: "vendor" } },
  };
  const old = process.env.PLUHUB_TEST_UPSTREAM_KEY;
  process.env.PLUHUB_TEST_UPSTREAM_KEY = "local-limits-test";
  const f = await fixture(undefined, { "ai-router": router });
  const admin = await f.admin();
  const invoke = (stream = false, text = "hello") =>
    f.request(
      "/v1/chat/completions",
      "POST",
      {
        model: "public",
        messages: [{ role: "user", content: text }],
        max_tokens: 8,
        stream,
      },
      admin,
    );
  return {
    ...f,
    adminHeaders: admin,
    router,
    invoke,
    calls: () => calls,
    async cleanup() {
      await f.close();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      if (old === undefined) delete process.env.PLUHUB_TEST_UPSTREAM_KEY;
      else process.env.PLUHUB_TEST_UPSTREAM_KEY = old;
    },
  };
}

it("applies only traversed quota nodes and releases streaming concurrency on cancellation", async () => {
  const f = await setup({ concurrency: 1 });
  try {
    const first = await f.invoke(true);
    expect(first.status).toBe(200);
    const blocked = await f.invoke(true);
    expect(blocked.status).toBe(429);
    await blocked.text();
    const bypass = await f.invoke();
    expect(bypass.status).toBe(200);
    await bypass.text();
    await first.body!.cancel();
    const next = await f.invoke(true);
    expect(next.status).toBe(200);
    await next.body!.cancel();
    expect(f.calls()).toBe(3);
  } finally {
    await f.cleanup();
  }
});

it("retains RPM limits after cancellation and keeps global user quotas on unselected branches", async () => {
  const f = await setup({ rpm: 1 });
  try {
    const first = await f.invoke(true);
    await first.body!.cancel();
    const second = await f.invoke(true);
    expect(second.status).toBe(429);
    await second.text();
    const plain = await f.invoke();
    expect(plain.status).toBe(200);
    await plain.text();
    f.kernel.configure({ "official.rate-limit": { user: { rpm: 1 } } });
    const one = await f.invoke();
    expect(one.status).toBe(200);
    await one.text();
    const two = await f.invoke();
    expect(two.status).toBe(429);
    await two.text();
  } finally {
    await f.cleanup();
  }
});

it("checks all reservations atomically, counts revisited nodes once and releases a lease once", async () => {
  const f = await setup();
  try {
    const reserve = (rules: any[]) =>
      f.kernel.invoke<(actual: number) => void>("ai.request-limits@1", {
        rules,
        tokens: 4,
      });
    const release = await reserve([["a", { rpm: 1 }]]);
    await expect(
      reserve([
        ["b", { rpm: 1 }],
        ["a", { rpm: 1 }],
      ]),
    ).rejects.toThrow(/limit/);
    const releaseB = await reserve([["b", { rpm: 1 }]]);
    release(3);
    release(3);
    releaseB(0);
    const duplicate = await reserve([
      ["c", { rpm: 2 }],
      ["c", { rpm: 2 }],
    ]);
    duplicate(0);
    const second = await reserve([["c", { rpm: 2 }]]);
    second(0);
    await expect(reserve([["c", { rpm: 2 }]])).rejects.toThrow(/limit/);
  } finally {
    await f.cleanup();
  }
});

it("supports personal channel limit nodes while preventing bypass of platform pacing defaults", async () => {
  const f = await setup({ concurrency: 1 });
  try {
    const origin = f.router.upstreams.c.baseUrl;
    f.kernel.configure({
      "official.byok": { allowedPrivateOrigins: [origin] },
    });
    const flow = {
      entry: "s",
      nodes: [
        { id: "s", type: "start", next: ["limit"] },
        { id: "limit", type: "rateLimit", rule: { rpm: 1 }, next: "p" },
        { id: "p", type: "provider" },
      ],
    };
    const body = {
      name: "own",
      protocol: "openai-chat",
      baseUrl: origin,
      key: "local-own-key",
      models: { demo: { model: "vendor" } },
      flow,
    };
    const created = await f.request(
      "/api/plugins/official.byok/personal-channels",
      "POST",
      body,
      f.adminHeaders,
    );
    expect(created.status, await created.clone().text()).toBe(201);
    const channel = await created.json();
    for (const status of [200, 429]) {
      const response = await f.request(
        "/v1/chat/completions",
        "POST",
        {
          model: "demo",
          messages: [{ role: "user", content: "hello" }],
          max_tokens: 8,
        },
        { ...f.adminHeaders, "x-pluhub-channel": channel.id },
      );
      expect(response.status, await response.clone().text()).toBe(status);
      await response.text();
    }
    const bypass = {
      ...body,
      flow: {
        entry: "s",
        nodes: [
          { id: "s", type: "start", next: ["pace"] },
          {
            id: "pace",
            type: "tps",
            rate: 10000,
            tokenizer: "o200k_base",
            inheritDefault: false,
            next: "p",
          },
          { id: "p", type: "provider" },
        ],
      },
    };
    const denied = await f.request(
      "/api/plugins/official.byok/personal-channels",
      "POST",
      bypass,
      f.adminHeaders,
    );
    expect(denied.status).toBe(400);
    expect(await denied.text()).toContain("不能关闭默认输出限速");
  } finally {
    await f.cleanup();
  }
});

it("reserves the graph's effective output budget, refunds actual usage and releases upstream errors", async () => {
  const f = await setup({ concurrency: 1, tpm: 4000 });
  try {
    f.router.upstreams.c.flow.nodes = f.router.upstreams.c.flow.nodes.filter(
      (node) => !["branch", "branch-predicate"].includes(node.id),
    );
    f.router.upstreams.c.flow.bindings = [];
    f.router.upstreams.c.flow.nodes[0].next = ["budget"];
    f.router.upstreams.c.flow.nodes.push({
      id: "budget",
      type: "maxTokens",
      limit: 8,
      next: "limit",
    });
    f.kernel.configure({ "official.ai-router": f.router });
    const large = await f.request(
      "/v1/chat/completions",
      "POST",
      {
        model: "public",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 65536,
      },
      f.adminHeaders,
    );
    expect(large.status).toBe(200);
    await large.text();
    for (let i = 0; i < 5; i++) {
      const response = await f.invoke();
      expect(response.status).toBe(200);
      await response.text();
    }
    const error = await f.invoke(false, "error");
    expect(error.status).toBe(502);
    await error.text();
    const retry = await f.invoke();
    expect(retry.status).toBe(200);
    await retry.text();
    const status = await (
      await f.request(
        "/api/plugins/official.rate-limit/status",
        "GET",
        undefined,
        f.adminHeaders,
      )
    ).json();
    expect(status.active).toBe(0);
  } finally {
    await f.cleanup();
  }
});

it("rejects missing limit capabilities and malformed rules before applying configuration", async () => {
  const f = await setup();
  try {
    for (const rule of [
      {},
      { rpm: -1 },
      { concurrency: 1.1 },
      { tpm: Infinity },
      { injected: 1 },
    ]) {
      const router = structuredClone(f.router);
      router.upstreams.c.flow.nodes[2].rule = rule;
      expect(() =>
        f.kernel.configure({ "official.ai-router": router }),
      ).toThrow();
    }
    await expect(f.kernel.stop("official.rate-limit")).rejects.toThrow(
      /Required by enabled plugins/,
    );
    const response = await f.invoke(true);
    expect(response.status).toBe(200);
    await response.body!.cancel();
    expect(f.calls()).toBe(1);
  } finally {
    await f.cleanup();
  }
});

it("carries redirect limits and resolves model-specific migrated pacing against the final provider model", async () => {
  const config: any = {
    upstreams: {
      first: {
        flow: {
          entry: "s",
          nodes: [
            { id: "s", type: "start", next: ["limit"] },
            {
              id: "limit",
              type: "rateLimit",
              rule: { rpm: 2 },
              next: "redirect",
            },
            {
              id: "redirect",
              type: "upstream",
              target: "final",
              mode: "implicit",
            },
          ],
        },
      },
      last: {
        protocol: "openai-chat",
        flow: {
          entry: "s",
          nodes: [
            { id: "s", type: "start", next: ["pace"] },
            {
              id: "pace",
              type: "tps",
              model: "physical",
              rate: 50,
              aggregateRate: 90,
              tokenizer: "custom",
              inheritDefault: false,
              next: "p",
            },
            { id: "p", type: "provider", model: "physical" },
          ],
        },
      },
    },
    models: {
      alias: { upstream: "first", model: "ignored" },
      final: { upstream: "last", model: "mapped" },
    },
  };
  const host = { config: () => config, hasCapability: () => true } as any;
  const request: any = {
    model: "alias",
    messages: [],
    tools: [],
    stream: true,
  };
  const plan = await planRoute(
    host,
    { model: "alias", request, features: ["text"] },
    new AbortController().signal,
  );
  expect(plan.requestLimits).toEqual([
    { channel: "first", node: "limit", rule: { rpm: 2 } },
  ]);
  expect(plan.outputPolicy).toMatchObject({
    tps: 50,
    aggregateTps: 90,
    tokenizer: "custom",
    inheritDefault: false,
  });
  config.upstreams.last.flow = defaultChannelFlow();
  const next = await planRoute(
    host,
    { model: "alias", request, features: ["text"] },
    new AbortController().signal,
  );
  expect(next.outputPolicy).toBeUndefined();
  const missing = {
    ...host,
    hasCapability: (name: string) => name !== "ai.request-limits@1",
  };
  await expect(
    planRoute(
      missing,
      { model: "alias", request, features: ["text"] },
      new AbortController().signal,
    ),
  ).rejects.toThrow(/请求限流插件/);
});
