# 插件开发接口

后端只导入公开的 @pluhub/sdk，AI 插件额外使用 @pluhub/contracts/ai，前端使用 @pluhub/ui-sdk。官方插件和模板均遵循相同入口。

## 后端

ESM 默认导出 definePlugin({ setup(host) { ... } })。setup 完成且所有声明能力已注册后，插件进入 Active。

Manifest 可填写 `name`（最多 80 字符）和 `description`（最多 400 字符），用于插件管理的名称、用途和搜索；缺省时保留 ID 回退。ID 仍是依赖绑定和持久化身份，不随显示名称变化。

配置与代码更新独立声明：`configReload: "snapshot"` 的配置通过控制面立即发布，新旧请求持有各自配置。`codeReload: "parallel"` 表示作者确认新旧实例可同时运行：无共享可变状态迁移、无独占监听或数据资源，所有资源在 cleanup 中释放，所有请求遵循 AbortSignal。缺省 `codeReload: "restart"`；数据库插件、认证、Listener 和 Console 使用重启升级。

管理员可在插件管理中为支持的插件选择宿主可读目录或 .tgz 包，调用 `POST /api/host/update`，字段为 `id`、当前 `revision`、`path`、`reason`。要求近期管理员会话和 CSRF，沿用已有权限授权，不自动扩大权限；插件 ID、对外能力集合、平台、宿主版本、配置及全局执行图须通过校验。新包复制到独立版本目录，启动完成、配置保存成功后原子切换，新请求进入新实例，旧请求按排空超时完成或取消；后台释放旧实例，避免更新请求等待自身排空。前端扩展 URL 携带实例 revision，管理页面更新后重新获取注册表；其他浏览器刷新页面后加载新模块。

验证、启动或持久化失败保留旧实例；新包目录不覆盖旧包。已退休的旧目录保留供维护回退，不自动逆转数据库迁移，不提供跨进程掉电事务或任意有状态插件的无损升级保证。Native ESM 模块不能完全从加载缓存中卸载，持续升级较大的原生模块后可通过维护重启回收缓存。更新包需自包含依赖；Docker 部署时将插件包目录挂载到容器后填写容器内路径。

| API                                   | 约定                                                                                          |
| ------------------------------------- | --------------------------------------------------------------------------------------------- |
| host.provide(name, handler, options?) | 只能提供 Manifest.provides 中的能力；可通过 options.callers 限定调用方插件                    |
| host.call(name, input, signal)        | 只能调用自身提供或 requires / optionalRequires 声明的能力                                     |
| host.hasCapability(name)              | 查询已声明的可选依赖是否可用                                                                  |
| host.api(route)                       | 挂载在 /api/plugins/插件ID 下，需要 api.register 权限                                         |
| host.route(route)                     | 注册业务 HTTP 路由，需要 http.route 权限，不得占用管理命名空间                                |
| host.hook(hook)                       | 注册具名阶段 Hook，需要 hooks.register 权限                                                   |
| host.config()                         | 请求中读取对应图版本的配置快照                                                                |
| host.validateConfig(check)            | 在启动和配置切换前检查跨字段约束                                                              |
| host.secret(reference)                | 读取 secrets.read 授权且列入 secretRefs 的托管凭据                                            |
| host.cleanup(callback)                | 停止时逆序释放资源                                                                            |
| host.publish / subscribe              | 诊断通知；不用于资金事实交付                                                                  |
| host.dispatchChild(request, options)  | 使用当前身份和配置快照执行子请求，需要 http.dispatch.child 权限及目标路由的 childCallers 授权 |
| host.requestContext(options?)         | 获取当前已认证的数据面请求；options.callers 限定入口及完整调用链，默认仅允许本插件            |

route 包含 method、path、access、handle，可选 prepare 与 error。prepare 位于 Planning Hook 之前，用于解码和生成计划；handle 在 Execution 阶段执行。管理 API 不进入数据面 Hook。

只读 POST、预览和会话确认接口应声明 `audit: false`，避免进入管理员操作记录；写操作默认记录。历史版本留下的只读记录由控制面的查询规则过滤。

子请求入口通过 `childCallers` 列出允许调用的插件 ID；未声明时拒绝子请求。`internal: true` 的路由只接受受信任子请求，外部访问返回 404。携带预先准备的 `plan` 仅允许进入内部路由；`delegatedModel` 是服务端传递的受托目标，不能从普通 HTTP 请求头取得。子请求继承父请求身份、配置快照及取消信号，拥有独立状态、结束处理和结果回调；嵌套深度最多为 8。

能力提供者可声明 `host.provide(name, handler, { callers: ["example.entry"] })`。宿主检查完整插件调用链，不能通过中间插件绕过限制；受限能力也不能在没有调用方身份时直接调用。提供者应根据自身业务确定允许列表，宿主不内置官方业务插件名称。

