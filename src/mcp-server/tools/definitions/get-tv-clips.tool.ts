/**
 * @fileoverview GDELT TV clips tool. Retrieves matching TV news clips with transcript
 * excerpts and Internet Archive viewing links.
 * @module mcp-server/tools/definitions/get-tv-clips.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getGdeltTvService } from '@/services/gdelt/gdelt-tv-service.js';
import {
  describeDateRangeFault,
  describeResolvedTimespan,
  GDELT_DATETIME_PATTERN,
  isWithinWindow,
  parseRecordTimestamp,
  planTvWindowContinuation,
  resolveEffectiveWindow,
  type TvCap,
  tvRequestWindow,
} from '../date-range.js';
import { escapeMarkdown, markdownUrl } from '../markdown-escape.js';
import { fitToBudget, planCutNotice, recordCharge } from '../response-budget.js';

/**
 * Hard ceiling GDELT's TV API serves in one clip request, and the `maxRecords` schema
 * maximum. Past it there is no offset or cursor — the cap-hit disclosure switches from
 * "raise maxRecords" to partitioning the date window.
 */
const MAX_RECORDS_CEILING = 3000;

/** One clip record — the output item schema, and the type `renderClip` renders. */
const clipSchema = z
  .object({
    show: z.string().describe('Show name (e.g. "Anderson Cooper 360").'),
    station: z.string().describe('Station ID (e.g. "CNN").'),
    date: z.string().describe('Air datetime in ISO 8601 format.'),
    snippet: z.string().describe('15-second transcript excerpt surrounding the match.'),
    archiveUrl: z.string().describe('Internet Archive URL to view the full 1-minute clip.'),
    thumbnail: z.string().optional().describe('Clip thumbnail URL when provided by the archive.'),
  })
  .describe('A single TV news clip with transcript excerpt and archive link.');

/**
 * Where to look when no clip aired inside the window, worded for what the caller sent: a
 * pinned window is checked against the archive span, a timespan or no window at all is told
 * to pin one.
 */
function noClipGuidance(input: {
  startDatetime?: string | undefined;
  endDatetime?: string | undefined;
}): string {
  return input.startDatetime && input.endDatetime
    ? `TV data spans 2009–October 2024 — check that ${input.startDatetime}–${input.endDatetime} falls ` +
        'inside it and that the stations were active then with gdelt_list_tv_stations, or broaden the query.'
    : 'TV data ends October 2024 — supply explicit startDatetime/endDatetime within 2009–2024, or verify ' +
        'station IDs with gdelt_list_tv_stations.';
}

/** One clip's content[] block. format() and the byte budget both use it, so the charge is exact. */
function renderClip(c: z.infer<typeof clipSchema>): string {
  const lines = [
    `\n### ${escapeMarkdown(c.show)} — ${escapeMarkdown(c.station, 'heading-end')}`,
    `**Date:** ${escapeMarkdown(c.date)}`,
    `**Snippet:** ${escapeMarkdown(c.snippet)}`,
    `**View clip:** ${markdownUrl(c.archiveUrl)}`,
  ];
  if (c.thumbnail) lines.push(`**Thumbnail:** ${markdownUrl(c.thumbnail)}`);
  return lines.join('\n');
}

