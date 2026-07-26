# LiveKit Node.js LLM provider catalog

Research date: 2026-07-26. Scope: pipeline LLMs for the Node.js LiveKit Agents
SDK, not STT, TTS, or speech-to-speech realtime models. The source audit is
pinned to `livekit/agents-js` commit
[`c92d739`](https://github.com/livekit/agents-js/commit/c92d739b7d1deefb412255df4f83a993405fe747)
from 2026-07-25.

## Recommendation

DeepInfra is not the only realistic path. The best next benchmark order for
Abita is:

1. **LiveKit Inference `google/gemma-4-31b-it`**. LiveKit calls it the
   recommended default for voice agents and says the deployment is tuned for
   low latency. It supports function-tool selection and parallel-tool control,
   with reasoning disabled by default. This is the cleanest way to test whether
   moving inference beside LiveKit removes provider-route latency.
   [LiveKit-hosted model guide][livekit-llm] LiveKit's own production-shaped
   benchmark reported 192 ms TTFT, 354 ms time to first speech, and 88% task
   completion on 100 simulated conversations with roughly 40 tools. Treat those
   provider-reported numbers as a strong reason to test, not as Acuity proof.
   [LiveKit Gemma benchmark][livekit-gemma-benchmark]
2. **Cerebras through `@livekit/agents-plugin-cerebras`**. It is the strongest
   direct-provider latency candidate in the current Node catalog: LiveKit's
   dedicated plugin adds gzip and MessagePack request optimization specifically
   to reduce TTFT for large prompts, and Cerebras documents automatic prefix
   caching on supported requests. Select the model only after confirming its
   current function-calling contract. [Cerebras plugin][cerebras-livekit]
   [Cerebras prompt caching][cerebras-cache]
3. **Gemini 2.5 Flash-Lite or Flash**, first through LiveKit Inference, then
   directly through `@livekit/agents-plugin-google` if tier, thinking, or cache
   control is important. LiveKit documents function tools for the managed
   models; the direct Node plugin supports `thinkingBudget: 0` for Gemini 2.5
   Flash. Google documents implicit caching for Gemini 2.5 and newer.
   [Gemini guide][gemini-livekit] [Gemini caching][gemini-cache]
4. **OpenAI `gpt-4.1-mini` as the tool-reliability control**, through either
   LiveKit Inference or the direct Responses plugin. The current Node plugin
   streams text and tool calls and reports cached-token usage. This is a control
   candidate, not a claim that it will win TTFT. [OpenAI guide][openai-livekit]
5. **LiveKit Inference `openai/gpt-oss-120b` pinned to `groq`** as a routing
   experiment. LiveKit exposes both `baseten` and `groq` backends for the same
   model, which makes it useful for separating model behavior from serving
   provider behavior. [OpenAI routing table][openai-livekit]

This is a benchmark order, not a winner. Plugin support proves transport and
schema compatibility; it does not prove low tail latency, correct tool
sequencing, or safe mutation behavior for a particular model.

Gemma is also the cleanest regulated-workload candidate in this list. LiveKit
Inference is zero data retention by default, LiveKit lists `google/*` LLMs as
HIPAA eligible when the customer has a LiveKit BAA, and the current rate is
$0.40 per million input tokens, $0.20 cached input, and $1.20 output. Confirm
that the production project is covered by the executed BAA before sending PHI.
[LiveKit HIPAA eligibility][livekit-hipaa] [LiveKit pricing][livekit-pricing]

## Managed LiveKit Inference

Node uses `new inference.LLM({ model, provider?, modelOptions? })` from
`@livekit/agents`; no provider plugin or provider API key is required. The
adapter requests a streaming response, serializes function tools, and parses
streamed tool calls. [Inference docs][inference-models]
[Node source][inference-source]

| Family | Active model IDs | Documented backend provider(s) | Function tools | Cache contract at this boundary |
|---|---|---|---|---|
| Hosted by LiveKit | `google/gemma-4-31b-it` | LiveKit-hosted; no backend ID is listed | Yes: `tool_choice`, `parallel_tool_calls` | None documented |
| DeepSeek | `deepseek-ai/deepseek-v4-pro` | `baseten` | Yes: `tool_choice` | None documented |
| Gemini | `google/gemini-2.5-flash`, `google/gemini-2.5-flash-lite`, `google/gemini-2.5-pro`, `google/gemini-3-flash-preview`, `google/gemini-3.1-flash-lite`, `google/gemini-3.1-pro-preview`, `google/gemini-3.5-flash`, `google/gemini-3.5-flash-lite`, `google/gemini-3.6-flash` | `google` | Yes: `tool_choice` | No LiveKit cache parameter documented; Google upstream implicit caching is not a LiveKit Inference guarantee |
| Kimi | `moonshotai/kimi-k2.5`, `moonshotai/kimi-k2.6` | `baseten` | Not documented on the family page | `prompt_cache_key` is documented |
| OpenAI | `openai/chat-latest`; GPT-4.1, GPT-4o, GPT-5, GPT-5.1, GPT-5.2, GPT-5.4, GPT-5.5 families; `openai/gpt-5.6-{luna,sol,terra}`; `openai/gpt-oss-120b` | `azure` and/or `openai` for most OpenAI models; `baseten` and `groq` for GPT OSS 120B | Yes: `tool_choice`, `parallel_tool_calls` | No LiveKit cache parameter documented; OpenAI upstream caching is not a LiveKit Inference guarantee |
| xAI | `xai/grok-4-1-fast-{non-reasoning,reasoning}`, `xai/grok-4.20-0309-{non-reasoning,reasoning}`, `xai/grok-4.20-multi-agent-0309`, `xai/grok-4.3`, `xai/grok-4.5` | `xai` | Yes: `tool_choice`, `parallel_tool_calls` | None documented |

The model IDs and providers above come from LiveKit's current aggregate and
family-specific tables. Retired IDs are excluded. [Inference models][inference-models]
[DeepSeek table][deepseek-livekit] [Gemini table][gemini-livekit]
[Kimi table][kimi-livekit] [OpenAI table][openai-livekit]
[xAI table][xai-livekit]

Routing is explicit:

- Set `provider` to pin a documented backend.
- Omit it and LiveKit selects the best available backend and bills for that
  route.
- `updateOptions()` can swap the model or persistent options for the next
  request without rebuilding the LLM.

Do not assume an arbitrary `modelOptions` field took effect. LiveKit says
unsupported parameters are silently ignored, and model support varies.
[Inference parameters][inference-params]

LiveKit also documents zero data retention by default for prompts and model
outputs sent through LiveKit Inference. That is a data-handling property, not
proof of a BAA or of application-level HIPAA controls. [Inference ZDR][inference-models]

## Direct Node.js LLM plugins

All rows below have an incremental `LLMStream` path. “Tools” means LiveKit
function-tool serialization and streamed tool-call parsing, not provider-hosted
web search or code execution.

| Provider | Node package / construction | Tools | Prompt caching | Endpoint and routing |
|---|---|---|---|---|
| Anthropic | `@livekit/agents-plugin-anthropic` | Yes; `toolChoice` and parallel-call control | Anthropic supports top-level `cache_control`; the LiveKit Node constructor does not document a named cache option, although per-chat extra kwargs and cache-usage accounting exist in source | Direct Claude Messages API; custom `baseURL` or client; no router |
| Baseten | `@livekit/agents-plugin-baseten` | Yes through the OpenAI-compatible transport | Model/deployment dependent; no plugin-wide guarantee | Model name selects a Baseten Model API deployment; exported LLM targets Baseten |
| Cerebras | `@livekit/agents-plugin-cerebras` | Yes; inherited from the OpenAI transport | Automatic on supported requests; no cache marker required | Direct Cerebras; custom `baseURL` or client |
| Google Gemini / Vertex AI | `@livekit/agents-plugin-google` | Yes; function tools and Gemini provider tools | Google implicit caching is automatic for 2.5+; current Node source also contains `cachedContent`, but the public guide still labels explicit cache attachment Python-only | Direct Gemini Developer API or Vertex AI; service tier and region/project options, not a multi-provider router |
| Mistral AI | `@livekit/agents-plugin-mistralai` | Yes; native Conversations streaming | Mistral documents `prompt_cache_key` for Chat Completions; the LiveKit Conversations plugin does not document a cache option, so cache use through this adapter is unverified | Direct Mistral client; no simple `baseURL` option |
| OpenAI | `@livekit/agents-plugin-openai`; prefer `openai.responses.LLM` for direct OpenAI | Yes; Chat Completions and Responses; Responses also supports OpenAI provider tools | OpenAI caching is automatic on eligible prompts; the plugin reports cached tokens | Direct OpenAI, Azure helper, arbitrary OpenAI-compatible `baseURL`, or injected client |
| Perplexity | `@livekit/agents-plugin-perplexity` | Adapter plumbing exists; confirm capability for the selected Sonar model | No cache contract found in the LiveKit/provider sources reviewed | Direct Perplexity Chat Completions or Responses; custom `baseURL`; no router |

Primary LiveKit evidence:

- Anthropic's Node guide and source explicitly support streaming and function
  tools. [Anthropic guide][anthropic-livekit] [Anthropic source][anthropic-source]
- The Baseten Node package exists in current `agents-js`, but this repository
  does not depend on it; the current runtime uses LiveKit Inference through
  `inference.LLM`. LiveKit's public model guide still labels Baseten
  Python-only, so treat the upstream Node package as documentation/stability
  drift rather than a current repository integration. [Baseten
  source][baseten-source] [Baseten guide][baseten-livekit]
- Cerebras inherits the OpenAI stream/tool adapter and adds compressed request
  payloads. [Cerebras source][cerebras-source]
- Google's native Node stream handles function calls, Gemini/Vertex routing,
  thinking configuration, and cache usage. [Google source][google-source]
- The Mistral plugin uses native Conversations streaming and serializes
  function tools. The older `@livekit/agents-plugin-mistral` package is a
  deprecated compatibility wrapper; use `...-mistralai`.
  [Mistral source][mistral-source] [Mistral wrapper][mistral-wrapper]
- OpenAI offers streaming Chat Completions, Responses, and Responses-over-WebSocket
  implementations. [OpenAI source][openai-source] [OpenAI Responses source][openai-responses-source]

### OpenAI-compatible Node integrations

These use `@livekit/agents-plugin-openai`, not separate LLM packages:

- Documented current helpers: Azure OpenAI, DeepSeek, Fireworks, Groq, Meta,
  OVHcloud, Perplexity, Telnyx, Together AI, and xAI.
- Current source also contains Cerebras and Ollama helpers. A dedicated Cerebras
  package is preferable when its payload optimization is desired.
- OpenRouter and any other compatible Chat Completions service can be supplied
  as `new openai.LLM({ model, apiKey, baseURL })`; LiveKit does not provide a
  Node-specific OpenRouter routing contract.
- A legacy `withOcto` helper remains in source but is absent from LiveKit's
  current documented matrix; it should not be selected for new work.

[OpenAI-compatible guide][openai-compatible]
[Factory source][openai-factories]

Two package-name traps:

- `@livekit/agents-plugin-xai` exports realtime/STT/TTS, not the pipeline LLM;
  use `openai.LLM.withXAI(...)` for a text LLM.
- `@livekit/agents-plugin-azure` is STT-only; Azure OpenAI LLM uses
  `openai.LLM.withAzure(...)`.

## Prompt-caching boundary

Prompt caching can reduce prefill time only when the integration reaches the
provider cache and the stable prefix remains identical. It does not reduce
output-token generation time.

| Route | What is confirmed |
|---|---|
| LiveKit Inference | Only use family-page parameters as contractual. Kimi lists `prompt_cache_key`; the other current family pages do not expose a cache control. Verify actual cached-token usage rather than assuming upstream provider behavior survives LiveKit routing. |
| Cerebras direct | Automatic prefix caching on supported requests; static system prompt and tool definitions should precede dynamic content. |
| Gemini direct | Implicit caching is enabled for Gemini 2.5+ above model-specific token minima. Explicit `cachedContent` is present in current Node source, despite stale public copy saying Python-only. |
| OpenAI direct | Eligible prompts are cached automatically; cached-token usage is surfaced by the Node plugin. |
| Anthropic direct | Provider caching requires `cache_control`; LiveKit does not document a first-class Node constructor option. |
| Mistral direct | Provider Chat Completions supports `prompt_cache_key`; support through LiveKit's native Conversations adapter is not documented. |
| Baseten / other OpenAI-compatible endpoints | Model and provider dependent. A field accepted by the generic adapter is not proof the backend used it. |

[Anthropic caching][anthropic-cache] [Mistral caching][mistral-cache]
[OpenAI caching][openai-cache]

## Fallback

Direct plugin instances are single-provider endpoints. Node's
`llm.FallbackAdapter` provides ordered in-process LLM failover. Its important
default is `retryOnChunkSent: false`: after text or a tool call has streamed,
the adapter raises rather than restarting on another provider. That guard helps
avoid duplicated speech and repeated tool attempts. Do not enable
`retryOnChunkSent` for mutation-capable scheduling turns without a stronger
idempotency/reconciliation design. [Fallback guide][fallback-guide]
[Fallback source][fallback-source]

The server-side LiveKit Inference fallback adapter supports STT and TTS only;
LLM fallback uses the in-process adapter. Provider selection inside a single
LiveKit Inference LLM is a separate managed routing feature.

For this scheduler, keep `parallelToolCalls: false` unless the exposed tools and
state owner explicitly permit parallel calls.

## Required benchmark before switching

Run the same production-shaped, PHI-free conversation against the first four
candidates:

- persistent client/session;
- current system prompt and exact tool schemas;
- reasoning disabled where the model supports it;
- `parallelToolCalls: false`;
- at least 20 interleaved runs per candidate;
- report first model event, first visible text, first tool call, completed
  caller-visible turn, cached tokens, duplicate tool calls, task correctness,
  p50/p95/max, and cost.

Select on completed-turn latency and correct tool/state transitions, not TTFT
alone.

[inference-models]: https://docs.livekit.io/agents/models/inference/
[inference-params]: https://docs.livekit.io/reference/agents/inference-llm-parameters/
[inference-source]: https://github.com/livekit/agents-js/blob/c92d739b7d1deefb412255df4f83a993405fe747/agents/src/inference/llm.ts#L289-L501
[livekit-llm]: https://docs.livekit.io/agents/models/llm/livekit/
[livekit-gemma-benchmark]: https://livekit.com/blog/latency-optimized-inference-gemma-4-on-livekit
[livekit-hipaa]: https://livekit.com/legal/hipaa
[livekit-pricing]: https://livekit.com/pricing/inference
[deepseek-livekit]: https://docs.livekit.io/agents/models/llm/deepseek/
[gemini-livekit]: https://docs.livekit.io/agents/models/llm/gemini/
[kimi-livekit]: https://docs.livekit.io/agents/models/llm/kimi/
[openai-livekit]: https://docs.livekit.io/agents/models/llm/openai/
[xai-livekit]: https://docs.livekit.io/agents/models/llm/xai/
[anthropic-livekit]: https://docs.livekit.io/agents/models/llm/anthropic/
[baseten-livekit]: https://docs.livekit.io/agents/models/llm/baseten/
[cerebras-livekit]: https://docs.livekit.io/agents/models/llm/cerebras/
[openai-compatible]: https://docs.livekit.io/agents/models/llm/openai-compatible-llms/
[fallback-guide]: https://docs.livekit.io/agents/logic/fallback-strategies/
[anthropic-source]: https://github.com/livekit/agents-js/blob/c92d739b7d1deefb412255df4f83a993405fe747/plugins/anthropic/src/llm.ts#L15-L50
[baseten-source]: https://github.com/livekit/agents-js/blob/c92d739b7d1deefb412255df4f83a993405fe747/plugins/baseten/src/llm.ts#L74-L195
[cerebras-source]: https://github.com/livekit/agents-js/blob/c92d739b7d1deefb412255df4f83a993405fe747/plugins/cerebras/src/llm.ts#L11-L90
[google-source]: https://github.com/livekit/agents-js/blob/c92d739b7d1deefb412255df4f83a993405fe747/plugins/google/src/llm.ts#L33-L90
[mistral-source]: https://github.com/livekit/agents-js/blob/c92d739b7d1deefb412255df4f83a993405fe747/plugins/mistralai/src/llm.ts#L118-L335
[mistral-wrapper]: https://github.com/livekit/agents-js/blob/c92d739b7d1deefb412255df4f83a993405fe747/plugins/mistral/src/index.ts
[openai-source]: https://github.com/livekit/agents-js/blob/c92d739b7d1deefb412255df4f83a993405fe747/plugins/openai/src/llm.ts#L22-L84
[openai-responses-source]: https://github.com/livekit/agents-js/blob/c92d739b7d1deefb412255df4f83a993405fe747/plugins/openai/src/responses/llm.ts#L190-L235
[openai-factories]: https://github.com/livekit/agents-js/blob/c92d739b7d1deefb412255df4f83a993405fe747/plugins/openai/src/llm.ts#L104-L473
[fallback-source]: https://github.com/livekit/agents-js/blob/c92d739b7d1deefb412255df4f83a993405fe747/agents/src/llm/fallback_adapter.ts#L40-L90
[cerebras-cache]: https://inference-docs.cerebras.ai/capabilities/prompt-caching
[gemini-cache]: https://ai.google.dev/gemini-api/docs/caching/
[anthropic-cache]: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
[mistral-cache]: https://docs.mistral.ai/studio-api/conversations/advanced/prompt-caching
[openai-cache]: https://developers.openai.com/api/docs/guides/latest-model
