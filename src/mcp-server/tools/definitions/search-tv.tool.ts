/**
 * @fileoverview GDELT TV search tool. Searches US television news closed captions
 * for spoken mentions and returns normalized per-station coverage time series.
 * @module mcp-server/tools/definitions/search-tv.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getGdeltTvService, type TvSearchSeries } from '@/services/gdelt/gdelt-tv-service.js';
import {
  describeDateRangeFault,
  describeResolvedTimespan,
  GDELT_DATETIME_PATTERN,
} from '../date-range.js';
import { CLAMP_HEADROOM, clampToCap, limitClampSchema, renderLimitClamp } from '../limit-clamp.js';
import { escapeMarkdown, markdownQuote, renderQueryEcho } from '../markdown-escape.js';
import { describeUnresolvedStations, stationLabel } from '../station-ids.js';

/** Evidence-led request/response bounds: ten station selectors and 500 returned points. */
const MAX_STATIONS = 10;
const MAX_POINTS_PER_PAGE = 500;

/** The `limit` schema maximum: past it a call is rejected; up to it, clamped to the page bound. */
const MAX_LIMIT_ACCEPTED = MAX_POINTS_PER_PAGE * CLAMP_HEADROOM;

export const gdeltSearchTv = tool('gdelt_search_tv', {
  title: 'Search GDELT TV News',
  description:
    'Search US television news closed captions (2009–October 2024, 150+ stations) for spoken mentions ' +
    'of a query. Returns a bounded, paged per-station time series showing airtime devoted to the topic — ' +
    "up to 500 points per page; a larger limit runs at 500. Each series carries GDELT's display name " +
    'for the station and, when that name resolves to one, the station ID gdelt_get_tv_clips takes as stations. ' +
    'Use the stations parameter to select networks (e.g. ["CNN", "FOXNEWS", "MSNBC"]) — the TV API ' +
    'requires at least one station, supplied either there or as a station: selector inside query. ' +
    'TV query also supports in-query operators: station:CNN, network:CBS, market:"National", ' +
    'show:"Anderson Cooper 360", context:"vaccine". ' +
    'Important: most station monitoring ended October 2024 — use gdelt_list_tv_stations to verify ' +
    'active date ranges before querying recent events.',
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
      reason: 'offset_out_of_range',
      code: JsonRpcErrorCode.NotFound,
      when: 'The requested point offset is at or beyond the end of a non-empty timeline.',
      recovery: 'Retry with an offset between 0 and totalPoints - 1 from the preceding response.',
    },
    {
      reason: 'invalid_query',
      code: JsonRpcErrorCode.ValidationError,
      when: 'GDELT rejected the query — no station was selected, or the query string is malformed.',
      recovery:
        'Read the recovery hint for the specific rule GDELT rejected; when no station was selected, list valid IDs with gdelt_list_tv_stations.',
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
      when: 'GDELT TV API is unreachable or temporarily returned no usable data.',
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
        'Search query for TV transcript content. Supports TV operators: ' +
          'station:CNN, network:CBS, market:"National", show:"Anderson Cooper", context:"vaccine". ' +
          'Boolean OR and phrase operators also work.',
      ),
    stations: z
      .array(z.string())
      .max(MAX_STATIONS, `At most ${MAX_STATIONS} stations may be requested.`)
      .optional()
      .describe(
        `Up to ${MAX_STATIONS} station IDs to filter to (e.g. ["CNN", "FOXNEWS", "MSNBC"]). ` +
          'The GDELT TV API requires at least one station — supply it here, or embed a station: ' +
          'selector directly in query. Omitting both is rejected; it does not fall back to all stations. ' +
          'Use gdelt_list_tv_stations to see valid station IDs.',
      ),
    timespan: z
      .string()
      .optional()
      .describe(
        'Time window, e.g. "1m", "6m", "1y". ' +
          'Ignored when startDatetime/endDatetime are set. ' +
          'TV data spans 2009–October 2024.',
      ),
    startDatetime: z
      .string()
      .regex(GDELT_DATETIME_PATTERN, 'startDatetime must be exactly 14 digits (YYYYMMDDHHMMSS).')
      .optional()
      .describe(
        'Start datetime in GDELT format YYYYMMDDHHMMSS — exactly 14 digits, no separators ' +
          '(e.g. 20200101000000). Must pair with endDatetime; supplying only one of the two is rejected.',
      ),
    endDatetime: z
      .string()
      .regex(GDELT_DATETIME_PATTERN, 'endDatetime must be exactly 14 digits (YYYYMMDDHHMMSS).')
      .optional()
      .describe(
        'End datetime in GDELT format YYYYMMDDHHMMSS — exactly 14 digits, no separators ' +
          '(e.g. 20200131235959). Must pair with startDatetime; supplying only one of the two is rejected.',
      ),
    smoothing: z
      .number()
      .int()
      .min(0)
      .max(5)
      .optional()
      .describe('Smoothing window in timesteps (0 = none). Reduces noise for sporadic topics.'),
    normalize: z
      .boolean()
      .default(true)
      .describe(
        'When true (default), values are normalized as % of total airtime, enabling cross-station comparison. ' +
          'When false, returns raw matching 15-second clip counts.',
      ),
    dateres: z
      .enum(['hour', 'day', 'week', 'month', 'year'])
      .optional()
      .describe(
        'Optional GDELT aggregation resolution. Omit to let GDELT choose from the query window; ' +
          'the effective recognized or inferred resolution is returned as dateResolution.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Zero-based point offset into the deterministic date-then-station-name ordering. Use nextOffset ' +
          'from the preceding response with the same query inputs to retrieve the next page.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(
        MAX_LIMIT_ACCEPTED,
        `limit must be at most ${MAX_LIMIT_ACCEPTED} (a value above ${MAX_POINTS_PER_PAGE} runs at ${MAX_POINTS_PER_PAGE}).`,
      )
      .default(MAX_POINTS_PER_PAGE)
      .describe(
        `Maximum timeline points returned in this response (1–${MAX_POINTS_PER_PAGE}; a value up to ` +
          `${MAX_LIMIT_ACCEPTED} runs at ${MAX_POINTS_PER_PAGE}, and the response says so in limitClamp).`,
      ),
  }),

  output: z.object({
    dateResolution: z
      .enum(['hour', 'day', 'week', 'month', 'year'])
      .optional()
      .describe(
        'Temporal resolution of data points — as GDELT reported it, as requested via dateres, or ' +
          'inferred from the returned intervals. Omitted when none of those can establish it.',
      ),
    timeRange: z
      .object({
        start: z.string().describe('Earliest date in the returned data.'),
        end: z.string().describe('Latest date in the returned data.'),
      })
      .optional()
      .describe('Date range spanned by this returned point page. Omitted when the page is empty.'),
    series: z
      .array(
        z
          .object({
            station: z
              .string()
              .optional()
              .describe(
                'Station ID — the value the stations input and the station: operator take (e.g. ' +
                  '"FOXNEWS"). Absent when GDELT\'s label for the station could not be resolved to ' +
                  'an ID; notice says why.',
              ),
            stationName: z
              .string()
              .describe(
                'GDELT\'s display label for the station (e.g. "FOX News"). Empty when GDELT ' +
                  'returned the series without one; notice says so.',
              ),
            data: z
              .array(
                z
                  .object({
                    date: z.string().describe('Timestep in ISO 8601 format.'),
                    value: z
                      .number()
                      .describe(
                        'Coverage value (normalized % or raw matching 15-second clip count).',
                      ),
                  })
                  .describe('A single coverage data point.'),
              )
              .describe('Time-ordered coverage data for this station.'),
          })
          .describe('Coverage time series for a single station.'),
      )
      .describe('Station series represented in this point page.'),
    normalized: z.boolean().describe('True when values are normalized coverage percentages.'),
    totalPoints: z
      .number()
      .describe('Total points available across all matched station series before pagination.'),
    offset: z.number().describe('Zero-based offset of this point page.'),
    limit: z
      .number()
      .describe(
        'Maximum points this page holds — the requested limit, or 500 when a larger one was clamped.',
      ),
    nextOffset: z
      .number()
      .optional()
      .describe(
        'Offset for the next page using the same query inputs. Absent when this is the final page.',
      ),
  }),

  // Agent-facing context — query echo, station count, and notices on empty results and
  // unresolved station IDs. Reaches structuredContent and content[] automatically; never in
  // the domain return.
  enrichment: {
    effectiveQuery: z.string().describe('Echoed query string for use in follow-up calls.'),
    totalCount: z.number().describe('Number of station series returned.'),
    limitClamp: limitClampSchema,
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when the query matched no TV coverage — the resolved timespan window, the October ' +
          '2024 archive cutoff, and how to check station coverage. When a returned series has no ' +
          'station ID, why: GDELT returned it without a station label, or its station catalog did ' +
          'not load or has no entry for the named label — with how to look the ID up. Absent when coverage was returned and every series ' +
          'carries its station ID.',
      ),
  },

  enrichmentTrailer: {
    effectiveQuery: { render: renderQueryEcho },
    limitClamp: { render: renderLimitClamp },
  },

  async handler(input, ctx) {
    const dateRangeFault = describeDateRangeFault(input.startDatetime, input.endDatetime);
    if (dateRangeFault) {
      throw ctx.fail('invalid_date_range', dateRangeFault);
    }

    ctx.log.info('gdelt_search_tv', { query: input.query, stations: input.stations });
    const svc = getGdeltTvService();

    const result = await svc.searchTv(
      {
        query: input.query,
        ...(input.stations?.length && { stations: input.stations }),
        ...(input.timespan && { timespan: input.timespan }),
        ...(input.startDatetime && { startDatetime: input.startDatetime }),
        ...(input.endDatetime && { endDatetime: input.endDatetime }),
        ...(input.smoothing != null && { smoothing: input.smoothing }),
        ...(input.dateres && { dateres: input.dateres }),
        normalize: input.normalize,
      },
      ctx,
    );

    const limit = clampToCap(ctx, 'limit', input.limit, MAX_POINTS_PER_PAGE);
    const page = paginateTvSeries(result.series, input.offset, limit);
    const isEmpty = page.totalPoints === 0;
    // An empty timeline has no offsets at all, so no offset can be out of its range.
    if (!isEmpty && input.offset >= page.totalPoints) {
      throw ctx.fail('offset_out_of_range', `Offset ${input.offset} is outside this timeline`, {
        offset: input.offset,
        totalPoints: page.totalPoints,
        recovery: {
          hint: `Retry with offset 0–${page.totalPoints - 1}; this timeline has ${page.totalPoints} points.`,
        },
      });
    }

    const pageDates = page.series.flatMap((series) => series.data.map((point) => point.date));
    const sortedPageDates = pageDates.slice().sort();
    const nextOffset =
      input.offset + pageDates.length < page.totalPoints
        ? input.offset + pageDates.length
        : undefined;

    const [start] = sortedPageDates;
    const end = sortedPageDates.at(-1);

    ctx.enrich.echo(input.query);
    ctx.enrich.total(page.series.length);

    // Every notice segment for this response accumulates here and is flushed once —
    // ctx.enrich.notice is last-wins, so a second call would silently drop the first.
    const notices: string[] = [];
    if (isEmpty) {
      notices.push(
        `No TV coverage for ${markdownQuote(input.query)}.${describeResolvedTimespan(input)} Most TV data ends ` +
          'October 2024 — check that the stations were active during the window with ' +
          'gdelt_list_tv_stations, broaden the query, or extend the window.',
      );
    }
    const unresolved = describeUnresolvedStations(
      page.series,
      result.stationCatalogUnavailable === true,
      { singular: 'series', plural: 'series' },
    );
    if (unresolved) notices.push(unresolved);
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    ctx.log.info('gdelt_search_tv completed', { seriesCount: result.series.length });
    return {
      ...(result.dateResolution && { dateResolution: result.dateResolution }),
      ...(start != null && end != null && { timeRange: { start, end } }),
      series: page.series,
      normalized: result.normalized,
      totalPoints: page.totalPoints,
      offset: input.offset,
      limit,
      ...(nextOffset != null ? { nextOffset } : {}),
    };
  },

  format: (result) => {
    const returned = result.series.reduce((sum, series) => sum + series.data.length, 0);
    const lines: string[] = [`## GDELT TV News Coverage`];
    if (result.dateResolution) lines.push(`**Date Resolution:** ${result.dateResolution}`);
    if (result.timeRange) {
      lines.push(
        `**Time Range:** ${escapeMarkdown(result.timeRange.start)} to ${escapeMarkdown(result.timeRange.end)}`,
      );
    }
    lines.push(
      `**Normalized:** ${result.normalized ? 'Yes (% of airtime)' : 'No (raw matching 15-second clip counts)'}`,
      `**Stations:** ${result.series.length}`,
      `**Point page:** offset ${result.offset}, limit ${result.limit}`,
      returned > 0
        ? `**Points ${result.offset + 1}–${result.offset + returned} of ${result.totalPoints}**`
        : `**Points:** 0 of ${result.totalPoints}`,
    );
    if (result.nextOffset != null) lines.push(`**Next offset:** ${result.nextOffset}`);
    // Each station's summary covers only its points on this page — a longer timeline has a
    // different sum and peak on every page, so the labels say so.
    for (const s of result.series) {
      const peak = s.data.reduce(
        (max, d) => (d.value > max.value ? d : max),
        s.data[0] ?? { date: '', value: 0 },
      );
      const sum = s.data.reduce((total, d) => total + d.value, 0);
      lines.push(`\n### ${escapeMarkdown(stationLabel(s), 'heading-end')}`);
      lines.push(`Points on this page: ${s.data.length} | Sum on this page: ${sum.toFixed(2)}`);
      if (peak.date) {
        lines.push(`Page peak: ${peak.value.toFixed(3)} at ${escapeMarkdown(peak.date)}`);
      }
      for (const point of s.data) {
        lines.push(`- ${escapeMarkdown(point.date, 'line-start')}: ${point.value.toFixed(3)}`);
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

/**
 * Select a stable date-then-station-name page, then group it in the original series order.
 * The name, not the ID, breaks date ties: the ID is absent when it did not resolve, and the
 * name order is the one pages have always had.
 */
function paginateTvSeries(
  series: TvSearchSeries[],
  offset: number,
  limit: number,
): { series: TvSearchSeries[]; totalPoints: number } {
  const orderedPoints = series
    .flatMap(({ data, ...identity }, seriesIndex) =>
      data.map((point, pointIndex) => ({ seriesIndex, identity, pointIndex, point })),
    )
    .sort(
      (a, b) =>
        a.point.date.localeCompare(b.point.date) ||
        a.identity.stationName.localeCompare(b.identity.stationName) ||
        a.seriesIndex - b.seriesIndex ||
        a.pointIndex - b.pointIndex,
    );
  const selected = orderedPoints.slice(offset, offset + limit);
  const bySeries = new Map<number, TvSearchSeries>();
  for (const item of selected) {
    const pageSeries = bySeries.get(item.seriesIndex) ?? { ...item.identity, data: [] };
    pageSeries.data.push(item.point);
    bySeries.set(item.seriesIndex, pageSeries);
  }
  return {
    series: [...bySeries.entries()].sort(([a], [b]) => a - b).map(([, pageSeries]) => pageSeries),
    totalPoints: orderedPoints.length,
  };
}
