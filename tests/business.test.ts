import { it, expect } from "vitest";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHmac, generateKeyPairSync, createHash, sign } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fixture } from "./helpers.js";
import { createKernel } from "../packages/control/dist/index.js";
// Independent reference signer: integration tests only load published plugin bundles.
function epaySign(
  fields: Record<string, unknown>,
  algorithm: "MD5" | "RSA",
  key: string,
) {
  const text = Object.keys(fields)
    .filter(
      (k) =>
        k !== "sign" &&
        k !== "sign_type" &&
        fields[k] !== "" &&
        fields[k] != null,
    )
    .sort()
    .map((k) => k + "=" + fields[k])
    .join("&");
  return algorithm === "MD5"
    ? createHash("md5")
        .update(text + key)
        .digest("hex")
    : sign("RSA-SHA256", Buffer.from(text), key).toString("base64");
}
const roots = [
  "users",
  "auth",
  "billing",
  "commerce",
  "payments-stripe",
  "payments-epay",
];
let transport: (
  input: any,
  signal: AbortSignal,
) => Response | Promise<Response>;
async function mockTransport(kernel: any, directory: string) {
  (globalThis as any).__pluhubBusinessTransport = (i: any, s: AbortSignal) =>
    transport(i, s);
  const dir = join(directory, "transport");
  await mkdir(dir);
  await writeFile(
    join(dir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "test.transport",
      version: "1.0.0",
      host: ">=0.1.0-alpha.1",
      runtime: { kind: "native", entry: "index.mjs" },
      provides: ["http.transport@1"],
      requires: [],
      permissions: [],
      configReload: "snapshot",
    }),
  );
  await writeFile(
    join(dir, "index.mjs"),
    'export default { setup(host) { host.provide("http.transport@1", (i,s)=>globalThis.__pluhubBusinessTransport(i,s)); } };',
  );
  await kernel.add(dir, { grants: [] });
}
const stripeSignature = (raw: string, t = Math.floor(Date.now() / 1000)) =>
  "t=" +
  t +
  ",v1=" +
  createHmac("sha256", "webhook-test-secret")
    .update(t + "." + raw)
    .digest("hex");
