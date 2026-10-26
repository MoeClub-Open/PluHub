import { resolve } from "node:path";
import { migrateManagedSecrets } from "../deploy/migrations/managed-secrets.ts";
if (!process.argv[2])
  throw new Error(
    "Usage: bun scripts/migrate-managed-secrets.ts CONFIG [--write]",
  );
console.log(
  JSON.stringify(
    migrateManagedSecrets(
      resolve(process.argv[2]),
      process.argv.includes("--write"),
    ),
  ),
);
