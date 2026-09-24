/**
 * @fileoverview GDELT article search tool. Full-text search across the last 3 months
 * of global news coverage in 65+ languages using the GDELT DOC API.
 * @module mcp-server/tools/definitions/search-articles.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getGdeltDocService } from '@/services/gdelt/gdelt-doc-service.js';
import {
  describeDateRangeFault,
  GDELT_DATETIME_PATTERN,
  gdeltDocTimespanSchema,
  isWithinWindow,
  parseRecordTimestamp,
  planWindowContinuation,
  resolveEffectiveWindow,
} from '../date-range.js';
import { escapeMarkdown, markdownUrl } from '../markdown-escape.js';
import { fitToBudget, planCutNotice, recordCharge } from '../response-budget.js';

/**
 * Hard ceiling GDELT's DOC API serves in one article request, and the `maxRecords`
 * schema maximum. Past it there is no offset or cursor — the cap-hit disclosure
 * switches from "raise maxRecords" to partitioning the date window.
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

/** One article's content[] block. format() and the byte budget both use it, so the charge is exact. */
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
    'and returns as many as fit a 48,000-byte response — the rest are counted in withheldCount, with a continuation to reach them. ' +
    'Query supports full GDELT syntax: phrases ("bird flu"), boolean OR ((flu OR pandemic)), source country (sourcecountry:china), ' +
    'source language (sourcelang:spanish), domain (domain:who.int), GKG theme (theme:TAX_DISEASE_OUTBREAK — ' +
    'find identifiers with gdelt_search_themes), ' +
    'tone filter (tone<-5 for negative), proximity (near20:"flu virus"), and repeat (repeat3:"outbreak"). ' +
    '250 is a hard per-call ceiling and GDELT offers no cursor: when a query fills it or a response comes back cut, ' +
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
      retryable: false,
      recovery:
        'Wait at least 5 seconds before retrying; GDELT accepts at most one request every 5 seconds.',
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

  input: z.object({
    query: z
      .string()
      .min(1)
      .describe(
        'Search query. Supports GDELT operators: phrases ("bird flu"), boolean OR ((flu OR pandemic)), ' +
          'sourcecountry:china, sourcelang:spanish, domain:who.int, theme:TAX_DISEASE_OUTBREAK (GKG ' +
          'theme identifiers come from gdelt_search_themes), tone<-5, near20:"flu virus", repeat3:"outbreak".',
      ),
    timespan: gdeltDocTimespanSchema
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
    maxRecords: z
      .number()
      .int()
      .min(1)
      .max(MAX_RECORDS_CEILING)
      .default(75)
      .describe(
        'Maximum number of articles to fetch (1–250); the response carries as many of them as fit its ' +
          "48,000-byte budget. 250 is GDELT's hard per-call ceiling, not a page size — there is no cursor " +
          'past it, so a query that fills 250 must be split into narrower startDatetime/endDatetime windows instead.',
      ),
    sort: z
      .enum(['relevance', 'dateDesc', 'dateAsc', 'toneDesc', 'toneAsc', 'hybridRel'])
      .default('relevance')
      .describe(
        'Sort order: relevance (default), dateDesc/dateAsc, toneDesc/toneAsc, or hybridRel ' +
          '(GDELT hybrid relevance and recency).',
      ),
  }),

  output: z.object({
    articles: z.array(articleSchema).describe('Matching articles sorted per the sort parameter.'),
  }),

  // Agent-facing context — query echo, total count, optional timespan echo, and the
  // cap-hit and byte-budget disclosures with their continuation windows. Reaches
  // structuredContent and content[] automatically; never in the domain return.
  enrichment: {
    effectiveQuery: z.string().describe('Echoed query string for use in follow-up calls.'),
    totalCount: z.number().describe('Number of articles returned in this response.'),
    timespan: z.string().optional().describe('Echoed timespan parameter when provided.'),
    withheldCount: z
      .number()
      .optional()
      .describe(
        'Articles GDELT returned inside the window that this response withheld to stay within its ' +
          '48,000-byte budget — fetched minus returned, not counting articles dropped for falling outside an ' +
          'explicit window. Absent when every in-window article fit.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance on an incomplete or empty result. When no articles matched, how to broaden the query ' +
          'or window. When GDELT returned articles dated outside an explicit startDatetime/endDatetime window, ' +
          'how many were dropped. When the response was cut to its 48,000-byte budget, how many articles it withheld ' +
          'and the route to them. When the maxRecords cap was reached on an uncut response, that more ' +
          'articles may exist — a higher maxRecords below the 250 ceiling, or a narrower date window at it. ' +
          'Absent when a non-empty result set fit under both the cap and the budget.',
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
        'Windows to re-run this query against, one at a time, when more articles are out of reach of this ' +
          'response. For a response cut to its budget under dateDesc or dateAsc: one window resuming from the ' +
          'last returned article, reaching back to the second it was published, so articles from that second ' +
          'come back again — or, when resuming there cannot reach a new article, one window skipping past that ' +
          'second. Otherwise — maxRecords at its 250 ceiling, or a cut under any other sort — the queried window ' +
          'halved, overlapping by one second so no article falls through the seam. Either way, de-duplicate by ' +
          'url. Absent when no window is known, or none would reach further.',
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
    const dateRangeFault = describeDateRangeFault(input.startDatetime, input.endDatetime);
    if (dateRangeFault) {
      throw ctx.fail('invalid_date_range', dateRangeFault, ctx.recoveryFor('invalid_date_range'));
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

    // DOC's boundary behavior is unmeasured, so articles dated outside an explicit window are
    // dropped before the budget: the drop never removes an article inside the caller's window,
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
    const charges = fetched.map((a) => recordCharge(a, renderArticle(a)));
    const emittedCount = fitToBudget(charges);
    const articles = fetched.slice(0, emittedCount);
    const cut = emittedCount < fetched.length;
    const capHit = upstream.length >= input.maxRecords;
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
      notices.push(`No articles matched "${input.query}". ${broaden}`);
    } else if (capHit && !cut) {
      if (input.maxRecords < MAX_RECORDS_CEILING) {
        notices.push(
          `Returned ${upstream.length} articles (maxRecords cap reached — there may be more). ` +
            `Raise maxRecords (up to ${MAX_RECORDS_CEILING}) to fetch more; a response carries only as many ` +
            'as fit its 48,000-byte budget and hands back a continuation for the rest.',
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
    if (cut) {
      const plan = planCutNotice({
        noun: { singular: 'article', plural: 'articles' },
        dedupeKey: 'url',
        sort: input.sort,
        window,
        emittedStamps: articles.map((a) => a.seendate),
        emittedCharges: charges.slice(0, emittedCount),
        nextCharge: charges[emittedCount] as number,
        withheldStamps: fetched.slice(emittedCount).map((a) => a.seendate),
        fetchedCount: fetched.length,
        maxRecords: input.maxRecords,
        ceiling: MAX_RECORDS_CEILING,
        capHit,
        halve: planWindowContinuation,
      });
      ctx.enrich({
        withheldCount: fetched.length - emittedCount,
        ...(plan.windows && { continuationWindows: plan.windows }),
      });
      notices.push(plan.notice);
    }
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
