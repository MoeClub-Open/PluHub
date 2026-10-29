import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { expect, it } from "vitest";
import { fixture } from "./helpers.js";

it("meters each remote automatic routing decision without bypassing key channel limits", async () => {
  let reportUsage = true;
  const requests: { path: string; authorization?: string; body: any }[] = [];
  const options = ["easy", "standard", "hard", "expert"];
  const probabilities = { easy: 0, standard: 0, hard: 1, expert: 0 };
  const server = createServer(async (request, response) => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({
      path: request.url!,
      authorization: request.headers.authorization,
      body,
    });
    response.setHeader("content-type", "application/json");
    const usage = reportUsage
      ? { usage: { input_tokens: 5, output_tokens: 3 } }
      : {};
    if (request.url?.endsWith("/decisions"))
      response.end(
        JSON.stringify({
          model: "luna-provider",
          answers: [
            {
              name: "difficulty",
              choice: "hard",
              confidence: 1,
              probabilities: options.map((value) => ({
                value,
                probability: probabilities[value as keyof typeof probabilities],
              })),
            },
          ],
          ...usage,
        }),
      );
    else if (request.url?.endsWith("/systemone"))
      response.end(
        JSON.stringify({
          model: "systemone-provider",
          answers: {
            difficulty: {
              type: "choice",
              choice: "hard",
              confidence: 1,
              probabilities,
            },
          },
          ...usage,
        }),
      );
    else if (request.url?.endsWith("/decide"))
      response.end(
        JSON.stringify({
          choice: "hard",
          confidence: 1,
          options,
          probabilities: [0, 0, 1, 0],
          ...usage,
        }),
      );
    else
      response.end(
        JSON.stringify({
          model: body.model,
          choices: [
            { message: { content: "routed answer" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 4, completion_tokens: 2 },
        }),
      );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const f = await fixture(
    [
      "users",
      "auth",
      "ai-router",
      "auto-router",
      "billing",
      "observability",
      "rate-limit",
      "http-transport",
      "upstream-openai-chat",
      "ingress-openai-chat",
    ],
    {
      billing: { enabled: true, reserveOutputTokens: 64 },
      "upstream-openai-chat": { secretRefs: [] },
    },
  );
  try {
    const admin = await f.admin();
    const me = await (
      await f.request("/api/plugins/official.auth/me", "GET", undefined, admin)
    ).json();
    await f.kernel.invoke("billing.credit@1", {
      userId: me.id,
      amount: 1_000_000,
      source: "metered-auto-routing",
    });
    f.kernel.secrets.put("decision-key", "secret:DECISION_TEST");
    f.kernel.secrets.put("answer-key", "secret:ANSWER_TEST");
    const baseUrl = `http://127.0.0.1:${(server.address() as any).port}/v1`;
    const kinds = ["luna", "systemone", "jev"] as const;
    const profiles = Object.fromEntries(
      kinds.map((kind) => [
        kind,
        {
          mode: "model",
          candidates: [{ id: "strong", target: "answer", strength: 95 }],
          fallbackCandidate: "strong",
          decision: {
            kind,
            model: `classifier-${kind}`,
            channelId: `decision-${kind}`,
          },
        },
      ]),
    );
    const upstreams = Object.fromEntries([
      [
        "text",
        { protocol: "openai-chat", baseUrl, keyRef: "secret:ANSWER_TEST" },
      ],
      ...kinds.flatMap((kind) => [
        [
          `decision-${kind}`,
          { protocol: kind, baseUrl, keyRef: "secret:DECISION_TEST" },
        ],
        [`virtual-${kind}`, { protocol: "auto-router" }],
      ]),
    ]);
    const models = Object.fromEntries([
      [
        "answer",
        {
          upstream: "text",
          model: "answer-provider",
          inputPrice: 1,
          outputPrice: 1,
        },
      ],
      ...kinds.flatMap((kind) => [
        [
          `classifier-${kind}`,
          {
            upstream: `decision-${kind}`,
            model: `${kind}-provider`,
            inputPrice: 2,
            outputPrice: 3,
          },
        ],
        [
          `smart-${kind}`,
          {
            upstream: `virtual-${kind}`,
            model: kind,
            inputPrice: 999,
            outputPrice: 999,
          },
        ],
      ]),
    ]);
    f.kernel.configure({
      "official.ai-router": {
        upstreams,
        models,
        secretRefs: ["secret:DECISION_TEST", "secret:ANSWER_TEST"],
      },
      "official.auto-router": { profiles },
      "official.upstream-openai-chat": { secretRefs: ["secret:ANSWER_TEST"] },
    });
    const tokens: Record<string, string> = {};
    for (const kind of kinds) {
      const result = await f.request(
        "/api/plugins/official.auth/keys",
        "POST",
        {
          name: `auto-${kind}`,
          models: [`smart-${kind}`],
        },
        admin,
      );
      expect(result.status, await result.clone().text()).toBe(201);
      tokens[kind] = (await result.json()).token;
    }
    const before = (
      await f.kernel.invoke<any>("billing.balance@1", { userId: me.id })
    ).balance;
    const childIds: string[] = [];
    for (const withUsage of [true, false]) {
      reportUsage = withUsage;
      for (const kind of kinds) {
        const result = await f.request(
          "/v1/chat/completions",
          "POST",
          {
            model: `smart-${kind}`,
            messages: [{ role: "user", content: "Classify this task" }],
            max_tokens: 16,
          },
          { authorization: `Bearer ${tokens[kind]}` },
        );
        expect(result.status, await result.clone().text()).toBe(200);
        const parent = result.headers.get("x-pluhub-request-id")!;
        expect((await result.json()).choices[0].message.content).toBe(
          "routed answer",
        );
        const children = await f.request(
          `/api/plugins/official.observability/requests/children?parentId=${parent}`,
          "GET",
          undefined,
          admin,
        );
        expect(children.status, await children.clone().text()).toBe(200);
        const rows = (await children.json()).data as any[];
        const decision = rows.find(
          (row) => row.workflow_node_id === `decision:${kind}`,
        );
        expect(decision).toMatchObject({
          model: `classifier-${kind}`,
          protocol: kind,
          billing_status: "settled",
          input_tokens: withUsage ? 5 : null,
          output_tokens: withUsage ? 3 : null,
        });
        if (withUsage) expect(decision.charged_micro_usd).toBe(19);
        else expect(decision.charged_micro_usd).toBeGreaterThan(0);
        expect(decision.held_micro_usd).toBe(0);
        childIds.push(decision.id);
      }
    }
    expect(requests).toHaveLength(12);
    for (const [index, path] of [
      "/v1/decisions",
      "/v1/systemone",
      "/v1/decide",
    ].entries()) {
      const decision = requests[index * 2]!;
      expect(decision).toMatchObject({
        path,
        authorization: "Bearer decision-key",
      });
      if (index === 2) expect(decision.body).not.toHaveProperty("model");
      else expect(decision.body.model).toBe(`${kinds[index]}-provider`);
      expect(requests[index * 2 + 1]).toMatchObject({
        authorization: "Bearer answer-key",
        body: { model: "answer-provider" },
      });
    }
    const balance = await f.kernel.invoke<any>("billing.balance@1", {
      userId: me.id,
    });
    const decisionCharges = await f.kernel.invoke<any[]>(
      "billing.request-charges@1",
      {
        requests: childIds.map((id) => ({ id, userId: me.id })),
      },
    );
    expect(balance.balance).toBe(
      before -
        decisionCharges.reduce((sum, row) => sum + row.charged, 0) -
        6 * 6,
    );
    expect(balance.held).toBe(0);
    const logs = new DatabaseSync(
      join(f.config.dataDir, "official.observability", "requests.sqlite"),
    );
    try {
      for (const id of childIds) {
        const row = logs.prepare("SELECT * FROM requests WHERE id=?").get(id);
        expect(JSON.stringify(row)).not.toContain("Classify this task");
        expect(JSON.stringify(row)).not.toContain("decision-key");
      }
    } finally {
      logs.close();
    }
    const restricted = await f.request(
      "/api/plugins/official.auth/keys",
      "POST",
      {
        name: "without-decision-channel",
        models: ["smart-luna"],
        channelIds: ["virtual-luna", "text"],
      },
      admin,
    );
    expect(restricted.status, await restricted.clone().text()).toBe(201);
    const token = (await restricted.json()).token;
    const denied = await f.request(
      "/v1/chat/completions",
      "POST",
      {
        model: "smart-luna",
        messages: [{ role: "user", content: "Classify this task" }],
        max_tokens: 16,
      },
      { authorization: `Bearer ${token}` },
    );
    expect(denied.status).toBeGreaterThanOrEqual(400);
    await denied.text();
    expect(requests).toHaveLength(12);
    const direct = await f.request(
      "/internal/workflow/decision",
      "POST",
      { kind: "luna", model: "classifier-luna", state: {} },
      admin,
    );
    expect(direct.status).toBe(404);
    await direct.text();
  } finally {
    await f.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
