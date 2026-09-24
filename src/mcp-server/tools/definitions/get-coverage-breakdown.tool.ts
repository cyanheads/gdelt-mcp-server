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
import { escapeMarkdown } from '../markdown-escape.js';

/** Maximum number of series to include before aggregating the rest into "Other". */
const MAX_SERIES = 10;

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

/** Render one series in full — header, total, peak, and every data point. */
function renderSeries(series: z.infer<typeof breakdownSeriesSchema>): string[] {
  const total = series.data.reduce((sum, d) => sum + d.value, 0);
  const peak = series.data.reduce(
    (max, d) => (d.value > max.value ? d : max),
    series.data[0] ?? { date: '', value: 0 },
  );
  const lines = [
    `\n### ${escapeMarkdown(series.label)} (total: ${total.toFixed(2)})`,
    `Data points: ${series.data.length}`,
  ];
  if (peak.date) lines.push(`Peak: ${peak.value.toFixed(3)} at ${escapeMarkdown(peak.date)}`);
  for (const d of series.data) lines.push(renderPoint(d));
  return lines;
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
    'Returns up to 10 series by total volume and aggregates the rest into an "Other" bucket, naming ' +
    'every series it folded in there under otherSeriesLabels — pass any of those labels back as the ' +
    'series input to get that series complete, ranked or not. ' +
    "Values are normalized: each point is the topic's share of media output, not an absolute article count. " +
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
        'Exact series labels to additionally return in full, e.g. ["Portuguese", "Vietnamese"]. ' +
          'Take them verbatim from otherSeriesLabels (the series folded into "Other") or topSeries[].label ' +
          'in a response, or from the label list an unknown_series error prints. Each one comes back complete ' +
          'under selectedSeries, on top of the usual top-10 overview; a label that matches nothing is rejected ' +
          'rather than silently skipped. Omit to get the overview alone.',
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
    topSeries: z.array(breakdownSeriesSchema).describe('Top 10 series by total coverage volume.'),
    otherAggregated: z
      .array(
        z
          .object({
            date: z.string().describe('Timestep in ISO 8601 format.'),
            value: z
              .number()
              .describe(
                'Aggregated normalized coverage volume for all remaining series — a share of ' +
                  'media output, not an absolute article count.',
              ),
          })
          .describe('A single aggregated data point for the "Other" bucket.'),
      )
      .optional()
      .describe(
        'Combined time series for all series beyond the top 10. Omitted when all series fit.',
      ),
    otherSeriesLabels: z
      .array(z.string())
      .optional()
      .describe(
        'Label of every series folded into otherAggregated, ranked by total volume — the identities the ' +
          '"Other" bucket would otherwise dissolve. Pass any of them to the series input to retrieve that ' +
          "series' complete data. Omitted when all series fit in the top 10.",
      ),
    selectedSeries: z
      .array(breakdownSeriesSchema)
      .optional()
      .describe(
        'Complete, untruncated time series for each label requested via the series input, in the order ' +
          'requested. Omitted when series was not supplied.',
      ),
  }),

  // Agent-facing context — query echo, breakdown dimension, total series count, and notice on empty results.
  // Reaches structuredContent and content[] automatically; never in the domain return.
  enrichment: {
    effectiveQuery: z.string().describe('Echoed query string for use in follow-up calls.'),
    breakdownBy: z
      .enum(['language', 'country'])
      .describe('Breakdown dimension used for this response.'),
    totalCount: z.number().describe('Total number of series returned before truncation to top 10.'),
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
          'extend the window. Absent when breakdown data was returned.',
      ),
  },

  async handler(input, ctx) {
    const dateRangeFault = describeDateRangeFault(input.startDatetime, input.endDatetime);
    if (dateRangeFault) {
      throw ctx.fail('invalid_date_range', dateRangeFault, ctx.recoveryFor('invalid_date_range'));
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

    // Sort by total volume descending, take top MAX_SERIES
    const sorted = allSeries
      .map((s) => ({
        ...s,
        total: s.data.reduce((sum, d) => sum + d.value, 0),
      }))
      .sort((a, b) => b.total - a.total);

    const topSeries = sorted.slice(0, MAX_SERIES).map(({ total: _, ...s }) => s);
    const remainingSeries = sorted.slice(MAX_SERIES);

    let otherAggregated: Array<{ date: string; value: number }> | undefined;
    let otherSeriesLabels: string[] | undefined;
    if (remainingSeries.length > 0) {
      const dateMap = new Map<string, number>();
      for (const s of remainingSeries) {
        for (const d of s.data) {
          dateMap.set(d.date, (dateMap.get(d.date) ?? 0) + d.value);
        }
      }
      otherAggregated = Array.from(dateMap.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, value]) => ({ date, value }));
      otherSeriesLabels = remainingSeries.map((s) => s.label);
    }

    // Label selection re-filters the same complete upstream set the ranking sliced, so a
    // series named on a follow-up call reconstructs statelessly from query + dimension + label.
    // An empty breakdown has no labels to name, so there a selection is moot, not wrong.
    const selectedSeries: Array<z.infer<typeof breakdownSeriesSchema>> = [];
    if (!isEmpty && input.series?.length) {
      const byLabel = new Map(allSeries.map((s) => [s.label, s]));
      const unknown: string[] = [];
      for (const label of input.series) {
        const match = byLabel.get(label);
        if (match) selectedSeries.push(match);
        else unknown.push(label);
      }
      if (unknown.length > 0) {
        const named = unknown.map((label) => `"${label}"`).join(', ');
        throw ctx.fail('unknown_series', `No ${input.breakdownBy} series named ${named}`, {
          unknownLabels: unknown,
          recovery: {
            hint:
              `This breakdown has no ${input.breakdownBy} series named ${named}. Labels are exact and ` +
              `case-sensitive. Available for "${input.query}": ${sorted.map((s) => s.label).join(', ')}.`,
          },
        });
      }
    }

    const allDates = topSeries.flatMap((s) => s.data.map((d) => d.date));
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
        `No breakdown data for "${input.query}". Broaden the query, extend the time window, or ` +
          'verify the query operators are correct.',
      );
      if (input.series?.length) {
        notices.push('The series input was not applied — this breakdown has no series.');
      }
    }
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    ctx.log.info('gdelt_get_coverage_breakdown completed', {
      totalSeries: allSeries.length,
      topSeriesCount: topSeries.length,
      selectedSeriesCount: selectedSeries.length,
    });

    return {
      ...(dateResolution && { dateResolution }),
      topSeries,
      ...(otherAggregated ? { otherAggregated } : {}),
      ...(otherSeriesLabels ? { otherSeriesLabels } : {}),
      ...(selectedSeries.length > 0 ? { selectedSeries } : {}),
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
    if (result.topSeries.every((s) => s.data.length === 0)) {
      lines.push('No breakdown series returned.');
    }
    for (const s of result.topSeries) lines.push(...renderSeries(s));

    if (result.otherAggregated) {
      const otherTotal = result.otherAggregated.reduce((sum, d) => sum + d.value, 0);
      const otherPeak = result.otherAggregated.reduce(
        (max, d) => (d.value > max.value ? d : max),
        result.otherAggregated[0] ?? { date: '', value: 0 },
      );
      lines.push(`\n### Other`);
      lines.push(`Total: ${otherTotal.toFixed(2)}`);
      if (otherPeak.date) {
        lines.push(`Peak: ${otherPeak.value.toFixed(3)} at ${escapeMarkdown(otherPeak.date)}`);
      }
      for (const d of result.otherAggregated) lines.push(renderPoint(d));
    }

    if (result.otherSeriesLabels?.length) {
      lines.push(`\n### Series folded into "Other" (${result.otherSeriesLabels.length})`);
      lines.push(
        `Ranked by total volume. Re-call with series: ["<label>"] to get any of them in full.`,
      );
      for (const label of result.otherSeriesLabels) {
        lines.push(`- ${escapeMarkdown(label, 'line-start')}`);
      }
    }

    if (result.selectedSeries?.length) {
      lines.push(`\n## Selected Series (${result.selectedSeries.length})`);
      lines.push(`Complete series for the labels requested via the series input.`);
      for (const s of result.selectedSeries) lines.push(...renderSeries(s));
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
