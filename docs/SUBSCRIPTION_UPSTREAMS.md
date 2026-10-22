# 订阅上游插件

Codex、Claude、Antigravity 分别由以下独立插件提供：
- official.upstream-codex
- official.upstream-claude-subscription
- official.upstream-antigravity

每个插件包含自己的授权页面、账号管理、刷新、并发租约和协议适配，独立安装、启停、更新。公共实现只在构建时复用，不需要运行时聚合账号插件。

## 能力与授权

各插件分别提供 ai.subscription.<provider>@1 和 ai.upstream.<provider>@1。AI Router 与 BYOSUB 按渠道协议调用相应账号能力。用户授权操作位于各插件 /personal/* API，所有者由会话身份确定。平台账号由管理员管理。

管理入口分别是 /settings/subscriptions/codex、/settings/subscriptions/claude-subscription、/settings/subscriptions/antigravity。个人 BYOSUB 仅显示已安装且运行的提供商。

Codex 支持设备授权；浏览器授权使用 PKCE 和一次性 state。使用站点回调时须先向服务商登记 /api/plugins/official.upstream-<provider>/oauth/callback。服务商固定回调地址时，页面接收授权码或完整回调地址。Antigravity 的 OAuth 客户端密钥通过环境变量引用配置。密钥、刷新令牌和上游返回的敏感内容不出现在列表或日志中。

凭证分别保存在各插件的数据目录，以 AES-256-GCM 加密。每个目录拥有自己的 vault.key；也可设置 masterKeyRef 引用独立环境变量。OAuth 设置可在线保存；修改解密主密钥必须离线迁移。账号禁用、授权失效、冷却和配额状态分别维护；租约在请求完成或取消后释放。

## 从旧聚合插件迁移

先备份并停止宿主，安装新版三个提供商包，再运行官方插件工具：

    node tools/migrate-subscriptions.mjs /data/pluhub.json /opt/pluhub/plugins

Docker 镜像内工具位于 /opt/pluhub/tools/migrate-subscriptions.mjs。该工具由官方插件仓发布，Kernel 不依赖订阅私有实现。

迁移保留账号 ID、个人所有权、状态、并发、配额、版本及渠道引用，按提供商拆分 OAuth 设置，分别生成加密密钥并重新加密。旧数据和迁移前配置保留在 .pluhub/migrations 内。目标数据已存在、旧数据无法验证或 schema 不兼容时拒绝覆盖；配置最后提交，失败时撤回本次写入的目标文件。成功后可重复执行，无需再次迁移。

尚未完成的 OAuth 流程和内存租约不迁移，停机前应排空请求；用户可重新发起授权。真实账号的可用性和服务商策略仍取决于对应账号，自动化验收使用模拟服务。
