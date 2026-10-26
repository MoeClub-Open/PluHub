import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { HostError } from "@pluhub/sdk";

export class SecretVault {
  constructor(
    private directory: string,
    private register: (value: string) => void = () => {},
  ) {}
  private records(): Record<string, string> {
    try {
      return JSON.parse(
        readFileSync(join(this.directory, "secrets.json"), "utf8"),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }
  private key(create = false) {
    const file = join(this.directory, "secrets.key");
    try {
      return readFileSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!create)
        throw new HostError(
          "secret_key_missing",
          "Credential encryption key is unavailable",
          503,
        );
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const key = randomBytes(32);
      writeFileSync(file, key, { flag: "wx", mode: 0o600 });
      return key;
    }
  }
  has(reference: string) {
    return Object.hasOwn(this.records(), reference);
  }
  put(value: string, reference = "secret:" + randomUUID()) {
    const records = this.records();
    const iv = randomBytes(12);
    const cipher = createCipheriv(
      "aes-256-gcm",
      this.key(Object.keys(records).length === 0),
      iv,
    );
    cipher.setAAD(Buffer.from(reference));
    records[reference] = Buffer.concat([
      iv,
      cipher.update(value, "utf8"),
      cipher.final(),
      cipher.getAuthTag(),
    ]).toString("base64");
    const file = join(this.directory, "secrets.json");
    const temporary = file + "." + randomUUID();
    writeFileSync(temporary, JSON.stringify(records) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, file);
    chmodSync(file, 0o600);
    this.register(value);
    return reference;
  }
  get(reference: string) {
    const encrypted = this.records()[reference];
    if (!encrypted)
      throw new HostError(
        "secret_missing",
        "Configured secret is unavailable",
        503,
      );
    const data = Buffer.from(encrypted, "base64");
    const cipher = createDecipheriv(
      "aes-256-gcm",
      this.key(),
      data.subarray(0, 12),
    );
    cipher.setAAD(Buffer.from(reference));
    cipher.setAuthTag(data.subarray(-16));
    const value = Buffer.concat([
      cipher.update(data.subarray(12, -16)),
      cipher.final(),
    ]).toString("utf8");
    this.register(value);
    return value;
  }
}
