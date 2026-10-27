# 登录、注册与账号安全

`official.mailer`、`official.turnstile` 分别提供发件和人机验证能力。Auth 负责邮箱登录凭据、TOTP、恢复码、WebAuthn 公钥和会话；Users 继续提供账号、角色与启用状态，通过公开 Capability 协作。验证码、邮件服务由独立插件提供，公共类型位于 Spec 的 `@pluhub/contracts/security`，Kernel 不包含认证方式的实现。

默认保留密码登录；邮箱注册、邮箱登录、人机验证和 WebAuthn 均需管理员启用。个人账号设置通过侧栏底部账号入口或 `#/account` 访问，旧的 `#/auth?tab=security` 仍可使用。API 密钥列表独立于账号安全，创建和撤销在弹窗中完成。站点配置统一位于管理员的「安全与验证 → 登录与验证」，在同一页面管理登录注册、邮件、人机验证、Passkey 与两步验证。

管理员创建用户使用 Auth 的 `POST /api/plugins/official.auth/users`：要求管理员会话及近期身份确认，先校验并哈希初始密码，再通过 Users 能力创建用户事实。无效密码不再留下无法登录的账号；Users 不依赖 Auth。

用户登录地址为 `#/login`，注册地址为 `#/register`。全新站点先经 OOBE 保存站点设置并创建管理员；在此之前公开注册不可用。门户和登录页提供注册链接；注册页支持邮箱验证码、用户名、密码确认、重发倒计时及错误重试，成功后以普通用户身份进入控制台。未开放注册或邮件服务不可用时显示相应状态。公开页面不显示管理员初始化命令；CLI 创建和恢复方法保留在部署文档中。

凭据在配置页直接填写并加密保存；示例中的 `secret:` 编号须替换为真实保存的编号，详见 [凭据与参数](SECRETS.md)。

## 配置

以下为各插件的 `config`，不是整个宿主配置文件。主配置中相应插件需要安装并启用。凭据在管理页面填写，保存后 `secretRefs` 授权插件读取相应的加密凭据，浏览器只看到已配置状态。

`official.mailer`：

```json
{
  "enabled": true,
  "host": "smtp.example.com",
  "port": 587,
  "secure": false,
  "from": "no-reply@example.com",
  "user": "smtp-user",
  "passwordRef": "secret:SMTP_PASSWORD",
  "secretRefs": ["secret:SMTP_PASSWORD"]
}
```

587 使用强制 STARTTLS；465 设置 `secure: true` 使用隐式 TLS。验证服务器证书，不降级为远程明文。`allowInsecure: true` 仅允许 `localhost`、`127.0.0.1`、`::1` 的本地测试服务。邮件为单收件人，正文提供纯文本及可选 HTML，不支持调用方提供附件、文件路径、远程 URL、任意邮件头或发件人。连接和会话有超时，同一插件最多并行 8 次发送；停用时关闭传输。管理员测试按钮会主动发送一封测试邮件，保存配置本身不会发信。

当 SMTP 使用 Docker 内网服务名连接，且证书签发给公开域名时，可设置 `tlsServerName` 为该证书域名。此项用于 SNI 和证书主机名校验，不会关闭证书验证；省略时使用 SMTP 服务器名。相应容器需要位于可互通的 Docker 网络。

人机验证插件的安装标识为 `official.turnstile`，显示名称为「人机验证」。在「登录与验证 → 人机验证」选择 Turnstile、reCAPTCHA v2/v3、hCaptcha 或极验 v4，一次启用一个服务。登录、注册发信、公开邮件验证码请求可分别开启保护；找回密码发信沿用登录或通用邮件策略。未设置 `provider` 的配置使用 Turnstile：

```json
{
  "enabled": true,
  "provider": "turnstile",
  "siteKey": "YOUR_PUBLIC_SITE_KEY",
  "secretRef": "secret:TURNSTILE_SECRET",
  "secretRefs": ["secret:TURNSTILE_SECRET"],
  "hostnames": ["hub.example.com"]
}
```

