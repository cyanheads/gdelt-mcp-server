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
   * The per-point article list stays capped at ARTICLES_PER_POINT by default while every point
   * renders (see the constant's rationale — rendering all of them measures 566 KB of links at
   * the documented maximum). The cap is neither silent nor a dead end: each point renders its
   * true upstream article count *and* how many links it showed, and `points` lifts the cap.
   */
  it('discloses both the true article count and how many links it showed when capping', () => {
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
    expect(text).toContain('(8 articles, 3 shown)');
    expect(text).toContain('Headline 0');
    expect(text).toContain('Headline 2');
    expect(text).not.toContain('Headline 3');
    // The withheld five need a stated route, not just a count.
    expect(text).toContain('points:');
  });

  it('does not claim links were withheld when every article fit under the cap', () => {
    const blocks = gdeltGetCoverageTimeline.format!({
      dateResolution: 'hour',
      series: [
        {
          label: 'Volume Intensity',
          data: [
            {
              date: '2024-01-01T00:00:00Z',
              value: 2.5,
              articles: [{ url: 'https://news.example/0', title: 'Headline 0' }],
            },
          ],
        },
      ],
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('(1 articles)');
    expect(text).not.toContain('shown');
  });

  /**
   * Point expansion. structuredContent always carried every reference; format() capped them
   * at 3 with no way to ask for the rest, so a content[]-only client could see that 8 articles
   * drove a spike and reach exactly 3 of them. `points` is that missing route.
   */
  describe('point expansion', () => {
    const ARTICLES = Array.from({ length: 8 }, (_, i) => ({
      url: `https://news.example/${i}`,
      title: `Headline ${i}`,
    }));
    const SPIKE_SERIES = [
      {
        label: 'Volume Intensity',
        data: [
          { date: '2024-01-01T00:00:00Z', value: 2.5, articles: ARTICLES },
          { date: '2024-01-01T01:00:00Z', value: 0.5, articles: ARTICLES },
        ],
      },
    ];

    beforeEach(() => {
      vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
        getTimeline: vi.fn().mockResolvedValue(SPIKE_SERIES),
      } as unknown as docServiceModule.GdeltDocService);
    });

    it('renders every article of a named point while other points stay capped', () => {
      const blocks = gdeltGetCoverageTimeline.format!({
        dateResolution: 'hour',
        series: SPIKE_SERIES,
        expandedPoints: ['2024-01-01T00:00:00Z'],
      });
      const text = (blocks[0] as { text: string }).text;
      // The expanded point reaches every article — including the five past the cap.
      for (const a of ARTICLES) expect(text).toContain(`[${a.title}](${a.url})`);
      // …and the point that was not named still shows 3 of its 8.
      expect(text).toContain('(8 articles, 3 shown)');
      expect(text).toContain('**Fully expanded timesteps:** 2024-01-01T00:00:00Z');
    });

    it('echoes points into expandedPoints so format() can act on the selection', async () => {
      const ctx = createMockContext({ errors: gdeltGetCoverageTimeline.errors });
      const input = gdeltGetCoverageTimeline.input.parse({
        query: 'pandemic',
        mode: 'volume_with_articles',
        points: ['2024-01-01T01:00:00Z'],
      });
      const result = await gdeltGetCoverageTimeline.handler(input, ctx);
      expect(result.expandedPoints).toEqual(['2024-01-01T01:00:00Z']);
    });

    it('omits expandedPoints when points is not supplied', async () => {
      const ctx = createMockContext({ errors: gdeltGetCoverageTimeline.errors });
      const input = gdeltGetCoverageTimeline.input.parse({
        query: 'pandemic',
        mode: 'volume_with_articles',
      });
      const result = await gdeltGetCoverageTimeline.handler(input, ctx);
      expect(result.expandedPoints).toBeUndefined();
    });

    it('rejects a date matching no timestep rather than expanding nothing in silence', async () => {
      const ctx = createMockContext({ errors: gdeltGetCoverageTimeline.errors });
      const input = gdeltGetCoverageTimeline.input.parse({
        query: 'pandemic',
        mode: 'volume_with_articles',
        points: ['2024-06-01T00:00:00Z'],
      });
      const err = await gdeltGetCoverageTimeline.handler(input, ctx).catch((e: unknown) => e);
      expect(err).toMatchObject({
        data: { reason: 'unknown_point', unknownPoints: ['2024-06-01T00:00:00Z'] },
      });
      const hint: string = (err as { data: { recovery: { hint: string } } }).data.recovery.hint;
      expect(hint).toContain('2024-01-01T00:00:00Z');
      expect(hint).toContain('2024-01-01T01:00:00Z');
    });
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
