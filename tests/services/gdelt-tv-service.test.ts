/**
 * @fileoverview Tests for GdeltTvService normalizers and helpers: parseGdeltDate,
 * formatGdeltDate (via listStations), buildBaseParams (station filter embedding),
 * and clip/context/timeline parsing.
 * @module tests/services/gdelt-tv-service.test
 */

import { readFileSync } from 'node:fs';
import { JsonRpcErrorCode, rateLimited, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GdeltDocService } from '@/services/gdelt/gdelt-doc-service.js';
import * as gdeltFetchModule from '@/services/gdelt/gdelt-fetch.js';
import { disposeGdeltPacer, initGdeltPacer } from '@/services/gdelt/gdelt-pacer.js';
import { GdeltTvService } from '@/services/gdelt/gdelt-tv-service.js';
import type { RawTvStation, TvStation } from '@/services/gdelt/types.js';

const MOCK_CONFIG = {} as ConstructorParameters<typeof GdeltTvService>[0];
const MOCK_STORAGE = {} as ConstructorParameters<typeof GdeltTvService>[1];
const MOCK_SERVER_CONFIG = {
  baseUrl: 'https://api.gdeltproject.org',
  requestTimeoutMs: 60_000,
} as ConstructorParameters<typeof GdeltTvService>[2];

function makeService(requestTimeoutMs = MOCK_SERVER_CONFIG.requestTimeoutMs): GdeltTvService {
  return new GdeltTvService(MOCK_CONFIG, MOCK_STORAGE, { ...MOCK_SERVER_CONFIG, requestTimeoutMs });
}

/** The live 159-station catalog (captured 2026-09-24), back in the raw `stationdetails` shape. */
const CATALOG = {
  station_details: (
    JSON.parse(
      readFileSync(new URL('../fixtures/tv-station-catalog.json', import.meta.url), 'utf8'),
    ) as { stations: TvStation[] }
  ).stations.map(
    (s): RawTvStation => ({
      StationID: s.stationId,
      Description: s.description,
      Market: s.market,
      Network: s.network,
      StartDate: s.startDate.replaceAll('-', ''),
      EndDate: s.endDate.replaceAll('-', ''),
    }),
  ),
};

const isCatalogRequest = (params: URLSearchParams) => params.get('mode') === 'stationdetails';

/**
 * Every test starts with the catalog request answered from the fixture and any other request
 * refused, so a test's own `mockResolvedValueOnce` answers its main request and the station
 * lookup after it still resolves.
 */
beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(gdeltFetchModule, 'gdeltFetch').mockImplementation((_url, params) =>
    isCatalogRequest(params)
      ? Promise.resolve(CATALOG)
      : Promise.reject(new Error('unexpected GDELT request')),
  );
});

describe('GdeltTvService.listStations', () => {
  it('normalizes station fields and formats dates to ISO', async () => {
    const raw = {
      station_details: [
        {
          StationID: 'CNN',
          Description: 'CNN',
          Market: 'National',
          Network: 'CNN',
          StartDate: '20090702',
          EndDate: '20241031',
        },
      ],
    };
    vi.spyOn(gdeltFetchModule, 'gdeltFetch').mockResolvedValueOnce(raw);
    const ctx = createMockContext();
    const svc = makeService();
    const stations = await svc.listStations(ctx);
    expect(stations[0]?.stationId).toBe('CNN');
    expect(stations[0]?.startDate).toBe('2009-07-02');
    expect(stations[0]?.endDate).toBe('2024-10-31');
  });

  it('marks station as inactive when endDate is far in the past', async () => {
    const raw = {
      station_details: [
        {
          StationID: 'OLD',
          Description: 'Old Station',
          Market: 'Local',
          Network: 'ABC',
          StartDate: '20100101',
          // far past date — definitely not active
          EndDate: '20200101',
        },
      ],
    };
    vi.spyOn(gdeltFetchModule, 'gdeltFetch').mockResolvedValueOnce(raw);
    const ctx = createMockContext();
    const svc = makeService();
    const stations = await svc.listStations(ctx);
    expect(stations[0]?.isActive).toBe(false);
  });

  it('returns empty array when station_details key is absent', async () => {
    vi.spyOn(gdeltFetchModule, 'gdeltFetch').mockResolvedValueOnce({});
    const ctx = createMockContext();
    const svc = makeService();
    const stations = await svc.listStations(ctx);
    expect(stations).toEqual([]);
  });

  it('handles malformed EndDate without throwing', async () => {
    const raw = {
      station_details: [
        {
          StationID: 'BAD',
          Description: 'Malformed',
          Market: 'Local',
          Network: 'NBC',
          StartDate: '',
          EndDate: 'invalid-date',
        },
      ],
    };
    vi.spyOn(gdeltFetchModule, 'gdeltFetch').mockResolvedValueOnce(raw);
    const ctx = createMockContext();
    const svc = makeService();
    const stations = await svc.listStations(ctx);
    // Should not throw — isActive defaults to false when date parsing fails
    expect(stations[0]?.isActive).toBe(false);
  });
});