Turnstile 调用 Cloudflare 官方校验接口，服务端校验 success、精确 hostname、action、challenge_ts，令牌有效期最多五分钟且单次使用。

reCAPTCHA 使用 `provider: "recaptcha"`，`recaptchaVersion` 选择 `v2`（默认）或 `v3`。Site Key、Secret Key 引用和 `hostnames` 使用相同字段；`recaptchaDomain` 可选择 `www.google.com`（默认）或官方替代域名 `www.recaptcha.net`。v2 使用复选框组件；v3 在提交受保护操作时获取新令牌，服务端额外校验 action 和 `minScore`（默认 0.5，范围 0–1）。两种版本均校验官方响应、主机名和最多两分钟的令牌时效。

极验使用 `provider: "geetest"`，`siteKey` 填写 Captcha ID，`secretRef` 引用对应的 Captcha Key。前端使用极验 v4 组件，服务端以 HMAC-SHA256 对 `lot_number` 签名，通过 HTTPS 二次校验 `captcha_output`、`pass_token` 和 `gen_time`。域名策略由极验控制台管理，不复用 Turnstile/reCAPTCHA 的主机名响应校验。

hCaptcha 使用 `provider: "hcaptcha"`，填写 Site Key 和 Secret Key；密钥在设置页直接输入，由宿主加密保存，配置使用 `secret:` 引用。前端等待官方 SDK 就绪后显式渲染复选框，关闭其 reCAPTCHA 兼容别名，避免切换服务时互相覆盖。过期、失败和挑战超时会清除令牌，可重新验证或重试加载。

服务端以表单格式向 `https://api.hcaptcha.com/siteverify` 提交 `secret`、`response` 和配置中的 `sitekey`，由官方接口约束站点归属、有效期及单次使用；本站校验 `success`，并额外记录两分钟内已用令牌。hCaptcha 的 `hostname` 是统计字段，可能返回 `not-provided`，不作为认证条件；允许域名在 hCaptcha 控制台设置，本站不显示 Turnstile/reCAPTCHA 的主机名配置。标准接入不依赖企业版评分。

所有服务通过 `captcha.options@1` 和 `captcha.verify@1` 接入 Auth。浏览器统一提交 `captchaToken`；旧客户端的 `turnstileToken` 继续兼容。极验将 `getValidate()` 结果编码为 JSON 字符串传递。成功令牌按提供商与 Site Key 隔离缓存摘要，极验以流水号去重，防止更改 JSON 字段顺序绕过本地重放检查。失败、超时或异常响应均不放行，Secret Key 不进入前端。Console 仅在需要验证时加载所选提供商的组件，CSP 允许固定的官方脚本、连接与 iframe 来源。

`official.auth`：

```json
{
  "issuer": "PluHub",
  "secureCookie": true,
  "registrationEnabled": true,
  "emailLoginEnabled": true,
  "passwordResetEnabled": true,
  "captcha": { "login": true, "register": true, "email": true },
  "webauthn": {
    "enabled": true,
    "rpID": "hub.example.com",
    "rpName": "PluHub",
    "origins": ["https://hub.example.com"]
  }
}
```

RP ID 是域名；Origin 必须含协议及非默认端口，不能包含路径或结尾斜线，并且属于 RP ID。正式 WebAuthn 需要 HTTPS 和 `secureCookie: true`；开发仅允许 `rpID: "localhost"` 配合 `http://localhost:端口`。TLS 反向代理还应按宿主部署说明设置 Listener 的 `publicOrigin`。页面与服务端配置必须使用同一 Origin，不能混用 `localhost` 与 `127.0.0.1`。

三个插件均支持配置快照更新。服务未正确配置时会拒绝相应验证，不退化为跳过验证码。停用邮件服务不影响密码、TOTP 或 Passkey 登录，也不能再申请新的邮箱验证码；已经发出的有效验证码仍按原有效期验证。

