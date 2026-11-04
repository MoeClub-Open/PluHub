import { it, expect } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./helpers.js";

it("keeps removed credentials for pinned requests and collects them after completion", async () => {
  const f = await fixture(["auth"]);
  try {
    const oldRef = f.kernel.secrets.put("previous-request-key");
    const directory = join(f.directory, "test.credentials");
    await mkdir(directory);
    await writeFile(
      join(directory, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "test.credentials",
        version: "1.0.0",
        host: ">=0.1.0-alpha.1",
        runtime: { kind: "native", entry: "index.js" },
        configReload: "snapshot",
        provides: ["test.started@1", "test.resume@1"],
        requires: [],
        permissions: ["http.route", "secrets.read"],
      }),
    );
    await writeFile(
      join(directory, "index.js"),
      `export default { setup(host) {
      let resume, entered;
      const waiting = new Promise(resolve => { resume = resolve; });
      const started = new Promise(resolve => { entered = resolve; });
      host.provide("test.started@1", () => started);
      host.provide("test.resume@1", () => resume());
      host.route({ method: "GET", path: "/test-credentials", access: "public", async handle() {
        entered(); await waiting;
        return new Response(host.secret(host.config().secretRefs[0]));
      }});
    }};`,
    );
    await f.kernel.add(directory, {
      grants: ["http.route", "secrets.read"],
      config: { secretRefs: [oldRef] },
    });
    await f.kernel.enable("test.credentials");
    const pending = f.kernel.fetch(
      new Request("http://localhost/test-credentials"),
    );
    await f.kernel.invoke("test.started@1");
    f.kernel.configure({ "test.credentials": { secretRefs: [] } });
    f.kernel.pruneSecrets();
    expect(f.kernel.secrets.has(oldRef)).toBe(true);
    await f.kernel.invoke("test.resume@1");
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("previous-request-key");
    expect(f.kernel.secrets.has(oldRef)).toBe(false);
  } finally {
    await f.close();
  }
});
