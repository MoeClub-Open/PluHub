import { dirname, resolve } from "node:path";
import {
  HostError,
  json,
  readObject,
  requiredString,
  type Handler,
  type HostConfig,
} from "@pluhub/sdk";
import type { Kernel } from "@pluhub/kernel";
import { registryService, fingerprint, registrySources } from "./registry.js";
import { pluginJobStore } from "./plugin-jobs.js";
import { installWithDependencies, readInstallOptions } from "./dependencies.js";
import { validateConfig } from "./index.js";
import semver from "semver";
export function registryManagement(
  kernel: Kernel,
  file: string,
  get: () => HostConfig,
  persist: (next: HostConfig) => Promise<void>,
  restart?: () => Promise<void>,
) {
  const registry = registryService(
      resolve(dirname(file), ".pluhub/registry-cache"),
    ),
    jobs = pluginJobStore(file);
  kernel.setPublicAssetHandler(registry.publish);
  const handler: Handler = async (request, context) => {
    const path = new URL(request.url).pathname;
    if (
      !path.startsWith("/api/host/registry") &&
      !path.startsWith("/api/host/plugin-update")
    )
      return new Response(null, { status: 404 });
    if (
      !context.principal?.session ||
      !context.principal.permissions.includes("*")
    )
      throw new HostError("forbidden", "Administrator session required", 403);
    const current = get();
    const recent = async () => {
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
          userId: context.principal!.id,
          token,
        });
      }
    };
    if (path === "/api/host/registry/sources" && request.method === "GET")
      return json(
        registrySources(current).map((source) => ({
          ...source,
          builtin: source.url === "builtin:official",
        })),
      );
    if (path === "/api/host/registry/sources" && request.method === "PUT") {
      await recent();
      const body = await readObject(request);
      if (!Array.isArray(body.sources))
        throw new HostError(
          "invalid_request",
          "Registry sources must be an array",
        );
      const next = {
        ...current,
        pluginRegistries: body.sources as HostConfig["pluginRegistries"],
      };
      validateConfig(next);
      registrySources(next);
      await persist(next);
      return json({ ok: true });
    }
    if (path === "/api/host/registry/catalog" && request.method === "GET") {
      const result = await registry.list(current),
        installed = kernel.list();
      return json({
        ...result,
        plugins: result.plugins.map((item) => ({
          ...item,
          updateAvailable: installed.some(
            (p) =>
              p.id === item.manifest.id &&
              semver.gt(item.manifest.version, p.version),
          ),
        })),
      });
    }
    if (path === "/api/host/plugin-updates" && request.method === "GET")
      return json(jobs.view(await jobs.read()));
    if (
      path === "/api/host/plugin-updates/cancel" &&
      request.method === "POST"
    ) {
      await recent();
      const body = await readObject(request),
        job = await jobs.read();
      if (!job || job.id !== body.id || job.state !== "pending")
        throw new HostError(
          "update_conflict",
          "Update cannot be cancelled",
          409,
        );
      job.state = "cancelled";
      await jobs.write(job);
      return json(jobs.view(job));
    }
    if (
      path === "/api/host/plugin-updates/apply" &&
      request.method === "POST"
    ) {
      await recent();
      if (!restart)
        throw new HostError(
          "restart_unavailable",
          "Managed restart is unavailable in this host",
          503,
        );
      const body = await readObject(request),
        job = await jobs.read();
      if (
        !job ||
        job.id !== body.id ||
        job.state !== "pending" ||
        job.beforeHash !== fingerprint(current)
      )
        throw new HostError(
          "update_conflict",
          "Pending update or configuration changed",
          409,
        );
      job.state = "scheduled";
      await jobs.write(job);
      context.state.set("admin.resourceId", job.pluginId);
      context.state.set("admin.reason", job.reason);
      setTimeout(() => {
        void restart().catch(async () => {
          const current = await jobs.read();
          if (current?.id === job.id && current.state === "scheduled") {
            current.state = "failed";
            current.errorCode = "restart_failed";
            await jobs.write(current);
          }
        });
      }, 200).unref();
      return json({ ok: true, restarting: true, id: job.id }, 202);
    }
    if (
      ["/api/host/registry/plan", "/api/host/registry/install"].includes(
        path,
      ) &&
      request.method === "POST"
    ) {
      const body = await readObject(request),
        id = requiredString(body.id, "id", 128),
        registryId = requiredString(body.registryId, "registryId", 64),
        version = requiredString(body.version, "version", 128);
      if (
        Object.keys(body).some(
          (key) =>
            ![
              "id",
              "registryId",
              "version",
              "operation",
              "revision",
              "reason",
              "config",
              "dependencyConfigs",
              "expectedPlan",
              "grants",
              "dependencyGrants",
            ].includes(key),
        )
      )
        throw new HostError("invalid_request", "Unknown registry option");
      const installOptions = readInstallOptions(
        Object.fromEntries(
          Object.entries(body).filter(([key]) =>
            [
              "config",
              "dependencyConfigs",
              "expectedPlan",
              "grants",
              "dependencyGrants",
            ].includes(key),
          ),
        ),
      );
      if (!["install", "update"].includes(String(body.operation)))
        throw new HostError("invalid_request", "Invalid registry operation");
      const operation = body.operation as "install" | "update";
      const existingJob = await jobs.read();
      if (
        existingJob &&
        ["pending", "scheduled", "applying"].includes(existingJob.state)
      )
        throw new HostError(
          "update_pending",
          "Apply or cancel the pending update first",
          409,
        );
      const active = kernel.list().find((p) => p.id === id);
      if (
        operation === "update" &&
        (!active || active.revision !== body.revision)
      )
        throw new HostError("update_conflict", "Plugin revision changed", 409);
      const prepared = await registry.prepare(
        current,
        { id, registryId, version, operation },
        {
          config: installOptions.config,
          dependencyConfigs: installOptions.dependencyConfigs,
        },
      );
      const newDependencies = prepared.plan.plugins.some(
        (p) => p.action === "install" && p.id !== id,
      );
      const manifest = JSON.parse(
        await (
          await import("node:fs/promises")
        ).readFile(resolve(prepared.source, "manifest.json"), "utf8"),
      );
      const mode =
        operation === "install"
          ? "install"
          : active?.codeReload === "parallel" &&
              active.state === "Active" &&
              !newDependencies &&
              manifest.codeReload === "parallel" &&
              fingerprint(manifest.provides.slice().sort()) ===
                fingerprint(active.manifest.provides.slice().sort())
            ? "hot-update"
            : "restart-update";
      const plan = {
        ...prepared.plan,
        mode,
        registryId,
        origins: prepared.origins,
        fingerprint: fingerprint({
          plan: prepared.plan,
          mode,
          registryId,
          origins: prepared.origins,
          revision: active?.revision,
        }),
      };
      if (path.endsWith("/plan")) return json(plan);
      await recent();
      const reason = requiredString(body.reason, "reason", 256);
      if (body.expectedPlan !== plan.fingerprint)
        throw new HostError(
          "install_plan_changed",
          "Registry plan changed; review it again",
          409,
        );
      context.state.set("admin.resourceId", id);
      context.state.set("admin.reason", reason);
      const options = {
        ...prepared.options,
        origins: prepared.origins,
        grants:
          installOptions.grants ?? prepared.previous?.settings.grants ?? [],
        dependencyGrants: installOptions.dependencyGrants,
      };
      let prospective: HostConfig | undefined;
      const result = await installWithDependencies(
        prepared.source,
        resolve(dirname(file), ".pluhub/plugins"),
        prepared.base,
        options,
        async (next) => {
          if (mode === "install") await persist(next);
          else prospective = next;
        },
        mode === "install" ? kernel : undefined,
      );
      if (mode === "install") return json({ ok: true, ...result }, 201);
      const next = prospective!,
        entry = next.plugins.find(
          (p) => p.path.endsWith("/" + id) || p.path.endsWith("\\" + id),
        )!;
      entry.enabled = prepared.previous?.settings.enabled;
      if (mode === "hot-update") {
        try {
          await kernel.replace(id, entry.path, entry, () => persist(next));
          return json({ ok: true, mode });
        } catch (error) {
          await persist(current);
          throw error;
        }
      }
      const job = await jobs.queue(
        current,
        next,
        id,
        reason,
        prepared.plan.plugins
          .filter((p) => p.action === "install")
          .map((p) => p.id),
      );
      return json({ ok: true, mode, job: jobs.view(job) }, 202);
    }
    return new Response(null, { status: 404 });
  };
  return handler;
}
