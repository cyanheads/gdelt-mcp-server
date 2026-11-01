/**
 * @fileoverview GDELT article search tool. Full-text search across the last 3 months
 * of global news coverage in 65+ languages using the GDELT DOC API.
 * @module mcp-server/tools/definitions/search-articles.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { routeArticleSearch } from '@/services/gdelt/doc-source-router.js';
import {
  describeDateRangeFault,
  describeResolvedTimespan,
  GDELT_DATETIME_PATTERN,
  isWithinWindow,
  parseRecordTimestamp,
  planWindowContinuation,
  refineDocTimespan,
  renderContinuationWindows,
  resolveEffectiveWindow,
} from '../date-range.js';
import {
  clampToCap,
  countInputSchema,
  limitClampSchema,
  renderLimitClamp,
} from '../limit-clamp.js';
import { escapeMarkdown, markdownQuote, markdownUrl, renderQueryEcho } from '../markdown-escape.js';
import {
  DOC_EMPTY_RETRY_NOTE,
  docProvenanceEnrichment,
  docProvenanceTrailer,
  mirrorAnswerNotice,
} from '../source-provenance.js';

/**
 * Hard ceiling GDELT's DOC API serves in one article request. Past it there is no offset or
 * cursor — the cap-hit disclosure switches from "raise maxRecords" to partitioning the date
 * window. A larger `maxRecords` runs at this ceiling when clamping is enabled.
 */
const MAX_RECORDS_CEILING = 250;

/** One article record — the output item schema, and the type `renderArticle` renders. */
const articleSchema = z
  .object({
    url: z.string().describe('Article URL.'),
    title: z.string().describe('Article title.'),
    seendate: z.string().describe('Publication datetime in GDELT format (YYYYMMDDTHHMMSSZ).'),
    domain: z.string().describe('Source domain (e.g. "nytimes.com").'),
    language: z.string().describe('Article language (e.g. "English", "Spanish").'),
    sourcecountry: z.string().describe('Country of the source outlet (e.g. "United States").'),
    socialimage: z
      .string()
      .optional()
      .describe('Social sharing image URL when provided by the source.'),
  })
  .describe('A single news article with metadata.');

/** One article's content[] block. */
function renderArticle(a: z.infer<typeof articleSchema>): string {
  const lines = [
    `\n### ${escapeMarkdown(a.title, 'heading-end')}`,
    `**URL:** ${markdownUrl(a.url)}`,
    `**Source:** ${escapeMarkdown(a.domain)} | **Country:** ${escapeMarkdown(a.sourcecountry)} | ` +
      `**Language:** ${escapeMarkdown(a.language)}`,
    `**Date:** ${escapeMarkdown(a.seendate)}`,
  ];
  if (a.socialimage) lines.push(`**Image:** ${markdownUrl(a.socialimage)}`);
  return lines.join('\n');
}

