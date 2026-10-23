import { it, expect } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./helpers.js";
import type { Protocol } from "@pluhub/contracts/ai";
const usage = { input_tokens: 2, output_tokens: 1 };
function encodeResult(protocol: Protocol, _result?: unknown): any {
  if (protocol === "openai-responses")
    return {
      status: "completed",
      output: [
        { type: "message", content: [{ type: "output_text", text: "hello" }] },
      ],
      usage,
    };
  if (protocol === "anthropic")
    return {
      content: [{ type: "text", text: "hello" }],
      stop_reason: "end_turn",
      usage,
    };
  return {
    candidates: [
      { content: { parts: [{ text: "hello" }] }, finishReason: "STOP" },
    ],
    usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 },
  };
}
const result = undefined;
const frame = (data: unknown) => "data: " + JSON.stringify(data) + "\n\n";
function encodeStream(protocol: Protocol): ReadableStream<Uint8Array> {
  const text =
    protocol === "openai-responses"
      ? frame({ type: "response.output_text.delta", delta: "hello" }) +
        frame({ type: "response.completed", response: { usage } })
      : frame({
          type: "message_start",
          message: { usage: { input_tokens: 2 } },
        }) +
        frame({
          type: "content_block_delta",
          delta: { type: "text_delta", text: "hello" },
        }) +
        frame({
          type: "message_delta",
          usage: { output_tokens: 1 },
          delta: { stop_reason: "end_turn" },
        }) +
        frame({ type: "message_stop" });
  return new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });
}
function encodeRequest(protocol: Protocol, request: any): any {
  if (protocol === "openai-chat")
    return {
      model: "demo",
      messages: [{ role: "user", content: "hi" }],
      stream: request.stream,
    };
  if (protocol === "openai-responses")
    return { model: "demo", input: "hi", stream: request.stream };
  if (protocol === "anthropic")
    return {
      model: "demo",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 16,
      stream: request.stream,
    };
  return { contents: [{ role: "user", parts: [{ text: "hi" }] }] };
}
it("runs subscription adapters through the compatible ingress matrix and omits CLI output overrides", async () => {
  const protocols: Protocol[] = [
    "openai-chat",
    "openai-responses",
    "anthropic",
    "gemini",
  ];
  let expected = "codex";
  let calls = 0;
  (globalThis as any).__pluhubSubscriptionTransport = (i: any) => {
    calls++;
    const body = JSON.parse(i.body);
    expect(i.headers.authorization).toBe("Bearer subscription-token");
    const protocol: Protocol =
      expected === "codex"
        ? "openai-responses"
        : expected === "claude-subscription"
          ? "anthropic"
          : "gemini";
    if (expected === "codex") {
      expect(i.headers["chatgpt-account-id"]).toBe("account-1");
      expect(body.store).toBe(false);
    }
    if (expected === "claude-subscription")
      expect(i.headers["anthropic-beta"]).toContain("oauth-");
    if (expected === "antigravity") {
      expect(body).toMatchObject({
        model: "vendor",
        project: "project-1",
        requestType: "agent",
      });
      expect(body.request.model).toBeUndefined();
    }
    const stream =
      expected === "antigravity"
        ? i.url.includes("streamGenerateContent")
        : body.stream;
    if (stream) {
      let bytes: ReadableStream<Uint8Array>;
      if (expected === "antigravity") {
        bytes = new ReadableStream({
          start(c) {
            c.enqueue(
              new TextEncoder().encode(
                "data: " +
                  JSON.stringify({ response: encodeResult("gemini", result) }) +
                  "\n\n",
              ),
            );
            c.close();
          },
        });
      } else bytes = encodeStream(protocol);
      return new Response(bytes, {
        headers: { "content-type": "text/event-stream" },
      });
    }
    return Response.json(
      expected === "antigravity"
        ? { response: encodeResult(protocol, result) }
        : encodeResult(protocol, result),
    );
  };
  process.env.PLUHUB_TEST_UPSTREAM_KEY = "subscription-token";
  const f = await fixture(
    [
      "users",
      "auth",
      "ai-router",
      ...protocols.map((p) => "ingress-" + p),
      "upstream-codex",
      "upstream-claude-subscription",
      "upstream-antigravity",
    ],
    {},
    async (kernel, dir) => {
      const path = join(dir, "transport");
      await mkdir(path);
      await writeFile(
        join(path, "manifest.json"),
        JSON.stringify({
          schemaVersion: 1,
          id: "test.transport",
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
        'export default {setup(host){host.provide("http.transport@1",i=>globalThis.__pluhubSubscriptionTransport(i));}}',
      );
      await kernel.add(path, { grants: [] });
    },
  );
  try {
    const admin = await f.admin();
    for (const kind of ["codex", "claude-subscription", "antigravity"]) {
      expected = kind;
      f.kernel.configure({
        "official.ai-router": {
          upstreams: {
            sub: {
              protocol: kind,
              baseUrl: kind === "codex" ? "https://test/v1" : "https://test",
              keyRef: "env:PLUHUB_TEST_UPSTREAM_KEY",
              authMode: "cli",
              accountId: "account-1",
              projectId: "project-1",
            },
          },
          models: { demo: { upstream: "sub", model: "vendor" } },
        },
      });
      for (const protocol of protocols)
        for (const stream of [false, true]) {
          const request = {
            model: "demo",
            messages: [{ role: "user" as const, text: "hi" }],
            stream,
            tools: [],
          };
          const body = encodeRequest(protocol, request);
          const path =
            protocol === "openai-chat"
              ? "/v1/chat/completions"
              : protocol === "openai-responses"
                ? "/v1/responses"
                : protocol === "anthropic"
                  ? "/v1/messages"
                  : "/v1beta/models/demo:" +
                    (stream ? "streamGenerateContent" : "generateContent");
          const response = await f.request(path, "POST", body, admin);
          expect(response.status, kind + "/" + protocol + "/" + stream).toBe(
            200,
          );
          const text = await response.text();
          expect(text).toContain("hello");
          if (stream)
            expect(response.headers.get("content-type")).toContain(
              "text/event-stream",
            );
        }
    }
    expect(calls).toBe(24);
  } finally {
    await f.close();
    delete process.env.PLUHUB_TEST_UPSTREAM_KEY;
    delete (globalThis as any).__pluhubSubscriptionTransport;
  }
});
