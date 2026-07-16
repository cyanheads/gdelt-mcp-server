/**
 * @fileoverview Shared date-range handling for the GDELT tools that accept an explicit
 * startDatetime/endDatetime window — the YYYYMMDDHHMMSS field pattern, the both-or-neither
 * pairing predicate, and the window partitioning the record-cap tools hand back as a
 * continuation contract.
 * @module mcp-server/tools/date-range
 */

import { resolveTimespan } from '@/services/gdelt/gdelt-fetch.js';

/**
 * GDELT's datetime wire format: exactly 14 digits, YYYYMMDDHHMMSS, no separators.
 *
 * Applied as a field-level Zod `.regex()` so it serializes into the advertised JSON
 * Schema as `pattern`, letting a caller see the constraint before it calls.
 */
export const GDELT_DATETIME_PATTERN = /^\d{14}$/;

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
 * How a caller retrieves records left behind once `maxRecords` is already at its ceiling.
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
        'one-second resolution, so the records past this cap are not retrievable through this API.',
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
