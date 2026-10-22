# Docker 部署

镜像正式目标为 Linux x64。需要 Docker Engine、Buildx 和 Docker Compose 2.24+；主仓、Spec、Plugins 保持同级目录。Go SDK 不参与当前镜像构建，安装 Go 进程插件时提供编译好的 Linux 可执行文件。

最终镜像使用固定版本及 digest 的 Bun 1.4.3，宿主、CLI、健康检查及 JavaScript 进程插件均使用 Bun。Node.js 24 仅用于构建和生产依赖制备，不复制到运行镜像。UID/GID 保持 1000，已有数据卷无需修改所有者；Bun 官方镜像的 `node` 兼容入口同样执行 Bun，保留旧维护命令兼容性。

## 首次启动

在 PluHub 根目录执行：

```sh
cp .env.example .env
docker compose build
docker compose up -d
docker compose ps
```

打开站点后依次设置站点信息、公开门户并确认，再创建管理员账号，密码至少 12 字符。创建成功后进入登录页，初始化入口随即关闭；已有管理员的实例直接进入正常登录流程。容器没有默认管理员密码。

新站仅默认启用账号、网关、标准协议、模型目录、Playground 与日志，共 17 个插件。计费、支付、BYO、订阅上游、自动路由、限流/TPS、邮件、验证码、工单和排行榜预装但停用，可在插件管理中按需启用；依赖需一并启用。停用插件不加载接口、Hook 或界面入口。定时备份默认关闭。升级保留现有的启用状态。

切换镜像后的首次启动，会在数据卷排他锁内按镜像自带目录同步所有内置插件的版本和安装记录，保留原配置、授权及启停状态。共享代码重建也包含在内，不能只更新本次直接修改的插件。普通重启不重复同步；在线安装到数据卷的插件继续使用各自的安装记录。启动失败时查看 `docker compose logs gateway`，不能只凭 Compose 返回“Started”判断上线成功。

无人值守安装或账号恢复仍可在停机时通过本地 `bootstrap-admin --username admin` 操作；使用 `PLUHUB_ADMIN_PASSWORD` 或挂载的 `PLUHUB_ADMIN_PASSWORD_FILE` 提供密码。通过本地 CLI 预建管理员会跳过网页 OOBE，站点信息可在后台设置。

默认只映射 `127.0.0.1:8080`，访问 `http://localhost:8080`。修改映射端口时同步设置 `.env` 中的 `PLUHUB_PUBLIC_ORIGIN`；公网部署应由 HTTPS 反向代理转发。上游密钥放入 `.env` 的运行时变量，再在控制台使用 `env:变量名` 引用，不写入镜像或路由 JSON。

首次启动自动创建 `/data/pluhub.json` 与 `/data/state/`。`PLUHUB_PUBLIC_ORIGIN` 只在首次创建配置时应用；HTTPS Origin 会同时启用 Auth 的 Secure Cookie。已有配置保留原值，改变域名、端口或 Cookie 策略后需修改持久化配置并重启。

### 接入反代或变更域名

已初始化的实例使用以下命令同时更新 Listener 的 Origin 与 Auth 的 Secure Cookie，不覆盖其他插件配置：

```sh
docker compose stop gateway
docker compose run --rm gateway set-public-origin https://hub.example.com
docker compose up -d gateway
```

命令持有数据卷独占锁，运行中不能修改；非法 URL 不落盘。若已启用 Passkey，必须先明确配置相应的 WebAuthn RP ID 和允许 Origin，否则拒绝切换，防止误操作导致登录不可用。不同域名间的 Passkey 不能自动迁移。修改 `.env` 的 Origin 仅影响首次初始化，不能替代上述命令。可参考 [Nginx 示例](../deploy/nginx.conf.example) 设置 SSE/WS 和超时；反代仍由部署者配置。

## 数据与安全设置

- 镜像使用 UID/GID 1000 的 `bun` 用户，根文件系统只读；只有 `/data` 卷和 `/tmp` 临时目录可写。
- `/data` 保存配置、各插件 SQLite、Auth 的 `security.key`、BYOK 的 `vault.key` 和插件安装数据。不得只备份数据库而遗漏密钥。
- Compose 禁用额外 Linux capabilities，启用 `no-new-privileges`，限制容器日志大小；新装 Native/Process 插件仍是管理员授权的本机代码。
- `docker compose stop` 会发送 SIGTERM；45 秒宽限覆盖默认 30 秒排空。升级采用停机替换。
- 入口使用数据卷上的 `flock` 排他锁，跨容器拒绝并发启动或离线管理，冲突退出码为 75。容器异常退出会释放锁，新启动在持锁后清理旧 PID 标记，支持异常终止后的恢复。
- `.dockerignore` 排除本机数据、密钥、依赖、历史输出和工具缓存。额外构建上下文分别读取 Spec 与 Plugins，不把整个父目录加入镜像。

