import { it, expect } from "vitest";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SecretVault } from "../packages/kernel/dist/index.js";
import { migrateManagedSecrets } from "../deploy/migrations/managed-secrets.ts";
import { fixture } from "./helpers.js";

it("imports old references into encrypted storage once and preserves a recoverable configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pluhub-managed-migration-"));
  const file = join(directory, "pluhub.json");
  const variable = "PLUHUB_MIGRATION_FIXTURE";
  const previous = process.env[variable];
  try {
    process.env[variable] = "offline-migration-only";
    await writeFile(
      file,
      JSON.stringify({
        dataDir: "state",
        plugins: [
          {
            config: {
              keyRef: "env:" + variable,
              secretRefs: ["env:" + variable],
            },
          },
        ],
      }),
    );
    expect(migrateManagedSecrets(file, false)).toMatchObject({
      changed: false,
      references: 1,
    });
    expect(migrateManagedSecrets(file)).toMatchObject({
      changed: true,
      imported: 1,
    });
    expect(process.env[variable]).toBeUndefined();
    const saved = JSON.parse(await readFile(file, "utf8"));
    const vault = new SecretVault(join(directory, "state"));
    expect(saved.plugins[0].config.keyRef).toBe("secret:" + variable);
    expect(vault.get(saved.plugins[0].config.keyRef)).toBe(
      "offline-migration-only",
    );
    expect(
      await readFile(join(directory, "state", "secrets.json"), "utf8"),
    ).not.toContain("offline-migration-only");
    expect(migrateManagedSecrets(file)).toMatchObject({
      changed: false,
      references: 0,
    });
    expect(await readFile(file + ".before-managed-secrets", "utf8")).toContain(
      "env:" + variable,
    );
  } finally {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

it("seals directly entered channel keys before saving and authorizes the text and media adapters", async () => {
  const authorizations: string[] = [];
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      /* Drain the request. */
    }
    authorizations.push(String(request.headers.authorization));
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(
        request.url?.includes("images")
          ? { data: [{ b64_json: "aW1hZ2U=" }] }
          : {
              choices: [
                { message: { content: "hello" }, finish_reason: "stop" },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const f = await fixture(
    [
      "users",
      "auth",
      "ai-router",
      "rate-limit",
      "http-transport",
      "upstream-openai-chat",
      "upstream-openai-media",
      "ingress-openai-chat",
      "ingress-openai-media",
    ],
    {
      "upstream-openai-chat": { secretRefs: [] },
      "upstream-openai-media": { secretRefs: [] },
    },
  );
  try {
    const admin = await f.admin();
    const original = await (
      await f.request(
        "/api/plugins/official.ai-router/configuration",
        "GET",
        undefined,
        admin,
      )
    ).json();
    const key = "entered-directly-through-management";
    original.config.upstreams = {
      "1": {
        protocol: "openai-chat",
        baseUrl: `http://127.0.0.1:${(server.address() as any).port}/v1`,
        keyRef: [key],
      },
    };
    original.config.models = {
      chat: { upstream: "1", model: "text" },
      image: {
        upstream: "1",
        model: "picture",
        operations: ["images/generations"],
      },
    };
    const update = await f.request(
      "/api/plugins/official.ai-router/configuration",
      "PUT",
      original,
      admin,
    );
    expect(update.status, await update.clone().text()).toBe(200);
    const visible = await (
      await f.request(
        "/api/plugins/official.ai-router/configuration",
        "GET",
        undefined,
        admin,
      )
    ).json();
    expect(visible.config.upstreams["1"].keyRef[0]).toMatch(/^secret:/);
    expect(JSON.stringify(visible)).not.toContain(key);
    expect(await readFile(f.file, "utf8")).not.toContain(key);
    expect(
      await readFile(join(f.config.dataDir, "secrets.json"), "utf8"),
    ).not.toContain(key);
    const chat = await f.request(
      "/v1/chat/completions",
      "POST",
      { model: "chat", messages: [{ role: "user", content: "hello" }] },
      admin,
    );
    expect(chat.status, await chat.clone().text()).toBe(200);
    await chat.text();
    const image = await f.request(
      "/v1/images/generations",
      "POST",
      { model: "image", prompt: "cup" },
      admin,
    );
    expect(image.status, await image.clone().text()).toBe(200);
    await image.text();
    expect(authorizations).toEqual(["Bearer " + key, "Bearer " + key]);
    const intruder = await f.request(
      "/api/plugins/official.ai-router/configuration",
      "PUT",
      original,
    );
    expect(intruder.status).toBe(401);
    const restricted = await (
      await f.request("/api/host/config", "GET", undefined, admin)
    ).json();
    restricted.plugins.find((plugin: any) =>
      plugin.path.endsWith("upstream-openai-media"),
    ).config.secretRefs = [];
    expect(
      (await f.request("/api/host/config", "PUT", restricted, admin)).status,
    ).toBe(200);
    const denied = await f.request(
      "/v1/images/generations",
      "POST",
      { model: "image", prompt: "cup" },
      admin,
    );
    expect(denied.status).toBe(403);
    await denied.text();
    expect(authorizations).toHaveLength(2);
  } finally {
    await f.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
