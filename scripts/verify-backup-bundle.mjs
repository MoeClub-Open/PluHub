import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

export async function verifyBackupBundle({
  docker,
  image,
  container,
  dataVolume,
  cookie,
  apiKey,
}) {
  const id =
    "pluhub-backup-verify-" + Date.now() + "-" + randomBytes(4).toString("hex");
  const metadataVolume = id + "-metadata",
    backupVolume = id + "-archive",
    restoredVolume = id + "-restore",
    restored = id + "-app";
  const key = randomBytes(32);
  const security = [
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--tmpfs=/tmp:rw,noexec,nosuid,size=64m,uid=1000,gid=1000",
  ];
  const run = (args, input) =>
    execFileSync(docker, args, {
      encoding: "utf8",
      ...(input === undefined ? {} : { input }),
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      timeout: 60000,
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  const mount = (source, target, readonly = false) => [
    "--mount",
    "type=volume,source=" +
      source +
      ",target=" +
      target +
      (readonly ? ",readonly" : ""),
  ];
  const packet = {
    key: key.toString("base64"),
    imageId: run(["inspect", "--format", "{{.Image}}", container]),
    environment: JSON.parse(
      run(["inspect", "--format", "{{json .Config.Env}}", container]),
    ),
  };
  let paused = false;
  const bundle = [
    "run",
    "--rm",
    "-i",
    "--network",
    "none",
    ...security,
    ...mount(dataVolume, "/data"),
    ...mount(metadataVolume, "/deployment", true),
    ...mount(backupVolume, "/backups"),
    image,
    "backup-bundle",
    "--output",
    "/backups/backup.phb",
    "--deployment",
    "/deployment",
  ];
  const decrypt = (output) => [
    "run",
    "--rm",
    "-i",
    "--network",
    "none",
    ...security,
    ...mount(backupVolume, "/backups"),
    image,
    "backup-decrypt",
    "--input",
    "/backups/backup.phb",
    "--output",
    "/backups/" + output,
  ];
  const archiveMember = (path) =>
    run([
      "run",
      "--rm",
      "--network",
      "none",
      ...security,
      ...mount(backupVolume, "/backups", true),
      "--entrypoint",
      "tar",
      image,
      "-xOzf",
      "/backups/authenticated.tar.gz",
      path,
    ]);
  try {
    for (const volume of [metadataVolume, backupVolume, restoredVolume])
      run(["volume", "create", volume]);
    run([
      "run",
      "--rm",
      "--network",
      "none",
      ...security,
      "--user",
      "0",
      "--cap-add",
      "CHOWN",
      ...mount(metadataVolume, "/metadata"),
      ...mount(backupVolume, "/backups"),
      "--entrypoint",
      "node",
      image,
      "-e",
      "const fs=require('node:fs');const files=" +
        JSON.stringify({
          "compose.yaml": "services: {}\n",
          ".env": "SMTP_PASSWORD=synthetic-backup-password\n",
        }) +
        ";for(const [name,value] of Object.entries(files)){fs.writeFileSync('/metadata/'+name,value,{mode:0o600});fs.chownSync('/metadata/'+name,1000,1000)}for(const path of ['/metadata','/backups'])fs.chownSync(path,1000,1000)",
    ]);
    let refused = false;
    try {
      run(bundle, JSON.stringify(packet));
    } catch (error) {
      refused = error.status === 75;
    }
    assert.equal(
      refused,
      true,
      "Encrypted backup must respect the active instance lock",
    );
    run(["stop", "--time", "40", container]);
    paused = true;
    let receipt;
    try {
      receipt = JSON.parse(run(bundle, JSON.stringify(packet)));
    } finally {
      run(["start", container]);
      paused = false;
    }
    assert.equal(receipt.encrypted, true);
    assert.equal(receipt.imageId, packet.imageId);
    assert.match(receipt.sha256, /^[a-f0-9]{64}$/);
    let rejected = false;
    try {
      run(
        decrypt("wrong-key.tar.gz"),
        JSON.stringify({ key: randomBytes(32).toString("base64") }),
      );
    } catch (error) {
      rejected = error.status === 1;
    }
    assert.equal(
      rejected,
      true,
      "Wrong keys must not produce restorable plaintext",
    );
    assert.deepEqual(
      JSON.parse(
        run(
          decrypt("authenticated.tar.gz"),
          JSON.stringify({ key: packet.key }),
        ),
      ),
      { authenticated: true },
    );
    const manifest = JSON.parse(archiveMember("deployment/manifest.json"));
    assert.equal(manifest.imageId, packet.imageId);
    assert.equal(manifest.consistency, "offline");
    assert.deepEqual(
      JSON.parse(archiveMember("deployment/runtime-environment.json")),
      packet.environment,
    );
    assert.equal(
      archiveMember("deployment/.env"),
      "SMTP_PASSWORD=synthetic-backup-password",
    );
    const names = run([
      "run",
      "--rm",
      "--network",
      "none",
      ...security,
      ...mount(backupVolume, "/backups", true),
      "--entrypoint",
      "tar",
      image,
      "-tzf",
      "/backups/authenticated.tar.gz",
    ]);
    assert.ok(
      names.includes("data/pluhub.json") && names.includes("security.key"),
    );
    assert.ok(
      !names.includes("pluhub.json.pid") && !names.includes("pluhub.json.lock"),
    );
    const privateFiles = JSON.parse(
      run([
        "run",
        "--rm",
        "--network",
        "none",
        ...security,
        ...mount(backupVolume, "/backups", true),
        "--entrypoint",
        "node",
        image,
        "-e",
        "const fs=require('node:fs');console.log(JSON.stringify(fs.readdirSync('/backups').map(name=>({name,mode:fs.statSync('/backups/'+name).mode&63}))))",
      ]),
    );
    assert.ok(privateFiles.every((file) => file.mode === 0));
    assert.deepEqual(privateFiles.map((file) => file.name).sort(), [
      "authenticated.tar.gz",
      "backup.phb",
    ]);
    run([
      "run",
      "--rm",
      "--network",
      "none",
      ...security,
      ...mount(backupVolume, "/backups", true),
      ...mount(restoredVolume, "/data"),
      "--user",
      "0",
      "--cap-add",
      "CHOWN",
      "--cap-add",
      "DAC_OVERRIDE",
      "--cap-add",
      "FOWNER",
      "--entrypoint",
      "tar",
      image,
      "-xzf",
      "/backups/authenticated.tar.gz",
      "--strip-components=1",
      "-C",
      "/data",
      "data",
    ]);
    const checked = JSON.parse(
      run([
        "run",
        "--rm",
        "--network",
        "none",
        ...security,
        ...mount(restoredVolume, "/data"),
        image,
        "verify-data",
      ]),
    );
    assert.equal(checked.passed, true);
    run([
      "run",
      "-d",
      "--name",
      restored,
      ...security,
      ...mount(restoredVolume, "/data"),
      "-p",
      "127.0.0.1::8080",
      image,
    ]);
    const origin =
      "http://127.0.0.1:" +
      Number(run(["port", restored, "8080/tcp"]).split(":").at(-1));
    let ready = false;
    for (let n = 0; n < 80; n++) {
      try {
        const response = await fetch(origin + "/readyz", {
          signal: AbortSignal.timeout(1000),
        });
        await response.body?.cancel();
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {}
      await new Promise((done) => setTimeout(done, 250));
    }
    assert.equal(ready, true, "Encrypted restore did not become ready");
    const me = await fetch(origin + "/api/plugins/official.auth/me", {
      headers: { cookie },
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).username, "admin");
    const models = await fetch(origin + "/v1/models", {
      headers: { authorization: "Bearer " + apiKey },
      signal: AbortSignal.timeout(10000),
    });
    assert.equal(models.status, 200);
    await models.body?.cancel();
    return [
      "encrypted-backup-instance-lock",
      "encrypted-complete-deployment-bundle",
      "authenticated-decryption-before-publication",
      "encrypted-independent-restore-session-key-and-integrity",
    ];
  } finally {
    key.fill(0);
    if (paused) {
      try {
        run(["start", container]);
      } catch {}
    }
    try {
      run(["rm", "-f", restored]);
    } catch {}
    for (const volume of [restoredVolume, backupVolume, metadataVolume]) {
      try {
        run(["volume", "rm", volume]);
      } catch {}
    }
  }
}
