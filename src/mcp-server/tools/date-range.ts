/**
 * @fileoverview Shared date-range handling for the GDELT tools that accept an explicit
 * startDatetime/endDatetime window — the YYYYMMDDHHMMSS field pattern, the both-or-neither
 * pairing predicate, the DOC API's shortest explicit window, record timestamps against a window,
 * and the window partitioning and continuation windows the record-list tools hand back when an
 * upstream cap is reached.
 * @module mcp-server/tools/date-range
 */

import type { z } from '@cyanheads/mcp-ts-core';
import {
  formatDateShort,
  parseGdeltTimespan,
  resolveTimespan,
} from '@/services/gdelt/gdelt-fetch.js';
import { DOC_MIN_WINDOW_MINUTES, DOC_MIN_WINDOW_SECONDS } from '@/services/gdelt/types.js';
import { quoteText } from './markdown-escape.js';

/**
 * GDELT's datetime wire format: exactly 14 digits, YYYYMMDDHHMMSS, no separators.
 *
 * Applied as a field-level Zod `.regex()` so it serializes into the advertised JSON
 * Schema as `pattern`, letting a caller see the constraint before it calls.
 */
export const GDELT_DATETIME_PATTERN = /^\d{14}$/;

/** GDELT DOC's documented minimum relative window. */
const GDELT_DOC_MIN_TIMESPAN_MINUTES = 15;

/** Minutes represented by each reliably parseable GDELT timespan unit. */
const TIMESPAN_UNIT_MINUTES = {
  min: 1,
  h: 60,
  d: 24 * 60,
  w: 7 * 24 * 60,
  m: 30 * 24 * 60,
  y: 365 * 24 * 60,
} as const;

/**
 * The shape of a relative timespan on the DOC and TV APIs, applied to the trimmed value: a number,
 * then its unit. The unit is captured, not checked, so number-plus-unit syntax this server does not
 * resolve (`15mins`, `1.5d`) stays GDELT's to read.
 */
const TIMESPAN_SHAPE = /^[+-]?\d+(?:\.\d+)?\s*([a-z]*)$/i;

const TIMESPAN_SHAPE_FAULT =
  'Use a numeric timespan followed by its unit, such as "24hours", "7d" or "1m", or supply startDatetime and endDatetime together.';

/**
 * The fault in a relative timespan's shape, or `undefined` when it has none: text with no leading
 * number is no window either API reads, and a bare number is refused unless `bareNumber` admits it.
 * A blank value is unset.
 */
function describeTimespanShapeFault(
  timespan: string | undefined,
  bareNumber: 'admit' | 'refuse',
): string | undefined {
  const value = timespan?.trim();
  if (!value) return;
  const unit = TIMESPAN_SHAPE.exec(value)?.[1];
  if (unit === undefined || (unit === '' && bareNumber === 'refuse')) return TIMESPAN_SHAPE_FAULT;
  return;
}

/**
 * Validate only an active DOC relative window. Explicit boundaries are handled by the
 * date-range guard, so an unused timespan cannot reject a valid pair or hide a date fault.
 * Text that is not a number followed by a unit is refused by the shape TV applies; a bare number
 * goes upstream, as GDELT DOC's answer to one is unmeasured. Unknown number-plus-unit syntax
 * remains available to GDELT and its response classifier.
 */
