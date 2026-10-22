import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { verifyBackupBundle } from "./verify-backup-bundle.mjs";
const docker = process.env.PLUHUB_DOCKER ?? "docker";
const image = process.env.PLUHUB_DOCKER_IMAGE ?? "pluhub:local";
const name = "pluhub-verify-" + Date.now();
const volume = name + "-data";
const restoredVolume = name + "-restored-data";
const restoredName = name + "-restored";
const password = randomBytes(24).toString("base64url");
const report = {
  at: new Date().toISOString(),
  image,
  checks: [],
  passed: false,
};
const run = (args, env = process.env) =>
  execFileSync(docker, args, {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 90000,
  }).trim();
const security = [
  "--read-only",
  "--cap-drop=ALL",
  "--security-opt=no-new-privileges",
  "--tmpfs=/tmp:rw,noexec,nosuid,size=64m,uid=1000,gid=1000",
];
let address;
async function ready() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(address + "/readyz", {
        signal: AbortSignal.timeout(2000),
      });
      const ok = r.ok;
      await r.body?.cancel();
      if (ok) return;
    } catch {}
    await delay(250);
  }
  throw new Error("Container did not become ready");
}
async function request(path, options = {}) {
  const r = await fetch(address + path, {
    ...options,
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(r.ok, true, "Unexpected status " + r.status + " for " + path);
  return r;
}
try {
  report.imageId = run(["image", "inspect", "--format", "{{.Id}}", image]);
  run(["volume", "create", volume]);
  run([
    "run",
    "-d",
    "--name",
    name,
    ...security,
    "--mount",
    "type=volume,source=" + volume + ",target=/data",
    "-p",
    "127.0.0.1::8080",
    image,
  ]);
  const port = Number(run(["port", name, "8080/tcp"]).split(":").at(-1));
  address = "http://127.0.0.1:" + port;
  await ready();
  await (await request("/healthz")).body?.cancel();
  report.checks.push("health-and-readiness");
  const setupHeaders = {
    origin: address,
    "content-type": "application/json",
    "x-pluhub-setup": "1",
  };
  const initial = await (await request("/api/host/setup")).json();
  assert.equal(initial.required, true);
  assert.equal(initial.stage, "site");
  const early = await fetch(address + "/api/host/setup", {
    method: "POST",
    headers: setupHeaders,
    body: JSON.stringify({
      action: "admin",
      revision: initial.revision,
      username: "admin",
      password,
    }),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(early.status, 409);
  await early.body?.cancel();
  const saved = await (
    await request("/api/host/setup", {
      method: "POST",
      headers: setupHeaders,
      body: JSON.stringify({
        action: "site",
        revision: initial.revision,
        step: 2,
        branding: { name: "Container verification" },
        portal: { enabled: false },
      }),
    })
  ).json();
  assert.equal(saved.stage, "admin");
  await (
    await request("/api/host/setup", {
      method: "POST",
      headers: setupHeaders,
      body: JSON.stringify({
        action: "admin",
        revision: saved.revision,
        username: "admin",
        password,
      }),
    })
  ).body?.cancel();
  assert.deepEqual(await (await request("/api/host/setup")).json(), {
    required: false,
    stage: "complete",
  });
  report.checks.push("site-initialization-before-first-administrator");
  const login = await request("/api/plugins/official.auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password }),
  });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  await login.body?.cancel();
  const system = await (
    await request("/api/host/status", { headers: { cookie } })
  ).json();
  assert.equal(system.runtime.name, "Bun");
  assert.equal(system.runtime.version, "1.4.3");
  const installed = await (
    await request("/api/host/plugins", { headers: { cookie } })
  ).json();
  assert.equal(installed.filter((p) => p.state === "Active").length, 17);
  for (const id of [
    "billing",
    "commerce",
    "payments-stripe",
    "payments-epay",
    "byok",
    "leaderboard",
    "tickets",
    "mailer",
    "turnstile",
    "auto-router",
    "rate-limit",
    "token-speed",
    "upstream-codex",
    "upstream-claude-subscription",
    "upstream-antigravity",
  ])
    assert.notEqual(
      installed.find((p) => p.id === "official." + id)?.state,
      "Active",
    );
  report.defaultActivePlugins = 17;
  const key = await (
    await request("/api/plugins/official.auth/keys", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ name: "container-persistence" }),
    })
  ).json();
  assert.ok(key.token);
  report.checks.push("session-and-key");
  report.checks.push(
    ...(await verifyBackupBundle({
      docker,
      image,
      container: name,
      dataVolume: volume,
      cookie,
      apiKey: key.token,
    })),
  );
  address =
    "http://127.0.0.1:" +
    Number(run(["port", name, "8080/tcp"]).split(":").at(-1));
  await ready();
  let lockRefused = false;
  try {
    run([
      "run",
      "--rm",
      ...security,
      "--mount",
      "type=volume,source=" + volume + ",target=/data",
      image,
      "backup-data",
    ]);
  } catch (error) {
    lockRefused = error.status === 75;
  }
  assert.ok(
    lockRefused,
    "A second writer must not open the active data volume",
  );
  report.checks.push("shared-volume-exclusive-lock");
  const asset = await request("/extensions/official.ai-router/ui.js");
  assert.ok((await asset.text()).includes("mount"));
  assert.equal(run(["inspect", "--format", "{{.Config.User}}", name]), "bun");
  assert.equal(
    run(["exec", name, "bun", "-p", "process.versions.bun"]),
    "1.4.3",
  );
  assert.equal(
    run(["exec", name, "node", "-p", "process.versions.bun"]),
    "1.4.3",
  );
  report.runtime = { name: "Bun", version: "1.4.3" };
  assert.equal(
    run(["inspect", "--format", "{{.HostConfig.ReadonlyRootfs}}", name]),
    "true",
  );
  report.checks.push("frontend-nonroot-and-readonly");
  run(["restart", "--time", "40", name]);
  address =
    "http://127.0.0.1:" +
    Number(run(["port", name, "8080/tcp"]).split(":").at(-1));
  await ready();
  const models = await request("/v1/models", {
    headers: { authorization: "Bearer " + key.token },
  });
  await models.body?.cancel();
  const me = await (
    await request("/api/plugins/official.auth/me", { headers: { cookie } })
  ).json();
  assert.equal(me.username, "admin");
  report.checks.push("restart-preserves-session-and-key");
  run(["kill", "--signal", "KILL", name]);
  run(["start", name]);
  address =
    "http://127.0.0.1:" +
    Number(run(["port", name, "8080/tcp"]).split(":").at(-1));
  await ready();
  const recovered = await request("/v1/models", {
    headers: { authorization: "Bearer " + key.token },
  });
  await recovered.body?.cancel();
  report.checks.push("crash-recovery");
  run(["stop", "--time", "40", name]);
  assert.equal(run(["inspect", "--format", "{{.State.ExitCode}}", name]), "0");
  report.checks.push("graceful-stop");
  const backup = execFileSync(
    docker,
    [
      "run",
      "--rm",
      ...security,
      "--mount",
      "type=volume,source=" + volume + ",target=/data",
      image,
      "backup-data",
    ],
    {
      timeout: 30000,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const files = execFileSync(
    docker,
    ["run", "--rm", "-i", "--entrypoint", "tar", image, "-tzf", "-"],
    { input: backup, encoding: "utf8", timeout: 30000 },
  );
  assert.ok(files.includes("pluhub.json") && files.includes("security.key"));
  assert.ok(
    !files.includes("pluhub.json.pid") && !files.includes("pluhub.json.lock"),
  );
  run(["volume", "create", restoredVolume]);
  execFileSync(
    docker,
    [
      "run",
      "--rm",
      "-i",
      "--user",
      "0",
      "--entrypoint",
      "tar",
      "--mount",
      "type=volume,source=" + restoredVolume + ",target=/data",
      image,
      "-xzf",
      "-",
      "-C",
      "/data",
    ],
    { input: backup, timeout: 30000, stdio: ["pipe", "pipe", "pipe"] },
  );
  run([
    "run",
    "-d",
    "--name",
    restoredName,
    ...security,
    "--mount",
    "type=volume,source=" + restoredVolume + ",target=/data",
    "-p",
    "127.0.0.1::8080",
    image,
  ]);
  address =
    "http://127.0.0.1:" +
    Number(run(["port", restoredName, "8080/tcp"]).split(":").at(-1));
  await ready();
  const restoredMe = await (
    await request("/api/plugins/official.auth/me", { headers: { cookie } })
  ).json();
  assert.equal(restoredMe.username, "admin");
  await (
    await request("/v1/models", {
      headers: { authorization: "Bearer " + key.token },
    })
  ).body?.cancel();
  report.checks.push("offline-backup-and-independent-restore");
  run(["stop", "--time", "40", restoredName]);
  const verifiedData = JSON.parse(
    run([
      "run",
      "--rm",
      ...security,
      "--mount",
      "type=volume,source=" + restoredVolume + ",target=/data",
      image,
      "verify-data",
    ]),
  );
  assert.equal(verifiedData.passed, true);
  assert.ok(
    verifiedData.databases.some((row) => row.path.endsWith("auth.sqlite")),
  );
  report.checks.push("restored-sqlite-integrity-and-private-permissions");
  run([
    "run",
    "--rm",
    ...security,
    "--mount",
    "type=volume,source=" + restoredVolume + ",target=/data",
    image,
    "set-public-origin",
    "https://gateway.example",
  ]);
  const changedConfig = JSON.parse(
    run([
      "run",
      "--rm",
      "--entrypoint",
      "cat",
      "--mount",
      "type=volume,source=" + restoredVolume + ",target=/data,readonly",
      image,
      "/data/pluhub.json",
    ]),
  );
  assert.equal(
    changedConfig.plugins.find((p) => p.path.endsWith("/listener")).config
      .publicOrigin,
    "https://gateway.example",
  );
  assert.equal(
    changedConfig.plugins.find((p) => p.path.endsWith("/auth")).config
      .secureCookie,
    true,
  );
  report.checks.push("offline-proxy-origin-and-secure-cookie");
  report.passed = true;
} catch (error) {
  report.failure = String(error.message ?? "Docker verification failed")
    .replaceAll(password, "[redacted]")
    .slice(0, 1500);
  try {
    const logs = spawnSync(docker, ["logs", "--tail", "15", name], {
      encoding: "utf8",
      timeout: 10000,
    });
    report.containerLog = (logs.stdout + logs.stderr)
      .replaceAll(password, "[redacted]")
      .slice(0, 1500);
  } catch {}
  process.exitCode = 1;
} finally {
  try {
    run(["rm", "-f", restoredName]);
  } catch {}
  try {
    run(["volume", "rm", restoredVolume]);
  } catch {}
  try {
    run(["rm", "-f", name]);
  } catch {}
  try {
    run(["volume", "rm", volume]);
  } catch {}
  await mkdir("output", { recursive: true });
  await writeFile(
    "output/docker-smoke.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
}
