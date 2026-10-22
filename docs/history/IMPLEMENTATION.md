# PluHub Alpha 历史验收记录

本文保留各轮验收时的数量、结果及限制，不代表当前状态。当前入口见 [实现状态](../IMPLEMENTATION.md)，目录约定见 [工程结构](../STRUCTURE.md)。

## 账号验证方式迭代验收（2026-10-19）

- 新增 Mailer、Turnstile，当前共 31 个官方插件。Auth 扩展邮箱验证码注册/登录/绑定、TOTP、单次恢复码、FIDO2 安全密钥和 Passkey；各方式独立启用，默认保持密码登录。站点策略、SMTP 与 Turnstile 有管理员配置表单，个人账号安全页可绑定和撤销凭据。
- Windows 与 Ubuntu 22.04 / WSL2 全套 85 项测试通过：主仓 44、Plugins 37、Spec 2、Go SDK 2。随后补充缺失加密密钥的拒绝行为、CLI 选取已安装可选服务的依赖闭包；两平台对认证集成 9 项、认证/验证码单测 4 项定向复测通过。构建、类型、格式、Manifest 兼容性与插件边界检查通过。
- 测试包括真实本地 SMTP 会话、RFC 6238 样例、邮件码过期/猜测/邮箱换绑、验证码 action/hostname/age/重放、TOTP 重放、一次性恢复码、WebAuthn 实际密码学签名、Origin/RP/UV/跨站/计数器错误、账号禁用、API Key 权限隔离、会话撤销、数据库迁移与本地 CLI 恢复。
- Playwright 实际验证邮箱注册、验证器扫码绑定及恢复码生成、密码登录后的第二步、恢复码完成登录、浏览器虚拟 FIDO2 的 Passkey 绑定/登录/撤销。SMTP 管理页保存与本地测试邮件已验证。截图保存在 `output/playwright/identity-*.png`；截图不包含恢复码或 TOTP 密钥。
- 31 个插件与 10 个 npm 包已打包，附 SHA-256 清单。`scripts/verify-identity-packages.mjs` 在源码目录外安装归档，验证密码会话、TOTP 二维码、WebAuthn options 与本地 SMTP；原自动路由打包检查仍通过。外部 SMTP 投递、真实 Cloudflare 站点密钥和实体硬件未验证，详见 [账号安全](../IDENTITY.md)。代码未提交、推送或发布。

## 自动路由与单请求 TPS 迭代验收（2026-10-19）

- 新增 Auto Router、Token Speed，当前共 29 个官方插件。实现 Luna Decisions、Clef/SystemOne、JEV decide 三种原生决策协议及离线规则；支持自动模型、自动思考、同时调整和手动模式，强度与档位配置支持快照更新。
- 虚拟提供商内部引用真实模型别名，在计费与准入前完成解析。验证 Key 范围与 RPM 在远程分类前拦截、最终模型计价、BYOK 候选隔离、递归拒绝、协议能力过滤及失败保底。调用记录保存选择元数据，旧版请求数据库迁移保留原记录。
- TPS 按单请求独立节拍，使用显式 tiktoken/Hugging Face tokenizer。验证 Unicode、工具参数、完整工具名称起始帧、隐藏用量补足、空闲无突发、取消及输出跟踪上限。限速控制客户端交付，不控制服务商内部推理速度；BPE 前缀高水位计数可能更保守。
- Windows 全套测试 72 项通过：主仓 35、Plugins 33、Spec 2、Go SDK 2。Linux / Ubuntu 22.04 / WSL2 完整脚本先通过 70 项，随后补充自备 tokenizer 和旧日志迁移，对相关文件 5 项定向复测通过；最终路由调整再对主仓路由集成 5 项和 Plugins 路由/限速 18 项定向复测。Manifest v1 兼容性、插件边界、构建与类型检查通过。
- 浏览器实际验证新建策略、添加候选、强度保存、模式切换、固定模型自动思考、虚拟提供商挂载、决策预览与 TPS 默认/模型规则保存。截图为 `output/playwright/auto-router.png`、`output/playwright/token-speed.png`。只使用本地模拟回答上游；没有用用户历史密钥发起本轮付费调用。
- 生成 10 个 npm 包与 29 个插件归档，附 `output/packages/SHA256SUMS`。`scripts/verify-routing-packages.mjs` 在源码目录之外安装并运行相关归档，验证打包后的路由、分词器可加载。真实远程决策模型、准确率与费用未在线实测。完整配置与边界见 [自动路由](../AUTO_ROUTING.md)。

