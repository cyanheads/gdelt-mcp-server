/**
 * @fileoverview The `windowClamp` enrichment: a time window the caller asked for reached further
 * back than the API searches, and the call ran on the window it does search instead. The window
 * counterpart of `limitClamp`.
 * @module mcp-server/tools/window-clamp
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { createCounter } from '@cyanheads/mcp-ts-core/utils';
import { markdownQuote } from './markdown-escape.js';

/** Resolves its instrument from the running SDK on each record, so module scope is safe. */
const windowClampCounter = createCounter(
  'gdelt.window_clamps',
  'Count requests whose time window was clamped to the API reach.',
);

/** The `windowClamp` enrichment field each window-clamping tool declares. */
export const windowClampSchema = z
  .object({
    parameter: z.enum(['timespan', 'startDatetime']).describe('The window input that was clamped.'),
    requested: z.string().describe('The value the call asked for.'),
    applied: z
      .string()
      .describe('The window the search ran on, in the form of the requested value.'),
  })
  .optional()
  .describe(
    'Present only when the requested window reached further back than the API searches: the search ran on the applied window instead, and every count, notice, and continuation in this response reflects it. Absent when the search ran on the window requested.',
  );

export type WindowClamp = NonNullable<z.infer<typeof windowClampSchema>>;

/** The `windowClamp` line of the `content[]` trailer. */
export function renderWindowClamp(clamp: WindowClamp): string {
  return `**Window clamped:** ${clamp.parameter} ${markdownQuote(clamp.requested)} → ${markdownQuote(clamp.applied)} (beyond the API's reach)`;
}

/** Disclose a clamped window as the `windowClamp` enrichment, and log and count it. */
export function discloseWindowClamp(ctx: Context, clamp: WindowClamp): void {
  ctx.enrich({ windowClamp: clamp });
  ctx.log.info('Window clamped to the API reach.', { ...clamp });
  windowClampCounter.add(1, { parameter: clamp.parameter });
}
