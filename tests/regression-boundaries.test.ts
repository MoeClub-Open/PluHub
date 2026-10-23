import { it, expect } from "vitest";
import { fixture } from "./helpers.js";

const users = "/api/plugins/official.users/users";
const auth = "/api/plugins/official.auth";
const billing = "/api/plugins/official.billing";

it("does not expose retired platform credential endpoints", async () => {
  const f = await fixture(["users", "auth", "byok", "http-transport"]);
  try {
    const admin = await f.admin();
    for (const method of ["GET", "POST", "DELETE"]) {
      const response = await f.request(
        "/api/plugins/official.byok/credentials",
        method,
        method === "GET" ? undefined : {},
        admin,
      );
      expect(response.status).toBe(404);
      await response.text();
    }
  } finally {
    await f.close();
  }
});

it("preserves a last administrator and immediately removes elevated access from existing sessions after demotion", async () => {
  const f = await fixture(["users", "auth"]);
  try {
    const admin = await f.admin();
    const first = await (
      await f.request(auth + "/me", "GET", undefined, admin)
    ).json();
    for (const update of [{ enabled: false }, { role: "user" }]) {
      const result = await f.request(
        users,
        "PATCH",
        { id: first.id, ...update },
        admin,
      );
      expect(result.status).toBe(409);
      expect(await result.json()).toMatchObject({
        error: { code: "last_admin" },
      });
    }
    const second = await (
      await f.request(
        users,
        "POST",
        { username: "second-admin", role: "admin" },
        admin,
      )
    ).json();
    expect(second.role).toBe("admin");
    const changed = await f.request(
      users,
      "PATCH",
      { id: first.id, role: "user" },
      admin,
    );
    expect(changed.status).toBe(200);
    await changed.json();
    const current = await (
      await f.request(auth + "/me", "GET", undefined, admin)
    ).json();
    expect(current.role).toBe("user");
    for (const path of ["/api/host/config", "/api/host/plugins", users]) {
      const denied = await f.request(path, "GET", undefined, admin);
      expect(denied.status).toBe(403);
      await denied.text();
    }
    const escalation = await f.request(
      users,
      "PATCH",
      { id: first.id, role: "admin" },
      admin,
    );
    expect(escalation.status).toBe(403);
    await escalation.text();
    expect(
      await f.kernel.invoke("users.lookup@1", { id: second.id }),
    ).toMatchObject({ enabled: true, role: "admin" });
  } finally {
    await f.close();
  }
});

it("invalidates all existing console sessions when an administrator resets a password", async () => {
  const f = await fixture(["users", "auth"]);
  try {
    const admin = await f.admin();
    const user = await (
      await f.request(users, "POST", { username: "password-reset" }, admin)
    ).json();
    const set = async (password: string) => {
      const result = await f.request(
        auth + "/password",
        "POST",
        { userId: user.id, password },
        admin,
      );
      expect(result.status).toBe(200);
      await result.json();
    };
    await set("first-password-123");
    const sessions = await Promise.all(
      [1, 2, 3].map(async () => {
        const result = await f.request(auth + "/login", "POST", {
          username: user.username,
          password: "first-password-123",
        });
        expect(result.status).toBe(200);
        await result.json();
        return { cookie: result.headers.get("set-cookie")!.split(";")[0]! };
      }),
    );
    await set("replacement-password-123");
    for (const session of sessions) {
      const result = await f.request(auth + "/me", "GET", undefined, session);
      expect(result.status).toBe(401);
      await result.json();
    }
    const old = await f.request(auth + "/login", "POST", {
      username: user.username,
      password: "first-password-123",
    });
    expect(old.status).toBe(401);
    await old.json();
    const fresh = await f.request(auth + "/login", "POST", {
      username: user.username,
      password: "replacement-password-123",
    });
    expect(fresh.status).toBe(200);
    await fresh.json();
  } finally {
    await f.close();
  }
});

it("deduplicates concurrent credits, rejects conflicting and invalid money, and isolates public wallet queries", async () => {
  const f = await fixture(["users", "auth", "billing"]);
  try {
    const admin = await f.admin();
    const first = await (
      await f.request(auth + "/me", "GET", undefined, admin)
    ).json();
    const second = await f.kernel.invoke<any>("users.manage@1", {
      action: "create",
      username: "wallet-owner",
    });
    const credit = {
      userId: first.id,
      amount: 100,
      source: "concurrent-payment",
    };
    await Promise.all(
      Array.from({ length: 40 }, () =>
        f.kernel.invoke("billing.credit@1", credit),
      ),
    );
    expect(
      await f.kernel.invoke("billing.balance@1", { userId: first.id }),
    ).toMatchObject({ balance: 100, held: 0 });
    for (const change of [{ amount: 101 }, { userId: second.id }]) {
      await expect(
        f.kernel.invoke("billing.credit@1", { ...credit, ...change }),
      ).rejects.toThrow("already used");
    }
    for (const amount of [
      -1,
      0,
      0.1,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      await expect(
        f.kernel.invoke("billing.credit@1", {
          ...credit,
          source: "invalid:" + String(amount),
          amount,
        }),
      ).rejects.toThrow();
    }
    const adjustment = {
      userId: first.id,
      amount: 25,
      id: "same-admin-adjustment",
      reason: "regression",
    };
    await Promise.all(
      Array.from({ length: 20 }, async () => {
        const response = await f.request(
          billing + "/adjust",
          "POST",
          adjustment,
          admin,
        );
        expect(response.status).toBe(200);
        await response.json();
      }),
    );
    expect(
      await f.kernel.invoke("billing.balance@1", { userId: first.id }),
    ).toMatchObject({ balance: 125 });
    expect(
      await f.kernel.invoke("billing.balance@1", { userId: second.id }),
    ).toMatchObject({ balance: 0 });
    const foreign = await f.request(
      billing + "/wallet?userId=" + second.id,
      "GET",
      undefined,
      admin,
    );
    expect(await foreign.json()).toMatchObject({ balance: 125 });
    const ledger = await (
      await f.request(billing + "/ledger", "GET", undefined, admin)
    ).json();
    expect(ledger).toHaveLength(2);
  } finally {
    await f.close();
  }
});