describe('GdeltTvService.getTvClips', () => {
  it('maps clip fields from raw to normalized shape', async () => {
    const raw = {
      clips: [
        {
          show: 'Anderson Cooper 360',
          station: 'CNN',
          date: '2024-01-15T20:00:00Z',
          snippet: 'Coverage snippet…',
          preview_url: 'https://archive.org/details/CNN_20240115',
          preview_thumb: 'https://archive.org/thumb.jpg',
        },
      ],
    };
    vi.spyOn(gdeltFetchModule, 'gdeltFetch').mockResolvedValueOnce(raw);
    const ctx = createMockContext();
    const svc = makeService();
    const { clips } = await svc.getTvClips({ query: 'test' }, ctx);
    expect(clips[0]?.archiveUrl).toBe('https://archive.org/details/CNN_20240115');
    expect(clips[0]?.thumbnail).toBe('https://archive.org/thumb.jpg');
  });

  it('omits thumbnail when preview_thumb is absent', async () => {
    const raw = {
      clips: [
        {
          show: 'Test Show',
          station: 'MSNBC',
          date: '2024-01-15T20:00:00Z',
          snippet: 'Text',
          preview_url: 'https://archive.org/details/MSNBC_20240115',
        },
      ],
    };
    vi.spyOn(gdeltFetchModule, 'gdeltFetch').mockResolvedValueOnce(raw);
    const ctx = createMockContext();
    const svc = makeService();
    const { clips } = await svc.getTvClips({ query: 'test' }, ctx);
    expect(clips[0]).not.toHaveProperty('thumbnail');
  });

  it('embeds a single station filter directly into the query string', async () => {
    let capturedParams: URLSearchParams | undefined;
    vi.spyOn(gdeltFetchModule, 'gdeltFetch').mockImplementationOnce(
      (_baseUrl, params, _ctx, _op, _label) => {
        capturedParams = params;
        return Promise.resolve({ clips: [] });
      },
    );
    const ctx = createMockContext();
    const svc = makeService();
    await svc.getTvClips({ query: 'vaccine', stations: ['CNN'] }, ctx);
    const q = capturedParams?.get('query') ?? '';
    expect(q).toBe('vaccine station:CNN');
  });

  it('joins multiple station filters with OR in parentheses', async () => {
    let capturedParams: URLSearchParams | undefined;
    vi.spyOn(gdeltFetchModule, 'gdeltFetch').mockImplementationOnce(
      (_baseUrl, params, _ctx, _op, _label) => {
        capturedParams = params;
        return Promise.resolve({ clips: [] });
      },
    );
    const ctx = createMockContext();
    const svc = makeService();
    await svc.getTvClips({ query: 'vaccine', stations: ['CNN', 'FOXNEWS'] }, ctx);
    const q = capturedParams?.get('query') ?? '';
    expect(q).toBe('vaccine (station:CNN OR station:FOXNEWS)');
  });

  it('returns empty array when clips key is absent', async () => {
    vi.spyOn(gdeltFetchModule, 'gdeltFetch').mockResolvedValueOnce({});
    const ctx = createMockContext();
    const svc = makeService();
    const { clips } = await svc.getTvClips({ query: 'test' }, ctx);
    expect(clips).toEqual([]);
  });

  it.each([
    ['dateDesc', 'DateDesc'],
    ['dateAsc', 'DateAsc'],
  ] as const)('maps public %s sorting to GDELT %s', async (sort, expected) => {
    let capturedParams: URLSearchParams | undefined;
    vi.spyOn(gdeltFetchModule, 'gdeltFetch').mockImplementationOnce((_url, params) => {
      capturedParams = params;
      return Promise.resolve({ clips: [] });
    });
    await makeService().getTvClips({ query: 'test', sort }, createMockContext());
    expect(capturedParams?.get('sort')).toBe(expected);
    expect(capturedParams?.has('sortdir')).toBe(false);
  });

  it('omits SORT for the documented relevance default', async () => {
    let capturedParams: URLSearchParams | undefined;
    vi.spyOn(gdeltFetchModule, 'gdeltFetch').mockImplementationOnce((_url, params) => {
      capturedParams = params;
      return Promise.resolve({ clips: [] });
    });
    await makeService().getTvClips({ query: 'test', sort: 'relevance' }, createMockContext());
    expect(capturedParams?.has('sort')).toBe(false);
  });
});

