/**
 * @fileoverview Station identity on the TV tools: the `stations` input cleaned and checked
 * before any request, the `Name (ID)` label gdelt_search_tv series and gdelt_get_tv_clips clip
 * headings render, and the notice segments for rows that carry no station ID and for selected
 * stations whose monitoring range an empty result's window misses.
 * @module mcp-server/tools/station-ids
 */

import { validationError } from '@cyanheads/mcp-ts-core/errors';
import type { StationRanges, TvStationRange } from '@/services/gdelt/gdelt-tv-service.js';
import type { GdeltWindow } from './date-range.js';
import { escapeMarkdown, markdownQuote, quoteText } from './markdown-escape.js';

/** Every ID in GDELT's station catalog is letters and digits. */
const STATION_ID = /^[A-Za-z0-9]+$/;

/**
 * Invisible format characters (zero-width space and joiners, soft hyphen, word joiner): pasted
 * text carries them, GDELT drops them, and in a refusal they would make `CNN` followed by a
 * zero-width space read as the valid `CNN`.
 */
const INVISIBLE_FORMAT = /\p{Cf}/gu;

/** A catalog date as the TV service normalizes it. */
const CATALOG_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The `stations` input as GDELT receives it: each entry stripped of invisible format characters
 * and trimmed, and blank entries dropped, with case and order kept — GDELT matches IDs
 * case-insensitively. An empty result means no stations were selected.
 *
 * The service splices each entry into the query as `station:<entry>`, and GDELT reads a token
 * that is not a station ID in ways the caller cannot see: a display label such as `FOX News` or
 * an operator fails with an error about something else, a quoted ID matches nothing, and stray
 * punctuation is dropped or cuts the token short, so `CNN,MSNBC` answers as CNN alone. Such
 * entries are refused here instead, before any request; labels are never resolved to IDs.
 * @throws McpError `ValidationError` with reason `invalid_query`, naming every such entry.
 */
export function parseStationIds(stations: readonly string[] = []): string[] {
  const ids = stations
    .map((entry) => entry.replace(INVISIBLE_FORMAT, '').trim())
    .filter((entry) => entry !== '');
  const invalid = ids.filter((id) => !STATION_ID.test(id));
  if (invalid.length > 0) {
    const named = invalid.map(quoteText).join(', ');
    throw validationError(
      `Invalid stations ${invalid.length === 1 ? 'entry' : 'entries'} ${named}: stations takes station IDs such as CNN or FOXNEWS (letters and digits only), not display labels. Find a station's ID with gdelt_list_tv_stations.`,
      {
        reason: 'invalid_query',
        recovery: {
          hint: 'Look each station up with gdelt_list_tv_stations and pass its stationId (e.g. FOXNEWS) in stations, not its description (e.g. "FOX News").',
        },
      },
    );
  }
  return ids;
}

/** A series or clip: GDELT's label (empty when GDELT sent none), and its station ID, if any. */
type StationRow = { readonly station?: string | undefined; readonly stationName: string };

/**
 * `FOX News (FOXNEWS)` — or the label alone when it already ends in its ID
 * (`CBS - Philadelphia (KYW)`), `KZZZ (no station ID)` for a row with no resolved ID, and
 * `(no station label)` for a row GDELT sent without a label.
 */
export function stationLabel(row: StationRow): string {
  if (row.stationName === '') return '(no station label)';
  const suffix = `(${row.station ?? 'no station ID'})`;
  return row.station !== undefined && row.stationName.endsWith(suffix)
    ? row.stationName
    : `${row.stationName} ${suffix}`;
}

/**
 * The notice segments for the returned rows that carry no station ID, or `undefined` when every
 * one does. Rows GDELT sent without a label are counted as such — there was nothing to resolve.
 * For labeled rows: when the catalog did not load, none resolved and the segment says so;
 * otherwise it names each label the catalog has no entry for. A notice reaches content[] as
 * written, so each label is quoted with `markdownQuote`, as caller text is; a plain label reads as
 * `"FOX News"`.
 */
