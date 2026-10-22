import { mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
export async function scaffold(directory: string, id = "example.hello") {
  if (!/^[a-z][a-z0-9.-]{1,95}$/.test(id)) throw new Error("Invalid plugin id");
  const root = resolve(directory);
  await mkdir(root);
  await mkdir(resolve(root, "src"));
  const manifest = {
    schemaVersion: 1,
    id,
    version: "0.1.0",
    host: ">=0.1.0-alpha.1 <0.2.0-0",
    runtime: { kind: "native", entry: "dist/index.js" },
    provides: [id + "@1"],
    requires: [],
    permissions: ["api.register"],
    ui: {
      entry: "dist/ui.js",
      path: "/" + id,
      title: id,
      slots: [{ name: "dashboard.top", entry: "dist/ui.js" }],
    },
  };
  const files: Record<string, string> = {
    "pnpm-workspace.yaml":
      "packages:\n  - .\nonlyBuiltDependencies:\n  - esbuild\n",
    "manifest.json": JSON.stringify(manifest, null, 2),
    "package.json": JSON.stringify(
      {
        name: id,
        version: "0.1.0",
        type: "module",
        license: "Apache-2.0",
        files: ["dist", "manifest.json"],
        scripts: { build: "node build.mjs" },
        dependencies: {
          "@pluhub/sdk":
            "link:" +
            dirname(dirname(fileURLToPath(import.meta.resolve("@pluhub/sdk")))),
          react: "19.2.0",
          "react-dom": "19.2.0",
        },
        devDependencies: { esbuild: "0.25.12" },
      },
      null,
      2,
    ),
    "src/index.ts":
      "import { definePlugin, json } from '@pluhub/sdk';\nexport default definePlugin({ setup(host) { host.provide('" +
      id +
      "@1', input => ({ hello: input })); host.api({method:'GET',path:'/hello',access:'public',handle:()=>json({message:'Hello from " +
      id +
      "'})}); } });\n",
    "src/ui.ts":
      "import React from 'react';import { createRoot } from 'react-dom/client';export function mount(element) { const root=createRoot(element);root.render(React.createElement('h1',null,'Hello from " +
      id +
      "'));return()=>root.unmount(); }\n",
    "build.mjs":
      "import { build } from 'esbuild';await build({entryPoints:['src/index.ts'],outfile:'dist/index.js',platform:'node',format:'esm',bundle:true});await build({entryPoints:['src/ui.ts'],outfile:'dist/ui.js',platform:'browser',format:'esm',bundle:true});\n",
    ".gitignore": "node_modules/\ndist/\n",
    "README.md":
      "# " +
      id +
      "\n\npnpm install\npnpm build\n\nInstall through pluhub plugin install <directory> --grant api.register. The local SDK dependency can be replaced with a published @pluhub/sdk version.\n",
  };
  for (const [file, content] of Object.entries(files))
    await writeFile(resolve(root, file), content + "\n", { flag: "wx" });
  return root;
}
