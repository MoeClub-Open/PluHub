// Opt-in: one model-directory query and exactly two bounded inference requests.
import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { resolve, join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { createKernel } from "../packages/control/dist/index.js";
const key = process.env.PLUHUB_LIVE_KEY,
  model = process.env.PLUHUB_LIVE_MODEL;
if (!key || !model)
  throw Error("Set PLUHUB_LIVE_KEY and PLUHUB_LIVE_MODEL explicitly");
const base = new URL(
  process.env.PLUHUB_LIVE_URL ?? "https://newapi.telecom.moe",
);
assert.ok(
  base.protocol === "https:" &&
    !base.username &&
    !base.password &&
    !base.search &&
    !base.hash,
);
const temp = resolve(tmpdir()),
  directory = await mkdtemp(join(temp, "pluhub-live-byo-"));
const report = {
  at: new Date().toISOString(),
  origin: base.origin,
  model,
  budget: { modelQueries: 1, inferenceCalls: 2, maxOutputTokensPerCall: 512 },
  checks: [],
  passed: false,
};
let kernel;
try {
  const plugins = [];
  for (const name of [
    "http-transport",
    "users",
    "auth",
    "billing",
    "ai-router",
    "byok",
    "rate-limit",
    "ingress-openai-chat",
    "upstream-openai-chat",
  ]) {
    const path = resolve("../PluHub-Plugins/plugins", name),
      manifest = JSON.parse(
        await readFile(join(path, "manifest.json"), "utf8"),
      );
    plugins.push({
      path,
      grants: manifest.permissions,
      config: name === "billing" ? { enabled: true } : {},
    });
  }
  kernel = await createKernel({
    schemaVersion: 1,
    dataDir: join(directory, "data"),
    plugins,
    drainTimeoutMs: 2000,
  });
  await kernel.start();
  const password = "ephemeral-byo-validation-password";
  await kernel.invoke("auth.bootstrap@1", { username: "live", password });
  let cookie, token;
  async function call(path, body, extra = {}) {
    return kernel.fetch(
      new Request("http://localhost" + path, {
        method: body ? "POST" : "GET",
        headers: {
          ...(body ? { "content-type": "application/json" } : {}),
          ...(cookie ? { cookie } : {}),
          ...extra,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(60000),
      }),
    );
  }
  const login = await call("/api/plugins/official.auth/login", {
    username: "live",
    password,
  });
  assert.equal(login.status, 200);
  cookie = login.headers.get("set-cookie").split(";")[0];
  await login.json();
  const me = await (await call("/api/plugins/official.auth/me")).json();
  const discovered = await call(
    "/api/plugins/official.byok/personal-channels/discover",
    { protocol: "openai-chat", baseUrl: base.href, key },
  );
  assert.equal(discovered.status, 200);
  const catalog = await discovered.json();
  assert.ok(catalog.models.includes(model));
  report.checks.push({
    operation: "unsaved-model-discovery",
    passed: true,
    models: catalog.models.length,
  });
  const created = await call("/api/plugins/official.byok/personal-channels", {
    name: "Ephemeral BYO",
    protocol: "openai-chat",
    baseUrl: base.href,
    key,
    models: { live: { model, inputPrice: 2, outputPrice: 4 } },
  });
  assert.equal(created.status, 201);
  const channel = await created.json();
  assert.ok(!JSON.stringify(channel).includes(key));
  const issued = await call("/api/plugins/official.auth/keys", {
    name: "Ephemeral bound key",
    channelId: channel.id,
    models: ["live"],
  });
  assert.equal(issued.status, 201);
  token = (await issued.json()).token;
  for (const stream of [false, true]) {
    const response = await call(
      "/v1/chat/completions",
      {
        model: "live",
        messages: [{ role: "user", content: "Reply exactly PLUHUB_BYO_OK." }],
        max_completion_tokens: 512,
        stream,
      },
      { authorization: "Bearer " + token },
    );
    assert.equal(response.status, 200);
    const text = await response.text(),
      frames = stream
        ? text
            .split(/\r?\n/)
            .filter((s) => s.startsWith("data: ") && s !== "data: [DONE]")
            .map((s) => JSON.parse(s.slice(6)))
        : [JSON.parse(text)];
    assert.ok(!frames.some((f) => f.error));
    const answer = frames
      .map((f) =>
        stream
          ? (f.choices?.[0]?.delta?.content ?? "")
          : (f.choices?.[0]?.message?.content ?? ""),
      )
      .join("");
    assert.ok(answer.includes("PLUHUB_BYO_OK"));
    assert.ok(frames.some((f) => f.choices?.[0]?.finish_reason === "stop"));
    assert.ok(
      frames.some((f) => Number.isSafeInteger(f.usage?.completion_tokens)),
    );
    report.checks.push({
      operation: "bound-personal-call",
      stream,
      status: response.status,
      passed: true,
    });
  }
  const wallet = await kernel.invoke("billing.balance@1", { userId: me.id });
  assert.ok(wallet.enabled);
  assert.equal(wallet.balance, 0);
  assert.equal(wallet.held, 0);
  report.checks.push({ operation: "platform-wallet-unchanged", passed: true });
  report.passed = true;
} catch (error) {
  report.error =
    typeof error?.code === "string" ? error.code : "validation_failed";
  process.exitCode = 1;
} finally {
  await kernel?.shutdown();
  assert.equal(dirname(resolve(directory)), temp);
  assert.ok(basename(directory).startsWith("pluhub-live-byo-"));
  await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  await mkdir("output", { recursive: true });
  await writeFile(
    "output/live-byo.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
}
