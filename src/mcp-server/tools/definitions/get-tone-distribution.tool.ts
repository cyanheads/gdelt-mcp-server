/**
 * @fileoverview GDELT tone distribution tool. Returns a histogram of article tone
 * scores for articles matching a query, revealing emotional distribution of coverage.
 * @module mcp-server/tools/definitions/get-tone-distribution.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getGdeltDocService } from '@/services/gdelt/gdelt-doc-service.js';
import {
  describeDateRangeFault,
  GDELT_DATETIME_PATTERN,
  gdeltDocTimespanSchema,
} from '../date-range.js';

export const gdeltGetToneDistribution = tool('gdelt_get_tone_distribution', {
  title: 'Get GDELT Tone Distribution',
  description:
    'Get the tonal distribution of articles matching a query as a histogram (bins approximately -30 to +30). ' +
    'Unlike a single average tone score, the histogram reveals whether coverage is uniformly negative, ' +
    'bimodal (some articles extremely positive and some extremely negative), or clustered near neutral. ' +
    'Each bin includes representative article URLs. ' +
    'Distinct from gdelt_get_coverage_timeline (mode: tone) — this is a snapshot distribution ' +
    'across all matching articles, not a time series. ' +
    'Use gdelt_get_coverage_timeline with mode "tone" to see how sentiment shifted over time.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'no_tone_data',
      code: JsonRpcErrorCode.NotFound,
      when: 'No tone histogram data returned for the query.',
      recovery: 'Broaden the query or extend the timespan to include more matching articles.',
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
      when: 'GDELT rejected the query string as malformed — bad keyword length, unbalanced parentheses, or an illegal character.',
      recovery:
        'Read the recovery hint for the specific rule GDELT rejected, then fix the query and retry.',
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
      when: 'GDELT DOC API is unreachable or temporarily returned no usable data.',
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
        'Search query using GDELT syntax. Same operators as gdelt_search_articles: ' +
          'phrases, boolean OR, sourcecountry:, sourcelang:, domain:, theme:.',
      ),
    timespan: gdeltDocTimespanSchema
      .optional()
      .describe(
        'Time window relative to now, minimum "15min"; other examples: "24h", "7d", "1m". ' +
          'Ignored when startDatetime/endDatetime are set. Maximum 3 months.',
      ),
    startDatetime: z
      .string()
      .regex(GDELT_DATETIME_PATTERN, 'startDatetime must be exactly 14 digits (YYYYMMDDHHMMSS).')
      .optional()
      .describe(
        'Start datetime in GDELT format YYYYMMDDHHMMSS — exactly 14 digits, no separators ' +
          '(e.g. 20240101000000). Must pair with endDatetime; supplying only one of the two is rejected.',
      ),
    endDatetime: z
      .string()
      .regex(GDELT_DATETIME_PATTERN, 'endDatetime must be exactly 14 digits (YYYYMMDDHHMMSS).')
      .optional()
      .describe(
        'End datetime in GDELT format YYYYMMDDHHMMSS — exactly 14 digits, no separators ' +
          '(e.g. 20240131235959). Must pair with startDatetime; supplying only one of the two is rejected.',
      ),
  }),

  output: z.object({
    histogram: z
      .array(
        z
          .object({
            bin: z.number().describe('Tone bin integer (typically -30 to +30; 0 is neutral).'),
            count: z.number().describe('Number of articles in this bin.'),
            articles: z
              .array(
                z
                  .object({
                    url: z.string().describe('Article URL.'),
                    title: z.string().describe('Article title.'),
                  })
                  .describe('A representative article for this tone bin.'),
              )
              .describe('Representative articles in this tone bin.'),
          })
          .describe('A single tone histogram bin with article count and representative articles.'),
      )
      .describe('Tone histogram sorted from most negative to most positive bin.'),
    summary: z
      .object({
        peakNegativeBin: z
          .number()
          .describe('Tone bin with the highest count among negative bins (bin < 0).'),
        peakPositiveBin: z
          .number()
          .describe('Tone bin with the highest count among positive bins (bin > 0).'),
        neutralPct: z
          .number()
          .describe('Percentage of articles in the near-neutral range (bins -2 to +2).'),
      })
      .describe('Summary statistics derived from the histogram.'),
  }),

  // Agent-facing context — query echo and notice on empty results.
  // Reaches structuredContent and content[] automatically; never in the domain return.
  enrichment: {
    effectiveQuery: z.string().describe('Echoed query string for use in follow-up calls.'),
    totalCount: z.number().describe('Total number of articles across all histogram bins.'),
    startDatetime: z
      .string()
      .optional()
      .describe('Echoed start datetime when provided (YYYYMMDDHHMMSS).'),
    endDatetime: z
      .string()
      .optional()
      .describe('Echoed end datetime when provided (YYYYMMDDHHMMSS).'),
    notice: z
      .string()
      .optional()
      .describe('Recovery hint when no tone data was returned. Absent on successful responses.'),
  },

  async handler(input, ctx) {
    const dateRangeFault = describeDateRangeFault(input.startDatetime, input.endDatetime);
    if (dateRangeFault) {
      throw ctx.fail('invalid_date_range', dateRangeFault, ctx.recoveryFor('invalid_date_range'));
    }

    ctx.log.info('gdelt_get_tone_distribution', { query: input.query });
    const svc = getGdeltDocService();

    const bins = await svc.getToneDistribution(
      {
        query: input.query,
        ...(input.timespan && { timespan: input.timespan }),
        ...(input.startDatetime && { startDatetime: input.startDatetime }),
        ...(input.endDatetime && { endDatetime: input.endDatetime }),
      },
      ctx,
    );

    if (bins.length === 0) {
      throw ctx.fail('no_tone_data', `No tone data for "${input.query}"`, {
        recovery: {
          hint: `No tone data for "${input.query}". Broaden the query or extend the time range.`,
        },
      });
    }

    // Compute summary
    const negativeBins = bins.filter((b) => b.bin < 0);
    const positiveBins = bins.filter((b) => b.bin > 0);
    const neutralBins = bins.filter((b) => b.bin >= -2 && b.bin <= 2);
    const totalCount = bins.reduce((sum, b) => sum + b.count, 0);
    const neutralCount = neutralBins.reduce((sum, b) => sum + b.count, 0);

    const peakNeg = negativeBins.reduce(
      (max, b) => (b.count > max.count ? b : max),
      negativeBins[0] ?? { bin: 0, count: 0, articles: [] },
    );
    const peakPos = positiveBins.reduce(
      (max, b) => (b.count > max.count ? b : max),
      positiveBins[0] ?? { bin: 0, count: 0, articles: [] },
    );

    const summary = {
      peakNegativeBin: peakNeg.bin,
      peakPositiveBin: peakPos.bin,
      neutralPct: totalCount > 0 ? Math.round((neutralCount / totalCount) * 100) : 0,
    };

    ctx.enrich.echo(input.query);
    ctx.enrich.total(totalCount);
    ctx.enrich({
      ...(input.startDatetime && { startDatetime: input.startDatetime }),
      ...(input.endDatetime && { endDatetime: input.endDatetime }),
    });

    ctx.log.info('gdelt_get_tone_distribution completed', { bins: bins.length, totalCount });
    return { histogram: bins, summary };
  },

  format: (result) => {
    const lines: string[] = [
      `## GDELT Tone Distribution`,
      `**Peak negative bin:** ${result.summary.peakNegativeBin}`,
      `**Peak positive bin:** ${result.summary.peakPositiveBin}`,
      `**Neutral articles (bins -2 to +2):** ${result.summary.neutralPct}%`,
    ];
    lines.push('\n### Histogram');
    for (const b of result.histogram) {
      const bar = '█'.repeat(Math.min(Math.ceil(b.count / 5), 20));
      lines.push(`**Bin ${b.bin > 0 ? '+' : ''}${b.bin}:** ${b.count} articles ${bar}`);
      for (const a of b.articles) {
        lines.push(`  - [${a.title}](${a.url})`);
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
