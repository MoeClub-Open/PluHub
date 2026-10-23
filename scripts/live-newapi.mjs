// Opt-in bounded integration: credentials are read only from this process environment.
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createKernel } from "../packages/control/dist/index.js";
const key = process.env.PLUHUB_LIVE_KEY;
if (!key) throw new Error("Set PLUHUB_LIVE_KEY for an authorized test");
const base = new URL(
  process.env.PLUHUB_LIVE_URL ?? "https://newapi.telecom.moe",
);
const report = {
  at: new Date().toISOString(),
  origin: base.origin,
  budget: { modelQueries: 1, inferenceCalls: 2, maxOutputTokensPerCall: 16 },
  checks: [],
};
if (process.env.PLUHUB_LIVE_CALLS === "1") report.budget.inferenceCalls = 1;
const directory = await mkdtemp(join(tmpdir(), "pluhub-live-"));
let kernel;
try {
  const response = await fetch(new URL("/v1/models", base), {
    headers: { authorization: "Bearer " + key },
    signal: AbortSignal.timeout(20000),
  });
  report.checks.push({ operation: "model-list", status: response.status });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Model query failed");
  }
  const data = await response.json();
  const ids = (data.data ?? []).map((m) => m.id);
  report.modelCount = ids.length;
  report.availableModels = ids;
  const selected =
    process.env.PLUHUB_LIVE_MODEL ??
    [
      "gpt-4o-mini",
      "gpt-4.1-mini",
      "gpt-4.1-nano",
      "gemini-2.0-flash",
      "gpt-4o",
    ].find((m) => ids.includes(m)) ??
    ids.find(
      (m) =>
        /mini|nano|flash|haiku/i.test(m) &&
        !/thinking|reasoning|image/i.test(m),
    );
  if (!selected || !ids.includes(selected))
    throw new Error(
      "No explicitly budgeted model available; set PLUHUB_LIVE_MODEL",
    );
  report.model = selected;
  report.modelCount = ids.length;
  const names = [
    "http-transport",
    "users",
    "auth",
    "ai-router",
    "observability",
    "ingress-openai-chat",
    "ingress-openai-responses",
    "upstream-openai-chat",
  ];
  const plugins = [];
  for (const name of names) {
    const path = resolve("../PluHub-Plugins/plugins", name);
    const manifest = JSON.parse(
      await readFile(join(path, "manifest.json"), "utf8"),
    );
    plugins.push({
      path,
      grants: manifest.permissions,
      config:
        name === "ai-router"
          ? {
              upstreams: {
                live: {
                  protocol: "openai-chat",
                  baseUrl: base.href,
                  keyRef: "env:PLUHUB_LIVE_KEY",
                },
              },
              models: { "live/test": { upstream: "live", model: selected } },
            }
          : name === "upstream-openai-chat"
            ? { secretRefs: ["env:PLUHUB_LIVE_KEY"] }
            : {},
    });
  }
  kernel = await createKernel({
    schemaVersion: 1,
    dataDir: join(directory, "data"),
    drainTimeoutMs: 1000,
    plugins,
  });
  await kernel.start();
  await kernel.invoke("auth.bootstrap@1", {
    username: "live-test",
    password: "temporary-in-memory-password-123",
  });
  const login = await kernel.fetch(
    new Request("http://localhost/api/plugins/official.auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "live-test",
        password: "temporary-in-memory-password-123",
      }),
    }),
  );
  const cookie = login.headers.get("set-cookie").split(";")[0];
  await login.json();
  const paths = ["/v1/chat/completions", "/v1/responses"].slice(
    0,
    report.budget.inferenceCalls,
  );
  for (const path of paths) {
    const started = performance.now();
    const body = path.endsWith("responses")
      ? {
          model: "live/test",
          input: "Reply only OK",
          max_output_tokens: 16,
          stream: true,
        }
      : {
          model: "live/test",
          messages: [{ role: "user", content: "Reply only OK" }],
          max_tokens: 16,
        };
    const response = await kernel.fetch(
      new Request("http://localhost" + path, {
        method: "POST",
        signal: AbortSignal.timeout(45000),
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    const text = await response.text();
    const check = {
      operation: path,
      status: response.status,
      latencyMs: Math.round(performance.now() - started),
      bytes: Buffer.byteLength(text),
      requestId: response.headers.get("x-pluhub-request-id"),
    };
    if (response.ok) {
      if (path.endsWith("responses")) {
        check.complete = text.includes("response.completed");
        check.incomplete = text.includes("response.incomplete");
        check.textPresent = text.includes("response.output_text.delta");
      } else {
        const result = JSON.parse(text);
        check.complete = !!result.choices?.[0]?.finish_reason;
        check.finishReason = result.choices?.[0]?.finish_reason;
        check.textPresent = !!result.choices?.[0]?.message?.content;
        check.usage = result.usage;
      }
    } else {
      try {
        check.errorCode = JSON.parse(text).error?.code;
      } catch {
        check.errorCode = "invalid_response";
      }
    }
    report.checks.push(check);
    if (!response.ok) break;
  }
} catch (error) {
  report.failure = error.message.startsWith("No explicitly")
    ? error.message
    : "Integration stopped; inspect check statuses";
  process.exitCode = 1;
} finally {
  await kernel?.shutdown();
  await rm(directory, { recursive: true, force: true });
  await mkdir("output", { recursive: true });
  let runs = [];
  try {
    const prior = JSON.parse(await readFile("output/live-newapi.json", "utf8"));
    runs = prior.runs ?? [prior];
  } catch {}
  runs.push(report);
  await writeFile(
    "output/live-newapi.json",
    JSON.stringify({ runs }, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
}