`passwordResetEnabled` 控制自助找回密码；未设置时跟随 `emailLoginEnabled`，显式 `false` 可单独关闭。新站点完成初始化后才开放恢复；邮件服务可用时登录页显示「忘记密码？」。关闭恢复后，已发出的恢复挑战也不能提交。

## 使用流程

- **邮箱注册**：发送验证码 → 输入验证码、用户名和至少 12 字符的密码 → 创建普通用户并登录。角色固定为普通用户，客户端不能指定管理员。管理员由首次部署向导创建，也可通过本地 CLI 预建。先建立已验证账号，再绑定 Passkey；首期不提供无账号的 Passkey 直接注册。
- **邮箱登录**：只有已绑定并验证的地址可以收到登录码。对不存在或不符合条件的地址返回相同通用提示，不创建账号。更换邮箱后，旧邮箱尚未使用的登录验证码也会失效。
- **找回密码**：绑定邮箱验证码 → 输入新密码 → 完成已启用的 TOTP、恢复码或新一次 Passkey 用户验证 → 使用新密码重新登录。不自动创建会话，不关闭两步验证，不删除 API Key。重置密码、消费验证码与恢复码、退出所有设备在同一事务中完成；失败可重试，不留下部分更新。账号、邮箱或密码发生变化后旧挑战失效。恢复只针对邮件证明绑定的账号，客户端不能指定另一个用户或在第二步替换新密码。
- **TOTP**：近期登录后扫码或手动输入密钥 → 输入验证器动态码确认 → 保存十条一次性恢复码。启用后其他会话退出，之后密码和邮箱登录必须再完成 TOTP 或恢复码验证。验证器采用 RFC 6238、SHA-1、六位、30 秒，允许相邻一个时间窗口；已成功使用的计数器不能再次使用，包括绑定确认时使用的码。
- **Passkey**：添加有意义的凭据名称，在浏览器或密码管理器确认绑定；之后可直接登录。WebAuthn 强制用户验证（PIN、生物识别等），所以它可以作为开启 TOTP 后的另一条强认证登录方式，无需再输入 TOTP。
- **硬件密钥**：选择外接 FIDO2 安全密钥并完成 PIN 或生物识别。非驻留凭据登录时需要先填写用户名，再点击安全密钥登录。只支持触摸、没有用户验证能力的旧 U2F 密钥不用于本期免密码登录。
- **撤销**：删除 Passkey 会使使用该凭据建立的会话立即失效。关闭 TOTP 会清除恢复码并退出其他会话；重新生成恢复码会立即废止旧码。更改密码会使该用户所有会话和未完成挑战失效。

Passkey 和安全密钥均使用标准 WebAuthn，支持 ES256、RS256，服务器保存公钥、签名计数器、设备类型和备份状态，不保存私钥。校验挑战、Origin、RP ID、签名、用户验证、计数器和用户归属，拒绝跨站 iframe 发起的认证。挑战五分钟有效且单次使用；注册挑战绑定当前会话，登录挑战绑定临时 HttpOnly/SameSite Cookie。注册使用 `attestation: none`，不建立硬件品牌白名单，也不声称认证器来自经过审计的特定硬件厂商。

账号禁用后，密码、邮件、TOTP 完成步骤、Passkey 和既有会话都会重新检查用户状态。API Key 只用于网关访问，不能绑定或删除安全凭据。

## 时效、限流与恢复

绑定或撤销邮箱、TOTP、安全密钥及恢复码，要求最近五分钟内完成登录或身份确认。旧会话可在「确认身份」输入密码与已启用的第二因素；Passkey 用户可重新使用 Passkey 登录。升级前会话没有近期认证时间，需要重新确认身份。

