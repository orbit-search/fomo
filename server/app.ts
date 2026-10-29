/** Single-operator, same-origin API. Local binding and origin checks protect server-held keys. */
import { Hono } from 'hono';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { Config } from '../shared/types.ts';
import type { Store } from './store.ts';
import type { Agent } from './agent.ts';
import { ProviderError } from './http.ts';
function equal(a: string, b: string) {
  return timingSafeEqual(
    createHash('sha256').update(a).digest(),
    createHash('sha256').update(b).digest(),
  );
}
export function createApp(config: Config, store: Store, agent: Agent) {
  const app = new Hono();
  const origin = `http://127.0.0.1:${config.port}`;
  const cookieValue = createHash('sha256')
    .update(`fomo-session:${config.operatorToken ?? ''}`)
    .digest('hex');
  app.use('*', async (c, next) => {
    const host = c.req.header('host');
    if (![`127.0.0.1:${config.port}`, `localhost:${config.port}`].includes(host ?? ''))
      return c.json({ error: 'Invalid local host.' }, 403);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Cache-Control', 'no-store');
    c.header('X-Frame-Options', 'DENY');
    if (c.req.path.startsWith('/api/')) {
      const supplied = c.req.header('origin');
      if (
        (supplied && ![origin, `http://localhost:${config.port}`].includes(supplied)) ||
        c.req.header('sec-fetch-site') === 'cross-site'
      )
        return c.json({ error: 'Cross-origin access is not allowed.' }, 403);
      if (
        !['GET', 'HEAD'].includes(c.req.method) &&
        !c.req.header('content-type')?.startsWith('application/json')
      )
        return c.json({ error: 'Use application/json.' }, 415);
      if (Number(c.req.header('content-length') ?? 0) > 64000)
        return c.json({ error: 'Request too large.' }, 413);
      if (config.operatorToken && c.req.path !== '/api/login') {
        const cookie =
          c.req
            .header('cookie')
            ?.split(';')
            .map((x) => x.trim())
            .find((x) => x.startsWith('fomo_operator='))
            ?.slice('fomo_operator='.length) ?? '';
        const bearer = c.req.header('authorization')?.replace(/^Bearer /, '') ?? '';
        if (!equal(cookie, cookieValue) && !equal(bearer, config.operatorToken))
          return c.json({ error: 'Unlock this workspace with the operator token.' }, 401);
      }
    }
    await next();
  });
  const body = async (c: { req: { text: () => Promise<string> } }) => {
    const text = await c.req.text();
    if (Buffer.byteLength(text) > 64000) throw new ProviderError('too_large', 'Request too large.');
    return JSON.parse(text) as unknown;
  };
  app.post('/api/login', async (c) => {
    const data = z.object({ token: z.string().max(500) }).parse(await body(c));
    if (!config.operatorToken || !equal(data.token, config.operatorToken))
      return c.json({ error: 'Operator token did not match.' }, 401);
    c.header(
      'Set-Cookie',
      `fomo_operator=${cookieValue}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=43200`,
    );
    return c.json({ ok: true });
  });
  app.get('/api/status', (c) =>
    c.json({
      name: 'FOMO',
      models: config.models,
      providers: Object.fromEntries(
        Object.entries(config.keys).map(([name, key]) => [name, { configured: Boolean(key) }]),
      ),
    }),
  );
  app.get('/api/sessions', (c) => c.json(store.list()));
  app.post('/api/sessions', (c) => c.json(store.create(), 201));
  app.get('/api/sessions/:id', (c) => {
    const id = c.req.param('id');
    const session = store.get(id);
    if (!session) return c.json({ error: 'Session not found.' }, 404);
    const after = Number(c.req.query('after') ?? 0);
    if (!Number.isSafeInteger(after) || after < 0)
      return c.json({ error: 'Invalid event cursor.' }, 400);
    return c.json({
      session,
      events: store.events(id, after),
      artifacts: store.artifacts(id),
      approvals: store.approvals(id),
    });
  });
  app.post('/api/sessions/:id/messages', async (c) => {
    const data = z
      .object({
        text: z.string().trim().min(1).max(12000),
        clientId: z.uuid(),
        model: z.string().optional(),
      })
      .parse(await body(c));
    if (data.model && !config.models.includes(data.model))
      return c.json({ error: 'Select a configured model.' }, 400);
    const models = data.model
      ? [data.model, ...config.models.filter((x) => x !== data.model)]
      : config.models;
    const turnId = agent.start(c.req.param('id'), data.text, data.clientId, models);
    return c.json({ turnId }, 202);
  });
  app.post('/api/sessions/:id/stop', async (c) => {
    if (!store.get(c.req.param('id'))) return c.json({ error: 'Session not found.' }, 404);
    await agent.stop(c.req.param('id'));
    return c.json({ ok: true });
  });
  app.post('/api/sessions/:id/approvals/:approvalId', async (c) => {
    const data = z.object({ approved: z.boolean() }).parse(await body(c));
    if (!agent.approve(c.req.param('id'), c.req.param('approvalId'), data.approved))
      return c.json({ error: 'This confirmation is no longer pending.' }, 409);
    return c.json({ ok: true });
  });
  app.delete('/api/sessions/:id', async (c) => {
    const id = c.req.param('id');
    if (!store.get(id)) return c.json({ error: 'Session not found.' }, 404);
    await agent.stop(id);
    store.delete(id);
    return c.json({ ok: true });
  });
  app.onError((e, c) => {
    const code = e instanceof ProviderError ? e.code : '';
    return c.json(
      {
        error:
          e instanceof ProviderError
            ? e.message
            : e.name === 'ZodError' || e instanceof SyntaxError
              ? 'Invalid request.'
              : 'The server could not complete this request.',
      },
      code === 'not_found'
        ? 404
        : code === 'busy'
          ? 409
          : code === 'too_large'
            ? 413
            : e.name === 'ZodError' || e instanceof SyntaxError
              ? 400
              : 500,
    );
  });
  return app;
}
