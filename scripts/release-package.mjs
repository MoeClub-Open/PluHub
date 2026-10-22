import { readFile } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { createHash } from "node:crypto";

/** Select the exact artifact from this release, not a stale file sharing its name prefix. */
export async function releasePackage(id) {
  const directory = resolve("output/packages");
  const lock = JSON.parse(
    await readFile(resolve(directory, "RELEASE_LOCK.json"), "utf8"),
  );
  const matches = lock.packages.filter((entry) => entry.id === id);
  if (lock.schemaVersion !== 1 || matches.length !== 1)
    throw Error("Missing/ambiguous release artifact: " + id);
  const entry = matches[0];
  if (
    basename(entry.file) !== entry.file ||
    !/^[a-f0-9]{64}$/.test(entry.sha256)
  )
    throw Error("Invalid release lock");
  const path = resolve(directory, entry.file);
  const actual = createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
  if (actual !== entry.sha256) throw Error("Release artifact changed: " + id);
  return path;
}
