# 工程结构

仓库获取、环境版本和构建命令见 [贡献指南](../CONTRIBUTING.md)。

## 源码目录

| 位置               | 内容                                                                    |
| ------------------ | ----------------------------------------------------------------------- |
| `PluHub/packages/` | Kernel、Runtime、Engine、Control、SDK、UI SDK、Frontend Host 和 Testkit |
| `PluHub/apps/cli/` | 命令行入口与新站插件预设                                                |
| `PluHub/tests/`    | 宿主及跨插件集成检查                                                    |
| `PluHub/scripts/`  | 工作区构建、打包、演示、迁移与联调工具                                  |
| `PluHub/deploy/`   | 容器入口、反向代理示例、备份与恢复工具                                  |
| `PluHub-Spec/`     | 公共类型、Schema、协议样例和兼容性基线                                  |
| `PluHub-SDK-Go/`   | Go 进程插件 SDK、协议检查和 echo 示例                                   |
| `PluHub-Plugins/`  | 官方插件、共享库、独立打包脚本和插件检查                                |

新站插件清单只在 `apps/cli/src/presets.ts` 维护，供初始化、演示和集成夹具复用。Dockerfile 与 Compose 通过独立构建上下文组合主仓、Spec 和 Plugins，不引入整个父目录。

## 官方插件

```text
PluHub-Plugins/
├── plugins/<name>/
│   ├── manifest.json / package.json
│   ├── index.ts                 # 后端入口
│   ├── ui.tsx                   # 可选前端入口
│   ├── ...                      # 插件内部模块
│   └── dist/                    # 分发产物
├── lib/
│   ├── ai/                      # 协议、流和入口/上游工厂
│   ├── commerce/                # 金额与支付工具
│   ├── subscriptions/           # 订阅账号公共实现
│   ├── identity/、admin/、mail/  # 身份、管理权限和邮件工具
│   ├── http/、export/、storage/ # 网络、导出和存储工具
│   └── ui/                      # 挂载、组件和复用表单
├── scripts/build.ts
└── tests/
```

仅一个插件使用的实现放在该插件目录；跨插件复用的纯工具和工厂放在 `lib/`。共享库不反向导入插件，插件之间不引用私有源码；业务协作使用公开能力接口，公共契约由 Spec 维护。

各插件的数据所有权、请求与资金链路见 [插件架构](PLUGIN_ARCHITECTURE.md)；能力、实现版本和安装锁见 [插件依赖](PLUGIN_DEPENDENCIES.md)。前端基础交互复用 Radix UI，图标使用 Lucide，详见 [组件约定](UI_COMPONENTS.md)。

## 构建与数据目录

| 位置                                   | 用途                                                |
| -------------------------------------- | --------------------------------------------------- |
| 主仓各包及 Spec 的 `dist/`             | 公开包编译产物                                      |
| `plugins/<name>/dist/`                 | esbuild 生成的插件前后端包；插件仓 `tsc` 仅检查类型 |
| `output/packages/`、`output/registry/` | 可安装归档和注册源目录                              |
| `output/` 下其他文件                   | 忽略的基准、联调和截图输出                          |
| `.pluhub/` 或配置指定的数据目录        | 配置、数据库、加密密钥和安装状态                    |

运行数据不是构建缓存，不能随产物一起清理。发布和恢复流程见 [持续集成](CICD.md) 与 [单节点运维](OPERATIONS.md)。
