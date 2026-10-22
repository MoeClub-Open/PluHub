# 实现范围与验收入口

PluHub 正式运行目标为 Linux x64、Bun 1.4.3，四仓通过公开包和契约协作。源码构建使用 Node.js 24 和 pnpm；构建产物、测试数量、镜像和插件版本以对应发布锁及验收报告为准。

## 已实现的主要能力

| 范围 | 当前实现 | 使用说明 |
| --- | --- | --- |
| 插件框架 | Native TS / Go Process、依赖及版本校验、授权、生命周期、配置快照、执行图、HTTP / SSE / WS、React 扩展、注册源安装与更新 | [插件架构](PLUGIN_ARCHITECTURE.md)、[插件 API](PLUGIN_API.md)、[注册源](PLUGIN_REGISTRY.md) |
| 站点与账号 | 管理员创建前的站点初始化、品牌及公开门户、多语言、注册与密码恢复、会话管理、TOTP / Passkey、企业与子账号归属 | [门户](PORTAL.md)、[账号安全](IDENTITY.md)、[语言偏好](LOCALIZATION.md) |
| 网关 | 独立入口和上游适配器、统一渠道流程图、模型重定向、自动路由、单请求 TPS、个人 BYOAPI / BYOSUB | [协议矩阵](PROTOCOLS.md)、[渠道工作流](WORKFLOWS.md)、[自动路由](AUTO_ROUTING.md)、[个人渠道](PERSONAL_CHANNELS.md) |
| 计费与支付 | 原价和消耗倍率、缓存及上下文阶梯、按次价格、输出预算、余额预留与结算、待核对处理、充值和订阅、支付调整 | [计价](PRICING.md)、[商业能力](COMMERCIAL.md) |
| 运维与管理 | 请求日志及企业可见范围、运行日志、管理审计、插件管理、系统状态、Docker 备份与恢复 | [日志](LOGGING.md)、[管理功能](ADMINISTRATION.md)、[Docker](DOCKER.md)、[运维](OPERATIONS.md) |

共有 34 个官方插件，新站默认启用其中 32 个；旧版 Workflow 和 Protocol Converter 按需安装。标准协议转换及所有渠道的流程图编辑不依赖这两个兼容插件。管理员通过独立管理入口操作系统，用户前台保留模型、调用、账号及个人业务功能。

提供者通过各自的 Manifest 声明更新方式：支持在线更新的插件切换执行图，其余插件重启升级；现有数据库迁移的回滚需要恢复匹配的数据和镜像。

## 验证与部署

本地验证入口为 `pnpm build:all`、`pnpm test:all`、`node scripts/check-boundaries.mjs`。打包后使用 `node scripts/verify-routing-packages.mjs` 和 `node scripts/verify-identity-packages.mjs` 验证源码目录外的安装结果。Linux CI 定义于各仓，远端 CI 的执行状态不能由本地测试替代。

SLC 实例位于 `/root/pluhub`，使用 Docker Compose，按部署要求监听 `0.0.0.0:18100`，主入口为 `https://apihub.telecom.moe`。当前发布信息和对应验收报告由部署流程维护在 `output/deploy/slc-release.json`；旧报告只证明其对应版本及测试范围。

历史实现记录见 [历史文档](history/IMPLEMENTATION.md)，界面验收记录见 [历史 UI 检查](UI_REVIEW.md)。真实模型调用范围以 [联调说明](LIVE_TESTING.md) 为准；本地模拟或单一上游成功不代表所有服务商均已认证。

## 仍须单独验收的范围

- 真实商户付款、续费及退款争议对账，订阅上游的有效授权，以及具体邮件、Turnstile 和实体硬件密钥的生产配置。
- 日常及异地备份、告警、容量与长连接负载、远端 CI 和正式发布。镜像恢复演练不代替这些运营验证。
- 输入 Token 预留仍为估算；估算模式的输出也没有默认硬上限，实际金额可能超过预留。收费边界见计价文档，不能宣称具有绝对费用上限。
- 通用细分管理权限、上游账号池、多节点一致性、分布式限流和故障转移；协议扩展仍受支持矩阵约束。

Native 插件及本地 React 扩展运行安装者授权的代码，当前不提供操作系统沙箱或不可信扩展隔离。原始设计理念和开发草稿保留作背景，不作为自动扩展实现范围的指令。
