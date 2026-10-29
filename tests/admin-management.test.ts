import { it, expect, vi } from "vitest";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  rmdir,
  access,
} from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./helpers.js";
import { otp } from "./security-helpers.js";
const auth = "/api/plugins/official.auth",
  byok = "/api/plugins/official.byok",
  billing = "/api/plugins/official.billing",
  commerce = "/api/plugins/official.commerce";
async function account(
  f: Awaited<ReturnType<typeof fixture>>,
  admin: Record<string, string>,
  username: string,
) {
  const response = await f.request(
    auth + "/users",
    "POST",
    { username, password: "original-user-password", role: "user" },
    admin,
  );
  expect(response.status).toBe(201);
  const user = await response.json();
  const session = await f.request(auth + "/login", "POST", {
    username,
    password: "original-user-password",
  });
  await session.text();
  const cookie = { cookie: session.headers.get("set-cookie")!.split(";")[0]! };
  const key = await (
    await f.request(auth + "/keys", "POST", { name: "client" }, cookie)
  ).json();
  return { ...user, cookie, key };
}

it("limits administrative reads and writes to administrator sessions, requires recent verification and revokes user keys immediately", async () => {
  const f = await fixture();
  try {
    const admin = await f.admin(),
      alice = await account(f, admin, "admin-alice");
    const adminKey = await (
      await f.request(auth + "/keys", "POST", { name: "admin-client" }, admin)
    ).json();
    const protectedReads = [
      auth + "/admin/user?userId=" + alice.id,
      auth + "/admin/keys",
      byok + "/admin/channels",
      billing + "/admin/wallet?userId=" + alice.id,
      billing + "/admin/ledger",
      commerce + "/admin/orders",
      commerce + "/admin/subscriptions",
      commerce + "/admin/outbox",
      "/api/host/audit",
    ];
    for (const path of protectedReads) {
      for (const [headers, status] of [
        [{}, 401],
        [alice.cookie, 403],
        [{ authorization: "Bearer " + adminKey.token }, 403],
      ] as const) {
        const response = await f.request(path, "GET", undefined, headers);
        expect(response.status, path).toBe(status);
        await response.text();
      }
      const ok = await f.request(path, "GET", undefined, admin);
      expect(ok.status, path).toBe(200);
      await ok.text();
    }
    const keys = await (
      await f.request(
        auth + "/admin/keys?userId=" + alice.id,
        "GET",
        undefined,
        admin,
      )
    ).json();
    expect(keys.total).toBe(1);
    expect(keys.items[0]).toMatchObject({
      id: alice.key.id,
      user_id: alice.id,
    });
    expect(JSON.stringify(keys)).not.toContain(alice.key.token);
    expect(keys.items[0]).not.toHaveProperty("hash");
    const body = {
      id: alice.key.id,
      userId: alice.id,
      reason: "Abnormal client rotation",
    };
    for (const headers of [
      alice.cookie,
      { authorization: "Bearer " + adminKey.token },
      { ...admin, origin: "https://other.example" },
    ]) {
      const response = await f.request(
        auth + "/admin/keys/revoke",
        "POST",
        body,
        headers,
      );
      expect(response.status).toBe(403);
      await response.text();
    }
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 360000);
    try {
      const denied = await f.request(
        auth + "/admin/keys/revoke",
        "POST",
        body,
        admin,
      );
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({
        error: { code: "reauth_required" },
      });
      const confirmed = await f.request(
        auth + "/reauth",
        "POST",
        { password: "correct-admin-password" },
        admin,
      );
      expect(confirmed.status).toBe(200);
      await confirmed.text();
      const revoked = await f.request(
        auth + "/admin/keys/revoke",
        "POST",
        body,
        admin,
      );
      expect(revoked.status).toBe(200);
      await revoked.text();
      expect(
        (
          await f.request("/v1/models", "GET", undefined, {
            authorization: "Bearer " + alice.key.token,
          })
        ).status,
      ).toBe(401);
    } finally {
      clock.mockRestore();
    }
  } finally {
    await f.close();
  }
});

