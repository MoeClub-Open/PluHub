import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { pathToFileURL } from "node:url";
import { StringDecoder } from "node:string_decoder";
import type { Readable, Writable } from "node:stream";
import { HostError, type Host, type Manifest, type Plugin } from "@pluhub/sdk";
const LIMIT = 1024 * 1024;
type Pending = {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  clear: () => void;
};
export class RpcPeer {
  private seq = 0;
  private buffer = "";
  private decoder = new StringDecoder("utf8");
  private pending = new Map<number, Pending>();
  private active = new Map<number, AbortController>();
  private closed = false;
  onRequest?: (
    method: string,
    params: any,
    signal: AbortSignal,
  ) => Promise<unknown>;
  constructor(
    private input: Readable,
    private output: Writable,
    private failed: (error: Error) => void = () => {},
  ) {
    input.on("data", this.onData);
    input.on("end", this.onEnd);
    input.on("error", this.onError);
    output.on("error", this.onError);
  }
  private onData = (chunk: Buffer) => {
    try {
      this.buffer += this.decoder.write(chunk);
      let n: number;
      while ((n = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, n);
        this.buffer = this.buffer.slice(n + 1);
        if (Buffer.byteLength(line) > LIMIT)
          throw new Error("RPC message exceeds 1 MiB");
        if (line.trim()) this.dispatch(JSON.parse(line));
      }
      if (Buffer.byteLength(this.buffer) > LIMIT)
        throw new Error("RPC message exceeds 1 MiB");
    } catch (e) {
      this.fail(e as Error);
    }
  };
  private onEnd = () => this.fail(new Error("RPC channel closed"));
  private onError = (error: Error) => this.fail(error);
  private dispatch(message: any) {
    if (message.jsonrpc !== "2.0") throw new Error("Invalid RPC envelope");
    if (message.method === "$/cancelRequest") {
      this.active.get(message.params?.id)?.abort();
      return;
    }
    if (typeof message.method === "string") {
      const controller = new AbortController();
      if (message.id !== undefined) this.active.set(message.id, controller);
      Promise.resolve()
        .then(() =>
          this.onRequest?.(message.method, message.params, controller.signal),
        )
        .then(
          (result) =>
            message.id === undefined
              ? undefined
              : this.send({
                  jsonrpc: "2.0",
                  id: message.id,
                  result: result ?? null,
                }),
          (error) =>
            message.id === undefined
              ? undefined
              : this.send({
                  jsonrpc: "2.0",
                  id: message.id,
                  error: {
                    code: -32000,
                    message:
                      error instanceof Error
                        ? error.message
                        : "RPC handler failed",
                  },
                }),
        )
        .catch((e) => this.fail(e))
        .finally(() => this.active.delete(message.id));
      return;
    }
    const p = this.pending.get(message.id);
    if (!p) return;
    this.pending.delete(message.id);
    p.clear();
    message.error
      ? p.reject(new Error(message.error.message))
      : p.resolve(message.result);
  }
  private send(message: unknown): Promise<void> {
    if (this.closed) return Promise.reject(new Error("RPC channel closed"));
    const line = JSON.stringify(message) + "\n";
    if (Buffer.byteLength(line) > LIMIT)
      return Promise.reject(new Error("RPC message exceeds 1 MiB"));
    return new Promise((resolve, reject) => {
      this.output.write(line, (error) => (error ? reject(error) : resolve()));
    });
  }
  call<T = unknown>(
    method: string,
    params: unknown,
    signal?: AbortSignal,
    timeout = 5000,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error("RPC channel closed"));
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.pending.size >= 256)
      return Promise.reject(new Error("RPC pending call limit"));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const cancel = () => {
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        p.clear();
        reject(signal?.reason ?? new Error("RPC timeout"));
        void this.send({
          jsonrpc: "2.0",
          method: "$/cancelRequest",
          params: { id },
        }).catch(() => {});
      };
      const timer = setTimeout(cancel, timeout);
      const clear = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
      };
      this.pending.set(id, { resolve, reject, clear });
      signal?.addEventListener("abort", cancel, { once: true });
      void this.send({ jsonrpc: "2.0", id, method, params }).catch((error) => {
        const p = this.pending.get(id);
        if (p) {
          this.pending.delete(id);
          p.clear();
          p.reject(error);
        }
      });
    });
  }
  fail(error: Error) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      p.clear();
      p.reject(error);
    }
    this.pending.clear();
    for (const c of this.active.values()) c.abort(error);
    this.active.clear();
    this.failed(error);
  }
  close() {
    this.fail(new Error("RPC closed"));
    this.input.off("data", this.onData);
    this.input.off("end", this.onEnd);
    this.input.off("error", this.onError);
    this.output.off("error", this.onError);
  }
}
export interface LoadedRuntime {
  stop(): Promise<void>;
}
export async function loadNative(
  entry: string,
  host: Host,
): Promise<LoadedRuntime> {
  const mod = await import(pathToFileURL(entry).href);
  const plugin = (mod.default ?? mod) as Plugin;
  if (typeof plugin.setup !== "function")
    throw new HostError("invalid_plugin", "Plugin must export setup");
  await plugin.setup(host);
  return { async stop() {} };
}
export async function loadProcess(
  entry: string,
  manifest: Manifest,
  host: Host,
  cwd: string,
  onFailure: (error: Error) => void,
): Promise<LoadedRuntime> {
  const command = entry.endsWith(".js") ? process.execPath : entry;
  const args = entry.endsWith(".js")
    ? [entry, ...(manifest.runtime.args ?? [])]
    : (manifest.runtime.args ?? []);
  const child: ChildProcessWithoutNullStreams = spawn(command, args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stopping = false;
  const fail = (e: Error) => {
    if (!stopping) {
      child.kill("SIGKILL");
      onFailure(e);
    }
  };
  const peer = new RpcPeer(child.stdout, child.stdin, fail);
  child.on("error", (e) => peer.fail(e));
  child.on("exit", (code) => peer.fail(new Error("Plugin exited: " + code)));
  let logBytes = 0;
  child.stderr.on("data", (chunk) => {
    logBytes += chunk.length;
    if (logBytes < 64 * 1024) host.log("warn", String(chunk).trim());
  });
  const contexts = new Map<
    string,
    { run: ReturnType<typeof AsyncLocalStorage.snapshot>; signal: AbortSignal }
  >();
  peer.onRequest = async (method, params, signal) => {
    const context = params?.contextId
      ? contexts.get(params.contextId)
      : undefined;
    if (params?.contextId && !context)
      throw new Error("Invocation context expired");
    const invoke = async () => {
      const activeSignal = context
        ? AbortSignal.any([signal, context.signal])
        : signal;
      if (method === "host.call")
        return host.call(
          params.capability,
          params.input,
          activeSignal,
          params.providerId,
        );
      if (method === "host.providers") return host.providers(params.capability);
      if (method === "host.secret") return host.secret(params.reference);
      if (method === "host.log") {
        if (
          params.level !== undefined &&
          !["info", "warn", "error"].includes(params.level)
        )
          throw new HostError("invalid_request", "Invalid log level");
        host.log(params.level ?? "info", String(params.message));
        return null;
      }
      throw new Error("Unsupported Host RPC method");
    };
    return context ? context.run(invoke) : invoke();
  };
  try {
    const hello = await peer.call<{
      protocolVersion: number;
      capabilities: string[];
    }>("plugin.initialize", {
      protocolVersion: 1,
      id: manifest.id,
      config: host.config(),
      dataDir: host.dataDir,
    });
    if (
      hello.protocolVersion !== 1 ||
      JSON.stringify([...hello.capabilities].sort()) !==
        JSON.stringify([...manifest.provides].sort())
    )
      throw new Error("Plugin handshake mismatch");
    for (const capability of hello.capabilities)
      host.provide(capability, async (input, signal) => {
        const contextId = randomUUID();
        contexts.set(contextId, { run: AsyncLocalStorage.snapshot(), signal });
        try {
          return await peer.call(
            "capability.invoke",
            { capability, input, config: host.config(), contextId },
            signal,
          );
        } finally {
          contexts.delete(contextId);
        }
      });
    const health = await peer.call<{ ready: boolean }>("plugin.health", {});
    if (!health?.ready) throw new Error("Plugin health check failed");
  } catch (error) {
    stopping = true;
    peer.close();
    child.kill("SIGKILL");
    if (child.exitCode === null)
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        setTimeout(resolve, 1000).unref();
      });
    throw error;
  }
  return {
    async stop() {
      stopping = true;
      try {
        await peer.call("plugin.drain", {}, undefined, 1000);
        await peer.call("plugin.stop", {}, undefined, 1000);
      } catch {
      } finally {
        peer.close();
        child.stdin.end();
        if (child.exitCode === null) {
          child.kill("SIGTERM");
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              child.kill("SIGKILL");
              resolve();
            }, 1000);
            child.once("exit", () => {
              clearTimeout(timer);
              resolve();
            });
          });
        }
      }
    },
  };
}
