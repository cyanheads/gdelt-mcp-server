/**
 * @fileoverview Shared date-range handling for the GDELT tools that accept an explicit
 * startDatetime/endDatetime window — the YYYYMMDDHHMMSS field pattern, the both-or-neither
 * pairing predicate, record timestamps against a window, and the window partitioning and
 * resume boundary the record-list tools hand back as a continuation contract.
 * @module mcp-server/tools/date-range
 */

import { z } from '@cyanheads/mcp-ts-core';
import { formatDateShort, resolveTimespan } from '@/services/gdelt/gdelt-fetch.js';

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
  m: 30 * 24 * 60,
  y: 365 * 24 * 60,
} as const;

/**
 * Relative DOC timespan validator. It rejects only syntax the server can parse reliably;
 * unknown/upstream-evolved syntax remains available to GDELT and its response classifier.
 */
export const gdeltDocTimespanSchema = z.string().refine(
  (timespan) => {
    const match = /^(\d+)(min|h|d|m|y)$/i.exec(timespan.trim());
    if (!match) return true;
    const amount = Number(match[1]);
    const unit = timespan
      .trim()
      .replace(/^\d+/, '')
      .toLowerCase() as keyof typeof TIMESPAN_UNIT_MINUTES;
    return amount * TIMESPAN_UNIT_MINUTES[unit] >= GDELT_DOC_MIN_TIMESPAN_MINUTES;
  },
  { message: 'DOC timespan must be at least 15 minutes; use "15min" or a longer window.' },
);

/** A GDELT query window, both boundaries in the 14-digit YYYYMMDDHHMMSS wire format. */
export type GdeltWindow = {
  startDatetime: string;
  endDatetime: string;
};

/** GDELT's datetime resolution — the narrowest window a caller can express. */
const GDELT_RESOLUTION_MS = 1000;

