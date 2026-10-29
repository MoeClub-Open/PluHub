import { createServer } from "node:http";
import { expect, it } from "vitest";
import { fixture } from "./helpers.js";

it("records only explicitly enabled upstream response model IDs for both response modes", async () => {
  let returnedModel: string | undefined = "provider-gray-2026";
  const server = createServer(async (request, response) => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const result = {
      ...(returnedModel ? { model: returnedModel } : {}),
      choices: [{ message: { content: "hello" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    };
    if (body.stream) {
      response.setHeader("content-type", "text/event-stream");
      response.end(
        `data: ${JSON.stringify({
          ...(returnedModel ? { model: returnedModel } : {}),
          choices: [
            { index: 0, delta: { content: "hello" }, finish_reason: "stop" },
          ],
          usage: result.usage,
        })}\n\ndata: [DONE]\n\n`,
      );
    } else {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(result));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const f = await fixture(
    [
      "users",
      "auth",
      "ai-router",
      "rate-limit",
      "http-transport",
      "upstream-openai-chat",
      "ingress-openai-chat",
      "observability",
    ],
    { "upstream-openai-chat": { secretRefs: [] } },
  );
  try {
    const admin = await f.admin();
    const config = await (
      await f.request(
        "/api/plugins/official.ai-router/configuration",
        "GET",
        undefined,
        admin,
      )
    ).json();
    const connection = {
      protocol: "openai-chat",
      baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
      keyRef: "test-key",
    };
    config.config.upstreams = Object.fromEntries(
      [true, false].map((enabled) => [
        enabled ? "on" : "off",
        {
          flow: {
            entry: "start",
            nodes: [
              { id: "start", type: "start", next: ["call"] },
              {
                id: "call",
                type: "provider",
                upstream: connection,
                modelMap: { "requested-upstream": "requested-upstream" },
                ...(enabled ? { recordResponseModel: true } : {}),
              },
            ],
          },
        },
      ]),
    );
    config.config.models = {
      on: { upstream: "on", model: "requested-upstream" },
      off: { upstream: "off", model: "requested-upstream" },
    };
    const saved = await f.request(
      "/api/plugins/official.ai-router/configuration",
      "PUT",
      config,
      admin,
    );
    expect(saved.status, await saved.clone().text()).toBe(200);

    async function call(model: string, stream: boolean) {
      const response = await f.request(
        "/v1/chat/completions",
        "POST",
        {
          model,
          stream,
          messages: [{ role: "user", content: "hi" }],
        },
        admin,
      );
      expect(response.status, await response.clone().text()).toBe(200);
      const id = response.headers.get("x-pluhub-request-id");
      const body = await response.text();
      expect(body).not.toContain("provider-gray-2026");
      const logs = await (
        await f.request(
          `/api/plugins/official.observability/requests?requestId=${id}`,
          "GET",
          undefined,
          admin,
        )
      ).json();
      expect(logs.data).toHaveLength(1);
      return logs.data[0];
    }
    expect((await call("on", false)).upstream_response_model).toBe(
      "provider-gray-2026",
    );
    expect((await call("on", true)).upstream_response_model).toBe(
      "provider-gray-2026",
    );
    expect((await call("off", false)).upstream_response_model).toBeNull();
    expect((await call("off", true)).upstream_response_model).toBeNull();
    returnedModel = undefined;
    expect((await call("on", false)).upstream_response_model).toBeNull();
    expect((await call("on", true)).upstream_response_model).toBeNull();
  } finally {
    await f.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
