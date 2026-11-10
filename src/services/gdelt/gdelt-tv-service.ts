/**
 * @fileoverview Service wrapping the GDELT TV API v2. Handles TV news transcript search,
 * clip retrieval, context/word cloud, and station metadata — including resolving the display
 * labels GDELT puts on timeline series and clips to the station IDs its queries take, and the
 * stations' monitoring ranges, from one process-wide catalog load.
 * @module services/gdelt/gdelt-tv-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { requestCancelled, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import type { ServerConfig } from '@/config/server-config.js';
import {
  inferDateResolution,
  normalizeGdeltDate,
  type TvDateResolution,
} from './date-resolution.js';
import {
  applyTimeRange,
  GDELT_CALL_DEADLINE_MULTIPLIER,
  GDELT_FALLBACK_BUDGET_MS,
  type GdeltFetchOptions,
  gdeltFetch,
} from './gdelt-fetch.js';
import type {
  RawTvClip,
  RawTvShowChartRow,
  RawTvStation,
  RawTvStationChartRow,
  RawTvWord,
  TvBreakdownRow,
  TvBreakdownValueUnit,
  TvClip,
  TvStation,
} from './types.js';

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
  combined?: boolean;
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

/** Rank matching TV coverage by station or show over one query window. */
export type TvBreakdownParams = TvContextParams & {
  breakdownBy: 'station' | 'show';
  normalize?: boolean;
};

export type TvSearchSeries = {
  /** Catalog station ID. Absent when the label did not resolve to one. */
  station?: string;
  /** GDELT's display label for the station — its catalog description. Empty when GDELT sent none. */
  stationName: string;
  data: Array<{ date: string; value: number }>;
};

export type TvContextWord = {
  label: string;
  score: number;
};

/** Station IDs keyed by the display label GDELT puts on timeline series and clips. */
type StationIdsByLabel = ReadonlyMap<string, string>;

/**
 * A catalog station's ID, monitoring dates (`YYYY-MM-DD`, as {@link TvStation} carries them), and
 * whether it was active when the catalog was read. An active station's end date moves on every day
 * while the process keeps the one it read, so for it `endDate` is only where coverage had reached.
 */
export type TvStationRange = Pick<TvStation, 'stationId' | 'startDate' | 'endDate' | 'isActive'>;

/** Catalog stations' monitoring ranges keyed by uppercase station ID — GDELT matches IDs in any case. */
export type StationRanges = ReadonlyMap<string, TvStationRange>;

/** The station catalog as one load yields it: IDs by display label, and ranges by ID. */
type StationCatalog = {
  readonly idsByLabel: StationIdsByLabel;
  readonly rangesById: StationRanges;
};

/** A station-catalog load in flight, shared by every call awaiting it. */
type CatalogLoad = {
  readonly catalog: Promise<StationCatalog>;
  /** Keep the load running until at least `waitUntil`, when a joining call waits that long. */
  readonly waitUntil: (waitUntil: number) => void;
};

export class GdeltTvService {
  private readonly baseUrl: string;
  /**
   * How long a call waits for the station catalog, from its start: {@link GDELT_FALLBACK_BUDGET_MS},
   * since the catalog only labels an answer the call already has, or the whole call's deadline
   * when that is shorter.
   */
  private readonly catalogWaitMs: number;
  /** The station catalog, once a load has landed. Kept for the process. */
  private catalog: StationCatalog | undefined;
  /** The one catalog load in flight. Cleared when it settles or is abandoned. */
  private catalogLoad: CatalogLoad | undefined;

  constructor(_config: AppConfig, _storage: StorageService, serverConfig: ServerConfig) {
    this.baseUrl = serverConfig.baseUrl + TV_ENDPOINT;
    this.catalogWaitMs = Math.min(
      GDELT_FALLBACK_BUDGET_MS,
      serverConfig.requestTimeoutMs * GDELT_CALL_DEADLINE_MULTIPLIER,
    );
  }