describe('GdeltTvService.getTvContext', () => {
  it('maps wordcloud entries to TvContextWord shape', async () => {
    const raw = {
      wordcloud: [
        { label: 'vaccine', count: 120 },
        { label: 'health', count: 80 },
      ],
      numclips: 42,
    };
    vi.spyOn(gdeltFetchModule, 'gdeltFetch').mockResolvedValueOnce(raw);
    const ctx = createMockContext();
    const svc = makeService();
    const result = await svc.getTvContext({ query: 'test' }, ctx);
    expect(result.words[0]?.label).toBe('vaccine');
    expect(result.words[0]?.score).toBe(120);
    expect(result.clipsAnalyzed).toBe(42);
  });

  it('omits clipsAnalyzed when numclips is absent from the upstream response', async () => {
    vi.spyOn(gdeltFetchModule, 'gdeltFetch').mockResolvedValueOnce({ wordcloud: [] });
    const ctx = createMockContext();
    const svc = makeService();
    const result = await svc.getTvContext({ query: 'test' }, ctx);
    expect(result.clipsAnalyzed).toBeUndefined();
  });

  it('returns empty words array when wordcloud key is absent', async () => {
    vi.spyOn(gdeltFetchModule, 'gdeltFetch').mockResolvedValueOnce({});
    const ctx = createMockContext();
    const svc = makeService();
    const result = await svc.getTvContext({ query: 'test' }, ctx);
    expect(result.words).toEqual([]);
  });
});

describe('GdeltTvService.searchTv', () => {
  it('maps timeline series to TvSearchSeries shape', async () => {
    const raw = {
      timeline: [
        {
          series: 'CNN',
          data: [
            { date: '2024-01-01', value: 0.5 },
            { date: '2024-01-02', value: 0.8 },
          ],
        },
      ],
      dateresolution: 'day',
    };
    vi.spyOn(gdeltFetchModule, 'gdeltFetch').mockResolvedValueOnce(raw);
    const ctx = createMockContext();
    const svc = makeService();
    const result = await svc.searchTv({ query: 'vaccine' }, ctx);
    expect(result.series[0]?.station).toBe('CNN');
    expect(result.dateResolution).toBe('day');
    expect(result.normalized).toBe(true);
  });

  /** gdelt_search_tv derives its time range from the returned page, so the service carries none. */
  it('returns only series, resolution, and normalization — no time range', async () => {
    const raw = {
      timeline: [
        {
          series: 'CNN',
          data: [
            { date: '2024-01-03', value: 1.0 },
            { date: '2024-01-01', value: 0.5 },
          ],
        },
      ],
    };
    vi.spyOn(gdeltFetchModule, 'gdeltFetch').mockResolvedValueOnce(raw);
    const result = await makeService().searchTv({ query: 'test' }, createMockContext());
    expect(Object.keys(result).sort()).toEqual(['dateResolution', 'normalized', 'series']);
  });

  it('omits dateResolution when metadata is absent and one point gives no interval', async () => {
    const raw = {
      timeline: [{ series: 'CNN', data: [{ date: '2024-01-01', value: 1.0 }] }],
    };
    vi.spyOn(gdeltFetchModule, 'gdeltFetch').mockResolvedValueOnce(raw);
    const ctx = createMockContext();
    const svc = makeService();
    const result = await svc.searchTv({ query: 'test' }, ctx);
    expect(result).not.toHaveProperty('dateResolution');
  });

  it('derives nothing from a `{}` zero-match answer', async () => {
    vi.spyOn(gdeltFetchModule, 'gdeltFetch').mockResolvedValueOnce({});
    const result = await makeService().searchTv({ query: 'test' }, createMockContext());
    expect(result).toEqual({ series: [], normalized: true });
  });

  it('keeps a caller-pinned dateres on a `{}` zero-match answer', async () => {
    vi.spyOn(gdeltFetchModule, 'gdeltFetch').mockResolvedValueOnce({});
    const result = await makeService().searchTv(
      { query: 'test', dateres: 'month' },
      createMockContext(),
    );
    expect(result).toEqual({ series: [], normalized: true, dateResolution: 'month' });
  });

  it('sets normalized to false when normalize:false is passed', async () => {
    const raw = { timeline: [{ series: 'CNN', data: [{ date: '2024-01-01', value: 1.0 }] }] };
    vi.spyOn(gdeltFetchModule, 'gdeltFetch').mockResolvedValueOnce(raw);
    const ctx = createMockContext();
    const svc = makeService();
    const result = await svc.searchTv({ query: 'test', normalize: false }, ctx);
    expect(result.normalized).toBe(false);
  });

  it.each([
    [undefined, 'perc'],
    [true, 'perc'],
    [false, 'raw'],
  ] as const)('requests query coverage with normalize=%s', async (normalize, datanorm) => {
    let capturedParams: URLSearchParams | undefined;
    vi.spyOn(gdeltFetchModule, 'gdeltFetch').mockImplementationOnce((_url, params) => {
      capturedParams = params;
      return Promise.resolve({ timeline: [] });
    });
    await makeService().searchTv(
      { query: 'test', ...(normalize != null ? { normalize } : {}) },
      createMockContext(),
    );
    expect(capturedParams?.get('mode')).toBe('timelinevol');
    expect(capturedParams?.get('datanorm')).toBe(datanorm);
  });

  it('serializes documented timeline smoothing and date-resolution parameters', async () => {
    let capturedParams: URLSearchParams | undefined;
    vi.spyOn(gdeltFetchModule, 'gdeltFetch').mockImplementationOnce((_url, params) => {
      capturedParams = params;
      return Promise.resolve({ timeline: [], dateresolution: 'week' });
    });
    const result = await makeService().searchTv(
      { query: 'test', smoothing: 4, dateres: 'week' },
      createMockContext(),
    );
    expect(capturedParams?.get('timelinesmooth')).toBe('4');
    expect(capturedParams?.has('smoothing')).toBe(false);
    expect(capturedParams?.get('dateres')).toBe('week');
    expect(result.dateResolution).toBe('week');
  });

  it.each(['hour', 'day', 'week', 'month', 'year'] as const)(
    'preserves recognized upstream %s resolution metadata',
    async (dateresolution) => {
      vi.spyOn(gdeltFetchModule, 'gdeltFetch').mockResolvedValueOnce({
        timeline: [],
        dateresolution,
      });
      const result = await makeService().searchTv({ query: 'test' }, createMockContext());
      expect(result.dateResolution).toBe(dateresolution);
    },
  );

  it('normalizes compact dates and infers hourly points across day boundaries', async () => {
    vi.spyOn(gdeltFetchModule, 'gdeltFetch').mockResolvedValueOnce({
      timeline: [
        {
          series: 'CNN',
          data: [
            { date: '20240101T230000Z', value: 1 },
            { date: '20240102T000000Z', value: 2 },
            { date: '20240102T010000Z', value: 3 },
          ],
        },
      ],
    });
    const result = await makeService().searchTv({ query: 'test' }, createMockContext());
    expect(result.dateResolution).toBe('hour');
    expect(result.series[0]?.data.map((point) => point.date)).toEqual([
      '2024-01-01T23:00:00Z',
      '2024-01-02T00:00:00Z',
      '2024-01-02T01:00:00Z',
    ]);
  });
});

