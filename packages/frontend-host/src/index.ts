import { resolve, relative, dirname, sep } from "node:path";
import { readFile, realpath } from "node:fs/promises";
import type { Manifest } from "@pluhub/sdk";
export interface Extension {
  id: string;
  title: string;
  path: string;
  url: string;
  public?: boolean;
  group?: string;
  order?: number;
}
export function extension(manifest: Manifest): Extension | undefined {
  const ui = manifest.ui;
  return ui
    ? {
        id: manifest.id,
        title: ui.title,
        path: ui.path,
        url: "/extensions/" + manifest.id + "/" + ui.entry.split("/").pop(),
        public: ui.public,
        group: ui.group,
        order: ui.order,
      }
    : undefined;
}
export function extensions(manifest: Manifest): Extension[] {
  const primary = extension(manifest);
  if (!primary) return [];
  return [
    primary,
    ...(manifest.ui?.pages ?? []).map((page, index) => ({
      id: manifest.id + ":page:" + index,
      ...page,
      url: primary.url,
    })),
  ];
}
export async function serveAsset(
  base: string,
  manifest: Manifest,
  name: string,
): Promise<Response> {
  if (!manifest.ui || !/^[-a-zA-Z0-9_.]+\.(js|css)$/.test(name))
    return new Response("Not found", { status: 404 });
  const dir = await realpath(resolve(base, dirname(manifest.ui.entry)));
  const file = await realpath(resolve(dir, name)).catch(() => null);
  if (!file || relative(dir, file).startsWith(".." + sep))
    return new Response("Not found", { status: 404 });
  return new Response(await readFile(file), {
    headers: {
      "content-type": name.endsWith(".css") ? "text/css" : "text/javascript",
      "cache-control": "no-cache",
      "x-content-type-options": "nosniff",
    },
  });
}

export interface SlotContribution {
  id: string;
  slot: string;
  url: string;
}
export function slotContributions(manifest: Manifest): SlotContribution[] {
  return (manifest.ui?.slots ?? []).map((slot, index) => ({
    id: manifest.id + ":" + index,
    slot: slot.name,
    url: "/extensions/" + manifest.id + "/" + slot.entry.split("/").pop(),
  }));
}
