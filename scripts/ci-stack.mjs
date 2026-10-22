import { readFile } from "node:fs/promises";
const lock = JSON.parse(
  await readFile(new URL("../ci/companions.json", import.meta.url), "utf8"),
);
if (lock.schemaVersion !== 1) throw Error("Unsupported CI stack lock");
for (const key of ["spec", "go", "plugins"]) {
  if (!/^[a-f0-9]{40}$/.test(lock[key] ?? ""))
    throw Error("Companion repositories require full commit IDs");
  console.log(`${key}=${lock[key]}`);
}