it("enforces administrator channel blocks independently of user settings, credentials and restarts", async () => {
  const f = await fixture();
  try {
    const admin = await f.admin(),
      alice = await account(f, admin, "channel-owner");
    const channel = await (
      await f.request(
        byok + "/personal-channels",
        "POST",
        {
          name: "Owned",
          preset: "custom",
          protocol: "openai-chat",
          baseUrl: "https://upstream.example",
          key: "never-return-this-key",
          models: {
            demo: { model: "provider-model", inputPrice: 10, outputPrice: 40 },
          },
        },
        alice.cookie,
      )
    ).json();
    expect(channel.id).toMatch(/^personal:/);
    const binding = await f.request(
      auth + "/keys",
      "PUT",
      {
        id: alice.key.id,
        name: "Admin-bound key",
        channelIds: [channel.id],
      },
      alice.cookie,
    );
    expect(binding.status).toBe(200);
    await binding.text();
    const body = {
      id: channel.id,
      userId: alice.id,
      blocked: true,
      reason: "Operator review",
    };
    expect(
      (
        await f.request(
          byok + "/admin/channels/block",
          "POST",
          body,
          alice.cookie,
        )
      ).status,
    ).toBe(403);
    const blocked = await f.request(
      byok + "/admin/channels/block",
      "POST",
      body,
      admin,
    );
    expect(blocked.status).toBe(200);
    await blocked.text();
    const own = await (
      await f.request(
        byok + "/personal-channels",
        "GET",
        undefined,
        alice.cookie,
      )
    ).json();
    expect(own[0]).toMatchObject({
      blocked: true,
      blockReason: "Operator review",
    });
    const overwrite = await f.request(
      byok + "/personal-channels",
      "PUT",
      { ...own[0], blocked: false, admin_blocked: 0, enabled: true },
      alice.cookie,
    );
    expect(overwrite.status).toBe(200);
    expect(await overwrite.json()).toMatchObject({ blocked: true });
    const invoke = () =>
      f.request(
        "/v1/chat/completions",
        "POST",
        { model: "demo", messages: [{ role: "user", content: "hello" }] },
        { authorization: "Bearer " + alice.key.token },
      );
    const rejected = await invoke();
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toMatchObject({
      error: { code: "channel_blocked" },
    });
    await expect(
      f.kernel.invoke("credentials.resolve@1", {
        id: channel.id,
        userId: alice.id,
      }),
    ).rejects.toMatchObject({ status: 403 });
    await f.kernel.shutdown();
    await f.kernel.start();
    expect((await invoke()).status).toBe(403);
    const listed = await (
      await f.request(
        byok + "/admin/channels?userId=" + alice.id + "&status=blocked",
        "GET",
        undefined,
        admin,
      )
    ).json();
    expect(listed.total).toBe(1);
    expect(JSON.stringify(listed)).not.toContain("never-return-this-key");
    expect(JSON.stringify(listed)).not.toContain("cipher");
    const released = await f.request(
      byok + "/admin/channels/block",
      "POST",
      { ...body, blocked: false, reason: "Review complete" },
      admin,
    );
    expect(released.status).toBe(200);
    await released.text();
    expect(
      await f.kernel.invoke("ai.routing@3", {
        model: "demo",
        channelId: channel.id,
        principalId: alice.id,
        features: ["text"],
        request: {
          model: "demo",
          messages: [{ role: "user", text: "hello" }],
          stream: false,
          tools: [],
        },
      }),
    ).toMatchObject({ model: "provider-model", credentialId: channel.id });
  } finally {
    await f.close();
  }
});

