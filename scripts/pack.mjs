import { existsSync } from "node:fs";
import {
  readFile,
  mkdir,
  cp,
  writeFile,
  mkdtemp,
  rm,
  readdir,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { packPlugin } from "../packages/control/dist/index.js";
const out = resolve("output/packages");
await mkdir(out, { recursive: true });
const artifacts = [];
const metadata = new Map();
const registry = [];
const packages = [
  resolve("../PluHub-Spec"),
  ...[
    "sdk",
    "runtime",
    "engine",
    "kernel",
    "control",
    "frontend-host",
    "ui-sdk",
    "testkit",
  ].map((name) => resolve("packages", name)),
  resolve("apps/cli"),
];
const packageVersions = new Map(
  await Promise.all(
    packages.map(async (path) => {
      const manifest = JSON.parse(
        await readFile(join(path, "package.json"), "utf8"),
      );
      return [manifest.name, manifest.version];
    }),
  ),
);
for (const path of packages) {
  const temp = await mkdtemp(join(tmpdir(), "pluhub-pack-"));
  try {
    const manifest = JSON.parse(
      await readFile(join(path, "package.json"), "utf8"),
    );
    for (const [name, value] of Object.entries(manifest.dependencies ?? {}))
      if (value.startsWith("link:") || value.startsWith("workspace:")) {
        const version = packageVersions.get(name);
        if (!version)
          throw new Error("Unknown internal package dependency: " + name);
        manifest.dependencies[name] = version;
      }
    delete manifest.devDependencies;
    await cp(join(path, "dist"), join(temp, "dist"), { recursive: true });
    if (manifest.name === "@pluhub/contracts")
      for (const dir of ["schemas", "fixtures"])
        await cp(join(path, dir), join(temp, dir), { recursive: true });
    await cp(resolve("LICENSE"), join(temp, "LICENSE"));
    await writeFile(
      join(temp, "package.json"),
      JSON.stringify(manifest, null, 2),
    );
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const result = spawnSync(
      npm,
      ["pack", "--ignore-scripts", "--pack-destination", out],
      { cwd: temp, stdio: "inherit", shell: process.platform === "win32" },
    );
    if (result.status !== 0) throw new Error("npm pack failed");
    artifacts.push(
      manifest.name.replace(/^@/, "").replaceAll("/", "-") +
        "-" +
        manifest.version +
        ".tgz",
    );
    metadata.set(artifacts.at(-1), {
      id: manifest.name,
      version: manifest.version,
      dependencies: manifest.dependencies ?? {},
    });
  } finally {
    await rm(temp, { recursive: true, force: true, maxRetries: 5 });
  }
}
for (const name of await readdir("../PluHub-Plugins/plugins")) {
  if (name === "subscription-accounts") continue;
  const path = resolve("../PluHub-Plugins/plugins", name);
  if (!existsSync(join(path, "manifest.json"))) continue;
  const manifest = JSON.parse(
    await readFile(join(path, "manifest.json"), "utf8"),
  );
  const filename = manifest.id + "-" + manifest.version + ".tgz";
  await packPlugin(path, join(out, filename));
  const archiveSha256 = createHash("sha256")
    .update(await readFile(join(out, filename)))
    .digest("hex");
  registry.push({
    manifest,
    archive: filename.slice(0, -4) + "-" + archiveSha256 + ".tgz",
    sha256: archiveSha256,
  });
  artifacts.push(filename);
  metadata.set(filename, {
    id: manifest.id,
    version: manifest.version,
    requires: manifest.requires,
    optionalRequires: manifest.optionalRequires ?? [],
    dependencies: manifest.dependencies ?? {},
  });
}
const sums = [];
const releasePackages = [];
for (const name of artifacts.sort()) {
  const hash = createHash("sha256")
    .update(await readFile(join(out, name)))
    .digest("hex");
  sums.push(hash + "  " + name);
  releasePackages.push({ ...metadata.get(name), file: name, sha256: hash });
}
await writeFile(join(out, "SHA256SUMS"), sums.join("\n") + "\n");
await writeFile(
  join(out, "RELEASE_LOCK.json"),
  JSON.stringify({ schemaVersion: 1, packages: releasePackages }, null, 2) +
    "\n",
);
console.log("Packages written to " + out);
await mkdir(resolve("output/registry/packages"), { recursive: true });
for (const entry of registry)
  await cp(
    join(out, entry.manifest.id + "-" + entry.manifest.version + ".tgz"),
    resolve("output/registry/packages", entry.archive),
  );
await writeFile(
  resolve("output/registry/index.json"),
  JSON.stringify({ schemaVersion: 1, plugins: registry }, null, 2) + "\n",
);
