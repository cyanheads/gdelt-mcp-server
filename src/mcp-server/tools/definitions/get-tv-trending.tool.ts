/**
 * @fileoverview GDELT TV trending tool. Returns trending topics currently dominating
 * US television news — no query required.
 * @module mcp-server/tools/definitions/get-tv-trending.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getGdeltTvService } from '@/services/gdelt/gdelt-tv-service.js';

export const gdeltGetTvTrending = tool('gdelt_get_tv_trending', {
  title: 'Get GDELT TV Trending',
  description:
    'Retrieve trending topics, keywords, and phrases currently dominating US television news ' +
    'across national networks. No query required — returns the top memes of the present news cycle. ' +
    'Updated every 15 minutes. ' +
    'Note: the GDELT TV archive feed stopped updating around October 2024; results from this endpoint ' +
    'reflect that most-recent archived data rather than a live feed.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'no_trending',
      code: JsonRpcErrorCode.NotFound,
      when: 'No trending topics returned — the endpoint returned an empty list.',
      recovery:
        'The TV archive is frozen at October 2024. For historical TV analysis, use gdelt_search_tv with startDatetime/endDatetime within the 2009–2024 window.',
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
    topics: z
      .array(
        z
          .object({
            label: z.string().describe('Trending topic, keyword, or phrase.'),
            score: z
              .number()
              .describe(
                'Relative trending score. Higher scores indicate topics with greater current airtime.',
              ),
          })
          .describe('A single trending topic with its relative score.'),
      )
      .describe('Trending topics sorted by score descending.'),
  }),

  // Agent-facing context — total topic count and notice on empty results.
  // Reaches structuredContent and content[] automatically; never in the domain return.
  enrichment: {
    totalCount: z.number().describe('Total number of trending topics returned.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery hint when no trending topics were returned. Absent on successful responses.',
      ),
  },

  async handler(_input, ctx) {
    ctx.log.info('gdelt_get_tv_trending');
    const svc = getGdeltTvService();

    const topics = await svc.getTvTrending(ctx);

    if (topics.length === 0) {
      throw ctx.fail('no_trending', 'No trending topics returned', {
        ...ctx.recoveryFor('no_trending'),
      });
    }

    ctx.enrich.total(topics.length);

    ctx.log.info('gdelt_get_tv_trending completed', { count: topics.length });
    return {
      topics: topics.sort((a, b) => b.score - a.score),
    };
  },

  format: (result) => {
    const lines: string[] = [
      `## GDELT TV Trending Topics`,
      `_Note: reflects the October 2024 TV archive cutoff, not a live feed_`,
    ];
    lines.push('\n### Trending Now');
    for (const t of result.topics.slice(0, 50)) {
      lines.push(`- **${t.label}** (score: ${t.score.toFixed(2)})`);
    }
    if (result.topics.length > 50) lines.push(`\n_… ${result.topics.length - 50} more topics_`);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
