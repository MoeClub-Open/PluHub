import { it, expect } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migratePluginBoundaries } from "../deploy/migrations/plugin-boundaries.ts";

it("persists condition node migration without losing connections or unrelated channel settings", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "pluhub-condition-migration-"),
  );
  const file = join(directory, "pluhub.json");
  const original = {
    schemaVersion: 1,
    dataDir: "data",
    plugins: [
      {
        path: resolve("../PluHub-Plugins/plugins/ai-router"),
        grants: ["*"],
        config: {
          upstreams: {
            sample: {
              name: "Example",
              flow: {
                entry: "start",
                nodes: [
                  { id: "start", type: "start", next: "check" },
                  {
                    id: "check",
                    type: "condition",
                    test: "model",
                    models: ["gpt-*"],
                    modelSource: "requested",
                    yes: "a",
                    no: "b",
                  },
                  {
                    id: "check-predicate",
                    type: "value",
                    valueType: "string[]",
                    value: ["other"],
                  },
                  { id: "a", type: "provider" },
                  { id: "b", type: "provider" },
                ],
                bindings: [
                  {
                    source: "check-predicate",
                    output: "value",
                    target: "check",
                    input: "models",
                  },
                ],
                layout: { check: { x: 500, y: 200 } },
              },
            },
          },
          models: {
            alias: { upstream: "sample", model: "vendor", inputPrice: 2 },
          },
        },
      },
    ],
  };
  try {
    const initial = JSON.stringify(original);
    await writeFile(file, initial);
    expect((await migratePluginBoundaries(file, false)).changed).toBe(true);
    expect(await readFile(file, "utf8")).toBe(initial);
    expect((await migratePluginBoundaries(file)).written).toBe(true);
    const migrated = JSON.parse(await readFile(file, "utf8"));
    const router = migrated.plugins[0].config;
    const flow = router.upstreams.sample.flow;
    expect(router.models).toEqual(original.plugins[0].config.models);
    expect(router.upstreams.sample.name).toBe("Example");
    expect(flow.nodes).toEqual(
      expect.arrayContaining([
        { id: "check", type: "branch", condition: false, yes: "a", no: "b" },
        {
          id: "check-predicate-1",
          type: "predicate",
          test: "model",
          models: ["gpt-*"],
          modelSource: "requested",
        },
      ]),
    );
    expect(flow.bindings).toEqual([
      {
        source: "check-predicate",
        output: "value",
        target: "check-predicate-1",
        input: "models",
      },
      {
        source: "check-predicate-1",
        output: "result",
        target: "check",
        input: "condition",
      },
    ]);
    expect(flow.layout).toEqual({
      check: { x: 500, y: 200 },
      "check-predicate-1": { x: 130, y: 200 },
    });
    const backup = (await readdir(directory)).find((name) =>
      name.startsWith("pluhub.json.pre-plugin-boundaries-"),
    );
    expect(backup && (await readFile(join(directory, backup), "utf8"))).toBe(
      initial,
    );
    expect(await migratePluginBoundaries(file)).toMatchObject({
      changed: false,
      written: false,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
