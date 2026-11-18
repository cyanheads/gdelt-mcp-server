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
  describeTvTimespanFault,
  GDELT_DATETIME_PATTERN,
  resolveEffectiveWindow,
  tvAnalyticsWindow,
} from '../date-range.js';
import {
  clampToCap,
  countInputSchema,
  limitClampSchema,
  renderLimitClamp,
} from '../limit-clamp.js';
import { escapeMarkdown, quoteText, renderNotice, renderQueryEcho } from '../markdown-escape.js';
import { peakOf } from '../peak-of.js';
import { renderStaleResponse, staleResponseSchema } from '../stale-response.js';
import {
  describeStationRangeMisses,
  describeUnresolvedStations,
  parseStationIds,
  stationLabel,
} from '../station-ids.js';
import { sumValues } from '../sum-values.js';
import { defaultTvResolution, describeTvCoveredWindow } from '../tv-covered-window.js';

/** Point pages bound the response without altering the selected station population. */
const MAX_POINTS_PER_PAGE = 20_000;

/** A point's `date`, a data point's or the peak's: GDELT labels a period, never an instant. */
const POINT_DATE_DESCRIPTION =
  "Label of the UTC period the point covers, in ISO 8601: the hour's start for hourly points, and 12:00:00Z of the period's first day for day, week, month, and year points.";

