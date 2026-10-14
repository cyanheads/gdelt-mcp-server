/**
 * @fileoverview Per-call cap clamping for the count inputs that carry one (`maxRecords`,
 * `limit`): a request above the cap — up to {@link CLAMP_HEADROOM} times it — runs exactly as a
 * request at the cap and discloses the clamp, instead of failing as invalid arguments.
 * @module mcp-server/tools/limit-clamp
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';

/**
 * How far past its per-call cap a count input is still accepted, as a multiple of the cap.
 * Up to it the value is clamped to the cap; past it the schema rejects the call, which keeps a
 * hard ceiling against absurd input.
 */
export const CLAMP_HEADROOM = 10;

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
  return cap;
}
