import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { HostConfig } from "@pluhub/sdk";

/** Change the externally visible origin without replacing unrelated configuration. */
export async function withPublicOrigin(config: HostConfig, value: string) {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error(
      "Expected an HTTP(S) origin without credentials, path, query or fragment",
    );
  const next = structuredClone(config);
  const entries = await Promise.all(
    next.plugins.map(async (entry) => ({
      entry,
      manifest: JSON.parse(
        await readFile(resolve(entry.path, "manifest.json"), "utf8"),
      ),
    })),
  );
  const listener = entries.find(
    ({ manifest }) => manifest.id === "official.listener",
  )?.entry;
  const auth = entries.find(
    ({ manifest }) => manifest.id === "official.auth",
  )?.entry;
  if (
    !listener ||
    listener.enabled === false ||
    !auth ||
    auth.enabled === false
  )
    throw new Error("An enabled official Listener and Auth are required");
  const webauthn = auth.config?.webauthn as
    { enabled?: boolean; origins?: string[] } | undefined;
  if (webauthn?.enabled && !webauthn.origins?.includes(url.origin))
    throw new Error(
      "Update WebAuthn RP ID and allowed origins before changing the public origin",
    );
  listener.config = { ...listener.config, publicOrigin: url.origin };
  auth.config = { ...auth.config, secureCookie: url.protocol === "https:" };
  return next;
}
