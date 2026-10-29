# 支付与订阅

计费、商品和支付适配器按需启用，均面向当前单节点部署。管理员在「支付与商业」配置计费、商品及支付方式；用户从「钱包与订阅」查看余额账单、购买商品和管理订阅。

## 钱包与计费

钱包以整数微美元记账，1 USD = 1,000,000 微美元。请求执行前预扣，结束时按有效用量结算；已派发但缺少有效用量时按预扣金额收费。价格、倍率、输出预算、取消和重启处理统一见 [模型计价](PRICING.md)。实际扣费以账本为准，不能用调用日志的估算金额代替。

个人渠道可配置固定请求手续费，详见 [个人渠道](PERSONAL_CHANNELS.md#原价与消耗倍率)。平台调用按模型价格和渠道倍率计算，密钥范围见 [渠道授权](GATEWAY.md#渠道授权范围)。

## 商品和支付

管理员在「支付与商业 → 商品与订阅」设置商品、实际支付币种、支付金额、到账 USD 额度和单次/周期模式。商品编号由系统生成。支付适配器统一在「支付方式」配置；余额和管理员身份在用户管理中调整。用户从「钱包与订阅」购买并查询资金明细。CNY 商品购买 USD 额度是明确的商品定价，没有隐式换汇。已有订单和订阅使用原价格快照。Checkout 支持 `Idempotency-Key`，并发或超时重试复用原订单；付款通知先到时，不会被迟到的失败响应覆盖。

订阅按订阅 ID 和周期结束时间去重：同一周期的重复付款通知或不同账单编号只发放一次额度，账单记录仍保留以便核对。升级旧数据库时，现有订阅的当前周期会写入去重记录；旧版本未保存的更早周期无法从该记录中恢复。

支付通知经核对后持久保存，钱包入账失败会定时重试；管理员也可调用 `POST /api/plugins/official.commerce/retry`。重复通知、重启重投和同周期账单不会重复发放额度。提供商、订单和钱包的事务分工见 [资金链路](PLUGIN_ARCHITECTURE.md#资金链路)。

### Stripe

在 Stripe 支付页面直接填写商户密钥与 Webhook 签名密钥，并选择测试/正式模式；保存到支付插件的加密存储。留空保留已保存凭据。Webhook 地址：

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

易支付退款需在商户后台处理，再人工核对并在用户管理中追加有原因的余额调整。

当前商品是固定金额、单价格周期。优惠码、税费、试用、按比例变更、银行退款发起、Stripe 保存付款工具管理和发票 PDF 暂未实现。开放收款前应使用实际 Stripe 测试商户完成事件回放和账本核对，参见 [联调说明](LIVE_TESTING.md)。

协议参考：[退款对象](https://docs.stripe.com/api/refunds/object)、[争议对象](https://docs.stripe.com/api/disputes/object)、[Invoice Payments](https://docs.stripe.com/api/invoice-payment/list)。

### 易支付

在易支付页添加支付方式，可同时启用支付宝、微信支付及 QQ 钱包，也可配置多个平台或商户。每条配置拥有持久化数字自增编号、名称、独立启停、V1/V2 与 MD5/RSA 设置；可复制商户参数后切换支付类型，新增方式默认停用。用户购买时按实际方式选择，订单保存所选配置及名称，幂等键不能跨方式复用。

停用方式或关闭易支付只阻止新订单，已存在且保留配置的订单仍可接收回调。删除配置后该方式的待付款订单不能验签，建议先停用并等待订单完成。商户参数统一保存在 `methods` 的对应支付方式内，创建订单与回调均使用明确的支付方式 ID。

配置 V1/V2 与 MD5/RSA。文档标准组合是 **V1 + MD5、V2 + RSA**；另外两种为兼容模式，须确认具体商户平台支持。

V1 生成 `/submit.php` 跳转；V2 POST `/api/pay/create`，携带 `method=jump`、clientip、timestamp 等字段，只接受验签后的跳转响应，不执行平台返回的 HTML/JS。RSA 使用 SHA256WithRSA / PKCS#1 v1.5；私钥签请求，平台公钥验响应/通知。MD5 按字段 ASCII 排序，排除空值/sign/sign_type，不 URL 编码签名原文，拼接商户 Key。

控制台可直接填写 MD5 商户密钥，或 RSA 商户私钥及平台公钥。插件使用 AES-256-GCM 加密存入自己的 `secrets.sqlite`，主密钥保存在同目录的 `vault.key`（权限 0600）。配置仅保存不可变的 `local:` 引用，查询配置和再次编辑均不返回密钥原文；留空保留已有值，复制支付方式复用原引用。备份必须同时保留插件数据和主密钥，修改凭证须管理员会话及近期身份确认。

`keyRef`、`privateKeyRef`、`platformPublicKeyRef` 保存加密凭据编号，页面直接填写实际密钥。宿主托管的 `secret:` 引用需要出现在 `secretRefs` 授权列表。回调：

```text
https://你的域名/api/plugins/official.payments-epay/notify?pluhub_method=<支付方式ID>
```

通知地址随订单生成。Commerce 核对回调方式与订单绑定，易支付同时核对该方式的商户与支付类型；支付流水按方式 ID 隔离，避免不同商户的交易号碰撞。只有验签成功的 `TRADE_SUCCESS` 才入账，重复通知返回 success 而不重复发放。金额严格解析为整数分并核对订单。易支付周期套餐是预付权益，没有自动续扣；用户到期重新购买。自然月/年按 UTC 日历计算并处理月底/闰年。
