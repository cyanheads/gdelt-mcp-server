/**
 * @fileoverview GDELT TV search tool. Searches US television news closed captions
 * for spoken mentions and returns normalized per-station coverage time series.
 * @module mcp-server/tools/definitions/search-tv.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { formatDateShort, resolveTimespan } from '@/services/gdelt/gdelt-fetch.js';
import { getGdeltTvService } from '@/services/gdelt/gdelt-tv-service.js';
import { GDELT_DATETIME_PATTERN, isUnpairedDateRange } from '../date-range.js';

export const gdeltSearchTv = tool('gdelt_search_tv', {
  title: 'Search GDELT TV News',
  description:
    'Search US television news closed captions (2009–October 2024, 150+ stations) for spoken mentions ' +
    'of a query. Returns a normalized per-station time series showing relative airtime devoted to the topic. ' +
    'Use the stations parameter to select networks (e.g. ["CNN", "FOXNEWS", "MSNBC"]) — the TV API ' +
    'requires at least one station, supplied either there or as a station: selector inside query. ' +
    'TV query also supports in-query operators: station:CNN, network:CBS, market:"National", ' +
    'show:"Anderson Cooper 360", context:"vaccine". ' +
    'Important: most station monitoring ended October 2024 — use gdelt_list_tv_stations to verify ' +
    'active date ranges before querying recent events.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'no_tv_coverage',
      code: JsonRpcErrorCode.NotFound,
      when: 'No TV coverage found for the query in the specified time range.',
      recovery:
        'Check that the stations were active during the time range using gdelt_list_tv_stations, ' +
        'broaden the query, or extend the timespan.',
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
      when: 'GDELT rejected the query — no station was selected, or the query string is malformed.',
      recovery:
        'Read the recovery hint for the specific rule GDELT rejected; when no station was selected, list valid IDs with gdelt_list_tv_stations.',
    },
    {
      reason: 'gdelt_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'GDELT TV API is unreachable or rate-limited.',
      retryable: true,
      recovery: 'Wait at least 5 seconds before retrying — GDELT enforces 1 request per 5 seconds.',
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
        'Station IDs to filter to (e.g. ["CNN", "FOXNEWS", "MSNBC"]). ' +
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
          'When false, returns raw coverage volume.',
      ),
  }),

  output: z.object({
    dateResolution: z
      .enum(['hour', 'day', 'month'])
      .describe('Temporal resolution of data points.'),
    timeRange: z
      .object({
        start: z.string().describe('Earliest date in the returned data.'),
        end: z.string().describe('Latest date in the returned data.'),
      })
      .describe('Date range spanned by the returned data.'),
    series: z
      .array(
        z
          .object({
            station: z.string().describe('Station ID (e.g. "CNN").'),
            data: z
              .array(
                z
                  .object({
                    date: z.string().describe('Timestep in ISO 8601 format.'),
                    value: z.number().describe('Coverage value (normalized % or raw count).'),
                  })
                  .describe('A single coverage data point.'),
              )
              .describe('Time-ordered coverage data for this station.'),
          })
          .describe('Coverage time series for a single station.'),
      )
      .describe('One series per station or combined national coverage.'),
    normalized: z.boolean().describe('True when values are normalized coverage percentages.'),
  }),

  // Agent-facing context — query echo, station count, and notice on empty results.
  // Reaches structuredContent and content[] automatically; never in the domain return.
  enrichment: {
    effectiveQuery: z.string().describe('Echoed query string for use in follow-up calls.'),
    totalCount: z.number().describe('Number of station series returned.'),
    notice: z
      .string()
      .optional()
      .describe('Recovery hint when no TV coverage was found. Absent on successful responses.'),
  },

  async handler(input, ctx) {
    if (isUnpairedDateRange(input.startDatetime, input.endDatetime)) {
      throw ctx.fail(
        'invalid_date_range',
        'startDatetime and endDatetime must be supplied together',
        ctx.recoveryFor('invalid_date_range'),
      );
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
        normalize: input.normalize,
      },
      ctx,
    );

    if (result.series.length === 0 || result.series.every((s) => s.data.length === 0)) {
      let rangeNote = '';
      if (input.timespan && !input.startDatetime && !input.endDatetime) {
        const range = resolveTimespan(input.timespan);
        if (range) {
          rangeNote = ` Timespan "${input.timespan}" resolved to ${formatDateShort(range.start)} – ${formatDateShort(range.end)}.`;
        }
      }
      throw ctx.fail('no_tv_coverage', `No TV coverage found for "${input.query}"`, {
        recovery: {
          hint:
            `No TV coverage for "${input.query}".${rangeNote} Most TV data ends October 2024 — ` +
            `use gdelt_list_tv_stations to check station active dates.`,
        },
      });
    }

    ctx.enrich.echo(input.query);
    ctx.enrich.total(result.series.length);

    ctx.log.info('gdelt_search_tv completed', { seriesCount: result.series.length });
    return {
      dateResolution: result.dateResolution,
      timeRange: result.timeRange,
      series: result.series,
      normalized: result.normalized,
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## GDELT TV News Coverage`,
      `**Date Resolution:** ${result.dateResolution}`,
      `**Time Range:** ${result.timeRange.start} to ${result.timeRange.end}`,
      `**Normalized:** ${result.normalized ? 'Yes (% of airtime)' : 'No (raw count)'}`,
      `**Stations:** ${result.series.length}`,
    ];
    for (const s of result.series) {
      const peak = s.data.reduce(
        (max, d) => (d.value > max.value ? d : max),
        s.data[0] ?? { date: '', value: 0 },
      );
      const total = s.data.reduce((sum, d) => sum + d.value, 0);
      lines.push(`\n### ${s.station}`);
      lines.push(`Points: ${s.data.length} | Total: ${total.toFixed(2)}`);
      if (peak.date) lines.push(`Peak: ${peak.value.toFixed(3)} at ${peak.date}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