export function refineDocTimespan(
  input: {
    timespan?: string | undefined;
    startDatetime?: string | undefined;
    endDatetime?: string | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  if (input.startDatetime || input.endDatetime || !input.timespan) return;
  const shapeFault = describeTimespanShapeFault(input.timespan, 'admit');
  if (shapeFault) {
    ctx.addIssue({ code: 'custom', path: ['timespan'], message: shapeFault });
    return;
  }
  const parsed = parseGdeltTimespan(input.timespan);
  if (!parsed) return;
  if (parsed.amount * TIMESPAN_UNIT_MINUTES[parsed.unit] < GDELT_DOC_MIN_TIMESPAN_MINUTES) {
    ctx.addIssue({
      code: 'custom',
      path: ['timespan'],
      message: 'DOC timespan must be at least 15 minutes; use "15min" or a longer window.',
    });
  }
}

/** Reject obvious TV timespan garbage only when relative time will actually be used. */
export function describeTvTimespanFault(args: {
  timespan?: string | undefined;
  startDatetime?: string | undefined;
  endDatetime?: string | undefined;
}): string | undefined {
  if (args.startDatetime && args.endDatetime) return;
  return describeTimespanShapeFault(args.timespan, 'refuse');
}

/** How far back DOC's article search reaches, in UTC calendar months — its default and its longest. */
const DOC_ARTICLE_REACH_MONTHS = 3;

/** {@link DOC_ARTICLE_REACH_MONTHS} as a timespan. */
const DOC_ARTICLE_REACH = `${DOC_ARTICLE_REACH_MONTHS}months`;

/**
 * The timespan DOC's article search runs on: `timespan` itself, or `3months` when it resolves to
 * a longer window. GDELT documents three months as the DOC window, and artlist answered `1y`
 * sorted oldest first with nothing older than three months. The analytics modes are not clamped:
 * they answer explicit windows years old, and a longer `timespan` there is unmeasured. A timespan
 * this server cannot resolve runs as sent.
 *
 * The reach is counted back from the resolved window's own end, so both read one clock.
 */
export function articleSearchTimespan(timespan: string): string {
  const range = resolveTimespan(timespan);
  if (!range) return timespan;
  const reachStart = new Date(range.end);
  reachStart.setUTCMonth(reachStart.getUTCMonth() - DOC_ARTICLE_REACH_MONTHS);
  return range.start < reachStart ? DOC_ARTICLE_REACH : timespan;
}

/** A GDELT query window, both boundaries in the 14-digit YYYYMMDDHHMMSS wire format. */
export type GdeltWindow = {
  startDatetime: string;
  endDatetime: string;
};

/** GDELT's datetime resolution — the narrowest window a caller can express. */
const GDELT_RESOLUTION_MS = 1000;

/** Parse a 14-digit YYYYMMDDHHMMSS string as UTC. Invalid calendar values yield an Invalid Date. */
export function parseGdeltDatetime(value: string): Date {
  return new Date(
    `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}` +
      `T${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12, 14)}Z`,
  );
}

/** Format a Date as GDELT's 14-digit YYYYMMDDHHMMSS wire format (UTC). */
export function toGdeltDatetime(date: Date): string {
  return date.toISOString().slice(0, 19).replace(/[-:T]/g, '');
}

/**
 * The window a call actually ran against, in GDELT's wire format.
 *
 * Mirrors `applyTimeRange()`'s precedence: an explicit boundary pair wins, a timespan
 * is resolved against now, and a call that pinned neither gets `undefined` rather than
 * a guessed window — GDELT's own default is not something this server can observe.
 */
export function resolveEffectiveWindow(args: {
  timespan?: string | undefined;
  startDatetime?: string | undefined;
  endDatetime?: string | undefined;
}): GdeltWindow | undefined {
  if (args.startDatetime && args.endDatetime) {
    return { startDatetime: args.startDatetime, endDatetime: args.endDatetime };
  }
  if (args.timespan) {
    const range = resolveTimespan(args.timespan);
    if (range) {
      return {
        startDatetime: toGdeltDatetime(range.start),
        endDatetime: toGdeltDatetime(range.end),
      };
    }
  }
  return;
}

/**
 * The ` Timespan "…" resolved to <start> – <end>.` sentence an empty-result notice carries when
 * a call ran on a relative timespan, so the caller sees which dates it actually covered; `''`
 * when an explicit window was pinned or the timespan does not parse. The timespan is quoted as
 * the caller sent it, whitespace around the unit included, with `quoteText`: the notice's
 * `content[]` render escapes it.
 */
export function describeResolvedTimespan(args: {
  timespan?: string | undefined;
  startDatetime?: string | undefined;
  endDatetime?: string | undefined;
}): string {
  if (!args.timespan || args.startDatetime || args.endDatetime) return '';
  const range = resolveTimespan(args.timespan);
  return range
    ? ` Timespan ${quoteText(args.timespan)} resolved to ${formatDateShort(range.start)} – ${formatDateShort(range.end)}.`
    : '';
}

/**
 * Smallest span whose halves the GDELT DOC API still accepts. The first half is
 * `floor(span/2)` seconds, so both reach {@link DOC_MIN_WINDOW_SECONDS} from twice that; the
 * second, reaching back a second to cover the seam, is a second longer. Both are strictly
 * narrower than the span, so repeated halving converges.
 */
const MIN_SPLITTABLE_MS = 2 * DOC_MIN_WINDOW_SECONDS * GDELT_RESOLUTION_MS;

/**
 * Split a window into two halves whose union covers it exactly, or `undefined` when a half
 * would fall under the shortest window the GDELT DOC API accepts.
 *
 * The second half deliberately **overlaps** the first by one second rather than resuming
 * at the shared midpoint. GDELT documents both boundaries as exclusive — STARTDATETIME
 * considers "only articles published *after* this date/time stamp" and ENDDATETIME "only
 * articles published *before*" it (DOC 2.0 and TV 2.0 API docs alike) — so halves that
 * merely touch at the midpoint would drop every record timestamped exactly there, silently.
 *
 * Reaching back one second closes that seam: under the documented exclusive reading the
 * two halves tile the original window with no gap and no repeat, and if the boundaries
 * turn out to behave inclusively instead, the overlap costs at most two seconds of
 * duplicates — which a caller can see and de-duplicate. Gap-free either way.
 */
export function splitWindow(window: GdeltWindow): [GdeltWindow, GdeltWindow] | undefined {
  const start = parseGdeltDatetime(window.startDatetime);
  const spanMs = parseGdeltDatetime(window.endDatetime).getTime() - start.getTime();
  if (!Number.isFinite(spanMs) || spanMs < MIN_SPLITTABLE_MS) return;

  const midpointMs =
    start.getTime() + Math.floor(spanMs / 2 / GDELT_RESOLUTION_MS) * GDELT_RESOLUTION_MS;
  return [
    { startDatetime: window.startDatetime, endDatetime: toGdeltDatetime(new Date(midpointMs)) },
    {
      startDatetime: toGdeltDatetime(new Date(midpointMs - GDELT_RESOLUTION_MS)),
      endDatetime: window.endDatetime,
    },
  ];
}

/** The next-call windows and the prose explaining them, for a record cap at its ceiling. */
export type WindowContinuation = {
  windows?: [GdeltWindow, GdeltWindow];
  guidance: string;
};

/**
 * How a DOC caller retrieves records left behind once `maxRecords` is already at its ceiling.
 *
 * GDELT exposes no offset or cursor, so narrowing the time window is the only lever, and
 * each outcome is stated rather than implied: halves to re-query when the window divides,
 * how to pin a window when the call never set one, and — when a half would fall under the
 * shortest window the DOC API accepts — that the remaining records are unreachable.
 *
 * Callers own the record-noun prose; this covers only the window reasoning.
 */
export function planWindowContinuation(window: GdeltWindow | undefined): WindowContinuation {
  if (!window) {
    return {
      guidance:
        'GDELT exposes no offset or cursor, so narrowing the time window is the only way to reach the rest: ' +
        'pin one with startDatetime/endDatetime (or a timespan), then re-run this query against successively narrower halves of it.',
    };
  }

  const windows = splitWindow(window);
  if (!windows) {
    return {
      guidance: `The window ${window.startDatetime}–${window.endDatetime} is under ${2 * DOC_MIN_WINDOW_MINUTES} minutes, so either half would fall under the ${DOC_MIN_WINDOW_MINUTES} minutes the GDELT DOC API accepts: it does not search a narrower window, and the remaining records are not retrievable through this API.`,
    };
  }

  const [first, second] = windows;
  return {
    windows,
    guidance:
      'GDELT exposes no offset or cursor. Re-run this query unchanged against each half of the current window — ' +
      `${first.startDatetime}–${first.endDatetime}, then ${second.startDatetime}–${second.endDatetime} ` +
      '(both echoed in continuationWindows) — and split a half again if it also hits the cap. ' +
      'The halves overlap by one second so nothing falls through the seam, so a record on that second can ' +
      'appear in both: de-duplicate on re-assembly.',
  };
}

/**
 * One clock hour. Measured live against GDELT TV: a `startdatetime`/`enddatetime` window of up
 * to 7 days is answered on clip air time from `floor_hour(start)` through the end of
 * `enddatetime`'s hour — a longer one in whole UTC days, and from 3 years in whole UTC months
 * (`tv-covered-window.ts`) — and a window spanning under 30 minutes is rejected ("Timespan is too
 * short." — 20 minutes rejected, 30 accepted).
 */
const HOUR_MS = 3_600_000;

/**
 * The shortest window sent to GDELT TV with its start as given. Measured live, GDELT answers an
 * off-the-hour start from its clock hour itself, in full: at 30 minutes (FOX News,
 * `20191218201500–20191218204500`), 2 hours (`20191218203000–20191218223000` counted hours 20
 * through 22), and 7 days (`20191215003000–20191222003000` counted the same as
 * `20191215000000–20191222000000`). A shorter window keeps the floor and stretch below, which
 * changes nothing inside GDELT's hourly answer and is how a window under 30 minutes still meets
 * GDELT's minimum; the period thresholds this cut keeps a sent span from crossing (7 days,
 * 3 × 365 days) lie far above it.
 */
const TV_KEPT_START_MIN_MS = 2 * HOUR_MS;

/**
 * The window to send GDELT TV for a caller's window. GDELT picks its answer's period from the span
 * it is sent, so a window of at least {@link TV_KEPT_START_MIN_MS} goes out as given: GDELT floors
 * its start to the hour itself, and flooring it here would lengthen the span — carrying a 7-day
 * window into a daily answer, or one just under 3 × 365 days into a monthly one. A shorter window
 * goes out with its start floored to the clock hour, and its end stretched to the end of that
 * hour when it ends inside it: within GDELT's hourly answer this adds no hour the caller's window
 * does not reach, and the widened span is one GDELT accepts, so a window of any width works. A
 * window over 7 days is answered in whole UTC days whatever its hours, so its edge clips can
 * reach back to its first day's midnight and on to its last day's end, spending maxRecords. The
 * caller's exact window is what the out-of-window drop then keeps.
 *
 * An end exactly on the clock hour is sent one second earlier: sent as is, it would have GDELT
 * answer that whole next hour for the window's one final second, spending maxRecords on clips
 * the drop then discards. That final second is left out — as GDELT documents ENDDATETIME, the
 * end is exclusive there.
 */
export function tvRequestWindow(window: GdeltWindow): GdeltWindow {
  const start = parseGdeltDatetime(window.startDatetime).getTime();
  const end = lastTvSecond(window);
  if (end - start >= TV_KEPT_START_MIN_MS) {
    return { startDatetime: window.startDatetime, endDatetime: toGdeltDatetime(new Date(end)) };
  }
  const hour = Math.floor(start / HOUR_MS) * HOUR_MS;
  return {
    startDatetime: toGdeltDatetime(new Date(hour)),
    endDatetime: toGdeltDatetime(new Date(Math.max(end, hour + HOUR_MS - GDELT_RESOLUTION_MS))),
  };
}

/** The last second of a window GDELT TV is asked for: its end, or a second before an on-the-hour end. */
function lastTvSecond(window: GdeltWindow): number {
  const end = parseGdeltDatetime(window.endDatetime).getTime();
  return end % HOUR_MS === 0 ? end - GDELT_RESOLUTION_MS : end;
}

/**
 * GDELT TV's shortest window. Measured live: 30 minutes is answered, while 29 minutes 59 seconds
 * (`20240927233000–20240927235959`) and 20 minutes are refused ("Timespan is too short.").
 */
const TV_MIN_SPAN_MS = 30 * 60 * 1000;

/**
 * The window to send GDELT TV's timelines, rankings, and word clouds for a caller's window: as
 * given, an end exactly on the clock hour a second earlier — the end rule {@link tvRequestWindow}
 * applies for clips. Every period GDELT TV counts (clock hour, UTC day, Sunday–Saturday week,
 * month, year) begins on the clock hour, and GDELT counts the whole period an end falls in, so an
 * end on a period's first second, sent as is, adds that whole period for one second that GDELT
 * documents as outside the window (ENDDATETIME is exclusive). An on-the-hour end inside a longer
 * period stays in that period, and its values do not change.
 *
 * GDELT picks the period from the span it is sent, and the second taken off moves a span to the
 * finer period at exactly two lengths: 3 × 365 days (months to days) and 7 days and a second (days
 * to hours). A window the trim would leave under {@link TV_MIN_SPAN_MS} goes as given: GDELT
 * refuses the shorter one, so a 30-minute window ending on the hour keeps counting the hour after
 * its end, which the covered-window notice names.
 */
export function tvAnalyticsWindow(window: GdeltWindow): GdeltWindow {
  const end = lastTvSecond(window);
  return end - parseGdeltDatetime(window.startDatetime).getTime() < TV_MIN_SPAN_MS
    ? window
    : { startDatetime: window.startDatetime, endDatetime: toGdeltDatetime(new Date(end)) };
}

/**
 * The TV counterpart of {@link planWindowContinuation}. GDELT TV answers whole UTC periods —
 * clock hours for a window up to 7 days, days beyond — and the handler trims its answer to the
 * requested window, so halves need no overlapping second: they share no second and cover the
 * window exactly.
 *
 * The split falls on the clock hour nearest the middle whenever one lies inside the window,
 * which gives two hourly-answered halves disjoint hour sets — the split that helps when the cap
 * left records behind, since any window inside one hour fetches that same capped hour. A half
 * over 7 days is answered in whole UTC days, so both halves fetch the day the split falls in and
 * its edge clips spend maxRecords; halving again reaches halves of 7 days or less, answered
 * hourly, which the split separates. A page capped at the ceiling with no hour inside has nothing
 * a narrower window can add.
 */
export function planTvWindowContinuation(window: GdeltWindow | undefined): WindowContinuation {
  if (!window) return planWindowContinuation(undefined);

  const start = parseGdeltDatetime(window.startDatetime).getTime();
  const end = parseGdeltDatetime(window.endDatetime).getTime();
  const middle = start + (end - start) / 2;
  const hourInside = [Math.floor(middle / HOUR_MS), Math.ceil(middle / HOUR_MS)]
    .map((hour) => hour * HOUR_MS)
    .filter((boundary) => boundary > start + GDELT_RESOLUTION_MS && boundary < end)
    .sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle))[0];

  if (hourInside === undefined) {
    return {
      guidance: `No clock hour falls inside the window ${window.startDatetime}–${window.endDatetime}, and the TV API answers in whole clock hours, so every narrower window inside it fetches the same capped set — the remaining clips are not retrievable through this API.`,
    };
  }

  const windows: [GdeltWindow, GdeltWindow] = [
    {
      startDatetime: window.startDatetime,
      endDatetime: toGdeltDatetime(new Date(hourInside - GDELT_RESOLUTION_MS)),
    },
    { startDatetime: toGdeltDatetime(new Date(hourInside)), endDatetime: window.endDatetime },
  ];
  const [first, second] = windows;
  return {
    windows,
    guidance: `GDELT exposes no offset or cursor. Re-run this query unchanged against each half of the current window — ${first.startDatetime}–${first.endDatetime}, then ${second.startDatetime}–${second.endDatetime} (both echoed in continuationWindows) — and split a half again if it also hits the cap. The TV API answers in whole UTC periods and each response keeps only its own window, so the halves share no second and no clip.`,
  };
}

