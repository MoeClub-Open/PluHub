import type { HostConfig } from "@pluhub/sdk";
import type { SecretVault } from "@pluhub/kernel";

/** Seal declared credentials before configuration validation, persistence or publication. */
export function sealConfigSecrets(config: HostConfig, vault: SecretVault) {
  const replacements = new Map<string, string>();
  for (const plugin of config.plugins ?? [])
    for (const value of (plugin.config?.secretRefs ?? []) as string[]) {
      if (typeof value !== "string" || !value) continue;
      if (/^(env:|secret:|local:)/.test(value)) continue;
      if (!replacements.has(value)) replacements.set(value, vault.put(value));
    }
  const visit = (value: any, field = ""): any => {
    if (typeof value === "string")
      return /Refs?$/.test(field) ? (replacements.get(value) ?? value) : value;
    if (Array.isArray(value)) return value.map((item) => visit(item, field));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, visit(item, key)]),
      );
    return value;
  };
  return visit(config) as HostConfig;
}
