/**
 * @fileoverview GDELT coverage timeline tool. Retrieves time series of coverage volume
 * or average tone for a query using the GDELT DOC API.
 * @module mcp-server/tools/definitions/get-coverage-timeline.tool
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
import {
  escapeMarkdown,
  markdownLinkDestination,
  markdownQuote,
  renderQueryEcho,
} from '../markdown-escape.js';
import { pageByOffset, recordCharge } from '../response-budget.js';

/**
 * Article links carried per timestep in volume_with_articles mode, on both surfaces, for
 * timesteps the caller did not name in `points`. GDELT returns up to 10 articles per timestep
 * across as many as ~288 timesteps (~650 KB of structuredContent at the maximum), so each
 * timestep keeps its first 3 beside `referenceCount`, its true total, and `points` returns the
 * named timesteps with every reference — the gap is visible and retrievable, never silent.
 */
const ARTICLES_PER_POINT = 3;

const TIMESTEP_NOUN = { singular: 'timestep', plural: 'timesteps' };

type TimelinePoint = {
  date: string;
  value: number;
  articles?: Array<{ url: string; title: string }> | undefined;
  referenceCount?: number | undefined;
};

/** The point with the largest absolute value, or `undefined` when there are no points. */
function peakOf<P extends { date: string; value: number }>(points: readonly P[]): P | undefined {
  return points.reduce<P | undefined>(
    (max, d) => (max === undefined || Math.abs(d.value) > Math.abs(max.value) ? d : max),
    undefined,
  );
}

/**
 * One timestep's list line and article links — the block format() renders and the budget
 * charges. A point not named in `points` shows at most ARTICLES_PER_POINT links.
 */
function renderTimestep(d: TimelinePoint, expanded: boolean): string {
  const shown = expanded ? d.articles : d.articles?.slice(0, ARTICLES_PER_POINT);
  const count = d.referenceCount ?? d.articles?.length ?? 0;
  const withheld = count - (shown?.length ?? 0);
  const articlesNote =
    count > 0 ? ` (${count} articles${withheld > 0 ? `, ${shown?.length ?? 0} shown` : ''})` : '';
  const lines = [`- ${escapeMarkdown(d.date, 'line-start')}: ${d.value.toFixed(3)}${articlesNote}`];
  for (const a of shown ?? []) {
    lines.push(`  - [${escapeMarkdown(a.title)}](${markdownLinkDestination(a.url)})`);
  }
  return lines.join('\n');
}

/**
 * The `expandedPoints` echo line. format() renders it on every page of a points selection, so
 * the budget charges it ahead of the timesteps.
 */
function renderExpandedPoints(dates: readonly string[]): string {
  return `**Fully expanded timesteps:** ${dates.map((date) => escapeMarkdown(date)).join(', ')}`;
}

