/**
 * @fileoverview GDELT coverage breakdown tool. Breaks down coverage volume by source
 * language or source country over time using the GDELT DOC API.
 * @module mcp-server/tools/definitions/get-coverage-breakdown.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { inferDateResolution } from '@/services/gdelt/date-resolution.js';
import { getGdeltDocService } from '@/services/gdelt/gdelt-doc-service.js';
import {
  describeDateRangeFault,
  GDELT_DATETIME_PATTERN,
  gdeltDocTimespanSchema,
} from '../date-range.js';
import { escapeMarkdown, markdownQuote, renderQueryEcho } from '../markdown-escape.js';
import { pageByOffset, recordCharge } from '../response-budget.js';

/** Series ranked into the topSeries overview; the rest are named in otherSeriesLabels. */
const MAX_SERIES = 10;

const SERIES_NOUN = { singular: 'series', plural: 'series' };

/**
 * One language or country coverage series. Shared by the ranked `topSeries` overview and
 * the `selectedSeries` arm so a label retrieved by name carries the identical shape it
 * would have had inside the top 10.
 */
const breakdownSeriesSchema = z
  .object({
    label: z.string().describe('Series label (language name or country name).'),
    data: z
      .array(
        z
          .object({
            date: z.string().describe('Timestep in ISO 8601 format.'),
            value: z
              .number()
              .describe(
                "Normalized coverage volume at this timestep — the topic's share of this " +
                  "source's media output, not an absolute article count.",
              ),
          })
          .describe('A single data point for this series.'),
      )
      .describe('Time-ordered data points for this series.'),
  })
  .describe('A single language or country coverage series.');

/**
 * Render one series in full — header with its ranking key (the sum of its values, which ranks
 * series but is not itself a share of anything), peak, and every data point.
 */
function renderSeries(series: z.infer<typeof breakdownSeriesSchema>): string[] {
  const sum = series.data.reduce((acc, d) => acc + d.value, 0);
  const peak = series.data.reduce(
    (max, d) => (d.value > max.value ? d : max),
    series.data[0] ?? { date: '', value: 0 },
  );
  const lines = [
    `\n### ${escapeMarkdown(series.label)} (sum of values: ${sum.toFixed(2)})`,
    `Data points: ${series.data.length}`,
  ];
  if (peak.date) lines.push(`Peak: ${peak.value.toFixed(3)} at ${escapeMarkdown(peak.date)}`);
  for (const d of series.data) lines.push(renderPoint(d));
  return lines;
}

/** The otherSeriesLabels block — rendered on every overview page, so charged before any series. */
function renderOtherLabels(labels: readonly string[]): string[] {
  return [
    `\n### Series beyond the top ${MAX_SERIES} (${labels.length})`,
    `Ranked by sum of values. Re-call with series: ["<label>"] to get any of them in full.`,
    ...labels.map((label) => `- ${escapeMarkdown(label, 'line-start')}`),
  ];
}

/** One `- date: value` list line; the upstream date is the list item's first text. */
function renderPoint(point: { date: string; value: number }): string {
  return `- ${escapeMarkdown(point.date, 'line-start')}: ${point.value.toFixed(3)}`;
}