邮件码十分钟有效、每个挑战最多五次验证；同一邮箱发送间隔至少一分钟、每小时最多五封，单连接来源每小时最多三十次。邮件发送失败不会返回验证码，也不会让未送达的挑战继续有效。TOTP 与恢复码验证、登录和安全密钥申请也有独立尝试次数限制，配额保存在 SQLite，重启不清零。Listener 覆盖客户端提交的 `x-pluhub-peer`；只有直接连接方位于显式配置的 `trustedProxies` 时，才从右向左解析 `X-Forwarded-For`，在首个不可信地址停止。未配置可信代理时使用直接连接地址，反代后的请求会共享该来源配额。

TOTP 密钥使用 AES-256-GCM 加密并绑定用户 ID，恢复码和邮件验证码保存带服务端密钥的 HMAC 摘要。随机 32 字节密钥保存在 Auth 数据目录 `security.key`，Linux 文件权限为 0600。**备份时必须同时备份 `auth.sqlite` 和 `security.key`**。存在 TOTP 凭据而密钥文件丢失时，启动会拒绝，需从备份恢复；不会生成一个新密钥并绕过现有验证。

管理员在丢失所有第二因素时，可以在宿主停机后使用本地 CLI：

```sh
bun apps/cli/dist/index.js call auth.reset-factors@1 '{"username":"admin"}' --config ./pluhub.json
```

该能力仅清除指定用户的 TOTP、恢复码、安全密钥、未完成挑战和所有会话，不修改密码或用户角色，也没有对应 HTTP 重置接口。Windows PowerShell 可用变量传递该 JSON 参数。重新启动后使用既有密码登录并重新绑定；密码丢失则另用原有 `bootstrap-admin` 本地流程。

## API 与公开能力

管理和个人 API 均位于 `/api/plugins/official.auth`。`/options` 公开查询启用的方式和必要的公开 Site Key；不会返回任何秘密。

| 流程 | 接口 |
| --- | --- |
| 密码登录 | `POST /login` |
| 第二步 | `POST /login/mfa`，携带 `challenge` 和 `code` 或 `recoveryCode` |
| 邮件验证 | `POST /email/request`，`purpose` 为 `register`、`login` 或 `bind` |
| 找回密码 | `POST /email/request`，`purpose: "reset"`；`POST /password/reset` 提交邮箱、`challenge`、`code` 和新 `password` |
| 恢复的第二步 | `POST /password/reset/finish`，提交恢复 `challenge` 和 `code` 或 `recoveryCode`；或先完成 Passkey 登录再提交恢复挑战 |
| 注册 / 邮件登录 / 绑定 | `POST /register`、`POST /email/login`、`POST /email/bind` |
| 安全状态 / 再认证 | `GET /security`、`POST /reauth` |
| TOTP | `POST /totp/setup`、`POST /totp/confirm`、`DELETE /totp` |
| 重建恢复码 | `POST /recovery-codes` |
| WebAuthn 绑定 | `POST /passkeys/register/options`、`POST /passkeys/register/verify` |
| WebAuthn 登录 | `POST /passkeys/login/options`、`POST /passkeys/login/verify` |
| 撤销凭据 | `DELETE /passkeys?id=凭据ID` |

密码或邮件验证通过但仍需第二因素时，响应为 `{ "mfaRequired": true, "challenge": "...", "methods": ["totp", "recovery"] }`，此时不会颁发登录会话。客户端完成 `/login/mfa` 后才获得 `pluhub_session`。安全接口返回 `Cache-Control: no-store`。

注册和邮件登录的 Turnstile 在申请邮件码时校验，action 对应所配置的 `register`、`login` 或通用 `email` 策略；已通过的同一令牌不在最终提交时重复使用。绑定邮箱已要求已登录且近期验证，不额外消耗公开验证码挑战。

