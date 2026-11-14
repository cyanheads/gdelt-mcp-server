/**
 * @fileoverview The window rules of GDELT's Context 2.0 API, as measured live: its `timespan`
 * grammar, its 72-hour reach, the minute it reads window bounds to, the widening that keeps a
 * short explicit window above the span the API refuses, and the date-edge continuation a sentence
 * search hands back. GDELT answers each violation with a plain-text refusal and never clamps or
 * widens on its own, so every rule is applied here, before any request.
 * @module mcp-server/tools/context-window
 */

import type { ContextSort } from '@/services/gdelt/gdelt-context-service.js';
import {
  describeDateRangeFault,
  type GdeltWindow,
  parseGdeltDatetime,
  toGdeltDatetime,
} from './date-range.js';
import { quoteText } from './markdown-escape.js';
import type { WindowClamp } from './window-clamp.js';

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;

/**
 * How far back the Context API searches. A longer `timespan` is refused as `The TIMESPAN is too
 * large.` and an older start as `Invalid query start date.`.
 */
const REACH_MS = 72 * 60 * MINUTE_MS;

/**
 * How far inside the reach a clamped start, a widened start, and the start of a full-reach
 * timespan window sit, so the difference between this host's clock and GDELT's cannot push them
 * back out.
 */
const REACH_MARGIN_MS = 5 * MINUTE_MS;

/** Shortest `timespan` the Context API accepts: `30min` is refused as too short, `31min` answered. */
const MIN_TIMESPAN_MINUTES = 31;

/** Longest `timespan` — the reach. */
const MAX_TIMESPAN_MINUTES = 72 * 60;

/** The timespan a call runs on when it names none, or names one longer than the reach. */
const CONTEXT_DEFAULT_TIMESPAN = '72h';

/**
 * GDELT reads `startdatetime` and `enddatetime` only to the minute, both inclusive of that
 * minute's first second, measured live: a start of 10:01:34 returned the matches seen from
 * 10:01:20 on, exactly as a start of 10:00:00 did; an end of 10:01:30 returned none of those seen
 * from 10:01:20 to 10:01:30; a start of 15:47:00 returned the matches seen at 15:47:00 and none
 * from 15:46:59, and an end of 15:47:00 those at 15:47:00 and none from 15:47:01. So a window
 * covers the matches seen from its start's minute through the first second of its end's minute.
 */

/** `ms` moved back to the first second of its minute. */
function floorToMinute(ms: number): number {
  return Math.floor(ms / MINUTE_MS) * MINUTE_MS;
}

/** `ms` moved forward to the first second of the next minute, unless it is already on one. */
function ceilToMinute(ms: number): number {
  return Math.ceil(ms / MINUTE_MS) * MINUTE_MS;
}

/**
 * The 14-digit `datetime` rounded up to a whole minute, unchanged when it is on one: the end a
 * request needs for GDELT to read every second up to `datetime`.
 */
export function roundUpToMinute(datetime: string): string {
  return toGdeltDatetime(new Date(ceilToMinute(parseGdeltDatetime(datetime).getTime())));
}

/**
 * Span an explicit window is widened to before it goes upstream. A 20-minute window is refused as
 * `Timespan is too short.` and a 60-minute one answered; the exact floor between them was not
 * pinned. GDELT measures a window only up to now: one ending 40 minutes in the future and
 * starting 20 minutes ago is refused the same way.
 */
const MIN_REQUEST_SPAN_MS = 60 * MINUTE_MS;

/**
 * The relative grammar GDELT reads with a known window, applied to the trimmed value: digits
 * (zero-padding allowed) and `min`, `h`, `hours`, `d`, or `days`, in any case. GDELT also answers
 * `1months` and `1.5d`, over windows it does not disclose, and refuses `1w` and `30m`.
 */
const TIMESPAN_GRAMMAR = /^(\d+)(min|h|hours|d|days)$/i;

const UNIT_MINUTES: Readonly<Record<string, number>> = {
  min: 1,
  h: 60,
  hours: 60,
  d: 24 * 60,
  days: 24 * 60,
};

const TIMESPAN_HINT =
  'Use a whole number followed by min, h, hours, d, or days, from 31min to 72h, such as "6h" or "3days", or supply startDatetime and endDatetime together.';