export const gdeltGetCoverageBreakdown = tool('gdelt_get_coverage_breakdown', {
  title: 'Get GDELT Coverage Breakdown',
  description:
    'Break down news coverage volume over time by source language or source country, returning a ' +
    'multi-series time series (one series per language or country). ' +
    'Shows which countries or languages drove early vs. late coverage — useful for tracing how a ' +
    'story propagated geographically or across language communities. ' +
    'Returns the top 10 series ranked by the sum of their values and names every other series under ' +
    'otherSeriesLabels — pass any labels, ranked or not, as the series input to get only those series, complete. ' +
    'A response carries as many whole series as fit its size budget; when more remain it returns nextOffset — ' +
    'pass it back as offset with otherwise identical inputs for the next page. ' +
    "Values are normalized: each point is the topic's share of that source's media output, not an absolute " +
    'article count, so values from different sources do not add up to a share. ' +
    'Small media markets with concentrated coverage therefore rank above large markets with diverse output — ' +
    "a high value means the topic dominated that source's coverage, not that it published the most articles. " +
    'Use breakdownBy "country" with the signal-detection chain to map geographic attention, ' +
    'or "language" to detect non-English media surges.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'unknown_series',
      code: JsonRpcErrorCode.NotFound,
      when: 'A label passed in the series input matches no series in a non-empty breakdown.',
      recovery:
        'Read the labels listed in the error and retry series with exact matches from that list.',
    },
    {
      reason: 'offset_out_of_range',
      code: JsonRpcErrorCode.NotFound,
      when: 'The requested offset is at or beyond the last series of a non-empty overview (the top 10), or of the series named in series.',
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
    breakdownBy: z
      .enum(['language', 'country'])
      .describe(
        'Breakdown dimension: "language" for source language time series, ' +
          '"country" for source country time series.',
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
    series: z
      .array(z.string())
      .optional()
      .describe(
        'Exact series labels to return instead of the ranked overview, e.g. ["Portuguese", "Vietnamese"]. ' +
          'Take them verbatim from otherSeriesLabels or topSeries[].label in a response, or from the label ' +
          'list an unknown_series error prints. Each one comes back complete under selectedSeries, in the ' +
          'order requested; a label that matches nothing is rejected rather than silently skipped. Omit to ' +
          'get the ranked overview.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Zero-based series offset — into the ranked top 10, or into the series named in series. Pass ' +
          'nextOffset from the preceding response, with otherwise identical inputs, to get the next page.',
      ),
  }),

  output: z.object({
    dateResolution: z
      .enum(['15min', 'hour', 'day'])
      .optional()
      .describe(
        'Temporal resolution of data points — 15min, hour, or day — inferred from the spacing of the ' +
          'returned timesteps. Omitted when fewer than two distinct timesteps came back.',
      ),
    topSeries: z
      .array(breakdownSeriesSchema)
      .optional()
      .describe(
        'The ranked overview: the top 10 series by the sum of their values, those of this page in rank ' +
          'order. Omitted when the series input selects series instead.',
      ),
    otherSeriesLabels: z
      .array(z.string())
      .optional()
      .describe(
        'Label of every series beyond the top 10, ranked by the sum of its values, on every overview page. ' +
          "Pass any of them to the series input to retrieve that series' complete data. Omitted when all " +
          'series fit in the top 10, or when the series input selects series instead.',
      ),
    selectedSeries: z
      .array(breakdownSeriesSchema)
      .optional()
      .describe(
        'Complete, untruncated time series for the labels requested via the series input — those of this ' +
          'page, in the order requested. Omitted when series was not supplied.',
      ),
    nextOffset: z
      .number()
      .optional()
      .describe(
        'Offset of the next page, for the same inputs. Absent when this page reaches the last series.',
      ),
  }),

  // Agent-facing context — query echo, breakdown dimension, total series count, and the
  // empty-result or paging notice. Reaches structuredContent and content[] automatically; never
  // in the domain return.
  enrichment: {
    effectiveQuery: z.string().describe('Echoed query string for use in follow-up calls.'),
    breakdownBy: z
      .enum(['language', 'country'])
      .describe('Breakdown dimension used for this response.'),
    totalCount: z
      .number()
      .describe('Total number of series GDELT returned, before ranking into the top 10 or paging.'),
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
        'Guidance when the query matched no coverage in the window — how to broaden the query or ' +
          'extend the window — or, when this response is one page of several, which series it ' +
          'returned out of how many. Absent when every series fit in one response.',
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

    ctx.log.info('gdelt_get_coverage_breakdown', {
      query: input.query,
      breakdownBy: input.breakdownBy,
    });
    const svc = getGdeltDocService();

    const modeMap = {
      language: 'timelinelang',
      country: 'timelinesourcecountry',
    } as const;

    const allSeries = await svc.getBreakdown(
      {
        query: input.query,
        mode: modeMap[input.breakdownBy],
        ...(input.timespan && { timespan: input.timespan }),
        ...(input.startDatetime && { startDatetime: input.startDatetime }),
        ...(input.endDatetime && { endDatetime: input.endDatetime }),
      },
      ctx,
    );

    const isEmpty = allSeries.every((s) => s.data.length === 0);

    // Rank by the sum of each series' values, descending. The sum is only a ranking key: the
    // values are shares of different sources' output, so no sum of them is itself a share.
    const sorted = allSeries
      .map((s) => ({ s, sum: s.data.reduce((acc, d) => acc + d.value, 0) }))
      .sort((a, b) => b.sum - a.sum)
      .map(({ s }) => s);

    const topSeries = sorted.slice(0, MAX_SERIES);
    const otherSeriesLabels =
      sorted.length > MAX_SERIES ? sorted.slice(MAX_SERIES).map((s) => s.label) : undefined;

    // Label selection re-filters the same complete upstream set the ranking sliced, so a
    // series named on a follow-up call reconstructs statelessly from query + dimension + label.
    // An empty breakdown has no labels to name, so there a selection is moot, not wrong.
    const isSelection = !isEmpty && (input.series?.length ?? 0) > 0;
    const selectedSeries: Array<z.infer<typeof breakdownSeriesSchema>> = [];
    if (isSelection) {
      const byLabel = new Map(allSeries.map((s) => [s.label, s]));
      const unknown: string[] = [];
      for (const label of input.series ?? []) {
        const match = byLabel.get(label);
        if (match) selectedSeries.push(match);
        else unknown.push(label);
      }
      if (unknown.length > 0) {
        const named = unknown.map(markdownQuote).join(', ');
        const labels = sorted.map((s) => escapeMarkdown(s.label)).join(', ');
        throw ctx.fail('unknown_series', `No ${input.breakdownBy} series named ${named}`, {
          unknownLabels: unknown,
          recovery: {
            hint:
              `This breakdown has no ${input.breakdownBy} series named ${named}. Labels are exact and ` +
              `case-sensitive. Available for ${markdownQuote(input.query)}: ${labels}.`,
          },
        });
      }
    }

    // The pageable units: the selected series in requested order, or the ranked top 10, whose
    // pages each carry otherSeriesLabels — charged before any series.
    const units = isSelection ? selectedSeries : topSeries;
    if (!isEmpty && input.offset >= units.length) {
      const scope = isSelection
        ? `the series input names ${units.length} series`
        : `the ranked overview holds ${units.length} series`;
      throw ctx.fail('offset_out_of_range', `Offset ${input.offset} is past the last series`, {
        offset: input.offset,
        totalSeries: units.length,
        recovery: { hint: `Retry with offset 0–${units.length - 1}; ${scope}.` },
      });
    }
    const overviewLabels = isSelection ? undefined : otherSeriesLabels;
    const page = isEmpty
      ? undefined
      : pageByOffset(
          units,
          (s) => recordCharge(s, renderSeries(s).join('\n')),
          input.offset,
          SERIES_NOUN,
          overviewLabels
            ? recordCharge(overviewLabels, renderOtherLabels(overviewLabels).join('\n'))
            : 0,
        );
    const pageSeries = page ? units.slice(input.offset, page.end) : units;

    const allDates = allSeries.flatMap((s) => s.data.map((d) => d.date));
    const dateResolution = inferDateResolution(allDates);

    ctx.enrich.echo(input.query);
    ctx.enrich.total(allSeries.length);
    ctx.enrich({
      breakdownBy: input.breakdownBy,
      ...(input.startDatetime && { startDatetime: input.startDatetime }),
      ...(input.endDatetime && { endDatetime: input.endDatetime }),
    });

    // Every notice segment for this response accumulates here and is flushed once —
    // ctx.enrich.notice is last-wins, so a second call would silently drop the first.
    const notices: string[] = [];
    if (isEmpty) {
      notices.push(
        `No breakdown data for ${markdownQuote(input.query)}. Broaden the query, extend the time window, or ` +
          'verify the query operators are correct.',
      );
      if (input.series?.length) {
        notices.push('The series input was not applied — this breakdown has no series.');
      }
    }
    if (page?.notice) notices.push(page.notice);
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    ctx.log.info('gdelt_get_coverage_breakdown completed', {
      totalSeries: allSeries.length,
      returnedSeries: pageSeries.length,
      selection: isSelection,
    });

    return {
      ...(dateResolution && { dateResolution }),
      ...(isSelection ? { selectedSeries: pageSeries } : { topSeries: pageSeries }),
      ...(overviewLabels && { otherSeriesLabels: overviewLabels }),
      ...(page?.nextOffset != null && { nextOffset: page.nextOffset }),
    };
  },

  /**
   * Every arm renders on its own field presence, never as an `if`/`else if` chain — the
   * format-parity linter populates all optional fields at once in its synthetic sample,
   * so a mutually-exclusive branch would leave the untaken arm unverified.
   */
  format: (result) => {
    const lines: string[] = [`## GDELT Coverage Breakdown`];
    if (result.dateResolution) lines.push(`**Date Resolution:** ${result.dateResolution}`);
    lines.push(
      `**Values:** normalized — each value is the topic's share of that source's media output, ` +
        `not an article count. Small media markets with concentrated coverage rank above large ` +
        `markets with diverse output.`,
    );
    if (result.nextOffset != null) lines.push(`**Next offset:** ${result.nextOffset}`);
    if (result.topSeries?.every((s) => s.data.length === 0)) {
      lines.push('No breakdown series returned.');
    }
    for (const s of result.topSeries ?? []) lines.push(...renderSeries(s));

    if (result.otherSeriesLabels?.length)
      lines.push(...renderOtherLabels(result.otherSeriesLabels));

    if (result.selectedSeries?.length) {
      lines.push(`\n## Selected Series (${result.selectedSeries.length})`);
      lines.push(`Complete series for the labels requested via the series input.`);
      for (const s of result.selectedSeries) lines.push(...renderSeries(s));
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
