// Exercise the deployed management plane without sending mail, charging or generating text.
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
const base = new URL(process.env.PLUHUB_DEPLOY_URL ?? "http://127.0.0.1:18100");
const origin = process.env.PLUHUB_EXPECTED_ORIGIN ?? base.origin;
const password = (
  await readFile(process.env.PLUHUB_ADMIN_PASSWORD_FILE, "utf8")
).trim();
const auth = "/api/plugins/official.auth";
const report = {
  at: new Date().toISOString(),
  origin,
  checks: [],
  passed: false,
};
let cookie;
let key;
async function request(path, status = 200, init = {}) {
  const response = await fetch(new URL(path, base), {
    ...init,
    headers: {
      origin,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, status, path + " returned " + response.status);
  return response;
}
try {
  await (await request("/healthz")).json();
  await (await request("/readyz")).json();
  await (await request("/api/host/config", 401)).json();
  await (await request("/v1/models", 401)).json();
  report.checks.push("health-and-anonymous-denial");
  const html = await request("/");
  assert.ok(html.headers.get("content-security-policy"));
  assert.ok((await html.text()).includes("pluhub-branding"));
  const publicContent = await (await request("/console/public")).json();
  assert.deepEqual(Object.keys(publicContent).sort(), ["branding", "portal"]);
  assert.ok(!Object.hasOwn(publicContent, "onboarding"));
  report.checks.push("public-portal-contract");
  const login = await request(auth + "/login", 200, {
    method: "POST",
    body: JSON.stringify({
      username: process.env.PLUHUB_ADMIN_USERNAME ?? "admin",
      password,
    }),
  });
  const setCookie = login.headers.get("set-cookie");
  assert.ok(
    setCookie?.includes("HttpOnly") && setCookie.includes("SameSite=Strict"),
  );
  if (origin.startsWith("https:")) assert.ok(setCookie.includes("Secure"));
  cookie = setCookie.split(";")[0];
  await login.json();
  const me = await (
    await request(auth + "/me", 200, { headers: { cookie } })
  ).json();
  assert.equal(me.role, "admin");
  report.checks.push("console-and-admin-login");
  const plugins = await (
    await request("/api/host/plugins", 200, { headers: { cookie } })
  ).json();
  assert.ok(
    plugins.length >= 32 &&
      plugins.every((plugin) => plugin.state === "Active"),
  );
  const extensions = await (
    await request("/api/host/extensions", 200, { headers: { cookie } })
  ).json();
  assert.equal(
    extensions.filter((extension) => extension.group === "payment-adapters")
      .length,
    2,
  );
  const consoleAsset = await request("/extensions/official.console/ui.js");
  const consoleCode = await consoleAsset.text();
  assert.ok(
    consoleCode.includes("payment-adapters") &&
      consoleCode.includes("/setup") &&
      consoleCode.includes("/settings/portal"),
  );
  report.checks.push("plugins-and-current-ui");
  const config = await (
    await request("/api/host/config", 200, { headers: { cookie } })
  ).json();
  const entry = (name) =>
    config.plugins.find((plugin) => plugin.path.endsWith("/" + name))?.config;
  assert.equal(entry("listener").publicOrigin, origin);
  assert.equal(entry("auth").secureCookie, origin.startsWith("https:"));
  assert.ok(!entry("auth").registrationEnabled);
  assert.ok(
    !entry("payments-stripe").enabled && !entry("payments-epay").enabled,
  );
  report.checks.push("origin-and-closed-registration-payments");
  key = await (
    await request(auth + "/keys", 201, {
      method: "POST",
      headers: { cookie },
      body: JSON.stringify({ name: "deployment-check-" + Date.now() }),
    })
  ).json();
  await (
    await request("/v1/models", 200, {
      headers: { authorization: "Bearer " + key.token },
    })
  ).json();
  await (
    await request("/api/host/config", 403, {
      headers: { authorization: "Bearer " + key.token },
    })
  ).json();
  await (
    await request(auth + "/keys", 403, {
      method: "POST",
      headers: { cookie, origin: "https://untrusted.example" },
      body: '{"name":"denied"}',
    })
  ).json();
  await (
    await request(auth + "/keys?id=" + encodeURIComponent(key.id), 200, {
      method: "DELETE",
      headers: { cookie },
    })
  ).json();
  await (
    await request("/v1/models", 401, {
      headers: { authorization: "Bearer " + key.token },
    })
  ).json();
  key = undefined;
  report.checks.push("key-scope-csrf-and-revocation");
  report.passed = true;
} catch (error) {
  report.failure = String(error.message)
    .replaceAll(password, "[redacted]")
    .slice(0, 1000);
  process.exitCode = 1;
} finally {
  try {
    if (key)
      await (
        await request(auth + "/keys?id=" + encodeURIComponent(key.id), 200, {
          method: "DELETE",
          headers: { cookie },
        })
      ).json();
    if (cookie)
      await (
        await request(auth + "/logout", 200, {
          method: "POST",
          headers: { cookie },
        })
      ).json();
  } catch {
    report.cleanupFailed = true;
    report.passed = false;
    process.exitCode = 1;
  }
  await mkdir("output", { recursive: true });
  await writeFile(
    "output/deployed-smoke.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
}
