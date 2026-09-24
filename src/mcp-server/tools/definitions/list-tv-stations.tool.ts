/**
 * @fileoverview GDELT TV station listing tool. Lists the television stations available for
 * TV search with monitoring date ranges and active status, optionally narrowed by station ID,
 * network, or market.
 * @module mcp-server/tools/definitions/list-tv-stations.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getGdeltTvService } from '@/services/gdelt/gdelt-tv-service.js';
import type { TvStation } from '@/services/gdelt/types.js';
import { escapeMarkdown } from '../markdown-escape.js';

/** Non-US markets in the catalog. Every other market not starting with `National` is a US city. */
const INTERNATIONAL_MARKETS = new Set(['International', 'Japan']);

/** Filter comparison key: whole value, trimmed, case-folded. */
function filterKey(value: string): string {
  return value.trim().toLowerCase();
}

/** One rendered station line — identical across groups so every line names its market. */
function renderStation(s: TvStation): string {
  const end = escapeMarkdown(s.endDate);
  const status = s.isActive ? '✓ Active' : `Ended ${end}`;
  return (
    `- **${escapeMarkdown(s.stationId)}** — ${escapeMarkdown(s.description)} | ` +
    `Market: ${escapeMarkdown(s.market)} | ${escapeMarkdown(s.network)} | ` +
    `${escapeMarkdown(s.startDate)}–${end} | ${status}`
  );
}

