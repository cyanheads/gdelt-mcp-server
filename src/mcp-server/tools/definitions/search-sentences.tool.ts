/**
 * @fileoverview GDELT sentence search tool. Sentence-level matches with the surrounding text,
 * one per article, across the last 72 hours of English-language news via the GDELT Context 2.0
 * API.
 * @module mcp-server/tools/definitions/search-sentences.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getGdeltContextService } from '@/services/gdelt/gdelt-context-service.js';
import {
  type ContextContinuation,
  type ContextWindowPlan,
  planContextContinuation,
  planContextWindow,
  roundUpToMinute,
} from '../context-window.js';
import {
  GDELT_DATETIME_PATTERN,
  type GdeltWindow,
  isWithinWindow,
  parseRecordTimestamp,
} from '../date-range.js';
import {
  clampToCap,
  countInputSchema,
  limitClampSchema,
  renderLimitClamp,
} from '../limit-clamp.js';
import {
  escapeMarkdown,
  markdownQuote,
  markdownUrl,
  quoteText,
  renderNotice,
  renderQueryEcho,
} from '../markdown-escape.js';
import { queryInputSchema } from '../query-input.js';
import { renderStaleResponse, staleResponseSchema } from '../stale-response.js';
import { discloseWindowClamp, renderWindowClamp, windowClampSchema } from '../window-clamp.js';

/** Most sentences the Context API counts toward one request: 201 is refused. */
const MAX_RECORDS_CEILING = 200;

/**
 * `domain:` and `domainis:`, which GDELT documents for Context but answered with no match on
 * every live probe — on queries whose terms the named domains carried in the same hours.
 */
const DOMAIN_OPERATOR = /\bdomain(?:is)?:/i;

/** One sentence match — the output item schema, and the type `renderMatch` renders. */
const matchSchema = z
  .object({
    url: z.string().describe('Article URL.'),
    title: z.string().describe('Article title.'),
    seendate: z
      .string()
      .describe(
        'When GDELT saw the article, in GDELT format (YYYYMMDDTHHMMSSZ) — not its publication time; an old article can carry a recent seendate.',
      ),
    domain: z.string().describe('Source domain (e.g. "nytimes.com").'),
    language: z.string().describe('Article language as GDELT names it (e.g. "ENGLISH").'),
    isquote: z.boolean().describe('True when the sentence holds a quotation mark.'),
    sentence: z.string().describe('The matching sentence, exactly as GDELT returned it.'),
    context: z
      .string()
      .describe('The sentence with the text around it, exactly as GDELT returned it.'),
    socialimage: z
      .string()
      .optional()
      .describe('Social sharing image URL. Absent when the article has none.'),
  })
  .describe('One matching sentence and the article it came from.');

/** One match's content[] block. */
function renderMatch(m: z.infer<typeof matchSchema>): string {
  const lines = [
    `\n### ${escapeMarkdown(m.title, 'heading-end')}`,
    `**URL:** ${markdownUrl(m.url)}`,
    `**Source:** ${escapeMarkdown(m.domain)} | **Language:** ${escapeMarkdown(m.language)}`,
    `**Seen:** ${escapeMarkdown(m.seendate)} | **Quote:** ${m.isquote}`,
    `**Sentence:** ${escapeMarkdown(m.sentence)}`,
    `**Context:** ${escapeMarkdown(m.context)}`,
  ];
  if (m.socialimage) lines.push(`**Image:** ${markdownUrl(m.socialimage)}`);
  return lines.join('\n');
}

/** The `continuationWindow` line of the `content[]` trailer. */
function renderContinuationWindow(window: GdeltWindow): string {
  return `**Continuation window:** startDatetime: ${window.startDatetime}, endDatetime: ${window.endDatetime}`;
}

/** Where the call searched, for an empty-result notice. */
function describeWindow(plan: Extract<ContextWindowPlan, { kind: 'timespan' | 'explicit' }>) {
  return plan.kind === 'timespan'
    ? `in the last ${plan.timespan}`
    : `in ${plan.window.startDatetime}–${plan.window.endDatetime}`;
}

/**
 * The window past a one-minute page that already ran at the ceiling, when there is one: no bound
 * splits that minute, so only the rest of the window is left to read.
 */
function skipPastMinute(continuation: ContextContinuation, maxRecords: number) {
  return continuation.kind === 'blocked' &&
    continuation.cause === 'one_minute' &&
    maxRecords >= MAX_RECORDS_CEILING
    ? continuation.skip
    : undefined;
}

