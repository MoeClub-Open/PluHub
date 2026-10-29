import { createServer } from "node:http";
import { expect, it } from "vitest";
import { fixture } from "./helpers.js";

it("rewrites the normal answer with a style prompt and routes a specific question separately", async () => {
  const requests: any[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    const content: Record<string, string> = {
      "vendor-deepseek": "草稿：旧称谓",
      "vendor-editor": "经过语义润色的回答：旧称谓",
      "vendor-special": "专门问题的回答",
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        model: body.model,
        choices: [
          {
            message: { role: "assistant", content: content[body.model] },
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
      "token-speed",
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
    const user = await (
      await f.request("/api/plugins/official.auth/me", "GET", undefined, admin)
    ).json();
    await f.kernel.invoke("billing.credit@1", {
      userId: user.id,
      amount: 1_000_000,
      source: "workflow-style-scenario",
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
      keyRef: "style-test-key",
    };
    config.config.upstreams = Object.fromEntries(
      ["deepseek", "editor", "special"].map((name) => [
        name,
        {
          flow: {
            entry: "start",
            nodes: [
              { id: "start", type: "start", next: "call" },
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
      ["deepseek", "editor", "special"].map((name) => [
        name,
        {
          upstream: name,
          model: `vendor-${name}`,
          inputPrice: 2,
          outputPrice: 4,
        },
      ]),
    );
    config.config.upstreams.workflow = {
      flow: {
        entry: "start",
        nodes: [
          { id: "start", type: "start", next: "branch" },
          {
            id: "match",
            type: "compare",
            valueType: "string",
            operator: "matches",
            left: "",
            right: ["*专门问题*"],
          },
          {
            id: "branch",
            type: "branch",
            condition: false,
            yes: "special",
            no: "pace",
          },
          {
            id: "special",
            type: "upstream",
            target: "special",
            mode: "implicit",
          },
          {
            id: "pace",
            type: "tps",
            rate: 100,
            tokenizer: "o200k_base",
            next: "response",
          },
          {
            id: "draft",
            type: "llm",
            model: "deepseek",
            system: "请准确、细致、有条理地回答；不冒充其他模型。",
            promptMode: "append",
          },
          {
            id: "rewritePrompt",
            type: "template",
            template: "保留事实与原意，改写并润色以下回答：\n{{draft}}",
            values: { draft: "" },
          },
          {
            id: "rewrite",
            type: "llm",
            model: "editor",
            promptMode: "replace",
            prompt: "",
          },
          {
            id: "replace",
            type: "replace",
            text: "",
            find: "旧称谓",
            replacement: "新称谓",
            all: true,
          },
          { id: "response", type: "response", text: "" },
        ],
        bindings: [
          { source: "start", output: "text", target: "match", input: "left" },
          {
            source: "match",
            output: "result",
            target: "branch",
            input: "condition",
          },
          {
            source: "draft",
            output: "text",
            target: "rewritePrompt",
            input: "values.draft",
          },
          {
            source: "rewritePrompt",
            output: "text",
            target: "rewrite",
            input: "prompt",
          },
          {
            source: "rewrite",
            output: "text",
            target: "replace",
            input: "text",
          },
          {
            source: "replace",
            output: "text",
            target: "response",
            input: "text",
          },
        ],
      },
    };
    config.config.models.workflow = {
      upstream: "workflow",
      model: "workflow",
      inputPrice: 999,
      outputPrice: 999,
    };
    const saved = await f.request(
      "/api/plugins/official.ai-router/configuration",
      "PUT",
      config,
      admin,
    );
    expect(saved.status, await saved.clone().text()).toBe(200);

    const invoke = async (question: string) => {
      const response = await f.request(
        "/v1/chat/completions",
        "POST",
        {
          model: "workflow",
          messages: [{ role: "user", content: question }],
          max_tokens: 64,
        },
        admin,
      );
      const id = response.headers.get("x-pluhub-request-id");
      const body = await response.json();
      expect(response.status, JSON.stringify(body)).toBe(200);
      const history = await f.request(
        `/api/plugins/official.observability/requests/children?parentId=${id}`,
        "GET",
        undefined,
        admin,
      );
      expect(history.status, await history.clone().text()).toBe(200);
      return { body, children: (await history.json()).data };
    };

    const normal = await invoke("请回答普通问题");
    expect(normal.body.choices[0].message.content).toBe(
      "经过语义润色的回答：新称谓",
    );
    expect(requests.map((body) => body.model)).toEqual([
      "vendor-deepseek",
      "vendor-editor",
    ]);
    expect(requests[0].messages[0]).toMatchObject({
      role: "system",
      content: "请准确、细致、有条理地回答；不冒充其他模型。",
    });
    expect(JSON.stringify(requests[1].messages)).toContain("草稿：旧称谓");
    expect(
      normal.children.map((row: any) => row.workflow_node_id).sort(),
    ).toEqual(["draft", "rewrite"]);
    expect(
      normal.children.every((row: any) => row.charged_micro_usd === 14),
    ).toBe(true);

    const special = await invoke("请处理这个专门问题");
    expect(special.body.choices[0].message.content).toBe("专门问题的回答");
    expect(requests.map((body) => body.model)).toEqual([
      "vendor-deepseek",
      "vendor-editor",
      "vendor-special",
    ]);
    expect(special.children).toHaveLength(1);
    expect(special.children[0].charged_micro_usd).toBe(14);
    expect(
      (await f.kernel.invoke<any>("billing.balance@1", { userId: user.id }))
        .balance,
    ).toBe(1_000_000 - 42);
  } finally {
    await f.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 20_000);
