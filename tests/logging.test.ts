import { it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  createLogSanitizer,
  newLog,
  type RuntimeLog,
} from "../packages/kernel/dist/logging.js";
import { runtimeLogStore } from "../packages/control/dist/logs.js";
import { mockHost } from "../packages/testkit/dist/index.js";
import { fixture } from "./helpers.js";
import {
  createKernel,
  attachManagement,
} from "../packages/control/dist/index.js";

it("scrubs known secrets, credentials, URL queries and control characters before either log sink", () => {
  const scrub = createLogSanitizer();
  scrub.register("known-private-value");
  for (const value of [
    "known-private-value",
    "Bearer abcdefghi",
    "Basic dXNlcjpwYXNz",
    "sk-abcdefghijklmnop",
    "ph_abcdefghijklmnop",
    "-----BEGIN PRIVATE KEY-----\nprivate-key-body\n-----END PRIVATE KEY-----",
    'password="password-value"',
    '{"refresh_token":"refresh-value"}',
    "api_key=key-value",
  ])
    expect(scrub.text(value)).toContain("[REDACTED]");
  const url = scrub.text(
    "Failed https://user:password@provider.example/v1?token=unknown#fragment",
  );
  expect(url).toBe("Failed https://provider.example/v1");
  expect(scrub.text("\u001b[31mred\u0000\ntext")).toBe("red  text");
  expect(scrub.text('password="private value with spaces"')).toBe(
    "password=[REDACTED]",
  );
  expect(scrub.text("x".repeat(10000)).length).toBe(2048);
  const once = scrub.text('password="private value" token=[REDACTED]');
  expect(scrub.text(once)).toBe(once);
  expect(
    scrub.text("x".repeat(250) + "ph_abcdefghijklmnop", 256),
  ).not.toContain("ph_");
});