const product = {
  id: "credits",
  name: "Credit pack",
  mode: "payment",
  currency: "usd",
  paymentMinor: 500,
  creditMicros: 5000000,
};
const monthly = {
  ...product,
  id: "monthly",
  mode: "subscription",
  interval: "month",
};
it("verifies Stripe raw webhooks, prevents duplicate credits and bills subscriptions once per paid period", async () => {
  process.env.PLUHUB_STRIPE_TEST_KEY = "stripe-test-only";
  process.env.PLUHUB_STRIPE_TEST_WEBHOOK = "webhook-test-secret";
  const responses = new Map<string, any>();
  const forms: URLSearchParams[] = [];
  let cancellations = 0;
  transport = (i) => {
    expect(i.headers.authorization).toBe("Bearer stripe-test-only");
    expect(i.headers["stripe-version"]).toBe("2025-03-31.basil");
    const path = new URL(i.url).pathname;
    if (path === "/v1/customers")
      return Response.json({ id: "cus_business_test" });
    if (path === "/v1/checkout/sessions") {
      forms.push(new URLSearchParams(i.body));
      expect(i.headers["idempotency-key"]).toMatch(/^checkout:/);
      return Response.json({ url: "https://checkout.stripe.com/c/pay/test" });
    }
    if (i.method === "POST" && path === "/v1/subscriptions/sub_1") {
      cancellations++;
      return Response.json({ id: "sub_1", cancel_at_period_end: true });
    }
    return Response.json(responses.get(path));
  };
  const f = await fixture(
    roots,
    {
      commerce: { publicUrl: "http://localhost", products: [product, monthly] },
      "payments-stripe": {
        enabled: true,
        keyRef: "env:PLUHUB_STRIPE_TEST_KEY",
        webhookSecretRef: "env:PLUHUB_STRIPE_TEST_WEBHOOK",
        secretRefs: [
          "env:PLUHUB_STRIPE_TEST_KEY",
          "env:PLUHUB_STRIPE_TEST_WEBHOOK",
        ],
        livemode: false,
      },
    },
    mockTransport,
  );
  try {
    const admin = await f.admin();
    const me = await (
      await f.request("/api/plugins/official.auth/me", "GET", undefined, admin)
    ).json();
    const checkout = async (productId: string) => {
      const r = await f.request(
        "/api/plugins/official.commerce/checkout",
        "POST",
        { productId, provider: "stripe", creditMicros: 999999999 },
        admin,
      );
      expect(r.status).toBe(200);
      return r.json();
    };
    async function webhook(
      type: string,
      obj: any,
      extra: any = {},
      timestamp?: number,
    ) {
      const raw = JSON.stringify({
        id: "evt_" + type,
        livemode: false,
        type,
        data: { object: obj },
        ...extra,
      });
      const r = await f.kernel.fetch(
        new Request(
          "http://localhost/api/plugins/official.payments-stripe/webhook",
          {
            method: "POST",
            headers: { "stripe-signature": stripeSignature(raw, timestamp) },
            body: raw,
          },
        ),
      );
      await r.text();
      return r.status;
    }
    const first = await checkout("credits");
    const session = {
      id: "cs_1",
      mode: "payment",
      payment_status: "paid",
      metadata: { orderId: first.id },
      payment_intent: "pi_1",
      amount_total: 500,
      currency: "usd",
    };
    responses.set("/v1/checkout/sessions/cs_1", session);
    expect(
      await webhook("checkout.session.completed", {
        ...session,
        payment_status: "unpaid",
      }),
    ).toBe(200);
    expect(
      (await f.kernel.invoke<any>("billing.balance@1", { userId: me.id }))
        .balance,
    ).toBe(0);
    expect(await webhook("checkout.session.completed", session)).toBe(200);
    expect(
      await webhook("checkout.session.async_payment_succeeded", session),
    ).toBe(200);
    expect(
      (await f.kernel.invoke<any>("billing.balance@1", { userId: me.id }))
        .balance,
    ).toBe(5000000);
    expect(
      await webhook(
        "checkout.session.completed",
        session,
        {},
        Math.floor(Date.now() / 1000) - 301,
      ),
    ).toBe(400);
    const bad = await checkout("credits");
    responses.set("/v1/checkout/sessions/cs_2", {
      ...session,
      id: "cs_2",
      payment_intent: "pi_2",
      metadata: { orderId: bad.id },
      amount_total: 1,
    });
    expect(
      await webhook("checkout.session.completed", { ...session, id: "cs_2" }),
    ).toBe(400);
    const subscription = await checkout("monthly");
    expect(forms.at(-1)?.get("subscription_data[metadata][orderId]")).toBe(
      subscription.id,
    );
    expect(
      forms.at(-1)?.get("line_items[0][price_data][recurring][interval]"),
    ).toBe("month");
    const end = Math.floor(Date.now() / 1000) + 86400;
    const sub = {
      id: "sub_1",
      status: "active",
      metadata: { orderId: subscription.id },
    };
    responses.set("/v1/subscriptions/sub_1", sub);
    const invoice = {
      id: "in_1",
      status: "paid",
      amount_remaining: 0,
      amount_paid: 500,
      currency: "usd",
      parent: { subscription_details: { subscription: "sub_1" } },
      lines: { data: [{ period: { end } }] },
    };
    responses.set("/v1/invoices/in_1", invoice);
    expect(await webhook("invoice.paid", invoice)).toBe(200);
    await f.kernel.shutdown();
    const oldSchema = new DatabaseSync(
      join(f.config.dataDir, "official.commerce", "commerce.sqlite"),
    );
    oldSchema.exec("DROP TABLE subscription_periods; PRAGMA user_version=6");
    oldSchema.close();
    await f.kernel.start();
    expect(await webhook("invoice.paid", invoice)).toBe(200);
    responses.set("/v1/invoices/in_duplicate_period", {
      ...invoice,
      id: "in_duplicate_period",
    });
    expect(await webhook("invoice.paid", { id: "in_duplicate_period" })).toBe(
      200,
    );
    const next = {
      ...invoice,
      id: "in_2",
      parent: undefined,
      subscription: "sub_1",
      lines: { data: [{ period: { end: end + 2592000 } }] },
    };
    responses.set("/v1/invoices/in_2", next);
    expect(await webhook("invoice.paid", next)).toBe(200);
    expect(
      (await f.kernel.invoke<any>("billing.balance@1", { userId: me.id }))
        .balance,
    ).toBe(15000000);
    const cancel = await f.request(
      "/api/plugins/official.commerce/cancel",
      "POST",
      { id: "sub_1" },
      admin,
    );
    expect(cancel.status).toBe(200);
    await cancel.json();
    const repeatCancel = await f.request(
      "/api/plugins/official.commerce/cancel",
      "POST",
      { id: "sub_1" },
      admin,
    );
    expect(repeatCancel.status).toBe(200);
    await repeatCancel.text();
    expect(cancellations).toBe(1);
    const subscriptions = await (
      await f.request(
        "/api/plugins/official.commerce/subscriptions",
        "GET",
        undefined,
        admin,
      )
    ).json();
    expect(subscriptions[0]).toMatchObject({
      status: "cancel_at_period_end",
      period_end: (end + 2592000) * 1000,
    });
    await expect(
      f.kernel.invoke("billing.credit@1", {
        userId: me.id,
        amount: 1,
        source: "payment:stripe:pi_1",
      }),
    ).rejects.toThrow("already used");
  } finally {
    await f.close();
    delete process.env.PLUHUB_STRIPE_TEST_KEY;
    delete process.env.PLUHUB_STRIPE_TEST_WEBHOOK;
    delete (globalThis as any).__pluhubBusinessTransport;
  }
});
it("supports all Epay version/signature combinations with signed V2 responses and idempotent prepaid callbacks", async () => {
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  process.env.PLUHUB_EPAY_MD5 = "md5-test-only";
  process.env.PLUHUB_EPAY_PRIVATE = pair.privateKey;
  process.env.PLUHUB_EPAY_PUBLIC = pair.publicKey;
  for (const version of ["v1", "v2"])
    for (const algorithm of ["MD5", "RSA"]) {
      transport = (i) => {
        expect(new URL(i.url).pathname).toBe("/api/pay/create");
        const fields = Object.fromEntries(new URLSearchParams(i.body));
        expect(fields).toMatchObject({
          method: "jump",
          clientip: "127.0.0.1",
          sign_type: algorithm,
        });
        const result: any = {
          code: 0,
          pay_type: "jump",
          pay_info: "https://pay.example/checkout",
          trade_no: "trade",
          timestamp: Math.floor(Date.now() / 1000),
          sign_type: algorithm,
        };
        result.sign = epaySign(
          result,
          algorithm as any,
          algorithm === "MD5" ? "md5-test-only" : pair.privateKey,
        );
        return Response.json(result);
      };
      const config = {
        enabled: true,
        methods: [
          {
            id: "1",
            enabled: true,
            paymentType: "alipay",
            version,
            algorithm,
            pid: "123",
            baseUrl: "https://epay.example",
            publicUrl: "http://localhost",
            keyRef: "env:PLUHUB_EPAY_MD5",
            privateKeyRef: "env:PLUHUB_EPAY_PRIVATE",
            platformPublicKeyRef: "env:PLUHUB_EPAY_PUBLIC",
          },
        ],
        secretRefs: [
          "env:PLUHUB_EPAY_MD5",
          "env:PLUHUB_EPAY_PRIVATE",
          "env:PLUHUB_EPAY_PUBLIC",
        ],
      };
      const f = await fixture(
        roots,
        {
          commerce: {
            publicUrl: "http://localhost",
            products: [{ ...monthly, currency: "cny" }],
          },
          "payments-epay": config,
        },
        mockTransport,
      );
      try {
        const admin = await f.admin();
        const r = await f.request(
          "/api/plugins/official.commerce/checkout",
          "POST",
          { productId: "monthly", provider: "epay" },
          admin,
        );
        expect(r.status).toBe(200);
        const order = await r.json();
        if (version === "v1") {
          const url = new URL(order.url);
          expect(url.pathname).toBe("/submit.php");
          expect(url.searchParams.get("money")).toBe("5.00");
        }
        const fields: any = {
          pid: "123",
          type: "alipay",
          out_trade_no: order.id,
          trade_no: "unique-trade",
          trade_status: "TRADE_SUCCESS",
          money: "5.00",
          sign_type: algorithm,
        };
        fields.sign = epaySign(
          fields,
          algorithm as any,
          algorithm === "MD5" ? "md5-test-only" : pair.privateKey,
        );
        async function notify(value: any) {
          const response = await f.kernel.fetch(
            new Request(
              "http://localhost/api/plugins/official.payments-epay/notify?pluhub_method=1&" +
                new URLSearchParams(value),
            ),
          );
          await response.text();
          return response.status;
        }
        expect(await notify({ ...fields, money: "9.00" })).toBe(400);
        expect(await notify(fields)).toBe(200);
        expect(await notify(fields)).toBe(200);
        const wallet = await (
          await f.request(
            "/api/plugins/official.billing/wallet",
            "GET",
            undefined,
            admin,
          )
        ).json();
        expect(wallet.balance).toBe(5000000);
        const subs = await (
          await f.request(
            "/api/plugins/official.commerce/subscriptions",
            "GET",
            undefined,
            admin,
          )
        ).json();
        expect(subs[0].id).toMatch(/^prepaid:/);
        expect(subs[0].period_end).toBeGreaterThan(Date.now());
      } finally {
        await f.close();
      }
    }
  delete process.env.PLUHUB_EPAY_MD5;
  delete process.env.PLUHUB_EPAY_PRIVATE;
  delete process.env.PLUHUB_EPAY_PUBLIC;
  delete (globalThis as any).__pluhubBusinessTransport;
});
it("settles known usage and charges unknown usage at the reserved amount while enforcing limits", async () => {
  let calls = 0;
  let lastKey = "";
  transport = (i) => {
    calls++;
    lastKey = i.headers.authorization;
    const req = JSON.parse(i.body);
    return Response.json({
      choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
      ...(req.messages[0].content === "unknown"
        ? {}
        : { usage: { prompt_tokens: 3, completion_tokens: 4 } }),
    });
  };
  process.env.PLUHUB_TEST_UPSTREAM_KEY = "platform-only";
  const f = await fixture(
    [
      "users",
      "auth",
      "ai-router",
      "billing",
      "byok",
      "rate-limit",
      "ingress-openai-chat",
      "upstream-openai-chat",
    ],
    { billing: { enabled: true } },
    mockTransport,
  );
  try {
    const admin = await f.admin();
    const me = await (
      await f.request("/api/plugins/official.auth/me", "GET", undefined, admin)
    ).json();
    f.kernel.configure({
      "official.ai-router": {
        upstreams: {
          primary: {
            protocol: "openai-chat",
            baseUrl: "https://test.example",
            keyRef: "env:PLUHUB_TEST_UPSTREAM_KEY",
          },
        },
        models: {
          demo: {
            upstream: "primary",
            model: "m",
            inputPrice: 1,
            outputPrice: 2,
          },
        },
      },
    });
    const invoke = (text: string, extra = {}) =>
      f.request(
        "/v1/chat/completions",
        "POST",
        {
          model: "demo",
          messages: [{ role: "user", content: text }],
          max_tokens: 8,
        },
        { ...admin, ...extra },
      );
    const denied = await invoke("hi");
    expect(denied.status).toBe(402);
    await denied.json();
    expect(calls).toBe(0);
    await f.kernel.invoke("billing.credit@1", {
      userId: me.id,
      amount: 100000,
      source: "test-credit",
    });
    const ok = await invoke("hi");
    expect(ok.status).toBe(200);
    await ok.json();
    expect(
      (await f.kernel.invoke<any>("billing.balance@1", { userId: me.id }))
        .balance,
    ).toBe(99989);
    expect(lastKey).toBe("Bearer platform-only");
    const unknown = await invoke("unknown");
    expect((await unknown.json()).usage).toBeUndefined();
    const wallet = await f.kernel.invoke<any>("billing.balance@1", {
      userId: me.id,
    });
    const [charge] = await f.kernel.invoke<any[]>("billing.request-charges@1", {
      requests: [
        { id: unknown.headers.get("x-pluhub-request-id"), userId: me.id },
      ],
    });
    expect(charge.status).toBe("settled");
    expect(charge.charged).toBeGreaterThan(0);
    expect(charge.receipt.mode).toBe("reserved");
    expect(wallet.balance).toBe(99989 - charge.charged);
    expect(wallet.held).toBe(0);
    f.kernel.configure({ "official.rate-limit": { user: { rpm: 1 } } });
    const first = await invoke("hi");
    await first.json();
    const limit = await invoke("hi");
    expect(limit.status).toBe(429);
    await limit.json();
    expect(
      (await f.kernel.invoke<any>("billing.balance@1", { userId: me.id })).held,
    ).toBe(0);
  } finally {
    await f.close();
    delete process.env.PLUHUB_TEST_UPSTREAM_KEY;
    delete (globalThis as any).__pluhubBusinessTransport;
  }
});