export const gdeltGetTvClips = tool('gdelt_get_tv_clips', {
  title: 'Get GDELT TV Clips',
  description:
    "Retrieve the top matching TV news clips for a query from the Internet Archive's " +
    'Television News Archive: fetches up to 3,000 and returns as many as fit a 48,000-byte response — ' +
    'the rest are counted in withheldCount, with a continuation to reach them. Each clip includes show ' +
    'name, station, air timestamp, a 15-second transcript excerpt, and a direct link to view the full ' +
    'one-minute clip. Use after gdelt_search_tv to read the actual transcript content driving a coverage spike. ' +
    'GDELT answers TV windows in whole clock hours; clips it returns from outside an explicit startDatetime/endDatetime ' +
    'window are dropped, and continuing a cut response at maxRecords 3000 leaves room for them. ' +
    '3,000 is a hard per-call ceiling and GDELT offers no cursor: when a query fills it or a response comes ' +
    'back cut, re-query narrower startDatetime/endDatetime windows — the response hands back the exact windows to use. ' +
    'Archive coverage spans 2009–October 2024.',
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
      when: 'GDELT rejected the query — no station was selected, or the query string is malformed.',
      recovery:
        'Read the recovery hint for the specific rule GDELT rejected; when no station was selected, list valid IDs with gdelt_list_tv_stations.',
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
        'Search query for TV transcript content. Same TV operators as gdelt_search_tv: ' +
          'station:CNN, network:CBS, market:"National", show:"Anderson Cooper", context:"vaccine".',
      ),
    stations: z
      .array(z.string())
      .optional()
      .describe(
        'Station IDs to filter to (e.g. ["CNN", "FOXNEWS"]). ' +
          'The GDELT TV API requires at least one station — supply it here, or embed a station: ' +
          'selector directly in query. Omitting both is rejected; it does not fall back to all stations. ' +
          'Use gdelt_list_tv_stations to see valid IDs.',
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
      .regex(GDELT_DATETIME_PATTERN, 'startDatetime must be exactly 14 digits (YYYYMMDDHHMMSS).')
      .optional()
      .describe(
        'Start datetime in GDELT format YYYYMMDDHHMMSS — exactly 14 digits, no separators ' +
          '(e.g. 20200101000000). Must pair with endDatetime; supplying only one of the two is rejected.',
      ),
    endDatetime: z
      .string()
      .regex(GDELT_DATETIME_PATTERN, 'endDatetime must be exactly 14 digits (YYYYMMDDHHMMSS).')
      .optional()
      .describe(
        'End datetime in GDELT format YYYYMMDDHHMMSS — exactly 14 digits, no separators ' +
          '(e.g. 20200131235959). Must pair with startDatetime; supplying only one of the two is rejected.',
      ),
    maxRecords: z
      .number()
      .int()
      .min(1)
      .max(MAX_RECORDS_CEILING)
      .default(50)
      .describe(
        'Maximum number of clips to fetch (1–3000); the response carries as many of them as fit its ' +
          "48,000-byte budget. 3000 is GDELT's hard per-call ceiling, not a page size — there is no cursor " +
          'past it, so a query that fills 3000 must be split into narrower startDatetime/endDatetime windows instead.',
      ),
    sort: z
      .enum(['relevance', 'dateDesc', 'dateAsc'])
      .default('relevance')
      .describe(
        'Sort order: relevance (default), dateDesc (newest first), dateAsc (oldest first).',
      ),
  }),

  output: z.object({
    clips: z.array(clipSchema).describe('Matching TV clips sorted per the sort parameter.'),
  }),

  // Agent-facing context — query echo, clip count, and the cap-hit, out-of-window, and
  // byte-budget disclosures with their continuation windows. Reaches structuredContent
  // and content[] automatically; never in the domain return.
  enrichment: {
    effectiveQuery: z.string().describe('Echoed query string for use in follow-up calls.'),
    totalCount: z.number().describe('Number of clips returned.'),
    withheldCount: z
      .number()
      .optional()
      .describe(
        'In-window clips GDELT returned that this response withheld to stay within its 48,000-byte ' +
          'budget — fetched minus returned, not counting clips dropped for falling outside the window. ' +
          'Absent when every in-window clip fit.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance on an incomplete or empty result. When no clips matched, the resolved timespan window ' +
          'and how to target the 2009–October 2024 archive or verify station IDs. When GDELT returned clips ' +
          'aired outside the requested window (it answers whole clock hours), how many were dropped. When ' +
          'the response was cut to its ' +
          '48,000-byte budget, how many clips it withheld and the route to them. When the maxRecords cap was ' +
          'reached on an uncut response, that more clips may exist — a higher maxRecords below the 3000 ' +
          'ceiling, or a narrower date window at it. Absent when a non-empty result set fit under both the ' +
          'cap and the budget.',
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
        'Windows to re-run this query against, one at a time, when more clips are out of reach of this ' +
          'response. For a response cut to its budget under dateDesc or dateAsc: one window resuming from the ' +
          'last returned clip, reaching back to the second it aired, so clips from that second come back ' +
          'again — de-duplicate by archiveUrl — or, when resuming there cannot reach a new clip, one window ' +
          'skipping past that second. Otherwise — maxRecords at its 3000 ceiling, or a relevance cut — the ' +
          'queried window split in two, on a clock hour when one falls inside it; the halves share no second. ' +
          'Absent when no window is known, or none would reach further.',
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

    ctx.log.info('gdelt_get_tv_clips', { query: input.query, maxRecords: input.maxRecords });
    const svc = getGdeltTvService();

    // GDELT TV answers whole clock hours — the start floored to the hour, the end's hour
    // included in full — and rejects a window under 30 minutes. An explicit window goes out
    // widened to those whole hours, so any width is accepted and the same clips come back.
    const requested =
      input.startDatetime && input.endDatetime
        ? tvRequestWindow({ startDatetime: input.startDatetime, endDatetime: input.endDatetime })
        : undefined;
    const upstream = await svc.getTvClips(
      {
        query: input.query,
        ...(input.stations?.length && { stations: input.stations }),
        ...(input.timespan && { timespan: input.timespan }),
        ...requested,
        maxRecords: input.maxRecords,
        sort: input.sort,
      },
      ctx,
    );

    // That hour-granular answer carries clips from outside an explicit window at any edge not on
    // the hour, so they are dropped before the budget — the echoed window stays exact and
    // continuation windows stay disjoint. A timespan is resolved by GDELT on its own clock,
    // which this server cannot observe, so a timespan call drops nothing. The cap is still
    // judged on the upstream count: GDELT filled maxRecords whatever it filled it with.
    const window = resolveEffectiveWindow(input);
    const pinned = requested ? window : undefined;
    const fetched = pinned
      ? upstream.filter((c) => {
          const aired = parseRecordTimestamp(c.date);
          return aired === undefined || isWithinWindow(pinned, aired);
        })
      : upstream;
    const dropped = upstream.length - fetched.length;
    const charges = fetched.map((c) => recordCharge(c, renderClip(c)));
    const emittedCount = fitToBudget(charges);
    const clips = fetched.slice(0, emittedCount);
    const cut = emittedCount < fetched.length;
    const capHit = upstream.length >= input.maxRecords;
    const belowCeiling = input.maxRecords < MAX_RECORDS_CEILING;
    const cap: TvCap = !capHit ? 'none' : belowCeiling ? 'below-ceiling' : 'at-ceiling';
    // Every continuation request is widened to whole hours, and the clips it fetches from
    // outside its window fill a small maxRecords before the ones inside it. This is the one
    // maxRecords directive a cut page below the ceiling carries: the drop segment and the split
    // guidance describe the cap, and this sentence says what to do about it.
    const continueAtCeiling =
      'Continue with maxRecords 3000: each continuation request fetches whole clock hours, and at a ' +
      'lower maxRecords the clips it returns from outside its window can use up the slots first' +
      (capHit ? " — and only a larger maxRecords reaches clips past this page's cap." : '.');

    ctx.enrich.echo(input.query);
    ctx.enrich.total(clips.length);

    // Every notice segment for this response accumulates here and is flushed once —
    // ctx.enrich.notice is last-wins, so a second call would silently drop the first.
    const notices: string[] = [];
    if (upstream.length === 0) {
      notices.push(
        `No TV clips matched "${input.query}".${describeResolvedTimespan(input)} ${noClipGuidance(input)}`,
      );
    } else if (capHit && !cut) {
      if (input.maxRecords < MAX_RECORDS_CEILING) {
        notices.push(
          `GDELT returned ${upstream.length} clips (maxRecords cap reached — there may be more). ` +
            `Raise maxRecords (up to ${MAX_RECORDS_CEILING}) to fetch more; a response carries only as many ` +
            'as fit its 48,000-byte budget and hands back a continuation for the rest.',
        );
      } else {
        const continuation = planTvWindowContinuation(window, { cut: false, cap: 'at-ceiling' });
        if (continuation.windows) ctx.enrich({ continuationWindows: continuation.windows });
        notices.push(
          `GDELT returned ${upstream.length} clips — maxRecords is already at its ${MAX_RECORDS_CEILING} ceiling, ` +
            `so more clips almost certainly matched. ${continuation.guidance}`,
        );
      }
    }
    if (pinned && dropped > 0) {
      const droppedClips =
        `GDELT answers TV windows in whole clock hours, so it also returned ${dropped} ` +
        `${dropped === 1 ? 'clip' : 'clips'} aired outside ${pinned.startDatetime}–${pinned.endDatetime}; ` +
        `${dropped === 1 ? 'it was' : 'they were'} dropped.`;
      notices.push(
        capHit
          ? `${droppedClips} ${dropped === 1 ? 'It' : 'They'} took ${dropped} of the ${input.maxRecords} ` +
              'maxRecords slots, so in-window clips past them were not fetched.'
          : `${droppedClips} That is expected at any window edge not on the hour — including the edges ` +
              'continuationWindows hands back — and not a sign of missing results.',
      );
      if (fetched.length === 0) {
        notices.push(
          `No clip aired inside the window.${describeResolvedTimespan(input)} ${noClipGuidance(input)}`,
        );
      }
    }
    if (cut) {
      const plan = planCutNotice({
        noun: { singular: 'clip', plural: 'clips' },
        dedupeKey: 'archiveUrl',
        sort: input.sort,
        window,
        emittedStamps: clips.map((c) => c.date),
        emittedCharges: charges.slice(0, emittedCount),
        nextCharge: charges[emittedCount] as number,
        withheldStamps: fetched.slice(emittedCount).map((c) => c.date),
        fetchedCount: fetched.length,
        maxRecords: input.maxRecords,
        ceiling: MAX_RECORDS_CEILING,
        capHit,
        halve: (w) => planTvWindowContinuation(w, { cut: true, cap }),
        ...(belowCeiling && { continueNote: continueAtCeiling }),
      });
      ctx.enrich({
        withheldCount: fetched.length - emittedCount,
        ...(plan.windows && { continuationWindows: plan.windows }),
      });
      notices.push(plan.notice);
    }
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    ctx.log.info('gdelt_get_tv_clips completed', {
      upstream: upstream.length,
      dropped,
      count: clips.length,
    });
    return { clips };
  },

  format: (result) => {
    const lines: string[] = [`## GDELT TV Clips`];
    if (result.clips.length === 0) lines.push('No clips returned.');
    for (const c of result.clips) lines.push(renderClip(c));
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
