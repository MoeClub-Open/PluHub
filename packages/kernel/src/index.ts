import { readFile, mkdir, realpath } from "node:fs/promises";
import { resolve, relative, isAbsolute, sep, dirname } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import Ajv from "ajv";
import semver from "semver";
import schema from "@pluhub/contracts/manifest.schema.json" with { type: "json" };
import { HOST_VERSION, type PluginConfig } from "@pluhub/contracts";
import {
  HostError,
  json,
  type Manifest,
  type Host,
  type PluginState,
  type ApiRoute,
  type Hook,
  type Principal,
  type RequestContext,
  type Handler,
} from "@pluhub/sdk";
import { loadNative, loadProcess, type LoadedRuntime } from "@pluhub/runtime";
import { compileGraph, type CompiledGraph } from "@pluhub/engine";
import { createLogSanitizer, newLog, type RuntimeLog } from "./logging.js";
export type { RuntimeLog, LogLevel } from "./logging.js";
export { createLogSanitizer } from "./logging.js";
import {
  extensions,
  serveAsset,
  slotContributions,
} from "@pluhub/frontend-host";
const ajv = new Ajv.default({ allErrors: true });
const manifestValidator = ajv.compile(schema);
export function validateManifest(value: unknown): Manifest {
  if (!manifestValidator(value))
    throw new HostError(
      "invalid_manifest",
      ajv.errorsText(manifestValidator.errors),
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
const frozen = <T>(value: T): T => {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const v of Object.values(value)) frozen(v);
  }
  return value;
};
type Capability = (input: any, signal: AbortSignal) => any;
type UpgradeRoute = {
  owner: string;
  path: string;
  access: string;
  handler: (
    request: Request,
    ctx: RequestContext,
  ) => Promise<{ url: string; headers?: Record<string, string> }>;
};
type OwnedRoute = ApiRoute & { owner: string };
interface RecordData {
  manifest: Manifest;
  revision: string;
  path: string;
  settings: PluginConfig;
  state: PluginState;
  inflight: Set<AbortController>;
  checks: ((config: Record<string, unknown>) => void)[];
  provided: Map<string, Capability>;
  routes: OwnedRoute[];
  upgrades: UpgradeRoute[];
  hooks: Hook[];
  cleanups: (() => void | Promise<void>)[];
  identity?: (request: Request) => Promise<Principal | undefined>;
  runtime?: LoadedRuntime;
}
interface Snapshot {
  bindings: Readonly<Record<string, string>>;
  version: number;
  records: RecordData[];
  routes: OwnedRoute[];
  upgrades: UpgradeRoute[];
  configs: Map<string, Record<string, unknown>>;
  pipeline: CompiledGraph;
  refs: number;
  abort: AbortController;
}
interface Scope {
  snapshot: Snapshot;
  context: RequestContext;
}
export interface AdminAudit {
  id: string;
  createdAt: number;
  actorId: string;
  method: string;
  path: string;
  userId?: string;
  resourceId?: string;
  status?: number;
  errorCode?: string;
  reason?: string;
}
export class Kernel {
  private records = new Map<string, RecordData>();
  private seq = 0;
  private snapshots = new Set<Snapshot>();
  private current: Snapshot;
  private storage = new AsyncLocalStorage<Scope>();
  private events = new EventEmitter();
  private bindings: Record<string, string>;
  private closing = false;
  private starting = false;
  private pipelineContexts = new WeakSet<RequestContext>();
  private management?: Handler;
  private publicAssetHandler?: (
    request: Request,
  ) => Promise<Response | undefined>;
  private audit?: (entry: AdminAudit) => void;
  private sanitizer = createLogSanitizer();
  private logHandler?: (entry: RuntimeLog) => void;
  private logCleanup?: () => void;
  private logStart?: () => void;
  private loggedRequests = new WeakSet<RequestContext>();
  private retiring = new Map<RecordData, Promise<void>>();
  private replacing = false;
  constructor(
    readonly dataDir: string,
    readonly drainTimeoutMs = 30000,
    bindings: Record<string, string> = {},
  ) {
    this.bindings = { ...bindings };
    this.current = this.makeSnapshot([]);
  }
  setManagementHandler(handler: Handler) {
    this.management = handler;
  }
  setPublicAssetHandler(
    handler: (request: Request) => Promise<Response | undefined>,
  ) {
    this.publicAssetHandler = handler;
  }
  setAuditHandler(handler: (entry: AdminAudit) => void) {
    this.audit = handler;
  }
  redactLogText(value: unknown, limit = 2048) {
    return this.sanitizer.text(value, limit);
  }
  setLogHandler(
    handler: (entry: RuntimeLog) => void,
    cleanup?: () => void,
    start?: () => void,
  ) {
    this.logCleanup?.();
    this.logHandler = handler;
    this.logCleanup = cleanup;
    this.logStart = start;
  }
  private requestFields(context: RequestContext): Partial<RuntimeLog> {
    return {
      requestId: context.id,
      graphVersion: context.graphVersion,
      method: context.request.method,
      path: this.sanitizer.text(new URL(context.request.url).pathname, 512),
    };
  }
  private recordRequest(context: RequestContext) {
    if (this.loggedRequests.has(context)) return;
    this.loggedRequests.add(context);
    const path = new URL(context.request.url).pathname;
    if (
      path === "/" ||
      path === "/health" ||
      path === "/healthz" ||
      path === "/readyz" ||
      path === "/favicon.ico" ||
      path.startsWith("/extensions/") ||
      path === "/api/host/logs"
    )
      return;
    const cancelled =
      context.signal.aborted || context.state.get("http.cancelled") === true;
    const status = Number(context.state.get("http.status") ?? 500);
    const errorCode = context.state.get("http.errorCode");
    const code = cancelled
      ? "cancelled"
      : typeof errorCode === "string"
        ? this.sanitizer.text(errorCode, 128)
        : undefined;
    this.emitLog({
      ...newLog(
        "host",
        code || status >= 400
          ? status >= 500 || (!cancelled && code && status < 400)
            ? "error"
            : "warn"
          : "info",
        cancelled
          ? "Request cancelled"
          : code || status >= 400
            ? "Request failed"
            : "Request completed",
      ),
      ...this.requestFields(context),
      status,
      code,
      durationMs: Math.max(
        0,
        Date.now() - Number(context.state.get("log.startedAt")),
      ),
    });
  }
  private recordAdmin(
    context: RequestContext,
    status?: number,
    errorCode?: string,
  ) {
    const path = new URL(context.request.url).pathname;
    if (
      !this.audit ||
      !path.startsWith("/api/") ||
      ["GET", "HEAD", "OPTIONS"].includes(context.request.method) ||
      !context.principal?.session ||
      !context.principal.permissions.includes("*")
    )
      return;
    const safeId = (key: string) => {
      const value = context.state.get(key);
      return typeof value === "string" &&
        /^[a-zA-Z0-9:_.@/-]{1,256}$/.test(value)
        ? this.sanitizer.text(value, 256)
        : undefined;
    };
    const reason = context.state.get("admin.reason");
    this.audit({
      id: context.id,
      createdAt: Number(context.state.get("admin.startedAt") ?? Date.now()),
      actorId: this.sanitizer.text(context.principal.id, 256),
      method: context.request.method,
      path: this.sanitizer.text(path, 512),
      userId: safeId("admin.userId"),
      resourceId: safeId("admin.resourceId"),
      status,
      errorCode: errorCode ? this.sanitizer.text(errorCode, 64) : undefined,
      reason:
        typeof reason === "string"
          ? this.sanitizer.text(reason, 256)
          : undefined,
    });
  }
  remove(id: string) {
    const r = this.records.get(id);
    if (!r) return;
    this.assertRemovable(id);
    if (!["Stopped", "Installed", "Failed"].includes(r.state))
      throw new HostError("plugin_active", "Stop plugin before removing", 409);
    this.records.delete(id);
    this.bindings = Object.fromEntries(
      Object.entries(this.bindings).filter(([, owner]) => owner !== id),
    );
    this.publish();
  }
  lifecycle(id: string) {
    const r = this.records.get(id);
    if (!r) throw new HostError("unknown_plugin", "Unknown plugin", 404);
    const protectedPlugin =
      r.manifest.category === "core" ||
      r.manifest.permissions.includes("identity.provide");
    const dependents = [...this.records.values()]
      .filter(
        (other) =>
          other !== r &&
          other.settings.enabled !== false &&
          (Object.hasOwn(other.manifest.dependencies ?? {}, id) ||
            other.manifest.requires.some(
              (capability) =>
                r.manifest.provides.includes(capability) &&
                (!this.bindings[capability] ||
                  this.bindings[capability] === id),
            )),
      )
      .map((other) => ({
        id: other.manifest.id,
        name: other.manifest.name ?? other.manifest.id,
      }));
    return { protected: protectedPlugin, dependents };
  }
  assertRemovable(id: string) {
    const policy = this.lifecycle(id);
    if (policy.protected)
      throw new HostError(
        "protected_plugin",
        "Infrastructure plugins cannot be disabled or uninstalled",
        409,
      );
    if (policy.dependents.length)
      throw new HostError(
        "plugin_required",
        "Required by enabled plugins: " +
          policy.dependents.map((p) => p.name).join(", "),
        409,
      );
    if ([...this.retiring.keys()].some((record) => record.manifest.id === id))
      throw new HostError(
        "update_draining",
        "Previous plugin version is still draining",
        409,
      );
  }
  validate() {
    this.ordered();
  }
  get graphVersion() {
    return this.current.version;
  }
  list() {
    return [...this.records.values()].map((r) => ({
      id: r.manifest.id,
      name: r.manifest.name ?? r.manifest.ui?.title ?? r.manifest.id,
      description: r.manifest.description ?? "",
      revision: r.revision,
      codeReload: this.canReplace(r) ? "parallel" : "restart",
      version: r.manifest.version,
      path: r.path,
      state: r.state,
      enabled: r.settings.enabled !== false,
      lifecycle: this.lifecycle(r.manifest.id),
      manifest: r.manifest,
      config: r.settings.config ?? {},
    }));
  }
  slots() {
    return this.current.records.flatMap((r) =>
      slotContributions(r.manifest).map((s) => ({
        ...s,
        url: s.url + "?v=" + r.revision,
      })),
    );
  }
  extensions() {
    return this.current.records.flatMap((r) =>
      extensions(r.manifest).map((e) => ({
        ...e,
        url: e.url + "?v=" + r.revision,
      })),
    );
  }
  async add(
    path: string,
    settings: Omit<PluginConfig, "path"> = { grants: [] },
  ): Promise<Manifest> {
    const record = await this.prepareRecord(path, settings);
    if (this.records.has(record.manifest.id))
      throw new HostError(
        "duplicate_plugin",
        "Duplicate plugin " + record.manifest.id,
      );
    this.records.set(record.manifest.id, record);
    return record.manifest;
  }
  private async prepareRecord(
    path: string,
    settings: Omit<PluginConfig, "path">,
  ): Promise<RecordData> {
    const manifest = validateManifest(
      JSON.parse(await readFile(resolve(path, "manifest.json"), "utf8")),
    );
    if (settings.version && settings.version !== manifest.version)
      throw new HostError(
        "version_lock_mismatch",
        "Locked version differs for " + manifest.id,
      );
    if (manifest.platforms && !manifest.platforms.includes(process.platform))
      throw new HostError("platform", "Plugin does not support this platform");
    await safeEntry(path, manifest.runtime.entry);
    if (manifest.ui) {
      await safeEntry(path, manifest.ui.entry);
      for (const slot of manifest.ui.slots ?? []) {
        await safeEntry(path, slot.entry);
        if (dirname(slot.entry) !== dirname(manifest.ui.entry))
          throw new HostError(
            "invalid_ui",
            "Slot assets must share the UI bundle directory",
          );
      }
    }
    const config = structuredClone(settings.config ?? {});
    if (manifest.configSchema && !ajv.compile(manifest.configSchema)(config))
      throw new HostError(
        "invalid_config",
        "Invalid config for " + manifest.id,
      );
    for (const permission of manifest.permissions)
      if (
        !settings.grants.includes(permission) &&
        !settings.grants.includes("*")
      )
        throw new HostError(
          "permission_denied",
          "Permission not granted: " + permission,
          403,
        );
    return {
      manifest,
      revision: randomUUID(),
      path: resolve(path),
      settings: { ...settings, path: resolve(path), config: frozen(config) },
      state: "Installed",
      inflight: new Set(),
      checks: [],
      provided: new Map(),
      routes: [],
      upgrades: [],
      hooks: [],
      cleanups: [],
    };
  }
  private canReplace(r: RecordData) {
    return (
      r.manifest.codeReload === "parallel" &&
      !r.manifest.provides.includes("listener.address@1") &&
      !r.manifest.permissions.includes("http.listen") &&
      !r.manifest.permissions.includes("identity.provide") &&
      r.manifest.ui?.path !== "/console"
    );
  }
  async replace(
    id: string,
    path: string,
    settings: Omit<PluginConfig, "path">,
    persist: () => Promise<void> = async () => {},
  ) {
    if (this.replacing || this.closing)
      throw new HostError(
        "update_conflict",
        "宿主正在更新或停止，请稍后重试",
        409,
      );
    this.replacing = true;
    try {
      return await this.replaceRecord(id, path, settings, persist);
    } finally {
      this.replacing = false;
    }
  }
  private async replaceRecord(
    id: string,
    path: string,
    settings: Omit<PluginConfig, "path">,
    persist: () => Promise<void> = async () => {},
  ) {
    const old = this.records.get(id);
    if (!old) throw new HostError("unknown_plugin", "Unknown plugin", 404);
    if (old.state !== "Active" || !this.canReplace(old))
      throw new HostError(
        "restart_required",
        "该插件需要通过维护流程重启升级",
        409,
      );
    if (this.retiring.size)
      throw new HostError(
        "update_draining",
        "前一次插件更新仍在排空，请稍后重试",
        409,
      );
    const next = await this.prepareRecord(path, settings);
    if (next.manifest.id !== id || !this.canReplace(next))
      throw new HostError(
        "invalid_update",
        "更新包 ID 或在线更新声明不匹配",
        409,
      );
    if (
      JSON.stringify([...next.manifest.provides].sort()) !==
      JSON.stringify([...old.manifest.provides].sort())
    )
      throw new HostError(
        "invalid_update",
        "在线更新必须保持对外能力契约不变",
        409,
      );
    if (resolve(path) === old.path)
      throw new HostError("invalid_update", "更新必须使用独立的版本目录", 409);
    try {
      this.records.set(id, next);
      try {
        this.ordered();
      } finally {
        this.records.set(id, old);
      }
      await this.storage.exit(() => this.startRecord(next));
      // Validate the complete prospective graph while current requests keep the old snapshot.
      this.records.set(id, next);
      try {
        this.checkConfigs();
        this.makeSnapshot(
          [...this.records.values()].filter((r) => r.state === "Active"),
        );
      } finally {
        this.records.set(id, old);
      }
      await persist();
      if (
        this.closing ||
        this.records.get(id) !== old ||
        next.state !== "Active"
      )
        throw new HostError(
          "update_conflict",
          "宿主状态已变化，更新未生效",
          409,
        );
      this.records.set(id, next);
      try {
        this.publish();
      } catch (error) {
        this.records.set(id, old);
        throw error;
      }
    } catch (error) {
      await this.dispose(next).catch(() => {});
      throw error;
    }
    old.state = "Draining";
    const snapshots = [...this.snapshots].filter((s) =>
      s.records.includes(old),
    );
    // Do not wait inside the update request: its own snapshot also pins the old plugin.
    const retirement = this.storage.exit(async () => {
      await this.drain(snapshots, [old]);
      await this.dispose(old);
    });
    this.retiring.set(old, retirement);
    void retirement
      .catch((e) =>
        this.log(id, "error", "Retired plugin cleanup failed: " + e.message),
      )
      .finally(() => this.retiring.delete(old));
    return {
      id,
      version: next.manifest.version,
      revision: next.revision,
      graphVersion: this.graphVersion,
    };
  }
  private resolveCapability(
    name: string,
    records: RecordData[],
    bindings: Readonly<Record<string, string>> = this.bindings,
  ): RecordData {
    let providers = records.filter((r) => r.manifest.provides.includes(name));
    const binding = bindings[name];
    if (binding) providers = providers.filter((r) => r.manifest.id === binding);
    if (providers.length !== 1)
      throw new HostError(
        providers.length ? "ambiguous_capability" : "missing_capability",
        "Capability " + name + " requires exactly one provider",
      );
    return providers[0]!;
  }
  private ordered(): RecordData[] {
    const enabled = [...this.records.values()].filter(
      (r) => r.settings.enabled !== false,
    );
    const result: RecordData[] = [];
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (r: RecordData) => {
      if (visited.has(r.manifest.id)) return;
      if (visiting.has(r.manifest.id))
        throw new HostError("dependency_cycle", "Plugin dependency cycle");
      visiting.add(r.manifest.id);
      for (const [id, range] of Object.entries(r.manifest.dependencies ?? {})) {
        const dependency = enabled.find(
          (candidate) => candidate.manifest.id === id,
        );
        if (!dependency)
          throw new HostError(
            "missing_dependency",
            r.manifest.id + " requires plugin " + id,
          );
        if (
          !semver.satisfies(dependency.manifest.version, range, {
            includePrerelease: true,
          })
        )
          throw new HostError(
            "dependency_version",
            r.manifest.id +
              " requires " +
              id +
              " " +
              range +
              "; installed " +
              dependency.manifest.version,
          );
        visit(dependency);
      }
      for (const name of r.manifest.requires) {
        const provider = this.resolveCapability(name, enabled);
        if (provider !== r) visit(provider);
      }
      visiting.delete(r.manifest.id);
      visited.add(r.manifest.id);
      result.push(r);
    };
    for (const r of enabled) visit(r);
    return result;
  }
  async start() {
    this.closing = false;
    this.logStart?.();
    const ordered = this.ordered();
    this.starting = true;
    try {
      for (const r of ordered) {
        if (r.state === "Active") continue;
        r.state = "Resolved";
        await this.startRecord(r);
      }
      this.publish();
    } catch (error) {
      for (const r of ordered.reverse()) await this.dispose(r).catch(() => {});
      throw error;
    } finally {
      this.starting = false;
    }
  }
  private async startRecord(r: RecordData) {
    r.state = "Starting";
    const host = this.host(r);
    await mkdir(host.dataDir, { recursive: true, mode: 0o700 });
    try {
      const entry = await safeEntry(r.path, r.manifest.runtime.entry);
      r.runtime =
        r.manifest.runtime.kind === "native"
          ? await loadNative(entry, host)
          : await loadProcess(entry, r.manifest, host, r.path, (error) => {
              r.state = "Failed";
              this.log(r.manifest.id, "error", error.message);
              if (this.records.get(r.manifest.id) !== r) return;
              try {
                this.publish(false);
              } catch {
                this.log(
                  r.manifest.id,
                  "warn",
                  "Previous graph retained after plugin failure",
                );
              }
            });
      for (const cap of r.manifest.provides)
        if (!r.provided.has(cap))
          throw new HostError(
            "missing_registration",
            "Plugin did not register " + cap,
          );
      r.state = "Ready";
      r.state = "Active";
      this.log(
        r.manifest.id,
        "info",
        "Plugin started (" + r.manifest.version + ")",
      );
    } catch (error) {
      this.log(
        r.manifest.id,
        "error",
        "Plugin startup failed: " +
          (error instanceof Error ? error.message : String(error)),
      );
      r.state = "Failed";
      await this.dispose(r).catch(() => {});
      r.state = "Failed";
      throw error;
    }
  }
  private makeSnapshot(records: RecordData[]): Snapshot {
    const routes = records.flatMap((r) => r.routes);
    const upgrades = records.flatMap((r) => r.upgrades);
    const paths = new Set<string>();
    for (const route of routes) {
      const key = route.method.toUpperCase() + " " + route.path;
      if (paths.has(key))
        throw new HostError("route_conflict", "Duplicate route " + key);
      paths.add(key);
    }
    if (records.filter((r) => r.identity).length > 1)
      throw new HostError("identity_conflict", "Multiple identity providers");
    const version = ++this.seq;
    return {
      version,
      bindings: Object.freeze({ ...this.bindings }),
      records: [...records],
      routes,
      upgrades,
      configs: new Map(
        records.map((r) => [
          r.manifest.id,
          frozen(structuredClone(r.settings.config ?? {})),
        ]),
      ),
      pipeline: compileGraph(
        version,
        records.flatMap((r) => r.hooks),
      ),
      refs: 0,
      abort: new AbortController(),
    };
  }
  private publish(validate = true) {
    if (validate) this.checkConfigs();
    const next = this.makeSnapshot(
      [...this.records.values()].filter((r) => r.state === "Active"),
    );
    this.current = next;
    this.snapshots.add(next);
    for (const s of this.snapshots)
      if (s !== next && s.refs === 0) this.snapshots.delete(s);
  }
  private checkConfigs() {
    this.storage.exit(() => {
      for (const r of this.records.values())
        if (r.state === "Active")
          for (const check of r.checks) check(r.settings.config ?? {});
    });
  }
  configure(
    configs: Record<string, Record<string, unknown>>,
    bindings = this.bindings,
    validateOnly = false,
  ) {
    for (const [id, config] of Object.entries(configs)) {
      const r = this.records.get(id);
      if (!r) throw new HostError("unknown_plugin", "Unknown plugin " + id);
      if (
        r.manifest.configSchema &&
        !ajv.compile(r.manifest.configSchema)(config)
      )
        throw new HostError("invalid_config", "Invalid config for " + id);
    }
    const oldBindings = this.bindings;
    const previous = new Map(
      [...this.records].map(([id, r]) => [id, r.settings.config]),
    );
    try {
      this.bindings = { ...bindings };
      for (const [id, config] of Object.entries(configs))
        this.records.get(id)!.settings.config = frozen(structuredClone(config));
      this.ordered();
      this.checkConfigs();
      if (validateOnly) {
        this.makeSnapshot(
          [...this.records.values()].filter((r) => r.state === "Active"),
        );
        this.bindings = oldBindings;
        for (const [id, config] of previous)
          this.records.get(id)!.settings.config = config;
      } else this.publish();
    } catch (error) {
      this.bindings = oldBindings;
      for (const [id, config] of previous)
        this.records.get(id)!.settings.config = config;
      throw error;
    }
  }
  private async dispose(r: RecordData) {
    const wasRunning = !!r.runtime;
    await r.runtime?.stop().catch(() => {});
    for (const cleanup of r.cleanups.splice(0).reverse())
      try {
        await cleanup();
      } catch {
        this.log(r.manifest.id, "error", "Plugin cleanup failed");
      }
    r.runtime = undefined;
    r.checks = [];
    r.provided.clear();
    r.routes = [];
    r.upgrades = [];
    r.hooks = [];
    r.identity = undefined;
    r.state = "Stopped";
    if (wasRunning) this.log(r.manifest.id, "info", "Plugin stopped");
  }
  async stop(id: string, persist: () => Promise<void> = async () => {}) {
    const r = this.records.get(id);
    if (!r) throw new HostError("unknown_plugin", "Unknown plugin");
    this.assertRemovable(id);
    const previous = r.state;
    r.state = "Draining";
    try {
      this.checkConfigs();
      this.makeSnapshot(
        [...this.records.values()].filter(
          (record) => record.state === "Active",
        ),
      );
      await persist();
      this.publish(false);
    } catch (error) {
      r.state = previous;
      throw error;
    }
    await this.drain(
      [...this.snapshots].filter((s) => s.records.includes(r)),
      [r],
    );
    await this.dispose(r);
    r.settings.enabled = false;
  }
  async enable(id: string, persist: () => Promise<void> = async () => {}) {
    const r = this.records.get(id);
    if (!r) throw new HostError("unknown_plugin", "Unknown plugin");
    if (r.state === "Active") {
      await persist();
      return;
    }
    if (r.state === "Failed") await this.dispose(r);
    const previous = r.settings.enabled;
    r.settings.enabled = true;
    try {
      this.ordered();
      await this.startRecord(r);
      this.checkConfigs();
      this.makeSnapshot(
        [...this.records.values()].filter(
          (record) => record.state === "Active",
        ),
      );
      await persist();
      this.publish(false);
    } catch (error) {
      await this.dispose(r).catch(() => {});
      r.settings.enabled = previous;
      throw error;
    }
  }
  /** Activate one dependency closure with one graph publication; failures keep old instances running. */
  async installBatch(
    entries: PluginConfig[],
    persist: () => Promise<void> = async () => {},
  ) {
    if (this.replacing || this.closing)
      throw new HostError(
        "update_conflict",
        "Host is updating or stopping",
        409,
      );
    this.replacing = true;
    const added: RecordData[] = [];
    let ordered: RecordData[] = [];
    try {
      for (const entry of entries) {
        const record = await this.prepareRecord(entry.path, entry);
        if (this.records.has(record.manifest.id))
          throw new HostError(
            "duplicate_plugin",
            "Duplicate plugin " + record.manifest.id,
          );
        this.records.set(record.manifest.id, record);
        added.push(record);
      }
      ordered = this.ordered().filter((record) => added.includes(record));
      await this.storage.exit(async () => {
        for (const record of ordered) await this.startRecord(record);
        this.checkConfigs();
        this.makeSnapshot(
          [...this.records.values()].filter(
            (record) => record.state === "Active",
          ),
        );
        await persist();
        if (this.closing)
          throw new HostError("update_conflict", "Host is stopping", 409);
        this.publish();
      });
      return added.map((record) => ({
        id: record.manifest.id,
        version: record.manifest.version,
      }));
    } catch (error) {
      for (const record of [
        ...ordered,
        ...added.filter((record) => !ordered.includes(record)),
      ].reverse()) {
        await this.dispose(record).catch(() => {});
        this.records.delete(record.manifest.id);
      }
      throw error;
    } finally {
      this.replacing = false;
    }
  }
  async shutdown() {
    if (this.closing) return;
    this.log("host", "info", "Host draining");
    this.closing = true;
    const snapshots = [...this.snapshots];
    this.current = this.makeSnapshot([]);
    await this.drain(snapshots, [...this.records.values()]);
    for (const r of this.ordered().reverse()) await this.dispose(r);
    await Promise.allSettled([...this.retiring.values()]);
    this.log("host", "info", "Host stopped");
    this.logCleanup?.();
  }
  private async drain(snapshots: Snapshot[], records: RecordData[] = []) {
    const deadline = Date.now() + this.drainTimeoutMs;
    while (
      (snapshots.some((s) => s.refs > 0) ||
        records.some((r) => r.inflight.size > 0)) &&
      Date.now() < deadline
    )
      await new Promise((r) => setTimeout(r, 10));
    for (const s of snapshots)
      if (s.refs > 0) s.abort.abort(new Error("Drain deadline"));
    for (const record of records)
      for (const call of record.inflight)
        call.abort(new Error("Drain deadline"));
  }
  private require(r: RecordData, permission: string) {
    if (
      !r.manifest.permissions.includes(permission) ||
      (!r.settings.grants.includes(permission) &&
        !r.settings.grants.includes("*"))
    )
      throw new HostError(
        "permission_denied",
        "Host permission denied: " + permission,
        403,
      );
  }
  private host(r: RecordData): Host {
    const ensure = () => {
      if (
        !["Starting", "Ready", "Active"].includes(r.state) &&
        !(
          r.state === "Draining" &&
          this.storage.getStore()?.snapshot.records.includes(r)
        )
      )
        throw new HostError("plugin_unavailable", "Plugin is not active", 503);
    };
    return {
      id: r.manifest.id,
      dataDir: resolve(this.dataDir, r.manifest.id),
      config: <T extends Record<string, unknown>>() =>
        (this.storage.getStore()?.snapshot.configs.get(r.manifest.id) ??
          r.settings.config ??
          {}) as T,
      dispatch: (request) => {
        if (!r.manifest.permissions.includes("http.dispatch"))
          this.require(r, "http.listen");
        else this.require(r, "http.dispatch");
        ensure();
        return this.fetch(request);
      },
      acceptUpgrade: (request) => {
        this.require(r, "http.listen");
        ensure();
        return this.acceptUpgrade(request);
      },
      validateConfig: (check) => {
        ensure();
        r.checks.push(check);
      },
      hasCapability: (name) => {
        if (
          !r.manifest.requires.includes(name) &&
          !r.manifest.optionalRequires?.includes(name) &&
          !r.manifest.provides.includes(name)
        )
          throw new HostError(
            "permission_denied",
            "Undeclared capability dependency",
            403,
          );
        // External readiness checks must stop advertising new work during drain.
        // Existing requests retain their pinned snapshot and its capabilities.
        if (this.closing && !this.storage.getStore()) return false;
        // A listener can already accept probes while later plugins are starting.
        // Advertise readiness only after the complete execution graph is published.
        if (this.starting && r.manifest.permissions.includes("http.listen"))
          return false;
        const snapshot = this.storage.getStore()?.snapshot;
        return (
          this.storage.getStore()?.snapshot.records ?? [
            ...this.records.values(),
          ]
        ).some(
          (other) =>
            (other.state === "Active" ||
              (other.state === "Draining" &&
                snapshot?.records.includes(other))) &&
            other.provided.has(name),
        );
      },
      provide: (name, handler) => {
        ensure();
        if (!r.manifest.provides.includes(name) || r.provided.has(name))
          throw new HostError(
            "invalid_registration",
            "Undeclared or duplicate capability " + name,
          );
        r.provided.set(name, handler);
      },
      providers: (name) => {
        ensure();
        if (
          ![
            ...r.manifest.requires,
            ...(r.manifest.optionalRequires ?? []),
            ...r.manifest.provides,
          ].includes(name)
        )
          throw new HostError(
            "permission_denied",
            "Undeclared capability dependency",
            403,
          );
        const records =
          this.storage.getStore()?.snapshot.records ??
          [...this.records.values()].filter(
            (record) => record.state === "Active",
          );
        return records
          .filter(
            (record) => record.state !== "Failed" && record.provided.has(name),
          )
          .map(({ manifest }) => ({
            id: manifest.id,
            name: manifest.name ?? manifest.id,
            version: manifest.version,
          }));
      },
      call: async <T>(
        name: string,
        input?: unknown,
        signal?: AbortSignal,
        providerId?: string,
      ) => {
        ensure();
        if (
          !r.manifest.requires.includes(name) &&
          !r.manifest.optionalRequires?.includes(name) &&
          !r.manifest.provides.includes(name)
        )
          throw new HostError(
            "permission_denied",
            "Undeclared capability dependency",
            403,
          );
        return this.invoke<T>(name, input, signal, providerId);
      },
      api: (route) => {
        this.require(r, "api.register");
        ensure();
        if (!route.path.startsWith("/") || route.path.includes(".."))
          throw new HostError("invalid_route", "Invalid API path");
        r.routes.push({
          ...route,
          owner: r.manifest.id,
          path: "/api/plugins/" + r.manifest.id + route.path,
        });
      },
      route: (route) => {
        this.require(r, "http.route");
        ensure();
        if (
          !route.path.startsWith("/") ||
          ["/api/host", "/api/plugins", "/extensions"].some((p) =>
            route.path.startsWith(p),
          )
        )
          throw new HostError("invalid_route", "Reserved or invalid route");
        r.routes.push({ ...route, owner: r.manifest.id });
      },
      upgrade: (path, access, handler) => {
        this.require(r, "http.route");
        ensure();
        r.upgrades.push({ owner: r.manifest.id, path, access, handler });
      },
      hook: (hook) => {
        this.require(r, "hooks.register");
        ensure();
        r.hooks.push({
          ...hook,
          id: r.manifest.id + ":" + hook.id,
          before: hook.before,
          after: hook.after,
        });
      },
      identity: (resolver) => {
        this.require(r, "identity.provide");
        ensure();
        r.identity = resolver;
      },
      secret: (reference) => {
        this.require(r, "secrets.read");
        if (
          !reference.startsWith("env:") ||
          !/^env:[A-Z][A-Z0-9_]*$/.test(reference)
        )
          throw new HostError("invalid_secret", "Expected env:NAME reference");
        const allowed = ((
          this.storage.getStore()?.snapshot.configs.get(r.manifest.id) ??
          r.settings.config
        )?.secretRefs ?? []) as string[];
        if (!allowed.includes(reference))
          throw new HostError(
            "permission_denied",
            "Secret reference not granted",
            403,
          );
        const value = process.env[reference.slice(4)];
        if (!value)
          throw new HostError(
            "secret_missing",
            "Configured secret is unavailable",
            503,
          );
        this.sanitizer.register(value);
        return value;
      },
      log: (level, message) => this.log(r.manifest.id, level, message),
      cleanup: (fn) => r.cleanups.push(fn),
      publish: (event, data) => {
        this.require(r, "events.publish");
        this.events.emit(event, data);
      },
      subscribe: (event, handler) => {
        this.require(r, "events.subscribe");
        this.events.on(event, handler);
        r.cleanups.push(() => {
          this.events.off(event, handler);
        });
      },
    };
  }
  private log(plugin: string, level: string, message: string) {
    const context = this.storage.getStore()?.context;
    this.emitLog({
      ...newLog(plugin, level, this.sanitizer.text(message)),
      ...(context ? this.requestFields(context) : {}),
    });
  }
  private emitLog(entry: RuntimeLog) {
    // A broken log sink must not fail a request or recursively log its own failure.
    try {
      process.stderr.write(JSON.stringify(entry) + "\n");
    } catch {}
    try {
      this.logHandler?.(entry);
    } catch {
      try {
        process.stderr.write(
          '{"level":"error","plugin":"host","message":"Runtime log sink failed"}\n',
        );
      } catch {}
    }
  }
  async invoke<T = unknown>(
    name: string,
    input?: unknown,
    signal?: AbortSignal,
    providerId?: string,
  ): Promise<T> {
    const records =
      this.storage.getStore()?.snapshot.records ??
      [...this.records.values()].filter((r) => r.state === "Active");
    const provider = providerId
      ? records.find(
          (record) =>
            record.manifest.id === providerId &&
            record.manifest.provides.includes(name),
        )
      : this.resolveCapability(
          name,
          records,
          this.storage.getStore()?.snapshot.bindings ?? this.bindings,
        );
    if (!provider)
      throw new HostError(
        "missing_capability",
        "Selected capability provider is unavailable",
        503,
      );
    if (provider.state === "Failed")
      throw new HostError(
        "plugin_unavailable",
        "Capability provider failed",
        503,
      );
    const handler = provider.provided.get(name);
    if (!handler)
      throw new HostError(
        "plugin_unavailable",
        "Capability is unavailable",
        503,
      );
    const activeSignal =
      signal ??
      this.storage.getStore()?.context.signal ??
      new AbortController().signal;
    activeSignal.throwIfAborted();
    const controller = new AbortController();
    provider.inflight.add(controller);
    try {
      return await handler(
        input,
        AbortSignal.any([activeSignal, controller.signal]),
      );
    } finally {
      provider.inflight.delete(controller);
    }
  }
  private acquire(request: Request) {
    const snapshot = this.current;
    if (this.starting)
      throw new HostError("starting_up", "Host is starting", 503);
    if (this.closing)
      throw new HostError("shutting_down", "Host is draining", 503);
    snapshot.refs++;
    const controller = new AbortController();
    const signal = AbortSignal.any([
      request.signal,
      snapshot.abort.signal,
      controller.signal,
    ]);
    const context: RequestContext = {
      id: randomUUID(),
      graphVersion: snapshot.version,
      request,
      signal,
      state: new Map<string, unknown>([["log.startedAt", Date.now()]]),
      config: {},
    };
    let released = false;
    return {
      snapshot,
      context,
      cancel: (reason?: unknown) => controller.abort(reason),
      release: async (abort = true) => {
        if (released) {
          if (abort) {
            this.recordRequest(context);
            controller.abort(
              new DOMException("Request completed", "AbortError"),
            );
          }
          return;
        }
        released = true;
        try {
          await this.storage.run({ snapshot, context }, () =>
            !this.pipelineContexts.has(context)
              ? Promise.resolve()
              : snapshot.pipeline.run("Finalize", context),
          );
        } catch (error) {
          this.storage.run({ snapshot, context }, () =>
            this.log(
              "host",
              "error",
              error instanceof AggregateError
                ? error.message
                : "Finalize hook failed",
            ),
          );
        } finally {
          if (abort) {
            this.recordRequest(context);
            controller.abort(
              new DOMException("Request completed", "AbortError"),
            );
          }
          snapshot.refs--;
          if (snapshot !== this.current && snapshot.refs === 0)
            this.snapshots.delete(snapshot);
        }
      },
    };
  }
  private async authorize(
    request: Request,
    snapshot: Snapshot,
    context: RequestContext,
    access: string,
  ) {
    context.principal = await snapshot.records
      .find((r) => r.identity)
      ?.identity?.(request);
    if (access !== "public" && !context.principal)
      throw new HostError("unauthorized", "Authentication required", 401);
    if (
      access !== "public" &&
      access !== "authenticated" &&
      !context.principal?.permissions.some((p) => p === "*" || p === access)
    )
      throw new HostError("forbidden", "Permission denied", 403);
    if (
      context.principal?.session &&
      !["GET", "HEAD", "OPTIONS"].includes(request.method)
    ) {
      const origin = request.headers.get("origin");
      if (origin && origin !== new URL(request.url).origin)
        throw new HostError("csrf", "Cross-origin request denied", 403);
    }
  }
  private matches(pattern: string, path: string) {
    return pattern.endsWith("*")
      ? path.startsWith(pattern.slice(0, -1))
      : pattern === path;
  }
  async fetch(request: Request): Promise<Response> {
    let lease: ReturnType<Kernel["acquire"]> | undefined;
    let selectedRoute: OwnedRoute | undefined;
    try {
      lease = this.acquire(request);
      const { snapshot, context } = lease;
      request = new Request(request, { signal: context.signal });
      context.request = request;
      return await this.storage.run({ snapshot, context }, async () => {
        const path = new URL(request.url).pathname;
        const publicAsset = await this.publicAssetHandler?.(request);
        if (publicAsset) {
          context.state.set("http.status", publicAsset.status);
          await lease!.release();
          return publicAsset;
        }
        const asset = /^\/extensions\/([a-z0-9.-]+)\/([^/]+)$/.exec(path);
        if (asset) {
          const r = snapshot.records.find((r) => r.manifest.id === asset[1]);
          const response = r
            ? await serveAsset(r.path, r.manifest, asset[2]!)
            : new Response("Not found", { status: 404 });
          await lease!.release();
          return response;
        }
        const route = snapshot.routes.find(
          (route) =>
            route.method.toUpperCase() === request.method &&
            this.matches(route.path, path),
        );
        selectedRoute = route;
        const pipeline =
          !!route && route.pipeline !== false && !path.startsWith("/api/");
        if (pipeline) this.pipelineContexts.add(context);
        const hostAccess =
          path === "/api/host/slots"
            ? "authenticated"
            : path.startsWith("/api/host/") &&
                !["/api/host/extensions", "/api/host/setup"].includes(path)
              ? "host.manage"
              : "public";
        if (pipeline) await snapshot.pipeline.run("Ingress", context);
        await this.authorize(
          request,
          snapshot,
          context,
          route?.access ?? hostAccess,
        );
        context.state.set("admin.startedAt", Date.now());
        this.recordAdmin(context);
        if (pipeline) await snapshot.pipeline.run("Identity", context);
        let response: Response;
        if (path === "/api/host/slots" && request.method === "GET")
          response = json(this.slots());
        else if (path === "/api/host/extensions" && request.method === "GET")
          response = json(this.extensions());
        else if (path === "/api/host/plugins" && request.method === "GET")
          response = json(this.list().map(({ config, ...p }) => p));
        else if (path.startsWith("/api/host/") && this.management) {
          // Management may stop the graph it entered. Detach its lease while keeping its request body live.
          await lease!.release(false);
          response = await this.storage.exit(() =>
            this.management!(request, context),
          );
        } else if (!route)
          response = json(
            { error: { code: "not_found", message: "Not found" } },
            404,
          );
        else {
          context.config = snapshot.configs.get(route.owner) ?? {};
          await route.prepare?.(request, context);
          if (pipeline) await snapshot.pipeline.run("Planning", context);
          if (pipeline) await snapshot.pipeline.run("Admission", context);
          if (pipeline) await snapshot.pipeline.run("Execution", context);
          response = await route.handle(request, context);
        }
        context.state.set("http.status", response.status);
        try {
          this.recordAdmin(context, response.status);
        } catch {
          this.log(
            "host",
            "error",
            "Could not finalize administrator audit record",
          );
        }
        context.response = response;
        if (pipeline) await snapshot.pipeline.run("Streaming", context);
        response = context.response ?? response;
        context.state.set("http.status", response.status);
        const headers = new Headers(response.headers);
        headers.set("x-pluhub-request-id", context.id);
        headers.set("x-pluhub-graph", String(context.graphVersion));
        if (!response.body) {
          await lease!.release();
          return new Response(null, { status: response.status, headers });
        }
        const reader = response.body.getReader();
        const finish = lease!.release;
        let bodyClosed = false;
        const abort = () => {
          if (!bodyClosed) context.state.set("http.cancelled", true);
          void reader
            .cancel(context.signal.reason)
            .catch(() => {})
            .finally(() => void finish());
        };
        context.signal.addEventListener("abort", abort, { once: true });
        const body = new ReadableStream<Uint8Array>({
          pull: async (controller) => {
            try {
              context.signal.throwIfAborted();
              const item = await this.storage.run({ snapshot, context }, () =>
                reader.read(),
              );
              if (bodyClosed) return;
              if (item.done) {
                bodyClosed = true;
                controller.close();
                context.signal.removeEventListener("abort", abort);
                await finish();
              } else controller.enqueue(item.value);
            } catch (error) {
              context.state.set("http.errorCode", "stream_error");
              if (!context.signal.aborted)
                this.storage.run({ snapshot, context }, () =>
                  this.log(
                    "host",
                    "error",
                    "Response stream failed: " +
                      (error instanceof Error ? error.message : String(error)),
                  ),
                );
              if (!bodyClosed) {
                bodyClosed = true;
                controller.error(error);
              }
              context.signal.removeEventListener("abort", abort);
              await finish();
            }
          },
          cancel: async (reason) => {
            bodyClosed = true;
            context.state.set("http.cancelled", true);
            context.signal.removeEventListener("abort", abort);
            lease!.cancel(reason);
            try {
              await reader.cancel(reason);
            } finally {
              await finish();
            }
          },
        });
        return new Response(body, { status: response.status, headers });
      });
    } catch (error) {
      if (lease) {
        if (Number((error as { status?: number }).status ?? 500) >= 500)
          this.storage.run(
            { snapshot: lease.snapshot, context: lease.context },
            () =>
              this.log(
                "host",
                "error",
                "Request handler failed: " +
                  (error instanceof Error ? error.message : String(error)),
              ),
          );
        const failure = error as { status?: number; code?: string };
        lease.context.state.set("http.status", failure.status ?? 500);
        lease.context.state.set(
          "http.errorCode",
          failure.code ?? "internal_error",
        );
        try {
          this.recordAdmin(
            lease.context,
            failure.status ?? 500,
            failure.code ?? "internal_error",
          );
        } catch {
          this.log(
            "host",
            "error",
            "Could not finalize administrator audit record",
          );
        }
      }
      await lease?.release();
      const e = error as { code?: string; status?: number };
      const response = selectedRoute?.error
        ? selectedRoute.error(error)
        : json(
            {
              error: {
                code: e.code ?? "internal_error",
                message:
                  e.status && e.status < 500
                    ? (error as Error).message
                    : "Request failed",
              },
            },
            e.status ?? 500,
          );
      const headers = new Headers(response.headers);
      if (lease) {
        headers.set("x-pluhub-request-id", lease.context.id);
        headers.set("x-pluhub-graph", String(lease.context.graphVersion));
      }
      return new Response(response.body, { status: response.status, headers });
    }
  }
  async acceptUpgrade(request: Request) {
    const lease = this.acquire(request);
    const { snapshot, context } = lease;
    try {
      return await this.storage.run({ snapshot, context }, async () => {
        const route = snapshot.upgrades.find((r) =>
          this.matches(r.path, new URL(request.url).pathname),
        );
        if (!route)
          throw new HostError("not_found", "Upgrade route not found", 404);
        this.pipelineContexts.add(context);
        await snapshot.pipeline.run("Ingress", context);
        await this.authorize(request, snapshot, context, route.access);
        await snapshot.pipeline.run("Identity", context);
        context.config = snapshot.configs.get(route.owner) ?? {};
        await snapshot.pipeline.run("Planning", context);
        await snapshot.pipeline.run("Admission", context);
        await snapshot.pipeline.run("Execution", context);
        const plan = await route.handler(request, context);
        context.state.set("http.status", 101);
        await snapshot.pipeline.run("Streaming", context);
        return {
          ...plan,
          signal: context.signal,
          release: () => {
            void lease.release();
          },
        };
      });
    } catch (error) {
      const failure = error as { status?: number; code?: string };
      context.state.set("http.status", failure.status ?? 500);
      context.state.set("http.errorCode", failure.code ?? "upgrade_error");
      await lease.release();
      throw error;
    }
  }
}
