/**
 * @fileoverview Service wrapping the GDELT DOC API v2. Handles article search,
 * coverage timelines, tone distribution, and language/country breakdowns.
 * @module services/gdelt/gdelt-doc-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import type { ServerConfig } from '@/config/server-config.js';
import { applyTimeRange, gdeltFetch } from './gdelt-fetch.js';
import type { Article, RawArticle, RawTimelineSeries, RawTimelineVolInfoPoint } from './types.js';

const DOC_ENDPOINT = '/doc/doc';

export type DocTimelineMode = 'timelinevol' | 'timelinevolinfo' | 'timelinetone';
export type DocBreakdownMode = 'timelinelang' | 'timelinesourcecountry';

export type DocSearchParams = {
  query: string;
  timespan?: string;
  startDatetime?: string;
  endDatetime?: string;
  maxRecords?: number;
  sort?: 'date' | 'relevance' | 'social';
};

export type DocTimelineParams = {
  query: string;
  mode: DocTimelineMode;
  timespan?: string;
  startDatetime?: string;
  endDatetime?: string;
  smoothing?: number;
};

export type DocToneParams = {
  query: string;
  timespan?: string;
  startDatetime?: string;
  endDatetime?: string;
};

export type DocBreakdownParams = {
  query: string;
  mode: DocBreakdownMode;
  timespan?: string;
  startDatetime?: string;
  endDatetime?: string;
};

export type ArticleSearchResult = {
  articles: Article[];
  totalReturned: number;
};

export type TimelineDataPoint = {
  date: string;
  value: number;
  articles?: Array<{ url: string; title: string }>;
};

export type TimelineSeries = {
  label: string;
  data: TimelineDataPoint[];
};

export type ToneHistogramBin = {
  bin: number;
  count: number;
  articles: Array<{ url: string; title: string }>;
};

export type BreakdownSeries = {
  label: string;
  data: Array<{ date: string; value: number }>;
};

export class GdeltDocService {
  private readonly baseUrl: string;

  constructor(_config: AppConfig, _storage: StorageService, serverConfig: ServerConfig) {
    this.baseUrl = serverConfig.baseUrl + DOC_ENDPOINT;
  }

  /** Search articles (artlist mode). */
  async searchArticles(params: DocSearchParams, ctx: Context): Promise<ArticleSearchResult> {
    const urlParams = this.buildBaseParams(params.query);
    urlParams.set('mode', 'artlist');
    if (params.maxRecords) urlParams.set('maxrecords', String(params.maxRecords));
    if (params.sort) urlParams.set('sort', params.sort);
    applyTimeRange(urlParams, params.timespan, params.startDatetime, params.endDatetime);

    const raw = await this.fetch<{ articles?: RawArticle[] }>(urlParams, ctx);
    const articles = (raw.articles ?? []).map(normalizeArticle);
    return { articles, totalReturned: articles.length };
  }

  /** Fetch a coverage or tone timeline. */
  async getTimeline(params: DocTimelineParams, ctx: Context): Promise<TimelineSeries[]> {
    const urlParams = this.buildBaseParams(params.query);
    urlParams.set('mode', params.mode);
    if (params.smoothing != null) urlParams.set('smoothing', String(params.smoothing));
    applyTimeRange(urlParams, params.timespan, params.startDatetime, params.endDatetime);

    if (params.mode === 'timelinevolinfo') {
      const raw = await this.fetch<{
        timeline?: Array<{ series?: string; data?: RawTimelineVolInfoPoint[] }>;
      }>(urlParams, ctx);
      return parseVolInfoTimeline(raw);
    }

    const raw = await this.fetch<{ timeline?: RawTimelineSeries[] }>(urlParams, ctx);
    return parseTimeline(raw);
  }

  /** Fetch tone distribution histogram (tonechart mode). */
  async getToneDistribution(params: DocToneParams, ctx: Context): Promise<ToneHistogramBin[]> {
    const urlParams = this.buildBaseParams(params.query);
    urlParams.set('mode', 'tonechart');
    applyTimeRange(urlParams, params.timespan, params.startDatetime, params.endDatetime);

    const raw = await this.fetch<{
      tonechart?: Array<{
        bin: number;
        count: number;
        toparts?: Array<{ url: string; title: string }>;
      }>;
    }>(urlParams, ctx);
    return (raw.tonechart ?? []).map((b) => ({
      bin: b.bin,
      count: b.count,
      articles: b.toparts ?? [],
    }));
  }

  /** Fetch language or source-country breakdown time series. */
  async getBreakdown(params: DocBreakdownParams, ctx: Context): Promise<BreakdownSeries[]> {
    const urlParams = this.buildBaseParams(params.query);
    urlParams.set('mode', params.mode);
    applyTimeRange(urlParams, params.timespan, params.startDatetime, params.endDatetime);

    const raw = await this.fetch<{ timeline?: RawTimelineSeries[] }>(urlParams, ctx);
    return parseTimeline(raw).map((s) => ({
      label: s.label,
      data: s.data.map((d) => ({ date: d.date, value: d.value })),
    }));
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private buildBaseParams(query: string): URLSearchParams {
    const p = new URLSearchParams();
    p.set('query', query);
    p.set('format', 'json');
    return p;
  }

  private fetch<T>(params: URLSearchParams, ctx: Context): Promise<T> {
    return gdeltFetch<T>(this.baseUrl, params, ctx, 'GdeltDocService.fetch', 'GDELT DOC');
  }
}

// ─── Normalizers ─────────────────────────────────────────────────────────────

function normalizeArticle(raw: RawArticle): Article {
  return {
    url: raw.url,
    title: raw.title,
    seendate: raw.seendate,
    domain: raw.domain,
    language: raw.language,
    sourcecountry: raw.sourcecountry,
    ...(raw.socialimage ? { socialimage: raw.socialimage } : {}),
  };
}

function parseTimeline(raw: { timeline?: RawTimelineSeries[] }): TimelineSeries[] {
  return (raw.timeline ?? []).map((s) => ({
    label: s.series ?? 'Series',
    data: (s.data ?? []).map((d) => ({ date: d.date, value: d.value })),
  }));
}

function parseVolInfoTimeline(raw: {
  timeline?: Array<{ series?: string; data?: RawTimelineVolInfoPoint[] }>;
}): TimelineSeries[] {
  return (raw.timeline ?? []).map((s) => ({
    label: s.series ?? 'Volume Intensity',
    data: (s.data ?? []).map((d) => ({
      date: d.date,
      value: d.value,
      ...(d.toparts?.length
        ? {
            articles: d.toparts.map((a) => ({ url: a.url, title: a.title })),
          }
        : {}),
    })),
  }));
}

// ─── Init/accessor pattern ────────────────────────────────────────────────────

let _service: GdeltDocService | undefined;

export function initGdeltDocService(
  config: AppConfig,
  storage: StorageService,
  serverConfig: ServerConfig,
): void {
  _service = new GdeltDocService(config, storage, serverConfig);
}

export function getGdeltDocService(): GdeltDocService {
  if (!_service)
    throw new Error('GdeltDocService not initialized — call initGdeltDocService() in setup()');
  return _service;
}
