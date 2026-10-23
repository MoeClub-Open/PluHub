import { it, expect, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fixture } from "./helpers.js";

async function gateway() {
  process.env.PLUHUB_TEST_UPSTREAM_KEY = "platform-test-only";
  let decisions = 0,
    answers = 0;
  const sent: any[] = [];
  const f = await fixture(
    [
      "users",
      "auth",
      "ai-router",
      "auto-router",
      "token-speed",
      "billing",
      "observability",
      "ingress-openai-chat",
      "upstream-openai-chat",
    ],
    {},
    async (kernel, directory) => {
      (globalThis as any).__pluhubRoutingTransport = (i: any) => {
        if (i.url.endsWith("/decisions")) {
          decisions++;
          return Response.json({
            answers: [
              {
                name: "difficulty",
                choice: "hard",
                confidence: 0.9,
                probabilities: [
                  { value: "easy", probability: 0 },
                  { value: "standard", probability: 0 },
                  { value: "hard", probability: 1 },
                  { value: "expert", probability: 0 },
                ],
              },
            ],
          });
        }
        answers++;
        sent.push(JSON.parse(i.body));
        return Response.json({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        });
      };
      const dir = join(directory, "transport");
      await mkdir(dir);
      await writeFile(
        join(dir, "manifest.json"),
        JSON.stringify({
          schemaVersion: 1,
          id: "test.routing-transport",
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
        'export default {setup(h){h.provide("http.transport@1",i=>globalThis.__pluhubRoutingTransport(i));}}',
      );
      await kernel.add(dir, { grants: [] });
    },
  );
  const profile: any = {
    mode: "both",
    decision: {
      kind: "luna",
      baseUrl: "https://classifier.example/v1",
      model: "decision-test",
    },
    fallbackCandidate: "strong",
    candidates: [
      {
        id: "fast",
        target: "fast",
        strength: 30,
        reasoningEfforts: ["low", "high"],
      },
      {
        id: "strong",
        target: "strong",
        strength: 95,
        reasoningEfforts: ["low", "high"],
      },
    ],
  };
  const routing: any = {
    upstreams: {
      primary: {
        protocol: "openai-chat",
        baseUrl: "https://upstream.example/v1",
        keyRef: "env:PLUHUB_TEST_UPSTREAM_KEY",
      },
      smart: { protocol: "auto-router" },
    },
    models: {
      fast: {
        upstream: "primary",
        model: "fast-vendor",
        inputPrice: 1,
        outputPrice: 1,
      },
      strong: {
        upstream: "primary",
        model: "strong-vendor",
        inputPrice: 3,
        outputPrice: 5,
      },
      auto: {
        upstream: "smart",
        model: "smart",
        inputPrice: 999,
        outputPrice: 999,
      },
    },
  };
  f.kernel.configure({
    "official.ai-router": routing,
    "official.auto-router": { profiles: { smart: profile } },
  });
  const admin = await f.admin();
  const keyResponse = await f.request(
    "/api/plugins/official.auth/keys",
    "POST",
    { name: "router-key", models: ["auto"], requestsPerMinute: 1 },
    admin,
  );
  expect(keyResponse.status).toBe(201);
  const key = await keyResponse.json();
  return {
    ...f,
    admin,
    profile,
    routing,
    headers: { authorization: "Bearer " + key.token },
    sent,
    decisions: () => decisions,
    answers: () => answers,
  };
}
it("filters automatic routing candidates by trusted protocol admission", async () => {
  const f = await gateway();
  try {
    f.routing.upstreams.primary.flow = {
      entry: "s",
      nodes: [
        { id: "s", type: "start", next: "gate" },
        {
          id: "gate",
          type: "protocol",
          allow: ["anthropic"],
          conversion: "auto",
          next: "p",
        },
        { id: "p", type: "provider" },
      ],
    };
    f.kernel.configure({ "official.ai-router": f.routing });
    const request = {
      model: "auto",
      messages: [{ role: "user", text: "hi" }],
      tools: [],
      stream: false,
    };
    await expect(
      f.kernel.invoke("ai.routing@2", {
        model: "auto",
        request,
        features: [],
        ingressProtocol: "openai-chat",
      }),
    ).rejects.toMatchObject({ code: "no_route" });
    expect(f.answers()).toBe(0);
    expect(f.decisions()).toBe(0);
    const plan = await f.kernel.invoke<any>("ai.routing@2", {
      model: "auto",
      request,
      features: [],
      ingressProtocol: "anthropic",
    });
    expect(plan.upstreamId).toBe("primary");
    expect(f.answers()).toBe(0);
  } finally {
    await f.close();
    delete (globalThis as any).__pluhubRoutingTransport;
  }
});

it("routes a virtual provider before billing, records final model and checks key scope before classification", async () => {
  const f = await gateway();
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  try {
    const me = await (
      await f.request(
        "/api/plugins/official.auth/me",
        "GET",
        undefined,
        f.admin,
      )
    ).json();
    f.kernel.configure({ "official.billing": { enabled: true } });
    await f.kernel.invoke("billing.credit@1", {
      userId: me.id,
      amount: 1000000,
      source: "routing-test",
    });
    const invoke = (model = "auto") =>
      f.request(
        "/v1/chat/completions",
        "POST",
        {
          model,
          messages: [{ role: "user", content: "debug this" }],
          max_tokens: 16,
        },
        f.headers,
      );
    expect((await invoke("strong")).status).toBe(403);
    expect(f.decisions()).toBe(0);
    const success = await invoke();
    expect(success.status).toBe(200);
    expect((await success.json()).choices[0].message.content).toBe("ok");
    expect(f.sent[0]).toMatchObject({
      model: "strong-vendor",
      reasoning_effort: "high",
    });
    expect(
      (await f.kernel.invoke<any>("billing.balance@1", { userId: me.id }))
        .balance,
    ).toBe(999981);
    const records = await (
      await f.request(
        "/api/plugins/official.observability/requests",
        "GET",
        undefined,
        f.admin,
      )
    ).json();
    const row = records.data.find((r: any) => r.status === "success");
    expect(row.upstream).toBe("primary");
    expect(row.cost_micro_usd).toBe(19);
    expect(JSON.parse(row.routing)).toMatchObject({
      targetModel: "strong-vendor",
      logicalUpstream: "smart",
      decision: { candidate: "strong" },
    });
    expect((await invoke()).status).toBe(429);
    expect(f.decisions()).toBe(1);
    expect(f.answers()).toBe(1);
    now += 60000;
    const nextWindow = await invoke();
    expect(nextWindow.status).toBe(200);
    await nextWindow.json();
    expect(f.answers()).toBe(2);
  } finally {
    clock.mockRestore();
    await f.close();
    delete (globalThis as any).__pluhubRoutingTransport;
  }
});
it("applies mode and strength snapshots, rejects recursion and preserves the previous configuration", async () => {
  const f = await gateway();
  try {
    f.profile.decision = { kind: "rules" };
    f.kernel.configure({
      "official.auto-router": { profiles: { smart: f.profile } },
    });
    const resolve = () =>
      f.kernel.invoke<any>("ai.routing@2", {
        model: "auto",
        features: ["text"],
        request: {
          model: "auto",
          messages: [{ role: "user", text: "hello" }],
          tools: [],
          stream: false,
        },
      });
    expect((await resolve()).model).toBe("fast-vendor");
    f.profile.candidates[0].strength = 100;
    f.kernel.configure({
      "official.auto-router": { profiles: { smart: f.profile } },
    });
    expect((await resolve()).model).toBe("strong-vendor");
    expect(() =>
      f.kernel.configure({
        "official.auto-router": {
          profiles: { smart: { ...f.profile, candidates: [] } },
        },
      }),
    ).toThrow();
    expect((await resolve()).model).toBe("strong-vendor");
    f.profile.candidates = [
      { id: "loop", target: "auto", strength: 99, reasoningEfforts: ["high"] },
    ];
    f.profile.fallbackCandidate = "loop";
    f.kernel.configure({
      "official.auto-router": { profiles: { smart: f.profile } },
    });
    await expect(resolve()).rejects.toMatchObject({ code: "routing_cycle" });
  } finally {
    await f.close();
    delete (globalThis as any).__pluhubRoutingTransport;
  }
});
it("paces nonstream output per selected physical model and supports management without the auto-router UI", async () => {
  const f = await gateway();
  try {
    f.kernel.configure({
      "official.token-speed": {
        models: [
          {
            channel: "primary",
            model: "strong-vendor",
            tps: 20,
            tokenizer: "o200k_base",
          },
        ],
      },
    });
    const start = performance.now();
    const response = await f.request(
      "/v1/chat/completions",
      "POST",
      { model: "auto", messages: [{ role: "user", content: "hi" }] },
      f.headers,
    );
    expect(response.status).toBe(200);
    await response.json();
    expect(performance.now() - start).toBeGreaterThanOrEqual(95);
    const targets = await f.request(
      "/api/plugins/official.ai-router/targets",
      "GET",
      undefined,
      f.admin,
    );
    expect((await targets.json()).map((t: any) => t.id)).toEqual([
      "fast",
      "strong",
    ]);
    expect(() =>
      f.kernel.configure({
        "official.token-speed": { default: { tps: 20, tokenizer: "unknown" } },
      }),
    ).toThrow();
  } finally {
    await f.close();
    delete (globalThis as any).__pluhubRoutingTransport;
  }
});
it("loads an administrator-provided Hugging Face tokenizer with no automatic downloads", async () => {
  const f = await fixture(["token-speed"]);
  try {
    const tokenizerPath = join(f.directory, "tokenizer.json"),
      configPath = join(f.directory, "tokenizer_config.json");
    await writeFile(
      tokenizerPath,
      JSON.stringify({
        version: "1.0",
        truncation: null,
        padding: null,
        added_tokens: [],
        normalizer: null,
        pre_tokenizer: { type: "Whitespace" },
        post_processor: null,
        decoder: null,
        model: {
          type: "WordLevel",
          vocab: { "[UNK]": 0, hello: 1, world: 2 },
          unk_token: "[UNK]",
        },
      }),
    );
    await writeFile(configPath, "{}");
    f.kernel.configure({
      "official.token-speed": {
        default: { tps: 20, tokenizer: "local" },
        tokenizers: {
          local: { kind: "huggingface", tokenizerPath, configPath },
        },
      },
    });
    async function* events() {
      yield { type: "text", text: "hello world" };
      yield { type: "finish", reason: "stop" };
    }
    const start = performance.now();
    const paced = await f.kernel.invoke<AsyncIterable<any>>(
      "ai.output-pace@1",
      { events: events(), plan: { upstreamId: "p", model: "m" } },
    );
    const output = [];
    for await (const e of paced) output.push(e);
    expect(
      output
        .filter((e) => e.type === "text")
        .map((e) => e.text)
        .join(""),
    ).toBe("hello world");
    expect(performance.now() - start).toBeGreaterThanOrEqual(95);
    expect(() =>
      f.kernel.configure({
        "official.token-speed": {
          default: { tps: 20, tokenizer: "local" },
          tokenizers: {
            local: {
              kind: "huggingface",
              tokenizerPath: join(f.directory, "missing.json"),
              configPath,
            },
          },
        },
      }),
    ).toThrow();
  } finally {
    await f.close();
  }
});
it("migrates existing request logs without deleting previous rows", async () => {
  const f = await fixture(
    ["users", "auth", "observability"],
    {},
    async (_kernel, directory) => {
      const dir = join(directory, "data", "official.observability");
      await mkdir(dir, { recursive: true });
      const db = new DatabaseSync(join(dir, "requests.sqlite"));
      try {
        db.exec(
          "CREATE TABLE requests(id TEXT PRIMARY KEY,user_id TEXT,key_id TEXT,created_at INTEGER NOT NULL,model TEXT NOT NULL,upstream TEXT,protocol TEXT NOT NULL,status TEXT NOT NULL,http_status INTEGER NOT NULL,latency_ms INTEGER NOT NULL,first_token_ms INTEGER,input_tokens INTEGER,output_tokens INTEGER,cost_micro_usd INTEGER,stream INTEGER NOT NULL,error_code TEXT); PRAGMA user_version=1;",
        );
        db.prepare(
          "INSERT INTO requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ).run(
          "legacy",
          null,
          null,
          Date.now(),
          "old-model",
          "p",
          "openai-chat",
          "success",
          200,
          10,
          null,
          1,
          2,
          3,
          0,
          null,
        );
      } finally {
        db.close();
      }
    },
  );
  try {
    const admin = await f.admin();
    const response = await f.request(
      "/api/plugins/official.observability/requests",
      "GET",
      undefined,
      admin,
    );
    expect((await response.json()).data[0]).toMatchObject({
      id: "legacy",
      model: "old-model",
      routing: null,
    });
  } finally {
    await f.close();
  }
});
