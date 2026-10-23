import { it, expect } from "vitest";
import { createServer } from "node:http";
import { fixture } from "./helpers.js";

it("releases request slots after repeated HTTP stream cancellation and serves concurrent follow-up traffic", async () => {
  let active = 0;
  let peak = 0;
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString());
    active++;
    peak = Math.max(peak, active);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      'data: {"choices":[{"index":0,"delta":{"content":"first"}}]}\n\n',
    );
    // Keep cancellation fixtures open until abort reaches the upstream. A fast
    // provider may otherwise finish legitimately before the client disconnects.
    const timer =
      input.messages[0].content === "cancel"
        ? undefined
        : setTimeout(
            () =>
              response.end(
                'data: {"choices":[{"index":0,"delta":{"content":"last"},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":2}}\n\ndata: [DONE]\n\n',
              ),
            15,
          );
    response.once("close", () => {
      clearTimeout(timer);
      active--;
    });
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const address = upstream.address() as { port: number };
  const oldKey = process.env.PLUHUB_TEST_UPSTREAM_KEY;
  process.env.PLUHUB_TEST_UPSTREAM_KEY = "load-test-only";
  const f = await fixture(
    [
      "listener",
      "http-transport",
      "users",
      "auth",
      "ai-router",
      "observability",
      "rate-limit",
      "ingress-openai-chat",
      "upstream-openai-chat",
    ],
    {
      "ai-router": {
        upstreams: {
          local: {
            protocol: "openai-chat",
            baseUrl: "http://127.0.0.1:" + address.port,
            keyRef: "env:PLUHUB_TEST_UPSTREAM_KEY",
          },
        },
        models: { demo: { upstream: "local", model: "local" } },
      },
      "rate-limit": { user: { concurrency: 5 } },
    },
  );
  try {
    const admin = await f.admin();
    const key = await (
      await f.request(
        "/api/plugins/official.auth/keys",
        "POST",
        { name: "load-test" },
        admin,
      )
    ).json();
    const listener = await f.kernel.invoke<{ port: number }>(
      "listener.address@1",
    );
    const url = "http://127.0.0.1:" + listener.port + "/v1/chat/completions";
    const once = async (cancel: boolean) => {
      const controller = new AbortController();
      const response = await fetch(url, {
        method: "POST",
        headers: {
          authorization: "Bearer " + key.token,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "demo",
          messages: [{ role: "user", content: cancel ? "cancel" : "test" }],
          stream: true,
          max_tokens: 8,
        }),
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      if (cancel) {
        const reader = response.body!.getReader();
        expect((await reader.read()).done).toBe(false);
        controller.abort();
        await reader.cancel().catch(() => {});
      } else {
        expect(await response.text()).toContain("[DONE]");
      }
    };
    for (let batch = 0; batch < 20; batch++) {
      await Promise.all(Array.from({ length: 5 }, () => once(batch < 4)));
      await expect
        .poll(
          async () =>
            (
              await (
                await f.request(
                  "/api/plugins/official.rate-limit/status",
                  "GET",
                  undefined,
                  admin,
                )
              ).json()
            ).active,
        )
        .toBe(0);
    }
    await once(false);
    await expect.poll(() => active).toBe(0);
    expect(peak).toBeLessThanOrEqual(5);
    const summary = await (
      await f.request(
        "/api/plugins/official.observability/summary",
        "GET",
        undefined,
        admin,
      )
    ).json();
    expect(summary.requests).toBe(101);
    expect(summary.successes).toBe(81);
    expect(summary.cancelled).toBe(20);
    expect(summary.errors).toBe(0);
  } finally {
    await f.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    if (oldKey === undefined) delete process.env.PLUHUB_TEST_UPSTREAM_KEY;
    else process.env.PLUHUB_TEST_UPSTREAM_KEY = oldKey;
  }
});
