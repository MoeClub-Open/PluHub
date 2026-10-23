import { lstat, realpath, rm } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import type { Kernel } from "@pluhub/kernel";
import { HostError, type HostConfig } from "@pluhub/sdk";
import { removeInstalledPackage } from "./package.js";

/** Data belongs to one plugin directory; never follow a link when purging it. */
async function purgeData(root: string, id: string) {
  const base = await realpath(root),
    target = resolve(base, id);
  if (relative(base, target) !== id)
    throw new HostError("unsafe_path", "Invalid plugin data path");
  try {
    const stat = await lstat(target);
    if (stat.isSymbolicLink() || (await realpath(target)) !== target)
      throw new HostError("unsafe_path", "Plugin data path must not be a link");
    await rm(target, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function uninstallPlugin(
  kernel: Kernel,
  file: string,
  config: HostConfig,
  id: string,
  purge: boolean,
  persist: (config: HostConfig) => Promise<void>,
) {
  kernel.assertRemovable(id);
  const plugin = kernel.list().find((p) => p.id === id)!;
  const next = structuredClone(config);
  next.plugins = next.plugins.filter((p) => resolve(p.path) !== plugin.path);
  next.bindings = Object.fromEntries(
    Object.entries(next.bindings ?? {}).filter(([, owner]) => owner !== id),
  );
  if (plugin.state === "Active" || plugin.state === "Failed")
    await kernel.stop(id);
  try {
    await persist(next);
  } catch (error) {
    if (plugin.state === "Active") await kernel.enable(id);
    throw error;
  }
  kernel.remove(id);
  // Configuration is already committed. Report cleanup failures without pretending the plugin is still installed.
  const cleanup: string[] = [];
  if (purge)
    await purgeData(kernel.dataDir, id).catch(() => cleanup.push("data"));
  await removeInstalledPackage(
    plugin.path,
    resolve(dirname(file), ".pluhub/plugins"),
    id,
  ).catch(() => cleanup.push("package"));
  await removeInstalledPackage(
    plugin.path,
    resolve(dirname(file), ".pluhub/plugin-releases"),
    id,
  ).catch(() => cleanup.push("package"));
  return {
    ok: true,
    data: purge
      ? cleanup.includes("data")
        ? "cleanup_pending"
        : "deleted"
      : "retained",
    cleanupPending: cleanup,
  };
}
