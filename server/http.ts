/** Bounded provider transport: no cross-origin redirects, raw provider error dumps, or mutation retries. */
import type { Config, Provider } from '../shared/types.ts';
export class ProviderError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
export function redact(text: string, config: Config) {
  for (const key of Object.values(config.keys)) if (key) text = text.replaceAll(key, '[redacted]');
  if (config.operatorToken) text = text.replaceAll(config.operatorToken, '[redacted]');
  return text;
}
export async function boundedJson(response: Response, max = 4_000_000): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new ProviderError('invalid_response', 'Provider returned no data.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max)
        throw new ProviderError(
          'too_large',
          'Provider response exceeded the workspace limit. Narrow the request.',
        );
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    throw new ProviderError('invalid_response', 'Provider returned unreadable JSON.');
  } finally {
    await reader.cancel().catch(() => {});
  }
}
export class Transport {
  constructor(
    readonly config: Config,
    readonly fetcher: typeof fetch = fetch,
  ) {}
  async request(
    provider: Provider,
    path: string,
    signal: AbortSignal,
    body?: unknown,
    method?: string,
    headers: Record<string, string> = {},
  ) {
    const key = this.config.keys[provider];
    if (!key)
      throw new ProviderError(
        'not_configured',
        `Set ${provider.toUpperCase()}_API_KEY on the FOMO server.`,
      );
    if (!path.startsWith('/') || path.startsWith('//'))
      throw new Error('Provider path must be relative.');
    let response: Response;
    try {
      response = await this.fetcher(this.config.origins[provider] + path, {
        method: method ?? (body ? 'POST' : 'GET'),
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)]),
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...headers },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      signal.throwIfAborted();
      throw new ProviderError(
        'connection_failed',
        `${provider} could not be reached. Mutations are not automatically retried.`,
      );
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new ProviderError(
        `http_${response.status}`,
        `${provider}: ${response.status === 401 || response.status === 403 ? 'check your API key and permissions' : response.status === 402 ? 'insufficient credits' : response.status === 429 ? 'rate limited; wait before retrying' : `request failed (HTTP ${response.status})`}.`,
      );
    }
    if (response.status === 204) return {};
    return JSON.parse(redact(JSON.stringify(await boundedJson(response)), this.config)) as unknown;
  }
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ProviderError('invalid_response', 'Provider response must be an object.');
  return value as Record<string, unknown>;
}
export function safeUrl(value: unknown) {
  if (typeof value !== 'string') return undefined;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password ? u.href : undefined;
  } catch {
    return undefined;
  }
}
export function publicUrl(value: string) {
  const u = new URL(value);
  if (
    !safeUrl(value) ||
    u.hostname === 'localhost' ||
    u.hostname.endsWith('.local') ||
    u.hostname.endsWith('.internal') ||
    /^\d+(\.\d+){3}$/.test(u.hostname) ||
    u.hostname.includes(':')
  )
    throw new ProviderError('invalid_url', 'Use a public HTTPS URL without credentials.');
  return u.href;
}

/** Canonical object order makes equivalent tool input share the same paid-operation receipt. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