通过卷维护工具修改配置时，保持文件可由 UID 1000 读写。不要在主服务运行期间并行执行 bootstrap、安装或恢复命令。

## 反向代理

Listener 的 `publicOrigin` 必须与浏览器对外 HTTPS Origin 一致，Auth 使用 `secureCookie: true`。代理应关闭 SSE 响应缓冲，保留长请求超时，并转发连接关闭。

如需基于客户端 IP 的登录限频和 Turnstile 校验，给 Listener 显式配置代理地址：

```json
{
  "host": "0.0.0.0",
  "port": 8080,
  "publicOrigin": "https://gateway.example.com",
  "trustedProxies": ["172.20.0.2/32"]
}
```

只信任实际代理的地址或最小必要网段，不能为了方便信任整个互联网。默认忽略 `X-Forwarded-For`；启用后从右向左检查代理链，在第一个不可信地址处停止，拒绝格式错误或超过 16 跳的链。客户端不能直接覆盖 `x-pluhub-peer`。Listener 配置修改需要重启。

## 健康、备份与升级

`GET /healthz` 检查 Listener 存活；`GET /readyz` 检查网关认证与路由能力已加载。Docker HEALTHCHECK 使用后者。探针不调用付费上游，也不代表服务商实时健康。

升级前停止主服务并备份整个 `/data` 卷，保留旧镜像的 digest。建议先在独立卷恢复备份，检查登录、Key、解密和账本，再切换生产。数据库迁移后回滚需要匹配版本的数据快照；仅切换旧镜像可能被 Schema 版本检查拒绝。`docker compose down` 保留卷，`down -v` 会删除卷，应谨慎使用。

### 加密完整备份

Linux 部署主机使用 `deploy/backup.py`，需要 root、Python 3.11+ 和 Docker CLI，不需要安装 Node。镜像须包含 `backup-bundle` / `backup-decrypt` 命令。首次生成独立密钥，不覆盖已存在文件，也不将密钥输出到终端：

```sh
python3 -B deploy/backup.py keygen --key-file /root/pluhub/keys/backup.key
python3 -B deploy/backup.py create-offline \
  --container pluhub-gateway-1 --directory /root/pluhub \
  --destination /root/pluhub/backups --key-file /root/pluhub/keys/backup.key
```

`create-offline` 排空并停止指定的 Compose Gateway，完整归档 `/data`、`compose.yaml`、可选的 `.env` 和容器配置环境变量，记录实际镜像 ID。主机文件和备份目录不进入用户界面。采用随机 96 位 nonce 的 AES-256-GCM，归档及环境信息全部加密；密钥经标准输入传递，不放入 Docker 参数、环境变量或回执。只支持单个命名数据卷和临时目录，存在其他持久挂载时拒绝，避免静默漏备份。

控制器先用原容器的不可变镜像执行 `verify-data`，再将其成功记录通过只读暂存目录提供给工具镜像。升级时可用 `--tool-image` 选择包含新备份命令的镜像，旧配置中的插件版本仍由原镜像校验；记录也随归档加密保存。该记录由有 Docker 权限的本机控制器提供，不是第三方证明。直接使用镜像命令、未提供记录时，仍使用工具镜像自身校验数据。

每次生成独立目录，内含 `data.phb` 和权限 0600 的校验回执；目录为 0700，原归档不覆盖、不自动清理。密钥须独立保存；丢失密钥无法恢复，更换密钥也不会自动迁移旧归档。匹配的镜像需要另行保留或导出。

辅助容器以默认非 root 用户、只读根文件系统、无网络和无额外能力执行。它与主服务使用同一数据卷排他锁，不允许对运行中数据直接复制。失败或正常结束后恢复原本运行的实例；原本停机的实例保持停机。原镜像或容器归属发生变化时拒绝自动恢复。

备份与部署通过主机 `.pluhub-maintenance.lock` 互斥。中断恢复记录同时标记原实例和本次辅助容器，恢复前核实辅助容器已停止；异常终止后可运行：

```sh
python3 -B deploy/backup.py recover-service --directory /root/pluhub
```

未确认恢复时保留记录，后续任务不覆盖该意图。参与互斥的锁文件不作为冗余临时文件删除。复合部署脚本可通过 `PLUHUB_MAINTENANCE_FD` 传入已经持有的锁描述符；工具验证文件身份并保持父进程持锁。

### 独立恢复检查

```sh
python3 -B deploy/backup.py check \
  --backup /root/pluhub/backups/backup-<标识>/data.phb \
  --key-file /root/pluhub/keys/backup.key --image pluhub:<工具镜像版本>
```

先完成认证解密，再检查路径、重复条目、文件类型、镜像和配置元数据、展开容量与磁盘余量。拒绝绝对路径、路径穿越、软/硬链接、特殊文件和特权模式。仅恢复到本次新建的临时卷，并使用备份记录的本地镜像执行 `verify-data`；不替换生产卷，不启动恢复副本的业务服务。临时明文和卷在结束时清理。

