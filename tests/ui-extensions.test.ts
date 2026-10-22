import { it, expect } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mockHost } from "../packages/testkit/dist/index.js";
import { validateManifest } from "../packages/kernel/dist/index.js";
import type { Manifest } from "../packages/sdk/dist/index.js";

const manifest: Manifest = {
  schemaVersion: 1,
  id: "example.settings",
  version: "1.0.0",
  host: ">=0.1.0-alpha.1",
  runtime: { kind: "native", entry: "index.mjs" },
  provides: [],
  requires: [],
  permissions: [],
  ui: {
    entry: "dist/ui.js",
    title: "Personal",
    path: "/personal",
    public: true,
    pages: [
      {
        title: "Admin",
        path: "/settings/example",
        group: "payments",
        order: 5,
      },
    ],
  },
};

it("registers additional private UI pages without inheriting public access and removes all pages on stop", async () => {
  const f = await mockHost();
  try {
    const directory = join(f.directory, manifest.id);
    await mkdir(join(directory, "dist"), { recursive: true });
    await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest));
    await writeFile(join(directory, "index.mjs"), "export default {setup(){}}");
    await writeFile(join(directory, "dist/ui.js"), "export function mount(){}");
    await f.kernel.add(directory);
    await f.kernel.start();
    const pages = f.kernel.extensions();
    expect(pages).toHaveLength(2);
    expect(pages[0]).toMatchObject({ id: manifest.id, public: true });
    expect(pages[1]).toMatchObject({
      path: "/settings/example",
      group: "payments",
      order: 5,
      url: pages[0].url,
    });
    expect(pages[1].public).toBeUndefined();
    expect(
      (await f.kernel.fetch(new Request("http://test" + pages[1].url))).status,
    ).toBe(200);
    await f.kernel.stop(manifest.id);
    expect(f.kernel.extensions()).toEqual([]);
    expect(
      (await f.kernel.fetch(new Request("http://test" + pages[1].url))).status,
    ).toBe(404);
  } finally {
    await f.close();
  }
});

it("rejects duplicate UI page paths and malformed grouping metadata", () => {
  expect(() =>
    validateManifest({
      ...manifest,
      ui: {
        ...manifest.ui,
        pages: [{ title: "Duplicate", path: "/personal" }],
      },
    }),
  ).toThrow("unique");
  expect(() =>
    validateManifest({
      ...manifest,
      ui: { ...manifest.ui, group: "../escape" },
    }),
  ).toThrow();
});
