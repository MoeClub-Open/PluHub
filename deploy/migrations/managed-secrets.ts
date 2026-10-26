import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { SecretVault } from "@pluhub/control";

/** Run under the deployment's exclusive data lock, before any plugins start. */
export function migrateManagedSecrets(file: string, write = true) {
  const original = readFileSync(file, "utf8");
  const config = JSON.parse(original);
  const references = new Set<string>();
  const collect = (value: any) => {
    if (typeof value === "string" && /^env:[A-Z][A-Z0-9_]*$/.test(value))
      references.add(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object")
      Object.values(value).forEach(collect);
  };
  collect(config.plugins);
  const names = [...references].map((reference) => reference.slice(4));
  if (write && !names.length && existsSync(file + ".managed-secrets.json"))
    for (const name of JSON.parse(
      readFileSync(file + ".managed-secrets.json", "utf8"),
    ).names)
      delete process.env[name];
  if (!write || !names.length)
    return { changed: false, references: names.length, imported: 0 };
  const vault = new SecretVault(resolve(dirname(file), config.dataDir));
  let imported = 0;
  for (const name of names) {
    const value = process.env[name];
    if (value) {
      vault.put(value, "secret:" + name);
      imported++;
    }
  }
  const replace = (value: any): any => {
    if (typeof value === "string" && references.has(value))
      return "secret:" + value.slice(4);
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, replace(item)]),
      );
    return value;
  };
  const backup = file + ".before-managed-secrets";
  if (!existsSync(backup))
    writeFileSync(backup, original, { flag: "wx", mode: 0o600 });
  const temporary = file + ".managed-secrets.tmp";
  writeFileSync(temporary, JSON.stringify(replace(config), null, 2) + "\n", {
    mode: 0o600,
  });
  renameSync(temporary, file);
  writeFileSync(
    file + ".managed-secrets.json",
    JSON.stringify({ names, imported }) + "\n",
    { mode: 0o600 },
  );
  for (const name of names) delete process.env[name];
  return { changed: true, references: names.length, imported };
}
