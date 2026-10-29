/** Discover → inspect → validate → approve → execute. Unknown mutations are never replayed. */
import Ajv2020 from 'ajv/dist/2020.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Transport, record, ProviderError, canonical } from '../http.ts';
import type { Store } from '../store.ts';
import type { ToolContext } from '../../shared/types.ts';
const statuses = [
  'READY',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'BLOCKED',
  'STOPPED',
  'TIME_OUT',
] as const;
const runSchema = z
  .object({
    runId: z.string(),
    status: z.enum(statuses),
    stoppable: z.boolean().optional(),
    output: z.unknown().optional(),
    cost: z.unknown().optional(),
    providerResponse: z
      .object({ httpStatus: z.number().optional() })
      .passthrough()
      .nullable()
      .optional(),
    controls: z.unknown().optional(),
    reason: z.string().optional(),
  })
  .passthrough();
export class Monid {
  constructor(
    readonly http: Transport,
    readonly store: Store,
  ) {}
  private body(value: Record<string, unknown>) {
    return {
      ...value,
      ...(this.http.config.workspaceId ? { workspaceId: this.http.config.workspaceId } : {}),
    };
  }
  private inspectKey(provider: string, endpoint: string) {
    return `monid:inspect:${provider}:${endpoint}`;
  }
  async discover(query: string, c: ToolContext) {
    const r = record(
      await this.http.request('monid', '/v1/discover', c.signal, this.body({ query, limit: 5 })),
    );
    if (!Array.isArray(r.results))
      throw new ProviderError('invalid_response', 'Monid returned an invalid discovery response.');
    return r;
  }
  async inspect(provider: string, endpoint: string, c: ToolContext) {
    const r = record(
      await this.http.request('monid', '/v1/inspect', c.signal, this.body({ provider, endpoint })),
    );
    if (r.provider !== provider || r.endpoint !== endpoint)
      throw new ProviderError('invalid_response', 'Monid returned a different endpoint.');
    if (!r.input && !r.inputSchema)
      throw new ProviderError('invalid_response', 'Monid did not return an input schema.');
    this.store.operationSet(c.sessionId, this.inspectKey(provider, endpoint), 'inspected', r);
    return r;
  }
  validate(provider: string, endpoint: string, input: Record<string, unknown>, c: ToolContext) {
    const op = this.store.operation(c.sessionId, this.inspectKey(provider, endpoint));
    if (!op)
      throw new ProviderError(
        'inspect_required',
        'Inspect this exact Monid endpoint in this conversation before executing it.',
      );
    const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
    const detail = op.data;
    try {
      if (detail.input) {
        const parts = record(detail.input);
        for (const key of Object.keys(input))
          if (!Object.hasOwn(parts, key))
            throw new ProviderError('invalid_input', `Unexpected Monid input section: ${key}`);
        for (const [part, schema] of Object.entries(parts)) {
          const validate = ajv.compile(record(schema));
          if (!validate(input[part] ?? {}))
            throw new ProviderError(
              'invalid_input',
              `Monid ${part}: ${ajv.errorsText(validate.errors)}`,
            );
        }
      } else {
        const validate = ajv.compile(record(detail.inputSchema));
        if (!validate(input))
          throw new ProviderError(
            'invalid_input',
            `Monid input: ${ajv.errorsText(validate.errors)}`,
          );
      }
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      throw new ProviderError(
        'schema_error',
        'This endpoint schema could not be validated. Reinspect it or choose another tool.',
      );
    }
    return detail;
  }
  async run(provider: string, endpoint: string, input: Record<string, unknown>, c: ToolContext) {
    this.validate(provider, endpoint, input, c);
    const hash = createHash('sha256')
      .update(canonical({ provider, endpoint, input }))
      .digest('hex');
    const key = `monid:run:${hash}`;
    const prior = this.store.operation(c.sessionId, key);
    if (prior) {
      if (prior.status === 'known') return prior.data;
      throw new ProviderError(
        'uncertain',
        'This Monid operation was already submitted and its result is uncertain. Check recent runs in Monid before repeating it.',
      );
    }
    this.store.operationSet(c.sessionId, key, 'submitted', {
      provider,
      endpoint,
      at: new Date().toISOString(),
    });
    const result = this.check(
      await this.http.request(
        'monid',
        '/v1/run',
        c.signal,
        this.body({ provider, endpoint, input }),
      ),
    );
    this.store.operationSet(c.sessionId, key, 'known', result);
    this.store.operationSet(c.sessionId, `monid:owned:${result.runId}`, 'known', result);
    return result;
  }
  check(value: unknown) {
    const r = runSchema.parse(value);
    if ((r.providerResponse?.httpStatus ?? 200) >= 400)
      throw new ProviderError(
        'provider_error',
        `Monid executed the request, but its provider returned HTTP ${r.providerResponse?.httpStatus}. Do not repeat automatically.`,
      );
    return r;
  }
  async poll(runId: string, c: ToolContext) {
    if (!this.store.operation(c.sessionId, `monid:owned:${runId}`))
      throw new ProviderError(
        'not_owned',
        'Only Monid runs created in this conversation can be read.',
      );
    const suffix = this.http.config.workspaceId
      ? `?workspaceId=${encodeURIComponent(this.http.config.workspaceId)}`
      : '';
    const r = this.check(
      await this.http.request('monid', `/v1/runs/${encodeURIComponent(runId)}${suffix}`, c.signal),
    );
    if (r.runId !== runId)
      throw new ProviderError('invalid_response', 'Monid returned a different run ID.');
    this.store.operationSet(c.sessionId, `monid:owned:${runId}`, 'known', r);
    return r;
  }
}
