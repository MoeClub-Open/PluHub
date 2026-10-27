import { expect, it } from "vitest";
import { fixture } from "./helpers.js";

it("keeps group keys and personal-channel keys in separate scopes", async () => {
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
    const channel = (await created.json()) as { id: string };

    const mixed = await f.request(
      "/api/plugins/official.auth/keys",
      "POST",
      {
        name: "Invalid mixed scope",
        groupId: "default",
        channelIds: [channel.id],
      },
      admin,
    );
    expect(mixed.status).toBe(400);
    await mixed.text();

    const keyResponse = await f.request(
      "/api/plugins/official.auth/keys",
      "POST",
      {
        name: "Group scope",
        groupId: "default",
      },
      admin,
    );
    expect(keyResponse.status, await keyResponse.clone().text()).toBe(201);
    const key = (await keyResponse.json()) as { token: string };
    const headers = {
      authorization: "Bearer " + key.token,
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
  } finally {
    await f.close();
  }
});
