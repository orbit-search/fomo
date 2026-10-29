/** Explicit provider configuration. No provider fallbacks or credential discovery at runtime. */
import { resolve } from 'node:path';
import type { Config, Provider } from '../shared/types.ts';
export function config(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT || 4330);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error('PORT must be between 1024 and 65535.');
  const operatorToken = env.FOMO_OPERATOR_TOKEN?.trim() || undefined;
  if (env.NODE_ENV === 'production' && (!operatorToken || operatorToken.length < 32))
    throw new Error('Production requires FOMO_OPERATOR_TOKEN with at least 32 characters.');
  const models = (env.FOMO_MODELS || 'openai/gpt-5.4-mini,anthropic/claude-sonnet-4.5')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  if (!models.length || models.length > 5 || models.some((x) => x.length > 150 || !x.includes('/')))
    throw new Error('FOMO_MODELS requires 1–5 OpenRouter model IDs.');
  const origins: Config['origins'] = {
    firecrawl: 'https://api.firecrawl.dev',
    orbit: 'https://api.orbitsearch.com',
    monid: 'https://api.monid.ai',
    openrouter: 'https://openrouter.ai',
  };
  // Endpoint overrides are limited to loopback fixtures, never a way to send keys to arbitrary hosts.
  for (const p of Object.keys(origins) as Provider[]) {
    const override = env[`FOMO_TEST_${p.toUpperCase()}_ORIGIN`];
    if (override) {
      const u = new URL(override);
      if (
        env.NODE_ENV !== 'test' ||
        u.protocol !== 'http:' ||
        !['127.0.0.1', 'localhost'].includes(u.hostname) ||
        u.username ||
        u.password ||
        u.pathname !== '/' ||
        u.search ||
        u.hash
      )
        throw new Error('Fixture origins require NODE_ENV=test and loopback HTTP.');
      origins[p] = u.origin;
    }
  }
  return {
    port,
    operatorToken,
    dataDir: resolve(env.FOMO_DATA_DIR || '.fomo'),
    models,
    workspaceId: env.MONID_WORKSPACE_ID || undefined,
    keys: {
      firecrawl: env.FIRECRAWL_API_KEY,
      orbit: env.ORBIT_API_KEY,
      monid: env.MONID_API_KEY,
      openrouter: env.OPENROUTER_API_KEY,
    },
    origins,
  };
}
