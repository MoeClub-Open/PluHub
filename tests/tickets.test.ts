import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { fixture } from "./helpers.js";
import { createKernel, readConfig } from "../packages/control/dist/index.js";
const api = "/api/plugins/official.tickets";
async function setup(config: Record<string, unknown> = {}) {
  const f = await fixture(["users", "auth", "tickets"], { tickets: config });
  const admin = await f.admin();
  async function user(username: string) {
    const value = await f.kernel.invoke<any>("users.manage@1", {
      action: "create",
      username,
      role: "user",
    });
    await f.kernel.invoke("auth.bootstrap@1", {
      userId: value.id,
      password: "support-test-password",
    });
    const login = await f.request("/api/plugins/official.auth/login", "POST", {
      username,
      password: "support-test-password",
    });
    await login.text();
    return {
      id: value.id,
      cookie: { cookie: login.headers.get("set-cookie")!.split(";")[0]! },
    };
  }
  const alice = await user("alice"),
    bob = await user("bob");
  const send = (path: string, body: unknown, headers = alice.cookie) =>
    f.request(api + path, "POST", body, headers);
  const create = (clientId = randomUUID(), overrides = {}) =>
    send("/tickets", {
      subject: "接口问题",
      category: "api",
      priority: "normal",
      message: "需要帮助 <script>alert(1)</script>",
      clientId,
      ...overrides,
    });
  return { ...f, admin, alice, bob, send, create };
}
it("isolates tickets and conversations, requires sessions and restricts administrator endpoints", async () => {
  const f = await setup();
  try {
    expect((await f.request(api + "/tickets")).status).toBe(401);
    const created = await f.create();
    expect(created.status).toBe(201);
    const detail = await created.json(),
      id = detail.ticket.id;
    expect(detail.ticket.ownerId).toBe(f.alice.id);
    expect(detail.messages[0].body).toContain("<script>");
    for (const path of [
      "/ticket?id=" + id,
      "/admin/tickets",
      "/admin/ticket?id=" + id,
    ]) {
      const r = await f.request(api + path, "GET", undefined, f.bob.cookie);
      expect(r.status).toBe(path.startsWith("/admin") ? 403 : 404);
      await r.text();
    }
    const foreignReply = await f.send(
      "/reply",
      { id, message: "foreign", revision: 1, clientId: randomUUID() },
      f.bob.cookie,
    );
    expect(foreignReply.status).toBe(404);
    await foreignReply.text();
    expect(
      (
        await (
          await f.request(api + "/tickets", "GET", undefined, f.bob.cookie)
        ).json()
      ).total,
    ).toBe(0);
    expect(
      (
        await (
          await f.request(api + "/admin/tickets", "GET", undefined, f.admin)
        ).json()
      ).total,
    ).toBe(1);
    const key = await (
      await f.request(
        "/api/plugins/official.auth/keys",
        "POST",
        { name: "no-support-via-key" },
        f.alice.cookie,
      )
    ).json();
    const denied = await f.send("/tickets", {}, {
      authorization: "Bearer " + key.token,
    } as any);
    expect(denied.status).toBe(403);
    await denied.text();
    const spoof = await f.create(randomUUID(), { ownerId: f.bob.id });
    expect(spoof.status).toBe(400);
    await spoof.text();
    const unknown = await f.send("/status", {
      id,
      status: "waiting_user",
      revision: 1,
    });
    expect(unknown.status).toBe(400);
    await unknown.text();
  } finally {
    await f.close();
  }
});
it("makes creation/replies idempotent and protects the reply/close/reopen lifecycle against stale edits", async () => {
  const f = await setup();
  try {
    // Replying to support tickets requires an administrator session, not a fresh
    // five-minute verification intended for sensitive financial operations.
    const authDb = new DatabaseSync(
      join(f.config.dataDir, "official.auth/auth.sqlite"),
    );
    try {
      authDb
        .prepare(
          "UPDATE sessions SET auth_at=0 WHERE user_id IN (SELECT user_id FROM passwords WHERE user_id NOT IN (?,?))",
        )
        .run(f.alice.id, f.bob.id);
    } finally {
      authDb.close();
    }
    const clientId = randomUUID();
    const initial = await (await f.create(clientId)).json();
    const duplicate = await f.create(clientId);
    expect(duplicate.status).toBe(200);
    expect((await duplicate.json()).ticket.id).toBe(initial.ticket.id);
    const id = initial.ticket.id,
      replyId = randomUUID();
    const reply = {
      id,
      message: "请补充请求编号",
      revision: 1,
      clientId: replyId,
    };
    let detail = await (await f.send("/admin/reply", reply, f.admin)).json();
    expect(detail.ticket).toMatchObject({
      status: "waiting_user",
      revision: 2,
    });
    detail = await (await f.send("/admin/reply", reply, f.admin)).json();
    expect(detail.messages).toHaveLength(2);
    expect(detail.ticket.revision).toBe(2);
    const stale = await f.send("/reply", {
      id,
      message: "stale",
      revision: 1,
      clientId: randomUUID(),
    });
    expect(stale.status).toBe(409);
    expect(await stale.text()).toContain("ticket_conflict");
    detail = await (
      await f.send("/reply", {
        id,
        message: "request-123",
        revision: 2,
        clientId: randomUUID(),
      })
    ).json();
    expect(detail.ticket.status).toBe("open");
    detail = await (
      await f.send("/status", { id, status: "closed", revision: 3 })
    ).json();
    expect(detail.ticket.status).toBe("closed");
    const closed = await f.send("/reply", {
      id,
      message: "closed",
      revision: 4,
      clientId: randomUUID(),
    });
    expect(closed.status).toBe(409);
    expect(await closed.text()).toContain("ticket_closed");
    detail = await (
      await f.send("/status", { id, status: "open", revision: 4 })
    ).json();
    expect(detail.ticket.revision).toBe(5);
    expect(
      detail.messages.filter((m: any) => m.kind === "status"),
    ).toHaveLength(2);
  } finally {
    await f.close();
  }
});
it("enforces quotas and validation atomically and unregisters its APIs and pages when disabled", async () => {
  const f = await setup({
    maxOpenPerUser: 1,
    dailyCreateLimit: 2,
    hourlyMessageLimit: 2,
  });
  try {
    const first = await (await f.create()).json();
    let rejected = await f.create();
    expect(rejected.status).toBe(429);
    await rejected.text();
    let detail = await (
      await f.send("/reply", {
        id: first.ticket.id,
        revision: 1,
        message: "first reply",
        clientId: randomUUID(),
      })
    ).json();
    rejected = await f.send("/reply", {
      id: first.ticket.id,
      revision: 2,
      message: "limited reply",
      clientId: randomUUID(),
    });
    expect(rejected.status).toBe(429);
    await rejected.text();
    f.kernel.configure({
      "official.tickets": {
        maxOpenPerUser: 1,
        dailyCreateLimit: 2,
        hourlyMessageLimit: 100,
      },
    });
    await (
      await f.send("/status", {
        id: first.ticket.id,
        revision: detail.ticket.revision,
        status: "closed",
      })
    ).json();
    detail = await (await f.create()).json();
    rejected = await f.send("/status", {
      id: first.ticket.id,
      revision: 3,
      status: "open",
    });
    expect(rejected.status).toBe(429);
    await rejected.text();
    await (
      await f.send("/status", {
        id: detail.ticket.id,
        revision: 1,
        status: "closed",
      })
    ).json();
    rejected = await f.create();
    expect(rejected.status).toBe(429);
    await rejected.text();
    rejected = await f.create(randomUUID(), { message: "x".repeat(8001) });
    expect(rejected.status).toBe(400);
    await rejected.text();
    rejected = await f.request(
      api + "/tickets?limit=-1",
      "GET",
      undefined,
      f.alice.cookie,
    );
    expect(rejected.status).toBe(400);
    await rejected.text();
    const pages = f.kernel.extensions();
    expect(pages.some((p) => p.path === "/tickets")).toBe(true);
    await f.kernel.stop("official.tickets");
    expect(
      f.kernel
        .extensions()
        .some((p) => p.path === "/tickets" || p.path === "/settings/tickets"),
    ).toBe(false);
    expect(
      (await f.request(api + "/tickets", "GET", undefined, f.alice.cookie))
        .status,
    ).toBe(404);
  } finally {
    await f.close();
  }
});
it("paginates long conversations and preserves tickets, author identity and sessions after restart", async () => {
  const f = await setup({ hourlyMessageLimit: 1000 });
  let restarted: any;
  try {
    let detail = await (await f.create()).json();
    const id = detail.ticket.id;
    for (let n = 0; n < 55; n++)
      detail = await (
        await f.send("/reply", {
          id,
          revision: detail.ticket.revision,
          message: "reply " + n,
          clientId: randomUUID(),
        })
      ).json();
    expect(detail.messages).toHaveLength(50);
    expect(detail.hasMore).toBe(true);
    const older = await (
      await f.request(
        api + "/ticket?id=" + id + "&before=" + detail.nextBefore,
        "GET",
        undefined,
        f.alice.cookie,
      )
    ).json();
    expect(older.messages).toHaveLength(6);
    expect(older.hasMore).toBe(false);
    expect(
      new Set([...older.messages, ...detail.messages].map((m: any) => m.id))
        .size,
    ).toBe(56);
    await f.kernel.shutdown();
    restarted = await createKernel(await readConfig(f.file));
    await restarted.start();
    const response = await restarted.fetch(
      new Request("http://localhost" + api + "/ticket?id=" + id, {
        headers: f.alice.cookie,
      }),
    );
    expect(response.status).toBe(200);
    const saved = await response.json();
    expect(saved.ticket.revision).toBe(56);
    expect(saved.messages.at(-1).authorName).toBe("alice");
  } finally {
    await restarted?.shutdown();
    await f.close();
  }
});
