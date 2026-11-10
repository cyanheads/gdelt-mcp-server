/**
 * @fileoverview Count validation and observable per-call cap clamping.
 * @module mcp-server/tools/limit-clamp
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { createCounter } from '@cyanheads/mcp-ts-core/utils';
import { getServerConfig } from '../../config/server-config.js';

/** Resolve after startup configuration and .env loading, without parsing config during imports. */
export function countInputSchema(cap: number, defaultValue: number, description: string) {
  return z
    .lazy(() => {
      const count = z
        .number()
        .min(1)
        .multipleOf(1)
        .refine(Number.isSafeInteger, 'Count must be a safe integer.');
      return (getServerConfig().clampLimits ? count : count.max(cap)).default(defaultValue);
    })
    .describe(description);
}

/** Resolves its instrument from the running SDK on each record, so module scope is safe. */
const clampCounter = createCounter(
  'gdelt.limit_clamps',
  'Count requests clamped to the per-call cap.',
);

/** The `limitClamp` enrichment field each clamping tool declares. */
export const limitClampSchema = z
  .object({
    parameter: z.enum(['maxRecords', 'limit']).describe('The count input that was clamped.'),
    requested: z.number().describe('The value the call asked for.'),
    applied: z.number().describe('The per-call cap the call ran with instead.'),
  })
  .optional()
  .describe(
    'Present only when the requested count exceeded the per-call cap: the call ran exactly as a ' +
      'call at the cap, and every count, notice, and continuation in this response reflects the ' +
      'applied value.',
  );

type LimitClamp = NonNullable<z.infer<typeof limitClampSchema>>;

/** The `limitClamp` line of the `content[]` trailer. */
export function renderLimitClamp(clamp: LimitClamp): string {
  return `**Limit clamped:** ${clamp.parameter} ${clamp.requested} → ${clamp.applied} (per-call cap)`;
}

/**
 * Clamp a count input to its per-call cap and return the value the call runs with. A clamped
 * value is disclosed as the `limitClamp` enrichment; a value at or below the cap passes through
 * with nothing recorded.
 */
export function clampToCap(
  ctx: Context,
  parameter: LimitClamp['parameter'],
  requested: number,
  cap: number,
): number {
  if (requested <= cap) return requested;
  ctx.enrich({ limitClamp: { parameter, requested, applied: cap } satisfies LimitClamp });
  ctx.log.info('Count clamped to its per-call cap.', { parameter, requested, applied: cap });
  clampCounter.add(1, { parameter });
  return cap;
}
