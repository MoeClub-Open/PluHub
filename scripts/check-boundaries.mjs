import { readdir, readFile } from "node:fs/promises";
import { resolve, relative, dirname, sep, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const pluginRoot = resolve(root, "../PluHub-Plugins");
const plugins = resolve(pluginRoot, "plugins");
const inside = (parent, file) => {
  const path = relative(parent, file);
  return path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path);
};
const owner = (file) =>
  inside(plugins, file) ? relative(plugins, file).split(sep)[0] : undefined;
async function walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (["node_modules", "dist", ".git"].includes(e.name)) continue;
    const file = resolve(dir, e.name);
    if (e.isDirectory()) await walk(file);
    else if (/\.tsx?$/.test(e.name)) {
      const source = await readFile(file, "utf8");
      for (const match of source.matchAll(
        /(?:from\s*|import\s*|import\s*\(\s*)['"]([^'"]+)['"]/g,
      )) {
        const specifier = match[1];
        if (
          /^@pluhub\/(?:kernel|runtime|control|engine)(?:\/|$)/.test(specifier)
        )
          throw new Error("Private host import in " + file);
        if (!specifier.startsWith(".")) continue;
        const target = resolve(dirname(file), specifier);
        if (!inside(pluginRoot, target))
          throw new Error("Relative import leaves plugin workspace in " + file);
        if (owner(target) && owner(file) !== owner(target))
          throw new Error("Private cross-plugin import in " + file);
      }
    }
  }
}
await walk(plugins);
await walk(resolve(pluginRoot, "lib"));
for (const pkg of ["kernel", "engine", "runtime"]) {
  await checkGeneric(resolve(root, "packages", pkg, "src"));
}
async function checkGeneric(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const file = resolve(dir, e.name);
    if (e.isDirectory()) await checkGeneric(file);
    else if (/\.tsx?$/.test(e.name)) {
      const source = await readFile(file, "utf8");
      if (
        /@pluhub\/contracts\/(?:ai|routing|commerce|security|workflow|subscription)/.test(
          source,
        )
      )
        throw new Error("Domain types leaked into " + file);
    }
  }
}
console.log("Plugin and shared-library boundaries verified");
await import("./check-plugin-dependencies.mjs");
