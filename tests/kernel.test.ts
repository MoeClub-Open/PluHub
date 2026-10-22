import { describe, it, expect } from "vitest";
import { mockHost } from "../packages/testkit/dist/index.js";
import { compileGraph } from "../packages/engine/dist/index.js";
import { validateManifest } from "../packages/kernel/dist/index.js";
import { install, digest } from "../packages/control/dist/index.js";
import type { Manifest } from "../packages/sdk/dist/index.js";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
const manifest = (id: string, extra: Partial<Manifest> = {}): Manifest => ({
  schemaVersion: 1,
  id,
  version: "1.0.0",
  host: ">=0.1.0-alpha.1",
  runtime: { kind: "native", entry: "index.mjs" },
  provides: [],
  requires: [],
  permissions: [],
  ...extra,
});
describe("kernel contracts", () => {
  it("rejects invalid manifests and incompatible hosts", () => {
    expect(() =>
      validateManifest({ ...manifest("valid.plugin"), id: "../escape" }),
    ).toThrow();
    expect(() =>
      validateManifest({ ...manifest("valid.plugin"), host: ">=99.0.0" }),
    ).toThrow();
  });
  it("enforces declared host permissions", async () => {
    const f = await mockHost();
    try {
      await expect(
        f.plugin(
          manifest("test.permission", { permissions: ["api.register"] }),
          "export default {setup(){}}",
          [],
        ),
      ).rejects.toThrow("Permission");
      await f.plugin(
        manifest("test.undeclared"),
        "export default {setup(h){h.api({method:'GET',path:'/x',access:'public',handle:()=>new Response('bad')})}}",
      );
      await expect(f.kernel.start()).rejects.toThrow("permission");
    } finally {
      await f.close();
    }
  });
  it("rejects missing dependencies and cycles", async () => {
    const f = await mockHost();
    try {
      await f.plugin(
        manifest("test.first", { provides: ["a@1"], requires: ["b@1"] }),
        "export default {setup(h){h.provide('a@1',()=>1)}}",
      );
      await expect(f.kernel.start()).rejects.toThrow("Capability");
      await f.plugin(
        manifest("test.second", { provides: ["b@1"], requires: ["a@1"] }),
        "export default {setup(h){h.provide('b@1',()=>1)}}",
      );
      await expect(f.kernel.start()).rejects.toThrow("cycle");
    } finally {
      await f.close().catch(() => {});
    }
  });
  it("rejects ambiguous capability providers", async () => {
    const f = await mockHost();
    try {
      for (const id of ["test.one", "test.two"])
        await f.plugin(
          manifest(id, { provides: ["shared@1"] }),
          "export default {setup(h){h.provide('shared@1',()=>1)}}",
        );
      await f.plugin(
        manifest("test.consumer", { requires: ["shared@1"] }),
        "export default {setup(){}}",
      );
      await expect(f.kernel.start()).rejects.toThrow("exactly one");
    } finally {
      await f.close().catch(() => {});
    }
  });
  it("detects hook cycles and cross-stage ordering", () => {
    const h = (id: string, after: string[]) => ({
      id,
      phase: "Planning" as const,
      after,
      handle: () => {},
    });
    expect(() => compileGraph(1, [h("a", ["b"]), h("b", ["a"])])).toThrow(
      "cycle",
    );
    expect(() => compileGraph(1, [h("a", ["missing"])])).toThrow("missing");
  });
  it("keeps request configuration immutable across graph replacement", async () => {
    const f = await mockHost();
    try {
      const m = manifest("test.snapshot", {
        permissions: ["http.route"],
        configReload: "snapshot",
      });
      await f.plugin(
        m,
        "export default {setup(h){h.route({method:'GET',path:'/snapshot',access:'public',handle:()=>new Response(new ReadableStream({pull(c){c.enqueue(new TextEncoder().encode(String(h.config().value)));c.close()}}))})}}",
      );
      f.kernel.configure({ "test.snapshot": { value: "old" } });
      await f.kernel.start();
      const old = await f.kernel.fetch(new Request("http://test/snapshot"));
      f.kernel.configure({ "test.snapshot": { value: "new" } });
      expect(await old.text()).toBe("old");
      expect(
        await (
          await f.kernel.fetch(new Request("http://test/snapshot"))
        ).text(),
      ).toBe("new");
    } finally {
      await f.close();
    }
  });
  it("removes APIs and extensions on plugin stop", async () => {
    const f = await mockHost();
    try {
      const m = manifest("test.removal", { permissions: ["http.route"] });
      await f.plugin(
        m,
        "export default {setup(h){h.route({method:'GET',path:'/example',access:'public',handle:()=>new Response('ok')})}}",
      );
      await f.kernel.start();
      expect(
        await (await f.kernel.fetch(new Request("http://test/example"))).text(),
      ).toBe("ok");
      await f.kernel.stop(m.id);
      expect(
        (await f.kernel.fetch(new Request("http://test/example"))).status,
      ).not.toBe(200);
    } finally {
      await f.close();
    }
  });
  it("installs a stable package and detects changing content", async () => {
    const f = await mockHost();
    try {
      const path = await f.plugin(
        manifest("test.package"),
        "export default {setup(){}}",
      );
      const root = join(f.directory, "installed");
      const result = await install(path, root);
      expect(await digest(result.path)).toBe(result.sha256);
      await writeFile(join(result.path, "index.mjs"), "changed");
      expect(await digest(result.path)).not.toBe(result.sha256);
      await expect(install(path, root)).rejects.toThrow();
    } finally {
      await f.close();
    }
  });
});

