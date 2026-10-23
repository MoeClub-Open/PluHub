import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { writeConfig } from "@pluhub/control";
import type { HostConfig } from "@pluhub/sdk";
import { migrateLegacyChannels } from "./channel-graphs.ts";

const retired = new Set(["official.workflow", "official.protocol-converter"]);
export async function migratePluginBoundaries(file: string, write = true) {
  const marker = file + ".plugin-boundaries.json";
  let applied = false;
  try {
    applied = JSON.parse(await readFile(marker, "utf8")).version === 1;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const original = await readFile(file, "utf8");
  const config: HostConfig = JSON.parse(original);
  const identities = new Map<string, string>();
  for (const plugin of config.plugins) {
    // Bundled retired directories no longer exist in the new image.
    const basename = plugin.path.replaceAll("\\", "/").split("/").pop()!;
    const bundledId = "official." + basename.replace(/^official\./, "");
    if (retired.has(bundledId)) identities.set(plugin.path, bundledId);
    else {
      const manifest = JSON.parse(
        await readFile(
          resolve(dirname(file), plugin.path, "manifest.json"),
          "utf8",
        ),
      );
      identities.set(plugin.path, manifest.id);
      if (
        manifest.requires.some((name: string) =>
          ["ai.workflow@1", "ai.converter@1"].includes(name),
        )
      )
        throw new Error(
          `Update ${manifest.id} before retiring its legacy dependency`,
        );
    }
  }
  // Resolve identity once; legacy transformation never depends on installation locations.
  const entries = config.plugins.map((plugin) => ({
    ...plugin,
    path: "/" + identities.get(plugin.path),
  }));
  migrateLegacyChannels({ plugins: entries });
  for (const [index, entry] of entries.entries())
    config.plugins[index]!.config = entry.config;
  config.plugins = config.plugins.filter(
    (plugin) => !retired.has(identities.get(plugin.path)!),
  );
  for (const [name, provider] of Object.entries(config.bindings ?? {}))
    if (
      retired.has(provider) ||
      ["ai.workflow@1", "ai.converter@1"].includes(name)
    )
      delete config.bindings![name];
  const router = config.plugins.find(
    (plugin) => identities.get(plugin.path) === "official.ai-router",
  );
  if (
    !applied &&
    router &&
    !router.grants.includes("*") &&
    !router.grants.includes("http.dispatch")
  )
    router.grants.push("http.dispatch");
  const changed =
    JSON.stringify(JSON.parse(original)) !== JSON.stringify(config);
  if (changed && write) {
    await writeFile(
      file + ".pre-plugin-boundaries-" + Date.now() + ".json",
      original,
      { mode: 0o600, flag: "wx" },
    );
    await writeConfig(file, config);
  }
  if (write && !applied) await writeConfig(marker, { version: 1 });
  return { changed, written: changed && write };
}