export const gdeltSearchTv = tool('gdelt_search_tv', {
  title: 'Search GDELT TV News',
  description:
    'Search television news closed captions for spoken mentions ' +
    'of a query. Returns a bounded, paged per-station time series showing airtime devoted to the topic — ' +
    "500 points by default, up to 20,000 per page. Each series carries GDELT's display name " +
    'for the station and, when that name resolves to one, the station ID gdelt_get_tv_clips takes as stations. ' +
    'Use stations to select station IDs (e.g. ["CNN", "FOXNEWS", "MSNBC"]), or select with station:, network:, or quoted market: operators in query. ' +
    'TV query also supports in-query operators: station:CNN, network:CBS, market:"National", ' +
    'show:"Anderson Cooper 360", context:"vaccine". ' +
    'Archive coverage varies by station; use gdelt_list_tv_stations for station IDs, network and market values, and monitoring date ranges.',
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
      when: 'A stations entry is not a station ID, GDELT rejected the query — no station was selected, or the query string is malformed — or the TV timespan is malformed.',
      recovery:
        'Read the recovery hint for the specific rule GDELT rejected; when no station was selected, list valid IDs with gdelt_list_tv_stations.',
      thrownBy: 'service',
    },
    {
      reason: 'gdelt_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'GDELT rejected the request for its one-request-per-five-seconds limit, or too many requests were already queued for this one to start in time.',
      retryable: true,
      recovery:
        'Back off before retrying; five seconds is minimum request spacing, not a recovery guarantee, and rate limiting may persist longer. Honor Retry-After when supplied.',
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
      .optional()
      .describe(
        'Station IDs to filter to (e.g. ["CNN", "FOXNEWS", "MSNBC"]) — the stationId values gdelt_list_tv_stations returns, not display labels such as "FOX News". Every supplied ID is forwarded. Alternatively use station:, network:, or quoted market: selectors in query; a selector is required. Obtain network and market values and per-station archive ranges from gdelt_list_tv_stations.',
      ),
    timespan: z
      .string()
      .optional()
      .describe(
        "Relative window counting back from now (a number and unit such as d, m, or y). Now is past the end of most stations' monitoring, so for archived periods set startDatetime/endDatetime inside a station's range from gdelt_list_tv_stations. Ignored when startDatetime/endDatetime are set.",
      ),
    startDatetime: z
      .string()
      .regex(GDELT_DATETIME_PATTERN, 'startDatetime must be exactly 14 digits (YYYYMMDDHHMMSS).')
      .optional()
      .describe(
        'Start datetime in GDELT format YYYYMMDDHHMMSS — exactly 14 digits, no separators (e.g. 20200101000000). Must pair with endDatetime; supplying only one of the two is rejected. GDELT widens it back to the start of its UTC period at the response resolution; notice then names the window the values cover.',
      ),
    endDatetime: z
      .string()
      .regex(GDELT_DATETIME_PATTERN, 'endDatetime must be exactly 14 digits (YYYYMMDDHHMMSS).')
      .optional()
      .describe(
        'End datetime in GDELT format YYYYMMDDHHMMSS — exactly 14 digits, no separators (e.g. 20200131235959). Must pair with startDatetime; supplying only one of the two is rejected. GDELT extends it through the end of its UTC period at the response resolution — an end exactly on the clock hour counts as the second before it, so it adds no period starting there; notice then names the window the values cover.',
      ),
    smoothing: z
      .number()
      .int()
      .min(0)
      .max(30)
      .optional()
      .describe(
        'Trailing moving-average width in timesteps, 0–30 (0 or 1 = none). Width N needs N source steps; leading steps cannot produce averages and peaks may appear later.',
      ),
    normalize: z
      .boolean()
      .default(true)
      .describe(
        'When true (default), values are normalized as % of total airtime, enabling cross-station comparison. ' +
          'When false, returns raw matching 15-second clip counts.',
      ),
    combined: z
      .boolean()
      .default(false)
      .describe(
        'Pool selected stations into one Combined timeline. Normalized values divide pooled matching clips by pooled monitored clips; false keeps separate station series.',
      ),
    dateres: z
      .enum(['hour', 'day', 'week', 'month', 'year'])
      .optional()
      .describe(
        'Optional GDELT aggregation resolution. Omit to let GDELT choose from the window length — hourly up to 7 days, daily under 3 years, monthly beyond; the effective recognized or inferred resolution is returned as dateResolution. Each point counts one whole UTC period: a clock hour, day, Sunday–Saturday week, month, or year.',
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
    limit: countInputSchema(
      MAX_POINTS_PER_PAGE,
      500,
      'Maximum timeline points returned per page (default 500, cap 20,000). Larger counts clamp with limitClamp; strict deployments reject them.',
    ),
  }),

  output: z.object({
    combined: z
      .boolean()
      .describe('True for one pooled Combined timeline; false for separate station series.'),
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
                    date: z.string().describe(POINT_DATE_DESCRIPTION),
                    value: z
                      .number()
                      .describe(
                        'Coverage value (normalized % or raw matching 15-second clip count).',
                      ),
                  })
                  .describe('A single coverage data point.'),
              )
              .describe('Time-ordered coverage data for this station on this page.'),
            pointCount: z
              .number()
              .describe('Points in the whole series, across every page — not only those in data.'),
            peak: z
              .object({
                date: z.string().describe(POINT_DATE_DESCRIPTION),
                value: z.number().describe('Value at the peak.'),
              })
              .describe(
                'The point of the whole series with the largest absolute value, the earliest timestep on a tie, across every page — it may lie outside data.',
              ),
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
        'Maximum points this page holds — the requested limit, or 20,000 when a larger one was clamped.',
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
        'When smoothing is above 1, that leading steps without a full window have no values and peaks may lag. When the query matched no TV coverage: the resolved timespan window; for each selected station whose monitoring range the window misses, that range and how to search inside it; and how to check station coverage. When an explicit startDatetime or endDatetime falls inside a UTC period of the response resolution: the resolution and the UTC window the values cover. When a returned series has no station ID, why: GDELT returned it without a station label, or its station catalog did not load or has no entry for the named label — with how to look the ID up. Absent when coverage was returned, smoothing is at most 1, the window is a timespan or sits on period boundaries, and every series carries its station ID or combined is true.',
      ),
    staleResponse: staleResponseSchema,
  },

  enrichmentTrailer: {
    effectiveQuery: { render: renderQueryEcho },
    limitClamp: { render: renderLimitClamp },
    notice: { render: renderNotice },
    staleResponse: { render: renderStaleResponse },
  },

  async handler(input, ctx) {
    const startedAt = Date.now();
    const stationIds = parseStationIds(input.stations);
    const dateRangeFault = describeDateRangeFault(input.startDatetime, input.endDatetime);
    if (dateRangeFault) {
      throw ctx.fail('invalid_date_range', dateRangeFault);
    }
    const timespanFault = describeTvTimespanFault(input);
    if (timespanFault) {
      throw ctx.fail('invalid_query', 'Invalid TV timespan.', {
        recovery: { hint: timespanFault },
      });
    }

    ctx.log.info('gdelt_search_tv', { query: input.query, stations: stationIds });
    const svc = getGdeltTvService();

    const requested =
      input.startDatetime && input.endDatetime
        ? { startDatetime: input.startDatetime, endDatetime: input.endDatetime }
        : undefined;
    const sent = requested && tvAnalyticsWindow(requested);
    /**
     * GDELT picks the points' resolution from the span it is sent. Where the second taken off an
     * on-the-hour end moves it (exactly 3 × 365 days, or 7 days and a second), the caller's span's
     * resolution goes as dateres, so the timeline keeps the points the caller's window asks for.
     */
    const callerResolution = requested && defaultTvResolution(requested);
    const dateres =
      input.dateres ??
      (sent && defaultTvResolution(sent) !== callerResolution ? callerResolution : undefined);

    const result = await svc.searchTv(
      {
        query: input.query,
        ...(stationIds.length > 0 && { stations: stationIds }),
        ...(input.timespan && { timespan: input.timespan }),
        ...sent,
        ...(input.smoothing != null && { smoothing: input.smoothing }),
        ...(dateres && { dateres }),
        normalize: input.normalize,
        combined: input.combined,
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
    const sortedPageDates = pageDates.toSorted();
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
    if (input.smoothing != null && input.smoothing > 1) {
      notices.push(
        `Trailing moving average width ${input.smoothing} requires that many source steps, so leading steps without a full window cannot produce values; peaks may lag.`,
      );
    }
    if (isEmpty) {
      // A catalog this call already failed to load is not requested again.
      const window = resolveEffectiveWindow(input);
      const ranges =
        window && stationIds.length > 0 && !result.stationCatalogUnavailable
          ? await svc.stationRanges(ctx, startedAt)
          : undefined;
      const rangeMisses =
        window && ranges ? describeStationRangeMisses(stationIds, ranges, window) : '';
      notices.push(
        `No TV coverage for ${quoteText(input.query)}.${describeResolvedTimespan(input)}${rangeMisses} Archive coverage varies by station — verify monitoring dates with gdelt_list_tv_stations and choose a matching window, or broaden the query.`,
      );
    } else {
      // The resolution GDELT answered in: the one it reported, else dateres, else the one
      // inferred from the points.
      const covered = describeTvCoveredWindow('Values', input, result.dateResolution);
      if (covered) notices.push(covered);
    }
    const unresolved = input.combined
      ? undefined
      : describeUnresolvedStations(page.series, result.stationCatalogUnavailable === true, {
          singular: 'series',
          plural: 'series',
        });
    if (unresolved) notices.push(unresolved);
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    ctx.log.info('gdelt_search_tv completed', { seriesCount: result.series.length });
    return {
      combined: input.combined,
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
      `**Combined:** ${result.combined}`,
      `**Stations:** ${result.series.length}`,
      `**Point page:** offset ${result.offset}, limit ${result.limit}`,
      returned > 0
        ? `**Points ${result.offset + 1}–${result.offset + returned} of ${result.totalPoints}**`
        : `**Points:** 0 of ${result.totalPoints}`,
    );
    if (result.nextOffset != null) lines.push(`**Next offset:** ${result.nextOffset}`);
    // Each station's point count and peak cover the whole series, the same on every page; its
    // sum and page peak cover only its points on this page, and the labels say which is which.
    for (const s of result.series) {
      lines.push(
        `\n### ${escapeMarkdown(result.combined ? s.stationName : stationLabel(s), 'heading-end')}`,
      );
      lines.push(
        `Points in the whole series: ${s.pointCount} | Whole-series peak: ${s.peak.value} at ${escapeMarkdown(s.peak.date)}`,
      );
      lines.push(
        `Points on this page: ${s.data.length} | Sum on this page: ${sumValues(s.data.map((d) => d.value))}`,
      );
      const pagePeak = peakOf(s.data);
      if (pagePeak) {
        lines.push(`Page peak: ${pagePeak.value} at ${escapeMarkdown(pagePeak.date)}`);
      }
      for (const point of s.data) {
        lines.push(`- ${escapeMarkdown(point.date, 'line-start')}: ${point.value}`);
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

type TvPoint = TvSearchSeries['data'][number];

/** A series on one point page, carrying its whole series' point count and peak. */
type TvPageSeries = TvSearchSeries & { pointCount: number; peak: TvPoint };

/**
 * Select a stable date-then-station-name page, then group it in the original series order.
 * The name, not the ID, breaks date ties: the ID is absent when it did not resolve, and the
 * name order is the one pages have always had. Each series' point count and peak are read off
 * the same date order across the whole series, so a tied peak is its earliest timestep whatever
 * order GDELT sent the points in.
 */
function paginateTvSeries(
  series: TvSearchSeries[],
  offset: number,
  limit: number,
): { series: TvPageSeries[]; totalPoints: number } {
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
  const bySeries = new Map<
    number,
    { identity: Omit<TvSearchSeries, 'data'>; whole: TvPoint[]; page: TvPoint[] }
  >();
  orderedPoints.forEach((item, rank) => {
    let entry = bySeries.get(item.seriesIndex);
    if (!entry) {
      entry = { identity: item.identity, whole: [], page: [] };
      bySeries.set(item.seriesIndex, entry);
    }
    entry.whole.push(item.point);
    if (rank >= offset && rank < offset + limit) entry.page.push(item.point);
  });
  return {
    series: [...bySeries.entries()]
      .sort(([a], [b]) => a - b)
      .flatMap(([, { identity, whole, page }]) => {
        const peak = peakOf(whole);
        // A page carries only the series with points on it.
        return page.length > 0 && peak
          ? [
              {
                ...identity,
                data: page,
                pointCount: whole.length,
                peak: { date: peak.date, value: peak.value },
              },
            ]
          : [];
      }),
    totalPoints: orderedPoints.length,
  };
}
