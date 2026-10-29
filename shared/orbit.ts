/** Public, bounded Orbit artifacts shared by the agent and workspace. */
import { z } from 'zod';

export const orbitPersonSchema = z.object({
  profile_id: z.string(),
  status: z.enum(['generating', 'enriching', 'ready', 'failed']),
  name: z.string(),
  headline: z.string().optional(),
  location: z.string().optional(),
  bio: z.string().optional(),
  profile_url: z.string().optional(),
  generation_level: z.number().nullable().optional(),
  sections: z.record(z.string(), z.json()).optional(),
  sources: z.array(z.object({ url: z.string(), title: z.string() })).max(12),
});
export const orbitSearchSchema = z.object({
  provider: z.literal('orbit'),
  operation: z.literal('search'),
  request_id: z.string(),
  search_id: z.string(),
  status: z.enum(['running', 'completed', 'completed_with_errors', 'failed']),
  people: z.array(orbitPersonSchema).max(30),
  poll_after_ms: z.number().nonnegative().optional(),
  billing: z
    .object({
      status: z.enum(['open', 'settled']),
      consumed_credits: z.number(),
      held_credits: z.number(),
    })
    .optional(),
});
export const orbitProfileSchema = z.object({
  provider: z.literal('orbit'),
  operation: z.literal('profile'),
  status: z.literal('completed'),
  person: orbitPersonSchema,
});
export type OrbitPerson = z.infer<typeof orbitPersonSchema>;
export type OrbitSearch = z.infer<typeof orbitSearchSchema>;

/** Provider links are data: only render credential-free HTTPS references. */
export function orbitSourceUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}
