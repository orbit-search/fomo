/** One process for API + UI; no sidecar agent or browser runtime to install. */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { getRequestListener } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { config } from './config.ts';
import { Store } from './store.ts';
import { Agent } from './agent.ts';
import { createApp } from './app.ts';
const settings = config();
const store = new Store(settings.dataDir);
store.recover();
const agent = new Agent(settings, store);
const app = createApp(settings, store, agent);
const dev = process.env.NODE_ENV !== 'production';
const vite = dev
  ? await (await import('vite')).createServer({ server: { middlewareMode: true }, appType: 'spa' })
  : undefined;
if (!dev) {
  app.use('*', serveStatic({ root: './dist' }));
  app.get('*', async (c) => {
    if (c.req.path.startsWith('/api/')) return c.json({ error: 'Route not found.' }, 404);
    if (c.req.path.includes('.')) return c.notFound();
    return c.html(await readFile('dist/index.html', 'utf8'));
  });
}
const handle = getRequestListener(app.fetch);
const server = createServer((req, res) => {
  if (vite && !req.url?.startsWith('/api/')) vite.middlewares(req, res);
  else void handle(req, res);
});
server.listen(settings.port, '127.0.0.1', () =>
  console.log(`FOMO → http://127.0.0.1:${settings.port} (${dev ? 'development' : 'production'})`),
);
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  server.close();
  await agent.shutdown();
  await vite?.close();
  store.close();
  server.closeAllConnections();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
