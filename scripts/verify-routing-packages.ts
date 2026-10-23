// Verify installed bundles outside every source checkout, without contacting providers.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { join, resolve, relative, isAbsolute } from "node:path";
import { install, createKernel } from "../packages/control/dist/index.js";
import { releasePackage } from "./release-package.mjs";
const parent = resolve(tmpdir());
const directory = await mkdtemp(join(parent, "pluhub-routing-package-"));
let kernel;
try {
  const plugins = [];
  for (const name of [
    "http-transport",
    "upstream-openai-chat",
    "ai-router",
    "auto-router",
    "token-speed",
    "workflow",
  ]) {
    const entry = await install(
      await releasePackage("official." + name),
      join(directory, "plugins"),
    );
    const manifest = JSON.parse(
      await readFile(join(entry.path, "manifest.json"), "utf8"),
    );
    plugins.push({
      path: entry.path,
      integrity: entry.sha256,
      grants: manifest.permissions,
      config:
        name === "ai-router"
          ? {
              upstreams: {
                p: {
                  protocol: "openai-chat",
                  baseUrl: "http://127.0.0.1:1",
                  keyRef: "env:PLUHUB_PACKAGE_KEY",
                },
                smart: { protocol: "auto-router" },
                composed: { protocol: "workflow" },
              },
              models: {
                physical: { upstream: "p", model: "m" },
                auto: { upstream: "smart", model: "smart" },
                composed: { upstream: "composed", model: "standard" },
              },
            }
          : name === "auto-router"
            ? {
                profiles: {
                  smart: {
                    mode: "both",
                    decision: { kind: "rules" },
                    fallbackCandidate: "c",
                    candidates: [
                      {
                        id: "c",
                        target: "physical",
                        strength: 100,
                        reasoningEfforts: ["low", "high"],
                      },
                    ],
                  },
                },
              }
            : name === "workflow"
              ? {
                  flows: {
                    standard: {
                      entry: "start",
                      nodes: [
                        { id: "start", type: "start", next: "prompt" },
                        {
                          id: "prompt",
                          type: "prompt",
                          text: "package workflow",
                          next: "call",
                        },
                        {
                          id: "call",
                          type: "upstream",
                          target: "auto",
                          mode: "explicit",
                        },
                      ],
                    },
                  },
                }
              : name === "token-speed"
                ? { default: { tps: 1000, tokenizer: "o200k_base" } }
                : {},
    });
  }
  const config = {
    schemaVersion: 1,
    dataDir: join(directory, "data"),
    plugins,
  };
  const routerEntry = plugins.find((p) =>
    p.path.replaceAll("\\", "/").endsWith("/official.ai-router"),
  );
  const { migrateLegacyChannels } = await import(
    pathToFileURL(join(routerEntry.path, "dist/index.js")).href
  );
  assert.equal(migrateLegacyChannels(config), true);
  assert.ok(
    Object.values(routerEntry.config.upstreams).every(
      (channel) => !channel.protocol && channel.flow,
    ),
  );
  config.plugins = config.plugins.filter(
    (p) => !p.path.replaceAll("\\", "/").endsWith("/official.workflow"),
  );
  kernel = await createKernel(config);
  await kernel.start();
  const plan = await kernel.invoke("ai.routing@2", {
    model: "auto",
    features: ["text"],
    request: {
      model: "auto",
      messages: [{ role: "user", text: "hello" }],
      tools: [],
      stream: false,
    },
  });
  assert.equal(plan.model, "m");
  assert.equal(plan.logicalUpstreamId, "smart");
  assert.equal(plan.reasoning.effort, "low");
  const composed = await kernel.invoke("ai.routing@2", {
    model: "composed",
    features: ["text"],
    request: {
      model: "composed",
      messages: [{ role: "user", text: "hello" }],
      tools: [],
      stream: false,
    },
  });
  assert.equal(composed.model, "m");
  assert.equal(composed.responseModel, "auto");
  assert.equal(composed.preparedRequest.messages[0].text, "package workflow");
  assert.equal(composed.workflows[0].profile, "composed");
  async function* events() {
    yield { type: "text", text: "hello" };
    yield { type: "finish", reason: "stop" };
  }
  const paced = await kernel.invoke("ai.output-pace@1", {
    events: events(),
    plan,
  });
  let text = "";
  for await (const event of paced)
    if (event.type === "text") text += event.text;
  assert.equal(text, "hello");
  console.log(
    "Installed unified channel graphs and tokenizer bundles verified without the legacy workflow plugin; no provider requests were sent.",
  );
} finally {
  await kernel?.shutdown();
  const target = resolve(directory),
    child = relative(parent, target);
  assert.ok(
    child &&
      !child.startsWith("..") &&
      !isAbsolute(child) &&
      child.startsWith("pluhub-routing-package-"),
  );
  await rm(target, { recursive: true, force: true, maxRetries: 5 });
}
