/**
 * @fileoverview The UTC window a GDELT TV answer covers. GDELT TV counts whole UTC periods — clock
 * hours, days, Sunday–Saturday weeks, months, years — and widens an explicit
 * startdatetime/enddatetime window outward to them: the start back to its period's first second,
 * the end through its period's last. A timeline point, a station or show ranking, and a word cloud
 * computed over that wider window carry no sign of it, so the TV tools name the window they cover.
 * @module mcp-server/tools/tv-covered-window
 */

import type { TvDateResolution } from '@/services/gdelt/date-resolution.js';
import { type GdeltWindow, parseGdeltDatetime } from './date-range.js';

const SECOND_MS = 1000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * The longest window GDELT TV answers hourly when it picks the resolution itself, and the shortest
 * it answers monthly. Its TV 2.0 documentation gives hourly under 7 days, daily under 3 years, and
 * monthly otherwise; measured live on station charts, a window of exactly 7 days is still hourly
 * (as the documentation's `DATERES` entry has hours "for timespans of 7 or fewer days") and 3 years
 * counts as 3 × 365 days — a second short of it is daily, exactly that span monthly.
 */
const LONGEST_HOURLY_MS = 7 * DAY_MS;
const SHORTEST_MONTHLY_MS = 3 * 365 * DAY_MS;

/**
 * The resolution GDELT TV picks for a window it is not given `dateres` for, from the window's
 * length. Rankings, word clouds, and clip galleries always take it; a timeline takes it when
 * `dateres` is omitted.
 */
export function defaultTvResolution(
  window: GdeltWindow,
): Extract<TvDateResolution, 'hour' | 'day' | 'month'> {
  const spanMs =
    parseGdeltDatetime(window.endDatetime).getTime() -
    parseGdeltDatetime(window.startDatetime).getTime();
  if (spanMs <= LONGEST_HOURLY_MS) return 'hour';
  return spanMs < SHORTEST_MONTHLY_MS ? 'day' : 'month';
}

/** How notices name the UTC periods each resolution counts. */
export const TV_PERIOD_NAMES = {
  hour: 'clock hours',
  day: 'UTC days',
  week: 'UTC weeks (Sunday–Saturday)',
  month: 'UTC months',
  year: 'UTC years',
} as const satisfies Record<TvDateResolution, string>;

/** Each resolution's period arithmetic, on epoch milliseconds: a period's first instant, and the next one's. */
const PERIODS: Record<
  TvDateResolution,
  { startOf: (ms: number) => number; nextAfter: (start: number) => number }
> = {
  hour: {
    startOf: (ms) => Math.floor(ms / HOUR_MS) * HOUR_MS,
    nextAfter: (start) => start + HOUR_MS,
  },
  day: {
    startOf: (ms) => Math.floor(ms / DAY_MS) * DAY_MS,
    nextAfter: (start) => start + DAY_MS,
  },
  week: {
    startOf: (ms) => {
      const day = Math.floor(ms / DAY_MS) * DAY_MS;
      return day - new Date(day).getUTCDay() * DAY_MS;
    },
    nextAfter: (start) => start + 7 * DAY_MS,
  },
  month: {
    startOf: (ms) => {
      const date = new Date(ms);
      return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
    },
    nextAfter: (start) => {
      const date = new Date(start);
      return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    },
  },
  year: {
    startOf: (ms) => Date.UTC(new Date(ms).getUTCFullYear(), 0, 1),
    nextAfter: (start) => Date.UTC(new Date(start).getUTCFullYear() + 1, 0, 1),
  },
};

/** ISO 8601 to the second, as TV point dates are written. */
function isoSecond(ms: number): string {
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}

/**
 * The notice sentence naming the UTC window `subject` covers when GDELT widened an explicit
 * startDatetime/endDatetime window to whole periods — of the resolution the answer `reported`, or
 * else of {@link defaultTvResolution} — or `undefined` when both edges already sit on period
 * boundaries or the call set no explicit window. A timespan is resolved on GDELT's own clock,
 * which this server cannot observe, so it gets no sentence. An end exactly on a period's first
 * second counts that whole period, as GDELT answers it.
 */
export function describeTvCoveredWindow(
  subject: string,
  args: { startDatetime?: string | undefined; endDatetime?: string | undefined },
  reported?: TvDateResolution,
): string | undefined {
  if (!args.startDatetime || !args.endDatetime) return;
  const window = { startDatetime: args.startDatetime, endDatetime: args.endDatetime };
  const resolution = reported ?? defaultTvResolution(window);
  const { startOf, nextAfter } = PERIODS[resolution];
  const start = parseGdeltDatetime(window.startDatetime).getTime();
  const end = parseGdeltDatetime(window.endDatetime).getTime();
  const coveredStart = startOf(start);
  const coveredEnd = nextAfter(startOf(end)) - SECOND_MS;
  if (coveredStart === start && coveredEnd === end) return;
  return `${subject} cover whole ${TV_PERIOD_NAMES[resolution]}, ${isoSecond(coveredStart)} – ${isoSecond(coveredEnd)}, wider than the requested ${window.startDatetime}–${window.endDatetime}.`;
}
