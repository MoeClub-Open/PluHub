export type {
  Manifest,
  Phase,
  PluginState,
  HostConfig,
  PluginConfig,
} from "@pluhub/contracts";
import type { Phase, Manifest } from "@pluhub/contracts";
export class HostError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = "HostError";
  }
}
export interface Principal {
  id: string;
  permissions: string[];
  session?: boolean;
  attributes?: Readonly<Record<string, unknown>>;
}
export interface RequestContext {
  id: string;
  graphVersion: number;
  /** Server-generated linkage for an internally dispatched child request. */
  parent?: Readonly<{ requestId: string; nodeId: string; depth: number }>;
  request: Request;
  /** Standard Web response, available to Streaming hooks for body transforms. */
  response?: Response;
  signal: AbortSignal;
  principal?: Principal;
  state: Map<string, unknown>;
  config: Record<string, unknown>;
}
export type Handler = (
  request: Request,
  context: RequestContext,
) => Response | Promise<Response>;
export interface ApiRoute {
  method: string;
  path: string;
  access: string;
  /** Only trusted child dispatches may enter this route. */
  internal?: boolean;
  /** Plugin IDs allowed to dispatch children to this route. Omitted denies child entry. */
  childCallers?: readonly string[];
  /** Set false for read-only POST endpoints and account-session operations. */
  audit?: boolean;
  pipeline?: boolean;
  prepare?: (request: Request, context: RequestContext) => Promise<void>;
  error?: (error: unknown) => Response;
  handle: Handler;
}
export interface Hook {
  id: string;
  phase: Phase;
  before?: string[];
  after?: string[];
  handle: (context: RequestContext) => void | Promise<void>;
}
export interface CapabilityProvider {
  id: string;
  name: string;
  version: string;
}
export interface Host {
  readonly id: string;
  readonly dataDir: string;
  dispatch(request: Request): Promise<Response>;
  /** Dispatch a metered internal workflow request using the current identity and graph. */
  dispatchChild(
    request: Request,
    options: {
      nodeId: string;
      plan?: unknown;
      delegatedModel?: string;
      onComplete?: (outcome: {
        status: number;
        errorCode?: string;
        cancelled: boolean;
        result?: unknown;
      }) => void;
    },
  ): Promise<Response>;
  /** Access the authenticated request context while handling a trusted workflow. */
  requestContext(options?: { callers?: readonly string[] }): RequestContext;
  upgrade(
    path: string,
    access: string,
    handler: (
      request: Request,
      context: RequestContext,
    ) => Promise<{ url: string; headers?: Record<string, string> }>,
  ): void;
  acceptUpgrade(request: Request): Promise<{
    url: string;
    headers?: Record<string, string>;
    signal: AbortSignal;
    release: () => void;
  }>;
  config<T extends Record<string, unknown> = Record<string, unknown>>(): T;
  validateConfig(check: (config: Record<string, unknown>) => void): void;
  hasCapability(name: string): boolean;
  provide(
    name: string,
    handler: (input: any, signal: AbortSignal) => any,
    options?: { callers?: readonly string[] },
  ): void;
  providers(name: string): CapabilityProvider[];
  call<T = unknown>(
    name: string,
    input?: unknown,
    signal?: AbortSignal,
    providerId?: string,
  ): Promise<T>;
  api(route: ApiRoute): void;
  route(route: ApiRoute): void;
  hook(hook: Hook): void;
  identity(resolve: (request: Request) => Promise<Principal | undefined>): void;
  /** Resolve a host-managed credential subject to this plugin's secretRefs grant. */
  secret(reference: string): string;
  log(level: "info" | "warn" | "error", message: string): void;
  cleanup(fn: () => void | Promise<void>): void;
  publish(event: string, data: unknown): void;
  subscribe(event: string, handler: (data: unknown) => void): void;
}
export interface Plugin {
  setup(host: Host): void | Promise<void>;
}
export const definePlugin = (plugin: Plugin): Plugin => plugin;
export const json = (data: unknown, status = 200): Response =>
  Response.json(data, { status });
export async function readJson<T = Record<string, any>>(
  request: Request,
  limit = 1024 * 1024,
): Promise<T> {
  if (!request.body)
    throw new HostError("invalid_request", "JSON body required");
  const reader = request.body.getReader();
  const abort = () => {
    void reader.cancel(request.signal.reason).catch(() => {});
  };
  request.signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      request.signal.throwIfAborted();
      const { done, value } = await reader.read();
      request.signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new HostError("body_too_large", "Request body too large", 413);
      }
      chunks.push(value);
    }
  } finally {
    request.signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
  try {
    return JSON.parse(
      new TextDecoder().decode(BufferlessConcat(chunks, size)),
    ) as T;
  } catch {
    throw new HostError("invalid_json", "Invalid JSON body");
  }
}
function BufferlessConcat(chunks: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let n = 0;
  for (const c of chunks) {
    out.set(c, n);
    n += c.byteLength;
  }
  return out;
}
export function requiredString(
  value: unknown,
  name: string,
  max = 256,
): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new HostError("invalid_request", "Invalid " + name);
  return value;
}

export async function readObject<T = Record<string, any>>(
  request: Request,
  limit = 1024 * 1024,
): Promise<T> {
  const value = await readJson(request, limit);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HostError("invalid_request", "Expected a JSON object");
  return value as T;
}
