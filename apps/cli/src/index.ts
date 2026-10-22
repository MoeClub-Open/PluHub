#!/usr/bin/env bun
import { scaffold } from "./scaffold.js";
import { withPublicOrigin } from "./public-origin.js";
import { defaultPluginNames } from "./presets.js";
import { verifyData } from "./verify-data.js";
import { readFile, access, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createKernel,
  readConfig,
  writeConfig,
  attachManagement,
  installWithDependencies,
  planInstall,
  removeInstalledPackage,
  applyPendingPluginUpdate,
  recoverInterruptedPluginUpdate,
} from "@pluhub/control";
const args = process.argv.slice(2);
const option = (name: string, fallback?: string) => {
  const index = args.indexOf("--" + name);
  return index >= 0 ? args[index + 1] : fallback;
};
const file = resolve(option("config", "pluhub.json")!);
async function requireOffline() {
  try {
    const pid = Number(await readFile(file + ".pid", "utf8"));
    try {
      process.kill(pid, 0);
    } catch {
      await rm(file + ".pid", { force: true });
      return;
    }
    throw new Error("Host is running; use its management API or stop it first");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
async function main() {
  const command = args[0] ?? "help";
  if (command === "create-plugin") {
    console.log(await scaffold(args[1]!, option("id", "example.hello")));
    return;
  }
  if (command === "init") {
    try {
      await access(file);
      throw new Error("Config already exists");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const pluginsRoot = resolve(
      option(
        "plugins",
        fileURLToPath(
          new URL("../../../../PluHub-Plugins/plugins/", import.meta.url),
        ),
      )!,
    );
    const plugins = [];
    for (const name of defaultPluginNames) {
      const path = resolve(pluginsRoot, name);
      const manifest = JSON.parse(
        await readFile(resolve(path, "manifest.json"), "utf8"),
      );
      plugins.push({
        path,
        grants: manifest.permissions,
        config:
          name === "listener"
            ? {
                port: Number(option("port", "8080")),
                host: option("host", "127.0.0.1"),
              }
            : name === "ai-router"
              ? { upstreams: {}, models: {} }
              : name.startsWith("upstream-")
                ? { secretRefs: [] }
                : {},
      });
    }
    await mkdir(dirname(file), { recursive: true });
    await writeConfig(file, {
      schemaVersion: 1,
      dataDir: resolve(dirname(file), ".pluhub/data"),
      drainTimeoutMs: 30000,
      pluginSources: [pluginsRoot],
      plugins,
    });
    console.log("Created " + file);
    return;
  }
  if (command === "help") {
    console.log(
      "pluhub create-plugin <directory> | init | validate | verify-data | start | set-public-origin <http(s)://host> | bootstrap-admin --username admin | call <capability> <json> | plugin install <directory> --grant <permissions>\nOptions: --config <path>. Bootstrap password: PLUHUB_ADMIN_PASSWORD.",
    );
    return;
  }
  if (command === "start") await recoverInterruptedPluginUpdate(file);
  const config = await readConfig(file);
  if (command === "verify-data") {
    await requireOffline();
    console.log(JSON.stringify(await verifyData(config), null, 2));
    return;
  }
  if (command === "set-public-origin") {
    await requireOffline();
    if (!args[1] || args[1].startsWith("--"))
      throw new Error("Supply a public origin");
    const next = await withPublicOrigin(config, args[1]);
    const checked = await createKernel(next);
    checked.validate();
    await writeConfig(file, next);
    console.log(
      "Public origin and session cookie policy updated; restart the host",
    );
    return;
  }
  if (command === "validate") {
    const kernel = await createKernel(config);
    kernel.validate();
    console.log("Configuration and plugin graph valid");
    return;
  }
  if (
    command === "plugin" &&
    ["list", "enable", "disable", "remove"].includes(args[1] ?? "")
  ) {
    const manifests = await Promise.all(
      config.plugins.map(async (entry) => ({
        entry,
        manifest: JSON.parse(
          await readFile(resolve(entry.path, "manifest.json"), "utf8"),
        ),
      })),
    );
    if (args[1] === "list") {
      console.log(
        JSON.stringify(
          manifests.map(({ entry, manifest }) => ({
            id: manifest.id,
            version: manifest.version,
            enabled: entry.enabled !== false,
          })),
          null,
          2,
        ),
      );
      return;
    }
    await requireOffline();
    const item = manifests.find((p) => p.manifest.id === args[2]);
    if (!item) throw new Error("Unknown plugin");
    const next = structuredClone(config);
    const index = config.plugins.indexOf(item.entry);
    if (args[1] === "remove") next.plugins.splice(index, 1);
    else next.plugins[index]!.enabled = args[1] === "enable";
    const checked = await createKernel(next);
    checked.validate();
    await writeConfig(file, next);
    if (args[1] === "remove") {
      await removeInstalledPackage(
        item.entry.path,
        resolve(dirname(file), ".pluhub/plugins"),
        item.manifest.id,
      );
    }
    console.log("Plugin configuration updated");
    return;
  }
  if (command === "plugin" && args[1] === "install") {
    const source = args[2];
    if (!source || source.startsWith("--"))
      throw new Error("Supply a plugin directory or archive");
    const options = {
      sources: args.flatMap((value, index) =>
        value === "--source" && args[index + 1]
          ? [resolve(args[index + 1]!)]
          : [],
      ),
      grants: option("grant", "")!
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      config: JSON.parse(option("plugin-config", "{}")!),
      dependencyGrants: JSON.parse(option("dependency-grants", "{}")!),
      dependencyConfigs: JSON.parse(option("dependency-configs", "{}")!),
      expectedPlan: option("expected-plan"),
    };
    if (args.includes("--plan")) {
      console.log(
        JSON.stringify(
          await planInstall(resolve(source), config, options),
          null,
          2,
        ),
      );
      return;
    }
    await requireOffline();
    const installed = await installWithDependencies(
      resolve(source),
      resolve(dirname(file), ".pluhub/plugins"),
      config,
      options,
      (next) => writeConfig(file, next),
    );
    console.log(JSON.stringify(installed));
    return;
  }
  if (command === "bootstrap-admin" || command === "call") {
    await requireOffline();
    const capability =
      command === "bootstrap-admin" ? "auth.bootstrap@1" : args[1]!;
    const manifests = await Promise.all(
      config.plugins.map(async (p) => ({
        p,
        m: JSON.parse(await readFile(resolve(p.path, "manifest.json"), "utf8")),
      })),
    );
    const needed = new Set<string>();
    const collect = (cap: string) => {
      const found = manifests.filter(
        (x) =>
          x.p.enabled !== false &&
          x.m.provides.includes(cap) &&
          (!config.bindings?.[cap] || config.bindings[cap] === x.m.id),
      );
      if (found.length !== 1)
        throw new Error("Expected one provider for " + cap);
      include(found[0]!);
    };
    const include = (item: (typeof manifests)[number]) => {
      if (needed.has(item.m.id)) return;
      needed.add(item.m.id);
      for (const id of Object.keys(item.m.dependencies ?? {})) {
        const dependency = manifests.find(
          (candidate) => candidate.m.id === id && candidate.p.enabled !== false,
        );
        if (!dependency)
          throw new Error("Missing or disabled dependency " + id);
        include(dependency);
      }
      for (const cap of item.m.requires) collect(cap);
      for (const cap of item.m.optionalRequires ?? []) {
        const providers = manifests.filter(
          (candidate) =>
            candidate.p.enabled !== false &&
            candidate.m.provides.includes(cap) &&
            (!config.bindings?.[cap] ||
              config.bindings[cap] === candidate.m.id),
        );
        if (providers.length === 1) collect(cap);
      }
    };
    collect(capability);
    const selected = {
      ...config,
      plugins: manifests
        .filter((x) => needed.has(x.m.id))
        .map((x) => ({ ...x.p, enabled: true })),
    };
    const kernel = await createKernel(selected);
    await kernel.start();
    try {
      const input =
        command === "bootstrap-admin"
          ? {
              username: option("username", "admin"),
              password: process.env.PLUHUB_ADMIN_PASSWORD,
            }
          : JSON.parse(args[2] ?? "null");
      if (command === "bootstrap-admin" && !input.password)
        throw new Error("Set PLUHUB_ADMIN_PASSWORD");
      console.log(JSON.stringify(await kernel.invoke(capability, input)));
    } finally {
      await kernel.shutdown();
    }
    return;
  }
  if (command === "start") {
    await requireOffline();
    await writeFile(file + ".pid", String(process.pid), {
      flag: "wx",
      mode: 0o600,
    });
    let kernel = await createKernel(config);
    let restartTask: Promise<void> | undefined;
    let stopping = false;
    let control: ReturnType<typeof attachManagement>;
    const restart = async (): Promise<void> => {
      if (stopping) throw new Error("Host is stopping");
      if (restartTask) return restartTask;
      restartTask = (async () => {
        const result = await applyPendingPluginUpdate(kernel, file, {
          restart,
        });
        kernel = result.kernel;
        control = result.management;
      })();
      try {
        await restartTask;
      } catch (error) {
        if ((error as { code?: string }).code === "update_recovery_required") {
          console.error("Plugin update recovery requires a host restart");
          process.exitCode = 1;
          setTimeout(() => process.exit(1), 100).unref();
        }
        throw error;
      } finally {
        restartTask = undefined;
      }
    };
    control = attachManagement(kernel, file, config, { restart });
    try {
      await kernel.start();
    } catch (error) {
      await rm(file + ".pid", { force: true });
      throw error;
    }
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      try {
        await restartTask;
        await kernel.shutdown();
        await rm(file + ".pid", { force: true });
      } catch (error) {
        console.error(error);
        process.exitCode = 1;
      }
    };
    process.on("SIGINT", () => void stop());
    process.on("SIGTERM", () => void stop());
    if (process.platform === "linux")
      process.on(
        "SIGHUP",
        () =>
          void control
            .reload()
            .catch((error) => console.error("Reload rejected:", error.message)),
      );
    console.log(
      JSON.stringify({ status: "ready", graphVersion: kernel.graphVersion }),
    );
    return;
  }
  throw new Error("Unknown command");
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
