import { expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migratePluginBoundaries } from "../deploy/migrations/plugin-boundaries.ts";

it("grants the official router its workflow permissions once when upgrading", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pluhub-workflow-grants-"));
  const file = join(directory, "pluhub.json");
  const original = JSON.stringify({
    schemaVersion: 1,
    dataDir: "data",
    plugins: [
      {
        path: resolve("../PluHub-Plugins/plugins/ai-router"),
        grants: ["api.register", "http.route", "http.dispatch"],
        config: { upstreams: {}, models: {} },
      },
    ],
  });
  try {
    await writeFile(file, original);
    await writeFile(
      file + ".plugin-boundaries.json",
      JSON.stringify({ version: 2 }),
    );
    expect((await migratePluginBoundaries(file, false)).changed).toBe(true);
    expect(await readFile(file, "utf8")).toBe(original);
    await migratePluginBoundaries(file);
    const migrated = JSON.parse(await readFile(file, "utf8"));
    expect(migrated.plugins[0].grants).toEqual([
      "api.register",
      "http.route",
      "http.dispatch",
      "http.dispatch.child",
      "secrets.read",
      "hooks.register",
    ]);
    expect(
      JSON.parse(await readFile(file + ".plugin-boundaries.json", "utf8")),
    ).toEqual({ version: 3 });
    const backup = (await readdir(directory)).find((name) =>
      name.startsWith("pluhub.json.pre-plugin-boundaries-"),
    );
    expect(backup && (await readFile(join(directory, backup), "utf8"))).toBe(
      original,
    );
    expect(await migratePluginBoundaries(file)).toMatchObject({
      changed: false,
      written: false,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
