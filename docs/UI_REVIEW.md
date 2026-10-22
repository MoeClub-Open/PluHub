# 商业能力 UI 验收

本文件为历史验收记录，各节只描述当时版本。当前入口与行为以对应功能文档和部署产物的验收报告为准，首次部署流程见 [门户说明](PORTAL.md)。

## 2026-10-19 OOBE 与公开门户

新增管理员首次登录引导（站点身份 → 门户 → 模型 → 检查）、未完成配置提示和独立公开门户。站点管理员可编辑公告、主按钮、能力介绍、FAQ 与帮助/政策正文。纯文本正文、链接白名单、长度/数量上限、禁用后的公开内容移除、普通用户与匿名写入拒绝有自动化验证。

独立本地模拟环境通过 Playwright 完成：首次登录跳转、步骤保存后刷新、无可用渠道时明确延后、完成并刷新保留状态、公告与帮助页发布、脚本文本不执行、禁用门户后新访客进入登录且接口不再返回正文、重新启用恢复。390px 页面宽度无溢出。截图为 `output/playwright/oobe-review.png`、`portal-settings.png`、`portal-public-page.png`、`portal-mobile.png`。

实际 HTTPS 域名验证门户、登录、初始化跳转、Origin/Cookie 就绪及内容编辑入口，正式配置未替用户标记完成。线上截图 `portal-live.png`、`oobe-live.png`。未登录的身份查询 401 为预期；Cloudflare 注入的可选统计脚本被现有 CSP 拦截，不影响门户/登录，未为其扩大脚本权限。Windows 与 Linux 均通过主仓 59、插件 54 项，服务器 Spec 另 2 项；镜像恢复、域名权限与 Key 撤销检查通过。真实外部服务不计入本轮 UI 验收。

收尾修正管理员预览：未完成初始化时，访问公开首页仍显示门户；进入控制台才引导到设置向导。独立浏览器验证两条路径，类型检查与构建通过；更新镜像再次通过容器恢复和 HTTPS 部署检查。后端代码与已通过 Linux 全套的版本逐文件核对一致，未重复执行未改变的后端全套。

## 2026-10-19 支付适配器收进支付方式

修正此前按插件展示设置入口的层级：「支付与商业」只保留支付方式、商品与订阅、计费与余额。Stripe、易支付及第三方适配器通过 `ui.group: "payment-adapters"` 加入页内列表，支持搜索与独立配置，旧路径仍可访问。设置总览、侧栏、手机分类及快捷搜索都使用统一入口；无适配器时显示安装提示。

插件构建、边界检查及主仓 53 项、插件仓 52 项测试通过；新增 20 个第三方适配器的导航用例，验证菜单数量、旧链接、停用和普通用户边界。本地模拟环境通过 Playwright 验证列表搜索、两类配置加载、Stripe 保存只修改本插件、快捷搜索、全部适配器停用后的空列表及失效链接提示，重新启用后恢复。390×844 页面内容宽度为 390，无适配器顶层分类。最终页面控制台无错误或警告。42 个安装包重新生成并逐一校验 SHA256；Docker 镜像未在本轮重建。

截图：`output/playwright/payment-methods.png`、`output/playwright/payment-methods-mobile.png`。仅使用新建临时演示数据，未改已有 `.pluhub` 配置，未发起真实支付、邮件或模型调用。下方早期验收记录中的支付插件二级入口已由本轮聚合页替代。

## 2026-10-19 品牌配置与 Stripe 风格界面

