/**
 * @fileoverview Tests for GdeltDocService normalizers and parsers: normalizeArticle,
 * parseTimeline, parseVolInfoTimeline, and method-level sparsity handling.
 * @module tests/services/gdelt-doc-service.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { GdeltDocService } from '@/services/gdelt/gdelt-doc-service.js';
import * as gdeltFetchModule from '@/services/gdelt/gdelt-fetch.js';

/** Minimal stubs — GdeltDocService only reads `baseUrl` from serverConfig. */
const MOCK_CONFIG = {} as ConstructorParameters<typeof GdeltDocService>[0];
const MOCK_STORAGE = {} as ConstructorParameters<typeof GdeltDocService>[1];
const MOCK_SERVER_CONFIG = {
  baseUrl: 'https://api.gdeltproject.org',
} as ConstructorParameters<typeof GdeltDocService>[2];

function makeService(): GdeltDocService {
  return new GdeltDocService(MOCK_CONFIG, MOCK_STORAGE, MOCK_SERVER_CONFIG);
}

describe('GdeltDocService.searchArticles', () => {
  it('normalizes a full article including optional socialimage', async () => {
    const raw = {
      articles: [
        {
          url: 'https://example.com/a',
          title: 'Title',
          seendate: '20240101T120000Z',
          domain: 'example.com',
          language: 'English',
          sourcecountry: 'United States',
          socialimage: 'https://example.com/img.jpg',
        },
      ],
    };
    vi.spyOn(gdeltFetchModule, 'gdeltFetch').mockResolvedValueOnce(raw);
    const ctx = createMockContext();
    const svc = makeService();
    const result = await svc.searchArticles({ query: 'test' }, ctx);
    expect(result.articles).toHaveLength(1);
    expect(result.articles[0]?.socialimage).toBe('https://example.com/img.jpg');
    expect(result.articles[0]?.url).toBe('https://example.com/a');
  });

  it('omits socialimage field when upstream does not supply it', async () => {
    const raw = {
      articles: [
        {
          url: 'https://example.com/b',
          title: 'No Image',
          seendate: '20240101T120000Z',
          domain: 'example.com',
          language: 'English',
          sourcecountry: 'United States',
        },
      ],
    };
    vi.spyOn(gdeltFetchModule, 'gdeltFetch').mockResolvedValueOnce(raw);
    const ctx = createMockContext();
    const svc = makeService();
    const result = await svc.searchArticles({ query: 'test' }, ctx);
    expect(result.articles[0]).not.toHaveProperty('socialimage');
  });

  it('returns empty articles array when upstream returns no articles field', async () => {
    vi.spyOn(gdeltFetchModule, 'gdeltFetch').mockResolvedValueOnce({});
    const ctx = createMockContext();
    const svc = makeService();
    const result = await svc.searchArticles({ query: 'test' }, ctx);
    expect(result.articles).toEqual([]);
    expect(result.totalReturned).toBe(0);
  });

  it('propagates a fetch error without swallowing it', async () => {
    vi.spyOn(gdeltFetchModule, 'gdeltFetch').mockRejectedValueOnce(new Error('network error'));
    const ctx = createMockContext();
    const svc = makeService();
    await expect(svc.searchArticles({ query: 'test' }, ctx)).rejects.toThrow('network error');
  });

  it.each([
    ['dateDesc', 'DateDesc'],
    ['dateAsc', 'DateAsc'],
    ['toneDesc', 'ToneDesc'],
    ['toneAsc', 'ToneAsc'],
    ['hybridRel', 'HybridRel'],
  ] as const)('maps public %s sorting to GDELT %s', async (sort, expected) => {
    let capturedParams: URLSearchParams | undefined;
    vi.spyOn(gdeltFetchModule, 'gdeltFetch').mockImplementationOnce((_url, params) => {
      capturedParams = params;
      return Promise.resolve({ articles: [] });
    });
    await makeService().searchArticles({ query: 'test', sort }, createMockContext());
    expect(capturedParams?.get('sort')).toBe(expected);
  });

  it('omits SORT for the documented relevance default', async () => {
    let capturedParams: URLSearchParams | undefined;
    vi.spyOn(gdeltFetchModule, 'gdeltFetch').mockImplementationOnce((_url, params) => {
      capturedParams = params;
      return Promise.resolve({ articles: [] });
    });
    await makeService().searchArticles({ query: 'test', sort: 'relevance' }, createMockContext());
    expect(capturedParams?.has('sort')).toBe(false);
  });
});

