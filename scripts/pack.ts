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
const registryRoot = resolve("output/registry");
await rm(out, { recursive: true, force: true, maxRetries: 5 });
await rm(registryRoot, { recursive: true, force: true, maxRetries: 5 });
await mkdir(out, { recursive: true });
const artifacts: string[] = [];
const metadata = new Map<string, Record<string, unknown>>();
const registry: Array<{
  manifest: { id: string; version: string };
  archive: string;
  sha256: string;
}> = [];
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
const packageVersions = new Map<string, string>(
  await Promise.all(
    packages.map(async (path): Promise<[string, string]> => {
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
    for (const [name, value] of Object.entries(
      (manifest.dependencies ?? {}) as Record<string, string>,
    ))
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
    const result = spawnSync(
      process.platform === "win32" ? "cmd.exe" : "npm",
      process.platform === "win32"
        ? [
            "/d",
            "/s",
            "/c",
            "npm",
            "pack",
            "--ignore-scripts",
            "--pack-destination",
            out,
          ]
        : ["pack", "--ignore-scripts", "--pack-destination", out],
      { cwd: temp, stdio: "inherit" },
    );
    if (result.status !== 0) throw new Error("npm pack failed");
    const filename =
      manifest.name.replace(/^@/, "").replaceAll("/", "-") +
      "-" +
      manifest.version +
      ".tgz";
    artifacts.push(filename);
    metadata.set(filename, {
      id: manifest.name,
      version: manifest.version,
      dependencies: manifest.dependencies ?? {},
    });
  } finally {
    await rm(temp, { recursive: true, force: true, maxRetries: 5 });
  }
}
for (const name of await readdir("../PluHub-Plugins/plugins")) {
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
const sums: string[] = [];
const releasePackages: Record<string, unknown>[] = [];
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
await mkdir(join(registryRoot, "packages"), { recursive: true });
for (const entry of registry)
  await cp(
    join(out, entry.manifest.id + "-" + entry.manifest.version + ".tgz"),
    join(registryRoot, "packages", entry.archive),
  );
await writeFile(
  join(registryRoot, "index.json"),
  JSON.stringify({ schemaVersion: 1, plugins: registry }, null, 2) + "\n",
);
