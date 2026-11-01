/**
 * @fileoverview Shared types for GDELT DOC and TV API responses, and for where a DOC tool's
 * answer came from when the local GKG mirror stands behind the DOC API.
 * @module services/gdelt/types
 */

import type { MirrorCoverage } from '../gkg-mirror/types.js';

// ─── DOC API types ───────────────────────────────────────────────────────────

/** Raw article record from GDELT DOC API artlist mode. */
export type RawArticle = {
  url: string;
  title: string;
  seendate: string;
  socialimage?: string;
  domain: string;
  language: string;
  sourcecountry: string;
};

/** Normalized article for tool output. */
export type Article = {
  url: string;
  title: string;
  seendate: string;
  domain: string;
  language: string;
  sourcecountry: string;
  socialimage?: string;
};

/** Raw timeline data point from GDELT DOC API timeline modes. */
export type RawTimelinePoint = {
  date: string;
  value: number;
  /** Unsmoothed monitored-article denominator, supplied by timelinevolraw only. */
  norm?: number;
};

/** Raw series from GDELT DOC API timeline response. */
export type RawTimelineSeries = {
  series: string;
  html: string;
  data: RawTimelinePoint[];
};

/** Raw response from GDELT DOC API timelinevolinfo — includes article blobs. */
export type RawTimelineVolInfoPoint = {
  date: string;
  value: number;
  toparts?: Array<{ url: string; title: string }>;
};

// ─── DOC answer provenance ───────────────────────────────────────────────────

/** Where a DOC tool's answer came from: the GDELT DOC API or the server's local GKG mirror. */
export const DOC_SOURCES = ['doc_api', 'gkg_mirror'] as const;

export type DocSource = (typeof DOC_SOURCES)[number];

/**
 * What one source did with a DOC tool call: answered with data, answered with nothing, refused
 * (`rate_limited`, `unavailable`), or — for the mirror — could not answer (`not_ready`,
 * `not_compiled`, `outside_coverage`, `store_error`).
 */
export const DOC_ATTEMPT_OUTCOMES = [
  'answered',
  'empty',
  'rate_limited',
  'unavailable',
  'not_ready',
  'not_compiled',
  'outside_coverage',
  'store_error',
] as const;

export type DocAttemptOutcome = (typeof DOC_ATTEMPT_OUTCOMES)[number];

/** One source's outcome on a call that tried more than one. `detail` says why, when there is a why. */
export type DocAttempt = { source: DocSource; outcome: DocAttemptOutcome; detail?: string };

/** How much of the requested window a mirror answer covers, when it covers less. */
export type DocCoverage = MirrorCoverage;

/** What DOC did with a call the mirror then answered in its place. */
export type DocStoodInFor = Extract<DocAttemptOutcome, 'empty' | 'rate_limited' | 'unavailable'>;

/** A DOC tool call the local GKG mirror answered in DOC's place: the facts its notice discloses. */
export type MirrorStandIn = {
  standsInFor: DocStoodInFor;
  /** Mirrored articles matching the query in the answered window; zero is an answer. */
  matched: number;
  /** Matching articles left out of a source-country breakdown because their outlet has no known country. */
  excludedWithoutCountry?: number;
};

// ─── TV API types ─────────────────────────────────────────────────────────────

/** Raw TV station record from GDELT TV stationdetails mode. */
export type RawTvStation = {
  StationID: string;
  Description: string;
  Market: string;
  Network: string;
  StartDate: string;
  EndDate: string;
};

/** Raw TV clip from GDELT TV clipgallery mode. */
export type RawTvClip = {
  show: string;
  /** The station's display label (its catalog `Description`), not its station ID. */
  station?: string;
  date: string;
  snippet: string;
  preview_url: string;
  preview_thumb?: string;
};

/** Raw TV word cloud entry from GDELT TV wordcloud mode. */
export type RawTvWord = {
  label: string;
  count: number;
};

/** Raw TV stationchart row; count is station airtime percentage or matching clip count. */
export type RawTvStationChartRow = { station: string; count: number };

/** Raw TV showchart row; count is always a percentage of matching clips. */
export type RawTvShowChartRow = { show: string; count: number };

/** A provider TV ranking label and value, with a catalog ID only for resolved stations. */
export type TvBreakdownRow = { label: string; value: number; station?: string };

/** Denominator and units of the provider's TV ranking values. */
export type TvBreakdownValueUnit =
  | 'percent_station_airtime'
  | 'percent_matching_clips'
  | 'matching_clips';

/** Normalized TV station for tool output. */
export type TvStation = {
  stationId: string;
  description: string;
  market: string;
  network: string;
  startDate: string;
  endDate: string;
  isActive: boolean;
};

/** Normalized TV clip for tool output. */
export type TvClip = {
  show: string;
  /** Catalog station ID. Absent when the clip's label did not resolve to one. */
  station?: string;
  /** GDELT's display label for the station — its catalog description. Empty when GDELT sent none. */
  stationName: string;
  date: string;
  snippet: string;
  archiveUrl: string;
  thumbnail?: string;
};
