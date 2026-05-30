/**
 * @fileoverview Tests for gdelt_get_coverage_timeline tool.
 * @module tests/tools/get-coverage-timeline.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gdeltGetCoverageTimeline } from '@/mcp-server/tools/definitions/get-coverage-timeline.tool.js';
import * as docServiceModule from '@/services/gdelt/gdelt-doc-service.js';

const VOLUME_SERIES = [
  {
    label: 'Volume Intensity',
    data: [
      { date: '2024-01-01T00:00:00Z', value: 0.5 },
      { date: '2024-01-02T00:00:00Z', value: 1.2 },
    ],
  },
];

const DAY_SERIES = [
  {
    label: 'Volume Intensity',
    data: [
      { date: '2024-01-01', value: 0.5 },
      { date: '2024-01-02', value: 1.2 },
    ],
  },
];

describe('gdeltGetCoverageTimeline', () => {
  beforeEach(() => {
    vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
      getTimeline: vi.fn().mockResolvedValue(VOLUME_SERIES),
    } as unknown as docServiceModule.GdeltDocService);
  });

  it('returns timeline series for volume mode', async () => {
    const ctx = createMockContext({ errors: gdeltGetCoverageTimeline.errors });
    const input = gdeltGetCoverageTimeline.input.parse({ query: 'pandemic', mode: 'volume' });
    const result = await gdeltGetCoverageTimeline.handler(input, ctx);
    expect(result.series).toHaveLength(1);
    expect(result.series[0]?.data).toHaveLength(2);
  });

  it('populates enrichment with query echo, mode, and total count', async () => {
    const ctx = createMockContext({ errors: gdeltGetCoverageTimeline.errors });
    const input = gdeltGetCoverageTimeline.input.parse({ query: 'pandemic', mode: 'volume' });
    await gdeltGetCoverageTimeline.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBe('pandemic');
    expect(enrichment.mode).toBe('volume');
    expect(enrichment.totalCount).toBe(2);
  });

  it('infers hour resolution from ISO datetime strings', async () => {
    const ctx = createMockContext({ errors: gdeltGetCoverageTimeline.errors });
    const input = gdeltGetCoverageTimeline.input.parse({ query: 'test', mode: 'volume' });
    const result = await gdeltGetCoverageTimeline.handler(input, ctx);
    expect(result.dateResolution).toBe('hour');
  });

  it('infers day resolution from date-only strings', async () => {
    vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
      getTimeline: vi.fn().mockResolvedValue(DAY_SERIES),
    } as unknown as docServiceModule.GdeltDocService);

    const ctx = createMockContext({ errors: gdeltGetCoverageTimeline.errors });
    const input = gdeltGetCoverageTimeline.input.parse({ query: 'test', mode: 'volume' });
    const result = await gdeltGetCoverageTimeline.handler(input, ctx);
    expect(result.dateResolution).toBe('day');
  });

  it('throws no_timeline_data when service returns empty series', async () => {
    vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
      getTimeline: vi.fn().mockResolvedValue([]),
    } as unknown as docServiceModule.GdeltDocService);

    const ctx = createMockContext({ errors: gdeltGetCoverageTimeline.errors });
    const input = gdeltGetCoverageTimeline.input.parse({ query: 'noresults', mode: 'volume' });
    await expect(gdeltGetCoverageTimeline.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_timeline_data' },
    });
  });

  it('throws no_timeline_data when all series have empty data arrays', async () => {
    vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
      getTimeline: vi.fn().mockResolvedValue([{ label: 'Volume Intensity', data: [] }]),
    } as unknown as docServiceModule.GdeltDocService);

    const ctx = createMockContext({ errors: gdeltGetCoverageTimeline.errors });
    const input = gdeltGetCoverageTimeline.input.parse({ query: 'noresults', mode: 'tone' });
    await expect(gdeltGetCoverageTimeline.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_timeline_data' },
    });
  });

  it('formats output with resolution, series label, and peak', () => {
    const output = {
      dateResolution: 'day' as const,
      series: DAY_SERIES,
    };
    const blocks = gdeltGetCoverageTimeline.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('day');
    expect(text).toContain('Volume Intensity');
    expect(text).toContain('1.200');
    expect(text).toContain('2024-01-02');
  });

  it('formats volume_with_articles mode including article links', () => {
    const output = {
      dateResolution: 'hour' as const,
      series: [
        {
          label: 'Volume Intensity',
          data: [
            {
              date: '2024-01-01T00:00:00Z',
              value: 2.5,
              articles: [{ url: 'https://news.com/a', title: 'Breaking News' }],
            },
          ],
        },
      ],
    };
    const blocks = gdeltGetCoverageTimeline.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Breaking News');
    expect(text).toContain('https://news.com/a');
  });
});
