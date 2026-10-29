/** Exercise the whole agent loop, including exact-call approvals, cancellation, and restart recovery. */
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Agent } from '../server/agent.ts';
import { createApp } from '../server/app.ts';
import { config } from '../server/config.ts';
import { fixture, json, completion } from './helpers.ts';
async function until(test: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (test()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('Fixture did not reach expected state.');
}
describe('Agent runtime', () => {
  it('streams a model answer and persists it across reads', async () => {
    const f = fixture();
    try {
      const a = new Agent(f.config, f.store, async () => completion('A real fixture answer.'));
      a.start(f.session.id, 'hello', randomUUID(), f.config.models);
      await until(() => !a.active.size);
      expect(f.store.events(f.session.id).map((e) => e.kind)).toEqual([
        'user',
        'route',
        'delta',
        'usage',
        'answer',
        'done',
      ]);
      expect(f.store.messages(f.session.id).at(-1)?.content).toBe('A real fixture answer.');
      expect(f.store.get(f.session.id)?.status).toBe('idle');
    } finally {
      f.close();
    }
  });
  it('deduplicates an uncertain client submission and enforces one active turn', async () => {
    const f = fixture();
    try {
      const a = new Agent(
        f.config,
        f.store,
        async (_url, init) =>
          new Promise((_, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
              once: true,
            });
          }),
      );
      const clientId = randomUUID();
      const first = a.start(f.session.id, 'test', clientId, f.config.models);
      expect(a.start(f.session.id, 'test', clientId, f.config.models)).toBe(first);
      expect(() => a.start(f.session.id, 'new', randomUUID(), f.config.models)).toThrow(
        'already working',
      );
      await until(() => a.active.size > 0);
      await a.stop(f.session.id);
      expect(f.store.events(f.session.id).filter((e) => e.kind === 'user')).toHaveLength(1);
    } finally {
      f.close();
    }
  });
  it('waits for exact session-scoped approval and denial never reaches provider', async () => {
    const f = fixture();
    try {
      let completions = 0;
      let runs = 0;
      const a = new Agent(f.config, f.store, async (url) => {
        if (String(url).includes('chat/completions')) {
          completions++;
          return completions === 1
            ? completion('', {
                name: 'tool_run',
                input: { provider: 'vendor', endpoint: '/lookup', input: { body: { q: 'one' } } },
              })
            : completion('The call was declined.');
        }
        runs++;
        return json({ runId: 'a', status: 'COMPLETED' });
      });
      f.store.operationSet(f.session.id, 'monid:inspect:vendor:/lookup', 'inspected', {
        provider: 'vendor',
        endpoint: '/lookup',
        input: { body: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } },
        price: { amount: 0.01 },
      });
      a.start(f.session.id, 'Run lookup', randomUUID(), f.config.models);
      await until(() => a.pending.size === 1);
      const approval = f.store.approvals(f.session.id)[0];
      expect(f.store.get(f.session.id)?.status).toBe('approval');
      expect(a.approve('wrong-session', approval.id, true)).toBe(false);
      expect(a.approve(f.session.id, approval.id, false)).toBe(true);
      await until(() => !a.active.size);
      expect(runs).toBe(0);
      expect(
        f.store.events(f.session.id).find((e) => e.kind === 'tool_end')?.data.result,
      ).toMatchObject({ error: 'denied' });
    } finally {
      f.close();
    }
  });
  it('cancels while awaiting approval, resolves all model tool calls, and allows a next turn', async () => {
    const f = fixture();
    try {
      let calls = 0;
      const a = new Agent(f.config, f.store, async () =>
        ++calls === 1
          ? completion('', { name: 'browser_act', input: { action: 'click', selector: '#submit' } })
          : completion('Ready for a fresh request.'),
      );
      a.start(f.session.id, 'click', randomUUID(), f.config.models);
      await until(() => a.pending.size === 1);
      await a.stop(f.session.id);
      expect(a.pending.size).toBe(0);
      expect(f.store.approvals(f.session.id)[0].status).toBe('denied');
      const history = f.store.messages(f.session.id);
      expect(history.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call-1' });
      a.start(f.session.id, 'continue', randomUUID(), f.config.models);
      await until(() => !a.active.size);
      expect(f.store.events(f.session.id).at(-1)?.data.status).toBe('completed');
    } finally {
      f.close();
    }
  });
  it('marks interrupted sessions and repairs open tool messages without replay', () => {
    const f = fixture();
    try {
      f.store.status(f.session.id, 'running');
      f.store.message(f.session.id, {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'lost', type: 'function', function: { name: 'tool_run', arguments: '{}' } },
        ],
      });
      f.store.operationSet(f.session.id, 'paid', 'submitted', { at: 'now' });
      f.store.recover();
      expect(f.store.get(f.session.id)?.status).toBe('idle');
      expect(f.store.messages(f.session.id).at(-1)).toMatchObject({
        role: 'tool',
        tool_call_id: 'lost',
      });
      expect(f.store.operation(f.session.id, 'paid')?.status).toBe('submitted');
      expect(f.store.events(f.session.id).at(-1)?.data.status).toBe('interrupted');
    } finally {
      f.close();
    }
  });
});
describe('API access boundary', () => {
  it('rejects cross-site and rebinding hosts before any provider can execute', async () => {
    const f = fixture();
    try {
      const app = createApp(f.config, f.store, new Agent(f.config, f.store));
      for (const headers of [
        { host: 'evil.test:4330' },
        { host: '127.0.0.1:4330', origin: 'https://evil.test' },
        { host: '127.0.0.1:4330', 'sec-fetch-site': 'cross-site' },
      ]) {
        const r = await app.request('http://127.0.0.1:4330/api/sessions', {
          headers: Object.fromEntries(
            Object.entries(headers).filter(
              (entry): entry is [string, string] => typeof entry[1] === 'string',
            ),
          ),
        });
        expect(r.status).toBe(403);
      }
    } finally {
      f.close();
    }
  });
  it('does not expose keys and supports private operator cookies', async () => {
    const f = fixture();
    try {
      f.config.operatorToken = 'x'.repeat(40);
      const app = createApp(f.config, f.store, new Agent(f.config, f.store));
      const headers = { host: '127.0.0.1:4330', 'content-type': 'application/json' };
      expect((await app.request('http://127.0.0.1:4330/api/status', { headers })).status).toBe(401);
      const login = await app.request('http://127.0.0.1:4330/api/login', {
        method: 'POST',
        headers,
        body: JSON.stringify({ token: f.config.operatorToken }),
      });
      expect(login.status).toBe(200);
      expect(login.headers.get('set-cookie')).toContain('HttpOnly');
      const r = await app.request('http://127.0.0.1:4330/api/status', {
        headers: { ...headers, cookie: login.headers.get('set-cookie')!.split(';')[0] },
      });
      expect(r.status).toBe(200);
      expect(await r.text()).not.toContain('secret');
    } finally {
      f.close();
    }
  });
  it('rejects unconfigured model selection and malformed input', async () => {
    const f = fixture();
    try {
      const app = createApp(f.config, f.store, new Agent(f.config, f.store));
      const headers = { host: '127.0.0.1:4330', 'content-type': 'application/json' };
      const r = await app.request(`http://127.0.0.1:4330/api/sessions/${f.session.id}/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ text: 'hi', clientId: randomUUID(), model: 'unconfigured/model' }),
      });
      expect(r.status).toBe(400);
      expect(f.store.events(f.session.id)).toHaveLength(0);
    } finally {
      f.close();
    }
  });
  it('requires a production operator token and restricts fixture endpoint overrides', () => {
    expect(() => config({ NODE_ENV: 'production' })).toThrow('Production requires');
    expect(() => config({ FOMO_TEST_MONID_ORIGIN: 'https://evil.test' })).toThrow(
      'Fixture origins',
    );
  });
});
