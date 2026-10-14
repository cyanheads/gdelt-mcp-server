/**
 * @fileoverview Station identity on gdelt_search_tv series and gdelt_get_tv_clips clips: the
 * `Name (ID)` label both content[] headings render, and the notice segments for rows that carry
 * no station ID.
 * @module mcp-server/tools/station-ids
 */

import { markdownQuote } from './markdown-escape.js';

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
