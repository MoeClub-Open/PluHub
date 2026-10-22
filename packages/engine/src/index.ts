import { PHASES } from "@pluhub/contracts";
import { HostError, type Hook, type RequestContext } from "@pluhub/sdk";
export interface CompiledGraph {
  readonly version: number;
  readonly hooks: ReadonlyMap<string, readonly Hook[]>;
  run(phase: string, context: RequestContext): Promise<void>;
}
export function compileGraph(version: number, input: Hook[]): CompiledGraph {
  const groups = new Map<string, readonly Hook[]>();
  const ids = new Set<string>();
  for (const h of input) {
    if (ids.has(h.id))
      throw new HostError("hook_conflict", "Duplicate hook " + h.id);
    if (!PHASES.includes(h.phase))
      throw new HostError("invalid_phase", "Invalid phase");
    ids.add(h.id);
  }
  for (const phase of PHASES) {
    const hooks = input.filter((h) => h.phase === phase);
    const map = new Map(hooks.map((h) => [h.id, h]));
    const edges = new Map(hooks.map((h) => [h.id, new Set<string>()]));
    const edge = (a: string, b: string) => {
      if (!map.has(a) || !map.has(b))
        throw new HostError(
          "hook_order",
          "Hook order target is missing or in another phase",
        );
      edges.get(a)!.add(b);
    };
    for (const h of hooks) {
      for (const b of h.before ?? []) edge(h.id, b);
      for (const a of h.after ?? []) edge(a, h.id);
    }
    const ordered: Hook[] = [];
    const pending = new Set(map.keys());
    while (pending.size) {
      const ready = [...pending]
        .filter(
          (id) => ![...pending].some((other) => edges.get(other)!.has(id)),
        )
        .sort();
      if (!ready.length) throw new HostError("hook_cycle", "Hook order cycle");
      for (const id of ready) {
        ordered.push(Object.freeze({ ...map.get(id)! }));
        pending.delete(id);
      }
    }
    groups.set(phase, Object.freeze(ordered));
  }
  return Object.freeze({
    version,
    hooks: groups,
    async run(phase: string, context: RequestContext) {
      for (const hook of groups.get(phase) ?? []) {
        if (phase !== "Finalize") context.signal.throwIfAborted();
        await hook.handle(context);
      }
    },
  });
}
export function streamTransform(
  source: ReadableStream<Uint8Array>,
  transform: (chunk: Uint8Array) => Uint8Array,
): ReadableStream<Uint8Array> {
  return source.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        controller.enqueue(transform(chunk));
      },
    }),
  );
}