describe('GdeltDocService.getTimeline (standard modes)', () => {
  it('parses a standard timeline response into labelled series', async () => {
    const raw = {
      timeline: [
        {
          series: 'Volume Intensity',
          html: '',
          data: [
            { date: '2024-01-01', value: 1.5 },
            { date: '2024-01-02', value: 2.0 },
          ],
        },
      ],
    };
    vi.spyOn(gdeltFetchModule, 'gdeltFetch').mockResolvedValueOnce(raw);
    const ctx = createMockContext();
    const svc = makeService();
    const series = await svc.getTimeline({ query: 'test', mode: 'timelinevol' }, ctx);
    expect(series).toHaveLength(1);
    expect(series[0]?.label).toBe('Volume Intensity');
    expect(series[0]?.data).toHaveLength(2);
  });

  it('falls back to "Series" label when upstream series field is missing', async () => {
    const raw = {
      timeline: [{ html: '', data: [{ date: '2024-01-01', value: 1.0 }] }],
    };
    vi.spyOn(gdeltFetchModule, 'gdeltFetch').mockResolvedValueOnce(raw);
    const ctx = createMockContext();
    const svc = makeService();
    const series = await svc.getTimeline({ query: 'test', mode: 'timelinetone' }, ctx);
    expect(series[0]?.label).toBe('Series');
  });

  it('returns empty array when timeline key is absent', async () => {
    vi.spyOn(gdeltFetchModule, 'gdeltFetch').mockResolvedValueOnce({});
    const ctx = createMockContext();
    const svc = makeService();
    const series = await svc.getTimeline({ query: 'test', mode: 'timelinevol' }, ctx);
    expect(series).toEqual([]);
  });

  it('handles a series with no data points gracefully', async () => {
    const raw = { timeline: [{ series: 'Volume Intensity', html: '', data: [] }] };
    vi.spyOn(gdeltFetchModule, 'gdeltFetch').mockResolvedValueOnce(raw);
    const ctx = createMockContext();
    const svc = makeService();
    const series = await svc.getTimeline({ query: 'test', mode: 'timelinevol' }, ctx);
    expect(series[0]?.data).toEqual([]);
  });

  it('serializes TIMELINESMOOTH and normalizes compact dates', async () => {
    let capturedParams: URLSearchParams | undefined;
    vi.spyOn(gdeltFetchModule, 'gdeltFetch').mockImplementationOnce((_url, params) => {
      capturedParams = params;
      return Promise.resolve({
        timeline: [
          {
            series: 'Volume Intensity',
            data: [
              { date: '20240101T000000Z', value: 1 },
              { date: '20240102T000000Z', value: 2 },
            ],
          },
        ],
      });
    });
    const series = await makeService().getTimeline(
      { query: 'test', mode: 'timelinevol', smoothing: 3 },
      createMockContext(),
    );
    expect(capturedParams?.get('timelinesmooth')).toBe('3');
    expect(capturedParams?.has('smoothing')).toBe(false);
    expect(series[0]?.data.map((point) => point.date)).toEqual([
      '2024-01-01T00:00:00Z',
      '2024-01-02T00:00:00Z',
    ]);
  });
});