it("persists, filters and bounds runtime logs, prunes idle data and closes the database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pluhub-logs-"));
  let store = runtimeLogStore(directory, { maxRows: 3, sweepMs: 20 });
  try {
    for (let i = 0; i < 6; i++)
      store.write({
        ...newLog("test.plugin", i === 5 ? "error" : "info", "message " + i),
        requestId: "request-" + i,
        time: Date.now() + i,
      });
    expect(store.read(new URLSearchParams()).total).toBe(3);
    expect(
      store.read(
        new URLSearchParams(
          "level=error&requestId=request-5&plugin=test.plugin&q=message%205",
        ),
      ).items,
    ).toHaveLength(1);
    expect(store.read(new URLSearchParams("q=%25")).total).toBe(0);
    expect(
      store.read(new URLSearchParams("offset=1&limit=1")).items,
    ).toHaveLength(1);
    for (const query of [
      "level=debug",
      "limit=100000",
      "offset=-1",
      "from=foo",
      "from=2&to=1",
    ])
      expect(() => store.read(new URLSearchParams(query))).toThrow();
    store.close();
    store = runtimeLogStore(directory, { maxRows: 3, sweepMs: 20 });
    expect(store.read(new URLSearchParams()).total).toBe(3);
    store.write({
      ...newLog("host", "info", "expired"),
      time: Date.now() - 31 * 86400000,
    });
    const db = new DatabaseSync(join(directory, "runtime-logs.sqlite"));
    // Age existing rows externally: the timer must prune without a read or write trigger.
    db.prepare("UPDATE runtime_logs SET time=?").run(
      Date.now() - 31 * 86400000,
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(
      (db.prepare("SELECT COUNT(*) n FROM runtime_logs").get() as any).n,
    ).toBe(0);
    db.close();
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("counts unavailable log storage without throwing from writes or leaking the underlying error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pluhub-logs-failure-"));
  await writeFile(join(directory, "not-a-directory"), "occupied");
  const store = runtimeLogStore(join(directory, "not-a-directory"));
  try {
    expect(() => store.write(newLog("host", "error", "failure"))).not.toThrow();
    expect(() => store.read(new URLSearchParams())).toThrow(
      "Runtime log storage is unavailable",
    );
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("associates native logs and completed, failed and cancelled streams with one request ID", async () => {
  const f = await mockHost(),
    entries: RuntimeLog[] = [];
  f.kernel.setLogHandler((entry) => entries.push(entry));
  try {
    await f.plugin(
      {
        schemaVersion: 1,
        id: "test.logging",
        version: "1.0.0",
        host: ">=0.1.0-alpha.1",
        runtime: { kind: "native", entry: "index.mjs" },
        provides: [],
        requires: [],
        permissions: ["http.route"],
      },
      `export default {setup(h){
      h.route({method:'POST',path:'/log/*',access:'public',handle(r){h.log('warn','test message sk-abcdefghijklmnop');
        if(r.url.includes('/throw')) throw new Error('password=private-value');
        if(r.url.includes('/stream-error')) return new Response(new ReadableStream({pull(){throw new Error('stream broke')}}));
        if(r.url.includes('/cancel')) return new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array([1]))}}));
        return new Response('ok');}})
    }}`,
    );
    await f.kernel.start();
    const send = (path: string, signal?: AbortSignal) =>
      f.kernel.fetch(
        new Request("http://test/log/" + path + "?token=private-query", {
          method: "POST",
          body: "private-body",
          headers: { authorization: "private-header" },
          signal,
        }),
      );
    const normal = await send("ok");
    await normal.text();
    const id = normal.headers.get("x-pluhub-request-id");
    const correlated = entries.filter((e) => e.requestId === id);
    expect(correlated).toHaveLength(2);
    expect(correlated[0]).toMatchObject({
      plugin: "test.logging",
      level: "warn",
      message: "test message [REDACTED]",
    });
    expect(correlated[1]).toMatchObject({
      status: 200,
      message: "Request completed",
      path: "/log/ok",
    });
    const failure = await send("throw");
    await failure.text();
    expect(
      entries.find(
        (e) =>
          e.requestId === failure.headers.get("x-pluhub-request-id") &&
          e.status === 500,
      ),
    ).toMatchObject({ level: "error", code: "internal_error" });
    const stream = await send("stream-error");
    await stream.text().catch(() => {});
    expect(
      entries.find(
        (e) =>
          e.requestId === stream.headers.get("x-pluhub-request-id") &&
          e.status === 200,
      ),
    ).toMatchObject({ level: "error", code: "stream_error" });
    const cancelled = await send("cancel");
    await cancelled.body!.cancel();
    expect(
      entries.filter(
        (e) =>
          e.requestId === cancelled.headers.get("x-pluhub-request-id") &&
          e.code === "cancelled",
      ),
    ).toHaveLength(1);
    const abort = new AbortController(),
      aborted = await send("cancel", abort.signal);
    abort.abort();
    await aborted.text().catch(() => {});
    expect(
      entries.find(
        (e) =>
          e.requestId === aborted.headers.get("x-pluhub-request-id") &&
          e.code === "cancelled",
      ),
    ).toBeDefined();
    const log = JSON.stringify(entries);
    for (const secret of [
      "private-query",
      "private-body",
      "private-header",
      "private-value",
      "sk-abcdefghijklmnop",
    ])
      expect(log).not.toContain(secret);
    f.kernel.setLogHandler(() => {
      throw new Error("sink unavailable");
    });
    expect(await (await send("ok")).text()).toBe("ok");
  } finally {
    await f.close();
  }
});

it("allows only administrator sessions to query persisted runtime logs and avoids logging log queries", async () => {
  const f = await fixture(["users", "auth"]);
  try {
    const admin = await f.admin();
    await (await f.request("/missing")).text();
    const initial = await (
      await f.request("/api/host/logs", "GET", undefined, admin)
    ).json();
    expect(
      initial.items.some((r: any) => r.path === "/missing" && r.status === 404),
    ).toBe(true);
    expect(
      (
        await (
          await f.request("/api/host/logs", "GET", undefined, admin)
        ).json()
      ).total,
    ).toBe(initial.total);
    expect((await f.request("/api/host/logs")).status).toBe(401);
    const created = await (
      await f.request(
        "/api/plugins/official.auth/users",
        "POST",
        { username: "log-user", password: "log-user-password", role: "user" },
        admin,
      )
    ).json();
    const login = await f.request("/api/plugins/official.auth/login", "POST", {
      username: "log-user",
      password: "log-user-password",
    });
    await login.text();
    const cookie = { cookie: login.headers.get("set-cookie")!.split(";")[0]! };
    expect(created.id).toBeTruthy();
    expect(
      (await f.request("/api/host/logs", "GET", undefined, cookie)).status,
    ).toBe(403);
    const key = await (
      await f.request(
        "/api/plugins/official.auth/keys",
        "POST",
        { name: "log-admin-key" },
        admin,
      )
    ).json();
    expect(
      (
        await f.request("/api/host/logs", "GET", undefined, {
          authorization: "Bearer " + key.token,
        })
      ).status,
    ).toBe(403);
    await f.kernel.shutdown();
    const restarted = await createKernel(f.config);
    attachManagement(restarted, f.file, f.config);
    try {
      await restarted.start();
      const response = await restarted.fetch(
        new Request("http://localhost/api/host/logs?q=Plugin%20started", {
          headers: admin,
        }),
      );
      expect(response.status).toBe(200);
      expect((await response.json()).total).toBeGreaterThan(0);
    } finally {
      await restarted.shutdown();
    }
  } finally {
    await f.close();
  }
});

it("preserves process plugin log severity and rejects invalid levels", async () => {
  const f = await mockHost(),
    entries: RuntimeLog[] = [];
  f.kernel.setLogHandler((entry) => entries.push(entry));
  try {
    await f.plugin(
      {
        schemaVersion: 1,
        id: "test.process-log",
        version: "1.0.0",
        host: ">=0.1.0-alpha.1",
        runtime: { kind: "process", entry: "index.js" },
        provides: [],
        requires: [],
        permissions: [],
      },
      `
      let buffer=''; const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');
      process.stdin.on('data',data=>{buffer+=data;let at;while((at=buffer.indexOf('\\n'))>=0){const m=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);
      if(m.method==='plugin.initialize') {for(const [i,level] of ['info','warn','error','debug'].entries())send({jsonrpc:'2.0',id:100+i,method:'host.log',params:{level,message:'process '+level}});send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1,capabilities:[]}});}
      else if(m.method==='plugin.health')send({jsonrpc:'2.0',id:m.id,result:{ready:true}});
      else if(m.method==='plugin.drain')send({jsonrpc:'2.0',id:m.id,result:null});
      else if(m.id===103){if(!m.error)process.exit(2);}
      else if(m.method==='plugin.stop'){send({jsonrpc:'2.0',id:m.id,result:null});}
      }});`,
    );
    await f.kernel.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      entries
        .filter((e) => e.message.startsWith("process "))
        .map((e) => e.level),
    ).toEqual(["info", "warn", "error"]);
    expect(f.kernel.list()[0]!.state).toBe("Active");
  } finally {
    await f.close();
  }
});
