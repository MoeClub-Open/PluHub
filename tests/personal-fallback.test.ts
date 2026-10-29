import { it, expect, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./helpers.js";

async function setup(credit = 1_000_000) {
  let personalCalls = 0,
    paidCalls = 0;
  const f = await fixture(
    [
      "users",
      "auth",
      "ai-router",
      "billing",
      "byok",
      "rate-limit",
      "observability",
      "ingress-openai-chat",
      "upstream-openai-chat",
    ],
    { billing: { enabled: true } },
    async (kernel, directory) => {
      (globalThis as any).__fallbackTransport = (input: any) => {
        const body = JSON.parse(input.body);
        const text = body.messages.at(-1).content;
        const personal = input.url.includes("personal.example");
        personal ? personalCalls++ : paidCalls++;
        if (personal && text === "partial")
          return new Response(
            'data: {"choices":[{"index":0,"delta":{"content":"partial output"}}]}\n\ndata: {"error":{"message":"Stream failed"}}\n\n',
            { headers: { "content-type": "text/event-stream" } },
          );
        if (text === "unknown") throw Error("Connection lost after dispatch");
        if ((personal && text !== "ok") || text === "reject")
          return new Response("rejected", { status: 429 });
        return Response.json({
          choices: [
            {
              message: { content: personal ? "personal" : "paid" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        });
      };
      const dir = join(directory, "transport");
      await mkdir(dir);
      await writeFile(
        join(dir, "manifest.json"),
        JSON.stringify({
          schemaVersion: 1,
          id: "test.fallback-transport",
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
        'export default {setup(h){h.provide("http.transport@1",i=>globalThis.__fallbackTransport(i));}}',
      );
      await kernel.add(dir, { grants: [] });
    },
  );
  const admin = await f.admin();
  const me = await (
    await f.request("/api/plugins/official.auth/me", "GET", undefined, admin)
  ).json();
  process.env.PLUHUB_TEST_UPSTREAM_KEY = "platform-only";
  const config: any = {
    upstreams: {
      paid: {
        protocol: "openai-chat",
        baseUrl: "https://paid.example/v1",
        keyRef: "env:PLUHUB_TEST_UPSTREAM_KEY",
        consumptionMultiplier: 0.5,
      },
    },
    models: {
      "paid-model": {
        upstream: "paid",
        model: "vendor-paid",
        inputPrice: 5,
        outputPrice: 10,
      },
    },
    groups: {
      team: {
        name: "Team",
        channelIds: ["paid"],
        multiplier: 2,
        userIds: [me.id],
      },
      hidden: {
        name: "Hidden",
        channelIds: ["paid"],
        multiplier: 1,
        userIds: [],
      },
    },
  };
  f.kernel.configure({ "official.ai-router": config });
  if (credit)
    await f.kernel.invoke("billing.credit@1", {
      userId: me.id,
      amount: credit,
      source: "fallback-test",
    });
  const channel: any = {
    name: "Mine",
    preset: "custom",
    protocol: "openai-chat",
    baseUrl: "https://personal.example/v1",
    key: "personal-only",
    models: {
      "my-model": { model: "vendor-personal", inputPrice: 99, outputPrice: 99 },
    },
    flow: {
      entry: "s",
      nodes: [
        { id: "s", type: "start", next: "p" },
        { id: "p", type: "provider", fallback: "g" },
        { id: "g", type: "platform", groupId: "team", model: "paid-model" },
      ],
    },
  };
  const created = await f.request(
    "/api/plugins/official.byok/personal-channels",
    "POST",
    channel,
    admin,
  );
  expect(created.status).toBe(201);
  const saved = await created.json();
  const key = await (
    await f.request(
      "/api/plugins/official.auth/keys",
      "POST",
      {
        name: "Personal scope",
        channelIds: [saved.id],
        groupId: null,
        models: ["my-model"],
        requestsPerMinute: 1,
      },
      admin,
    )
  ).json();
  const invoke = (text: string, platform = false, stream = false) =>
    f.request(
      "/v1/chat/completions",
      "POST",
      {
        model: platform ? "paid-model" : "my-model",
        messages: [{ role: "user", content: text }],
        max_tokens: 8,
        stream,
      },
      platform
        ? admin
        : {
            authorization: "Bearer " + key.token,
            "x-pluhub-channel": saved.id,
          },
    );
  return {
    ...f,
    admin,
    me,
    channel,
    saved,
    config,
    invoke,
    balance: () => f.kernel.invoke<any>("billing.balance@1", { userId: me.id }),
    calls: () => ({ personalCalls, paidCalls }),
  };
}

it("falls back from a personal key to its authorized paid group exactly once and bills the selected route", async () => {
  const f = await setup();
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  try {
    const first = await f.invoke("ok");
    expect(first.status).toBe(200);
    expect((await first.json()).choices[0].message.content).toBe("personal");
    expect((await f.balance()).balance).toBe(1_000_000);
    now += 60000;
    const fallback = await f.invoke("fallback");
    expect(fallback.status).toBe(200);
    expect((await fallback.json()).choices[0].message.content).toBe("paid");
    expect(await f.balance()).toMatchObject({ balance: 999965, held: 0 });
    expect(f.calls()).toEqual({ personalCalls: 2, paidCalls: 1 });
    const limited = await f.invoke("fallback");
    expect(limited.status).toBe(429);
    await limited.text();
    expect(f.calls()).toEqual({ personalCalls: 2, paidCalls: 1 });
    const denied = await f.request(
      "/api/plugins/official.byok/personal-channels",
      "POST",
      {
        ...f.channel,
        flow: {
          entry: "s",
          nodes: [
            { id: "s", type: "start", next: "g" },
            {
              id: "g",
              type: "platform",
              groupId: "hidden",
              model: "paid-model",
            },
          ],
        },
      },
      f.admin,
    );
    expect(denied.status).toBe(403);
    await denied.text();
    now += 60000;
    const partial = await f.invoke("partial", false, true);
    expect(partial.status).toBe(200);
    expect(await partial.text()).toContain("partial output");
    expect(f.calls().paidCalls).toBe(1);
    now += 60000;
    const changed = await f.request(
      "/api/plugins/official.byok/personal-channels",
      "PUT",
      {
        ...f.channel,
        id: f.saved.id,
        revision: f.saved.revision,
        flow: {
          entry: "s",
          nodes: [
            { id: "s", type: "start", next: "g" },
            { id: "g", type: "platform", groupId: "team", model: "paid-model" },
          ],
        },
      },
      f.admin,
    );
    expect(changed.status).toBe(200);
    await changed.json();
    const direct = await f.invoke("ok");
    expect(direct.status).toBe(200);
    await direct.json();
    expect(await f.balance()).toMatchObject({ balance: 999930, held: 0 });
    const test = await f.request(
      "/api/plugins/official.byok/personal-channels/test",
      "POST",
      { id: f.saved.id, model: "my-model" },
      f.admin,
    );
    expect(test.status).toBe(200);
    await test.json();
    expect(await f.balance()).toMatchObject({ balance: 999895, held: 0 });
  } finally {
    clock.mockRestore();
    await f.close();
    delete (globalThis as any).__fallbackTransport;
  }
});
it("does not require platform funds for the personal primary and stops a paid fallback when funds are insufficient", async () => {
  const f = await setup(0);
  let now = Date.now();
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  try {
    const ok = await f.invoke("ok");
    expect(ok.status).toBe(200);
    await ok.json();
    now += 60000;
    const fail = await f.invoke("fallback");
    expect(fail.status).toBe(402);
    await fail.text();
    expect(f.calls()).toEqual({ personalCalls: 2, paidCalls: 0 });
    expect(await f.balance()).toMatchObject({ balance: 0, held: 0 });
  } finally {
    clock.mockRestore();
    await f.close();
    delete (globalThis as any).__fallbackTransport;
  }
});
it("releases definite upstream refusals but settles uncertain transport failures at the reserved amount", async () => {
  const f = await setup();
  try {
    const rejected = await f.invoke("reject", true);
    expect(rejected.status).toBe(429);
    await rejected.text();
    expect(await f.balance()).toMatchObject({ balance: 1_000_000, held: 0 });
    delete process.env.PLUHUB_TEST_UPSTREAM_KEY;
    const missingKey = await f.invoke("ok", true);
    expect(missingKey.status).toBeGreaterThanOrEqual(400);
    await missingKey.text();
    expect((await f.balance()).held).toBe(0);
    process.env.PLUHUB_TEST_UPSTREAM_KEY = "platform-only";
    const unknown = await f.invoke("unknown", true);
    expect(unknown.status).toBeGreaterThanOrEqual(500);
    await unknown.text();
    expect((await f.balance()).held).toBe(0);
    expect((await f.balance()).balance).toBeLessThan(1_000_000);
  } finally {
    await f.close();
    delete (globalThis as any).__fallbackTransport;
  }
});
