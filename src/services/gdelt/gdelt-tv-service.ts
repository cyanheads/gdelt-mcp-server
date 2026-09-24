/**
 * @fileoverview Service wrapping the GDELT TV API v2. Handles TV news transcript search,
 * clip retrieval, context/word cloud, and station metadata.
 * @module services/gdelt/gdelt-tv-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import type { ServerConfig } from '@/config/server-config.js';
import {
  inferDateResolution,
  normalizeGdeltDate,
  type TvDateResolution,
} from './date-resolution.js';
import { applyTimeRange, gdeltFetch } from './gdelt-fetch.js';
import type { RawTvClip, RawTvStation, RawTvWord, TvClip, TvStation } from './types.js';

const TV_ENDPOINT = '/tv/tv';

/** Threshold for "active" station: endDate within this many milliseconds of now. */
const ACTIVE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

export type TvSearchParams = {
  query: string;
  stations?: string[];
  timespan?: string;
  startDatetime?: string;
  endDatetime?: string;
  smoothing?: number;
  normalize?: boolean;
  dateres?: TvDateResolution;
};

export type TvClipParams = {
  query: string;
  stations?: string[];
  timespan?: string;
  startDatetime?: string;
  endDatetime?: string;
  maxRecords?: number;
  sort?: 'relevance' | 'dateDesc' | 'dateAsc';
};

export type TvContextParams = {
  query: string;
  stations?: string[];
  timespan?: string;
  startDatetime?: string;
  endDatetime?: string;
};

export type TvSearchSeries = {
  station: string;
  data: Array<{ date: string; value: number }>;
};

export type TvContextWord = {
  label: string;
  score: number;
};

export class GdeltTvService {
  private readonly baseUrl: string;

  constructor(_config: AppConfig, _storage: StorageService, serverConfig: ServerConfig) {
    this.baseUrl = serverConfig.baseUrl + TV_ENDPOINT;
  }

  /**
   * Search TV coverage — returns per-station normalized time series. `dateResolution` is
   * omitted when nothing supports it: no upstream metadata, no `dateres`, and fewer than two
   * distinct timestamps (a `{}` zero-match answer has none at all).
   */
  async searchTv(
    params: TvSearchParams,
    ctx: Context,
  ): Promise<{
    series: TvSearchSeries[];
    dateResolution?: TvDateResolution;
    normalized: boolean;
  }> {
    const urlParams = this.buildBaseParams(params.query, params.stations);
    urlParams.set('mode', 'timelinevol');
    urlParams.set('datanorm', params.normalize !== false ? 'perc' : 'raw');
    if (params.smoothing != null) urlParams.set('timelinesmooth', String(params.smoothing));
    if (params.dateres) urlParams.set('dateres', params.dateres);
    applyTimeRange(urlParams, params.timespan, params.startDatetime, params.endDatetime);

    const raw = await this.fetch<{
      timeline?: Array<{ series: string; data?: Array<{ date: string; value: number }> }>;
      dateresolution?: string;
    }>(urlParams, ctx);

    const series: TvSearchSeries[] = (raw.timeline ?? []).map((s) => ({
      station: s.series ?? 'Unknown',
      data: (s.data ?? []).map((d) => ({ date: normalizeGdeltDate(d.date), value: d.value })),
    }));

    const allDates = series.flatMap((s) => s.data.map((d) => d.date));

    const observedResolution = raw.dateresolution?.toLowerCase();
    const recognizedResolution = isTvDateResolution(observedResolution)
      ? observedResolution
      : undefined;
    const dateResolution =
      recognizedResolution ?? params.dateres ?? inferDateResolution(allDates, 'tv');

    return {
      series,
      ...(dateResolution && { dateResolution }),
      normalized: params.normalize !== false,
    };
  }

  /** Retrieve TV clips (clip gallery). */
  async getTvClips(params: TvClipParams, ctx: Context): Promise<TvClip[]> {
    const urlParams = this.buildBaseParams(params.query, params.stations);
    urlParams.set('mode', 'clipgallery');
    if (params.maxRecords) urlParams.set('maxrecords', String(params.maxRecords));
    if (params.sort && params.sort !== 'relevance') {
      const sortMap = { dateDesc: 'DateDesc', dateAsc: 'DateAsc' } as const;
      urlParams.set('sort', sortMap[params.sort]);
    }
    applyTimeRange(urlParams, params.timespan, params.startDatetime, params.endDatetime);

    const raw = await this.fetch<{ clips?: RawTvClip[] }>(urlParams, ctx);
    return (raw.clips ?? []).map((c) => ({
      show: c.show,
      station: c.station,
      date: c.date,
      snippet: c.snippet,
      archiveUrl: c.preview_url,
      ...(c.preview_thumb ? { thumbnail: c.preview_thumb } : {}),
    }));
  }

