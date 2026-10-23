import Ajv from "ajv";
import hostSchema from "@pluhub/contracts/host-config.schema.json" with { type: "json" };
import {
  readFile,
  writeFile,
  mkdir,
  rename,
  rm,
  mkdtemp,
} from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { Kernel, validateManifest } from "@pluhub/kernel";
import { digest, install } from "./package.js";
import {
  installWithDependencies,
  planInstall,
  readInstallOptions,
} from "./dependencies.js";
import {
  HostError,
  readObject,
  requiredString,
  json,
  type HostConfig,
} from "@pluhub/sdk";
import { auditStore } from "./audit.js";
import { runtimeLogStore } from "./logs.js";
import { storageStatus } from "./storage-status.js";
import { setupHandler } from "./setup.js";
import { registryManagement } from "./registry-api.js";
import {
  pluginJobStore,
  backupPluginData,
  restorePluginData,
} from "./plugin-jobs.js";
import { fingerprint, registrySources } from "./registry.js";
import { uninstallPlugin } from "./uninstall.js";
export { uninstallPlugin } from "./uninstall.js";
export { recoverInterruptedPluginUpdate } from "./plugin-jobs.js";
export function validateConfig(value: unknown): asserts value is HostConfig {
  const valid = new Ajv.default().compile(hostSchema);
  if (!valid(value))
    throw new HostError("invalid_config", "Invalid host config");
  registrySources(value as unknown as HostConfig);
}
export async function readConfig(file: string): Promise<HostConfig> {
  const config = JSON.parse(await readFile(file, "utf8"));
  validateConfig(config);
  if (
    config.schemaVersion !== 1 ||
    typeof config.dataDir !== "string" ||
    !Array.isArray(config.plugins)
  )
    throw new HostError("invalid_config", "Invalid host config");
  for (const plugin of config.plugins)
    if (typeof plugin.path !== "string" || !Array.isArray(plugin.grants))
      throw new HostError("invalid_config", "Invalid plugin config");
  config.dataDir = resolve(dirname(file), config.dataDir);
  for (const plugin of config.plugins)
    plugin.path = resolve(dirname(file), plugin.path);
  if (config.pluginSources)
    config.pluginSources = config.pluginSources.map((source) =>
      resolve(dirname(file), source),
    );
  return config;
}
export async function writeConfig(file: string, value: unknown) {
  const temp = file + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temp, JSON.stringify(value, null, 2) + "\n", {
      mode: 0o600,
    });
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
export {
  digest,
  install,
  packPlugin,
  removeInstalledPackage,
} from "./package.js";
export {
  planInstall,
  installWithDependencies,
  type InstallPlan,
  type InstallOptions,
} from "./dependencies.js";
export async function createKernel(
  config: HostConfig,
  base = process.cwd(),
): Promise<Kernel> {
  validateConfig(config);
  const kernel = new Kernel(
    resolve(base, config.dataDir),
    config.drainTimeoutMs,
    config.bindings,
  );
  for (const p of config.plugins) {
    if (p.integrity && (await digest(resolve(base, p.path))) !== p.integrity)
      throw new HostError(
        "integrity_mismatch",
        "Installed plugin content changed",
      );
    await kernel.add(resolve(base, p.path), p);
  }
  return kernel;
}
export async function applyConfig(
  kernel: Kernel,
  current: HostConfig,
  next: HostConfig,
  validateOnly = false,
) {
  validateConfig(next);
  if (
    next.dataDir !== current.dataDir ||
    next.drainTimeoutMs !== current.drainTimeoutMs ||
    next.plugins.length !== current.plugins.length
  )
    throw new HostError(
      "restart_required",
      "Plugin set or data directory changed",
      409,
    );
  const configs: Record<string, Record<string, unknown>> = {};
  for (let i = 0; i < next.plugins.length; i++) {
    const a = current.plugins[i]!,
      b = next.plugins[i]!;
    if (
      a.path !== b.path ||
      a.integrity !== b.integrity ||
      a.version !== b.version ||
      a.enabled !== b.enabled ||
      JSON.stringify(a.grants) !== JSON.stringify(b.grants)
    )
      throw new HostError(
        "restart_required",
        "Plugin lifecycle or grants changed",
        409,
      );
    const manifest = validateManifest(
      JSON.parse(await readFile(resolve(b.path, "manifest.json"), "utf8")),
    );
    if (
      JSON.stringify(a.config) !== JSON.stringify(b.config) &&
      manifest.configReload !== "snapshot"
    )
      throw new HostError(
        "restart_required",
        "Plugin configuration requires restart",
        409,
      );
    configs[manifest.id] = b.config ?? {};
  }
  kernel.configure(configs, next.bindings ?? {}, validateOnly);
}
export { Kernel };

