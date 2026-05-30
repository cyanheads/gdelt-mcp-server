/**
 * @fileoverview GDELT coverage timeline tool. Retrieves time series of coverage volume
 * or average tone for a query using the GDELT DOC API.
 * @module mcp-server/tools/definitions/get-coverage-timeline.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getGdeltDocService } from '@/services/gdelt/gdelt-doc-service.js';
import { inferDateResolution } from '../date-resolution.js';

export const gdeltGetCoverageTimeline = tool('gdelt_get_coverage_timeline', {
  title: 'Get GDELT Coverage Timeline',
  description:
    'Retrieve a time series showing when news coverage of a topic spiked, or how average tone shifted over time. ' +
    'Use mode "volume" for normalized coverage intensity (% of all global coverage per timestep). ' +
    'Use mode "volume_with_articles" for the same signal plus the top articles that drove each spike — ' +
    'this is the primary signal-detection mode: a single call reveals both the spike and its cause, ' +
    'avoiding a follow-up gdelt_search_articles call. ' +
    'Use mode "tone" for average sentiment score per timestep (negative = hostile/fearful, positive = celebratory). ' +
    'Date resolution is automatically chosen based on timespan: hours for short windows, days for longer ones. ' +
    'Note: DOC API covers only the last 3 months.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'no_timeline_data',
      code: JsonRpcErrorCode.NotFound,
      when: 'No timeline data returned for the query and time range.',
      recovery: 'Broaden the query, extend the timespan, or verify query operators are correct.',
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
          'phrases, boolean OR, sourcecountry:, sourcelang:, domain:, theme:, tone<.',
      ),
    mode: z
      .enum(['volume', 'volume_with_articles', 'tone'])
      .default('volume')
      .describe(
        'Timeline mode: "volume" returns normalized coverage % per timestep, ' +
          '"volume_with_articles" returns volume plus top articles per spike (best for signal detection), ' +
          '"tone" returns average sentiment score per timestep.',
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
    smoothing: z
      .number()
      .int()
      .min(0)
      .max(5)
      .optional()
      .describe(
        'Smoothing window in timesteps (0 = none, 1–5 = moving average width). ' +
          'Reduces noise for spotty topics.',
      ),
  }),

  output: z.object({
    dateResolution: z
      .enum(['hour', 'day'])
      .describe('Temporal resolution of the data points — hour for short windows, day for longer.'),
    series: z
      .array(
        z
          .object({
            label: z.string().describe('Series label (e.g. "Volume Intensity" or "Average Tone").'),
            data: z
              .array(
                z
                  .object({
                    date: z.string().describe('Timestep in ISO 8601 format.'),
                    value: z
                      .number()
                      .describe(
                        'Normalized coverage % (volume mode) or average tone score (tone mode). ' +
                          'Tone range is approximately -100 to +100.',
                      ),
                    articles: z
                      .array(
                        z
                          .object({
                            url: z.string().describe('Article URL.'),
                            title: z.string().describe('Article title.'),
                          })
                          .describe('An article linked to this spike.'),
                      )
                      .optional()
                      .describe(
                        'Top articles driving coverage at this timestep. Present only in volume_with_articles mode.',
                      ),
                  })
                  .describe('A single time-series data point.'),
              )
              .describe('Time-ordered data points for this series.'),
          })
          .describe('A single time series with a label and data points.'),
      )
      .describe(
        'One or more time series (typically one for volume/tone, one per label for breakdowns).',
      ),
  }),

  // Agent-facing context — query echo, mode used, date span covered, and notice on empty results.
  // Reaches structuredContent and content[] automatically; never in the domain return.
  enrichment: {
    effectiveQuery: z.string().describe('Echoed query string for use in follow-up calls.'),
    mode: z
      .enum(['volume', 'volume_with_articles', 'tone'])
      .describe('Timeline mode used for this response.'),
    totalCount: z.number().describe('Total number of data points across all series.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery hint when no timeline data was returned. Absent on successful responses.',
      ),
  },

  async handler(input, ctx) {
    ctx.log.info('gdelt_get_coverage_timeline', { query: input.query, mode: input.mode });
    const svc = getGdeltDocService();

    const modeMap = {
      volume: 'timelinevol',
      volume_with_articles: 'timelinevolinfo',
      tone: 'timelinetone',
    } as const;

    const series = await svc.getTimeline(
      {
        query: input.query,
        mode: modeMap[input.mode],
        ...(input.timespan && { timespan: input.timespan }),
        ...(input.startDatetime && { startDatetime: input.startDatetime }),
        ...(input.endDatetime && { endDatetime: input.endDatetime }),
        ...(input.smoothing != null && { smoothing: input.smoothing }),
      },
      ctx,
    );

    if (series.length === 0 || series.every((s) => s.data.length === 0)) {
      throw ctx.fail('no_timeline_data', `No timeline data for "${input.query}"`, {
        recovery: {
          hint: `No coverage data found for "${input.query}". Try broadening the query or extending the time window.`,
        },
      });
    }

    // Infer date resolution from data point spacing
    const allDates = series.flatMap((s) => s.data.map((d) => d.date));
    const dateResolution = inferDateResolution(allDates);
    const totalPoints = series.reduce((sum, s) => sum + s.data.length, 0);

    ctx.enrich.echo(input.query);
    ctx.enrich.total(totalPoints);
    ctx.enrich({ mode: input.mode });

    ctx.log.info('gdelt_get_coverage_timeline completed', {
      seriesCount: series.length,
      pointCount: series[0]?.data.length ?? 0,
    });

    return { dateResolution, series };
  },

  format: (result) => {
    const lines: string[] = [
      `## GDELT Coverage Timeline`,
      `**Date Resolution:** ${result.dateResolution}`,
    ];
    for (const s of result.series) {
      lines.push(`\n### ${s.label}`);
      const peakPoint = s.data.reduce(
        (max, d) => (Math.abs(d.value) > Math.abs(max.value) ? d : max),
        s.data[0] ?? { date: '', value: 0, articles: undefined },
      );
      lines.push(`**Data points:** ${s.data.length}`);
      if (peakPoint.date) {
        lines.push(`**Peak:** ${peakPoint.value.toFixed(3)} at ${peakPoint.date}`);
      }
      // Show first 10 data points to orient the agent
      const preview = s.data.slice(0, 10);
      for (const d of preview) {
        const articlesNote = d.articles?.length ? ` (${d.articles.length} articles)` : '';
        lines.push(`- ${d.date}: ${d.value.toFixed(3)}${articlesNote}`);
        if (d.articles?.length) {
          for (const a of d.articles.slice(0, 3)) {
            lines.push(`  - [${a.title}](${a.url})`);
          }
        }
      }
      if (s.data.length > 10) lines.push(`- … ${s.data.length - 10} more points`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
