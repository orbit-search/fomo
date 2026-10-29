/** Firecrawl owns web search, reading, and isolated persistent browser interaction. */
import { z } from 'zod';
import { Transport, record, publicUrl, safeUrl, ProviderError } from '../http.ts';
import type { Store } from '../store.ts';
import type { ToolContext } from '../../shared/types.ts';
const pageSchema = z.object({
  markdown: z.string().optional(),
  screenshot: z.string().optional(),
  metadata: z
    .object({
      title: z.string().optional(),
      sourceURL: z.string().optional(),
      url: z.string().optional(),
      statusCode: z.number().optional(),
    })
    .passthrough()
    .optional(),
});
export class Firecrawl {
  constructor(
    readonly http: Transport,
    readonly store: Store,
  ) {}
  async search(query: string, limit: number, c: ToolContext) {
    const raw = record(
      await this.http.request('firecrawl', '/v2/search', c.signal, {
        query,
        limit,
        sources: ['web'],
      }),
    );
    if (raw.success !== true)
      throw new ProviderError('provider_error', 'Firecrawl search did not succeed.');
    const data = record(raw.data);
    const rows = z
      .array(
        z.object({
          url: z.string(),
          title: z.string().optional(),
          description: z.string().optional(),
        }),
      )
      .parse(data.web ?? []);
    return { results: rows.map((r) => ({ ...r, url: safeUrl(r.url) })).filter((r) => r.url) };
  }
  async scrape(url: string, c: ToolContext) {
    const raw = record(
      await this.http.request('firecrawl', '/v2/scrape', c.signal, {
        url: publicUrl(url),
        formats: ['markdown', 'screenshot'],
        onlyMainContent: true,
        timeout: 45000,
      }),
    );
    if (raw.success !== true)
      throw new ProviderError('provider_error', 'Firecrawl could not read this page.');
    const p = pageSchema.parse(raw.data);
    if ((p.metadata?.statusCode ?? 200) >= 400)
      throw new ProviderError(
        'page_error',
        `The requested page returned HTTP ${p.metadata?.statusCode}.`,
      );
    const result = {
      url: safeUrl(p.metadata?.sourceURL ?? p.metadata?.url) ?? url,
      title: p.metadata?.title ?? new URL(url).hostname,
      markdown: p.markdown?.slice(0, 40000) ?? '',
      screenshot: safeUrl(p.screenshot),
    };
    this.store.artifact({
      sessionId: c.sessionId,
      provider: 'firecrawl',
      kind: 'page',
      title: result.title,
      data: result,
    });
    return result;
  }
  async browser(c: ToolContext) {
    const key = 'firecrawl:browser';
    const existing = this.store.operation(c.sessionId, key);
    if (
      existing?.status === 'active' &&
      Date.parse(String(existing.data.expiresAt)) > Date.now() + 5000
    )
      return existing.data;
    if (
      existing?.status === 'creating' &&
      Date.now() - Date.parse(String(existing.data.at)) < 310000
    )
      throw new ProviderError(
        'uncertain',
        'Browser creation was interrupted. Wait for its short TTL before creating another.',
      );
    this.store.operationSet(c.sessionId, key, 'creating', { at: new Date().toISOString() });
    const r = z
      .object({
        success: z.literal(true),
        id: z.string().min(1),
        liveViewUrl: z.string().optional(),
        expiresAt: z.string().optional(),
      })
      .parse(
        await this.http.request('firecrawl', '/v2/interact', c.signal, {
          ttl: 300,
          activityTtl: 120,
        }),
      );
    const data = {
      id: r.id,
      expiresAt: r.expiresAt ?? new Date(Date.now() + 300000).toISOString(),
      liveViewUrl: safeUrl(r.liveViewUrl),
    };
    this.store.operationSet(c.sessionId, key, 'active', data);
    return data;
  }
  async action(
    action: 'open' | 'snapshot' | 'click' | 'fill' | 'press' | 'scroll',
    args: { url?: string; selector?: string; value?: string; direction?: 'up' | 'down' },
    c: ToolContext,
  ) {
    const session = await this.browser(c);
    const q = (x: unknown) => JSON.stringify(x);
    const statement =
      action === 'open'
        ? `await page.goto(${q(publicUrl(args.url!))}, {waitUntil:'domcontentloaded'});`
        : action === 'click'
          ? `await page.locator(${q(args.selector)}).click({timeout:10000});`
          : action === 'fill'
            ? `await page.locator(${q(args.selector)}).fill(${q(args.value)},{timeout:10000});`
            : action === 'press'
              ? `await page.locator(${q(args.selector)}).press(${q(args.value)},{timeout:10000});`
              : action === 'scroll'
                ? `await page.mouse.wheel(0,${args.direction === 'up' ? -650 : 650});`
                : '';
    const code = `${statement}\nconsole.log(JSON.stringify({url:page.url(),title:await page.title(),text:(await page.locator('body').innerText()).slice(0,16000),controls:await page.locator('a,button,input,textarea,select').evaluateAll(els=>els.slice(0,80).map(e=>({tag:e.tagName,text:e.innerText?.slice(0,100),id:e.id,name:e.getAttribute('name'),type:e.getAttribute('type'),label:e.getAttribute('aria-label'),placeholder:e.getAttribute('placeholder')}))),screenshot:(await page.screenshot({type:'jpeg',quality:55})).toString('base64')}));`;
    const r = record(
      await this.http.request(
        'firecrawl',
        `/v2/interact/${encodeURIComponent(String(session.id))}/execute`,
        c.signal,
        { code, language: 'node', timeout: 45 },
      ),
    );
    if (r.success !== true || r.error || (typeof r.exitCode === 'number' && r.exitCode !== 0))
      throw new ProviderError(
        'browser_error',
        'Firecrawl browser action failed. Inspect the current page before trying again.',
      );
    let page: Record<string, unknown>;
    try {
      page = record(JSON.parse(String(r.stdout ?? r.result)));
    } catch {
      throw new ProviderError(
        'invalid_response',
        'Firecrawl did not return a readable browser snapshot.',
      );
    }
    const image =
      typeof page.screenshot === 'string' &&
      page.screenshot.length < 2_000_000 &&
      /^[A-Za-z0-9+/=]+$/.test(page.screenshot)
        ? `data:image/jpeg;base64,${page.screenshot}`
        : undefined;
    const data = {
      title: typeof page.title === 'string' ? page.title : 'Browser',
      url: safeUrl(page.url),
      text: page.text,
      controls: page.controls,
      screenshot: image,
      liveViewUrl: session.liveViewUrl,
      expiresAt: session.expiresAt,
    };
    this.store.artifact(
      { sessionId: c.sessionId, provider: 'firecrawl', kind: 'browser', title: data.title, data },
      `${c.sessionId}:browser`,
    );
    return {
      ...data,
      screenshot: image ? 'Captured in the workspace' : undefined,
      liveViewUrl: undefined,
    };
  }
  async close(sessionId: string) {
    const op = this.store.operation(sessionId, 'firecrawl:browser');
    if (op?.status === 'creating') {
      // A lost create has no known remote ID; the provider TTL bounds its lifetime.
      if (Date.now() - Date.parse(String(op.data.at)) > 310000)
        this.store.operationSet(sessionId, 'firecrawl:browser', 'closed', {});
      return;
    }
    if (op?.status !== 'active') return;
    try {
      await this.http.request(
        'firecrawl',
        `/v2/interact/${encodeURIComponent(String(op.data.id))}`,
        AbortSignal.timeout(10000),
        undefined,
        'DELETE',
      );
      this.store.operationSet(sessionId, 'firecrawl:browser', 'closed', {});
    } catch (e) {
      if (Date.parse(String(op.data.expiresAt)) < Date.now())
        this.store.operationSet(sessionId, 'firecrawl:browser', 'closed', {});
      else throw e;
    }
  }
}
