/**
 * @fileoverview GDELT TV context tool. Returns co-occurring words and phrases from
 * TV news clips matching a query — the vocabulary framing a topic on television.
 * @module mcp-server/tools/definitions/get-tv-context.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getGdeltTvService } from '@/services/gdelt/gdelt-tv-service.js';
import {
  describeDateRangeFault,
  describeResolvedTimespan,
  GDELT_DATETIME_PATTERN,
} from '../date-range.js';
import { escapeMarkdown } from '../markdown-escape.js';

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
      reason: 'invalid_date_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Only one of startDatetime / endDatetime was supplied, one of them is not a real UTC calendar timestamp, or startDatetime is not earlier than endDatetime.',
      recovery:
        'Supply both startDatetime and endDatetime as real UTC calendar timestamps, with startDatetime earlier than endDatetime, or omit both and use timespan instead.',
    },
    {
      reason: 'invalid_query',
      code: JsonRpcErrorCode.ValidationError,
      when: 'GDELT rejected the query — no station was selected, or the query string is malformed.',
      recovery:
        'Read the recovery hint for the specific rule GDELT rejected; when no station was selected, list valid IDs with gdelt_list_tv_stations.',
      thrownBy: 'service',
    },
    {
      reason: 'gdelt_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'GDELT rejected the request for its one-request-per-five-seconds limit, or too many requests were already queued for this one to start in time.',
      retryable: false,
      recovery:
        'Wait at least 5 seconds before retrying; GDELT accepts at most one request every 5 seconds.',
      thrownBy: 'service',
    },
    {
      reason: 'gdelt_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'GDELT TV API is unreachable or temporarily returned no usable data.',
      retryable: true,
      recovery: 'Retry after a short delay; GDELT may be temporarily unavailable.',
      thrownBy: 'service',
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
        'Station IDs to filter to (e.g. ["CNN", "FOXNEWS"]). ' +
          'The GDELT TV API requires at least one station — supply it here, or embed a station: ' +
          'selector directly in query. Omitting both is rejected; it does not fall back to all stations. ' +
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
      .regex(GDELT_DATETIME_PATTERN, 'startDatetime must be exactly 14 digits (YYYYMMDDHHMMSS).')
      .optional()
      .describe(
        'Start datetime in GDELT format YYYYMMDDHHMMSS — exactly 14 digits, no separators ' +
          '(e.g. 20200101000000). Must pair with endDatetime; supplying only one of the two is rejected. ' +
          'TV data spans 2009–October 2024.',
      ),
    endDatetime: z
      .string()
      .regex(GDELT_DATETIME_PATTERN, 'endDatetime must be exactly 14 digits (YYYYMMDDHHMMSS).')
      .optional()
      .describe(
        'End datetime in GDELT format YYYYMMDDHHMMSS — exactly 14 digits, no separators ' +
          '(e.g. 20200131235959). Must pair with startDatetime; supplying only one of the two is rejected.',
      ),
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
      .describe(
        'Guidance when no clips matched, so there is no vocabulary to report — the resolved timespan ' +
          'window, the October 2024 archive cutoff, and how to broaden the query or check station ' +
          'coverage. Absent when terms were returned.',
      ),
  },

  async handler(input, ctx) {
    const dateRangeFault = describeDateRangeFault(input.startDatetime, input.endDatetime);
    if (dateRangeFault) {
      throw ctx.fail('invalid_date_range', dateRangeFault, ctx.recoveryFor('invalid_date_range'));
    }

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

    ctx.enrich.echo(input.query);
    if (result.clipsAnalyzed != null) ctx.enrich.total(result.clipsAnalyzed);

    if (result.words.length === 0) {
      ctx.enrich.notice(
        `No TV context data for "${input.query}".${describeResolvedTimespan(input)} TV data ends ` +
          'October 2024 — broaden the query, extend the window, or use gdelt_list_tv_stations to ' +
          'check coverage.',
      );
    }

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
    lines.push('\n### Terms');
    if (result.words.length === 0) lines.push('No terms returned.');
    for (const w of result.words) {
      const bar = '█'.repeat(Math.round(w.score / 5));
      lines.push(`- **${escapeMarkdown(w.label)}**: ${w.score.toFixed(1)} ${bar}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
