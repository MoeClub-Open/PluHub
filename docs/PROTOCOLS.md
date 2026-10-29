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

会话协议转换暂不支持音频、视频、文件、图片输出、除 OpenAI 内置网页搜索外的服务商托管工具、持久 Responses、previous_response_id、后台 Responses、多候选或任意供应商附加字段。Gemini responseSchema 使用其专用 Schema 方言，当前要求 responseJsonSchema，避免不完整转换。Gemini 可见文本上的签名暂不支持；思考块和函数调用签名已支持。不支持的请求字段或目标组合明确拒绝，函数工具由客户端执行。Schema 名称是 OpenAI 的元数据；转换到不具名的 Anthropic/Gemini 时保留 Schema 与严格约束，不能表达的 description 或 relaxed 模式拒绝。

Responses 是请求级无状态调用，上游请求设置 store: false，支持 include: ["reasoning.encrypted_content"]。call_id 用于工具往返，输出 item.id 独立保留。增量与 done/completed 快照合并时检查前缀一致性，避免重复文本和工具参数；最后快照的加密思考内容也会保留。

思考签名、加密块和 redacted 块记录来源。跨协议响应使用带版本的 PluHub envelope 保留来源数据；续轮经其他入口返回原提供商时可还原。原生客户端必须保留签名/扩展字段；删除这些字段无法恢复。签名不会作为其他提供商的有效签名发送，路由到不兼容目标时明确拒绝。为等待最终签名，Anthropic 思考内容按块缓冲，Responses 思考摘要缓冲至最终响应。工具 thoughtSignature 可经 Chat 的 extra_content、Responses 的 extra_content 和 Gemini 往返；Anthropic 无对应字段，明确拒绝。

SSE 使用严格 UTF-8 增量解码，兼容 LF/CRLF/CR、多行 data 与任意 Chunk 切分；缺少空行的 EOF 尾事件不提交。单事件最多 1 MiB 字符，单个工具参数最多 1 MiB，聚合结果最多 16 MiB 字符，请求体和非流式上游响应最多 16 MiB 字节；Raw 透传不解析正文。Anthropic 内容块顺序启停，Responses 输出单调序号和完整 item 生命周期，Gemini 结束帧不重复内容。截断、非法参数与转换错误输出失败事件，不发送成功终止，不自动重试。取消/超时释放上游 reader 和连接；转换失败同步标记观测失败，计费按有效用量或预扣金额直接结算。

用量以原提供商为准：缓存命中/写入属于输入用量的子集，思考属于输出用量的子集，转换中避免重复累加。定价与资金结算由计费插件负责。