it("exposes safe account facts and supports password, sessions, factors and roles without removing the last administrator", async () => {
  const f = await fixture(["users", "auth", "ai-router"]);
  try {
    const admin = await f.admin(),
      alice = await account(f, admin, "recover-user");
    let details = await (
      await f.request(
        auth + "/admin/user?userId=" + alice.id,
        "GET",
        undefined,
        admin,
      )
    ).json();
    expect(details).toMatchObject({
      passwordSet: true,
      sessions: 1,
      keys: 1,
      totpEnabled: false,
    });
    expect(details).not.toHaveProperty("hash");
    const setup = await (
      await f.request(auth + "/totp/setup", "POST", {}, alice.cookie)
    ).json();
    const confirmed = await f.request(
      auth + "/totp/confirm",
      "POST",
      { challenge: setup.challenge, code: otp(setup.secret) },
      alice.cookie,
    );
    expect(confirmed.status).toBe(200);
    await confirmed.text();
    const wrong = await f.request(
      auth + "/admin/factors/reset",
      "POST",
      { userId: alice.id, reason: "Lost device", confirmUsername: "wrong" },
      admin,
    );
    expect(wrong.status).toBe(400);
    await wrong.text();
    const reset = await f.request(
      auth + "/admin/factors/reset",
      "POST",
      {
        userId: alice.id,
        reason: "Lost device",
        confirmUsername: alice.username,
      },
      admin,
    );
    expect(reset.status).toBe(200);
    await reset.text();
    expect(
      (await f.request(auth + "/me", "GET", undefined, alice.cookie)).status,
    ).toBe(401);
    details = await (
      await f.request(
        auth + "/admin/user?userId=" + alice.id,
        "GET",
        undefined,
        admin,
      )
    ).json();
    expect(details).toMatchObject({ sessions: 0, totpEnabled: false });
    const password = await f.request(
      auth + "/password",
      "POST",
      {
        userId: alice.id,
        password: "replacement-user-password",
        reason: "Verified recovery",
      },
      admin,
    );
    expect(password.status).toBe(200);
    await password.text();
    const login = await f.request(auth + "/login", "POST", {
      username: alice.username,
      password: "replacement-user-password",
    });
    expect(login.status).toBe(200);
    const cookie = { cookie: login.headers.get("set-cookie")!.split(";")[0]! };
    await login.text();
    const revoked = await f.request(
      auth + "/admin/sessions/revoke",
      "POST",
      { userId: alice.id, reason: "Session incident" },
      admin,
    );
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({ removed: 1 });
    expect(
      (await f.request(auth + "/me", "GET", undefined, cookie)).status,
    ).toBe(401);
    const me = await (
      await f.request(auth + "/me", "GET", undefined, admin)
    ).json();
    const last = await f.request(
      "/api/plugins/official.users/users",
      "PATCH",
      { id: me.id, role: "user" },
      admin,
    );
    expect(last.status).toBe(409);
    expect(await last.json()).toMatchObject({ error: { code: "last_admin" } });
    const promoted = await f.request(
      "/api/plugins/official.users/users",
      "PATCH",
      { id: alice.id, role: "admin", reason: "Delegated administrator" },
      admin,
    );
    expect(promoted.status).toBe(200);
    await promoted.text();
    const delegated = await f.request(auth + "/login", "POST", {
      username: alice.username,
      password: "replacement-user-password",
    });
    const newCookie = {
      cookie: delegated.headers.get("set-cookie")!.split(";")[0]!,
    };
    await delegated.text();
    expect(
      (await f.request("/api/host/audit", "GET", undefined, newCookie)).status,
    ).toBe(200);
    const demoted = await f.request(
      "/api/plugins/official.users/users",
      "PATCH",
      { id: alice.id, role: "user" },
      admin,
    );
    expect(demoted.status).toBe(200);
    await demoted.text();
    expect(
      (await f.request("/api/host/audit", "GET", undefined, newCookie)).status,
    ).toBe(403);
  } finally {
    await f.close();
  }
});

it("records successful and failed management actions durably without bodies, credentials or duplicate audit rows", async () => {
  const f = await fixture(["users", "auth", "ai-router"]);
  try {
    const admin = await f.admin(),
      alice = await account(f, admin, "audited-user");
    const bad = await f.request(
      "/api/plugins/official.users/users",
      "PATCH",
      {
        id: alice.id,
        role: "invalid-role",
        password: "never-record-this-secret",
      },
      admin,
    );
    expect(bad.status).toBe(400);
    await bad.text();
    const reset = await f.request(
      auth + "/password",
      "POST",
      {
        userId: alice.id,
        password: "never-record-this-password",
        reason: "Confirmed ownership",
      },
      admin,
    );
    expect(reset.status).toBe(200);
    await reset.text();
    const response = await (
      await f.request(
        "/api/host/audit?userId=" + alice.id,
        "GET",
        undefined,
        admin,
      )
    ).json();
    expect(response.items.some((r: any) => r.status === 400)).toBe(true);
    expect(
      response.items.some(
        (r: any) => r.reason === "Confirmed ownership" && r.status === 200,
      ),
    ).toBe(true);
    expect(new Set(response.items.map((r: any) => r.id)).size).toBe(
      response.items.length,
    );
    for (const secret of [
      "never-record-this-secret",
      "never-record-this-password",
      alice.key.token,
    ])
      expect(JSON.stringify(response)).not.toContain(secret);
    await f.kernel.shutdown();
    await f.kernel.start();
    const restored = await (
      await f.request(
        "/api/host/audit?userId=" + alice.id,
        "GET",
        undefined,
        admin,
      )
    ).json();
    expect(restored).toEqual(response);
  } finally {
    await f.close();
  }
});

