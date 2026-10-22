# 上游调用与协议转换验收

本地回归覆盖四种入口与四种上游的 64 个 JSON/SSE、文本/工具组合，并增加 32 次工具结果回传，核对跨协议调用 ID 和工具名称。取消、超时、流中断、错误、用量、授权隔离和不支持字段由其他集成测试覆盖。

真实上游验证独立于常规测试，不在 CI 中自动消费付费额度：

```sh
export PLUHUB_LIVE_KEY='<授权测试密钥>'
export PLUHUB_LIVE_URL='https://你的兼容网关'
export PLUHUB_LIVE_MODEL='<明确选择的模型>'
pnpm test:live
unset PLUHUB_LIVE_KEY
```

默认最多 16 次生成调用，每次输出预算 512 Token，另查询一次模型目录。`PLUHUB_LIVE_CALLS` 可设为 1–16，`PLUHUB_LIVE_TOKENS` 可设为 32–1024。缩减预算只代表完成相应子集，不代表完整矩阵通过。

脚本在临时数据目录创建用户与 API Key，再通过真实网关入口调用；测试结束后销毁临时凭据和数据。验证范围：

- 四种客户端入口 → Chat Completions 上游：普通和流式共 8 次。
- Chat/Responses 两种入口 → Responses 上游：普通和流式共 4 次。
- Chat 的普通与流式工具往返：共 4 次；工具结果由测试客户端提供。

除了 HTTP 状态，还检查有效回答标识、结束状态、用量及工具结果是否进入最终回答。报告 `output/live-gateway.json` 不保存密钥、完整提示词或回答正文；没有自动换模型和扩大预算的重试。

2026-10-19，使用用户授权的 New API 网关与 `gpt-6-luna` 完成上述 16 次调用，全部通过。它证明该网关下两种 OpenAI 上游及四类客户端入口的当前组合；不代表直接验证了 Anthropic/Google 官方服务、全部模型或订阅账号。此前 DeepSeek/Qwen 的部分联调失败仍保留在 `output/live-newapi.json`，不由这次成功覆盖。

流式取消、异常网络与极端 Chunk 切分主要通过确定性的本地服务验证，不人为扩大真实上游消耗。生产并发、长时间稳定性、计费对账与其他提供商仍应在各自环境验收。