describe('GdeltDocService.getTimeline (timelinevolinfo mode)', () => {
  it('attaches article links to data points that have toparts', async () => {
    const raw = {
      timeline: [
        {
          series: 'Volume Intensity',
          data: [
            {
              date: '2024-01-01T00:00:00Z',
              value: 3.0,
              toparts: [{ url: 'https://news.com/a', title: 'Article A' }],
            },
            { date: '2024-01-01T01:00:00Z', value: 1.0 },
          ],
        },
      ],
    };
    vi.spyOn(gdeltFetchModule, 'gdeltFetch').mockResolvedValueOnce(raw);
    const ctx = createMockContext();
    const svc = makeService();
    const series = await svc.getTimeline({ query: 'test', mode: 'timelinevolinfo' }, ctx);
    expect(series[0]?.data[0]?.articles).toHaveLength(1);
    expect(series[0]?.data[0]?.articles?.[0]?.url).toBe('https://news.com/a');
    expect(series[0]?.data[1]).not.toHaveProperty('articles');
  });

  it('falls back to "Volume Intensity" label when series field is absent', async () => {
    const raw = {
      timeline: [{ data: [{ date: '2024-01-01T00:00:00Z', value: 1.0 }] }],
    };
    vi.spyOn(gdeltFetchModule, 'gdeltFetch').mockResolvedValueOnce(raw);
    const ctx = createMockContext();
    const svc = makeService();
    const series = await svc.getTimeline({ query: 'test', mode: 'timelinevolinfo' }, ctx);
    expect(series[0]?.label).toBe('Volume Intensity');
  });
});

describe('GdeltDocService.getToneDistribution', () => {
  it('maps tonechart bins to ToneHistogramBin shape', async () => {
    const raw = {
      tonechart: [
        {
          bin: -5,
          count: 10,
          toparts: [{ url: 'https://a.com/x', title: 'Negative' }],
        },
        { bin: 3, count: 5, toparts: [] },
      ],
    };
    vi.spyOn(gdeltFetchModule, 'gdeltFetch').mockResolvedValueOnce(raw);
    const ctx = createMockContext();
    const svc = makeService();
    const bins = await svc.getToneDistribution({ query: 'test' }, ctx);
    expect(bins).toHaveLength(2);
    expect(bins[0]?.bin).toBe(-5);
    expect(bins[0]?.articles).toHaveLength(1);
    expect(bins[1]?.articles).toEqual([]);
  });

  it('returns empty array when tonechart key is absent', async () => {
    vi.spyOn(gdeltFetchModule, 'gdeltFetch').mockResolvedValueOnce({});
    const ctx = createMockContext();
    const svc = makeService();
    const bins = await svc.getToneDistribution({ query: 'test' }, ctx);
    expect(bins).toEqual([]);
  });

  it('uses empty articles when toparts is absent on a bin', async () => {
    const raw = { tonechart: [{ bin: 0, count: 5 }] };
    vi.spyOn(gdeltFetchModule, 'gdeltFetch').mockResolvedValueOnce(raw);
    const ctx = createMockContext();
    const svc = makeService();
    const bins = await svc.getToneDistribution({ query: 'test' }, ctx);
    expect(bins[0]?.articles).toEqual([]);
  });
});

describe('GdeltDocService.getBreakdown', () => {
  it('maps timeline data to BreakdownSeries shape', async () => {
    const raw = {
      timeline: [
        {
          series: 'English',
          html: '',
          data: [{ date: '2024-01-01', value: 4.2 }],
        },
      ],
    };
    vi.spyOn(gdeltFetchModule, 'gdeltFetch').mockResolvedValueOnce(raw);
    const ctx = createMockContext();
    const svc = makeService();
    const breakdown = await svc.getBreakdown({ query: 'test', mode: 'timelinelang' }, ctx);
    expect(breakdown).toHaveLength(1);
    expect(breakdown[0]?.label).toBe('English');
    expect(breakdown[0]?.data[0]?.value).toBe(4.2);
  });

  it('normalizes compact breakdown dates', async () => {
    vi.spyOn(gdeltFetchModule, 'gdeltFetch').mockResolvedValueOnce({
      timeline: [
        {
          series: 'English',
          data: [{ date: '20240101T120000Z', value: 4.2 }],
        },
      ],
    });
    const breakdown = await makeService().getBreakdown(
      { query: 'test', mode: 'timelinelang' },
      createMockContext(),
    );
    expect(breakdown[0]?.data[0]?.date).toBe('2024-01-01T12:00:00Z');
  });
});
