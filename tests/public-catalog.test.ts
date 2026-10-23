import { it, expect } from "vitest";
import { fixture } from "./helpers.js";

const publicPath = "/api/plugins/official.model-catalog/public";
const config = {
  upstreams: {
    live: {
      protocol: "openai-chat",
      baseUrl: "https://private-upstream.example",
      keyRef: "env:PRIVATE_UPSTREAM_KEY",
    },
    disabled: {
      protocol: "openai-chat",
      baseUrl: "https://disabled.example",
      keyRef: "env:PRIVATE_UPSTREAM_KEY",
      enabled: false,
    },
  },
  models: {
    standard: {
      upstream: "live",
      model: "vendor-private-target",
      name: "公开模型",
      provider: "Example",
      description: "适合写作",
      inputPrice: 2,
      outputPrice: 4,
      contextWindow: 128000,
    },
    hidden: { upstream: "live", model: "hidden-target", enabled: false },
    offline: { upstream: "disabled", model: "offline-target" },
  },
  redirects: { alias: { target: "standard", mode: "implicit" } },
};

it("publishes active platform model aliases and original prices without credentials or private bindings", async () => {
  const f = await fixture(
    [
      "http-transport",
      "users",
      "auth",
      "ai-router",
      "model-catalog",
      "upstream-openai-chat",
    ],
    { "ai-router": config },
  );
  try {
    const response = await f.request(
      publicPath + "?channel=personal:someone&userId=someone",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const models = await response.json();
    expect(models.map((model: any) => model.id)).toEqual(["standard", "alias"]);
    expect(models[0]).toEqual({
      id: "standard",
      name: "公开模型",
      provider: "Example",
      description: "适合写作",
      inputPrice: 2,
      outputPrice: 4,
      contextWindow: 128000,
      channel: { id: "live", name: "live", scope: "platform" },
      consumptionMultiplier: 1,
      billing: { input: 2, output: 4 },
      features: ["text", "tools", "stream", "usage"],
    });
    expect(JSON.stringify(models)).not.toMatch(
      /private-upstream|PRIVATE_UPSTREAM_KEY|keyRef|baseUrl|vendor-private-target|hidden-target|offline-target|orphan-target|upstream/,
    );
    expect(
      (await f.request("/api/plugins/official.model-catalog/models")).status,
    ).toBe(401);
    expect(
      (await f.request("/api/plugins/official.ai-router/channels")).status,
    ).toBe(401);
    expect((await f.request("/api/host/config")).status).toBe(401);
    expect((await f.request(publicPath, "POST", {})).status).toBe(404);
    f.kernel.configure({
      "official.ai-router": {
        ...config,
        upstreams: {
          ...config.upstreams,
          live: { ...config.upstreams.live, enabled: false },
        },
      },
    });
    expect(await (await f.request(publicPath)).json()).toEqual([]);
  } finally {
    await f.close();
  }
});

it("keeps personal channels out of public listings even with an authenticated owner or a channel-bound key", async () => {
  const f = await fixture(
    [
      "http-transport",
      "users",
      "auth",
      "ai-router",
      "model-catalog",
      "byok",
      "upstream-openai-chat",
    ],
    { "ai-router": config },
  );
  try {
    const admin = await f.admin();
    const created = await f.request(
      "/api/plugins/official.byok/personal-channels",
      "POST",
      {
        name: "Private personal channel",
        protocol: "openai-chat",
        baseUrl: "https://personal-upstream.example",
        key: "personal-private-token",
        models: {
          personalOnly: {
            model: "personal-private-target",
            inputPrice: 1,
            outputPrice: 2,
          },
        },
      },
      admin,
    );
    expect(created.status).toBe(201);
    const channel = await created.json();
    const privateModels = await (
      await f.request(
        "/api/plugins/official.model-catalog/models?channel=" +
          encodeURIComponent(channel.id),
        "GET",
        undefined,
        admin,
      )
    ).json();
    expect(privateModels.map((model: any) => model.id)).toEqual([
      "personalOnly",
    ]);
    const keyResponse = await f.request(
      "/api/plugins/official.auth/keys",
      "POST",
      { name: "Bound", channelIds: [channel.id] },
      admin,
    );
    expect(keyResponse.status).toBe(201);
    const key = await keyResponse.json();
    for (const headers of [
      {},
      admin,
      { authorization: "Bearer " + key.token },
    ]) {
      const list = await (
        await f.request(
          publicPath + "?channel=" + encodeURIComponent(channel.id),
          "GET",
          undefined,
          headers,
        )
      ).json();
      expect(list.map((model: any) => model.id)).toEqual(["standard", "alias"]);
      expect(JSON.stringify(list)).not.toMatch(
        /personalOnly|personal-private|personal-upstream|Private personal/,
      );
    }
  } finally {
    await f.close();
  }
});