/** Parse a 14-digit YYYYMMDDHHMMSS string as UTC. Invalid calendar values yield an Invalid Date. */
function parseGdeltDatetime(value: string): Date {
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
 * when an explicit window was pinned or the timespan does not parse.
 */
export function describeResolvedTimespan(args: {
  timespan?: string | undefined;
  startDatetime?: string | undefined;
  endDatetime?: string | undefined;
}): string {
  if (!args.timespan || args.startDatetime || args.endDatetime) return '';
  const range = resolveTimespan(args.timespan);
  return range
    ? ` Timespan "${args.timespan}" resolved to ${formatDateShort(range.start)} – ${formatDateShort(range.end)}.`
    : '';
}

/**
 * Smallest span that still divides into two strictly-narrower halves. The second half
 * reaches back a second to cover the seam, so it costs `span - floor(span/2) + 1`
 * seconds — only under four does that stop shrinking.
 */
const MIN_SPLITTABLE_MS = 4 * GDELT_RESOLUTION_MS;

/**
 * Split a window into two halves whose union covers it exactly, or `undefined` when it
 * is already too narrow to divide.
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
 * How a caller retrieves records left behind once `maxRecords` is already at its ceiling, or
 * once a page under a sort with no resume point is cut to the response byte budget.
 *
 * GDELT exposes no offset or cursor, so narrowing the time window is the only lever, and
 * each outcome is stated rather than implied: halves to re-query when the window divides,
 * how to pin a window when the call never set one, and — when the window is already too
 * narrow to divide — that the remaining records are simply unreachable.
 *
 * Callers own the record-noun prose; this covers only the window reasoning both tools share.
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
      guidance:
        `The window ${window.startDatetime}–${window.endDatetime} is already too narrow to divide at GDELT's ` +
        'one-second resolution, so the remaining records are not retrievable through this API.',
    };
  }

  const [first, second] = windows;
  return {
    windows,
    guidance:
      'GDELT exposes no offset or cursor. Re-run this query unchanged against each half of the current window — ' +
      `${first.startDatetime}–${first.endDatetime}, then ${second.startDatetime}–${second.endDatetime} ` +
      '(both echoed in continuationWindows) — and split a half again if it also hits the cap or comes back cut. ' +
      'The halves overlap by one second so nothing falls through the seam, so a record on that second can ' +
      'appear in both: de-duplicate on re-assembly.',
  };
}

/**
 * One clock hour. Measured live against GDELT TV: a `startdatetime`/`enddatetime` window is
 * answered on clip air time from `floor_hour(start)` through the end of `enddatetime`'s hour,
 * and a window spanning under 30 minutes is rejected ("Timespan is too short." — 20 minutes
 * rejected, 30 accepted).
 */
const HOUR_MS = 3_600_000;

/**
 * The window to send GDELT TV for a caller's window: the start floored to the clock hour and
 * the end kept, or stretched to the end of that first hour when the window is shorter. GDELT
 * answers the same whole hours either way — this never adds an hour the caller's window does
 * not reach — but the widened span is one GDELT accepts, so a window of any width works. The
 * caller's exact window is what the out-of-window drop then keeps.
 *
 * An end exactly on the clock hour is sent one second earlier: sent as is, it would have GDELT
 * answer that whole next hour for the window's one final second, spending maxRecords on clips
 * the drop then discards. That final second is left out — as GDELT documents ENDDATETIME, the
 * end is exclusive there.
 */
export function tvRequestWindow(window: GdeltWindow): GdeltWindow {
  const start = Math.floor(parseGdeltDatetime(window.startDatetime).getTime() / HOUR_MS) * HOUR_MS;
  const end = Math.max(lastTvSecond(window), start + HOUR_MS - GDELT_RESOLUTION_MS);
  return {
    startDatetime: toGdeltDatetime(new Date(start)),
    endDatetime: toGdeltDatetime(new Date(end)),
  };
}

/** The last second of a window GDELT TV is asked for: its end, or a second before an on-the-hour end. */
function lastTvSecond(window: GdeltWindow): number {
  const end = parseGdeltDatetime(window.endDatetime).getTime();
  return end % HOUR_MS === 0 ? end - GDELT_RESOLUTION_MS : end;
}

/** Whether GDELT capped the page that needs a continuation, and against which limit. */
export type TvCap = 'none' | 'below-ceiling' | 'at-ceiling';

/**
 * The TV counterpart of {@link planWindowContinuation}. GDELT TV answers whole clock hours and
 * the handler trims its answer to the requested window, so halves need no overlapping second:
 * they share no second and cover the window exactly.
 *
 * The split falls on the clock hour nearest the middle whenever one lies inside the window,
 * which gives the two halves disjoint hour sets — the split that helps when the cap left
 * records behind, since any window inside one hour fetches that same capped hour. Inside a
 * single hour a page cut to the byte budget still splits at the second: its withheld clips were
 * fetched and each half fetches the hour again and keeps its own seconds. When that page was
 * also capped, only clips past the cap stay out of reach — a higher maxRecords reaches them
 * below the 3000 ceiling, nothing does at it. An uncut page capped at the ceiling with no hour
 * inside has nothing a narrower window can add.
 */
export function planTvWindowContinuation(
  window: GdeltWindow | undefined,
  { cut, cap }: { cut: boolean; cap: TvCap },
): WindowContinuation {
  if (!window) return planWindowContinuation(undefined);

  const start = parseGdeltDatetime(window.startDatetime).getTime();
  const end = parseGdeltDatetime(window.endDatetime).getTime();
  const middle = start + (end - start) / 2;
  const hourInside = [Math.floor(middle / HOUR_MS), Math.ceil(middle / HOUR_MS)]
    .map((hour) => hour * HOUR_MS)
    .filter((boundary) => boundary > start + GDELT_RESOLUTION_MS && boundary < end)
    .sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle))[0];

  let windows: [GdeltWindow, GdeltWindow] | undefined;
  let capNote = '';
  if (hourInside !== undefined) {
    windows = [
      {
        startDatetime: window.startDatetime,
        endDatetime: toGdeltDatetime(new Date(hourInside - GDELT_RESOLUTION_MS)),
      },
      { startDatetime: toGdeltDatetime(new Date(hourInside)), endDatetime: window.endDatetime },
    ];
  } else if (!cut) {
    return {
      guidance:
        `No clock hour falls inside the window ${window.startDatetime}–${window.endDatetime}, and the TV API ` +
        'answers in whole clock hours, so every narrower window inside it fetches the same capped set — the ' +
        'remaining clips are not retrievable through this API.',
    };
  } else if (end - start >= MIN_TV_SPLITTABLE_MS) {
    capNote =
      cap === 'below-ceiling'
        ? ' GDELT stopped at maxRecords within this hour, so clips past that cap are out of reach of any ' +
          'narrower window.'
        : cap === 'at-ceiling'
          ? ' GDELT stopped at 3000 within this hour, so more clips matched upstream than any window inside ' +
            'this hour can fetch.'
          : '';
    const midpoint =
      start + Math.floor((end - start) / 2 / GDELT_RESOLUTION_MS) * GDELT_RESOLUTION_MS;
    windows = [
      { startDatetime: window.startDatetime, endDatetime: toGdeltDatetime(new Date(midpoint)) },
      {
        startDatetime: toGdeltDatetime(new Date(midpoint + GDELT_RESOLUTION_MS)),
        endDatetime: window.endDatetime,
      },
    ];
  } else {
    return {
      guidance:
        `The window ${window.startDatetime}–${window.endDatetime} is already too narrow to divide at one-second ` +
        'resolution, so the remaining clips are not retrievable through this API.',
    };
  }

  const [first, second] = windows;
  return {
    windows,
    guidance:
      'GDELT exposes no offset or cursor. Re-run this query unchanged against each half of the current window — ' +
      `${first.startDatetime}–${first.endDatetime}, then ${second.startDatetime}–${second.endDatetime} ` +
      '(both echoed in continuationWindows) — and split a half again if it also hits the cap or comes back cut. ' +
      'The TV API answers in whole clock hours and each response keeps only its own window, so the halves ' +
      `share no second and no clip.${capNote}`,
  };
}

