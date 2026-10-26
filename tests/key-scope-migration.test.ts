import { it, expect } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migratePluginBoundaries } from "../deploy/migrations/plugin-boundaries.ts";

async function setup(mixed = false) {
  const directory = await mkdtemp(join(tmpdir(), "pluhub-scope-migration-"));
  const file = join(directory, "pluhub.json");
  const data = join(directory, "data/official.auth");
  await mkdir(data, { recursive: true });
  const database = join(data, "auth.sqlite");
  const db = new DatabaseSync(database);
  db.exec(
    "CREATE TABLE api_keys(id TEXT PRIMARY KEY,user_id TEXT,channel_ids_json TEXT,group_id TEXT)",
  );
  const add = db.prepare("INSERT INTO api_keys VALUES(?,?,?,NULL)");
  add.run(
    "a",
    "u1",
    JSON.stringify(mixed ? ["platform", "personal:u1:c"] : ["platform"]),
  );
  add.run("b", "u2", '["platform"]');
  add.run("p", "u1", '["personal:u1:c"]');
  db.close();
  await writeFile(
    file,
    JSON.stringify({
      schemaVersion: 1,
      dataDir: "data",
      bindings: {
        "ai.output-pace@1": "official.token-speed",
        "ai.upstream.auto-router@1": "official.auto-router",
      },
      plugins: [
        {
          path: resolve("../PluHub-Plugins/plugins/ai-router"),
          grants: [],
          config: {
            upstreams: {
              platform: {
                flow: {
                  entry: "s",
                  nodes: [
                    { id: "s", type: "start", next: "p" },
                    { id: "p", type: "provider" },
                  ],
                },
              },
            },
            models: {},
          },
        },
        {
          path: resolve("../PluHub-Plugins/plugins/rate-limit"),
          enabled: false,
          grants: [],
        },
        {
          path: resolve("../PluHub-Plugins/plugins/ingress-openai-chat"),
          grants: [],
        },
      ],
    }),
  );
  return {
    file,
    database,
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

it("previews and migrates key scopes without widening channels, then remains idempotent", async () => {
  const f = await setup();
  try {
    const original = await readFile(f.file, "utf8");
    expect(await migratePluginBoundaries(f.file, false)).toMatchObject({
      changed: true,
      written: false,
      migratedKeys: 2,
    });
    expect(await readFile(f.file, "utf8")).toBe(original);
    await migratePluginBoundaries(f.file);
    const config = JSON.parse(await readFile(f.file, "utf8"));
    expect(config.plugins[1].enabled).toBe(true);
    expect(config.bindings).toEqual({
      "ai.output-pace@2": "official.token-speed",
    });
    const groups = Object.values(config.plugins[0].config.groups);
    expect(groups).toEqual([
      {
        name: "原渠道授权 · platform",
        multiplier: 1,
        channelIds: ["platform"],
        userIds: ["u1", "u2"],
      },
    ]);
    const db = new DatabaseSync(f.database, { readOnly: true });
    const rows = db
      .prepare("SELECT id,group_id,channel_ids_json FROM api_keys ORDER BY id")
      .all();
    db.close();
    expect(rows).toEqual([
      { id: "a", group_id: "migrated-key-scope-1", channel_ids_json: "[]" },
      { id: "b", group_id: "migrated-key-scope-1", channel_ids_json: "[]" },
      { id: "p", group_id: null, channel_ids_json: '["personal:u1:c"]' },
    ]);
    expect(await migratePluginBoundaries(f.file)).toEqual({
      changed: false,
      written: false,
      migratedKeys: 0,
    });
  } finally {
    await f.close();
  }
});

it("refuses mixed personal/platform scopes before writing either config or keys", async () => {
  const f = await setup(true);
  try {
    const original = await readFile(f.file, "utf8");
    await expect(migratePluginBoundaries(f.file)).rejects.toThrow(
      /拆成两个密钥/,
    );
    expect(await readFile(f.file, "utf8")).toBe(original);
    const db = new DatabaseSync(f.database, { readOnly: true });
    expect(
      db.prepare("SELECT group_id FROM api_keys WHERE id='a'").get()?.group_id,
    ).toBe(null);
    db.close();
  } finally {
    await f.close();
  }
});