access 为 public、authenticated，或认证插件提供的权限名。管理员与普通用户的具体角色由 Auth 插件定义，Kernel 只检查返回的权限集合。

Hook 的实际 ID 为“插件ID:Hook名”，before / after 使用完整 ID；同阶段约束必须无环。Finalize 在正常完成、取消和失败后执行一次。正文使用标准 Web Streams 和 AbortSignal，不能忽略取消或无界缓存。

原生插件应在 setup 内建立实例状态并注册 cleanup。停止会注销服务和扩展，不保证 ESM 模块从内存完全卸载。

## 前端页面与组件插槽

Manifest 的 ui 声明入口、标题、页面路径；可选 slots 声明命名插槽贡献：

```json
{
  "ui": {
    "entry": "dist/ui.js",
    "title": "我的插件",
    "path": "/example",
    "slots": [
      { "name": "dashboard.top", "entry": "dist/widget.js" }
    ]
  }
```

入口模块导出 mount(element, host)，返回注销函数。UIHost 提供 request、navigate、refresh；在插槽中还提供 slot 名称。页面与 Widget 的资源放在同一个 Bundle 目录。

Console 首批开放 dashboard.top、sidebar.footer。其他前端宿主可通过公开 mountSlot(element, name, host) 加载自己的命名插槽。

停用后，服务端移除页面与插槽注册；控制台刷新注册表时调用注销函数。UI 仍须通过后端认证，菜单可见性不代替权限检查。

Console 将 `ui.public: true` 的页面提供给已登录的普通用户；其余页面仅展示给管理员。这里的 public 不代表后端 API 免认证。

### 聚合设置

`ui.group` 可将管理员页面加入统一设置，`ui.order` 控制组内顺序（默认 100）。Console 提供 `site`（站点与品牌）、`payments`（支付与商业）、`security`（安全与验证）、`routing`（渠道与路由）、`traffic`（流量控制）五组；没有分组或未知分组的扩展仍显示独立入口。组内只装配当前启用的页面；空组自动隐藏。

支付适配器页面声明 `ui.group: "payment-adapters"`，由 Console 统一收进「支付与商业 → 支付方式」（`/settings/payment-methods`）。它们只供管理员配置，不为每个适配器增加设置菜单；商品订阅与计费页面仍使用 `payments`。新增适配器只需声明分组与公开 UI 模块，无需 Console 导入其源码。列表按 `ui.order` 排序，支持搜索；选中后仍通过 `mount(element, { ...host, page: 原页面路径 })` 加载，离开或注销时清理。原页面地址保持兼容。没有可用适配器时保留支付方式入口并提示安装插件；设置与快捷搜索中的适配器名称指向统一支付方式页。

一个插件可通过可选 `ui.pages` 额外声明最多 32 个页面，共用 `ui.entry` 模块。每个页面独立声明 `title`、`path`、`public`、`group` 和 `order`；`public` 默认 false，不继承主页面。所有页面路径在插件内必须唯一。宿主将所选页面路径通过 `host.page` 传给 `mount`，插件据此呈现对应功能，返回的注销函数仍负责清理该页面。已有单页 Manifest 和 URL 保持兼容。

```json
{
  "ui": {
    "entry": "dist/ui.js",
    "title": "充值与订阅",
    "path": "/commerce",
    "public": true,
    "pages": [
      {
        "title": "商品与订阅",
        "path": "/settings/commerce",
        "group": "payments",
        "order": 30
      }
    ]
  }
}
```

Console 按公开扩展注册表加载页面，不导入业务插件源码。后端仍独立验证权限；个人页面不混入站点设置。

Finalize Hook 可从请求 `state` 读取通用观测信息：`http.status`、`http.errorCode`、`http.cancelled`。流式输出开始后失败时 HTTP 状态仍可能为 200；须同时检查错误、取消及业务流完成状态。Principal 的可选 `attributes` 用于传递插件域元数据，Kernel 不解释其中的 AI 或密钥策略。

## 独立进程

Go SDK 使用 JSON-RPC 2.0 标准输入/输出，支持请求级能力、Host 反向调用、超时与取消。单消息最大 1 MiB，不传输流式正文。SSE / WS 在原生数据面执行，Sidecar 整流通道不在首版范围。

Native 和 Process 都是安装者授权的本机代码；Host API 权限检查不构成操作系统沙箱。

通用凭据通过 `Host.secret("secret:编号")` 读取，仍要求 `secrets.read` 和配置 `secretRefs` 的共同授权。宿主管理配置保存时先加密直接填写的凭据，再验证并持久化配置。业务参数通过能力参数、请求体或插件配置传递。迁移、存储及恢复说明见 [凭据与参数](SECRETS.md)。