参考 [Stripe Dashboard 的导航与设置组织](https://docs.stripe.com/dashboard/basics)、[品牌配置](https://docs.stripe.com/get-started/account/branding) 与 [组件原则](https://docs.stripe.com/stripe-apps/components)，使用现有组件独立调整：白色内容区、浅色导航、细边框和一致的卡片/表单层级；保留明暗主题。新增「站点与品牌」和 `Ctrl/Cmd+K` 页面搜索。

品牌编辑器支持名称、Logo/图标上传、主题色、登录文案和联系链接；带实时预览、保存状态与放弃更改。公共品牌端点只返回白名单字段，保存不增加插件权限；热更新和重启保留均有自动化验证。HTML、初始化 JSON、URL 类型、上传类型/大小和主题对比度有相应检查。

本地独立模拟演示实测上传 PNG Logo，保存演示品牌「星桥 AI」和蓝色主题。标题、侧栏、预览及登录按钮立即更新，配置对比只有 Console 改动；注销后登录页仍显示所配品牌和联系支持。`Ctrl+K` 打开后焦点进入搜索框，可直接输入并按 Enter 跳转「模型 TPS」。390×844 编辑器宽度无溢出，预览仍可见。主仓 53 项、插件仓 51 项通过，另对最终品牌相关变更定向复测。

截图：`output/playwright/stripe-brand-editor.png`、`stripe-console.png`、`stripe-brand-login.png`、`stripe-brand-mobile.png`。演示品牌只写入新建临时目录，未改动已有 `.pluhub` 数据，未发送邮件或发起支付/真实模型调用。品牌不扩展到邮件和支付商托管页面；这部分仍需各产品分别配置。

## 2026-10-19 参考 New API 的管理流程优化

参考 `QuantumNous/new-api` 的 `058c8231b68c51ee02abee15befcd720fee9f4a2` 版本，借鉴信息架构与交互模式，在现有 React/UI SDK 中独立实现：

| 参考来源 | 本轮改动 |
|---|---|
| [上下文侧栏](https://github.com/QuantumNous/new-api/blob/058c8231b68c51ee02abee15befcd720fee9f4a2/web/src/components/layout/components/app-sidebar.tsx) | 独立系统设置入口，进入后切换分类侧栏，返回控制台后恢复业务导航 |
| [计费设置分类](https://github.com/QuantumNous/new-api/blob/058c8231b68c51ee02abee15befcd720fee9f4a2/web/src/features/system-settings/billing/section-registry.tsx) | 分类总览、可搜索的设置入口；保留插件独立注册、启停与权限边界 |
| [渠道管理表格](https://github.com/QuantumNous/new-api/blob/058c8231b68c51ee02abee15befcd720fee9f4a2/web/src/features/channels/components/channels-table.tsx) | 渠道/模型搜索、状态和协议筛选、10/20/50 条分页、跨筛选选择和批量启停 |

本地独立模拟环境的 Playwright 验证：

- 设置中心有四类共 12 个可用页面，搜索 `STRIPE` 只返回 Stripe 设置；进入具体设置后侧栏高亮当前页面。桌面使用侧栏，手机保留组内横向导航。
- 用公开模型别名 `demo/chat` 搜到其上游，选中后更换筛选，批量停用确认仍明确列出原先选择及三个关联模型。保存后只有所选 `local` 渠道停用，其他渠道保持启用；逐插件配置比较只有 AI Router 变化，模型映射不变。随后通过批量启用恢复。
- 临时加入 12 个模拟渠道，共 15 个。第一页 10 条，第二页 5 条；筛选停用后展示 6 条并回到第一页。测试后移除额外模拟渠道。
- 普通用户直接访问 `/settings` 不会加载设置中心与配置导航，配置 API 返回 403。
- 1440×1000 与 390×844 布局检查通过。手机文档宽度为 390，渠道表格在自身容器内横向滚动。
- 主仓 51 项、插件仓 49 项测试通过，包含新增的多词搜索、筛选、失效选择拒绝和授权保留用例；插件构建与类型检查、公开接口边界及 Manifest v1 兼容检查通过。

截图：`output/playwright/newapi-settings-center.png`、`newapi-channel-manager.png`、`newapi-settings-mobile.png`、`newapi-channels-mobile.png`。本轮未发起真实支付或模型调用。New API 的账号池、渠道调度、价格体系等其他功能不在本轮界面优化范围内。

## 2026-10-19 设置聚合更新

管理员侧栏按支付与商业、安全与验证、渠道与路由、流量控制聚合，组内通过二级导航加载插件公开前端入口。商品与订阅、计费管理、站点认证策略移出个人页面；旧地址继续定位到所属分类。额外页面默认私有，不继承插件主页面的普通用户可见性。

本地模拟演示经 Playwright 实测：

- Stripe、易支付、商品、计费和站点认证页可切换；易支付保持禁用并保存 V2/RSA，刷新保留，逐插件配置对比确认只修改易支付。
- 停用易支付后原地址显示扩展不可用；重新启用后恢复扩展注册。
- 普通用户侧栏没有管理设置，个人充值页没有商品编辑器；直接请求配置与插件管理 API 均返回 403。
- 桌面 1440×1000、窄屏 390×844 显示二级导航；窄屏标签换行，文档宽度为 390，无横向溢出。
- 截图：`output/playwright/settings-payments.png`、`settings-payments-mobile.png`、`settings-security.png`。
- 主仓 51 项、插件仓 45 项、Spec 2 项及 Go SDK 测试通过；包括新增的私有额外页面、重复路径、分组与停用回退用例。Manifest v1 兼容检查、边界检查、类型检查与格式检查通过。

本轮使用独立临时演示数据，没有调用真实支付、发送邮件或消费真实模型额度。以下保留此前商业页面的清单审查记录。

渠道工作流与重定向的新增验收：使用 Playwright 实际添加思考节点、自动插入连接、保存、条件分支预览、创建组合渠道、模型重定向规则编辑，并检查明暗主题与 390px 窄屏。窄屏画布内部滚动，文档宽度与视口均为 390px。截图为 `output/playwright/channel-workflow.png`、`channel-workflow-mobile.png`、`model-redirects.png`。这部分是浏览器操作验收，不沿用下面历史商业页面的 Checklist Design 审查结论。

2026-10-19，使用 Checklist Design 技能，读取新增页面源码，并检查本地演示 `http://127.0.0.1:18181` 的实际截图。开发验证的登录、表单保存和凭证创建/撤销依据用户的实现授权执行；清单审查本身不对外部支付站点执行操作。

截图：

- `output/playwright/commerce-compact-light.png`：充值与套餐，1280×720。
- `output/playwright/converter-compact-dark.png`：暗色双栏转换，已点击转换并显示结果。
- `output/playwright/converter-compact-mobile.png`：390×844，转换编辑区纵向堆叠。
- `output/playwright/epay-settings-dark.png`：易支付 V2 / RSA 配置，1280×900。
- `output/playwright/byok-compact-dark.png`：模拟凭证保存后只显示元信息；随后已撤销。
- `output/playwright/billing-compact-dark.png`：余额、预留、明细及管理入口。
- `output/playwright/billing-compact-light.png`：最终紧凑空状态与同行搜索/充值操作。

统一侧栏 214px、顶栏 54px、内容间距 24px、卡片和表格间距；保留 14px 基础字号。支付复选框修复为与标签同行；辅助说明最小 11px。保留焦点样式和 reduced-motion 支持。

## Table 清单

按 [Table](https://www.checklist.design/design-system/table) 原顺序记录。

| 项目 | 状态 | 证据 / 影响 |
| --- | --- | --- |
| Table header | present | 各表使用 th，标明金额币种、凭证类型、时间和操作。 |
| Row style | present | 表头背景、行边界和操作颜色一致，暗色截图可区分。 |
| Spacing | present | 统一表头 10px、行 11px 纵向间距，正文未缩成密集小字。 |
| Search | partial | 账本支持来源/请求 ID 搜索；订单与凭证尚无独立搜索。 |
| Actions | present | 撤销凭证、取消续订、核对资金和刷新状态均有明确动作。 |
| Filter and sort | missing | 新增资金列表固定按时间排序，尚无自选排序/筛选。 |
| Responsiveness | present | 小屏表格在容器内横向滚动，转换区改为单列；侧栏折叠。 |
| Pagination | partial | 账本/订单最多显示最近 100 条，尚无更早记录翻页入口。 |

## Billing 清单

按 [Billing](https://www.checklist.design/website/billing) 原顺序记录。

| 项目 | 状态 | 证据 / 影响 |
| --- | --- | --- |
| Payment method/s used | partial | 显示支付商与续费方式，密钥仅配置环境变量引用；银行卡由 Stripe 处理，尚无卡片管理入口。 |
| History | partial | 独立订单与资金明细，尚无发票 PDF 下载。 |
| Plan details | present | 展示支付金额、币种、到账额度、单次/周期、月/年；订阅保留购买快照。 |
| Promo or discount code | not needed | 本期固定商品定价，明确不支持优惠码。 |
| Additional details | present | 余额、预留、未知用量与手动续费均有说明，禁用支付有状态提示。 |
| Next payment | partial | 展示本期结束日期和周期金额；尚无 Stripe upcoming invoice 明细。 |
| Cancel subscription | present | Stripe 订阅可取消自动续订，保留本期；易支付明确为手动续费。 |

## 已操作验证

- 管理员登录后访问新增页面；真实支付与订阅授权均未配置。
- 易支付选择 V2/RSA，保持禁用并保存；返回“支付配置已校验并保存”，刷新后保留。
- BYOK 添加本地模拟凭证；列表不显示密钥；撤销后行移除。
- 协议转换预览由 Chat Completions 转为 Anthropic Messages，结果包含文本及输出预算。
- 流量策略保存全零/不限规则，收到保存成功反馈。
- 登录前和演示重启后旧会话的 401 属于预期认证响应；重新登录后的上述页面无新增 JavaScript 控制台错误。

清单中的 partial/missing 是后续产品能力，不能将本轮称作完整商业平台。视觉截图使用本地模拟数据，不代表真实支付或订阅已经联调。
