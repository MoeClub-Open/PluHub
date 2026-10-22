import { it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { migrateSubscriptions } from "../../PluHub-Plugins/tools/migrate-subscriptions.mjs";
const kinds = ["codex", "claude-subscription", "antigravity"];
function encrypt(id: string, provider: string, owner: string, key: Buffer) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(
    Buffer.from(JSON.stringify(owner ? [id, provider, owner] : [id, provider])),
  );
  return Buffer.concat([
    iv,
    cipher.update(JSON.stringify({ access_token: "secret-" + provider })),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
}
async function migrationFixture() {
  const dir = await mkdtemp(join(tmpdir(), "pluhub-subscription-migration-")),
    data = join(dir, "data"),
    source = join(data, "official.subscription-accounts"),
    legacy = join(dir, "legacy"),
    file = join(dir, "pluhub.json");
  await mkdir(source, { recursive: true });
  await mkdir(legacy);
  await writeFile(
    join(legacy, "manifest.json"),
    JSON.stringify({ id: "official.subscription-accounts" }),
  );
  const config: any = {
    schemaVersion: 1,
    dataDir: data,
    plugins: [
      {
        path: legacy,
        grants: [],
        config: { oauth: { codex: { clientId: "custom-codex" } } },
      },
    ],
  };
  for (const kind of kinds) {
    const path = resolve("../PluHub-Plugins/plugins/upstream-" + kind),
      manifest = JSON.parse(
        await readFile(join(path, "manifest.json"), "utf8"),
      );
    config.plugins.push({
      path,
      grants: manifest.permissions.filter((p: string) => p !== "api.register"),
      config: { secretRefs: [] },
    });
  }
  await writeFile(file, JSON.stringify(config));
  const key = randomBytes(32);
  await writeFile(join(source, "vault.key"), key);
  const db = new DatabaseSync(join(source, "accounts.sqlite"));
  db.exec(
    "CREATE TABLE accounts(id TEXT PRIMARY KEY,provider TEXT NOT NULL,name TEXT NOT NULL,cipher TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,max_concurrency INTEGER NOT NULL DEFAULT 2,status TEXT NOT NULL DEFAULT 'ready',cooldown_until INTEGER NOT NULL DEFAULT 0,error_code TEXT,last_status INTEGER,last_used INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,quota_json TEXT NOT NULL DEFAULT '[]',quota_updated_at INTEGER,owner_id TEXT NOT NULL DEFAULT ''); CREATE INDEX accounts_owner ON accounts(owner_id); PRAGMA user_version=3;",
  );
  for (const [i, kind] of kinds.entries())
    for (const owner of ["", "user-123"]) {
      const id = kind + "-" + (owner || "platform");
      db.prepare(
        "INSERT INTO accounts(id,provider,name,cipher,owner_id,enabled,status,version,quota_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        id,
        kind,
        kind,
        encrypt(id, kind, owner, key),
        owner,
        i === 1 ? 0 : 1,
        i === 2 ? "forbidden" : "ready",
        7,
        '[{"window":"primary","usedPercent":99}]',
        10,
        20,
      );
    }
  db.close();
  return {
    dir,
    data,
    source,
    legacy,
    file,
    config,
    key,
    close: () => rm(dir, { recursive: true, force: true }),
  };
}
it("splits and reencrypts nonempty platform and personal subscriptions without changing IDs, ownership or state", async () => {
  const f = await migrationFixture();
  try {
    const result = await migrateSubscriptions(
      f.file,
      resolve("../PluHub-Plugins/plugins"),
    );
    expect(result.counts).toEqual({
      codex: 2,
      "claude-subscription": 2,
      antigravity: 2,
    });
    const config = JSON.parse(await readFile(f.file, "utf8"));
    expect(config.plugins).toHaveLength(3);
    expect(config.plugins.some((p: any) => p.path === f.legacy)).toBe(false);
    expect(config.plugins[0].config.oauth.codex.clientId).toBe("custom-codex");
    const keys = [];
    for (const [i, kind] of kinds.entries()) {
      const path = join(f.data, "official.upstream-" + kind),
        key = await readFile(join(path, "vault.key"));
      keys.push(key.toString("hex"));
      expect(key.equals(f.key)).toBe(false);
      const db = new DatabaseSync(join(path, "accounts.sqlite"));
      try {
        const rows: any[] = db.prepare("SELECT * FROM accounts").all();
        expect(rows).toHaveLength(2);
        expect(
          rows.every(
            (row) =>
              row.provider === kind &&
              row.version === 7 &&
              row.enabled === (i === 1 ? 0 : 1),
          ),
        ).toBe(true);
        expect(rows.map((row) => row.owner_id).sort()).toEqual([
          "",
          "user-123",
        ]);
        for (const row of rows) {
          const data = Buffer.from(row.cipher, "base64"),
            cipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
          cipher.setAAD(
            Buffer.from(
              JSON.stringify(
                row.owner_id
                  ? [row.id, row.provider, row.owner_id]
                  : [row.id, row.provider],
              ),
            ),
          );
          cipher.setAuthTag(data.subarray(-16));
          expect(
            JSON.parse(
              Buffer.concat([
                cipher.update(data.subarray(12, -16)),
                cipher.final(),
              ]).toString(),
            ).access_token,
          ).toBe("secret-" + kind);
        }
      } finally {
        db.close();
      }
      expect(config.plugins[i].grants).toContain("api.register");
    }
    expect(new Set(keys).size).toBe(3);
    expect(
      (await migrateSubscriptions(f.file, resolve("../PluHub-Plugins/plugins")))
        .migrated,
    ).toBe(false);
    expect(await readFile(join(f.source, "vault.key"))).toEqual(f.key);
  } finally {
    await f.close();
  }
});
it("preserves legacy configuration and target data on migration conflicts or invalid ciphertext", async () => {
  for (const mode of ["conflict", "cipher"]) {
    const f = await migrationFixture();
    try {
      const before = await readFile(f.file, "utf8");
      if (mode === "conflict") {
        const target = join(f.data, "official.upstream-claude-subscription");
        await mkdir(target, { recursive: true });
        await writeFile(join(target, "vault.key"), "preserve");
      } else {
        const db = new DatabaseSync(join(f.source, "accounts.sqlite"));
        db.exec("UPDATE accounts SET cipher='bad'");
        db.close();
      }
      await expect(
        migrateSubscriptions(f.file, resolve("../PluHub-Plugins/plugins")),
      ).rejects.toBeDefined();
      expect(await readFile(f.file, "utf8")).toBe(before);
      if (mode === "conflict")
        expect(
          await readFile(
            join(f.data, "official.upstream-claude-subscription/vault.key"),
            "utf8",
          ),
        ).toBe("preserve");
    } finally {
      await f.close();
    }
  }
});