export function describeUnresolvedStations(
  rows: readonly StationRow[],
  catalogUnavailable: boolean,
  noun: { readonly singular: string; readonly plural: string },
): string | undefined {
  const unresolved = rows.filter((row) => row.station === undefined);
  const unlabeled = unresolved.filter((row) => row.stationName === '').length;
  const labels = [
    ...new Set(unresolved.map((row) => row.stationName).filter((label) => label !== '')),
  ];
  const segments: string[] = [];
  if (unlabeled > 0) {
    segments.push(
      unlabeled === 1
        ? `GDELT returned 1 ${noun.singular} without a station label, so its stationName is ` +
            'empty and station is absent.'
        : `GDELT returned ${unlabeled} ${noun.plural} without a station label, so their ` +
            'stationName is empty and station is absent.',
    );
  }
  if (labels.length > 0) segments.push(describeUnresolvedLabels(labels, catalogUnavailable));
  return segments.length > 0 ? segments.join(' ') : undefined;
}

/**
 * For an empty result: a sentence for each selected station whose monitoring range the window
 * misses — starting after the range ends, or ending before it starts — then how to reach one; `''`
 * when none does. Each sentence opens with a space, to follow the sentence before it.
 *
 * Each of `stationIds` is matched against the catalog in any case, as GDELT matches IDs, and named
 * once, by the catalog's own ID, escaped as upstream text in a notice is. Days compare whole — a
 * range runs from the start of its first day through the end of its last — so a window touching
 * either day overlaps it. The catalog promises no coverage inside a range, so an overlapping range
 * is never named; neither is a station the catalog lacks, or one whose dates are not `YYYY-MM-DD`.
 * A station active when the catalog was read is never said to have ended — its end date has moved
 * on since — so only a window ending before its start is named for it.
 */
export function describeStationRangeMisses(
  stationIds: readonly string[],
  ranges: StationRanges,
  window: GdeltWindow,
): string {
  const misses = [...new Set(stationIds.map((id) => id.toUpperCase()))].flatMap((id) => {
    const range = ranges.get(id);
    if (!range) return [];
    const miss = rangeMiss(range, window);
    return miss
      ? [
          ` ${escapeMarkdown(range.stationId)} was monitored ${range.startDate} – ${range.endDate}; the window ${miss}.`,
        ]
      : [];
  });
  if (misses.length === 0) return '';
  return `${misses.join('')} Set startDatetime and endDatetime inside ${misses.length === 1 ? 'that range' : "a station's range"} to search that station.`;
}

/**
 * How `window` misses `range`, or `undefined` when they share a day, the range has no dates, or
 * the window starts after the stored end of a range that was still active when read.
 */
function rangeMiss(range: TvStationRange, window: GdeltWindow): string | undefined {
  if (!CATALOG_DATE.test(range.startDate) || !CATALOG_DATE.test(range.endDate)) return;
  // YYYYMMDD prefixes of fixed-width digits: lexical order is calendar order.
  if (!range.isActive && window.startDatetime.slice(0, 8) > range.endDate.replaceAll('-', '')) {
    return 'starts after that range ends';
  }
  if (window.endDatetime.slice(0, 8) < range.startDate.replaceAll('-', '')) {
    return 'ends before that range starts';
  }
  return;
}

/** The segment for labeled rows with no station ID. */
function describeUnresolvedLabels(labels: readonly string[], catalogUnavailable: boolean): string {
  if (catalogUnavailable) {
    return (
      "Station IDs could not be resolved — GDELT's station catalog did not load — so station is " +
      "absent and stationName carries GDELT's label; find the IDs with gdelt_list_tv_stations. " +
      'The next call loads the catalog again.'
    );
  }
  const quoted = labels.map(markdownQuote).join(', ');
  return labels.length === 1
    ? `No station in GDELT's station catalog is labeled ${quoted}, so station is absent where ` +
        `stationName is ${quoted}; find its ID with gdelt_list_tv_stations.`
    : `No station in GDELT's station catalog is labeled ${quoted}, so station is absent where ` +
        'stationName is one of them; find their IDs with gdelt_list_tv_stations.';
}
