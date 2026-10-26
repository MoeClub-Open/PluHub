# PluHub

可组合的插件驱动网关。当前提供 TypeScript 插件宿主、Go 进程插件 SDK、React 控制台、用户认证，以及独立的 AI 入口协议和上游适配器。

当前版本为可运行 Alpha，交付范围和生产适用边界见 [实现范围](docs/IMPLEMENTATION.md)。

正式支持 **Linux x64、Bun 1.4.3**。默认单节点运行，用户与认证分别使用本地 SQLite，不需要 PostgreSQL、Redis 或消息队列。

## 四仓布局

```text
Dev/
├── PluHub/             # Host、CLI、TS SDK、UI SDK、测试工具
├── PluHub-Spec/        # Manifest、RPC、配置及 AI 契约
├── PluHub-SDK-Go/      # Go SDK 与进程插件示例
└── PluHub-Plugins/     # 独立发布的官方插件
```

开发时通过公开包入口链接本地依赖；插件不导入宿主私有源码。其他三个仓库需位于主仓同级目录，CI 通过完整提交 ID 固定版本组合。

源码归属、共享库分组、构建产物和维护入口见 [工程结构](docs/STRUCTURE.md)。

Docker 部署见 [容器部署指南](docs/DOCKER.md)：`docker compose build` 后运行 `docker compose up -d`，在网页中先设置站点与门户，再创建管理员。支持持久化数据卷、健康检查和非 root 运行。

## 开始运行

运行时安装 Bun 1.4.3；源码构建使用 Node.js 24.22.0、pnpm 10.20.0。开发 Go 插件时安装 Go 1.27.0。

```sh
cd PluHub
pnpm bootstrap
pnpm build:all
bun apps/cli/dist/index.js init
bun apps/cli/dist/index.js start
```

打开 http://127.0.0.1:8080 ，按「站点信息 → 公开门户 → 确认设置 → 管理员账号」完成首次部署；已有管理员的实例直接登录。新站预装 35 个插件，默认启用账号、网关、请求限流、标准协议、模型目录、Playground 与日志等 18 个基础插件，其他功能和定时备份按需启用；管理员通过独立管理入口创建用户、管理插件、配置渠道与模型映射。用户可浏览模型、创建及撤销自己的 API Key，并在 Playground 发起流式对话。密钥支持复制、轮换和撤销，管理操作要求登录会话。平台密钥绑定使用分组，个人密钥绑定自己的个人渠道。[整站排行榜](docs/LEADERBOARD.md) 提供用户用量榜和模型热度榜。新增计费、Stripe/易支付、商品订阅、BYOK、流量策略和订阅上游，配置与边界见 [商业能力](docs/COMMERCIAL.md)。自动路由与单请求 TPS 的模式、原生决策接口及分词语义见 [自动路由](docs/AUTO_ROUTING.md)。邮箱注册、邮件发送、Turnstile、TOTP 与 Passkey 配置见 [账号安全](docs/IDENTITY.md)。

网关提供调用总览、按用户隔离的请求记录、Token 用量与配置价格成本估算。API Key 支持模型范围、到期时间和每分钟请求限制。使用及升级说明见 [AI 网关功能](docs/GATEWAY.md)。

仅体验本地演示可运行 `pnpm demo`，打开 http://127.0.0.1:18181 ，使用终端输出的管理员密码登录。演示使用独立目录 `.pluhub/product-demo` 和本地模拟上游，不调用真实服务商；每次启动会重置演示路由与管理员密码，保留演示数据库。

init --port 9000 可指定端口，--config /path/pluhub.json 可指定配置文件。validate 执行静态配置与依赖校验，不启动 Listener。

## 配置 AI 调用

在启动进程前设置上游密钥环境变量。进入控制台“模型与上游”，保存以下结构；界面同时更新对应上游插件的密钥引用授权。

```json
{
  "upstreams": {
    "primary": {
      "flow": {
        "entry": "start",
        "nodes": [
          { "id": "start", "type": "start", "next": "call" },
          {
            "id": "call",
            "type": "provider",
            "upstream": {
              "protocol": "openai-chat",
              "baseUrl": "https://api.openai.com/v1",
              "keyRef": "env:OPENAI_API_KEY"
            }
          }
        ]
      }
    }
  },
  "models": {
    "my-model": { "upstream": "primary", "model": "your-upstream-model" }
  }
}
```

入口与上游独立组合，上游 protocol 可选 openai-chat、openai-responses、anthropic、gemini。客户端使用网关签发的 API Key；服务商凭证由上游插件读取，两者不会混用。

完整能力范围及限制见 [协议支持矩阵](docs/PROTOCOLS.md)。当前测试使用本地模拟上游，不代表已完成真实服务商兼容认证。

## 插件开发

渠道可以通过工作流组合条件、提示词、思考强度、输出预算、TPS 和上游选择；支持隐式/显式模型重定向。配置见 [渠道工作流](docs/WORKFLOWS.md)。真实上游及转换验证的范围和预算见 [联调说明](docs/LIVE_TESTING.md)。

```sh
bun apps/cli/dist/index.js create-plugin ./hello-plugin --id example.hello
cd hello-plugin
pnpm install
pnpm build
```

模板只导入公开 SDK，同时生成后端 API 和可注销的前端模块。返回主仓后安装：

```sh
bun apps/cli/dist/index.js plugin install ./hello-plugin --grant api.register
```

CLI 安装在宿主停机时使用，完成后启动宿主。控制台支持安装、启停和检查插件更新；声明支持在线升级的插件通过新执行图切换，其余插件重启升级，界面会显示实际更新方式。Go 示例见同级 PluHub-SDK-Go/examples/echo。

Native 与 Process 都是安装者授权的本机代码，当前没有操作系统沙箱或不可信 UI 隔离。

## 验证与基准

```sh
pnpm build:all
pnpm test:all
node scripts/check-boundaries.mjs
pnpm bench
```

测试覆盖插件生命周期、权限、Go RPC、HTTP/SSE/WS、取消、配置快照、账号认证及 AI 转换。基准记录在 output/bench.json，包含环境、源码摘要、负载和直连/Raw/Native 对照；这是首份基线，没有固定吞吐承诺。

Linux CI 定义于各仓 .github/workflows/ci.yml。CI 保留当前仓 PR 版本，通过 `ci/companions.json` 固定其他仓库的提交进行集成；四仓需先存在并可访问。私有仓使用 CROSS_REPO_TOKEN。

## 运行约定

- 配置中的 path、dataDir 相对配置文件解析。
- Linux SIGHUP 校验并切换可热更新配置；失败保留旧图。在途请求固定使用原图。
- SIGINT / SIGTERM 停止准入并排空，默认期限 30 秒。
- Listener、Users、Auth 等静态配置改变需要重启；AI 路由和上游密钥引用配置支持快照切换。
- 远程部署由 TLS 反向代理提供 HTTPS，Listener 配置 publicOrigin 为对外 HTTPS Origin，并设置 Auth 配置 secureCookie: true。
- 普通 API 渠道不自动跨渠道重试；订阅上游可在首事件前按安全条件切换同渠道账号。流中途失败输出协议错误并结束，不拼接结果。

许可证：Apache-2.0。
