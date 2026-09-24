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
import { escapeMarkdown, markdownLinkDestination } from '../markdown-escape.js';

/** The bin carrying the most articles, or `undefined` when there is no bin to choose from. */
function peakBin(bins: Array<{ bin: number; count: number }>): number | undefined {
  return bins.reduce<{ bin: number; count: number } | undefined>(
    (max, b) => (max == null || b.count > max.count ? b : max),
    undefined,
  )?.bin;
}

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
          'phrases, boolean OR, sourcecountry:, sourcelang:, domain:, theme: (GKG theme identifiers ' +
          'come from gdelt_search_themes).',
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
          .optional()
          .describe(
            'Tone bin with the highest count among negative bins (bin < 0). Omitted when no negative bin was returned.',
          ),
        peakPositiveBin: z
          .number()
          .optional()
          .describe(
            'Tone bin with the highest count among positive bins (bin > 0). Omitted when no positive bin was returned.',
          ),
        neutralPct: z
          .number()
          .optional()
          .describe(
            'Percentage of articles in the near-neutral range (bins -2 to +2). Omitted when the histogram counts no articles.',
          ),
      })
      .describe(
        'Summary statistics derived from the histogram. Each value is omitted when the histogram cannot support it — all of them on an empty result.',
      ),
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
      .describe(
        'Guidance when no articles matched in the window — how to broaden the query or extend the ' +
          'window. Absent when tone data was returned.',
      ),
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

    // Compute summary — each value only from bins that support it, never a stand-in default.
    const totalCount = bins.reduce((sum, b) => sum + b.count, 0);
    const neutralCount = bins
      .filter((b) => b.bin >= -2 && b.bin <= 2)
      .reduce((sum, b) => sum + b.count, 0);
    const peakNegativeBin = peakBin(bins.filter((b) => b.bin < 0));
    const peakPositiveBin = peakBin(bins.filter((b) => b.bin > 0));

    const summary = {
      ...(peakNegativeBin != null && { peakNegativeBin }),
      ...(peakPositiveBin != null && { peakPositiveBin }),
      ...(totalCount > 0 && { neutralPct: Math.round((neutralCount / totalCount) * 100) }),
    };

    ctx.enrich.echo(input.query);
    ctx.enrich.total(totalCount);
    ctx.enrich({
      ...(input.startDatetime && { startDatetime: input.startDatetime }),
      ...(input.endDatetime && { endDatetime: input.endDatetime }),
    });

    if (bins.length === 0) {
      ctx.enrich.notice(
        `No tone data for "${input.query}". Broaden the query or extend the time range to include ` +
          'more matching articles.',
      );
    }

    ctx.log.info('gdelt_get_tone_distribution completed', { bins: bins.length, totalCount });
    return { histogram: bins, summary };
  },

  format: (result) => {
    const { peakNegativeBin, peakPositiveBin, neutralPct } = result.summary;
    const lines: string[] = [`## GDELT Tone Distribution`];
    if (peakNegativeBin != null) lines.push(`**Peak negative bin:** ${peakNegativeBin}`);
    if (peakPositiveBin != null) lines.push(`**Peak positive bin:** ${peakPositiveBin}`);
    if (neutralPct != null) lines.push(`**Neutral articles (bins -2 to +2):** ${neutralPct}%`);
    lines.push('\n### Histogram');
    if (result.histogram.length === 0) lines.push('No tone bins returned.');
    for (const b of result.histogram) {
      const bar = '█'.repeat(Math.min(Math.ceil(b.count / 5), 20));
      // The blank line ends the previous bin's article list; without it CommonMark lazy
      // continuation folds this header into that list's last item.
      lines.push(`\n**Bin ${b.bin > 0 ? '+' : ''}${b.bin}:** ${b.count} articles ${bar}`);
      for (const a of b.articles) {
        lines.push(`  - [${escapeMarkdown(a.title)}](${markdownLinkDestination(a.url)})`);
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
