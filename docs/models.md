# Models

Verified against provider release announcements and OpenRouter’s live catalog on **October 28, 2026**. Model availability changes; check the catalog and your account’s access before changing routes.

## Default route

| Priority | Model | OpenRouter ID | Released |
| --- | --- | --- | --- |
| Primary | GPT‑6.1 Terra | `openai/gpt-6.1-terra` | October 26, 2026 |
| Fallback | Claude Sonnet 5.5 | `anthropic/claude-sonnet-5.5` | September 28, 2026 |

Terra is the newest GPT‑6.1 release, aimed at fast, efficient agentic work, visual reasoning, and computer use. Sonnet 5.5 is the latest Sonnet release, suited to well-scoped coding, research, and professional work. Both publish tool-calling support in OpenRouter’s catalog. These choices balance current capabilities and routine agent cost; they are not claims that one model wins every task.

For more demanding work, `openai/gpt-6.1-sol` and `anthropic/claude-opus-5.5` are current higher-capability alternatives. Add a preferred model to `FOMO_MODELS` to expose it in the selector. The first entry is the primary route, and the remaining entries are ordered fallbacks. FOMO records the model that actually answered.

```dotenv
FOMO_MODELS=openai/gpt-6.1-terra,anthropic/claude-sonnet-5.5
```

The runtime default, `.env.example`, and README use the same route. Existing private environment files override the default; update `FOMO_MODELS` there and restart the server when migrating an instance.

## Verification

Use `FOMO_LIVE_MODELS=1 pnpm eval:models` to verify each configured model individually. This uses the model API: each model must emit a tool call, accept its tool result, and produce the expected final answer. Models are tested without fallbacks so a successful substitute cannot hide an unavailable route. Private reports are written under `.fomo/quality/`.

## Sources

- [OpenAI: introducing GPT‑6.1 Terra](https://openai.com/index/introducing-gpt-6-1-terra/)
- [Anthropic: introducing Claude Sonnet 5.5](https://www.anthropic.com/claude-sonnet-5-5)
- [OpenRouter live model catalog](https://openrouter.ai/api/v1/models)
- [GPT‑6.1 Terra on OpenRouter](https://openrouter.ai/openai/gpt-6.1-terra)
- [Claude Sonnet 5.5 on OpenRouter](https://openrouter.ai/anthropic/claude-sonnet-5.5)
- [GPT‑6.1 Sol on OpenRouter](https://openrouter.ai/openai/gpt-6.1-sol)
- [Claude Opus 5.5 on OpenRouter](https://openrouter.ai/anthropic/claude-opus-5.5)
