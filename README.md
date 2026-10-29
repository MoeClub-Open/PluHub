# PluHub

插件驱动的 AI 网关，提供统一模型 API、可视化渠道流程和用户控制台。

- 支持 OpenAI Chat Completions、Responses、Anthropic 和 Gemini 入口，以及图片、视频等模型接口。
- 在渠道流程中配置多个上游、模型映射、条件分支、自动选型和输出速度。
- 提供账号、API Key、个人渠道、在线试用和调用记录。
- 按需启用钱包计费、支付、订阅、邮件和人机验证等插件。

当前为 Alpha，正式运行目标为 Linux x64、Bun 1.4.3，默认使用单节点 SQLite。部署前请阅读 [适用范围](docs/IMPLEMENTATION.md) 和 [协议支持矩阵](docs/PROTOCOLS.md)。

## 快速开始

需要 Docker Engine、Buildx 和 Docker Compose 2.24+。三个源码仓库保持同级目录：

```sh
git clone https://github.com/MoeClub-Open/PluHub.git
git clone https://github.com/MoeClub-Open/PluHub-Spec.git
git clone https://github.com/MoeClub-Open/PluHub-Plugins.git
cd PluHub
cp .env.example .env
docker compose build
docker compose up -d
```

打开 <http://localhost:8080>，完成站点设置并创建管理员，再按 [网关使用指南](docs/GATEWAY.md) 配置渠道和模型。上游凭据在页面填写并加密保存。

HTTPS、数据卷和备份配置见 [Docker 部署](docs/DOCKER.md)；源码运行、本地演示和插件开发见 [贡献指南](CONTRIBUTING.md)。

## 文档

[文档目录](docs/README.md) 按使用、路由、运维和开发分类，包含配置说明、接口规则与架构参考。

## 许可证

[Apache-2.0](LICENSE)。
