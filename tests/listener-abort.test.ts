import { it, expect } from "vitest";
import { request } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./helpers.js";

it("survives client disconnects before delayed responses and while response bodies are starting", async () => {
  const f = await fixture(["listener"]);
  try {
    const path = join(f.directory, "delayed");
    await mkdir(path);
    await writeFile(
      join(path, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "test.delayed",
        version: "1.0.0",
        host: ">=0.1.0-alpha.1",
        runtime: { kind: "native", entry: "index.mjs" },
        provides: [],
        requires: [],
        permissions: ["http.route"],
      }),
    );
    await writeFile(
      join(path, "index.mjs"),
      `export default {setup(h){h.route({method:'GET',path:'/delayed',access:'public',async handle(r,c){await new Promise(resolve=>setTimeout(resolve,20));return new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(131072));},cancel(){}}));}});}};`,
    );
    await f.kernel.add(path, { grants: ["http.route"] });
    await f.kernel.enable("test.delayed");
    const { port } = await f.kernel.invoke<{ port: number }>(
      "listener.address@1",
    );
    for (const delay of [0, 15, 20, 25]) {
      await Promise.all(
        Array.from(
          { length: 5 },
          () =>
            new Promise<void>((resolve) => {
              const req = request("http://127.0.0.1:" + port + "/delayed");
              req.on("error", () => {});
              req.on("response", (res) => {
                res.on("error", () => {});
                res.resume();
              });
              req.on("close", () => resolve());
              req.end();
              setTimeout(() => req.destroy(), delay);
            }),
        ),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    const ready = await fetch("http://127.0.0.1:" + port + "/healthz");
    expect(ready.status).toBe(200);
    await ready.text();
  } finally {
    await f.close();
  }
});
