/**
 * @fileoverview GDELT coverage breakdown tool. Breaks down coverage volume by source
 * language or source country over time using the GDELT DOC API.
 * @module mcp-server/tools/definitions/get-coverage-breakdown.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getGdeltDocService } from '@/services/gdelt/gdelt-doc-service.js';
import { GDELT_DATETIME_PATTERN, isUnpairedDateRange } from '../date-range.js';
import { inferDateResolution } from '../date-resolution.js';

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
    `\n### ${series.label} (total: ${total.toFixed(2)})`,
    `Data points: ${series.data.length}`,
  ];
  if (peak.date) lines.push(`Peak: ${peak.value.toFixed(3)} at ${peak.date}`);
  for (const d of series.data) lines.push(`- ${d.date}: ${d.value.toFixed(3)}`);
  return lines;
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
      reason: 'no_breakdown_data',
      code: JsonRpcErrorCode.NotFound,
      when: 'No breakdown data returned for the query.',
      recovery:
        'Broaden the query, extend the timespan, or verify the query operators are correct.',
    },
    {
      reason: 'unknown_series',
      code: JsonRpcErrorCode.NotFound,
      when: 'A label passed in the series input matches no series in this breakdown.',
      recovery:
        'Read the labels listed in the error and retry series with exact matches from that list.',
    },
    {
      reason: 'invalid_date_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Exactly one of startDatetime / endDatetime was supplied.',
      recovery:
        'Supply both startDatetime and endDatetime to pin an explicit window, or omit both and use timespan instead.',
    },
    {
      reason: 'invalid_query',
      code: JsonRpcErrorCode.ValidationError,
      when: 'GDELT rejected the query string as malformed — bad keyword length, unbalanced parentheses, or an illegal character.',
      recovery:
        'Read the recovery hint for the specific rule GDELT rejected, then fix the query and retry.',
    },
    {
      reason: 'gdelt_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'GDELT DOC API is unreachable or rate-limited.',
      retryable: true,
      recovery: 'Wait at least 5 seconds before retrying — GDELT enforces 1 request per 5 seconds.',
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
    timespan: z
      .string()
      .optional()
      .describe(
        'Time window relative to now, e.g. "24h", "7d", "1m". ' +
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
    dateResolution: z.enum(['hour', 'day']).describe('Temporal resolution of data points.'),
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
        'Recovery hint when no breakdown data was returned. Absent on successful responses.',
      ),
  },

  async handler(input, ctx) {
    if (isUnpairedDateRange(input.startDatetime, input.endDatetime)) {
      throw ctx.fail(
        'invalid_date_range',
        'startDatetime and endDatetime must be supplied together',
        ctx.recoveryFor('invalid_date_range'),
      );
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

    if (allSeries.length === 0) {
      throw ctx.fail('no_breakdown_data', `No breakdown data for "${input.query}"`, {
        recovery: {
          hint: `No breakdown data for "${input.query}". Try broadening the query or extending the time range.`,
        },
      });
    }

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
    const selectedSeries: Array<z.infer<typeof breakdownSeriesSchema>> = [];
    if (input.series?.length) {
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

    ctx.log.info('gdelt_get_coverage_breakdown completed', {
      totalSeries: allSeries.length,
      topSeriesCount: topSeries.length,
      selectedSeriesCount: selectedSeries.length,
    });

    return {
      dateResolution,
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
    const lines: string[] = [
      `## GDELT Coverage Breakdown`,
      `**Date Resolution:** ${result.dateResolution}`,
      `**Values:** normalized — each value is the topic's share of that source's media output, ` +
        `not an article count. Small media markets with concentrated coverage rank above large ` +
        `markets with diverse output.`,
    ];
    for (const s of result.topSeries) lines.push(...renderSeries(s));

    if (result.otherAggregated) {
      const otherTotal = result.otherAggregated.reduce((sum, d) => sum + d.value, 0);
      const otherPeak = result.otherAggregated.reduce(
        (max, d) => (d.value > max.value ? d : max),
        result.otherAggregated[0] ?? { date: '', value: 0 },
      );
      lines.push(`\n### Other`);
      lines.push(`Total: ${otherTotal.toFixed(2)}`);
      if (otherPeak.date) lines.push(`Peak: ${otherPeak.value.toFixed(3)} at ${otherPeak.date}`);
      for (const d of result.otherAggregated) {
        lines.push(`- ${d.date}: ${d.value.toFixed(3)}`);
      }
    }

    if (result.otherSeriesLabels?.length) {
      lines.push(`\n### Series folded into "Other" (${result.otherSeriesLabels.length})`);
      lines.push(
        `Ranked by total volume. Re-call with series: ["<label>"] to get any of them in full.`,
      );
      for (const label of result.otherSeriesLabels) lines.push(`- ${label}`);
    }

    if (result.selectedSeries?.length) {
      lines.push(`\n## Selected Series (${result.selectedSeries.length})`);
      lines.push(`Complete series for the labels requested via the series input.`);
      for (const s of result.selectedSeries) lines.push(...renderSeries(s));
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
