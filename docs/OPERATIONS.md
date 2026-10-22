# 单机部署与运维

## slc 候选实例

2026-10-19 部署于 slc 的 `/root/pluhub`。Compose 项目为 `pluhub`，服务为 `gateway`，监听 `0.0.0.0:18100`（容器内 8080）。主入口为 `https://apihub.telecom.moe`，HTTP 域名由边缘跳转到 HTTPS；Listener Origin 与 Auth Secure Cookie 已同步。该实例 `.env` 显式设置 `PLUHUB_BIND_ADDRESS=0.0.0.0` 和 `COMPOSE_PROJECT_NAME=pluhub`，保留原数据卷；同机 OpenResty 仍可反代 `127.0.0.1:18100`，公网直连端口按用户要求保留。浏览器登录与管理写入使用所配置的 HTTPS 域名。

公开首页、首次站点配置及内容编辑见 [门户说明](PORTAL.md)。全新安装先保存站点与门户，再创建管理员；已有管理员的线上实例直接跳过 OOBE，旧版未完成标记不会重新打开向导。未自动发布测试公告或政策正文。

`compose.yaml` 来自 `deploy/compose.production.yaml`，`.env` 固定已测试镜像标签；只读、非 root、日志轮转、1 GiB 内存限制与自动重启已配置。数据卷为 `pluhub_pluhub-data`。源码构建、验收记录及镜像版本留在 `releases/<版本>/`，初始全卷备份留在 `backups/`。首次管理员用户名为 `admin`，随机密码在服务器 `admin-initial.txt` 中，文件权限 0600；交付副本保存在本地忽略目录 `.pluhub/deploy-slc/`，不写入文档或镜像。

```sh
cd /root/pluhub
docker compose -p pluhub ps
docker compose -p pluhub logs --tail 100 gateway
curl --fail http://127.0.0.1:18100/readyz
```

## 接入 HTTPS

1. 配置域名与证书，反代 `http://127.0.0.1:18100`。参考 `nginx.conf.example`，关闭 SSE 缓冲并保留 WebSocket Upgrade。
2. 停机运行 `docker compose -p pluhub run --rm gateway set-public-origin https://实际域名`，再启动；完整命令见 [Docker 部署](DOCKER.md)。`.env` 同步维护该 Origin 作为后续重建的说明，已有配置以数据卷为准。
3. 根据真实代理来源配置最小 `trustedProxies`（并重启），再验收客户端 IP 配额。未配置时会按代理连接来源共享配额。
4. 通过域名检查 Cookie Secure/HttpOnly/SameSite、登录、管理 API 的 CSRF、Key 权限、资产加载、SSE 首事件/结束/取消、四种入口转换，以及适配器回调路径。真实支付、邮件和订阅授权需各自的有效配置。

`scripts/verify-deployed.mjs` 可复用已部署账号进行控制面检查，通过环境变量指定 `PLUHUB_DEPLOY_URL`、`PLUHUB_ADMIN_PASSWORD_FILE`。TLS 域名场景不设置 `PLUHUB_EXPECTED_ORIGIN` 覆盖值。脚本只创建并撤销自己的临时 Key/会话，不修改业务配置，不发送邮件、支付或模型生成。测试报告为 `output/deployed-smoke.json`。

使用反向代理时，Listener 的 `trustedProxies` 应只列出经过实测的直接代理地址和必要的上级代理网段，不能信任所有公网或整个 Docker 网段。Cloudflare 场景使用官方 `https://www.cloudflare.com/ips-v4` 与 `/ips-v6`，校验 CIDR 后显式配置，并随官方范围变更维护。应分别通过 HTTPS 域名和公网端口测试伪造的 `X-Forwarded-For`、`x-pluhub-peer`，核对安全历史和限流来源；健康检查通过不能证明来源判断正确。

## 备份、恢复和升级

按需加密备份使用 `python3 -B deploy/backup.py create-offline`，独立恢复检查使用 `check`；每日维护窗口由 `deploy/backup-schedule.py configure` 设置，可调整时间、时区和窗口。命令、恢复记录和密钥要求见 [Docker 部署](DOCKER.md)。备份包含原数据卷、部署配置、容器配置环境与实际镜像 ID，不会把凭证输出到终端。全新安装不自动开启周期停机任务或异地上传。

完整数据备份命令与独占锁规则见 [Docker 部署](DOCKER.md)。备份前停机、保存匹配的镜像 ID，并另行安全备份 `.env`；恢复至新建空卷验证后再切换。不要对运行中 SQLite 或已有卷直接覆盖解包。

升级先在独立卷验收候选镜像，再停止服务并备份，切换 `.env` 的 `PLUHUB_IMAGE` 后 `docker compose -p pluhub up -d --no-build`。失败时停止新版本，将数据和镜像同时恢复到匹配的版本。不能只回退镜像而假定数据库 Schema 可逆。已有支付账本和未结算记录须在恢复前核对。

故障初查：容器重启次数/退出码、健康状态、磁盘余量、内存、最近结构化错误、上游连接与配置权限。`readyz` 只判断本地认证/路由是否可接收请求，不能用它替代外部服务可用性或付款对账。

系统状态页显示数据目录所在文件系统的可用容量和总容量，不返回真实路径。可用空间不足 1 GiB 或低于总容量的 10% 时提示检查，并将宿主管理状态标为 `degraded`；无法读取容量也会提示，不将其显示为零或正常。该状态不会直接停用业务或代替网关 readiness。

反复构建和发布时，应保留线上镜像、匹配的回滚镜像及备份，定期清理不再使用的本项目镜像标签；不能使用会影响其他应用或数据卷的全局清理命令。清理前核对容器引用、受保护版本及对应源码归档，清理后检查实际可用空间和线上健康。

远程源码包使用 `python scripts/create-deploy-bundle.py` 生成，排除依赖、构建输出、运行数据、密钥和本地环境文件。SSH 使用部署者提供的连接工具；不得将舰队凭据复制进本项目。
