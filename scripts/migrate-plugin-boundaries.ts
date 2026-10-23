import { resolve } from "node:path";
import { migratePluginBoundaries } from "../deploy/migrations/plugin-boundaries.ts";

if (!process.argv[2])
  throw new Error(
    "Usage: bun scripts/migrate-plugin-boundaries.ts CONFIG [--write]",
  );
console.log(
  JSON.stringify(
    await migratePluginBoundaries(
      resolve(process.argv[2]),
      process.argv.includes("--write"),
    ),
  ),
);
