import { t as listArchive, x as extractArchive, c as createArchive } from "tar";
import {
  readFile,
  mkdir,
  rename,
  readdir,
  lstat,
  cp,
  rm,
  mkdtemp,
  realpath,
  rmdir,
} from "node:fs/promises";
import { resolve, relative, sep, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { validateManifest, safeEntry } from "@pluhub/kernel";
import { HostError } from "@pluhub/sdk";
/** Remove only a package owned by this install store, preserving sibling dependencies. */
export async function removeInstalledPackage(
  path: string,
  root: string,
  id: string,
) {
  const parts = relative(resolve(root), resolve(path)).split(sep);
  if (
    !(parts.length === 1 && parts[0] === id) &&
    !(
      parts.length === 2 &&
      (/^set-[a-zA-Z0-9_-]+$/.test(parts[0]!) ||
        parts[0]!.startsWith(id + "-")) &&
      parts[1] === id
    )
  )
    return;
  const base = await realpath(root),
    target = await realpath(path);
  if (relative(base, target) !== parts.join(sep))
    throw new HostError(
      "unsafe_path",
      "Installed package path resolves outside its store",
    );
  await rm(target, { recursive: true, force: true });
  if (parts.length === 2) {
    const parent = resolve(base, parts[0]!);
    if ((await readdir(parent)).length === 0) await rmdir(parent);
  }
}
export async function digest(directory: string): Promise<string> {
  const hash = createHash("sha256");
  async function walk(path: string) {
    for (const item of (await readdir(path, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      if (item.name === "node_modules" || item.name === ".git") continue;
      const target = resolve(path, item.name);
      const stat = await lstat(target);
      if (stat.isSymbolicLink())
        throw new HostError(
          "unsafe_package",
          "Plugin packages may not contain symlinks",
        );
      if (stat.isDirectory()) await walk(target);
      else if (stat.isFile()) {
        hash.update(
          relative(directory, target).split(sep).join("/") +
            "\0" +
            stat.size +
            "\0",
        );
        hash.update(await readFile(target));
      }
    }
  }
  await walk(directory);
  return hash.digest("hex");
}
export async function install(
  source: string,
  root: string,
  validate?: (directory: string) => Promise<void>,
) {
  await mkdir(root, { recursive: true });
  let directory = source;
  let unpacked: string | undefined;
  if ((await lstat(source)).isFile()) {
    if ((await lstat(source)).size > 64 * 1024 * 1024)
      throw new HostError("unsafe_package", "Archive exceeds 64 MiB");
    unpacked = await mkdtemp(resolve(root, ".unpack-"));
    let invalid = false;
    let total = 0;
    let entries = 0;
    try {
      await listArchive({
        file: source,
        strict: true,
        onReadEntry: (entry) => {
          const path = entry.path;
          total += entry.size;
          entries++;
          if (
            path.startsWith("/") ||
            path.includes("\\") ||
            path.includes(":") ||
            path.split("/").includes("..") ||
            !["File", "Directory"].includes(entry.type) ||
            total > 256 * 1024 * 1024 ||
            entries > 10000
          )
            invalid = true;
        },
      });
      if (invalid)
        throw new HostError("unsafe_package", "Unsafe archive entry or size");
      await extractArchive({
        file: source,
        cwd: unpacked,
        strict: true,
        preservePaths: false,
      });
      try {
        await readFile(resolve(unpacked, "manifest.json"));
        directory = unpacked;
      } catch {
        directory = resolve(unpacked, "package");
      }
    } catch (error) {
      await rm(unpacked, { recursive: true, force: true });
      throw error;
    }
  }
  try {
    return await installDirectory(directory, root, validate);
  } finally {
    if (unpacked) await rm(unpacked, { recursive: true, force: true });
  }
}
export async function packPlugin(directory: string, file: string) {
  await digest(directory);
  await createArchive(
    {
      gzip: true,
      file,
      cwd: directory,
      portable: true,
      mtime: new Date(0),
      filter: (path) =>
        !path.split(/[\\/]/).some((p) => ["node_modules", ".git"].includes(p)),
    },
    [
      "manifest.json",
      "dist",
      ...((await lstat(resolve(directory, "package.json")).catch(() => null))
        ? ["package.json"]
        : []),
    ],
  );
}
async function installDirectory(
  directory: string,
  root: string,
  validate?: (directory: string) => Promise<void>,
) {
  const targetRelative = relative(resolve(directory), resolve(root));
  if (
    targetRelative === "" ||
    (!targetRelative.startsWith(".." + sep) &&
      targetRelative !== ".." &&
      !isAbsolute(targetRelative))
  )
    throw new HostError(
      "unsafe_package",
      "Installation directory must not be inside the source package",
    );
  const manifest = validateManifest(
    JSON.parse(await readFile(resolve(directory, "manifest.json"), "utf8")),
  );
  await safeEntry(directory, manifest.runtime.entry);
  if (manifest.ui) {
    await safeEntry(directory, manifest.ui.entry);
    for (const slot of manifest.ui.slots ?? [])
      await safeEntry(directory, slot.entry);
  }
  const hash = await digest(directory);
  await mkdir(root, { recursive: true });
  const target = resolve(root, manifest.id);
  if (await lstat(target).catch(() => undefined))
    throw new HostError(
      "plugin_exists",
      "Installation target already exists: " + manifest.id,
      409,
    );
  if (
    relative(resolve(root), target).startsWith("..") ||
    isAbsolute(relative(resolve(root), target))
  )
    throw new Error("Unsafe install path");
  const stage = await mkdtemp(resolve(root, ".install-"));
  try {
    await cp(directory, stage, {
      recursive: true,
      filter: (source) =>
        !["node_modules", ".git"].includes(source.split(sep).pop()!),
    });
    if ((await digest(stage)) !== hash)
      throw new Error("Plugin changed during install");
    await validate?.(stage);
    await rename(stage, target);
    return {
      id: manifest.id,
      version: manifest.version,
      path: target,
      sha256: hash,
    };
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}
