import { createServer } from "node:http";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  rm,
  readdir,
} from "node:fs/promises";
import { tmpdir, cpus, release } from "node:os";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Kernel } from "../packages/kernel/dist/index.js";
const dir = await mkdtemp(join(tmpdir(), "pluhub-bench-"));
const payload = Buffer.alloc(16384, 97);
const upstream = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/octet-stream" });
  res.end(payload);
});
await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const target = "http://127.0.0.1:" + upstream.address().port;
const kernel = new Kernel(join(dir, "data"), 1000);
try {
  for (const name of ["listener", "http-transport"]) {
    const path = resolve("../PluHub-Plugins/plugins", name);
    const m = JSON.parse(await readFile(join(path, "manifest.json"), "utf8"));
    await kernel.add(path, {
      grants: m.permissions,
      config: name === "listener" ? { port: 0, host: "127.0.0.1" } : {},
    });
  }
  const plugin = join(dir, "bench.plugin");
  await mkdir(plugin);
  await writeFile(
    join(plugin, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "bench.plugin",
      version: "1.0.0",
      host: ">=0.1.0-alpha.1",
      runtime: { kind: "native", entry: "index.mjs" },
      provides: [],
      requires: ["http.transport@1"],
      permissions: ["http.route"],
    }),
  );
  await writeFile(
    join(plugin, "index.mjs"),
    "export default {setup(h){for(const path of ['/raw','/native'])h.route({method:'GET',path,access:'public',handle:async(r,c)=>{const response=await h.call('http.transport@1',{url:'" +
      target +
      "',method:'GET'},c.signal);if(path==='/raw')return response;return new Response(response.body.pipeThrough(new TransformStream({transform(chunk,c){c.enqueue(chunk.map(v=>v===97?65:v))}})),{headers:response.headers})}});}}",
  );
  await kernel.add(plugin, { grants: ["http.route"] });
  await kernel.start();
  const address = await kernel.invoke("listener.address@1");
  const gateway = "http://127.0.0.1:" + address.port;
  const percentile = (values, p) =>
    values.slice().sort((a, b) => a - b)[
      Math.min(values.length - 1, Math.floor(values.length * p))
    ];
  const results = [];
  for (const [path, url] of [
    ["direct", target],
    ["raw", gateway + "/raw"],
    ["native", gateway + "/native"],
  ]) {
    const latency = [],
      ttfb = [];
    async function once(record = true) {
      const start = performance.now();
      const response = await fetch(url);
      if (response.status !== 200) throw new Error("Benchmark HTTP error");
      const reader = response.body.getReader();
      let first = true;
      while (true) {
        const { done } = await reader.read();
        if (first) {
          if (record) ttfb.push(performance.now() - start);
          first = false;
        }
        if (done) break;
      }
      if (record) latency.push(performance.now() - start);
    }
    for (let n = 0; n < 10; n++) await once(false);
    const rss = process.memoryUsage().rss;
    const start = performance.now();
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        for (let n = 0; n < 25; n++) await once();
      }),
    );
    const elapsed = performance.now() - start;
    results.push({
      path,
      requests: 100,
      concurrency: 4,
      responseBytes: payload.length,
      rps: 100000 / elapsed,
      latencyMs: {
        p50: percentile(latency, 0.5),
        p95: percentile(latency, 0.95),
        p99: percentile(latency, 0.99),
      },
      ttfbMs: {
        p50: percentile(ttfb, 0.5),
        p95: percentile(ttfb, 0.95),
        p99: percentile(ttfb, 0.99),
      },
      rssBefore: rss,
      rssAfter: process.memoryUsage().rss,
    });
  }
  const hash = createHash("sha256");
  async function sources(dir) {
    for (const e of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (["node_modules", "dist"].includes(e.name)) continue;
      const file = join(dir, e.name);
      if (e.isDirectory()) await sources(file);
      else if (/\.(ts|tsx|json)$/.test(file)) {
        hash.update(
          file
            .replaceAll("\\", "/")
            .replace(resolve("..").replaceAll("\\", "/"), ""),
        );
        hash.update(await readFile(file));
      }
    }
  }
  await sources(resolve("packages"));
  await sources(resolve("../PluHub-Plugins/plugins"));
  await sources(resolve("../PluHub-Plugins/lib"));
  // Release archives and slim build images need not contain Git or a checkout.
  // Preserve unavailable metadata as null; sourceHash still identifies tested code.
  function git(args) {
    const result = spawnSync("git", args, { encoding: "utf8" });
    return result.status === 0 ? result.stdout.trim() : null;
  }
  const commit = git(["rev-parse", "HEAD"]);
  const changes = git(["status", "--porcelain"]);
  const report = {
    capturedAt: new Date().toISOString(),
    node: process.version,
    runtime: process.versions.bun ? "Bun" : "Node.js",
    runtimeVersion: process.versions.bun ?? process.version,
    platform: process.platform,
    os: release(),
    cpu: cpus()[0]?.model,
    commit,
    dirty: changes === null ? null : changes.length > 0,
    sourceHash: hash.digest("hex"),
    method:
      "Same process and environment; 10 warmups, 100 requests, concurrency 4; first response byte, not model TTFT; no pass/fail throughput promise.",
    results,
  };
  await mkdir("output", { recursive: true });
  await writeFile("output/bench.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} finally {
  await kernel.shutdown();
  await new Promise((resolve) => upstream.close(() => resolve()));
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
}
