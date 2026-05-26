/**
 * @fileoverview GDELT TV station listing tool. Lists all television stations available
 * for TV search with monitoring date ranges and active status.
 * @module mcp-server/tools/definitions/list-tv-stations.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getGdeltTvService } from '@/services/gdelt/gdelt-tv-service.js';

export const gdeltListTvStations = tool('gdelt_list_tv_stations', {
  title: 'List GDELT TV Stations',
  description:
    'List all television stations available for TV search with their market, network, monitoring ' +
    'start date, and monitoring end date. ' +
    'Stations with an end date within the last 24 hours are flagged as active; ' +
    'stations with earlier end dates are discontinued. ' +
    'Use before querying to verify a station was active during the target time period, ' +
    'or to discover valid station IDs for the stations parameter in other TV tools. ' +
    'Most station monitoring ended October 2024 when the Internet Archive TV feed stopped updating.',
  annotations: { readOnlyHint: true, openWorldHint: false },

  errors: [
    {
      reason: 'no_stations',
      code: JsonRpcErrorCode.NotFound,
      when: 'The station list returned empty — API may be temporarily unavailable.',
      recovery:
        'Retry after a short delay; the station list is static and should always return data.',
    },
    {
      reason: 'gdelt_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'GDELT TV API is unreachable or rate-limited.',
      retryable: true,
      recovery: 'Wait at least 5 seconds before retrying — GDELT enforces 1 request per 5 seconds.',
    },
  ],

  input: z.object({}),

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
      .describe('All TV stations sorted by station ID.'),
    activeCount: z.number().describe('Number of stations currently flagged as active.'),
    totalCount: z.number().describe('Total number of stations in the list.'),
  }),

  async handler(_input, ctx) {
    ctx.log.info('gdelt_list_tv_stations');
    const svc = getGdeltTvService();

    const stations = await svc.listStations(ctx);

    if (stations.length === 0) {
      throw ctx.fail('no_stations', 'Station list returned empty', {
        ...ctx.recoveryFor('no_stations'),
      });
    }

    const sorted = stations.slice().sort((a, b) => a.stationId.localeCompare(b.stationId));
    const activeCount = sorted.filter((s) => s.isActive).length;

    ctx.log.info('gdelt_list_tv_stations completed', { total: sorted.length, active: activeCount });
    return { stations: sorted, activeCount, totalCount: sorted.length };
  },

  format: (result) => {
    const lines: string[] = [
      `## GDELT TV Stations`,
      `**Total:** ${result.totalCount} | **Active:** ${result.activeCount}`,
    ];

    // Group by market for readability
    const national = result.stations.filter((s) => s.market === 'National');
    const local = result.stations.filter((s) => s.market !== 'National');

    if (national.length > 0) {
      lines.push('\n### National Networks');
      for (const s of national) {
        const status = s.isActive ? '✓ Active' : `Ended ${s.endDate}`;
        lines.push(
          `- **${s.stationId}** — ${s.description} | ${s.network} | ${s.startDate}–${s.endDate} | ${status}`,
        );
      }
    }
    if (local.length > 0) {
      lines.push('\n### Local/Regional Stations');
      for (const s of local) {
        const status = s.isActive ? '✓ Active' : `Ended ${s.endDate}`;
        lines.push(
          `- **${s.stationId}** — ${s.description} | Market: ${s.market} | ${s.network} | ${s.startDate}–${s.endDate} | ${status}`,
        );
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
