import { it, expect } from "vitest";
import { createServer } from "node:http";
import { fixture } from "./helpers.js";
const protocols = [
  "openai-chat",
  "openai-responses",
  "anthropic",
  "gemini",
] as const;
function input(protocol: string, tools: boolean, stream: boolean) {
  const tool = {
    name: "weather",
    description: "Weather",
    parameters: { type: "object", properties: { city: { type: "string" } } },
  };
  if (protocol === "openai-chat")
    return {
      model: "demo",
      messages: [{ role: "user", content: "Hello" }],
      stream,
      ...(tools ? { tools: [{ type: "function", function: tool }] } : {}),
    };
  if (protocol === "openai-responses")
    return {
      model: "demo",
      input: "Hello",
      stream,
      ...(tools ? { tools: [{ type: "function", ...tool }] } : {}),
    };
  if (protocol === "anthropic")
    return {
      model: "demo",
      messages: [{ role: "user", content: "Hello" }],
      max_tokens: 100,
      stream,
      ...(tools
        ? { tools: [{ name: "weather", input_schema: tool.parameters }] }
        : {}),
    };
  return {
    contents: [{ role: "user", parts: [{ text: "Hello" }] }],
    ...(tools ? { tools: [{ functionDeclarations: [tool] }] } : {}),
  };
}
const sse = (data: any, event?: string) =>
  (event ? "event: " + event + "\n" : "") +
  "data: " +
  JSON.stringify(data) +
  "\n\n";
