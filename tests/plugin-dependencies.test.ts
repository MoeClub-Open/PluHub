import { it, expect, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Kernel, validateManifest } from "../packages/kernel/dist/index.js";
import {
  planInstall,
  installWithDependencies,
  createKernel,
  writeConfig,
  readConfig,
  packPlugin,
  install,
  removeInstalledPackage,
} from "../packages/control/dist/index.js";
import type { HostConfig } from "@pluhub/contracts";
import { fixture } from "./helpers.js";
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    mkdtemp: async (prefix: string, ...args: any[]) => {
      const path = await (fs.mkdtemp as any)(prefix, ...args);
      if (
        (globalThis as any).__dependencySetCollision &&
        prefix.endsWith(".resolve-")
      ) {
        const destination = join(
          path,
          "..",
          "set-" + path.split(/[\\/]/).at(-1)!.slice(".resolve-".length),
        );
        await fs.mkdir(destination);
        await fs.writeFile(
          join(destination, "existing-package"),
          "preserve existing installation",
        );
      }
      return path;
    },
  };
});

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), "pluhub-dependencies-"));
  const config: HostConfig = {
    schemaVersion: 1,
    dataDir: join(directory, "data"),
    plugins: [],
  };
  const packageAt = async (
    folder: string,
    id: string,
    extra: Record<string, unknown> = {},
    source?: string,
  ) => {
    const path = join(directory, folder);
    await mkdir(join(path, "dist"), { recursive: true });
    const manifest = {
      schemaVersion: 1,
      id,
      version: "1.0.0",
      host: ">=0.1.0-alpha.1",
      runtime: { kind: "native", entry: "dist/index.js" },
      provides: [],
      requires: [],
      permissions: [],
      ...extra,
    };
    await writeFile(join(path, "manifest.json"), JSON.stringify(manifest));
    await writeFile(
      join(path, "dist/index.js"),
      source ??
        `export default {setup(h){for(const name of ${JSON.stringify(manifest.provides)})h.provide(name,()=>42)}}`,
    );
    return path;
  };
  return {
    directory,
    config,
    packageAt,
    store: join(directory, "installed"),
    async close() {
      expect(
        resolve(directory).startsWith(
          resolve(tmpdir(), "pluhub-dependencies-"),
        ),
      ).toBe(true);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

it("plans a transitive capability closure, ignores optional dependencies, pins all new packages and survives restart", async () => {
  const f = await harness();
  try {
    await f.packageAt("storage", "test.storage", {
      provides: ["test.storage@1"],
    });
    await f.packageAt("service", "test.service", {
      provides: ["test.service@1"],
      requires: ["test.storage@1"],
    });
    await f.packageAt("optional", "test.optional", {
      provides: ["test.optional@1"],
    });
    const root = await f.packageAt(
      "root",
      "test.root",
      {
        provides: ["test.result@1"],
        requires: ["test.service@1"],
        optionalRequires: ["test.optional@1"],
      },
      `export default {setup(h){h.provide('test.result@1',()=>h.call('test.service@1'))}}`,
    );
    const plan = await planInstall(root, f.config);
    expect(plan.plugins.map((p) => p.id)).toEqual([
      "test.storage",
      "test.service",
      "test.root",
    ]);
    expect((await planInstall(root, f.config)).fingerprint).toBe(
      plan.fingerprint,
    );
    let next = f.config;
    await installWithDependencies(
      root,
      f.store,
      f.config,
      { expectedPlan: plan.fingerprint },
      async (value) => {
        next = value;
      },
    );
    expect(next.plugins).toHaveLength(3);
    expect(
      next.plugins.every(
        (p) => p.version === "1.0.0" && /^[a-f0-9]{64}$/.test(p.integrity!),
      ),
    ).toBe(true);
    const kernel = await createKernel(next);
    try {
      await kernel.start();
      expect(await kernel.invoke("test.result@1")).toBe(42);
    } finally {
      await kernel.shutdown();
    }
  } finally {
    await f.close();
  }
});

it("backtracks across implementation versions rather than selecting an incompatible highest version", async () => {
  const f = await harness();
  try {
    await f.packageAt("a1", "test.a", {
      version: "1.0.0",
      dependencies: { "test.b": "^1.0.0" },
    });
    await f.packageAt("a2", "test.a", {
      version: "2.0.0",
      dependencies: { "test.b": "^2.0.0" },
    });
    await f.packageAt("b1", "test.b", { version: "1.0.0" });
    await f.packageAt("b2", "test.b", { version: "2.0.0" });
    const root = await f.packageAt("root", "test.root", {
      dependencies: { "test.a": ">=1 <3", "test.b": "^1.0.0" },
    });
    const plan = await planInstall(root, f.config);
    expect(plan.plugins.find((p) => p.id === "test.a")?.version).toBe("1.0.0");
    expect(plan.plugins.find((p) => p.id === "test.b")?.version).toBe("1.0.0");
  } finally {
    await f.close();
  }
});

it("uses existing compatible providers without reinstalling or modifying their grants", async () => {
  const f = await harness();
  try {
    const existing = await f.packageAt("provider", "test.provider", {
      provides: ["test.value@1"],
    });
    f.config.plugins.push({
      path: existing,
      grants: [],
      config: { preserved: true },
    });
    const root = await f.packageAt("root", "test.root", {
      requires: ["test.value@1"],
    });
    const plan = await planInstall(root, f.config);
    expect(plan.plugins[0]).toMatchObject({
      id: "test.provider",
      action: "keep",
    });
    let next = f.config;
    await installWithDependencies(
      root,
      f.store,
      f.config,
      {},
      async (config) => {
        next = config;
      },
    );
    expect(next.plugins[0]).toEqual(f.config.plugins[0]);
    expect(next.plugins).toHaveLength(2);
  } finally {
    await f.close();
  }
});

it("requires explicit bindings for different providers and rejects different content with the same ID/version", async () => {
  const f = await harness();
  try {
    await f.packageAt("first", "test.first", { provides: ["test.value@1"] });
    await f.packageAt("second", "test.second", { provides: ["test.value@1"] });
    const root = await f.packageAt("root", "test.root", {
      requires: ["test.value@1"],
    });
    await expect(planInstall(root, f.config)).rejects.toMatchObject({
      code: "ambiguous_capability",
    });
    f.config.bindings = { "test.value@1": "test.first" };
    expect(
      (await planInstall(root, f.config)).plugins.map((p) => p.id),
    ).toEqual(["test.first", "test.root"]);
    await f.packageAt(
      "duplicate",
      "test.first",
      { provides: ["test.value@1"] },
      "export default {setup(h){h.provide('test.value@1',()=>99)}}",
    );
    await expect(planInstall(root, f.config)).rejects.toMatchObject({
      code: "ambiguous_package",
    });
  } finally {
    await f.close();
  }
});

it.each(["missing", "cycle", "version", "disabled"])(
  "rejects %s dependencies without persisting partial installations",
  async (kind) => {
    const f = await harness();
    try {
      let extra: Record<string, unknown> = { requires: ["test.missing@1"] };
      if (kind === "cycle") {
        extra = { provides: ["test.root@1"], requires: ["test.dep@1"] };
        await f.packageAt("dep", "test.dep", {
          provides: ["test.dep@1"],
          requires: ["test.root@1"],
        });
      }
      if (kind === "version") {
        extra = { dependencies: { "test.dep": "^2.0.0" } };
        const dep = await f.packageAt("dep", "test.dep");
        f.config.plugins.push({ path: dep, grants: [] });
        await f.packageAt("new-dep", "test.dep", { version: "2.0.0" });
      }
      if (kind === "disabled") {
        extra = { requires: ["test.dep@1"] };
        const dep = await f.packageAt("dep", "test.dep", {
          provides: ["test.dep@1"],
        });
        f.config.plugins.push({ path: dep, grants: [], enabled: false });
      }
      const root = await f.packageAt("root", "test.root", extra);
      let writes = 0;
      await expect(
        installWithDependencies(root, f.store, f.config, {}, async () => {
          writes++;
        }),
      ).rejects.toBeTruthy();
      expect(writes).toBe(0);
      expect(await readdir(f.store)).toEqual([]);
    } finally {
      await f.close();
    }
  },
);

it("checks every dependency permission and config before executing code", async () => {
  const f = await harness();
  const marker = "dependencyPermissionMarker";
  try {
    await f.packageAt(
      "dep",
      "test.dep",
      {
        provides: ["test.dep@1"],
        permissions: ["events.publish"],
        configSchema: {
          type: "object",
          required: ["value"],
          properties: { value: { type: "number" } },
        },
      },
      `export default {setup(h){globalThis.${marker}=true;h.provide('test.dep@1',()=>42)}}`,
    );
    const root = await f.packageAt("root", "test.root", {
      requires: ["test.dep@1"],
    });
    const attempt = (options: any) =>
      installWithDependencies(root, f.store, f.config, options, async () => {});
    await expect(attempt({})).rejects.toBeTruthy();
    await expect(
      attempt({ dependencyConfigs: { "test.dep": { value: 1 } } }),
    ).rejects.toMatchObject({ code: "permission_denied" });
    expect((globalThis as any)[marker]).toBeUndefined();
    await attempt({
      dependencyGrants: { "test.dep": ["events.publish"] },
      dependencyConfigs: { "test.dep": { value: 1 } },
    });
    expect((globalThis as any)[marker]).toBeUndefined(); // Offline install validates but never starts plugins.
  } finally {
    delete (globalThis as any)[marker];
    await f.close();
  }
});

it("rejects a stale reviewed plan when source content or the host configuration changes", async () => {
  const f = await harness();
  try {
    const root = await f.packageAt("root", "test.root");
    const plan = await planInstall(root, f.config);
    await writeFile(
      join(root, "dist/index.js"),
      "export default {setup(){ /* changed */ }}",
    );
    await expect(
      installWithDependencies(
        root,
        f.store,
        f.config,
        { expectedPlan: plan.fingerprint },
        async () => {},
      ),
    ).rejects.toMatchObject({ code: "install_plan_changed" });
    const nextPlan = await planInstall(root, f.config);
    await expect(
      installWithDependencies(
        root,
        f.store,
        { ...f.config, bindings: { "test.value@1": "test.value" } },
        { expectedPlan: nextPlan.fingerprint },
        async () => {},
      ),
    ).rejects.toMatchObject({ code: "install_plan_changed" });
    expect(await readdir(f.store)).toEqual([]);
  } finally {
    await f.close();
  }
});

it("resolves archives from an explicit catalog and does not run npm lifecycle scripts", async () => {
  const f = await harness();
  try {
    const dep = await f.packageAt("dep", "test.dep", {
      provides: ["test.dep@1"],
    });
    await writeFile(
      join(dep, "package.json"),
      JSON.stringify({ name: "test-dep", scripts: { install: "exit 99" } }),
    );
    const catalog = join(f.directory, "catalog");
    await mkdir(catalog);
    await packPlugin(dep, join(catalog, "dep.tgz"));
    await rm(dep, { recursive: true });
    const root = await f.packageAt("root", "test.root", {
      requires: ["test.dep@1"],
    });
    expect(
      (await planInstall(root, f.config, { sources: [catalog] })).plugins.map(
        (p) => p.id,
      ),
    ).toEqual(["test.dep", "test.root"]);
    await installWithDependencies(
      root,
      f.store,
      f.config,
      { sources: [catalog] },
      async () => {},
    );
  } finally {
    await f.close();
  }
});

it.each(["setup", "persist"])(
  "keeps the old graph and instances active after a live %s failure",
  async (failure) => {
    const f = await harness();
    const kernel = new Kernel(f.config.dataDir, 100);
    try {
      const old = await f.packageAt(
        "old",
        "test.old",
        { provides: ["test.old@1"], permissions: ["http.route"] },
        "export default {setup(h){h.provide('test.old@1',()=>7);h.route({method:'GET',path:'/old',access:'public',handle:()=>new Response('old')})}}",
      );
      f.config.plugins.push({ path: old, grants: ["http.route"] });
      await kernel.add(old, { grants: ["http.route"] });
      await kernel.start();
      const graph = kernel.graphVersion;
      await f.packageAt("dep", "test.dep", { provides: ["test.dep@1"] });
      const root = await f.packageAt(
        "root",
        "test.root",
        { requires: ["test.dep@1"] },
        failure === "setup"
          ? "export default {setup(){throw Error('setup failure')}}"
          : undefined,
      );
      await expect(
        installWithDependencies(
          root,
          f.store,
          f.config,
          {},
          async () => {
            throw Error("persist failure");
          },
          kernel,
        ),
      ).rejects.toThrow();
      expect(kernel.list().map((p) => [p.id, p.state])).toEqual([
        ["test.old", "Active"],
      ]);
      expect(kernel.graphVersion).toBe(graph);
      expect(
        await (await kernel.fetch(new Request("http://test/old"))).text(),
      ).toBe("old");
      expect(await readdir(f.store)).toEqual([]);
    } finally {
      await kernel.shutdown();
      await f.close();
    }
  },
);

it("enforces implementation ranges on startup, stopping and hot replacement", async () => {
  const f = await harness();
  const kernel = new Kernel(f.config.dataDir, 100);
  try {
    const provider = await f.packageAt("dep", "test.dep", {
      provides: ["test.value@1"],
      codeReload: "parallel",
    });
    const consumer = await f.packageAt("consumer", "test.consumer", {
      dependencies: { "test.dep": "^1.0.0" },
    });
    await kernel.add(consumer);
    await kernel.add(provider);
    await kernel.start();
    await expect(kernel.stop("test.dep")).rejects.toMatchObject({
      code: "plugin_required",
    });
    const next = await f.packageAt("dep-next", "test.dep", {
      version: "2.0.0",
      provides: ["test.value@1"],
      codeReload: "parallel",
    });
    await expect(
      kernel.replace("test.dep", next, { grants: [] }),
    ).rejects.toMatchObject({ code: "dependency_version" });
    expect(await kernel.invoke("test.value@1")).toBe(42);
    await expect(
      createKernel({
        ...f.config,
        plugins: [{ path: provider, version: "9.0.0", grants: [] }],
      }),
    ).rejects.toMatchObject({ code: "version_lock_mismatch" });
  } finally {
    await kernel.shutdown();
    await f.close();
  }
});

it("starts new dependencies outside the installation request snapshot and publishes one complete graph", async () => {
  const f = await harness();
  const kernel = new Kernel(f.config.dataDir, 100);
  try {
    const old = await f.packageAt("old", "test.old", {
      provides: ["test.old@1"],
    });
    await kernel.add(old);
    await kernel.start();
    f.config.plugins.push({ path: old, grants: [] });
    const graph = kernel.graphVersion;
    await f.packageAt("dep", "test.dep", { provides: ["test.dep@1"] });
    const root = await f.packageAt(
      "root",
      "test.root",
      { provides: ["test.result@1"], requires: ["test.dep@1"] },
      "export default {async setup(h){const value=await h.call('test.dep@1');h.provide('test.result@1',()=>value)}}",
    );
    let next = f.config;
    await installWithDependencies(
      root,
      f.store,
      f.config,
      {},
      async (config) => {
        expect(kernel.graphVersion).toBe(graph);
        next = config;
      },
      kernel,
    );
    expect(kernel.graphVersion).toBeGreaterThan(graph);
    expect(await kernel.invoke("test.result@1")).toBe(42);
    expect(next.plugins).toHaveLength(3);
    expect(kernel.list().every((p) => p.state === "Active")).toBe(true);
  } finally {
    await kernel.shutdown();
    await f.close();
  }
});

it("removes only an installed package and preserves dependencies sharing its immutable set", async () => {
  const f = await harness();
  try {
    await f.packageAt("dep", "test.dep", { provides: ["test.dep@1"] });
    const root = await f.packageAt("root", "test.root", {
      requires: ["test.dep@1"],
    });
    let next = f.config;
    const result = await installWithDependencies(
      root,
      f.store,
      f.config,
      {},
      async (config) => {
        next = config;
      },
    );
    const dep = next.plugins.find((p) => p.path.endsWith("test.dep"))!;
    await removeInstalledPackage(result.path, f.store, "test.root");
    expect(await readFile(join(dep.path, "manifest.json"), "utf8")).toContain(
      "test.dep",
    );
    await removeInstalledPackage(root, f.store, "test.root"); // Source directories are not owned by the store.
    expect(await readFile(join(root, "manifest.json"), "utf8")).toContain(
      "test.root",
    );
    await removeInstalledPackage(dep.path, f.store, "test.dep");
    expect(await readdir(f.store)).toEqual([]);
  } finally {
    await f.close();
  }
});

it("never deletes an existing installation set when publication collides", async () => {
  const f = await harness();
  try {
    const root = await f.packageAt("root", "test.root");
    (globalThis as any).__dependencySetCollision = true;
    await expect(
      installWithDependencies(root, f.store, f.config, {}, async () => {}),
    ).rejects.toMatchObject({ code: "plugin_exists" });
    const sets = await readdir(f.store);
    expect(sets).toHaveLength(1);
    expect(
      await readFile(join(f.store, sets[0]!, "existing-package"), "utf8"),
    ).toBe("preserve existing installation");
  } finally {
    delete (globalThis as any).__dependencySetCollision;
    await f.close();
  }
});

it("CLI calls honor bindings, named dependencies and deliberately disabled optional services", async () => {
  const f = await harness();
  try {
    const first = await f.packageAt("first", "test.first", {
      provides: ["test.choice@1"],
    });
    const second = await f.packageAt(
      "second",
      "test.second",
      { provides: ["test.choice@1"] },
      "export default {setup(h){h.provide('test.choice@1',()=>2)}}",
    );
    const disabled = await f.packageAt(
      "optional",
      "test.optional",
      { provides: ["test.optional@1"] },
      "export default {setup(){throw Error('disabled optional service started')}}",
    );
    const marker = await f.packageAt("marker", "test.marker");
    const root = await f.packageAt(
      "root",
      "test.root",
      {
        provides: ["test.result@1"],
        requires: ["test.choice@1"],
        optionalRequires: ["test.optional@1"],
        dependencies: { "test.marker": "^1.0.0" },
      },
      "export default {setup(h){h.provide('test.result@1',()=>h.call('test.choice@1'))}}",
    );
    const file = join(f.directory, "host.json");
    await writeConfig(file, {
      ...f.config,
      bindings: { "test.choice@1": "test.second" },
      plugins: [first, second, marker, root]
        .map((path) => ({ path, grants: [] }))
        .concat([{ path: disabled, grants: [], enabled: false }] as any),
    });
    const before = await readFile(file, "utf8");
    const result = await promisify(execFile)(process.execPath, [
      resolve("apps/cli/dist/index.js"),
      "call",
      "test.result@1",
      "null",
      "--config",
      file,
    ]);
    expect(JSON.parse(result.stdout)).toBe(2);
    expect(await readFile(file, "utf8")).toBe(before);
  } finally {
    await f.close();
  }
});

it("previews and atomically activates required dependencies through the administrator API", async () => {
  const f = await fixture(["users", "auth"]);
  try {
    const packageAt = async (
      folder: string,
      id: string,
      requires: string[],
      provides: string[],
    ) => {
      const path = join(f.directory, folder);
      await mkdir(join(path, "dist"), { recursive: true });
      await writeFile(
        join(path, "manifest.json"),
        JSON.stringify({
          schemaVersion: 1,
          id,
          version: "1.0.0",
          host: ">=0.1.0-alpha.1",
          runtime: { kind: "native", entry: "dist/index.js" },
          provides,
          requires,
          permissions: [],
        }),
      );
      await writeFile(
        join(path, "dist/index.js"),
        `export default {setup(h){for(const name of ${JSON.stringify(provides)})h.provide(name,()=>42)}}`,
      );
      return path;
    };
    await packageAt("dep", "test.dep", [], ["test.dep@1"]);
    const root = await packageAt(
      "root",
      "test.root",
      ["test.dep@1"],
      ["test.result@1"],
    );
    await writeFile(
      join(root, "dist/index.js"),
      "export default {async setup(h){const value=await h.call('test.dep@1');h.provide('test.result@1',()=>value)}}",
    );
    const admin = await f.admin();
    const before = f.kernel.graphVersion;
    expect(
      (await f.request("/api/host/install-plan", "POST", { path: root }))
        .status,
    ).toBe(401);
    const preview = await f.request(
      "/api/host/install-plan",
      "POST",
      { path: root },
      admin,
    );
    expect(preview.status).toBe(200);
    const plan = await preview.json();
    expect(f.kernel.graphVersion).toBe(before);
    const response = await f.request(
      "/api/host/install",
      "POST",
      { path: root, grants: [], expectedPlan: plan.fingerprint },
      admin,
    );
    expect(response.status, await response.clone().text()).toBe(201);
    expect(await f.kernel.invoke("test.result@1")).toBe(42);
    const installed = await readConfig(f.file);
    expect(installed.plugins.filter((p) => p.version === "1.0.0")).toHaveLength(
      2,
    );
  } finally {
    await f.close();
  }
});

it("keeps CLI plan read-only and writes exact package locks on offline installation", async () => {
  const f = await harness();
  try {
    const dep = await f.packageAt("dep", "test.dep", {
      provides: ["test.dep@1"],
    });
    const root = await f.packageAt("root", "test.root", {
      requires: ["test.dep@1"],
    });
    const file = join(f.directory, "host.json");
    await writeConfig(file, f.config);
    const before = await readFile(file, "utf8");
    const cli = resolve("apps/cli/dist/index.js"),
      exec = promisify(execFile);
    const preview = await exec(process.execPath, [
      cli,
      "plugin",
      "install",
      root,
      "--plan",
      "--config",
      file,
    ]);
    const plan = JSON.parse(preview.stdout);
    expect(await readFile(file, "utf8")).toBe(before);
    await exec(process.execPath, [
      cli,
      "plugin",
      "install",
      root,
      "--expected-plan",
      plan.fingerprint,
      "--config",
      file,
    ]);
    const saved = await readConfig(file);
    expect(saved.plugins).toHaveLength(2);
    expect(saved.plugins.every((p) => p.version && p.integrity)).toBe(true);
    await expect(install(dep, join(dep, "nested"))).rejects.toMatchObject({
      code: "unsafe_package",
    });
  } finally {
    await f.close();
  }
});

it.each([
  { dependencies: { "test.self": "*" } },
  { dependencies: { "test.other": "not-semver" } },
  { requires: ["test.cap@1"], optionalRequires: ["test.cap@1"] },
])("rejects invalid dependency declarations %#", (extra) => {
  expect(() =>
    validateManifest({
      schemaVersion: 1,
      id: "test.self",
      version: "1.0.0",
      host: ">=0.1.0-alpha.1",
      runtime: { kind: "native", entry: "index.js" },
      provides: [],
      requires: [],
      permissions: [],
      ...extra,
    }),
  ).toThrow();
});