架构与边界参考 [AxonHub](https://github.com/looplj/axonhub) 的 llm 统一模型和 transformer 模块（研究基线 8d3c3865dc642307cabe0950e241d2c231c08f42）；PluHub 保持独立的 TypeScript 实现，入口和上游继续独立注册，转换仍可作为渠道流程图的条件能力组合。

OpenAI 实现参考：

- https://developers.openai.com/api/docs/guides/migrate-to-responses
- https://developers.openai.com/api/reference/resources/responses/streaming-events
- https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events

New API 已完成四类入口到 Chat 上游、Chat/Responses 入口到 Responses 上游，以及普通/流式工具往返的 16 次真实生成验证。具体模型、预算、报告和未覆盖范围见 [联调说明](LIVE_TESTING.md)。本地矩阵与该网关实测不代表全部供应商接口兼容认证。

## 内置网页搜索

Responses 入口支持 `web_search`、`web_search_preview` 与 `web_search_preview_2025_03_11`，可与函数工具一起声明。搜索配置、指定搜索工具的 `tool_choice`、`include: ["web_search_call.action.sources"]` 发送到 Responses/Codex 上游。上游是否允许搜索取决于模型与账号授权，网关不模拟工具执行。

Chat 入口接受 `web_search_options`，也可接收上述搜索工具声明并转换到 Responses/Codex。原生 Chat 上游仅传递 `search_context_size`、`user_location`，需要支持搜索的模型；指定搜索工具、源列表或其他 Responses 搜索控制不能转换时明确拒绝。当前没有实现 Anthropic/Gemini 原生搜索及其跨协议转换。

搜索活动是服务端工具事件，不转成待客户端执行的函数调用。普通响应保留 `web_search_call` 和 URL 引用；SSE 保留搜索状态、完成快照与引用事件。增量、结束项和最终完整快照按调用 ID / 引用去重；多个文本部分的引用偏移映射到客户端聚合正文。Responses 多轮输入可包含搜索调用项及带 URL 引用的 assistant 消息。Chat 返回标准 `annotations`，搜索活动放在 `extra_content.web_search_calls`，可重新作为对话历史接入 Responses。Playground 将 URL 引用渲染为可点击链接。

工具分支将搜索视为有工具请求，自动路由排除不支持相应控制或接口的候选。调用元数据只记录搜索次数，不记录查询词和检索正文。模型价格可配置 `pricing.webSearch`（USD / 次）；按已完成的搜索调用 ID 去重结算，计入价格、用量及账单快照，并应用渠道倍率。未配置时不追加搜索费。Responses API 的 `max_tool_calls` 原样传递；Codex CLI 当前不接受该参数，网关在资金预留及上游调用前明确拒绝，需省略该参数或选择 Responses API 上游；预留使用该上限，未指定时按 3 次估算。原生 Chat 无法报告工具次数，配置独立搜索费时要求改用 Responses 上游。

参考：[OpenAI Web search](https://developers.openai.com/api/docs/guides/tools-web-search)、[Responses streaming events](https://developers.openai.com/api/reference/resources/responses/streaming-events)。

## 图片、视频、向量与音频

`official.ingress-openai-media` 和 `official.upstream-openai-media` 独立安装与启停；新站点预装但默认停用。媒体上游复用 OpenAI Chat / Responses 连接的凭证、认证及公网上游策略。Codex 图片通过其订阅插件声明的 `ai.media.codex@1` 调用；Claude 与 Antigravity 当前不提供媒体生成端点。

| 入口                            | 请求                                   | 响应                                   |
| ------------------------------- | -------------------------------------- | -------------------------------------- |
| `POST /v1/embeddings`           | 文本、文本批次、Token 数组             | JSON 向量 / base64、输入 Token 用量    |
| `POST /v1/images/generations`   | JSON                                   | JSON 图片或图片 SSE                    |
| `POST /v1/images/edits`         | JSON 图片引用或 multipart 文件、遮罩   | JSON 图片或图片 SSE                    |
| `POST /v1/videos/generations`   | JSON 或 multipart 提示词、可选参考图片 | 完成后的视频二进制或含结果 URL 的 JSON |
| `POST /v1/audio/speech`         | JSON 文本与音色                        | 音频二进制流或 `stream_format: "sse"`  |
| `POST /v1/audio/transcriptions` | multipart 音频文件                     | JSON、文本、字幕或转写 SSE             |
| `POST /v1/audio/translations`   | multipart 音频文件                     | JSON、文本或字幕                       |

模型配置 `operations` 选择允许的端点，例如 `["images/generations", "images/edits"]` 或 `["videos/generations"]`。省略时只允许 `chat`（四类会话协议）。Playground 按模式分别显示对话、图片和视频模型；音频和向量仍通过对应 API 调用。公开及个人目录保留各自模型端点和渠道价格，媒体模型的接入示例使用对应接口。个人模型仍按所属用户隔离，API Key 的渠道及模型限制同样生效。

渠道流程继续提供渠道/模型选择、重定向、请求限流与 OpenAI 协议准入。媒体请求不能执行文本提示词、思考强度、输出 Token 上限、TPS 或任务分类节点，防止配置静默失效。高级接口组合的 `mediaPaths` 按操作名配置相对路径，例如 `{ "embeddings": "/v1/vector" }`，不会误用会话的 `path`。

媒体请求体最多 32 MiB，JSON 响应及单个媒体 SSE 事件最多 64 MiB；Listener 的请求体上限也需满足实际上传大小。重复文件和表单字段保持顺序，模型选择字段不得重复。音频采用拉取和背压，取消会中断上游连接；SSE 必须出现对应完成事件。中断、错误和取消不记为成功调用，已经派发的请求仍按 [结算规则](PRICING.md#取消中断与重启结算) 收费。请求日志保留操作、状态、耗时及可核实用量，不保存图片、音频、提示词或搜索正文。

Embeddings 以提供商输入 Token 计费。图片和音频使用明确的按次价格或固定金额表达式，不把媒体 Token 当作普通文本 Token，也不根据文件体积猜测音频时长；上游提供的 Token 总量仍可记录。平台计费启用时，媒体未配置固定价格会在调用前拒绝；个人上游成本与平台请求手续费按 [个人渠道规则](PERSONAL_CHANNELS.md#原价与消耗倍率) 分开处理。

### Codex 图片

Codex 模型映射可声明 `images/generations`、`images/edits`；目标模型使用实际图片模型，例如 `gpt-image-2.5-sunburst`。订阅适配器复用现有账号租约、刷新和冷却，将图片请求转换为 Responses 的 `image_generation` 工具。顶层调用默认使用 `gpt-6.1-sol`，可用请求参数 `response_model` 指定账号支持的主模型；如果路由目标本身是文本模型，则以该模型为主模型，并可用 `image_model` 指定图片模型。每次生成一张图片，常用尺寸、画质、背景与输出格式传给工具。

只有收到完整的 `response.completed` 和图片数据才完成结算；同一图片在增量与最终快照中去重。工具开始后不自动重放，取消或截断也会结算，缺少有效用量时按预扣金额扣费。该适配不代表所有 Codex 订阅账号均获得官方图片工具权限，实际开放情况以上游响应为准；平台图片模型应配置明确的按次价格或固定金额表达式，不沿用文本 Token 价格。

### 视频完成式调用

`POST /v1/videos/generations` 是网关的完成式接口，和异步 `POST /v1/videos` 的返回语义不同。上游默认调用 `/v1/videos`；高级接口的 `mediaPaths["videos/generations"]` 可覆盖该路径。兼容上游可直接返回视频或结果 URL，也可返回 `id` 与 `queued` / `in_progress` 等状态；适配器查询同一路径下的 `/{id}`，直到 `completed`，再获取 `/{id}/content`。查询和下载使用同一上游与凭证，不接受任意远端查询地址。

任务创建、状态查询和下载属于同一次网关执行，只预留和结算一次。任务已接受后的失败、取消或查询异常不会按「尚未生成」自动退款。连接保持至完成，不提供跨刷新恢复任务的接口；反向代理的等待超时应满足提供商的生成耗时。原生 Sora API 已于 2026-09-24 退役，因此不内置可用 Sora 预设，也不将 Codex 订阅视为视频授权；需要管理员配置仍在服务的兼容视频上游。

图片变体、Realtime、Files 和通用 Responses `image_generation` 工具透传尚未接入。媒体端点不提供 Gemini / Anthropic 媒体协议转换；提供商自身是否支持模型、格式和参数，以其接口响应为准。

参考：[Images](https://developers.openai.com/api/reference/resources/images)、[Image generation tool](https://developers.openai.com/api/docs/guides/tools-image-generation)、[Video API 与退役说明](https://developers.openai.com/api/docs/deprecations)、[Embeddings](https://developers.openai.com/api/reference/resources/embeddings/methods/create)、[Speech](https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create)、[Transcriptions](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create)。
