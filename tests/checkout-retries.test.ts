import { it, expect, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fixture } from "./helpers.js";
const api = "/api/plugins/official.commerce";
const product = {
  id: "credit",
  name: "Credits",
  currency: "usd",
  mode: "payment",
  paymentMinor: 500,
  creditMicros: 5000000,
};
async function setup() {
  let execute: (input: any) => Promise<any> = async () => ({
    url: "https://checkout.example.test/pay",
  });
  const calls: any[] = [];
  (globalThis as any).__auditCheckout = async (input: any) => {
    if (input.action === "status") return { enabled: true };
    calls.push(input);
    return execute(input);
  };
  const f = await fixture(
    ["users", "auth", "billing", "commerce"],
    {
      commerce: {
        publicUrl: "http://localhost",
        products: [product, { ...product, id: "other" }],
      },
    },
    async (kernel, dir) => {
      const path = join(dir, "fake-checkout");
      await mkdir(path);
      await writeFile(
        join(path, "manifest.json"),
        JSON.stringify({
          schemaVersion: 1,
          id: "test.checkout",
          version: "1.0.0",
          host: ">=0.1.0-alpha.1",
          runtime: { kind: "native", entry: "index.mjs" },
          provides: ["payments.stripe@1"],
          requires: [],
          permissions: [],
        }),
      );
      await writeFile(
        join(path, "index.mjs"),
        'export default {setup(h){h.provide("payments.stripe@1",i=>globalThis.__auditCheckout(i));}};',
      );
      await kernel.add(path);
    },
  );
  const admin = await f.admin();
  const order = (nonce: string, productId = "credit") =>
    f.request(
      api + "/checkout",
      "POST",
      { provider: "stripe", productId },
      { ...admin, "idempotency-key": nonce },
    );
  const history = async (query = "") =>
    await (
      await f.request(api + "/orders/history?" + query, "GET", undefined, admin)
    ).json();
  return {
    ...f,
    admin,
    calls,
    order,
    history,
    execute(fn: typeof execute) {
      execute = fn;
    },
  };
}
it("coalesces concurrent checkout retries and rejects reuse for another product", async () => {
  const f = await setup();
  try {
    let release: () => void = () => {};
    f.execute(async () => {
      await new Promise<void>((done) => (release = done));
      return { url: "https://checkout.example.test/pay" };
    });
    const pending = Array.from({ length: 8 }, () => f.order("one-request"));
    await vi.waitFor(() => expect(f.calls).toHaveLength(1));
    release();
    const responses = await Promise.all(pending);
    const bodies = await Promise.all(
      responses.map(async (r) => {
        expect(r.status).toBe(200);
        return r.json();
      }),
    );
    expect(new Set(bodies.map((b) => b.id)).size).toBe(1);
    expect((await f.history()).total).toBe(1);
    const repeated = await f.order("one-request");
    expect((await repeated.json()).id).toBe(bodies[0].id);
    expect(f.calls).toHaveLength(1);
    const conflict = await f.order("one-request", "other");
    expect(conflict.status).toBe(409);
    await conflict.text();
    const invalid = await f.order("invalid nonce");
    expect(invalid.status).toBe(400);
    await invalid.text();
  } finally {
    await f.close();
  }
});
it("reuses the same order and price snapshot after a gateway timeout", async () => {
  const f = await setup();
  try {
    f.execute(async () => {
      throw new Error("simulated gateway timeout");
    });
    const failed = await f.order("retry-timeout");
    expect(failed.status).toBeGreaterThanOrEqual(500);
    await failed.text();
    const original = (await f.history()).items[0];
    expect(original.status).toBe("failed");
    f.kernel.configure({
      "official.commerce": {
        publicUrl: "http://localhost",
        products: [{ ...product, paymentMinor: 900 }],
      },
    });
    f.execute(async () => ({ url: "https://checkout.example.test/pay" }));
    const retry = await f.order("retry-timeout");
    expect(retry.status).toBe(200);
    expect((await retry.json()).id).toBe(original.id);
    expect(f.calls.map((c) => c.orderId)).toEqual([original.id, original.id]);
    expect(f.calls[1].product.paymentMinor).toBe(500);
    expect((await f.history()).items[0].status).toBe("pending");
  } finally {
    await f.close();
  }
});
it("does not overwrite an already paid order when the checkout response is lost", async () => {
  const f = await setup();
  try {
    f.execute(async (input) => {
      await f.kernel.invoke("commerce.payment@1", {
        provider: "stripe",
        eventId: "evt-early",
        paymentId: "pi-early",
        orderId: input.orderId,
        amount: 500,
        currency: "usd",
        kind: "paid",
      });
      throw new Error("checkout response lost after payment notification");
    });
    const failed = await f.order("early-payment");
    expect(failed.status).toBeGreaterThanOrEqual(500);
    await failed.text();
    expect((await f.history()).items[0].status).toBe("paid");
    const retry = await f.order("early-payment");
    expect(retry.status).toBe(200);
    await retry.json();
    expect(f.calls).toHaveLength(1);
    const ledger = await (
      await f.request(
        "/api/plugins/official.billing/ledger",
        "GET",
        undefined,
        f.admin,
      )
    ).json();
    expect(ledger).toHaveLength(1);
    expect(ledger[0].amount).toBe(5000000);
  } finally {
    await f.close();
  }
});
it("queries the complete order history rather than filtering a truncated client list", async () => {
  const f = await setup();
  try {
    const me = await (
      await f.request(
        "/api/plugins/official.auth/me",
        "GET",
        undefined,
        f.admin,
      )
    ).json();
    const db = new DatabaseSync(
      join(f.config.dataDir, "official.commerce/commerce.sqlite"),
    );
    const insert = db.prepare(
      "INSERT INTO orders(id,user_id,provider,product,status,created_at) VALUES(?,?,'stripe',?,'paid',?)",
    );
    db.exec("BEGIN");
    for (let i = 0; i < 125; i++)
      insert.run(
        "historical-" + String(i).padStart(3, "0"),
        me.id,
        JSON.stringify(product),
        Date.now() + i,
      );
    db.exec("COMMIT");
    db.close();
    expect((await f.history("limit=20&offset=120")).items).toHaveLength(5);
    expect((await f.history("q=historical-000")).items[0].id).toBe(
      "historical-000",
    );
    expect((await f.history("status=pending")).total).toBe(0);
    expect((await f.history("q=%25")).total).toBe(0);
  } finally {
    await f.close();
  }
});
