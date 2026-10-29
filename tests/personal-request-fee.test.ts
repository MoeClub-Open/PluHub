import { expect, it, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./helpers.js";

it("charges only the frozen personal handling fee, releases rejected attempts and records ledger audiences", async () => {
  let calls = 0;
  const f = await fixture(
    [
      "users",
      "auth",
      "ai-router",
      "billing",
      "byok",
      "observability",
      "model-catalog",
      "rate-limit",
      "ingress-openai-chat",
      "upstream-openai-chat",
    ],
    { billing: { enabled: true, personalRequestFee: 0.002 } },
    async (kernel, directory) => {
      (globalThis as any).__personalFeeTransport = (input: any) => {
        calls++;
        const body = JSON.parse(input.body);
        if (body.messages.at(-1).content === "reject")
          return new Response("rejected", { status: 429 });
        if (body.stream)
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    'data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n',
                  ),
                );
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        return Response.json({
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10000, completion_tokens: 1000 },
        });
      };
      const dir = join(directory, "transport");
      await mkdir(dir);
      await writeFile(
        join(dir, "manifest.json"),
        JSON.stringify({
          schemaVersion: 1,
          id: "test.personal-fee-transport",
          version: "1.0.0",
          host: ">=0.1.0-alpha.1",
          runtime: { kind: "native", entry: "index.js" },
          provides: ["http.transport@1"],
          requires: [],
          permissions: [],
          configReload: "snapshot",
        }),
      );
      await writeFile(
        join(dir, "index.js"),
        'export default {setup(h){h.provide("http.transport@1",i=>globalThis.__personalFeeTransport(i));}}',
      );
      await kernel.add(dir, { grants: [] });
    },
  );
  try {
    const admin = await f.admin();
    const user = await (
      await f.request("/api/plugins/official.auth/me", "GET", undefined, admin)
    ).json();
    const created = await f.request(
      "/api/plugins/official.byok/personal-channels",
      "POST",
      {
        name: "Mine",
        preset: "custom",
        protocol: "openai-chat",
        baseUrl: "https://fee.example/v1",
        key: "test-key",
        models: {
          mine: { model: "native", inputPrice: 999, outputPrice: 999 },
        },
      },
      admin,
    );
    expect(created.status, await created.clone().text()).toBe(201);
    const channel = await created.json();
    const invoke = (text: string, stream = false) =>
      f.request(
        "/v1/chat/completions",
        "POST",
        {
          model: "mine",
          messages: [{ role: "user", content: text }],
          stream,
        },
        { ...admin, "x-pluhub-channel": channel.id },
      );
    const balance = () =>
      f.kernel.invoke<any>("billing.balance@1", { userId: user.id });
    const denied = await invoke("no balance");
    expect(denied.status).toBe(402);
    await denied.text();
    expect(calls).toBe(0);
    await f.kernel.invoke("billing.credit@1", {
      userId: user.id,
      amount: 1000000,
      source: "gift:test",
    });
    expect(
      await f.kernel.invoke("billing.customer-status@1", { userId: user.id }),
    ).toEqual({ paid: false, consumed: false });
    const first = await invoke("ok");
    expect(first.status, await first.clone().text()).toBe(200);
    await first.json();
    expect(await balance()).toMatchObject({ balance: 998000, held: 0 });
    expect(
      await f.kernel.invoke("billing.customer-status@1", { userId: user.id }),
    ).toEqual({ paid: false, consumed: true });
    const quote = await f.request(
      "/api/plugins/official.billing/quote",
      "POST",
      {
        model: "mine",
        channelId: channel.id,
        usage: { input: 10000, output: 1000 },
      },
      admin,
    );
    expect(quote.status).toBe(200);
    expect(await quote.json()).toMatchObject({
      amount: 2000,
      lines: [{ kind: "serviceFee", quantity: 1, rate: 0.002 }],
    });
    const rejected = await invoke("reject");
    expect(rejected.status).toBe(429);
    await rejected.text();
    expect(await balance()).toMatchObject({ balance: 998000, held: 0 });
    const cancelled = await invoke("cancel", true);
    const reader = cancelled.body!.getReader();
    await reader.read();
    f.kernel.configure({
      "official.billing": { enabled: true, personalRequestFee: 0.003 },
    });
    await reader.cancel();
    await vi.waitFor(async () =>
      expect(await balance()).toMatchObject({ balance: 996000, held: 0 }),
    );
    const ledger = await (
      await f.request(
        "/api/plugins/official.billing/ledger",
        "GET",
        undefined,
        admin,
      )
    ).json();
    expect(
      ledger
        .filter((row: any) => row.source.startsWith("request:"))
        .map((row: any) => row.amount),
    ).toEqual([-2000, -2000]);
    const summary = await (
      await f.request(
        "/api/plugins/official.observability/summary",
        "GET",
        undefined,
        admin,
      )
    ).json();
    expect(summary.wallet.chargedUSD).toBe(0.004);
    await f.kernel.invoke("billing.payment-state@1", {
      userId: user.id,
      source: "payment:test:confirmed",
      credit: 1000,
      debit: 0,
      hold: 0,
      revision: 1,
    });
    expect(
      await f.kernel.invoke("billing.customer-status@1", { userId: user.id }),
    ).toEqual({ paid: true, consumed: true });
    f.kernel.configure({
      "official.billing": { enabled: true, personalRequestFee: 0 },
    });
    const free = await invoke("free");
    expect(free.status).toBe(200);
    await free.text();
    expect(await balance()).toMatchObject({ balance: 997000, held: 0 });
  } finally {
    await f.close();
  }
});
