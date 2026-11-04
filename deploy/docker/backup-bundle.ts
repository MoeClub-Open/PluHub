import { createReadStream, type Stats } from "node:fs";
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
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { encryptBackup, decryptBackupFile } from "./backup-format.ts";

export function backupPacket(value: unknown): {
  key: Buffer;
  imageId?: string;
  environment?: unknown;
  output?: undefined;
} {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof (value as { key?: unknown }).key !== "string"
  )
    throw Error("Invalid backup request");
  const record = value as {
    key: string;
    imageId?: string;
    environment?: unknown;
  };
  const key = Buffer.from(record.key, "base64");
  if (key.toString("base64") !== record.key || key.length !== 32)
    throw Error("Invalid backup key");
  return { key, imageId: record.imageId, environment: record.environment };
}

export async function sourceVerification(directory: string, imageId?: string) {
  const file = join(directory, "source-verification.json");
  if (!(await regular(file, true))) return undefined;
  const value = JSON.parse(await readFile(file, "utf8"));
  if (
    value?.schemaVersion !== 1 ||
    value.passed !== true ||
    value.imageId !== imageId ||
    !/^sha256:[a-f0-9]{64}$/.test(imageId ?? "") ||
    !Number.isSafeInteger(value.databases) ||
    value.databases < 0
  )
    throw Error("Invalid source image validation record");
  return value;
}

async function regular(file: string, optional = false) {
  let info: Stats;
  try {
    info = await lstat(file);
  } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT")
      return false;
    throw error;
  }
  if (!info.isFile()) throw Error("Backup refuses non-regular files");
  return true;
}

async function tree(
  directory: string,
  excluded: Set<string>,
  outputDirectory: Stats,
  base = directory,
) {
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

function environmentValues(values: unknown): string[] {
  if (!Array.isArray(values) || values.length > 1024)
    throw Error("Invalid backup environment");
  const names = new Set<string>();
  for (const value of values) {
    if (
      typeof value !== "string" ||
      value.includes("\x00") ||
      value.length > 131072
    )
      throw Error("Invalid backup environment");
    const at = value.indexOf("=");
    const name = value.slice(0, at);
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
}: {
  dataDirectory: string;
  configFile: string;
  deploymentDirectory: string;
  output: string;
  key: Buffer;
  imageId?: string;
  environment?: unknown;
  signal?: AbortSignal;
}) {
  if (!/^sha256:[a-f0-9]{64}$/.test(imageId ?? ""))
    throw Error("Backup requires an immutable image ID");
  const checkedEnvironment = environmentValues(environment);
  const root = resolve(dataDirectory);
  const configPath = relative(root, resolve(configFile));
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
  const verified = await sourceVerification(deploymentDirectory, imageId);
  const temporary = await mkdtemp(join(tmpdir(), "pluhub-bundle-"));
  const staging = join(
    dirname(output),
    ".pluhub-bundle-" + randomBytes(16).toString("hex"),
  );
  let child: ChildProcessByStdio<null, Readable, null> | undefined;
  let complete: Promise<void> | undefined;
  let encrypted: Promise<void> | undefined;
  let stagingCreated = false;
  try {
    const metadata = join(temporary, "deployment");
    await mkdir(metadata, { mode: 0o700 });
    await copyFile(
      join(deploymentDirectory, "compose.yaml"),
      join(metadata, "compose.yaml"),
    );
    if (withEnv)
      await copyFile(join(deploymentDirectory, ".env"), join(metadata, ".env"));
    if (verified)
      await writeFile(
        join(metadata, "source-verification.json"),
        JSON.stringify(verified) + "\n",
        { mode: 0o600 },
      );
    await writeFile(
      join(metadata, "runtime-environment.json"),
      JSON.stringify(checkedEnvironment) + "\n",
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
    complete = new Promise<void>((done, reject) => {
      child!.once("error", reject);
      child!.once("close", (code) =>
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
      await unlink(staging).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    await rm(temporary, { recursive: true, force: true });
  }
}

async function packet() {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw Error("Backup request is too large");
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks);
  try {
    return backupPacket(JSON.parse(bytes.toString("utf8")));
  } finally {
    bytes.fill(0);
  }
}

export async function runBackupCommand(
  command: string,
  args: string[],
  configFile: string,
) {
  const values = new Map<string, string>();
  for (let n = 0; n < args.length; n += 2) {
    if (
      !["--output", "--input", "--deployment"].includes(args[n]!) ||
      !args[n + 1] ||
      values.has(args[n]!)
    )
      throw Error("Invalid backup arguments");
    values.set(args[n]!, args[n + 1]!);
  }
  const output = values.get("--output");
  if (!output || dirname(resolve(output)) !== "/backups")
    throw Error("Backup output must be inside /backups");
  const input = await packet();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.once(signal, cancel);
  try {
    let result: unknown;
    if (command === "backup-decrypt") {
      if (!values.get("--input") || values.has("--deployment"))
        throw Error("Invalid backup arguments");
      await decryptBackupFile(
        values.get("--input")!,
        output,
        input.key,
        controller.signal,
      );
      result = { authenticated: true };
    } else {
      const deploymentDirectory = values.get("--deployment");
      if (!deploymentDirectory || values.has("--input"))
        throw Error("Invalid backup arguments");
      if (!(await sourceVerification(deploymentDirectory, input.imageId))) {
        const cliVerify =
          "/opt/pluhub/node_modules/@pluhub/cli/dist/verify-data.js";
        const { verifyData } = (await import(cliVerify)) as {
          verifyData: (config: unknown) => Promise<unknown>;
        };
        const config = JSON.parse(await readFile(configFile, "utf8"));
        config.dataDir = resolve(dirname(configFile), config.dataDir);
        await verifyData(config);
      }
      result = await createBackupBundle({
        dataDirectory: "/data",
        configFile,
        deploymentDirectory,
        output,
        ...input,
        signal: controller.signal,
      });
    }
    process.stdout.write(JSON.stringify(result) + "\n");
  } finally {
    input.key.fill(0);
    for (const signal of ["SIGTERM", "SIGINT"] as const)
      process.off(signal, cancel);
  }
}
