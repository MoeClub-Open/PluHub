import { it, expect, vi, afterEach } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  utimes,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { fixture } from "./helpers.js";
import {
  packPlugin,
  createKernel,
  writeConfig,
  readConfig,
  applyPendingPluginUpdate,
  recoverInterruptedPluginUpdate,
} from "../packages/control/dist/index.js";
import {
  registryService,
  registrySources,
  fingerprint,
} from "../packages/control/dist/registry.js";
import {
  fetchRegistryBytes,
  validateRegistryAddresses,
} from "../packages/control/dist/registry-fetch.js";
import {
  pluginJobStore,
  backupPluginData,
} from "../packages/control/dist/plugin-jobs.js";
afterEach(() => vi.unstubAllEnvs());
async function harness() {
  const directory = await mkdtemp(join(tmpdir(), "pluhub-registry-")),
    catalog = join(directory, "catalog");
  await mkdir(join(catalog, "packages"), { recursive: true });
  const entries: any[] = [];
  async function add(
    id = "test.online",
    version = "1.0.0",
    extra: any = {},
    source?: string,
  ) {
    const path = join(directory, id + "-" + version);
    await mkdir(join(path, "dist"), { recursive: true });
    const manifest = {
      schemaVersion: 1,
      id,
      version,
      host: ">=0.1.0-alpha.1",
      runtime: { kind: "native", entry: "dist/index.mjs" },
      provides: [],
      requires: [],
      permissions: [],
      ...extra,
    };
    await writeFile(join(path, "manifest.json"), JSON.stringify(manifest));
    await writeFile(
      join(path, "dist/index.mjs"),
      source ??
        "export default {setup(h){for(const c of " +
          JSON.stringify(manifest.provides) +
          ")h.provide(c,()=>" +
          JSON.stringify(version) +
          ")}}",
    );
    const archive = id + "-" + version + ".tgz";
    await packPlugin(path, join(catalog, "packages", archive));
    const row = {
      manifest,
      archive,
      sha256: createHash("sha256")
        .update(await readFile(join(catalog, "packages", archive)))
        .digest("hex"),
    };
    entries.push(row);
    await index();
    return { path, row };
  }
  async function index() {
    await writeFile(
      join(catalog, "index.json"),
      JSON.stringify({ schemaVersion: 1, plugins: entries }),
    );
  }
  const service = registryService(join(directory, "cache"), catalog);
  const config: any = {
    schemaVersion: 1,
    dataDir: join(directory, "data"),
    plugins: [],
  };
  await index();
  return {
    directory,
    catalog,
    entries,
    add,
    index,
    service,
    config,
    close: () => rm(directory, { recursive: true, force: true }),
  };
}
it("plans remote dependency closure with locked origins and never grants permissions", async () => {
  const f = await harness();
  try {
    await f.add("test.dep", "1.0.0", {
      provides: ["test.dep@1"],
      permissions: ["secrets.read"],
    });
    await f.add("test.online", "1.0.0", { requires: ["test.dep@1"] });
    const result = await f.service.prepare(f.config, {
      id: "test.online",
      registryId: "official",
      version: "1.0.0",
      operation: "install",
    });
    expect(result.plan.plugins.map((p: any) => p.id)).toEqual([
      "test.dep",
      "test.online",
    ]);
    expect(result.origins["test.dep"]).toMatchObject({
      registryId: "official",
      version: "1.0.0",
      archiveSha256: f.entries[0].sha256,
    });
    expect(result.options.grants).toBeUndefined();
    expect(result.options.dependencyGrants).toBeUndefined();
  } finally {
    await f.close();
  }
});
it("rejects archive hash mismatch and registry manifest substitution", async () => {
  for (const mode of ["hash", "manifest"]) {
    const f = await harness();
    try {
      await f.add();
      if (mode === "hash") f.entries[0].sha256 = "0".repeat(64);
      else f.entries[0].manifest.name = "Substituted";
      await f.index();
      await expect(
        f.service.prepare(f.config, {
          id: "test.online",
          registryId: "official",
          version: "1.0.0",
          operation: "install",
        }),
      ).rejects.toMatchObject({
        code: mode === "hash" ? "integrity_mismatch" : "registry_manifest",
      });
    } finally {
      await f.close();
    }
  }
});
it("rejects corrupted cached content and same-version updates", async () => {
  const f = await harness();
  try {
    const { path } = await f.add();
    const input: any = {
      id: "test.online",
      registryId: "official",
      version: "1.0.0",
      operation: "install",
    };
    const prepared = await f.service.prepare(f.config, input);
    await writeFile(join(prepared.source, "dist/index.mjs"), "tampered");
    await expect(f.service.prepare(f.config, input)).rejects.toMatchObject({
      code: "integrity_mismatch",
    });
    const config = { ...f.config, plugins: [{ path, grants: [], config: {} }] };
    await expect(
      f.service.prepare(config, { ...input, operation: "update" }),
    ).rejects.toMatchObject({ code: "invalid_update" });
  } finally {
    await f.close();
  }
});
it("does not upgrade or enable conflicting installed dependencies", async () => {
  const f = await harness();
  try {
    const dep = await f.add("test.dep", "1.0.0", { provides: ["test.dep@1"] });
    await f.add("test.dep", "2.0.0", { provides: ["test.dep@1"] });
    await f.add("test.online", "1.0.0", {
      dependencies: { "test.dep": "^2.0.0" },
    });
    for (const enabled of [true, false]) {
      const config = {
        ...f.config,
        plugins: [{ path: dep.path, grants: [], enabled }],
      };
      await expect(
        f.service.prepare(config, {
          id: "test.online",
          registryId: "official",
          version: "1.0.0",
          operation: "install",
        }),
      ).rejects.toBeDefined();
    }
  } finally {
    await f.close();
  }
});
it("keeps the official catalog usable when a third-party source fails and reserves its ID", async () => {
  const f = await harness();
  try {
    await f.add();
    const result = await f.service.list({
      ...f.config,
      pluginRegistries: [
        { id: "broken", name: "Broken", url: "http://127.0.0.1:1/index.json" },
      ],
    });
    expect(result.plugins).toHaveLength(1);
    expect(result.errors).toEqual([
      { registryId: "broken", code: "registry_network" },
    ]);
    expect(() =>
      registrySources({
        ...f.config,
        pluginRegistries: [
          { id: "official", name: "Fake", url: "https://example.com" },
        ],
      }),
    ).toThrow();
    expect(() =>
      registrySources({
        ...f.config,
        pluginRegistries: [{ id: "bad", name: "Bad", url: "not a url" }],
      }),
    ).toThrow("Invalid registry URL");
  } finally {
    await f.close();
  }
});
it("serves an allowlisted catalog with GET/HEAD and fetches third-party packages online", async () => {
  const f = await harness();
  let server: any;
  try {
    await f.add();
    server = createServer(async (req, res) => {
      try {
        const response = await f.service.publish(
          new Request("http://localhost" + req.url, { method: req.method }),
        );
        res.writeHead(
          response?.status ?? 404,
          Object.fromEntries(response?.headers ?? []),
        );
        res.end(
          response ? Buffer.from(await response.arrayBuffer()) : undefined,
        );
      } catch {
        res.writeHead(500);
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url =
      "http://127.0.0.1:" + server.address().port + "/registry/v1/index.json";
    const config = {
      ...f.config,
      pluginRegistries: [
        { id: "third", name: "Third party", url, allowPrivateNetwork: true },
      ],
    };
    const result = await f.service.prepare(config, {
      id: "test.online",
      registryId: "third",
      version: "1.0.0",
      operation: "install",
    });
    expect(result.origins["test.online"].registryId).toBe("third");
    const head = await fetch(url, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(
      (await fetch(url.replace("index.json", "packages/missing.tgz"))).status,
    ).toBe(404);
    expect((await fetch(url, { method: "POST" })).status).toBe(405);
  } finally {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    await f.close();
  }
});
it("blocks unsafe networks, credentials, insecure public HTTP and oversized downloads", async () => {
  for (const url of [
    "https://127.0.0.1",
    "https://[::1]",
    "https://169.254.169.254",
    "http://8.8.8.8",
    "https://u:p@8.8.8.8",
    "https://[::ffff:127.0.0.1]",
  ]) {
    await expect(fetchRegistryBytes(new URL(url), 1024)).rejects.toMatchObject({
      code: expect.stringMatching(/^registry_(network|url)$/),
    });
  }
  const server = createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "http://169.254.169.254/" });
      res.end();
    } else {
      res.end("x".repeat(50));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  try {
    await expect(
      fetchRegistryBytes(new URL("http://127.0.0.1:" + port), 10, true),
    ).rejects.toMatchObject({ code: "registry_size" });
    await expect(
      fetchRegistryBytes(
        new URL("http://127.0.0.1:" + port + "/redirect"),
        1024,
        true,
      ),
    ).rejects.toMatchObject({ code: "registry_network" });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
it("requires an administrator session and explicit permission review for online installation", async () => {
  const r = await harness();
  vi.stubEnv("PLUHUB_PLUGIN_CATALOG", r.catalog);
  const f = await fixture(["users", "auth"]);
  try {
    await r.add("test.online", "1.0.0", { permissions: ["secrets.read"] });
    vi.stubEnv("PLUHUB_PLUGIN_CATALOG", r.catalog);
    const input = {
      id: "test.online",
      registryId: "official",
      version: "1.0.0",
      operation: "install",
      reason: "test",
    };
    expect((await f.request("/api/host/registry/catalog")).status).toBe(401);
    const admin = await f.admin(),
      key = await (
        await f.request(
          "/api/plugins/official.auth/keys",
          "POST",
          { name: "test" },
          admin,
        )
      ).json();
    expect(
      (
        await f.request("/api/host/registry/catalog", "GET", undefined, {
          authorization: "Bearer " + key.token,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await f.request(
          "/api/host/registry/plan",
          "POST",
          { ...input, config: [] },
          admin,
        )
      ).status,
    ).toBe(400);
    const plan = await (
      await f.request("/api/host/registry/plan", "POST", input, admin)
    ).json();
    expect(plan.mode).toBe("install");
    const denied = await f.request(
      "/api/host/registry/install",
      "POST",
      { ...input, expectedPlan: plan.fingerprint },
      admin,
    );
    expect(denied.status).toBe(403);
    await denied.json();
    const installed = await f.request(
      "/api/host/registry/install",
      "POST",
      { ...input, expectedPlan: plan.fingerprint, grants: ["secrets.read"] },
      admin,
    );
    expect(installed.status, await installed.clone().text()).toBe(201);
    await installed.json();
    expect(
      (await readConfig(f.file)).plugins.find((p) => p.version === "1.0.0")
        ?.origin,
    ).toMatchObject({
      registryId: "official",
      archiveSha256: r.entries[0].sha256,
    });
  } finally {
    await f.close();
    await r.close();
  }
});
it("detects changed registry plans and hot-updates an eligible plugin", async () => {
  const r = await harness();
  vi.stubEnv("PLUHUB_PLUGIN_CATALOG", r.catalog);
  const f = await fixture(["users", "auth"]);
  try {
    await r.add("test.online", "1.0.0", {
      codeReload: "parallel",
      provides: ["test.online@1"],
    });
    vi.stubEnv("PLUHUB_PLUGIN_CATALOG", r.catalog);
    const admin = await f.admin();
    const perform = async (input: any) => {
      const p = await (
        await f.request("/api/host/registry/plan", "POST", input, admin)
      ).json();
      return {
        p,
        result: await f.request(
          "/api/host/registry/install",
          "POST",
          { ...input, expectedPlan: p.fingerprint, reason: "test" },
          admin,
        ),
      };
    };
    const first = await perform({
      id: "test.online",
      registryId: "official",
      version: "1.0.0",
      operation: "install",
    });
    expect(first.result.status).toBe(201);
    await first.result.json();
    await r.add("test.online", "1.1.0", {
      codeReload: "parallel",
      provides: ["test.online@1"],
    });
    const input = {
      id: "test.online",
      registryId: "official",
      version: "1.1.0",
      operation: "update",
      revision: f.kernel.list().find((p) => p.id === "test.online")!.revision,
    };
    const changed = await f.request(
      "/api/host/registry/install",
      "POST",
      { ...input, expectedPlan: "0".repeat(64), reason: "test" },
      admin,
    );
    expect(changed.status).toBe(409);
    await changed.json();
    const second = await perform(input);
    expect(second.p.mode).toBe("hot-update");
    expect(second.result.status, await second.result.clone().text()).toBe(200);
    await second.result.json();
    expect(await f.kernel.invoke("test.online@1")).toBe("1.1.0");
  } finally {
    await f.close();
    await r.close();
  }
});
it.each([false, true])(
  "applies stateful updates and restores data/config on startup failure (failure=%s)",
  async (fail) => {
    const f = await harness();
    let kernel: any;
    try {
      const old = await f.add(
        "test.online",
        "1.0.0",
        { provides: ["test.online@1"] },
        "import fs from 'node:fs';export default {setup(h){const p=h.dataDir+'/state';if(!fs.existsSync(p))fs.writeFileSync(p,'original');h.provide('test.online@1',()=>fs.readFileSync(p,'utf8'));}}",
      );
      const next = await f.add(
        "test.online",
        "1.1.0",
        { provides: ["test.online@1"] },
        "import fs from 'node:fs';export default {setup(h){fs.writeFileSync(h.dataDir+'/state','new');" +
          (fail
            ? "throw new Error('bad migration')"
            : "h.provide('test.online@1',()=> 'new')") +
          ";}}",
      );
      const before = { ...f.config, plugins: [{ path: old.path, grants: [] }] },
        after = { ...f.config, plugins: [{ path: next.path, grants: [] }] },
        file = join(f.directory, "pluhub.json");
      await writeConfig(file, before);
      kernel = await createKernel(before);
      await kernel.start();
      const jobs = pluginJobStore(file);
      await jobs.queue(before, after, "test.online", "test", ["test.online"]);
      const result = await applyPendingPluginUpdate(kernel, file);
      kernel = result.kernel;
      expect(await kernel.invoke("test.online@1")).toBe(
        fail ? "original" : "new",
      );
      expect((await jobs.read())!.state).toBe(fail ? "failed" : "applied");
      expect(fingerprint(await readConfig(file))).toBe(
        fingerprint(fail ? before : after),
      );
    } finally {
      await kernel?.shutdown();
      await f.close();
    }
  },
);
it("recovers interrupted updates and refuses stale pending configurations", async () => {
  const f = await harness();
  let kernel: any;
  try {
    const old = await f.add(),
      before = { ...f.config, plugins: [{ path: old.path, grants: [] }] },
      file = join(f.directory, "pluhub.json");
    await writeConfig(file, before);
    kernel = await createKernel(before);
    await kernel.start();
    const jobs = pluginJobStore(file),
      job = await jobs.queue(before, before, "test.online", "test", [
        "test.online",
      ]);
    await writeConfig(file, { ...before, drainTimeoutMs: 300 });
    await expect(applyPendingPluginUpdate(kernel, file)).rejects.toMatchObject({
      code: "update_conflict",
    });
    await writeConfig(file, before);
    await writeFile(join(before.dataDir, "test.online/state"), "original");
    await backupPluginData(file, job);
    job.state = "applying";
    await jobs.write(job);
    await writeFile(join(before.dataDir, "test.online/state"), "broken");
    await recoverInterruptedPluginUpdate(file);
    expect(
      await readFile(join(before.dataDir, "test.online/state"), "utf8"),
    ).toBe("original");
    expect((await jobs.read())!.state).toBe("failed");
  } finally {
    await kernel?.shutdown();
    await f.close();
  }
});
it("stages restart updates without changing live code or exposing configuration, and supports cancellation", async () => {
  const r = await harness();
  vi.stubEnv("PLUHUB_PLUGIN_CATALOG", r.catalog);
  const f = await fixture(["users", "auth"]);
  try {
    const admin = await f.admin();
    for (const version of ["1.0.0", "1.1.0"])
      await r.add("test.online", version, {
        codeReload: "restart",
        provides: ["test.online@1"],
      });
    const install = {
      id: "test.online",
      registryId: "official",
      version: "1.0.0",
      operation: "install",
    };
    const plan = await (
      await f.request("/api/host/registry/plan", "POST", install, admin)
    ).json();
    const initial = await f.request(
      "/api/host/registry/install",
      "POST",
      { ...install, expectedPlan: plan.fingerprint, reason: "test" },
      admin,
    );
    expect(initial.status).toBe(201);
    await initial.json();
    const update = {
      ...install,
      version: "1.1.0",
      operation: "update",
      revision: f.kernel.list().find((p) => p.id === "test.online")!.revision,
    };
    const next = await (
      await f.request("/api/host/registry/plan", "POST", update, admin)
    ).json();
    expect(next.mode).toBe("restart-update");
    const staged = await f.request(
      "/api/host/registry/install",
      "POST",
      { ...update, expectedPlan: next.fingerprint, reason: "test" },
      admin,
    );
    expect(staged.status, await staged.clone().text()).toBe(202);
    await staged.json();
    expect(await f.kernel.invoke("test.online@1")).toBe("1.0.0");
    const view = await (
      await f.request("/api/host/plugin-updates", "GET", undefined, admin)
    ).json();
    expect(view.state).toBe("pending");
    expect(view).not.toHaveProperty("before");
    expect(view).not.toHaveProperty("next");
    expect(
      (await f.request("/api/host/registry/plan", "POST", update, admin))
        .status,
    ).toBe(409);
    expect(
      (
        await f.request(
          "/api/host/plugin-updates/apply",
          "POST",
          { id: view.id },
          admin,
        )
      ).status,
    ).toBe(503);
    expect(
      (
        await f.request(
          "/api/host/plugin-updates/cancel",
          "POST",
          { id: view.id },
          admin,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await (
          await f.request("/api/host/plugin-updates", "GET", undefined, admin)
        ).json()
      ).state,
    ).toBe("cancelled");
  } finally {
    await f.close();
    await r.close();
  }
});
it("returns temporary unavailability until all startup registrations are published", async () => {
  const f = await harness();
  let kernel: any;
  try {
    const plugin = await f.add();
    kernel = await createKernel({
      ...f.config,
      plugins: [{ path: plugin.path, grants: [] }],
    });
    const started = kernel.start();
    const early = await kernel.fetch(
      new Request("http://localhost/api/host/extensions"),
    );
    expect(early.status).toBe(503);
    expect((await early.json()).error.code).toBe("starting_up");
    await started;
    const ready = await kernel.fetch(
      new Request("http://localhost/api/host/extensions"),
    );
    expect(ready.status).toBe(200);
    await ready.json();
  } finally {
    await kernel?.shutdown();
    await f.close();
  }
});

it("accepts public IPv4/IPv6 registries while rejecting private, mapped and mixed DNS results", () => {
  const url = new URL("https://registry.example.com");
  for (const address of [
    { address: "104.21.54.172", family: 4 },
    { address: "172.67.140.177", family: 4 },
    { address: "2606:4700:3033::6815:36ac", family: 6 },
  ])
    expect(() => validateRegistryAddresses(url, [address])).not.toThrow();
  for (const address of [
    { address: "::ffff:8.8.8.8", family: 6 },
    { address: "0:0:0:0:0:ffff:808:808", family: 6 },
    { address: "::127.0.0.1", family: 6 },
    { address: "10.0.0.1", family: 4 },
    { address: "::1", family: 6 },
  ])
    expect(() => validateRegistryAddresses(url, [address])).toThrow();
  expect(() =>
    validateRegistryAddresses(url, [
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]),
  ).toThrow();
});

it("reproduces registry package bytes after source modification times change", async () => {
  const f = await harness();
  try {
    const { path, row } = await f.add();
    for (const name of ["manifest.json", "dist", "dist/index.mjs"])
      await utimes(join(path, name), new Date(123456000), new Date(987654000));
    const archive = join(f.directory, "repacked.tgz");
    await packPlugin(path, archive);
    expect(
      createHash("sha256")
        .update(await readFile(archive))
        .digest("hex"),
    ).toBe(row.sha256);
  } finally {
    await f.close();
  }
});
