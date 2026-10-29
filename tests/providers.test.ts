/** Provider boundaries: composite Monid inputs, ownership, idempotency, and browser lifecycle. */
import { describe, it, expect, vi } from 'vitest';
import { Tools } from '../server/tools.ts';
import { Transport, publicUrl } from '../server/http.ts';
import { Firecrawl } from '../server/providers/firecrawl.ts';
import { Monid } from '../server/providers/monid.ts';
import { fixture, json } from './helpers.ts';
const inspected = {
  provider: 'vendor',
  endpoint: '/lookup',
  input: {
    queryParams: {
      type: 'object',
      properties: { q: { type: 'string' }, limit: { type: 'integer', maximum: 5 } },
      required: ['q'],
      additionalProperties: false,
    },
  },
  price: { amount: { value: 0.002, currency: 'USD' } },
};
describe('Monid', () => {
  it('requires inspection and validates composite input before asking approval', async () => {
    const f = fixture();
    try {
      const approve = vi.fn();
      const tools = new Tools(f.config, f.store, approve, async () => json(inspected));
      await expect(
        tools.execute(
          'tool_run',
          { provider: 'vendor', endpoint: '/lookup', input: { queryParams: { q: 'a' } } },
          f.context,
        ),
      ).rejects.toThrow('Inspect');
      await tools.execute('tool_inspect', { provider: 'vendor', endpoint: '/lookup' }, f.context);
      await expect(
        tools.execute(
          'tool_run',
          {
            provider: 'vendor',
            endpoint: '/lookup',
            input: { queryParams: { q: 'a', limit: 100 } },
          },
          f.context,
        ),
      ).rejects.toThrow('<= 5');
      expect(approve).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });
  it('sends exact inspected sections, waits for approval, and reuses the original receipt', async () => {
    const f = fixture();
    try {
      let runs = 0;
      let sent: unknown;
      const approve = vi.fn(async () => {});
      const tools = new Tools(f.config, f.store, approve, async (url, init) => {
        if (String(url).endsWith('/inspect')) return json(inspected);
        runs++;
        sent = JSON.parse(String(init?.body));
        return json({ runId: 'run-a', status: 'RUNNING' });
      });
      await tools.execute('tool_inspect', { provider: 'vendor', endpoint: '/lookup' }, f.context);
      const input = {
        provider: 'vendor',
        endpoint: '/lookup',
        input: { queryParams: { q: 'one', limit: 1 } },
      };
      await tools.execute('tool_run', input, f.context);
      await tools.execute('tool_run', input, f.context);
      expect(approve).toHaveBeenCalled();
      expect(sent).toEqual(input);
      expect(runs).toBe(1);
      expect(f.store.artifacts(f.session.id)[0].data.status).toBe('RUNNING');
    } finally {
      f.close();
    }
  });
  it('never resubmits an uncertain paid call', async () => {
    const f = fixture();
    try {
      const monid = new Monid(
        new Transport(f.config, async () => {
          throw new Error('lost');
        }),
        f.store,
      );
      f.store.operationSet(f.session.id, 'monid:inspect:vendor:/lookup', 'inspected', inspected);
      await expect(
        monid.run('vendor', '/lookup', { queryParams: { q: 'one' } }, f.context),
      ).rejects.toThrow('could not');
      await expect(
        monid.run('vendor', '/lookup', { queryParams: { q: 'one' } }, f.context),
      ).rejects.toThrow('already submitted');
    } finally {
      f.close();
    }
  });
  it('refuses cross-session run reads', async () => {
    const f = fixture();
    try {
      const fetcher = vi.fn();
      const monid = new Monid(new Transport(f.config, fetcher), f.store);
      await expect(monid.poll('someone-elses-run', f.context)).rejects.toThrow('Only Monid runs');
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });
  it('keeps BLOCKED terminal and preserves control details', () => {
    const f = fixture();
    try {
      const monid = new Monid(new Transport(f.config), f.store);
      expect(
        monid.check({
          runId: 'a',
          status: 'BLOCKED',
          controls: ['WORKSPACE_BUDGET'],
          reason: 'budget',
        }),
      ).toMatchObject({ status: 'BLOCKED', controls: ['WORKSPACE_BUDGET'] });
    } finally {
      f.close();
    }
  });
  it('detects a downstream provider failure inside HTTP success', () => {
    const f = fixture();
    try {
      expect(() =>
        new Monid(new Transport(f.config), f.store).check({
          runId: 'a',
          status: 'COMPLETED',
          providerResponse: { httpStatus: 500 },
        }),
      ).toThrow('provider returned HTTP 500');
    } finally {
      f.close();
    }
  });
});
describe('Receipt normalization', () => {
  it('canonicalizes reordered tool input so it cannot create a second paid run', async () => {
    const f = fixture();
    try {
      let runs = 0;
      f.store.operationSet(f.session.id, 'monid:inspect:vendor:/lookup', 'inspected', inspected);
      const monid = new Monid(
        new Transport(f.config, async () => {
          runs++;
          return json({ runId: 'one', status: 'COMPLETED', output: { ok: true } });
        }),
        f.store,
      );
      await monid.run('vendor', '/lookup', { queryParams: { q: 'one', limit: 1 } }, f.context);
      await monid.run('vendor', '/lookup', { queryParams: { limit: 1, q: 'one' } }, f.context);
      expect(runs).toBe(1);
    } finally {
      f.close();
    }
  });
});

describe('Firecrawl', () => {
  it('uses one browser per conversation and closes the exact resource', async () => {
    const f = fixture();
    try {
      const calls: { url: string; body: unknown; method: unknown }[] = [];
      const fc = new Firecrawl(
        new Transport(f.config, async (url, init) => {
          calls.push({
            url: String(url),
            body: init?.body ? JSON.parse(String(init.body)) : undefined,
            method: init?.method,
          });
          if (init?.method === 'DELETE') return json({ success: true });
          if (String(url).endsWith('/execute'))
            return json({
              success: true,
              stdout: JSON.stringify({
                title: 'Example',
                url: 'https://example.com',
                text: 'Example Domain',
                controls: [],
                screenshot: 'YWJj',
              }),
            });
          return json({
            success: true,
            id: 'browser-a',
            expiresAt: new Date(Date.now() + 60000).toISOString(),
            liveViewUrl: 'https://liveview.firecrawl.dev/browser-a',
            cdpUrl: 'wss://secret',
          });
        }),
        f.store,
      );
      await fc.action('open', { url: 'https://example.com' }, f.context);
      await fc.action('snapshot', {}, f.context);
      await fc.close(f.session.id);
      expect(calls.filter((c) => c.url.endsWith('/interact'))).toHaveLength(1);
      expect(calls.at(-1)).toMatchObject({
        url: 'https://api.firecrawl.dev/v2/interact/browser-a',
        method: 'DELETE',
      });
      expect(f.store.artifacts(f.session.id)[0].data).not.toHaveProperty('cdpUrl');
      expect(f.store.operation(f.session.id, 'firecrawl:browser')?.status).toBe('closed');
    } finally {
      f.close();
    }
  });
  it('treats HTTP 200 with an execution exception as failure', async () => {
    const f = fixture();
    try {
      const fc = new Firecrawl(
        new Transport(f.config, async (url) =>
          String(url).endsWith('/interact')
            ? json({ success: true, id: 'a' })
            : json({ success: true, error: 'TimeoutError' }),
        ),
        f.store,
      );
      await expect(fc.action('snapshot', {}, f.context)).rejects.toThrow('browser action failed');
      expect(f.store.artifacts(f.session.id)).toHaveLength(0);
    } finally {
      f.close();
    }
  });
  it('retains browser ownership after a failed close', async () => {
    const f = fixture();
    try {
      f.store.operationSet(f.session.id, 'firecrawl:browser', 'active', {
        id: 'a',
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      });
      const fc = new Firecrawl(
        new Transport(f.config, async () => new Response('', { status: 500 })),
        f.store,
      );
      await expect(fc.close(f.session.id)).rejects.toThrow();
      expect(f.store.operation(f.session.id, 'firecrawl:browser')?.status).toBe('active');
    } finally {
      f.close();
    }
  });
  it.each([
    'http://example.com',
    'https://user:pass@example.com',
    'https://localhost',
    'https://127.0.0.1',
    'file:///etc/passwd',
  ])('blocks unsafe browse URL %s', (url) => {
    expect(() => publicUrl(url)).toThrow();
  });
  it('requires confirmation before a browser mutation', async () => {
    const f = fixture();
    try {
      const approve = vi.fn(async () => {
        throw new Error('denied');
      });
      const fetcher = vi.fn();
      const tools = new Tools(f.config, f.store, approve, fetcher);
      await expect(
        tools.execute('browser_act', { action: 'click', selector: 'button' }, f.context),
      ).rejects.toThrow('denied');
      expect(approve).toHaveBeenCalledWith(
        'browser_act',
        expect.objectContaining({ selector: 'button' }),
        expect.anything(),
        f.context,
      );
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  });
});
