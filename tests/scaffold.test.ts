import { it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { readFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { mockHost } from "../packages/testkit/dist/index.js";
it("builds and runs a generated full-stack plugin using only public SDK imports", async () => {
  const f = await mockHost();
  await mkdir(resolve(".pluhub"), { recursive: true });
  const parent = await mkdtemp(resolve(".pluhub/scaffold-test-"));
  try {
    const directory = join(parent, "generated");
    let result = spawnSync(
      process.execPath,
      [
        resolve("apps/cli/dist/index.js"),
        "create-plugin",
        directory,
        "--id",
        "example.generated",
      ],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr + result.stdout).toBe(0);
    const pnpm = process.env.npm_execpath;
    if (!pnpm) throw new Error("Run test via pnpm test");
    result = spawnSync(
      process.execPath,
      [
        pnpm,
        "install",
        "--prefer-offline",
        "--store-dir",
        dirname(
          spawnSync(process.execPath, [pnpm, "store", "path"], {
            cwd: process.cwd(),
            encoding: "utf8",
          }).stdout.trim(),
        ),
      ],
      { cwd: directory, encoding: "utf8" },
    );
    expect(result.status, result.stderr + result.stdout).toBe(0);
    result = spawnSync(process.execPath, [pnpm, "build"], {
      cwd: directory,
      encoding: "utf8",
    });
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(await readFile(join(directory, "src/index.ts"), "utf8")).toContain(
      "from '@pluhub/sdk'",
    );
    await f.kernel.add(directory, { grants: ["api.register"] });
    await f.kernel.start();
    expect(await f.kernel.invoke("example.generated@1", { ok: true })).toEqual({
      hello: { ok: true },
    });
    const response = await f.kernel.fetch(
      new Request("http://test/api/plugins/example.generated/hello"),
    );
    expect(await response.json()).toEqual({
      message: "Hello from example.generated",
    });
    const extensions = f.kernel.extensions() as any[];
    expect(extensions[0].id).toBe("example.generated");
    expect(f.kernel.slots()).toEqual([
      expect.objectContaining({ slot: "dashboard.top" }),
    ]);
    const asset = await f.kernel.fetch(
      new Request("http://test" + extensions[0].url),
    );
    expect(asset.headers.get("content-type")).toContain("javascript");
    await asset.text();
    await f.kernel.stop("example.generated");
    expect(f.kernel.extensions()).toEqual([]);
    expect(f.kernel.slots()).toEqual([]);
  } finally {
    await f.close();
    await rm(parent, { recursive: true, force: true, maxRetries: 5 });
  }
}, 120000);
