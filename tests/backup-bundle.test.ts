import { it, expect } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  createBackupBundle,
  backupPacket,
} from "../deploy/docker/backup-bundle.mjs";
import { decryptBackupFile } from "../deploy/docker/backup-format.mjs";

const imageId = "sha256:" + "1".repeat(64);
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "pluhub-bundle-test-"));
  const data = join(directory, "data"),
    deployment = join(directory, "metadata"),
    output = join(directory, "backup.phb"),
    configFile = join(data, "pluhub.json"),
    key = randomBytes(32);
  await mkdir(join(data, "state"), { recursive: true });
  await mkdir(deployment);
  await writeFile(
    configFile,
    JSON.stringify({ dataDir: "state", schemaVersion: 1 }),
  );
  await writeFile(join(data, "state", "vault.key"), "synthetic-vault-key", {
    mode: 0o600,
  });
  await writeFile(configFile + ".lock", "lock");
  await writeFile(configFile + ".pid", "123");
  await writeFile(join(deployment, "compose.yaml"), "services: {}\n");
  await writeFile(
    join(deployment, ".env"),
    "SMTP_PASSWORD=synthetic-mail-password\n",
    { mode: 0o600 },
  );
  const options = {
    dataDirectory: data,
    configFile,
    deploymentDirectory: deployment,
    output,
    key,
    imageId,
    environment: [
      "UPSTREAM_KEY=synthetic-upstream-key",
      "MULTILINE=first\nsecond",
    ],
  };
  return {
    directory,
    data,
    deployment,
    output,
    key,
    options,
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

it("accepts only canonical key packets and does not allow packet fields to override filesystem locations", () => {
  const key = randomBytes(32),
    packet = backupPacket({
      key: key.toString("base64"),
      imageId,
      environment: [],
      output: "/data/overwrite",
    });
  expect(packet.key).toEqual(key);
  expect(packet.output).toBeUndefined();
  for (const input of [
    null,
    [],
    {},
    { key: "invalid" },
    { key: key.toString("base64") + " " },
    { key: "a".repeat(44) },
  ])
    expect(() => backupPacket(input)).toThrow();
});

it.skipIf(process.platform !== "linux")(
  "packages a consistent data tree with deployment settings, exact image ID and runtime environment inside authenticated encryption",
  async () => {
    const f = await fixture();
    try {
      const receipt = await createBackupBundle(f.options);
      expect(receipt).toMatchObject({ encrypted: true, imageId });
      expect(receipt.sha256).toMatch(/^[a-f0-9]{64}$/);
      const bytes = await readFile(f.output);
      expect(bytes.includes(Buffer.from("synthetic-mail-password"))).toBe(
        false,
      );
      const archive = join(f.directory, "restored.tar.gz");
      await decryptBackupFile(f.output, archive, f.key);
      const names = execFileSync("tar", ["-tzf", archive], {
        encoding: "utf8",
      });
      expect(names).toContain("data/pluhub.json");
      expect(names).toContain("data/state/vault.key");
      expect(names).not.toContain("pluhub.json.lock");
      expect(names).not.toContain("pluhub.json.pid");
      const member = (name: string) =>
        execFileSync("tar", ["-xOzf", archive, name], { encoding: "utf8" });
      expect(JSON.parse(member("deployment/manifest.json"))).toMatchObject({
        consistency: "offline",
        imageId,
        config: "pluhub.json",
        environmentFile: true,
      });
      expect(JSON.parse(member("deployment/runtime-environment.json"))).toEqual(
        f.options.environment,
      );
      expect(member("deployment/.env")).toContain("synthetic-mail-password");
      await expect(createBackupBundle(f.options)).rejects.toMatchObject({
        code: "EEXIST",
      });
      expect(await readFile(f.output)).toEqual(bytes);
      expect(
        (await readdir(f.directory)).some((name) =>
          name.startsWith(".pluhub-"),
        ),
      ).toBe(false);
    } finally {
      f.key.fill(0);
      await f.close();
    }
  },
);

it.skipIf(process.platform !== "linux")(
  "rejects source links, metadata links, output aliases into source data and ambiguous environment without leaving backup artifacts",
  async () => {
    const f = await fixture();
    try {
      await symlink(f.deployment, join(f.data, "linked"));
      await expect(createBackupBundle(f.options)).rejects.toThrow(
        "symbolic links",
      );
      await unlink(join(f.data, "linked"));
      await unlink(join(f.deployment, ".env"));
      await symlink(
        join(f.data, "state", "vault.key"),
        join(f.deployment, ".env"),
      );
      await expect(createBackupBundle(f.options)).rejects.toThrow(
        "non-regular",
      );
      await unlink(join(f.deployment, ".env"));
      await symlink(f.data, join(f.directory, "alias"));
      await expect(
        createBackupBundle({
          ...f.options,
          output: join(f.directory, "alias", "recursive.phb"),
        }),
      ).rejects.toThrow("inside the data directory");
      for (const environment of [
        ["TOKEN=a", "TOKEN=b"],
        ["missing-equals"],
        ["BAD-NAME=secret"],
        ["TOKEN=bad\x00value"],
      ])
        await expect(
          createBackupBundle({ ...f.options, environment }),
        ).rejects.toThrow("Invalid backup environment");
      await expect(
        createBackupBundle({ ...f.options, imageId: "pluhub:mutable" }),
      ).rejects.toThrow("immutable image ID");
      expect(
        (await readdir(f.directory)).some(
          (name) => name.startsWith(".pluhub-") || name.endsWith(".phb"),
        ),
      ).toBe(false);
    } finally {
      await f.close();
    }
  },
);
