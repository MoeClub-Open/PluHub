import {
  readFile,
  readdir,
  lstat,
  mkdir,
  mkdtemp,
  rename,
  rm,
} from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import semver from "semver";
import { Kernel, validateManifest } from "@pluhub/kernel";
import {
  HostError,
  type HostConfig,
  type Manifest,
  type PluginConfig,
} from "@pluhub/sdk";
import { digest, install } from "./package.js";
import type { PluginInstallPlan } from "@pluhub/contracts";

type Candidate = {
  manifest: Manifest;
  path: string;
  sha256: string;
  installed: boolean;
};
export interface InstallOptions {
  sources?: string[];
  grants?: string[];
  dependencyGrants?: Record<string, string[]>;
  config?: Record<string, unknown>;
  dependencyConfigs?: Record<string, Record<string, unknown>>;
  expectedPlan?: string;
  isolatedSources?: boolean;
  origins?: Record<string, NonNullable<PluginConfig["origin"]>>;
}
export type InstallPlan = PluginInstallPlan;
export function readInstallOptions(
  body: Record<string, unknown>,
): InstallOptions {
  const object = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value);
  const strings = (value: unknown): value is string[] =>
    Array.isArray(value) &&
    value.length <= 128 &&
    value.every(
      (item) =>
        typeof item === "string" && item.length > 0 && item.length <= 2048,
    );
  if (
    Object.keys(body).some(
      (key) =>
        ![
          "path",
          "sources",
          "grants",
          "dependencyGrants",
          "config",
          "dependencyConfigs",
          "expectedPlan",
        ].includes(key),
    ) ||
    (body.sources !== undefined &&
      (!strings(body.sources) || body.sources.length > 64)) ||
    (body.grants !== undefined && !strings(body.grants)) ||
    (body.config !== undefined && !object(body.config)) ||
    (body.dependencyGrants !== undefined &&
      (!object(body.dependencyGrants) ||
        !Object.values(body.dependencyGrants).every(strings))) ||
    (body.dependencyConfigs !== undefined &&
      (!object(body.dependencyConfigs) ||
        !Object.values(body.dependencyConfigs).every(object))) ||
    (body.expectedPlan !== undefined &&
      (typeof body.expectedPlan !== "string" ||
        !/^[a-f0-9]{64}$/.test(body.expectedPlan)))
  )
    throw new HostError("invalid_request", "Invalid installation options");
  return body as InstallOptions;
}
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (code: string, message: string): never => {
  throw new HostError(code, message, 409);
};
const satisfies = (candidate: Candidate, range: string) =>
  semver.satisfies(candidate.manifest.version, range, {
    includePrerelease: true,
  });

