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
  describeTvTimespanFault,
  GDELT_DATETIME_PATTERN,
  resolveEffectiveWindow,
} from '../date-range.js';
import {
  clampToCap,
  countInputSchema,
  limitClampSchema,
  renderLimitClamp,
} from '../limit-clamp.js';
import { escapeMarkdown, markdownQuote, renderQueryEcho } from '../markdown-escape.js';
import { renderStaleResponse, staleResponseSchema } from '../stale-response.js';
import { describeStationRangeMisses, parseStationIds } from '../station-ids.js';

/**
 * The population GDELT computes the word cloud from. Its TV API documentation names the 200
 * most relevant matching clips; GDELT reports no analyzed-clip count beside the terms, so the
 * size is cited as documented rather than stated as something this server enforces.
 */
const SAMPLE_SCOPE =
  "GDELT's relevance-ranked sample of matching clips, documented as the 200 most relevant, not " +
  'all matching coverage';

/** The disclosure every non-empty result carries, and the descriptions repeat. */
const SAMPLING_NOTICE =
  `Terms and scores come from ${SAMPLE_SCOPE} — compare windows or stations with a separate, ` +
  'narrower call for each.';

export const gdeltGetTvContext = tool('gdelt_get_tv_context', {
  title: 'Get GDELT TV Context',
  description:
    'Get the top co-occurring words and phrases from TV news clips matching a query — ' +
    'the vocabulary framing a topic on television. ' +
    'Returns the most frequent non-stopword terms with relative frequency scores ' +
    `(0–100, where 100 = the query term itself). ${SAMPLING_NOTICE} ` +
    'Use to understand narrative framing, identify related concepts mentioned alongside a topic, ' +
    'or generate follow-up search terms. ' +
    'Returns 25 terms by default, with count pages up to 25,000 terms. Archive coverage varies by station; check gdelt_list_tv_stations for each station’s monitoring date range.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'offset_out_of_range',
      code: JsonRpcErrorCode.NotFound,
      when: 'The requested term offset is at or beyond the end of a non-empty result.',
      recovery: 'Retry with an offset between 0 and totalTerms - 1 from the preceding response.',
    },
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
      when: 'A stations entry is not a station ID, GDELT rejected the query — no station was selected, or the query string is malformed — or the TV timespan is malformed.',
      recovery:
        'Read the recovery hint for the specific rule GDELT rejected; when no station was selected, list valid IDs with gdelt_list_tv_stations.',
      thrownBy: 'service',
    },
    {
      reason: 'gdelt_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'GDELT rejected the request for its one-request-per-five-seconds limit, or too many requests were already queued for this one to start in time.',
      retryable: true,
      recovery:
        'Back off before retrying; five seconds is minimum request spacing, not a recovery guarantee, and rate limiting may persist longer. Honor Retry-After when supplied.',
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
        'Station IDs to filter to (e.g. ["CNN", "FOXNEWS"]) — the stationId values gdelt_list_tv_stations returns, not display labels such as "FOX News". Alternatively use station:, network:, or quoted market: selectors in query; a selector is required. Obtain network and market values and per-station archive ranges from gdelt_list_tv_stations.',
      ),
    limit: countInputSchema(
      25_000,
      25,
      'Maximum score-sorted terms returned per page (default 25, cap 25,000). Larger counts clamp with limitClamp; strict deployments reject them.',
    ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Zero-based term offset in descending score order. Use nextOffset with the same query inputs for the next page.',
      ),
    timespan: z
      .string()
      .optional()
      .describe(
        "Relative window counting back from now (a number and unit such as d, m, or y). Now is past the end of most stations' monitoring, so for archived periods set startDatetime/endDatetime inside a station's range from gdelt_list_tv_stations. Ignored when startDatetime/endDatetime are set.",
      ),
    startDatetime: z
      .string()
      .regex(GDELT_DATETIME_PATTERN, 'startDatetime must be exactly 14 digits (YYYYMMDDHHMMSS).')
      .optional()
      .describe(
        'Start datetime in GDELT format YYYYMMDDHHMMSS — exactly 14 digits, no separators ' +
          '(e.g. 20200101000000). Must pair with endDatetime; supplying only one of the two is rejected. ' +
          'Check station monitoring dates with gdelt_list_tv_stations.',
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
    truncated: z
      .boolean()
      .describe('True when more terms remain after this page; use nextOffset to retrieve them.'),
    totalTerms: z
      .number()
      .describe('Total co-occurring terms before pagination; never a clip count.'),
    offset: z.number().describe('Zero-based offset of this term page.'),
    nextOffset: z
      .number()
      .optional()
      .describe('Offset of the next term page; absent on the final page.'),
    words: z
      .array(
        z
          .object({
            label: z.string().describe('Co-occurring word or phrase.'),
            score: z
              .number()
              .describe(
                'Relative frequency score (0–100). The query term itself scores 100; other terms ' +
                  `are proportional to their co-occurrence frequency within ${SAMPLE_SCOPE}.`,
              ),
          })
          .describe('A co-occurring term with its relative frequency score.'),
      )
      .describe(`Co-occurring terms from ${SAMPLE_SCOPE}, sorted by score descending.`),
  }),

  // Agent-facing context — query echo, count clamp, and sampling or no-data notice.
  // Reaches structuredContent and content[] automatically; never in the domain return.
  enrichment: {
    effectiveQuery: z.string().describe('Echoed query string for use in follow-up calls.'),
    limitClamp: limitClampSchema,
    notice: z
      .string()
      .optional()
      .describe(
        `On every non-empty result, that terms and scores come from ${SAMPLE_SCOPE} — compare windows or stations with a separate, narrower call for each. When no clips matched, so there is no vocabulary to report: the resolved timespan window; for each selected station whose monitoring range the window misses, that range and how to search inside it; and how to broaden the query or check station monitoring dates.`,
      ),
    staleResponse: staleResponseSchema,
  },

  enrichmentTrailer: {
    effectiveQuery: { render: renderQueryEcho },
    limitClamp: { render: renderLimitClamp },
    staleResponse: { render: renderStaleResponse },
  },

  async handler(input, ctx) {
    const startedAt = Date.now();
    const stationIds = parseStationIds(input.stations);
    const dateRangeFault = describeDateRangeFault(input.startDatetime, input.endDatetime);
    if (dateRangeFault) {
      throw ctx.fail('invalid_date_range', dateRangeFault);
    }
    const timespanFault = describeTvTimespanFault(input);
    if (timespanFault) {
      throw ctx.fail('invalid_query', 'Invalid TV timespan.', {
        recovery: { hint: timespanFault },
      });
    }

    ctx.log.info('gdelt_get_tv_context', { query: input.query });
    const svc = getGdeltTvService();

    const result = await svc.getTvContext(
      {
        query: input.query,
        ...(stationIds.length > 0 && { stations: stationIds }),
        ...(input.timespan && { timespan: input.timespan }),
        ...(input.startDatetime && { startDatetime: input.startDatetime }),
        ...(input.endDatetime && { endDatetime: input.endDatetime }),
      },
      ctx,
    );

    ctx.enrich.echo(input.query);
    const limit = clampToCap(ctx, 'limit', input.limit, 25_000);
    const totalTerms = result.words.length;
    if (totalTerms > 0 && input.offset >= totalTerms) {
      throw ctx.fail('offset_out_of_range', `Offset ${input.offset} is outside these terms.`, {
        offset: input.offset,
        totalTerms,
        recovery: {
          hint: `Retry with offset 0–${totalTerms - 1}; this result has ${totalTerms} terms.`,
        },
      });
    }
    const words = result.words
      .toSorted((a, b) => b.score - a.score)
      .slice(input.offset, input.offset + limit);
    const nextOffset =
      input.offset + words.length < totalTerms ? input.offset + words.length : undefined;

    if (result.words.length === 0) {
      const window = resolveEffectiveWindow(input);
      const ranges =
        window && stationIds.length > 0 ? await svc.stationRanges(ctx, startedAt) : undefined;
      const rangeMisses =
        window && ranges ? describeStationRangeMisses(stationIds, ranges, window) : '';
      ctx.enrich.notice(
        `No TV context data for ${markdownQuote(input.query)}.${describeResolvedTimespan(input)}${rangeMisses} Archive coverage varies by station — verify monitoring dates with gdelt_list_tv_stations and choose a matching window, or broaden the query.`,
      );
    } else {
      ctx.enrich.notice(SAMPLING_NOTICE);
    }

    ctx.log.info('gdelt_get_tv_context completed', { wordCount: result.words.length });
    return {
      words,
      truncated: nextOffset != null,
      totalTerms,
      offset: input.offset,
      ...(nextOffset != null && { nextOffset }),
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## GDELT TV Context`,
      `**Co-occurring terms:** ${result.words.length}`,
      `**Term page:** offset ${result.offset}, total ${result.totalTerms}`,
      `**Truncated:** ${result.truncated}`,
    ];
    if (result.nextOffset != null) lines.push(`**Next offset:** ${result.nextOffset}`);
    lines.push('\n### Terms');
    if (result.words.length === 0) lines.push('No terms returned.');
    for (const w of result.words) {
      const bar = '█'.repeat(Math.round(w.score / 5));
      lines.push(`- **${escapeMarkdown(w.label)}**: ${w.score} ${bar}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
