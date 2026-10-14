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
import {
  escapeMarkdown,
  markdownLinkDestination,
  markdownQuote,
  renderQueryEcho,
} from '../markdown-escape.js';
import { pageByOffset, recordCharge } from '../response-budget.js';

/**
 * Representative article links carried per bin, on both surfaces, for bins the caller did not
 * name in `bins`. GDELT returns up to 10 per bin across as many as 61 bins, so each bin keeps its
 * first 3 beside `referenceCount`, its true total, and `bins` returns the named bins in full.
 */
const ARTICLES_PER_BIN = 3;

const BIN_NOUN = { singular: 'bin', plural: 'bins' };

type HistogramBin = {
  bin: number;
  count: number;
  articles: Array<{ url: string; title: string }>;
  referenceCount: number;
};

/** One bin's header and article links — the block format() renders and the budget charges. */
function renderBin(b: HistogramBin): string {
  const bar = '█'.repeat(Math.min(Math.ceil(b.count / 5), 20));
  const shown =
    b.referenceCount > b.articles.length
      ? `(${b.articles.length} of ${b.referenceCount} links shown)`
      : '';
  // The blank line ends the previous bin's article list; without it CommonMark lazy
  // continuation folds this header into that list's last item.
  const header = [`**Bin ${b.bin > 0 ? '+' : ''}${b.bin}:** ${b.count} articles`, bar, shown]
    .filter(Boolean)
    .join(' ');
  const lines = [`\n${header}`];
  for (const a of b.articles) {
    lines.push(`  - [${escapeMarkdown(a.title)}](${markdownLinkDestination(a.url)})`);
  }
  return lines.join('\n');
}

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
    'Each bin carries its first 3 representative article links and referenceCount, how many GDELT returned; ' +
    'name bins in the bins input to get only those bins, each with every link. ' +
    'A response carries as many whole bins as fit its size budget; when more remain it returns nextOffset — ' +
    'pass it back as offset with otherwise identical inputs for the next page. ' +
    'Distinct from gdelt_get_coverage_timeline (mode: tone) — this is a snapshot distribution ' +
    'across all matching articles, not a time series. ' +
    'Use gdelt_get_coverage_timeline with mode "tone" to see how sentiment shifted over time.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'unknown_bin',
      code: JsonRpcErrorCode.NotFound,
      when: 'A value passed in the bins input matches no bin in a non-empty histogram.',
      recovery:
        'Read the bins listed in the error and retry bins with exact matches from that list.',
    },
    {
      reason: 'offset_out_of_range',
      code: JsonRpcErrorCode.NotFound,
      when: 'The requested offset is at or beyond the last bin of a non-empty histogram, or of the bins named in bins.',
      recovery:
        'Retry with an offset inside the range the error names, or with nextOffset from the preceding response.',
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
    bins: z
      .array(z.number().int())
      .optional()
      .describe(
        'Tone bins to return alone, e.g. [-7, 4]. Take them from histogram[].bin in a prior response, or ' +
          'from the list an unknown_bin error prints. The response then carries only these bins, in ' +
          'histogram order, each with every representative article link instead of the first 3. A value ' +
          'matching no bin is rejected rather than silently ignored.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Zero-based bin offset — into the histogram, or into the bins named in bins. Pass nextOffset ' +
          'from the preceding response, with otherwise identical inputs, to get the next page.',
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
              .describe(
                'Representative articles in this tone bin — the first 3, or all of them for a bin named in bins.',
              ),
            referenceCount: z
              .number()
              .describe(
                'How many representative articles GDELT returned for this bin; articles carries the first 3 ' +
                  'unless the bin was named in bins.',
              ),
          })
          .describe('A single tone histogram bin with article count and representative articles.'),
      )
      .describe(
        'The bins of this page, sorted from most negative to most positive — the whole histogram when it fits.',
      ),
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
        'Summary statistics derived from the whole histogram, not this page. Each value is omitted when the histogram cannot support it — all of them on an empty result.',
      ),
    nextOffset: z
      .number()
      .optional()
      .describe(
        'Offset of the next page, for the same inputs. Absent when this page reaches the last bin.',
      ),
  }),

  // Agent-facing context — query echo and the empty-result or paging notice.
  // Reaches structuredContent and content[] automatically; never in the domain return.
  enrichment: {
    effectiveQuery: z.string().describe('Echoed query string for use in follow-up calls.'),
    totalCount: z
      .number()
      .describe('Total number of articles across all histogram bins, not only this page.'),
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
          'window — or, when this response is one page of several, which bins it returned out of how ' +
          'many. Absent when the whole histogram fit in one response.',
      ),
  },

  enrichmentTrailer: {
    effectiveQuery: { render: renderQueryEcho },
  },

  async handler(input, ctx) {
    const dateRangeFault = describeDateRangeFault(input.startDatetime, input.endDatetime);
    if (dateRangeFault) {
      throw ctx.fail('invalid_date_range', dateRangeFault);
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

    const isEmpty = bins.length === 0;
    // An empty histogram has no bins to name, so there a bins selection is moot, not wrong.
    const named = !isEmpty && input.bins?.length ? new Set(input.bins) : undefined;

    // A bins value that matches no bin would return nothing for it and say nothing — reject it.
    if (named) {
      const available = new Set(bins.map((b) => b.bin));
      const unknown = [...named].filter((bin) => !available.has(bin));
      if (unknown.length > 0) {
        const listed = unknown.join(', ');
        throw ctx.fail('unknown_bin', `No tone bin ${listed}`, {
          unknownBins: unknown,
          recovery: {
            hint: `This histogram has no bin ${listed}. Available: ${[...available].join(', ')}.`,
          },
        });
      }
    }

    // The pageable units: every bin, or only the named ones. A named bin keeps every
    // representative article; any other keeps the first ARTICLES_PER_BIN.
    const units: HistogramBin[] = bins
      .filter((b) => !named || named.has(b.bin))
      .map((b) => ({
        bin: b.bin,
        count: b.count,
        articles: named ? b.articles : b.articles.slice(0, ARTICLES_PER_BIN),
        referenceCount: b.articles.length,
      }));

    // An empty histogram has no offsets at all, so no offset can be out of its range.
    if (!isEmpty && input.offset >= units.length) {
      const scope = named
        ? `the bins input selects ${units.length} bins`
        : `this histogram has ${units.length} bins`;
      throw ctx.fail('offset_out_of_range', `Offset ${input.offset} is past the last bin`, {
        offset: input.offset,
        totalBins: units.length,
        recovery: { hint: `Retry with offset 0–${units.length - 1}; ${scope}.` },
      });
    }

    const page = isEmpty
      ? undefined
      : pageByOffset(units, (b) => recordCharge(b, renderBin(b)), input.offset, BIN_NOUN);
    const histogram = page ? units.slice(input.offset, page.end) : [];

    ctx.enrich.echo(input.query);
    ctx.enrich.total(totalCount);
    ctx.enrich({
      ...(input.startDatetime && { startDatetime: input.startDatetime }),
      ...(input.endDatetime && { endDatetime: input.endDatetime }),
    });

    // Every notice segment for this response accumulates here and is flushed once —
    // ctx.enrich.notice is last-wins, so a second call would silently drop the first.
    const notices: string[] = [];
    if (isEmpty) {
      notices.push(
        `No tone data for ${markdownQuote(input.query)}. Broaden the query or extend the time range to include ` +
          'more matching articles.',
      );
      if (input.bins?.length) {
        notices.push('The bins input was not applied — this histogram has no bins.');
      }
    }
    if (page?.notice) notices.push(page.notice);
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    ctx.log.info('gdelt_get_tone_distribution completed', {
      bins: bins.length,
      returnedBins: histogram.length,
      totalCount,
    });
    return {
      histogram,
      summary,
      ...(page?.nextOffset != null && { nextOffset: page.nextOffset }),
    };
  },

  format: (result) => {
    const { peakNegativeBin, peakPositiveBin, neutralPct } = result.summary;
    const lines: string[] = [`## GDELT Tone Distribution`];
    if (peakNegativeBin != null) lines.push(`**Peak negative bin:** ${peakNegativeBin}`);
    if (peakPositiveBin != null) lines.push(`**Peak positive bin:** ${peakPositiveBin}`);
    if (neutralPct != null) lines.push(`**Neutral articles (bins -2 to +2):** ${neutralPct}%`);
    if (result.histogram.some((b) => b.referenceCount > b.articles.length)) {
      lines.push(
        `**Article links:** first ${ARTICLES_PER_BIN} per bin, with each bin's true total beside it. ` +
          "Re-call with bins: [<bin>] to get a bin's full list.",
      );
    }
    if (result.nextOffset != null) lines.push(`**Next offset:** ${result.nextOffset}`);
    lines.push('\n### Histogram');
    if (result.histogram.length === 0) lines.push('No tone bins returned.');
    for (const b of result.histogram) lines.push(renderBin(b));
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