export const gdeltListTvStations = tool('gdelt_list_tv_stations', {
  title: 'List GDELT TV Stations',
  description:
    'List the television stations available for TV search with their market, network, monitoring ' +
    'start date, and monitoring end date — every station by default, or only those matching the ' +
    'optional stations, network, and market filters (each an exact, case-insensitive match; combined ' +
    'with AND). activeCount and totalCount count the returned stations. ' +
    'Stations with an end date within the last 24 hours are flagged as active; ' +
    'stations with earlier end dates are discontinued. ' +
    'Use before querying to verify a station was active during the target time period, ' +
    'or to discover valid station IDs for the stations parameter in other TV tools. ' +
    'Most station monitoring ended October 2024 when the Internet Archive TV feed stopped updating.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  errors: [
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
      when: 'GDELT TV API is unreachable or temporarily returned no usable data, including an empty station catalog.',
      retryable: true,
      recovery: 'Retry after a short delay; GDELT may be temporarily unavailable.',
      thrownBy: 'service',
    },
  ],

  input: z.object({
    stations: z
      .array(z.string())
      .optional()
      .describe(
        'Station IDs to return (e.g. ["CNN", "FOXNEWS", "MSNBC"]) — the IDs the stations parameter of ' +
          'the other TV tools takes. Matches any listed ID, exactly and case-insensitively after ' +
          'trimming; IDs that match no station are named in the notice. Blank entries are ignored; ' +
          'omit it or pass [] to include every station.',
      ),
    network: z
      .string()
      .optional()
      .describe(
        'Network to narrow to (e.g. "CNN", "ABC"), matched as a whole value case-insensitively after ' +
          'trimming — "FOX" does not match "FOXNEWS". Values come from the network field of the ' +
          'unfiltered list. Blank is ignored.',
      ),
    market: z
      .string()
      .optional()
      .describe(
        'Market to narrow to (e.g. "National", "San Francisco"), matched as a whole value ' +
          'case-insensitively after trimming — "National" does not match "NationalSpecialty". Values ' +
          'come from the market field of the unfiltered list. Blank is ignored.',
      ),
  }),

  output: z.object({
    stations: z
      .array(
        z
          .object({
            stationId: z.string().describe('Station ID used in TV query operators (e.g. "CNN").'),
            description: z.string().describe('Human-readable station description.'),
            market: z.string().describe('Market (e.g. "National", "San Francisco").'),
            network: z.string().describe('Network affiliation (e.g. "CNN", "NBC").'),
            startDate: z.string().describe('Monitoring start date in ISO 8601 format.'),
            endDate: z.string().describe('Monitoring end date in ISO 8601 format.'),
            isActive: z
              .boolean()
              .describe(
                'True when the end date is within the last 24 hours (recently updated feed). ' +
                  'False for discontinued stations.',
              ),
          })
          .describe('A single TV station with monitoring metadata.'),
      )
      .describe(
        'Stations matching every supplied filter — all stations when none is given — sorted by station ID.',
      ),
    activeCount: z.number().describe('Number of returned stations currently flagged as active.'),
    totalCount: z
      .number()
      .describe('Number of stations returned — the whole catalog when no filter is given.'),
  }),

  // Agent-facing context — the filter outcome. Reaches structuredContent and content[]
  // automatically; never in the domain return, so the unfiltered payload is unchanged.
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Filter outcome: names the filters when no station matched, and names requested station IDs ' +
          'that are not in the catalog or that another filter excluded. Absent when every requested ID ' +
          'was returned and the result is not empty.',
      ),
  },

  async handler(input, ctx) {
    ctx.log.info('gdelt_list_tv_stations', {
      stations: input.stations,
      network: input.network,
      market: input.market,
    });
    const svc = getGdeltTvService();

    const stations = await svc.listStations(ctx);

    // The catalog is static; an empty one is GDELT failing, whatever filters were asked for.
    if (stations.length === 0) {
      throw ctx.fail(
        'gdelt_unavailable',
        'GDELT TV station catalog came back empty — the endpoint may be temporarily unavailable.',
        ctx.recoveryFor('gdelt_unavailable'),
      );
    }

    // Blank values are omitted filters, not filters that match nothing.
    const requestedIds = new Map<string, string>();
    for (const id of input.stations ?? []) {
      const trimmed = id.trim();
      if (trimmed && !requestedIds.has(filterKey(trimmed))) {
        requestedIds.set(filterKey(trimmed), trimmed);
      }
    }
    const network = input.network?.trim() || undefined;
    const market = input.market?.trim() || undefined;

    const sorted = stations.slice().sort((a, b) => a.stationId.localeCompare(b.stationId));
    const returned = sorted.filter(
      (s) =>
        (requestedIds.size === 0 || requestedIds.has(filterKey(s.stationId))) &&
        (!network || filterKey(s.network) === filterKey(network)) &&
        (!market || filterKey(s.market) === filterKey(market)),
    );
    const activeCount = returned.filter((s) => s.isActive).length;

    // Every notice segment for this response accumulates here and is flushed once —
    // ctx.enrich.notice is last-wins, so a second call would silently drop the first.
    const notices: string[] = [];
    const quotedIds = [...requestedIds.values()].map((id) => `"${id}"`).join(', ');
    const attributeFilters = [
      network && `network "${network}"`,
      market && `market "${market}"`,
    ].filter(Boolean);
    if (returned.length === 0) {
      const applied = [requestedIds.size > 0 && `stations [${quotedIds}]`, ...attributeFilters];
      notices.push(`No station matched ${applied.filter(Boolean).join(', ')}.`);
    }
    const catalogIds = new Set(sorted.map((s) => filterKey(s.stationId)));
    const returnedIds = new Set(returned.map((s) => filterKey(s.stationId)));
    const unknownIds = [...requestedIds]
      .filter(([key]) => !catalogIds.has(key))
      .map(([, id]) => id);
    const excludedIds = [...requestedIds]
      .filter(([key]) => catalogIds.has(key) && !returnedIds.has(key))
      .map(([, id]) => id);
    if (unknownIds.length > 0) notices.push(`No station has ID ${unknownIds.join(', ')}.`);
    if (excludedIds.length > 0) {
      notices.push(
        `${excludedIds.join(', ')} ${excludedIds.length === 1 ? 'is a station' : 'are stations'} ` +
          `but did not match ${attributeFilters.join(' and ')}.`,
      );
    }
    if (returned.length === 0 || unknownIds.length > 0) {
      notices.push(
        'Filters match whole values case-insensitively — network "FOX" does not match "FOXNEWS". ' +
          'Call gdelt_list_tv_stations with no arguments to see every station ID, network, and market.',
      );
    }
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    ctx.log.info('gdelt_list_tv_stations completed', {
      catalog: sorted.length,
      returned: returned.length,
      active: activeCount,
    });
    return { stations: returned, activeCount, totalCount: returned.length };
  },

  format: (result) => {
    const lines: string[] = [
      `## GDELT TV Stations`,
      `**Total:** ${result.totalCount} | **Active:** ${result.activeCount}`,
    ];
    if (result.stations.length === 0) lines.push('No stations returned.');

    // Group by market category: every National* market (including the specialty and
    // discontinued feeds), the non-US markets, then US city markets.
    const groups: Array<[heading: string, stations: TvStation[]]> = [
      ['National Networks', result.stations.filter((s) => s.market.startsWith('National'))],
      [
        'International Stations',
        result.stations.filter((s) => INTERNATIONAL_MARKETS.has(s.market)),
      ],
      [
        'Local/Regional Stations',
        result.stations.filter(
          (s) => !s.market.startsWith('National') && !INTERNATIONAL_MARKETS.has(s.market),
        ),
      ],
    ];
    for (const [heading, stations] of groups) {
      if (stations.length === 0) continue;
      lines.push(`\n### ${heading}`);
      for (const s of stations) lines.push(renderStation(s));
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