/** The `continuationWindows` line of the `content[]` trailer. */
export function renderContinuationWindows(windows: readonly GdeltWindow[] = []): string {
  return [
    '**Continuation windows:**',
    ...windows.map((w) => `- startDatetime: ${w.startDatetime}, endDatetime: ${w.endDatetime}`),
  ].join('\n');
}

/**
 * Epoch milliseconds of a record timestamp — DOC's `seendate` (`20240115T120000Z`) or TV's ISO
 * 8601 clip date (`2024-01-15T12:00:00Z`) — or `undefined` when it is neither.
 */
export function parseRecordTimestamp(value: string): number | undefined {
  const match = /^(\d{4})-?(\d{2})-?(\d{2})T(\d{2}):?(\d{2}):?(\d{2})Z$/.exec(value);
  if (!match) return;
  const [, year, month, day, hour, minute, second] = match;
  const ms = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * True when `ms` falls inside `window`, boundaries included. Inclusive on purpose: GDELT
 * documents exclusive boundaries, but a record on a boundary second is one the caller's
 * window names, and dropping it would open a gap if the boundaries behave inclusively.
 */
export function isWithinWindow(window: GdeltWindow, ms: number): boolean {
  return (
    ms >= parseGdeltDatetime(window.startDatetime).getTime() &&
    ms <= parseGdeltDatetime(window.endDatetime).getTime()
  );
}

/**
 * True when exactly one of the two boundaries is present.
 *
 * GDELT honors an explicit date range only when both boundaries are set, so a lone
 * boundary is dropped during URL construction and the query silently runs against a
 * different window than the caller asked for.
 *
 * The rule is cross-field, so each tool handler enforces it rather than a Zod
 * object-level refinement: a schema-level rejection is raised before the handler runs,
 * which returns a raw Zod issue dump with no `structuredContent` — dropping the
 * `reason` + `recovery.hint` contract every other error path on these tools carries.
 */
export function isUnpairedDateRange(startDatetime?: string, endDatetime?: string): boolean {
  return Boolean(startDatetime) !== Boolean(endDatetime);
}

/**
 * True when a 14-digit GDELT datetime names a real UTC instant.
 *
 * Construct via `Date.UTC` and compare every component back, rather than testing for an
 * Invalid Date: February 29th of a non-leap year, April 31st, and hour 24 all roll forward
 * into a perfectly valid instant instead of failing, which is the same silent window shift
 * this check exists to stop. The read-back also rejects a two-digit year, which `Date.UTC`
 * would otherwise map into the 1900s.
 */
function isRealGdeltDatetime(value: string): boolean {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const hour = Number(value.slice(8, 10));
  const minute = Number(value.slice(10, 12));
  const second = Number(value.slice(12, 14));
  const parsed = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day &&
    parsed.getUTCHours() === hour &&
    parsed.getUTCMinutes() === minute &&
    parsed.getUTCSeconds() === second
  );
}