/** The window a Context call runs on, or why it cannot run. */
export type ContextWindowPlan =
  | {
      kind: 'timespan';
      /** The timespan sent upstream: the caller's, trimmed, or the 72-hour default. */
      timespan: string;
      /** What it covers by this host's clock, its start no earlier than 5 minutes inside the reach. */
      window: GdeltWindow;
      /**
       * What GDELT reads for it, by this host's clock: the whole timespan up to now. A 72-hour one
       * starts 5 minutes before `window`, so its oldest matches can precede the window.
       */
      request: GdeltWindow;
      clamp?: WindowClamp;
    }
  | {
      kind: 'explicit';
      /** The caller's window, its start moved 5 minutes inside the reach when it lay outside it. */
      window: GdeltWindow;
      /**
       * The window sent upstream: `window`, or `window` widened to {@link MIN_REQUEST_SPAN_MS},
       * its end rounded up to a whole minute.
       */
      request: GdeltWindow;
      clamp?: WindowClamp;
    }
  | { kind: 'invalid_date_range'; message: string; hint?: string }
  | { kind: 'invalid_timespan'; message: string; hint: string };

/**
 * Plan the window a Context call runs on at `nowMs`. An explicit pair wins over `timespan`, which
 * it leaves unread; a blank `timespan` is unset.
 */
export function planContextWindow(
  input: {
    timespan?: string | undefined;
    startDatetime?: string | undefined;
    endDatetime?: string | undefined;
  },
  sort: ContextSort,
  nowMs: number,
): ContextWindowPlan {
  const now = Math.floor(nowMs / SECOND_MS) * SECOND_MS;
  const dateFault = describeDateRangeFault(input.startDatetime, input.endDatetime);
  if (dateFault) return { kind: 'invalid_date_range', message: dateFault };
  if (input.startDatetime && input.endDatetime) {
    return planExplicitWindow(input.startDatetime, input.endDatetime, sort, now);
  }
  return planTimespan(input.timespan, now);
}

function planTimespan(timespan: string | undefined, now: number): ContextWindowPlan {
  if (!timespan?.trim()) return timespanPlan(CONTEXT_DEFAULT_TIMESPAN, MAX_TIMESPAN_MINUTES, now);
  const value = timespan.trim();
  const match = TIMESPAN_GRAMMAR.exec(value);
  if (!match) {
    return {
      kind: 'invalid_timespan',
      message: `Context timespan ${quoteText(timespan)} is not a whole number followed by min, h, hours, d, or days.`,
      hint: TIMESPAN_HINT,
    };
  }
  const minutes = Number(match[1]) * (UNIT_MINUTES[(match[2] as string).toLowerCase()] as number);
  if (minutes < MIN_TIMESPAN_MINUTES) {
    return {
      kind: 'invalid_timespan',
      message: `Context timespan ${quoteText(timespan)} is shorter than the 31 minutes the Context API accepts.`,
      hint: 'Use a timespan of at least 31min, or supply startDatetime and endDatetime together: a shorter explicit window is widened upstream and trimmed back to its bounds.',
    };
  }
  if (minutes > MAX_TIMESPAN_MINUTES) {
    return {
      ...timespanPlan(CONTEXT_DEFAULT_TIMESPAN, MAX_TIMESPAN_MINUTES, now),
      clamp: { parameter: 'timespan', requested: timespan, applied: CONTEXT_DEFAULT_TIMESPAN },
    };
  }
  return timespanPlan(value, minutes, now);
}

function timespanPlan(
  timespan: string,
  minutes: number,
  now: number,
): Extract<ContextWindowPlan, { kind: 'timespan' }> {
  const start = Math.max(now - minutes * MINUTE_MS, reachStart(now));
  return {
    kind: 'timespan',
    timespan,
    window: windowOf(start, now),
    request: windowOf(now - minutes * MINUTE_MS, now),
  };
}

function planExplicitWindow(
  startDatetime: string,
  endDatetime: string,
  sort: ContextSort,
  now: number,
): ContextWindowPlan {
  const start = parseGdeltDatetime(startDatetime).getTime();
  const end = parseGdeltDatetime(endDatetime).getTime();
  if (start >= now) {
    return {
      kind: 'invalid_date_range',
      message: `startDatetime ${startDatetime} is not in the past; the Context API searches the 72 hours up to now`,
    };
  }
  const floor = reachStart(now);
  let applied = start;
  let clamp: WindowClamp | undefined;
  if (start < now - REACH_MS) {
    if (end <= floor) {
      return {
        kind: 'invalid_date_range',
        message: `The window ${startDatetime}–${endDatetime} ends before ${toGdeltDatetime(new Date(floor))}, so it holds nothing the Context API searches; it reaches back only 72 hours`,
        hint: `Use a window ending after ${toGdeltDatetime(new Date(floor))}, or gdelt_search_articles for older coverage.`,
      };
    }
    applied = floor;
    clamp = {
      parameter: 'startDatetime',
      requested: startDatetime,
      applied: toGdeltDatetime(new Date(floor)),
    };
  }
  const window = { startDatetime: toGdeltDatetime(new Date(applied)), endDatetime };
  return {
    kind: 'explicit',
    window,
    request: contextRequestWindow(window, sort, now),
    ...(clamp && { clamp }),
  };
}

