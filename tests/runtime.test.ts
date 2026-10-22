import { it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { writeFile, mkdir, readFile, copyFile, chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import { mockHost } from "../packages/testkit/dist/index.js";
it("runs the Go SDK over stdio, cancels calls and stops the child", async () => {
  const f = await mockHost();
  try {
    await f.plugin(
      {
        schemaVersion: 1,
        id: "example.config",
        version: "1.0.0",
        host: ">=0.1.0-alpha.1",
        runtime: { kind: "native", entry: "index.mjs" },
        provides: ["example.config@1"],
        requires: [],
        optionalRequires: ["example.echo@1"],
        permissions: ["http.route"],
        configReload: "snapshot",
      },
      "export default {setup(h){h.provide('example.config@1',()=>h.config());h.route({method:'GET',path:'/go',access:'public',handle:async(r,c)=>new Response(JSON.stringify(await h.call('example.echo@1',{getHostConfig:true},c.signal)))})}}",
    );
    const path = join(f.directory, "example.go");
    await mkdir(path);
    const entry = process.platform === "win32" ? "echo.exe" : "echo";
    if (process.env.PLUHUB_GO_ECHO) {
      await copyFile(process.env.PLUHUB_GO_ECHO, join(path, entry));
      await chmod(join(path, entry), 0o755);
    } else {
      const build = spawnSync(
        "go",
        ["build", "-o", join(path, entry), "./examples/echo"],
        { cwd: resolve("../PluHub-SDK-Go"), encoding: "utf8" },
      );
      expect(build.status, build.stderr).toBe(0);
    }
    await writeFile(
      join(path, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "example.go",
        version: "1.0.0",
        host: ">=0.1.0-alpha.1",
        runtime: { kind: "process", entry },
        provides: ["example.echo@1"],
        requires: ["example.config@1"],
        permissions: [],
        configReload: "snapshot",
      }),
    );
    await f.kernel.add(path, { grants: [], config: { value: "old" } });
    f.kernel.configure({ "example.config": { value: "old" } });
    await f.kernel.start();
    expect(await f.kernel.invoke("example.echo@1", { hello: "world" })).toEqual(
      { hello: "world" },
    );
    expect(
      await f.kernel.invoke("example.echo@1", { getConfig: true }),
    ).toEqual({ value: "old" });
    f.kernel.configure({ "example.go": { value: "new" } });
    expect(
      await f.kernel.invoke("example.echo@1", { getConfig: true }),
    ).toEqual({ value: "new" });
    const oldResponse = f.kernel.fetch(new Request("http://test/go"));
    f.kernel.configure({ "example.config": { value: "new" } });
    expect(await (await oldResponse).json()).toEqual({ value: "old" });
    expect(
      await (await f.kernel.fetch(new Request("http://test/go"))).json(),
    ).toEqual({ value: "new" });
    const controller = new AbortController();
    const pending = f.kernel.invoke(
      "example.echo@1",
      { wait: true },
      controller.signal,
    );
    setTimeout(() => controller.abort(new Error("client cancel")), 20);
    await expect(pending).rejects.toThrow("client cancel");
    expect(
      await f.kernel.invoke("example.echo@1", { after: "cancel" }),
    ).toEqual({ after: "cancel" });
    await f.kernel.stop("example.go");
    expect(f.kernel.list().find((p) => p.id === "example.go")!.state).toBe(
      "Stopped",
    );
  } finally {
    await f.close();
  }
}, 30000);
it("contains process protocol failures and removes the failed runtime from service", async () => {
  const f = await mockHost();
  try {
    const path = join(f.directory, "example.broken");
    await mkdir(path);
    await writeFile(
      join(path, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "example.broken",
        version: "1.0.0",
        host: ">=0.1.0-alpha.1",
        runtime: { kind: "process", entry: "broken.js" },
        provides: [],
        requires: [],
        permissions: [],
      }),
    );
    await writeFile(
      join(path, "broken.js"),
      "process.stdout.write('not json\\n');setTimeout(()=>process.exit(1),20)",
    );
    await f.kernel.add(path, { grants: [] });
    await expect(f.kernel.start()).rejects.toThrow();
    expect(f.kernel.list()[0]!.state).toBe("Stopped");
  } finally {
    await f.close();
  }
});