/** The notice sentence for how the page continues, or `undefined` when it needs none. */
function describeContinuation(
  continuation: ContextContinuation,
  sort: 'dateDesc' | 'dateAsc',
  shown: number,
  request: GdeltWindow,
  maxRecords: number,
): string | undefined {
  const further = sort === 'dateDesc' ? 'older' : 'newer';
  switch (continuation.kind) {
    case 'next':
      return `maxRecords counts matching sentences before GDELT keeps one per article, so this page of ${shown} is not every match: re-run the call with continuationWindow's startDatetime and endDatetime to reach ${further} matches, and de-duplicate by url. On a broad query a page can span only seconds of coverage; adding a term narrows it.`;
    case 'complete':
      return `This page reached past the ${sort === 'dateDesc' ? 'start' : 'end'} of the window, so it holds every match in the window.`;
    case 'blocked': {
      const skip = skipPastMinute(continuation, maxRecords);
      if (skip) {
        return `Every match on this page was seen in the minute from ${skip.minute}, and GDELT reads window bounds only to the minute, so no window reaches the rest of that minute, even at the ${MAX_RECORDS_CEILING} ceiling: continuationWindow skips past it to reach ${further} matches, and de-duplicate by url.`;
      }
      const cause =
        continuation.cause === 'widened'
          ? `the window went out widened to ${request.startDatetime}–${request.endDatetime}, and matches outside it take the page first`
          : 'every match on this page was seen within one minute, and GDELT reads window bounds only to the minute';
      const remedy =
        maxRecords < MAX_RECORDS_CEILING
          ? `Raise maxRecords (up to ${MAX_RECORDS_CEILING}) to read further.`
          : `At the ${MAX_RECORDS_CEILING} ceiling, the rest of the window is not retrievable through this API.`;
      return `No narrower window reaches further matches: ${cause}. ${remedy}`;
    }
    case 'none':
      return;
    default:
      return continuation satisfies never;
  }
}

