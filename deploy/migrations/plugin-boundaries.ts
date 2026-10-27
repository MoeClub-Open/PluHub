import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { writeConfig } from "@pluhub/control";
import type { HostConfig } from "@pluhub/sdk";
import { migrateLegacyChannels } from "./channel-graphs.ts";
import { prepareKeyScopes } from "./key-scopes.ts";
import { migrateWorkflowConditions } from "@pluhub/contracts/workflow-migration";
import type { ChannelWorkflow } from "@pluhub/contracts/workflow";

const retired = new Set(["official.workflow", "official.protocol-converter"]);
export async function migratePluginBoundaries(file: string, write = true) {
  const marker = file + ".plugin-boundaries.json";
  let applied = false,
    compositionApplied = false,
    workflowGrantsApplied = false;
  try {
    const version = JSON.parse(await readFile(marker, "utf8")).version;
    applied = version >= 1;
    compositionApplied = version >= 2;
    workflowGrantsApplied = version >= 3;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const original = await readFile(file, "utf8");
  const config: HostConfig = JSON.parse(original);
  const identities = new Map<string, string>();
  for (const plugin of config.plugins) {
    // Bundled retired directories no longer exist in the new image.
    const basename = plugin.path.replaceAll("\\", "/").split("/").pop()!;
    const bundledId = "official." + basename.replace(/^official\./, "");
    if (retired.has(bundledId)) identities.set(plugin.path, bundledId);
    else {
      const manifest = JSON.parse(
        await readFile(
          resolve(dirname(file), plugin.path, "manifest.json"),
          "utf8",
        ),
      );
      identities.set(plugin.path, manifest.id);
      if (
        manifest.requires.some((name: string) =>
          ["ai.workflow@1", "ai.converter@1"].includes(name),
        )
      )
        throw new Error(
          `Update ${manifest.id} before retiring its legacy dependency`,
        );
    }
  }
  // Resolve identity once; legacy transformation never depends on installation locations.
  const entries = config.plugins.map((plugin) => ({
    ...plugin,
    path: "/" + identities.get(plugin.path),
  }));
  migrateLegacyChannels({ plugins: entries });
  for (const [index, entry] of entries.entries())
    config.plugins[index]!.config = entry.config;
  config.plugins = config.plugins.filter(
    (plugin) => !retired.has(identities.get(plugin.path)!),
  );
  for (const [name, provider] of Object.entries(config.bindings ?? {}))
    if (
      retired.has(provider) ||
      ["ai.workflow@1", "ai.converter@1"].includes(name)
    )
      delete config.bindings![name];
  const router = config.plugins.find(
    (plugin) => identities.get(plugin.path) === "official.ai-router",
  );
  // Convert legacy condition nodes before the new plugin validates its config.
  for (const channel of Object.values(
    (router?.config?.upstreams ?? {}) as Record<
      string,
      { flow?: ChannelWorkflow }
    >,
  )) {
    if (channel.flow) channel.flow = migrateWorkflowConditions(channel.flow);
  }
  if (
    config.plugins.some(
      (plugin) =>
        plugin.enabled !== false &&
        identities.get(plugin.path)?.startsWith("official.ingress-"),
    )
  ) {
    const limiter = config.plugins.find(
      (plugin) => identities.get(plugin.path) === "official.rate-limit",
    );
    if (!limiter)
      throw new Error(
        "标准 AI 入口需要安装 official.rate-limit，请先安装后再升级。",
      );
    limiter.enabled = true;
  }
  const bindings = config.bindings ?? {};
  if (bindings["ai.output-pace@1"]) {
    bindings["ai.output-pace@2"] ??= bindings["ai.output-pace@1"];
    delete bindings["ai.output-pace@1"];
  }
  delete bindings["ai.upstream.auto-router@1"];
  const byok = config.plugins.find(
    (plugin) => identities.get(plugin.path) === "official.byok",
  );
  if (
    !compositionApplied &&
    byok &&
    !byok.grants.includes("*") &&
    !byok.grants.includes("http.dispatch")
  )
    byok.grants.push("http.dispatch");
  const keyScopes = prepareKeyScopes(file, config, router?.config);
  for (const [id, group] of Object.entries(
    (router?.config?.groups ?? {}) as Record<string, any>,
  ))
    if (
      id.startsWith("migrated-key-scope-") &&
      group.name.startsWith("原渠道授权 · ")
    )
      group.name =
        group.channelIds
          .map(
            (channel: string) =>
              router!.config!.upstreams[channel]?.name ?? channel,
          )
          .join(" / ") + " · 指定用户";

  if (
    !applied &&
    router &&
    !router.grants.includes("*") &&
    !router.grants.includes("http.dispatch")
  )
    router.grants.push("http.dispatch");
  // Only the official router receives the new internal execution permissions.
  if (!workflowGrantsApplied && router && !router.grants.includes("*")) {
    for (const permission of [
      "http.dispatch.child",
      "secrets.read",
      "hooks.register",
    ])
      if (!router.grants.includes(permission)) router.grants.push(permission);
  }
  const changed =
    JSON.stringify(JSON.parse(original)) !== JSON.stringify(config);
  if (changed && write) {
    await writeFile(
      file + ".pre-plugin-boundaries-" + Date.now() + ".json",
      original,
      { mode: 0o600, flag: "wx" },
    );
    await writeConfig(file, config);
  }
  if (write) keyScopes.apply();
  if (write && !workflowGrantsApplied)
    await writeConfig(marker, { version: 3 });
  return {
    changed: changed || keyScopes.count > 0,
    written: write && (changed || keyScopes.count > 0),
    migratedKeys: keyScopes.count,
  };
}
