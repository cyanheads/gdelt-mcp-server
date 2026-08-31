/**
 * @fileoverview Tests for gdelt_search_tv tool.
 * @module tests/tools/search-tv.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gdeltSearchTv } from '@/mcp-server/tools/definitions/search-tv.tool.js';
import * as tvServiceModule from '@/services/gdelt/gdelt-tv-service.js';

const TV_RESULT = {
  series: [
    {
      station: 'CNN',
      data: [
        { date: '2024-01-01', value: 0.5 },
        { date: '2024-01-02', value: 0.8 },
      ],
    },
  ],
  dateResolution: 'day' as const,
  timeRange: { start: '2024-01-01', end: '2024-01-02' },
  normalized: true,
};

describe('gdeltSearchTv', () => {
  beforeEach(() => {
    vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
      searchTv: vi.fn().mockResolvedValue(TV_RESULT),
    } as unknown as tvServiceModule.GdeltTvService);
  });

  it('returns TV coverage series', async () => {
    const ctx = createMockContext({ errors: gdeltSearchTv.errors });
    const input = gdeltSearchTv.input.parse({ query: 'vaccine' });
    const result = await gdeltSearchTv.handler(input, ctx);
    expect(result.series).toHaveLength(1);
    expect(result.series[0]?.station).toBe('CNN');
    expect(result.normalized).toBe(true);
  });

  it('populates enrichment with query echo and station count', async () => {
    const ctx = createMockContext({ errors: gdeltSearchTv.errors });
    const input = gdeltSearchTv.input.parse({ query: 'vaccine' });
    await gdeltSearchTv.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBe('vaccine');
    expect(enrichment.totalCount).toBe(1);
  });

  it('passes stations filter to the service', async () => {
    const svc = {
      searchTv: vi.fn().mockResolvedValue(TV_RESULT),
    } as unknown as tvServiceModule.GdeltTvService;
    vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue(svc);

    const ctx = createMockContext({ errors: gdeltSearchTv.errors });
    const input = gdeltSearchTv.input.parse({ query: 'test', stations: ['CNN', 'FOXNEWS'] });
    await gdeltSearchTv.handler(input, ctx);
    expect(svc.searchTv).toHaveBeenCalledWith(
      expect.objectContaining({ stations: ['CNN', 'FOXNEWS'] }),
      ctx,
    );
  });

  it('preserves selector-only and explicitly empty station requests', async () => {
    const svc = {
      searchTv: vi.fn().mockResolvedValue(TV_RESULT),
    } as unknown as tvServiceModule.GdeltTvService;
    vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue(svc);

    const ctx = createMockContext({ errors: gdeltSearchTv.errors });
    const input = gdeltSearchTv.input.parse({ query: 'vaccine station:CNN', stations: [] });
    await gdeltSearchTv.handler(input, ctx);
    expect(svc.searchTv).toHaveBeenCalledWith(
      expect.not.objectContaining({ stations: expect.anything() }),
      ctx,
    );
  });

  it('passes the selected TV date resolution to the service', async () => {
    const svc = {
      searchTv: vi.fn().mockResolvedValue({ ...TV_RESULT, dateResolution: 'week' }),
    } as unknown as tvServiceModule.GdeltTvService;
    vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue(svc);

    const ctx = createMockContext({ errors: gdeltSearchTv.errors });
    const input = gdeltSearchTv.input.parse({ query: 'test', dateres: 'week' });
    const result = await gdeltSearchTv.handler(input, ctx);
    expect(svc.searchTv).toHaveBeenCalledWith(expect.objectContaining({ dateres: 'week' }), ctx);
    expect(result.dateResolution).toBe('week');
  });

  it('throws no_tv_coverage when series is empty', async () => {
    vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
      searchTv: vi.fn().mockResolvedValue({ ...TV_RESULT, series: [] }),
    } as unknown as tvServiceModule.GdeltTvService);

    const ctx = createMockContext({ errors: gdeltSearchTv.errors });
    const input = gdeltSearchTv.input.parse({ query: 'noresults' });
    await expect(gdeltSearchTv.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_tv_coverage' },
    });
  });

  it('throws no_tv_coverage when all series have empty data', async () => {
    vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
      searchTv: vi.fn().mockResolvedValue({
        ...TV_RESULT,
        series: [{ station: 'CNN', data: [] }],
      }),
    } as unknown as tvServiceModule.GdeltTvService);

    const ctx = createMockContext({ errors: gdeltSearchTv.errors });
    const input = gdeltSearchTv.input.parse({ query: 'test' });
    await expect(gdeltSearchTv.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_tv_coverage' },
    });
  });

  it('formats output with all required fields', () => {
    const output = {
      dateResolution: 'day' as const,
      timeRange: { start: '2024-01-01', end: '2024-01-02' },
      series: TV_RESULT.series,
      normalized: true,
      totalPoints: 2,
      offset: 0,
      limit: 500,
    };
    const blocks = gdeltSearchTv.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('day');
    expect(text).toContain('2024-01-01');
    expect(text).toContain('2024-01-02');
    expect(text).toContain('Yes');
    expect(text).toContain('CNN');
    // Peak value is 0.8
    expect(text).toContain('0.800');
    expect(text).toContain('2024-01-01: 0.500');
    expect(text).toContain('2024-01-02: 0.800');
    expect(text).toContain('Points 1–2 of 2');
  });

  describe('bounded point pages', () => {
    const PAGED_RESULT = {
      ...TV_RESULT,
      series: [
        {
          station: 'CNN',
          data: [
            { date: '2024-01-01', value: 1 },
            { date: '2024-01-02', value: 2 },
            { date: '2024-01-03', value: 3 },
          ],
        },
        {
          station: 'FOXNEWS',
          data: [
            { date: '2024-01-01', value: 4 },
            { date: '2024-01-02', value: 5 },
            { date: '2024-01-03', value: 6 },
          ],
        },
      ],
      timeRange: { start: '2024-01-01', end: '2024-01-03' },
    };

    beforeEach(() => {
      vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
        searchTv: vi.fn().mockResolvedValue(PAGED_RESULT),
      } as unknown as tvServiceModule.GdeltTvService);
    });

    it('returns a deterministic page with the same points in structured output and text', async () => {
      const ctx = createMockContext({ errors: gdeltSearchTv.errors });
      const input = gdeltSearchTv.input.parse({ query: 'test', limit: 3 });
      const result = await gdeltSearchTv.handler(input, ctx);
      const returned = result.series.flatMap((series) =>
        series.data.map((point) => `${series.station}:${point.date}:${point.value.toFixed(3)}`),
      );
      expect(result).toMatchObject({ totalPoints: 6, offset: 0, limit: 3, nextOffset: 3 });
      expect(returned).toEqual([
        'CNN:2024-01-01:1.000',
        'CNN:2024-01-02:2.000',
        'FOXNEWS:2024-01-01:4.000',
      ]);

      const text = (gdeltSearchTv.format!(result)[0] as { text: string }).text;
      for (const point of returned) {
        const [, date, value] = point.split(':');
        expect(text).toContain(`${date}: ${value}`);
      }
      expect(text).toContain('Next offset:** 3');
    });

    it('retrieves a non-overlapping later page and omits nextOffset on the final page', async () => {
      const ctx = createMockContext({ errors: gdeltSearchTv.errors });
      const input = gdeltSearchTv.input.parse({ query: 'test', limit: 3, offset: 3 });
      const result = await gdeltSearchTv.handler(input, ctx);
      expect(result).toMatchObject({ totalPoints: 6, offset: 3, limit: 3 });
      expect(result.nextOffset).toBeUndefined();
      expect(
        result.series.flatMap((series) =>
          series.data.map((point) => `${series.station}:${point.date}:${point.value.toFixed(3)}`),
        ),
      ).toEqual(['CNN:2024-01-03:3.000', 'FOXNEWS:2024-01-02:5.000', 'FOXNEWS:2024-01-03:6.000']);
    });

    it('rejects an offset past the result with a recovery-bearing error', async () => {
      const ctx = createMockContext({ errors: gdeltSearchTv.errors });
      const input = gdeltSearchTv.input.parse({ query: 'test', offset: 6 });
      await expect(gdeltSearchTv.handler(input, ctx)).rejects.toMatchObject({
        data: {
          reason: 'offset_out_of_range',
          recovery: { hint: expect.stringMatching(/offset 0.*5/s) },
        },
      });
    });
  });
});