it("keeps plugin state consistent on persistence failure, protects management providers and allows retry after failed installation", async () => {
  const f = await fixture();
  let moved = false;
  try {
    const admin = await f.admin();
    const before = await readFile(f.file, "utf8");
    const invalid = await f.request(
      "/api/host/plugin-state",
      "POST",
      { id: "official.playground", enabled: "false" },
      admin,
    );
    expect(invalid.status).toBe(400);
    await invalid.text();
    expect(await readFile(f.file, "utf8")).toBe(before);
    for (const id of [
      "official.auth",
      "official.listener",
      "official.console",
    ]) {
      const protectedResponse = await f.request(
        "/api/host/plugin-state",
        "POST",
        { id, enabled: false },
        admin,
      );
      expect(protectedResponse.status).toBe(409);
      expect(await protectedResponse.json()).toMatchObject({
        error: { code: "protected_plugin" },
      });
    }
    await rename(f.file, f.file + ".saved");
    await mkdir(f.file);
    moved = true;
    const failed = await f.request(
      "/api/host/plugin-state",
      "POST",
      { id: "official.playground", enabled: false },
      admin,
    );
    expect(failed.status).toBe(500);
    await failed.text();
    expect(
      f.kernel.list().find((p) => p.id === "official.playground")!.state,
    ).toBe("Active");
    await rmdir(f.file);
    await rename(f.file + ".saved", f.file);
    moved = false;
    const directory = join(f.directory, "retry-plugin");
    await mkdir(directory);
    await writeFile(
      join(directory, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "example.retry-install",
        version: "1.0.0",
        host: ">=0.1.0-alpha.1",
        runtime: { kind: "native", entry: "index.mjs" },
        provides: [],
        requires: [],
        permissions: ["api.register"],
      }),
    );
    await writeFile(
      join(directory, "index.mjs"),
      "export default {setup(){}};",
    );
    const refused = await f.request(
      "/api/host/install",
      "POST",
      { path: directory, grants: [] },
      admin,
    );
    expect(refused.status).toBe(403);
    await refused.text();
    await expect(
      access(join(f.directory, ".pluhub/plugins/example.retry-install")),
    ).rejects.toThrow();
    const installed = await f.request(
      "/api/host/install",
      "POST",
      { path: directory, grants: ["api.register"] },
      admin,
    );
    expect(installed.status).toBe(201);
    await installed.text();
    const persisted = JSON.parse(await readFile(f.file, "utf8"));
    expect(
      persisted.plugins.some((p: any) =>
        p.path.endsWith("example.retry-install"),
      ),
    ).toBe(true);
  } finally {
    if (moved) {
      await rmdir(f.file);
      await rename(f.file + ".saved", f.file);
    }
    await f.close();
  }
});

