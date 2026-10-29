import { expect, it } from "vitest";
import { fixture } from "./helpers.js";

it("keeps default platform keys out of personal channels and allows explicit owned-channel bindings", async () => {
  const f = await fixture(
    [
      "users",
      "auth",
      "ai-router",
      "byok",
      "rate-limit",
      "http-transport",
      "upstream-openai-chat",
      "ingress-openai-chat",
    ],
    { "upstream-openai-chat": { secretRefs: [] } },
  );
  try {
    const admin = await f.admin();
    const created = await f.request(
      "/api/plugins/official.byok/personal-channels",
      "POST",
      {
        name: "Personal scope",
        preset: "custom",
        protocol: "openai-chat",
        baseUrl: "https://api.example.com/v1",
        key: "personal-test-key",
        models: { personal: { model: "provider-model" } },
      },
      admin,
    );
    expect(created.status, await created.clone().text()).toBe(201);
    const channel = await created.json();
    const invalid = await f.request(
      "/api/plugins/official.auth/keys",
      "POST",
      {
        name: "Invalid scope",
        unsupportedScope: "anything",
      },
      admin,
    );
    expect(invalid.status).toBe(400);
    await invalid.text();
    const defaultResponse = await f.request(
      "/api/plugins/official.auth/keys",
      "POST",
      { name: "Platform scope" },
      admin,
    );
    expect(defaultResponse.status, await defaultResponse.clone().text()).toBe(
      201,
    );
    const platform = await defaultResponse.json();
    const headers = {
      authorization: "Bearer " + platform.token,
      "x-pluhub-channel": channel.id,
    };
    const list = await f.request("/v1/models", "GET", undefined, headers);
    expect(list.status).toBe(403);
    await list.text();
    const call = await f.request(
      "/v1/chat/completions",
      "POST",
      {
        model: "personal",
        messages: [{ role: "user", content: "hello" }],
      },
      headers,
    );
    expect(call.status).toBe(403);
    expect((await call.json()).error.code).toBe("channel_forbidden");
    const scopedResponse = await f.request(
      "/api/plugins/official.auth/keys",
      "POST",
      {
        name: "Personal scope",
        channelIds: [channel.id],
      },
      admin,
    );
    expect(scopedResponse.status, await scopedResponse.clone().text()).toBe(
      201,
    );
    const scoped = await scopedResponse.json();
    const own = await f.request("/v1/models", "GET", undefined, {
      authorization: "Bearer " + scoped.token,
    });
    expect(own.status).toBe(200);
    expect((await own.json()).data.map((model: any) => model.id)).toEqual([
      "personal",
    ]);
    const outside = await f.request("/v1/models", "GET", undefined, {
      authorization: "Bearer " + scoped.token,
      "x-pluhub-channel": "outside",
    });
    expect(outside.status).toBe(403);
    await outside.text();
  } finally {
    await f.close();
  }
});
