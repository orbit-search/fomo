/** Server-only Orbit v3 client. Credentials never enter tool arguments or browser artifacts. */
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { orbitSourceUrl, type OrbitPerson, type OrbitSearch } from '../../shared/orbit.ts';

type JsonValue = z.infer<ReturnType<typeof z.json>>;

export interface OrbitConfig {
  apiKey: string;
  origin: string;
}
export function orbitConfig(env: Record<string, string | undefined> = process.env): OrbitConfig {
  const apiKey = env.ORBIT_API_KEY?.trim();
  if (!apiKey)
    throw new OrbitError('not_configured', 'Set ORBIT_API_KEY on the FOMO server to use Orbit.');
  const url = new URL(env.ORBIT_API_HOST?.trim() || 'https://api.orbitsearch.com');
  if (
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))
  )
    throw new OrbitError(
      'configuration',
      'ORBIT_API_HOST must be an HTTPS origin, or loopback HTTP for tests.',
    );
  return { apiKey, origin: url.origin };
}
export class OrbitError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryAfterMs?: number,
    readonly retryable = false,
  ) {
    super(message);
  }
}
export interface OrbitSearchInput {
  request_id: string;
  query: string;
  limit: number;
  profile_depth: 'quick' | 'partial' | 'full';
  candidate_discovery: boolean;
}
const source = z.object({ link: z.string(), title: z.string().optional() });
const profile = z.object({
  displayName: z.string().optional(),
  personName: z.string().optional(),
  profileUrl: z.string().optional(),
  generationLevel: z.number().nullable().optional(),
  headline: z
    .union([
      z.string(),
      z.object({ jobTitle: z.string().optional(), companyName: z.string().optional() }),
    ])
    .optional(),
  location: z
    .union([
      z.string(),
      z.object({
        city: z.string().optional(),
        region: z.string().optional(),
        country: z.string().optional(),
      }),
    ])
    .optional(),
  sections: z.record(z.string(), z.json()).optional(),
  sources: z.array(source).optional(),
});
const rawSearch = z.object({
  search_id: z.string().min(1),
  request_id: z.string().min(1),
  status: z.enum(['running', 'completed', 'completed_with_errors', 'failed']),
  results: z.array(
    z.object({
      profile_id: z.string().min(1),
      status: z.enum(['generating', 'enriching', 'ready', 'failed']),
      generation_level: z.number().nullable().optional(),
      profile: profile.optional(),
      preview: z.record(z.string(), z.json()).optional(),
      candidate_sources: z.array(source).optional(),
    }),
  ),
  billing: z
    .object({
      status: z.enum(['open', 'settled']),
      consumedCredits: z.number(),
      heldCredits: z.number(),
    })
    .optional(),
});
const rawProfile = z.object({
  profile_id: z.string().min(1),
  generation_level: z.number().nullable(),
  profile,
});
const text = (value: unknown, limit = 1000) =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : undefined;
/** Preserve public facts while avoiding repeated evidence blobs in every section item. */
function contextValue(value: JsonValue, includeExcerpts: boolean): JsonValue {
  if (Array.isArray(value)) return value.map((item) => contextValue(item, includeExcerpts));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (key !== 'sources' || !Array.isArray(item))
        return [key, contextValue(item, includeExcerpts)];
      return [
        key,
        item.flatMap((receipt) => {
          if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return [];
          const url = orbitSourceUrl(receipt.link);
          if (!url) return [];
          const title = text(receipt.title, 200);
          return [
            {
              link: url,
              ...(title ? { title } : {}),
              ...(includeExcerpts && receipt.chunks ? { chunks: receipt.chunks } : {}),
            },
          ];
        }),
      ];
    }),
  );
}
function person(
  id: string,
  status: OrbitPerson['status'],
  value: z.infer<typeof profile>,
  receipts: z.infer<typeof source>[] = [],
  includeExcerpts = false,
): OrbitPerson {
  const headline =
    typeof value.headline === 'string'
      ? value.headline
      : [value.headline?.jobTitle, value.headline?.companyName].filter(Boolean).join(' · ');
  const location =
    typeof value.location === 'string'
      ? value.location
      : [value.location?.city, value.location?.region, value.location?.country]
          .filter(Boolean)
          .join(', ');
  const bio = value.sections?.bio;
  const supporting =
    bio && typeof bio === 'object' && !Array.isArray(bio)
      ? z.array(source).safeParse(bio.sources)
      : undefined;
  const sources = new Map<string, { url: string; title: string }>();
  for (const receipt of [
    ...(supporting?.success ? supporting.data : []),
    ...receipts,
    ...(value.sources ?? []),
  ]) {
    const url = orbitSourceUrl(receipt.link);
    if (url) sources.set(url, { url, title: text(receipt.title, 200) ?? new URL(url).hostname });
  }
  return {
    profile_id: id,
    status,
    name: text(value.displayName ?? value.personName, 200) ?? 'Profile pending',
    headline: text(headline, 300),
    location: text(location, 300),
    bio: bio && typeof bio === 'object' && !Array.isArray(bio) ? text(bio.bio, 4000) : undefined,
    profile_url: orbitSourceUrl(value.profileUrl),
    generation_level: value.generationLevel,
    sections: value.sections
      ? Object.fromEntries(
          Object.entries(value.sections).map(([key, item]) => [
            key,
            contextValue(item, includeExcerpts),
          ]),
        )
      : undefined,
    sources: [...sources.values()].slice(0, 12),
  };
}
function retryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(milliseconds) && milliseconds > 0 ? Math.ceil(milliseconds) : undefined;
}
function httpError(status: number, retry?: number): OrbitError {
  if (status === 401)
    return new OrbitError(
      'unauthorized',
      'Orbit rejected the server API key. Check ORBIT_API_KEY.',
    );
  if (status === 403)
    return new OrbitError(
      'access_denied',
      'The Orbit key needs search:read and profile:read scopes for this operation.',
    );
  if (status === 402)
    return new OrbitError(
      'insufficient_credits',
      'Orbit credits are insufficient. Check the developer dashboard; this request was not retried.',
    );
  if (status === 404)
    return new OrbitError('not_found', 'Orbit could not find this search or profile.');
  if (status === 409)
    return new OrbitError(
      'request_conflict',
      'The Orbit request ID already belongs to different parameters. Do not silently replace it.',
    );
  if (status === 429)
    return new OrbitError(
      'rate_limited',
      'Orbit is rate limited. Wait for retry_after_ms before retrying the same operation.',
      retry,
      true,
    );
  if (status >= 500)
    return new OrbitError(
      'unavailable',
      'Orbit is temporarily unavailable. Retry the same operation, preserving its request ID.',
      retry,
      true,
    );
  return new OrbitError(
    'invalid_request',
    'Orbit rejected the request. Check the query and parameters.',
  );
}
async function boundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new OrbitError('invalid_response', 'Orbit returned an empty response.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes)
        throw new OrbitError(
          'invalid_response',
          'Orbit returned more data than this workspace can accept. Narrow the search.',
        );
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error instanceof OrbitError) throw error;
    throw new OrbitError(
      'invalid_response',
      'Orbit returned an unreadable response. Retry the same operation.',
    );
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export class OrbitClient {
  private readonly config: OrbitConfig;
  private readonly fetcher: typeof fetch;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  constructor(
    options: {
      config?: OrbitConfig;
      fetch?: typeof fetch;
      sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
    } = {},
  ) {
    this.config = options.config ?? orbitConfig();
    this.fetcher = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms, signal) => delay(ms, undefined, { signal }));
  }
  private async request(
    path: string,
    signal: AbortSignal,
    requestId?: string,
    body?: unknown,
    maxBytes = 2_000_000,
  ): Promise<unknown> {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      let response: Response;
      try {
        response = await this.fetcher(`${this.config.origin}${path}`, {
          method: body ? 'POST' : 'GET',
          redirect: 'error',
          signal: bounded,
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json',
            ...(requestId ? { 'Idempotency-Key': requestId } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });
      } catch {
        signal.throwIfAborted();
        throw new OrbitError(
          'connection_failed',
          'Orbit could not be reached. Retry the same operation with its existing request ID.',
          undefined,
          true,
        );
      }
      if (response.ok) {
        // An upstream must never echo the operator credential into model-visible results.
        const value = await boundedJson(response, maxBytes);
        return JSON.parse(
          JSON.stringify(value).replaceAll(this.config.apiKey, '[redacted]'),
        ) as unknown;
      }
      const error = httpError(response.status, retryAfter(response.headers.get('retry-after')));
      await response.body?.cancel().catch(() => undefined);
      if (!error.retryable || attempt >= 2 || (error.retryAfterMs ?? 0) > 5000) throw error;
      const wait =
        error.retryAfterMs ?? Math.round(500 * 2 ** attempt * (0.8 + Math.random() * 0.4));
      try {
        await this.sleep(wait, bounded);
      } catch {
        signal.throwIfAborted();
        throw error;
      }
    }
  }
  async search(input: OrbitSearchInput, signal: AbortSignal): Promise<OrbitSearch> {
    const payload = {
      ...input,
      include_profile: true,
      ...(input.candidate_discovery
        ? { candidate_discovery_limit: Math.min(input.limit, 10) }
        : {}),
    };
    const snapshot = this.searchResult(
      await this.request('/v3/search', signal, input.request_id, payload),
    );
    if (snapshot.request_id !== input.request_id)
      throw new OrbitError(
        'invalid_response',
        'Orbit returned a different request ID. Preserve the original operation when retrying.',
      );
    return snapshot;
  }
  async status(searchId: string, signal: AbortSignal): Promise<OrbitSearch> {
    const snapshot = this.searchResult(
      await this.request(`/v3/search/${encodeURIComponent(searchId)}`, signal),
    );
    if (snapshot.search_id !== searchId)
      throw new OrbitError('invalid_response', 'Orbit returned a different search ID.');
    return snapshot;
  }
  private searchResult(value: unknown): OrbitSearch {
    const result = rawSearch.safeParse(value);
    if (!result.success)
      throw new OrbitError(
        'invalid_response',
        "Orbit's search response did not match the v3 contract. Preserve the request ID when retrying.",
      );
    const data = result.data;
    return {
      provider: 'orbit',
      operation: 'search',
      request_id: data.request_id,
      search_id: data.search_id,
      status: data.status,
      people: data.results.slice(0, 30).map((row) => {
        const preview = profile.safeParse(row.preview ?? {});
        const value =
          row.profile ??
          (preview.success
            ? preview.data
            : {
                displayName: text(
                  row.preview?.displayName ?? row.preview?.personName ?? row.preview?.name,
                  200,
                ),
              });
        return {
          ...person(row.profile_id, row.status, value, row.candidate_sources),
          generation_level: row.generation_level ?? value.generationLevel,
        };
      }),
      ...(data.status === 'running' ? { poll_after_ms: 1500 } : {}),
      ...(data.billing
        ? {
            billing: {
              status: data.billing.status,
              consumed_credits: data.billing.consumedCredits,
              held_credits: data.billing.heldCredits,
            },
          }
        : {}),
    };
  }
  async profile(
    profileId: string,
    requestId: string,
    signal: AbortSignal,
    includeExcerpts = false,
  ) {
    const result = rawProfile.safeParse(
      await this.request(
        `/v3/enrich/${encodeURIComponent(profileId)}`,
        signal,
        requestId,
        undefined,
        8_000_000,
      ),
    );
    if (!result.success)
      throw new OrbitError(
        'invalid_response',
        "Orbit's profile response did not match the v3 contract.",
      );
    return {
      provider: 'orbit' as const,
      operation: 'profile' as const,
      status: 'completed' as const,
      person: {
        ...person(result.data.profile_id, 'ready', result.data.profile, [], includeExcerpts),
        generation_level: result.data.generation_level,
      },
    };
  }
}