it("recovers payment delivery across restarts without crediting twice and settles interrupted reservations once", async () => {
  const f = await fixture(["users", "auth", "billing", "commerce"]);
  let fresh: any;
  try {
    const admin = await f.admin();
    const user = await (
      await f.request("/api/plugins/official.auth/me", "GET", undefined, admin)
    ).json();
    await f.kernel.invoke("billing.credit@1", {
      userId: user.id,
      amount: 100,
      source: "payment:stripe:already-committed",
    });
    await f.kernel.shutdown();
    const billing = new DatabaseSync(
      join(f.config.dataDir, "official.billing", "billing.sqlite"),
    );
    billing
      .prepare(
        "INSERT INTO reservations(id,user_id,amount,status,actual,created_at,note) VALUES(?,?,?,'reserved',NULL,?,NULL)",
      )
      .run("interrupted", user.id, 10, Date.now());
    billing.close();
    const commerce = new DatabaseSync(
      join(f.config.dataDir, "official.commerce", "commerce.sqlite"),
    );
    commerce
      .prepare(
        "INSERT INTO outbox(source,user_id,amount,delivered) VALUES(?,?,?,0)",
      )
      .run("payment:stripe:already-committed", user.id, 100);
    commerce
      .prepare(
        "INSERT INTO outbox(source,user_id,amount,delivered) VALUES(?,?,?,0)",
      )
      .run("payment:stripe:not-yet-delivered", user.id, 200);
    commerce.close();
    fresh = await createKernel(f.config);
    await fresh.start();
    const response = await fresh.fetch(
      new Request("http://localhost/api/plugins/official.commerce/retry", {
        method: "POST",
        headers: admin,
      }),
    );
    expect(response.status).toBe(200);
    await response.json();
    expect(
      await fresh.invoke("billing.balance@1", { userId: user.id }),
    ).toMatchObject({ balance: 290, held: 0, available: 290 });
    const ledger = new DatabaseSync(
      join(f.config.dataDir, "official.billing", "billing.sqlite"),
    );
    expect(
      (ledger.prepare("SELECT COUNT(*) n FROM ledger").get() as any).n,
    ).toBe(3);
    expect(
      (ledger.prepare("SELECT status FROM reservations").get() as any).status,
    ).toBe("settled");
    ledger.close();
  } finally {
    await fresh?.shutdown();
    await f.close();
  }
});

