/**
 * @fileoverview GDELT TV context tool. Returns co-occurring words and phrases from
 * TV news clips matching a query — the vocabulary framing a topic on television.
 * @module mcp-server/tools/definitions/get-tv-context.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getGdeltTvService } from '@/services/gdelt/gdelt-tv-service.js';

export const gdeltGetTvContext = tool('gdelt_get_tv_context', {
  title: 'Get GDELT TV Context',
  description:
    'Get the top co-occurring words and phrases from TV news clips matching a query — ' +
    'the vocabulary framing a topic on television. ' +
    'Returns the most frequent non-stopword terms from matching clips, with relative frequency scores ' +
    '(0–100, where 100 = the query term itself). ' +
    'Use to understand narrative framing, identify related concepts mentioned alongside a topic, ' +
    'or generate follow-up search terms. ' +
    'TV data spans 2009–October 2024.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'no_context',
      code: JsonRpcErrorCode.NotFound,
      when: 'No context words found — no clips matched the query.',
      recovery:
        'Broaden the query, extend the timespan, or verify station IDs with gdelt_list_tv_stations.',
    },
    {
      reason: 'gdelt_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'GDELT TV API is unreachable or rate-limited.',
      retryable: true,
      recovery: 'Wait at least 5 seconds before retrying — GDELT enforces 1 request per 5 seconds.',
    },
  ],

  input: z.object({
    query: z
      .string()
      .min(1)
      .describe(
        'Search query for TV transcript content. Same TV operators as gdelt_search_tv: ' +
          'station:CNN, network:CBS, market:"National", show:"Anderson Cooper", context:"vaccine".',
      ),
    stations: z
      .array(z.string())
      .optional()
      .describe(
        'Station IDs to filter to. Omit for all stations. ' +
          'Use gdelt_list_tv_stations to see valid IDs.',
      ),
    timespan: z
      .string()
      .optional()
      .describe('Time window, e.g. "1m", "6m". TV data spans 2009–October 2024.'),
  }),

  output: z.object({
    query: z.string().describe('Echoed query string.'),
    words: z
      .array(
        z
          .object({
            label: z.string().describe('Co-occurring word or phrase.'),
            score: z
              .number()
              .describe(
                'Relative frequency score (0–100). The query term itself scores 100; ' +
                  'other terms are proportional to their co-occurrence frequency.',
              ),
          })
          .describe('A co-occurring term with its relative frequency score.'),
      )
      .describe('Co-occurring terms sorted by score descending.'),
    clipsAnalyzed: z
      .number()
      .describe('Number of matching clips from which co-occurrences were computed.'),
    notice: z
      .string()
      .optional()
      .describe('Recovery hint when no context was found. Absent on successful responses.'),
  }),

  async handler(input, ctx) {
    ctx.log.info('gdelt_get_tv_context', { query: input.query });
    const svc = getGdeltTvService();

    const result = await svc.getTvContext(
      {
        query: input.query,
        ...(input.stations?.length && { stations: input.stations }),
        ...(input.timespan && { timespan: input.timespan }),
      },
      ctx,
    );

    if (result.words.length === 0) {
      throw ctx.fail('no_context', `No context words for "${input.query}"`, {
        recovery: {
          hint:
            `No TV context data for "${input.query}". TV data ends October 2024 — ` +
            `broaden the query or use gdelt_list_tv_stations to check coverage.`,
        },
      });
    }

    ctx.log.info('gdelt_get_tv_context completed', { wordCount: result.words.length });
    return {
      query: input.query,
      words: result.words.sort((a, b) => b.score - a.score),
      clipsAnalyzed: result.clipsAnalyzed,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## GDELT TV Context`,
      `**Query:** ${result.query}`,
      `**Clips analyzed:** ${result.clipsAnalyzed}`,
      `**Co-occurring terms:** ${result.words.length}`,
    ];
    if (result.notice) lines.push(`\n> ${result.notice}`);
    lines.push('\n### Top Terms');
    for (const w of result.words.slice(0, 50)) {
      const bar = '█'.repeat(Math.round(w.score / 5));
      lines.push(`- **${w.label}**: ${w.score.toFixed(1)} ${bar}`);
    }
    if (result.words.length > 50) {
      lines.push(`\n_… ${result.words.length - 50} more terms_`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
