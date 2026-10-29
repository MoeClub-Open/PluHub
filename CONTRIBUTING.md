# 开发与贡献

## 仓库与环境

将相关仓库放在同级目录；Docker 构建不需要 Go SDK 仓库，完整开发与集成检查需要四个仓库。

| 仓库                                                             | 内容                                    |
| ---------------------------------------------------------------- | --------------------------------------- |
| [PluHub](https://github.com/MoeClub-Open/PluHub)                 | 宿主、CLI、TypeScript/UI SDK 和集成检查 |
| [PluHub-Spec](https://github.com/MoeClub-Open/PluHub-Spec)       | 公共类型、配置 Schema 和协议样例        |
| [PluHub-Plugins](https://github.com/MoeClub-Open/PluHub-Plugins) | 官方插件及仓内共享实现                  |
| [PluHub-SDK-Go](https://github.com/MoeClub-Open/PluHub-SDK-Go)   | Go 进程插件 SDK 和示例                  |

| 工具    | 版本    | 用途                       |
| ------- | ------- | -------------------------- |
| Bun     | 1.4.3   | 运行宿主、CLI 和插件       |
| Node.js | 24.22.0 | 源码构建                   |
| pnpm    | 10.20.0 | 安装依赖和执行工作区命令   |
| Go      | 1.27.0  | 开发 Go 插件、完整集成检查 |

正式运行平台为 Linux x64。目录和源码归属见 [工程结构](docs/STRUCTURE.md)。

## 源码运行

在主仓执行，命令会依次安装和构建 Spec、宿主及官方插件：

```sh
pnpm bootstrap
pnpm build:all
bun apps/cli/dist/index.js init
bun apps/cli/dist/index.js start
```

访问 <http://127.0.0.1:8080>，按网页完成首次设置。`init --port 9000` 可修改端口，CLI 的 `--config /path/pluhub.json` 可选择配置文件；配置中的相对路径以配置文件目录为基准。`validate` 只校验配置和依赖，不启动服务。

## 本地演示

完成构建后运行 `pnpm demo`，访问 <http://127.0.0.1:18181>，使用终端输出的管理员密码。演示使用本地模拟上游，不调用真实服务商。

演示数据位于 `.pluhub/product-demo`，与正式配置隔离；每次启动重置演示路由和管理员密码，保留演示数据库。

## 开发插件

在主仓创建独立插件目录：

```sh
bun apps/cli/dist/index.js create-plugin ../hello-plugin --id example.hello
pnpm -C ../hello-plugin install
pnpm -C ../hello-plugin build
bun apps/cli/dist/index.js plugin install ../hello-plugin --grant api.register
```

CLI 安装需停止宿主，再启动加载插件。模板使用公开 SDK，包含后端 API 和可卸载的前端模块；接口、权限与生命周期见 [插件 API](docs/PLUGIN_API.md)。Go 示例位于 `PluHub-SDK-Go/examples/echo`。

插件间通过公开能力接口协作，不导入其他插件或宿主私有源码。新增模块的职责依据 [插件架构](docs/PLUGIN_ARCHITECTURE.md)；前端复用要求见 [组件约定](docs/UI_COMPONENTS.md)。

## 检查与发布

根据改动选择相关检查，纯文档修改核对链接、示例和格式即可。跨仓及发布检查由 [持续集成](docs/CICD.md) 统一执行。

| 命令                                                    | 用途                      |
| ------------------------------------------------------- | ------------------------- |
| `pnpm build:all`                                        | 构建 Spec、宿主和官方插件 |
| `pnpm typecheck`、`pnpm -C ../PluHub-Plugins typecheck` | 宿主及插件类型检查        |
| `pnpm format:check`                                     | 源码格式检查              |
| `pnpm test:all`                                         | 跨仓测试，包含 Go SDK     |
| `node scripts/check-boundaries.mjs`                     | 检查公开包和插件依赖边界  |
| `pnpm -C ../PluHub-Spec check:compat`                   | 检查契约兼容性            |
| `pnpm bench`                                            | 生成本地性能记录          |

`pnpm pack:all` 生成公开包；`bun scripts/verify-routing-packages.ts` 和 `node scripts/verify-identity-packages.mjs` 检查打包后安装。`pnpm test:docker` 检查容器初始化和持久化。真实模型、邮件或支付的调用须单独按 [联调说明](docs/LIVE_TESTING.md) 确定范围和预算。

文档介绍当前行为和可复用操作；详细规则在所属专题维护，其他页面链接引用。现场发布记录、截图和开发过程保存在仓库外或忽略的输出目录，凭据和运行数据不提交。
