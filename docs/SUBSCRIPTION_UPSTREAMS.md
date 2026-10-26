# 订阅上游插件

Codex、Claude、Antigravity 分别由以下独立插件提供：
- official.upstream-codex
- official.upstream-claude-subscription
- official.upstream-antigravity

每个插件包含自己的授权页面、账号管理、刷新、并发租约和协议适配，独立安装、启停、更新。公共实现只在构建时复用，不需要运行时聚合账号插件。

## 能力与授权

各插件分别提供 ai.subscription.<provider>@1 和 ai.upstream.<provider>@1。AI Router 与 BYOSUB 按渠道协议调用相应账号能力。用户授权操作位于各插件 /personal/* API，所有者由会话身份确定。平台账号由管理员管理。

管理入口分别是 /settings/subscriptions/codex、/settings/subscriptions/claude-subscription、/settings/subscriptions/antigravity。个人 BYOSUB 仅显示已安装且运行的提供商。

平台与个人订阅采用相同的手动回调流程：复制授权链接或在新标签页打开提供商登录，登录后将完整回调链接粘贴回原页面，完成授权。回调指向本机地址，不需要网关服务器监听对应端口；本地页面无法打开时，仍可复制地址栏中的完整链接。也可导入已有单账号授权 JSON。

提供商原生客户端参数内置，与 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 的接入方式一致，无需在后台配置 OAuth 应用。Codex、Claude 使用 PKCE，Antigravity 使用原生安装应用公开客户端凭据；所有提供商均校验一次性 state、会话归属及有效期。底层保留已有自定义客户端配置和设备授权 API 的兼容能力。密钥、刷新令牌和上游返回的敏感内容不出现在列表或日志中。

凭证分别保存在各插件的数据目录，以 AES-256-GCM 加密。每个目录拥有自己的 vault.key；也可设置 masterKeyRef 引用宿主托管凭据。修改解密主密钥必须离线迁移。账号禁用、授权失效、冷却和配额状态分别维护；租约在请求完成或取消后释放。

账号名称可留空，OAuth 完成后优先使用授权返回的邮箱；Claude、Antigravity 在授权信息缺少邮箱时查询提供商账号资料。导入授权同样读取邮箱字段与身份令牌的展示信息。手动指定的名称保持不变，邮箱仅用于账号展示，不用于认证 PluHub 用户。

列表的「查看额度」会主动查询账号额度，展示剩余比例、重置时间和更新时间：Codex 使用 `/backend-api/wham/usage`，包含主次周期、额外功能限额和提供商返回的点数；Claude 使用 `/api/oauth/usage`，区分五小时、七天及模型专属周期；Antigravity 使用 `fetchAvailableModels` 返回的模型额度。查询复用账号令牌刷新和所有权校验，不发送模型推理请求、不兑换重置额度，也不默认开启后台轮询。查询失败保留已有快照；缺少数据时不显示为零用量。既有账号使用提供商默认名称时，查询返回邮箱后会自动补全名称。

## 从旧聚合插件迁移

先备份并停止宿主，安装新版三个提供商包，再运行官方插件工具：

    node tools/migrate-subscriptions.mjs /data/pluhub.json /opt/pluhub/plugins

Docker 镜像内工具位于 /opt/pluhub/tools/migrate-subscriptions.mjs。该工具由官方插件仓发布，Kernel 不依赖订阅私有实现。

迁移保留账号 ID、个人所有权、状态、并发、配额、版本及渠道引用，按提供商拆分 OAuth 设置，分别生成加密密钥并重新加密。旧数据和迁移前配置保留在 .pluhub/migrations 内。目标数据已存在、旧数据无法验证或 schema 不兼容时拒绝覆盖；配置最后提交，失败时撤回本次写入的目标文件。成功后可重复执行，无需再次迁移。

尚未完成的 OAuth 流程和内存租约不迁移，停机前应排空请求；用户可重新发起授权。真实账号的可用性和服务商策略仍取决于对应账号，自动化验收使用模拟服务。
