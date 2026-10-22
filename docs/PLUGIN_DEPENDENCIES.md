# 插件依赖、版本与安装

插件默认依赖公开 Capability，例如 `users.lookup@1`，通过 `bindings` 选择可替换实现。`@1` 是能力契约的主版本，不等于插件自身版本。只有确实依赖某个实现时，才额外声明 Manifest `dependencies`：

```json
{
  "requires": ["example.service@1"],
  "host": ">=0.1.0-alpha.2 <0.2.0-0",
  "optionalRequires": ["example.metrics@1"],
  "dependencies": {"example.provider": "^1.2.0"}
}
```

宿主在启动、启用、配置变更和在线替换时校验必需插件、实现版本范围、能力绑定和环路。依赖者仍在运行时不能停止其必需提供者。可选能力不构成强制启动边，避免 Users/Auth、Router/BYOK 等协作形成硬循环；插件仍需在使用可选能力之前检查其可用性。

## 自动安装

后台「插件 → 安装本地插件」先生成安装清单，列出复用/新增的插件、具体版本和权限，再确认安装。每个新增插件的权限需要单独授权。可填写根插件及依赖插件的初始配置；Schema 不通过时不执行插件代码。

依赖来源可以是服务器上的插件目录、含插件子目录的本地目录，或 `.tgz` / `.tar.gz` 安装包。默认搜索目标包的同级目录，另可通过宿主 `pluginSources` 或本次安装的 `sources` 指定来源。没有插件来源白名单，不使用插件名称猜测 npm 包，不调用 npm 安装脚本。

规则如下：

- 只补充缺失的必需依赖，不自动安装可选插件。
- 复用兼容的已安装插件；不隐式升级、替换或启用已停用插件。
- 同一插件的多个版本按约束解析，必要时回退到兼容版本。多个不同提供者需要 `bindings`；相同 ID/版本但内容不同的包会被拒绝。
- 缺包、版本冲突、循环依赖、未授权权限、无效配置或安装清单过期均明确拒绝。
- 新插件集先校验和暂存，再激活依赖，最后发布一次完整执行图。失败撤销新增实例、代码和配置，已有实例与请求继续使用原图；插件自行产生的数据目录不作为代码缓存删除。

目前自动安装针对可访问的本地来源；未实现远程插件市场或任意 URL 下载。

## CLI 与 API

```sh
pluhub plugin install /srv/packages/example --plan --source /srv/packages
pluhub plugin install /srv/packages/example --grant api.register \
  --dependency-grants '{"example.provider":["api.register"]}' \
  --dependency-configs '{"example.provider":{"enabled":true}}' \
  --source /srv/packages
```

`--source` 可重复。`--plan` 不修改宿主配置；实际 CLI 安装要求宿主停止。可使用 `--expected-plan <fingerprint>` 将确认绑定到预览的包内容和宿主配置，变化后需重新检查。

管理 API 为 `POST /api/host/install-plan` 与 `POST /api/host/install`，均要求管理员会话。支持 `path`、`sources`、`config`、`dependencyConfigs`，安装另外接收 `grants`、`dependencyGrants`、`expectedPlan`。后台使用相同解析器，避免 CLI 与 HTTP 各自实现依赖规则。

## 锁与发布

新安装的宿主配置项记录精确 `version` 和 `integrity`（SHA-256），启动时核对。在线更新必须显式更新锁，并继续满足其他插件的版本约束。旧配置中的这两个字段保持可选，不能把未加锁的开发目录宣称为已锁定。

本轮宿主及受影响公共包为 `0.1.0-alpha.2`。Console 与六个受影响业务插件独立升到 `alpha.2`，其他插件保留原版本；Console 声明新宿主最低版本。使用新增 `dependencies` 字段的插件同样应声明新宿主下限。官方 Manifest 和新插件模板的宿主兼容范围限定在已知的 `0.1` 系列，避免开放下界错误宣称兼容未来主版本。

依赖库通过固定版本与 pnpm lockfile 维护；`pack:all` 按实际公共包版本替换开发用 `link:` / `workspace:`，输出 `SHA256SUMS` 与 `RELEASE_LOCK.json`，列出每个产物的版本和摘要。安装包集成验证从锁清单读取实际版本并核对摘要，不再将所有插件的安装包名写死为同一个版本。

`node scripts/check-boundaries.mjs` 同时检查私有导入和 34 个官方插件的编译产物：字面量 Capability 调用/探测与注册必须在 Manifest 中声明，Manifest/package 版本必须一致。动态能力名仍由宿主的依赖授权校验与集成测试覆盖。Go SDK 保留 `dependencies` 和 `optionalRequires` 元数据；npm SemVer 范围的最终解释由宿主统一执行。
