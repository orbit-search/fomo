/** Real SSE framing, truncation and tool fragment contracts. */
import { describe, it, expect } from 'vitest';
import { OpenRouter, sseData } from '../server/providers/openrouter.ts';
import { fixture, completion } from './helpers.ts';
function stream(parts: string[]) {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const p of parts) c.enqueue(new TextEncoder().encode(p));
      c.close();
    },
  });
}
describe('OpenRouter stream', () => {
  it('reads split CRLF lines, comments, and multiline data', async () => {
    const data = [];
    for await (const x of sseData(
      stream([': ping\r\ndata: {"a":', '1}\r\ndata: next\r\n\r\ndata: [DONE]\n\n']),
    ))
      data.push(x);
    expect(data).toEqual(['{"a":1}\nnext', '[DONE]']);
  });
  it('assembles tool arguments across chunks and preserves routing and usage', async () => {
    const f = fixture();
    try {
      let sent: Record<string, unknown> = {};
      const payloads = [
        {
          model: 'actual/model',
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: 'abc', function: { name: 'tool_', arguments: '{"q":' } },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { name: 'discover', arguments: '"tools"}' } }],
              },
              finish_reason: 'tool_calls',
            },
          ],
        },
        { choices: [], usage: { cost: 0.003, total_tokens: 20 } },
      ];
      const router = new OpenRouter(f.config, async (_url, init) => {
        sent = JSON.parse(String(init?.body));
        return new Response(
          stream(payloads.map((x) => `data: ${JSON.stringify(x)}\n\n`).concat('data: [DONE]\n\n')),
        );
      });
      const routes: string[] = [];
      const r = await router.complete(
        [{ role: 'user', content: 'test' }],
        [],
        ['a/model', 'b/model'],
        f.context.signal,
        () => {},
        (m) => routes.push(m),
      );
      expect(r.message.tool_calls?.[0]).toMatchObject({
        id: 'abc',
        function: { name: 'tool_discover', arguments: '{"q":"tools"}' },
      });
      expect(sent.models).toEqual(['a/model', 'b/model']);
      expect(sent).not.toHaveProperty('api_key');
      expect(routes).toEqual(['actual/model']);
      expect(r.usage.cost).toBe(0.003);
    } finally {
      f.close();
    }
  });
  it('rejects a truncated model stream', async () => {
    const f = fixture();
    try {
      const router = new OpenRouter(
        f.config,
        async () =>
          new Response(stream(['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'])),
      );
      await expect(
        router.complete(
          [],
          [],
          f.config.models,
          f.context.signal,
          () => {},
          () => {},
        ),
      ).rejects.toThrow('before the response finished');
    } finally {
      f.close();
    }
  });
  it('treats a length stop as incomplete', async () => {
    const f = fixture();
    try {
      const router = new OpenRouter(
        f.config,
        async () =>
          new Response(
            stream([
              'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}\n\n',
            ]),
          ),
      );
      await expect(
        router.complete(
          [],
          [],
          f.config.models,
          f.context.signal,
          () => {},
          () => {},
        ),
      ).rejects.toThrow('length');
    } finally {
      f.close();
    }
  });
  it('redacts provider keys in streamed text', async () => {
    const f = fixture();
    try {
      const router = new OpenRouter(f.config, async () => completion('crawl-secret'));
      const deltas: string[] = [];
      const r = await router.complete(
        [],
        [],
        f.config.models,
        f.context.signal,
        (t) => deltas.push(t),
        () => {},
      );
      expect(r.message.content).toBe('[redacted]');
      expect(deltas).toEqual(['[redacted]']);
    } finally {
      f.close();
    }
  });
  it('stops on provider auth errors without retry', async () => {
    const f = fixture();
    try {
      let calls = 0;
      const router = new OpenRouter(f.config, async () => {
        calls++;
        return new Response('sensitive', { status: 401 });
      });
      await expect(
        router.complete(
          [],
          [],
          f.config.models,
          f.context.signal,
          () => {},
          () => {},
        ),
      ).rejects.toThrow('API key');
      expect(calls).toBe(1);
    } finally {
      f.close();
    }
  });
});