it("bounds unread stream production and runs Finalize after cancellation", async () => {
  const f = await mockHost();
  try {
    await f.plugin(
      manifest("test.backpressure", {
        provides: ["test.stats@1"],
        permissions: ["http.route", "hooks.register"],
      }),
      "export default {setup(h){let produced=0,canceled=false,finalized=0;h.provide('test.stats@1',()=>({produced,canceled,finalized}));h.hook({id:'finalize',phase:'Finalize',handle:()=>{finalized++}});h.route({method:'GET',path:'/stream',access:'public',handle:()=>new Response(new ReadableStream({pull(c){produced++;c.enqueue(new Uint8Array(65536))},cancel(){canceled=true}}))})}}",
    );
    await f.kernel.start();
    const response = await f.kernel.fetch(new Request("http://test/stream"));
    await new Promise((r) => setTimeout(r, 30));
    expect(
      (await f.kernel.invoke<any>("test.stats@1")).produced,
    ).toBeLessThanOrEqual(4);
    await response.body!.cancel();
    expect(await f.kernel.invoke("test.stats@1")).toMatchObject({
      canceled: true,
      finalized: 1,
    });
  } finally {
    await f.close();
  }
});

it("drains request-level native capability calls before disposing the runtime", async () => {
  const f = await mockHost();
  try {
    await f.plugin(
      manifest("test.inflight", { provides: ["test.wait@1"] }),
      "export default {setup(h){h.provide('test.wait@1',async()=>{await new Promise(r=>setTimeout(r,40));return 'finished'})}}",
    );
    await f.kernel.start();
    const pending = f.kernel.invoke("test.wait@1");
    await f.kernel.stop("test.inflight");
    expect(await pending).toBe("finished");
    expect(f.kernel.list()[0].state).toBe("Stopped");
  } finally {
    await f.close();
  }
});

it("pins capability bindings for a stream across a configuration switch", async () => {
  const f = await mockHost();
  try {
    for (const [id, value] of [
      ["test.bind-a", "a"],
      ["test.bind-b", "b"],
    ])
      await f.plugin(
        manifest(id!, { provides: ["test.selector@1"] }),
        "export default {setup(h){h.provide('test.selector@1',()=>" +
          JSON.stringify(value) +
          ")}}",
      );
    await f.plugin(
      manifest("test.bound", {
        requires: ["test.selector@1"],
        permissions: ["http.route"],
      }),
      "export default {setup(h){h.route({method:'GET',path:'/bound',access:'public',handle:()=>new Response(new ReadableStream({async pull(c){await new Promise(r=>setTimeout(r,40));c.enqueue(new TextEncoder().encode(await h.call('test.selector@1')));c.close()}}))})}}",
    );
    f.kernel.configure({}, { "test.selector@1": "test.bind-a" });
    await f.kernel.start();
    const old = await f.kernel.fetch(new Request("http://test/bound"));
    f.kernel.configure({}, { "test.selector@1": "test.bind-b" });
    expect(await old.text()).toBe("a");
    expect(
      await (await f.kernel.fetch(new Request("http://test/bound"))).text(),
    ).toBe("b");
  } finally {
    await f.close();
  }
});
