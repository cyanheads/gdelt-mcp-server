/**
 * @fileoverview GDELT article search tool. Full-text search across the last 3 months
 * of global news coverage in 65+ languages using the GDELT DOC API.
 * @module mcp-server/tools/definitions/search-articles.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getGdeltDocService } from '@/services/gdelt/gdelt-doc-service.js';
import {
  GDELT_DATETIME_PATTERN,
  isUnpairedDateRange,
  planWindowContinuation,
  resolveEffectiveWindow,
} from '../date-range.js';

/**
 * Hard ceiling GDELT's DOC API serves in one article request, and the `maxRecords`
 * schema maximum. Past it there is no offset or cursor — the cap-hit disclosure
 * switches from "raise maxRecords" to partitioning the date window.
 */
const MAX_RECORDS_CEILING = 250;

export const gdeltSearchArticles = tool('gdelt_search_articles', {
  title: 'Search GDELT Articles',
  description:
    'Search the last 3 months of global news coverage (65+ languages) using the GDELT DOC API. ' +
    'Returns up to 250 articles with URL, title, source domain, language, country, publication date, and social image URL. ' +
    'Query supports full GDELT syntax: phrases ("bird flu"), boolean OR ((flu OR pandemic)), source country (sourcecountry:china), ' +
    'source language (sourcelang:spanish), domain (domain:who.int), GKG theme (theme:DISEASE_OUTBREAK), ' +
    'tone filter (tone<-5 for negative), proximity (near20:"flu virus"), and repeat (repeat3:"outbreak"). ' +
    '250 is a hard per-call ceiling and GDELT offers no cursor: when a query fills it, split the run into ' +
    'narrower startDatetime/endDatetime windows — the response hands back the exact windows to use. ' +
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
      reason: 'invalid_date_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Exactly one of startDatetime / endDatetime was supplied.',
      recovery:
        'Supply both startDatetime and endDatetime to pin an explicit window, or omit both and use timespan instead.',
    },
    {
      reason: 'invalid_query',
      code: JsonRpcErrorCode.ValidationError,
      when: 'GDELT rejected the query string as malformed — bad keyword length, unbalanced parentheses, or an illegal character.',
      recovery:
        'Read the recovery hint for the specific rule GDELT rejected, then fix the query and retry.',
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
      .regex(GDELT_DATETIME_PATTERN, 'startDatetime must be exactly 14 digits (YYYYMMDDHHMMSS).')
      .optional()
      .describe(
        'Start of date range in GDELT format YYYYMMDDHHMMSS — exactly 14 digits, no separators ' +
          '(e.g. 20240101000000). Must be supplied together with endDatetime; supplying only one ' +
          'of the two is rejected.',
      ),
    endDatetime: z
      .string()
      .regex(GDELT_DATETIME_PATTERN, 'endDatetime must be exactly 14 digits (YYYYMMDDHHMMSS).')
      .optional()
      .describe(
        'End of date range in GDELT format YYYYMMDDHHMMSS — exactly 14 digits, no separators ' +
          '(e.g. 20240131235959). Must be supplied together with startDatetime; supplying only one ' +
          'of the two is rejected.',
      ),
    maxRecords: z
      .number()
      .int()
      .min(1)
      .max(MAX_RECORDS_CEILING)
      .default(75)
      .describe(
        "Maximum number of articles to return (1–250). 250 is GDELT's hard per-call ceiling, not a " +
          'page size — there is no cursor past it, so a query that fills 250 must be split into narrower ' +
          'startDatetime/endDatetime windows instead.',
      ),
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

  // Agent-facing context — query echo, total count, optional timespan echo, and the
  // cap-hit disclosure with its continuation windows. Reaches structuredContent and
  // content[] automatically; never in the domain return.
  enrichment: {
    effectiveQuery: z.string().describe('Echoed query string for use in follow-up calls.'),
    totalCount: z.number().describe('Number of articles returned in this response.'),
    timespan: z.string().optional().describe('Echoed timespan parameter when provided.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Disclosure that the maxRecords cap was reached and more articles may exist, naming the route ' +
          'to them — a higher maxRecords below the 250 ceiling, or a narrower date window at it. ' +
          'Absent when the full result set fit under the cap.',
      ),
    continuationWindows: z
      .array(
        z
          .object({
            startDatetime: z
              .string()
              .describe('Start of this window in GDELT format YYYYMMDDHHMMSS.'),
            endDatetime: z.string().describe('End of this window in GDELT format YYYYMMDDHHMMSS.'),
          })
          .describe('One window to re-query with the same query string.'),
      )
      .optional()
      .describe(
        'The queried window halved, to re-run this query against one pair at a time when maxRecords is at ' +
          'its 250 ceiling. The halves overlap by one second so no article falls through the seam; an article ' +
          'published on that second can come back in both, so de-duplicate by url. Absent unless the ceiling ' +
          'was reached with a window that is both known and wide enough to divide.',
      ),
  },

  enrichmentTrailer: {
    continuationWindows: {
      render: (windows = []) =>
        [
          '**Continuation windows:**',
          ...windows.map(
            (w) => `- startDatetime: ${w.startDatetime}, endDatetime: ${w.endDatetime}`,
          ),
        ].join('\n'),
    },
  },

  async handler(input, ctx) {
    if (isUnpairedDateRange(input.startDatetime, input.endDatetime)) {
      throw ctx.fail(
        'invalid_date_range',
        'startDatetime and endDatetime must be supplied together',
        ctx.recoveryFor('invalid_date_range'),
      );
    }

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
    if (result.articles.length >= input.maxRecords) {
      if (input.maxRecords < MAX_RECORDS_CEILING) {
        ctx.enrich.notice(
          `Returned ${result.articles.length} articles (maxRecords cap reached — there may be more). ` +
            `Increase maxRecords up to ${MAX_RECORDS_CEILING} to retrieve more.`,
        );
      } else {
        const continuation = planWindowContinuation(resolveEffectiveWindow(input));
        if (continuation.windows) ctx.enrich({ continuationWindows: continuation.windows });
        ctx.enrich.notice(
          `Returned ${result.articles.length} articles — maxRecords is already at its ${MAX_RECORDS_CEILING} ceiling, ` +
            `so more articles almost certainly matched. ${continuation.guidance}`,
        );
      }
    }

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