it("queries all financial facts, retries verified credits once and serializes owner/admin subscription cancellation", async () => {
  process.env.PLUHUB_ADMIN_STRIPE_KEY = "mock-stripe-key";
  let cancels = 0;
  (globalThis as any).__pluhubAdminTransport = async (input: any) => {
    if (input.url.endsWith("/customers"))
      return Response.json({ id: "cus_admin_test" });
    if (input.url.endsWith("/checkout/sessions"))
      return Response.json({ url: "https://checkout.stripe.com/mock" });
    if (input.url.endsWith("/subscriptions/sub_admin")) {
      cancels++;
      await new Promise((resolve) => setTimeout(resolve, 40));
      return Response.json({ id: "sub_admin", cancel_at_period_end: true });
    }
    throw new Error("Unexpected mock transport call");
  };
  const product = {
    id: "monthly",
    name: "Monthly",
    paymentMinor: 500,
    currency: "usd",
    creditMicros: 1000000,
    mode: "subscription",
    interval: "month",
  };
  const f = await fixture(
    ["users", "auth", "billing", "commerce", "payments-stripe"],
    {
      commerce: { publicUrl: "http://localhost", products: [product] },
      "payments-stripe": {
        enabled: true,
        keyRef: "env:PLUHUB_ADMIN_STRIPE_KEY",
        webhookSecretRef: "env:PLUHUB_ADMIN_STRIPE_KEY",
        secretRefs: ["env:PLUHUB_ADMIN_STRIPE_KEY"],
        livemode: false,
      },
    },
    async (kernel, directory) => {
      const path = join(directory, "mock-transport");
      await mkdir(path);
      await writeFile(
        join(path, "manifest.json"),
        JSON.stringify({
          schemaVersion: 1,
          id: "test.admin-transport",
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
        'export default {setup(h){h.provide("http.transport@1",i=>globalThis.__pluhubAdminTransport(i))}};',
      );
      await kernel.add(path, { grants: [] });
    },
  );
  try {
    const admin = await f.admin(),
      alice = await account(f, admin, "paying-user");
    const checkout = await (
      await f.request(
        commerce + "/checkout",
        "POST",
        { productId: "monthly", provider: "stripe" },
        alice.cookie,
      )
    ).json();
    expect(checkout.id).toBeTruthy();
    await f.kernel.invoke("billing.credit@1", {
      userId: alice.id,
      amount: Number.MAX_SAFE_INTEGER,
      source: "overflow-test",
    });
    await expect(
      f.kernel.invoke("commerce.payment@1", {
        provider: "stripe",
        eventId: "event-admin",
        orderId: checkout.id,
        paymentId: "payment-admin",
        amount: 500,
        currency: "usd",
        kind: "paid",
        subscriptionId: "sub_admin",
        periodEnd: Date.now() + 86400000,
      }),
    ).rejects.toThrow();
    const pending = await (
      await f.request(
        commerce + "/admin/outbox?status=pending&userId=" + alice.id,
        "GET",
        undefined,
        admin,
      )
    ).json();
    expect(pending.total).toBe(1);
    const adjusted = await f.request(
      billing + "/adjust",
      "POST",
      {
        userId: alice.id,
        amount: -Number.MAX_SAFE_INTEGER,
        id: "release-test-balance",
        reason: "Local overflow recovery",
      },
      admin,
    );
    expect(adjusted.status).toBe(200);
    await adjusted.text();
    for (let i = 0; i < 2; i++) {
      const retry = await f.request(
        commerce + "/retry",
        "POST",
        { reason: "Retry verified payment" },
        admin,
      );
      expect(retry.status).toBe(200);
      await retry.text();
    }
    const wallet = await (
      await f.request(
        billing + "/admin/wallet?userId=" + alice.id,
        "GET",
        undefined,
        admin,
      )
    ).json();
    expect(wallet.balance).toBe(1000000);
    const ledger = await (
      await f.request(
        billing + "/admin/ledger?userId=" + alice.id,
        "GET",
        undefined,
        admin,
      )
    ).json();
    expect(ledger.total).toBe(3);
    expect(
      ledger.items.filter(
        (r: any) => r.source === "payment:stripe:payment-admin",
      ),
    ).toHaveLength(1);
    expect(ledger.items.find((r: any) => r.reason)?.reason).toBe(
      "Local overflow recovery",
    );
    const orders = await (
      await f.request(
        commerce + "/admin/orders?userId=" + alice.id,
        "GET",
        undefined,
        admin,
      )
    ).json();
    expect(orders.items[0]).toMatchObject({
      id: checkout.id,
      status: "paid",
      product,
    });
    expect(orders.items[0]).not.toHaveProperty("checkout_url");
    const results = await Promise.all([
      f.request(
        commerce + "/cancel",
        "POST",
        { id: "sub_admin" },
        alice.cookie,
      ),
      f.request(
        commerce + "/admin/subscriptions/cancel",
        "POST",
        { id: "sub_admin", userId: alice.id, reason: "Customer cancellation" },
        admin,
      ),
    ]);
    for (const result of results) {
      expect(result.status).toBe(200);
      await result.text();
    }
    expect(cancels).toBe(1);
    const subs = await (
      await f.request(
        commerce + "/admin/subscriptions?status=cancel_at_period_end",
        "GET",
        undefined,
        admin,
      )
    ).json();
    expect(subs.total).toBe(1);
    const unknown = await f.request(
      billing + "/adjust",
      "POST",
      {
        userId: "nonexistent",
        amount: 1,
        id: "bad-user",
        reason: "Should refuse",
      },
      admin,
    );
    expect(unknown.status).toBe(404);
    await unknown.text();
  } finally {
    await f.close();
    delete (globalThis as any).__pluhubAdminTransport;
  }
});
