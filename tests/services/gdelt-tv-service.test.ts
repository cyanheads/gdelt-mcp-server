/**
 * @fileoverview Tests for GdeltTvService normalizers and helpers: parseGdeltDate,
 * formatGdeltDate (via listStations), buildBaseParams (station filter embedding),
 * and clip/context/timeline parsing.
 * @module tests/services/gdelt-tv-service.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import * as gdeltFetchModule from '@/services/gdelt/gdelt-fetch.js';
import { GdeltTvService } from '@/services/gdelt/gdelt-tv-service.js';

const MOCK_CONFIG = {} as ConstructorParameters<typeof GdeltTvService>[0];
const MOCK_STORAGE = {} as ConstructorParameters<typeof GdeltTvService>[1];
const MOCK_SERVER_CONFIG = {
  baseUrl: 'https://api.gdeltproject.org',
} as ConstructorParameters<typeof GdeltTvService>[2];

function makeService(): GdeltTvService {
  return new GdeltTvService(MOCK_CONFIG, MOCK_STORAGE, MOCK_SERVER_CONFIG);
}

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
    const clips = await svc.getTvClips({ query: 'test' }, ctx);
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
    const clips = await svc.getTvClips({ query: 'test' }, ctx);
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
    const clips = await svc.getTvClips({ query: 'test' }, ctx);
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
