/**
 * @fileoverview Ranked GDELT TV station and show coverage with count pagination.
 * @module mcp-server/tools/definitions/get-tv-breakdown.tool
 */
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getGdeltTvService } from '@/services/gdelt/gdelt-tv-service.js';
import {
  describeDateRangeFault,
  describeResolvedTimespan,
  describeTvTimespanFault,
  GDELT_DATETIME_PATTERN,
  resolveEffectiveWindow,
} from '../date-range.js';
import {
  clampToCap,
  countInputSchema,
  limitClampSchema,
  renderLimitClamp,
} from '../limit-clamp.js';
import { escapeMarkdown, markdownQuote, renderQueryEcho } from '../markdown-escape.js';
import { renderStaleResponse, staleResponseSchema } from '../stale-response.js';
import { describeStationRangeMisses, parseStationIds } from '../station-ids.js';

/** TV rankings expose percentages with different denominators, or raw station clip counts. */
export const gdeltGetTvBreakdown = tool('gdelt_get_tv_breakdown', {
  title: 'Get GDELT TV Breakdown',
  description:
    'Rank TV stations or shows mentioning a query. Station values are percentages of each station’s monitored airtime, or raw matching 15-second clip counts with normalize=false. Show values always represent percentages of matching clips, even with normalize=false. Labels are preserved exactly; ellipsized show labels may not work as exact show: selectors. Returns 25 rows by default, up to 10,000 per page. Archive coverage varies by station; use gdelt_list_tv_stations for station IDs, network and market selectors, and monitoring date ranges.',
  annotations: { readOnlyHint: true, openWorldHint: true },
  errors: [
    {
      reason: 'invalid_date_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Only one explicit datetime was supplied, a datetime is not a real UTC timestamp, or startDatetime is not earlier than endDatetime.',
      recovery:
        'Supply both startDatetime and endDatetime as real UTC calendar timestamps, with startDatetime earlier than endDatetime, or omit both and use timespan instead.',
    },
    {
      reason: 'offset_out_of_range',
      code: JsonRpcErrorCode.NotFound,
      when: 'The requested row offset is at or beyond the end of a non-empty ranking.',
      recovery: 'Retry with an offset between 0 and totalRows - 1 from the preceding response.',
    },
    {
      reason: 'invalid_query',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A stations entry is not a station ID, GDELT rejected the query, or the TV timespan is malformed.',
      recovery:
        'Read the recovery hint for the rejected rule; use gdelt_list_tv_stations for station IDs, networks, and markets.',
      thrownBy: 'service',
    },
    {
      reason: 'gdelt_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'GDELT rejected its request-spacing limit, or the request queue could not start this call in time.',
      retryable: true,
      recovery:
        'Back off before retrying; five seconds is minimum request spacing, not a recovery guarantee. Honor Retry-After when supplied.',
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
        'TV transcript query. Supports phrases, Boolean OR, station:CNN, network:CBS, market:"National", show:"Bloomberg Best", and context:"vaccine".',
      ),
    stations: z
      .array(z.string())
      .optional()
      .describe(
        'Station IDs to select (e.g. ["CNN", "FOXNEWS"]) — the stationId values gdelt_list_tv_stations returns, not display labels such as "FOX News"; every supplied ID is forwarded. Alternatively select station:, network:, or quoted market: in query. A selector is required; obtain network and market values from gdelt_list_tv_stations.',
      ),
    breakdownBy: z
      .enum(['station', 'show'])
      .describe(
        'Rank stations by their airtime share or matching clip count, or shows by percentage of matching clips.',
      ),
    normalize: z
      .boolean()
      .default(true)
      .describe(
        'Station rankings: true returns station-airtime percentages; false returns matching 15-second clip counts. Show rankings always return matching-clip percentages.',
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
      .describe('UTC start in YYYYMMDDHHMMSS format. Must pair with a later endDatetime.'),
    endDatetime: z
      .string()
      .regex(GDELT_DATETIME_PATTERN, 'endDatetime must be exactly 14 digits (YYYYMMDDHHMMSS).')
      .optional()
      .describe('UTC end in YYYYMMDDHHMMSS format. Must pair with an earlier startDatetime.'),
    limit: countInputSchema(
      10_000,
      25,
      'Maximum ranking rows per page (default 25, cap 10,000). Larger counts clamp with limitClamp; strict deployments reject them.',
    ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Zero-based row offset after descending-value and exact-label sorting. Use nextOffset with the same query inputs for the next page.',
      ),
  }),
  output: z.object({
    rows: z
      .array(
        z
          .object({
            label: z
              .string()
              .describe('Exact provider station or show label, including any ellipsis.'),
            value: z.number().describe('Ranking value in valueUnit; no rescaling is applied.'),
            station: z
              .string()
              .optional()
              .describe(
                'Catalog station ID for a resolved station row; absent for shows or unresolved labels.',
              ),
          })
          .describe('A station or show ranking row.'),
      )
      .describe(
        'Rows sorted by descending value, breaking ties by exact label, from the requested page.',
      ),
    valueUnit: z
      .enum(['percent_station_airtime', 'percent_matching_clips', 'matching_clips'])
      .describe(
        'Station-airtime percentage, matching-clip percentage for shows, or raw matching 15-second clip count for stations.',
      ),
    totalRows: z.number().describe('Full ranking row count before pagination.'),
    offset: z.number().describe('Zero-based offset of this ranking page.'),
    limit: z.number().describe('Applied maximum rows on this page.'),
    nextOffset: z
      .number()
      .optional()
      .describe('Offset of the next page; absent when no rows remain.'),
    truncated: z.boolean().describe('True when additional rows remain after this page.'),
  }),
  enrichment: {
    effectiveQuery: z.string().describe('Echoed query for follow-up calls.'),
    limitClamp: limitClampSchema,
    notice: z
      .string()
      .optional()
      .describe(
        'When no rows matched: the resolved timespan window; for each selected station whose monitoring range the window misses, that range and how to search inside it; and how to check station monitoring ranges. On show rankings, that values are percentages of matching clips and ellipsized labels may not work as show: selectors. On station rankings whose page has rows without a station ID, why: the station catalog did not load, or has no entry for the named labels. Absent on a non-empty station ranking whose rows on the page all carry station IDs.',
      ),
    staleResponse: staleResponseSchema,
  },
  enrichmentTrailer: {
    effectiveQuery: { render: renderQueryEcho },
    limitClamp: { render: renderLimitClamp },
    staleResponse: { render: renderStaleResponse },
  },
  async handler(input, ctx) {
    const startedAt = Date.now();
    const stationIds = parseStationIds(input.stations);
    const dateRangeFault = describeDateRangeFault(input.startDatetime, input.endDatetime);
    if (dateRangeFault) throw ctx.fail('invalid_date_range', dateRangeFault);
    const timespanFault = describeTvTimespanFault(input);
    if (timespanFault)
      throw ctx.fail('invalid_query', 'Invalid TV timespan.', {
        recovery: { hint: timespanFault },
      });
    ctx.log.info('gdelt_get_tv_breakdown', { query: input.query, breakdownBy: input.breakdownBy });
    const svc = getGdeltTvService();
    const result = await svc.getTvBreakdown(
      {
        query: input.query,
        breakdownBy: input.breakdownBy,
        normalize: input.normalize,
        ...(stationIds.length > 0 && { stations: stationIds }),
        ...(input.timespan && { timespan: input.timespan }),
        ...(input.startDatetime && { startDatetime: input.startDatetime }),
        ...(input.endDatetime && { endDatetime: input.endDatetime }),
      },
      ctx,
    );
    const limit = clampToCap(ctx, 'limit', input.limit, 10_000);
    const ordered = result.rows.toSorted(
      (a, b) => b.value - a.value || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0),
    );
    const totalRows = ordered.length;
    if (totalRows > 0 && input.offset >= totalRows) {
      throw ctx.fail('offset_out_of_range', `Offset ${input.offset} is outside this ranking.`, {
        offset: input.offset,
        totalRows,
        recovery: {
          hint: `Retry with offset 0–${totalRows - 1}; this ranking has ${totalRows} rows.`,
        },
      });
    }
    const rows = ordered.slice(input.offset, input.offset + limit);
    const nextOffset =
      input.offset + rows.length < totalRows ? input.offset + rows.length : undefined;
    const notices: string[] = [];
    if (totalRows === 0) {
      // A catalog this call already failed to load is not requested again.
      const window = resolveEffectiveWindow(input);
      const ranges =
        window && stationIds.length > 0 && !result.stationCatalogUnavailable
          ? await svc.stationRanges(ctx, startedAt)
          : undefined;
      const rangeMisses =
        window && ranges ? describeStationRangeMisses(stationIds, ranges, window) : '';
      notices.push(
        `No TV rankings for ${markdownQuote(input.query)}.${describeResolvedTimespan(input)}${rangeMisses} Check station monitoring ranges with gdelt_list_tv_stations or broaden the query.`,
      );
    }
    if (input.breakdownBy === 'show')
      notices.push(
        'Show values are percentages of matching clips, regardless of normalize. Provider labels may contain ellipses and may not work as exact show: selectors.',
      );
    else {
      const unresolved = rows.filter((row) => row.station === undefined);
      if (unresolved.length > 0)
        notices.push(
          result.stationCatalogUnavailable
            ? 'Station IDs could not be resolved because the station catalog did not load; labels and values are preserved. Find IDs with gdelt_list_tv_stations; the next call loads the catalog again.'
            : `Station IDs could not be resolved for labels ${unresolved.map((row) => markdownQuote(row.label)).join(', ')}; labels and values are preserved. Find IDs with gdelt_list_tv_stations.`,
        );
    }
    ctx.enrich.echo(input.query);
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));
    return {
      rows,
      valueUnit: result.valueUnit,
      totalRows,
      offset: input.offset,
      limit,
      truncated: nextOffset != null,
      ...(nextOffset != null && { nextOffset }),
    };
  },
  format(result) {
    const lines = [
      '## GDELT TV Breakdown',
      `**Value unit:** ${result.valueUnit}`,
      `**Row page:** offset ${result.offset}, limit ${result.limit}, total ${result.totalRows}`,
      `**Truncated:** ${result.truncated}`,
    ];
    if (result.nextOffset != null) lines.push(`**Next offset:** ${result.nextOffset}`);
    if (result.rows.length === 0) lines.push('No rows returned.');
    for (const row of result.rows)
      lines.push(
        `- **${escapeMarkdown(row.label)}**${row.station !== undefined ? ` (${escapeMarkdown(row.station)})` : ''}: ${row.value}`,
      );
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
