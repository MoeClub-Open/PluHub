import { it, expect, vi } from "vitest";
import { mkdtemp, rm, mkdir, rename, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { auditStore } from "../packages/control/dist/audit.js";
import { fixture } from "./helpers.js";
import { mockHost } from "../packages/testkit/dist/index.js";

it("uses each plugin's route declaration to distinguish previews from changes", async () => {
  const f = await mockHost();
  const entries: { path: string }[] = [];
  f.kernel.setAuditHandler((entry) => {
    entries.push(entry);
  });
  await f.plugin(
    {
      schemaVersion: 1,
      id: "example.operations",
      version: "1.0.0",
      host: ">=0.1.0-alpha.1",
      runtime: { kind: "native", entry: "index.js" },
      provides: [],
      requires: [],
      permissions: ["api.register", "identity.provide"],
    },
    `export default { setup(host) {
    host.identity(async () => ({id:'admin',session:true,permissions:['*']}));
    host.api({method:'POST',path:'/preview',access:'host.manage',audit:false,handle:()=>Response.json({ok:true})});
    host.api({method:'POST',path:'/change',access:'host.manage',handle:()=>Response.json({ok:true})});
  } }`,
  );
  try {
    await f.kernel.start();
    for (const action of ["preview", "change"]) {
      const response = await f.kernel.fetch(
        new Request("http://test/api/plugins/example.operations/" + action, {
          method: "POST",
        }),
      );
      expect(response.status).toBe(200);
      await response.json();
    }
    expect(entries).toHaveLength(2);
    expect(entries.every((entry) => entry.path.endsWith("/change"))).toBe(true);
  } finally {
    await f.close();
  }
});

it("hides historical read-only requests without deleting them or hiding changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pluhub-audit-operations-"));
  const store = auditStore(directory);
  try {
    for (const [id, path, status] of [
      ["quote", "/api/plugins/official.billing/quote", 200],
      ["preview", "/api/plugins/official.ai-router/graph/preview", undefined],
      ["change", "/api/plugins/official.ai-router/configuration", 200],
    ] as const)
      store.write({
        id,
        actorId: "admin",
        createdAt: Date.now() - 400000,
        method: "POST",
        path,
        status,
      });
    expect(
      store.read(new URLSearchParams()).items.map((row) => row.id),
    ).toEqual(["change"]);
    expect(store.status().unresolved).toBe(0);
    const db = new DatabaseSync(join(directory, "admin-audit.sqlite"));
    try {
      expect(db.prepare("SELECT count(*) n FROM admin_audit").get()!.n).toBe(3);
    } finally {
      db.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("records management changes but not read-only POST requests", async () => {
  const f = await fixture(["users", "auth"]);
  try {
    const admin = await f.admin();
    const quote = await f.request(
      "/api/plugins/official.billing/quote",
      "POST",
      {},
      admin,
    );
    const id = quote.headers.get("x-pluhub-request-id")!;
    const records = await (
      await f.request(
        "/api/host/audit?requestId=" + id,
        "GET",
        undefined,
        admin,
      )
    ).json();
    expect(records.total).toBe(0);
    const db = new DatabaseSync(
      join(f.directory, "data", "admin-audit.sqlite"),
    );
    try {
      expect(
        db.prepare("SELECT count(*) n FROM admin_audit WHERE id=?").get(id)!.n,
      ).toBe(0);
    } finally {
      db.close();
    }
  } finally {
    await f.close();
  }
});

it("filters audit results, methods, request IDs, inclusive dates and literal search without changing fault counters", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pluhub-audit-query-"));
  const store = auditStore(directory),
    now = Date.now();
  const query = (value: Record<string, string> = {}) =>
    store.read(new URLSearchParams(value));
  try {
    for (const [
      id,
      status,
      actorId,
      userId,
      path,
      resourceId,
      method,
      createdAt,
    ] of [
      [
        "ok",
        200,
        "actor-a",
        "user-a",
        "/api/path_underscore",
        "resource-a",
        "POST",
        now,
      ],
      [
        "redirect",
        302,
        "actor-a",
        "user-a",
        "/api/ordinary",
        "resource-a",
        "PUT",
        now + 1,
      ],
      [
        "denied",
        403,
        "actor-b",
        "user-b",
        "/api/pathXunderscore",
        "resource-b",
        "PATCH",
        now + 2,
      ],
      [
        "failed",
        500,
        "actor-a",
        "user-b",
        "/api/ordinary",
        "percent%value",
        "DELETE",
        now + 3,
      ],
      [
        "pending",
        undefined,
        "actor-a",
        undefined,
        "/api/ordinary",
        "slash\\value",
        "POST",
        now + 4,
      ],
    ] as const)
      store.write({
        id,
        status,
        actorId,
        userId,
        path,
        resourceId,
        method,
        createdAt,
      });
    expect(query({ result: "success" }).items.map((row) => row.id)).toEqual([
      "redirect",
      "ok",
    ]);
    expect(query({ result: "failure" }).items.map((row) => row.id)).toEqual([
      "failed",
      "denied",
    ]);
    expect(query({ result: "pending" }).items.map((row) => row.id)).toEqual([
      "pending",
    ]);
    expect(
      query({
        requestId: "ok",
        actorId: "actor-a",
        userId: "user-a",
        method: "POST",
        result: "success",
        from: String(now),
        to: String(now),
      }).total,
    ).toBe(1);
    expect(query({ requestId: "ok", result: "failure" }).total).toBe(0);
    expect(query({ q: "_" }).items.map((row) => row.id)).toEqual(["ok"]);
    expect(query({ q: "%" }).items.map((row) => row.id)).toEqual(["failed"]);
    expect(query({ q: "\\" }).items.map((row) => row.id)).toEqual(["pending"]);
    expect(query({ q: "' OR 1=1 --" }).total).toBe(0);
    expect(
      query({ limit: "2", offset: "1" }).items.map((row) => row.id),
    ).toEqual(["failed", "denied"]);
    expect(query({ limit: "2", offset: "1" }).total).toBe(5);
    for (const bad of [
      { result: "unknown" },
      { result: "constructor" },
      { result: "__proto__" },
      { method: "post" },
      { method: "POST OR 1" },
      { from: "-1" },
      { from: "1.5" },
      { from: "1e3" },
      { from: "9007199254740992" },
      { from: "8640000000000001" },
      { from: "2", to: "1" },
      { to: "NaN" },
      { requestId: "x".repeat(129) },
      { q: "x".repeat(257) },
      { userId: "a\n" },
      { limit: "0" },
      { limit: "101" },
      { offset: "-1" },
      { offset: "1.5" },
    ])
      expect(() => query(bad)).toThrow(
        expect.objectContaining({ code: "invalid_request", status: 400 }),
      );
    expect(store.status()).toMatchObject({
      available: true,
      failures: 0,
      writeFailures: 0,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("migrates legacy audit rows, retains unresolved outcomes and prunes expired records on reads and status checks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pluhub-audit-retention-"));
  const file = join(directory, "admin-audit.sqlite"),
    now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    const legacy = new DatabaseSync(file);
    legacy.exec(
      "CREATE TABLE admin_audit(id TEXT PRIMARY KEY,created_at INTEGER NOT NULL,actor_id TEXT NOT NULL,method TEXT NOT NULL,path TEXT NOT NULL,user_id TEXT,resource_id TEXT,status INTEGER,error_code TEXT);",
    );
    legacy
      .prepare("INSERT INTO admin_audit VALUES(?,?,?,?,?,?,?,?,?)")
      .run("legacy", now, "actor", "POST", "/api/test", null, null, 200, null);
    legacy.close();
    const store = auditStore(directory);
    expect(store.read(new URLSearchParams()).items[0]).toMatchObject({
      id: "legacy",
      status: 200,
      reason: null,
    });
    store.write({
      id: "held",
      createdAt: now - 300001,
      actorId: "actor",
      method: "PATCH",
      path: "/api/test",
    });
    store.write({
      id: "boundary",
      createdAt: now - 90 * 86400000,
      actorId: "actor",
      method: "PATCH",
      path: "/api/test",
      status: 200,
    });
    expect(store.status().unresolved).toBe(1);
    expect(store.read(new URLSearchParams()).total).toBe(3);
    clock.mockReturnValue(now + 1);
    expect(store.read(new URLSearchParams()).total).toBe(2);
    clock.mockReturnValue(now + 91 * 86400000);
    expect(store.status()).toMatchObject({
      available: true,
      unresolved: 0,
      retentionDays: 90,
    });
    expect(auditStore(directory).read(new URLSearchParams()).total).toBe(0);
    const db = new DatabaseSync(file);
    expect(db.prepare("SELECT count(*) n FROM admin_audit").get()!.n).toBe(0);
    db.close();
  } finally {
    clock.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});

it("reports storage faults safely, distinguishes write failures and recovers without reclassifying them as successful writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pluhub-audit-unavailable-"));
  const file = join(directory, "admin-audit.sqlite"),
    store = auditStore(directory);
  try {
    await mkdir(file);
    expect(store.status()).toMatchObject({
      available: false,
      failures: 1,
      writeFailures: 0,
      unresolved: null,
    });
    expect(() => store.read(new URLSearchParams())).toThrow(
      expect.objectContaining({ code: "audit_unavailable", status: 503 }),
    );
    expect(() =>
      store.write({
        id: "not-saved",
        actorId: "actor",
        createdAt: Date.now(),
        method: "POST",
        path: "/api/test",
      }),
    ).toThrow(
      expect.objectContaining({ code: "audit_unavailable", status: 503 }),
    );
    await rmdir(file);
    expect(store.status()).toMatchObject({
      available: true,
      failures: 3,
      writeFailures: 1,
      unresolved: 0,
    });
    expect(store.read(new URLSearchParams()).total).toBe(0);
    store.write({
      id: "saved",
      actorId: "actor",
      createdAt: Date.now(),
      method: "POST",
      path: "/api/test",
      status: 200,
    });
    expect(store.read(new URLSearchParams()).total).toBe(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects management mutations before execution when the audit intent cannot be stored, and exposes degradation", async () => {
  const f = await fixture(["users", "auth"]);
  const file = join(f.directory, "data", "admin-audit.sqlite");
  let displaced = false;
  try {
    const admin = await f.admin();
    const user = await f.kernel.invoke<any>("users.manage@1", {
      action: "create",
      username: "audit-protected",
    });
    expect(
      (await f.request("/api/host/status", "GET", undefined, admin)).status,
    ).toBe(200);
    await rename(file, file + ".saved");
    displaced = true;
    await mkdir(file);
    const rejected = await f.request(
      "/api/plugins/official.users/users",
      "PATCH",
      { id: user.id, enabled: false },
      admin,
    );
    expect(rejected.status).toBe(503);
    expect(await rejected.json()).toMatchObject({
      error: { code: "audit_unavailable" },
    });
    expect(
      (await f.kernel.invoke<any>("users.lookup@1", { id: user.id })).enabled,
    ).toBe(true);
    const status = await (
      await f.request("/api/host/status", "GET", undefined, admin)
    ).json();
    expect(status).toMatchObject({
      status: "degraded",
      audit: { available: false },
    });
    expect(status.audit.writeFailures).toBeGreaterThan(0);
    const unavailable = await f.request(
      "/api/host/audit",
      "GET",
      undefined,
      admin,
    );
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).not.toContain(f.directory);
    await rmdir(file);
    await rename(file + ".saved", file);
    displaced = false;
    const retried = await f.request(
      "/api/plugins/official.users/users",
      "PATCH",
      { id: user.id, enabled: false },
      admin,
    );
    expect(retried.status).toBe(200);
    expect(
      (await f.kernel.invoke<any>("users.lookup@1", { id: user.id })).enabled,
    ).toBe(false);
    const requestId = retried.headers.get("x-pluhub-request-id")!;
    const rows = await f.request(
      "/api/host/audit?requestId=" + requestId + "&result=success&method=PATCH",
      "GET",
      undefined,
      admin,
    );
    expect(rows.headers.get("cache-control")).toBe("no-store");
    expect((await rows.json()).items).toHaveLength(1);
    for (const bad of [
      "result=constructor",
      "from=2&to=1",
      "requestId=" + "x".repeat(129),
    ])
      expect(
        (await f.request("/api/host/audit?" + bad, "GET", undefined, admin))
          .status,
      ).toBe(400);
  } finally {
    if (displaced) {
      await rmdir(file);
      await rename(file + ".saved", file);
    }
    await f.close();
  }
});

it("keeps the pending intent when a committed management mutation cannot finalize its audit result", async () => {
  const f = await fixture(["users", "auth"]);
  let db: DatabaseSync | undefined;
  const clock = vi.spyOn(Date, "now");
  try {
    const admin = await f.admin();
    const user = await f.kernel.invoke<any>("users.manage@1", {
      action: "create",
      username: "audit-result",
    });
    expect(
      (await f.request("/api/host/status", "GET", undefined, admin)).status,
    ).toBe(200);
    db = new DatabaseSync(join(f.directory, "data", "admin-audit.sqlite"));
    db.exec(
      "CREATE TRIGGER fail_audit_result BEFORE UPDATE OF status ON admin_audit WHEN NEW.status IS NOT NULL BEGIN SELECT RAISE(ABORT,'fixture audit result unavailable'); END;",
    );
    const result = await f.request(
      "/api/plugins/official.users/users",
      "PATCH",
      { id: user.id, enabled: false },
      admin,
    );
    expect(result.status).toBe(200);
    expect(
      (await f.kernel.invoke<any>("users.lookup@1", { id: user.id })).enabled,
    ).toBe(false);
    const id = result.headers.get("x-pluhub-request-id")!;
    const pending = await (
      await f.request(
        "/api/host/audit?requestId=" + id + "&result=pending",
        "GET",
        undefined,
        admin,
      )
    ).json();
    expect(pending.items).toHaveLength(1);
    expect(pending.items[0]).toMatchObject({ id, status: null });
    expect(pending.writeFailures).toBe(1);
    clock.mockReturnValue(Date.now() + 300001);
    const status = await (
      await f.request("/api/host/status", "GET", undefined, admin)
    ).json();
    expect(status).toMatchObject({
      status: "degraded",
      audit: { available: true, writeFailures: 1, unresolved: 1 },
    });
    db.exec("DROP TRIGGER fail_audit_result;");
    expect(
      auditStore(join(f.directory, "data")).read(
        new URLSearchParams("requestId=" + id),
      ).items[0]!.status,
    ).toBeNull();
  } finally {
    clock.mockRestore();
    db?.close();
    await f.close();
  }
});
