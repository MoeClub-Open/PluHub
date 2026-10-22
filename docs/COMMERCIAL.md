# 计费、支付、订阅与自带凭证

当前共有 34 个官方插件，新站默认安装 32 个。以下为主要商业插件；预付计费、Stripe、易支付默认关闭。已有配置必须显式安装和授权，普通启动不会自动扩大权限。部署范围为单节点。

| 插件 | 能力 / 页面 | 行为 |
| --- | --- | --- |
| billing | `billing.credit@1`、`billing.balance@1`；用量与账单 | USD 整数微单位钱包、唯一来源账本、请求预留、结算、待核对、管理员审计调整 |
| commerce | `commerce.payment@1`、`commerce.entitlements@1`；充值与订阅 | 商品价格快照、订单、单次支付、周期额度、权益到期、取消续订、持久 outbox |
| payments-stripe | `payments.stripe@1`；Stripe 支付配置 | Checkout 单次支付和持续订阅、原始字节 Webhook 验签、异步支付、周期发放 |
| payments-epay | `payments.epay@1`；易支付配置 | 多支付方式与商户、V1/V2 与 MD5/RSA 独立配置、V2 响应验签、支付回调、预付周期与手动续费 |
| byok | `credentials.select@1`、`credentials.resolve@1`；自带凭证 | 按用户和渠道隔离的加密 API Key / OAuth 授权、过期刷新、撤销 |
| rate-limit | 流量策略 | 按用户、Key、渠道聚合 RPM/TPM/并发，以及 HTTP/SSE 输出字节限速 |
| protocol-converter | `ai.converter@1`；协议转换 | 四协议请求/响应与流式编解码能力；入口、标准上游通过此能力调用；本地转换预览 |
| upstream-codex | `ai.upstream.codex@1` | 官方 SIWC Responses 模式及 CLI 兼容模式 |
| upstream-claude-subscription | `ai.upstream.claude-subscription@1` | Claude OAuth Bearer 认证、Messages JSON/SSE |
| upstream-antigravity | `ai.upstream.antigravity@1` | Project 请求包装、Gemini JSON/SSE、外层 response 解包 |

## 计费规则

1 USD = 1,000,000 微美元。Token 价格以 USD / 百万 Token 配置，支持普通输入、输出、缓存读、缓存写、1 小时缓存写、上下文阶梯及按次计价。价格填写原价，渠道、用户组和用户的消耗倍率参与最终计算。用有理数汇总后只在最终微美元边界向上取整；SQLite 事务内记录资金变动和唯一来源。非整数、负信用充值或超出 JavaScript 安全整数范围的金额会被拒绝。

Admission 按流程变换后的消息、工具和输出预算预留，采用当次价格快照及输入 UTF-8 字节估计。没有显式输出预算时使用 `reserveOutputTokens`，默认 4096；这只是预留估计。实际费用超过预留时完整入账，可能形成负余额，后续请求被拒绝。BYOK 请求跳过平台模型费用。

Finalize 仅在请求完成且实际用量有效时结算。从未进入上游执行的失败释放预留；调用已开始但缺用量、取消时只有部分用量、异常退出遗留的预留进入待核对。管理员根据服务商事实填写实际费用和原因；填 0 释放预留，不自动将未知用量记作免费。

输入总量包含 Anthropic 缓存读写 Token；Gemini 输出总量包含 thoughts Token。缓存细项从输入总量中拆分计价，思考 Token 已包含在输出总量内，不重复收费。观测页面保存费用估算快照，实际扣款以资金账本为准。钱包资金历史由服务端筛选和分页，支持本人 CSV 导出。

## 商品和支付

管理员在「支付与商业 → 商品与订阅」设置商品、实际支付币种、支付金额、到账 USD 额度和单次/周期模式。新商品使用持久化的数字自增编号，界面不再要求手工填写；历史商品继续保留原 ID。支付适配器统一在「支付方式」配置；余额、权限组和个体倍率在用户管理中调整。用户购买位于「充值与订阅」，资金明细位于「用量与账单」。CNY 商品购买 USD 额度是明确的商品定价，没有隐式换汇。已有订单和订阅使用原价格快照。Checkout 支持 `Idempotency-Key`，并发或超时重试复用原订单；付款通知先到时，不会被迟到的失败响应覆盖。

