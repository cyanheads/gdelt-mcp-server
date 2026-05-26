/**
 * @fileoverview Service wrapping the GDELT TV API v2. Handles TV news transcript search,
 * clip retrieval, context/word cloud, trending topics, and station metadata.
 * @module services/gdelt/gdelt-tv-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import type { ServerConfig } from '@/config/server-config.js';
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
};

export type TvSearchSeries = {
  station: string;
  data: Array<{ date: string; value: number }>;
};

export type TvContextWord = {
  label: string;
  score: number;
};

export type TvTrendingTopic = {
  label: string;
  score: number;
};

export class GdeltTvService {
  private readonly baseUrl: string;

  constructor(_config: AppConfig, _storage: StorageService, serverConfig: ServerConfig) {
    this.baseUrl = serverConfig.baseUrl + TV_ENDPOINT;
  }

  /** Search TV coverage — returns per-station normalized time series. */
  async searchTv(
    params: TvSearchParams,
    ctx: Context,
  ): Promise<{
    series: TvSearchSeries[];
    dateResolution: 'hour' | 'day' | 'month';
    timeRange: { start: string; end: string };
    normalized: boolean;
  }> {
    const urlParams = this.buildBaseParams(params.query, params.stations);
    urlParams.set('mode', params.normalize !== false ? 'timelinenorm' : 'timeline');
    if (params.smoothing != null) urlParams.set('smoothing', String(params.smoothing));
    applyTimeRange(urlParams, params.timespan, params.startDatetime, params.endDatetime);

    const raw = await this.fetch<{
      timeline?: Array<{ series: string; data?: Array<{ date: string; value: number }> }>;
      dateresolution?: string;
    }>(urlParams, ctx);

    const series: TvSearchSeries[] = (raw.timeline ?? []).map((s) => ({
      station: s.series ?? 'Unknown',
      data: (s.data ?? []).map((d) => ({ date: d.date, value: d.value })),
    }));

    const allDates = series.flatMap((s) => s.data.map((d) => d.date));
    const sorted = allDates.slice().sort();
    const timeRange = {
      start: sorted[0] ?? '',
      end: sorted[sorted.length - 1] ?? '',
    };

    const resStr = raw.dateresolution ?? 'day';
    const dateResolution: 'hour' | 'day' | 'month' =
      resStr === 'hour' ? 'hour' : resStr === 'month' ? 'month' : 'day';

    return { series, dateResolution, timeRange, normalized: params.normalize !== false };
  }

  /** Retrieve TV clips (clip gallery). */
  async getTvClips(params: TvClipParams, ctx: Context): Promise<TvClip[]> {
    const urlParams = this.buildBaseParams(params.query, params.stations);
    urlParams.set('mode', 'clipgallery');
    if (params.maxRecords) urlParams.set('maxrecords', String(params.maxRecords));
    if (params.sort) {
      const sortMap = { relevance: 'relevance', dateDesc: 'date', dateAsc: 'date' } as const;
      urlParams.set('sort', sortMap[params.sort]);
      if (params.sort === 'dateAsc') urlParams.set('sortdir', 'asc');
    }
    applyTimeRange(urlParams, params.timespan, params.startDatetime, params.endDatetime);

    const raw = await this.fetch<{ clips?: RawTvClip[] }>(urlParams, ctx);
    return (raw.clips ?? []).map((c) => ({
      show: c.show,
      station: c.station,
      date: c.date,
      snippet: c.snippet,
      archiveUrl: c.preview_url,
      ...(c.thumbnail_url ? { thumbnail: c.thumbnail_url } : {}),
    }));
  }

  /** Fetch word cloud / co-occurring terms for TV clips matching a query. */
  async getTvContext(
    params: TvContextParams,
    ctx: Context,
  ): Promise<{
    words: TvContextWord[];
    clipsAnalyzed: number;
  }> {
    const urlParams = this.buildBaseParams(params.query, params.stations);
    urlParams.set('mode', 'wordcloud');
    if (params.timespan) urlParams.set('timespan', params.timespan);

    const raw = await this.fetch<{ wordcloud?: RawTvWord[]; numclips?: number }>(urlParams, ctx);
    const words: TvContextWord[] = (raw.wordcloud ?? []).map((w) => ({
      label: w.Label,
      score: w.Score,
    }));
    return { words, clipsAnalyzed: raw.numclips ?? 0 };
  }

  /** Fetch currently trending topics on TV news. */
  async getTvTrending(ctx: Context): Promise<TvTrendingTopic[]> {
    const urlParams = new URLSearchParams();
    urlParams.set('mode', 'trendingtopics');
    urlParams.set('format', 'json');

    const raw = await this.fetch<{ topics?: Array<{ label: string; score: number }> }>(
      urlParams,
      ctx,
    );
    return (raw.topics ?? []).map((t) => ({ label: t.label, score: t.score }));
  }

  /** List all TV stations with metadata. */
  async listStations(ctx: Context): Promise<TvStation[]> {
    const urlParams = new URLSearchParams();
    urlParams.set('mode', 'stationdetails');
    urlParams.set('format', 'json');

    const raw = await this.fetch<{ stations?: RawTvStation[] }>(urlParams, ctx);
    const now = Date.now();

    return (raw.stations ?? []).map((s) => {
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
    // TV API embeds station filters inside the query string
    let q = query;
    if (stations?.length) {
      q += ' ' + stations.map((s) => `station:${s}`).join(' ');
    }
    p.set('query', q);
    p.set('format', 'json');
    return p;
  }

  private fetch<T>(params: URLSearchParams, ctx: Context): Promise<T> {
    return gdeltFetch<T>(this.baseUrl, params, ctx, 'GdeltTvService.fetch', 'GDELT TV');
  }
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
