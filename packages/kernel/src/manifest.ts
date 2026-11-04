import { realpath } from "node:fs/promises";
import { resolve, relative, isAbsolute, sep } from "node:path";
import Ajv from "ajv";
import semver from "semver";
import schema from "@pluhub/contracts/manifest.schema.json" with { type: "json" };
import { HOST_VERSION } from "@pluhub/contracts";
import { HostError, type Manifest } from "@pluhub/sdk";

export const manifestAjv = new Ajv.default({ allErrors: true });
const manifestValidator = manifestAjv.compile(schema);

export function validateManifest(value: unknown): Manifest {
  if (!manifestValidator(value))
    throw new HostError(
      "invalid_manifest",
      manifestAjv.errorsText(manifestValidator.errors),
    );
  const m = value as unknown as Manifest;
  if (
    !semver.valid(m.version) ||
    !semver.validRange(m.host) ||
    !semver.satisfies(HOST_VERSION, m.host, { includePrerelease: true })
  )
    throw new HostError("host_version", "Incompatible plugin version");
  for (const [id, range] of Object.entries(m.dependencies ?? {})) {
    if (id === m.id || !range.trim() || !semver.validRange(range))
      throw new HostError(
        "invalid_dependency",
        "Invalid dependency " + id + " for " + m.id,
      );
  }
  if (m.requires.some((name) => m.optionalRequires?.includes(name)))
    throw new HostError(
      "invalid_dependency",
      "A capability cannot be both required and optional",
    );
  if (m.ui) {
    const paths = [m.ui.path, ...(m.ui.pages ?? []).map((page) => page.path)];
    if (new Set(paths).size !== paths.length)
      throw new HostError(
        "invalid_ui",
        "UI page paths must be unique within a plugin",
      );
  }
  return m;
}

export async function safeEntry(base: string, entry: string): Promise<string> {
  if (isAbsolute(entry))
    throw new HostError("unsafe_path", "Entry must be relative");
  const root = await realpath(base);
  const file = await realpath(resolve(base, entry));
  const rel = relative(root, file);
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel))
    throw new HostError("unsafe_path", "Entry escapes plugin directory");
  return file;
}

export const frozen = <T>(value: T): T => {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const v of Object.values(value)) frozen(v);
  }
  return value;
};