/** Never loads plugin code, follows optional edges, upgrades installed packages, or grants permissions. */
async function resolveInstall(
  source: string,
  config: HostConfig,
  options: InstallOptions,
  workspace: string,
) {
  const rootPackage = await install(resolve(source), join(workspace, "root"));
  const read = async (path: string, installed = false): Promise<Candidate> => ({
    path,
    installed,
    manifest: validateManifest(
      JSON.parse(await readFile(join(path, "manifest.json"), "utf8")),
    ),
    sha256: await digest(path),
  });
  const root = await read(rootPackage.path);
  const existing = new Map<string, Candidate>();
  const disabled = new Set<string>();
  const selected = new Map<string, Candidate>();
  for (const settings of config.plugins) {
    const candidate = await read(resolve(settings.path), true);
    const id = candidate.manifest.id;
    if (existing.has(id))
      fail("duplicate_plugin", "Duplicate installed plugin " + id);
    if (settings.integrity && settings.integrity !== candidate.sha256)
      fail("integrity_mismatch", "Installed content changed: " + id);
    if (settings.version && settings.version !== candidate.manifest.version)
      fail("version_lock_mismatch", "Locked version differs for " + id);
    existing.set(id, candidate);
    if (settings.enabled === false) disabled.add(id);
    else selected.set(id, candidate);
  }
  if (existing.has(root.manifest.id))
    fail(
      "duplicate_plugin",
      "Already installed: " + root.manifest.id + "; use the update operation",
    );
  selected.set(root.manifest.id, root);
  const candidates: Candidate[] = [root];
  const paths = new Set<string>([resolve(source)]);
  let archives = 0,
    inspected = 0;
  const add = async (path: string, explicit: boolean) => {
    path = resolve(path);
    if (paths.has(path)) return;
    paths.add(path);
    if (++inspected > 512)
      fail("catalog_limit", "Too many local dependency packages");
    const stat = await lstat(path);
    if (stat.isSymbolicLink())
      fail("unsafe_package", "Dependency source may not be a symlink");
    let directory = path;
    if (stat.isFile()) {
      if (!/\.(?:tgz|tar\.gz)$/i.test(path)) return;
      try {
        directory = (
          await install(path, join(workspace, "archive-" + archives++))
        ).path;
      } catch (error) {
        if (explicit) throw error;
        return; // A catalog may also contain SDK/npm archives, which are not plugin packages.
      }
    } else if (!stat.isDirectory()) return;
    const manifest = await lstat(join(directory, "manifest.json")).catch(
      () => undefined,
    );
    if (!manifest) {
      if (explicit) fail("missing_manifest", "No plugin manifest: " + path);
      return;
    }
    let candidate: Candidate;
    try {
      candidate = await read(directory);
    } catch (error) {
      if (explicit) throw error;
      return;
    }
    if (
      !candidates.some(
        (c) =>
          c.manifest.id === candidate.manifest.id &&
          c.manifest.version === candidate.manifest.version &&
          c.sha256 === candidate.sha256,
      )
    )
      candidates.push(candidate);
  };
  const sources = [
    ...new Set([
      ...(options.sources ?? []),
      ...(options.isolatedSources
        ? []
        : [...(config.pluginSources ?? []), dirname(resolve(source))]),
    ]),
  ];
  if (sources.length > 65) fail("catalog_limit", "Too many dependency sources");
  for (const path of sources) {
    const stat = await lstat(path);
    if (stat.isSymbolicLink())
      fail("unsafe_package", "Dependency source may not be a symlink");
    if (
      stat.isFile() ||
      (await lstat(join(path, "manifest.json")).catch(() => undefined))
    ) {
      await add(path, true);
    } else {
      for (const entry of (await readdir(path, { withFileTypes: true })).sort(
        (a, b) => a.name.localeCompare(b.name),
      )) {
        if (entry.name.startsWith(".") || entry.name === "node_modules")
          continue;
        if (entry.isDirectory() || /\.(?:tgz|tar\.gz)$/i.test(entry.name))
          await add(join(path, entry.name), false);
      }
    }
  }
  function edges(chosen: Map<string, Candidate>) {
    const result = new Map<string, string[]>();
    for (const candidate of chosen.values()) {
      const targets = Object.keys(candidate.manifest.dependencies ?? {});
      for (const capability of candidate.manifest.requires) {
        const providers = [...chosen.values()].filter(
          (c) =>
            c.manifest.provides.includes(capability) &&
            (!config.bindings?.[capability] ||
              config.bindings[capability] === c.manifest.id),
        );
        if (providers.length !== 1)
          fail(
            "ambiguous_capability",
            "Expected one provider for " + capability,
          );
        if (providers[0] !== candidate) targets.push(providers[0]!.manifest.id);
      }
      result.set(candidate.manifest.id, [...new Set(targets)]);
    }
    const seen = new Set<string>(),
      visiting: string[] = [];
    const visit = (id: string) => {
      if (seen.has(id)) return;
      if (visiting.includes(id))
        fail(
          "dependency_cycle",
          "Dependency cycle: " + [...visiting, id].join(" -> "),
        );
      visiting.push(id);
      for (const next of result.get(id) ?? []) visit(next);
      visiting.pop();
      seen.add(id);
    };
    for (const id of chosen.keys()) visit(id);
    return result;
  }
  let attempts = 0;
  function solve(chosen: Map<string, Candidate>): Map<string, Candidate> {
    if (++attempts > 4096)
      fail(
        "dependency_resolution_limit",
        "Dependency search is too complex; narrow the catalog or add bindings",
      );
    const ranges = new Map<string, string[]>();
    for (const candidate of chosen.values())
      for (const [id, range] of Object.entries(
        candidate.manifest.dependencies ?? {},
      ))
        ranges.set(id, [...(ranges.get(id) ?? []), range]);
    const choose = (
      id: string,
      choices: Candidate[],
    ): Map<string, Candidate> => {
      if (disabled.has(id))
        fail(
          "disabled_dependency",
          "Enable the installed dependency explicitly: " + id,
        );
      choices = choices.filter((c) =>
        (ranges.get(id) ?? []).every((range) => satisfies(c, range)),
      );
      // Two different archives claiming the same ID/version must not be selected by path order.
      const hashes = new Map<string, string>();
      for (const c of choices) {
        const old = hashes.get(c.manifest.version);
        if (old && old !== c.sha256)
          fail(
            "ambiguous_package",
            "Different packages share " + id + "@" + c.manifest.version,
          );
        hashes.set(c.manifest.version, c.sha256);
      }
      choices.sort((a, b) =>
        semver.rcompare(a.manifest.version, b.manifest.version),
      );
      let error: unknown;
      for (const choice of choices) {
        try {
          return solve(new Map([...chosen, [id, choice]]));
        } catch (e) {
          error = e;
        }
      }
      if (error) throw error;
      return fail(
        "dependency_version",
        "No compatible local package for " +
          id +
          " " +
          (ranges.get(id) ?? []).join(" & "),
      );
    };
    for (const [id, required] of ranges) {
      const current = chosen.get(id);
      if (current) {
        if (!required.every((range) => satisfies(current, range)))
          fail(
            "dependency_version",
            "Installed/selected " +
              id +
              "@" +
              current.manifest.version +
              " does not satisfy " +
              required.join(" & "),
          );
      } else
        return choose(
          id,
          candidates.filter((c) => c.manifest.id === id && !existing.has(id)),
        );
    }
    for (const candidate of chosen.values()) {
      for (const capability of candidate.manifest.requires) {
        const binding = config.bindings?.[capability];
        const providers = [...chosen.values()].filter(
          (c) =>
            c.manifest.provides.includes(capability) &&
            (!binding || c.manifest.id === binding),
        );
        if (providers.length > 1)
          fail(
            "ambiguous_capability",
            "Choose a provider with bindings for " + capability,
          );
        if (providers.length === 1) continue;
        const available = candidates.filter(
          (c) =>
            c.manifest.provides.includes(capability) &&
            !chosen.has(c.manifest.id) &&
            (!binding || c.manifest.id === binding),
        );
        const ids = [...new Set(available.map((c) => c.manifest.id))];
        if (ids.length > 1)
          fail(
            "ambiguous_capability",
            "Multiple local providers for " +
              capability +
              ": " +
              ids.join(", ") +
              "; configure bindings",
          );
        if (ids.length === 0) {
          const stopped = [...existing.values()].find(
            (c) =>
              disabled.has(c.manifest.id) &&
              c.manifest.provides.includes(capability) &&
              (!binding || binding === c.manifest.id),
          );
          if (stopped)
            fail(
              "disabled_dependency",
              "Enable the installed dependency explicitly: " +
                stopped.manifest.id,
            );
          fail("missing_dependency", "No local provider for " + capability);
        }
        return choose(
          ids[0]!,
          available.filter((c) => !existing.has(c.manifest.id)),
        );
      }
    }
    edges(chosen);
    return chosen;
  }
  const chosen = solve(selected);
  const dependencyEdges = edges(chosen);
  const closure: Candidate[] = [],
    seen = new Set<string>();
  const collect = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const next of dependencyEdges.get(id) ?? []) collect(next);
    closure.push(chosen.get(id)!);
  };
  collect(root.manifest.id);
  for (const candidate of chosen.values())
    if (!candidate.installed) collect(candidate.manifest.id);
  const plugins: InstallPlan["plugins"] = closure.map((c) => ({
    id: c.manifest.id,
    name: c.manifest.name ?? c.manifest.id,
    version: c.manifest.version,
    sha256: c.sha256,
    action: c.installed ? "keep" : "install",
    permissions: c.manifest.permissions,
    dependencies: dependencyEdges.get(c.manifest.id) ?? [],
  }));
  const plan: InstallPlan = {
    root: root.manifest.id,
    plugins,
    fingerprint: hash({
      config,
      plugins,
      configDraft: options.config,
      dependencyConfigs: options.dependencyConfigs,
    }),
  };
  if (options.expectedPlan && plan.fingerprint !== options.expectedPlan)
    fail(
      "install_plan_changed",
      "Packages or configuration changed; review the installation plan again",
    );
  return { plan, additions: closure.filter((c) => !c.installed) };
}

