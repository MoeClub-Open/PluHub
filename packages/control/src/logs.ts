import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeLog } from "@pluhub/kernel";
import { HostError } from "@pluhub/sdk";

/** Separate operational storage: no prompt, headers, bodies or query strings. */
export function runtimeLogStore(
  directory: string,
  options: { retentionDays?: number; maxRows?: number; sweepMs?: number } = {},
) {
  const retentionDays = options.retentionDays ?? 30;
  const maxRows = options.maxRows ?? 50000;
  let db: DatabaseSync | undefined,
    closed = false,
    retryAt = 0,
    dropped = 0,
    failures = 0,
    rowCount = 0;
  const unavailable = () =>
    new HostError(
      "logs_unavailable",
      "Runtime log storage is unavailable",
      503,
    );
  const fail = () => {
    failures++;
    retryAt = Date.now() + 30000;
    try {
      db?.close();
    } catch {}
    db = undefined;
    try {
      process.stderr.write(
        '{"level":"error","plugin":"host","message":"Runtime log storage unavailable"}\n',
      );
    } catch {}
  };
  function open() {
    if (closed || (!db && Date.now() < retryAt)) throw unavailable();
    if (!db) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const file = join(directory, "runtime-logs.sqlite");
      db = new DatabaseSync(file);
      chmodSync(file, 0o600);
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=100;
        CREATE TABLE IF NOT EXISTS runtime_logs (
          id TEXT PRIMARY KEY, time INTEGER NOT NULL, level TEXT NOT NULL, plugin TEXT NOT NULL,
          message TEXT NOT NULL, requestId TEXT, method TEXT, path TEXT, status INTEGER,
          code TEXT, durationMs INTEGER, graphVersion INTEGER
        );
        CREATE INDEX IF NOT EXISTS runtime_logs_time ON runtime_logs(time);
        CREATE INDEX IF NOT EXISTS runtime_logs_request ON runtime_logs(requestId,time);
        CREATE INDEX IF NOT EXISTS runtime_logs_plugin ON runtime_logs(plugin,time);`);
      rowCount = Number(
        (db.prepare("SELECT COUNT(*) n FROM runtime_logs").get() as any).n,
      );
    }
    return db;
  }
  function prune() {
    const connection = open();
    connection
      .prepare("DELETE FROM runtime_logs WHERE time<?")
      .run(Date.now() - retentionDays * 86400000);
    rowCount = Number(
      (connection.prepare("SELECT COUNT(*) n FROM runtime_logs").get() as any)
        .n,
    );
    trim(connection);
  }
  function trim(connection: DatabaseSync) {
    if (rowCount <= maxRows) return;
    connection
      .prepare(
        "DELETE FROM runtime_logs WHERE rowid IN (SELECT rowid FROM runtime_logs ORDER BY time ASC,rowid ASC LIMIT ?)",
      )
      .run(rowCount - maxRows);
    rowCount = maxRows;
  }
  const startSweep = () =>
    setInterval(() => {
      if (closed || Date.now() < retryAt) return;
      try {
        prune();
      } catch {
        fail();
      }
    }, options.sweepMs ?? 60000);
  let sweep = startSweep();
  sweep.unref();
  try {
    prune();
  } catch {
    fail();
  }
  let writes = 0;
  return {
    start() {
      if (closed) {
        closed = false;
        retryAt = 0;
        sweep = startSweep();
        sweep.unref();
      }
    },
    write(entry: RuntimeLog) {
      if (closed || Date.now() < retryAt) {
        dropped++;
        return;
      }
      try {
        open()
          .prepare("INSERT INTO runtime_logs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)")
          .run(
            entry.id,
            entry.time,
            entry.level,
            entry.plugin,
            entry.message,
            entry.requestId ?? null,
            entry.method ?? null,
            entry.path ?? null,
            entry.status ?? null,
            entry.code ?? null,
            entry.durationMs ?? null,
            entry.graphVersion ?? null,
          );
        rowCount++;
        trim(open());
        // Bounded even under sustained traffic. Retention also runs during idle periods.
        if (++writes % 100 === 0) prune();
      } catch {
        dropped++;
        fail();
      }
    },
    read(query: URLSearchParams) {
      const limit = Number(query.get("limit") ?? 20),
        offset = Number(query.get("offset") ?? 0);
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        !Number.isInteger(offset) ||
        offset < 0 ||
        offset > 50100
      )
        throw new HostError("invalid_request", "Invalid log pagination");
      const where: string[] = [],
        values: (string | number)[] = [];
      for (const key of ["level", "plugin", "requestId"] as const) {
        const value = query.get(key);
        if (!value) continue;
        if (
          value.length > 256 ||
          (key === "level" && !["info", "warn", "error"].includes(value))
        )
          throw new HostError("invalid_request", "Invalid log filter");
        where.push(key + "=?");
        values.push(value);
      }
      for (const [key, op] of [
        ["from", ">="],
        ["to", "<="],
      ]) {
        if (!query.has(key!)) continue;
        const value = Number(query.get(key!));
        if (!Number.isSafeInteger(value) || value < 0)
          throw new HostError("invalid_request", "Invalid log time range");
        where.push("time" + op + "?");
        values.push(value);
      }
      if (
        query.has("from") &&
        query.has("to") &&
        Number(query.get("from")) > Number(query.get("to"))
      )
        throw new HostError("invalid_request", "Invalid log time range");
      const q = query.get("q")?.trim();
      if (q) {
        if (q.length > 256)
          throw new HostError("invalid_request", "Log search is too long");
        where.push(
          "(instr(lower(message),lower(?))>0 OR instr(lower(path),lower(?))>0 OR instr(lower(code),lower(?))>0)",
        );
        values.push(q, q, q);
      }
      try {
        prune();
        const connection = open(),
          sql = where.length ? " WHERE " + where.join(" AND ") : "";
        const total = (
          connection
            .prepare("SELECT COUNT(*) n FROM runtime_logs" + sql)
            .get(...values) as any
        ).n;
        const items = connection
          .prepare(
            "SELECT * FROM runtime_logs" +
              sql +
              " ORDER BY time DESC,rowid DESC LIMIT ? OFFSET ?",
          )
          .all(...values, limit, offset);
        return {
          items,
          total,
          limit,
          offset,
          retentionDays,
          maxRows,
          dropped,
          failures,
        };
      } catch {
        if (!closed && Date.now() >= retryAt) fail();
        throw unavailable();
      }
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(sweep);
      db?.close();
      db = undefined;
    },
  };
}
