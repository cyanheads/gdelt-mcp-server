/**
 * @fileoverview The `staleResponse` enrichment field every DOC and TV tool declares, and its
 * `content[]` trailer line. The fetch layer writes it when it answers with a stored response
 * after GDELT refused, failed, or answered empty to the refetch.
 * @module mcp-server/tools/stale-response
 */

import { z } from '@cyanheads/mcp-ts-core';

/** The `staleResponse` enrichment field each DOC and TV tool declares. */
export const staleResponseSchema = z
  .object({
    fetchedAt: z.string().describe('ISO 8601 time GDELT returned the stored answer.'),
    ageSeconds: z.number().describe('Age of the stored answer when served, in whole seconds.'),
    reason: z
      .enum(['gdelt_rate_limited', 'gdelt_unavailable', 'gdelt_empty'])
      .describe(
        'Why the refetch was not used: GDELT rate-limited it, did not answer with data, or answered empty — which GDELT also does under load.',
      ),
  })
  .optional()
  .describe(
    "Present only when the refetch of this exact request was refused, failed, or came back empty, and the response is GDELT's stored answer from fetchedAt instead. It holds nothing published after fetchedAt; a relative timespan covers the window ending at fetchedAt, not now. Absent on a live answer.",
  );

export type StaleResponse = NonNullable<z.infer<typeof staleResponseSchema>>;

/** The `staleResponse` line of the `content[]` trailer. */
export function renderStaleResponse(stale: StaleResponse): string {
  const refetch =
    stale.reason === 'gdelt_empty'
      ? 'the refetch came back empty (`gdelt_empty`), which GDELT also does under load'
      : `the refetch failed with \`${stale.reason}\``;
  return `**Stale response:** ${refetch}, so this is GDELT's stored answer from ${stale.fetchedAt} (${stale.ageSeconds}s old) — nothing published after that time is included.`;
}