export function attachManagement(
  kernel: Kernel,
  file: string,
  initial: HostConfig,
  options: { restart?: () => Promise<void> } = {},
) {
  const audit = auditStore(kernel.dataDir, (value, limit) =>
    kernel.redactLogText(value, limit),
  );
  kernel.setAuditHandler(audit.write);
  const logs = runtimeLogStore(kernel.dataDir);
  kernel.setLogHandler(logs.write, logs.close, logs.start);
  let config = initial;
  let queue = Promise.resolve();
  const run = <T>(job: () => Promise<T>): Promise<T> => {
    const result = queue.then(job);
    queue = result.then(
      () => {},
      () => {},
    );
    return result;
  };
  const commit = async (next: HostConfig) => {
    await applyConfig(kernel, config, next, true);
    await writeConfig(file, next);
    try {
      await applyConfig(kernel, config, next);
    } catch (error) {
      await writeConfig(file, config);
      throw error;
    }
    config = next;
  };
  const setup = setupHandler(kernel, () => config, commit);
  const registry = registryManagement(
    kernel,
    file,
    () => config,
    async (next) => {
      validateConfig(next);
      await writeConfig(file, next);
      config = next;
    },
    options.restart,
  );
  kernel.setManagementHandler(async (request, context) =>
    run(async () => {
      const path = new URL(request.url).pathname;
      if (
        ["/api/host/plugin-state", "/api/host/plugin-uninstall"].includes(
          path,
        ) &&
        request.method === "POST"
      ) {
        if (
          !context.principal?.session ||
          !context.principal.permissions.includes("*")
        )
          throw new HostError(
            "forbidden",
            "Administrator session required",
            403,
          );
        if (
          kernel
            .list()
            .some(
              (plugin) =>
                plugin.state === "Active" &&
                plugin.manifest.provides.includes("auth.admin@1"),
            )
        ) {
          const token = /(?:^|;\s*)pluhub_session=([a-zA-Z0-9_-]+)/.exec(
            request.headers.get("cookie") ?? "",
          )?.[1];
          await kernel.invoke(
            "auth.admin@1",
            { userId: context.principal.id, token },
            context.signal,
          );
        }
      }
      if (
        path.startsWith("/api/host/registry") ||
        path.startsWith("/api/host/plugin-update")
      )
        return registry(request, context);
      if (path === "/api/host/setup") return setup(request);
      if (path === "/api/host/logs" && request.method === "GET") {
        if (
          !context.principal?.session ||
          !context.principal.permissions.includes("*")
        )
          throw new HostError(
            "forbidden",
            "Administrator session required",
            403,
          );
        return json(logs.read(new URL(request.url).searchParams));
      }
      if (path === "/api/host/audit" && request.method === "GET")
        return Response.json(audit.read(new URL(request.url).searchParams), {
          headers: { "cache-control": "no-store" },
        });
      if (path === "/api/host/status" && request.method === "GET") {
        const plugins = kernel.list();
        const memory = process.memoryUsage();
        const failed = plugins.filter((p) => p.state === "Failed").length;
        const auditing = audit.status();
        const storage = storageStatus(kernel.dataDir);
        return json({
          time: new Date().toISOString(),
          status:
            failed ||
            !auditing.available ||
            auditing.writeFailures ||
            auditing.unresolved ||
            !storage.available ||
            storage.lowSpace
              ? "degraded"
              : "running",
          audit: auditing,
          storage,
          runtime: {
            name: process.versions.bun ? "Bun" : "Node.js",
            version: process.versions.bun ?? process.version,
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            uptimeSeconds: Math.floor(process.uptime()),
          },
          memory: {
            rss: memory.rss,
            heapUsed: memory.heapUsed,
            heapTotal: memory.heapTotal,
          },
          graphVersion: kernel.graphVersion,
          plugins: {
            total: plugins.length,
            active: plugins.filter((p) => p.state === "Active").length,
            failed,
            stopped: plugins.filter((p) => p.state === "Stopped").length,
          },
        });
      }
      if (path === "/api/host/config" && request.method === "GET")
        return json(config);
      if (path === "/api/host/config" && request.method === "PUT") {
        const next = await readObject<HostConfig>(request);
        await commit(next);
        return json({ ok: true, graphVersion: kernel.graphVersion });
      }
      if (path === "/api/host/plugin-state" && request.method === "POST") {
        const body = await readObject(request);
        if (typeof body.enabled !== "boolean")
          throw new HostError("invalid_request", "enabled must be a boolean");
        context.state.set("admin.resourceId", body.id);
        const plugin = kernel.list().find((p) => p.id === body.id);
        if (!plugin)
          throw new HostError("unknown_plugin", "Unknown plugin", 404);
        if (!body.enabled) kernel.assertRemovable(plugin.id);
        let found = -1;
        for (let i = 0; i < config.plugins.length; i++) {
          const m = validateManifest(
            JSON.parse(
              await readFile(
                resolve(config.plugins[i]!.path, "manifest.json"),
                "utf8",
              ),
            ),
          );
          if (m.id === body.id) {
            found = i;
            break;
          }
        }
        if (found < 0)
          throw new HostError(
            "unknown_plugin",
            "Plugin is not in the persisted configuration",
            404,
          );
        const next = structuredClone(config);
        next.plugins[found]!.enabled = body.enabled;
        const persist = async () => {
          await writeConfig(file, next);
          config = next;
        };
        if (body.enabled) await kernel.enable(body.id, persist);
        else await kernel.stop(body.id, persist);
        return json({ ok: true });
      }
      if (path === "/api/host/plugin-uninstall" && request.method === "POST") {
        const body = await readObject(request),
          id = requiredString(body.id, "id");
        if (typeof body.purgeData !== "boolean")
          throw new HostError("invalid_request", "purgeData must be a boolean");
        context.state.set("admin.resourceId", id);
        return json(
          await uninstallPlugin(
            kernel,
            file,
            config,
            id,
            body.purgeData,
            async (next) => {
              await writeConfig(file, next);
              config = next;
            },
          ),
        );
      }
      if (path === "/api/host/update" && request.method === "POST") {
        const body = await readObject(request),
          id = requiredString(body.id, "id"),
          source = requiredString(body.path, "path", 2048),
          revision = requiredString(body.revision, "revision"),
          reason = requiredString(body.reason, "reason", 256);
        context.state.set("admin.resourceId", id);
        context.state.set("admin.reason", reason);
        const current = kernel.list().find((p) => p.id === id);
        if (!current) throw new HostError("unknown_plugin", "插件不存在", 404);
        if (current.codeReload !== "parallel" || current.state !== "Active")
          throw new HostError(
            "restart_required",
            "该插件需要通过维护流程重启升级",
            409,
          );
        if (current.revision !== revision)
          throw new HostError(
            "update_conflict",
            "插件版本已变化，请刷新后重试",
            409,
          );
        if (
          kernel
            .list()
            .some(
              (p) =>
                p.state === "Active" &&
                p.manifest.provides.includes("auth.admin@1"),
            )
        ) {
          const token = /(?:^|;\s*)pluhub_session=([a-zA-Z0-9_-]+)/.exec(
            request.headers.get("cookie") ?? "",
          )?.[1];
          await kernel.invoke("auth.admin@1", {
            userId: context.principal?.id,
            token,
          });
        }
        const index = config.plugins.findIndex(
          (p) => resolve(p.path) === current.path,
        );
        if (index < 0)
          throw new HostError("unknown_plugin", "插件不在已保存配置中", 409);
        const releases = resolve(dirname(file), ".pluhub/plugin-releases");
        await mkdir(releases, { recursive: true });
        const stage = await mkdtemp(resolve(releases, id + "-"));
        let persisted = false;
        try {
          const installed = await install(source, stage);
          if (installed.id !== id)
            throw new HostError(
              "invalid_update",
              "更新包的插件 ID 不匹配",
              409,
            );
          const next = structuredClone(config);
          next.plugins[index] = {
            ...next.plugins[index]!,
            path: installed.path,
            integrity: installed.sha256,
            version: installed.version,
          };
          const result = await kernel.replace(
            id,
            installed.path,
            next.plugins[index]!,
            async () => {
              await writeConfig(file, next);
              persisted = true;
            },
          );
          config = next;
          return json({ ok: true, ...result });
        } catch (error) {
          if (persisted) {
            try {
              await writeConfig(file, config);
            } catch {
              throw new HostError(
                "update_recovery_required",
                "旧实例继续运行，但配置回滚失败。已保留更新包，请通过本地维护恢复配置",
                500,
              );
            }
          }
          await rm(stage, { recursive: true, force: true });
          throw error;
        }
      }
      if (
        (path === "/api/host/install" || path === "/api/host/install-plan") &&
        request.method === "POST"
      ) {
        const body = await readObject(request);
        const source = requiredString(body.path, "path", 2048);
        const options = readInstallOptions(body);
        if (path === "/api/host/install-plan")
          return json(await planInstall(source, config, options));
        const old = config;
        const installed = await installWithDependencies(
          source,
          resolve(dirname(file), ".pluhub/plugins"),
          old,
          options,
          async (next) => {
            await writeConfig(file, next);
            config = next;
          },
          kernel,
        );
        context.state.set("admin.resourceId", installed.id);
        return json(installed, 201);
      }
      return json({ error: { code: "not_found", message: "Not found" } }, 404);
    }),
  );
  return {
    reload: () =>
      run(async () => {
        const next = await readConfig(file);
        await applyConfig(kernel, config, next);
        config = next;
      }),
  };
}