支付插件只负责支付平台协议。验签后，Commerce 核对订单、商户、金额和币种，在本库事务内写支付事实和 outbox；随后调用 `billing.payment-state@1`，在同一钱包事务内提交原始额度、累计冲减与支付冻结。投递失败定时重试，也可由管理员调用 `POST /api/plugins/official.commerce/retry`。账本先提交而 outbox 尚未标记时，重启重投不会双入账；并发更新的较新版本不会被旧任务标为已投递。单个钱包失败不会阻塞其他用户入账。普通 Event 不承担财务交付。

### Stripe

环境变量示例：

```text
STRIPE_SECRET_KEY=<商户测试模式密钥>
STRIPE_WEBHOOK_SECRET=<Webhook endpoint 签名密钥>
```

在 Stripe 支付页面填写 `env:STRIPE_SECRET_KEY`、`env:STRIPE_WEBHOOK_SECRET` 并选择测试/正式模式。配置中的 `secretRefs` 会由表单按选择的引用生成；不在控制台填写明文密钥。Webhook 地址：

```text
https://你的域名/api/plugins/official.payments-stripe/webhook
```

订阅事件：`checkout.session.completed`、`checkout.session.async_payment_succeeded`、`invoice.paid`、`invoice.payment_failed`、`customer.subscription.updated`、`customer.subscription.deleted`。

请求固定使用 Stripe API `2025-03-31.basil`；验签基于原始字节、HMAC-SHA256、300 秒时效和常量时间比较，支持多个 v1 签名。关键事件再次查询 Stripe 对象。兼容 Invoice 旧 `subscription` 及新 `parent.subscription_details.subscription` 字段。

单次支付只有 `payment_status=paid` 才入账，以 PaymentIntent 去重。订阅只按已付 Invoice 发放周期额度，Checkout 完成不重复发放。重复或同周期 Invoice 不二次发放；状态更新查询当前订阅，避免旧事件覆盖新状态。取消自动续订保留已付周期。

### 退款与支付争议

Stripe 处理 `refund.created`、`refund.updated`、`refund.failed`、`charge.refunded` 及 `charge.dispute.created/updated/closed/funds_withdrawn/funds_reinstated`。验签后重新查询当前退款、争议及发票支付关联，不直接用通知快照的金额或状态变更钱包。整笔退款通知会分页读取全部退款；订阅按 Invoice Payments 关联原 Invoice，兼容本地原有的发票支付 ID。

Commerce 持久保存每笔退款或争议及去重事件。通知早于支付入账时保留待匹配事实，支付到达后自动关联；充值与已确认的冲减、冻结一次性写入钱包，不先放出可花费额度。未匹配、关联不明确、币种或金额异常的记录进入管理核对；能够关联但状态异常的支付保守冻结原额度。

处理中退款及未决争议冻结对应额度；成功退款或败诉将对应额度转为账本冲减，失败退款、取消退款及胜诉/关闭争议释放冻结，已冲减的款项按服务商最新事实追加恢复账本。所有变动保留原始入账，不删除历史记录。按购买时的支付金额与 USD 到账额度比例计算，合计冲减与冻结不超过该笔原额度；商户争议费用不向用户额外扣取。余额已消费时允许产生欠额，新的预付调用继续受可用余额检查约束。

管理员在「商品与订阅 → 退款与争议」按用户、状态及记录搜索，重新核对须近期管理员认证和操作原因，写入管理审计。重新核对只读取服务商事实并同步钱包，不发起银行退款、不提交争议材料，也不自动改变 Stripe 续订计划。用户仅从自己的订单查看退款与争议；钱包区分请求预留和支付冻结，资金明细显示冲减与恢复。

易支付各平台的退款接口不统一，首期保持商户后台退款、人工核对并在用户管理中追加有原因的余额调整，不虚构自动退款支持。