/**
 * The window to send upstream for `window` at `now`: `window` itself when it spans 60 minutes up
 * to now, otherwise widened to 60 minutes at the edge `sort` reads last — the start under
 * `dateDesc`, the end under `dateAsc` — and at the other edge for whatever that one cannot take.
 * A widened end never passes now and a widened start never passes 5 minutes inside the reach,
 * whose 72 hours leave room for the full span between them. The end then goes up to a whole
 * minute, so GDELT reads every second the window names; the start goes as it is, since GDELT
 * reads from the first second of its minute anyway.
 */
export function contextRequestWindow(
  window: GdeltWindow,
  sort: ContextSort,
  now: number,
): GdeltWindow {
  const start = parseGdeltDatetime(window.startDatetime).getTime();
  const end = Math.min(parseGdeltDatetime(window.endDatetime).getTime(), now);
  const missing = MIN_REQUEST_SPAN_MS - (end - start);
  if (missing <= 0) {
    return { ...window, endDatetime: roundUpToMinute(window.endDatetime) };
  }
  const lowest = Math.min(start, reachStart(now));
  if (sort === 'dateDesc') {
    const widenedStart = Math.max(lowest, start - missing);
    const widenedEnd = Math.min(now, end + missing - (start - widenedStart));
    return windowOf(widenedStart, ceilToMinute(widenedEnd));
  }
  const widenedEnd = Math.min(now, end + missing);
  return windowOf(
    Math.max(lowest, start - (missing - (widenedEnd - end))),
    ceilToMinute(widenedEnd),
  );
}

/** How a sentence search continues past the page it returned. */
export type ContextContinuation =
  /** Re-run the call against `window` for the next matches. */
  | { kind: 'next'; window: GdeltWindow }
  /** The page reached past the window's far edge, so it holds every match in the window. */
  | { kind: 'complete' }
  /**
   * No narrower window reaches further matches: matches outside a widened window take the page
   * first (`widened`), or every match on the page sits within one minute, which no window bound
   * on a whole minute splits, so the next window would read the same page (`one_minute`). Only a
   * larger `maxRecords` reads further into that minute.
   */
  | { kind: 'blocked'; cause: 'widened' }
  | {
      kind: 'blocked';
      cause: 'one_minute';
      /**
       * The window past that minute, when one still holds part of the window and its request
       * reads none of the minute: from the next whole minute under `dateAsc`, up to the minute's
       * first second under `dateDesc`. It skips the rest of the minute, so it is for a page that
       * already ran at the `maxRecords` ceiling. `minute` is the minute's first second.
       */
      skip?: { window: GdeltWindow; minute: string };
    }
  /** The page holds no dated match to continue from. */
  | { kind: 'none' };

/**
 * Where a page continues. GDELT orders matches strictly by date and counts `maxrecords` in
 * sentences before keeping one per article, so a short page says nothing about what is left — but
 * its far-edge date is an exact resume point. GDELT reads window bounds only to the minute, so the
 * next window's moving edge sits on a whole minute: under `dateDesc` it ends on the minute at or
 * after the oldest match, under `dateAsc` it starts on the minute at or before the newest. An edge
 * on the oldest match's own second would read only up to its minute's first second and skip the
 * rest of that minute; on the whole minute, the matches between it and the far-edge match repeat
 * — on a dense minute, much of the next page — but none falls through. A window is handed back
 * only when that minute leaves out a match on this page and its request moves the minute GDELT
 * reads first, so a walk can never repeat a page. A page whose matches all fall in one minute is
 * blocked, and carries the window past that minute when one exists: no bound splits the minute, so
 * once `maxRecords` is at its ceiling the rest of it is out of reach, and the rest of the window
 * is not.
 *
 * `window` is the window the page answered for and `request` the one sent upstream; `seenMs` are
 * the epoch milliseconds of every match GDELT returned, including any trimmed from `window`.
 */
