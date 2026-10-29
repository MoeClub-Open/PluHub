import type { ModelRedirect, ModelRoute, Upstream } from "@pluhub/contracts/ai";

/** Fold retired standalone aliases into the target channel's existing graph. */
export function migrateModelRedirects(router: {
  upstreams: Record<string, Upstream>;
  models: Record<string, ModelRoute>;
  redirects?: Record<string, ModelRedirect>;
}) {
  if (!router.redirects) return false;
  const rules = router.redirects;
  const aliases = Object.entries(rules).flatMap(([source, rule]) => {
    if (rule.enabled === false) return [];
    let target = source,
      explicit = false;
    const seen = new Set<string>();
    while (Object.hasOwn(rules, target) && rules[target]!.enabled !== false) {
      if (seen.has(target) || seen.size >= 32)
        throw new Error("模型重定向存在循环或超过 32 层：" + source);
      seen.add(target);
      const next = rules[target]!;
      explicit ||= next.mode === "explicit";
      target = next.target;
    }
    const model = router.models[target];
    if (!model || !router.upstreams[model.upstream])
      throw new Error("模型重定向目标不存在：" + target);
    return [{ source, target, model: structuredClone(model), explicit }];
  });
  for (const { source, target, model, explicit } of aliases) {
    const channel = router.upstreams[model.upstream]!;
    const flow = channel.flow;
    const start = flow?.nodes.find((node) => node.id === flow.entry);
    if (!flow || start?.type !== "start")
      throw new Error("请先迁移渠道流程：" + model.upstream);
    const used = new Set(flow.nodes.map((node) => node.id));
    let id = "redirect",
      suffix = 1;
    while ([id, id + "-test", id + "-target"].some((key) => used.has(key)))
      id = "redirect" + suffix++;
    const modelIds = new Set(
      Object.values(router.models)
        .filter((route) => route.upstream === model.upstream)
        .map((route) => route.model),
    );
    let mapped = ("redirect/" + source).slice(0, 240);
    while (modelIds.has(mapped))
      mapped = ("redirect/" + source).slice(0, 230) + "-" + suffix++;
    router.models[source] = { ...model, publicModel: source, model: mapped };
    flow.nodes.push(
      {
        id,
        type: "branch",
        condition: false,
        yes: id + "-target",
        no: start.next,
      },
      {
        id: id + "-test",
        type: "compare",
        valueType: "string",
        operator: "eq",
        left: "",
        right: mapped,
      },
      {
        id: id + "-target",
        type: "upstream",
        target,
        mode: explicit ? "explicit" : "implicit",
      },
    );
    (flow.bindings ??= []).push(
      {
        source: start.id,
        output: "mappedModel",
        target: id + "-test",
        input: "left",
      },
      {
        source: id + "-test",
        output: "result",
        target: id,
        input: "condition",
      },
    );
    start.next = id;
  }
  delete router.redirects;
  return true;
}
