// Local product demo only: the provider is a loopback mock, never a paid API.
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  createKernel,
  attachManagement,
  applyPendingPluginUpdate,
  writeConfig,
} from "../packages/control/dist/index.js";
import { migrateLegacyChannels } from "../../PluHub-Plugins/plugins/ai-router/dist/index.js";
import { defaultPluginNames } from "../apps/cli/dist/presets.js";
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = resolve(
  process.env.PLUHUB_DEMO_DIR ?? resolve(root, ".pluhub/product-demo"),
);
await mkdir(directory, { recursive: true });
const port = Number(process.env.PLUHUB_DEMO_PORT ?? 18181);
const upstreamPort = Number(process.env.PLUHUB_DEMO_UPSTREAM_PORT ?? 18182);
const upstream = createServer(async (request, response) => {
  if (request.method === "GET") {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify(
        request.url === "/api/ratio_config"
          ? {
              success: true,
              data: {
                model_ratio: { "local-chat": 0.25 },
                completion_ratio: { "local-chat": 4 },
              },
            }
          : { data: [{ id: "local-chat" }, { id: "local-code" }] },
      ),
    );
    return;
  }
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString());
  const content = input.messages?.at(-1)?.content ?? "";
  if (content === "/error") {
    response.writeHead(503);
    response.end();
    return;
  }
  const text =
    "你好！这是 PluHub 本地演示上游返回的流式回答。\n\n你的请求已经经过身份认证、模型路由和协议适配。打开「调用记录」，可以查看这次请求的用量与延迟。\n\n这段内容来自本地模拟服务，没有调用真实 AI 模型。";
  const usage = { prompt_tokens: 20, completion_tokens: 40 };
  if (!input.stream) {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        choices: [{ message: { content: text }, finish_reason: "stop" }],
        usage,
      }),
    );
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream" });
  const pieces = text.match(/.{1,5}|\n/gu) ?? [];
  let index = 0;
  const timer = setInterval(() => {
    if (index < pieces.length)
      response.write(
        "data: " +
          JSON.stringify({
            choices: [{ index: 0, delta: { content: pieces[index++] } }],
          }) +
          "\n\n",
      );
    else {
      clearInterval(timer);
      response.end(
        "data: " +
          JSON.stringify({
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage,
          }) +
          "\n\ndata: [DONE]\n\n",
      );
    }
  }, 45);
  response.on("close", () => clearInterval(timer));
});
await new Promise((resolve, reject) => {
  upstream.once("error", reject);
  upstream.listen(upstreamPort, "127.0.0.1", resolve);
});
process.env.PLUHUB_DEMO_UPSTREAM_KEY = randomBytes(24).toString("hex");
const models = Object.fromEntries(
  ["chat", "writer", "code"].map((name, index) => [
    "demo/" + name,
    {
      upstream: "local",
      model: "local-" + name,
      name: ["PluHub Chat", "PluHub Writer", "PluHub Code"][index],
      provider: "Local Demo",
      description:
        "本地模拟模型，用于体验流式调用与网关观测。不会访问真实服务商；Token 用量为固定演示值。",
      inputPrice: 0,
      outputPrice: 0,
      reasoningEfforts: ["low", "medium", "high"],
    },
  ]),
);
const plugins = await Promise.all(
  defaultPluginNames.map(async (name) => {
    const path = resolve(root, "../PluHub-Plugins/plugins", name);
    const manifest = JSON.parse(
      await readFile(resolve(path, "manifest.json"), "utf8"),
    );
    return {
      path,
      grants: manifest.permissions,
      config:
        name === "byok"
          ? { allowedPrivateOrigins: ["http://127.0.0.1:" + upstreamPort] }
          : name === "auth" && process.env.PLUHUB_DEMO_IDENTITY
            ? {
                registrationEnabled: true,
                emailLoginEnabled: true,
                webauthn: {
                  enabled: true,
                  rpID: "localhost",
                  rpName: "PluHub 本地演示",
                  origins: ["http://localhost:" + port],
                },
              }
            : name === "mailer" && process.env.PLUHUB_DEMO_IDENTITY
              ? {
                  enabled: true,
                  host: "127.0.0.1",
                  port: Number(process.env.PLUHUB_DEMO_SMTP_PORT),
                  allowInsecure: true,
                  from: "no-reply@example.test",
                }
              : name === "commerce"
                ? {
                    publicUrl: "http://127.0.0.1:" + port,
                    products: [
                      {
                        id: "demo-credit",
                        name: "按需额度",
                        mode: "payment",
                        currency: "usd",
                        paymentMinor: 500,
                        creditMicros: 5000000,
                      },
                      {
                        id: "demo-month",
                        name: "开发者月度套餐",
                        mode: "subscription",
                        interval: "month",
                        currency: "usd",
                        paymentMinor: 2000,
                        creditMicros: 20000000,
                      },
                      {
                        id: "demo-cny",
                        name: "预付周期套餐",
                        mode: "subscription",
                        interval: "month",
                        currency: "cny",
                        paymentMinor: 9900,
                        creditMicros: 15000000,
                      },
                    ],
                  }
                : name === "listener"
                  ? { port, host: "127.0.0.1" }
                  : name === "auto-router"
                    ? {
                        profiles: {
                          smart: {
                            name: "演示智能路由",
                            mode: "both",
                            decision: { kind: "rules" },
                            fallbackCandidate: "code",
                            candidates: [
                              {
                                id: "chat",
                                target: "demo/chat",
                                strength: 30,
                                reasoningEfforts: ["low", "medium", "high"],
                              },
                              {
                                id: "code",
                                target: "demo/code",
                                strength: 95,
                                reasoningEfforts: ["low", "medium", "high"],
                              },
                            ],
                          },
                        },
                      }
                    : name === "ai-router"
                      ? {
                          upstreams: {
                            workflow: {
                              name: "组合渠道 · 演示",
                              flow: {
                                entry: "start",
                                nodes: [
                                  {
                                    id: "start",
                                    type: "start",
                                    next: "prompt",
                                  },
                                  {
                                    id: "prompt",
                                    type: "prompt",
                                    text: "请简洁、准确地回答。",
                                    next: "branch",
                                  },
                                  {
                                    id: "branch",
                                    type: "condition",
                                    test: "hasTools",
                                    yes: "smart",
                                    no: "pace",
                                  },
                                  {
                                    id: "pace",
                                    type: "tps",
                                    rate: 100,
                                    tokenizer: "o200k_base",
                                    next: "chat",
                                  },
                                  {
                                    id: "smart",
                                    type: "upstream",
                                    target: "auto/smart",
                                    mode: "explicit",
                                  },
                                  {
                                    id: "chat",
                                    type: "upstream",
                                    target: "demo/chat",
                                    mode: "implicit",
                                  },
                                ],
                              },
                            },
                            smart: {
                              protocol: "auto-router",
                              name: "智能路由 · 演示",
                            },
                            local: {
                              name: "Local demo provider",
                              protocol: "openai-chat",
                              baseUrl: "http://127.0.0.1:" + upstreamPort,
                              keyRef: "env:PLUHUB_DEMO_UPSTREAM_KEY",
                            },
                          },
                          models: {
                            ...models,
                            "workflow/standard": {
                              upstream: "workflow",
                              model: "standard",
                              name: "PluHub 组合渠道",
                              provider: "PluHub",
                              description:
                                "可视化组合提示词、分支、TPS 和上游。",
                            },
                            "auto/smart": {
                              upstream: "smart",
                              model: "smart",
                              name: "PluHub Auto",
                              provider: "PluHub Auto",
                              description:
                                "规则决策演示：按任务难度选择本地模拟模型与思考强度。",
                            },
                          },
                          redirects: {
                            "demo/legacy": {
                              target: "demo/chat",
                              mode: "implicit",
                            },
                            "demo/latest": {
                              target: "auto/smart",
                              mode: "explicit",
                            },
                          },
                        }
                      : name.startsWith("upstream-")
                        ? { secretRefs: ["env:PLUHUB_DEMO_UPSTREAM_KEY"] }
                        : {},
    };
  }),
);
const config = {
  schemaVersion: 1,
  dataDir: resolve(directory, "data"),
  drainTimeoutMs: 3000,
  plugins,
};
const file = resolve(directory, "config.json");
migrateLegacyChannels(config);
await writeConfig(file, config);
let kernel = await createKernel(config),
  restartTask;
const restart = async () => {
  if (restartTask) return restartTask;
  restartTask = applyPendingPluginUpdate(kernel, file, { restart }).then(
    (result) => {
      kernel = result.kernel;
    },
  );
  try {
    await restartTask;
  } finally {
    restartTask = undefined;
  }
};
attachManagement(kernel, file, config, { restart });
try {
  await kernel.start();
} catch (error) {
  upstream.close();
  throw error;
}
const password =
  process.env.PLUHUB_DEMO_PASSWORD ?? randomBytes(18).toString("base64url");
await kernel.invoke("auth.bootstrap@1", { username: "admin", password });
console.log(
  "Local mock demo: http://" +
    (process.env.PLUHUB_DEMO_IDENTITY ? "localhost" : "127.0.0.1") +
    ":" +
    port,
);
console.log("User: admin | Password: " + password);
console.log(
  "Demo config/data: " +
    directory +
    ". Restart resets demo routes and administrator password.",
);
let closing = false;
async function stop() {
  if (closing) return;
  closing = true;
  await restartTask;
  await kernel.shutdown();
  upstream.closeAllConnections();
  upstream.close();
}
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
