# 整站排行榜

`official.leaderboard` 提供登录可见的 `#/leaderboard` 页面，位于侧栏「模型服务」。用户榜和模型榜均支持近 7 天、近 30 天与累计，按 Token 用量或成功调用次数排序，展示前 50 名、输入/输出用量和占比。用户榜额外返回当前用户排名，低于前 50 名时单独显示。并列名次相同，后续名次跳过对应人数。

统计只纳入平台渠道的成功调用。个人渠道、匿名调用、失败和中断流不进入公开排行。未返回 Usage 的成功请求只增加调用次数，不估算 Token。日期使用 UTC 自然日：近 7 天为今天及前 6 天，近 30 天为今天及前 29 天。

用户榜显示已启用账号的公开账号名，隐藏停用账号；不返回用户 ID、邮箱、API Key、请求内容、成本或上游信息。模型榜只展示当前启用的平台目录中的公开模型别名和名称，不读取个人渠道目录。管理员与普通用户看到相同统计口径，只有「我」标记和当前用户排名不同。接口需要认证，响应使用 private/no-store，避免跨用户缓存。

Observability 的 SQLite schema v3 增加 `ranking_daily` 和统计起点元数据。迁移先从当前保留的调用明细一次性回填，再执行原明细保留策略。后续请求在同一事务写入明细与按天汇总；明细清理不影响累计数据，重启不会重复回填。已在升级前清理的历史数据无法恢复，「累计」页面显示统计起点。排行仍属于使用统计，不承担计费事实或结算。

公开的可选 Spec 模块 `@pluhub/contracts/analytics` 定义请求和响应：

- `users.directory@1`：仅向已声明依赖的插件提供已启用用户的 ID 和公开账号名，不提供角色、邮箱和认证资料。
- `observability.rankings@1`：提供按天聚合查询；用户 ID 仅在插件间传递，HTTP 出口由排行榜插件映射并删去。
- `GET /api/plugins/official.leaderboard/rankings?kind=users|models&range=7d|30d|all&metric=tokens|requests`：公开排名数据，仍需登录或有效 API Key。

新 `init`、示例配置及本地 Demo 默认安装排行榜插件。现有部署需先升级 Users 和 Observability，再安装排行榜插件并授权 `api.register`。停用排行榜只移除排行榜 API 和页面，不清理历史统计。升级前备份完整数据卷；回滚到旧 Observability 时需恢复匹配的旧数据库备份。