export function planContextContinuation(
  window: GdeltWindow,
  request: GdeltWindow,
  sort: ContextSort,
  seenMs: readonly number[],
  nowMs: number,
): ContextContinuation {
  if (seenMs.length === 0) return { kind: 'none' };
  const now = Math.floor(nowMs / SECOND_MS) * SECOND_MS;
  const start = parseGdeltDatetime(window.startDatetime).getTime();
  const end = parseGdeltDatetime(window.endDatetime).getTime();
  const requestStart = floorToMinute(parseGdeltDatetime(request.startDatetime).getTime());
  const requestEnd = ceilToMinute(parseGdeltDatetime(request.endDatetime).getTime());
  const oldest = Math.min(...seenMs);
  const newest = Math.max(...seenMs);
  const widened: ContextContinuation = { kind: 'blocked', cause: 'widened' };
  const oneMinute = (): ContextContinuation => {
    const skip = pastTheMinute();
    return { kind: 'blocked', cause: 'one_minute', ...(skip && { skip }) };
  };
  /** The window past the one minute this page's matches fell in, if its request reads none of it. */
  function pastTheMinute(): { window: GdeltWindow; minute: string } | undefined {
    if (sort === 'dateDesc') {
      const minute = floorToMinute(oldest);
      if (minute <= start) return;
      const skip = windowOf(start, Math.min(minute, end));
      const skipEnd = parseGdeltDatetime(
        contextRequestWindow(skip, sort, now).endDatetime,
      ).getTime();
      if (skipEnd > minute || skipEnd >= requestEnd) return;
      return { window: skip, minute: toGdeltDatetime(new Date(minute)) };
    }
    const minute = floorToMinute(newest);
    const from = minute + MINUTE_MS;
    if (from >= end) return;
    const skip = windowOf(from, end);
    const skipStart = parseGdeltDatetime(contextRequestWindow(skip, sort, now).startDatetime);
    if (floorToMinute(skipStart.getTime()) < from) return;
    return { window: skip, minute: toGdeltDatetime(new Date(minute)) };
  }

  if (sort === 'dateDesc') {
    if (oldest < start) return { kind: 'complete' };
    const nextEnd = ceilToMinute(oldest);
    /**
     * The next end would stay in the window's last minute: only a match past it, in a request
     * widened forward, spreads the page wider than one minute.
     */
    if (nextEnd >= ceilToMinute(end)) return newest > ceilToMinute(end) ? widened : oneMinute();
    if (nextEnd >= newest) return oneMinute();
    const next = windowOf(start, nextEnd);
    const nextRequest = contextRequestWindow(next, sort, now);
    if (parseGdeltDatetime(nextRequest.endDatetime).getTime() >= requestEnd) return widened;
    return { kind: 'next', window: next };
  }

  if (newest > end) return { kind: 'complete' };
  const nextStart = floorToMinute(newest);
  if (nextStart <= floorToMinute(start)) {
    /**
     * The page reaches no further than the window's first minute. With every match inside that
     * minute, the next window would read this page again. With matches before it — a 72-hour
     * timespan, which GDELT reads from 5 minutes before the window, or a request widened back —
     * the window itself is the next to try, unless its request is this one.
     */
    if (oldest >= floorToMinute(start)) return oneMinute();
    const nextRequest = contextRequestWindow(window, sort, now);
    if (floorToMinute(parseGdeltDatetime(nextRequest.startDatetime).getTime()) <= requestStart) {
      return widened;
    }
    return { kind: 'next', window: windowOf(start, end) };
  }
  if (nextStart <= oldest) return oneMinute();
  const next = windowOf(nextStart, end);
  const nextRequest = contextRequestWindow(next, sort, now);
  if (floorToMinute(parseGdeltDatetime(nextRequest.startDatetime).getTime()) <= requestStart) {
    return widened;
  }
  return { kind: 'next', window: next };
}

/** Five minutes inside the 72-hour reach at `now`. */
function reachStart(now: number): number {
  return now - REACH_MS + REACH_MARGIN_MS;
}

function windowOf(startMs: number, endMs: number): GdeltWindow {
  return {
    startDatetime: toGdeltDatetime(new Date(startMs)),
    endDatetime: toGdeltDatetime(new Date(endMs)),
  };
}