当前商品是固定金额、单价格周期。优惠码、税费、试用、按比例变更、银行退款发起、Stripe 保存付款工具管理和发票 PDF 暂未实现。上述退款及争议链路已由隔离模拟服务验证，仍须使用实际 Stripe 测试商户完成事件回放后再开放收款。

协议参考：[退款对象](https://docs.stripe.com/api/refunds/object)、[争议对象](https://docs.stripe.com/api/disputes/object)、[Invoice Payments](https://docs.stripe.com/api/invoice-payment/list)。

### 易支付

在易支付页添加支付方式，可同时启用支付宝、微信支付及 QQ 钱包，也可配置多个平台或商户。每条配置拥有持久化数字自增编号、名称、独立启停、V1/V2 与 MD5/RSA 设置；可复制商户参数后切换支付类型，新增方式默认停用。用户购买时按实际方式选择，订单保存所选配置及名称，幂等键不能跨方式复用。商品、渠道和支付方式等内部配置 ID 自动生成；模型名等外部协议标识仍由管理员指定。

停用方式或关闭易支付只阻止新订单，已存在且保留配置的订单仍可接收回调。删除配置后该方式的待付款订单不能验签，建议先停用并等待订单完成。旧单配置及无方式 ID 的历史订单回调继续兼容，原环境变量引用保留。

配置 V1/V2 与 MD5/RSA。文档标准组合是 **V1 + MD5、V2 + RSA**；另外两种为兼容模式，须确认具体商户平台支持。

V1 生成 `/submit.php` 跳转；V2 POST `/api/pay/create`，携带 `method=jump`、clientip、timestamp 等字段，只接受验签后的跳转响应，不执行平台返回的 HTML/JS。RSA 使用 SHA256WithRSA / PKCS#1 v1.5；私钥签请求，平台公钥验响应/通知。MD5 按字段 ASCII 排序，排除空值/sign/sign_type，不 URL 编码签名原文，拼接商户 Key。

控制台可直接填写 MD5 商户密钥，或 RSA 商户私钥及平台公钥。插件使用 AES-256-GCM 加密存入自己的 `secrets.sqlite`，主密钥保存在同目录的 `vault.key`（权限 0600）。配置仅保存不可变的 `local:` 引用，查询配置和再次编辑均不返回密钥原文；留空保留已有值，复制支付方式复用原引用。备份必须同时保留插件数据和主密钥，修改凭证须管理员会话及近期身份确认。

仍兼容 `keyRef`、`privateKeyRef`、`platformPublicKeyRef` 的环境变量引用，只有 `env:` 引用需要出现在 `secretRefs` 授权列表。回调：

```text
https://你的域名/api/plugins/official.payments-epay/notify?pluhub_method=<支付方式ID>
```

通知地址随订单生成。Commerce 核对回调方式与订单绑定，易支付同时核对该方式的商户与支付类型；支付流水按方式 ID 隔离，避免不同商户的交易号碰撞。只有验签成功的 `TRADE_SUCCESS` 才入账，重复通知返回 success 而不重复发放。金额严格解析为整数分并核对订单。易支付周期套餐是预付权益，没有自动续扣；用户到期重新购买。自然月/年按 UTC 日历计算并处理月底/闰年。

## BYOK 和订阅授权

用户在「个人渠道」保存自己的上游地址、API Key 和模型映射；订阅授权在「自带订阅」中由各提供商插件管理。API Key 可绑定个人渠道，请求也可用 `x-pluhub-channel` 选择个人渠道。平台渠道使用管理员配置的上游授权，不提供用户覆盖平台凭证的接口。

个人密钥采用 AES-256-GCM 加密，AAD 绑定 ID、用户、渠道和类型。主密钥可用 `masterKeyRef` 引用 32 字节 Base64 环境变量，或首次启动生成权限 0600 的 `vault.key`。备份时保留数据库和主密钥；更换主密钥不会自动重加密旧数据。

各订阅提供商插件负责 OAuth 授权、刷新和账号占用，见 [订阅上游插件](SUBSCRIPTION_UPSTREAMS.md)。

渠道配置示例（与普通模型映射组合）：

```json
{
  "codex-plan":{"protocol":"codex","authMode":"siwc","baseUrl":"https://api.openai.com/v1","keyRef":"env:CODEX_ACCESS_TOKEN"},
  "codex-cli":{"protocol":"codex","authMode":"cli","baseUrl":"https://chatgpt.com/backend-api/codex","keyRef":"env:CODEX_ACCESS_TOKEN","accountId":"你的账号ID"},
  "claude-plan":{"protocol":"claude-subscription","baseUrl":"https://api.anthropic.com","keyRef":"env:CLAUDE_ACCESS_TOKEN"},
  "google-plan":{"protocol":"antigravity","baseUrl":"https://cloudcode-pa.googleapis.com","keyRef":"env:GOOGLE_ACCESS_TOKEN","projectId":"你的项目ID"}
}
```

订阅授权是否允许模型调用取决于实际账号和服务商，不凭模型目录推断。CLI 模式强制流式上游，非流式入口可收集后返回；不支持 maxTokens/temperature 覆盖，明确拒绝。因 Anthropic 入口必须指定 max_tokens，不能组合 CLI 模式；可使用 SIWC 或其他兼容上游。启用预付计费且要求输出预算时也不能使用 CLI 平台费用模式，可使用 BYOK。

三个订阅适配器已通过本地认证头、请求包装、JSON/SSE、取消和入口组合验证；没有用户真实订阅授权，未宣称服务商实测成功。

## 限流、转换和界面

流量策略可同时设置每用户、每 Key 和各渠道的 RPM/TPM/并发。使用一分钟固定窗口；Token 先预留、完成后按真实用量修正；未知或中断保留预算，下一窗口恢复。状态存在内存，重启重置，当前不提供分布式限流。Auth 的 Key RPM 仍独立生效。

带宽单位为字节/秒，作用于 HTTP/SSE 响应体，使用 pull 背压并可取消等待，不是 Token/秒限速。宿主 Streaming Hook 可以通过公开 `RequestContext.response` 包装标准 Web Response。客户端关闭响应会中断请求信号，Finalize 后释放资源。

协议转换器可以独立启停。`ai.converter@1` 支持 decode/encode/decodeResult/encodeResult/decodeStream/encodeStream；流式对象使用 Native TS 调用。存在时入口与标准上游通过声明的能力调用；不安装时兼容已有内建转换路径。订阅服务的包装由各自适配器处理。协议预览不调用模型。文本、工具、用量及流式范围延续 [支持矩阵](PROTOCOLS.md)。

控制台按账单、订阅、支付方式和个人渠道组织业务入口。协议准入、限流、输出 TPS、自动路由和请求变换统一在渠道流程图编辑。保留可读字号、焦点样式、明暗主题及手机布局。

## 文档与参考来源

以下仅作协议/功能参考，未复制参考项目实现源码：

- [Stripe Checkout](https://docs.stripe.com/api/checkout/sessions/create)、[Webhook 验签](https://docs.stripe.com/webhooks)、[订阅事件](https://docs.stripe.com/billing/subscriptions/webhooks)、[履约](https://docs.stripe.com/checkout/fulfillment)
- [易支付 V1](https://yzf.yzfpay.com/doc/v1_legacy_api.html)、[V2 创建订单](https://ezfu.cn/doc/pay_create.html)
- [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)、[Sub2API](https://github.com/Wei-Shaw/sub2api)
- [OpenAI SIWC](https://developers.openai.com/siwc/quickstart)、[Codex app-server token sharing](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)

本地支付测试不发起真实付款。真实 New API 联调结果在 `output/live-newapi.json`：两次 DeepSeek 请求 HTTP 200，但 16 Token 预算内无正文；Qwen 渠道返回上游错误。累计 3 次模型查询、3 次推理请求，未进一步扩大调用。报告和源码均不包含用户密钥。
