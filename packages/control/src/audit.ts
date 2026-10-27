import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  createLogSanitizer,
  nonAdminOperationPosts,
  type AdminAudit,
} from "@pluhub/kernel";
import { HostError } from "@pluhub/sdk";

export function auditStore(
  directory: string,
  redact = createLogSanitizer().text,
) {
  const retentionDays = 90;
  const operationClause = `NOT (method='POST' AND path IN (${nonAdminOperationPosts.map(() => "?").join(",")}))`;
  let failures = 0,
    writeFailures = 0,
    lastFaultAt = -Infinity;
  const unavailable = () =>
    new HostError("audit_unavailable", "管理审计存储不可用，请稍后重试。", 503);
  const fault = (writing: boolean) => {
    failures++;
    if (writing) writeFailures++;
    if (Date.now() - lastFaultAt >= 30000) {
      lastFaultAt = Date.now();
      try {
        process.stderr.write(
          '{"level":"error","plugin":"host","message":"Administrator audit storage unavailable"}\n',
        );
      } catch {}
    }
  };
  function open() {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, "admin-audit.sqlite");
    const db = new DatabaseSync(file);
    try {
      chmodSync(file, 0o600);
      db.exec(
        "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS admin_audit(id TEXT PRIMARY KEY,created_at INTEGER NOT NULL,actor_id TEXT NOT NULL,method TEXT NOT NULL,path TEXT NOT NULL,user_id TEXT,resource_id TEXT,status INTEGER,error_code TEXT); CREATE INDEX IF NOT EXISTS audit_time ON admin_audit(created_at); CREATE INDEX IF NOT EXISTS audit_user ON admin_audit(user_id,created_at); CREATE INDEX IF NOT EXISTS audit_actor_time ON admin_audit(actor_id,created_at); CREATE INDEX IF NOT EXISTS audit_pending ON admin_audit(created_at) WHERE status IS NULL;",
      );
      if (
        !(db.prepare("PRAGMA table_info(admin_audit)").all() as any[]).some(
          (column) => column.name === "reason",
        )
      )
        db.exec("ALTER TABLE admin_audit ADD COLUMN reason TEXT");
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }
  function use<T>(writing: boolean, work: (db: DatabaseSync) => T): T {
    let db: DatabaseSync | undefined;
    try {
      db = open();
      return work(db);
    } catch {
      fault(writing);
      throw unavailable();
    } finally {
      db?.close();
    }
  }
  function prune(db: DatabaseSync) {
    db.prepare("DELETE FROM admin_audit WHERE created_at<?").run(
      Date.now() - retentionDays * 86400000,
    );
  }
  function state(db: DatabaseSync) {
    return {
      available: true,
      failures,
      writeFailures,
      retentionDays,
      unresolved: Number(
        (
          db
            .prepare(
              `SELECT COUNT(*) n FROM admin_audit WHERE status IS NULL AND created_at<? AND ${operationClause}`,
            )
            .get(Date.now() - 300000, ...nonAdminOperationPosts) as {
            n: number;
          }
        ).n,
      ),
    };
  }
  return {
    write(entry: AdminAudit) {
      entry = {
        ...entry,
        actorId: redact(entry.actorId, 256),
        path: redact(entry.path, 512),
        userId: entry.userId ? redact(entry.userId, 256) : undefined,
        resourceId: entry.resourceId
          ? redact(entry.resourceId, 256)
          : undefined,
        reason: entry.reason ? redact(entry.reason, 256) : undefined,
        errorCode: entry.errorCode ? redact(entry.errorCode, 64) : undefined,
      };
      use(true, (db) => {
        db.exec("BEGIN IMMEDIATE");
        try {
          prune(db);
          db.prepare(
            "INSERT INTO admin_audit(id,created_at,actor_id,method,path,user_id,resource_id,status,error_code,reason) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id,resource_id=excluded.resource_id,status=excluded.status,error_code=excluded.error_code,reason=excluded.reason",
          ).run(
            entry.id,
            entry.createdAt,
            entry.actorId,
            entry.method,
            entry.path,
            entry.userId ?? null,
            entry.resourceId ?? null,
            entry.status ?? null,
            entry.errorCode ?? null,
            entry.reason ?? null,
          );
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      });
    },
    status() {
      try {
        return use(false, (db) => {
          prune(db);
          return state(db);
        });
      } catch {
        return {
          available: false,
          failures,
          writeFailures,
          retentionDays,
          unresolved: null,
        };
      }
    },
    read(query: URLSearchParams) {
      const limit = Number(query.get("limit") ?? 20),
        offset = Number(query.get("offset") ?? 0);
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        !Number.isSafeInteger(offset) ||
        offset < 0
      )
        throw new HostError("invalid_request", "Invalid audit pagination");
      const where: string[] = [operationClause],
        values: (string | number)[] = [...nonAdminOperationPosts];
      const filter = (key: string, max = 256) => {
        const value = query.get(key) ?? "";
        if (value.length > max || /[\u0000-\u001f\u007f]/.test(value))
          throw new HostError("invalid_request", "Invalid audit filter");
        return value;
      };
      const user = filter("userId"),
        actor = filter("actorId"),
        requestId = filter("requestId", 128),
        result = filter("result", 16),
        method = filter("method", 16),
        q = filter("q");
      if (user) {
        where.push("user_id=?");
        values.push(user);
      }
      if (actor) {
        where.push("actor_id=?");
        values.push(actor);
      }
      if (requestId) {
        where.push("id=?");
        values.push(requestId);
      }
      if (method) {
        if (!/^[A-Z]{1,16}$/.test(method))
          throw new HostError("invalid_request", "Invalid audit method");
        where.push("method=?");
        values.push(method);
      }
      if (result) {
        const clause = new Map([
          ["success", "status>=200 AND status<400"],
          ["failure", "status>=400"],
          ["pending", "status IS NULL"],
        ]).get(result);
        if (!clause)
          throw new HostError("invalid_request", "Invalid audit result");
        where.push("(" + clause + ")");
      }
      const time = (key: string) => {
        const value = filter(key, 16);
        if (!value) return;
        const number = Number(value);
        if (
          !/^\d+$/.test(value) ||
          !Number.isSafeInteger(number) ||
          number > 8640000000000000
        )
          throw new HostError("invalid_request", "Invalid audit time range");
        where.push("created_at" + (key === "from" ? ">=?" : "<=?"));
        values.push(number);
        return number;
      };
      const from = time("from"),
        to = time("to");
      if (from !== undefined && to !== undefined && from > to)
        throw new HostError("invalid_request", "Invalid audit time range");
      if (q) {
        const literal = "%" + q.replace(/[\\%_]/g, "\\$&") + "%";
        where.push(
          "(path LIKE ? ESCAPE '\\' OR resource_id LIKE ? ESCAPE '\\')",
        );
        values.push(literal, literal);
      }
      const clause = where.length ? " WHERE " + where.join(" AND ") : "";
      return use(false, (db) => {
        prune(db);
        return {
          ...state(db),
          total: Number(
            (
              db
                .prepare("SELECT COUNT(*) n FROM admin_audit" + clause)
                .get(...values) as any
            ).n,
          ),
          items: db
            .prepare(
              "SELECT * FROM admin_audit" +
                clause +
                " ORDER BY created_at DESC,id LIMIT ? OFFSET ?",
            )
            .all(...values, limit, offset)
            .map((row) => ({
              ...row,
              actor_id: redact(row.actor_id, 256),
              path: redact(row.path, 512),
              user_id: row.user_id === null ? null : redact(row.user_id, 256),
              resource_id:
                row.resource_id === null ? null : redact(row.resource_id, 256),
              reason: row.reason === null ? null : redact(row.reason, 256),
              error_code:
                row.error_code === null ? null : redact(row.error_code, 64),
            })),
        };
      });
    },
  };
}
