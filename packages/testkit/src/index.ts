import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel } from "@pluhub/kernel";
import type { Manifest } from "@pluhub/sdk";
export async function mockHost() {
  const directory = await mkdtemp(join(tmpdir(), "pluhub-"));
  const kernel = new Kernel(join(directory, "data"), 200);
  return {
    directory,
    kernel,
    async plugin(
      manifest: Manifest,
      source: string,
      grants = manifest.permissions,
    ) {
      const path = join(directory, manifest.id);
      await mkdir(path);
      await writeFile(join(path, "manifest.json"), JSON.stringify(manifest));
      await writeFile(join(path, manifest.runtime.entry), source);
      await kernel.add(path, { grants });
      return path;
    },
    async close() {
      try {
        await kernel.shutdown();
      } finally {
        await rm(directory, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        });
      }
    },
  };
}
