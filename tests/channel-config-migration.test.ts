import { it, expect } from "vitest";
import {
  migrateLegacyChannels,
  defaultChannelFlow,
} from "../deploy/migrations/channel-graphs.ts";
import { compileWorkflow } from "../lib/ai/channel-graph.js";

it("moves channel quotas and model pacing into graphs without losing defaults, custom tokenizers or orphan rules", () => {
  const config: any = {
    plugins: [
      {
        path: "/plugins/ai-router",
        config: {
          upstreams: { c: { flow: defaultChannelFlow() } },
          models: { public: { upstream: "c", model: "vendor" } },
        },
      },
      {
        path: "/plugins/rate-limit",
        config: {
          user: { rpm: 100 },
          channels: { c: { rpm: 2, concurrency: 1 }, missing: { rpm: 5 } },
        },
      },
      {
        path: "/plugins/token-speed",
        config: {
          default: { tps: 10, tokenizer: "o200k_base" },
          models: [
            {
              channel: "c",
              model: "vendor",
              tps: 50,
              aggregateTps: 100,
              tokenizer: "custom",
            },
            {
              channel: "missing",
              model: "v",
              tps: 20,
              tokenizer: "o200k_base",
            },
          ],
          tokenizers: { custom: { kind: "tiktoken", encoding: "cl100k_base" } },
        },
      },
    ],
  };
  const original = structuredClone(config);
  expect(migrateLegacyChannels(config)).toBe(true);
  const flow = config.plugins[0].config.upstreams.c.flow;
  expect(() => compileWorkflow(flow)).not.toThrow();
  expect(flow.nodes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "rateLimit",
        rule: { rpm: 2, concurrency: 1 },
      }),
      expect.objectContaining({
        type: "tps",
        model: "vendor",
        rate: 50,
        aggregateRate: 100,
        tokenizer: "custom",
        inheritDefault: false,
      }),
    ]),
  );
  expect(config.plugins[1].config).toEqual({
    user: { rpm: 100 },
    channels: { missing: { rpm: 5 } },
  });
  expect(config.plugins[2].config.default).toEqual(
    original.plugins[2].config.default,
  );
  expect(config.plugins[2].config.tokenizers).toEqual(
    original.plugins[2].config.tokenizers,
  );
  expect(config.plugins[2].config.models).toEqual([
    original.plugins[2].config.models[1],
  ]);
  expect(migrateLegacyChannels(config)).toBe(false);
});

it("migrates multi-profile legacy channels without changing aliases, pricing or shared profiles", () => {
  const flow = (target: string) => ({
    entry: "s",
    nodes: [
      { id: "s", type: "start", next: "u" },
      { id: "u", type: "upstream", target, mode: "implicit" },
    ],
  });
  const config: any = {
    plugins: [
      {
        path: "C:\\plugins\\official.ai-router",
        config: {
          upstreams: {
            c: { protocol: "workflow", name: "Legacy" },
            "c-graph-1": { protocol: "auto-router" },
          },
          models: {
            a: { upstream: "c", model: "one", inputPrice: 2, outputPrice: 4 },
            b: { upstream: "c", model: "two" },
            x: { upstream: "c", model: "one" },
          },
          redirects: { alias: { target: "a", mode: "explicit" } },
        },
      },
      {
        path: "/plugins/workflow",
        config: { flows: { one: flow("physical"), two: flow("smart") } },
      },
    ],
  };
  const original = structuredClone(config);
  expect(migrateLegacyChannels(config)).toBe(true);
  const router = config.plugins[0].config;
  expect(router.upstreams.c).toEqual({
    name: "Legacy",
    flow: flow("physical"),
  });
  expect(router.models.a).toEqual(original.plugins[0].config.models.a);
  expect(router.models.x.upstream).toBe("c");
  expect(router.models.b.upstream).toBe("c-graph-2");
  expect(router.upstreams[router.models.b.upstream].flow).toEqual(
    flow("smart"),
  );
  expect(router.redirects).toEqual(original.plugins[0].config.redirects);
  expect(config.plugins[1]).toEqual(original.plugins[1]);
  expect(migrateLegacyChannels(config)).toBe(false);
  expect(compileWorkflow(defaultChannelFlow()).nodes.size).toBe(2);
});

it("refuses to migrate a legacy channel with missing graph data", () => {
  const config = {
    plugins: [
      {
        path: "/plugins/ai-router",
        config: {
          upstreams: { c: { protocol: "workflow" } },
          models: { a: { upstream: "c", model: "missing" } },
        },
      },
    ],
  };
  expect(() => migrateLegacyChannels(config)).toThrow(/missing/);
});

it("moves provider settings into graph nodes without changing secret grants", () => {
  const connection = {
    protocol: "openai-chat" as const,
    baseUrl: "https://example.com/v1",
    keyRef: "env:BEFORE",
    authMode: "cli" as const,
    accountId: "account",
  };
  const config: any = {
    plugins: [
      {
        path: "/ai-router",
        config: {
          upstreams: {
            p: { ...connection, name: "Primary" },
            smart: { protocol: "auto-router" },
          },
          models: {},
        },
      },
      {
        path: "/upstream-openai-chat",
        config: { secretRefs: ["env:BEFORE", "env:UNRELATED"] },
      },
      { path: "/upstream-anthropic", config: {} },
    ],
  };
  migrateLegacyChannels(config);
  const channels = config.plugins[0].config.upstreams;
  expect(channels.p).toEqual({
    name: "Primary",
    flow: {
      entry: "start",
      nodes: [
        { id: "start", type: "start", next: "provider" },
        { id: "provider", type: "provider", upstream: connection },
      ],
    },
  });
  expect(channels.smart.flow.nodes[1]).toEqual({
    id: "provider",
    type: "routing",
    profile: "$model",
  });
  expect(migrateLegacyChannels(config)).toBe(false);
});
