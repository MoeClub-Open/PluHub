import { it, expect } from "vitest";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture, pluginsRoot } from "./helpers.js";
import {
  install,
  packPlugin,
  createKernel,
} from "../packages/control/dist/index.js";
it("validates dynamic configuration before persisting or changing the live graph", async () => {
  const f = await fixture();
  try {
    const admin = await f.admin();
    const before = await readFile(f.file, "utf8");
    const version = f.kernel.graphVersion;
    const next = structuredClone(f.config);
    next.plugins.find((p: any) => p.path.endsWith("ai-router")).config = {
      models: { broken: { upstream: "missing", model: "x" } },
      upstreams: {},
    };
    const response = await f.request("/api/host/config", "PUT", next, admin);
    expect(response.status, await response.clone().text()).toBe(400);
    await response.json();
    expect(f.kernel.graphVersion).toBe(version);
    expect(await readFile(f.file, "utf8")).toBe(before);
    const good = structuredClone(f.config);
    good.plugins.find((p: any) => p.path.endsWith("ai-router")).config = {
      models: {},
      upstreams: {},
    };
    const applied = await f.request("/api/host/config", "PUT", good, admin);
    expect(applied.status).toBe(200);
    await applied.json();
    expect(f.kernel.graphVersion).toBeGreaterThan(version);
  } finally {
    await f.close();
  }
});
it("roundtrips a standalone plugin archive and rejects changed installed content", async () => {
  const f = await fixture(["users", "auth"]);
  try {
    const archive = join(f.directory, "console.tgz");
    await packPlugin(join(pluginsRoot, "console"), archive);
    const installed = await install(archive, join(f.directory, "plugins"));
    const config: any = {
      schemaVersion: 1,
      dataDir: join(f.directory, "state"),
      plugins: [
        {
          path: installed.path,
          integrity: installed.sha256,
          grants: ["http.route"],
          config: {},
        },
      ],
    };
    const kernel = await createKernel(config);
    await kernel.start();
    const html = await kernel.fetch(new Request("http://test/"));
    expect(html.status).toBe(200);
    await html.text();
    await kernel.shutdown();
    await writeFile(join(installed.path, "dist/index.js"), "tampered");
    await expect(createKernel(config)).rejects.toThrow("content changed");
  } finally {
    await f.close();
  }
});
it("keeps control APIs usable when a data-plane hook fails", async () => {
  const f = await fixture(["users", "auth"]);
  try {
    const directory = join(f.directory, "example.bad-hook");
    await mkdir(directory);
    await writeFile(
      join(directory, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "example.bad-hook",
        version: "1.0.0",
        host: ">=0.1.0-alpha.1",
        runtime: { kind: "native", entry: "index.mjs" },
        provides: [],
        requires: [],
        permissions: ["hooks.register", "http.route"],
      }),
    );
    await writeFile(
      join(directory, "index.mjs"),
      "export default {setup(h){h.hook({id:'fail',phase:'Planning',handle(){throw new Error('broken policy')}});h.route({method:'GET',path:'/broken',access:'public',handle:()=>new Response('unreachable')})}}",
    );
    await f.kernel.add(directory, { grants: ["hooks.register", "http.route"] });
    await f.kernel.enable("example.bad-hook");
    expect((await f.request("/broken")).status).toBe(500);
    const admin = await f.admin();
    const response = await f.request(
      "/api/host/plugins",
      "GET",
      undefined,
      admin,
    );
    expect(response.status).toBe(200);
    await response.json();
  } finally {
    await f.close();
  }
});
