/** Opt-in live provider proof. Reports aggregate evidence; never keys, raw profiles, or signed browser URLs. */
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { config } from '../server/config.ts';
import { Store } from '../server/store.ts';
import { Tools } from '../server/tools.ts';
import { OpenRouter } from '../server/providers/openrouter.ts';
import { record, ProviderError } from '../server/http.ts';
if (process.env.FOMO_LIVE_EVAL !== '1')
  throw new Error(
    'Opt in with FOMO_LIVE_EVAL=1. This uses configured provider credits. FOMO_LIVE_MONID=1 additionally executes one $0.05 weather call.',
  );
const conf = config();
const dir = await mkdtemp(join(tmpdir(), 'fomo-live-'));
const store = new Store(dir);
const s = store.create();
const controller = new AbortController();
const c = {
  sessionId: s.id,
  turnId: randomUUID(),
  callId: randomUUID(),
  signal: controller.signal,
};
const results: {
  name: string;
  passed: boolean;
  durationMs: number;
  evidence?: Record<string, unknown>;
  error?: string;
}[] = [];
const tools = new Tools(conf, store, async (name, args) => {
  if (
    name === 'tool_run' &&
    process.env.FOMO_LIVE_MONID === '1' &&
    args.provider === 'accuweather' &&
    args.endpoint === '/get_weather' &&
    JSON.stringify(args.input) === JSON.stringify({ queryParams: { city: 'London' } })
  )
    return;
  throw new ProviderError(
    'not_approved',
    'Live evaluation only authorizes the explicitly opted-in one-city weather fixture.',
  );
});
async function check(name: string, fn: () => Promise<Record<string, unknown>>) {
  const start = Date.now();
  console.log(`FOMO live: ${name}`);
  try {
    const evidence = await fn();
    results.push({ name, passed: true, durationMs: Date.now() - start, evidence });
  } catch (e) {
    results.push({
      name,
      passed: false,
      durationMs: Date.now() - start,
      error:
        e instanceof ProviderError
          ? e.message
          : e instanceof Error
            ? e.message.slice(0, 400)
            : 'Evaluation failed',
    });
  }
}
await check('OpenRouter streaming and tool calling', async () => {
  const router = new OpenRouter(conf);
  const seen: string[] = [];
  const result = await router.complete(
    [
      {
        role: 'system',
        content:
          'Use the echo tool exactly once with text fomo-live-proof. Do not answer from memory.',
      },
      { role: 'user', content: 'Call echo now.' },
    ],
    [
      {
        type: 'function',
        function: {
          name: 'echo',
          description: 'Return an echo.',
          parameters: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
            additionalProperties: false,
          },
        },
      },
    ],
    conf.models,
    c.signal,
    () => {},
    (model) => seen.push(model),
  );
  assert.equal(result.message.tool_calls?.[0].function.name, 'echo');
  assert.equal(
    JSON.parse(result.message.tool_calls![0].function.arguments).text,
    'fomo-live-proof',
  );
  return {
    model: seen.at(-1),
    toolCalls: result.message.tool_calls!.length,
    totalTokens: result.usage.total_tokens,
  };
});
await check('Firecrawl web search', async () => {
  const r = record(
    await tools.execute('web_search', { query: 'IANA example domains', limit: 1 }, c),
  );
  assert.ok(Array.isArray(r.results) && r.results.length > 0);
  return { results: (r.results as unknown[]).length };
});
await check('Firecrawl page reading and screenshot', async () => {
  const r = record(
    await tools.execute('read_page', { url: 'https://www.iana.org/help/example-domains' }, c),
  );
  assert.match(String(r.markdown), /IANA|Example Domains/i);
  assert.ok(r.screenshot);
  return { title: r.title, screenshot: true, characters: String(r.markdown).length };
});
await check('Firecrawl persistent browser and cleanup', async () => {
  try {
    const open = record(
      await tools.execute('browser_open', { url: 'https://www.iana.org/help/example-domains' }, c),
    );
    assert.match(String(open.text), /IANA|Example Domains/i);
    const before = store.operation(s.id, 'firecrawl:browser')?.data.id;
    const next = record(await tools.execute('browser_snapshot', {}, c));
    assert.match(String(next.text), /IANA|Example Domains/i);
    assert.equal(store.operation(s.id, 'firecrawl:browser')?.data.id, before);
    return { sameBrowser: true, snapshot: true };
  } finally {
    await tools.firecrawl.close(s.id);
    assert.equal(store.operation(s.id, 'firecrawl:browser')?.status, 'closed');
  }
});
await check('Orbit search and cited profile read', async () => {
  let r = record(
    await tools.execute('people_search', { query: 'Linus Torvalds', limit: 1, depth: 'quick' }, c),
  );
  for (let i = 0; r.status === 'running' && i < 40; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    r = record(await tools.execute('people_status', { search_id: r.search_id }, c));
  }
  assert.ok(['completed', 'completed_with_errors'].includes(String(r.status)));
  const people = Array.isArray(r.people) ? r.people : [];
  const p = people
    .map(record)
    .find((p) => p.status === 'ready' && /Linus.*Torvalds/i.test(String(p.name)));
  assert.ok(p);
  const result = record(await tools.execute('people_profile', { profile_id: p.profile_id }, c));
  const person = record(result.person);
  assert.match(String(person.bio), /Linux/i);
  assert.ok(Array.isArray(person.sources) && person.sources.length > 0);
  return {
    readyResults: people.length,
    sources: (person.sources as unknown[]).length,
    profileRead: true,
  };
});
await check('Monid discovery and exact input schema', async () => {
  const discovered = record(await tools.execute('tool_discover', { query: 'weather forecast' }, c));
  assert.ok(Array.isArray(discovered.results) && discovered.results.length > 0);
  const inspected = record(
    await tools.execute('tool_inspect', { provider: 'accuweather', endpoint: '/get_weather' }, c),
  );
  assert.ok(record(inspected.input).queryParams);
  return {
    discovered: (discovered.results as unknown[]).length,
    compositeSchema: true,
    price: inspected.price,
  };
});
if (process.env.FOMO_LIVE_MONID === '1')
  await check('Monid approved execution and result', async () => {
    let r = record(
      await tools.execute(
        'tool_run',
        {
          provider: 'accuweather',
          endpoint: '/get_weather',
          input: { queryParams: { city: 'London' } },
        },
        c,
      ),
    );
    for (let i = 0; ['READY', 'RUNNING'].includes(String(r.status)) && i < 30; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      r = record(await tools.execute('tool_status', { run_id: r.runId }, c));
    }
    assert.equal(r.status, 'COMPLETED');
    assert.ok(r.output);
    return { status: r.status, hasOutput: true, cost: r.cost };
  });
await tools.firecrawl.close(s.id).catch(() => {});
store.close();
let revision = 'uncommitted';
let dirty = true;
try {
  revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  dirty = Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim());
} catch {
  /* New checkouts may not have their first commit yet. */
}
const report = {
  suite: 'live',
  revision,
  dirty,
  at: new Date().toISOString(),
  status: 'completed',
  passed: results.every((r) => r.passed),
  results,
};
await mkdir('.fomo/quality', { recursive: true, mode: 0o700 });
await writeFile('.fomo/quality/live-latest.json', JSON.stringify(report, null, 2) + '\n', {
  mode: 0o600,
});
console.log(
  `Live gates: ${results.filter((r) => r.passed).length}/${results.length} passed. Report: .fomo/quality/live-latest.json`,
);
if (!report.passed) process.exitCode = 1;