export async function applyPendingPluginUpdate(
  previous: Kernel,
  file: string,
  options: { restart?: () => Promise<void> } = {},
) {
  const jobs = pluginJobStore(file),
    job = await jobs.read();
  if (!job || !["pending", "scheduled"].includes(job.state))
    throw new HostError("update_pending", "No applicable plugin update", 409);
  const before = await readConfig(file);
  if (fingerprint(before) !== job.beforeHash)
    throw new HostError("update_conflict", "Host configuration changed", 409);
  const checked = await createKernel(job.next);
  checked.validate();
  job.state = "applying";
  await jobs.write(job);
  let backup: string | undefined, candidate: Kernel | undefined;
  try {
    await previous.shutdown();
    backup = await backupPluginData(file, job);
    await writeConfig(file, job.next);
    candidate = await createKernel(job.next);
    const management = attachManagement(candidate, file, job.next, options);
    await candidate.start();
    job.state = "applied";
    await jobs.write(job);
    return { kernel: candidate, management };
  } catch (error) {
    await candidate?.shutdown().catch(() => {});
    try {
      if (backup) await restorePluginData(job, backup);
      await writeConfig(file, job.before);
      const kernel = await createKernel(job.before),
        management = attachManagement(kernel, file, job.before, options);
      await kernel.start();
      job.state = "failed";
      job.errorCode =
        error instanceof HostError ? error.code : "plugin_startup_failed";
      await jobs.write(job);
      return { kernel, management };
    } catch {
      job.state = "applying";
      await jobs.write(job).catch(() => {});
      throw new HostError(
        "update_recovery_required",
        "Restart the host to recover the interrupted update",
        500,
      );
    }
  }
}
