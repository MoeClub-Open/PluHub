import { readFile, writeFile, mkdir, cp, rm, stat } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { HostConfig } from "@pluhub/sdk";
import { HostError } from "@pluhub/sdk";
import { fingerprint } from "./registry.js";
export interface PluginUpdateJob {
  id: string;
  state:
    "pending" | "scheduled" | "applying" | "applied" | "failed" | "cancelled";
  createdAt: number;
  updatedAt: number;
  pluginId: string;
  reason: string;
  before: HostConfig;
  next: HostConfig;
  beforeHash: string;
  affected: string[];
  errorCode?: string;
}
export function pluginJobStore(file: string) {
  const path = file + ".plugin-update.json";
  async function read(): Promise<PluginUpdateJob | undefined> {
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  async function write(job: PluginUpdateJob) {
    const { writeConfig } = await import("./index.js");
    job.updatedAt = Date.now();
    await writeConfig(path, job);
  }
  return {
    read,
    write,
    async queue(
      before: HostConfig,
      next: HostConfig,
      pluginId: string,
      reason: string,
      affected: string[],
    ) {
      const existing = await read();
      if (
        existing &&
        ["pending", "scheduled", "applying"].includes(existing.state)
      )
        throw new HostError(
          "update_pending",
          "Apply or cancel the pending update first",
          409,
        );
      const job: PluginUpdateJob = {
        id: randomUUID(),
        state: "pending",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        pluginId,
        reason,
        before,
        next,
        beforeHash: fingerprint(before),
        affected,
      };
      await write(job);
      return job;
    },
    view(job?: PluginUpdateJob) {
      if (!job) return null;
      const { id, state, createdAt, updatedAt, pluginId, reason, errorCode } =
        job;
      return { id, state, createdAt, updatedAt, pluginId, reason, errorCode };
    },
  };
}
export async function backupPluginData(file: string, job: PluginUpdateJob) {
  const root = resolve(dirname(file), ".pluhub/update-backups", job.id);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(join(root, "before.json"), JSON.stringify(job.before), {
    mode: 0o600,
  });
  const present: string[] = [];
  for (const id of job.affected) {
    if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(id))
      throw new HostError("unsafe_path", "Invalid plugin data ID");
    const source = resolve(job.before.dataDir, id);
    if (dirname(source) !== resolve(job.before.dataDir))
      throw new HostError("unsafe_path", "Invalid plugin data path");
    if (await stat(source).catch(() => undefined)) {
      await cp(source, join(root, id), { recursive: true });
      present.push(id);
    }
  }
  await writeFile(join(root, "present.json"), JSON.stringify(present), {
    mode: 0o600,
  });
  return root;
}
export async function restorePluginData(job: PluginUpdateJob, backup: string) {
  const present: string[] = JSON.parse(
    await readFile(join(backup, "present.json"), "utf8"),
  );
  for (const id of job.affected) {
    const target = resolve(job.before.dataDir, id);
    if (
      !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(id) ||
      dirname(target) !== resolve(job.before.dataDir)
    )
      throw new HostError("unsafe_path", "Invalid plugin data path");
    await rm(target, { recursive: true, force: true });
    if (present.includes(id))
      await cp(join(backup, id), target, { recursive: true });
  }
}
export async function recoverInterruptedPluginUpdate(file: string) {
  const jobs = pluginJobStore(file),
    job = await jobs.read();
  if (!job) return;
  if (job.state === "scheduled") {
    job.state = "pending";
    await jobs.write(job);
    return;
  }
  if (job.state !== "applying") return;
  const backup = resolve(dirname(file), ".pluhub/update-backups", job.id);
  if (await stat(join(backup, "present.json")).catch(() => undefined))
    await restorePluginData(job, backup);
  const { writeConfig } = await import("./index.js");
  await writeConfig(file, job.before);
  job.state = "failed";
  job.errorCode = "update_interrupted";
  await jobs.write(job);
}
