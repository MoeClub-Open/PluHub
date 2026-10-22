# 工程结构与维护约定

## 四仓职责

| 仓库 | 内容 |
| --- | --- |
| PluHub | `packages/` 提供 Host、Kernel、Runtime、Engine、Control、TS/UI SDK 与 Testkit；`apps/cli/` 提供 CLI；`tests/` 执行宿主和跨插件集成测试 |
| PluHub-Spec | 公共契约、Schema、协议样例与兼容性基线，AI、商业、路由及账号安全使用独立可选模块 |
| PluHub-SDK-Go | Go Process SDK、共享协议测试与 echo 示例 |
| PluHub-Plugins | `plugins/<name>/` 实现独立发布的官方插件，`lib/` 保存仓内复用代码，`tests/` 验证协议及插件算法 |

主仓 `scripts/` 只保留可复用入口：四仓构建、打包、基准、Linux 验证、包安装验证、本地演示与显式上游联调。真实上游联调需要自行提供凭证，整理或常规回归不运行该脚本。新站的默认插件清单只在 `apps/cli/src/presets.ts` 维护，由 CLI、Demo 和集成夹具复用。默认 32 项不包含可选的 Protocol Converter 与旧版 Workflow；存量配置和兼容回归仍支持这两个公开能力。

`deploy/docker/` 保存镜像产物准备、持锁入口和健康检查；根目录 `Dockerfile`、`compose.yaml` 通过独立构建上下文组合三仓。`pnpm test:docker` 验证独立容器，`pnpm test:live` 是有额度上限的付费联调入口，两者不隐式加入普通单元测试。

## 官方插件内部结构

~~~text
PluHub-Plugins/
├── plugins/<name>/
│   ├── manifest.json / package.json
│   ├── index.ts             # 后端入口
│   ├── ui.tsx               # 可选前端入口
│   ├── ...                  # 仅此插件使用的内部模块
│   └── dist/                # 唯一分发产物目录
├── lib/
│   ├── ai/                  # 协议编解码、流、入口/上游工厂、思考参数、观测
│   ├── commerce/            # 金额与支付签名
│   ├── http/                # 原始请求体读取
│   ├── identity/            # 邮箱格式校验等身份公共工具
│   ├── storage/             # SQLite 与事务
│   └── ui/                  # React 挂载、组件和复用表单
├── scripts/build.mjs        # 前后端独立 Bundle
└── tests/
~~~

决策器归 Auto Router、输出节拍归 Token Speed、带宽限速归 Rate Limit、账期归 Commerce、浏览器对话流读取归 Playground。Auth 的安全流程和密码学工具位于 `plugins/auth/security/`；Mailer 负责 SMTP 传输，Auth 负责验证用途及收件账号语言，两者复用 `lib/mail/` 模板及邮箱格式校验，不相互导入内部源码。Console 通过 `site.branding@1` 提供邮件所需的公共站点名称、默认语言及主题色。

只被一个插件使用的实现归该插件；跨插件复用的纯工具或工厂归 `lib/`。`lib/` 不反向导入插件。插件之间的业务协作使用 Capability，公共契约仍归 Spec，不能通过共享目录绕过服务边界。

`node scripts/check-boundaries.mjs` 从主仓检查插件及共享库的导入，拒绝跨插件私有引用和宿主私有依赖，并递归检查通用 Kernel/Runtime/Engine 未引入领域契约。

职责复核与本轮调整见 [插件职责检查](PLUGIN_ARCHITECTURE.md)；Capability、实现版本、安装锁和自动依赖安装规则见 [插件依赖与安装](PLUGIN_DEPENDENCIES.md)。Control 的 `package.ts` 负责安全包操作，`dependencies.ts` 负责共享安装解析和事务编排；Console 安装界面独立在 `install-ui.tsx`。

模型原价、缓存、阶梯、分组倍率和预付结算的边界与配置见 [模型计价](PRICING.md)。

支付退款与争议的协议查询归 Stripe 适配器 `adjustments.ts`；订单关联、事实去重及状态投递归 Commerce；原始充值、冲减与冻结的原子事务归 Billing `payments.ts`。三者通过公开 Capability 协作，财务状态不经普通通知事件交付。

前端基础交互优先复用 Radix UI，图标使用 Lucide。共享封装、主题与表单兼容要求见 [前端组件约定](UI_COMPONENTS.md)。

## 构建与产物

插件仓 `tsc` 只执行类型检查，由 esbuild 输出各插件 `dist/` 的后端和前端 Bundle；不再生成仓库根目录 `dist/lib`、`dist/plugins`。构建会先清理当前插件的旧 Bundle，避免保留已移除的 UI 文件。原有 Manifest、包名及公开入口保持不变。

主仓和 Spec 的 `dist/` 仍是公开 npm 包的必要产物。`output/packages/` 保存分发归档与 `SHA256SUMS`；`output/playwright/` 保存验收截图；`output/bench.json` 与 `output/live-newapi.json` 保存有效性能和上游验证证据。

`.pluhub/` 包含配置、数据库和加密密钥，应按运行数据维护，不作为构建缓存清理。`.cache-tools/` 内的 Linux 工具只在仍有引用时保留。浏览器过程快照与历史副本压缩归档，不参与构建或打包；重复的验收二进制采用内容一致的硬链接保留原复现路径。

Windows 开发产物整理使用 `pwsh scripts/clean-artifacts.ps1` 先查看计划，`-Apply` 执行。只处理明确列出的历史归档、浏览器快照、解压后的 Linux Docker 工具缓存和重复 Go 验收二进制。归档逐文件校验 SHA-256 后再清理原副本，报告保存在 `output/history/`；不会处理 `.pluhub/`、生产数据或部署回滚备份。

## 验证入口

~~~sh
pnpm build:all
pnpm test:all
pnpm typecheck
pnpm format:check
pnpm -C ../PluHub-Plugins typecheck
pnpm -C ../PluHub-Spec check:compat
node scripts/check-boundaries.mjs
pnpm pack:all
node scripts/verify-routing-packages.mjs
node scripts/verify-identity-packages.mjs
~~~

Linux 使用 `sh scripts/linux-verify.sh`。可通过 `PLUHUB_NODE_LINUX` 指定 Linux Node，通过 `PLUHUB_PNPM_CLI` 指定 pnpm CLI；缺少这两项时使用系统 Node 和已安装 Vitest。脚本复用 `output/go-echo-linux` 和 `output/go-sdk-linux.test`（若存在），否则需要 Linux Go 工具链。
