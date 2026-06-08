/**
 * @fileoverview GDELT TV context tool. Returns co-occurring words and phrases from
 * TV news clips matching a query — the vocabulary framing a topic on television.
 * @module mcp-server/tools/definitions/get-tv-context.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { formatDateShort, resolveTimespan } from '@/services/gdelt/gdelt-fetch.js';
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
      .describe(
        'Time window, e.g. "1m", "6m". Ignored when startDatetime/endDatetime are set. ' +
          'TV data spans 2009–October 2024.',
      ),
    startDatetime: z
      .string()
      .optional()
      .describe(
        'Start datetime in GDELT format YYYYMMDDHHMMSS. Must pair with endDatetime. ' +
          'TV data spans 2009–October 2024.',
      ),
    endDatetime: z
      .string()
      .optional()
      .describe('End datetime in GDELT format YYYYMMDDHHMMSS. Must pair with startDatetime.'),
  }),

  output: z.object({
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
  }),

  // Agent-facing context — query echo, clips analyzed, and notice on empty results.
  // Reaches structuredContent and content[] automatically; never in the domain return.
  enrichment: {
    effectiveQuery: z.string().describe('Echoed query string for use in follow-up calls.'),
    totalCount: z
      .number()
      .optional()
      .describe(
        'Number of clips from which co-occurrences were computed. ' +
          'Absent when the upstream API does not return a clip count.',
      ),
    notice: z
      .string()
      .optional()
      .describe('Recovery hint when no context was found. Absent on successful responses.'),
  },

  async handler(input, ctx) {
    ctx.log.info('gdelt_get_tv_context', { query: input.query });
    const svc = getGdeltTvService();

    const result = await svc.getTvContext(
      {
        query: input.query,
        ...(input.stations?.length && { stations: input.stations }),
        ...(input.timespan && { timespan: input.timespan }),
        ...(input.startDatetime && { startDatetime: input.startDatetime }),
        ...(input.endDatetime && { endDatetime: input.endDatetime }),
      },
      ctx,
    );

    if (result.words.length === 0) {
      let rangeNote = '';
      if (input.timespan && !input.startDatetime && !input.endDatetime) {
        const range = resolveTimespan(input.timespan);
        if (range) {
          rangeNote = ` Timespan "${input.timespan}" resolved to ${formatDateShort(range.start)} – ${formatDateShort(range.end)}.`;
        }
      }
      throw ctx.fail('no_context', `No context words for "${input.query}"`, {
        recovery: {
          hint:
            `No TV context data for "${input.query}".${rangeNote} TV data ends October 2024 — ` +
            `broaden the query or use gdelt_list_tv_stations to check coverage.`,
        },
      });
    }

    ctx.enrich.echo(input.query);
    if (result.clipsAnalyzed != null) ctx.enrich.total(result.clipsAnalyzed);

    ctx.log.info('gdelt_get_tv_context completed', { wordCount: result.words.length });
    return {
      words: result.words.sort((a, b) => b.score - a.score),
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## GDELT TV Context`,
      `**Co-occurring terms:** ${result.words.length}`,
    ];
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
