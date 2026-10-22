import { it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./helpers.js";
import { createKernel } from "../packages/control/dist/index.js";

const commerce = "/api/plugins/official.commerce",
  billing = "/api/plugins/official.billing";
const product = {
  id: "credit",
  name: "Credits",
  mode: "payment",
  currency: "usd",
  paymentMinor: 500,
  creditMicros: 5000000,
};
async function setup() {
  const objects = new Map<string, any>(),
    invoices = new Map<string, string[]>(),
    requests: string[] = [];
  let counter = 0;
  process.env.PLUHUB_FINANCE_TEST = "local-financial-fixture";
  (globalThis as any).__pluhubFinanceTransport = (input: any) => {
    const url = new URL(input.url);
    requests.push(url.pathname + url.search);
    if (url.pathname === "/v1/checkout/sessions")
      return Response.json({ url: "https://checkout.stripe.com/c/pay/local" });
    if (url.pathname === "/v1/invoice_payments") {
      expect(url.searchParams.get("payment[type]")).toBe("payment_intent");
      return Response.json({
        has_more: false,
        data: (
          invoices.get(url.searchParams.get("payment[payment_intent]")!) ?? []
        ).map((invoice) => ({ invoice, status: "paid" })),
      });
    }
    const value =
      objects.get(url.pathname + url.search) ?? objects.get(url.pathname);
    if (!value)
      return Response.json(
        { error: "local fixture object missing" },
        { status: 503 },
      );
    return Response.json(value);
  };
  const f = await fixture(
    ["users", "auth", "billing", "commerce", "payments-stripe"],
    {
      commerce: {
        publicUrl: "http://localhost",
        products: [
          product,
          {
            ...product,
            id: "monthly",
            mode: "subscription",
            interval: "month",
          },
          { ...product, id: "tiny", paymentMinor: 3, creditMicros: 2 },
        ],
      },
      "payments-stripe": {
        enabled: true,
        keyRef: "env:PLUHUB_FINANCE_TEST",
        webhookSecretRef: "env:PLUHUB_FINANCE_TEST",
        secretRefs: ["env:PLUHUB_FINANCE_TEST"],
        livemode: false,
      },
    },
    async (kernel, directory) => {
      const path = join(directory, "finance-transport");
      await mkdir(path);
      await writeFile(
        join(path, "manifest.json"),
        JSON.stringify({
          schemaVersion: 1,
          id: "test.finance-transport",
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
        'export default {setup(h){h.provide("http.transport@1",i=>globalThis.__pluhubFinanceTransport(i));}};',
      );
      await kernel.add(path, { grants: [] });
    },
  );
  f.config.plugins.push({
    path: join(f.directory, "finance-transport"),
    grants: [],
  });
  const admin = await f.admin(),
    user = await f.kernel.invoke<any>("users.lookup@1", { username: "admin" });
  const order = async (productId = "credit") => {
    const r = await f.request(
      commerce + "/checkout",
      "POST",
      { productId, provider: "stripe" },
      admin,
    );
    expect(r.status).toBe(200);
    return r.json();
  };
  const paid = async (
    orderId: string,
    paymentId = "pi_original",
    extra: any = {},
  ) =>
    f.kernel.invoke("commerce.payment@1", {
      provider: "stripe",
      eventId: "paid:" + paymentId,
      orderId,
      paymentId,
      amount: 500,
      currency: "usd",
      kind: "paid",
      ...extra,
    });
  const adjust = async (
    objectId: string,
    status: string,
    amount = 100,
    extra: any = {},
  ) =>
    f.kernel.invoke("commerce.payment-adjustment@1", {
      provider: "stripe",
      eventId: "case:" + ++counter,
      objectId,
      references: ["pi_original"],
      kind: "refund",
      status,
      amount,
      currency: "usd",
      ...extra,
    });
  const wallet = () =>
    f.kernel.invoke<any>("billing.balance@1", { userId: user.id });
  const webhook = async (
    type: string,
    obj: any,
    eventId = "stripe:" + ++counter,
    signature = true,
  ) => {
    const raw = JSON.stringify({
        id: eventId,
        livemode: false,
        type,
        data: { object: obj },
      }),
      t = Math.floor(Date.now() / 1000);
    const r = await f.kernel.fetch(
      new Request(
        "http://localhost/api/plugins/official.payments-stripe/webhook",
        {
          method: "POST",
          body: raw,
          headers: {
            "stripe-signature": `t=${t},v1=${
              signature
                ? createHmac("sha256", "local-financial-fixture")
                    .update(t + "." + raw)
                    .digest("hex")
                : "bad"
            }`,
          },
        },
      ),
    );
    const status = r.status;
    await r.text();
    return status;
  };
  return {
    ...f,
    admin,
    user,
    order,
    paid,
    adjust,
    wallet,
    webhook,
    objects,
    invoices,
    requests,
    async close() {
      await f.close();
      delete (globalThis as any).__pluhubFinanceTransport;
      delete process.env.PLUHUB_FINANCE_TEST;
    },
  };
}
it("freezes pending refunds and disputes, settles only confirmed losses and restores failed or won cases", async () => {
  const f = await setup();
  try {
    await f.paid((await f.order()).id);
    await f.adjust("re_partial", "pending", 100);
    expect(await f.wallet()).toMatchObject({
      balance: 5000000,
      paymentHeld: 1000000,
      available: 4000000,
    });
    await f.adjust("re_partial", "succeeded", 100);
    expect(await f.wallet()).toMatchObject({
      balance: 4000000,
      paymentHeld: 0,
    });
    await f.adjust("du_open", "open", 200, { kind: "dispute" });
    expect(await f.wallet()).toMatchObject({
      balance: 4000000,
      paymentHeld: 2000000,
      available: 2000000,
    });
    await f.adjust("du_open", "won", 200, { kind: "dispute" });
    expect(await f.wallet()).toMatchObject({
      balance: 4000000,
      paymentHeld: 0,
    });
    await f.adjust("du_lost", "lost", 500, { kind: "dispute" });
    expect(await f.wallet()).toMatchObject({ balance: 0, paymentHeld: 0 });
    await f.adjust("du_lost", "won", 500, { kind: "dispute" });
    expect(await f.wallet()).toMatchObject({
      balance: 4000000,
      paymentHeld: 0,
    });
    await f.adjust("re_partial", "failed", 100);
    expect(await f.wallet()).toMatchObject({
      balance: 5000000,
      paymentHeld: 0,
    });
  } finally {
    await f.close();
  }
});
it("persists early adjustments and atomically applies them with the original credit", async () => {
  const f = await setup();
  try {
    await f.adjust("re_early", "succeeded", 500);
    expect(await f.wallet()).toMatchObject({ balance: 0 });
    const before = await (
      await f.request(
        commerce + "/admin/adjustments?status=review",
        "GET",
        undefined,
        f.admin,
      )
    ).json();
    expect(before.total).toBe(1);
    const order = await f.order();
    await f.paid(order.id);
    expect(await f.wallet()).toMatchObject({ balance: 0, available: 0 });
    const after = await (
      await f.request(
        commerce + "/admin/adjustments?status=",
        "GET",
        undefined,
        f.admin,
      )
    ).json();
    expect(after.items[0]).toMatchObject({
      order_id: order.id,
      user_id: f.user.id,
      review: null,
    });
    await f.paid(order.id);
    expect(await f.wallet()).toMatchObject({ balance: 0 });
    const ledger = await (
      await f.request(billing + "/ledger", "GET", undefined, f.admin)
    ).json();
    expect(ledger).toHaveLength(2);
  } finally {
    await f.close();
  }
});
it("keeps partial-refund rounding bounded across concurrent adjustments and retries", async () => {
  const f = await setup();
  try {
    await f.paid((await f.order("tiny")).id, "pi_original", { amount: 3 });
    await Promise.all([
      f.adjust("re_1", "succeeded", 1),
      f.adjust("re_2", "pending", 1),
      f.adjust("du_round", "open", 3, { kind: "dispute" }),
    ]);
    expect(await f.wallet()).toMatchObject({
      balance: 1,
      paymentHeld: 1,
      available: 0,
    });
    await f.adjust("re_2", "succeeded", 1);
    await f.adjust("du_round", "won", 3, { kind: "dispute" });
    expect(await f.wallet()).toMatchObject({ balance: 0, paymentHeld: 0 });
    await f.adjust("re_3", "succeeded", 1);
    expect(await f.wallet()).toMatchObject({ balance: 0, paymentHeld: 0 });
  } finally {
    await f.close();
  }
});
it("rejects conflicting event identities and payment state revisions without minting funds", async () => {
  const f = await setup();
  try {
    await f.paid((await f.order()).id);
    await f.adjust("re_repeat", "succeeded", 100, { eventId: "same-event" });
    await f.adjust("re_repeat", "succeeded", 100, { eventId: "same-event" });
    await expect(
      f.adjust("re_other", "succeeded", 100, { eventId: "same-event" }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    const state = {
      userId: f.user.id,
      source: "payment:stripe:pi_original",
      credit: 5000000,
      debit: 1000000,
      hold: 0,
      revision: 1,
    };
    await f.kernel.invoke("billing.payment-state@1", state);
    await expect(
      f.kernel.invoke("billing.payment-state@1", { ...state, debit: 0 }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    await f.kernel.invoke("billing.payment-state@1", {
      ...state,
      revision: 0,
      debit: 0,
    });
    await expect(
      f.kernel.invoke("billing.payment-state@1", {
        ...state,
        revision: 2,
        hold: 5000000,
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(await f.wallet()).toMatchObject({ balance: 4000000 });
  } finally {
    await f.close();
  }
});
it("re-queries Stripe refund state and never trusts the signed event object's amount or status", async () => {
  const f = await setup();
  try {
    await f.paid((await f.order()).id);
    const refund = {
      id: "re_verified",
      amount: 200,
      currency: "usd",
      status: "pending",
      payment_intent: "pi_original",
      charge: "ch_original",
    };
    f.objects.set("/v1/refunds/re_verified", refund);
    expect(
      await f.webhook("refund.created", {
        ...refund,
        amount: 500,
        status: "succeeded",
      }),
    ).toBe(200);
    expect(await f.wallet()).toMatchObject({
      balance: 5000000,
      paymentHeld: 2000000,
    });
    refund.status = "succeeded";
    expect(
      await f.webhook("refund.updated", { ...refund, status: "pending" }),
    ).toBe(200);
    expect(await f.wallet()).toMatchObject({
      balance: 3000000,
      paymentHeld: 0,
    });
    expect(
      await f.webhook("refund.created", { ...refund, status: "pending" }),
    ).toBe(200);
    expect(await f.wallet()).toMatchObject({
      balance: 3000000,
      paymentHeld: 0,
    });
    expect(
      await f.webhook("refund.updated", refund, "bad-signature", false),
    ).toBe(400);
    expect(await f.webhook("refund.updated", { id: "re_unavailable" })).toBe(
      502,
    );
  } finally {
    await f.close();
  }
});
it("maps subscription refunds through Stripe invoice payments and lists all charge refunds", async () => {
  const f = await setup();
  try {
    await f.paid((await f.order("monthly")).id, "in_monthly", {
      kind: "renewed",
      subscriptionId: "sub_monthly",
      periodEnd: Date.now() + 86400000,
    });
    f.invoices.set("pi_invoice", ["in_monthly"]);
    const refund = {
      id: "re_invoice",
      amount: 100,
      currency: "usd",
      status: "succeeded",
      payment_intent: "pi_invoice",
      charge: "ch_invoice",
    };
    f.objects.set("/v1/charges/ch_invoice", {
      id: "ch_invoice",
      amount_refunded: 200,
    });
    f.objects.set("/v1/refunds?charge=ch_invoice&limit=100", {
      has_more: true,
      data: [refund],
    });
    f.objects.set(
      "/v1/refunds?charge=ch_invoice&limit=100&starting_after=re_invoice",
      { has_more: false, data: [{ ...refund, id: "re_invoice_2" }] },
    );
    expect(await f.webhook("charge.refunded", { id: "ch_invoice" })).toBe(200);
    expect(await f.wallet()).toMatchObject({ balance: 3000000 });
    expect(await f.webhook("charge.refunded", { id: "ch_invoice" })).toBe(200);
    expect(await f.wallet()).toMatchObject({ balance: 3000000 });
    expect(f.requests.some((p) => p.includes("starting_after="))).toBe(true);
  } finally {
    await f.close();
  }
});
it("persists holds through restart and records a consumed-credit refund as debt", async () => {
  const f = await setup();
  try {
    const order = await f.order();
    await f.paid(order.id);
    await f.adjust("du_restart", "open", 300, { kind: "dispute" });
    await f.request(
      billing + "/adjust",
      "POST",
      {
        userId: f.user.id,
        amount: -4000000,
        id: "consumed-before-refund",
        reason: "Local consumed-credit fixture",
      },
      f.admin,
    );
    await f.kernel.shutdown();
    const restored = await createKernel(f.config);
    try {
      await restored.start();
      expect(
        await restored.invoke("billing.balance@1", { userId: f.user.id }),
      ).toMatchObject({ balance: 1000000, paymentHeld: 3000000 });
      await restored.invoke("commerce.payment-adjustment@1", {
        provider: "stripe",
        eventId: "restored-won",
        objectId: "du_restart",
        references: ["pi_original"],
        kind: "dispute",
        status: "won",
        amount: 300,
        currency: "usd",
      });
      await restored.invoke("commerce.payment-adjustment@1", {
        provider: "stripe",
        eventId: "restored-refund",
        objectId: "re_consumed",
        references: ["pi_original"],
        kind: "refund",
        status: "succeeded",
        amount: 500,
        currency: "usd",
      });
      expect(
        await restored.invoke("billing.balance@1", { userId: f.user.id }),
      ).toMatchObject({
        balance: -4000000,
        available: -4000000,
        paymentHeld: 0,
      });
    } finally {
      await restored.shutdown();
    }
  } finally {
    await f.close();
  }
});
it("isolates user adjustment history and requires recent administrator access for provider rechecks", async () => {
  const f = await setup();
  try {
    await f.paid((await f.order()).id);
    await f.adjust("re_recheck", "pending", 100);
    const create = await (
      await f.request(
        "/api/plugins/official.auth/users",
        "POST",
        { username: "finance-reader", password: "local-reader-password" },
        f.admin,
      )
    ).json();
    const login = await f.request("/api/plugins/official.auth/login", "POST", {
      username: create.username,
      password: "local-reader-password",
    });
    const owner = { cookie: login.headers.get("set-cookie")!.split(";")[0]! };
    await login.text();
    expect(
      (
        await (
          await f.request(
            commerce + "/adjustments?userId=" + f.user.id,
            "GET",
            undefined,
            owner,
          )
        ).json()
      ).total,
    ).toBe(0);
    expect(
      (
        await f.request(
          commerce + "/admin/adjustments",
          "GET",
          undefined,
          owner,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await f.request(
          commerce + "/admin/adjustments/recheck",
          "POST",
          { provider: "stripe", id: "re_consumed", reason: "Unauthorized" },
          owner,
        )
      ).status,
    ).toBe(403);
    f.objects.set("/v1/refunds/re_recheck", {
      id: "re_recheck",
      payment_intent: "pi_original",
      charge: "ch_original",
      amount: 100,
      currency: "usd",
      status: "failed",
    });
    const recheck = await f.request(
      commerce + "/admin/adjustments/recheck",
      "POST",
      {
        provider: "stripe",
        id: "re_recheck",
        reason: "Verify local merchant facts",
      },
      f.admin,
    );
    expect(recheck.status).toBe(200);
    await recheck.text();
    expect(await f.wallet()).toMatchObject({
      balance: 5000000,
      paymentHeld: 0,
    });
    const history = await (
      await f.request(commerce + "/adjustments", "GET", undefined, f.admin)
    ).json();
    expect(history.items[0].status).toBe("failed");
    expect(history.items[0]).not.toHaveProperty("payment_id");
  } finally {
    await f.close();
  }
});
it("holds mismatched amounts and currencies for review and releases ambiguous references after a verified match", async () => {
  const f = await setup();
  try {
    await f.paid((await f.order()).id);
    await f.paid((await f.order()).id, "pi_second");
    await f.adjust("re_ambiguous", "succeeded", 100, {
      references: ["pi_original", "pi_second"],
    });
    expect(await f.wallet()).toMatchObject({
      balance: 10000000,
      paymentHeld: 10000000,
      available: 0,
    });
    await f.adjust("re_ambiguous", "succeeded", 100, {
      references: ["pi_original"],
    });
    expect(await f.wallet()).toMatchObject({
      balance: 9000000,
      paymentHeld: 0,
      available: 9000000,
    });
    await f.adjust("re_currency", "succeeded", 100, {
      references: ["pi_second"],
      currency: "eur",
    });
    expect(await f.wallet()).toMatchObject({
      balance: 9000000,
      paymentHeld: 5000000,
    });
    const review = await (
      await f.request(
        commerce + "/admin/adjustments?status=review",
        "GET",
        undefined,
        f.admin,
      )
    ).json();
    expect(review.total).toBe(1);
    expect(review.items[0].object_id).toBe("re_currency");
  } finally {
    await f.close();
  }
});
it("does not let one invalid wallet block another user's payment delivery", async () => {
  const f = await setup();
  try {
    await f.kernel.invoke("billing.credit@1", {
      userId: f.user.id,
      amount: Number.MAX_SAFE_INTEGER,
      source: "local-blocked-wallet",
    });
    await expect(f.paid((await f.order()).id)).rejects.toThrow();
    const user = await (
      await f.request(
        "/api/plugins/official.auth/users",
        "POST",
        { username: "valid-wallet", password: "local-valid-wallet-password" },
        f.admin,
      )
    ).json();
    const login = await f.request("/api/plugins/official.auth/login", "POST", {
      username: user.username,
      password: "local-valid-wallet-password",
    });
    const session = { cookie: login.headers.get("set-cookie")!.split(";")[0]! };
    await login.text();
    const order = await (
      await f.request(
        commerce + "/checkout",
        "POST",
        { productId: "credit", provider: "stripe" },
        session,
      )
    ).json();
    await expect(f.paid(order.id, "pi_other_user")).resolves.toMatchObject({
      ok: true,
    });
    expect(
      await f.kernel.invoke("billing.balance@1", { userId: user.id }),
    ).toMatchObject({ balance: 5000000, available: 5000000 });
    const tasks = await (
      await f.request(commerce + "/admin/outbox", "GET", undefined, f.admin)
    ).json();
    expect(
      tasks.items.find((row: any) => row.user_id === user.id).delivered,
    ).toBe(1);
    expect(
      tasks.items.find((row: any) => row.user_id === f.user.id).delivered,
    ).toBe(0);
  } finally {
    await f.close();
  }
});
it("retries durable payment adjustments after an atomic wallet transaction fails", async () => {
  const f = await setup();
  try {
    await f.kernel.invoke("billing.credit@1", {
      userId: f.user.id,
      amount: Number.MAX_SAFE_INTEGER,
      source: "local-overflow",
    });
    await expect(f.paid((await f.order()).id)).rejects.toThrow();
    await expect(f.adjust("re_outbox", "succeeded", 100)).rejects.toThrow();
    expect(await f.wallet()).toMatchObject({
      balance: Number.MAX_SAFE_INTEGER,
      paymentHeld: 0,
    });
    const pending = await (
      await f.request(
        commerce + "/admin/outbox?status=pending",
        "GET",
        undefined,
        f.admin,
      )
    ).json();
    expect(pending.items[0]).toMatchObject({ delivered: 0, debit: 1000000 });
    await f.request(
      billing + "/adjust",
      "POST",
      {
        userId: f.user.id,
        amount: -Number.MAX_SAFE_INTEGER,
        id: "release-local-overflow",
        reason: "Local recovery fixture",
      },
      f.admin,
    );
    for (let i = 0; i < 2; i++) {
      const response = await f.request(
        commerce + "/retry",
        "POST",
        { reason: "Retry verified local facts" },
        f.admin,
      );
      expect(response.status).toBe(200);
      await response.text();
    }
    expect(await f.wallet()).toMatchObject({
      balance: 4000000,
      paymentHeld: 0,
    });
  } finally {
    await f.close();
  }
});