恢复邮件使用登录或通用邮件的 Turnstile 策略，验证码申请后开始一分钟重发倒计时；冷却结束重新取得人机验证令牌。恢复邮件码绑定临时 HttpOnly、SameSite=Strict、Path=/ Cookie；`secureCookie: true` 时使用 `__Host-pluhub_reset` 并添加 Secure，不接受非前缀或重复 Cookie。邮箱证明十分钟有效，恢复的第二步五分钟有效，各最多五次验证。新密码候选的哈希加密保存在恢复挑战中，明文密码不进入数据库、邮件或浏览器存储。

恢复 Passkey 选项请求需要同时提交已验证的 `resetChallenge` 和恢复 Cookie，不重复消耗 Turnstile；凭据必须属于恢复目标并满足 WebAuthn 用户验证。已有会话不能替代新验证，即使会话创建时间恰与挑战相同；成功后刚创建的 Passkey 会话也一并撤销。更换邮箱或通过其他方式修改密码后，旧恢复证明和第二步均失效。

独立服务能力为 `mail.options@1`、`mail.send@1`、`captcha.options@1`、`captcha.verify@1`。宿主网络对象、内部数据库不进入这些契约。

`mail.send@1` 接收 `to`、`subject`、`text` 和可选的 `html`。纯文本正文始终必填；提供 HTML 时通过 SMTP 发送 `multipart/alternative`。注册、邮箱登录、邮箱绑定、找回密码和管理员测试使用统一的中英文邮件模板，站点名称与主题色通过可选的 `site.branding@1` 能力读取。模板使用内联样式和表格布局，不加载外部资源；动态品牌文本经过 HTML 转义，验证码不放入主题或预览摘要。

邮件语言依次使用收件账号语言、当前页面传入的 `language`、站点默认语言。邮箱登录和找回密码按收件账号查询偏好，邮箱绑定和管理员测试按当前账号查询；公共请求不能覆盖已保存的账号偏好。新注册账号会保存注册页面所选语言。无 Console 插件时使用 PluHub 品牌和中文默认值；原有纯文本邮件调用保持兼容。

管理员可在「登录与验证 → 邮箱验证」选择注册、登录、绑定、找回密码或服务测试模板，预览 HTML 与纯文本，并向指定邮箱发送相同样例。`POST /api/plugins/official.mailer/preview` 接收可选的 `template`、`language`，按当前管理员的账号语言返回主题及双格式正文，不发送邮件；SMTP 关闭时仍可预览。`POST /api/plugins/official.mailer/test` 额外接收 `to`，省略模板时保持服务测试邮件行为。验证类样例明确标注测试用途，固定示例码不创建认证挑战，不能用于登录或重置密码。两接口均要求 `host.manage` 权限，预览响应禁止缓存。

## 登录设备与来源检查

账号设置提供安全设置、登录设备和安全记录页内标签。安全记录包括登录成功、失败、等待二步验证、注册、退出、身份确认、密码和验证方式修改、会话及 Key 撤销；管理员在原「管理操作记录」入口切换到「账号安全」查询全站。等待第二因素不记作成功登录。未知账号的失败事件仅供管理员查询，不保存提交的用户名。

`GET /api/plugins/official.auth/security/history` 仅本人控制台会话可读；企业主账号不能查看子账号的安全历史，API Key 也不能读取。`GET /admin/security-history` 与 `/admin/security-history/status` 要求管理员控制台会话。查询支持 `action/outcome/method/userId/actorId/requestId/from/to`、`limit=1..100` 和 `offset`；个人接口禁止指定其他用户或操作人。时间为包含端点的毫秒时间戳，所有条件取交集，响应禁止缓存。本人视图隐藏用户和操作人 ID；其他账号操作本人时，也隐藏该操作人的设备和 IP。

Auth 自己维护 `security_events`，默认保留 90 天、最多 100,000 条；配置项 `securityHistoryRetentionDays`（1–3650）、`securityHistoryMaxRows`（1000–1,000,000）。保存固定事件名、结果、验证方式、服务端请求 ID、经过验证的来源 IP、浏览器和系统类别，以及必要的资源 ID。Key 使用内部 ID，Passkey 使用凭据 ID 的 SHA-256 指纹；不保存邮箱、密码、验证码、恢复码、完整 Cookie、凭据内容或原始 User-Agent。

