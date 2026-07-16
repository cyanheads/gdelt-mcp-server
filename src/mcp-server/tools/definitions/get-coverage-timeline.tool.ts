/**
 * @fileoverview GDELT coverage timeline tool. Retrieves time series of coverage volume
 * or average tone for a query using the GDELT DOC API.
 * @module mcp-server/tools/definitions/get-coverage-timeline.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getGdeltDocService } from '@/services/gdelt/gdelt-doc-service.js';
import { GDELT_DATETIME_PATTERN, isUnpairedDateRange } from '../date-range.js';
import { inferDateResolution } from '../date-resolution.js';

/**
 * Article links rendered per timestep in volume_with_articles mode. Every data point's
 * date and value is rendered; only the per-point article list stays capped. GDELT returns
 * up to 10 articles per timestep across as many as ~288 timesteps, so rendering them all
 * would put ~450 KB of links in content[] and swamp the timeline itself. The complete set
 * stays in structuredContent, and each point renders its true article count, so the gap
 * between the count and the links shown is visible rather than silent.
 */
const ARTICLES_PER_POINT = 3;

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
        'Recovery hint when no timeline data was returned. Absent on successful responses.',
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
    ctx.enrich({
      mode: input.mode,
      ...(input.startDatetime && { startDatetime: input.startDatetime }),
      ...(input.endDatetime && { endDatetime: input.endDatetime }),
    });

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
      for (const d of s.data) {
        const articlesNote = d.articles?.length ? ` (${d.articles.length} articles)` : '';
        lines.push(`- ${d.date}: ${d.value.toFixed(3)}${articlesNote}`);
        if (d.articles?.length) {
          for (const a of d.articles.slice(0, ARTICLES_PER_POINT)) {
            lines.push(`  - [${a.title}](${a.url})`);
          }
        }
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
