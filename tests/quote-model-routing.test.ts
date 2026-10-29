import { expect, it } from "vitest";
import { fixture } from "./helpers.js";

it("quotes the selected route using its public model name even when IDs collide", async () => {
  const f = await fixture();
  try {
    const admin = await f.admin();
    f.kernel.configure({
      "official.ai-router": {
        upstreams: {
          entry: {
            flow: {
              entry: "start",
              nodes: [
                { id: "start", type: "start", next: "condition" },
                {
                  id: "condition",
                  type: "branch",
                  condition: false,
                  yes: "matched",
                  no: "other",
                },
                {
                  id: "condition-predicate",
                  type: "compare",
                  valueType: "string",
                  operator: "matches",
                  left: "",
                  right: ["assistant"],
                },
                {
                  id: "matched",
                  type: "upstream",
                  target: "cheap",
                  mode: "implicit",
                },
                {
                  id: "other",
                  type: "upstream",
                  target: "expensive",
                  mode: "implicit",
                },
              ],
              bindings: [
                {
                  source: "start",
                  output: "requestedModel",
                  target: "condition-predicate",
                  input: "left",
                },
                {
                  source: "condition-predicate",
                  output: "result",
                  target: "condition",
                  input: "condition",
                },
              ],
            },
          },
          provider: {
            protocol: "openai-chat",
            baseUrl: "https://example.test",
            keyRef: "secret:test",
          },
        },
        models: {
          collision: {
            upstream: "entry",
            publicModel: "internal-a",
            model: "unused",
            inputPrice: 99,
            outputPrice: 99,
          },
          "internal-a": {
            upstream: "entry",
            publicModel: "assistant",
            model: "unused",
            inputPrice: 99,
            outputPrice: 99,
            operations: ["chat", "embeddings"],
          },
          cheap: {
            upstream: "provider",
            model: "cheap",
            inputPrice: 2,
            outputPrice: 0,
          },
          expensive: {
            upstream: "provider",
            model: "expensive",
            inputPrice: 9,
            outputPrice: 0,
          },
        },
      },
    });
    const response = await f.request(
      "/api/plugins/official.billing/quote",
      "POST",
      {
        model: "assistant",
        channelId: "entry",
        usage: { input: 1000, output: 0 },
      },
      admin,
    );
    expect(response.status).toBe(200);
    expect((await response.json()).amount).toBe(2000);
    const other = await f.request(
      "/api/plugins/official.billing/quote",
      "POST",
      {
        model: "internal-a",
        channelId: "entry",
        usage: { input: 1000, output: 0 },
      },
      admin,
    );
    expect(other.status).toBe(200);
    expect((await other.json()).amount).toBe(9000);
    const plan = await f.kernel.invoke<any>("ai.routing@2", {
      model: "assistant",
      channelId: "entry",
      ingressProtocol: "openai-chat",
      features: ["text", "usage"],
      request: { model: "assistant", messages: [], tools: [], stream: false },
    });
    expect(plan.model).toBe("cheap");
    expect(plan.pricing.input).toBe(2);
    const otherPlan = await f.kernel.invoke<any>("ai.routing@2", {
      model: "internal-a",
      channelId: "entry",
      ingressProtocol: "openai-chat",
      features: ["text", "usage"],
      request: { model: "internal-a", messages: [], tools: [], stream: false },
    });
    expect(otherPlan.model).toBe("expensive");
    expect(otherPlan.pricing.input).toBe(9);
    await expect(
      f.kernel.invoke("ai.routing@2", {
        model: "internal-a",
        channelId: "entry",
        purpose: "quote",
        operation: "embeddings",
      }),
    ).rejects.toMatchObject({ code: "operation_not_supported" });
  } finally {
    await f.close();
  }
});
