import { readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { validateManifest } from "../packages/kernel/dist/index.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const directory = resolve(root, "../PluHub-Plugins/plugins");
const report = [];
for (const entry of (await readdir(directory, { withFileTypes: true }))
  .filter(
    (e) =>
      e.isDirectory() && existsSync(join(directory, e.name, "manifest.json")),
  )
  .sort((a, b) => a.name.localeCompare(b.name))) {
  const path = join(directory, entry.name);
  const manifest = validateManifest(
    JSON.parse(await readFile(join(path, "manifest.json"), "utf8")),
  );
  const pkg = JSON.parse(await readFile(join(path, "package.json"), "utf8"));
  if (pkg.version !== manifest.version)
    throw Error(manifest.id + ": package and manifest versions differ");
  const source = await readFile(join(path, manifest.runtime.entry), "utf8");
  const ast = ts.createSourceFile(
    manifest.runtime.entry,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const calls = new Set(),
    provisions = new Set();
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const method = node.expression.name.text,
        capability = node.arguments[0].text;
      if (/^[a-z][a-z0-9.-]*@[1-9][0-9]*$/.test(capability)) {
        if (["call", "hasCapability"].includes(method)) calls.add(capability);
        if (method === "provide") provisions.add(capability);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  for (const capability of calls)
    if (
      ![
        ...manifest.provides,
        ...manifest.requires,
        ...(manifest.optionalRequires ?? []),
      ].includes(capability)
    )
      throw Error(
        manifest.id +
          ": undeclared bundled capability dependency " +
          capability,
      );
  for (const capability of provisions)
    if (!manifest.provides.includes(capability))
      throw Error(
        manifest.id + ": undeclared provided capability " + capability,
      );
  report.push({
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    requires: manifest.requires,
    optional: manifest.optionalRequires ?? [],
    dependencies: manifest.dependencies ?? {},
    literalCalls: [...calls].sort(),
  });
}
const output = process.argv.indexOf("--output");
if (output >= 0)
  await writeFile(
    resolve(process.argv[output + 1]),
    JSON.stringify({ passed: true, plugins: report }, null, 2) + "\n",
  );
console.log(
  "Plugin dependency declarations and package versions verified (" +
    report.length +
    " plugins)",
);
