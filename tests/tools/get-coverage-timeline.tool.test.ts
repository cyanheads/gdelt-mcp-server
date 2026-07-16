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

  it('echoes startDatetime/endDatetime in enrichment when provided', async () => {
    const ctx = createMockContext({ errors: gdeltGetCoverageTimeline.errors });
    const input = gdeltGetCoverageTimeline.input.parse({
      query: 'pandemic',
      mode: 'volume',
      startDatetime: '20240101000000',
      endDatetime: '20240131235959',
    });
    await gdeltGetCoverageTimeline.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.startDatetime).toBe('20240101000000');
    expect(enrichment.endDatetime).toBe('20240131235959');
  });

  it('omits date echo from enrichment when dates are not provided', async () => {
    const ctx = createMockContext({ errors: gdeltGetCoverageTimeline.errors });
    const input = gdeltGetCoverageTimeline.input.parse({ query: 'pandemic', mode: 'volume' });
    await gdeltGetCoverageTimeline.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.startDatetime).toBeUndefined();
    expect(enrichment.endDatetime).toBeUndefined();
  });

  /**
   * The echo is unconditional on the input being present, so before the pairing guard it
   * confirmed a boundary that applyTimeRange had silently dropped. The guard now rejects
   * first, making the echo accurate by construction.
   */
  it('never echoes an unpaired boundary — the pairing guard rejects before enrichment', async () => {
    const ctx = createMockContext({ errors: gdeltGetCoverageTimeline.errors });
    const input = gdeltGetCoverageTimeline.input.parse({
      query: 'pandemic',
      mode: 'volume',
      startDatetime: '20240101000000',
    });
    await expect(gdeltGetCoverageTimeline.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_date_range' },
    });
    const enrichment = getEnrichment(ctx);
    expect(enrichment.startDatetime).toBeUndefined();
    expect(enrichment.endDatetime).toBeUndefined();
  });

  /**
   * content[] must carry every point structuredContent carries. The fixture is larger than
   * the previous 10-point render cap, and every date/value is asserted individually — a
   * summary marker (count, peak) passing is not evidence the series survived the render.
   */
  it('renders every data point in format output, past the previous 10-point cap', () => {
    const data = Array.from({ length: 25 }, (_, i) => ({
      date: `2024-02-${String(i + 1).padStart(2, '0')}`,
      value: (i + 1) / 8,
    }));
    const blocks = gdeltGetCoverageTimeline.format!({
      dateResolution: 'day',
      series: [{ label: 'Volume Intensity', data }],
    });
    const text = (blocks[0] as { text: string }).text;
    for (const d of data) expect(text).toContain(`- ${d.date}: ${d.value.toFixed(3)}`);
    expect(text).not.toContain('more points');
  });

  it('renders every point across multiple series', () => {
    const blocks = gdeltGetCoverageTimeline.format!({
      dateResolution: 'day',
      series: [
        {
          label: 'Volume Intensity',
          data: [
            { date: '2024-01-01', value: 1.111 },
            { date: '2024-01-02', value: 2.222 },
          ],
        },
        {
          label: 'Average Tone',
          data: [
            { date: '2024-01-01', value: -3.333 },
            { date: '2024-01-02', value: -4.444 },
          ],
        },
      ],
    });
    const text = (blocks[0] as { text: string }).text;
    for (const v of ['1.111', '2.222', '-3.333', '-4.444']) expect(text).toContain(v);
    expect(text).toContain('Volume Intensity');
    expect(text).toContain('Average Tone');
  });

  /**
   * The per-point article list stays capped at ARTICLES_PER_POINT while every point renders
   * (see the constant's rationale — a full render is ~450 KB of links). The cap is deliberate,
   * not silent: each point renders its true upstream article count, so the gap between the
   * count and the links shown is visible on the text surface. Tracked for a retrieval path.
   */
  it('discloses the true article count per point while capping rendered links at 3', () => {
    const articles = Array.from({ length: 8 }, (_, i) => ({
      url: `https://news.example/${i}`,
      title: `Headline ${i}`,
    }));
    const blocks = gdeltGetCoverageTimeline.format!({
      dateResolution: 'hour',
      series: [
        {
          label: 'Volume Intensity',
          data: [{ date: '2024-01-01T00:00:00Z', value: 2.5, articles }],
        },
      ],
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('(8 articles)');
    expect(text).toContain('Headline 0');
    expect(text).toContain('Headline 2');
    expect(text).not.toContain('Headline 3');
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