export const gdeltGetCoverageTimeline = tool('gdelt_get_coverage_timeline', {
  title: 'Get GDELT Coverage Timeline',
  description:
    'Retrieve a time series showing when news coverage of a topic spiked, or how average tone shifted over time. ' +
    'Use mode "volume" for normalized coverage intensity (% of all global coverage per timestep). ' +
    'Use mode "volume_with_articles" for the same signal plus the top articles that drove each spike — ' +
    'this is the primary signal-detection mode: a single call reveals both the spike and its cause, ' +
    'avoiding a follow-up gdelt_search_articles call. ' +
    'Use mode "tone" for average sentiment score per timestep (negative = hostile/fearful, positive = celebratory). ' +
    'Date resolution is inferred from returned intervals: 15 minutes or hours for short windows, days for longer ones. ' +
    'In volume_with_articles mode each timestep carries its first 3 article links and referenceCount, its true ' +
    "article count; name timesteps' dates in points to get only those timesteps, each with its full list. " +
    'A response carries as many whole timesteps as fit its size budget; when more remain it returns nextOffset — ' +
    'pass it back as offset with otherwise identical inputs for the next page. ' +
    'Note: DOC API covers only the last 3 months.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'unknown_point',
      code: JsonRpcErrorCode.NotFound,
      when: 'A date passed in the points input matches no timestep in a non-empty timeline.',
      recovery:
        'Read the timestep dates listed in the error and retry points with exact matches from that list.',
    },
    {
      reason: 'offset_out_of_range',
      code: JsonRpcErrorCode.NotFound,
      when: 'The requested offset is at or beyond the last timestep of a non-empty timeline, or of the timesteps named in points.',
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
          'come from gdelt_search_themes), tone<.',
      ),
    mode: z
      .enum(['volume', 'volume_with_articles', 'tone'])
      .default('volume')
      .describe(
        'Timeline mode: "volume" returns normalized coverage % per timestep, ' +
          '"volume_with_articles" returns volume plus top articles per spike (best for signal detection), ' +
          '"tone" returns average sentiment score per timestep.',
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
        'Timestep dates to return alone, e.g. ["2024-01-05T12:00:00Z"]. Take them verbatim from ' +
          'series[].data[].date in a prior response, or from the list an unknown_point error prints. The ' +
          'response then carries only these timesteps, in timeline order, and in volume_with_articles mode ' +
          'each carries its complete article list instead of the first 3. A date matching no timestep is ' +
          'rejected rather than silently ignored.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Zero-based timestep offset — into the timeline, or into the timesteps named in points. Pass ' +
          'nextOffset from the preceding response, with otherwise identical inputs, to get the next page.',
      ),
  }),

  output: z.object({
    dateResolution: z
      .enum(['15min', 'hour', 'day'])
      .optional()
      .describe(
        'Temporal resolution of the data points — 15min, hour, or day — inferred from the spacing ' +
          'of the returned timesteps. Omitted when fewer than two distinct timesteps came back.',
      ),
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
                        'Top articles driving coverage at this timestep — the first 3, or all of them for a ' +
                          'timestep named in points. Present only in volume_with_articles mode.',
                      ),
                    referenceCount: z
                      .number()
                      .optional()
                      .describe(
                        'How many articles GDELT returned for this timestep; articles carries the first 3 ' +
                          'unless the timestep was named in points. Present whenever articles is.',
                      ),
                  })
                  .describe('A single time-series data point.'),
              )
              .describe('Time-ordered data points of this series returned in this response.'),
            pointCount: z
              .number()
              .optional()
              .describe(
                'Data points in the whole series, across every page — not only those in data. Present ' +
                  'whenever the series has points.',
              ),
            peak: z
              .object({
                date: z.string().describe('Timestep of the peak, in ISO 8601 format.'),
                value: z.number().describe('Value at the peak timestep.'),
              })
              .optional()
              .describe(
                'The point of the whole series with the largest absolute value, across every page — it ' +
                  'may lie outside data. Omitted when the series has no points.',
              ),
          })
          .describe('A single time series with a label and data points.'),
      )
      .describe(
        'One or more time series (typically one for volume/tone), holding the timesteps of this page.',
      ),
    expandedPoints: z
      .array(z.string())
      .optional()
      .describe(
        'Timestep dates this response is restricted to, each carrying its full article list — echoing ' +
          'the points input. Omitted when points was not supplied.',
      ),
    nextOffset: z
      .number()
      .optional()
      .describe(
        'Offset of the next page, for the same inputs. Absent when this page reaches the last timestep.',
      ),
  }),

  // Agent-facing context — query echo, mode used, date span covered, and the empty-result or
  // paging notice. Reaches structuredContent and content[] automatically; never in the domain
  // return.
  enrichment: {
    effectiveQuery: z.string().describe('Echoed query string for use in follow-up calls.'),
    mode: z
      .enum(['volume', 'volume_with_articles', 'tone'])
      .describe('Timeline mode used for this response.'),
    totalCount: z
      .number()
      .describe(
        'Total number of data points across all series of the full timeline, not this page.',
      ),
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
          'extend the window — or, when this response is one page of several, which timesteps it ' +
          'returned out of how many. Absent when the whole timeline fit in one response.',
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

    // Infer date resolution from data point spacing
    const allDates = series.flatMap((s) => s.data.map((d) => d.date));
    const dateResolution = inferDateResolution(allDates);
    const totalPoints = allDates.length;
    const isEmpty = totalPoints === 0;
    // An empty timeline has no timesteps to name, so there a points selection is moot, not wrong.
    const expandedPoints = !isEmpty && input.points?.length ? input.points : undefined;

    // A points value that matches no timestep would expand nothing and say nothing —
    // the same silent withholding the selector exists to remove. Reject it instead.
    if (expandedPoints) {
      const available = new Set(allDates);
      const unknown = expandedPoints.filter((date) => !available.has(date));
      if (unknown.length > 0) {
        const named = unknown.map(markdownQuote).join(', ');
        throw ctx.fail('unknown_point', `No timestep at ${named}`, {
          unknownPoints: unknown,
          recovery: {
            hint:
              `This timeline has no timestep at ${named}. Dates are exact` +
              `${dateResolution ? `, at ${dateResolution} resolution` : ''}. ` +
              `Available: ${[...available].map((date) => escapeMarkdown(date)).join(', ')}.`,
          },
        });
      }
    }

    // The pageable units: every timestep in series order, or only the named ones. A named
    // timestep keeps every reference; any other keeps the first ARTICLES_PER_POINT.
    const namedDates = expandedPoints && new Set(expandedPoints);
    const units = series.flatMap((s, seriesIndex) =>
      s.data
        .filter((d) => !namedDates || namedDates.has(d.date))
        .map((d) => ({
          seriesIndex,
          point: {
            date: d.date,
            value: d.value,
            ...(d.articles && {
              articles: namedDates ? d.articles : d.articles.slice(0, ARTICLES_PER_POINT),
              referenceCount: d.articles.length,
            }),
          },
        })),
    );

    // An empty timeline has no offsets at all, so no offset can be out of its range.
    if (!isEmpty && input.offset >= units.length) {
      const scope = namedDates
        ? `points selects ${units.length} timesteps`
        : `this timeline has ${units.length} timesteps`;
      throw ctx.fail('offset_out_of_range', `Offset ${input.offset} is past the last timestep`, {
        offset: input.offset,
        totalTimesteps: units.length,
        recovery: { hint: `Retry with offset 0–${units.length - 1}; ${scope}.` },
      });
    }

    const page = isEmpty
      ? undefined
      : pageByOffset(
          units,
          (u) => recordCharge(u.point, renderTimestep(u.point, namedDates !== undefined)),
          input.offset,
          TIMESTEP_NOUN,
          expandedPoints ? recordCharge(expandedPoints, renderExpandedPoints(expandedPoints)) : 0,
        );
    const pageUnits = page ? units.slice(input.offset, page.end) : [];
    // Each series' point count and peak summarize the whole series, so they read the same on
    // every page — the page holds only some of its points.
    const pagedSeries = isEmpty
      ? series
      : series
          .map((s, seriesIndex) => {
            const peak = peakOf(s.data);
            return {
              label: s.label,
              data: pageUnits.filter((u) => u.seriesIndex === seriesIndex).map((u) => u.point),
              pointCount: s.data.length,
              ...(peak && { peak: { date: peak.date, value: peak.value } }),
            };
          })
          .filter((s) => s.data.length > 0);

    ctx.enrich.echo(input.query);
    ctx.enrich.total(totalPoints);
    ctx.enrich({
      mode: input.mode,
      ...(input.startDatetime && { startDatetime: input.startDatetime }),
      ...(input.endDatetime && { endDatetime: input.endDatetime }),
    });

    // Every notice segment for this response accumulates here and is flushed once —
    // ctx.enrich.notice is last-wins, so a second call would silently drop the first.
    const notices: string[] = [];
    if (isEmpty) {
      notices.push(
        `No coverage data found for ${markdownQuote(input.query)}. Broaden the query, extend the time window, ` +
          'or verify the query operators are correct.',
      );
      if (input.points?.length) {
        notices.push('The points input was not applied — this timeline has no timesteps.');
      }
    }
    if (page?.notice) notices.push(page.notice);
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    ctx.log.info('gdelt_get_coverage_timeline completed', {
      seriesCount: series.length,
      pointCount: totalPoints,
      returnedPoints: pageUnits.length,
    });

    return {
      ...(dateResolution && { dateResolution }),
      series: pagedSeries,
      ...(expandedPoints && { expandedPoints }),
      ...(page?.nextOffset != null && { nextOffset: page.nextOffset }),
    };
  },

  /**
   * Renders each field on its own presence, never as an `if`/`else if` chain — the
   * format-parity linter populates every optional field at once in its synthetic sample,
   * so a mutually-exclusive branch would leave the untaken one unverified.
   */
  format: (result) => {
    const expanded = new Set(result.expandedPoints ?? []);
    const lines: string[] = [`## GDELT Coverage Timeline`];
    if (result.dateResolution) lines.push(`**Date Resolution:** ${result.dateResolution}`);
    if (result.series.every((s) => s.data.length === 0)) lines.push('No timeline data returned.');

    const capped = result.series.some((s) =>
      s.data.some(
        (d) =>
          !expanded.has(d.date) &&
          (d.referenceCount ?? d.articles?.length ?? 0) > ARTICLES_PER_POINT,
      ),
    );
    if (capped) {
      lines.push(
        `**Article links:** first ${ARTICLES_PER_POINT} per timestep, with each timestep's true total ` +
          `beside it. Re-call with points: ["<date>"] to get a timestep's full list.`,
      );
    }
    if (result.expandedPoints?.length) lines.push(renderExpandedPoints(result.expandedPoints));
    if (result.nextOffset != null) lines.push(`**Next offset:** ${result.nextOffset}`);

    for (const s of result.series) {
      lines.push(`\n### ${escapeMarkdown(s.label, 'heading-end')}`);
      // The handler sets pointCount and peak over the whole series; a result built without
      // them is a whole series, summarized from its own points.
      const pointCount = s.pointCount ?? s.data.length;
      const peak = s.peak ?? peakOf(s.data);
      lines.push(
        `**Data points:** ${pointCount}` +
          (pointCount > s.data.length ? ` in the series, ${s.data.length} in this response` : ''),
      );
      if (peak) {
        lines.push(`**Peak:** ${peak.value.toFixed(3)} at ${escapeMarkdown(peak.date)}`);
      }
      for (const d of s.data) lines.push(renderTimestep(d, expanded.has(d.date)));
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
