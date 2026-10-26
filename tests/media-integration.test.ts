import { it, expect } from "vitest";
import { createServer } from "node:http";
import { fixture } from "./helpers.js";

it("routes media JSON, multipart and binary through auth, channel bindings, logs and 0.2x settlement", async () => {
  const prior = process.env.PLUHUB_TEST_UPSTREAM_KEY;
  process.env.PLUHUB_TEST_UPSTREAM_KEY = "media-test-upstream-only";
  const received: {
    path: string;
    model: string;
    headers: any;
    form?: FormData;
  }[] = [];
  let disconnected!: () => void;
  const cancelled = new Promise<void>((resolve) => {
    disconnected = resolve;
  });
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const form = req.headers["content-type"]?.includes("multipart/form-data")
      ? await new Response(bytes, {
          headers: { "content-type": req.headers["content-type"]! },
        }).formData()
      : undefined;
    const body = form ? Object.fromEntries(form) : JSON.parse(bytes.toString());
    received.push({
      path: req.url!,
      model: String(body.model),
      headers: req.headers,
      form,
    });
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        'data: {"type":"image_generation.partial_image","b64_json":"aW1hZ2U="}\n\n',
      );
      if (body.prompt !== "truncate")
        res.write(
          'data: {"type":"image_generation.completed","b64_json":"aW1hZ2U="}\n\n',
        );
      res.end();
      return;
    }
    if (body.input === "cancel") {
      res.writeHead(200, { "content-type": "audio/mpeg" });
      res.write(Buffer.from([1, 2]));
      res.once("close", disconnected);
      return;
    }
    if (req.url?.endsWith("speech")) {
      res.writeHead(200, { "content-type": "audio/mpeg" });
      res.end(Buffer.from([1, 2, 3, 255]));
    } else {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify(
          req.url?.includes("vector")
            ? {
                object: "list",
                model: body.model,
                data: [
                  { index: 0, object: "embedding", embedding: [0.1, 0.2] },
                ],
                usage: { prompt_tokens: 10, total_tokens: 10 },
              }
            : req.url?.includes("images")
              ? { created: 1, data: [{ b64_json: "aW1hZ2U=" }] }
              : {
                  text: "transcript",
                  usage: { type: "duration", seconds: 1.5 },
                },
        ),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const operations = [
    "embeddings",
    "images/generations",
    "images/edits",
    "audio/speech",
    "audio/transcriptions",
    "audio/translations",
  ];
  const f = await fixture(
    [
      "users",
      "auth",
      "billing",
      "ai-router",
      "observability",
      "http-transport",
      "upstream-openai-chat",
      "upstream-openai-media",
      "rate-limit",
      "ingress-openai-media",
    ],
    {
      billing: { enabled: true },
      "ai-router": {
        upstreams: {
          "1": {
            protocol: "openai-chat",
            baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
            keyRef: "env:PLUHUB_TEST_UPSTREAM_KEY",
            consumptionMultiplier: 0.2,
            interfaces: [
              {
                incoming: ["openai-chat"],
                protocol: "openai-chat",
                path: "/custom/chat",
                mediaPaths: { embeddings: "/v1/vector" },
              },
            ],
          },
        },
        models: Object.fromEntries(
          operations.map((op, i) => [
            "model" + i,
            {
              upstream: "1",
              model: "actual" + i,
              operations: [op],
              ...(i === 0
                ? { inputPrice: 2, outputPrice: 0 }
                : { pricing: { mode: "request", request: 0.04 } }),
            },
          ]),
        ),
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
      amount: 1000000,
      source: "media-test",
    });
    const keyResponse = await f.request(
      "/api/plugins/official.auth/keys",
      "POST",
      { name: "media", channelIds: ["1"] },
      admin,
    );
    expect(keyResponse.status).toBe(201);
    const key = await keyResponse.json();
    const authorization = "Bearer " + key.token;
    const embedding = await f.request(
      "/v1/embeddings",
      "POST",
      { model: "model0", input: ["hello", "world"], dimensions: 2 },
      { authorization },
    );
    expect(embedding.status, await embedding.clone().text()).toBe(200);
    expect(await embedding.json()).toMatchObject({
      model: "model0",
      data: [{ embedding: [0.1, 0.2] }],
      usage: { prompt_tokens: 10 },
    });
    for (const i of [1, 3]) {
      const result = await f.request(
        "/v1/" + operations[i],
        "POST",
        {
          model: "model" + i,
          ...(i === 1 ? { prompt: "cat" } : { input: "hello", voice: "alloy" }),
        },
        { authorization },
      );
      expect(result.status, await result.clone().text()).toBe(200);
      if (i === 3)
        expect([...new Uint8Array(await result.arrayBuffer())]).toEqual([
          1, 2, 3, 255,
        ]);
      else
        expect(await result.json()).toMatchObject({
          data: [{ b64_json: "aW1hZ2U=" }],
        });
    }
    for (const i of [2, 4, 5]) {
      const form = new FormData();
      form.set("model", "model" + i);
      form.set("prompt", "edit this");
      form.set(
        i === 2 ? "image[]" : "file",
        new Blob([new Uint8Array([0, 255, 12])], {
          type: i === 2 ? "image/png" : "audio/wav",
        }),
        "source.bin",
      );
      form.append("timestamp_granularities[]", "word");
      form.append("timestamp_granularities[]", "segment");
      const result = await f.kernel.fetch(
        new Request("http://localhost/v1/" + operations[i], {
          method: "POST",
          headers: { authorization },
          body: form,
        }),
      );
      expect(result.status, await result.clone().text()).toBe(200);
      await result.text();
    }
    expect(received).toHaveLength(6);
    expect(received[0]!.path).toBe("/v1/vector");
    expect(
      received.every(
        (item) =>
          item.headers.authorization === "Bearer media-test-upstream-only" &&
          item.path.startsWith("/v1/"),
      ),
    ).toBe(true);
    expect(received.map((item) => item.model)).toEqual([
      "actual0",
      "actual1",
      "actual3",
      "actual2",
      "actual4",
      "actual5",
    ]);
    expect(received[3]!.form!.getAll("timestamp_granularities[]")).toEqual([
      "word",
      "segment",
    ]);
    expect([
      ...new Uint8Array(
        await (received[3]!.form!.get("image[]") as File).arrayBuffer(),
      ),
    ]).toEqual([0, 255, 12]);
    expect(
      await f.kernel.invoke("billing.balance@1", { userId: me.id }),
    ).toMatchObject({ balance: 959996, held: 0 });
    const forbidden = await f.request(
      "/v1/images/generations",
      "POST",
      { model: "model0", prompt: "cat" },
      { authorization },
    );
    expect(forbidden.status).toBe(400);
    const unauthenticated = await f.request("/v1/embeddings", "POST", {
      model: "model0",
      input: "hello",
    });
    expect(unauthenticated.status).toBe(401);
    expect(received).toHaveLength(6);
    const crossChannel = await f.request(
      "/v1/embeddings",
      "POST",
      { model: "model0", input: "hello" },
      { authorization, "x-pluhub-channel": "2" },
    );
    expect(crossChannel.status).toBe(403);
    await crossChannel.text();
    const logs = await (
      await f.request(
        "/api/plugins/official.observability/requests",
        "GET",
        undefined,
        admin,
      )
    ).json();
    expect(JSON.stringify(logs)).not.toContain("media-test-upstream-only");
    expect(JSON.stringify(logs)).toContain("images/generations");
    const stream = await f.request(
      "/v1/images/generations",
      "POST",
      { model: "model1", prompt: "cat", stream: true },
      { authorization },
    );
    expect(stream.status).toBe(200);
    expect(await stream.text()).toContain("image_generation.completed");
    const truncated = await f.request(
      "/v1/images/generations",
      "POST",
      { model: "model1", prompt: "truncate", stream: true },
      { authorization },
    );
    expect(truncated.status).toBe(200);
    await expect(truncated.text()).rejects.toThrow("completion");
    const slow = await f.request(
      "/v1/audio/speech",
      "POST",
      { model: "model3", input: "cancel", voice: "alloy" },
      { authorization },
    );
    const reader = slow.body!.getReader();
    await reader.read();
    await reader.cancel();
    await Promise.race([
      cancelled,
      new Promise((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Audio connection leaked")),
          1500,
        );
        timer.unref();
      }),
    ]);
    expect(
      await f.kernel.invoke("billing.balance@1", { userId: me.id }),
    ).toMatchObject({ balance: 951996, held: 16000 });
  } finally {
    await f.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    if (prior === undefined) delete process.env.PLUHUB_TEST_UPSTREAM_KEY;
    else process.env.PLUHUB_TEST_UPSTREAM_KEY = prior;
  }
}, 20000);