/**
 * Why an explicit window cannot be used, or `undefined` when it can.
 *
 * One reason covers every way a date argument fails, so each handler stays a single guard and
 * a caller has one `invalid_date_range` branch rather than three. The field regex upstream has
 * already established 14 digits; what it cannot see is whether those digits name a real
 * instant, or which boundary comes first — `applyTimeRange` sets both parameters verbatim, so
 * an impossible or reversed window reaches GDELT, which normalizes it and answers successfully
 * for dates nobody asked about.
 *
 * Both boundaries are fixed-width zero-padded digits by the time ordering is compared, so
 * lexical order is calendar order.
 */
export function describeDateRangeFault(
  startDatetime?: string,
  endDatetime?: string,
): string | undefined {
  if (isUnpairedDateRange(startDatetime, endDatetime)) {
    return 'startDatetime and endDatetime must be supplied together';
  }
  if (!startDatetime || !endDatetime) return;
  if (!isRealGdeltDatetime(startDatetime)) {
    return `startDatetime ${startDatetime} is not a real UTC calendar timestamp`;
  }
  if (!isRealGdeltDatetime(endDatetime)) {
    return `endDatetime ${endDatetime} is not a real UTC calendar timestamp`;
  }
  if (startDatetime >= endDatetime) {
    return `startDatetime ${startDatetime} must be earlier than endDatetime ${endDatetime}`;
  }
  return;
}

