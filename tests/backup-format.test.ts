import { it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import {
  mkdtemp,
  readdir,
  readFile,
  writeFile,
  rm,
  chmod,
  symlink,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  encryptBackup,
  decryptBackup,
  parseBackupKey,
  readBackupKey,
} from "../deploy/docker/backup-format.mjs";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "pluhub-backup-format-"));
  return {
    directory,
    key: randomBytes(32),
    file: (name: string) => join(directory, name),
    close: () => rm(directory, { recursive: true, force: true }),
  };
}
it("round-trips encrypted streaming archives through arbitrary chunk boundaries with fresh nonces and private outputs", async () => {
  const f = await fixture();
  try {
    const source = Buffer.concat([
      Buffer.from("private-mail-password private-vault-key"),
      randomBytes(2 * 1024 * 1024),
    ]);
    await encryptBackup(Readable.from([source]), f.file("first.enc"), f.key);
    await encryptBackup(Readable.from([source]), f.file("second.enc"), f.key);
    const first = await readFile(f.file("first.enc"));
    expect(first).not.toEqual(await readFile(f.file("second.enc")));
    expect(first.includes(Buffer.from("private-mail-password"))).toBe(false);
    await encryptBackup(
      Readable.from([source.subarray(0, 256)]),
      f.file("small.enc"),
      f.key,
    );
    const small = await readFile(f.file("small.enc"));
    for (const size of [1, 17, 65536]) {
      const bytes = size < 100 ? small : first;
      const chunks = function* () {
        for (let n = 0; n < bytes.length; n += size)
          yield bytes.subarray(n, n + size);
      };
      const target = f.file("restored-" + size);
      await decryptBackup(Readable.from(chunks()), target, f.key);
      expect(await readFile(target)).toEqual(
        size < 100 ? source.subarray(0, 256) : source,
      );
      if (process.platform !== "win32")
        expect((await stat(target)).mode & 0o077).toBe(0);
    }
  } finally {
    await f.close();
  }
}, 30000);

it("rejects wrong keys, changed headers, nonces, ciphertext, tags and truncation without publishing plaintext", async () => {
  const f = await fixture();
  try {
    await encryptBackup(
      Readable.from([Buffer.from("private-database-bytes")]),
      f.file("valid.enc"),
      f.key,
    );
    const valid = await readFile(f.file("valid.enc"));
    const changes = [0, 12, 20, valid.length - 17, valid.length - 1].map(
      (n) => {
        const changed = Buffer.from(valid);
        changed[n] ^= 1;
        return changed;
      },
    );
    const invalid = [
      ...changes,
      valid.subarray(0, 5),
      valid.subarray(0, -1),
      Buffer.concat([valid, Buffer.from("extra")]),
    ];
    for (const bytes of invalid)
      await expect(
        decryptBackup(Readable.from([bytes]), f.file("rejected.tar.gz"), f.key),
      ).rejects.toThrow("Invalid backup or backup key");
    await expect(
      decryptBackup(
        Readable.from([valid]),
        f.file("wrong-key.tar.gz"),
        randomBytes(32),
      ),
    ).rejects.toThrow("Invalid backup or backup key");
    expect(await readdir(f.directory)).toEqual(["valid.enc"]);
  } finally {
    await f.close();
  }
});

it("keeps existing outputs intact and cleans incomplete files on source failure and cancellation", async () => {
  const f = await fixture();
  try {
    await writeFile(f.file("existing"), "preserved");
    await expect(
      encryptBackup(Readable.from(["content"]), f.file("existing"), f.key),
    ).rejects.toMatchObject({ code: "EEXIST" });
    const broken = Readable.from(
      (async function* () {
        yield "beginning";
        throw Error("synthetic source failure");
      })(),
    );
    await expect(
      encryptBackup(broken, f.file("broken"), f.key),
    ).rejects.toThrow("synthetic source failure");
    const controller = new AbortController();
    controller.abort();
    await expect(
      encryptBackup(
        Readable.from(["content"]),
        f.file("cancelled"),
        f.key,
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(await readFile(f.file("existing"), "utf8")).toBe("preserved");
    expect(await readdir(f.directory)).toEqual(["existing"]);
  } finally {
    await f.close();
  }
});

it("accepts only full-strength binary or hexadecimal keys and checks key file ownership boundaries", async () => {
  const f = await fixture();
  try {
    expect(parseBackupKey(f.key)).toEqual(f.key);
    expect(parseBackupKey(Buffer.from(f.key.toString("hex") + "\n"))).toEqual(
      f.key,
    );
    for (const value of [
      Buffer.alloc(0),
      Buffer.from("short passphrase"),
      Buffer.from("g".repeat(64)),
      Buffer.alloc(64, 0xb0),
      Buffer.alloc(67),
    ])
      expect(() => parseBackupKey(value)).toThrow();
    await writeFile(f.file("key"), f.key, { mode: 0o600 });
    expect(await readBackupKey(f.file("key"))).toEqual(f.key);
    if (process.platform !== "win32") {
      await chmod(f.file("key"), 0o644);
      await expect(readBackupKey(f.file("key"))).rejects.toThrow(
        "private regular file",
      );
      await chmod(f.file("key"), 0o600);
      await symlink(f.file("key"), f.file("key-link"));
      await expect(readBackupKey(f.file("key-link"))).rejects.toThrow(
        "private regular file",
      );
    }
  } finally {
    f.key.fill(0);
    await f.close();
  }
});