当前默认安装 31 个插件，账号验证方式见 [账号安全](../IDENTITY.md)，自动路由和单请求 TPS 见 [自动路由](../AUTO_ROUTING.md)；计费、支付、商品订阅、BYOK、流量策略、转换器及订阅上游见 [商业能力](../COMMERCIAL.md)。以下保留各阶段验收记录。功能与升级步骤见 [AI 网关功能](../GATEWAY.md)；下面保留首轮框架验收记录。

版本：`0.1.0-alpha.1`。本次交付为本地可运行的 Alpha，正式运行目标为 Linux x64。四仓代码均在本地工作树中，未提交、推送或发布；GitHub Actions 已配置，尚未在远端执行。

## 已交付

| 计划范围 | 实现入口 | 当前结果 |
| --- | --- | --- |
| F01 工程与契约 | 同级 `PluHub-Spec`、四仓 CI | Manifest/配置 Schema、版本及依赖约束、共享 TS/Go 样例、Manifest v1 兼容性基线 |
| F02 Kernel | `packages/kernel` | 依赖解析、能力绑定、Host API 授权、生命周期、插件启停及资源注销 |
| F03 Runtime 与 SDK | `packages/runtime`、`packages/sdk`、同级 `PluHub-SDK-Go` | Native ESM、JSON-RPC 2.0 进程插件、反向调用、取消、超时与异常退出处理 |
| F04 配置与控制面 | `packages/control`、`apps/cli` | Schema 校验、本地安装与归档校验、CLI、管理 API、插件命名空间 |
| F05 Gateway Engine | `packages/engine`、`packages/kernel` | 七阶段、配置与能力绑定快照、HTTP/SSE/WS、背压、取消、Finalize 与排空 |
| F06 前端扩展 | `packages/frontend-host`、`packages/ui-sdk` | React 页面、菜单、命名插槽、API 客户端及停用注销 |
| F07 开发工具 | `packages/testkit`、`create-plugin` 命令、各仓测试 | 模拟 Host、全栈模板、协议与集成测试；生成的插件可独立安装依赖及构建 |
| 基础插件 | 同级 `PluHub-Plugins/plugins` | Listener、HTTP Transport、Console、Users、Auth；用户事实与凭证分库保存 |
| AI 适配器 | 同级 `PluHub-Plugins/plugins` | 四类接口各有独立 ingress/upstream 插件，AI Router 提供静态模型映射及配置界面 |

总计 14 个官方插件。用户账号覆盖管理员、普通用户、会话、个人 API Key、用户禁用及撤销；上游密钥通过环境变量引用，与用户 Key 分离。AI 功能范围及明确拒绝项见 [协议支持矩阵](../PROTOCOLS.md)。

## 已执行的验证

最终 Linux 验证在 Ubuntu 22.04 / WSL2、Node.js 24.11.1 下执行，脚本为 `scripts/linux-verify.sh`，退出码为 0。

| 仓库 | 通过测试数 | 验证内容 |
| --- | ---: | --- |
| PluHub | 21 | 生命周期、授权、配置和能力绑定快照、Go 调用、崩溃处理、安装恢复、HTTP/SSE/WS、账号认证、模板及 AI 集成 |
| PluHub-Plugins | 7 | AI 样例、分块解析、工具与错误处理、功能拒绝 |
| PluHub-Spec | 2 | TS 共享 Manifest 样例；另通过兼容性检查 |
| PluHub-SDK-Go | 2 | Go 共享样例和初始化时反向 Host 调用 |

主仓 AI 集成测试包含 4 个入口 × 4 个上游 × 流式/非流式 × 文本/工具，共 64 个组合，验证用量与凭证隔离。上游均为本地模拟服务，未使用真实服务商凭证；这不代表已通过服务商兼容认证。

构建、类型检查、格式检查、公开依赖边界检查及 `go vet` 已通过。本地未运行 Go 竞态检测；Linux CI 已配置该检查。

浏览器验收已执行管理员登录、用户创建、Key 创建和模型配置保存。在 Linux 宿主上另验证：安装仅使用公开 SDK 的全栈插件后，新增菜单、页面及 `dashboard.top` 插槽；停用后菜单和插槽移除，直接访问原页面显示扩展未启用。截图：`output/playwright/linux-console.png`。

同环境的直连、Raw 透传及 Native 转换基线记录在 `output/bench.json`，包括源码摘要、环境、负载、延迟和 RSS；响应首字节时间不等于模型 TTFT，不承诺固定吞吐。

