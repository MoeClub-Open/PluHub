import { createReadStream } from "node:fs";
import {
  copyFile,
  lstat,
  readFile,
  writeFile,
  mkdtemp,
  mkdir,
  rm,
  link,
  unlink,
  stat,
  readdir,
  open,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, relative, dirname, join, isAbsolute } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { encryptBackup, decryptBackupFile } from "./backup-format.mjs";

export function backupPacket(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.key !== "string"
  )
    throw Error("Invalid backup request");
  const key = Buffer.from(value.key, "base64");
  if (key.toString("base64") !== value.key || key.length !== 32)
    throw Error("Invalid backup key");
  return { key, imageId: value.imageId, environment: value.environment };
}

async function regular(file, optional = false) {
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if (optional && error.code === "ENOENT") return false;
    throw error;
  }
  if (!info.isFile()) throw Error("Backup refuses non-regular files");
  return true;
}

async function tree(directory, excluded, outputDirectory, base = directory) {
  const directoryInfo = await stat(directory);
  if (
    directoryInfo.dev === outputDirectory.dev &&
    directoryInfo.ino === outputDirectory.ino
  )
    throw Error("Backup output cannot be inside the data directory");
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (excluded.has(relative(base, file))) continue;
    if (entry.isDirectory()) await tree(file, excluded, outputDirectory, base);
    else if (!entry.isFile())
      throw Error("Backup refuses symbolic links and special files");
  }
}

function environmentValues(values) {
  if (!Array.isArray(values) || values.length > 1024)
    throw Error("Invalid backup environment");
  const names = new Set();
  for (const value of values) {
    if (
      typeof value !== "string" ||
      value.includes("\x00") ||
      value.length > 131072
    )
      throw Error("Invalid backup environment");
    const at = value.indexOf("="),
      name = value.slice(0, at);
    if (at < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || names.has(name))
      throw Error("Invalid backup environment");
    names.add(name);
  }
  return values;
}

export async function createBackupBundle({
  dataDirectory,
  configFile,
  deploymentDirectory,
  output,
  key,
  imageId,
  environment,
  signal,
}) {
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId ?? ""))
    throw Error("Backup requires an immutable image ID");
  environment = environmentValues(environment);
  const root = resolve(dataDirectory),
    configPath = relative(root, resolve(configFile));
  if (!configPath || configPath.startsWith("..") || isAbsolute(configPath))
    throw Error("Backup config must be inside the data directory");
  const config = JSON.parse(await readFile(configFile, "utf8"));
  const statePath = relative(
    root,
    resolve(dirname(configFile), config.dataDir),
  );
  if (statePath.startsWith("..") || isAbsolute(statePath))
    throw Error("Backup state must be inside the data directory");
  const excluded = new Set([configPath + ".lock", configPath + ".pid"]);
  await tree(root, excluded, await stat(dirname(output)));
  await regular(join(deploymentDirectory, "compose.yaml"));
  const withEnv = await regular(join(deploymentDirectory, ".env"), true);
  const temporary = await mkdtemp(join(tmpdir(), "pluhub-bundle-"));
  const staging = join(
    dirname(output),
    ".pluhub-bundle-" + randomBytes(16).toString("hex"),
  );
  let child,
    complete,
    encrypted,
    stagingCreated = false;
  try {
    const metadata = join(temporary, "deployment");
    await mkdir(metadata, { mode: 0o700 });
    await copyFile(
      join(deploymentDirectory, "compose.yaml"),
      join(metadata, "compose.yaml"),
    );
    if (withEnv)
      await copyFile(join(deploymentDirectory, ".env"), join(metadata, ".env"));
    await writeFile(
      join(metadata, "runtime-environment.json"),
      JSON.stringify(environment) + "\n",
      { mode: 0o600 },
    );
    await writeFile(
      join(metadata, "manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        consistency: "offline",
        createdAt: new Date().toISOString(),
        imageId,
        config: configPath.replaceAll("\\", "/"),
        environmentFile: withEnv,
        runtimeEnvironment: true,
      }) + "\n",
      { mode: 0o600 },
    );
    child = spawn(
      "tar",
      [
        "--format=pax",
        "--transform=s,^\\./,data/,",
        "--transform=s,^\\.$,data,",
        ...[...excluded].map(
          (file) => "--exclude=./" + file.replaceAll("\\", "/"),
        ),
        "-czf",
        "-",
        "-C",
        root,
        ".",
        "-C",
        temporary,
        "deployment",
      ],
      { stdio: ["ignore", "pipe", "ignore"], signal },
    );
    complete = new Promise((done, reject) => {
      child.once("error", reject);
      child.once("close", (code) =>
        code === 0 ? done() : reject(Error("Backup archive creation failed")),
      );
    });
    encrypted = encryptBackup(child.stdout, staging, key, signal).then(() => {
      stagingCreated = true;
    });
    await Promise.all([encrypted, complete]);
    signal?.throwIfAborted();
    const hash = createHash("sha256");
    for await (const bytes of createReadStream(staging, { signal }))
      hash.update(bytes);
    const bytes = (await stat(staging)).size;
    await link(staging, output);
    if (process.platform !== "win32") {
      const directory = await open(dirname(output), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
    return {
      schemaVersion: 1,
      encrypted: true,
      imageId,
      bytes,
      sha256: hash.digest("hex"),
    };
  } finally {
    if (child && child.exitCode === null) child.kill("SIGTERM");
    await complete?.catch(() => {});
    await encrypted?.catch(() => {});
    if (stagingCreated)
      await unlink(staging).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    await rm(temporary, { recursive: true, force: true });
  }
}

async function packet() {
  let size = 0;
  const chunks = [];
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw Error("Backup request is too large");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  try {
    return backupPacket(JSON.parse(bytes.toString("utf8")));
  } finally {
    bytes.fill(0);
  }
}

export async function runBackupCommand(command, args, configFile) {
  const values = new Map();
  for (let n = 0; n < args.length; n += 2) {
    if (
      !["--output", "--input", "--deployment"].includes(args[n]) ||
      !args[n + 1] ||
      values.has(args[n])
    )
      throw Error("Invalid backup arguments");
    values.set(args[n], args[n + 1]);
  }
  const output = values.get("--output");
  if (!output || dirname(resolve(output)) !== "/backups")
    throw Error("Backup output must be inside /backups");
  const input = await packet();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, cancel);
  try {
    let result;
    if (command === "backup-decrypt") {
      if (!values.get("--input") || values.has("--deployment"))
        throw Error("Invalid backup arguments");
      await decryptBackupFile(
        values.get("--input"),
        output,
        input.key,
        controller.signal,
      );
      result = { authenticated: true };
    } else {
      if (!values.get("--deployment") || values.has("--input"))
        throw Error("Invalid backup arguments");
      const { verifyData } =
        await import("/opt/pluhub/node_modules/@pluhub/cli/dist/verify-data.js");
      const config = JSON.parse(await readFile(configFile, "utf8"));
      config.dataDir = resolve(dirname(configFile), config.dataDir);
      await verifyData(config);
      result = await createBackupBundle({
        dataDirectory: "/data",
        configFile,
        deploymentDirectory: values.get("--deployment"),
        output,
        ...input,
        signal: controller.signal,
      });
    }
    process.stdout.write(JSON.stringify(result) + "\n");
  } finally {
    input.key.fill(0);
    for (const signal of ["SIGTERM", "SIGINT"]) process.off(signal, cancel);
  }
}