export const gdeltSearchSentences = tool('gdelt_search_sentences', {
  title: 'Search GDELT Sentences',
  description:
    'Search the sentences of the last 72 hours of English-language news coverage with the GDELT Context 2.0 API, to read what coverage actually said. Every query term must fall inside one sentence; each match returns that sentence, the text around it, and its article URL, title, domain, and seen date — one sentence per article. Matches come newest first (dateDesc) or oldest first (dateAsc); there is no relevance ranking. maxRecords counts matching sentences before GDELT keeps one per article, so pages run short, and a page that is not every match hands back continuationWindow, the startDatetime/endDatetime that reaches the next matches. GDELT reads window bounds only to the minute, so a page whose matches all fall in one minute cannot be continued inside it: raise maxRecords, and at its 200 ceiling continuationWindow skips past that minute. Query operators: phrases ("bird flu"), OR groups ((ukraine OR gaza) ceasefire), -term to exclude an exact word, near5:"trump putin", and repeat2:"ukraine"; quotesOnly keeps sentences holding a quotation mark. For the DOC-only filters (sourcecountry:, sourcelang:, theme:, tone), domain filtering, other languages, or coverage older than 72 hours, use gdelt_search_articles.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'invalid_date_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Only one of startDatetime / endDatetime was supplied, one of them is not a real UTC calendar timestamp, startDatetime is not earlier than endDatetime or not in the past, or the window ends before the last 72 hours the Context API searches.',
      recovery:
        'Supply both startDatetime and endDatetime as real UTC timestamps inside the last 72 hours, startDatetime first, or omit both and use timespan instead.',
    },
    {
      reason: 'invalid_query',
      code: JsonRpcErrorCode.ValidationError,
      when: 'GDELT rejected the query — a DOC-only operator, sourcelang:, an overly short, long, or common keyword, or malformed syntax — or the timespan is not a whole number followed by min, h, hours, d, or days, or is shorter than 31 minutes.',
      recovery:
        'Read the recovery hint for the rule that failed, then fix the query or the timespan and retry.',
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
      when: 'GDELT Context API is unreachable or temporarily returned no usable data.',
      retryable: true,
      recovery: 'Retry after a short delay; GDELT may be temporarily unavailable.',
      thrownBy: 'service',
    },
  ],

  input: z.object({
    query: queryInputSchema(
      'Words and phrases that must all appear in one sentence. Supports phrases ("bird flu"), OR groups ((ukraine OR gaza) ceasefire), -term to exclude an exact word (-russia still matches "Russian"), near5:"trump putin" (words within about five words of each other), and repeat2:"ukraine" (a word at least twice). GDELT refuses the DOC-only operators sourcecountry:, sourcelang:, theme:, and tone here.',
    ),
    timespan: z
      .string()
      .optional()
      .describe(
        'Window counting back from now: a whole number followed by min, h, hours, d, or days, in any case, from 31min to 72h (e.g. "6h", "3days"). A longer one runs as 72h with a windowClamp disclosure; a shorter one, or another unit such as w or m, is refused. Defaults to 72h. Ignored when startDatetime/endDatetime are set.',
      ),
    startDatetime: z
      .string()
      .regex(GDELT_DATETIME_PATTERN, 'startDatetime must be exactly 14 digits (YYYYMMDDHHMMSS).')
      .optional()
      .describe(
        'Start of an explicit window in GDELT format YYYYMMDDHHMMSS (UTC, exactly 14 digits). Must pair with endDatetime. A start older than 72 hours runs from 5 minutes inside the reach, disclosed in windowClamp. A window under 60 minutes goes upstream widened, and matches outside it are dropped.',
      ),
    endDatetime: z
      .string()
      .regex(GDELT_DATETIME_PATTERN, 'endDatetime must be exactly 14 digits (YYYYMMDDHHMMSS).')
      .optional()
      .describe(
        'End of an explicit window in GDELT format YYYYMMDDHHMMSS (UTC, exactly 14 digits). Must pair with startDatetime. A window ending before the last 72 hours is refused.',
      ),
    maxRecords: countInputSchema(
      MAX_RECORDS_CEILING,
      25,
      'Matching sentences to request. Defaults to 25. GDELT counts sentences before keeping one per article, so a page usually holds fewer matches; follow continuationWindow for the rest. Values above 200 run at 200 with a limitClamp disclosure unless clamping is disabled.',
    ),
    sort: z
      .enum(['dateDesc', 'dateAsc'])
      .default('dateDesc')
      .describe(
        'dateDesc (default) returns the newest matches first, dateAsc the oldest. The Context API has no relevance order.',
      ),
    quotesOnly: z
      .boolean()
      .default(false)
      .describe(
        'Keep only sentences holding a quotation mark. The sentence may hold only part of a longer quotation.',
      ),
  }),

  output: z.object({
    matches: z
      .array(matchSchema)
      .describe('One matching sentence per article, in the requested date order.'),
  }),

  enrichment: {
    effectiveQuery: z.string().describe('Echoed query string for use in follow-up calls.'),
    totalCount: z.number().describe('Number of matches returned in this response.'),
    timespan: z
      .string()
      .optional()
      .describe(
        'The timespan the request ran with: the one sent, trimmed, or 72h when none was sent or a longer one was clamped. Absent when startDatetime/endDatetime were used.',
      ),
    limitClamp: limitClampSchema,
    windowClamp: windowClampSchema,
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance on this page: when nothing matched, how to broaden the query or window; when GDELT returned matches outside an explicit window — it reads window bounds only to the minute, and a window under 60 minutes goes out widened — how many were dropped; when continuationWindow is present, that this page is not every match; when the page reached past the far edge of its window, that it holds every match in it; and when no narrower window reaches further matches, why, and whether a larger maxRecords helps — or, at the 200 ceiling, that continuationWindow skips the rest of the one minute every match on the page fell in.',
      ),
    continuationWindow: z
      .object({
        startDatetime: z
          .string()
          .describe('Start of the next window in GDELT format YYYYMMDDHHMMSS.'),
        endDatetime: z.string().describe('End of the next window in GDELT format YYYYMMDDHHMMSS.'),
      })
      .optional()
      .describe(
        'The window that reaches the next matches: re-run the same call with these as startDatetime and endDatetime. GDELT reads window bounds only to the minute, so under dateDesc it ends on the whole minute at or after the oldest match on this page and under dateAsc starts on the whole minute at or before the newest; matches seen in that minute can repeat — de-duplicate by url. On a page at the 200 maxRecords ceiling whose matches all fall in one minute, it skips past that minute instead, since no window reaches the rest of it. Absent on an empty page, on a page that holds every match in its window, and when no narrower window reaches further matches.',
      ),
    staleResponse: staleResponseSchema,
  },

  enrichmentTrailer: {
    effectiveQuery: { render: renderQueryEcho },
    timespan: { render: (timespan = '') => `**timespan:** ${markdownQuote(timespan)}` },
    limitClamp: { render: renderLimitClamp },
    windowClamp: { render: renderWindowClamp },
    notice: { render: renderNotice },
    continuationWindow: { render: renderContinuationWindow },
    staleResponse: { render: renderStaleResponse },
  },

  async handler(input, ctx) {
    const now = Date.now();
    const plan = planContextWindow(input, input.sort, now);
    if (plan.kind === 'invalid_date_range') {
      throw ctx.fail(
        'invalid_date_range',
        plan.message,
        plan.hint ? { recovery: { hint: plan.hint } } : undefined,
      );
    }
    if (plan.kind === 'invalid_timespan') {
      throw ctx.fail('invalid_query', plan.message, { recovery: { hint: plan.hint } });
    }

    const maxRecords = clampToCap(ctx, 'maxRecords', input.maxRecords, MAX_RECORDS_CEILING);
    if (plan.clamp) discloseWindowClamp(ctx, plan.clamp);
    const { request } = plan;
    ctx.log.info('gdelt_search_sentences', { query: input.query, maxRecords, sort: input.sort });

    const upstream = await getGdeltContextService().searchSentences(
      {
        query: input.query,
        maxRecords,
        sort: input.sort,
        quotesOnly: input.quotesOnly,
        window: plan.kind === 'timespan' ? { timespan: plan.timespan } : plan.request,
      },
      ctx,
    );

    /**
     * An explicit request answers for more than the caller asked — GDELT reads its bounds only to
     * the minute, and a short one goes out widened — so matches outside the caller's window are
     * dropped. A timespan is resolved by GDELT on its own clock and kept whole.
     */
    const seen = upstream.map((m) => parseRecordTimestamp(m.seendate));
    const matches =
      plan.kind === 'explicit'
        ? upstream.filter((_, i) => {
            const at = seen[i];
            return at === undefined || isWithinWindow(plan.window, at);
          })
        : upstream;
    const dropped = upstream.length - matches.length;
    const continuation = planContextContinuation(
      plan.window,
      request,
      input.sort,
      seen.filter((at): at is number => at !== undefined),
      now,
    );

    ctx.enrich.echo(input.query);
    ctx.enrich.total(matches.length);
    if (plan.kind === 'timespan') ctx.enrich({ timespan: plan.timespan });
    const continuationWindow =
      continuation.kind === 'next'
        ? continuation.window
        : skipPastMinute(continuation, maxRecords)?.window;
    if (continuationWindow) ctx.enrich({ continuationWindow });

    /**
     * Every notice segment for this response accumulates here and is flushed once —
     * ctx.enrich.notice is last-wins, so a second call would silently drop the first.
     */
    const notices: string[] = [];
    if (upstream.length === 0) {
      notices.push(
        `No sentence matched ${quoteText(input.query)} ${describeWindow(plan)}. The Context API matches only when every query term falls inside one sentence, and it searches English-language coverage of the last 72 hours: drop a term or an operator${input.quotesOnly ? ', turn quotesOnly off,' : ''} or widen the window. For the DOC-only filters (sourcecountry:, sourcelang:, theme:, tone) or older coverage, use gdelt_search_articles.`,
      );
      if (DOMAIN_OPERATOR.test(input.query)) {
        notices.push(
          'The Context API answered every live domain: and domainis: query with no matches, even for domains that carried the query terms; filter by domain with gdelt_search_articles.',
        );
      }
    }
    if (dropped > 0) {
      // Past rounding its end up to the minute, a request differs from the window only by widening.
      const widened =
        request.startDatetime !== plan.window.startDatetime ||
        request.endDatetime !== roundUpToMinute(plan.window.endDatetime);
      notices.push(
        `${widened ? `The Context API refuses a window this short, so the request went out widened to ${request.startDatetime}–${request.endDatetime}, and GDELT` : 'GDELT reads window bounds only to the minute and'} returned ${dropped} ${dropped === 1 ? 'match' : 'matches'} seen outside ${plan.window.startDatetime}–${plan.window.endDatetime}; ${dropped === 1 ? 'it was' : 'they were'} dropped.`,
      );
      if (matches.length === 0) notices.push('No match was seen inside the window.');
    }
    const next = describeContinuation(
      continuation,
      input.sort,
      matches.length,
      request,
      maxRecords,
    );
    if (next) notices.push(next);
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    ctx.log.info('gdelt_search_sentences completed', {
      upstream: upstream.length,
      dropped,
      count: matches.length,
      continuation: continuation.kind,
    });
    return { matches };
  },

  format: (result) => {
    const lines: string[] = ['## GDELT Sentence Search'];
    if (result.matches.length === 0) lines.push('No matches returned.');
    for (const m of result.matches) lines.push(renderMatch(m));
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
