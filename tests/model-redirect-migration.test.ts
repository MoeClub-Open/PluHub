import { expect, it } from "vitest";
import { migrateLegacyChannels } from "../deploy/migrations/channel-graphs.ts";
import { compileWorkflow } from "../../PluHub-Plugins/lib/ai/channel-graph.js";
import { planRoute } from "../../PluHub-Plugins/plugins/ai-router/planning.js";
import { readCatalog } from "../../PluHub-Plugins/plugins/ai-router/catalog.js";

it("migrates redirect chains into the existing channel without changing prices or response identities", async () => {
  const router: any = {
    upstreams: {
      c: { protocol: "openai-chat", baseUrl: "https://example.com" },
    },
    models: {
      actual: { upstream: "c", model: "native", inputPrice: 2, outputPrice: 4 },
      disabled: { upstream: "c", model: "disabled-original" },
      collision: { upstream: "c", model: "redirect/hidden" },
    },
    redirects: {
      hidden: { target: "actual", mode: "implicit" },
      visible: { target: "hidden", mode: "explicit" },
      "wild*alias": { target: "hidden", mode: "implicit" },
      disabled: { target: "actual", mode: "explicit", enabled: false },
    },
  };
  const config = { plugins: [{ path: "/ai-router", config: router }] };
  expect(migrateLegacyChannels(config)).toBe(true);
  expect(router.redirects).toBeUndefined();
  expect(Object.keys(router.upstreams)).toEqual(["c"]);
  expect(router.models.hidden.model).not.toBe("redirect/hidden");
  expect(router.models.disabled.model).toBe("disabled-original");
  compileWorkflow(router.upstreams.c.flow);
  expect(migrateLegacyChannels(config)).toBe(false);
  const host = { config: () => router, hasCapability: () => true } as any;
  expect((await readCatalog(host)).map((model) => model.id)).toEqual([
    "actual",
    "disabled",
    "collision",
    "hidden",
    "visible",
    "wild*alias",
  ]);
  for (const model of ["actual", "hidden", "visible", "wild*alias"]) {
    const plan = await planRoute(
      host,
      {
        model,
        features: ["text"],
        ingressProtocol: "openai-chat",
        request: {
          model,
          messages: [{ role: "user", text: "hello" }],
          tools: [],
          stream: false,
        },
      },
      new AbortController().signal,
    );
    expect(plan.model).toBe("native");
    expect(plan.responseModel).toBe(model === "visible" ? "actual" : model);
    expect(plan.pricing).toMatchObject({ input: 2, output: 4 });
  }
});

it("refuses cyclic or missing legacy targets instead of silently discarding them", () => {
  for (const redirects of [
    {
      a: { target: "b", mode: "implicit" },
      b: { target: "a", mode: "explicit" },
    },
    { a: { target: "missing", mode: "implicit" } },
  ]) {
    expect(() =>
      migrateLegacyChannels({
        plugins: [
          {
            path: "/ai-router",
            config: {
              upstreams: {},
              models: {},
              redirects,
            },
          },
        ],
      }),
    ).toThrow();
  }
});
