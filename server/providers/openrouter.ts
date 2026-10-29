/** OpenRouter's OpenAI-compatible streaming loop, including fragmented parallel tool calls. */
import { z } from 'zod';
import type { Config, Message, ToolDefinition, ToolCall, RouteUsage } from '../../shared/types.ts';
import { ProviderError, redact } from '../http.ts';
const chunkSchema = z.object({
  error: z
    .object({ message: z.string().optional(), code: z.union([z.number(), z.string()]).optional() })
    .optional(),
  model: z.string().optional(),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
      total_tokens: z.number().optional(),
      cost: z.number().optional(),
    })
    .optional(),
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullable().optional(),
        delta: z.object({
          content: z.string().nullable().optional(),
          tool_calls: z
            .array(
              z.object({
                index: z.number().int().nonnegative().max(31),
                id: z.string().optional(),
                type: z.string().optional(),
                function: z
                  .object({ name: z.string().optional(), arguments: z.string().optional() })
                  .optional(),
              }),
            )
            .optional(),
        }),
      }),
    )
    .optional(),
});
export async function* sseData(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      total += value?.length ?? 0;
      if (buffer.length > 1_000_000 || total > 8_000_000)
        throw new ProviderError('too_large', 'Model stream exceeded its limit.');
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, '');
        buffer = buffer.slice(end + 1);
        if (!line) {
          if (data.length) {
            yield data.join('\n');
            data = [];
          }
        } else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (done) {
        if (buffer.startsWith('data:')) data.push(buffer.slice(5).trimStart());
        if (data.length) yield data.join('\n');
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
export class OpenRouter {
  constructor(
    readonly config: Config,
    readonly fetcher: typeof fetch = fetch,
  ) {}
  async complete(
    messages: Message[],
    tools: ToolDefinition[],
    models: string[],
    signal: AbortSignal,
    onDelta: (text: string) => void,
    onRoute: (model: string) => void,
  ) {
    const key = this.config.keys.openrouter;
    if (!key)
      throw new ProviderError('not_configured', 'Set OPENROUTER_API_KEY on the FOMO server.');
    let response: Response;
    try {
      response = await this.fetcher(this.config.origins.openrouter + '/api/v1/chat/completions', {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          'X-OpenRouter-Title': 'FOMO',
          'HTTP-Referer': 'http://localhost:4330',
          'X-OpenRouter-App-Visibility': 'private',
        },
        body: JSON.stringify({
          models,
          messages,
          tools: tools.length ? tools : undefined,
          provider: { require_parameters: true },
          max_tokens: 4096,
          stream: true,
          stream_options: { include_usage: true },
        }),
      });
    } catch {
      signal.throwIfAborted();
      throw new ProviderError('connection_failed', 'OpenRouter connection failed.');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new ProviderError(
        `http_${response.status}`,
        `OpenRouter returned HTTP ${response.status}. ${response.status === 402 ? 'Check available credits.' : response.status === 401 ? 'Check your API key.' : 'Check model availability and try again.'}`,
      );
    }
    if (!response.body)
      throw new ProviderError('invalid_response', 'OpenRouter returned an empty stream.');
    let content = '';
    let model = '';
    let usage: RouteUsage = {};
    let finished = false;
    const calls = new Map<number, ToolCall>();
    for await (const data of sseData(response.body)) {
      signal.throwIfAborted();
      if (data === '[DONE]') break;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        throw new ProviderError('invalid_response', 'OpenRouter returned an invalid stream event.');
      }
      const c = chunkSchema.parse(parsed);
      if (c.error)
        throw new ProviderError(
          'model_error',
          'OpenRouter could not complete this model response.',
        );
      if (c.model && c.model !== model) {
        model = c.model;
        onRoute(model);
      }
      if (c.usage) usage = { ...usage, ...c.usage };
      const choice = c.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) {
        if (!['stop', 'tool_calls'].includes(choice.finish_reason))
          throw new ProviderError(
            'incomplete',
            `Model response ended with ${choice.finish_reason}.`,
          );
        finished = true;
      }
      const delta = choice.delta;
      if (delta.content) {
        const text = redact(delta.content, this.config);
        content += text;
        onDelta(text);
      }
      for (const part of delta.tool_calls ?? []) {
        const call = calls.get(part.index) ?? {
          id: '',
          type: 'function',
          function: { name: '', arguments: '' },
        };
        if (part.id) call.id += part.id;
        if (part.function?.name) call.function.name += part.function.name;
        if (part.function?.arguments) call.function.arguments += part.function.arguments;
        if (call.function.arguments.length > 64_000)
          throw new ProviderError('too_large', 'Tool arguments are too large.');
        calls.set(part.index, call);
      }
    }
    if (!finished)
      throw new ProviderError(
        'interrupted_stream',
        'OpenRouter stream ended before the response finished.',
      );
    const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
    if (
      toolCalls.some((c) => !c.id || !c.function.name) ||
      new Set(toolCalls.map((c) => c.id)).size !== toolCalls.length
    )
      throw new ProviderError('invalid_response', 'OpenRouter returned incomplete tool calls.');
    if (!content && !toolCalls.length)
      throw new ProviderError(
        'empty_response',
        'The model returned no answer. Try another configured model.',
      );
    return {
      message: {
        role: 'assistant' as const,
        content: content || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
      model,
      usage,
    };
  }
}
