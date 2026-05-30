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
  });
});
