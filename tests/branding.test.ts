import { it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fixture } from "./helpers.js";
import { createKernel, readConfig } from "../packages/control/dist/index.js";

it("applies branding live using existing grants, escapes HTML and persists it across restart", async () => {
  const f = await fixture(["console", "users", "auth"]);
  try {
    const admin = await f.admin();
    const initial = await f.request("/console/branding");
    expect(initial.status).toBe(200);
    expect(initial.headers.get("cache-control")).toBe("no-store");
    expect((await initial.json()).name).toBe("PluHub");
    const config = structuredClone(f.config);
    const consolePlugin = config.plugins.find((plugin: any) =>
      plugin.path.endsWith("console"),
    );
    consolePlugin.config = {
      branding: {
        name: '星桥 <AI> "gateway"',
        accentColor: "#155eef",
        description: '<img src=x onerror="alert(1)">',
        logoUrl: "https://cdn.example.com/logo.png",
        termsUrl: "/terms",
      },
    };
    expect(consolePlugin.grants).toEqual(["http.route"]);
    const result = await f.request("/api/host/config", "PUT", config, admin);
    expect(result.status, await result.clone().text()).toBe(200);
    const brand = await (await f.request("/console/branding")).json();
    expect(brand.name).toBe(consolePlugin.config.branding.name);
    expect(brand).not.toHaveProperty("plugins");
    expect(brand).not.toHaveProperty("secretRefs");
    const html = await (await f.request("/")).text();
    expect(
      JSON.parse(
        html.match(
          /<script id="pluhub-branding" type="application\/json">(.*?)<\/script>/s,
        )![1]!,
      ),
    ).toEqual(brand);
    expect(html).toContain("星桥 &lt;AI&gt; &quot;gateway&quot;");
    expect(html).not.toContain('<img src=x onerror="alert(1)">');
    await f.kernel.shutdown();
    const restarted = await createKernel(await readConfig(f.file));
    try {
      await restarted.start();
      expect(
        await (
          await restarted.fetch(
            new Request("http://localhost/console/branding"),
          )
        ).json(),
      ).toEqual(brand);
    } finally {
      await restarted.shutdown();
    }
  } finally {
    await f.close();
  }
});

it("rejects invalid or unauthorized brand updates without changing the live snapshot or persisted config", async () => {
  const f = await fixture(["console", "users", "auth"]);
  try {
    const admin = await f.admin();
    const before = await readFile(f.file, "utf8"),
      version = f.kernel.graphVersion;
    const config = structuredClone(f.config);
    config.plugins.find((plugin: any) =>
      plugin.path.endsWith("console"),
    ).config = { branding: { websiteUrl: "javascript:alert(1)" } };
    const denied = await f.request("/api/host/config", "PUT", config);
    expect([401, 403]).toContain(denied.status);
    await denied.text();
    const invalid = await f.request("/api/host/config", "PUT", config, admin);
    expect(invalid.status).toBe(400);
    await invalid.text();
    expect(f.kernel.graphVersion).toBe(version);
    expect(await readFile(f.file, "utf8")).toBe(before);
    expect((await (await f.request("/console/branding")).json()).name).toBe(
      "PluHub",
    );
  } finally {
    await f.close();
  }
});
