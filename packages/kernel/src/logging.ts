import { randomUUID } from "node:crypto";
export type LogLevel = "info" | "warn" | "error";
export interface RuntimeLog {
  id: string;
  time: number;
  level: LogLevel;
  plugin: string;
  message: string;
  requestId?: string;
  method?: string;
  path?: string;
  status?: number;
  code?: string;
  durationMs?: number;
  graphVersion?: number;
}
export function logLevel(value: unknown): LogLevel {
  return value === "error" || value === "warn" ? value : "info";
}
/** No request bodies or headers enter this logger. Free text is bounded and scrubbed before either sink. */
export function createLogSanitizer() {
  const secrets = new Set<string>();
  for (const [key, value] of Object.entries(process.env))
    if (
      /(?:KEY|TOKEN|PASSWORD|SECRET|COOKIE|CREDENTIAL)/i.test(key) &&
      value &&
      value.length >= 6
    )
      secrets.add(value);
  function register(value: string) {
    if (value.length >= 6) secrets.add(value);
  }
  function text(value: unknown, limit = 2048): string {
    let result = String(value ?? "");
    for (const secret of secrets)
      result = result.split(secret).join("[REDACTED]");
    result = result
      .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "[REDACTED]")
      .replace(/(?:sk-|ph_)[A-Za-z0-9_-]{8,}/g, "[REDACTED]")
      .replace(
        /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
        "[REDACTED]",
      )
      .replace(
        /((?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|cookie|code[_-]?verifier)["']?\s*[:=]\s*)(?:\[REDACTED\]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;"'}\]]+)/gi,
        "$1[REDACTED]",
      )
      .replace(/https?:\/\/[^\s"'<>]+/gi, (raw) => {
        try {
          const url = new URL(raw);
          url.username = "";
          url.password = "";
          url.search = "";
          url.hash = "";
          return url.href;
        } catch {
          return "[URL]";
        }
      })
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
      .replace(/[\u0000-\u001f\u007f]/g, " ");
    return result.length > limit ? result.slice(0, limit - 1) + "…" : result;
  }
  return { text, register };
}
export function newLog(
  plugin: string,
  level: unknown,
  message: string,
): RuntimeLog {
  return {
    id: randomUUID(),
    time: Date.now(),
    plugin,
    level: logLevel(level),
    message,
  };
}
