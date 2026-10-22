import { it, expect } from "vitest";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Protocol } from "@pluhub/contracts/ai";
import { fixture } from "./helpers.js";
const protocols: Protocol[] = [
  "openai-chat",
  "openai-responses",
  "anthropic",
  "gemini",
];
const frame = (d: any) => "data: " + JSON.stringify(d) + "\n\n";
function path(p: Protocol, stream: boolean) {
  return p === "openai-chat"
    ? "/v1/chat/completions"
    : p === "openai-responses"
      ? "/v1/responses"
      : p === "anthropic"
        ? "/v1/messages"
        : "/v1beta/models/demo:" +
          (stream ? "streamGenerateContent?alt=sse" : "generateContent");
}
function input(p: Protocol, stream: boolean) {
  const image = "data:image/png;base64,aGk=";
  const schema = {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
    additionalProperties: false,
  };
  if (p === "openai-chat")
    return {
      model: "demo",
      stream,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Look" },
            { type: "image_url", image_url: { url: image } },
          ],
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "answer", schema, strict: true },
      },
      top_p: 0.8,
    };
  if (p === "openai-responses")
    return {
      model: "demo",
      stream,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "Look" },
            { type: "input_image", image_url: image },
          ],
        },
      ],
      text: {
        format: { type: "json_schema", name: "answer", schema, strict: true },
      },
      top_p: 0.8,
    };
  if (p === "anthropic")
    return {
      model: "demo",
      stream,
      max_tokens: 64,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Look" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "aGk=" },
            },
          ],
        },
      ],
      output_config: { format: { type: "json_schema", schema } },
      top_p: 0.8,
    };
  return {
    contents: [
      {
        role: "user",
        parts: [
          { text: "Look" },
          { inlineData: { mimeType: "image/png", data: "aGk=" } },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseJsonSchema: schema,
      topP: 0.8,
    },
  };
}
it("runs image + schema + signed reasoning conversion over all HTTP entry/provider pairs", async () => {
  const prior = process.env.PLUHUB_TEST_UPSTREAM_KEY;
  process.env.PLUHUB_TEST_UPSTREAM_KEY = "conversion-only-secret";
  let calls = 0;
  const received: any[] = [];
  const server = createServer(async (req, res) => {
    const parts = [];
    for await (const chunk of req) parts.push(chunk);
    const body = JSON.parse(Buffer.concat(parts).toString());
    received.push(body);
    calls++;
    const p = req.url!.includes("chat/completions")
      ? "openai-chat"
      : req.url!.includes("responses")
        ? "openai-responses"
        : req.url!.includes("messages")
          ? "anthropic"
          : "gemini";
    const stream = body.stream || req.url!.includes("streamGenerateContent");
    const answer = '{"answer":"ok"}';
    const usage = { input_tokens: 10, output_tokens: 4 };
    const result =
      p === "openai-chat"
        ? {
            choices: [
              {
                index: 0,
                message: { content: answer, reasoning_content: "think" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 4 },
          }
        : p === "openai-responses"
          ? {
              status: "completed",
              output: [
                {
                  id: "rs1",
                  type: "reasoning",
                  summary: [{ type: "summary_text", text: "think" }],
                  encrypted_content: "opaque-cipher",
                },
                {
                  id: "msg1",
                  type: "message",
                  content: [{ type: "output_text", text: answer }],
                },
              ],
              usage,
            }
          : p === "anthropic"
            ? {
                content: [
                  {
                    type: "thinking",
                    thinking: "think",
                    signature: "opaque-signature",
                  },
                  { type: "text", text: answer },
                ],
                stop_reason: "end_turn",
                usage,
              }
            : {
                candidates: [
                  {
                    index: 0,
                    content: {
                      parts: [
                        {
                          text: "think",
                          thought: true,
                          thoughtSignature: "opaque-signature",
                        },
                        { text: answer },
                      ],
                    },
                    finishReason: "STOP",
                  },
                ],
                usageMetadata: {
                  promptTokenCount: 10,
                  candidatesTokenCount: 4,
                },
              };
    const wire = !stream
      ? JSON.stringify(result)
      : p === "openai-chat"
        ? frame({
            choices: [
              {
                index: 0,
                delta: { reasoning_content: "think", content: answer },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 4 },
          }) + "data: [DONE]\n\n"
        : p === "openai-responses"
          ? frame({ type: "response.completed", response: result })
          : p === "anthropic"
            ? frame({ type: "message_start", message: { usage } }) +
              frame({
                type: "content_block_start",
                index: 0,
                content_block: {
                  type: "thinking",
                  thinking: "think",
                  signature: "opaque-signature",
                },
              }) +
              frame({ type: "content_block_stop", index: 0 }) +
              frame({
                type: "content_block_start",
                index: 1,
                content_block: { type: "text", text: answer },
              }) +
              frame({ type: "content_block_stop", index: 1 }) +
              frame({
                type: "message_delta",
                delta: { stop_reason: "end_turn" },
                usage,
              }) +
              frame({ type: "message_stop" })
            : frame(result);
    res.writeHead(200, {
      "content-type": stream ? "text/event-stream" : "application/json",
    });
    res.end(wire);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const f = await fixture();
  try {
    const admin = await f.admin();
    for (const p of protocols) {
      f.kernel.configure({
        "official.ai-router": {
          upstreams: {
            primary: {
              protocol: p,
              baseUrl: "http://127.0.0.1:" + (server.address() as any).port,
              keyRef: "env:PLUHUB_TEST_UPSTREAM_KEY",
            },
          },
          models: { demo: { upstream: "primary", model: "provider-model" } },
        },
      });
      for (const entry of protocols)
        for (const stream of [false, true]) {
          const response = await f.request(
            path(entry, stream),
            "POST",
            input(entry, stream),
            admin,
          );
          expect(response.status).toBe(200);
          const text = await response.text();
          expect(text, `${entry} -> ${p}`).not.toContain(
            "Upstream stream failed",
          );
          expect(text).toContain("think");
          expect(text).toContain("answer");
          const sent = received.at(-1);
          const raw = JSON.stringify(sent);
          expect(raw).toContain("aGk=");
          expect(raw).toContain("0.8");
          expect(raw).toContain("additionalProperties");
          expect(raw).not.toContain("conversion-only-secret");
          if (p === "anthropic")
            expect(sent.output_config.format.schema.properties).toHaveProperty(
              "answer",
            );
        }
    }
    expect(calls).toBe(32);
  } finally {
    await f.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (prior === undefined) delete process.env.PLUHUB_TEST_UPSTREAM_KEY;
    else process.env.PLUHUB_TEST_UPSTREAM_KEY = prior;
  }
});

it("records encoder failure after upstream finish and holds settlement for review", async () => {
  const f = await fixture(
    [
      "users",
      "auth",
      "billing",
      "observability",
      "ai-router",
      "protocol-converter",
      "ingress-openai-chat",
    ],
    {
      billing: { enabled: true },
      "ai-router": {
        upstreams: {
          test: {
            protocol: "openai-chat",
            baseUrl: "http://127.0.0.1",
            keyRef: "env:PLUHUB_TEST_UPSTREAM_KEY",
          },
        },
        models: {
          demo: {
            upstream: "test",
            model: "test",
            pricing: { mode: "request", request: 0.002 },
          },
        },
      },
    },
    async (kernel, dir) => {
      const provider = join(dir, "provider");
      await mkdir(provider);
      await writeFile(
        join(provider, "manifest.json"),
        JSON.stringify({
          schemaVersion: 1,
          id: "test.provider",
          version: "1.0.0",
          host: ">=0.1.0-alpha.1",
          runtime: { kind: "native", entry: "index.mjs" },
          provides: ["ai.upstream.openai-chat@1"],
          requires: [],
          permissions: [],
        }),
      );
      await writeFile(
        join(provider, "index.mjs"),
        `export default { setup(host) { host.provide("ai.upstream.openai-chat@1", () => (async function*() { yield {type:"tool",index:0,id:"c1",name:"weather",arguments:"{"}; yield {type:"usage",usage:{input:1,output:1}}; yield {type:"finish",reason:"tool_calls"}; })()); } };`,
      );
      await kernel.add(provider);
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
      source: "test:conversion",
    });
    const response = await f.request(
      "/v1/chat/completions",
      "POST",
      {
        model: "demo",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      },
      admin,
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("Upstream stream failed");
    expect(text).not.toContain("[DONE]");
    const balance = await f.kernel.invoke<any>("billing.balance@1", {
      userId: me.id,
    });
    expect(balance.balance).toBe(1000000);
    expect(balance.held).toBe(2000);
    const requests = await (
      await f.request(
        "/api/plugins/official.observability/requests",
        "GET",
        undefined,
        admin,
      )
    ).json();
    expect(requests.data[0]).toMatchObject({ error_code: "upstream_protocol" });
  } finally {
    await f.close();
  }
});

it("closes a pending HTTP upstream when the client cancels the converted stream", async () => {
  const prior = process.env.PLUHUB_TEST_UPSTREAM_KEY;
  process.env.PLUHUB_TEST_UPSTREAM_KEY = "cancel-test";
  let upstreamClosed = false;
  const server = createServer(async (req, res) => {
    for await (const _ of req) {
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.flushHeaders();
    res.on("close", () => {
      upstreamClosed = true;
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const f = await fixture();
  try {
    const admin = await f.admin();
    f.kernel.configure({
      "official.ai-router": {
        upstreams: {
          test: {
            protocol: "openai-chat",
            baseUrl: "http://127.0.0.1:" + (server.address() as any).port,
            keyRef: "env:PLUHUB_TEST_UPSTREAM_KEY",
          },
        },
        models: { demo: { upstream: "test", model: "test" } },
      },
    });
    const response = await f.request(
      "/v1/chat/completions",
      "POST",
      {
        model: "demo",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      },
      admin,
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    await reader.read();
    const pending = reader.read().catch((error) => ({ error }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(reader.cancel()).resolves.toBeUndefined();
    await pending;
    await expect.poll(() => upstreamClosed, { timeout: 2000 }).toBe(true);
  } finally {
    await f.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (prior === undefined) delete process.env.PLUHUB_TEST_UPSTREAM_KEY;
    else process.env.PLUHUB_TEST_UPSTREAM_KEY = prior;
  }
});
