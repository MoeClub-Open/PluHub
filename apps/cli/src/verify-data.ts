import { DatabaseSync } from "node:sqlite";
import { readdir, lstat } from "node:fs/promises";
import { join, relative } from "node:path";
import { createKernel } from "@pluhub/control";

/** Validate a restored data directory without executing plugin code or repairs. */
export async function verifyData(config: Parameters<typeof createKernel>[0]) {
  const kernel = await createKernel(config);
  kernel.validate();
  const databases: { path: string; bytes: number }[] = [];
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(
          "Data validation refuses symbolic links: " +
            relative(config.dataDir, file),
        );
      if (entry.isDirectory()) {
        await walk(file);
        continue;
      }
      if (!entry.isFile()) continue;
      const secret = /(?:\.sqlite(?:-wal|-shm)?|\.key)$/.test(entry.name);
      const info = await lstat(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" && /\.sqlite-(wal|shm)$/.test(entry.name))
          return undefined;
        throw error;
      });
      if (!info) continue;
      if (secret && process.platform !== "win32" && info.mode & 0o077)
        throw new Error(
          "Data file permissions must exclude group/other access: " +
            relative(config.dataDir, file),
        );
      if (!entry.name.endsWith(".sqlite")) continue;
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        const results = db.prepare("PRAGMA quick_check").all();
        if (results.length !== 1 || Object.values(results[0]!)[0] !== "ok")
          throw new Error(
            "SQLite integrity check failed: " + relative(config.dataDir, file),
          );
      } finally {
        db.close();
      }
      databases.push({
        path: relative(config.dataDir, file).replaceAll("\\", "/"),
        bytes: info.size,
      });
    }
  }
  await walk(config.dataDir);
  return { passed: true, pluginCount: config.plugins.length, databases };
}
