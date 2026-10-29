import { createServer } from "node:http";
import { expect, it } from "vitest";
import { fixture } from "./helpers.js";
import { createWorkflowTemplate } from "../../PluHub-Plugins/lib/ui/workflow-templates.js";

async function gateway(forceParallel = false) {
  const requests: any[] = [];
  let waiting: (() => void) | undefined;
  let pairStarted = 0;
  let concurrent = false;
  const server = createServer(async (request, response) => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    if (forceParallel && ["vendor-a", "vendor-b"].includes(body.model)) {
      pairStarted++;
      if (pairStarted === 1) {
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(resolve, 1500);
          waiting = () => {
            clearTimeout(timeout);
            resolve();
          };
        });
      } else if (pairStarted === 2) {
        concurrent = true;
        waiting?.();
      }
    }
    const answer: Record<string, string> = {
      "vendor-a": "answer A",
      "vendor-b": "answer B",
      "vendor-summary": "combined answer",
      "vendor-decision": "complex",
      "vendor-simple": "simple answer",
      "vendor-complex": "complex answer",
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        model: body.model,
        choices: [
          {
            message: { role: "assistant", content: answer[body.model] },
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
      "ingress-openai-responses",
      "ingress-anthropic",
    ],
    { "upstream-openai-chat": { secretRefs: [] }, billing: { enabled: true } },
  );
  const admin = await f.admin();
  const me = await (
    await f.request("/api/plugins/official.auth/me", "GET", undefined, admin)
  ).json();
  await f.kernel.invoke("billing.credit@1", {
    userId: me.id,
    amount: 1_000_000,
    source: "composition-e2e",
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
    keyRef: "composition-test-key",
  };
  config.config.upstreams = Object.fromEntries(
    ["a", "b", "summary", "decision", "simple", "complex"].map((name) => [
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
    ["a", "b", "summary", "decision", "simple", "complex"].map((name) => [
      name,
      {
        upstream: name,
        model: `vendor-${name}`,
        inputPrice: 2,
        outputPrice: 4,
      },
    ]),
  );
  async function save(flow: unknown) {
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
    config.config.upstreams.workflow = { flow };
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
  }
  async function invoke(model = "workflow", headers = admin) {
    const result = await f.request(
      "/v1/chat/completions",
      "POST",
      {
        model,
        messages: [{ role: "user", content: "Explain this question" }],
        max_tokens: 64,
      },
      headers,
    );
    const id = result.headers.get("x-pluhub-request-id");
    const body = await result.json();
    return { response: result, id, body };
  }
  async function children(id: string | null) {
    const response = await f.request(
      `/api/plugins/official.observability/requests/children?parentId=${id}`,
      "GET",
      undefined,
      admin,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()).data;
  }
  return {
    ...f,
    admin,
    me,
    save,
    invoke,
    children,
    requests,
    isConcurrent: () => concurrent,
    async cleanup() {
      await f.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

it("runs a discussion in parallel, combines both replies and charges each model once", async () => {
  const f = await gateway(true);
  try {
    await f.save(
      createWorkflowTemplate("discussion", {
        primary: "a",
        secondary: "b",
        summary: "summary",
      }),
    );
    const result = await f.invoke();
    expect(result.response.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.choices[0].message.content).toBe("combined answer");
    expect(f.isConcurrent()).toBe(true);
    const summary = f.requests.find(
      (request) => request.model === "vendor-summary",
    );
    expect(JSON.stringify(summary.messages)).toContain("answer A");
    expect(JSON.stringify(summary.messages)).toContain("answer B");
    const children = await f.children(result.id);
    expect(children.map((row: any) => row.workflow_node_id).sort()).toEqual([
      "first",
      "second",
      "summary",
    ]);
    expect(new Set(children.map((row: any) => row.id)).size).toBe(3);
    for (const row of children)
      expect(row).toMatchObject({
        status: "success",
        input_tokens: 3,
        output_tokens: 2,
        charged_micro_usd: 14,
      });
    expect(
      (await f.kernel.invoke<any>("billing.balance@1", { userId: f.me.id }))
        .balance,
    ).toBe(1_000_000 - 42);
  } finally {
    await f.cleanup();
  }
}, 20_000);

it("runs intermediate requests through Chat, Responses and Anthropic ingress protocols", async () => {
  const f = await gateway();
  try {
    for (const protocol of ["openai-chat", "openai-responses", "anthropic"]) {
      const flow = createWorkflowTemplate("polish", {
        primary: "a",
        summary: "summary",
      });
      Object.assign(
        flow.nodes.find((node) => node.id === "summary")!,
        { protocol },
      );
      await f.save(flow);
      const result = await f.invoke();
      expect(
        result.response.status,
        `${protocol}: ${JSON.stringify(result.body)}`,
      ).toBe(200);
      expect(result.body.choices[0].message.content).toBe("combined answer");
      const children = await f.children(result.id);
      expect(
        children.find((row: any) => row.workflow_node_id === "summary")
          ?.protocol,
      ).toBe(protocol);
    }
    expect(
      (await f.kernel.invoke<any>("billing.balance@1", { userId: f.me.id }))
        .balance,
    ).toBe(1_000_000 - 84);
  } finally {
    await f.cleanup();
  }
}, 20_000);

it("passes the first model answer to a second model for polishing", async () => {
  const f = await gateway();
  try {
    await f.save(
      createWorkflowTemplate("polish", { primary: "a", summary: "summary" }),
    );
    const result = await f.invoke();
    expect(result.response.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.choices[0].message.content).toBe("combined answer");
    expect(
      JSON.stringify(
        f.requests.find((request) => request.model === "vendor-summary")
          .messages,
      ),
    ).toContain("answer A");
    const children = await f.children(result.id);
    expect(children.map((row: any) => row.workflow_node_id).sort()).toEqual([
      "first",
      "summary",
    ]);
    expect(
      (await f.kernel.invoke<any>("billing.balance@1", { userId: f.me.id }))
        .balance,
    ).toBe(1_000_000 - 28);
  } finally {
    await f.cleanup();
  }
}, 20_000);

it("returns a polished result through a streaming client response", async () => {
  const f = await gateway();
  try {
    await f.save(
      createWorkflowTemplate("polish", { primary: "a", summary: "summary" }),
    );
    const response = await f.request(
      "/v1/chat/completions",
      "POST",
      {
        model: "workflow",
        stream: true,
        messages: [{ role: "user", content: "Explain this question" }],
        max_tokens: 64,
      },
      f.admin,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await response.text();
    expect(body).toContain("combined answer");
    expect(body).toContain("[DONE]");
    const children = await f.children(
      response.headers.get("x-pluhub-request-id"),
    );
    expect(children.map((row: any) => row.workflow_node_id).sort()).toEqual([
      "first",
      "summary",
    ]);
    expect(
      (await f.kernel.invoke<any>("billing.balance@1", { userId: f.me.id }))
        .balance,
    ).toBe(1_000_000 - 28);
  } finally {
    await f.cleanup();
  }
}, 20_000);

it("rejects unsupported tool requests before starting paid text-only workflow calls", async () => {
  const f = await gateway();
  try {
    await f.save(
      createWorkflowTemplate("discussion", {
        primary: "a",
        secondary: "b",
        summary: "summary",
      }),
    );
    const response = await f.request(
      "/v1/chat/completions",
      "POST",
      {
        model: "workflow",
        messages: [{ role: "user", content: "Find an answer" }],
        tools: [
          {
            type: "function",
            function: {
              name: "lookup",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
      },
      f.admin,
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("unsupported_feature");
    expect(f.requests).toHaveLength(0);
    expect(
      (await f.kernel.invoke<any>("billing.balance@1", { userId: f.me.id }))
        .balance,
    ).toBe(1_000_000);
  } finally {
    await f.cleanup();
  }
}, 20_000);

it("applies a system prompt and text replacement with an output speed policy", async () => {
  const f = await gateway();
  try {
    const flow = createWorkflowTemplate(
      "output-processing",
      { primary: "a" },
      { find: "answer", replacement: "reply" },
    );
    await f.save(flow);
    const result = await f.invoke();
    expect(result.response.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.choices[0].message.content).toBe("reply A");
    expect(f.requests[0].messages[0]).toMatchObject({
      role: "system",
      content: "请准确、有条理地回答用户的问题。",
    });
    const children = await f.children(result.id);
    expect(children.map((row: any) => row.workflow_node_id)).toEqual([
      "answer",
    ]);
    expect(
      (await f.kernel.invoke<any>("billing.balance@1", { userId: f.me.id }))
        .balance,
    ).toBe(1_000_000 - 14);
  } finally {
    await f.cleanup();
  }
}, 20_000);

it("uses the classifier result to choose a configured model and charges both calls", async () => {
  const f = await gateway();
  try {
    await f.save(
      createWorkflowTemplate("llm-routing", {
        decision: "decision",
        simpleTarget: "simple",
        complexTarget: "complex",
      }),
    );
    const result = await f.invoke();
    expect(result.response.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.choices[0].message.content).toBe("complex answer");
    expect(f.requests.map((request) => request.model)).toEqual([
      "vendor-decision",
      "vendor-complex",
    ]);
    const children = await f.children(result.id);
    expect(children).toHaveLength(2);
    expect(children.map((row: any) => row.workflow_node_id)).toContain(
      "decision",
    );
    expect(
      (await f.kernel.invoke<any>("billing.balance@1", { userId: f.me.id }))
        .balance,
    ).toBe(1_000_000 - 28);
  } finally {
    await f.cleanup();
  }
}, 20_000);

it("keeps client tools and output options out of the classifier but preserves them for the selected model", async () => {
  const f = await gateway();
  try {
    await f.save(
      createWorkflowTemplate("llm-routing", {
        decision: "decision",
        simpleTarget: "simple",
        complexTarget: "complex",
      }),
    );
    const tools = [
      {
        type: "function",
        function: {
          name: "lookup",
          parameters: { type: "object", properties: {} },
        },
      },
    ];
    const response = await f.request(
      "/v1/chat/completions",
      "POST",
      {
        model: "workflow",
        messages: [{ role: "user", content: "Find an answer" }],
        tools,
        web_search_options: { search_context_size: "low" },
        response_format: { type: "json_object" },
        stop: ["client-stop"],
        max_tokens: 64,
      },
      f.admin,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    await response.json();
    expect(f.requests.map((request) => request.model)).toEqual([
      "vendor-decision",
      "vendor-complex",
    ]);
    const [decision, final] = f.requests;
    expect(decision.tools).toBeUndefined();
    expect(decision.web_search_options).toBeUndefined();
    expect(decision.response_format).toBeUndefined();
    expect(decision.stop).toBeUndefined();
    expect(final.tools).toEqual(tools);
    expect(final.web_search_options).toEqual({ search_context_size: "low" });
    expect(final.response_format).toEqual({ type: "json_object" });
    expect(final.stop).toEqual(["client-stop"]);
  } finally {
    await f.cleanup();
  }
}, 20_000);

it("restricts external model access while allowing a workflow's configured delegated models", async () => {
  const f = await gateway();
  try {
    await f.save(
      createWorkflowTemplate("polish", { primary: "a", summary: "summary" }),
    );
    const created = await f.request(
      "/api/plugins/official.auth/keys",
      "POST",
      { name: "workflow-only", models: ["workflow"] },
      f.admin,
    );
    expect(created.status, await created.clone().text()).toBe(201);
    const key = await created.json();
    const headers = { authorization: `Bearer ${key.token}` };
    const denied = await f.invoke("a", headers);
    expect(denied.response.status).toBe(403);
    expect(f.requests).toHaveLength(0);
    const result = await f.invoke("workflow", headers);
    expect(result.response.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body.choices[0].message.content).toBe("combined answer");
    expect(f.requests.map((request) => request.model)).toEqual([
      "vendor-a",
      "vendor-summary",
    ]);
    expect(await f.children(result.id)).toHaveLength(2);
  } finally {
    await f.cleanup();
  }
}, 20_000);
