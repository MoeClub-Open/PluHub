import { it, expect } from "vitest";
import { createServer } from "node:http";
import { fixture } from "./helpers.js";

it("keeps media selection scoped and settles Codex images and completed video jobs once", async () => {
  const previous = process.env.PLUHUB_TEST_UPSTREAM_KEY;
  process.env.PLUHUB_TEST_UPSTREAM_KEY = "media-fixture-key";
  const sent: any[] = [];
  let videoFailed = false;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const input = chunks.length
      ? JSON.parse(Buffer.concat(chunks).toString())
      : {};
    sent.push({ path: req.url, method: req.method, input });
    res.setHeader("content-type", "application/json");
    if (req.url?.endsWith("/responses")) {
      if (input.input?.[0]?.content?.some((p: any) => p.text === "reject")) {
        res.writeHead(400).end('{"error":{"message":"unsupported"}}');
        return;
      }
      const item = {
        id: "img-1",
        type: "image_generation_call",
        result: "aW1hZ2U=",
        output_format: "png",
      };
      res.setHeader("content-type", "text/event-stream");
      res.end(
        [
          {
            type: "response.output_item.added",
            item: { id: item.id, type: item.type },
          },
          { type: "response.output_item.done", item },
          {
            type: "response.completed",
            response: {
              output: [item],
              usage: { input_tokens: 8, output_tokens: 2 },
            },
          },
        ]
          .map((data) => "data: " + JSON.stringify(data) + "\n\n")
          .join(""),
      );
    } else if (req.method === "POST") {
      videoFailed = input.prompt === "fail";
      res.end('{"id":"video-1","status":"queued"}');
    } else if (req.url?.endsWith("/content")) {
      res.setHeader("content-type", "video/mp4");
      res.end("video-content");
    } else
      res.end(
        JSON.stringify({
          id: "video-1",
          status: videoFailed ? "failed" : "completed",
        }),
      );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as any).port}/v1`;
  const f = await fixture(
    [
      "users",
      "auth",
      "billing",
      "ai-router",
      "rate-limit",
      "http-transport",
      "upstream-openai-chat",
      "upstream-openai-media",
      "upstream-codex",
      "ingress-openai-media",
      "playground",
    ],
    {
      billing: { enabled: true },
      "ai-router": {
        upstreams: {
          "1": {
            protocol: "openai-chat",
            baseUrl,
            keyRef: "env:PLUHUB_TEST_UPSTREAM_KEY",
          },
          "2": {
            protocol: "codex",
            authMode: "cli",
            baseUrl,
            keyRef: "env:PLUHUB_TEST_UPSTREAM_KEY",
          },
        },
        models: {
          image: {
            upstream: "2",
            model: "gpt-image-2.5-sunburst",
            operations: ["images/generations"],
            pricing: { mode: "request", request: 0.04 },
          },
          video: {
            upstream: "1",
            model: "provider-video",
            operations: ["videos/generations"],
            pricing: { mode: "request", request: 0.04 },
          },
        },
      },
    },
  );
  try {
    const admin = await f.admin();
    const me = await (
      await f.request("/api/plugins/official.auth/me", "GET", undefined, admin)
    ).json();
    await f.kernel.invoke("billing.credit@1", {
      userId: me.id,
      amount: 1_000_000,
      source: "fixture",
    });
    for (const [operation, id] of [
      ["images", "image"],
      ["videos/generations", "video"],
    ]) {
      const models = await (
        await f.request(
          "/api/plugins/official.playground/models?operation=" + operation,
          "GET",
          undefined,
          admin,
        )
      ).json();
      expect(models.map((model: any) => model.id)).toEqual([id]);
    }
    const image = await f.request(
      "/v1/images/generations",
      "POST",
      { model: "image", prompt: "a cup" },
      admin,
    );
    expect(image.status, await image.clone().text()).toBe(200);
    expect((await image.json()).data).toHaveLength(1);
    expect(sent[0].input).toMatchObject({
      model: "gpt-6.1-sol",
      tools: [{ type: "image_generation", model: "gpt-image-2.5-sunburst" }],
    });
    const video = await f.request(
      "/v1/videos/generations",
      "POST",
      { model: "video", prompt: "moving cup", stream: false },
      admin,
    );
    expect(video.status, await video.clone().text()).toBe(200);
    expect(video.headers.get("content-type")).toBe("video/mp4");
    expect(await video.text()).toBe("video-content");
    expect(
      sent.find((r) => r.path === "/v1/videos" && r.method === "POST").input,
    ).not.toHaveProperty("stream");
    expect(
      await (
        await f.request(
          "/api/plugins/official.billing/wallet",
          "GET",
          undefined,
          admin,
        )
      ).json(),
    ).toMatchObject({ balance: 920000, held: 0 });
    const rejected = await f.request(
      "/v1/images/generations",
      "POST",
      { model: "image", prompt: "reject" },
      admin,
    );
    expect(rejected.status).toBe(502);
    expect(
      await (
        await f.request(
          "/api/plugins/official.billing/wallet",
          "GET",
          undefined,
          admin,
        )
      ).json(),
    ).toMatchObject({ balance: 920000, held: 0 });
    const failed = await f.request(
      "/v1/videos/generations",
      "POST",
      { model: "video", prompt: "fail" },
      admin,
    );
    expect(failed.status).toBe(502);
    expect(
      await (
        await f.request(
          "/api/plugins/official.billing/wallet",
          "GET",
          undefined,
          admin,
        )
      ).json(),
    ).toMatchObject({ balance: 920000, held: 40000 });
  } finally {
    await f.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env.PLUHUB_TEST_UPSTREAM_KEY;
    else process.env.PLUHUB_TEST_UPSTREAM_KEY = previous;
  }
});
