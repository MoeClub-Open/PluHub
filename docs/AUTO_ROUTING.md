# 自动路由与单请求 TPS

使用前按需启用 `official.auto-router` 和 `official.token-speed`。自动路由节点编辑共享策略，输出 TPS 节点编辑渠道速度；跨渠道的默认速度与自定义分词器在「模型服务 → 全局限制」编辑。新请求使用新配置，在途请求保留原快照。

## 调用链与模式

客户端公开模型 → 用户身份与 Key 范围检查 → 决策器 → 真实渠道与模型 → 准入、余额预留 → 上游调用 → 单请求 Token 节拍 → 客户端协议编码 → 用量结算与日志。

在渠道图中添加「自动路由」节点并选择策略，节点通过 `ai.auto-routing@1` 请求选型；它不配置生成服务的地址或密钥。候选引用已配置的公开模型，从渠道图解析实际提供商、目标模型、价格和支持档位。候选须到达真实上游，不能再次进入自动选型。流程入口及节点连接规则见 [渠道流程图](WORKFLOWS.md)。

| mode     | 行为                                                                       |
| -------- | -------------------------------------------------------------------------- |
| `model`  | 按任务难度选模型，保留客户端思考设置；未指定时使用候选默认值或服务商默认值 |
| `effort` | 固定候选，只按难度调整思考档位；失败保底也不切换模型                       |
| `both`   | 同时选择模型与思考档位                                                     |
| `manual` | 固定模型与思考档位，不调用决策器                                           |

`preserveClientEffort` 默认 true，客户端显式 effort 优先；不支持该档位的候选会被过滤。需要完全由策略控制时设为 false。数值 thinking budget 仅在 `model` 模式原样保留并检查协议可表达性；自动 effort 模式不会静默吞掉客户端预算。

强度是管理员可动态修改的 0–100 策略评分，不是公开榜单成绩。难度默认为 easy/standard/hard/expert，对应最低强度 20/45/70/95 和 effort low/medium/high/max。思考档位根据候选显式支持列表向上选择，最高不足时取其最高支持档。不能把服务商不支持的档位勾选为支持。

`balanced` 选择满足强度要求的最弱候选，`cost` 在满足强度的候选中比较输入/输出估算成本，`quality` 优先最高强度。成本估算中的输入采用保守字节计数，仅用于排序，不是账单 Token 数。没有候选达到强度时选最强可用候选，日志记 `strength_ceiling`。上下文按请求字节数加输出预算保守过滤，可能拒绝本来能容纳的任务。

## 配置策略

先在渠道内配置可直接调用的 `physical/fast` 和 `physical/strong` 两个公开模型及价格。然后在自动路由节点中创建 `smart` 策略；以下是 `official.auto-router` 的 `config`：

```json
{
  "profiles": {
    "smart": {
      "mode": "both",
      "strategy": "balanced",
      "decision": { "kind": "rules" },
      "minConfidence": 0.65,
      "onFailure": "fallback",
      "fallbackCandidate": "strong",
      "fallbackEffort": "high",
      "candidates": [
        { "id": "fast", "target": "physical/fast", "strength": 30, "reasoningEfforts": ["low", "medium"] },
        { "id": "strong", "target": "physical/strong", "strength": 95, "reasoningEfforts": ["low", "medium", "high"] }
      ]
    }
  }
}
```

为自动选型渠道配置下列流程，并在「提供模型」发布 `auto/smart`：

```json
{
  "entry": "start",
  "nodes": [
    { "id": "start", "type": "start", "next": ["choose"] },
    { "id": "choose", "type": "routing", "profile": "smart" }
  ]
}
```