function followup(protocol: string, stream: boolean) {
  const body: any = input(protocol, true, stream);
  if (protocol === "openai-chat")
    body.messages.push(
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "weather", arguments: '{"city":"Hefei"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "TOOL_RESULT_OK" },
    );
  else if (protocol === "openai-responses")
    body.input = [
      { role: "user", content: "Hello" },
      {
        type: "function_call",
        call_id: "c1",
        name: "weather",
        arguments: '{"city":"Hefei"}',
      },
      { type: "function_call_output", call_id: "c1", output: "TOOL_RESULT_OK" },
    ];
  else if (protocol === "anthropic")
    body.messages.push(
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "c1",
            name: "weather",
            input: { city: "Hefei" },
          },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "c1", content: "TOOL_RESULT_OK" },
        ],
      },
    );
  else
    body.contents.push(
      {
        role: "model",
        parts: [{ functionCall: { name: "weather", args: { city: "Hefei" } } }],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "weather",
              response: { result: "TOOL_RESULT_OK" },
            },
          },
        ],
      },
    );
  return body;
}
function mock(protocol: string, tools: boolean, stream: boolean) {
  const args = '{"city":"Hefei"}';
  const usage = { input_tokens: 7, output_tokens: 4 };
  if (!stream) {
    if (protocol === "openai-chat")
      return {
        choices: [
          {
            message: {
              content: tools ? null : "Hello",
              ...(tools
                ? {
                    tool_calls: [
                      {
                        id: "c1",
                        type: "function",
                        function: { name: "weather", arguments: args },
                      },
                    ],
                  }
                : {}),
            },
            finish_reason: tools ? "tool_calls" : "stop",
          },
        ],
        usage: { prompt_tokens: 7, completion_tokens: 4 },
      };
    if (protocol === "openai-responses")
      return {
        status: "completed",
        output: tools
          ? [
              {
                type: "function_call",
                call_id: "c1",
                name: "weather",
                arguments: args,
              },
            ]
          : [
              {
                type: "message",
                content: [{ type: "output_text", text: "Hello" }],
              },
            ],
        usage,
      };
    if (protocol === "anthropic")
      return {
        content: tools
          ? [
              {
                type: "tool_use",
                id: "c1",
                name: "weather",
                input: { city: "Hefei" },
              },
            ]
          : [{ type: "text", text: "Hello" }],
        stop_reason: tools ? "tool_use" : "end_turn",
        usage,
      };
    return {
      candidates: [
        {
          content: {
            parts: tools
              ? [{ functionCall: { name: "weather", args: { city: "Hefei" } } }]
              : [{ text: "Hello" }],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 4 },
    };
  }
  if (protocol === "openai-chat")
    return (
      sse({
        choices: [
          {
            index: 0,
            delta: tools
              ? {
                  tool_calls: [
                    {
                      index: 0,
                      id: "c1",
                      function: { name: "weather", arguments: args },
                    },
                  ],
                }
              : { content: "Hello" },
            finish_reason: tools ? "tool_calls" : "stop",
          },
        ],
      }) +
      sse({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 4 } }) +
      "data: [DONE]\n\n"
    );
  if (protocol === "openai-responses")
    return (
      (tools
        ? sse({
            type: "response.output_item.added",
            item: {
              type: "function_call",
              id: "fc1",
              call_id: "c1",
              name: "weather",
              arguments: "",
            },
          }) +
          sse({
            type: "response.function_call_arguments.delta",
            item_id: "fc1",
            delta: args,
          })
        : sse({ type: "response.output_text.delta", delta: "Hello" })) +
      sse({ type: "response.completed", response: { usage } })
    );
  if (protocol === "anthropic")
    return (
      sse({
        type: "message_start",
        message: { usage: { input_tokens: 7, output_tokens: 0 } },
      }) +
      (tools
        ? sse({
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "c1",
              name: "weather",
              input: {},
            },
          }) +
          sse({
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: args },
          })
        : sse({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Hello" },
          })) +
      sse({
        type: "message_delta",
        delta: { stop_reason: tools ? "tool_use" : "end_turn" },
        usage: { output_tokens: 4 },
      }) +
      sse({ type: "message_stop" })
    );
  return sse(mock(protocol, tools, false));
}
it("supports all 4×4 entry/upstream combinations for JSON, SSE, tools, usage and isolated credentials", async () => {
  const prior = process.env.PLUHUB_TEST_UPSTREAM_KEY;
  process.env.PLUHUB_TEST_UPSTREAM_KEY = "only-upstream-secret";
  const seen: any[] = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    seen.push({ headers: req.headers, body, url: req.url });
    const protocol = req.url!.includes("chat/completions")
      ? "openai-chat"
      : req.url!.includes("/responses")
        ? "openai-responses"
        : req.url!.includes("/messages")
          ? "anthropic"
          : "gemini";
    const stream = body.stream || req.url!.includes("streamGenerateContent");
    const isFollowup = JSON.stringify(body).includes("TOOL_RESULT_OK");
    const result = mock(protocol, !!body.tools?.length && !isFollowup, stream);
    res.writeHead(200, {
      "content-type": stream ? "text/event-stream" : "application/json",
    });
    res.end(typeof result === "string" ? result : JSON.stringify(result));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + (server.address() as any).port;
  const f = await fixture();
  try {
    const admin = await f.admin();
    const key = await (
      await f.request(
        "/api/plugins/official.auth/keys",
        "POST",
        { name: "gateway" },
        admin,
      )
    ).json();
    const credential = { authorization: "Bearer " + key.token };
    for (const upstream of protocols) {
      f.kernel.configure({
        "official.ai-router": {
          upstreams: {
            primary: {
              protocol: upstream,
              baseUrl: base,
              keyRef: "env:PLUHUB_TEST_UPSTREAM_KEY",
            },
          },
          models: { demo: { upstream: "primary", model: "real-model" } },
        },
      });
      for (const entry of protocols)
        for (const stream of [false, true])
          for (const tools of [false, true]) {
            const path =
              entry === "openai-chat"
                ? "/v1/chat/completions"
                : entry === "openai-responses"
                  ? "/v1/responses"
                  : entry === "anthropic"
                    ? "/v1/messages"
                    : "/v1beta/models/demo:" +
                      (stream
                        ? "streamGenerateContent?alt=sse"
                        : "generateContent");
            const response = await f.request(
              path,
              "POST",
              input(entry, tools, stream),
              credential,
            );
            const output = await response.text();
            expect(
              response.status,
              entry + " -> " + upstream + ": " + output,
            ).toBe(200);
            expect(output).toContain(tools ? "weather" : "Hello");
            expect(output).toContain(stream ? "data:" : "7");
            if (stream)
              expect(response.headers.get("content-type")).toContain(
                "text/event-stream",
              );
            const actual = seen.at(-1);
            expect(JSON.stringify(actual.headers)).not.toContain(key.token);
            expect(JSON.stringify(actual.headers)).toContain(
              "only-upstream-secret",
            );
            if (entry === "gemini") expect(actual.url).not.toContain(key.token);
            if (tools) {
              const second = await f.request(
                path,
                "POST",
                followup(entry, stream),
                credential,
              );
              expect(second.status).toBe(200);
              expect(await second.text()).toContain("Hello");
              const sent = seen.at(-1).body;
              expect(JSON.stringify(sent)).toContain("TOOL_RESULT_OK");
              if (upstream === "openai-chat") {
                const call = sent.messages.find(
                  (m: any) => m.tool_calls?.length,
                ).tool_calls[0];
                expect(
                  sent.messages.find((m: any) => m.role === "tool")
                    .tool_call_id,
                ).toBe(call.id);
              } else if (upstream === "openai-responses") {
                expect(
                  sent.input.find((m: any) => m.type === "function_call_output")
                    .call_id,
                ).toBe(
                  sent.input.find((m: any) => m.type === "function_call")
                    .call_id,
                );
              } else if (upstream === "anthropic") {
                expect(
                  sent.messages
                    .flatMap((m: any) => m.content)
                    .find((b: any) => b.type === "tool_result").tool_use_id,
                ).toBe(
                  sent.messages
                    .flatMap((m: any) => m.content)
                    .find((b: any) => b.type === "tool_use").id,
                );
              } else {
                expect(
                  sent.contents
                    .flatMap((m: any) => m.parts)
                    .find((p: any) => p.functionResponse).functionResponse.name,
                ).toBe("weather");
              }
            }
          }
    }
    expect(seen).toHaveLength(96);
    const unsupported = await f.request(
      "/v1/responses",
      "POST",
      { model: "demo", input: "hi", background: true },
      credential,
    );
    expect(unsupported.status).toBe(400);
    expect(await unsupported.text()).toContain("unsupported_feature");
    expect(seen).toHaveLength(96);
    const unauth = await f.request("/v1/messages", "POST", {
      model: "demo",
      messages: [],
    });
    expect(unauth.status).toBe(401);
    expect(await unauth.json()).toMatchObject({ type: "error" });
  } finally {
    await f.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (prior === undefined) delete process.env.PLUHUB_TEST_UPSTREAM_KEY;
    else process.env.PLUHUB_TEST_UPSTREAM_KEY = prior;
  }
});
