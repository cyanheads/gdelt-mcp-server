/**
 * @fileoverview Tests for GdeltTvService normalizers and helpers: parseGdeltDate,
 * formatGdeltDate (via listStations), buildBaseParams (station filter embedding),
 * and clip/context/trending parsing.
 * @module tests/services/gdelt-tv-service.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import * as gdeltFetchModule from '@/services/gdelt/gdelt-fetch.js';
import { GdeltTvService } from '@/services/gdelt/gdelt-tv-service.js';

const MOCK_CONFIG = {} as Parameters<typeof GdeltTvService.prototype.constructor>[0];
const MOCK_STORAGE = {} as Parameters<typeof GdeltTvService.prototype.constructor>[1];
const MOCK_SERVER_CONFIG = { baseUrl: 'https://api.gdeltproject.org' } as Parameters<
  typeof GdeltTvService.prototype.constructor
>[2];

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

  it('embeds station filters into the query string when stations are provided', async () => {
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
    expect(q).toContain('station:CNN');
    expect(q).toContain('station:FOXNEWS');
    expect(q).toContain('vaccine');
  });

  it('returns empty array when clips key is absent', async () => {
    vi.spyOn(gdeltFetchModule, 'gdeltFetch').mockResolvedValueOnce({});
    const ctx = createMockContext();
    const svc = makeService();
    const clips = await svc.getTvClips({ query: 'test' }, ctx);
    expect(clips).toEqual([]);
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

  it('defaults clipsAnalyzed to 0 when numclips is absent', async () => {
    vi.spyOn(gdeltFetchModule, 'gdeltFetch').mockResolvedValueOnce({ wordcloud: [] });
    const ctx = createMockContext();
    const svc = makeService();
    const result = await svc.getTvContext({ query: 'test' }, ctx);
    expect(result.clipsAnalyzed).toBe(0);
  });

  it('returns empty words array when wordcloud key is absent', async () => {
    vi.spyOn(gdeltFetchModule, 'gdeltFetch').mockResolvedValueOnce({});
    const ctx = createMockContext();
    const svc = makeService();
    const result = await svc.getTvContext({ query: 'test' }, ctx);
    expect(result.words).toEqual([]);
  });
});

describe('GdeltTvService.getTvTrending', () => {
  it('maps OverallTrendingTopics to TvTrendingTopic shape', async () => {
    const raw = {
      OverallTrendingTopics: [
        { label: 'Ukraine', score: 8.5 },
        { label: 'inflation', score: 4.2 },
      ],
    };
    vi.spyOn(gdeltFetchModule, 'gdeltFetch').mockResolvedValueOnce(raw);
    const ctx = createMockContext();
    const svc = makeService();
    const topics = await svc.getTvTrending(ctx);
    expect(topics[0]?.label).toBe('Ukraine');
    expect(topics[0]?.score).toBe(8.5);
  });

  it('falls back to OverallTrendingPhrases when topics are absent', async () => {
    const raw = {
      OverallTrendingPhrases: [{ label: 'climate change', score: 3.0 }],
    };
    vi.spyOn(gdeltFetchModule, 'gdeltFetch').mockResolvedValueOnce(raw);
    const ctx = createMockContext();
    const svc = makeService();
    const topics = await svc.getTvTrending(ctx);
    expect(topics[0]?.label).toBe('climate change');
  });

  it('returns empty array when both topic keys are absent', async () => {
    vi.spyOn(gdeltFetchModule, 'gdeltFetch').mockResolvedValueOnce({});
    const ctx = createMockContext();
    const svc = makeService();
    const topics = await svc.getTvTrending(ctx);
    expect(topics).toEqual([]);
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

  it('computes correct timeRange from all data point dates', async () => {
    const raw = {
      timeline: [
        {
          series: 'CNN',
          data: [
            { date: '2024-01-03', value: 1.0 },
            { date: '2024-01-01', value: 0.5 },
            { date: '2024-01-02', value: 0.8 },
          ],
        },
      ],
    };
    vi.spyOn(gdeltFetchModule, 'gdeltFetch').mockResolvedValueOnce(raw);
    const ctx = createMockContext();
    const svc = makeService();
    const result = await svc.searchTv({ query: 'test' }, ctx);
    expect(result.timeRange.start).toBe('2024-01-01');
    expect(result.timeRange.end).toBe('2024-01-03');
  });

  it('uses dateResolution "day" when dateresolution key is absent', async () => {
    const raw = {
      timeline: [{ series: 'CNN', data: [{ date: '2024-01-01', value: 1.0 }] }],
    };
    vi.spyOn(gdeltFetchModule, 'gdeltFetch').mockResolvedValueOnce(raw);
    const ctx = createMockContext();
    const svc = makeService();
    const result = await svc.searchTv({ query: 'test' }, ctx);
    expect(result.dateResolution).toBe('day');
  });

  it('sets normalized to false when normalize:false is passed', async () => {
    const raw = { timeline: [{ series: 'CNN', data: [{ date: '2024-01-01', value: 1.0 }] }] };
    vi.spyOn(gdeltFetchModule, 'gdeltFetch').mockResolvedValueOnce(raw);
    const ctx = createMockContext();
    const svc = makeService();
    const result = await svc.searchTv({ query: 'test', normalize: false }, ctx);
    expect(result.normalized).toBe(false);
  });
});