  /**
   * Search TV coverage — returns per-station normalized time series, each labeled with its
   * station ID and GDELT's display label (see {@link stationIdsFor}). `dateResolution` is
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
    /** Set when the station catalog was unavailable, so no series carries a station ID. */
    stationCatalogUnavailable?: true;
  }> {
    const catalogWaitUntil = Date.now() + this.catalogWaitMs;
    const urlParams = this.buildBaseParams(params.query, params.stations);
    urlParams.set('mode', 'timelinevol');
    urlParams.set('datanorm', params.normalize !== false ? 'perc' : 'raw');
    if (params.combined) urlParams.set('datacomb', 'combined');
    if (params.smoothing != null) urlParams.set('timelinesmooth', String(params.smoothing));
    if (params.dateres) urlParams.set('dateres', params.dateres);
    applyTimeRange(urlParams, params.timespan, params.startDatetime, params.endDatetime);

    const raw = await this.fetch<{
      timeline?: Array<{ series?: string; data?: Array<{ date: string; value: number }> }>;
      query_details?: { date_resolution?: string };
    }>(urlParams, ctx);

    const timeline = (raw.timeline ?? []).map((s) => ({ ...s, label: s.series ?? '' }));
    const ids = params.combined
      ? new Map<string, string>()
      : await this.stationIdsFor(
          timeline.map((s) => s.label),
          ctx,
          catalogWaitUntil,
        );
    const series: TvSearchSeries[] = timeline.map((s) => ({
      ...withStationId(s.label, ids),
      data: (s.data ?? []).map((d) => ({ date: normalizeGdeltDate(d.date), value: d.value })),
    }));

    const allDates = series.flatMap((s) => s.data.map((d) => d.date));

    const observedResolution = raw.query_details?.date_resolution?.toLowerCase();
    const recognizedResolution = isTvDateResolution(observedResolution)
      ? observedResolution
      : undefined;
    const dateResolution =
      recognizedResolution ?? params.dateres ?? inferDateResolution(allDates, 'tv');

    return {
      series,
      ...(dateResolution && { dateResolution }),
      normalized: params.normalize !== false,
      ...(ids === undefined && { stationCatalogUnavailable: true as const }),
    };
  }

  /** Retrieve TV clips (clip gallery), each labeled like {@link searchTv}'s series. */
  async getTvClips(
    params: TvClipParams,
    ctx: Context,
  ): Promise<{
    clips: TvClip[];
    /** Set when the station catalog was unavailable, so no clip carries a station ID. */
    stationCatalogUnavailable?: true;
  }> {
    const catalogWaitUntil = Date.now() + this.catalogWaitMs;
    const urlParams = this.buildBaseParams(params.query, params.stations);
    urlParams.set('mode', 'clipgallery');
    if (params.maxRecords) urlParams.set('maxrecords', String(params.maxRecords));
    if (params.sort && params.sort !== 'relevance') {
      const sortMap = { dateDesc: 'DateDesc', dateAsc: 'DateAsc' } as const;
      urlParams.set('sort', sortMap[params.sort]);
    }
    applyTimeRange(urlParams, params.timespan, params.startDatetime, params.endDatetime);

    const raw = await this.fetch<{ clips?: RawTvClip[] }>(urlParams, ctx);
    const rawClips = raw.clips ?? [];
    const ids = await this.stationIdsFor(
      rawClips.map((c) => c.station ?? ''),
      ctx,
      catalogWaitUntil,
    );
    const clips = rawClips.map((c) => ({
      show: c.show,
      ...withStationId(c.station ?? '', ids),
      date: c.date,
      snippet: c.snippet,
      archiveUrl: c.preview_url,
      ...(c.preview_thumb ? { thumbnail: c.preview_thumb } : {}),
    }));
    return { clips, ...(ids === undefined && { stationCatalogUnavailable: true as const }) };
  }

  /** Fetch word cloud / co-occurring terms for TV clips matching a query. */
  async getTvContext(
    params: TvContextParams,
    ctx: Context,
  ): Promise<{
    words: TvContextWord[];
  }> {
    const urlParams = this.buildBaseParams(params.query, params.stations);
    urlParams.set('mode', 'wordcloud');
    applyTimeRange(urlParams, params.timespan, params.startDatetime, params.endDatetime);

    const raw = await this.fetch<{ wordcloud?: RawTvWord[] }>(urlParams, ctx);
    const words: TvContextWord[] = (raw.wordcloud ?? []).map((w) => ({
      label: w.label,
      score: w.count,
    }));
    return { words };
  }

  /** Fetch complete provider rankings; show values remain percentages even with normalize=false. */
  async getTvBreakdown(
    params: TvBreakdownParams,
    ctx: Context,
  ): Promise<{
    rows: TvBreakdownRow[];
    valueUnit: TvBreakdownValueUnit;
    stationCatalogUnavailable?: true;
  }> {
    const catalogWaitUntil = Date.now() + this.catalogWaitMs;
    const urlParams = this.buildBaseParams(params.query, params.stations);
    urlParams.set('mode', params.breakdownBy === 'station' ? 'stationchart' : 'showchart');
    urlParams.set('datanorm', params.normalize !== false ? 'perc' : 'raw');
    applyTimeRange(urlParams, params.timespan, params.startDatetime, params.endDatetime);
    const raw = await this.fetch<{
      stationchart?: RawTvStationChartRow[];
      showchart?: RawTvShowChartRow[];
    }>(urlParams, ctx);
    if (params.breakdownBy === 'show') {
      return {
        rows: (raw.showchart ?? []).map((row) => ({ label: row.show, value: row.count })),
        valueUnit: 'percent_matching_clips',
      };
    }
    const chart = raw.stationchart ?? [];
    const ids = await this.stationIdsFor(
      chart.map((row) => row.station),
      ctx,
      catalogWaitUntil,
    );
    return {
      rows: chart.map((row) => {
        const station = ids?.get(row.station);
        return { label: row.station, value: row.count, ...(station !== undefined && { station }) };
      }),
      valueUnit: params.normalize !== false ? 'percent_station_airtime' : 'matching_clips',
      ...(ids === undefined && { stationCatalogUnavailable: true as const }),
    };
  }

  /**
   * List all TV stations with metadata. `fetchOptions` reaches {@link gdeltFetch} — the
   * station-ID lookup asks for a single attempt and a fresh answer only.
   */
  async listStations(ctx: Context, fetchOptions: GdeltFetchOptions = {}): Promise<TvStation[]> {
    const urlParams = new URLSearchParams();
    urlParams.set('mode', 'stationdetails');
    urlParams.set('format', 'json');

    const raw = await this.fetch<{ station_details?: RawTvStation[] }>(
      urlParams,
      ctx,
      fetchOptions,
    );
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

  /**
   * Every catalog station's monitoring range keyed by uppercase ID, or `undefined` when the
   * catalog is unavailable to this call — for an empty answer, to name the selected stations its
   * window misses. The same process-wide load station IDs resolve from, under the same rules (see
   * {@link catalogFor}): no request once a load has landed, one load in flight, a failed one not
   * kept. The wait ends {@link catalogWaitMs} after `callStartedAt`, the epoch-ms start of the
   * tool call, as it does for station IDs.
   */
  async stationRanges(ctx: Context, callStartedAt: number): Promise<StationRanges | undefined> {
    return (await this.catalogFor(ctx, callStartedAt + this.catalogWaitMs))?.rangesById;
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  /**
   * Station IDs for a call's labels, or `undefined` when the catalog is unavailable to this
   * call. GDELT labels timeline series and clips with a station's catalog description
   * ("FOX News"), never the ID its `station:` operator takes ("FOXNEWS"), so each label is
   * matched exactly against the `stationdetails` catalog — after the call's own request, and
   * only when there is a label to resolve. An empty label — a row GDELT sent without one — has
   * nothing to resolve.
   */
  private async stationIdsFor(
    labels: readonly string[],
    ctx: Context,
    waitUntil: number,
  ): Promise<StationIdsByLabel | undefined> {
    if (!labels.some(Boolean)) return new Map();
    return (await this.catalogFor(ctx, waitUntil))?.idsByLabel;
  }

  /**
   * The station catalog for a call, or `undefined` when it is unavailable to this call. Loaded
   * once per process (see {@link loadCatalog}).
   *
   * The catalog is a side lookup and never fails the call: a failed or empty load, or one still
   * running at `waitUntil`, yields `undefined`. Only the caller's own cancellation fails the call —
   * as cancelled. `waitUntil` is counted from the start of the call (see
   * {@link GDELT_FALLBACK_BUDGET_MS}), so the lookup cannot hold an answer past it; a call that
   * has already spent it, or is already cancelled, starts no load.
   */
  private async catalogFor(ctx: Context, waitUntil: number): Promise<StationCatalog | undefined> {
    if (this.catalog) return this.catalog;
    const cancelled = () =>
      requestCancelled('Request cancelled while loading the station catalog.');
    if (ctx.signal.aborted) throw cancelled();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const remainingMs = waitUntil - Date.now();
      if (remainingMs <= 0) throw new Error('the call wait budget was spent before the lookup');
      return await Promise.race([
        this.loadCatalog(ctx, waitUntil),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('station catalog did not load within the call wait budget')),
            remainingMs,
          );
        }),
        new Promise<never>((_, reject) => {
          onAbort = () => reject(cancelled());
          // Starting the load can itself run past a cancellation, before this listener exists.
          if (ctx.signal.aborted) onAbort();
          else ctx.signal.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      ctx.log.warning('GDELT TV station catalog unavailable; answering without it', {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    } finally {
      clearTimeout(timer);
      if (onAbort) ctx.signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * The catalog load: the one in flight, or a new one when there is none. Concurrent first calls
   * share the one load, which runs until the latest `waitUntil` among them. A load still running
   * then is abandoned: its request is aborted, which frees the one GDELT request slot it holds for
   * whatever is queued behind it, and it counts as failed — nothing is kept even if an answer
   * arrives, and the next call loads again.
   */
  private loadCatalog(ctx: Context, waitUntil: number): Promise<StationCatalog> {
    if (this.catalogLoad) {
      this.catalogLoad.waitUntil(waitUntil);
      return this.catalogLoad.catalog;
    }
    const controller = new AbortController();
    let abandonAt = waitUntil;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const scheduleAbandon = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => {
          this.catalogLoad = undefined;
          controller.abort(new Error('No call is still waiting for the station catalog.'));
        },
        Math.max(0, abandonAt - Date.now()),
      );
    };
    const load: CatalogLoad = {
      catalog: this.fetchCatalog(ctx, controller.signal).then(
        (catalog) => {
          clearTimeout(timer);
          if (this.catalogLoad === load) {
            this.catalog = catalog;
            this.catalogLoad = undefined;
          }
          return catalog;
        },
        (error: unknown) => {
          clearTimeout(timer);
          if (this.catalogLoad === load) this.catalogLoad = undefined;
          throw error;
        },
      ),
      waitUntil: (until) => {
        if (until <= abandonAt) return;
        abandonAt = until;
        scheduleAbandon();
      },
    };
    this.catalogLoad = load;
    scheduleAbandon();
    return load.catalog;
  }

  /**
   * Fetch the catalog under the load's own signal rather than the caller's, so the call that
   * happens to start the shared load can be cancelled without failing the others awaiting it.
   * One attempt, never the retry ladder: a failure costs this call its IDs, not its answer, and
   * the next call loads again. Fresh stored answers only: the load runs on the first caller's
   * `ctx`, where a stale serve would mark that caller's own fresh answer as stale. An empty
   * catalog is GDELT failing, not an answer. The entries are GDELT's, unvalidated: one without a
   * string ID ranges no station and costs the others nothing.
   */
  private async fetchCatalog(ctx: Context, signal: AbortSignal): Promise<StationCatalog> {
    const stations = await this.listStations(
      { ...ctx, signal },
      { maxRetries: 0, freshOnly: true },
    );
    if (stations.length === 0) {
      throw serviceUnavailable('GDELT TV station catalog came back empty.');
    }
    return {
      idsByLabel: new Map(stations.map((s) => [s.description, s.stationId])),
      rangesById: new Map(
        stations.flatMap(
          ({ stationId, startDate, endDate, isActive }): [string, TvStationRange][] =>
            typeof stationId === 'string'
              ? [[stationId.toUpperCase(), { stationId, startDate, endDate, isActive }]]
              : [],
        ),
      ),
    };
  }

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

  private fetch<T>(
    params: URLSearchParams,
    ctx: Context,
    options: GdeltFetchOptions = {},
  ): Promise<T> {
    return gdeltFetch<T>(this.baseUrl, params, ctx, 'GdeltTvService.fetch', 'GDELT TV', options);
  }
}

/** A row's `stationName` (GDELT's label) and, when the catalog resolved it, its `station` ID. */
function withStationId(
  label: string,
  ids: StationIdsByLabel | undefined,
): { station?: string; stationName: string } {
  const station = ids?.get(label);
  return { ...(station !== undefined && { station }), stationName: label };
}

/** True when upstream metadata is one of the documented TV timeline resolutions. */
function isTvDateResolution(value: string | undefined): value is TvDateResolution {
  return (
    value === 'hour' || value === 'day' || value === 'week' || value === 'month' || value === 'year'
  );
}

/** Parse a GDELT date string (YYYYMMDDHHMMSS or YYYYMMDD) to the ms epoch of its UTC day. Returns undefined on failure. */
function parseGdeltDate(s: string): number | undefined {
  if (!s) return;
  const clean = s.replace(/\D/g, '');
  if (clean.length < 8) return;
  const year = parseInt(clean.slice(0, 4), 10);
  const month = parseInt(clean.slice(4, 6), 10) - 1;
  const day = parseInt(clean.slice(6, 8), 10);
  const ms = Date.UTC(year, month, day);
  return Number.isNaN(ms) ? undefined : ms;
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
