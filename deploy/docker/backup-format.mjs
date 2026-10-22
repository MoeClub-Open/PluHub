import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { createReadStream, constants } from "node:fs";
import { open, link, unlink, lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const magic = Buffer.from("PluHubBackup\x00\x01", "binary");
const headerLength = magic.length + 12;
const invalid = () => new Error("Invalid backup or backup key");

export function parseBackupKey(value) {
  if (!Buffer.isBuffer(value)) throw invalid();
  if (value.length === 32) return Buffer.from(value);
  if (
    value.length <= 66 &&
    /^[a-f0-9]{64}\r?\n?$/i.test(value.toString("latin1"))
  )
    return Buffer.from(value.toString("latin1").trim(), "hex");
  throw invalid();
}

export async function readBackupKey(file) {
  const info = await lstat(file);
  if (!info.isFile() || (process.platform !== "win32" && info.mode & 0o077))
    throw new Error("Backup key must be a private regular file");
  const handle = await open(
    file,
    constants.O_RDONLY |
      (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
  );
  try {
    const current = await handle.stat();
    if (
      current.dev !== info.dev ||
      current.ino !== info.ino ||
      current.size > 66 ||
      (process.platform !== "win32" && current.mode & 0o077)
    )
      throw invalid();
    const bytes = await handle.readFile();
    try {
      return parseBackupKey(bytes);
    } finally {
      bytes.fill(0);
    }
  } finally {
    await handle.close();
  }
}

function encryption(key) {
  const header = Buffer.concat([magic, randomBytes(12)]);
  const cipher = createCipheriv(
    "aes-256-gcm",
    key,
    header.subarray(magic.length),
  );
  cipher.setAAD(header);
  let started = false;
  return new Transform({
    transform(chunk, _encoding, done) {
      if (!started) {
        this.push(header);
        started = true;
      }
      try {
        this.push(cipher.update(chunk));
        done();
      } catch {
        done(invalid());
      }
    },
    flush(done) {
      try {
        if (!started) this.push(header);
        this.push(cipher.final());
        this.push(cipher.getAuthTag());
        done();
      } catch {
        done(invalid());
      }
    },
  });
}

function decryption(key) {
  let pending = Buffer.alloc(0),
    decipher;
  return new Transform({
    transform(chunk, _encoding, done) {
      try {
        pending = Buffer.concat([pending, chunk]);
        if (!decipher) {
          if (pending.length < headerLength) return done();
          const header = pending.subarray(0, headerLength);
          if (!header.subarray(0, magic.length).equals(magic)) throw invalid();
          decipher = createDecipheriv(
            "aes-256-gcm",
            key,
            header.subarray(magic.length),
          );
          decipher.setAAD(header);
          pending = pending.subarray(headerLength);
        }
        if (pending.length > 16) {
          this.push(decipher.update(pending.subarray(0, -16)));
          pending = Buffer.from(pending.subarray(-16));
        }
        done();
      } catch {
        done(invalid());
      }
    },
    flush(done) {
      try {
        if (!decipher || pending.length !== 16) throw invalid();
        decipher.setAuthTag(pending);
        this.push(decipher.final());
        done();
      } catch {
        done(invalid());
      }
    },
  });
}

// Authenticate completely before publishing plaintext. Existing files are never replaced.
async function transformFile(input, output, key, decrypt, signal) {
  const owned = parseBackupKey(key);
  const partial = join(
    dirname(output),
    ".pluhub-backup-" + randomBytes(16).toString("hex"),
  );
  let handle,
    created = false;
  try {
    handle = await open(partial, "wx", 0o600);
    created = true;
    await pipeline(
      input,
      decrypt ? decryption(owned) : encryption(owned),
      handle.createWriteStream({ flush: true }),
      { signal },
    );
    await handle.close();
    handle = undefined;
    signal?.throwIfAborted();
    await link(partial, output);
    if (process.platform !== "win32") {
      const directory = await open(dirname(output), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
  } finally {
    owned.fill(0);
    await handle?.close();
    if (created)
      await unlink(partial).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
  }
}

export const encryptBackup = (input, output, key, signal) =>
  transformFile(input, output, key, false, signal);
export const decryptBackup = (input, output, key, signal) =>
  transformFile(input, output, key, true, signal);
export const decryptBackupFile = (input, output, key, signal) =>
  decryptBackup(createReadStream(input), output, key, signal);
