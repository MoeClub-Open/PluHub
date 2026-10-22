// Run with the gateway stopped. Default is a dry run; --write backs up first.
import { readFile, writeFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve, dirname } from "node:path";
import { pathToFileURL } from "node:url";

const file = process.argv[2];
if (!file)
  throw new Error(
    "Usage: node scripts/migrate-channel-graphs.mjs CONFIG [--write]",
  );
const path = resolve(file);
const raw = await readFile(path, "utf8");
const config = JSON.parse(raw);
const entry = config.plugins.find((p) =>
  /\/(?:official\.)?ai-router$/.test(p.path.replaceAll("\\", "/")),
);
if (!entry) throw new Error("AI Router plugin is not configured");
const { migrateLegacyChannels } = await import(
  pathToFileURL(resolve(dirname(path), entry.path, "dist/index.js")).href
);
const changed = migrateLegacyChannels(config);
let backup;
if (changed && process.argv.includes("--write")) {
  backup =
    path +
    ".pre-channel-graphs-" +
    new Date().toISOString().replaceAll(/[:.]/g, "-") +
    ".json";
  await writeFile(backup, raw, { flag: "wx", mode: 0o600 });
  const temp = path + "." + randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify(config, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  await rename(temp, path);
}
console.log(
  JSON.stringify({
    changed,
    written: changed && process.argv.includes("--write"),
    channels: Object.keys(entry.config.upstreams ?? {}).length,
    ...(backup ? { backup } : {}),
  }),
);