安全历史尽力写入，故障不会使已成功的认证或密码修改失败；故障及未保存条数通过状态接口显示，无法读取时返回 503。`auth.security-history@1` 仅提供 `available/dropped/failures/retentionDays/maxRows` 状态元数据，不返回事件。失败计数属于当前进程，丢失记录不能补写；此规则不改变管理员业务写入前必须成功留痕的审计要求。用户角色和企业归属修改仍由 Users 与宿主管理审计记录，Users 不反向依赖 Auth。

账号设置中的「登录设备」显示本人有效会话的设备、IP、认证方式和活动时间，支持退出指定设备或其他全部设备。撤销其他设备要求近期认证，退出当前设备清除 Cookie。列表不返回令牌或其哈希；已有会话迁移后保持可用，新登录最多允许 50 个有效设备。

启用 Secure Cookie 后，已认证会话的写操作必须携带与站点一致的 Origin；没有 Origin 时可使用同源 Referer。缺少来源、跨站或畸形来源返回 403。API Key 调用保持独立的令牌授权。

## 本地验证与当前边界

```sh
pnpm build:all
pnpm test:all
node scripts/identity-demo.mjs
```

演示打开 `http://localhost:18181`，只允许向 `@example.test` 测试地址发信；验证码显示在终端，SMTP 服务完全在本机，不会发送真实邮件。演示启用邮箱注册、登录与 localhost WebAuthn，其他演示说明与 `pnpm demo` 相同。浏览器的虚拟 FIDO2 认证器仅用于自动化测试，不是产品内置的认证绕过。

`pnpm pack:all` 后可运行 `node scripts/verify-identity-packages.mjs`，在临时目录安装分发归档，验证密码会话、TOTP 二维码、WebAuthn 选项及本地 SMTP，再清理临时目录。分发物与校验和位于 `output/packages`。

已验证：RFC TOTP 样例、加密与重启保留、SMTP 实际会话、邮件码猜测/过期/换绑、角色限制、TOTP 与恢复码重放、真实 WebAuthn 签名及 Origin/RP/UV/计数器错误、账号禁用、撤销会话与旧数据库迁移。浏览器验证邮箱注册、TOTP 绑定、恢复码完成两步登录及 Passkey 绑定/登录/撤销。

人机验证的本地用例覆盖 Turnstile/hCaptcha 的成功、过期、拒绝、重复令牌和异常响应，以及 reCAPTCHA v3 的 action、评分与主机名校验。hCaptcha 官方公开测试密钥已用于在线 Siteverify 协议验证；测试密钥不写入站点配置。真实生产站点密钥的挑战流程仍需在配置后验证，不把测试密钥结果视为生产账号验证。SMTP 已通过本机协议测试及 SLC 线上服务的 TLS、认证、测试邮件接收和注册验证码请求验证；SMTP 接受不等同于收件箱投递证明。硬件交互使用 Chromium 虚拟 FIDO2 认证器，尚未测试实体密钥、系统平台认证器和跨设备同步。

参考：[Turnstile 服务端校验](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)、[reCAPTCHA 服务端校验](https://developers.google.com/recaptcha/docs/verify)、[reCAPTCHA v3](https://developers.google.com/recaptcha/docs/v3)、[hCaptcha 官方接入](https://docs.hcaptcha.com/)、[极验 v4 服务端接口](https://docs.geetest.com/gt4/apirefer/api/server)、[SimpleWebAuthn Server](https://simplewebauthn.dev/docs/packages/server)、[Nodemailer SMTP](https://nodemailer.com/smtp)、[RFC 6238](https://www.rfc-editor.org/rfc/rfc6238) 和 [WebAuthn](https://www.w3.org/TR/webauthn-3/)。
