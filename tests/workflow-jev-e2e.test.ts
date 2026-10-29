import { createServer } from "node:http";
import { expect, it } from "vitest";
import { fixture } from "./helpers.js";

it("routes via a metered Jev node and retains a reservation when usage is absent", async () => {
  const received: { path: string; body: any; authorization?: string }[] = [];
  let reportUsage = true;
  const server = createServer(async (request, response) => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    received.push({
      path: request.url!,
      body,
      authorization: request.headers.authorization,
    });
    response.setHeader("content-type", "application/json");
    if (request.url?.endsWith("/systemone")) {
      response.end(
        JSON.stringify({
          model: "jev-provider",
          answers: { route: { type: "choice", choice: "complex" } },
          ...(reportUsage
            ? { usage: { input_tokens: 4, output_tokens: 2 } }
            : {}),
        }),
      );
    } else {
      response.end(
        JSON.stringify({
          model: body.model,
          choices: [
            {
              message: { content: "selected complex model" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const f = await fixture(
    [
      "users",
      "auth",
      "ai-router",
      "rate-limit",
      "billing",
      "observability",
      "http-transport",
      "upstream-openai-chat",
      "ingress-openai-chat",
    ],
    { "upstream-openai-chat": { secretRefs: [] }, billing: { enabled: true } },
  );
  try {
    const admin = await f.admin();
    const me = await (
      await f.request("/api/plugins/official.auth/me", "GET", undefined, admin)
    ).json();
    await f.kernel.invoke("billing.credit@1", {
      userId: me.id,
      amount: 1_000_000,
      source: "jev-e2e",
    });
    const settings = await (
      await f.request(
        "/api/plugins/official.ai-router/configuration",
        "GET",
        undefined,
        admin,
      )
    ).json();
    const baseUrl = `http://127.0.0.1:${(server.address() as any).port}/v1`;
    const provider = (protocol: string, keyRef: string) => ({
      flow: {
        entry: "start",
        nodes: [
          { id: "start", type: "start", next: "call" },
          {
            id: "call",
            type: "provider",
            upstream: { protocol, baseUrl, keyRef },
          },
        ],
      },
    });
    settings.config.upstreams = {
      decision: provider("systemone", "jev-test-key"),
      text: provider("openai-chat", "chat-test-key"),
      route: {
        flow: {
          entry: "start",
          nodes: [
            { id: "start", type: "start", next: "branch" },
            {
              id: "decision",
              type: "jev",
              model: "classifier",
              state: "",
              answerKey: "route",
              questions: {
                route: {
                  type: "choice",
                  instructions: "Choose a route",
                  criteria: { simple: "simple", complex: "complex" },
                },
              },
            },
            {
              id: "compare",
              type: "compare",
              valueType: "string",
              operator: "eq",
              left: "",
              right: "complex",
            },
            {
              id: "branch",
              type: "branch",
              condition: false,
              yes: "complex",
              no: "simple",
            },
            {
              id: "complex",
              type: "upstream",
              target: "strong",
              mode: "implicit",
            },
            {
              id: "simple",
              type: "upstream",
              target: "fast",
              mode: "implicit",
            },
          ],
          bindings: [
            {
              source: "start",
              output: "text",
              target: "decision",
              input: "state",
            },
            {
              source: "decision",
              output: "choice",
              target: "compare",
              input: "left",
            },
            {
              source: "compare",
              output: "result",
              target: "branch",
              input: "condition",
            },
          ],
        },
      },
    };
    settings.config.models = {
      classifier: {
        upstream: "decision",
        model: "jev-provider",
        inputPrice: 2,
        outputPrice: 4,
      },
      strong: {
        upstream: "text",
        model: "strong-provider",
        inputPrice: 5,
        outputPrice: 7,
      },
      fast: {
        upstream: "text",
        model: "fast-provider",
        inputPrice: 1,
        outputPrice: 1,
      },
      smart: {
        upstream: "route",
        model: "smart",
        inputPrice: 999,
        outputPrice: 999,
      },
    };
    const saved = await f.request(
      "/api/plugins/official.ai-router/configuration",
      "PUT",
      settings,
      admin,
    );
    expect(saved.status, await saved.clone().text()).toBe(200);

    const quote = await f.request(
      "/api/plugins/official.billing/quote",
      "POST",
      {
        model: "smart",
        usage: { input: 3, output: 2 },
      },
      admin,
    );
    expect(quote.status).toBe(409);
    expect(received).toHaveLength(0);

    async function call() {
      const response = await f.request(
        "/v1/chat/completions",
        "POST",
        {
          model: "smart",
          messages: [{ role: "user", content: "A hard question" }],
          max_tokens: 16,
        },
        admin,
      );
      expect(response.status, await response.clone().text()).toBe(200);
      const id = response.headers.get("x-pluhub-request-id")!;
      expect((await response.json()).choices[0].message.content).toBe(
        "selected complex model",
      );
      const rows = await f.request(
        `/api/plugins/official.observability/requests/children?parentId=${id}`,
        "GET",
        undefined,
        admin,
      );
      expect(rows.status, await rows.clone().text()).toBe(200);
      return (await rows.json()).data as any[];
    }

    const first = await call();
    expect(received).toHaveLength(2);
    expect(received[0]).toMatchObject({
      authorization: "Bearer jev-test-key",
      body: { model: "jev-provider", state: "A hard question" },
    });
    expect(received[1]).toMatchObject({
      authorization: "Bearer chat-test-key",
      body: { model: "strong-provider" },
    });
    const decision = first.find((row) => row.workflow_node_id === "decision");
    expect(decision).toMatchObject({
      input_tokens: 4,
      output_tokens: 2,
      billing_status: "settled",
      charged_micro_usd: 16,
    });
    const final = first.find((row) => row.id !== decision.id);
    expect(final).toMatchObject({
      input_tokens: 3,
      output_tokens: 2,
      billing_status: "settled",
      charged_micro_usd: 29,
    });
    expect(
      (await f.kernel.invoke<any>("billing.balance@1", { userId: me.id }))
        .balance,
    ).toBe(1_000_000 - 45);

    reportUsage = false;
    const second = await call();
    const unknown = second.find((row) => row.workflow_node_id === "decision");
    expect(unknown).toMatchObject({
      input_tokens: null,
      output_tokens: null,
      billing_status: "settled",
    });
    expect(unknown.charged_micro_usd).toBeGreaterThan(0);
    expect(unknown.held_micro_usd).toBe(0);
    const balance = await f.kernel.invoke<any>("billing.balance@1", {
      userId: me.id,
    });
    expect(balance.balance).toBe(
      1_000_000 - 45 - 29 - unknown.charged_micro_usd,
    );
    expect(balance.held).toBe(0);
  } finally {
    await f.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