/**
 * GDELT labels timeline series and clips with a station's catalog `description` ("FOX News"),
 * not the station ID the `stations` input takes ("FOXNEWS"). The labels below are verbatim from
 * live TV API answers (2026-10-14); every one is a description in the catalog fixture.
 */
describe('GdeltTvService station ID resolution', () => {
  /** Live timeline labels and the station IDs they were requested by. */
  const LABELED: ReadonlyArray<readonly [label: string, id: string]> = [
    ['ABC - San Francisco (KGO)', 'KGO'],
    ['CBS - St. Petersburg (WTSP)', 'WTSP'],
    ['CSPAN2', 'CSPAN2'],
    ['Comedy Central', 'COM'],
    ['FOX Business', 'FBC'],
    ['FOX News', 'FOXNEWS'],
    ['MyNetworkTV - San Francisco (KRON)', 'KRON'],
    ['NBC - Des Moines (WHO)', 'WHO'],
    ['SFGOVTV - San Francisco (SFGTV)', 'SFGTV'],
    ['Al Jazeera', 'ALJAZ'],
    ['BBC News', 'BBCNEWS'],
    ['Bloomberg', 'BLOOMBERG'],
    ['CNBC', 'CNBC'],
    ['CSPAN3', 'CSPAN3'],
    ['DeutscheWelle', 'DW'],
    ['LinkTV', 'LINKTV'],
    ['MSNBC', 'MSNBC'],
    ['Russia Today', 'RT'],
    ['Univision - San Francisco (KDTV)', 'KDTV'],
  ];

  const POINT = { date: '20160215T120000Z', value: 1 };
  const timeline = (labels: readonly string[]) => ({
    timeline: labels.map((series) => ({ series, data: [POINT] })),
  });
  const clipGallery = (labels: readonly string[]) => ({
    clips: labels.map((station, i) => ({
      show: 'Today',
      station,
      date: '2016-02-15T14:02:30Z',
      snippet: 'snippet',
      preview_url: `https://archive.org/details/CLIP_${i}`,
    })),
  });

  type Answer = (ctx: { signal: AbortSignal }) => Promise<unknown>;

  /**
   * Answer each request by its mode — `timelinevol` and `clipgallery` from `main`, the catalog
   * from `catalog` — and record the order requests were made in.
   */
  function routeUpstream(
    main: { timelinevol?: unknown; clipgallery?: unknown },
    catalog: Answer = () => Promise.resolve(CATALOG),
  ) {
    const spy = vi
      .spyOn(gdeltFetchModule, 'gdeltFetch')
      .mockImplementation((_url, params, ctx) =>
        isCatalogRequest(params)
          ? catalog(ctx)
          : Promise.resolve(main[params.get('mode') as keyof typeof main]),
      );
    return {
      catalogCalls: () => spy.mock.calls.filter(([, params]) => isCatalogRequest(params)).length,
      modes: () => spy.mock.calls.map(([, params]) => params.get('mode')),
    };
  }

  /** A catalog answer held until `release()`, rejecting early if its own signal aborts. */
  function heldCatalog() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const answer: Answer = ({ signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        void gate.then(() => resolve(CATALOG));
      });
    return { answer, release };
  }

  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

  it('resolves every live timeline label to its station ID and keeps the label as stationName', async () => {
    routeUpstream({ timelinevol: timeline(LABELED.map(([label]) => label)) });
    const result = await makeService().searchTv({ query: 'election' }, createMockContext());
    expect(result.series.map((s) => [s.stationName, s.station])).toEqual(LABELED);
    expect(result).not.toHaveProperty('stationCatalogUnavailable');
  });

  it('resolves clip labels the same way, keeping every other clip field', async () => {
    routeUpstream({ clipgallery: clipGallery(LABELED.map(([label]) => label)) });
    const result = await makeService().getTvClips({ query: 'election' }, createMockContext());
    expect(result.clips.map((c) => [c.stationName, c.station])).toEqual(LABELED);
    expect(result.clips[5]).toEqual({
      show: 'Today',
      station: 'FOXNEWS',
      stationName: 'FOX News',
      date: '2016-02-15T14:02:30Z',
      snippet: 'snippet',
      archiveUrl: 'https://archive.org/details/CLIP_5',
    });
    expect(result).not.toHaveProperty('stationCatalogUnavailable');
  });

  it('requests the catalog once per process across both methods, always after the main request', async () => {
    const upstream = routeUpstream({
      timelinevol: timeline(['FOX News']),
      clipgallery: clipGallery(['FOX Business']),
    });
    const svc = makeService();
    const series = await svc.searchTv({ query: 'x' }, createMockContext());
    const clips = await svc.getTvClips({ query: 'x' }, createMockContext());
    await svc.searchTv({ query: 'y' }, createMockContext());
    expect(series.series[0]?.station).toBe('FOXNEWS');
    expect(clips.clips[0]?.station).toBe('FBC');
    expect(upstream.catalogCalls()).toBe(1);
    expect(upstream.modes()).toEqual([
      'timelinevol',
      'stationdetails',
      'clipgallery',
      'timelinevol',
    ]);
  });

  it('never requests the catalog for an answer with no station to resolve', async () => {
    const upstream = routeUpstream({ timelinevol: {}, clipgallery: { clips: [] } });
    const svc = makeService();
    expect(await svc.searchTv({ query: 'x' }, createMockContext())).toEqual({
      series: [],
      normalized: true,
    });
    expect(await svc.getTvClips({ query: 'x' }, createMockContext())).toEqual({ clips: [] });
    expect(upstream.catalogCalls()).toBe(0);
  });

  it('shares one in-flight load between concurrent first calls', async () => {
    const held = heldCatalog();
    const upstream = routeUpstream(
      { timelinevol: timeline(['FOX News']), clipgallery: clipGallery(['FOX Business']) },
      held.answer,
    );
    const svc = makeService();
    const series = svc.searchTv({ query: 'x' }, createMockContext());
    const clips = svc.getTvClips({ query: 'x' }, createMockContext());
    await tick();
    held.release();
    expect((await series).series[0]?.station).toBe('FOXNEWS');
    expect((await clips).clips[0]?.station).toBe('FBC');
    expect(upstream.catalogCalls()).toBe(1);
  });

  it('fails a cancelled caller as cancelled without failing the others awaiting the same load', async () => {
    const held = heldCatalog();
    const upstream = routeUpstream(
      { timelinevol: timeline(['FOX News']), clipgallery: clipGallery(['FOX Business']) },
      held.answer,
    );
    const svc = makeService();
    const cancelled = new AbortController();
    const first = svc.searchTv({ query: 'x' }, createMockContext({ signal: cancelled.signal }));
    const second = svc.getTvClips({ query: 'x' }, createMockContext());
    await tick();
    cancelled.abort();
    await expect(first).rejects.toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    held.release();
    const survivor = await second;
    expect(survivor.clips[0]?.station).toBe('FBC');
    expect(survivor).not.toHaveProperty('stationCatalogUnavailable');
    expect(upstream.catalogCalls()).toBe(1);
  });

  it('fails a caller cancelled before the lookup as cancelled', async () => {
    const cancelled = new AbortController();
    routeUpstream({ timelinevol: timeline(['FOX News']) }, () => {
      cancelled.abort();
      return Promise.resolve(CATALOG);
    });
    await expect(
      makeService().searchTv({ query: 'x' }, createMockContext({ signal: cancelled.signal })),
    ).rejects.toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
  });

  it.each([
    ['an HTTP 429', () => rateLimited('GDELT TV API rate-limited the request.')],
    ['an HTTP 5xx', () => serviceUnavailable('GDELT TV API returned HTTP 503.')],
    ['a network error', () => new TypeError('fetch failed')],
  ])(
    'returns labels without IDs when the catalog load fails with %s, and loads it again next call',
    async (_case, failure) => {
      let fail = true;
      const upstream = routeUpstream(
        { timelinevol: timeline(['FOX News']), clipgallery: clipGallery(['FOX Business']) },
        () => (fail ? Promise.reject(failure()) : Promise.resolve(CATALOG)),
      );
      const svc = makeService();
      const series = await svc.searchTv({ query: 'x' }, createMockContext());
      expect(series.series).toEqual([
        { stationName: 'FOX News', data: [{ date: '2016-02-15T12:00:00Z', value: 1 }] },
      ]);
      expect(series.stationCatalogUnavailable).toBe(true);
      const clips = await svc.getTvClips({ query: 'x' }, createMockContext());
      expect(clips.clips[0]).not.toHaveProperty('station');
      expect(clips.clips[0]?.stationName).toBe('FOX Business');
      expect(clips.stationCatalogUnavailable).toBe(true);

      fail = false;
      const recovered = await svc.searchTv({ query: 'x' }, createMockContext());
      expect(recovered.series[0]?.station).toBe('FOXNEWS');
      expect(recovered).not.toHaveProperty('stationCatalogUnavailable');
      expect(upstream.catalogCalls()).toBe(3);
    },
  );

  it.each([
    ['no station_details key', {}],
    ['an empty station list', { station_details: [] }],
  ])('treats a catalog with %s as unavailable and does not keep it', async (_case, empty) => {
    let answer: unknown = empty;
    const upstream = routeUpstream({ timelinevol: timeline(['FOX News']) }, () =>
      Promise.resolve(answer),
    );
    const svc = makeService();
    const first = await svc.searchTv({ query: 'x' }, createMockContext());
    expect(first.series[0]).not.toHaveProperty('station');
    expect(first.stationCatalogUnavailable).toBe(true);
    answer = CATALOG;
    const second = await svc.searchTv({ query: 'x' }, createMockContext());
    expect(second.series[0]?.station).toBe('FOXNEWS');
    expect(upstream.catalogCalls()).toBe(2);
  });

  it('keeps stationName and omits station for a label the catalog does not list', async () => {
    routeUpstream({ timelinevol: timeline(['FOX News', 'KZZZ Local News']) });
    const result = await makeService().searchTv({ query: 'x' }, createMockContext());
    expect(result.series.map((s) => s.station)).toEqual(['FOXNEWS', undefined]);
    expect(result.series[1]).toEqual({
      stationName: 'KZZZ Local News',
      data: [{ date: '2016-02-15T12:00:00Z', value: 1 }],
    });
    expect(result).not.toHaveProperty('stationCatalogUnavailable');
  });

  /**
   * A series or clip GDELT sends with no station label has no label to resolve: stationName is
   * empty — never a stand-in that reads as a label — and it is never looked up in the catalog.
   */
  it('carries a series or clip GDELT sent without a label as an empty stationName and no station', async () => {
    const unlabeledClip = { ...clipGallery(['x']).clips[0], station: undefined };
    const upstream = routeUpstream({
      timelinevol: { timeline: [{ data: [POINT] }, { series: 'FOX News', data: [POINT] }] },
      clipgallery: { clips: [unlabeledClip, ...clipGallery(['FOX Business']).clips] },
    });
    const svc = makeService();
    const result = await svc.searchTv({ query: 'x' }, createMockContext());
    expect(result.series).toEqual([
      { stationName: '', data: [{ date: '2016-02-15T12:00:00Z', value: 1 }] },
      {
        station: 'FOXNEWS',
        stationName: 'FOX News',
        data: [{ date: '2016-02-15T12:00:00Z', value: 1 }],
      },
    ]);
    expect(result).not.toHaveProperty('stationCatalogUnavailable');
    const clips = await svc.getTvClips({ query: 'x' }, createMockContext());
    expect(clips.clips.map((c) => [c.stationName, c.station])).toEqual([
      ['', undefined],
      ['FOX Business', 'FBC'],
    ]);
    expect(clips.clips[0]).not.toHaveProperty('station');
    expect(upstream.catalogCalls()).toBe(1);
  });

  it('never requests the catalog when no returned series carries a label', async () => {
    const upstream = routeUpstream({ timelinevol: { timeline: [{ data: [POINT] }] } });
    const result = await makeService().searchTv({ query: 'x' }, createMockContext());
    expect(result.series).toEqual([
      { stationName: '', data: [{ date: '2016-02-15T12:00:00Z', value: 1 }] },
    ]);
    expect(upstream.catalogCalls()).toBe(0);
  });

  describe('the call deadline', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      return () => vi.useRealTimers();
    });

    const resolveAfter = <T>(ms: number, value: T) =>
      new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

    /**
     * requestTimeoutMs 100 → a 200 ms call deadline, counted from the start of the call. The main
     * request takes 150 ms and the catalog 100 ms more, so the load would settle at 250 ms — past
     * the deadline, though inside a fresh 200 ms counted from the end of the main request. The
     * stub answers at 250 ms despite the abort, and that answer is still not kept: the next call,
     * whose main request is instant, loads the catalog again.
     */
    it('stops waiting for the catalog at the deadline of the whole call, abandoning the load', async () => {
      const catalogSignals: AbortSignal[] = [];
      let mainMs = 150;
      const spy = vi
        .spyOn(gdeltFetchModule, 'gdeltFetch')
        .mockImplementation((_url, params, ctx) => {
          if (!isCatalogRequest(params)) return resolveAfter(mainMs, timeline(['FOX News']));
          catalogSignals.push(ctx.signal);
          return resolveAfter(100, CATALOG);
        });
      const svc = makeService(100);
      const call = svc.searchTv({ query: 'x' }, createMockContext());
      let settled = false;
      void call.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(200);
      expect(settled).toBe(true);
      const result = await call;
      expect(result.series[0]).not.toHaveProperty('station');
      expect(result.stationCatalogUnavailable).toBe(true);
      expect(catalogSignals[0]?.aborted).toBe(true);

      await vi.advanceTimersByTimeAsync(50);
      mainMs = 0;
      const next = svc.searchTv({ query: 'x' }, createMockContext());
      await vi.advanceTimersByTimeAsync(100);
      expect((await next).series[0]?.station).toBe('FOXNEWS');
      expect(spy.mock.calls.filter(([, params]) => isCatalogRequest(params))).toHaveLength(2);
    });

    /**
     * A call that joins a load already in flight keeps it running to its own deadline: requestTimeoutMs
     * 100 gives each call 200 ms. The first call starts at 0, the second at 100, and the catalog
     * answers at 250 — after the first call stopped waiting, inside the second call's deadline.
     */
    it('keeps a shared load running until the last waiting call stops waiting', async () => {
      const catalogSignals: AbortSignal[] = [];
      const upstream = routeUpstream(
        { timelinevol: timeline(['FOX News']), clipgallery: clipGallery(['FOX Business']) },
        ({ signal }) => {
          catalogSignals.push(signal);
          return resolveAfter(250, CATALOG);
        },
      );
      const svc = makeService(100);
      const first = svc.searchTv({ query: 'x' }, createMockContext());
      await vi.advanceTimersByTimeAsync(100);
      const second = svc.getTvClips({ query: 'x' }, createMockContext());
      await vi.advanceTimersByTimeAsync(100);
      expect((await first).stationCatalogUnavailable).toBe(true);
      expect(catalogSignals[0]?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(50);
      const clips = await second;
      expect(clips.clips[0]?.station).toBe('FBC');
      expect(clips).not.toHaveProperty('stationCatalogUnavailable');
      const third = await svc.searchTv({ query: 'x' }, createMockContext());
      expect(third.series[0]?.station).toBe('FOXNEWS');
      expect(upstream.catalogCalls()).toBe(1);
    });

    it('aborts a shared load that has not answered once the last waiting call stops waiting', async () => {
      const catalogSignals: AbortSignal[] = [];
      const upstream = routeUpstream(
        { timelinevol: timeline(['FOX News']), clipgallery: clipGallery(['FOX Business']) },
        ({ signal }) => {
          catalogSignals.push(signal);
          return new Promise((_, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        },
      );
      const svc = makeService(100);
      const first = svc.searchTv({ query: 'x' }, createMockContext());
      await vi.advanceTimersByTimeAsync(100);
      const second = svc.getTvClips({ query: 'x' }, createMockContext());
      await vi.advanceTimersByTimeAsync(100);
      expect((await first).stationCatalogUnavailable).toBe(true);
      expect(catalogSignals[0]?.aborted).toBe(false);

      await vi.advanceTimersByTimeAsync(100);
      expect(catalogSignals[0]?.aborted).toBe(true);
      expect((await second).stationCatalogUnavailable).toBe(true);
      expect(upstream.catalogCalls()).toBe(1);
    });

    it('never holds a call past its deadline for a catalog that does not answer', async () => {
      vi.spyOn(gdeltFetchModule, 'gdeltFetch').mockImplementation((_url, params) =>
        isCatalogRequest(params) ? new Promise(() => {}) : Promise.resolve(timeline(['FOX News'])),
      );
      const call = makeService(100).searchTv({ query: 'x' }, createMockContext());
      let settled = false;
      void call.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(199);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      expect((await call).stationCatalogUnavailable).toBe(true);
    });
  });
});

