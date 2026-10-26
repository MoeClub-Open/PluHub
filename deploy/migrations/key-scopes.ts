import { chmodSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { HostConfig } from "@pluhub/sdk";
import type { ServiceGroup } from "@pluhub/contracts/ai";

/** Runs offline, before Auth opens its database. Config is saved before applying
 * key updates so a restart can safely finish an interrupted migration. */
export function prepareKeyScopes(
  file: string,
  config: HostConfig,
  router?: Record<string, any>,
) {
  const database = resolve(
    dirname(file),
    config.dataDir,
    "official.auth/auth.sqlite",
  );
  const updates: { id: string; groupId: string }[] = [];
  if (!existsSync(database)) return { count: 0, apply() {} };
  const source = new DatabaseSync(database, { readOnly: true });
  try {
    if (
      !source
        .prepare("PRAGMA table_info(api_keys)")
        .all()
        .some((column) => column.name === "group_id")
    )
      throw new Error("请先升级至支持使用分组的 Auth 版本，再迁移密钥授权。");
    const keys = source
      .prepare(
        "SELECT id,user_id,channel_ids_json FROM api_keys WHERE group_id IS NULL",
      )
      .all() as { id: string; user_id: string; channel_ids_json: string }[];
    const scopes = new Map<string, typeof keys>();
    for (const key of keys) {
      const channels = JSON.parse(key.channel_ids_json) as string[];
      if (!channels.length) {
        updates.push({ id: key.id, groupId: "default" });
        continue;
      }
      if (channels.every((id) => id.startsWith("personal:"))) continue;
      if (channels.some((id) => id.startsWith("personal:")))
        throw new Error(
          `密钥 ${key.id} 同时绑定平台和个人渠道，请先拆成两个密钥。`,
        );
      const scope = JSON.stringify([...new Set(channels)].sort());
      scopes.set(scope, [...(scopes.get(scope) ?? []), key]);
    }
    if (scopes.size && !router)
      throw new Error("平台密钥授权迁移需要 AI Router 配置。");
    if (router && scopes.size) {
      const groups = (router.groups ??= {}) as Record<string, ServiceGroup>;
      for (const [scope, keys] of scopes) {
        const channelIds = JSON.parse(scope) as string[];
        let id = Object.keys(groups).find(
          (id) =>
            id.startsWith("migrated-key-scope-") &&
            JSON.stringify([...(groups[id]!.channelIds ?? [])].sort()) ===
              scope &&
            groups[id]!.multiplier === 1,
        );
        if (!id) {
          let suffix = 1;
          while (Object.hasOwn(groups, "migrated-key-scope-" + suffix))
            suffix++;
          id = "migrated-key-scope-" + suffix;
          groups[id] = {
            name: "原渠道授权 · " + channelIds.join(", "),
            multiplier: 1,
            channelIds,
            userIds: [],
          };
        }
        groups[id]!.userIds = [
          ...new Set([
            ...(groups[id]!.userIds ?? []),
            ...keys.map((key) => key.user_id),
          ]),
        ];
        updates.push(...keys.map((key) => ({ id: key.id, groupId: id! })));
      }
    }
  } finally {
    source.close();
  }
  return {
    count: updates.length,
    apply() {
      if (!updates.length) return;
      const db = new DatabaseSync(database);
      try {
        const backup = database + ".pre-key-scopes-" + Date.now();
        db.prepare("VACUUM INTO ?").run(backup);
        chmodSync(backup, 0o600);
        db.exec("BEGIN IMMEDIATE");
        const update = db.prepare(
          "UPDATE api_keys SET group_id=?,channel_ids_json='[]' WHERE id=? AND group_id IS NULL",
        );
        for (const { id, groupId } of updates) update.run(groupId, id);
        db.exec("COMMIT");
      } finally {
        db.close();
      }
    },
  };
}