export const gdeltSearchArticles = tool('gdelt_search_articles', {
  title: 'Search GDELT Articles',
  description:
    'Search the last 3 months of global news coverage (65+ languages) using the GDELT DOC API. ' +
    'Fetches up to 250 articles with URL, title, source domain, language, country, publication date, and social image URL, ' +
    'and returns every fetched article inside the requested window. ' +
    'Query supports full GDELT syntax: phrases ("bird flu"), boolean OR ((flu OR pandemic)), source country (sourcecountry:china), ' +
    'source language (sourcelang:spanish), domain (domain:who.int), GKG theme (theme:TAX_DISEASE_OUTBREAK — ' +
    'find identifiers with gdelt_search_themes), ' +
    'tone filter (tone<-5 for negative), proximity (near20:"flu virus"), and repeat (repeat3:"outbreak"). ' +
    '250 is a hard per-call ceiling and GDELT offers no cursor: when a query fills it, ' +
    're-query narrower startDatetime/endDatetime windows — the response hands back the exact windows to use. ' +
    'Note: this API covers only the most recent 3 months — use gdelt_search_tv for historical TV transcripts back to 2009.',
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
      reason: 'invalid_query',
      code: JsonRpcErrorCode.ValidationError,
      when: 'GDELT rejected the query string as malformed — bad keyword length, unbalanced parentheses, or an illegal character.',
      recovery:
        'Read the recovery hint for the specific rule GDELT rejected, then fix the query and retry.',
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
      when: 'GDELT DOC API is unreachable or temporarily returned no usable data.',
      retryable: true,
      recovery: 'Retry after a short delay; GDELT may be temporarily unavailable.',
      thrownBy: 'service',
    },
  ],

  input: z
    .object({
      query: z
        .string()
        .min(1)
        .describe(
          'Search query. Supports GDELT operators: phrases ("bird flu"), boolean OR ((flu OR pandemic)), ' +
            'sourcecountry:china, sourcelang:spanish, domain:who.int, theme:TAX_DISEASE_OUTBREAK (GKG ' +
            'theme identifiers come from gdelt_search_themes), tone<-5, near20:"flu virus", repeat3:"outbreak".',
        ),
      timespan: z
        .string()
        .optional()
        .describe(
          'Time window relative to now, minimum "15min"; other examples: "24h", "7d", "1m". Ignored when startDatetime/endDatetime are set. ' +
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
      maxRecords: countInputSchema(
        MAX_RECORDS_CEILING,
        75,
        "Maximum number of articles to fetch. Defaults to 75; values above 250 run at 250 with a limitClamp disclosure unless clamping is disabled. Every fetched in-window record is returned. 250 is GDELT's hard per-call ceiling, with no cursor; split a query that fills it into narrower startDatetime/endDatetime windows.",
      ),
      sort: z
        .enum(['relevance', 'dateDesc', 'dateAsc', 'toneDesc', 'toneAsc', 'hybridRel'])
        .default('relevance')
        .describe(
          'Sort order: relevance (default), dateDesc/dateAsc, toneDesc/toneAsc, or hybridRel ' +
            '(GDELT hybrid relevance and recency).',
        ),
    })
    .superRefine(refineDocTimespan),

  output: z.object({
    articles: z.array(articleSchema).describe('Matching articles sorted per the sort parameter.'),
  }),

  // Query echo, returned count, cap continuations, and explicit-window drop notices.
  enrichment: {
    effectiveQuery: z.string().describe('Echoed query string for use in follow-up calls.'),
    totalCount: z.number().describe('Number of articles returned in this response.'),
    timespan: z.string().optional().describe('Echoed timespan parameter when provided.'),
    limitClamp: limitClampSchema,
    notice: z
      .string()
      .optional()
      .describe(
        "Guidance on an incomplete or empty result. When no articles matched, how to broaden the query or window. When GDELT returned articles dated outside an explicit startDatetime/endDatetime window, how many were dropped. When the maxRecords cap was reached, raise maxRecords below the 250 ceiling or narrow the date window at it. When the server's local GKG mirror answered (source: gkg_mirror), why, and how its answer differs from the DOC API's. Absent when a non-empty result set from the DOC API is below the cap and no article was dropped as out of window.",
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
        'Windows to re-run this query against when maxRecords reaches its 250 ceiling: the queried window halved, overlapping by one second so no article falls through the seam. De-duplicate by url. Absent when no window is known or narrowing cannot reach further articles.',
      ),
    ...docProvenanceEnrichment,
  },

  enrichmentTrailer: {
    effectiveQuery: { render: renderQueryEcho },
    timespan: { render: (timespan = '') => `**timespan:** ${markdownQuote(timespan)}` },
    limitClamp: { render: renderLimitClamp },
    continuationWindows: { render: renderContinuationWindows },
    ...docProvenanceTrailer,
  },

  async handler(input, ctx) {
    const dateRangeFault = describeDateRangeFault(input.startDatetime, input.endDatetime);
    if (dateRangeFault) {
      throw ctx.fail('invalid_date_range', dateRangeFault);
    }

    const maxRecords = clampToCap(ctx, 'maxRecords', input.maxRecords, MAX_RECORDS_CEILING);
    ctx.log.info('gdelt_search_articles', { query: input.query, maxRecords });
    const { result, standIn } = await routeArticleSearch(
      {
        query: input.query,
        ...(input.timespan && { timespan: input.timespan }),
        ...(input.startDatetime && { startDatetime: input.startDatetime }),
        ...(input.endDatetime && { endDatetime: input.endDatetime }),
        maxRecords,
        sort: input.sort,
      },
      ctx,
    );

    // DOC's boundary behavior is unmeasured, so articles dated outside an explicit window are
    // dropped: the drop never removes an article inside the caller's window,
    // and it keeps a continuation walk convergent whatever DOC does at the edge. A timespan
    // window is resolved by GDELT against its own clock and is left alone. The cap is judged on
    // the upstream count.
    const upstream = result.articles;
    const window = resolveEffectiveWindow(input);
    const pinned = input.startDatetime && input.endDatetime ? window : undefined;
    const fetched = pinned
      ? upstream.filter((a) => {
          const seen = parseRecordTimestamp(a.seendate);
          return seen === undefined || isWithinWindow(pinned, seen);
        })
      : upstream;
    const dropped = upstream.length - fetched.length;
    const articles = fetched;
    const capHit = upstream.length >= maxRecords;
    const broaden = pinned
      ? `Broaden the query, remove operators, widen the ${pinned.startDatetime}–${pinned.endDatetime} window, or try synonym terms.`
      : 'Broaden the query, remove operators, extend the timespan, or try synonym terms.';

    ctx.enrich.echo(input.query);
    ctx.enrich.total(articles.length);
    if (input.timespan) ctx.enrich({ timespan: input.timespan });

    // Every notice segment for this response accumulates here and is flushed once —
    // ctx.enrich.notice is last-wins, so a second call would silently drop the first.
    const notices: string[] = [];
    if (upstream.length === 0) {
      notices.push(
        `No articles matched ${markdownQuote(input.query)}.${describeResolvedTimespan(input)} ${broaden}`,
      );
      if (!standIn) notices.push(DOC_EMPTY_RETRY_NOTE);
    } else if (capHit) {
      if (maxRecords < MAX_RECORDS_CEILING) {
        notices.push(
          `Returned ${upstream.length} articles (maxRecords cap reached — there may be more). ` +
            `Raise maxRecords (up to ${MAX_RECORDS_CEILING}) to fetch more.`,
        );
      } else {
        const continuation = planWindowContinuation(window);
        if (continuation.windows) ctx.enrich({ continuationWindows: continuation.windows });
        notices.push(
          `Returned ${upstream.length} articles — maxRecords is already at its ${MAX_RECORDS_CEILING} ceiling, ` +
            `so more articles almost certainly matched. ${continuation.guidance}`,
        );
      }
    }
    if (pinned && dropped > 0) {
      notices.push(
        `GDELT returned ${dropped} ${dropped === 1 ? 'article' : 'articles'} dated outside ` +
          `${pinned.startDatetime}–${pinned.endDatetime}; ${dropped === 1 ? 'it was' : 'they were'} dropped. ` +
          'At the edges of a window from continuationWindows these belong to the neighboring window — ' +
          'not a sign of missing results.',
      );
      if (fetched.length === 0)
        notices.push(`No article was published inside the window. ${broaden}`);
    }
    if (standIn) notices.push(mirrorAnswerNotice(standIn));
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    ctx.log.info('gdelt_search_articles completed', {
      fetched: fetched.length,
      count: articles.length,
    });
    return { articles };
  },

  format: (result) => {
    const lines: string[] = [`## GDELT Article Search`];
    if (result.articles.length === 0) lines.push('No articles returned.');
    for (const a of result.articles) lines.push(renderArticle(a));
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
