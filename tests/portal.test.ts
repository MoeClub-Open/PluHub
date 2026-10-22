import { it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fixture } from "./helpers.js";
import { readConfig, createKernel } from "../packages/control/dist/index.js";

it("publishes only public content and preserves portal and onboarding across restart", async () => {
  const f = await fixture(["console", "users", "auth"]);
  try {
    const admin = await f.admin();
    const extensions = await (
      await f.request("/api/host/extensions", "GET", undefined, admin)
    ).json();
    expect(extensions.some((page: any) => page.path === "/setup")).toBe(false);
    const config = structuredClone(f.config);
    const consolePlugin = config.plugins.find((entry: any) =>
      entry.path.endsWith("console"),
    );
    consolePlugin.config = {
      branding: { name: "公开站点" },
      portal: {
        title: "门户上线",
        description: '<img src=x onerror="alert(1)">',
        pages: [
          {
            slug: "help",
            title: "使用指南",
            body: "正文\n<script>alert(1)</script>",
          },
        ],
      },
      onboarding: {
        completed: true,
        completedAt: "2026-10-19T00:00:00Z",
        modelSetupDeferred: true,
      },
    };
    const beforeOthers = config.plugins.filter(
      (entry: any) => !entry.path.endsWith("console"),
    );
    expect(
      (await f.request("/api/host/config", "PUT", config, admin)).status,
    ).toBe(200);
    const published = await (await f.request("/console/public")).json();
    expect(Object.keys(published).sort()).toEqual(["branding", "portal"]);
    expect(published.portal.title).toBe("门户上线");
    expect(published).not.toHaveProperty("onboarding");
    expect(JSON.stringify(published)).not.toContain("secretRefs");
    const html = await (await f.request("/")).text();
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img src=x");
    const head = await f.kernel.fetch(
      new Request("http://localhost/", { method: "HEAD" }),
    );
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const persisted = await readConfig(f.file);
    expect(
      persisted.plugins.filter((entry: any) => !entry.path.endsWith("console")),
    ).toEqual(beforeOthers);
    await f.kernel.shutdown();
    const restarted = await createKernel(persisted);
    try {
      await restarted.start();
      expect(
        await (
          await restarted.fetch(new Request("http://localhost/console/public"))
        ).json(),
      ).toEqual(published);
    } finally {
      await restarted.shutdown();
    }
    expect(
      persisted.plugins.find((entry: any) => entry.path.endsWith("console"))
        ?.config?.onboarding,
    ).toMatchObject({ completed: true, modelSetupDeferred: true });
  } finally {
    await f.close();
  }
});

it("rejects anonymous, ordinary-user and unsafe portal writes without changing the graph or config", async () => {
  const f = await fixture(["console", "users", "auth"]);
  try {
    const admin = await f.admin();
    const user: any = await f.kernel.invoke("users.manage@1", {
      action: "create",
      username: "reader",
      role: "user",
    });
    await (
      await f.request(
        "/api/plugins/official.auth/password",
        "POST",
        { userId: user.id, password: "reader-test-password" },
        admin,
      )
    ).json();
    const login = await f.request("/api/plugins/official.auth/login", "POST", {
      username: "reader",
      password: "reader-test-password",
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    await login.json();
    const before = await readFile(f.file, "utf8");
    const version = f.kernel.graphVersion;
    const config = structuredClone(f.config);
    config.plugins.find((entry: any) => entry.path.endsWith("console")).config =
      { portal: { primaryUrl: "javascript:alert(1)" } };
    expect((await f.request("/api/host/config", "PUT", config)).status).toBe(
      401,
    );
    expect(
      (await f.request("/api/host/config", "PUT", config, { cookie })).status,
    ).toBe(403);
    expect(
      (await f.request("/api/host/config", "PUT", config, admin)).status,
    ).toBe(400);
    expect(await readFile(f.file, "utf8")).toBe(before);
    expect(f.kernel.graphVersion).toBe(version);
    const valid = structuredClone(f.config);
    valid.plugins.find((entry: any) => entry.path.endsWith("console")).config =
      {
        portal: {
          enabled: false,
          pages: [{ slug: "draft", title: "未公开", body: "DRAFT-SECRET" }],
        },
      };
    expect(
      (await f.request("/api/host/config", "PUT", valid, admin)).status,
    ).toBe(200);
    expect(
      JSON.stringify(await (await f.request("/console/public")).json()),
    ).not.toContain("DRAFT-SECRET");
  } finally {
    await f.close();
  }
});
