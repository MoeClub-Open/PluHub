// Opt-in paid integration. Never writes credentials, prompts or completions to the report.
import { readFile, mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { createKernel } from "../packages/control/dist/index.js";

const key = process.env.PLUHUB_LIVE_KEY;
if (!key)
  throw new Error("Set PLUHUB_LIVE_KEY for an authorized integration run");
const base = new URL(
  process.env.PLUHUB_LIVE_URL ?? "https://newapi.telecom.moe",
);
if (
  base.protocol !== "https:" ||
  base.username ||
  base.password ||
  base.search ||
  base.hash
)
  throw new Error("Use an HTTPS upstream URL without embedded credentials");
const model = process.env.PLUHUB_LIVE_MODEL;
if (!model) throw new Error("Choose PLUHUB_LIVE_MODEL explicitly");
const calls = Number(process.env.PLUHUB_LIVE_CALLS ?? 16);
const maxTokens = Number(process.env.PLUHUB_LIVE_TOKENS ?? 512);
if (
  !Number.isInteger(calls) ||
  calls < 1 ||
  calls > 16 ||
  !Number.isInteger(maxTokens) ||
  maxTokens < 32 ||
  maxTokens > 1024
)
  throw new Error("Budget: 1..16 calls and 32..1024 output tokens per call");
const report = {
  at: new Date().toISOString(),
  origin: base.origin,
  model,
  budget: {
    modelQueries: 1,
    maximumCalls: calls,
    maxOutputTokensPerCall: maxTokens,
  },
  checks: [],
  calls: 0,
  passed: false,
};
const directory = await mkdtemp(join(tmpdir(), "pluhub-live-matrix-"));
let kernel;
function path(protocol, stream) {
  return protocol === "openai-chat"
    ? "/v1/chat/completions"
    : protocol === "openai-responses"
      ? "/v1/responses"
      : protocol === "anthropic"
        ? "/v1/messages"
        : "/v1beta/models/live:" +
          (stream ? "streamGenerateContent?alt=sse" : "generateContent");
}
function content(protocol, wire, stream) {
  const records = stream
    ? wire
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data: ") && l !== "data: [DONE]")
        .map((l) => JSON.parse(l.slice(6)))
    : [JSON.parse(wire)];
  let text = "",
    finished = false,
    usage = false;
  const tools = new Map();
  for (const r of records) {
    if (r.error || r.type === "error") throw new Error("stream_error");
    if (protocol === "openai-chat") {
      const c = r.choices?.[0];
      text += stream ? (c?.delta?.content ?? "") : (c?.message?.content ?? "");
      finished ||= !!c?.finish_reason && c.finish_reason !== "length";
      usage ||= !!r.usage;
      for (const t of (stream
        ? c?.delta?.tool_calls
        : c?.message?.tool_calls) ?? []) {
        const index = t.index ?? 0,
          old = tools.get(index) ?? { id: "", name: "", arguments: "" };
        old.id ||= t.id ?? "";
        old.name += t.function?.name ?? "";
        old.arguments += t.function?.arguments ?? "";
        tools.set(index, old);
      }
    } else if (protocol === "openai-responses") {
      const final = r.response ?? r;
      if (r.type === "response.output_text.delta") text += r.delta ?? "";
      if (!stream)
        for (const item of r.output ?? [])
          for (const part of item.content ?? []) text += part.text ?? "";
      finished ||= final.status === "completed";
      usage ||= !!final.usage;
    } else if (protocol === "anthropic") {
      if (stream) text += r.delta?.text ?? "";
      else for (const c of r.content ?? []) text += c.text ?? "";
      finished ||=
        r.type === "message_stop" ||
        (!!r.stop_reason && r.stop_reason !== "max_tokens");
      usage ||= !!r.usage || !!r.message?.usage;
    } else {
      const c = r.candidates?.[0];
      for (const part of c?.content?.parts ?? []) text += part.text ?? "";
      finished ||= c?.finishReason === "STOP";
      usage ||= !!r.usageMetadata;
    }
  }
  return { text, finished, usage, tools: [...tools.values()] };
}
try {
  const list = await fetch(
    new URL("v1/models", base.href.endsWith("/") ? base : base.href + "/"),
    {
      headers: { authorization: "Bearer " + key },
      signal: AbortSignal.timeout(20000),
    },
  );
  if (!list.ok) {
    await list.body?.cancel();
    throw new Error("model_list_failed");
  }
  const catalog = await list.json();
  if (!catalog.data?.some((m) => m.id === model))
    throw new Error("model_not_available");
  const names = [
    "http-transport",
    "users",
    "auth",
    "ai-router",
    "protocol-converter",
    ...["openai-chat", "openai-responses", "anthropic", "gemini"].map(
      (p) => "ingress-" + p,
    ),
    "upstream-openai-chat",
    "upstream-openai-responses",
  ];
  const plugins = [];
  for (const name of names) {
    const path = resolve("../PluHub-Plugins/plugins", name),
      manifest = JSON.parse(
        await readFile(join(path, "manifest.json"), "utf8"),
      );
    plugins.push({
      path,
      grants: manifest.permissions,
      config: name.startsWith("upstream-")
        ? { secretRefs: ["env:PLUHUB_LIVE_KEY"] }
        : {},
    });
  }
  kernel = await createKernel({
    schemaVersion: 1,
    dataDir: join(directory, "data"),
    plugins,
    drainTimeoutMs: 2000,
  });
  await kernel.start();
  await kernel.invoke("auth.bootstrap@1", {
    username: "live",
    password: "ephemeral-live-matrix-password",
  });
  const login = await kernel.fetch(
    new Request("http://localhost/api/plugins/official.auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "live",
        password: "ephemeral-live-matrix-password",
      }),
    }),
  );
  if (!login.ok) throw new Error("local_login_failed");
  const cookie = login.headers.get("set-cookie").split(";")[0];
  await login.body?.cancel();
  const selected = await kernel.fetch(
    new Request("http://localhost/api/plugins/official.auth/keys", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "live-matrix", models: ["live"] }),
    }),
  );
  const token = (await selected.json()).token;
  if (!token) throw new Error("local_key_failed");
  function configure(protocol) {
    kernel.configure({
      "official.ai-router": {
        upstreams: {
          live: { protocol, baseUrl: base.href, keyRef: "env:PLUHUB_LIVE_KEY" },
        },
        models: { live: { upstream: "live", model } },
      },
    });
  }
  async function call(entry, upstream, stream, request, purpose) {
    if (report.calls >= calls) return;
    configure(upstream);
    report.calls++;
    const body = await kernel.invoke("ai.converter@1", {
      action: "encode",
      protocol: entry,
      input: { model: "live", tools: [], maxTokens, ...request, stream },
    });
    const started = performance.now();
    const check = {
      entry,
      upstream,
      stream,
      purpose,
      status: 0,
      passed: false,
    };
    report.checks.push(check);
    try {
      const response = await kernel.fetch(
        new Request("http://localhost" + path(entry, stream), {
          method: "POST",
          headers: {
            authorization: "Bearer " + token,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60000),
        }),
      );
      check.status = response.status;
      const wire = await response.text();
      if (!response.ok) {
        try {
          check.errorCode = JSON.parse(wire).error?.code ?? "upstream_error";
        } catch {
          check.errorCode = "invalid_response";
        }
        return;
      }
      const parsed = content(entry, wire, stream);
      check.finished = parsed.finished;
      check.usage = parsed.usage;
      check.textPresent = parsed.text.length > 0;
      check.toolCalls = parsed.tools.length;
      check.passed =
        parsed.finished &&
        parsed.usage &&
        (purpose === "tool-start"
          ? parsed.tools.length > 0
          : parsed.text.includes(
              purpose === "tool-result" ? "SUNNY_42" : "PLUHUB_OK",
            ));
      return parsed;
    } catch {
      check.errorCode = "transport_or_protocol_error";
    } finally {
      check.latencyMs = Math.round(performance.now() - started);
      console.log(JSON.stringify(check));
    }
  }
  const normal = {
    messages: [
      { role: "user", text: "Reply exactly PLUHUB_OK and nothing else." },
    ],
  };
  for (const entry of [
    "openai-chat",
    "openai-responses",
    "anthropic",
    "gemini",
  ])
    for (const stream of [false, true])
      await call(entry, "openai-chat", stream, normal, "text");
  for (const entry of ["openai-chat", "openai-responses"])
    for (const stream of [false, true])
      await call(entry, "openai-responses", stream, normal, "text");
  const tools = [
    {
      name: "get_weather",
      description:
        "Get weather; you must call this before answering the user's weather question.",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  ];
  for (const stream of [false, true]) {
    const messages = [
      {
        role: "user",
        text: "Call get_weather for Paris. Do not answer until you receive the tool result. Then repeat its result code exactly.",
      },
    ];
    const first = await call(
      "openai-chat",
      "openai-chat",
      stream,
      { messages, tools },
      "tool-start",
    );
    if (first?.tools.length) {
      for (const c of first.tools) JSON.parse(c.arguments);
      await call(
        "openai-chat",
        "openai-chat",
        stream,
        {
          messages: [
            ...messages,
            { role: "assistant", text: "", calls: first.tools },
            ...first.tools.map((c) => ({
              role: "tool",
              text: '{"result":"SUNNY_42"}',
              callId: c.id,
              toolName: c.name,
            })),
          ],
          tools,
        },
        "tool-result",
      );
    }
  }
  report.passed =
    report.checks.length > 0 && report.checks.every((c) => c.passed);
} catch {
  report.failure = "Integration stopped; inspect sanitized check results";
} finally {
  await kernel?.shutdown();
  await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  await mkdir("output", { recursive: true });
  await writeFile(
    "output/live-gateway.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      passed: report.passed,
      calls: report.calls,
      report: "output/live-gateway.json",
    }),
  );
  if (!report.passed) process.exitCode = 1;
}
