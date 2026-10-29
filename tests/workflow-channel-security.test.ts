import { createServer } from "node:http";
import { expect, it } from "vitest";
import { fixture } from "./helpers.js";

it("keeps a channel-bound key out of a personal workflow target while retaining authorized personal fallback", async () => {
  const calls: { path: string; model: string }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls.push({ path: request.url!, model: body.model });
    if (request.url!.startsWith("/personal/")) {
      response.writeHead(429).end("rejected");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        choices: [
          { message: { content: "platform fallback" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const f = await fixture(
    [
      "users",
      "auth",
      "ai-router",
      "byok",
      "billing",
      "observability",
      "rate-limit",
      "http-transport",
      "upstream-openai-chat",
      "ingress-openai-chat",
    ],
    {
      "upstream-openai-chat": { secretRefs: [] },
      byok: { allowedPrivateOrigins: [origin] },
    },
  );
  try {
    const admin = await f.admin();
    const user = await f.kernel.invoke<any>("users.manage@1", {
      action: "create",
      username: "channel-workflow-user",
      role: "user",
    });
    await f.kernel.invoke("auth.bootstrap@1", {
      userId: user.id,
      password: "workflow-user-password",
    });
    const login = await f.request("/api/plugins/official.auth/login", "POST", {
      username: "channel-workflow-user",
      password: "workflow-user-password",
    });
    const session = { cookie: login.headers.get("set-cookie")!.split(";")[0]! };
    await login.text();

    const config = await (
      await f.request(
        "/api/plugins/official.ai-router/configuration",
        "GET",
        undefined,
        admin,
      )
    ).json();
    config.config.upstreams = {
      paid: {
        flow: {
          entry: "start",
          nodes: [
            { id: "start", type: "start", next: ["call"] },
            {
              id: "call",
              type: "provider",
              modelMap: { "paid-upstream": "paid-upstream" },
              upstream: {
                protocol: "openai-chat",
                baseUrl: `${origin}/platform/v1`,
                keyRef: "platform-test-key",
              },
            },
          ],
        },
      },
    };
    config.config.models = {
      "paid-model": {
        upstream: "paid",
        model: "paid-upstream",
        inputPrice: 5,
        outputPrice: 10,
      },
    };
    let saved = await f.request(
      "/api/plugins/official.ai-router/configuration",
      "PUT",
      config,
      admin,
    );
    expect(saved.status, await saved.clone().text()).toBe(200);

    const created = await f.request(
      "/api/plugins/official.byok/personal-channels",
      "POST",
      {
        name: "Personal",
        preset: "custom",
        protocol: "openai-chat",
        baseUrl: `${origin}/personal/v1`,
        key: "personal-test-key",
        models: { "personal-model": { model: "personal-upstream" } },
        flow: {
          entry: "s",
          nodes: [
            { id: "s", type: "start", next: ["p"] },
            { id: "p", type: "provider", fallback: "g" },
            {
              id: "g",
              type: "platform",
              channelId: "paid",
              model: "paid-model",
            },
          ],
        },
      },
      session,
    );
    expect(created.status, await created.clone().text()).toBe(201);
    const channel = await created.json();

    const updated = await (
      await f.request(
        "/api/plugins/official.ai-router/configuration",
        "GET",
        undefined,
        admin,
      )
    ).json();
    updated.config.upstreams.workflow = {
      flow: {
        entry: "s",
        nodes: [
          { id: "s", type: "start", next: ["result"] },
          {
            id: "personal-call",
            type: "llm",
            model: "personal-model",
            channelId: channel.id,
            promptMode: "append",
          },
          { id: "result", type: "response", text: "" },
        ],
        bindings: [
          {
            source: "personal-call",
            output: "text",
            target: "result",
            input: "text",
          },
        ],
      },
    };
    updated.config.models.workflow = {
      upstream: "workflow",
      model: "workflow",
      inputPrice: 1,
      outputPrice: 1,
    };
    saved = await f.request(
      "/api/plugins/official.ai-router/configuration",
      "PUT",
      updated,
      admin,
    );
    expect(saved.status, await saved.clone().text()).toBe(200);
    f.kernel.configure({ "official.billing": { enabled: true } });
    await f.kernel.invoke("billing.credit@1", {
      userId: user.id,
      amount: 1_000_000,
      source: "channel-workflow-test",
    });

    const platformResponse = await f.request(
      "/api/plugins/official.auth/keys",
      "POST",
      {
        name: "Platform key",
        channelIds: ["paid", "workflow"],
        models: ["workflow", "personal-model"],
      },
      session,
    );
    expect(platformResponse.status, await platformResponse.clone().text()).toBe(
      201,
    );
    const platformKey = await platformResponse.json();
    const blocked = await f.request(
      "/v1/chat/completions",
      "POST",
      {
        model: "workflow",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 16,
      },
      { authorization: `Bearer ${platformKey.token}` },
    );
    expect(blocked.status, await blocked.clone().text()).toBe(403);
    expect((await blocked.json()).error.code).toBe("channel_forbidden");
    expect(calls).toEqual([]);
    expect(
      await f.kernel.invoke<any>("billing.balance@1", { userId: user.id }),
    ).toMatchObject({ balance: 1_000_000, held: 0 });

    const personalResponse = await f.request(
      "/api/plugins/official.auth/keys",
      "POST",
      {
        name: "Personal key",
        channelIds: [channel.id],
        models: ["personal-model"],
      },
      session,
    );
    expect(personalResponse.status, await personalResponse.clone().text()).toBe(
      201,
    );
    const personalKey = await personalResponse.json();
    const response = await f.request(
      "/v1/chat/completions",
      "POST",
      {
        model: "personal-model",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 16,
      },
      {
        authorization: `Bearer ${personalKey.token}`,
        "x-pluhub-channel": channel.id,
      },
    );
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await response.json()).choices[0].message.content).toBe(
      "platform fallback",
    );
    expect(calls).toEqual([
      { path: "/personal/v1/chat/completions", model: "personal-upstream" },
      { path: "/platform/v1/chat/completions", model: "paid-upstream" },
    ]);
    expect(
      await f.kernel.invoke<any>("billing.balance@1", { userId: user.id }),
    ).toMatchObject({ balance: 999_965, held: 0 });
  } finally {
    await f.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