解包到新卷的单个辅助容器使用 root，以及 CHOWN、DAC_OVERRIDE、FOWNER，以还原非 root 所有者及插件包的目录、文件权限。主服务和备份加密容器的权限不变。

恢复仍需部署者在新环境核对镜像、网络、外部服务和配置，再选择切换；工具不自动拉取可变镜像或覆盖运行中的系统。加密、完整性验证和副本恢复不等同于已建立异地备份。S3/R2/SSH 投递与不停机一致性快照另行配置或实现。

### 可配置的每日维护窗口

将 `deploy/backup.py`、`deploy/backup-schedule.py` 安装到部署主机后，由 root 配置 systemd Timer：

```sh
python3 -B deploy/backup-schedule.py configure --directory /root/pluhub \
  --time 04:00 --timezone Asia/Shanghai --window-minutes 30 --enable
python3 -B deploy/backup-schedule.py status --directory /root/pluhub
systemctl list-timers pluhub-backup.timer
journalctl -u pluhub-backup.service --since yesterday
```

再次执行 `configure` 可修改时间、时区、窗口和容器名；省略 `--enable` 则停用 Timer。配置保存在部署目录 `backup-policy.json`，权限 0600。全新安装不自动开启停机备份，只有显式配置 `--enable` 后启用。

任务不在系统重启后补跑，不使用随机延迟。执行前再次检查本地时区及窗口，剩余不足两分钟时跳过；备份期限为窗口结束前 90 秒，超时尝试取消辅助容器并恢复原服务。备份结束后先恢复原服务，再进行独立恢复检查。失败不会更新成功记录。硬故障导致的服务恢复仍需检查持久化恢复记录。

每日备份只保存到 `backups/daily`，校验通过后保存 `verified.json` 和 `latest.json`；该成功记录表示归档认证及 SQLite 完整性检查通过，不代表外部服务已验收。升级备份保留在 `backups`。默认不自动删除归档或匹配镜像，部署者需监控磁盘并制定保留策略。维护锁冲突时任务失败，不在窗口外重试。

### 旧备份兼容

`backup-data` 仍在持有数据卷排他锁时将 `/data` 输出为 gzip tar，排除 PID/锁。服务运行时以 75 退出。它不包含宿主环境或镜像，也不加密；适用于已有部署脚本的兼容路径。手动使用时需要自行停机并负责恢复服务：

```sh
umask 077
mkdir -p backups
stamp=$(date -u +%Y%m%dT%H%M%SZ)
docker compose stop gateway
if docker compose run --rm -T gateway backup-data > "backups/$stamp.tgz"; then
  sha256sum "backups/$stamp.tgz" > "backups/$stamp.sha256"
  docker compose up -d gateway
else
  docker compose up -d gateway
  echo 'Backup failed; check the partial file' >&2
fi
```

另行安全备份宿主机 `.env` 与固定的镜像 ID，它们不在 `/data` 中。备份含敏感数据，存储时加密并限制访问。恢复仅向**新建空卷**解包可信且校验通过的备份（容器以 root 解包保留 UID 1000），再将 Compose 的数据卷指向新卷并验收；不要覆盖运行中或已有数据的卷。`pnpm test:docker` 实际执行独立卷恢复并验证旧会话和 API Key。

## 本地验收与 CI

```sh
docker compose build
pnpm test:docker
```

脚本创建独立临时卷与容器，验证先设置站点再创建管理员、健康探针、登录及 API Key、前端扩展、非 root/只读运行、跨容器互斥、重启持久化、SIGKILL 后恢复和优雅退出，结束后清理测试容器与卷，不调用外部模型。报告为 `output/docker-smoke.json`。可通过 `PLUHUB_DOCKER` 指定 CLI，通过 `PLUHUB_DOCKER_IMAGE` 指定待验镜像。

还验证离线备份、独立卷恢复与域名/Cookie 切换；排空期间 `/readyz` 返回 503，存量请求继续完成。镜像探针仍不代表外部支付、邮件或真实上游健康。测试默认镜像为 `pluhub:local`。

恢复后停机运行 `docker compose run --rm -T gateway verify-data`，检查配置、插件依赖图、所有 SQLite 的 `quick_check` 及 Linux 数据文件权限。命令拒绝符号链接，不修复损坏数据；SQLite 和密钥文件应为 0600。Docker 验收包含独立卷恢复后的这项检查。镜像制备只复制 `RELEASE_LOCK.json` 列出的当前公共包，避免混入旧产物。

主仓 Linux CI 已加入镜像构建和该验收；远端执行仍需提交代码后触发。本地已在 WSL2 Docker Engine 验证，不代表已完成生产服务器、TLS 或负载验收。
