# 自动路由与单请求 TPS

`official.auto-router`、`official.token-speed` 为独立运行插件，初始化配置和本地演示均包含。自动路由节点编辑共享策略，输出 TPS 节点编辑渠道速度；跨渠道的默认速度与自定义分词器在「模型服务 → 全局限制」编辑。新请求使用新配置，在途请求保留原快照。

## 调用链与模式

客户端公开模型 → 用户身份与 Key 范围检查 → 决策器 → 真实渠道与模型 → 准入、余额预留 → 上游调用 → 单请求 Token 节拍 → 客户端协议编码 → 用量结算与日志。

路由器注册为 `protocol: "auto-router"` 的虚拟提供商，无 `baseUrl` 或 `keyRef`。其模型映射中的 `model` 是策略 ID；内部候选引用「渠道与路由」已有的**公开模型别名**，从中解析真实渠道、服务商模型 ID、价格和支持档位。候选必须指向物理渠道，引用另一个自动路由时拒绝，避免循环。

| mode | 行为 |
| --- | --- |
| `model` | 按任务难度选模型，保留客户端思考设置；未指定时使用候选默认值或服务商默认值 |
| `effort` | 固定候选，只按难度调整思考档位；失败保底也不切换模型 |
| `both` | 同时选择模型与思考档位 |
| `manual` | 固定模型与思考档位，不调用决策器 |

`preserveClientEffort` 默认 true，客户端显式 effort 优先；不支持该档位的候选会被过滤。需要完全由策略控制时设为 false。数值 thinking budget 仅在 `model` 模式原样保留并检查协议可表达性；自动 effort 模式不会静默吞掉客户端预算。

强度是管理员可动态修改的 0–100 策略评分，不是公开榜单成绩。难度默认为 easy/standard/hard/expert，对应最低强度 20/45/70/95 和 effort low/medium/high/max。思考档位根据候选显式支持列表向上选择，最高不足时取其最高支持档。不能把服务商不支持的档位勾选为支持。

`balanced` 选择满足强度要求的最弱候选，`cost` 在满足强度的候选中比较输入/输出估算成本，`quality` 优先最高强度。成本估算中的输入采用保守字节计数，仅用于排序，不是账单 Token 数。没有候选达到强度时选最强可用候选，日志记 `strength_ceiling`。上下文按请求字节数加输出预算保守过滤，可能拒绝本来能容纳的任务。

## 完整组合示例

下面是三个插件的 `config` 字段示例。API Key 在配置页填写并加密保存，下方 `secret:PROVIDER_KEY` 应替换为实际保存的凭据编号。`fast-vendor`、`strong-vendor` 是占位模型 ID，需要改成服务商真实模型和支持档位。

```json
{
  "ai-router": {
    "upstreams": {
      "primary": { "protocol": "openai-chat", "baseUrl": "https://provider.example/v1", "keyRef": "secret:PROVIDER_KEY" },
      "smart-provider": { "protocol": "auto-router", "name": "智能提供商" }
    },
    "models": {
      "physical/fast": { "upstream": "primary", "model": "fast-vendor", "reasoningEfforts": ["low", "medium"], "inputPrice": 1, "outputPrice": 2 },
      "physical/strong": { "upstream": "primary", "model": "strong-vendor", "reasoningEfforts": ["low", "medium", "high"], "inputPrice": 3, "outputPrice": 10 },
      "auto/smart": { "upstream": "smart-provider", "model": "smart" }
    }
  },
  "auto-router": {
    "profiles": {
      "smart": {
        "mode": "both", "strategy": "balanced", "decision": { "kind": "rules" },
        "minConfidence": 0.65, "onFailure": "fallback", "fallbackCandidate": "strong", "fallbackEffort": "high",
        "candidates": [
          { "id": "fast", "target": "physical/fast", "strength": 30, "reasoningEfforts": ["low", "medium"] },
          { "id": "strong", "target": "physical/strong", "strength": 95, "reasoningEfforts": ["low", "medium", "high"] }
        ]
      }
    }
  },
  "token-speed": {
    "models": [{ "channel": "primary", "model": "strong-vendor", "tps": 30, "tokenizer": "o200k_base" }]
  }
}
```

客户端使用自己的网关 Key 请求 `model: "auto/smart"`。Key 范围检查使用这个逻辑模型；计费、TPS 与上游渠道限制使用最终物理模型。虚拟模型上填写的价格不覆盖真实模型价格。BYOK 凭证会按归属渠道过滤候选，再检查最终渠道；不会把客户端 Key 当作决策器或服务商凭证。自动路由应被视为一组管理员授权的模型，只有逻辑别名权限不等于允许直接调用内部模型别名。

