/**
 * @fileoverview GDELT article search tool. Full-text search across the last 3 months
 * of global news coverage in 65+ languages using the GDELT DOC API.
 * @module mcp-server/tools/definitions/search-articles.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getGdeltDocService } from '@/services/gdelt/gdelt-doc-service.js';

export const gdeltSearchArticles = tool('gdelt_search_articles', {
  title: 'Search GDELT Articles',
  description:
    'Search the last 3 months of global news coverage (65+ languages) using the GDELT DOC API. ' +
    'Returns up to 250 articles with URL, title, source domain, language, country, publication date, and social image URL. ' +
    'Query supports full GDELT syntax: phrases ("bird flu"), boolean OR ((flu OR pandemic)), source country (sourcecountry:china), ' +
    'source language (sourcelang:spanish), domain (domain:who.int), GKG theme (theme:DISEASE_OUTBREAK), ' +
    'tone filter (tone<-5 for negative), proximity (near20:"flu virus"), and repeat (repeat3:"outbreak"). ' +
    'Note: this API covers only the most recent 3 months — use gdelt_search_tv for historical TV transcripts back to 2009.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'no_articles',
      code: JsonRpcErrorCode.NotFound,
      when: 'No articles matched the query within the specified time range.',
      recovery: 'Broaden the query, remove operators, extend timespan, or try synonym terms.',
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
        'Search query. Supports GDELT operators: phrases ("bird flu"), boolean OR ((flu OR pandemic)), ' +
          'sourcecountry:china, sourcelang:spanish, domain:who.int, theme:DISEASE_OUTBREAK, tone<-5, ' +
          'near20:"flu virus", repeat3:"outbreak".',
      ),
    timespan: z
      .string()
      .optional()
      .describe(
        'Time window relative to now, e.g. "24h", "7d", "1m". Ignored when startDatetime/endDatetime are set. ' +
          'Maximum is 3 months (the full DOC API window). Defaults to the full 3-month window.',
      ),
    startDatetime: z
      .string()
      .optional()
      .describe(
        'Start of date range in GDELT format YYYYMMDDHHMMSS (e.g. 20240101000000). ' +
          'Must be used together with endDatetime.',
      ),
    endDatetime: z
      .string()
      .optional()
      .describe(
        'End of date range in GDELT format YYYYMMDDHHMMSS (e.g. 20240131235959). ' +
          'Must be used together with startDatetime.',
      ),
    maxRecords: z
      .number()
      .int()
      .min(1)
      .max(250)
      .default(75)
      .describe('Maximum number of articles to return (1–250).'),
    sort: z
      .enum(['date', 'relevance', 'social'])
      .default('relevance')
      .describe(
        'Sort order: relevance (default), date (newest first), social (most socially shared).',
      ),
  }),

  output: z.object({
    articles: z
      .array(
        z
          .object({
            url: z.string().describe('Article URL.'),
            title: z.string().describe('Article title.'),
            seendate: z
              .string()
              .describe('Publication datetime in GDELT format (YYYYMMDDTHHMMSSZ).'),
            domain: z.string().describe('Source domain (e.g. "nytimes.com").'),
            language: z.string().describe('Article language (e.g. "English", "Spanish").'),
            sourcecountry: z
              .string()
              .describe('Country of the source outlet (e.g. "United States").'),
            socialimage: z
              .string()
              .optional()
              .describe('Social sharing image URL when provided by the source.'),
          })
          .describe('A single news article with metadata.'),
      )
      .describe('Matching articles sorted per the sort parameter.'),
  }),

  // Agent-facing context — query echo, total count, optional timespan echo, and notice
  // when no results. Reaches structuredContent and content[] automatically; never in the
  // domain return.
  enrichment: {
    effectiveQuery: z.string().describe('Echoed query string for use in follow-up calls.'),
    totalCount: z.number().describe('Number of articles returned in this response.'),
    timespan: z.string().optional().describe('Echoed timespan parameter when provided.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Recovery hint when no articles matched — echoes filters and suggests how to broaden. Absent on successful responses.',
      ),
  },

  async handler(input, ctx) {
    ctx.log.info('gdelt_search_articles', { query: input.query });
    const svc = getGdeltDocService();
    const result = await svc.searchArticles(
      {
        query: input.query,
        ...(input.timespan && { timespan: input.timespan }),
        ...(input.startDatetime && { startDatetime: input.startDatetime }),
        ...(input.endDatetime && { endDatetime: input.endDatetime }),
        maxRecords: input.maxRecords,
        sort: input.sort,
      },
      ctx,
    );

    if (result.articles.length === 0) {
      throw ctx.fail('no_articles', `No articles matched "${input.query}"`, {
        recovery: {
          hint: `No articles matched "${input.query}". Try broadening the query or extending the timespan.`,
        },
      });
    }

    ctx.enrich.echo(input.query);
    ctx.enrich.total(result.articles.length);
    if (input.timespan) ctx.enrich({ timespan: input.timespan });

    ctx.log.info('gdelt_search_articles completed', { count: result.articles.length });
    return { articles: result.articles };
  },

  format: (result) => {
    const lines: string[] = [`## GDELT Article Search`];
    for (const a of result.articles) {
      lines.push(`\n### ${a.title}`);
      lines.push(`**URL:** ${a.url}`);
      lines.push(
        `**Source:** ${a.domain} | **Country:** ${a.sourcecountry} | **Language:** ${a.language}`,
      );
      lines.push(`**Date:** ${a.seendate}`);
      if (a.socialimage) lines.push(`**Image:** ${a.socialimage}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
