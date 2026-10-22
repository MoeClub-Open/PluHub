import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { Kernel } from "@pluhub/kernel";
import { HostError, readObject, type HostConfig } from "@pluhub/sdk";

/** First install exposes a bounded site form, never the host configuration API. */
export function setupHandler(
  kernel: Kernel,
  current: () => HostConfig,
  commit: (next: HostConfig) => Promise<void>,
) {
  let attempts = 0;
  let windowStart = 0;
  function entry(config: HostConfig, id: string) {
    const plugin = kernel
      .list()
      .find((p) => p.id === id && p.state === "Active");
    return (
      plugin && config.plugins.find((p) => resolve(p.path) === plugin.path)
    );
  }
  async function state() {
    const config = current();
    const console = entry(config, "official.console");
    const auth = entry(config, "official.auth");
    if (
      !console ||
      !auth ||
      !kernel
        .list()
        .some(
          (p) =>
            p.state === "Active" &&
            p.manifest.provides.includes("auth.setup@1"),
        )
    )
      return { required: false, stage: "complete" as const };
    const status = await kernel.invoke<any>("auth.setup@1", {
      action: "status",
    });
    if (status.initialized)
      return { required: false, stage: "complete" as const };
    const site = console.config ?? {};
    const onboarding = (site.onboarding ?? {}) as Record<string, any>;
    const listener = entry(config, "official.listener")?.config ?? {};
    return {
      required: true,
      stage: onboarding.siteConfiguredAt
        ? ("admin" as const)
        : ("site" as const),
      step: onboarding.siteConfiguredAt ? 3 : Number(onboarding.draftStep ?? 0),
      revision: createHash("sha256").update(JSON.stringify(site)).digest("hex"),
      branding: site.branding ?? {},
      portal: site.portal ?? {},
      publicOrigin: String(listener.publicOrigin ?? ""),
      secureCookie: auth.config?.secureCookie === true,
    };
  }
  function response(value: unknown, status = 200) {
    return Response.json(value, {
      status,
      headers: { "cache-control": "no-store" },
    });
  }
  return async (request: Request) => {
    if (request.method === "GET") return response(await state());
    if (request.method !== "POST")
      return new Response(null, {
        status: 405,
        headers: { allow: "GET, POST" },
      });
    if (
      request.headers.get("origin") !== new URL(request.url).origin ||
      request.headers.get("sec-fetch-site") === "cross-site" ||
      request.headers.get("x-pluhub-setup") !== "1" ||
      !request.headers.get("content-type")?.startsWith("application/json")
    )
      throw new HostError("csrf", "请从当前站点的初始化页面提交", 403);
    const before = await state();
    if (!before.required)
      throw new HostError(
        "setup_complete",
        "站点已有管理员，请登录后修改设置",
        409,
      );
    const now = Date.now();
    if (now - windowStart >= 60000) {
      attempts = 0;
      windowStart = now;
    }
    if (++attempts > 30)
      throw new HostError(
        "rate_limited",
        "初始化操作过于频繁，请稍后重试",
        429,
      );
    const body = await readObject(request, 256 * 1024);
    const allowed =
      body.action === "site"
        ? ["action", "revision", "step", "branding", "portal"]
        : ["action", "revision", "username", "password"];
    if (Object.keys(body).some((key) => !allowed.includes(key)))
      throw new HostError("invalid_request", "初始化请求包含不支持的字段");
    if (body.revision !== before.revision)
      throw new HostError(
        "setup_conflict",
        "初始化设置已在其他页面更改，请刷新后继续",
        409,
      );
    const next = structuredClone(current());
    const console = entry(next, "official.console")!;
    const saved = console.config ?? {};
    const onboarding = (saved.onboarding ?? {}) as Record<string, unknown>;
    if (body.action === "site") {
      if (
        !Number.isInteger(body.step) ||
        body.step < 0 ||
        body.step > 2 ||
        !body.branding ||
        typeof body.branding !== "object" ||
        Array.isArray(body.branding) ||
        !body.portal ||
        typeof body.portal !== "object" ||
        Array.isArray(body.portal)
      )
        throw new HostError("invalid_request", "请提供站点和门户设置");
      const ready = body.step === 2;
      const origin = new URL(request.url).origin;
      if (
        ready &&
        ((before.publicOrigin &&
          before.publicOrigin.replace(/\/$/, "") !== origin) ||
          (origin.startsWith("https:") && !before.secureCookie))
      )
        throw new HostError(
          "invalid_origin",
          "请先配置当前对外地址及安全 Cookie，再创建管理员",
        );
      console.config = {
        ...saved,
        branding: body.branding,
        portal: body.portal,
        onboarding: {
          ...onboarding,
          draftStep: Math.min(2, body.step + 1),
          ...(ready ? { siteConfiguredAt: new Date().toISOString() } : {}),
        },
      };
      await commit(next);
      return response(await state());
    }
    if (body.action !== "admin")
      throw new HostError("invalid_request", "未知初始化操作");
    if (before.stage !== "admin")
      throw new HostError("site_required", "请先完成站点初始化设置", 409);
    await kernel.invoke("auth.setup@1", {
      action: "create",
      username: body.username,
      password: body.password,
    });
    console.config = {
      ...saved,
      onboarding: {
        ...onboarding,
        completed: true,
        completedAt: new Date().toISOString(),
      },
    };
    await commit(next);
    return response({ required: false, stage: "complete" }, 201);
  };
}
