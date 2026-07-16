/**
 * @fileoverview Tests for gdelt_get_coverage_breakdown tool.
 * @module tests/tools/get-coverage-breakdown.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gdeltGetCoverageBreakdown } from '@/mcp-server/tools/definitions/get-coverage-breakdown.tool.js';
import * as docServiceModule from '@/services/gdelt/gdelt-doc-service.js';

const SERIES = [
  {
    label: 'United States',
    data: [
      { date: '2024-01-01', value: 5.0 },
      { date: '2024-01-02', value: 3.0 },
    ],
  },
  {
    label: 'China',
    data: [
      { date: '2024-01-01', value: 2.0 },
      { date: '2024-01-02', value: 1.5 },
    ],
  },
];

describe('gdeltGetCoverageBreakdown', () => {
  beforeEach(() => {
    vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
      getBreakdown: vi.fn().mockResolvedValue(SERIES),
    } as unknown as docServiceModule.GdeltDocService);
  });

  it('returns breakdown by country', async () => {
    const ctx = createMockContext({ errors: gdeltGetCoverageBreakdown.errors });
    const input = gdeltGetCoverageBreakdown.input.parse({
      query: 'pandemic',
      breakdownBy: 'country',
    });
    const result = await gdeltGetCoverageBreakdown.handler(input, ctx);
    expect(result.topSeries).toHaveLength(2);
  });

  it('populates enrichment with query echo, breakdownBy, and total series count', async () => {
    const ctx = createMockContext({ errors: gdeltGetCoverageBreakdown.errors });
    const input = gdeltGetCoverageBreakdown.input.parse({
      query: 'pandemic',
      breakdownBy: 'country',
    });
    await gdeltGetCoverageBreakdown.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBe('pandemic');
    expect(enrichment.breakdownBy).toBe('country');
    expect(enrichment.totalCount).toBe(2);
  });

  it('returns breakdown by language', async () => {
    const ctx = createMockContext({ errors: gdeltGetCoverageBreakdown.errors });
    const input = gdeltGetCoverageBreakdown.input.parse({ query: 'flu', breakdownBy: 'language' });
    const result = await gdeltGetCoverageBreakdown.handler(input, ctx);
    expect(result.topSeries).toHaveLength(2);
  });

  it('sorts topSeries by total volume descending', async () => {
    const ctx = createMockContext({ errors: gdeltGetCoverageBreakdown.errors });
    const input = gdeltGetCoverageBreakdown.input.parse({ query: 'test', breakdownBy: 'country' });
    const result = await gdeltGetCoverageBreakdown.handler(input, ctx);
    // US total = 8.0, China total = 3.5 — US should come first
    expect(result.topSeries[0]?.label).toBe('United States');
    expect(result.topSeries[1]?.label).toBe('China');
  });

  it('aggregates remaining series into otherAggregated when more than 10 series', async () => {
    const manySeries = Array.from({ length: 12 }, (_, i) => ({
      label: `Country${i}`,
      data: [{ date: '2024-01-01', value: 12 - i }],
    }));
    vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
      getBreakdown: vi.fn().mockResolvedValue(manySeries),
    } as unknown as docServiceModule.GdeltDocService);

    const ctx = createMockContext({ errors: gdeltGetCoverageBreakdown.errors });
    const input = gdeltGetCoverageBreakdown.input.parse({
      query: 'global',
      breakdownBy: 'country',
    });
    const result = await gdeltGetCoverageBreakdown.handler(input, ctx);
    expect(result.topSeries).toHaveLength(10);
    expect(result.otherAggregated).toBeDefined();
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(12);
  });

  /**
   * The echo is unconditional on the input being present, so before the pairing guard it
   * confirmed a boundary that applyTimeRange had silently dropped. The guard now rejects
   * first, making the echo accurate by construction.
   */
  it('never echoes an unpaired boundary — the pairing guard rejects before enrichment', async () => {
    const ctx = createMockContext({ errors: gdeltGetCoverageBreakdown.errors });
    const input = gdeltGetCoverageBreakdown.input.parse({
      query: 'global',
      breakdownBy: 'country',
      startDatetime: '20240101000000',
    });
    await expect(gdeltGetCoverageBreakdown.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_date_range' },
    });
    const enrichment = getEnrichment(ctx);
    expect(enrichment.startDatetime).toBeUndefined();
    expect(enrichment.endDatetime).toBeUndefined();
  });

  it('omits otherAggregated when all series fit in top 10', async () => {
    const ctx = createMockContext({ errors: gdeltGetCoverageBreakdown.errors });
    const input = gdeltGetCoverageBreakdown.input.parse({ query: 'test', breakdownBy: 'country' });
    const result = await gdeltGetCoverageBreakdown.handler(input, ctx);
    expect(result.otherAggregated).toBeUndefined();
  });

  it('throws no_breakdown_data when service returns empty array', async () => {
    vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
      getBreakdown: vi.fn().mockResolvedValue([]),
    } as unknown as docServiceModule.GdeltDocService);

    const ctx = createMockContext({ errors: gdeltGetCoverageBreakdown.errors });
    const input = gdeltGetCoverageBreakdown.input.parse({
      query: 'noresults',
      breakdownBy: 'language',
    });
    await expect(gdeltGetCoverageBreakdown.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_breakdown_data' },
    });
  });

  it('formats output with series labels and peaks', () => {
    const output = {
      dateResolution: 'day' as const,
      topSeries: SERIES,
    };
    const blocks = gdeltGetCoverageBreakdown.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('United States');
    expect(text).toContain('China');
    // Peak data point for US is 5.0
    expect(text).toContain('5.000');
  });

  it('formats otherAggregated when present', () => {
    const output = {
      dateResolution: 'day' as const,
      topSeries: SERIES,
      otherAggregated: [{ date: '2024-01-01', value: 1.0 }],
    };
    const blocks = gdeltGetCoverageBreakdown.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Other');
  });

  /**
   * content[] must carry every point structuredContent carries. Previously only each series'
   * total/peak was rendered, so a text-surface client saw an aggregate derived from the points
   * but never the points themselves. Every date/value is asserted individually.
   */
  it('renders every data point of every topSeries', () => {
    const topSeries = [
      {
        label: 'United States',
        data: Array.from({ length: 15 }, (_, i) => ({
          date: `2024-03-${String(i + 1).padStart(2, '0')}`,
          value: (i + 1) / 4,
        })),
      },
      {
        label: 'China',
        data: Array.from({ length: 15 }, (_, i) => ({
          date: `2024-03-${String(i + 1).padStart(2, '0')}`,
          value: (i + 1) / 16,
        })),
      },
    ];
    const blocks = gdeltGetCoverageBreakdown.format!({ dateResolution: 'day', topSeries });
    const text = (blocks[0] as { text: string }).text;
    for (const s of topSeries) {
      for (const d of s.data) expect(text).toContain(`- ${d.date}: ${d.value.toFixed(3)}`);
    }
  });

  it('renders every point of the otherAggregated bucket, not just its total and peak', () => {
    const otherAggregated = Array.from({ length: 12 }, (_, i) => ({
      date: `2024-04-${String(i + 1).padStart(2, '0')}`,
      value: (i + 1) / 3,
    }));
    const blocks = gdeltGetCoverageBreakdown.format!({
      dateResolution: 'day',
      topSeries: SERIES,
      otherAggregated,
    });
    const text = (blocks[0] as { text: string }).text;
    for (const d of otherAggregated) expect(text).toContain(`- ${d.date}: ${d.value.toFixed(3)}`);
  });

  /**
   * The values are normalized shares of media output, which is why small media markets can
   * outrank large ones. The text surface must say so — an agent reading only content[] would
   * otherwise have no way to interpret the ranking.
   */
  it('discloses in format output that values are normalized, not article counts', () => {
    const blocks = gdeltGetCoverageBreakdown.format!({
      dateResolution: 'day',
      topSeries: SERIES,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('normalized');
    expect(text).toContain('not an article count');
  });
});
