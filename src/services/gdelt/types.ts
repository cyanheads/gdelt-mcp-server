/**
 * @fileoverview Shared types for GDELT DOC and TV API responses.
 * @module services/gdelt/types
 */

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
  station: string;
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
  station: string;
  date: string;
  snippet: string;
  archiveUrl: string;
  thumbnail?: string;
};
