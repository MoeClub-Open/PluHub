import { migrateLegacyChannels } from "../deploy/migrations/channel-graphs.ts";
import { migrateModelRedirects } from "../deploy/migrations/model-redirects.ts";
import { it, expect } from "vitest";
import { createServer } from "node:http";
import { fixture } from "./helpers.js";
import { defaultChannelFlow } from "../../PluHub-Plugins/lib/ai/channel-config.js";
import { readConfig, createKernel } from "../packages/control/dist/index.js";

async function setup() {
  const prior = process.env.PLUHUB_TEST_UPSTREAM_KEY;
  process.env.PLUHUB_TEST_UPSTREAM_KEY = "workflow-upstream-only";
  const sent: any[] = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    sent.push(body);
    const answer = {
      choices: [
        {
          message: {
            content: body.model === "vendor-empty" ? "" : "workflow OK",
          },
          finish_reason: body.model === "vendor-length" ? "length" : "stop",
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    };
    res.writeHead(200, {
      "content-type": body.stream ? "text/event-stream" : "application/json",
    });
    res.end(
      body.stream
        ? "data: " +
            JSON.stringify({
              choices: [
                {
                  index: 0,
                  delta: { content: "workflow OK" },
                  finish_reason: "stop",
                },
              ],
              usage: answer.usage,
            }) +
            "\n\ndata: [DONE]\n\n"
        : JSON.stringify(answer),
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const f = await fixture();
  const router: any = {
    upstreams: {
      p: {
        protocol: "openai-chat",
        baseUrl: "http://127.0.0.1:" + (server.address() as any).port,
        keyRef: "env:PLUHUB_TEST_UPSTREAM_KEY",
      },
      composed: { protocol: "workflow" },
    },
    models: {
      actual: {
        upstream: "p",
        model: "vendor-model",
        inputPrice: 2,
        outputPrice: 4,
        reasoningEfforts: ["low"],
      },
      flow: {
        upstream: "composed",
        model: "standard",
        inputPrice: 999,
        outputPrice: 999,
      },
    },
    redirects: {
      hidden: { target: "actual", mode: "implicit" },
      "hidden/path": { target: "actual", mode: "implicit" },
      visible: { target: "actual", mode: "explicit" },
    },
  };
  const workflow: any = {
    flows: {
      standard: {
        entry: "start",
        nodes: [
          { id: "start", type: "start", next: ["prompt"] },
          {
            id: "prompt",
            type: "prompt",
            text: "policy: concise",
            next: "effort",
          },
          { id: "effort", type: "reasoning", effort: "low", next: "budget" },
          { id: "budget", type: "maxTokens", limit: 16, next: "tps" },
          {
            id: "tps",
            type: "tps",
            rate: 10000,
            tokenizer: "o200k_base",
            next: "call",
          },
          { id: "call", type: "upstream", target: "actual", mode: "explicit" },
        ],
      },
    },
  };
  const connection = structuredClone(router.upstreams.p);
  router.upstreams.composed = { flow: workflow.flows.standard };
  router.upstreams.p.flow = defaultChannelFlow();
  migrateModelRedirects(router);
  f.kernel.configure({ "official.ai-router": router });
  const admin = await f.admin();
  return {
    ...f,
    admin,
    router,
    connection,
    workflow,
    sent,
    async cleanup() {
      await f.close();
      await new Promise<void>((done) => server.close(() => done()));
      if (prior === undefined) delete process.env.PLUHUB_TEST_UPSTREAM_KEY;
      else process.env.PLUHUB_TEST_UPSTREAM_KEY = prior;
    },
  };
}

it("uses the same requested/mapped model conditions for preview, execution and quotes", async () => {
  const f = await setup();
  try {
    f.router.models.actual.publicModel = "assistant";
    f.router.upstreams.p.flow = {
      entry: "s",
      nodes: [
        { id: "s", type: "start", next: ["requested"] },
        {
          id: "requested",
          type: "branch",
          condition: false,
          yes: "mapped",
          no: "other",
        },
        {
          id: "requested-predicate",
          type: "compare",
          valueType: "string",
          operator: "matches",
          left: "",
          right: ["assistant"],
        },
        {
          id: "mapped",
          type: "branch",
          condition: false,
          yes: "match",
          no: "other",
        },
        {
          id: "mapped-predicate",
          type: "compare",
          valueType: "string",
          operator: "matches",
          left: "",
          right: ["vendor-*"],
        },
        { id: "match", type: "provider", model: "vendor-selected" },
        { id: "other", type: "provider", model: "vendor-other" },
      ],
      bindings: [
        {
          source: "s",
          output: "requestedModel",
          target: "requested-predicate",
          input: "left",
        },
        {
          source: "s",
          output: "mappedModel",
          target: "mapped-predicate",
          input: "left",
        },
        {
          source: "requested-predicate",
          output: "result",
          target: "requested",
          input: "condition",
        },
        {
          source: "mapped-predicate",
          output: "result",
          target: "mapped",
          input: "condition",
        },
      ],
    };
    const configuration = await f.request(
      "/api/plugins/official.ai-router/configuration",
      "GET",
      undefined,
      f.admin,
    );
    const { revision } = (await configuration.json()) as any;
    const saved = await f.request(
      "/api/plugins/official.ai-router/configuration",
      "PUT",
      { config: f.router, revision },
      f.admin,
    );
    expect(saved.status).toBe(200);
    await saved.text();
    const request = {
      model: "assistant",
      messages: [{ role: "user", text: "hello" }],
      tools: [],
      stream: false,
    };
    const preview = await f.request(
      "/api/plugins/official.ai-router/graph/preview",
      "POST",
      { upstream: "p", mappingId: "actual", request },
      f.admin,
    );
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({
      providerId: "match",
      trace: { nodes: ["s", "requested", "mapped", "match"] },
    });
    const quoted = await f.kernel.invoke<any>("ai.routing@2", {
      model: "assistant",
      purpose: "quote",
      ingressProtocol: "openai-chat",
      features: ["text", "usage"],
    });
    expect(quoted.model).toBe("vendor-selected");
    expect(f.sent).toHaveLength(0);
    const response = await f.request(
      "/v1/chat/completions",
      "POST",
      { model: "assistant", messages: [{ role: "user", content: "hello" }] },
      f.admin,
    );
    expect(response.status).toBe(200);
    await response.text();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0].model).toBe("vendor-selected");
  } finally {
    await f.cleanup();
  }
});

it("enforces trusted protocol admission before the upstream and keeps JSON/SSE cross-protocol conversion", async () => {
  const f = await setup();
  try {
    f.router.upstreams.p.flow = {
      entry: "s",
      nodes: [
        { id: "s", type: "start", next: ["gate"] },
        {
          id: "gate",
          type: "protocol",
          allow: ["anthropic"],
          conversion: "auto",
          next: "p",
        },
        { id: "p", type: "provider" },
      ],
    };
    f.kernel.configure({ "official.ai-router": f.router });
    for (const stream of [false, true]) {
      const denied = await f.request(
        "/v1/chat/completions",
        "POST",
        {
          model: "actual",
          messages: [{ role: "user", content: "hi" }],
          stream,
        },
        { ...f.admin, "x-pluhub-ingress-protocol": "anthropic" },
      );
      expect(denied.status).toBe(400);
      expect(await denied.text()).toContain("protocol_not_allowed");
    }
    expect(f.sent).toHaveLength(0);
    const spoof = await f.request(
      "/v1/chat/completions",
      "POST",
      {
        model: "actual",
        messages: [{ role: "user", content: "hi" }],
        ingressProtocol: "anthropic",
      },
      f.admin,
    );
    expect(spoof.status).toBe(400);
    await spoof.text();
    expect(f.sent).toHaveLength(0);
    for (const stream of [false, true]) {
      const accepted = await f.request(
        "/v1/messages",
        "POST",
        {
          model: "actual",
          messages: [{ role: "user", content: "hi" }],
          stream,
          max_tokens: 32,
        },
        f.admin,
      );
      expect(accepted.status).toBe(200);
      expect(await accepted.text()).toContain("workflow OK");
    }
    expect(f.sent).toHaveLength(2);
    expect(f.sent[1].stream).toBe(true);
    const extensions = await (
      await f.request("/api/host/extensions", "GET", undefined, f.admin)
    ).json();
    expect(extensions.some((e: any) => e.path === "/protocol-converter")).toBe(
      false,
    );
    expect(
      (
        await f.request(
          "/api/plugins/official.protocol-converter/convert",
          "POST",
          {},
          f.admin,
        )
      ).status,
    ).toBe(404);
  } finally {
    await f.cleanup();
  }
});

it("keeps same-protocol restrictions across redirects and lets branches select by ingress", async () => {
  const f = await setup();
  try {
    delete f.router.upstreams.composed.protocol;
    f.router.upstreams.composed.flow = {
      entry: "s",
      nodes: [
        { id: "s", type: "start", next: ["gate"] },
        {
          id: "gate",
          type: "protocol",
          allow: ["openai-chat", "openai-responses"],
          conversion: "disabled",
          next: "target",
        },
        { id: "target", type: "upstream", target: "actual", mode: "implicit" },
      ],
    };
    f.kernel.configure({ "official.ai-router": f.router });
    const denied = await f.request(
      "/v1/responses",
      "POST",
      { model: "flow", input: "hi" },
      f.admin,
    );
    expect(denied.status).toBe(400);
    expect(await denied.text()).toContain("protocol_conversion_forbidden");
    expect(f.sent).toHaveLength(0);
    await expect(
      f.kernel.invoke("ai.routing@2", {
        model: "flow",
        features: [],
        request: { model: "flow", messages: [], tools: [], stream: false },
      }),
    ).rejects.toMatchObject({ code: "ingress_protocol_required" });
    const accepted = await f.request(
      "/v1/chat/completions",
      "POST",
      { model: "flow", messages: [{ role: "user", content: "hi" }] },
      f.admin,
    );
    expect(accepted.status).toBe(200);
    await accepted.text();
    f.router.upstreams.p.flow = {
      entry: "s",
      nodes: [
        { id: "s", type: "start", next: ["branch"] },
        { id: "branch", type: "branch", condition: false, yes: "a", no: "b" },
        {
          id: "branch-predicate",
          type: "compare",
          valueType: "string",
          operator: "eq",
          left: "",
          right: "anthropic",
        },
        { id: "a", type: "provider", model: "vendor-anthropic" },
        { id: "b", type: "provider", model: "vendor-other" },
      ],
      bindings: [
        {
          source: "s",
          output: "ingressProtocol",
          target: "branch-predicate",
          input: "left",
        },
        {
          source: "branch-predicate",
          output: "result",
          target: "branch",
          input: "condition",
        },
      ],
    };
    f.kernel.configure({ "official.ai-router": f.router });
    for (const [path, body, expected] of [
      [
        "/v1/messages",
        {
          model: "actual",
          messages: [{ role: "user", content: "hi" }],
          max_tokens: 32,
        },
        "vendor-anthropic",
      ],
      ["/v1/responses", { model: "actual", input: "hi" }, "vendor-other"],
    ] as const) {
      const response = await f.request(path, "POST", body, f.admin);
      expect(response.status).toBe(200);
      await response.text();
      expect(f.sent.at(-1).model).toBe(expected);
    }
  } finally {
    await f.cleanup();
  }
});

it("does not report empty or truncated channel probes as successful", async () => {
  const f = await setup();
  try {
    for (const model of ["vendor-empty", "vendor-length"]) {
      const response = await f.request(
        "/api/plugins/official.ai-router/test",
        "POST",
        { upstream: "p", model },
        f.admin,
      );
      expect(response.status).toBe(502);
      expect(await response.text()).toContain("upstream_protocol");
    }
    const valid = await f.request(
      "/api/plugins/official.ai-router/test",
      "POST",
      { upstream: "p", model: "vendor-model", maxTokens: 64 },
      f.admin,
    );
    expect(valid.status).toBe(200);
    expect((await valid.json()).textPresent).toBe(true);
    expect(f.sent.at(-1).max_completion_tokens).toBe(64);
    const before = f.sent.length;
    const invalid = await f.request(
      "/api/plugins/official.ai-router/test",
      "POST",
      { upstream: "p", model: "vendor-model", maxTokens: 100000 },
      f.admin,
    );
    expect(invalid.status).toBe(400);
    await invalid.text();
    expect(f.sent).toHaveLength(before);
  } finally {
    await f.cleanup();
  }
});

it("preserves implicit identities and exposes explicit redirect targets in every ingress, JSON and SSE", async () => {
  const f = await setup();
  try {
    for (const model of ["hidden", "hidden/path", "visible"])
      for (const stream of [false, true])
        for (const protocol of [
          "openai-chat",
          "openai-responses",
          "anthropic",
          "gemini",
        ]) {
          const path =
            protocol === "openai-chat"
              ? "/v1/chat/completions"
              : protocol === "openai-responses"
                ? "/v1/responses"
                : protocol === "anthropic"
                  ? "/v1/messages"
                  : "/v1beta/models/" +
                    model +
                    ":" +
                    (stream
                      ? "streamGenerateContent?alt=sse"
                      : "generateContent");
          const body =
            protocol === "openai-responses"
              ? { model, input: "Hello", stream }
              : protocol === "gemini"
                ? { contents: [{ role: "user", parts: [{ text: "Hello" }] }] }
                : {
                    model,
                    messages: [{ role: "user", content: "Hello" }],
                    max_tokens: 32,
                    stream,
                  };
          const response = await f.request(path, "POST", body, f.admin);
          expect(response.status).toBe(200);
          expect(response.headers.get("x-pluhub-model")).toBe(
            model === "visible" ? "actual" : null,
          );
          const output = await response.text();
          expect(output).toContain("workflow OK");
          if (protocol !== "gemini")
            expect(output).toContain(
              '"model":"' + (model === "visible" ? "actual" : model) + '"',
            );
          expect(output).not.toContain("vendor-model");
          expect(f.sent.at(-1).model).toBe("vendor-model");
        }
    const models = await (
      await f.request("/v1/models", "GET", undefined, f.admin)
    ).json();
    expect(models.data.map((m: any) => m.id)).toContain("hidden");
  } finally {
    await f.cleanup();
  }
});

it("composes channel functions before billing and preserves key scope and final-target pricing", async () => {
  const f = await setup();
  try {
    const user = await (
      await f.request(
        "/api/plugins/official.auth/me",
        "GET",
        undefined,
        f.admin,
      )
    ).json();
    f.kernel.configure({ "official.billing": { enabled: true } });
    await f.kernel.invoke("billing.credit@1", {
      userId: user.id,
      amount: 1000000,
      source: "test-credit",
    });
    const key = await (
      await f.request(
        "/api/plugins/official.auth/keys",
        "POST",
        { name: "workflow-only", models: ["flow"] },
        f.admin,
      )
    ).json();
    const credential = { authorization: "Bearer " + key.token };
    const denied = await f.request(
      "/v1/chat/completions",
      "POST",
      {
        model: "actual",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 20,
      },
      credential,
    );
    expect(denied.status).toBe(403);
    await denied.text();
    expect(f.sent).toHaveLength(0);
    const response = await f.request(
      "/v1/chat/completions",
      "POST",
      {
        model: "flow",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 100,
      },
      credential,
    );
    expect(response.status).toBe(200);
    expect((await response.json()).model).toBe("actual");
    expect(f.sent[0]).toMatchObject({
      model: "vendor-model",
      max_completion_tokens: 16,
      reasoning_effort: "low",
      messages: [
        { role: "system", content: "policy: concise" },
        { role: "user", content: "hi" },
      ],
    });
    expect(
      (await f.kernel.invoke<any>("billing.balance@1", { userId: user.id }))
        .balance,
    ).toBe(1000000 - 14);
    const logs = await (
      await f.request(
        "/api/plugins/official.observability/requests",
        "GET",
        undefined,
        f.admin,
      )
    ).json();
    expect(JSON.stringify(logs)).toContain("composed");
    expect(JSON.stringify(logs)).not.toContain("policy: concise");
  } finally {
    await f.cleanup();
  }
});

it("rejects channel recursion and invalid graph updates while preserving the previous snapshot", async () => {
  const f = await setup();
  try {
    expect(() =>
      f.kernel.configure({
        "official.ai-router": {
          ...f.router,
          redirects: {
            a: { target: "b", mode: "implicit" },
            b: { target: "a", mode: "explicit" },
          },
        },
      }),
    ).toThrow();
    const invalid = structuredClone(f.workflow);
    invalid.flows.standard.nodes[0].next = ["absent"];
    expect(() =>
      f.kernel.configure({
        "official.ai-router": {
          ...f.router,
          upstreams: {
            ...f.router.upstreams,
            composed: { flow: invalid.flows.standard },
          },
        },
      }),
    ).toThrow();
    const request = {
      model: "flow",
      messages: [{ role: "user", text: "hello" }],
      tools: [],
      stream: false,
    };
    expect(
      (
        await f.kernel.invoke<any>("ai.routing@2", {
          model: "flow",
          request,
          features: ["text"],
        })
      ).model,
    ).toBe("vendor-model");
    const recursive = structuredClone(f.workflow);
    recursive.flows.standard.nodes.at(-1).target = "flow";
    f.kernel.configure({
      "official.ai-router": {
        ...f.router,
        upstreams: {
          ...f.router.upstreams,
          composed: { flow: recursive.flows.standard },
        },
      },
    });
    await expect(
      f.kernel.invoke("ai.routing@2", {
        model: "flow",
        request,
        features: ["text"],
      }),
    ).rejects.toMatchObject({ code: "routing_cycle" });
    expect(f.sent).toHaveLength(0);
    const forbidden = await f.request(
      "/api/plugins/official.ai-router/graph/preview",
      "POST",
      { upstream: "composed", request },
    );
    expect(forbidden.status).toBe(401);
    await forbidden.text();
  } finally {
    await f.cleanup();
  }
});

it("composes an automatic-router channel and keeps previously prepared workflow snapshots immutable", async () => {
  const f = await setup();
  try {
    const router = structuredClone(f.router);
    router.upstreams.smart = { protocol: "auto-router" };
    router.models.smart = { upstream: "smart", model: "p" };
    const workflow = structuredClone(f.workflow);
    workflow.flows.standard.nodes.at(-1).target = "smart";
    f.kernel.configure({
      "official.ai-router": {
        ...router,
        upstreams: {
          ...router.upstreams,
          composed: { flow: workflow.flows.standard },
        },
      },
      "official.auto-router": {
        profiles: {
          p: {
            mode: "both",
            decision: { kind: "rules" },
            fallbackCandidate: "one",
            candidates: [
              {
                id: "one",
                target: "actual",
                strength: 100,
                reasoningEfforts: ["low"],
              },
            ],
          },
        },
      },
    });
    const request = {
      model: "flow",
      messages: [{ role: "user", text: "hello" }],
      tools: [],
      stream: true,
    };
    const old = await f.kernel.invoke<any>("ai.routing@2", {
      model: "flow",
      request,
      features: ["text", "stream"],
    });
    expect(old.targetModelId).toBe("actual");
    expect(old.responseModel).toBe("smart");
    expect(old.workflows[0].profile).toBe("composed");
    workflow.flows.standard.nodes[1].text = "new policy";
    f.kernel.configure({
      "official.ai-router": {
        ...router,
        upstreams: {
          ...router.upstreams,
          composed: { flow: workflow.flows.standard },
        },
      },
    });
    const next = await f.kernel.invoke<any>("ai.routing@2", {
      model: "flow",
      request,
      features: ["text"],
    });
    expect(next.preparedRequest.messages[0].text).toBe("new policy");
    expect(old.preparedRequest.messages[0].text).toBe("policy: concise");
    expect(request.messages).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});

it("executes a physical channel's graph for every mapped model and checks the final target reasoning", async () => {
  const f = await setup();
  try {
    const router = structuredClone(f.router);
    router.upstreams.p.flow = structuredClone(f.workflow.flows.standard);
    router.upstreams.p.flow.nodes.at(-1).type = "provider";
    delete router.upstreams.p.flow.nodes.at(-1).target;
    delete router.upstreams.p.flow.nodes.at(-1).mode;
    router.models.second = { ...router.models.actual, model: "vendor-second" };
    f.kernel.configure({ "official.ai-router": router });
    for (const model of ["actual", "second"])
      for (const stream of [false, true]) {
        const response = await f.request(
          "/v1/chat/completions",
          "POST",
          {
            model,
            messages: [{ role: "user", content: "hi" }],
            stream,
            max_tokens: 100,
          },
          f.admin,
        );
        expect(response.status).toBe(200);
        const body = await response.text();
        const text = stream
          ? body
              .split("\n")
              .filter((line) => line.startsWith("data: {"))
              .map(
                (line) =>
                  JSON.parse(line.slice(6)).choices?.[0]?.delta?.content ?? "",
              )
              .join("")
          : JSON.parse(body).choices[0].message.content;
        expect(text).toBe("workflow OK");
        expect(f.sent.at(-1)).toMatchObject({
          model: model === "actual" ? "vendor-model" : "vendor-second",
          max_completion_tokens: 16,
          reasoning_effort: "low",
          messages: [
            { role: "system", content: "policy: concise" },
            { role: "user", content: "hi" },
          ],
        });
      }
    const invalid = structuredClone(router);
    invalid.upstreams.p.flow.nodes[0].next = ["missing"];
    expect(() => f.kernel.configure({ "official.ai-router": invalid })).toThrow(
      /missing/,
    );
    invalid.upstreams.p.flow = structuredClone(router.upstreams.p.flow);
    invalid.upstreams.p.flow.nodes.find(
      (n: any) => n.type === "reasoning",
    ).effort = "high";
    f.kernel.configure({ "official.ai-router": invalid });
    const before = f.sent.length;
    const rejected = await f.request(
      "/v1/chat/completions",
      "POST",
      { model: "actual", messages: [{ role: "user", content: "hi" }] },
      f.admin,
    );
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).toContain("unsupported_reasoning");
    expect(f.sent).toHaveLength(before);
  } finally {
    await f.cleanup();
  }
});

it("uses graphs on all provider protocols and auto-router selections", async () => {
  const f = await setup();
  try {
    const router = structuredClone(f.router);
    const graph = {
      entry: "s",
      nodes: [
        { id: "s", type: "start", next: ["p"] },
        { id: "p", type: "prompt", text: "channel policy", next: "call" },
        { id: "call", type: "provider" },
      ],
    };
    for (const protocol of [
      "openai-chat",
      "openai-responses",
      "anthropic",
      "gemini",
      "codex",
      "claude-subscription",
      "antigravity",
    ]) {
      router.upstreams[protocol] = {
        ...router.upstreams.p,
        protocol,
        flow: graph,
      };
      router.models[protocol] = {
        upstream: protocol,
        model: "vendor-" + protocol,
      };
    }
    router.upstreams.smart = { protocol: "auto-router", flow: graph };
    router.upstreams.p.flow = graph;
    router.models.smart = { upstream: "smart", model: "one" };
    f.kernel.configure({
      "official.ai-router": router,
      "official.auto-router": {
        profiles: {
          one: {
            mode: "manual",
            decision: { kind: "rules" },
            fixedCandidate: "c",
            fixedEffort: "low",
            candidates: [
              {
                id: "c",
                target: "actual",
                strength: 50,
                reasoningEfforts: ["low"],
              },
            ],
          },
        },
      },
    });
    const normalized = { plugins: [{ path: "/ai-router", config: router }] };
    migrateLegacyChannels({
      plugins: [
        ...normalized.plugins,
        { path: "/workflow", config: f.workflow },
      ],
    });
    f.kernel.configure({ "official.ai-router": router });
    const user = await (
      await f.request(
        "/api/plugins/official.auth/me",
        "GET",
        undefined,
        f.admin,
      )
    ).json();
    const request = {
      model: "smart",
      messages: [{ role: "user", text: "hi" }],
      tools: [],
      stream: false,
    };
    const plan = await f.kernel.invoke<any>("ai.routing@2", {
      model: "smart",
      request,
      features: ["text"],
      principalId: user.id,
    });
    expect(plan.upstreamId).toBe("p");
    expect(plan.workflows.map((w: any) => w.profile)).toEqual(["smart", "p"]);
    expect(plan.preparedRequest.messages).toHaveLength(3);
    expect(plan.reasoning.effort).toBe("low");
    for (const protocol of [
      "openai-chat",
      "openai-responses",
      "anthropic",
      "gemini",
      "codex",
      "claude-subscription",
      "antigravity",
    ]) {
      const p = await f.kernel.invoke<any>("ai.routing@2", {
        model: protocol,
        request: { ...request, model: protocol },
        features: ["text"],
      });
      expect(p.capability).toBe("ai.upstream." + protocol + "@1");
      expect(p.preparedRequest.messages[0].text).toBe("channel policy");
    }
    await expect(
      f.kernel.invoke("ai.routing@2", {
        model: "codex",
        request,
        features: ["text"],
        principalId: user.id,
        channelId: "personal:missing",
      }),
    ).rejects.toMatchObject({ code: "channel_not_found" });
    const controller = new AbortController();
    controller.abort();
    await expect(
      f.kernel.invoke(
        "ai.routing@2",
        { model: "smart", request, features: ["text"] },
        controller.signal,
      ),
    ).rejects.toBeDefined();
    expect(f.sent).toHaveLength(0);
  } finally {
    await f.cleanup();
  }
});

it("migrates legacy graphs equivalently and rejects cyclic routes", async () => {
  const f = await setup();
  try {
    const config = {
      plugins: [
        { path: "/ai-router", config: structuredClone(f.router) },
        { path: "/workflow", config: structuredClone(f.workflow) },
      ],
    };
    const input = {
      model: "flow",
      features: ["text"],
      request: {
        model: "flow",
        messages: [{ role: "user", text: "hi" }],
        tools: [],
        stream: false,
      },
    };
    const before = await f.kernel.invoke<any>("ai.routing@2", input);
    expect(migrateLegacyChannels(config)).toBe(true);
    const router = config.plugins[0]!.config;
    f.kernel.configure({ "official.ai-router": router });
    const after = await f.kernel.invoke<any>("ai.routing@2", input);
    for (const field of [
      "model",
      "pricing",
      "upstreamId",
      "preparedRequest",
      "responseModel",
      "outputPolicy",
    ])
      expect(after[field]).toEqual(before[field]);
    router.upstreams.composed.flow.nodes.at(-1).target = "flow";
    f.kernel.configure({ "official.ai-router": router });
    await expect(f.kernel.invoke("ai.routing@2", input)).rejects.toMatchObject({
      code: "routing_cycle",
    });
    const invalid = structuredClone(router);
    invalid.upstreams.composed.flow = defaultChannelFlow();
    expect(() => f.kernel.configure({ "official.ai-router": invalid })).toThrow(
      /provider/,
    );
    invalid.upstreams.composed.flow.nodes = [
      { id: "s", type: "start", next: ["x"] },
      { id: "x", type: "upstream", target: "missing", mode: "implicit" },
    ];
    invalid.upstreams.composed.flow.entry = "s";
    expect(() => f.kernel.configure({ "official.ai-router": invalid })).toThrow(
      /missing/,
    );
  } finally {
    await f.cleanup();
  }
});

it("persists one untyped channel with multiple provider branches, validates preview access and restores after restart", async () => {
  const f = await setup();
  let restarted: Awaited<ReturnType<typeof createKernel>> | undefined;
  try {
    const config = structuredClone(f.config);
    const router = {
      upstreams: {
        unified: {
          name: "Unified",
          flow: {
            entry: "s",
            nodes: [
              { id: "s", type: "start", next: ["condition"] },
              {
                id: "condition",
                type: "branch",
                condition: false,
                yes: "budget",
                no: "short",
              },
              {
                id: "condition-predicate",
                type: "compare",
                valueType: "boolean",
                operator: "eq",
                left: false,
                right: true,
              },
              { id: "budget", type: "maxTokens", limit: 20, next: "stream" },
              {
                id: "stream",
                type: "provider",
                model: "stream-model",
                upstream: f.connection,
              },
              {
                id: "short",
                type: "provider",
                model: "short-model",
                upstream: f.connection,
              },
            ],
            bindings: [
              {
                source: "s",
                output: "stream",
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
      },
      models: { unified: { upstream: "unified", model: "fallback" } },
    };
    config.plugins.find((p: any) => /[\\/]ai-router$/.test(p.path)).config =
      router;
    const update = await f.request("/api/host/config", "PUT", config, f.admin);
    expect(update.status).toBe(200);
    await update.text();
    const stored = await readConfig(f.file);
    const saved: any = stored.plugins.find((p) =>
      /[\\/]ai-router$/.test(p.path),
    )!.config;
    expect(saved.upstreams.unified.protocol).toBeUndefined();
    expect(
      saved.upstreams.unified.flow.nodes.filter(
        (n: any) => n.type === "provider",
      ),
    ).toHaveLength(2);
    const request = {
      model: "unified",
      messages: [{ role: "user", text: "hi" }],
      tools: [],
      stream: true,
    };
    const anonymous = await f.request(
      "/api/plugins/official.ai-router/graph/preview",
      "POST",
      { upstream: "unified", request },
    );
    expect(anonymous.status).toBe(401);
    await anonymous.text();
    const preview = await f.request(
      "/api/plugins/official.ai-router/graph/preview",
      "POST",
      { upstream: "unified", request },
      f.admin,
    );
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({
      providerId: "stream",
      request: { maxTokens: 20 },
    });
    expect(f.sent).toHaveLength(0);
    const probe = await f.request(
      "/api/plugins/official.ai-router/test",
      "POST",
      { upstream: "unified", publicModel: "unified" },
      f.admin,
    );
    expect(probe.status).toBe(200);
    await probe.text();
    expect(f.sent.at(-1).model).toBe("short-model");
    const oldPlan = await f.kernel.invoke<any>("ai.routing@2", {
      model: "unified",
      request,
      features: ["text", "stream"],
    });
    const updated = structuredClone(config);
    updated.plugins
      .find((p: any) => /[\\/]ai-router$/.test(p.path))
      .config.upstreams.unified.flow.nodes.find(
        (n: any) => n.id === "stream",
      ).model = "new-stream-model";
    const changed = await f.request(
      "/api/host/config",
      "PUT",
      updated,
      f.admin,
    );
    expect(changed.status).toBe(200);
    await changed.text();
    expect(oldPlan.model).toBe("stream-model");
    expect(oldPlan.upstream.baseUrl).toBe(f.router.upstreams.p.baseUrl);
    const invalid = structuredClone(updated);
    invalid.plugins.find((p: any) =>
      /[\\/]ai-router$/.test(p.path),
    ).config.upstreams.unified.flow.nodes[0].next = ["absent"];
    const rejected = await f.request(
      "/api/host/config",
      "PUT",
      invalid,
      f.admin,
    );
    expect(rejected.status).toBe(400);
    await rejected.text();
    await f.kernel.shutdown();
    restarted = await createKernel(await readConfig(f.file));
    await restarted.start();
    for (const stream of [false, true]) {
      const plan = await restarted.invoke<any>("ai.routing@2", {
        model: "unified",
        request: { ...request, stream },
        features: ["text"],
      });
      expect(plan.model).toBe(stream ? "new-stream-model" : "short-model");
      const events = await restarted.invoke<AsyncIterable<any>>(
        "ai.execution@1",
        { plan, request: { ...request, stream } },
      );
      let text = "";
      for await (const event of events)
        if (event.type === "text") text += event.text;
      expect(text).toBe("workflow OK");
      expect(f.sent.at(-1).model).toBe(
        stream ? "new-stream-model" : "short-model",
      );
    }
  } finally {
    await restarted?.shutdown();
    await f.cleanup();
  }
});
