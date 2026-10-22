import { it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fixture } from "./helpers.js";
import {
  attachManagement,
  createKernel,
  readConfig,
} from "../packages/control/dist/index.js";

it("saves the default language during OOBE before administrator creation and restores it after restart", async () => {
  const f = await fixture(["console", "users", "auth"]);
  const headers = { origin: "http://localhost", "x-pluhub-setup": "1" };
  const state = async () => (await f.request("/api/host/setup")).json();
  try {
    const initial = await state();
    expect(initial.stage).toBe("site");
    const response = await f.request(
      "/api/host/setup",
      "POST",
      {
        action: "site",
        revision: initial.revision,
        step: 0,
        branding: {
          name: "自定义站名",
          defaultLanguage: "en-US",
          description: "保留自定义介绍",
        },
        portal: { title: "自定义门户", description: "保留原文" },
      },
      headers,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await state()).branding.defaultLanguage).toBe("en-US");
    expect(await f.kernel.invoke("users.manage@1", { action: "list" })).toEqual(
      [],
    );
    expect(await (await f.request("/console/branding")).json()).toMatchObject({
      defaultLanguage: "en-US",
      name: "自定义站名",
      description: "保留自定义介绍",
    });
    const html = await (await f.request("/")).text();
    expect(html).toContain('<html lang="en-US">');
    expect(html).toContain("自定义站名");
    expect(
      (await (await f.request("/console/public")).json()).portal.title,
    ).toBe("自定义门户");
    await f.kernel.shutdown();
    const config = await readConfig(f.file),
      restarted = await createKernel(config);
    attachManagement(restarted, f.file, config);
    try {
      await restarted.start();
      const resumed = await (
        await restarted.fetch(new Request("http://localhost/api/host/setup"))
      ).json();
      expect(resumed).toMatchObject({
        required: true,
        step: 1,
        branding: { defaultLanguage: "en-US" },
      });
      expect(
        await (await restarted.fetch(new Request("http://localhost/"))).text(),
      ).toContain('<html lang="en-US">');
    } finally {
      await restarted.shutdown();
    }
  } finally {
    await f.close();
  }
});

it("rejects unsupported site languages atomically in OOBE and management without reopening completed setup", async () => {
  const f = await fixture(["console", "users", "auth"]);
  try {
    const setup = await (await f.request("/api/host/setup")).json();
    const before = await readFile(f.file, "utf8");
    for (const language of [
      "en-GB",
      "bad",
      null,
      "<script>alert(1)</script>",
    ]) {
      const response = await f.request(
        "/api/host/setup",
        "POST",
        {
          action: "site",
          revision: setup.revision,
          step: 0,
          branding: { defaultLanguage: language },
          portal: {},
        },
        { origin: "http://localhost", "x-pluhub-setup": "1" },
      );
      expect(response.status).toBe(400);
      await response.text();
      expect(await readFile(f.file, "utf8")).toBe(before);
    }
    const admin = await f.admin();
    const config = await readConfig(f.file);
    const consoleEntry = config.plugins.find((entry) =>
      entry.path.endsWith("console"),
    )!;
    consoleEntry.config = {
      ...consoleEntry.config,
      branding: { defaultLanguage: "en-US" },
    };
    expect(
      (await f.request("/api/host/config", "PUT", config, admin)).status,
    ).toBe(200);
    const published = await (await f.request("/console/public")).json();
    expect(published.branding).toMatchObject({
      defaultLanguage: "en-US",
      description: "AI model service",
    });
    expect(published.portal.title).toBe("AI model service");
    expect(published.portal.primaryLabel).toBe("Browse models");
    expect(await (await f.request("/api/host/setup")).json()).toEqual({
      required: false,
      stage: "complete",
    });
    const saved = await readFile(f.file, "utf8");
    consoleEntry.config = { branding: { defaultLanguage: "en-GB" } };
    expect(
      (await f.request("/api/host/config", "PUT", config, admin)).status,
    ).toBe(400);
    expect(await readFile(f.file, "utf8")).toBe(saved);
  } finally {
    await f.close();
  }
});
