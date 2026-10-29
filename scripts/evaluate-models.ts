/** Opt-in model compatibility: a real tool-call round trip per configured route, with no fallback masking. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { config } from '../server/config.ts';
import { OpenRouter } from '../server/providers/openrouter.ts';
import { ProviderError } from '../server/http.ts';
import type { Message, ToolDefinition } from '../shared/types.ts';
if (process.env.FOMO_LIVE_MODELS !== '1')
  throw new Error('Opt in with FOMO_LIVE_MODELS=1; this uses your configured model API.');
const settings = config();
const router = new OpenRouter(settings);
const tools: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'echo',
      description: 'Return the supplied text exactly.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
    },
  },
];
const results: {
  model: string;
  passed: boolean;
  durationMs: number;
  actualModels?: string[];
  toolCalls?: number;
  error?: string;
}[] = [];
for (const model of settings.models) {
  console.log(`Model round trip: ${model}`);
  const start = Date.now();
  const actualModels: string[] = [];
  try {
    const signal = AbortSignal.timeout(120000);
    const messages: Message[] = [
      {
        role: 'system',
        content:
          'Call echo exactly once with text fomo-model-proof. After receiving the tool result, reply with exactly FOMO_MODEL_OK. Do not call another tool.',
      },
      { role: 'user', content: 'Run the echo verification.' },
    ];
    const first = await router.complete(
      messages,
      tools,
      [model],
      signal,
      () => {},
      (m) => actualModels.push(m),
    );
    assert.equal(first.model, model, 'The requested model must handle its own verification.');
    assert.equal(first.message.tool_calls?.length, 1, 'Expected exactly one tool call.');
    const call = first.message.tool_calls![0];
    assert.equal(call.function.name, 'echo');
    assert.deepEqual(JSON.parse(call.function.arguments), { text: 'fomo-model-proof' });
    messages.push(first.message, {
      role: 'tool',
      tool_call_id: call.id,
      content: JSON.stringify({ text: 'fomo-model-proof' }),
    });
    const second = await router.complete(
      messages,
      tools,
      [model],
      signal,
      () => {},
      (m) => actualModels.push(m),
    );
    assert.equal(second.model, model);
    assert.equal(second.message.content?.trim(), 'FOMO_MODEL_OK');
    assert.ok(!second.message.tool_calls?.length);
    results.push({
      model,
      passed: true,
      durationMs: Date.now() - start,
      actualModels,
      toolCalls: 1,
    });
  } catch (error) {
    results.push({
      model,
      passed: false,
      durationMs: Date.now() - start,
      actualModels,
      error:
        error instanceof ProviderError
          ? error.message
          : error instanceof Error
            ? error.message.slice(0, 300)
            : 'Verification failed',
    });
  }
}
let revision = 'uncommitted';
let dirty = true;
try {
  revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  dirty = Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim());
} catch {
  /* New source may not have its first commit. */
}
await mkdir('.fomo/quality', { recursive: true, mode: 0o700 });
const report = {
  revision,
  dirty,
  at: new Date().toISOString(),
  suite: 'models',
  status: 'completed',
  passed: results.every((r) => r.passed),
  results,
};
await writeFile('.fomo/quality/models-latest.json', JSON.stringify(report, null, 2) + '\n', {
  mode: 0o600,
});
console.log(
  `Model round trips: ${results.filter((r) => r.passed).length}/${results.length} passed.`,
);
if (!report.passed) process.exitCode = 1;