it("releases concurrency and settles partial usage on stream cancellation", async () => {
  let aborted = 0;
  transport = (i, signal) => {
    const source = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(
          new TextEncoder().encode(
            'data: {"choices":[{"index":0,"delta":{"content":"partial"}}],"usage":{"prompt_tokens":3,"completion_tokens":0}}\n\n',
          ),
        );
        signal.addEventListener(
          "abort",
          () => {
            aborted++;
            c.error(signal.reason);
          },
          { once: true },
        );
      },
    });
    return new Response(source, {
      headers: { "content-type": "text/event-stream" },
    });
  };
  process.env.PLUHUB_TEST_UPSTREAM_KEY = "test-stream";
  const f = await fixture(
    [
      "users",
      "auth",
      "ai-router",
      "billing",
      "rate-limit",
      "ingress-openai-chat",
      "upstream-openai-chat",
    ],
    {
      billing: { enabled: true },
      "rate-limit": { user: { concurrency: 1 }, bytesPerSecond: 1000000 },
    },
    mockTransport,
  );
  try {
    const admin = await f.admin();
    const user = await (
      await f.request("/api/plugins/official.auth/me", "GET", undefined, admin)
    ).json();
    f.kernel.configure({
      "official.ai-router": {
        upstreams: {
          primary: {
            protocol: "openai-chat",
            baseUrl: "https://test",
            keyRef: "env:PLUHUB_TEST_UPSTREAM_KEY",
          },
        },
        models: {
          demo: {
            upstream: "primary",
            model: "m",
            inputPrice: 1,
            outputPrice: 2,
          },
        },
      },
    });
    await f.kernel.invoke("billing.credit@1", {
      userId: user.id,
      amount: 1000000,
      source: "credit",
    });
    const invoke = () =>
      f.request(
        "/v1/chat/completions",
        "POST",
        {
          model: "demo",
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 8,
          stream: true,
        },
        admin,
      );
    const first = await invoke();
    expect(first.status).toBe(200);
    const denied = await invoke();
    expect(denied.status).toBe(429);
    await denied.json();
    const reader = first.body!.getReader();
    await reader.read();
    await reader.read();
    await reader.cancel();
    expect(aborted).toBe(1);
    const wallet = await f.kernel.invoke<any>("billing.balance@1", {
      userId: user.id,
    });
    expect(wallet.balance).toBe(999997);
    expect(wallet.held).toBe(0);
    const next = await invoke();
    expect(next.status).toBe(200);
    await next.body!.cancel();
    expect(aborted).toBe(2);
    const status = await (
      await f.request(
        "/api/plugins/official.rate-limit/status",
        "GET",
        undefined,
        admin,
      )
    ).json();
    expect(status.active).toBe(0);
    transport = () =>
      Response.json({
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 1 },
      });
    const overflow = await invoke();
    expect(overflow.status).toBe(200);
    await overflow.text();
    const [charge] = await f.kernel.invoke<any[]>("billing.request-charges@1", {
      requests: [
        { id: overflow.headers.get("x-pluhub-request-id"), userId: user.id },
      ],
    });
    expect(charge).toMatchObject({
      status: "settled",
      held: 0,
      receipt: { mode: "reserved" },
    });
  } finally {
    await f.close();
    delete process.env.PLUHUB_TEST_UPSTREAM_KEY;
    delete (globalThis as any).__pluhubBusinessTransport;
  }
});
