# 订阅上游插件

订阅账号分别由以下独立插件提供：

- official.upstream-codex
- official.upstream-claude-subscription
- official.upstream-antigravity
- official.upstream-grok

每个插件包含自己的授权页面、账号管理、刷新、并发租约和协议适配，独立安装、启停、更新。公共实现只在构建时复用，不需要运行时聚合账号插件。

## 能力与授权

各插件分别提供 ai.subscription.<provider>@1 和 ai.upstream.<provider>@1。AI Router 与 BYOSUB 按渠道协议调用相应账号能力。用户授权操作位于各插件 /personal/* API，所有者由会话身份确定。平台账号由管理员管理。

管理入口为 `/settings/subscriptions/<provider>`，提供商标识为 `codex`、`claude-subscription`、`antigravity` 或 `grok`。个人 BYOSUB 仅显示已安装且运行的提供商。

平台与个人订阅采用相同的手动回调流程：复制授权链接或在新标签页打开提供商登录，登录后将完整回调链接粘贴回原页面，完成授权。回调指向本机地址，不需要网关服务器监听对应端口；本地页面无法打开时，仍可复制地址栏中的完整链接。也可导入已有单账号授权 JSON。

提供商原生客户端参数内置，与 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 的接入方式一致，无需在后台配置 OAuth 应用。Codex、Claude 使用 PKCE，Antigravity 使用原生安装应用公开客户端凭据；所有提供商均校验一次性 state、会话归属及有效期。底层保留已有自定义客户端配置和设备授权 API 的兼容能力。密钥、刷新令牌和上游返回的敏感内容不出现在列表或日志中。

凭证分别保存在各插件的数据目录，以 AES-256-GCM 加密。每个目录拥有自己的 vault.key；也可设置 masterKeyRef 引用宿主托管凭据。修改解密主密钥必须离线迁移。账号禁用、授权失效、冷却和配额状态分别维护；租约在请求完成或取消后释放。

账号名称可留空，OAuth 完成后优先使用授权返回的邮箱；Claude、Antigravity 在授权信息缺少邮箱时查询提供商账号资料。导入授权同样读取邮箱字段与身份令牌的展示信息。手动指定的名称保持不变，邮箱仅用于账号展示，不用于认证 PluHub 用户。

列表的「查看额度」会主动查询账号额度，展示剩余比例、重置时间和更新时间：Codex 使用 `/backend-api/wham/usage`，包含主次周期、额外功能限额和提供商返回的点数；Claude 使用 `/api/oauth/usage`，区分五小时、七天及模型专属周期；Antigravity 使用 `fetchAvailableModels` 返回的模型额度。查询复用账号令牌刷新和所有权校验，不发送模型推理请求或兑换重置额度；后台维护另按下述周期执行。查询失败保留已有快照；缺少数据时不显示为零用量。既有账号使用提供商默认名称时，查询返回邮箱后会自动补全名称。

## 连接模式

在渠道的「调用上游」节点选择提供商与已授权账号，模型目标从该节点的账号目录选择。手动连接配置使用以下协议和地址，凭据填写后保存为加密引用：

| 提供商      | 连接配置                                          | 默认地址                                    |
| ----------- | ------------------------------------------------- | ------------------------------------------- |
| Codex SIWC  | `protocol: "codex"`、`authMode: "siwc"`           | `https://api.openai.com/v1`                 |
| Codex CLI   | `protocol: "codex"`、`authMode: "cli"`，需账号 ID | `https://chatgpt.com/backend-api/codex`     |
| Claude      | `protocol: "claude-subscription"`                 | `https://api.anthropic.com`                 |
| Antigravity | `protocol: "antigravity"`，可指定项目 ID          | `https://daily-cloudcode-pa.googleapis.com` |
| Grok        | `protocol: "grok"`                                | `https://cli-chat-proxy.grok.com/v1`        |

Codex CLI 强制流式上游，非流式客户端由入口收集后返回；该模式忽略输出 Token 上限和 Temperature，SIWC 保留这些参数。不同模式的预扣与输出预算限制见 [模型计价](PRICING.md#预留与快照)。账号目录包含某模型不等于实际账号必然具备调用额度，真实可用性仍需对应服务验证。

## 后台维护与安全切换

插件约每 30 秒调度维护，提前 5 分钟刷新即将过期的授权；正常账号约每 5 分钟查询额度，冷却账号约每分钟检查恢复。失败按退避间隔重试，保留已有快照。维护只访问授权与额度控制接口，不发送生成请求。

额度冷却可按全局窗口、模型或模型系列隔离，并持久保存；独立功能的额度不阻塞普通生成。新的额度查询确认恢复后，账号重新参与选择。授权无效时需重新登录，刷新会保留轮换后的 Refresh Token。

在首个标准化响应事件前，明确的认证、限额或服务错误可触发同渠道内安全切号，最多尝试三个不同账号；认证错误先刷新一次。响应开始后、网络结果不明时均不重放请求。自动路由也会跳过当前不可用的订阅目标。

## 会话账号绑定

入口从客户端会话 Header、Claude 会话元数据、会话字段或 `prompt_cache_key` 派生会话标识；没有显式标识时使用首轮用户消息摘要。标识按用户、API Key、渠道和上游节点隔离，不保存原始消息作为绑定键。客户端改写或截断首轮消息后，摘要可能变化。

绑定持久保存，闲置一小时过期，使用时续期。绑定账号并发已满时最多等待 15 秒，超时返回 429；账号停用、删除、授权失效、冷却或移出渠道后，在当前允许的账号池中重新选择。安全切号后的账号成为新绑定，不在后台重试已经结束的失败请求。

## 从旧聚合插件迁移

此迁移仅适用于仍使用旧聚合插件的 Codex、Claude 和 Antigravity 账号。先备份并停止宿主，安装对应提供商包，再运行官方插件工具：

    node tools/migrate-subscriptions.mjs /data/pluhub.json /opt/pluhub/plugins

Docker 镜像内工具位于 /opt/pluhub/tools/migrate-subscriptions.mjs。该工具由官方插件仓发布，Kernel 不依赖订阅私有实现。

迁移保留账号 ID、个人所有权、状态、并发、配额、版本及渠道引用，按提供商拆分 OAuth 设置，分别生成加密密钥并重新加密。旧数据和迁移前配置保留在 .pluhub/migrations 内。目标数据已存在、旧数据无法验证或 schema 不兼容时拒绝覆盖；配置最后提交，失败时撤回本次写入的目标文件。成功后可重复执行，无需再次迁移。

尚未完成的 OAuth 流程和内存租约不迁移，停机前应排空请求；用户可重新发起授权。真实账号的可用性和服务商策略仍取决于对应账号，自动化验收使用模拟服务。
