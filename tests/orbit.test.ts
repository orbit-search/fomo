/** Orbit's public v3 contract and replay-safe search receipts. */
import { describe, it, expect } from 'vitest';
import { OrbitClient } from '../server/providers/orbit.ts';
import { Tools } from '../server/tools.ts';
import { fixture, json } from './helpers.ts';
const raw = {
  search_id: 'search-1',
  request_id: 'request-1',
  status: 'completed',
  results: [
    {
      profile_id: 'person-1',
      status: 'ready',
      generation_level: 1,
      profile: {
        displayName: 'Linus Torvalds',
        headline: { jobTitle: 'Fellow', companyName: 'Linux Foundation' },
        sections: {
          bio: {
            bio: 'Creator of Linux.',
            sources: [
              { link: 'https://example.com/bio', title: 'Biography', chunks: ['repeat evidence'] },
            ],
          },
        },
      },
    },
  ],
};
describe('Orbit integration', () => {
  it('validates search receipts and preserves source attribution', async () => {
    const f = fixture();
    try {
      const client = new OrbitClient({
        config: { apiKey: 'key', origin: 'https://api.orbitsearch.com' },
        fetch: async () => json(raw),
      });
      const r = await client.search(
        {
          request_id: 'request-1',
          query: 'Linus Torvalds',
          limit: 1,
          profile_depth: 'quick',
          candidate_discovery: false,
        },
        f.context.signal,
      );
      expect(r.people[0]).toMatchObject({
        name: 'Linus Torvalds',
        headline: 'Fellow · Linux Foundation',
        bio: 'Creator of Linux.',
      });
      expect(r.people[0].sources).toEqual([{ url: 'https://example.com/bio', title: 'Biography' }]);
      expect(JSON.stringify(r.people[0].sections)).not.toContain('repeat evidence');
    } finally {
      f.close();
    }
  });
  it('deduplicates repeated search queries with stable IDs across different tool calls', async () => {
    const f = fixture();
    try {
      let calls = 0;
      const requestIds: string[] = [];
      const tools = new Tools(
        f.config,
        f.store,
        async () => {},
        async (_url, init) => {
          calls++;
          const body = JSON.parse(String(init?.body));
          requestIds.push(body.request_id);
          return json({ ...raw, request_id: body.request_id });
        },
      );
      const args = { query: 'Linus Torvalds', limit: 1, depth: 'quick' };
      await tools.execute('people_search', args, f.context);
      await tools.execute('people_search', args, { ...f.context, callId: 'different' });
      expect(calls).toBe(1);
      expect(requestIds[0]).toMatch(/^fomo_/);
      expect(f.store.artifacts(f.session.id)[0].kind).toBe('people');
    } finally {
      f.close();
    }
  });
  it('retries an uncertain search with its original idempotency receipt', async () => {
    const f = fixture();
    try {
      const ids: string[] = [];
      let attempt = 0;
      const tools = new Tools(
        f.config,
        f.store,
        async () => {},
        async (_url, init) => {
          const body = JSON.parse(String(init?.body));
          ids.push(body.request_id);
          if (attempt++ === 0) throw new Error('connection lost');
          return json({ ...raw, request_id: body.request_id });
        },
      );
      await expect(tools.execute('people_search', { query: 'Linus' }, f.context)).rejects.toThrow(
        'could not be reached',
      );
      await tools.execute('people_search', { query: 'Linus' }, { ...f.context, callId: 'next' });
      expect(ids[0]).toBe(ids[1]);
    } finally {
      f.close();
    }
  });
  it('rejects mismatched request identities and foreign search polling', async () => {
    const f = fixture();
    try {
      const tools = new Tools(
        f.config,
        f.store,
        async () => {},
        async () => json(raw),
      );
      await expect(tools.execute('people_search', { query: 'Linus' }, f.context)).rejects.toThrow(
        'different request ID',
      );
      await expect(
        tools.execute('people_status', { search_id: 'foreign' }, f.context),
      ).rejects.toThrow('Only searches');
    } finally {
      f.close();
    }
  });
  it('accepts a rich profile larger than 2MB while compacting repeated source evidence', async () => {
    const f = fixture();
    try {
      const client = new OrbitClient({
        config: { apiKey: 'key', origin: 'https://api.orbitsearch.com' },
        fetch: async () =>
          json({
            profile_id: 'person-1',
            generation_level: 1,
            profile: {
              displayName: 'Linus',
              sections: {
                bio: {
                  bio: 'Linux creator',
                  sources: [{ link: 'https://example.com', chunks: ['x'.repeat(2_100_000)] }],
                },
              },
            },
          }),
      });
      const r = await client.profile('person-1', 'stable', f.context.signal);
      expect(JSON.stringify(r).length).toBeLessThan(1500);
      expect(r.person.bio).toBe('Linux creator');
    } finally {
      f.close();
    }
  });
});
