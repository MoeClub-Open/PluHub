import { it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fixture } from "./helpers.js";
import type { Leaderboard } from "@pluhub/contracts/analytics";

const day = 86400000;
const schema = `CREATE TABLE requests (
  id TEXT PRIMARY KEY,user_id TEXT,key_id TEXT,created_at INTEGER NOT NULL,
  model TEXT NOT NULL,upstream TEXT,protocol TEXT NOT NULL,status TEXT NOT NULL,
  http_status INTEGER NOT NULL,latency_ms INTEGER NOT NULL,first_token_ms INTEGER,
  input_tokens INTEGER,output_tokens INTEGER,cost_micro_usd INTEGER,stream INTEGER NOT NULL,error_code TEXT,routing TEXT
); PRAGMA user_version=2;`;
const names = [
  "users",
  "auth",
  "ai-router",
  "observability",
  "leaderboard",
  "http-transport",
  "upstream-openai-chat",
];
const configs = {
  "ai-router": {
    upstreams: {
      platform: {
        protocol: "openai-chat",
        baseUrl: "https://example.test",
        keyRef: "env:PLUHUB_TEST_UPSTREAM_KEY",
      },
    },
    models: {
      alpha: {
        upstream: "platform",
        model: "vendor-secret-alpha",
        name: "Alpha",
        provider: "Example",
      },
      beta: {
        upstream: "platform",
        model: "vendor-secret-beta",
        name: "Beta",
        provider: "Example",
      },
      hidden: { upstream: "platform", model: "vendor-hidden", enabled: false },
    },
  },
};
async function setup() {
  const now = Date.now();
  const f = await fixture(names, configs, async (_kernel, directory) => {
    const userDir = join(directory, "data", "official.users");
    const observationDir = join(directory, "data", "official.observability");
    await mkdir(userDir, { recursive: true });
    await mkdir(observationDir, { recursive: true });
    const users = new DatabaseSync(join(userDir, "users.sqlite"));
    users.exec(
      "CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,role TEXT NOT NULL,enabled INTEGER NOT NULL,created_at TEXT NOT NULL); PRAGMA user_version=1;",
    );
    for (const [id, name, enabled] of [
      ["alice-id", "alice", 1],
      ["bob-id", "bob", 1],
      ["blocked-id", "blocked", 0],
      ["empty-id", "emptyuser", 1],
    ] as const)
      users
        .prepare("INSERT INTO users VALUES(?,?,?,?,?)")
        .run(id, name, "user", enabled, new Date(now).toISOString());
    users.close();
    const db = new DatabaseSync(join(observationDir, "requests.sqlite"));
    db.exec(schema);
    let id = 0;
    const add = (
      user: string | null,
      model: string,
      input: number | null,
      output: number | null,
      age = 0,
      status = "success",
      upstream = "platform",
    ) =>
      db
        .prepare(
          "INSERT INTO requests(id,user_id,key_id,created_at,model,upstream,protocol,status,http_status,latency_ms,first_token_ms,input_tokens,output_tokens,cost_micro_usd,stream,error_code,routing) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          "old-" + ++id,
          user,
          "private-key-id",
          now - age * day,
          model,
          upstream,
          "openai-chat",
          status,
          status === "success" ? 200 : 500,
          10,
          2,
          input,
          output,
          1000000,
          1,
          null,
          '{"targetModel":"private-provider-model"}',
        );
    add("alice-id", "alpha", 100, 20);
    add("alice-id", "beta", 5, 5);
    add("alice-id", "hidden", 1, 1);
    add("alice-id", "alpha", null, null);
    add("bob-id", "alpha", 60, 60);
    for (let i = 0; i < 4; i++) add("bob-id", "alpha", null, null);
    add("bob-id", "beta", 100, 100, 8);
    add("alice-id", "alpha", 1000, 0, 40);
    add("blocked-id", "alpha", 999999, 999999);
    add(null, "alpha", 999999, 999999);
    add("alice-id", "alpha", 999999, 999999, 0, "error");
    add("alice-id", "alpha", 999999, 999999, 0, "cancelled");
    add(
      "bob-id",
      "alpha",
      999999,
      999999,
      0,
      "success",
      "personal:private-channel",
    );
    db.close();
  });
  const admin = await f.admin();
  await f.kernel.invoke("auth.bootstrap@1", {
    userId: "alice-id",
    password: "alice-leaderboard-test-password",
  });
  const login = await f.request("/api/plugins/official.auth/login", "POST", {
    username: "alice",
    password: "alice-leaderboard-test-password",
  });
  expect(login.status).toBe(200);
  const alice = { cookie: login.headers.get("set-cookie")!.split(";")[0]! };
  await login.json();
  const get = async (query = "", headers = alice) => {
    const response = await f.request(
      "/api/plugins/official.leaderboard/rankings" + (query ? "?" + query : ""),
      "GET",
      undefined,
      headers,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    return (await response.json()) as Leaderboard;
  };
  return { ...f, admin, alice, get, now };
}

it("serves site-wide user rankings to ordinary users without leaking private identifiers or request data", async () => {
  const f = await setup();
  try {
    const board = await f.get();
    expect(board.rows.map((row) => [row.name, row.tokens, row.rank])).toEqual([
      ["alice", 132, 1],
      ["bob", 120, 2],
    ]);
    expect(board.me).toMatchObject({
      name: "alice",
      tokens: 132,
      rank: 1,
      isCurrentUser: true,
    });
    expect(board.totals).toMatchObject({
      participants: 2,
      requests: 9,
      tokens: 252,
      usageRequests: 4,
    });
    expect(board.rows[0]!.share).toBeCloseTo(132 / 252);
    const serialized = JSON.stringify(board);
    for (const secret of [
      "alice-id",
      "bob-id",
      "blocked",
      "emptyuser",
      "private-key-id",
      "private-channel",
      "routing",
      "cost_micro_usd",
      "user_id",
      "subjectId",
      "email",
    ])
      expect(serialized).not.toContain(secret);
    expect(
      (await f.get("metric=requests")).rows.map((row) => row.name),
    ).toEqual(["bob", "alice"]);
    const logs = await f.request(
      "/api/plugins/official.observability/requests?scope=all",
      "GET",
      undefined,
      f.alice,
    );
    expect(
      (await logs.json()).data.every((row: any) => row.user_id === "alice-id"),
    ).toBe(true);
  } finally {
    await f.close();
  }
});

it("keeps model rankings in the public platform catalog and does not expose private or disabled models", async () => {
  const f = await setup();
  try {
    const board = await f.get("kind=models");
    expect(board.rows.map((row) => [row.modelId, row.tokens])).toEqual([
      ["alpha", 240],
      ["beta", 10],
    ]);
    expect(board.rows[0]).toMatchObject({
      name: "Alpha",
      provider: "Example",
      requests: 7,
      usageRequests: 2,
      isCurrentUser: false,
    });
    expect(board.me).toBeUndefined();
    expect(board.totals).toMatchObject({
      participants: 2,
      tokens: 250,
      requests: 8,
    });
    expect(JSON.stringify(board)).not.toMatch(
      /vendor-secret|vendor-hidden|personal:|private-channel|hidden|user_id|subjectId/,
    );
  } finally {
    await f.close();
  }
});

it("backfills once before pruning, preserves cumulative aggregates across restart and honors day windows", async () => {
  const f = await setup();
  try {
    expect(
      (await f.get("range=30d")).rows.map((row) => [row.name, row.tokens]),
    ).toEqual([
      ["bob", 320],
      ["alice", 132],
    ]);
    const before = await f.get("range=all");
    expect(before.rows.map((row) => [row.name, row.tokens])).toEqual([
      ["alice", 1132],
      ["bob", 320],
    ]);
    expect(before.coverageSince).toBe(f.now - 40 * day);
    const db = new DatabaseSync(
      join(f.config.dataDir, "official.observability", "requests.sqlite"),
    );
    try {
      expect(
        (
          db
            .prepare("SELECT count(*) n FROM requests WHERE created_at<?")
            .get(f.now - 30 * day) as any
        ).n,
      ).toBe(0);
      expect(
        (db.prepare("PRAGMA user_version").get() as any).user_version,
      ).toBe(6);
    } finally {
      db.close();
    }
    await f.kernel.stop("official.leaderboard");
    await f.kernel.stop("official.observability");
    await f.kernel.enable("official.observability");
    await f.kernel.enable("official.leaderboard");
    const after = await f.get("range=all");
    expect(after.rows).toEqual(before.rows);
    expect(after.coverageSince).toBe(before.coverageSince);
  } finally {
    await f.close();
  }
});

it("rejects anonymous or invalid requests and removes disabled users from all public ranks", async () => {
  const f = await setup();
  try {
    expect(
      (await f.request("/api/plugins/official.leaderboard/rankings")).status,
    ).toBe(401);
    for (const query of [
      "range=365d",
      "kind=channels",
      "metric=cost",
      "metric=tokens%3BDROP%20TABLE%20users",
    ])
      expect(
        (
          await f.request(
            "/api/plugins/official.leaderboard/rankings?" + query,
            "GET",
            undefined,
            f.alice,
          )
        ).status,
      ).toBe(400);
    await f.kernel.invoke("users.manage@1", {
      action: "update",
      id: "bob-id",
      enabled: false,
    });
    const users = await f.get();
    expect(users.rows.map((row) => row.name)).toEqual(["alice"]);
    expect(users.totals.requests).toBe(4);
    expect((await f.get("kind=models")).totals.tokens).toBe(130);
    await f.kernel.stop("official.leaderboard");
    expect(
      (
        await f.request(
          "/api/plugins/official.leaderboard/rankings",
          "GET",
          undefined,
          f.alice,
        )
      ).status,
    ).toBe(404);
    expect(f.kernel.extensions().some((e) => e.path === "/leaderboard")).toBe(
      false,
    );
  } finally {
    await f.close();
  }
});

it("records real non-streaming and streaming calls once, while excluding failures and interrupted streams", async () => {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString());
    const content = input.messages[0].content;
    if (content === "fail") {
      response.writeHead(503);
      response.end();
      return;
    }
    const usage = { prompt_tokens: 12, completion_tokens: 8 };
    if (!input.stream) {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          choices: [{ message: { content: "test" }, finish_reason: "stop" }],
          usage,
        }),
      );
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(
      'data: {"choices":[{"index":0,"delta":{"content":"test"}}]}\n\n',
    );
    if (content === "cut") {
      response.end();
      return;
    }
    response.end(
      "data: " +
        JSON.stringify({
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage,
        }) +
        "\n\ndata: [DONE]\n\n",
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const f = await fixture([...names, "rate-limit", "ingress-openai-chat"]);
  try {
    process.env.PLUHUB_TEST_UPSTREAM_KEY = "local-leaderboard-test-secret";
    f.kernel.configure({
      "official.ai-router": {
        upstreams: {
          primary: {
            protocol: "openai-chat",
            baseUrl: "http://127.0.0.1:" + (server.address() as any).port,
            keyRef: "env:PLUHUB_TEST_UPSTREAM_KEY",
          },
        },
        models: {
          demo: { upstream: "primary", model: "private-demo", name: "Demo" },
        },
      },
    });
    const admin = await f.admin();
    const keyResponse = await f.request(
      "/api/plugins/official.auth/keys",
      "POST",
      { name: "leaderboard-test" },
      admin,
    );
    const key = await keyResponse.json();
    expect(keyResponse.status).toBe(201);
    for (const [stream, content] of [
      [false, "hello"],
      [true, "hello"],
      [false, "fail"],
      [true, "cut"],
    ] as const) {
      const response = await f.request(
        "/v1/chat/completions",
        "POST",
        { model: "demo", messages: [{ role: "user", content }], stream },
        { authorization: "Bearer " + key.token },
      );
      if (content === "fail")
        expect(response.status).toBeGreaterThanOrEqual(400);
      else expect(response.status).toBe(200);
      await response.text();
    }
    const response = await f.request(
      "/api/plugins/official.leaderboard/rankings",
      "GET",
      undefined,
      admin,
    );
    const board = await response.json();
    expect(board.rows).toHaveLength(1);
    expect(board.rows[0]).toMatchObject({
      name: "admin",
      tokens: 40,
      inputTokens: 24,
      outputTokens: 16,
      requests: 2,
      usageRequests: 2,
    });
  } finally {
    await f.close();
    delete process.env.PLUHUB_TEST_UPSTREAM_KEY;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
