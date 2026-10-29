/** Disposable fixture runtime; never reads developer credentials. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../server/config.ts';
import { Store } from '../server/store.ts';
export function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'fomo-test-'));
  const conf = config({
    NODE_ENV: 'test',
    FOMO_DATA_DIR: dir,
    OPENROUTER_API_KEY: 'router-secret',
    FIRECRAWL_API_KEY: 'crawl-secret',
    ORBIT_API_KEY: 'orbit-secret',
    MONID_API_KEY: 'monid-secret',
  });
  const store = new Store(dir);
  const session = store.create();
  return {
    config: conf,
    store,
    session,
    context: {
      sessionId: session.id,
      turnId: 'test-turn',
      callId: 'call-1',
      signal: new AbortController().signal,
    },
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
export function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
export function completion(text: string, tool?: { name: string; input: unknown; id?: string }) {
  const chunks = tool
    ? [
        {
          id: tool.id ?? 'call-1',
          type: 'function',
          index: 0,
          function: { name: tool.name, arguments: JSON.stringify(tool.input) },
        },
      ]
    : undefined;
  return new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({ model: 'fixture/model', choices: [{ delta: { content: text || undefined, tool_calls: chunks }, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17, cost: 0.001 } })}\n\ndata: [DONE]\n\n`,
          ),
        );
        c.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
