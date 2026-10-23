# AI 协议支持矩阵

入口适配器与上游适配器分别注册，支持的入口可绑定任一已安装的上游适配器。

| 协议                    | 入口                                                               | 上游                      |
| ----------------------- | ------------------------------------------------------------------ | ------------------------- |
| OpenAI Chat Completions | POST /v1/chat/completions                                          | /v1/chat/completions      |
| OpenAI Responses        | POST /v1/responses                                                 | /v1/responses             |
| Anthropic Messages      | POST /v1/messages                                                  | /v1/messages              |
| Gemini                  | POST /v1beta/models/:model:generateContent、:streamGenerateContent | 对应 GenerateContent 接口 |

GET /v1/models 列出密钥授权范围内的可用模型别名。所有生成入口要求用户认证。控制台模型目录另外展示本人 BYOAPI/BYOSUB 模型，公开目录仅展示平台模型。单个连接可在 `interfaces` 中组合多种入口与上游接口，按入口及模型匹配规则确定转换目标、路径与认证；配置方式与隔离边界见 [个人渠道](PERSONAL_CHANNELS.md#多接口组合)。

支持文本、图片输入、多轮消息、客户端函数工具定义/调用/结果、普通 JSON、SSE、思考内容/签名、拒答、安全过滤、结束原因与缓存/思考用量。基础 HTTP 矩阵为 4 个入口 × 4 个上游 × 普通/流式 × 无工具/有工具，共 64 个本地模拟组合，另有 32 次工具结果回传；扩展矩阵另以 32 次 HTTP 调用验证图片、JSON Schema 和思考内容。模型身份由重定向策略决定，见 [渠道工作流](WORKFLOWS.md)。

| 特性                                    | Chat      | Responses              | Anthropic            | Gemini                     |
| --------------------------------------- | --------- | ---------------------- | -------------------- | -------------------------- |
| 文本与图片输入                          | ✓         | ✓                      | ✓                    | ✓                          |
| 工具选择（auto/none/required/指定名称） | ✓         | ✓                      | ✓                    | ✓                          |
| 严格工具 Schema                         | strict    | strict                 | strict               | VALIDATED / ANY 全局模式   |
| 禁止并行工具                            | ✓         | ✓                      | ✓                    | 明确拒绝                   |
| JSON Schema 输出                        | ✓         | ✓                      | ✓                    | responseJsonSchema         |
| 无约束 JSON object                      | ✓         | ✓                      | 明确拒绝             | ✓                          |
| top_p / stop                            | ✓         | 仅 top_p               | ✓                    | ✓                          |
| 思考强度、预算和显示设置                | 仅 effort | effort/summary/include | effort/预算/adaptive | level/预算/includeThoughts |

图片支持 PNG/JPEG/GIF/WebP 的 base64 data URL，以及协议能够表达的 HTTP(S) 地址。Gemini 远程图片需要显式 MIME；跨协议无法表达 low/high 图片 detail 时拒绝。多模态工具结果仅 Anthropic 原协议支持，其余目标明确拒绝。Gemini 的纯文本/标量工具结果包装为 response.result 对象；有序内容块与工具结果保持原次序。

不支持音频、视频、文件、图片输出、服务商托管工具、持久 Responses、previous_response_id、后台 Responses、多候选或任意供应商附加字段。Gemini responseSchema 使用其专用 Schema 方言，当前要求 responseJsonSchema，避免不完整转换。Gemini 可见文本上的签名暂不支持；思考块和函数调用签名已支持。不支持的请求字段或目标组合明确拒绝，函数工具由客户端执行。Schema 名称是 OpenAI 的元数据；转换到不具名的 Anthropic/Gemini 时保留 Schema 与严格约束，不能表达的 description 或 relaxed 模式拒绝。

Responses 是请求级无状态调用，上游请求设置 store: false，支持 include: ["reasoning.encrypted_content"]。call_id 用于工具往返，输出 item.id 独立保留。增量与 done/completed 快照合并时检查前缀一致性，避免重复文本和工具参数；最后快照的加密思考内容也会保留。

思考签名、加密块和 redacted 块记录来源。跨协议响应使用带版本的 PluHub envelope 保留来源数据；续轮经其他入口返回原提供商时可还原。原生客户端必须保留签名/扩展字段；删除这些字段无法恢复。签名不会作为其他提供商的有效签名发送，路由到不兼容目标时明确拒绝。为等待最终签名，Anthropic 思考内容按块缓冲，Responses 思考摘要缓冲至最终响应。工具 thoughtSignature 可经 Chat 的 extra_content、Responses 的 extra_content 和 Gemini 往返；Anthropic 无对应字段，明确拒绝。

SSE 使用严格 UTF-8 增量解码，兼容 LF/CRLF/CR、多行 data 与任意 Chunk 切分；缺少空行的 EOF 尾事件不提交。单事件最多 1 MiB 字符，单个工具参数最多 1 MiB，聚合结果最多 16 MiB 字符，请求体和非流式上游响应最多 16 MiB 字节；Raw 透传不解析正文。Anthropic 内容块顺序启停，Responses 输出单调序号和完整 item 生命周期，Gemini 结束帧不重复内容。截断、非法参数与转换错误输出失败事件，不发送成功终止，不自动重试。取消/超时释放上游 reader 和连接；转换失败同步标记观测失败，计费转待核对。

用量以原提供商为准：缓存命中/写入属于输入用量的子集，思考属于输出用量的子集，转换中避免重复累加。定价与资金结算由计费插件负责。

架构与边界参考 [AxonHub](https://github.com/looplj/axonhub) 的 llm 统一模型和 transformer 模块（研究基线 8d3c3865dc642307cabe0950e241d2c231c08f42）；PluHub 保持独立的 TypeScript 实现，入口和上游继续独立注册，转换仍可作为渠道流程图的条件能力组合。

OpenAI 实现参考：

- https://developers.openai.com/api/docs/guides/migrate-to-responses
- https://developers.openai.com/api/reference/resources/responses/streaming-events
- https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events

New API 已完成四类入口到 Chat 上游、Chat/Responses 入口到 Responses 上游，以及普通/流式工具往返的 16 次真实生成验证。具体模型、预算、报告和未覆盖范围见 [联调说明](LIVE_TESTING.md)。本地矩阵与该网关实测不代表全部供应商接口兼容认证。
