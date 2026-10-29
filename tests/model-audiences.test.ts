import { expect, it } from "vitest";
import { fixture } from "./helpers.js";

it("uses payment history rather than gifts for HTTP model listings while retaining direct routing", async () => {
  const f = await fixture(
    ["users", "auth", "ai-router", "billing", "model-catalog"],
    {
      billing: { enabled: true },
      "ai-router": {
        upstreams: {
          c: {
            flow: {
              entry: "s",
              nodes: [
                { id: "s", type: "start", next: "answer" },
                { id: "answer", type: "response", text: "ok" },
              ],
            },
          },
        },
        models: {
          open: { upstream: "c", model: "open" },
          signed: {
            upstream: "c",
            model: "signed",
            visibility: "authenticated",
          },
          "gpt-test": { upstream: "c", model: "gpt-test", visibility: "paid" },
          "gemini-test": {
            upstream: "c",
            model: "gemini-test",
            visibility: "paid",
          },
        },
      },
    },
  );
  try {
    const admin = await f.admin();
    const user = await (
      await f.request("/api/plugins/official.auth/me", "GET", undefined, admin)
    ).json();
    const list = async (headers = {}) =>
      (
        await (
          await f.request(
            "/api/plugins/official.model-catalog/" +
              (Object.keys(headers).length ? "models" : "public"),
            "GET",
            undefined,
            headers,
          )
        ).json()
      ).map((model: any) => model.id);
    expect(await list()).toEqual(["open"]);
    await f.kernel.invoke("billing.credit@1", {
      userId: user.id,
      amount: 1000000,
      source: "gift:audience",
    });
    expect(await list(admin)).toEqual(["open", "signed"]);
    const apiList = await (
      await f.request("/v1/models", "GET", undefined, admin)
    ).json();
    expect(apiList.data.map((model: any) => model.id)).toEqual([
      "open",
      "signed",
    ]);
    const plan = await f.kernel.invoke<any>("ai.routing@2", {
      model: "gpt-test",
      groupId: "default",
      principalId: user.id,
      request: { model: "gpt-test", messages: [], tools: [], stream: false },
      features: ["text"],
    });
    expect(plan.kind).toBe("workflow");
    await f.kernel.invoke("billing.payment-state@1", {
      userId: user.id,
      source: "payment:test:audience",
      credit: 1000,
      debit: 0,
      hold: 0,
      revision: 1,
    });
    expect(await list(admin)).toEqual([
      "open",
      "signed",
      "gpt-test",
      "gemini-test",
    ]);
    expect(await list()).toEqual(["open"]);
  } finally {
    await f.close();
  }
});
