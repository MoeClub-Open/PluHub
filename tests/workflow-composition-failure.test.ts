import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { fixture } from "./helpers.js";
import { createWorkflowTemplate } from "../../PluHub-Plugins/lib/ui/workflow-templates.js";

async function setup(
  handler: (
    model: string,
    response: import("node:http").ServerResponse,
  ) => void,
) {
  const seen: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const model = JSON.parse(Buffer.concat(chunks).toString()).model;
    seen.push(model);
    handler(model, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const f = await fixture(
    [
      "users",
      "auth",
      "ai-router",
      "byok",
      "billing",
      "observability",
      "rate-limit",
      "http-transport",
      "upstream-openai-chat",
      "ingress-openai-chat",
    ],
    {
      "upstream-openai-chat": { secretRefs: [] },
      byok: { allowedPrivateOrigins: [origin] },
    },
  );
  const admin = await f.admin();
  const me = await (
    await f.request("/api/plugins/official.auth/me", "GET", undefined, admin)
  ).json();
  const config = await (
    await f.request(
      "/api/plugins/official.ai-router/configuration",
      "GET",
      undefined,
      admin,
    )
  ).json();
  const baseUrl = `${origin}/v1`;
  const flow = createWorkflowTemplate("discussion", {
    primary: "first",
    secondary: "second",
    summary: "summary",
  });
  config.config.upstreams = {
    provider: {
      flow: {
        entry: "start",
        nodes: [
          { id: "start", type: "start", next: "call" },
          {
            id: "call",
            type: "provider",
            upstream: { protocol: "openai-chat", baseUrl, keyRef: "test-key" },
          },
        ],
      },
    },
    workflow: { flow },
  };
  config.config.models = {
    first: {
      upstream: "provider",
      model: "first-upstream",
      inputPrice: 1,
      outputPrice: 1,
    },
    second: {
      upstream: "provider",
      model: "second-upstream",
      inputPrice: 1,
      outputPrice: 1,
    },
    summary: {
      upstream: "provider",
      model: "summary-upstream",
      inputPrice: 1,
      outputPrice: 1,
    },
    discussion: {
      upstream: "workflow",
      model: "discussion",
      inputPrice: 1,
      outputPrice: 1,
    },
  };
  const saved = await f.request(
    "/api/plugins/official.ai-router/configuration",
    "PUT",
    config,
    admin,
  );
  expect(saved.status, await saved.clone().text()).toBe(200);
  f.kernel.configure({ "official.billing": { enabled: true } });
  await f.kernel.invoke("billing.credit@1", {
    userId: me.id,
    amount: 1000000,
    source: "workflow-test-credit",
  });
  return {
    ...f,
    admin,
    me,
    seen,
    baseUrl,
    reservations() {
      const db = new DatabaseSync(
        join(f.config.dataDir, "official.billing/billing.sqlite"),
      );
      try {
        return db
          .prepare(
            "SELECT id,status,actual FROM reservations ORDER BY created_at,id",
          )
          .all() as any[];
      } finally {
        db.close();
      }
    },
    async children(id: string) {
      const response = await f.request(
        `/api/plugins/official.observability/requests/children?parentId=${id}`,
        "GET",
        undefined,
        admin,
      );
      expect(response.status, await response.clone().text()).toBe(200);
      return (await response.json()).data as any[];
    },
    async cleanup() {
      await f.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const result = JSON.stringify({
  choices: [{ message: { content: "valid response" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 2 },
});

it.each(["llm", "jev"] as const)(
  "does not let a personal %s node bypass an API key's model restriction",
  async (kind) => {
    const f = await setup((_model, response) => {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(result);
    });
    try {
      const user = await f.kernel.invoke<any>("users.manage@1", {
        action: "create",
        username: "personal-workflow-user",
        role: "user",
      });
      await f.kernel.invoke("auth.bootstrap@1", {
        userId: user.id,
        password: "workflow-user-password",
      });
      const login = await f.request(
        "/api/plugins/official.auth/login",
        "POST",
        {
          username: "personal-workflow-user",
          password: "workflow-user-password",
        },
      );
      const session = {
        cookie: login.headers.get("set-cookie")!.split(";")[0]!,
      };
      await login.text();
      const channelResponse = await f.request(
        "/api/plugins/official.byok/personal-channels",
        "POST",
        {
          name: "Personal workflow",
          preset: "custom",
          protocol: "openai-chat",
          baseUrl: f.baseUrl,
          key: "personal-test-key",
          models: { "personal-a": { model: "personal-target" } },
          flow: {
            entry: "start",
            nodes: [
              { id: "start", type: "start", next: "response" },
              ...(kind === "llm"
                ? [
                    {
                      id: "call-b",
                      type: "llm",
                      model: "first",
                      promptMode: "append",
                    },
                  ]
                : [
                    {
                      id: "call-b",
                      type: "jev",
                      model: "first",
                      state: "question",
                      questions: {
                        route: {
                          type: "choice",
                          instructions: "Choose",
                          criteria: { yes: "yes", no: "no" },
                        },
                      },
                      answerKey: "route",
                    },
                  ]),
              { id: "response", type: "response", text: "" },
            ],
            bindings: [
              {
                source: "call-b",
                output: kind === "llm" ? "text" : "choice",
                target: "response",
                input: "text",
              },
            ],
          },
        },
        session,
      );
      expect(channelResponse.status, await channelResponse.clone().text()).toBe(
        201,
      );
      const channel = await channelResponse.json();
      const created = await f.request(
        "/api/plugins/official.auth/keys",
        "POST",
        {
          name: "personal-only",
          models: ["personal-a"],
          channelIds: [channel.id],
        },
        session,
      );
      expect(created.status, await created.clone().text()).toBe(201);
      const key = await created.json();
      const response = await f.request(
        "/v1/chat/completions",
        "POST",
        {
          model: "personal-a",
          messages: [{ role: "user", content: "question" }],
          max_tokens: 32,
        },
        { authorization: "Bearer " + key.token },
      );
      expect(response.status).toBe(403);
      expect((await response.json()).error.code).toBe("model_forbidden");
      expect(f.seen).toEqual([]);
      expect(f.reservations()).toEqual([]);
    } finally {
      await f.cleanup();
    }
  },
);

it("settles the successful concurrent call when another discussion call fails", async () => {
  const f = await setup((model, response) => {
    if (model === "first-upstream") {
      response.writeHead(500).end("upstream failed");
    } else {
      setTimeout(
        () =>
          response
            .writeHead(200, { "content-type": "application/json" })
            .end(result),
        100,
      );
    }
  });
  try {
    const response = await f.request(
      "/v1/chat/completions",
      "POST",
      {
        model: "discussion",
        messages: [{ role: "user", content: "question" }],
        max_tokens: 32,
      },
      f.admin,
    );
    const requestId = response.headers.get("x-pluhub-request-id")!;
    expect(response.status).toBeGreaterThanOrEqual(400);
    await response.text();
    expect(f.seen.sort()).toEqual(["first-upstream", "second-upstream"]);
    const children = await f.children(requestId);
    expect(children.map((row) => row.workflow_node_id).sort()).toEqual([
      "first",
      "second",
    ]);
    const reservations = f.reservations();
    expect(reservations.map((row) => row.status).sort()).toEqual([
      "settled",
      "settled",
    ]);
    const settled = reservations.find((row) => row.actual === 5);
    expect(settled.actual).toBe(5);
    expect(
      children.find((row) => row.id === settled.id)?.workflow_node_id,
    ).toBe("second");
    expect(
      (await f.kernel.invoke<any>("billing.balance@1", { userId: f.me.id }))
        .balance,
    ).toBe(1_000_000 - reservations.reduce((sum, row) => sum + row.actual, 0));
  } finally {
    await f.cleanup();
  }
});

it("rejects a reached channel limit before starting paid workflow nodes", async () => {
  const f = await setup((_model, response) => {
    response.writeHead(200, { "content-type": "application/json" }).end(result);
  });
  try {
    const config = await (
      await f.request(
        "/api/plugins/official.ai-router/configuration",
        "GET",
        undefined,
        f.admin,
      )
    ).json();
    const flow = config.config.upstreams.workflow.flow;
    flow.nodes.find((node: any) => node.id === "start").next = "limit";
    flow.nodes.push({
      id: "limit",
      type: "rateLimit",
      rule: { rpm: 1 },
      next: "response",
    });
    const saved = await f.request(
      "/api/plugins/official.ai-router/configuration",
      "PUT",
      config,
      f.admin,
    );
    expect(saved.status, await saved.clone().text()).toBe(200);
    f.kernel.configure({ "official.billing": { enabled: true } });
    const payload = {
      model: "discussion",
      messages: [{ role: "user", content: "question" }],
      max_tokens: 32,
    };
    const first = await f.request(
      "/v1/chat/completions",
      "POST",
      payload,
      f.admin,
    );
    expect(first.status, await first.clone().text()).toBe(200);
    await first.text();
    expect(f.seen).toHaveLength(3);
    expect(f.reservations()).toHaveLength(3);
    const blocked = await f.request(
      "/v1/chat/completions",
      "POST",
      payload,
      f.admin,
    );
    expect(blocked.status, await blocked.clone().text()).toBe(429);
    await blocked.text();
    expect(f.seen).toHaveLength(3);
    expect(f.reservations()).toHaveLength(3);
  } finally {
    await f.cleanup();
  }
});

it("records and retains reservations for canceled in-flight workflow calls", async () => {
  let started!: () => void;
  const bothStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  let count = 0;
  const f = await setup((_model, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"choices":');
    if (++count === 2) started();
  });
  try {
    const controller = new AbortController();
    const pending = f.kernel.fetch(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", ...f.admin },
        body: JSON.stringify({
          model: "discussion",
          messages: [{ role: "user", content: "question" }],
          max_tokens: 32,
        }),
        signal: controller.signal,
      }),
    );
    await Promise.race([
      bothStarted,
      pending.then(async (response) => {
        throw new Error(
          `Workflow ended before both calls started: ${response.status} ${await response.text()}`,
        );
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("Workflow calls did not start")),
          3000,
        ),
      ),
    ]);
    controller.abort();
    const response = await pending;
    const requestId = response.headers.get("x-pluhub-request-id")!;
    await response.text().catch(() => undefined);
    await vi.waitFor(() => {
      const reservations = f.reservations();
      expect(reservations).toHaveLength(2);
      expect(reservations.every((row) => row.status === "settled")).toBe(true);
    });
    const children = await f.children(requestId);
    expect(children.map((row) => row.workflow_node_id).sort()).toEqual([
      "first",
      "second",
    ]);
    expect(children.every((row) => row.status !== "success")).toBe(true);
  } finally {
    await f.cleanup();
  }
});
