import { createServer } from "node:http";
import { expect, it } from "vitest";
import { fixture } from "./helpers.js";
import { createWorkflowTemplate } from "../../PluHub-Plugins/lib/ui/workflow-templates.js";

it("preserves the full conversation when discussing or polishing a response", async () => {
  const calls: any[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls.push(body);
    const answer =
      body.model === "vendor-a"
        ? "模型 A 的回答"
        : body.model === "vendor-b"
          ? "模型 B 的回答"
          : "最终回答";
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        model: body.model,
        choices: [
          {
            message: { role: "assistant", content: answer },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const f = await fixture(
    [
      "users",
      "auth",
      "ai-router",
      "rate-limit",
      "billing",
      "observability",
      "http-transport",
      "upstream-openai-chat",
      "ingress-openai-chat",
    ],
    { "upstream-openai-chat": { secretRefs: [] }, billing: { enabled: true } },
  );
  try {
    const admin = await f.admin();
    const me = await (
      await f.request("/api/plugins/official.auth/me", "GET", undefined, admin)
    ).json();
    await f.kernel.invoke("billing.credit@1", {
      userId: me.id,
      amount: 1_000_000,
      source: "workflow-multiturn",
    });
    const config = await (
      await f.request(
        "/api/plugins/official.ai-router/configuration",
        "GET",
        undefined,
        admin,
      )
    ).json();
    const connection = {
      protocol: "openai-chat",
      baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
      keyRef: "multiturn-test-key",
    };
    config.config.upstreams = Object.fromEntries(
      ["a", "b", "summary"].map((name) => [
        name,
        {
          flow: {
            entry: "start",
            nodes: [
              { id: "start", type: "start", next: ["call"] },
              {
                id: "call",
                type: "provider",
                upstream: connection,
                modelMap: { [`vendor-${name}`]: `vendor-${name}` },
              },
            ],
          },
        },
      ]),
    );
    config.config.models = Object.fromEntries(
      ["a", "b", "summary"].map((name) => [
        name,
        {
          upstream: name,
          model: `vendor-${name}`,
          inputPrice: 2,
          outputPrice: 4,
        },
      ]),
    );
    const history = [
      { role: "system", content: "请使用中文。" },
      { role: "user", content: "我偏好简短回答。" },
      { role: "assistant", content: "好的，我会简短回答。" },
      { role: "user", content: "结合上面的偏好回答：什么是缓存？" },
    ];
    for (const preset of ["discussion", "polish"] as const) {
      const flow = createWorkflowTemplate(preset, {
        primary: "a",
        secondary: "b",
        summary: "summary",
      });
      config.config.upstreams.workflow = { flow };
      config.config.models.workflow = {
        upstream: "workflow",
        model: "workflow",
        inputPrice: 999,
        outputPrice: 999,
      };
      config.revision = (
        await (
          await f.request(
            "/api/plugins/official.ai-router/configuration",
            "GET",
            undefined,
            admin,
          )
        ).json()
      ).revision;
      const saved = await f.request(
        "/api/plugins/official.ai-router/configuration",
        "PUT",
        config,
        admin,
      );
      expect(saved.status, await saved.clone().text()).toBe(200);
      calls.length = 0;
      const response = await f.request(
        "/v1/chat/completions",
        "POST",
        {
          model: "workflow",
          messages: history,
          max_tokens: 64,
        },
        admin,
      );
      const body = await response.json();
      expect(response.status, JSON.stringify(body)).toBe(200);
      expect(body.choices[0].message.content).toBe("最终回答");
      const summary = calls.find((call) => call.model === "vendor-summary");
      expect(summary).toBeDefined();
      expect(summary.messages.slice(0, history.length)).toEqual(history);
      expect(summary.messages).toHaveLength(history.length + 1);
      const instruction = summary.messages.at(-1);
      expect(instruction.role).toBe("user");
      expect(instruction.content).toContain("模型 A 的回答");
      if (preset === "discussion")
        expect(instruction.content).toContain("模型 B 的回答");
    }
  } finally {
    await f.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 20_000);
