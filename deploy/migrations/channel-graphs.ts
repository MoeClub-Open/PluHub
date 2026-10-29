import type {
  Upstream,
  ModelRoute,
  ProviderConnection,
} from "@pluhub/contracts/ai";
import type { ChannelWorkflow } from "@pluhub/contracts/workflow";
import { migrateModelRedirects } from "./model-redirects.ts";
export const defaultChannelFlow = (): ChannelWorkflow => ({
  entry: "start",
  nodes: [
    { id: "start", type: "start", next: "provider" },
    { id: "provider", type: "provider" },
  ],
});

/** Convert a complete config copy before saving. Existing aliases and prices
 * stay intact. Split legacy channels only when their models use different graphs.
 * This runs only during an offline configuration migration. */
export function migrateLegacyChannels(config: {
  plugins: { path: string; config?: any }[];
}) {
  const find = (name: string) =>
    config.plugins.find((p) =>
      new RegExp("/(?:official\\.)?" + name + "$").test(
        p.path.replaceAll("\\", "/"),
      ),
    )?.config;
  const router = find("ai-router");
  if (!router) return false;
  const upstreams = (router.upstreams ?? {}) as Record<string, any>;
  const models = (router.models ?? {}) as Record<string, ModelRoute>;
  const flows = find("workflow")?.flows ?? {};
  let changed = false;
  for (const [id, upstream] of Object.entries(upstreams)) {
    if (upstream.protocol !== "workflow") continue;
    const routes = Object.values(models).filter((r) => r.upstream === id);
    const profiles = [...new Set(routes.map((r) => r.model))];
    if (!profiles.length)
      throw new Error("旧渠道 " + id + " 没有模型映射，请先删除或补充映射。");
    for (const profile of profiles)
      if (!flows[profile])
        throw new Error("旧渠道 " + id + " 缺少流程 " + profile);
    for (const [i, profile] of profiles.entries()) {
      let nextId = id;
      if (i) {
        let n = i;
        do {
          nextId = id + "-graph-" + n++;
        } while (Object.hasOwn(upstreams, nextId));
      }
      const next = structuredClone(upstream);
      delete next.protocol;
      next.flow = structuredClone(flows[profile]);
      if (i) next.name = (upstream.name ?? id) + " · " + profile;
      upstreams[nextId] = next;
      for (const route of routes)
        if (route.model === profile) route.upstream = nextId;
    }
    changed = true;
  }
  for (const channel of Object.values(upstreams)) {
    if (!channel.protocol) continue;
    const { flow } = channel;
    const connection = Object.fromEntries(
      [
        "protocol",
        "baseUrl",
        "keyRef",
        "accountId",
        "projectId",
        "authMode",
        "subscriptionAccountIds",
        "interfaces",
      ]
        .filter((key) => channel[key] !== undefined)
        .map((key) => [key, channel[key]]),
    );
    const next = structuredClone(flow ?? defaultChannelFlow());
    next.nodes = next.nodes.map((node) =>
      node.type === "provider"
        ? channel.protocol === "auto-router"
          ? { id: node.id, type: "routing", profile: "$model" }
          : {
              ...node,
              upstream: node.upstream ?? (connection as ProviderConnection),
            }
        : node,
    );
    for (const key of [
      "protocol",
      "baseUrl",
      "keyRef",
      "accountId",
      "subscriptionAccountIds",
      "projectId",
      "authMode",
      "credentialId",
      "credentialOwner",
      "interfaces",
    ] as const)
      delete channel[key];
    channel.flow = next;
    changed = true;
  }
  // Keep orphan rules for repair instead of silently discarding them.
  const append = (channel: Upstream, node: Record<string, unknown>) => {
    const flow = (channel.flow ??= defaultChannelFlow());
    const start = flow.nodes.find((n) => n.id === flow.entry);
    if (start?.type !== "start") throw new Error("渠道流程入口无效");
    if (flow.nodes.length >= 64)
      throw new Error("请先精简渠道流程，再迁移旧规则");
    let id = String(node.type),
      i = 1;
    while (flow.nodes.some((n) => n.id === id)) id = String(node.type) + i++;
    flow.nodes.push({
      ...node,
      id,
      next: start.next,
    } as ChannelWorkflow["nodes"][number]);
    start.next = id;
    changed = true;
  };
  const limiter = find("rate-limit");
  for (const [id, rule] of Object.entries(limiter?.channels ?? {})) {
    if (!Object.hasOwn(upstreams, id)) continue;
    if (Object.keys(rule as object).length)
      append(upstreams[id]!, { type: "rateLimit", rule });
    delete limiter.channels[id];
    changed = true;
  }
  const pacer = find("token-speed");
  if (pacer?.models?.length) {
    pacer.models = pacer.models.filter((rule: any) => {
      if (!Object.hasOwn(upstreams, rule.channel)) return true;
      append(upstreams[rule.channel]!, {
        type: "tps",
        model: rule.model,
        tokenizer: rule.tokenizer,
        ...(rule.tps ? { rate: rule.tps } : {}),
        ...(rule.aggregateTps ? { aggregateRate: rule.aggregateTps } : {}),
        inheritDefault: false,
      });
      return false;
    });
  }
  return migrateModelRedirects(router) || changed;
}
