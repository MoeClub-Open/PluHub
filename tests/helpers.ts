import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { Kernel } from "../packages/kernel/dist/index.js";
import { defaultPluginNames } from "../apps/cli/dist/presets.js";
import {
  attachManagement,
  writeConfig,
} from "../packages/control/dist/index.js";
export const pluginsRoot = resolve("../PluHub-Plugins/plugins");
export async function fixture(
  // Include optional legacy adapters in regression coverage, not in new sites.
  names = [...defaultPluginNames, "protocol-converter", "workflow"],
  configs: Record<string, Record<string, unknown>> = {},
  prepare?: (kernel: Kernel, directory: string) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "pluhub-integration-"));
  const config: any = {
    schemaVersion: 1,
    dataDir: join(directory, "data"),
    drainTimeoutMs: 200,
    plugins: [],
  };
  for (const name of names) {
    const path = join(pluginsRoot, name);
    const m = JSON.parse(await readFile(join(path, "manifest.json"), "utf8"));
    config.plugins.push({
      path,
      grants: m.permissions,
      config:
        configs[name] ??
        (name === "listener"
          ? { port: 0, host: "127.0.0.1" }
          : name === "ai-router"
            ? { upstreams: {}, models: {} }
            : name.startsWith("upstream-")
              ? { secretRefs: ["env:PLUHUB_TEST_UPSTREAM_KEY"] }
              : {}),
    });
  }
  const file = join(directory, "pluhub.json");
  await writeConfig(file, config);
  const kernel = new Kernel(config.dataDir, 200);
  for (const entry of config.plugins) await kernel.add(entry.path, entry);
  await prepare?.(kernel, directory);
  attachManagement(kernel, file, config);
  await kernel.start();
  async function request(
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    return kernel.fetch(
      new Request("http://localhost" + path, {
        method,
        headers: {
          ...(body ? { "content-type": "application/json" } : {}),
          ...headers,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
  }
  async function admin() {
    await kernel.invoke("auth.bootstrap@1", {
      username: "admin",
      password: "correct-admin-password",
    });
    const response = await request("/api/plugins/official.auth/login", "POST", {
      username: "admin",
      password: "correct-admin-password",
    });
    const token = response.headers.get("set-cookie")!.split(";")[0]!;
    await response.json();
    return { cookie: token };
  }
  return {
    kernel,
    directory,
    config,
    file,
    request,
    admin,
    async close() {
      await kernel.shutdown();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
