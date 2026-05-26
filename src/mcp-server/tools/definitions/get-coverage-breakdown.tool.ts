/**
 * @fileoverview GDELT coverage breakdown tool. Breaks down coverage volume by source
 * language or source country over time using the GDELT DOC API.
 * @module mcp-server/tools/definitions/get-coverage-breakdown.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getGdeltDocService } from '@/services/gdelt/gdelt-doc-service.js';
import { inferDateResolution } from '../date-resolution.js';

/** Maximum number of series to include before aggregating the rest into "Other". */
const MAX_SERIES = 10;

export const gdeltGetCoverageBreakdown = tool('gdelt_get_coverage_breakdown', {
  title: 'Get GDELT Coverage Breakdown',
  description:
    'Break down news coverage volume over time by source language or source country, returning a ' +
    'multi-series time series (one series per language or country). ' +
    'Shows which countries or languages drove early vs. late coverage — useful for tracing how a ' +
    'story propagated geographically or across language communities. ' +
    'Returns up to 10 series by total volume; remaining series are aggregated into an "Other" bucket. ' +
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
      .optional()
      .describe('Start datetime in GDELT format YYYYMMDDHHMMSS. Must pair with endDatetime.'),
    endDatetime: z
      .string()
      .optional()
      .describe('End datetime in GDELT format YYYYMMDDHHMMSS. Must pair with startDatetime.'),
  }),

  output: z.object({
    query: z.string().describe('Echoed query string.'),
    breakdownBy: z.enum(['language', 'country']).describe('Breakdown dimension used.'),
    dateResolution: z.enum(['hour', 'day']).describe('Temporal resolution of data points.'),
    topSeries: z
      .array(
        z
          .object({
            label: z.string().describe('Series label (language name or country name).'),
            data: z
              .array(
                z
                  .object({
                    date: z.string().describe('Timestep in ISO 8601 format.'),
                    value: z.number().describe('Normalized coverage volume at this timestep.'),
                  })
                  .describe('A single data point for this series.'),
              )
              .describe('Time-ordered data points for this series.'),
          })
          .describe('A single language or country coverage series.'),
      )
      .describe('Top 10 series by total coverage volume.'),
    otherAggregated: z
      .array(
        z
          .object({
            date: z.string().describe('Timestep in ISO 8601 format.'),
            value: z.number().describe('Aggregated coverage volume for all remaining series.'),
          })
          .describe('A single aggregated data point for the "Other" bucket.'),
      )
      .optional()
      .describe(
        'Combined time series for all series beyond the top 10. Omitted when all series fit.',
      ),
    seriesCount: z.number().describe('Total number of series before truncation to top 10.'),
    notice: z
      .string()
      .optional()
      .describe('Recovery hint when no data was returned. Absent on successful responses.'),
  }),

  async handler(input, ctx) {
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
    }

    const allDates = topSeries.flatMap((s) => s.data.map((d) => d.date));
    const dateResolution = inferDateResolution(allDates);

    ctx.log.info('gdelt_get_coverage_breakdown completed', {
      totalSeries: allSeries.length,
      topSeriesCount: topSeries.length,
    });

    return {
      query: input.query,
      breakdownBy: input.breakdownBy,
      dateResolution,
      topSeries,
      ...(otherAggregated ? { otherAggregated } : {}),
      seriesCount: allSeries.length,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## GDELT Coverage Breakdown by ${result.breakdownBy === 'language' ? 'Language' : 'Country'}`,
      `**Query:** ${result.query}`,
      `**Total series:** ${result.seriesCount} | **Showing top:** ${result.topSeries.length}`,
      `**Date Resolution:** ${result.dateResolution}`,
    ];
    if (result.notice) lines.push(`\n> ${result.notice}`);
    for (const s of result.topSeries) {
      const total = s.data.reduce((sum, d) => sum + d.value, 0);
      lines.push(`\n### ${s.label} (total: ${total.toFixed(2)})`);
      lines.push(`Data points: ${s.data.length}`);
      const peak = s.data.reduce(
        (max, d) => (d.value > max.value ? d : max),
        s.data[0] ?? { date: '', value: 0 },
      );
      if (peak.date) lines.push(`Peak: ${peak.value.toFixed(3)} at ${peak.date}`);
    }
    if (result.otherAggregated) {
      const otherTotal = result.otherAggregated.reduce((sum, d) => sum + d.value, 0);
      const otherPeak = result.otherAggregated.reduce(
        (max, d) => (d.value > max.value ? d : max),
        result.otherAggregated[0] ?? { date: '', value: 0 },
      );
      lines.push(
        `\n### Other (${result.seriesCount - result.topSeries.length} series, total: ${otherTotal.toFixed(2)})`,
      );
      if (otherPeak.date) lines.push(`Peak: ${otherPeak.value.toFixed(3)} at ${otherPeak.date}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
