import { expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./helpers.js";

const protocols = [
  "openai-chat",
  "openai-responses",
  "anthropic",
  "gemini",
] as const;
type Protocol = (typeof protocols)[number];
function responseBody(protocol: string, output = 10): any {
  const usage = { input_tokens: 20, output_tokens: output };
  if (protocol === "openai-chat")
    return {
      choices: [
        {
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: output },
    };
  if (protocol === "anthropic")
    return {
      id: "message-fixture",
      model: "actual",
      role: "assistant",
      type: "message",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage,
    };
  if (protocol === "gemini")
    return {
      candidates: [
        {
          content: { role: "model", parts: [{ text: "ok" }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: {
        promptTokenCount: 20,
        candidatesTokenCount: output,
        totalTokenCount: 20 + output,
      },
    };
  return {
    id: "response-fixture",
    model: "actual",
    status: "completed",
    usage,
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "ok" }],
      },
    ],
  };
}
function requestBody(
  protocol: Protocol,
  limit?: number,
  stream = false,
): { path: string; body: any } {
  const common = { model: "demo", stream };
  if (protocol === "openai-chat")
    return {
      path: "/v1/chat/completions",
      body: {
        ...common,
        messages: [{ role: "user", content: "hello" }],
        ...(limit === undefined ? {} : { max_tokens: limit }),
      },
    };
  if (protocol === "openai-responses")
    return {
      path: "/v1/responses",
      body: {
        ...common,
        input: "hello",
        ...(limit === undefined ? {} : { max_output_tokens: limit }),
      },
    };
  if (protocol === "anthropic")
    return {
      path: "/v1/messages",
      body: {
        ...common,
        messages: [{ role: "user", content: "hello" }],
        ...(limit === undefined ? {} : { max_tokens: limit }),
      },
    };
  return {
    path:
      "/v1beta/models/demo:" +
      (stream ? "streamGenerateContent" : "generateContent"),
    body: {
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
      ...(limit === undefined
        ? {}
        : { generationConfig: { maxOutputTokens: limit } }),
    },
  };
}
const wireLimit = (protocol: string, body: any) =>
  protocol === "openai-chat"
    ? body.max_completion_tokens
    : protocol === "anthropic"
      ? body.max_tokens
      : protocol === "gemini"
        ? body.generationConfig?.maxOutputTokens
        : body.max_output_tokens;
async function budgetFixture(
  options: {
    target?: string;
    ingress?: Protocol;
    mode?: string;
    balance?: number;
    enabled?: boolean;
  } = {},
) {
  const target = options.target ?? "openai-chat",
    ingress = options.ingress ?? "openai-chat";
  const sent: any[] = [];
  let respond: (input: any) => Response | Promise<Response> = () =>
    target === "codex"
      ? new Response(
          `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: responseBody(target) })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        )
      : Response.json(responseBody(target));
  process.env.PLUHUB_TEST_UPSTREAM_KEY = "budget-fixture-only";
  const router: any = {
    upstreams: {
      primary: {
        protocol: target,
        baseUrl: "https://budget.example.test",
        keyRef: "env:PLUHUB_TEST_UPSTREAM_KEY",
        ...(target === "codex" ? { authMode: "cli" } : {}),
      },
    },
    models: {
      demo: {
        upstream: "primary",
        model: "actual",
        inputPrice: 1,
        outputPrice: 2,
      },
    },
  };
  const billing: any = {
    enabled: options.enabled ?? true,
    reserveOutputTokens: 64,
    ...(options.mode ? { outputBudgetMode: options.mode } : {}),
  };
  const f = await fixture(
    [
      "users",
      "auth",
      "billing",
      "ai-router",
      "observability",
      "rate-limit",
      "ingress-" + ingress,
      "upstream-" + target,
    ],
    {
      billing,
      "ai-router": router,
    },
    async (kernel, directory) => {
      (globalThis as any).__pluhubBudgetTransport = async (input: any) => {
        sent.push(JSON.parse(input.body));
        return respond(input);
      };
      const path = join(directory, "transport");
      await mkdir(path);
      await writeFile(
        join(path, "manifest.json"),
        JSON.stringify({
          schemaVersion: 1,
          id: "test.budget-transport",
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
        join(path, "index.mjs"),
        'export default {setup(h){h.provide("http.transport@1", input=>globalThis.__pluhubBudgetTransport(input));}};',
      );
      await kernel.add(path, { grants: [] });
    },
  );
  const session = await f.admin();
  const user = await f.kernel.invoke<any>("users.lookup@1", {
    username: "admin",
  });
  await f.kernel.invoke("billing.credit@1", {
    userId: user.id,
    amount: options.balance ?? 1_000_000,
    source: "budget-fixture",
  });
  return {
    ...f,
    user,
    session,
    router,
    billing,
    sent,
    setResponse: (value: typeof respond) => {
      respond = value;
    },
    send: (limit?: number, stream = false, update?: (body: any) => void) => {
      const input = requestBody(ingress, limit, stream);
      update?.(input.body);
      return f.request(input.path, "POST", input.body, session);
    },
    balance: () =>
      f.kernel.invoke<any>("billing.balance@1", { userId: user.id }),
    reservations: () => {
      const db = new DatabaseSync(
        join(f.config.dataDir, "official.billing/billing.sqlite"),
      );
      try {
        return db
          .prepare(
            "SELECT id,status,amount,actual,budget,reported_usage,receipt FROM reservations ORDER BY rowid",
          )
          .all() as any[];
      } finally {
        db.close();
      }
    },
    logs: async () =>
      (
        await (
          await f.request(
            "/api/plugins/official.observability/requests",
            "GET",
            undefined,
            session,
          )
        ).json()
      ).data as any[],
    async close() {
      await f.close();
      delete (globalThis as any).__pluhubBudgetTransport;
    },
  };
}

it.each(
  protocols.flatMap((ingress) =>
    protocols.map((target) => [ingress, target] as const),
  ),
)(
  "uses one default output budget for %s ingress and %s upstream, persists the snapshot and settles actual usage",
  async (ingress, target) => {
    const f = await budgetFixture({ ingress, target });
    try {
      const response = await f.send();
      expect(response.status).toBe(200);
      await response.json();
      expect(wireLimit(target, f.sent[0])).toBe(64);
      expect(await f.balance()).toMatchObject({ balance: 999960, held: 0 });
      const row = f.reservations()[0];
      expect(row.status).toBe("settled");
      expect(JSON.parse(row.budget)).toMatchObject({
        mode: "bounded",
        source: "default",
        limit: 64,
        reservedTokens: 64,
      });
      expect(JSON.parse(row.budget).inputTokens).toBeGreaterThan(1024);
      expect(JSON.parse((await f.logs())[0].routing).outputBudget.limit).toBe(
        64,
      );
    } finally {
      await f.close();
    }
  },
);

it("uses the channel's final cap instead of the larger client cap", async () => {
  const f = await budgetFixture();
  try {
    f.router.upstreams.primary.flow = {
      entry: "start",
      nodes: [
        { id: "start", type: "start", next: ["limit"] },
        { id: "limit", type: "maxTokens", limit: 8, next: "provider" },
        { id: "provider", type: "provider" },
      ],
    };
    f.kernel.configure({ "official.ai-router": f.router });
    f.setResponse(() => Response.json(responseBody("openai-chat", 4)));
    const response = await f.send(1000);
    expect(response.status).toBe(200);
    await response.json();
    expect(wireLimit("openai-chat", f.sent[0])).toBe(8);
    expect(JSON.parse(f.reservations()[0].budget)).toMatchObject({
      source: "explicit",
      limit: 8,
      reservedTokens: 8,
    });
    expect((await f.balance()).held).toBe(0);
  } finally {
    await f.close();
  }
});

it("includes effective thinking in the default and rejects contradictory client limits before reservation or transport", async () => {
  const f = await budgetFixture({ ingress: "anthropic", target: "anthropic" });
  try {
    const update = (body: any) => {
      body.thinking = { type: "enabled", budget_tokens: 2048 };
    };
    const response = await f.send(undefined, false, update);
    expect(response.status).toBe(200);
    await response.json();
    expect(f.sent[0].max_tokens).toBe(3072);
    expect(JSON.parse(f.reservations()[0].budget)).toMatchObject({
      reservedTokens: 3072,
      thinkingTokens: 2048,
    });
    const invalid = await f.send(1024, false, update);
    expect(invalid.status).toBe(400);
    await invalid.json();
    expect(f.sent).toHaveLength(1);
    expect(f.reservations()).toHaveLength(1);
    expect((await f.balance()).held).toBe(0);
  } finally {
    await f.close();
  }
});

it("supports Codex CLI estimation and fixed prices while strict token billing rejects an unbounded upstream before dispatch", async () => {
  const f = await budgetFixture({ target: "codex" });
  try {
    let response = await f.send();
    expect(response.status).toBe(200);
    await response.json();
    expect(f.sent[0].max_output_tokens).toBeUndefined();
    expect(JSON.parse(f.reservations()[0].budget).mode).toBe("estimate");
    f.kernel.configure({
      "official.billing": { ...f.billing, outputBudgetMode: "bounded" },
    });
    response = await f.send();
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe(
      "output_budget_unsupported",
    );
    expect(f.sent).toHaveLength(1);
    expect(f.reservations()).toHaveLength(1);
    f.router.models.demo.pricing = { mode: "request", request: 0.001 };
    f.kernel.configure({ "official.ai-router": f.router });
    response = await f.send();
    expect(response.status).toBe(200);
    await response.json();
    expect(JSON.parse(f.reservations()[1].budget).mode).toBe("fixed");
    response = await f.send(32);
    expect(response.status).toBe(200);
    await response.json();
    expect(f.sent).toHaveLength(3);
    expect(f.sent[2].max_output_tokens).toBeUndefined();
    expect(await f.balance()).toMatchObject({ balance: 997960, held: 0 });
  } finally {
    await f.close();
  }
});

it.each([false, true])(
  "settles Codex SSE without Content-Type for streaming and collected responses (stream=%s)",
  async (stream) => {
    const f = await budgetFixture({ target: "codex" });
    try {
      f.router.upstreams.primary.consumptionMultiplier = 0.2;
      f.kernel.configure({ "official.ai-router": f.router });
      f.setResponse(
        () =>
          new Response(
            new TextEncoder().encode(
              `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: responseBody("codex") })}\n\n`,
            ),
          ),
      );
      const response = await f.send(undefined, stream);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain("ok");
      expect(text).not.toContain('"error"');
      expect(f.reservations()[0]).toMatchObject({
        status: "settled",
        actual: 8,
      });
      expect(await f.balance()).toMatchObject({ balance: 999992, held: 0 });
      expect((await f.logs())[0]).toMatchObject({
        status: "success",
        cost_micro_usd: 8,
      });
    } finally {
      await f.close();
    }
  },
);

it("rejects an unframed Codex response without Content-Type", async () => {
  const f = await budgetFixture({ target: "codex" });
  try {
    f.setResponse(
      () => new Response(new TextEncoder().encode("not an event stream")),
    );
    const response = await f.send();
    expect(response.status).toBe(502);
    expect((await response.json()).error.code).toBe("upstream_truncated");
    expect(f.reservations()[0].status).toBe("settled");
    expect((await f.balance()).balance).toBe(
      1_000_000 - f.reservations()[0].amount,
    );
  } finally {
    await f.close();
  }
});

it("keeps estimation optional and does not rewrite requests when billing is disabled", async () => {
  const f = await budgetFixture({ mode: "estimate" });
  try {
    let response = await f.send();
    expect(response.status).toBe(200);
    await response.json();
    expect(wireLimit("openai-chat", f.sent[0])).toBeUndefined();
    expect(JSON.parse(f.reservations()[0].budget).mode).toBe("estimate");
    f.kernel.configure({ "official.billing": { enabled: false } });
    response = await f.send();
    expect(response.status).toBe(200);
    await response.json();
    expect(wireLimit("openai-chat", f.sent[1])).toBeUndefined();
    expect(f.reservations()).toHaveLength(1);
    expect((await f.balance()).balance).toBe(999960);
  } finally {
    await f.close();
  }
});

it("reserves atomically for concurrent calls and retains the admitted request's cap across configuration changes", async () => {
  const f = await budgetFixture({ balance: 2000 });
  let started!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first: Promise<Response> | undefined;
  try {
    f.setResponse(async () => {
      started();
      await gate;
      return Response.json(responseBody("openai-chat"));
    });
    first = f.send();
    await entered;
    expect((await f.balance()).held).toBeGreaterThan(0);
    f.kernel.configure({
      "official.billing": { ...f.billing, reserveOutputTokens: 128 },
    });
    const second = await f.send();
    expect(second.status).toBe(402);
    await second.json();
    expect(f.sent).toHaveLength(1);
    release();
    const completed = await first;
    await completed.json();
    expect(wireLimit("openai-chat", f.sent[0])).toBe(64);
    expect(await f.balance()).toMatchObject({ balance: 1960, held: 0 });
    const next = await f.send();
    expect(next.status).toBe(200);
    await next.json();
    expect(wireLimit("openai-chat", f.sent[1])).toBe(128);
    expect(f.reservations().map((row) => JSON.parse(row.budget).limit)).toEqual(
      [64, 128],
    );
  } finally {
    release();
    await first?.then((response) => response.body?.cancel()).catch(() => {});
    await f.close();
  }
});

it.each([false, true])(
  "bills the final Gemini snapshot after provisional thinking counts and an empty-text signature (stream=%s)",
  async (stream) => {
    const f = await budgetFixture({ target: "antigravity" });
    try {
      f.router.upstreams.primary.consumptionMultiplier = 0.2;
      f.router.upstreams.primary.projectId = "test-project";
      f.kernel.configure({ "official.ai-router": f.router });
      const frames = [
        {
          candidates: [{ content: { parts: [{ text: "ok" }] } }],
          usageMetadata: {
            promptTokenCount: 20,
            candidatesTokenCount: 2,
            thoughtsTokenCount: 128,
          },
        },
        {
          candidates: [
            {
              content: {
                parts: [{ text: "", thoughtSignature: "test-signature" }],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: {
            promptTokenCount: 20,
            candidatesTokenCount: 2,
            thoughtsTokenCount: 30,
          },
        },
      ];
      f.setResponse((input) => {
        expect(input.url).toContain(":streamGenerateContent?alt=sse");
        return new Response(
          frames
            .map((frame) => "data: " + JSON.stringify(frame) + "\n\n")
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      });
      const response = await f.send(64, stream);
      expect(response.status).toBe(200);
      expect(await response.text()).not.toContain('"error"');
      expect(f.reservations()[0]).toMatchObject({
        status: "settled",
        actual: 17,
      });
      expect(await f.balance()).toMatchObject({ balance: 999983, held: 0 });
      const row = (await f.logs())[0]!;
      expect(row).toMatchObject({ status: "success", cost_micro_usd: 17 });
      expect(JSON.parse(row.usage_json)).toEqual({
        input: 20,
        output: 32,
        reasoning: 30,
        cacheRead: 0,
      });
    } finally {
      await f.close();
    }
  },
);

it.each([false, true])(
  "settles an output-limit violation at the reservation instead of charging invalid excess (stream=%s)",
  async (stream) => {
    const f = await budgetFixture();
    try {
      f.setResponse(() =>
        stream
          ? new Response(
              `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 65 } })}\n\ndata: [DONE]\n\n`,
              { headers: { "content-type": "text/event-stream" } },
            )
          : Response.json(responseBody("openai-chat", 65)),
      );
      const response = await f.send(undefined, stream);
      expect(response.status).toBe(stream ? 200 : 502);
      expect(await response.text()).toContain("upstream_budget_exceeded");
      expect(f.reservations()[0].status).toBe("settled");
      expect(JSON.parse(f.reservations()[0].reported_usage).output).toBe(65);
      expect((await f.balance()).balance).toBe(
        1_000_000 - f.reservations()[0].amount,
      );
      expect((await f.balance()).held).toBe(0);
      expect((await f.logs())[0].error_code).toBe("upstream_budget_exceeded");
    } finally {
      await f.close();
    }
  },
);

it("settles cancellation at the reservation and does not charge again after restart", async () => {
  const f = await budgetFixture();
  let cancelled = false;
  try {
    f.setResponse(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n',
                ),
              );
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const response = await f.send(undefined, true);
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    expect(cancelled).toBe(true);
    let row = f.reservations()[0];
    expect(row.status).toBe("settled");
    expect(JSON.parse(row.budget).limit).toBe(64);
    await f.kernel.shutdown();
    await f.kernel.start();
    row = f.reservations()[0];
    expect(row.status).toBe("settled");
    expect(JSON.parse(row.budget).limit).toBe(64);
    expect(await f.balance()).toMatchObject({
      balance: 1_000_000 - row.amount,
      held: 0,
    });
    expect(row.actual).toBe(row.amount);
    expect(JSON.parse(row.receipt).mode).toBe("reserved");
  } finally {
    await f.close();
  }
});

it("migrates previous reservations without losing money or inventing historical budget and usage snapshots", async () => {
  const f = await budgetFixture();
  try {
    await f.kernel.shutdown();
    const db = new DatabaseSync(
      join(f.config.dataDir, "official.billing/billing.sqlite"),
    );
    try {
      db.exec(
        "ALTER TABLE reservations DROP COLUMN budget; ALTER TABLE reservations DROP COLUMN reported_usage; PRAGMA user_version=5;",
      );
      db.prepare(
        "INSERT INTO reservations(id,user_id,amount,status,created_at,pricing) VALUES(?,?,100,'reserved',?,?)",
      ).run(
        "legacy-reservation",
        f.user.id,
        Date.now(),
        JSON.stringify({ input: 1, output: 2 }),
      );
    } finally {
      db.close();
    }
    await f.kernel.start();
    expect(await f.balance()).toMatchObject({ balance: 999900, held: 0 });
    const row = f.reservations()[0];
    expect(row.status).toBe("settled");
    expect(row.budget).toBeNull();
    expect(row.reported_usage).toBeNull();
    const response = await f.send();
    expect(response.status).toBe(200);
    await response.json();
    expect(JSON.parse(f.reservations()[1].budget).limit).toBe(64);
    expect(await f.balance()).toMatchObject({ balance: 999860, held: 0 });
  } finally {
    await f.close();
  }
});

it("retains the actual usage in its final receipt when optional usage-copy storage fails", async () => {
  const f = await budgetFixture();
  const db = new DatabaseSync(
    join(f.config.dataDir, "official.billing/billing.sqlite"),
  );
  try {
    db.exec(
      "CREATE TRIGGER deny_usage_storage BEFORE UPDATE OF reported_usage ON reservations BEGIN SELECT RAISE(ABORT,'test audit write failure'); END;",
    );
    const response = await f.send();
    expect(response.status).toBe(200);
    await response.json();
    const row = f.reservations()[0];
    expect(row.status).toBe("settled");
    expect(row.reported_usage).toBeNull();
    expect(JSON.parse(row.receipt).usage).toMatchObject({
      input: 20,
      output: 10,
    });
    expect(await f.balance()).toMatchObject({ balance: 999960, held: 0 });
    db.exec("DROP TRIGGER deny_usage_storage");
    await f.kernel.shutdown();
    await f.kernel.start();
    expect(await f.balance()).toMatchObject({ balance: 999960, held: 0 });
  } finally {
    db.close();
    await f.close();
  }
});

it.each(protocols)(
  "encodes a safe output-budget failure in the %s stream format",
  async (ingress) => {
    const f = await budgetFixture({ ingress });
    try {
      f.setResponse(
        () =>
          new Response(
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "partial" }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 65 } })}\n\ndata: [DONE]\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          ),
      );
      const response = await f.send(undefined, true);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).toContain("Upstream usage exceeded the output token limit");
      expect(text.toLowerCase()).toContain("upstream_budget_exceeded");
      expect(text).not.toContain('"type":"response.completed"');
      expect(text).not.toContain('"type":"message_stop"');
      expect(f.reservations()[0].status).toBe("settled");
      expect((await f.balance()).balance).toBe(
        1_000_000 - f.reservations()[0].amount,
      );
    } finally {
      await f.close();
    }
  },
);
