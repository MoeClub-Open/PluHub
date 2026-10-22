// Install published bundles in a clean directory and exercise authentication without external services.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, isAbsolute } from "node:path";
import { createServer } from "node:net";
import { install, createKernel } from "../packages/control/dist/index.js";
import { releasePackage } from "./release-package.mjs";
const parent = resolve(tmpdir()),
  directory = await mkdtemp(join(parent, "pluhub-identity-package-"));
const sockets = new Set();
let delivered = false,
  kernel;
const server = createServer((socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  socket.setEncoding("utf8");
  socket.write("220 local SMTP\r\n");
  let buffer = "",
    data = false;
  socket.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\r\n")) {
      const at = buffer.indexOf("\r\n"),
        line = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      if (data) {
        if (line === ".") {
          data = false;
          delivered = true;
          socket.write("250 accepted\r\n");
        }
      } else if (/^EHLO|^HELO/.test(line)) socket.write("250 localhost\r\n");
      else if (line === "DATA") {
        data = true;
        socket.write("354 send\r\n");
      } else if (line === "QUIT") socket.end("221 bye\r\n");
      else socket.write("250 ok\r\n");
    }
  });
});
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const plugins = [];
  for (const name of [
    "users",
    "auth",
    "mailer",
    "turnstile",
    "http-transport",
    "console",
  ]) {
    const entry = await install(
      await releasePackage("official." + name),
      join(directory, "plugins"),
    );
    const manifest = JSON.parse(
      await readFile(join(entry.path, "manifest.json"), "utf8"),
    );
    plugins.push({
      path: entry.path,
      integrity: entry.sha256,
      grants: manifest.permissions,
      config:
        name === "mailer"
          ? {
              enabled: true,
              host: "127.0.0.1",
              port: server.address().port,
              from: "sender@example.test",
              allowInsecure: true,
            }
          : name === "auth"
            ? {
                webauthn: {
                  enabled: true,
                  rpID: "localhost",
                  origins: ["http://localhost"],
                },
              }
            : {},
    });
  }
  kernel = await createKernel({
    schemaVersion: 1,
    dataDir: join(directory, "data"),
    plugins,
  });
  await kernel.start();
  await kernel.invoke("auth.bootstrap@1", {
    username: "admin",
    password: "package-test-password",
  });
  const request = (path, body, cookie) =>
    kernel.fetch(
      new Request("http://localhost/api/plugins/official.auth" + path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(cookie ? { cookie } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
  const login = await request("/login", {
    username: "admin",
    password: "package-test-password",
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  await login.json();
  const setup = await request("/totp/setup", {}, cookie);
  assert.equal(setup.status, 200);
  assert.match((await setup.json()).qrDataURL, /^data:image\/png;base64,/);
  const options = await request(
    "/passkeys/register/options",
    { name: "package credential", kind: "passkey" },
    cookie,
  );
  assert.equal(options.status, 200);
  assert.equal((await options.json()).options.rp.id, "localhost");
  await kernel.invoke("mail.send@1", {
    to: "receiver@example.test",
    subject: "Local package test",
    text: "Only a loopback SMTP server receives this message.",
  });
  assert.equal(delivered, true);
  console.log(
    "Installed identity bundles verified: password session, encrypted TOTP setup, WebAuthn options, local SMTP. No external requests sent.",
  );
} finally {
  await kernel?.shutdown();
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(() => resolve()));
  const target = resolve(directory),
    child = relative(parent, target);
  assert.ok(
    child &&
      !child.startsWith("..") &&
      !isAbsolute(child) &&
      child.startsWith("pluhub-identity-package-"),
  );
  await rm(target, { recursive: true, force: true, maxRetries: 5 });
}
