import { createServer, type Socket } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createHmac,
  generateKeyPairSync,
  createHash,
  sign,
  randomBytes,
} from "node:crypto";
import { fixture } from "./helpers.js";
import { writeConfig } from "../packages/control/dist/index.js";
export const cookie = (r: Response) => ({
  cookie: r.headers.get("set-cookie")!.split(";")[0]!,
});
export async function securityFixture(branding?: Record<string, unknown>) {
  const deliveries: {
      to: string;
      text: string;
      html: string;
      subject: string;
      raw: string;
    }[] = [],
    sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    socket.write("220 localhost test SMTP\r\n");
    let buffer = "",
      data = false,
      message = "",
      to = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\r\n")) {
        const at = buffer.indexOf("\r\n"),
          line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        if (data) {
          if (line !== ".") {
            message += (line.startsWith("..") ? line.slice(1) : line) + "\r\n";
            continue;
          }
          data = false;
          // Parse the controlled MIME alternatives produced by our local Nodemailer fixture.
          const parts = { text: "", html: "" };
          const decode = (value: string, encoding: string) =>
            encoding === "base64"
              ? Buffer.from(value, "base64").toString("utf8")
              : encoding === "quoted-printable"
                ? Buffer.from(
                    value
                      .replace(/=\r\n/g, "")
                      .replace(/=([0-9A-F]{2})/gi, (_m, h) =>
                        String.fromCharCode(parseInt(h, 16)),
                      ),
                    "latin1",
                  ).toString("utf8")
                : value;
          const parse = (part: string) => {
            const split = part.indexOf("\r\n\r\n"),
              headers = part.slice(0, split).replace(/\r\n[ \t]+/g, " "),
              body = part.slice(split + 4);
            const boundary = /boundary="([^"]+)"/i.exec(headers)?.[1];
            if (boundary) {
              for (const child of body.split("--" + boundary).slice(1, -1))
                parse(child.replace(/^\r\n/, "").replace(/\r\n$/, ""));
            } else {
              const encoding =
                /Content-Transfer-Encoding: ([^\r\n]+)/i
                  .exec(headers)?.[1]
                  ?.toLowerCase() ?? "7bit";
              if (/Content-Type: text\/html/i.test(headers))
                parts.html = decode(body, encoding);
              else parts.text = decode(body, encoding);
            }
          };
          parse(message);
          const headers = message
            .slice(0, message.indexOf("\r\n\r\n"))
            .replace(/\r\n[ \t]+/g, " ");
          const subject = (/^Subject: (.+)$/im.exec(headers)?.[1] ?? "")
            .replace(/\?=\s+=\?/g, "?==?")
            .replace(/=\?UTF-8\?([BQ])\?([^?]*)\?=/gi, (_m, encoding, value) =>
              decode(
                encoding.toUpperCase() === "Q"
                  ? value.replace(/_/g, " ")
                  : value,
                encoding.toUpperCase() === "B" ? "base64" : "quoted-printable",
              ),
            );
          deliveries.push({ to, ...parts, subject, raw: message });
          socket.write("250 accepted\r\n");
        } else if (/^EHLO|^HELO/.test(line))
          socket.write("250-localhost\r\n250 SIZE 100000\r\n");
        else if (/^RCPT TO:/i.test(line)) {
          to = line.slice(8);
          socket.write("250 ok\r\n");
        } else if (/^DATA/.test(line)) {
          data = true;
          message = "";
          socket.write("354 end with dot\r\n");
        } else if (/^QUIT/.test(line)) {
          socket.end("221 bye\r\n");
        } else socket.write("250 ok\r\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;
  process.env.PLUHUB_TEST_TURNSTILE = "local-test-secret";
  let validations = 0;
  const f = await fixture(
    ["users", "auth", "mailer", "turnstile", ...(branding ? ["console"] : [])],
    {
      console: { branding },
      auth: {
        registrationEnabled: true,
        emailLoginEnabled: true,
        webauthn: {
          enabled: true,
          rpID: "localhost",
          origins: ["http://localhost"],
        },
      },
      mailer: {
        enabled: true,
        host: "127.0.0.1",
        port,
        from: "no-reply@pluhub.test",
        allowInsecure: true,
      },
      turnstile: {},
    },
    async (kernel, directory) => {
      (globalThis as any).__pluhubCaptchaTransport = (i: any) => {
        validations++;
        const b = JSON.parse(i.body);
        return Response.json({
          success: b.response?.startsWith("valid-"),
          hostname: "localhost",
          action: b.response?.split("-")[1],
          challenge_ts: new Date().toISOString(),
        });
      };
      const dir = join(directory, "transport");
      await mkdir(dir);
      await writeFile(
        join(dir, "manifest.json"),
        JSON.stringify({
          schemaVersion: 1,
          id: "test.captcha-transport",
          version: "1.0.0",
          host: ">=0.1.0-alpha.1",
          runtime: { kind: "native", entry: "index.mjs" },
          provides: ["http.transport@1"],
          requires: [],
          permissions: [],
          configReload: "snapshot",
        }),
      );
      await writeFile(
        join(dir, "index.mjs"),
        'export default {setup(h){h.provide("http.transport@1",i=>globalThis.__pluhubCaptchaTransport(i));}}',
      );
      await kernel.add(dir, { grants: [] });
    },
  );
  // Keep the offline CLI's dependency inventory consistent with this mock host.
  f.config.plugins.push({
    path: join(f.directory, "transport"),
    grants: [],
    config: {},
  });
  await writeConfig(f.file, f.config);
  // These flows exercise registration on an installed site. Fresh setup is tested separately.
  await f.kernel.invoke("auth.bootstrap@1", {
    username: "admin",
    password: "correct-admin-password",
  });
  return {
    ...f,
    deliveries,
    validations: () => validations,
    code: () => {
      const code = deliveries.at(-1)?.text.match(/\b\d{6}\b/)?.[0];
      if (!code) throw Error("SMTP did not receive an OTP");
      return code;
    },
    async close() {
      await f.close();
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      delete (globalThis as any).__pluhubCaptchaTransport;
    },
  };
}
export function otp(secret: string, counter = Math.floor(Date.now() / 30000)) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of secret)
    bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  const key = Buffer.from(
      (bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)),
    ),
    moving = Buffer.alloc(8);
  moving.writeBigUInt64BE(BigInt(counter));
  const hash = createHmac("sha1", key).update(moving).digest(),
    offset = hash.at(-1)! & 15;
  return ((hash.readUInt32BE(offset) & 0x7fffffff) % 1000000)
    .toString()
    .padStart(6, "0");
}
// Minimal independent CBOR encoder for standard WebAuthn test attestations.
function head(kind: number, n: number) {
  if (n < 24) return Buffer.from([(kind << 5) | n]);
  if (n < 256) return Buffer.from([(kind << 5) | 24, n]);
  const b = Buffer.alloc(3);
  b[0] = (kind << 5) | 25;
  b.writeUInt16BE(n, 1);
  return b;
}
function cbor(v: any): Buffer {
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === "string") {
    const b = Buffer.from(v);
    return Buffer.concat([head(3, b.length), b]);
  }
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  const entries = v instanceof Map ? [...v] : Object.entries(v);
  return Buffer.concat([
    head(5, entries.length),
    ...entries.flatMap(([k, value]: any) => [cbor(k), cbor(value)]),
  ]);
}
export function authenticator() {
  const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" }),
    jwk = key.publicKey.export({ format: "jwk" }),
    id = randomBytes(32).toString("base64url"),
    publicKey = cbor(
      new Map<any, any>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x!, "base64url")],
        [-3, Buffer.from(jwk.y!, "base64url")],
      ]),
    );
  let counter = 0;
  const client = (
    type: string,
    challenge: string,
    origin: string,
    crossOrigin = false,
  ) => Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin }));
  const authData = (rpID: string, flags: number, count: number) => {
    const n = Buffer.alloc(4);
    n.writeUInt32BE(count);
    return Buffer.concat([
      createHash("sha256").update(rpID).digest(),
      Buffer.from([flags]),
      n,
    ]);
  };
  return {
    id,
    register: (options: any, origin = "http://localhost") => {
      const credential = Buffer.from(id, "base64url"),
        len = Buffer.alloc(2);
      len.writeUInt16BE(credential.length);
      const data = Buffer.concat([
        authData(options.rp.id, 0x45, 0),
        Buffer.alloc(16),
        len,
        credential,
        publicKey,
      ]);
      return {
        id,
        rawId: id,
        type: "public-key",
        clientExtensionResults: { credProps: { rk: true } },
        authenticatorAttachment: "platform",
        response: {
          clientDataJSON: client(
            "webauthn.create",
            options.challenge,
            origin,
          ).toString("base64url"),
          attestationObject: cbor({
            fmt: "none",
            attStmt: {},
            authData: data,
          }).toString("base64url"),
          transports: ["internal"],
        },
      };
    },
    login: (
      options: any,
      userId: string,
      override: {
        origin?: string;
        rpID?: string;
        uv?: boolean;
        crossOrigin?: boolean;
        counter?: number;
      } = {},
    ) => {
      const c = client(
          "webauthn.get",
          options.challenge,
          override.origin ?? "http://localhost",
          override.crossOrigin ?? false,
        ),
        data = authData(
          override.rpID ?? options.rpId,
          override.uv === false ? 1 : 5,
          override.counter ?? ++counter,
        );
      return {
        id,
        rawId: id,
        type: "public-key",
        clientExtensionResults: {},
        authenticatorAttachment: "platform",
        response: {
          clientDataJSON: c.toString("base64url"),
          authenticatorData: data.toString("base64url"),
          signature: sign(
            "sha256",
            Buffer.concat([data, createHash("sha256").update(c).digest()]),
            key.privateKey,
          ).toString("base64url"),
          userHandle: Buffer.from(userId).toString("base64url"),
        },
      };
    },
  };
}
