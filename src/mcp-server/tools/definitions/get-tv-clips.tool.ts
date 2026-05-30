/**
 * @fileoverview GDELT TV clips tool. Retrieves matching TV news clips with transcript
 * excerpts and Internet Archive viewing links.
 * @module mcp-server/tools/definitions/get-tv-clips.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getGdeltTvService } from '@/services/gdelt/gdelt-tv-service.js';

export const gdeltGetTvClips = tool('gdelt_get_tv_clips', {
  title: 'Get GDELT TV Clips',
  description:
    "Retrieve the top matching TV news clips (up to 3,000) for a query from the Internet Archive's " +
    'Television News Archive. Each clip includes show name, station, air timestamp, a 15-second ' +
    'transcript excerpt, and a direct link to view the full one-minute clip. ' +
    'Use after gdelt_search_tv to read the actual transcript content driving a coverage spike. ' +
    'Archive coverage spans 2009–October 2024.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'no_clips',
      code: JsonRpcErrorCode.NotFound,
      when: 'No TV clips matched the query in the specified time range.',
      recovery:
        'TV data ends October 2024 — supply explicit startDatetime/endDatetime within 2009–2024, ' +
        'or verify station IDs with gdelt_list_tv_stations.',
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
        'Search query for TV transcript content. Same TV operators as gdelt_search_tv: ' +
          'station:CNN, network:CBS, market:"National", show:"Anderson Cooper", context:"vaccine".',
      ),
    stations: z
      .array(z.string())
      .optional()
      .describe(
        'Station IDs to filter to (e.g. ["CNN", "FOXNEWS"]). ' +
          'Omit for all stations. Use gdelt_list_tv_stations to see valid IDs.',
      ),
    timespan: z
      .string()
      .optional()
      .describe(
        'Time window, e.g. "1m", "6m". Ignored when startDatetime/endDatetime are set. ' +
          'TV data spans 2009–October 2024.',
      ),
    startDatetime: z
      .string()
      .optional()
      .describe('Start datetime in GDELT format YYYYMMDDHHMMSS. Must pair with endDatetime.'),
    endDatetime: z
      .string()
      .optional()
      .describe('End datetime in GDELT format YYYYMMDDHHMMSS. Must pair with startDatetime.'),
    maxRecords: z
      .number()
      .int()
      .min(1)
      .max(3000)
      .default(50)
      .describe('Maximum number of clips to return (1–3000).'),
    sort: z
      .enum(['relevance', 'dateDesc', 'dateAsc'])
      .default('relevance')
      .describe(
        'Sort order: relevance (default), dateDesc (newest first), dateAsc (oldest first).',
      ),
  }),

  output: z.object({
    clips: z
      .array(
        z
          .object({
            show: z.string().describe('Show name (e.g. "Anderson Cooper 360").'),
            station: z.string().describe('Station ID (e.g. "CNN").'),
            date: z.string().describe('Air datetime in ISO 8601 format.'),
            snippet: z.string().describe('15-second transcript excerpt surrounding the match.'),
            archiveUrl: z.string().describe('Internet Archive URL to view the full 1-minute clip.'),
            thumbnail: z
              .string()
              .optional()
              .describe('Clip thumbnail URL when provided by the archive.'),
          })
          .describe('A single TV news clip with transcript excerpt and archive link.'),
      )
      .describe('Matching TV clips sorted per the sort parameter.'),
  }),

  // Agent-facing context — query echo, clip count, and notice on empty results.
  // Reaches structuredContent and content[] automatically; never in the domain return.
  enrichment: {
    effectiveQuery: z.string().describe('Echoed query string for use in follow-up calls.'),
    totalCount: z.number().describe('Number of clips returned.'),
    notice: z
      .string()
      .optional()
      .describe('Recovery hint when no clips matched. Absent on successful responses.'),
  },

  async handler(input, ctx) {
    ctx.log.info('gdelt_get_tv_clips', { query: input.query, maxRecords: input.maxRecords });
    const svc = getGdeltTvService();

    const clips = await svc.getTvClips(
      {
        query: input.query,
        ...(input.stations?.length && { stations: input.stations }),
        ...(input.timespan && { timespan: input.timespan }),
        ...(input.startDatetime && { startDatetime: input.startDatetime }),
        ...(input.endDatetime && { endDatetime: input.endDatetime }),
        maxRecords: input.maxRecords,
        sort: input.sort,
      },
      ctx,
    );

    if (clips.length === 0) {
      throw ctx.fail('no_clips', `No TV clips matched "${input.query}"`, {
        recovery: {
          hint:
            `No TV clips for "${input.query}". TV data ends October 2024 — ` +
            `supply explicit startDatetime/endDatetime within 2009–2024, or verify station IDs with gdelt_list_tv_stations.`,
        },
      });
    }

    ctx.enrich.echo(input.query);
    ctx.enrich.total(clips.length);

    ctx.log.info('gdelt_get_tv_clips completed', { count: clips.length });
    return { clips };
  },

  format: (result) => {
    const lines: string[] = [`## GDELT TV Clips`];
    for (const c of result.clips) {
      lines.push(`\n### ${c.show} — ${c.station}`);
      lines.push(`**Date:** ${c.date}`);
      lines.push(`**Snippet:** ${c.snippet}`);
      lines.push(`**View clip:** ${c.archiveUrl}`);
      if (c.thumbnail) lines.push(`**Thumbnail:** ${c.thumbnail}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
