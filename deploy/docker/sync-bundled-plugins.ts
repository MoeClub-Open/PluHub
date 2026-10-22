import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { validateConfig, writeConfig } from "@pluhub/control";
import type { HostConfig } from "@pluhub/sdk";

export interface ImagePluginCatalog {
  imageId: string;
  plugins: Record<string, { id: string; version: string; integrity: string }>;
}

export async function syncBundledPlugins(file: string) {
  const catalog: ImagePluginCatalog = JSON.parse(
    await readFile(new URL("./bundled-plugins.json", import.meta.url), "utf8"),
  );
  const marker = file + ".image.json";
  try {
    const previous = JSON.parse(await readFile(marker, "utf8"));
    if (previous.imageId === catalog.imageId) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const config: HostConfig = JSON.parse(await readFile(file, "utf8"));
  validateConfig(config);
  let updated = 0;
  for (const plugin of config.plugins) {
    const release = catalog.plugins[resolve(dirname(file), plugin.path)];
    if (!release) continue;
    plugin.version = release.version;
    if (plugin.integrity) plugin.integrity = release.integrity;
    updated++;
  }
  await writeConfig(file, config);
  await writeConfig(marker, { imageId: catalog.imageId });
  console.log("Activated image-bundled plugin records: " + updated);
}
