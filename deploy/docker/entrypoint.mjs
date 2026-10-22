import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { spawnSync, spawn } from "node:child_process";
const cli = "/opt/pluhub/node_modules/@pluhub/cli/dist/index.js";
const file = process.env.PLUHUB_CONFIG ?? "/data/pluhub.json";
const args = process.argv.slice(2);
if (!args.length) args.push("start");
if (["backup-bundle", "backup-decrypt"].includes(args[0])) {
  try {
    const { runBackupCommand } = await import("./backup-bundle.mjs");
    await runBackupCommand(args[0], args.slice(1), file);
  } catch {
    process.stderr.write(
      "Backup operation failed; no successful receipt was issued.\n",
    );
    process.exitCode = 1;
  }
  process.exit(process.exitCode ?? 0);
}
// The shell entrypoint holds the same exclusive data-volume lock as the server.
// A backup contains SQLite state and encryption keys, but no stale PID or lock.
if (args[0] === "backup-data") {
  if (!existsSync(file) || relative("/data", file).startsWith(".."))
    throw new Error("Backup requires an initialized config inside /data");
  const config = JSON.parse(readFileSync(file, "utf8"));
  if (
    relative("/data", resolve(dirname(file), config.dataDir)).startsWith("..")
  )
    throw new Error("Backup requires the state directory to be inside /data");
  const result = spawnSync(
    "tar",
    [
      "-C",
      "/data",
      "--exclude=./" + relative("/data", file) + ".lock",
      "--exclude=./" + relative("/data", file) + ".pid",
      "-czf",
      "-",
      ".",
    ],
    { stdio: "inherit" },
  );
  process.exit(result.status ?? 1);
}
// Validate before init writes a config; an invalid initial origin must be retryable.
const initialOrigin = process.env.PLUHUB_PUBLIC_ORIGIN;
if (!existsSync(file) && initialOrigin) {
  const url = new URL(initialOrigin);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      "PLUHUB_PUBLIC_ORIGIN must be an HTTP(S) origin without credentials or path",
    );
}
if (!existsSync(file)) {
  mkdirSync(dirname(file), { recursive: true });
  const initialized = spawnSync(
    process.execPath,
    [
      cli,
      "init",
      "--plugins",
      "/opt/pluhub/plugins",
      "--host",
      "0.0.0.0",
      "--config",
      file,
    ],
    { stdio: "inherit" },
  );
  if (initialized.status !== 0) process.exit(initialized.status ?? 1);
  const config = JSON.parse(readFileSync(file, "utf8"));
  config.dataDir = "/data/state";
  const origin = process.env.PLUHUB_PUBLIC_ORIGIN;
  if (origin) {
    config.plugins.find((p) =>
      p.path.endsWith("/listener"),
    ).config.publicOrigin = origin;
    config.plugins.find((p) => p.path.endsWith("/auth")).config.secureCookie =
      new URL(origin).protocol === "https:";
  }
  writeFileSync(file + ".init", JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
  renameSync(file + ".init", file);
}
// The shell entrypoint holds an exclusive flock across container PID namespaces.
// A stale PID from a crashed container cannot identify a process in this namespace.
try {
  unlinkSync(file + ".pid");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (process.env.PLUHUB_ADMIN_PASSWORD_FILE)
  process.env.PLUHUB_ADMIN_PASSWORD = readFileSync(
    process.env.PLUHUB_ADMIN_PASSWORD_FILE,
    "utf8",
  ).replace(/\r?\n$/, "");
const child = spawn(process.execPath, [cli, ...args, "--config", file], {
  stdio: "inherit",
});
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"])
  process.on(signal, () => child.kill(signal));
child.on("error", () => process.exit(1));
child.on("exit", (code, signal) =>
  process.exit(code ?? (signal === "SIGTERM" ? 143 : 1)),
);