## 决策模型与原生接口

已查阅以下资料并分别实现请求和响应格式，不使用通用 Chat Completion 猜测它们的接口：

| kind | 参考模型 | 接口 | 资料 |
| --- | --- | --- | --- |
| `luna` | `gpt-6-luna` | `POST /v1/decisions`，`input` + `questions[]` | [OpenAI Decisions](https://developers.openai.com/api/docs/guides/decisions) |
| `systemone` | `Cloudflare/clef`，兼容 Jev/SystemOne | `POST /v1/systemone`，`state` + `questions.difficulty.criteria` | [Clef 模型卡](https://huggingface.co/Cloudflare/clef) |
| `jev` | `autotrust/JEV-27B` 自部署 | `POST /v1/decide`，`kind/state/question/options`，不发送 model | [JEV 模型卡](https://huggingface.co/autotrust/JEV-27B) |
| `rules` | 本地规则 | 无远程请求 | 使用长度、工具和任务特征估难度；confidence=1 只表示规则成功，不是校准后的模型概率 |

例如把策略 `decision` 改为：

```json
{ "kind": "luna", "model": "decision-model", "channelId": "decision-channel", "timeoutMs": 3000, "maxInputChars": 16000 }
```

先将决策服务配置为对应协议的渠道，填写凭据、公开模型名和价格，再在策略中选择该模型。旧配置中直接填写的服务地址和凭据需要迁移到渠道。Clef 使用部署的 SystemOne 服务，JEV 使用运行 `serve_decide.py` 的服务；这些服务需要自行部署或开通。

概率分布、选项和 confidence 会严格检查。超时、无效响应、输入超出决策长度或低置信度，按 `onFailure` 使用保底候选或拒绝；请求取消直接退出。保底模型仍须通过上下文、协议和 BYOK 过滤。远程决策有独立的每用户自然分钟配额 `decisionRpm`（默认 60）与全局并发 `decisionConcurrency`（默认 8），超限返回 429。远程决策会向配置的服务发送任务正文；决策调用按其模型价格单独预留、结算并记录，与回答模型的调用分别计费。

流程图中的「Jev 请求」节点也使用单独配置的模型和价格，配置方法及费用说明见 [渠道流程图](WORKFLOWS.md#配置-jev)。

思考参数按协议映射：Chat 的 `reasoning_effort`、Responses 的 `reasoning.effort`、Anthropic 的 `output_config.effort`、Gemini 的 `generationConfig.thinkingConfig`。不支持的预算、档位或冲突设置明确拒绝。服务商内部 thinking/thought 文本不作为最终回答输出；用量仍包含可获得的隐藏思考 Token。各模型支持的档位以服务商说明为准：[OpenAI](https://developers.openai.com/api/docs/guides/reasoning)、[Claude](https://platform.claude.com/docs/en/build-with-claude/effort)、[Gemini](https://ai.google.dev/gemini-api/docs/thinking)。

## 单请求 TPS 语义

`token-speed` 默认无规则，不限速。每个请求独立计时，不与其他请求共享 TPS。规则按**真实渠道 ID + 服务商模型 ID**匹配，未匹配时使用可选 `default`。现有 `rate-limit` 插件继续处理 RPM/RPS/TPM、并发和字节带宽。

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

## 验证与复现

`pnpm build:all`、`pnpm test:all`、`node scripts/check-boundaries.mjs`。新增测试位于主仓 `tests/auto-routing.test.ts` 和 Plugins 仓 `tests/routing.test.ts`：原生决策格式、四种模式、动态强度、低置信度/截断/失败、取消、协议可表达性、Key 准入、最终模型计费、递归拒绝、实际分词、工具帧和 TPS 节拍。远程决策仅使用本地模拟响应验证，尚未用真实 Luna 账号或部署 JEV/Clef 权重做准确率、延迟和费用验证。

`pnpm pack:all` 后运行 `node scripts/verify-routing-packages.mjs`，会在临时目录安装打包后的网络、路由和限速插件，验证虚拟模型解析与分词器加载，不发送服务商请求，并在结束时清理目录。分发文件及 SHA-256 清单位于 `output/packages`。

`pnpm demo` 提供 `auto/smart`，只组合本地模拟上游。默认不启用 TPS，以便与原演示体验一致；在「模型 TPS」开启每请求限速后保存即可测试。页面截图位于 `output/playwright/auto-router.png` 和 `output/playwright/token-speed.png`。
