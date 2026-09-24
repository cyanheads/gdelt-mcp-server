/**
 * @fileoverview GDELT timeline date normalization and interval-based resolution inference.
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

export type DocDateResolution = '15min' | 'hour' | 'day';
export type TvDateResolution = 'hour' | 'day' | 'week' | 'month' | 'year';

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
  const timestamps = [
    ...new Set(dates.map(parseTimelineDate).filter((value): value is number => value != null)),
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
