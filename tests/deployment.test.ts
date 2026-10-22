import { it, expect } from "vitest";
import { spawn } from "node:child_process";
import { readFile, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fixture } from "./helpers.js";
import { defaultPluginNames } from "../apps/cli/dist/presets.js";

it("keeps init and example defaults aligned without redundant compatibility adapters", async () => {
  const f = await fixture(["users"]);
  try {
    const file = resolve(f.directory, "fresh.json");
    const result = await new Promise<number | null>((done, reject) => {
      const child = spawn(
        process.execPath,
        [resolve("apps/cli/dist/index.js"), "init", "--config", file],
        { stdio: "ignore" },
      );
      child.on("error", reject);
      child.on("exit", done);
    });
    expect(result).toBe(0);
    const config = JSON.parse(await readFile(file, "utf8"));
    const names = config.plugins.map((p: any) =>
      p.path.replaceAll("\\", "/").split("/").pop(),
    );
    expect(names).toEqual(defaultPluginNames);
    expect(new Set(names).size).toBe(names.length);
    expect(names).not.toContain("workflow");
    expect(names).not.toContain("protocol-converter");
    const example = JSON.parse(await readFile("pluhub.example.json", "utf8"));
    expect(
      example.plugins.map((p: any) => p.path.split("/").pop()).sort(),
    ).toEqual([...defaultPluginNames].sort());
  } finally {
    await f.close();
  }
});

function cli(file: string, origin: string) {
  return new Promise<{ code: number | null; output: string }>(
    (done, reject) => {
      const child = spawn(process.execPath, [
        resolve("apps/cli/dist/index.js"),
        "set-public-origin",
        origin,
        "--config",
        file,
      ]);
      let output = "";
      child.stdout.on("data", (data) => {
        output += data;
      });
      child.stderr.on("data", (data) => {
        output += data;
      });
      child.on("error", reject);
      child.on("exit", (code) => done({ code, output }));
    },
  );
}

it("changes the proxy origin and cookie policy offline without changing other settings", async () => {
  const f = await fixture(["listener", "users", "auth", "console"]);
  try {
    await f.kernel.shutdown();
    const before = JSON.parse(await readFile(f.file, "utf8"));
    expect((await cli(f.file, "https://hub.example/")).code).toBe(0);
    const after = JSON.parse(await readFile(f.file, "utf8"));
    const expected = structuredClone(before);
    expected.plugins.find((p: any) =>
      p.path.endsWith("listener"),
    ).config.publicOrigin = "https://hub.example";
    expected.plugins.find((p: any) =>
      p.path.endsWith("auth"),
    ).config.secureCookie = true;
    expect(after).toEqual(expected);
    expect((await cli(f.file, "http://127.0.0.1:18088")).code).toBe(0);
    expect(
      JSON.parse(await readFile(f.file, "utf8")).plugins.find((p: any) =>
        p.path.endsWith("auth"),
      ).config.secureCookie,
    ).toBe(false);
  } finally {
    await f.close();
  }
});

it("rejects unsafe origins, a running host and incompatible Passkey settings without writing", async () => {
  const f = await fixture(["listener", "users", "auth"]);
  try {
    await f.kernel.shutdown();
    const before = await readFile(f.file, "utf8");
    for (const origin of [
      "https://user:pass@host",
      "https://host/path",
      "https://host?x=1",
      "https://host#x",
      "file:///tmp",
      "invalid",
    ])
      expect((await cli(f.file, origin)).code).toBe(1);
    expect(await readFile(f.file, "utf8")).toBe(before);
    await writeFile(f.file + ".pid", String(process.pid));
    expect((await cli(f.file, "https://hub.example")).output).toContain(
      "Host is running",
    );
    await rm(f.file + ".pid");
    const configured = JSON.parse(before);
    configured.plugins.find((p: any) =>
      p.path.endsWith("auth"),
    ).config.webauthn = {
      enabled: true,
      rpID: "old.example",
      origins: ["https://old.example"],
    };
    await writeFile(f.file, JSON.stringify(configured));
    const locked = await readFile(f.file, "utf8");
    expect((await cli(f.file, "https://hub.example")).output).toContain(
      "WebAuthn RP ID",
    );
    expect(await readFile(f.file, "utf8")).toBe(locked);
  } finally {
    await f.close();
  }
});