  /** Fetch word cloud / co-occurring terms for TV clips matching a query. */
  async getTvContext(
    params: TvContextParams,
    ctx: Context,
  ): Promise<{
    words: TvContextWord[];
    /** Present only when the upstream API returns a clip count. */
    clipsAnalyzed?: number;
  }> {
    const urlParams = this.buildBaseParams(params.query, params.stations);
    urlParams.set('mode', 'wordcloud');
    applyTimeRange(urlParams, params.timespan, params.startDatetime, params.endDatetime);

    const raw = await this.fetch<{ wordcloud?: RawTvWord[]; numclips?: number }>(urlParams, ctx);
    const words: TvContextWord[] = (raw.wordcloud ?? []).map((w) => ({
      label: w.label,
      score: w.count,
    }));
    // Only include clipsAnalyzed when the upstream API provides a value — defaulting
    // to 0 falsely signals "zero clips analyzed" when the field is simply absent.
    return { words, ...(raw.numclips != null ? { clipsAnalyzed: raw.numclips } : {}) };
  }

  /** List all TV stations with metadata. */
  async listStations(ctx: Context): Promise<TvStation[]> {
    const urlParams = new URLSearchParams();
    urlParams.set('mode', 'stationdetails');
    urlParams.set('format', 'json');

    const raw = await this.fetch<{ station_details?: RawTvStation[] }>(urlParams, ctx);
    const now = Date.now();

    return (raw.station_details ?? []).map((s) => {
      const endMs = parseGdeltDate(s.EndDate);
      const isActive = endMs != null && now - endMs < ACTIVE_THRESHOLD_MS;
      return {
        stationId: s.StationID,
        description: s.Description,
        market: s.Market,
        network: s.Network,
        startDate: formatGdeltDate(s.StartDate),
        endDate: formatGdeltDate(s.EndDate),
        isActive,
      };
    });
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private buildBaseParams(query: string, stations?: string[]): URLSearchParams {
    const p = new URLSearchParams();
    // TV API embeds station filters inside the query string.
    // Multiple stations must be joined with OR inside parentheses — the API
    // rejects multiple standalone station: selectors joined by spaces.
    let q = query;
    if (stations?.length === 1) {
      q += ` station:${stations[0]}`;
    } else if (stations && stations.length > 1) {
      q += ` (${stations.map((s) => `station:${s}`).join(' OR ')})`;
    }
    p.set('query', q);
    p.set('format', 'json');
    return p;
  }

  private fetch<T>(params: URLSearchParams, ctx: Context): Promise<T> {
    return gdeltFetch<T>(this.baseUrl, params, ctx, 'GdeltTvService.fetch', 'GDELT TV');
  }
}

/** True when upstream metadata is one of the documented TV timeline resolutions. */
function isTvDateResolution(value: string | undefined): value is TvDateResolution {
  return (
    value === 'hour' || value === 'day' || value === 'week' || value === 'month' || value === 'year'
  );
}

/** Parse GDELT date string (YYYYMMDDHHMMSS or YYYYMMDD) to ms epoch. Returns undefined on failure. */
function parseGdeltDate(s: string): number | undefined {
  if (!s) return;
  const clean = s.replace(/\D/g, '');
  if (clean.length < 8) return;
  const year = parseInt(clean.slice(0, 4), 10);
  const month = parseInt(clean.slice(4, 6), 10) - 1;
  const day = parseInt(clean.slice(6, 8), 10);
  const d = new Date(year, month, day);
  return Number.isNaN(d.getTime()) ? undefined : d.getTime();
}

/** Convert GDELT date string to ISO 8601. Returns original on failure. */
function formatGdeltDate(s: string): string {
  if (!s) return s;
  const clean = s.replace(/\D/g, '');
  if (clean.length < 8) return s;
  return `${clean.slice(0, 4)}-${clean.slice(4, 6)}-${clean.slice(6, 8)}`;
}

// ─── Init/accessor pattern ────────────────────────────────────────────────────

let _service: GdeltTvService | undefined;

export function initGdeltTvService(
  config: AppConfig,
  storage: StorageService,
  serverConfig: ServerConfig,
): void {
  _service = new GdeltTvService(config, storage, serverConfig);
}

export function getGdeltTvService(): GdeltTvService {
  if (!_service)
    throw new Error('GdeltTvService not initialized — call initGdeltTvService() in setup()');
  return _service;
}
