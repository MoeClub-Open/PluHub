import { it, expect, vi } from "vitest";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fixture } from "./helpers.js";
import { createKernel } from "../packages/control/dist/index.js";
import type {
  SubscriptionLease,
  SubscriptionCredential,
} from "@pluhub/contracts/subscription";
let transport: (
  i: any,
  signal: AbortSignal,
) => Response | Promise<Response> = () => {
  throw new Error("Unexpected network request");
};
const providerApi = (provider: string) =>
  "/api/plugins/official.upstream-" + provider;
const api = providerApi("codex");
function accountDiscovery(input: any) {
  if (input.url === "https://www.googleapis.com/oauth2/v2/userinfo?alt=json")
    return Response.json({ email: "subscription@example.com" });
  if (input.url === "https://api.anthropic.com/api/oauth/profile")
    return Response.json({ account: { email: "subscription@example.com" } });
  if (input.url.endsWith("/v1internal:loadCodeAssist"))
    return Response.json({ cloudaicompanionProject: "test-project" });
}
async function setup(extra: string[] = [], configs: any = {}) {
  let transportPath = "";
  (globalThis as any).__subscriptionAccountsTransport = (
    i: any,
    s: AbortSignal,
  ) => transport(i, s);
  const f = await fixture(
    [
      ...new Set([
        "users",
        "auth",
        ...["codex", "claude-subscription", "antigravity"].map(
          (p) => "upstream-" + p,
        ),
        ...extra,
      ]),
    ],
    Object.fromEntries([
      ...Object.entries(configs).filter(
        ([key]) => key !== "subscription-accounts",
      ),
      ...["codex", "claude-subscription", "antigravity"].map((provider) => [
        "upstream-" + provider,
        {
          ...(configs["subscription-accounts"] ?? {}),
          oauth: {
            ...(configs["subscription-accounts"]?.oauth?.[provider]
              ? { [provider]: configs["subscription-accounts"].oauth[provider] }
              : {}),
          },
        },
      ]),
    ]),
    async (kernel, dir) => {
      const path = join(dir, "transport");
      transportPath = path;
      await mkdir(path);
      await writeFile(
        join(path, "manifest.json"),
        JSON.stringify({
          schemaVersion: 1,
          id: "test.subscription-transport",
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
        'export default {setup(host){host.provide("http.transport@1",(i,s)=>globalThis.__subscriptionAccountsTransport(i,s));}}',
      );
      await kernel.add(path, { grants: [] });
    },
  );
  f.config.plugins.push({ path: transportPath, grants: [] });
  const admin = await f.admin();
  const accountProviders = new Map<string, string>(),
    leaseProviders = new Map<string, string>();
  const list = async () =>
    (
      await Promise.all(
        ["codex", "claude-subscription", "antigravity"].map(async (provider) =>
          (
            await f.request(
              providerApi(provider) + "/accounts",
              "GET",
              undefined,
              admin,
            )
          ).json(),
        ),
      )
    ).flat();
  const create = async (
    provider = "codex",
    authorization: any = {
      access_token: "subscription-secret",
      refresh_token: "refresh-secret",
      expires_at: Date.now() + 3600000,
    },
    extra: any = {},
  ) => {
    const response = await f.request(
      providerApi(provider) + "/accounts",
      "POST",
      { provider, authorization, name: provider, ...extra },
      admin,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const account = await response.json();
    accountProviders.set(account.id, provider);
    return account;
  };
  const acquire = async (
    ids: string[],
    provider = "codex",
    signal?: AbortSignal,
  ) => {
    const lease = await f.kernel.invoke<SubscriptionLease>(
      `ai.subscription.${provider}@1`,
      { action: "acquire", provider, ids },
      signal,
    );
    leaseProviders.set(lease.leaseId, provider);
    return lease;
  };
  const release = (lease: SubscriptionLease) =>
    f.kernel.invoke(
      `ai.subscription.${leaseProviders.get(lease.leaseId) ?? "codex"}@1`,
      { action: "release", leaseId: lease.leaseId },
    );
  const report = (
    lease: SubscriptionLease,
    status: number,
    retryAfter?: string,
  ) =>
    f.kernel.invoke(
      `ai.subscription.${leaseProviders.get(lease.leaseId) ?? "codex"}@1`,
      {
        action: "report",
        leaseId: lease.leaseId,
        version: lease.credential.version,
        status,
        retryAfter,
      },
    );
  const action = (id: string, action: string, extra: any = {}) =>
    f.request(
      providerApi(accountProviders.get(id) ?? "codex") + "/account",
      "POST",
      { id, action, ...extra },
      admin,
    );
  return { ...f, admin, list, create, acquire, release, report, action };
}
it("keeps subscription administration session-only, encrypts tokens and survives a restart", async () => {
  const f = await setup();
  let fresh: any;
  try {
    expect((await f.request(api + "/accounts")).status).toBe(401);
    const a = await f.create();
    expect(JSON.stringify(await f.list())).not.toMatch(
      /subscription-secret|refresh-secret|cipher/,
    );
    const db = await readFile(
      join(f.config.dataDir, "official.upstream-codex/accounts.sqlite"),
    );
    expect(db.includes(Buffer.from("subscription-secret"))).toBe(false);
    const keyResponse = await f.request(
      "/api/plugins/official.auth/keys",
      "POST",
      { name: "admin-api" },
      f.admin,
    );
    expect(keyResponse.status).toBe(201);
    const key = await keyResponse.json();
    expect(
      (
        await f.request(api + "/accounts", "GET", undefined, {
          authorization: "Bearer " + key.token,
        })
      ).status,
    ).toBe(403);
    const l = await f.acquire([a.id]);
    expect(l.credential.secret).toBe("subscription-secret");
    await f.release(l);
    await f.kernel.shutdown();
    fresh = await createKernel(f.config);
    await fresh.start();
    const after = await fresh.invoke("ai.subscription.codex@1", {
      action: "acquire",
      provider: "codex",
      ids: [a.id],
    });
    expect(after.credential.secret).toBe("subscription-secret");
    await fresh.invoke("ai.subscription.codex@1", {
      action: "release",
      leaseId: after.leaseId,
    });
  } finally {
    await fresh?.shutdown();
    await f.close();
  }
});
it.each(["codex", "claude-subscription", "antigravity"])(
  "completes %s authorization with state validation and single-use callbacks",
  async (provider) => {
    const api = providerApi(provider);
    process.env.PLUHUB_SUBSCRIPTION_OAUTH_SECRET = "mock-client-secret";
    const f = await setup([], {
      "subscription-accounts": {
        secretRefs: ["env:PLUHUB_SUBSCRIPTION_OAUTH_SECRET"],
        oauth: {
          antigravity: {
            clientSecretRef: "env:PLUHUB_SUBSCRIPTION_OAUTH_SECRET",
          },
        },
      },
    });
    try {
      const start = await f.request(
        api + "/oauth/start",
        "POST",
        { provider, name: "OAuth account" },
        f.admin,
      );
      expect(start.status).toBe(200);
      const flow = await start.json(),
        url = new URL(flow.url);
      expect(url.searchParams.get("code_challenge_method")).toBe(
        provider === "antigravity" ? null : "S256",
      );
      const callback = new URL(url.searchParams.get("redirect_uri")!);
      callback.searchParams.set("code", "good-code");
      callback.searchParams.set("state", "wrong");
      expect(
        (
          await f.request(
            api + "/oauth/finish",
            "POST",
            { id: flow.id, callback: callback.href },
            f.admin,
          )
        ).status,
      ).toBe(400);
      callback.searchParams.set("state", url.searchParams.get("state")!);
      let calls = 0;
      transport = (i) => {
        const discovery = accountDiscovery(i);
        if (discovery) return discovery;
        calls++;
        expect(i.publicOnly).toBe(true);
        const body =
          provider === "claude-subscription"
            ? JSON.parse(i.body)
            : Object.fromEntries(new URLSearchParams(i.body));
        expect(body).toMatchObject({
          grant_type: "authorization_code",
          code: "good-code",
          redirect_uri: url.searchParams.get("redirect_uri"),
        });
        if (provider === "antigravity") {
          expect(body.code_verifier).toBeUndefined();
          expect(body.client_secret).toBe("mock-client-secret");
        } else {
          expect(
            createHash("sha256").update(body.code_verifier).digest("base64url"),
          ).toBe(url.searchParams.get("code_challenge"));
        }
        return Response.json({
          access_token: "oauth-access",
          refresh_token: "oauth-refresh",
          expires_in: 3600,
        });
      };
      const finished = await f.request(
        api + "/oauth/finish",
        "POST",
        { id: flow.id, callback: callback.href },
        f.admin,
      );
      expect(finished.status, await finished.clone().text()).toBe(200);
      const account = await finished.json();
      expect(JSON.stringify(account)).not.toContain("oauth-access");
      expect(
        (
          await f.request(
            api + "/oauth/finish",
            "POST",
            { id: flow.id, callback: callback.href },
            f.admin,
          )
        ).status,
      ).toBe(409);
      expect(calls).toBe(1);
    } finally {
      await f.close();
      delete process.env.PLUHUB_SUBSCRIPTION_OAUTH_SECRET;
    }
  },
);
it.each(["codex", "claude-subscription", "antigravity"])(
  "receives %s web callbacks without exposing credentials or allowing cross-scope completion",
  async (provider) => {
    const api = providerApi(provider);
    process.env.PLUHUB_SUBSCRIPTION_OAUTH_SECRET = "mock-client-secret";
    const f = await setup([], {
      "subscription-accounts": {
        secretRefs: ["env:PLUHUB_SUBSCRIPTION_OAUTH_SECRET"],
        oauth: {
          [provider]: {
            redirectUri: "http://localhost" + api + "/oauth/callback",
            ...(provider === "antigravity"
              ? { clientSecretRef: "env:PLUHUB_SUBSCRIPTION_OAUTH_SECRET" }
              : {}),
          },
        },
      },
    });
    try {
      let calls = 0;
      transport = (input) => {
        const discovery = accountDiscovery(input);
        if (discovery) return discovery;
        calls++;
        return Response.json({
          access_token: "web-only-secret",
          refresh_token: "web-refresh",
          expires_in: 3600,
        });
      };
      const flow = await (
        await f.request(
          api + "/oauth/start",
          "POST",
          { provider, mode: "browser", name: "Web account" },
          f.admin,
        )
      ).json();
      expect(flow.mode).toBe("callback");
      const callback = new URL("http://localhost" + api + "/oauth/callback");
      callback.searchParams.set(
        "state",
        new URL(flow.url).searchParams.get("state")!,
      );
      callback.searchParams.set("code", "web-code");
      expect(
        (await f.request(api + "/oauth/callback?state=wrong&code=bad")).status,
      ).toBe(400);
      const received = await f.kernel.fetch(new Request(callback));
      expect(received.status).toBe(200);
      expect(received.headers.get("cache-control")).toBe("no-store");
      expect(await received.text()).not.toMatch(
        /web-code|web-only-secret|web-refresh/,
      );
      expect(calls).toBe(0);
      expect(
        (await f.request(api + "/oauth/status", "POST", { id: flow.id }))
          .status,
      ).toBe(401);
      expect(
        (
          await f.request(
            api + "/personal/oauth/status",
            "POST",
            { id: flow.id },
            f.admin,
          )
        ).status,
      ).toBe(409);
      expect((await f.kernel.fetch(new Request(callback))).status).toBe(409);
      const result = await f.request(
        api + "/oauth/status",
        "POST",
        { id: flow.id },
        f.admin,
      );
      expect(result.status).toBe(200);
      const body = await result.json();
      expect(body.status).toBe("complete");
      expect(body.account.provider).toBe(provider);
      expect(JSON.stringify(body)).not.toMatch(/web-only-secret|web-refresh/);
      expect(calls).toBe(1);
      expect(await f.list()).toHaveLength(1);
      expect(
        (
          await f.request(
            api + "/oauth/status",
            "POST",
            { id: flow.id },
            f.admin,
          )
        ).status,
      ).toBe(409);
    } finally {
      await f.close();
      delete process.env.PLUHUB_SUBSCRIPTION_OAUTH_SECRET;
    }
  },
);
it("completes Codex device authorization once, throttles polls and isolates personal ownership", async () => {
  const f = await setup();
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  try {
    const verifier = "device-pkce-verifier",
      challenge = createHash("sha256").update(verifier).digest("base64url");
    let polls = 0,
      exchanges = 0;
    transport = (i) => {
      expect(i.publicOnly).toBe(true);
      if (i.url.endsWith("/usercode"))
        return Response.json({
          device_auth_id: "private-device-id",
          usercode: "ABCD-EFGH",
          interval: "1",
        });
      if (i.url.endsWith("/deviceauth/token")) {
        polls++;
        expect(JSON.parse(i.body)).toEqual({
          device_auth_id: "private-device-id",
          user_code: "ABCD-EFGH",
        });
        return Response.json({
          authorization_code: "device-code",
          code_verifier: verifier,
          code_challenge: challenge,
        });
      }
      exchanges++;
      expect(Object.fromEntries(new URLSearchParams(i.body))).toMatchObject({
        grant_type: "authorization_code",
        code: "device-code",
        code_verifier: verifier,
        redirect_uri: "https://auth.openai.com/deviceauth/callback",
      });
      return Response.json({
        access_token: "device-access",
        refresh_token: "device-refresh",
        expires_in: 3600,
      });
    };
    const flow = await (
      await f.request(
        api + "/personal/oauth/start",
        "POST",
        { provider: "codex", name: "Personal device", mode: "device" },
        f.admin,
      )
    ).json();
    expect(flow).toMatchObject({
      mode: "device",
      url: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
    });
    expect(JSON.stringify(flow)).not.toContain("private-device-id");
    const poll = () =>
      f.request(
        api + "/personal/oauth/status",
        "POST",
        { id: flow.id },
        f.admin,
      );
    expect((await (await poll()).json()).status).toBe("pending");
    expect(polls).toBe(0);
    expect(
      (await f.request(api + "/oauth/status", "POST", { id: flow.id }, f.admin))
        .status,
    ).toBe(409);
    now += 1001;
    const responses = await Promise.all([poll(), poll()]);
    const results = await Promise.all(responses.map((r) => r.json()));
    expect(results.every((r) => r.status === "complete")).toBe(true);
    expect(polls).toBe(1);
    expect(exchanges).toBe(1);
    expect(await f.list()).toHaveLength(0);
    const personal = await (
      await f.request(api + "/personal/accounts", "GET", undefined, f.admin)
    ).json();
    expect(personal).toHaveLength(1);
    expect(JSON.stringify(personal)).not.toMatch(
      /device-access|device-refresh/,
    );
  } finally {
    clock.mockRestore();
    await f.close();
  }
});
it("backs off device polling and expires or cancels authorization without saving an account", async () => {
  const f = await setup();
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  try {
    let polls = 0;
    transport = (i) =>
      i.url.endsWith("/usercode")
        ? Response.json({
            device_auth_id: "private-id",
            user_code: "ABCD",
            interval: 1,
          })
        : (polls++, new Response(null, { status: 429 }));
    const start = async () =>
      (
        await f.request(
          api + "/oauth/start",
          "POST",
          { provider: "codex", mode: "device", name: "Device" },
          f.admin,
        )
      ).json();
    const flow = await start();
    now += 1001;
    const poll = () =>
      f.request(api + "/oauth/status", "POST", { id: flow.id }, f.admin);
    const pending = await (await poll()).json();
    expect(pending.retryAfterMs).toBeGreaterThanOrEqual(6000);
    await poll();
    expect(polls).toBe(1);
    now = flow.expiresAt + 1;
    expect((await poll()).status).toBe(409);
    const cancelled = await start();
    expect(
      (
        await f.request(
          api + "/oauth/cancel",
          "POST",
          { id: cancelled.id },
          f.admin,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await f.request(
          api + "/oauth/status",
          "POST",
          { id: cancelled.id },
          f.admin,
        )
      ).status,
    ).toBe(409);
    expect(await f.list()).toHaveLength(0);
  } finally {
    clock.mockRestore();
    await f.close();
  }
});
it("prevents a cancelled in-flight OAuth exchange from saving credentials", async () => {
  const f = await setup([], {
    "subscription-accounts": {
      oauth: {
        codex: { redirectUri: "http://localhost" + api + "/oauth/callback" },
      },
    },
  });
  try {
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    transport = async () => {
      entered();
      await gate;
      return Response.json({
        access_token: "cancelled-secret",
        expires_in: 3600,
      });
    };
    const flow = await (
      await f.request(
        api + "/oauth/start",
        "POST",
        { provider: "codex", name: "Cancelled" },
        f.admin,
      )
    ).json();
    const url = new URL("http://localhost" + api + "/oauth/callback");
    url.searchParams.set("state", new URL(flow.url).searchParams.get("state")!);
    url.searchParams.set("code", "ok");
    expect((await f.kernel.fetch(new Request(url))).status).toBe(200);
    const polling = f.request(
      api + "/oauth/status",
      "POST",
      { id: flow.id },
      f.admin,
    );
    await started;
    expect(
      (await f.request(api + "/oauth/cancel", "POST", { id: flow.id }, f.admin))
        .status,
    ).toBe(200);
    release();
    expect((await polling).ok).toBe(false);
    expect(await f.list()).toHaveLength(0);
  } finally {
    await f.close();
  }
});
it("keeps provider denial and unsupported device flows out of stored accounts", async () => {
  const f = await setup([], {
    "subscription-accounts": {
      oauth: {
        codex: { redirectUri: "http://localhost" + api + "/oauth/callback" },
      },
    },
  });
  try {
    const providers = await (
      await f.request(
        providerApi("antigravity") + "/oauth/providers",
        "GET",
        undefined,
        f.admin,
      )
    ).json();
    expect(providers.find((p: any) => p.provider === "antigravity").ready).toBe(
      true,
    );
    expect(
      (
        await f.request(
          api + "/oauth/start",
          "POST",
          { provider: "claude-subscription", mode: "device", name: "Bad" },
          f.admin,
        )
      ).status,
    ).toBe(400);
    const flow = await (
      await f.request(
        api + "/oauth/start",
        "POST",
        { provider: "codex", name: "Denied" },
        f.admin,
      )
    ).json();
    const denied = new URL("http://localhost" + api + "/oauth/callback");
    denied.searchParams.set(
      "state",
      new URL(flow.url).searchParams.get("state")!,
    );
    denied.searchParams.set("error", "access_denied");
    expect((await f.kernel.fetch(new Request(denied))).status).toBe(200);
    const result = await f.request(
      api + "/oauth/status",
      "POST",
      { id: flow.id },
      f.admin,
    );
    expect(result.status).toBe(400);
    expect((await result.json()).error.code).toBe("oauth_denied");
    expect(await f.list()).toHaveLength(0);
  } finally {
    await f.close();
  }
});
it("merges concurrent refreshes independently of request cancellation and persists rotated refresh tokens", async () => {
  const f = await setup();
  try {
    const a = await f.create(
      "codex",
      {
        access_token: "expired",
        refresh_token: "refresh-one",
        expires_at: Date.now() - 1000,
      },
      { maxConcurrency: 10 },
    );
    let finish!: () => void, started!: () => void;
    const ready = new Promise<void>((r) => {
        started = r;
      }),
      gate = new Promise<void>((r) => {
        finish = r;
      });
    let calls = 0;
    transport = async (i) => {
      calls++;
      expect(new URLSearchParams(i.body).get("refresh_token")).toBe(
        "refresh-one",
      );
      started();
      await gate;
      return Response.json({
        access_token: "renewed",
        refresh_token: "refresh-two",
        expires_in: 3600,
      });
    };
    const controller = new AbortController();
    const first = f.acquire([a.id], "codex", controller.signal),
      cancelled = expect(first).rejects.toThrow();
    await ready;
    const second = f.acquire([a.id]);
    controller.abort(new Error("client cancelled"));
    await cancelled;
    finish();
    const lease = await second;
    expect(lease.credential.secret).toBe("renewed");
    expect(calls).toBe(1);
    expect((await f.list())[0].active).toBe(1);
    transport = (i) => {
      expect(new URLSearchParams(i.body).get("refresh_token")).toBe(
        "refresh-two",
      );
      return Response.json({ access_token: "renewed-again", expires_in: 3600 });
    };
    const rotated = await f.kernel.invoke<SubscriptionCredential>(
      "ai.subscription.codex@1",
      {
        action: "refresh",
        leaseId: lease.leaseId,
        version: lease.credential.version,
      },
    );
    expect(rotated.secret).toBe("renewed-again");
    await f.release(lease);
    expect((await f.list())[0].active).toBe(0);
  } finally {
    await f.close();
  }
});
it("preserves re-imports over stale refreshes and never recreates deleted accounts", async () => {
  const f = await setup();
  try {
    const a = await f.create("codex", { refresh_token: "old-refresh" });
    let finish!: () => void, started!: () => void;
    let ready = new Promise<void>((r) => {
      started = r;
    });
    let gate = new Promise<void>((r) => {
      finish = r;
    });
    transport = async () => {
      started();
      await gate;
      return Response.json({ access_token: "stale", expires_in: 3600 });
    };
    const work = f.acquire([a.id]);
    await ready;
    await f.create(
      "codex",
      {
        access_token: "new-import",
        refresh_token: "new-refresh",
        expires_at: Date.now() + 3600000,
      },
      { id: a.id },
    );
    finish();
    const lease = await work;
    expect(lease.credential.secret).toBe("new-import");
    await f.release(lease);
    const b = await f.create("codex", { refresh_token: "r" });
    ready = new Promise<void>((r) => {
      started = r;
    });
    gate = new Promise<void>((r) => {
      finish = r;
    });
    const gone = f.acquire([b.id]),
      rejected = expect(gone).rejects.toMatchObject({
        code: "subscription_not_found",
      });
    await ready;
    await f.action(b.id, "delete");
    finish();
    await rejected;
    expect((await f.list()).length).toBe(1);
  } finally {
    await f.close();
  }
});
it("enforces pool bindings, concurrency, cooldown, disabled and invalid-grant states", async () => {
  const f = await setup();
  try {
    const a = await f.create("codex", undefined, { maxConcurrency: 1 }),
      b = await f.create();
    const l = await f.acquire([a.id]);
    await expect(f.acquire([a.id])).rejects.toMatchObject({
      code: "subscription_unavailable",
    });
    const other = await f.acquire([a.id, b.id]);
    expect(other.accountId).toBe(b.id);
    await f.report(l, 429, "90");
    await f.report(l, 200);
    await f.release(l);
    await f.release(l);
    const state = (await f.list()).find((r: any) => r.id === a.id);
    expect(state.status).toBe("cooldown");
    expect(state.cooldownUntil).toBeGreaterThan(Date.now() + 80000);
    await f.release(other);
    await f.action(a.id, "resume");
    const retry = await f.acquire([a.id]);
    await f.report(retry, 403);
    await f.release(retry);
    expect((await f.list()).find((r: any) => r.id === a.id).status).toBe(
      "forbidden",
    );
    await f.action(a.id, "update", { enabled: false });
    await expect(f.acquire([a.id])).rejects.toMatchObject({
      code: "subscription_unavailable",
    });
    await expect(f.acquire([b.id], "antigravity")).rejects.toMatchObject({
      code: "subscription_not_found",
    });
    await expect(f.acquire([])).rejects.toMatchObject({
      code: "subscription_binding",
    });
    const expired = await f.create("codex", {
      access_token: "expired",
      refresh_token: "invalid",
      expires_at: Date.now() - 1000,
    });
    transport = () =>
      Response.json(
        { error: "invalid_grant", details: "sensitive-provider-data" },
        { status: 400 },
      );
    await expect(f.acquire([expired.id])).rejects.toMatchObject({
      code: "subscription_reauthorize",
      status: 503,
    });
    expect(
      (await f.list()).find((r: any) => r.id === expired.id),
    ).toMatchObject({ status: "reauthorize", active: 0 });
    expect(JSON.stringify(await f.list())).not.toContain(
      "sensitive-provider-data",
    );
  } finally {
    await f.close();
  }
});
it("discovers an Antigravity project without generating model traffic", async () => {
  const f = await setup();
  try {
    const a = await f.create("antigravity");
    transport = (i) => {
      expect(i.url).toBe(
        "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
      );
      expect(i.publicOnly).toBe(true);
      return Response.json({
        cloudaicompanionProject: { id: "authorized-project" },
      });
    };
    expect((await f.action(a.id, "project")).status).toBe(200);
    expect((await f.list())[0].projectId).toBe("authorized-project");
  } finally {
    await f.close();
  }
});
it("does not send expired unrefreshable credentials and cools a fully used quota until its reset", async () => {
  const f = await setup();
  try {
    const expired = await f.create("codex", {
      access_token: "expired",
      expires_at: Date.now() - 1000,
    });
    await expect(f.acquire([expired.id])).rejects.toMatchObject({
      code: "subscription_reauthorize",
    });
    const a = await f.create();
    const lease = await f.acquire([a.id]);
    await f.kernel.invoke("ai.subscription.codex@1", {
      action: "report",
      leaseId: lease.leaseId,
      version: lease.credential.version,
      status: 200,
      quota: [
        {
          window: "primary",
          usedPercent: 100,
          resetAt: Date.now() + 300000,
          windowMinutes: 300,
        },
      ],
    });
    await f.release(lease);
    expect((await f.list()).find((r: any) => r.id === a.id)).toMatchObject({
      status: "cooldown",
      quota: [{ usedPercent: 100 }],
    });
    await expect(f.acquire([a.id])).rejects.toMatchObject({
      code: "subscription_unavailable",
    });
  } finally {
    await f.close();
  }
});
it("retries a rejected authorization once, stops after a second 401 and releases failed stream leases", async () => {
  const f = await setup(["upstream-codex"]);
  try {
    const a = await f.create();
    let calls = 0,
      refreshes = 0;
    transport = (i) => {
      if (i.url.includes("oauth/token")) {
        refreshes++;
        return Response.json({ access_token: "new", expires_in: 3600 });
      }
      calls++;
      return new Response(null, { status: 401 });
    };
    const input = {
      upstream: { protocol: "codex", subscriptionAccountIds: [a.id] },
      request: {
        model: "m",
        messages: [{ role: "user", text: "hi" }],
        tools: [],
        stream: true,
      },
    };
    await expect(
      f.kernel.invoke("ai.upstream.codex@1", input),
    ).rejects.toMatchObject({ code: "subscription_reauthorize", status: 502 });
    expect(calls).toBe(2);
    expect(refreshes).toBe(1);
    expect((await f.list())[0]).toMatchObject({
      status: "reauthorize",
      active: 0,
    });
    await f.action(a.id, "resume");
    calls = 0;
    transport = () => {
      calls++;
      return new Response(
        'data: {"type":"error","error":{"message":"secret error"}}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      );
    };
    const events = await f.kernel.invoke<AsyncIterableIterator<any>>(
      "ai.upstream.codex@1",
      input,
    );
    await expect(events.next()).rejects.toThrow();
    expect((await f.list())[0].active).toBe(0);
    expect(calls).toBe(1);
  } finally {
    await f.close();
  }
});
it("retries one 401 on the same subscription account, holds the stream lease and preserves platform billing", async () => {
  const f = await setup(
    [
      "billing",
      "observability",
      "ai-router",
      "ingress-openai-chat",
      "upstream-codex",
    ],
    { billing: { enabled: true } },
  );
  try {
    const a = await f.create();
    f.kernel.configure({
      "official.ai-router": {
        upstreams: {
          sub: {
            flow: {
              entry: "start",
              nodes: [
                { id: "start", type: "start", next: "provider" },
                {
                  id: "provider",
                  type: "provider",
                  upstream: {
                    protocol: "codex",
                    subscriptionAccountIds: [a.id],
                  },
                },
              ],
            },
          },
        },
        models: {
          demo: {
            upstream: "sub",
            model: "model-vendor",
            inputPrice: 2,
            outputPrice: 8,
          },
        },
      },
    });
    const me = await (
      await f.request(
        "/api/plugins/official.auth/me",
        "GET",
        undefined,
        f.admin,
      )
    ).json();
    await f.kernel.invoke("billing.credit@1", {
      userId: me.id,
      amount: 1000000,
      source: "test",
    });
    let calls = 0,
      refreshes = 0;
    transport = (i) => {
      if (i.url.includes("oauth/token")) {
        refreshes++;
        return Response.json({ access_token: "refreshed", expires_in: 3600 });
      }
      calls++;
      expect(i.url).toBe("https://chatgpt.com/backend-api/codex/responses");
      expect(i.publicOnly).toBe(true);
      if (calls === 1) return new Response(null, { status: 401 });
      expect(i.headers.authorization).toBe("Bearer refreshed");
      expect(JSON.parse(i.body)).toMatchObject({
        stream: true,
        store: false,
        model: "model-vendor",
      });
      const sse =
        'data: {"type":"response.output_text.delta","delta":"hello"}\n\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":1}}}\n\n';
      return new Response(sse, {
        headers: { "content-type": "text/event-stream" },
      });
    };
    const response = await f.request(
      "/v1/chat/completions",
      "POST",
      {
        model: "demo",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      },
      f.admin,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.text()).toContain("hello");
    expect(calls).toBe(2);
    expect(refreshes).toBe(1);
    expect((await f.list())[0].active).toBe(0);
    const balance = await f.kernel.invoke<any>("billing.balance@1", {
      userId: me.id,
    });
    expect(balance.balance).toBeLessThan(1000000);
    expect(balance.held).toBe(0);
  } finally {
    await f.close();
  }
});
it.each(["codex", "claude-subscription", "antigravity"])(
  "releases %s stream leases on early return and never retries after output",
  async (provider) => {
    const api = providerApi(provider);
    const f = await setup(["upstream-" + provider]);
    try {
      const a = await f.create(provider, {
        access_token: "a",
        refresh_token: "r",
        project_id: "project",
        expires_at: Date.now() + 3600000,
      });
      let cancelled = 0,
        calls = 0;
      transport = () => {
        calls++;
        return new Response(
          new ReadableStream({
            start(c) {
              const content =
                provider === "codex"
                  ? { type: "response.output_text.delta", delta: "hello" }
                  : provider === "claude-subscription"
                    ? {
                        type: "content_block_delta",
                        delta: { type: "text_delta", text: "hello" },
                      }
                    : {
                        response: {
                          candidates: [
                            { content: { parts: [{ text: "hello" }] } },
                          ],
                        },
                      };
              c.enqueue(
                new TextEncoder().encode(
                  "data: " + JSON.stringify(content) + "\n\n",
                ),
              );
            },
            cancel() {
              cancelled++;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      };
      const events = await f.kernel.invoke<AsyncIterableIterator<any>>(
        "ai.upstream." + provider + "@1",
        {
          upstream: { protocol: provider, subscriptionAccountIds: [a.id] },
          request: {
            model: "m",
            messages: [{ role: "user", text: "hi" }],
            stream: true,
            tools: [],
          },
        },
      );
      expect((await f.list())[0].active).toBe(1);
      expect((await events.next()).value).toMatchObject({
        type: "text",
        text: "hello",
      });
      await events.return?.();
      expect((await f.list())[0].active).toBe(0);
      expect(cancelled).toBe(1);
      expect(calls).toBe(1);
      const unopened = await f.kernel.invoke<AsyncIterableIterator<any>>(
        "ai.upstream." + provider + "@1",
        {
          upstream: { protocol: provider, subscriptionAccountIds: [a.id] },
          request: {
            model: "m",
            messages: [{ role: "user", text: "hi" }],
            stream: true,
            tools: [],
          },
        },
      );
      await unopened.return?.();
      expect((await f.list())[0].active).toBe(0);
      expect(cancelled).toBe(2);
    } finally {
      await f.close();
    }
  },
);