export async function planInstall(
  source: string,
  config: HostConfig,
  options: InstallOptions = {},
): Promise<InstallPlan> {
  const workspace = await mkdtemp(join(tmpdir(), "pluhub-plan-"));
  try {
    return (await resolveInstall(source, config, options, workspace)).plan;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

export async function installWithDependencies(
  source: string,
  root: string,
  config: HostConfig,
  options: InstallOptions,
  persist: (next: HostConfig) => Promise<void>,
  kernel?: Kernel,
) {
  await mkdir(root, { recursive: true });
  const workspace = await mkdtemp(join(root, ".resolve-"));
  let published: string | undefined;
  let persisted = false;
  try {
    const { plan, additions } = await resolveInstall(
      source,
      config,
      options,
      workspace,
    );
    const staged = join(workspace, "packages");
    const entries: PluginConfig[] = [];
    for (const candidate of additions) {
      const copy = await install(candidate.path, staged);
      if (copy.sha256 !== candidate.sha256)
        fail(
          "install_plan_changed",
          "Package changed during install: " + copy.id,
        );
      entries.push({
        path: copy.path,
        version: copy.version,
        integrity: copy.sha256,
        ...(options.origins?.[copy.id]
          ? { origin: options.origins[copy.id] }
          : {}),
        grants:
          copy.id === plan.root
            ? (options.grants ?? [])
            : (options.dependencyGrants?.[copy.id] ?? []),
        config:
          copy.id === plan.root
            ? (options.config ?? {})
            : (options.dependencyConfigs?.[copy.id] ?? {}),
      });
    }
    const prospective = new Kernel(
      config.dataDir,
      config.drainTimeoutMs,
      config.bindings,
    );
    for (const entry of [...config.plugins, ...entries])
      await prospective.add(entry.path, entry);
    prospective.validate(); // Full schema, grants, implementation ranges, bindings and cycles, without setup().
    const destination = join(
      root,
      "set-" + workspace.split(/[\\/]/).at(-1)!.slice(".resolve-".length),
    );
    if (await lstat(destination).catch(() => undefined))
      fail("plugin_exists", "Installation set already exists");
    await rename(staged, destination);
    published = destination;
    for (const entry of entries)
      entry.path = join(published, entry.path.split(/[\\/]/).at(-1)!);
    const next: HostConfig = {
      ...structuredClone(config),
      plugins: [...config.plugins, ...entries],
    };
    const commit = async () => {
      await persist(next);
      persisted = true;
    };
    if (kernel) await kernel.installBatch(entries, commit);
    else await commit();
    const entry = entries.find(
      (entry) =>
        entry.path.endsWith("/" + plan.root) ||
        entry.path.endsWith("\\" + plan.root),
    )!;
    return {
      id: plan.root,
      version: entry.version!,
      path: entry.path,
      sha256: entry.integrity!,
      plugins: plan.plugins,
      fingerprint: plan.fingerprint,
    };
  } catch (error) {
    if (persisted) {
      try {
        await persist(config);
      } catch {
        throw new HostError(
          "install_recovery_required",
          "Previous graph remains active, but config rollback failed; preserve installed packages for offline recovery",
          500,
        );
      }
    }
    if (published) await rm(published, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
