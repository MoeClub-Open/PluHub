import { it, expect } from "vitest";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { mockHost } from "../packages/testkit/dist/index.js";
import { fixture } from "./helpers.js";
import { createKernel, writeConfig } from "../packages/control/dist/index.js";
const manifest = (extra: any = {}) => ({
  schemaVersion: 1,
  id: "test.update",
  name: "测试插件",
  description: "在线更新测试",
  codeReload: "parallel",
  version: "1.0.0",
  host: ">=0.1.0-alpha.1",
  runtime: { kind: "native", entry: "index.mjs" },
  provides: ["test.value@1"],
  requires: [],
  permissions: ["http.route"],
  ...extra,
});
async function packageAt(
  root: string,
  folder: string,
  value: string,
  extra: any = {},
  source?: string,
) {
  const path = join(root, folder);
  await mkdir(path);
  await writeFile(join(path, "manifest.json"), JSON.stringify(manifest(extra)));
  await writeFile(
    join(path, "value.mjs"),
    `export default ${JSON.stringify(value)}`,
  );
  await writeFile(
    join(path, extra.runtime?.entry ?? "index.mjs"),
    source ??
      `import value from './value.mjs'; export default {setup(h){h.provide('test.value@1',()=>value);h.route({method:'GET',path:'/version',access:'public',handle:()=>new Response(value)})}}`,
  );
  return path;
}
it("switches provider code and UI generations while old requests retain their graph and cleanup waits for them", async () => {
  const f = await mockHost();
  const gate = "pluhubUpdate_" + randomUUID().replaceAll("-", "");
  try {
    const old = await packageAt(f.directory, "old", "old", {
      ui: { title: "Example", path: "/example", entry: "ui.js" },
    });
    const oldSource = await readFile(join(old, "index.mjs"), "utf8");
    await writeFile(
      join(old, "index.mjs"),
      oldSource.replace(
        "setup(h){",
        `setup(h){h.cleanup(()=>globalThis['${gate}Disposed']=true);`,
      ),
    );
    await writeFile(join(old, "ui.js"), "export const value='old'");
    await f.kernel.add(old, { grants: ["http.route"] });
    await f.plugin(
      manifest({
        id: "test.consumer",
        codeReload: "restart",
        provides: [],
        requires: ["test.value@1"],
      }),
      `export default {setup(h){h.route({method:'GET',path:'/stream',access:'public',handle:()=>new Response(new ReadableStream({async start(c){await new Promise(r=>globalThis['${gate}']=r);c.enqueue(new TextEncoder().encode(String(h.hasCapability('test.value@1'))+':'+await h.call('test.value@1')));c.close()}}))})}}`,
    );
    await f.kernel.start();
    const before = f.kernel.extensions()[0]!.url;
    const response = await f.kernel.fetch(new Request("http://test/stream"));
    const next = await packageAt(f.directory, "next", "new", {
      version: "1.1.0",
      ui: { title: "Example", path: "/example", entry: "ui.js" },
    });
    await writeFile(join(next, "ui.js"), "export const value='new'");
    await f.kernel.replace("test.update", next, { grants: ["http.route"] });
    expect((globalThis as any)[gate + "Disposed"]).toBeUndefined();
    expect(await f.kernel.invoke("test.value@1")).toBe("new");
    expect(f.kernel.extensions()[0]!.url).not.toBe(before);
    (globalThis as any)[gate]();
    expect(await response.text()).toBe("true:old");
    expect(
      await (await f.kernel.fetch(new Request("http://test/version"))).text(),
    ).toBe("new");
    await f.kernel.shutdown();
    expect((globalThis as any)[gate + "Disposed"]).toBe(true);
  } finally {
    delete (globalThis as any)[gate];
    delete (globalThis as any)[gate + "Disposed"];
    await f.close();
  }
});
it("keeps the old instance on startup, dependency, permission, graph and persistence failures", async () => {
  const f = await mockHost();
  try {
    const old = await packageAt(f.directory, "old", "old");
    await f.kernel.add(old, { grants: ["http.route"] });
    await f.kernel.start();
    await f.plugin(
      manifest({ id: "test.conflict", provides: [], codeReload: "restart" }),
      `export default {setup(h){h.route({method:'GET',path:'/occupied',access:'public',handle:()=>new Response('ok')})}}`,
    );
    await f.kernel.enable("test.conflict");
    const cases: [any, string | undefined][] = [
      [{}, "export default {setup(){throw new Error('setup failed')}}"],
      [{ requires: ["missing@1"] }, undefined],
      [{ permissions: ["http.route", "secrets.read"] }, undefined],
      [
        {},
        "export default {setup(h){h.provide('test.value@1',()=>1);h.route({method:'GET',path:'/occupied',access:'public',handle:()=>new Response('bad')})}}",
      ],
    ];
    for (let i = 0; i < cases.length; i++) {
      const [extra, source] = cases[i]!;
      const candidate = await packageAt(
        f.directory,
        "bad" + i,
        "bad",
        extra,
        source,
      );
      const version = f.kernel.graphVersion;
      await expect(
        f.kernel.replace("test.update", candidate, { grants: ["http.route"] }),
      ).rejects.toThrow();
      expect(f.kernel.graphVersion).toBe(version);
      expect(await f.kernel.invoke("test.value@1")).toBe("old");
    }
    const candidate = await packageAt(f.directory, "persistence", "new");
    await expect(
      f.kernel.replace(
        "test.update",
        candidate,
        { grants: ["http.route"] },
        async () => {
          throw Error("disk full");
        },
      ),
    ).rejects.toThrow("disk full");
    expect(await f.kernel.invoke("test.value@1")).toBe("old");
    expect(f.kernel.list().find((p) => p.id === "test.update")!.path).toBe(old);
  } finally {
    await f.close();
  }
});
it("persists an authorized update in a separate immutable directory and loads it after host restart", async () => {
  const f = await fixture(["users", "auth"]);
  try {
    const old = await packageAt(f.directory, "old", "old");
    const entry = { path: old, grants: ["http.route"], config: {} };
    await f.kernel.add(old, entry);
    await f.kernel.enable("test.update");
    f.config.plugins.push(entry);
    await writeConfig(f.file, f.config);
    const next = await packageAt(f.directory, "next", "new", {
      version: "1.1.0",
    });
    const revision = f.kernel
      .list()
      .find((p) => p.id === "test.update")!.revision;
    const body = {
      id: "test.update",
      path: next,
      revision,
      reason: "Validated plugin release",
    };
    const denied = await f.request("/api/host/update", "POST", body);
    expect(denied.status).toBe(401);
    await denied.text();
    const admin = await f.admin();
    const key = await (
      await f.request(
        "/api/plugins/official.auth/keys",
        "POST",
        { name: "admin-key" },
        admin,
      )
    ).json();
    const keyDenied = await f.request("/api/host/update", "POST", body, {
      authorization: "Bearer " + key.token,
    });
    expect(keyDenied.status).toBe(403);
    await keyDenied.text();
    const csrf = await f.request("/api/host/update", "POST", body, {
      ...admin,
      origin: "https://wrong.example",
    });
    expect(csrf.status).toBe(403);
    await csrf.text();
    const ok = await f.request("/api/host/update", "POST", body, admin);
    expect(ok.status, await ok.clone().text()).toBe(200);
    await ok.json();
    expect(await f.kernel.invoke("test.value@1")).toBe("new");
    const config = JSON.parse(await readFile(f.file, "utf8")),
      installed = config.plugins.find((p: any) =>
        p.path.includes("plugin-releases"),
      );
    expect(installed.integrity).toMatch(/^[a-f0-9]{64}$/);
    expect(installed.path).not.toBe(next);
    expect(installed.path).not.toBe(old);
    expect(await readFile(join(old, "value.mjs"), "utf8")).toContain("old");
    const stale = await f.request("/api/host/update", "POST", body, admin);
    expect(stale.status).toBe(409);
    await stale.text();
    await f.kernel.shutdown();
    const restored = await createKernel(config);
    try {
      await restored.start();
      expect(await restored.invoke("test.value@1")).toBe("new");
    } finally {
      await restored.shutdown();
    }
    expect(
      (await readdir(join(f.directory, ".pluhub/plugin-releases"))).length,
    ).toBe(1);
  } finally {
    await f.close();
  }
});
it("rejects upgrades of plugins that require restart and retains the previous config after an invalid package", async () => {
  const f = await fixture(["users", "auth"]);
  try {
    const admin = await f.admin(),
      before = await readFile(f.file, "utf8");
    const auth = f.kernel.list().find((p) => p.id === "official.auth")!;
    const protectedUpdate = await f.request(
      "/api/host/update",
      "POST",
      {
        id: auth.id,
        revision: auth.revision,
        path: f.directory,
        reason: "test",
      },
      admin,
    );
    expect(protectedUpdate.status).toBe(409);
    await protectedUpdate.text();
    expect(await readFile(f.file, "utf8")).toBe(before);
    const old = await packageAt(f.directory, "old", "old");
    const entry = { path: old, grants: ["http.route"] };
    await f.kernel.add(old, entry);
    await f.kernel.enable("test.update");
    f.config.plugins.push(entry);
    await writeConfig(f.file, f.config);
    const invalid = await packageAt(f.directory, "invalid", "bad", {
      id: "test.wrong",
    });
    const version = f.kernel.list().find((p) => p.id === "test.update")!;
    const saved = await readFile(f.file, "utf8");
    const failed = await f.request(
      "/api/host/update",
      "POST",
      {
        id: version.id,
        revision: version.revision,
        path: invalid,
        reason: "test failure",
      },
      admin,
    );
    expect(failed.status).toBe(409);
    await failed.text();
    expect(await readFile(f.file, "utf8")).toBe(saved);
    expect(await f.kernel.invoke("test.value@1")).toBe("old");
    expect(await readdir(join(f.directory, ".pluhub/plugin-releases"))).toEqual(
      [],
    );
  } finally {
    await f.close();
  }
});
it("replaces process plugins through a fresh stdio handshake without restarting the host", async () => {
  const f = await mockHost();
  try {
    const source = (value: string) =>
      `import readline from 'node:readline';readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result=m.method==='plugin.initialize'?{protocolVersion:1,capabilities:['test.value@1']}:m.method==='plugin.health'?{ready:true}:m.method==='capability.invoke'?${JSON.stringify(value)}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+String.fromCharCode(10));if(m.method==='plugin.stop')setTimeout(()=>process.exit(0),10)});`;
    const extra = {
      runtime: { kind: "process", entry: "index.js" },
      permissions: [],
    };
    const old = await packageAt(
      f.directory,
      "process-old",
      "old",
      extra,
      source("old"),
    );
    await f.kernel.add(old, { grants: [] });
    await f.kernel.start();
    expect(await f.kernel.invoke("test.value@1")).toBe("old");
    const next = await packageAt(
      f.directory,
      "process-new",
      "new",
      { ...extra, version: "1.1.0" },
      source("new"),
    );
    await f.kernel.replace("test.update", next, { grants: [] });
    expect(await f.kernel.invoke("test.value@1")).toBe("new");
  } finally {
    await f.close();
  }
});
