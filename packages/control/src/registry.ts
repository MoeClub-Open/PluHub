import {
  readFile,
  writeFile,
  mkdir,
  mkdtemp,
  rename,
  rm,
  stat,
  readdir,
  utimes,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import semver from "semver";
import { HostError, json, type HostConfig, type Manifest } from "@pluhub/sdk";
import { validateManifest } from "@pluhub/kernel";
import { install, digest } from "./package.js";
import { planInstall, type InstallOptions } from "./dependencies.js";
import { fetchRegistryBytes } from "./registry-fetch.js";
export type RegistrySource = NonNullable<
  HostConfig["pluginRegistries"]
>[number];
type Entry = { manifest: Manifest; archive: string; sha256: string };
type Candidate = Entry & { source: RegistrySource; builtin: boolean };
export const canonical = (value: any): string => {
  const normalized = (v: any): any =>
    v && typeof v === "object"
      ? Array.isArray(v)
        ? v.map(normalized)
        : Object.fromEntries(
            Object.keys(v)
              .sort()
              .filter((k) => v[k] !== undefined)
              .map((k) => [k, normalized(v[k])]),
          )
      : v;
  return JSON.stringify(normalized(value));
};
export const fingerprint = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
export function registrySources(config: HostConfig): RegistrySource[] {
  const ids = new Set<string>(["official"]);
  for (const source of config.pluginRegistries ?? []) {
    if (ids.has(source.id))
      throw new HostError(
        "registry_duplicate",
        "Duplicate or reserved registry ID",
      );
    ids.add(source.id);
    let url: URL;
    try {
      url = new URL(source.url);
    } catch {
      throw new HostError("registry_url", "Invalid registry URL");
    }
    if (
      url.username ||
      url.password ||
      url.hash ||
      !["http:", "https:"].includes(url.protocol)
    )
      throw new HostError("registry_url", "Invalid registry URL");
  }
  return [
    {
      id: "official",
      name: "PluHub",
      url: process.env.PLUHUB_OFFICIAL_REGISTRY_URL ?? "builtin:official",
    },
    ...(config.pluginRegistries ?? []),
  ];
}
export function registryService(
  cacheDirectory: string,
  catalogDirectory = resolve(process.env.PLUHUB_PLUGIN_CATALOG ?? "registry"),
) {
  async function pruneCache(protectedHashes: Set<string>) {
    const entries = await readdir(cacheDirectory, {
      withFileTypes: true,
    }).catch(() => []);
    let bytes = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
      const path = join(cacheDirectory, entry.name),
        info = await stat(join(path, "package.tgz")).catch(() => undefined);
      if (!info) continue;
      if (
        !protectedHashes.has(entry.name) &&
        info.mtimeMs < Date.now() - 7 * 86400000
      ) {
        await rm(path, { recursive: true, force: true });
        continue;
      }
      bytes += info.size;
    }
    if (bytes > 512 * 1024 * 1024)
      throw new HostError(
        "registry_cache_full",
        "Registry cache is full; remove unused cache while the host is stopped",
        409,
      );
  }
  async function catalog(source: RegistrySource): Promise<Candidate[]> {
    const builtin = source.url === "builtin:official";
    let bytes: Buffer;
    if (builtin) {
      try {
        bytes = await readFile(join(catalogDirectory, "index.json"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    } else
      bytes = await fetchRegistryBytes(
        new URL(source.url),
        2 * 1024 * 1024,
        source.allowPrivateNetwork,
      );
    if (bytes.length > 2 * 1024 * 1024)
      throw new HostError("registry_size", "Registry index is too large");
    let document: any;
    try {
      document = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new HostError("registry_schema", "Invalid registry JSON");
    }
    if (
      document.schemaVersion !== 1 ||
      !Array.isArray(document.plugins) ||
      document.plugins.length > 512
    )
      throw new HostError("registry_schema", "Invalid registry index");
    const seen = new Set<string>();
    return document.plugins.map((entry: Entry) => {
      if (
        !entry?.manifest ||
        !semver.valid(entry.manifest.version) ||
        !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(entry.manifest.id) ||
        !/^[a-f0-9]{64}$/.test(entry.sha256) ||
        typeof entry.archive !== "string" ||
        entry.archive.length > 2048 ||
        !Array.isArray(entry.manifest.provides) ||
        !Array.isArray(entry.manifest.requires)
      )
        throw new HostError("registry_schema", "Invalid registry package");
      const key = entry.manifest.id + "@" + entry.manifest.version;
      try {
        validateManifest(entry.manifest);
      } catch (error) {
        if (!(error instanceof HostError) || error.code !== "host_version")
          throw new HostError("registry_schema", "Invalid registry manifest");
      }
      if (seen.has(key))
        throw new HostError(
          "registry_duplicate",
          "Duplicate registry package version",
        );
      seen.add(key);
      if (builtin && !/^[a-z0-9.-]+\.tgz$/.test(entry.archive))
        throw new HostError("registry_schema", "Invalid bundled archive");
      return { ...entry, source, builtin };
    });
  }
  async function entries(config: HostConfig, strictId?: string) {
    const sources = registrySources(config).filter((s) => s.enabled !== false);
    const errors: { registryId: string; code: string }[] = [];
    const result = await Promise.all(
      sources.map(async (source) => {
        try {
          return { source, packages: await catalog(source) };
        } catch (error) {
          if (source.id === strictId) throw error;
          errors.push({
            registryId: source.id,
            code:
              error instanceof HostError ? error.code : "registry_unavailable",
          });
          return { source, packages: [] };
        }
      }),
    );
    return { packages: result.flatMap((row) => row.packages), errors };
  }
  async function materialize(candidate: Candidate) {
    validateManifest(candidate.manifest);
    const root = join(cacheDirectory, candidate.sha256),
      target = join(root, "installed", candidate.manifest.id);
    const cached = await stat(join(root, "package.tgz")).catch(() => undefined);
    if (cached) {
      const bytes = await readFile(join(root, "package.tgz"));
      if (
        createHash("sha256").update(bytes).digest("hex") !== candidate.sha256 ||
        (await digest(target)) !==
          (await readFile(join(root, "content.sha256"), "utf8"))
      )
        throw new HostError(
          "integrity_mismatch",
          "Cached registry package changed",
        );
      const manifest = JSON.parse(
        await readFile(join(target, "manifest.json"), "utf8"),
      );
      if (canonical(manifest) !== canonical(candidate.manifest))
        throw new HostError(
          "registry_manifest",
          "Package manifest differs from registry metadata",
        );
      await utimes(join(root, "package.tgz"), new Date(), new Date());
      return target;
    }
    await mkdir(cacheDirectory, { recursive: true });
    const stage = await mkdtemp(join(cacheDirectory, ".download-"));
    try {
      const bytes = candidate.builtin
        ? await readFile(join(catalogDirectory, "packages", candidate.archive))
        : await fetchRegistryBytes(
            new URL(candidate.archive, candidate.source.url),
            64 * 1024 * 1024,
            candidate.source.allowPrivateNetwork,
          );
      if (
        bytes.length > 64 * 1024 * 1024 ||
        createHash("sha256").update(bytes).digest("hex") !== candidate.sha256
      )
        throw new HostError(
          "integrity_mismatch",
          "Registry package SHA-256 mismatch",
        );
      await writeFile(join(stage, "package.tgz"), bytes, { mode: 0o600 });
      const installed = await install(
        join(stage, "package.tgz"),
        join(stage, "installed"),
      );
      const manifest = JSON.parse(
        await readFile(join(installed.path, "manifest.json"), "utf8"),
      );
      if (canonical(manifest) !== canonical(candidate.manifest))
        throw new HostError(
          "registry_manifest",
          "Package manifest differs from registry metadata",
        );
      await writeFile(join(stage, "content.sha256"), installed.sha256, {
        mode: 0o600,
      });
      await rename(stage, root);
      return target;
    } catch (error) {
      await rm(stage, { recursive: true, force: true });
      throw error;
    }
  }
  return {
    sources: registrySources,
    async list(config: HostConfig) {
      const result = await entries(config);
      return {
        plugins: result.packages
          .sort(
            (a, b) =>
              a.manifest.id.localeCompare(b.manifest.id) ||
              semver.rcompare(a.manifest.version, b.manifest.version),
          )
          .map(({ manifest, source, sha256 }) => {
            let compatible = true;
            try {
              validateManifest(manifest);
            } catch {
              compatible = false;
            }
            return {
              manifest,
              registryId: source.id,
              registryName: source.name,
              archiveSha256: sha256,
              compatible,
            };
          }),
        errors: result.errors,
      };
    },
    async prepare(
      config: HostConfig,
      input: {
        id: string;
        registryId: string;
        version: string;
        operation: "install" | "update";
      },
      options: InstallOptions = {},
    ) {
      const candidates = (await entries(config, input.registryId)).packages,
        root = candidates.find(
          (c) =>
            c.source.id === input.registryId &&
            c.manifest.id === input.id &&
            c.manifest.version === input.version,
        );
      if (!root)
        throw new HostError(
          "registry_not_found",
          "Registry package not found",
          404,
        );
      const installed = await Promise.all(
        config.plugins.map(async (p) => ({
          settings: p,
          manifest: JSON.parse(
            await readFile(join(p.path, "manifest.json"), "utf8"),
          ) as Manifest,
        })),
      );
      const previous = installed.find((row) => row.manifest.id === input.id);
      if (
        previous?.settings.integrity &&
        (await digest(previous.settings.path)) !== previous.settings.integrity
      )
        throw new HostError(
          "integrity_mismatch",
          "Installed plugin content changed",
        );
      if (
        input.operation === "update" &&
        (!previous || !semver.gt(input.version, previous.manifest.version))
      )
        throw new HostError(
          "invalid_update",
          "Choose a newer installed plugin version",
          409,
        );
      if (input.operation === "install" && previous)
        throw new HostError(
          "duplicate_plugin",
          "Plugin is already installed",
          409,
        );
      const base = {
        ...config,
        plugins: config.plugins.filter((p) => p !== previous?.settings),
      };
      const available = installed.filter((row) => row !== previous),
        selected = new Map<string, Candidate>([
          [root.manifest.id + "@" + root.manifest.version, root],
        ]);
      const visited = new Set<string>();
      const addId = (id: string) => {
        if (available.some((row) => row.manifest.id === id)) return;
        const matches = candidates.filter((c) => c.manifest.id === id);
        const source = matches[0]?.source.id;
        for (const match of matches.filter((c) => c.source.id === source))
          selected.set(match.manifest.id + "@" + match.manifest.version, match);
      };
      while ([...selected.keys()].some((key) => !visited.has(key))) {
        if (selected.size > 32)
          throw new HostError(
            "registry_limit",
            "Dependency closure exceeds 32 package versions",
          );
        for (const [key, candidate] of selected) {
          if (visited.has(key)) continue;
          visited.add(key);
          validateManifest(candidate.manifest);
          for (const id of Object.keys(candidate.manifest.dependencies ?? {}))
            addId(id);
          for (const cap of candidate.manifest.requires) {
            if (
              available.some(
                (row) =>
                  row.settings.enabled !== false &&
                  row.manifest.provides.includes(cap),
              ) ||
              [...selected.values()].some((c) =>
                c.manifest.provides.includes(cap),
              )
            )
              continue;
            const providers = [
              ...new Set(
                candidates
                  .filter(
                    (c) =>
                      c.manifest.provides.includes(cap) &&
                      (!config.bindings?.[cap] ||
                        c.manifest.id === config.bindings[cap]),
                  )
                  .map((c) => c.manifest.id),
              ),
            ];
            if (providers.length > 1)
              throw new HostError(
                "ambiguous_capability",
                "Choose a capability provider in bindings",
                409,
              );
            if (providers[0]) addId(providers[0]);
          }
        }
      }
      await pruneCache(new Set([...selected.values()].map((c) => c.sha256)));
      const paths = [];
      let total = 0;
      for (const candidate of selected.values()) {
        const path = await materialize(candidate);
        total += (
          await stat(join(cacheDirectory, candidate.sha256, "package.tgz"))
        ).size;
        if (total > 256 * 1024 * 1024)
          throw new HostError(
            "registry_limit",
            "Dependency downloads exceed 256 MiB",
          );
        paths.push(path);
      }
      const source = paths[0]!,
        installOptions = {
          ...options,
          isolatedSources: true,
          sources: paths,
          config: previous?.settings.config ?? options.config,
        };
      const plan = await planInstall(source, base, installOptions);
      const origins = Object.fromEntries(
        plan.plugins
          .filter((p) => p.action === "install")
          .map((p) => {
            const origin = [...selected.values()].find(
              (c) => c.manifest.id === p.id && c.manifest.version === p.version,
            )!;
            return [
              p.id,
              {
                registryId: origin.source.id,
                version: p.version,
                archiveSha256: origin.sha256,
              },
            ];
          }),
      );
      return { plan, source, base, options: installOptions, origins, previous };
    },
    async publish(request: Request): Promise<Response | undefined> {
      const path = new URL(request.url).pathname;
      if (!path.startsWith("/registry/v1/")) return undefined;
      if (!["GET", "HEAD"].includes(request.method))
        return new Response(null, {
          status: 405,
          headers: { allow: "GET, HEAD" },
        });
      if (path === "/registry/v1/index.json") {
        const rows = await catalog({
          id: "official",
          name: "PluHub",
          url: "builtin:official",
        });
        const response = json({
          schemaVersion: 1,
          plugins: rows.map(({ manifest, archive, sha256 }) => ({
            manifest,
            archive: "packages/" + archive,
            sha256,
          })),
        });
        response.headers.set("cache-control", "no-cache");
        return request.method === "HEAD"
          ? new Response(null, { headers: response.headers })
          : response;
      }
      const match = /^\/registry\/v1\/packages\/([a-z0-9.-]+\.tgz)$/.exec(path);
      if (!match) return new Response(null, { status: 404 });
      const rows = await catalog({
        id: "official",
        name: "PluHub",
        url: "builtin:official",
      });
      const entry = rows.find((row) => row.archive === match[1]);
      if (!entry) return new Response(null, { status: 404 });
      const file = join(catalogDirectory, "packages", entry.archive),
        info = await stat(file);
      return new Response(
        request.method === "HEAD"
          ? null
          : (Readable.toWeb(createReadStream(file)) as ReadableStream),
        {
          headers: {
            "content-type": "application/gzip",
            "content-length": String(info.size),
            "cache-control": "public,max-age=31536000,immutable",
            etag: '"' + entry.sha256 + '"',
          },
        },
      );
    },
  };
}