/** Narrowest window split into two non-empty, second-disjoint halves: `[s, s+1]` and `[s+2, s+3]`. */
const MIN_TV_SPLITTABLE_MS = 3 * GDELT_RESOLUTION_MS;

/** Sort orders whose last emitted record is a point a follow-up window can resume from. */
export type DateSort = 'dateDesc' | 'dateAsc';

/**
 * The boundary that resumes a date-sorted run after the last record a response emitted: under
 * `dateDesc` an `endDatetime` one second past that record, under `dateAsc` a `startDatetime`
 * one second before it. The other boundary stays whatever the caller's window had.
 *
 * Reaching one second past the record keeps it inside the resumed window under GDELT's
 * documented exclusive boundaries, so records that share its second — and were cut — are
 * returned again rather than skipped. Records from that second the response already emitted
 * come back too, so callers de-duplicate on re-assembly.
 */
export function resumeBoundary(
  sort: DateSort,
  lastEmittedMs: number,
): Pick<GdeltWindow, 'endDatetime'> | Pick<GdeltWindow, 'startDatetime'> {
  return sort === 'dateDesc'
    ? { endDatetime: toGdeltDatetime(new Date(lastEmittedMs + GDELT_RESOLUTION_MS)) }
    : { startDatetime: toGdeltDatetime(new Date(lastEmittedMs - GDELT_RESOLUTION_MS)) };
}

/**
 * The boundary that skips past the last emitted record's second: under `dateDesc` an
 * `endDatetime` one second before it, under `dateAsc` a `startDatetime` one second after it.
 * Offered when resuming at that second cannot make progress; records at the skipped second
 * that the response did not emit are left behind.
 */
export function skipPastBoundary(
  sort: DateSort,
  lastEmittedMs: number,
): Pick<GdeltWindow, 'endDatetime'> | Pick<GdeltWindow, 'startDatetime'> {
  return sort === 'dateDesc'
    ? { endDatetime: toGdeltDatetime(new Date(lastEmittedMs - GDELT_RESOLUTION_MS)) }
    : { startDatetime: toGdeltDatetime(new Date(lastEmittedMs + GDELT_RESOLUTION_MS)) };
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