客户端使用网关 Key 请求 `auto/smart`，原始模型授权按该公开名检查；计费和上游限制使用最终执行模型，入口渠道与使用分组范围仍生效。需要限速时，在实际执行路径添加「输出 TPS」节点，见 [单请求 TPS 语义](#单请求-tps-语义)。

## 决策模型与原生接口

远程决策使用对应的原生接口：

| kind        | 参考模型                              | 接口                                                            | 资料                                                                              |
| ----------- | ------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `luna`      | `gpt-6-luna`                          | `POST /v1/decisions`，`input` + `questions[]`                   | [OpenAI Decisions](https://developers.openai.com/api/docs/guides/decisions)       |
| `systemone` | `Cloudflare/clef`，兼容 Jev/SystemOne | `POST /v1/systemone`，`state` + `questions.difficulty.criteria` | [Clef 模型卡](https://huggingface.co/Cloudflare/clef)                             |
| `jev`       | `autotrust/JEV-27B` 自部署            | `POST /v1/decide`，`kind/state/question/options`，不发送 model  | [JEV 模型卡](https://huggingface.co/autotrust/JEV-27B)                            |
| `rules`     | 本地规则                              | 无远程请求                                                      | 使用长度、工具和任务特征估难度；confidence=1 只表示规则成功，不是校准后的模型概率 |

例如把策略 `decision` 改为：

```json
{ "kind": "luna", "model": "decision-model", "channelId": "decision-channel", "timeoutMs": 3000, "maxInputChars": 16000 }
```

先将决策服务配置为对应协议的渠道，填写凭据、公开模型名和价格，再在策略中选择该模型。旧配置中直接填写的服务地址和凭据需要迁移到渠道。Clef 使用部署的 SystemOne 服务，JEV 使用运行 `serve_decide.py` 的服务；这些服务需要自行部署或开通。

概率分布、选项和 confidence 会严格检查。超时、无效响应、输入超出决策长度或低置信度，按 `onFailure` 使用保底候选或拒绝；请求取消直接退出。保底模型仍须通过上下文、协议和 BYOK 过滤。远程决策有独立的每用户自然分钟配额 `decisionRpm`（默认 60）与全局并发 `decisionConcurrency`（默认 8），超限返回 429。远程决策会向配置的服务发送任务正文；决策调用按其模型价格单独预留、结算并记录，与回答模型的调用分别计费。

流程图中的「Jev 请求」节点也使用单独配置的模型和价格，配置方法及费用说明见 [渠道流程图](WORKFLOWS.md#配置-jev)。

思考参数按协议映射：Chat 的 `reasoning_effort`、Responses 的 `reasoning.effort`、Anthropic 的 `output_config.effort`、Gemini 的 `generationConfig.thinkingConfig`。不支持的预算、档位或冲突设置明确拒绝。服务商内部 thinking/thought 文本不作为最终回答输出；用量仍包含可获得的隐藏思考 Token。各模型支持的档位以服务商说明为准：[OpenAI](https://developers.openai.com/api/docs/guides/reasoning)、[Claude](https://platform.claude.com/docs/en/build-with-claude/effort)、[Gemini](https://ai.google.dev/gemini-api/docs/thinking)。

## 单请求 TPS 语义

渠道图的「输出 TPS」节点设置单请求速度，可选同渠道模型总速度；未匹配节点规则时使用全局可选 `default`。`token-speed` 默认无规则，不限速。Rate Limit 负责请求数、Token、并发和字节带宽，两者不共用计数。

计数使用显式 tokenizer：内置 `o200k_base`、`cl100k_base`，或管理员提供 Hugging Face 文件：

```json
{
  "default": { "tps": 30, "tokenizer": "my-model" },
  "tokenizers": {
    "my-model": { "kind": "huggingface", "tokenizerPath": "/srv/tokenizers/model/tokenizer.json", "configPath": "/srv/tokenizers/model/tokenizer_config.json" }
  },
  "quantumTokens": 1,
  "maxTrackedChars": 65536
}
```

文件必须存在，每个不超过 32 MiB；相对路径基于插件数据目录。未指定或无法加载的 tokenizer 拒绝生效，不自动下载。必须选择和实际模型对应的 tokenizer，内置编码不能代表全部供应商模型。

文本、可见思考和工具参数在 Unicode 码点边界分片，按完整字段前缀重新分词，采用 Token 计数高水位，BPE 合并不会退还已等待的节拍，所以可能比服务商计数更保守。工具名称按完整字段发出并提前等待其 Token 成本，避免破坏协议起始帧；部分协议本身缓冲工具结果，交付仍受其原子字段限制。单个字符可能占多个 Token，会先等待完整成本再输出。用量和完成帧直接传递，不按上游报告的隐藏思考或其他未交付 Token 补等，避免响应内容已结束却迟迟不结束工具回合。

这限制的是网关向客户端交付速度，不能控制远程模型内部生成速度。非流式响应会等待后整体交付；它不能变成逐 Token 的网络输出。上游报告的完整用量仍用于计费和调用记录的输出 TPS（输出 Token / 请求总耗时），包括隐藏思考 Token；该统计值与交付限速的计数范围不同。默认每请求跟踪 65536 个 UTF-16 字符，超出明确终止，不退化成按字节计费；管理员可调高，但重分词成本也会增加。取消或停用插件会停止等待并清理资源。

## 验证范围

`pnpm demo` 的 `auto/smart` 使用本地模拟上游，默认不启用输出限速。构建、打包及相关检查入口见 [贡献指南](../CONTRIBUTING.md#检查与发布)。

本地检查覆盖原生决策格式、选型模式、准入、计价、分词和取消；不能据此判断远程决策模型的准确率、延迟或费用。真实服务按 [联调说明](LIVE_TESTING.md) 单独验证。
