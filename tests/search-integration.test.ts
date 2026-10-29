import { it, expect } from "vitest";
import { createServer } from "node:http";
import { fixture } from "./helpers.js";

it("rejects unsupported Codex CLI tool-call bounds before reserving funds or contacting the provider", async () => {
  const f = await fixture(
    [
      "users",
      "auth",
      "billing",
      "ai-router",
      "http-transport",
      "upstream-codex",
      "rate-limit",
      "ingress-openai-responses",
    ],
    {
      billing: { enabled: true },
      "ai-router": {
        upstreams: {
          "1": {
            protocol: "codex",
            authMode: "cli",
            baseUrl: "https://provider.invalid",
            keyRef: "env:PLUHUB_TEST_UPSTREAM_KEY",
          },
        },
        models: {
          search: {
            upstream: "1",
            model: "gpt-6-luna",
            inputPrice: 0.1,
            outputPrice: 0.5,
          },
        },
      },
    },
  );
  try {
    const admin = await f.admin();
    const response = await f.request(
      "/v1/responses",
      "POST",
      {
        model: "search",
        input: "search",
        tools: [{ type: "web_search" }],
        max_tool_calls: 1,
      },
      admin,
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("web_search_unsupported");
    expect(
      await (
        await f.request(
          "/api/plugins/official.billing/wallet",
          "GET",
          undefined,
          admin,
        )
      ).json(),
    ).toMatchObject({ balance: 0, held: 0 });
  } finally {
    await f.close();
  }
});

it("settles native search once for JSON and split SSE, preserving references and scoped credentials", async () => {
  const prior = process.env.PLUHUB_TEST_UPSTREAM_KEY;
  process.env.PLUHUB_TEST_UPSTREAM_KEY = "search-upstream-fixture";
  let calls = 0;
  const call = {
    id: "search1",
    type: "web_search_call",
    status: "completed",
    action: { type: "search", query: "private search query" },
  };
  const output = [
    call,
    {
      id: "message1",
      type: "message",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: "Found",
          annotations: [
            {
              type: "url_citation",
              url: "https://example.com",
              title: "Source",
              start_index: 0,
              end_index: 5,
            },
          ],
        },
      ],
    },
  ];
  const result = {
    id: "response1",
    status: "completed",
    output,
    usage: { input_tokens: 20, output_tokens: 4 },
  };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    expect(req.headers.authorization).toBe("Bearer search-upstream-fixture");
    expect(body.tools).toContainEqual({ type: "web_search" });
    expect(body.model).toBe("upstream-model");
    calls++;
    if (!body.stream) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(result));
    } else {
      res.setHeader("content-type", "text/event-stream");
      const frames = [
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { ...call, status: "in_progress" },
        },
        {
          type: "response.web_search_call.searching",
          output_index: 0,
          item_id: "search1",
        },
        { type: "response.output_item.done", output_index: 0, item: call },
        {
          type: "response.output_text.delta",
          item_id: "message1",
          output_index: 1,
          content_index: 0,
          delta: "Found",
        },
        { type: "response.output_item.done", output_index: 1, item: output[1] },
        { type: "response.completed", response: result },
      ];
      const data = Buffer.from(
        frames
          .map((frame) => "data: " + JSON.stringify(frame) + "\n\n")
          .join(""),
      );
      for (let i = 0; i < data.length; i += 7)
        res.write(data.subarray(i, i + 7));
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const f = await fixture(
    [
      "users",
      "auth",
      "billing",
      "ai-router",
      "observability",
      "http-transport",
      "upstream-openai-responses",
      "rate-limit",
      "ingress-openai-responses",
    ],
    {
      billing: { enabled: true },
      "ai-router": {
        upstreams: {
          "1": {
            protocol: "openai-responses",
            baseUrl: `http://127.0.0.1:${(server.address() as any).port}`,
            keyRef: "env:PLUHUB_TEST_UPSTREAM_KEY",
            consumptionMultiplier: 0.2,
          },
        },
        models: {
          search: {
            upstream: "1",
            model: "upstream-model",
            inputPrice: 2,
            outputPrice: 4,
            pricing: { webSearch: 0.01 },
          },
        },
      },
    },
  );
  try {
    const admin = await f.admin();
    const me = await (
      await f.request("/api/plugins/official.auth/me", "GET", undefined, admin)
    ).json();
    await f.kernel.invoke("billing.credit@1", {
      userId: me.id,
      amount: 1000000,
      source: "test:search",
    });
    const key = await (
      await f.request(
        "/api/plugins/official.auth/keys",
        "POST",
        { name: "search" },
        admin,
      )
    ).json();
    for (const stream of [false, true]) {
      const response = await f.request(
        "/v1/responses",
        "POST",
        {
          model: "search",
          input: "Search the web",
          stream,
          max_output_tokens: 32,
          tools: [{ type: "web_search" }],
        },
        { authorization: "Bearer " + key.token },
      );
      expect(response.status, await response.clone().text()).toBe(200);
      if (stream) {
        const text = await response.text();
        expect(
          text.match(/event: response.web_search_call.completed/g),
        ).toHaveLength(1);
        expect(text).toContain("https://example.com");
        expect(text).toContain("event: response.completed");
      } else
        expect(await response.json()).toMatchObject({
          output: [
            { type: "web_search_call", id: "search1" },
            { type: "message" },
          ],
        });
    }
    expect(calls).toBe(2);
    expect(
      await f.kernel.invoke("billing.balance@1", { userId: me.id }),
    ).toMatchObject({ balance: 995976, held: 0 });
    const ledger = await (
      await f.request(
        "/api/plugins/official.billing/ledger",
        "GET",
        undefined,
        admin,
      )
    ).json();
    for (const row of ledger.filter((r: any) =>
      r.source.startsWith("request:"),
    )) {
      const receipt = JSON.parse(row.receipt);
      expect(receipt).toMatchObject({
        amount: 2012,
        usage: { webSearch: 1 },
        pricing: { webSearch: 0.01, multiplier: 0.2 },
      });
      expect(
        receipt.lines.find((line: any) => line.kind === "webSearch").quantity,
      ).toBe(1);
    }
    const logs = await (
      await f.request(
        "/api/plugins/official.observability/requests",
        "GET",
        undefined,
        admin,
      )
    ).json();
    expect(JSON.stringify(logs)).not.toContain("private search query");
  } finally {
    await f.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    if (prior === undefined) delete process.env.PLUHUB_TEST_UPSTREAM_KEY;
    else process.env.PLUHUB_TEST_UPSTREAM_KEY = prior;
  }
}, 20000);
