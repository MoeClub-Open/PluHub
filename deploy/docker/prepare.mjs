import { mkdir, readdir, cp, readFile, writeFile } from "node:fs/promises";
const out = "/image";
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
  const target = out + "/plugins/" + name;
  await mkdir(target, { recursive: true });
  for (const file of ["manifest.json", "package.json", "dist"])
    await cp(source + "/" + file, target + "/" + file, { recursive: true });
}
await cp("deploy/docker", out + "/deploy/docker", { recursive: true });
await mkdir(out + "/scripts", { recursive: true });
await cp(
  "scripts/migrate-channel-graphs.mjs",
  out + "/scripts/migrate-channel-graphs.mjs",
);
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