/**
 * Why the GDELT DOC API would refuse an explicit window as too short, or `undefined` when it would
 * not: a pair spanning under {@link DOC_MIN_WINDOW_SECONDS}, compared to the second. Only a pair
 * {@link describeDateRangeFault} passes is judged — a fault there is that check's to report — and
 * a relative timespan keeps its own 15-minute rule. DOC-only: the TV tools widen a short window
 * themselves.
 */
export function describeShortDocWindow(
  startDatetime?: string,
  endDatetime?: string,
): string | undefined {
  if (!startDatetime || !endDatetime || describeDateRangeFault(startDatetime, endDatetime)) return;
  const spanSeconds =
    (parseGdeltDatetime(endDatetime).getTime() - parseGdeltDatetime(startDatetime).getTime()) /
    GDELT_RESOLUTION_MS;
  if (spanSeconds >= DOC_MIN_WINDOW_SECONDS) return;
  return `The window ${startDatetime}–${endDatetime} spans ${describeSpan(spanSeconds)}, under the ${DOC_MIN_WINDOW_MINUTES} minutes the GDELT DOC API accepts for a startDatetime/endDatetime window.`;
}

/** The sentence each DOC tool's startDatetime and endDatetime descriptions end with. */
export const DOC_WINDOW_MINIMUM_NOTE = `The window must span at least ${DOC_MIN_WINDOW_MINUTES} minutes, the shortest the GDELT DOC API accepts; a shorter one is answered from the server's local GKG mirror where one runs, and refused otherwise.`;

/** The recovery for a window {@link describeShortDocWindow} faults. */
export const DOC_SHORT_WINDOW_HINT = `Set endDatetime at least ${DOC_MIN_WINDOW_MINUTES} minutes after startDatetime, or omit both and use a timespan of ${GDELT_DOC_MIN_TIMESPAN_MINUTES} minutes or more for a window ending now.`;

/** A positive whole number of seconds in minutes and seconds, e.g. `29 minutes 59 seconds`. */
function describeSpan(seconds: number): string {
  const count = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes === 0) return count(rest, 'second');
  return rest === 0
    ? count(minutes, 'minute')
    : `${count(minutes, 'minute')} ${count(rest, 'second')}`;
}
