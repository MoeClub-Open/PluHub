import { mkdir, readdir, cp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { digest } from "../../packages/control/dist/index.js";
import type { ImagePluginCatalog } from "./sync-bundled-plugins.ts";
const out = "/image";
const catalog: ImagePluginCatalog = { imageId: randomUUID(), plugins: {} };
await cp("output/registry", out + "/registry", { recursive: true });
await mkdir(out + "/packages", { recursive: true });
const release = JSON.parse(
  await readFile("output/packages/RELEASE_LOCK.json", "utf8"),
);
for (const pkg of release.packages)
  if (pkg.id.startsWith("@pluhub/"))
    await cp("output/packages/" + pkg.file, out + "/packages/" + pkg.file);
for (const name of await readdir("../PluHub-Plugins/plugins")) {
  if (name === "subscription-accounts") continue;
  const source = "../PluHub-Plugins/plugins/" + name;
  if (!existsSync(source + "/manifest.json")) continue;
  const target = out + "/plugins/" + name;
  await mkdir(target, { recursive: true });
  for (const file of ["manifest.json", "package.json", "dist"])
    await cp(source + "/" + file, target + "/" + file, { recursive: true });
  const manifest = JSON.parse(
    await readFile(target + "/manifest.json", "utf8"),
  );
  catalog.plugins["/opt/pluhub/plugins/" + name] = {
    id: manifest.id,
    version: manifest.version,
    integrity: await digest(target),
  };
}
await cp("deploy/docker", out + "/deploy/docker", { recursive: true });
await writeFile(
  out + "/deploy/docker/bundled-plugins.json",
  JSON.stringify(catalog) + "\n",
);
await mkdir(out + "/scripts", { recursive: true });
await cp("deploy/migrations", out + "/deploy/migrations", { recursive: true });
for (const name of [
  "migrate-plugin-boundaries.ts",
  "migrate-managed-secrets.ts",
])
  await cp("scripts/" + name, out + "/scripts/" + name);
await cp("LICENSE", out + "/LICENSE");
await writeFile(
  out + "/package.json",
  JSON.stringify({
    name: "pluhub-runtime",
    version: "0.1.0-alpha.1",
    private: true,
    type: "module",
  }),
);
await mkdir(out + "/tools", { recursive: true });
await cp(
  "../PluHub-Plugins/tools/migrate-subscriptions.mjs",
  out + "/tools/migrate-subscriptions.mjs",
);
