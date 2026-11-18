/**
 * @fileoverview GDELT timeline date normalization, interval-based resolution inference, the DOC
 * resolution an answer reports, and the timesteps missing from a DOC answer.
 * @module services/gdelt/date-resolution
 */

/** Normalize GDELT compact dates to ISO 8601 while preserving date-only precision. */
export function normalizeGdeltDate(value: string): string {
  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  if (dateOnly) return `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`;

  const dateTime = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (dateTime) {
    return (
      `${dateTime[1]}-${dateTime[2]}-${dateTime[3]}` +
      `T${dateTime[4]}:${dateTime[5]}:${dateTime[6]}Z`
    );
  }

  return value;
}

/** Parse a supported GDELT/ISO date without treating malformed values as evidence. */
function parseTimelineDate(value: string): number | undefined {
  const normalized = normalizeGdeltDate(value);
  const milliseconds = Date.parse(
    /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? `${normalized}T00:00:00Z` : normalized,
  );
  return Number.isFinite(milliseconds) ? milliseconds : undefined;
}

/** The length of one timestep at each DOC timeline resolution. */
const DOC_STEP_MS = {
  '15min': 15 * 60 * 1000,
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
} as const;

export type DocDateResolution = keyof typeof DOC_STEP_MS;
export type TvDateResolution = 'hour' | 'day' | 'week' | 'month' | 'year';

/**
 * The spellings `query_details.date_resolution` takes, lowercased. DOC's `timelinevol` answers
 * report `15m` over 24 hours, `hour` over 7 days, and `day` over two and nine years (measured).
 */
const DOC_REPORTED_RESOLUTION: ReadonlyMap<string, DocDateResolution> = new Map([
  ['15m', '15min'],
  ['15min', '15min'],
  ['hour', 'hour'],
  ['day', 'day'],
]);

/**
 * The resolution a DOC answer reports in `query_details.date_resolution`, matched without regard
 * to case, or `undefined` when it names none DOC uses; a value spelled any other way leaves the
 * resolution to {@link inferDateResolution}.
 */
export function parseDocDateResolution(
  reported: string | undefined,
): DocDateResolution | undefined {
  return reported === undefined ? undefined : DOC_REPORTED_RESOLUTION.get(reported.toLowerCase());
}

/** A run of consecutive timesteps missing from a timeline: its first and last, and how many. */
type MissingTimestepRun = { first: string; last: string; count: number };

/** A timestep date in the form the DOC service gives it: an ISO day, or an ISO instant to the second. */
const ISO_TIMESTEP = /^(\d{4}-\d{2}-\d{2})(T\d{2}:\d{2}:\d{2}Z)?$/;

/**
 * The timesteps missing strictly between the first and last distinct timestep of `dates`, one
 * `resolution` step apart, as runs in date order — each run's dates in the form its neighbours
 * take. `dates` may hold several series' timesteps: a step any of them carries is present. Only
 * ISO days and instants (or GDELT's compact forms of them) count; any other string is no evidence
 * of a timestep. Steps before the first or after the last are never counted, so fewer than two
 * timesteps have no gap.
 *
 * A resolution names the step without showing the series takes it: an inferred one is only the
 * nearest DOC uses to the smallest interval (dates a week apart infer `day`), and a reported one
 * is DOC's label, not its spacing. So runs are found only where two timesteps sit exactly one step
 * apart: a series that never steps at the resolution has no gaps at it.
 */
export function findMissingTimesteps(
  dates: readonly string[],
  resolution: DocDateResolution,
): MissingTimestepRun[] {
  const stepMs = DOC_STEP_MS[resolution];
  const dateOnlyAt = new Map<number, boolean>();
  for (const date of new Set(dates)) {
    const match = ISO_TIMESTEP.exec(normalizeGdeltDate(date));
    if (!match) continue;
    const milliseconds = Date.parse(match[2] ? match[0] : `${match[1]}T00:00:00Z`);
    if (Number.isFinite(milliseconds)) dateOnlyAt.set(milliseconds, match[2] === undefined);
  }

  const runs: MissingTimestepRun[] = [];
  let stepSeen = false;
  let previous: [number, boolean] | undefined;
  for (const current of [...dateOnlyAt].sort(([a], [b]) => a - b)) {
    if (previous) {
      const [at, dateOnly] = previous;
      const interval = current[0] - at;
      stepSeen ||= interval === stepMs;
      const count = Math.ceil(interval / stepMs) - 1;
      if (count > 0) {
        runs.push({
          first: formatTimestep(at + stepMs, dateOnly),
          last: formatTimestep(at + count * stepMs, dateOnly),
          count,
        });
      }
    }
    previous = current;
  }
  return stepSeen ? runs : [];
}

/** An epoch instant as an ISO day, or as an ISO instant to the second. */
function formatTimestep(milliseconds: number, dateOnly: boolean): string {
  const iso = new Date(milliseconds).toISOString();
  return dateOnly ? iso.slice(0, 10) : `${iso.slice(0, 19)}Z`;
}

export function inferDateResolution(dates: string[], api: 'tv'): TvDateResolution | undefined;
export function inferDateResolution(dates: string[], api?: 'doc'): DocDateResolution | undefined;
/**
 * Infer the API's supported resolution from the smallest positive interval in the full series.
 * Resolution is an interval, so fewer than two distinct usable timestamps leave it
 * undeterminable — `undefined`, never a guessed default reported as fact.
 */
export function inferDateResolution(
  dates: string[],
  api: 'doc' | 'tv' = 'doc',
): DocDateResolution | TvDateResolution | undefined {
  // Series of one answer repeat the same dates, so each distinct string is parsed once.
  const timestamps = [
    ...new Set(
      [...new Set(dates)].map(parseTimelineDate).filter((value): value is number => value != null),
    ),
  ].sort((a, b) => a - b);
  if (timestamps.length < 2) return;

  let smallestInterval = Number.POSITIVE_INFINITY;
  for (let index = 1; index < timestamps.length; index += 1) {
    const previous = timestamps[index - 1];
    const current = timestamps[index];
    if (previous != null && current != null) {
      smallestInterval = Math.min(smallestInterval, current - previous);
    }
  }
  const hour = 60 * 60 * 1000;
  const day = 24 * hour;
  if (api === 'doc') {
    if (smallestInterval < hour) return '15min';
    return smallestInterval < day ? 'hour' : 'day';
  }

  if (smallestInterval < day) return 'hour';
  if (smallestInterval < 7 * day) return 'day';
  if (smallestInterval < 28 * day) return 'week';
  if (smallestInterval < 300 * day) return 'month';
  return 'year';
}
