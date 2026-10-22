import { it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID, scryptSync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fixture } from "./helpers.js";
import {
  attachManagement,
  createKernel,
  readConfig,
} from "../packages/control/dist/index.js";

const api = "/api/host/setup";
const headers = { origin: "http://localhost", "x-pluhub-setup": "1" };
const password = "first-install-admin-password";
const site = {
  branding: { name: "测试网关", supportEmail: "help@example.test" },
  portal: { enabled: true, title: "欢迎使用", description: "初始化门户" },
};
async function state(f: any) {
  return (await f.request(api)).json();
}
async function save(f: any, step: number, extra = {}) {
  return f.request(
    api,
    "POST",
    {
      action: "site",
      revision: (await state(f)).revision,
      step,
      ...site,
      ...extra,
    },
    headers,
  );
}
async function create(f: any, extra = {}) {
  return f.request(
    api,
    "POST",
    {
      action: "admin",
      revision: (await state(f)).revision,
      username: "admin",
      password,
      ...extra,
    },
    headers,
  );
}
it("saves site and portal before the first administrator, closes setup permanently and supports normal login", async () => {
  const f = await fixture(["console", "users", "auth"]);
  try {
    expect(await state(f)).toMatchObject({
      required: true,
      stage: "site",
      step: 0,
    });
    expect((await create(f)).status).toBe(409);
    const others = f.config.plugins.filter(
      (p: any) => !p.path.endsWith("console"),
    );
    for (const step of [0, 1]) {
      expect((await save(f, step)).status).toBe(200);
      expect(
        await f.kernel.invoke("users.manage@1", { action: "list" }),
      ).toEqual([]);
    }
    expect((await save(f, 2)).status).toBe(200);
    expect(await state(f)).toMatchObject({
      required: true,
      stage: "admin",
      step: 3,
    });
    expect(await f.kernel.invoke("users.manage@1", { action: "list" })).toEqual(
      [],
    );
    const persisted = await readConfig(f.file);
    expect(
      persisted.plugins.filter((p: any) => !p.path.endsWith("console")),
    ).toEqual(others);
    expect(
      (await (await f.request("/console/public")).json()).branding.name,
    ).toBe("测试网关");
    expect((await create(f, { password: "too-short" })).status).toBe(400);
    expect(await f.kernel.invoke("users.manage@1", { action: "list" })).toEqual(
      [],
    );
    const made = await create(f);
    expect(made.status, await made.clone().text()).toBe(201);
    expect(await made.json()).toEqual({ required: false, stage: "complete" });
    expect(await state(f)).toEqual({ required: false, stage: "complete" });
    expect(
      (await create(f, { password: "attempted-reset-password" })).status,
    ).toBe(409);
    expect((await save(f, 0)).status).toBe(409);
    const login = await f.request("/api/plugins/official.auth/login", "POST", {
      username: "admin",
      password,
    });
    expect(login.status).toBe(200);
    expect(login.headers.get("set-cookie")).toContain("HttpOnly");
    expect((await login.json()).role).toBe("admin");
    const done = await readConfig(f.file);
    expect(
      done.plugins.find((p: any) => p.path.endsWith("console"))?.config
        ?.onboarding,
    ).toMatchObject({ completed: true });
  } finally {
    await f.close();
  }
});
it("keeps host APIs private and rejects cross-site, stale, unsafe or unbounded initialization writes", async () => {
  const f = await fixture(["console", "users", "auth"]);
  try {
    const before = await readFile(f.file, "utf8"),
      version = f.kernel.graphVersion;
    const body = {
      action: "site",
      revision: (await state(f)).revision,
      step: 0,
      ...site,
    };
    for (const h of [
      {},
      { origin: "https://evil.test", "x-pluhub-setup": "1" },
      { origin: "http://localhost" },
      { ...headers, "sec-fetch-site": "cross-site" },
    ])
      expect((await f.request(api, "POST", body, h)).status).toBe(403);
    expect((await f.request("/api/host/config")).status).toBe(401);
    expect(
      (await f.request("/api/host/config", "PUT", f.config, headers)).status,
    ).toBe(401);
    expect(
      (await f.request(api, "POST", { ...body, plugins: [] }, headers)).status,
    ).toBe(400);
    expect(
      (
        await f.request(
          api,
          "POST",
          {
            ...body,
            branding: { name: "unsafe", logoUrl: "javascript:alert(1)" },
          },
          headers,
        )
      ).status,
    ).toBe(400);
    expect(
      (await f.request(api, "POST", { ...body, revision: "stale" }, headers))
        .status,
    ).toBe(409);
    expect(
      (
        await f.request(
          api,
          "POST",
          { ...body, portal: { title: "x".repeat(300000) } },
          headers,
        )
      ).status,
    ).toBe(413);
    expect(await readFile(f.file, "utf8")).toBe(before);
    expect(f.kernel.graphVersion).toBe(version);
    expect((await save(f, 0)).status).toBe(200);
    expect((await f.request(api, "POST", body, headers)).status).toBe(409);
  } finally {
    await f.close();
  }
});
it("accepts only one concurrent initial administrator and never promotes an existing ordinary user", async () => {
  const f = await fixture(["console", "users", "auth"]);
  try {
    await f.kernel.invoke("users.manage@1", {
      action: "create",
      username: "occupied",
      role: "user",
    });
    await save(f, 2);
    expect((await create(f, { username: "occupied" })).status).toBe(409);
    const revision = (await state(f)).revision;
    const responses = await Promise.all(
      ["admin", "otheradmin"].map((username) =>
        f.request(
          api,
          "POST",
          { action: "admin", revision, username, password },
          headers,
        ),
      ),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    const users: any[] = await f.kernel.invoke("users.manage@1", {
      action: "list",
    });
    expect(users.filter((u) => u.role === "admin")).toHaveLength(1);
    expect(users.find((u) => u.username === "occupied")?.role).toBe("user");
    await expect(
      f.kernel.invoke("auth.setup@1", {
        action: "create",
        username: "third",
        password,
      }),
    ).rejects.toThrow("管理员已存在");
  } finally {
    await f.close();
  }
});
it("resumes saved first-install steps across restart and preserves existing legacy administrator sites", async () => {
  const f = await fixture(["console", "users", "auth"]);
  try {
    await save(f, 0);
    const saved = await state(f);
    await f.kernel.shutdown();
    const config = await readConfig(f.file),
      restarted = await createKernel(config);
    attachManagement(restarted, f.file, config);
    try {
      await restarted.start();
      expect(
        await (
          await restarted.fetch(new Request("http://localhost" + api))
        ).json(),
      ).toEqual(saved);
      await restarted.invoke("auth.bootstrap@1", {
        username: "legacyadmin",
        password,
      });
      expect(
        await (
          await restarted.fetch(new Request("http://localhost" + api))
        ).json(),
      ).toEqual({ required: false, stage: "complete" });
      const after = await readConfig(f.file);
      expect(after).toEqual(config);
    } finally {
      await restarted.shutdown();
    }
  } finally {
    await f.close();
  }
});
it("recovers an interrupted cross-plugin administrator creation", async () => {
  const f = await fixture(["console", "users", "auth"]);
  try {
    const id = randomUUID(),
      salt = "setup-test-salt";
    const hash =
      salt +
      ":" +
      scryptSync(password, salt, 64, {
        N: 32768,
        r: 8,
        p: 1,
        maxmem: 64 * 1024 * 1024,
      }).toString("hex");
    await f.kernel.invoke("users.manage@1", {
      action: "create-initial-admin",
      id,
      username: "recovered",
    });
    const db = new DatabaseSync(
      join(f.config.dataDir, "official.auth", "auth.sqlite"),
    );
    db.prepare("INSERT INTO setup_admin VALUES(?,?,?)").run(
      id,
      "recovered",
      hash,
    );
    db.close();
    await f.kernel.shutdown();
    const config = await readConfig(f.file),
      restarted = await createKernel(config);
    attachManagement(restarted, f.file, config);
    try {
      await restarted.start();
      const login = await restarted.fetch(
        new Request("http://localhost/api/plugins/official.auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: "recovered", password }),
        }),
      );
      expect(login.status).toBe(200);
      await login.json();
      expect(
        await restarted.invoke("auth.setup@1", { action: "status" }),
      ).toEqual({ initialized: true });
    } finally {
      await restarted.shutdown();
    }
    const persisted = new DatabaseSync(
      join(f.config.dataDir, "official.auth", "auth.sqlite"),
    );
    expect(persisted.prepare("SELECT * FROM setup_admin").all()).toEqual([]);
    persisted.close();
  } finally {
    await f.close();
  }
});
it("enforces deployment origin and secure cookies before site confirmation", async () => {
  const f = await fixture(["listener", "console", "users", "auth"], {
    listener: {
      port: 0,
      host: "127.0.0.1",
      publicOrigin: "https://hub.example",
    },
    auth: { secureCookie: false },
  });
  try {
    const body = {
      action: "site",
      revision: (await state(f)).revision,
      step: 2,
      ...site,
    };
    const r = await f.kernel.fetch(
      new Request("https://hub.example" + api, {
        method: "POST",
        headers: {
          origin: "https://hub.example",
          "x-pluhub-setup": "1",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
    );
    expect(r.status).toBe(400);
    await r.json();
    expect((await save(f, 2)).status).toBe(400);
    expect(await f.kernel.invoke("users.manage@1", { action: "list" })).toEqual(
      [],
    );
  } finally {
    await f.close();
  }
});
it("does not overwrite a repaired password or reopen setup when an administrator is disabled", async () => {
  const f = await fixture(["console", "users", "auth"]);
  try {
    await f.admin();
    const admin: any = await f.kernel.invoke("users.lookup@1", {
      username: "admin",
    });
    const db = new DatabaseSync(
      join(f.config.dataDir, "official.auth", "auth.sqlite"),
    );
    db.prepare("INSERT INTO setup_admin VALUES(?,?,?)").run(
      admin.id,
      "admin",
      "unused:00",
    );
    db.close();
    await f.kernel.shutdown();
    const config = await readConfig(f.file),
      restarted = await createKernel(config);
    attachManagement(restarted, f.file, config);
    try {
      await restarted.start();
      const login = await restarted.fetch(
        new Request("http://localhost/api/plugins/official.auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            username: "admin",
            password: "correct-admin-password",
          }),
        }),
      );
      expect(login.status).toBe(200);
      await login.json();
      const users = new DatabaseSync(
        join(f.config.dataDir, "official.users", "users.sqlite"),
      );
      users.prepare("UPDATE users SET enabled=0 WHERE id=?").run(admin.id);
      users.close();
      expect(
        await (
          await restarted.fetch(new Request("http://localhost" + api))
        ).json(),
      ).toEqual({ required: false, stage: "complete" });
    } finally {
      await restarted.shutdown();
    }
  } finally {
    await f.close();
  }
});
it("keeps public registration disabled until an initial administrator exists", async () => {
  const f = await fixture(["console", "users", "auth", "mailer"], {
    auth: { registrationEnabled: true },
  });
  try {
    expect(
      (await (await f.request("/api/plugins/official.auth/options")).json())
        .registrationEnabled,
    ).toBe(false);
    expect(
      (await f.request("/api/plugins/official.auth/register", "POST", {}))
        .status,
    ).toBe(403);
    expect(
      (
        await f.request("/api/plugins/official.auth/email/request", "POST", {
          purpose: "register",
          email: "new@example.test",
        })
      ).status,
    ).toBe(403);
    await f.admin();
    expect(
      (await (await f.request("/api/plugins/official.auth/options")).json())
        .registrationEnabled,
    ).toBe(true);
  } finally {
    await f.close();
  }
});
