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
 * Article links rendered per timestep in volume_with_articles mode, for timesteps the
 * caller did not name in `points`. Every data point's date and value is rendered; only
 * the per-point article list stays capped by default. GDELT returns up to 10 articles per
 * timestep across as many as ~288 timesteps, so rendering them all unconditionally would
 * put ~450 KB of links in content[] and swamp the timeline itself.
 *
 * The complete set always rides in structuredContent, each point renders its true article
 * count next to how many links it showed, and `points` lifts the cap for named timesteps —
 * so the gap is both visible and retrievable rather than a silent truncation.
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
    'In volume_with_articles mode the text surface shows the first 3 article links per timestep next to that ' +
    "timestep's true article count; name a timestep's date in points to render its full list. " +
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
      reason: 'unknown_point',
      code: JsonRpcErrorCode.NotFound,
      when: 'A date passed in the points input matches no timestep in this timeline.',
      recovery:
        'Read the timestep dates listed in the error and retry points with exact matches from that list.',
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
    points: z
      .array(z.string())
      .optional()
      .describe(
        'Timestep dates whose complete article list should be rendered in the text surface, e.g. ' +
          '["2024-01-05T12:00:00Z"]. Take them verbatim from series[].data[].date in a prior response, or ' +
          'from the list an unknown_point error prints. Only affects volume_with_articles rendering — every ' +
          'timestep already carries its full article list in structuredContent regardless. Timesteps not named ' +
          'here show their first 3 links; a date matching no timestep is rejected rather than silently ignored.',
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
    expandedPoints: z
      .array(z.string())
      .optional()
      .describe(
        'Timestep dates whose full article list is rendered in the text surface instead of the first 3, ' +
          'echoing the points input. Omitted when points was not supplied. Purely a rendering concern — ' +
          'structuredContent carries every article for every timestep either way.',
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

    // A points value that matches no timestep would expand nothing and say nothing —
    // the same silent withholding the selector exists to remove. Reject it instead.
    if (input.points?.length) {
      const available = new Set(allDates);
      const unknown = input.points.filter((date) => !available.has(date));
      if (unknown.length > 0) {
        const named = unknown.map((date) => `"${date}"`).join(', ');
        throw ctx.fail('unknown_point', `No timestep at ${named}`, {
          unknownPoints: unknown,
          recovery: {
            hint:
              `This timeline has no timestep at ${named}. Dates are exact, at ${dateResolution} resolution. ` +
              `Available: ${[...available].join(', ')}.`,
          },
        });
      }
    }

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

    return {
      dateResolution,
      series,
      ...(input.points?.length ? { expandedPoints: input.points } : {}),
    };
  },

  /**
   * Renders each field on its own presence, never as an `if`/`else if` chain — the
   * format-parity linter populates every optional field at once in its synthetic sample,
   * so a mutually-exclusive branch would leave the untaken one unverified.
   */
  format: (result) => {
    const expanded = new Set(result.expandedPoints ?? []);
    const lines: string[] = [
      `## GDELT Coverage Timeline`,
      `**Date Resolution:** ${result.dateResolution}`,
    ];

    const capped = result.series.some((s) =>
      s.data.some((d) => (d.articles?.length ?? 0) > ARTICLES_PER_POINT && !expanded.has(d.date)),
    );
    if (capped) {
      lines.push(
        `**Article links:** first ${ARTICLES_PER_POINT} per timestep, with each timestep's true total ` +
          `beside it. Re-call with points: ["<date>"] to render a timestep's full list.`,
      );
    }
    if (result.expandedPoints?.length) {
      lines.push(`**Fully expanded timesteps:** ${result.expandedPoints.join(', ')}`);
    }

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
        const shown = expanded.has(d.date) ? d.articles : d.articles?.slice(0, ARTICLES_PER_POINT);
        const withheld = (d.articles?.length ?? 0) - (shown?.length ?? 0);
        const articlesNote = d.articles?.length
          ? ` (${d.articles.length} articles${withheld > 0 ? `, ${shown?.length} shown` : ''})`
          : '';
        lines.push(`- ${d.date}: ${d.value.toFixed(3)}${articlesNote}`);
        for (const a of shown ?? []) lines.push(`  - [${a.title}](${a.url})`);
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