/**
 * The catalog is a side lookup, so it never stretches a call toward an MCP client's 60-second
 * timeout: its load is one attempt, and a call waits for it at most 45 seconds from the call's
 * start before answering without IDs. These drive the real fetch helper, pacer, and retry ladder
 * — only `fetch` is stubbed — at the default 60-second request timeout.
 */
describe('GdeltTvService station catalog wait, through the real fetch path', () => {
  const MAIN = {
    timeline: [{ series: 'FOX News', data: [{ date: '20160215T120000Z', value: 1 }] }],
  };

  type Route = (signal: AbortSignal | undefined) => Promise<Response>;
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  const answerAfter =
    (ms: number, response: () => Response): Route =>
    (signal) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve(response()), ms);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(signal.reason);
        });
      });

  /** Answer the main request and the catalog request each by its own route; count each. */
  function routeFetch(main: Route, catalog: Route) {
    const calls = { main: 0, catalog: 0 };
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const catalogRequest = new URL(String(input)).searchParams.get('mode') === 'stationdetails';
      calls[catalogRequest ? 'catalog' : 'main']++;
      return (catalogRequest ? catalog : main)(init?.signal ?? undefined);
    });
    return calls;
  }

  /** Start a call and report the fake-clock time it settled at. */
  function timed<T>(call: Promise<T>) {
    const startedAt = Date.now();
    const state: { settledAfterMs?: number } = {};
    void call.then(
      () => {
        state.settledAfterMs = Date.now() - startedAt;
      },
      () => {
        state.settledAfterMs = Date.now() - startedAt;
      },
    );
    return state;
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
    initGdeltPacer(0);
    return () => {
      disposeGdeltPacer();
      vi.useRealTimers();
    };
  });

  it('makes one catalog request on a 503 and answers at once without IDs', async () => {
    const calls = routeFetch(
      async () => json(MAIN),
      async () => new Response('', { status: 503 }),
    );
    const call = makeService().searchTv({ query: 'x' }, createMockContext());
    const state = timed(call);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(state.settledAfterMs).toBeDefined();
    const result = await call;
    expect(result.series[0]).toEqual({
      stationName: 'FOX News',
      data: [{ date: '2016-02-15T12:00:00Z', value: 1 }],
    });
    expect(result.stationCatalogUnavailable).toBe(true);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls).toEqual({ main: 1, catalog: 1 });
  });

  it('keeps a catalog that answers inside the 45 seconds, serving the next call from it', async () => {
    const calls = routeFetch(
      async () => json(MAIN),
      answerAfter(44_000, () => json(CATALOG)),
    );
    const svc = makeService();
    const call = svc.searchTv({ query: 'x' }, createMockContext());
    const state = timed(call);
    await vi.advanceTimersByTimeAsync(44_000);
    expect(state.settledAfterMs).toBe(44_000);
    expect((await call).series[0]?.station).toBe('FOXNEWS');

    const next = svc.searchTv({ query: 'x' }, createMockContext());
    await vi.advanceTimersByTimeAsync(0);
    expect((await next).series[0]?.station).toBe('FOXNEWS');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls).toEqual({ main: 2, catalog: 1 });
  });

  /**
   * GDELT holds one request in flight. A catalog request that never answers must give that slot
   * up when the call stops waiting for it at 45 seconds — not at its own 60-second attempt
   * timeout, which would hold the next GDELT request, from any tool, for 15 seconds more. The
   * abandoned load is not kept, so the next TV call requests the catalog again.
   */
  it('aborts a hung catalog request when the call stops waiting, freeing the slot and keeping nothing', async () => {
    let catalogAnswers = false;
    const hang: Route = (signal) =>
      new Promise((_, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason));
      });
    const calls = routeFetch(
      async () => json(MAIN),
      (signal) => (catalogAnswers ? Promise.resolve(json(CATALOG)) : hang(signal)),
    );
    const svc = makeService();
    const tv = svc.searchTv({ query: 'x' }, createMockContext());
    const tvState = timed(tv);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(tvState.settledAfterMs).toBe(45_000);
    expect((await tv).stationCatalogUnavailable).toBe(true);

    const doc = new GdeltDocService(MOCK_CONFIG, MOCK_STORAGE, MOCK_SERVER_CONFIG);
    const timeline = doc.getTimeline({ query: 'x', mode: 'timelinevol' }, createMockContext());
    const docState = timed(timeline);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(docState.settledAfterMs).toBe(0);
    expect((await timeline)[0]?.label).toBe('FOX News');

    catalogAnswers = true;
    const next = svc.searchTv({ query: 'x' }, createMockContext());
    await vi.advanceTimersByTimeAsync(0);
    expect((await next).series[0]?.station).toBe('FOXNEWS');
    expect(calls).toEqual({ main: 3, catalog: 2 });
  });

  it('answers at 45 seconds from the call start when the catalog does not answer', async () => {
    routeFetch(
      async () => json(MAIN),
      () => new Promise<Response>(() => {}),
    );
    const call = makeService().searchTv({ query: 'x' }, createMockContext());
    const state = timed(call);
    await vi.advanceTimersByTimeAsync(44_999);
    expect(state.settledAfterMs).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(state.settledAfterMs).toBe(45_000);
    expect((await call).stationCatalogUnavailable).toBe(true);
  });

  /**
   * A 30-second main request and a 20-second catalog: the catalog would land at 50 seconds, so
   * the call answers at 45 without IDs, and the catalog request is aborted then rather than
   * kept — the next call, whose main request is instant, requests it again.
   */
  it('counts the 45 seconds from the call start, and abandons a catalog that would land later', async () => {
    const calls = routeFetch(
      (signal) =>
        calls.main === 1
          ? answerAfter(30_000, () => json(MAIN))(signal)
          : Promise.resolve(json(MAIN)),
      answerAfter(20_000, () => json(CATALOG)),
    );
    const svc = makeService();
    const call = svc.searchTv({ query: 'x' }, createMockContext());
    const state = timed(call);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(state.settledAfterMs).toBe(45_000);
    expect((await call).stationCatalogUnavailable).toBe(true);

    await vi.advanceTimersByTimeAsync(5_000);
    const next = svc.searchTv({ query: 'x' }, createMockContext());
    await vi.advanceTimersByTimeAsync(20_000);
    expect((await next).series[0]?.station).toBe('FOXNEWS');
    expect(calls).toEqual({ main: 2, catalog: 2 });
  });
});