本地打包产物位于 `output/packages`：10 个 npm 包及 14 个官方插件归档，已检查 npm 包不残留 `link:`/`workspace:` 依赖，并生成 `SHA256SUMS`。这些产物尚未上传。

## 运行与后续边界

启动和初始管理员创建见 [README](../../README.md)。发布前仍需真实上游验证、远端 Linux CI 和真实部署环境验收。SQLite 使用 Node.js 24 内置的实验性 API。

按批准范围，Sidecar 整流、上游账号池、动态调度、iframe 隔离、插件市场、签名、操作系统沙箱和多节点留待后续。钱包与支付见后续商业能力迭代。版本升级采用停机替换。

`PluHub_Development_Plan_v0.1.md` 保留为原有历史草稿，其中旧工程布局与平台描述不作为本次实现依据。

## AI 网关迭代验收

- 四仓完整构建通过；Linux / WSL2 验证共 37 项测试通过：主仓 24、官方插件 9、Spec 2、Go SDK 2。原有 64 个 AI 组合仍通过。随后对目录权限与统计时间桶调整进行了 Linux 定向复测。
- 新增覆盖密钥模型范围、过期、限速、管理权限隔离、旧版认证数据库迁移、未知用量、成本估算、请求取消和流中断、用户日志隔离及重启保留。旧版认证数据库迁移补充断言已在本地测试中通过。
- 修复 HTTP Transport 在取消与数据到达同时发生时的未捕获流写入异常；HTTP、SSE、WS 和取消回归检查通过。
- 浏览器在 Linux 宿主验证登录、Key 创建、模型选择、真实网关流式调用、日志对应、渠道表单新增与删除、显式渠道测试、深色主题和移动端。截图位于 `output/playwright/product-*.png`；演示上游为本地模拟服务，固定演示文本和用量。
- 新版产物包含 10 个 npm 包和 17 个插件归档，保存在 `output/packages`；远端 CI、推送及发布尚未执行。

## 商业能力与订阅上游迭代验收

- 新增 10 个插件，共 27 个；[配置、财务规则与边界](../COMMERCIAL.md) 包括易支付四种版本/签名组合、Stripe Checkout/订阅、独立 Billing/Commerce、BYOK、限流限速、协议转换器及三类订阅上游。
- Windows 与 Ubuntu 22.04 / WSL2、Node 24.11.1 全套验证均通过：主仓 30、官方插件 15、Spec 2、Go SDK 2，共 49 项。原有 64 个协议组合仍通过；另验证 22 个订阅入口/上游 JSON/SSE 组合和 2 个明确拒绝的 CLI 参数组合。
- 财务验证包括原始字节验签、时间窗、金额篡改、异步支付未到账、重复支付、同周期发放、Invoice 新旧字段、取消续订保留周期、跨库 outbox 恢复与入账幂等。
- 计费验证包括余额不足、真实用量结算、未知用量预留、整数溢出待核对、重启恢复。BYOK 验证包括加密存储、用户/渠道隔离、撤销和并发 OAuth 刷新；限流验证包括 RPM、并发释放、等待中的带宽取消。
- 修复提前取消响应时的资源清理，Finalized 后关闭请求信号；管理 API 先脱离执行图、保持请求体可读，避免配置更新被提前中断。补充公开 `RequestContext.response`，供 Streaming Hook 包装标准 Web 响应。
- 构建、类型检查、格式检查、协议兼容与边界检查通过。最后修改的转换器、计费边界另执行针对性复测。`output/bench.json` 是 Linux 同环境透传/Native 基线，不是商业插件全链路吞吐承诺。
- 浏览器验证及清单逐项结果见 [UI 验收](../UI_REVIEW.md)。本地演示支付保持关闭，没有发起真实付款；临时 BYOK 凭证已撤销。
- New API 已真实查询模型与发送三次最多 16 输出 Token 的请求：DeepSeek 两个接口 HTTP 200 但无正文，另一个 Qwen 渠道返回上游错误。记录为部分联调结果，见 `output/live-newapi.json`，不声称完整生成成功。
- 已生成 10 个公共 npm 包及 27 个插件归档，保存在 `output/packages`，附 SHA256SUMS；包内无 `link:`/`workspace:` 私有依赖。未提交、推送或发布，远端 CI 未执行。
- 支付商户凭据与三类订阅真实授权尚未提供，这部分只有本地模拟验证。退款/拒付自动冲账、发票/支付方式管理、账号池、分布式限流和自动网页登录仍未实现。
