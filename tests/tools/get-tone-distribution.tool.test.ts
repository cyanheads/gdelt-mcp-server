/**
 * @fileoverview Tests for gdelt_get_tone_distribution tool.
 * @module tests/tools/get-tone-distribution.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gdeltGetToneDistribution } from '@/mcp-server/tools/definitions/get-tone-distribution.tool.js';
import * as docServiceModule from '@/services/gdelt/gdelt-doc-service.js';

const BINS = [
  { bin: -5, count: 20, articles: [{ url: 'https://a.com/1', title: 'Negative Article' }] },
  { bin: 0, count: 30, articles: [{ url: 'https://a.com/2', title: 'Neutral Article' }] },
  { bin: 3, count: 10, articles: [{ url: 'https://a.com/3', title: 'Positive Article' }] },
];

describe('gdeltGetToneDistribution', () => {
  beforeEach(() => {
    vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
      getToneDistribution: vi.fn().mockResolvedValue(BINS),
    } as unknown as docServiceModule.GdeltDocService);
  });

  it('returns histogram with summary statistics', async () => {
    const ctx = createMockContext({ errors: gdeltGetToneDistribution.errors });
    const input = gdeltGetToneDistribution.input.parse({ query: 'climate' });
    const result = await gdeltGetToneDistribution.handler(input, ctx);
    expect(result.histogram).toHaveLength(3);
    expect(result.summary.peakNegativeBin).toBe(-5);
    expect(result.summary.peakPositiveBin).toBe(3);
    expect(result.summary.neutralPct).toBeGreaterThan(0);
  });

  it('populates enrichment with query echo and total article count', async () => {
    const ctx = createMockContext({ errors: gdeltGetToneDistribution.errors });
    const input = gdeltGetToneDistribution.input.parse({ query: 'climate' });
    await gdeltGetToneDistribution.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBe('climate');
    // Total count = 20 + 30 + 10 = 60
    expect(enrichment.totalCount).toBe(60);
  });

  /**
   * The echo is unconditional on the input being present, so before the pairing guard it
   * confirmed a boundary that applyTimeRange had silently dropped. The guard now rejects
   * first, making the echo accurate by construction.
   */
  it('never echoes an unpaired boundary — the pairing guard rejects before enrichment', async () => {
    const ctx = createMockContext({ errors: gdeltGetToneDistribution.errors });
    const input = gdeltGetToneDistribution.input.parse({
      query: 'climate',
      endDatetime: '20240131235959',
    });
    await expect(gdeltGetToneDistribution.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_date_range' },
    });
    const enrichment = getEnrichment(ctx);
    expect(enrichment.startDatetime).toBeUndefined();
    expect(enrichment.endDatetime).toBeUndefined();
  });

  it('computes neutralPct from bins -2 to +2', async () => {
    const ctx = createMockContext({ errors: gdeltGetToneDistribution.errors });
    const input = gdeltGetToneDistribution.input.parse({ query: 'test' });
    const result = await gdeltGetToneDistribution.handler(input, ctx);
    // bin 0 has count 30, total is 60 — bin 0 is within -2..+2
    expect(result.summary.neutralPct).toBe(50);
  });

  it('throws no_tone_data when service returns empty array', async () => {
    vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
      getToneDistribution: vi.fn().mockResolvedValue([]),
    } as unknown as docServiceModule.GdeltDocService);

    const ctx = createMockContext({ errors: gdeltGetToneDistribution.errors });
    const input = gdeltGetToneDistribution.input.parse({ query: 'noresults' });
    await expect(gdeltGetToneDistribution.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_tone_data' },
    });
  });

  it('handles bins with no negative values gracefully', async () => {
    vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
      getToneDistribution: vi.fn().mockResolvedValue([
        { bin: 2, count: 10, articles: [] },
        { bin: 5, count: 15, articles: [] },
      ]),
    } as unknown as docServiceModule.GdeltDocService);

    const ctx = createMockContext({ errors: gdeltGetToneDistribution.errors });
    const input = gdeltGetToneDistribution.input.parse({ query: 'positive topic' });
    const result = await gdeltGetToneDistribution.handler(input, ctx);
    // No negative bins — peakNegativeBin falls back to 0
    expect(result.summary.peakNegativeBin).toBe(0);
    expect(result.summary.peakPositiveBin).toBe(5);
  });

  it('formats output with histogram bins and summary', () => {
    const output = {
      histogram: BINS,
      summary: { peakNegativeBin: -5, peakPositiveBin: 3, neutralPct: 50 },
    };
    const blocks = gdeltGetToneDistribution.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('-5');
    expect(text).toContain('3');
    expect(text).toContain('50%');
    expect(text).toContain('Negative Article');
    expect(text).toContain('Positive Article');
  });

  /**
   * content[] must carry every representative article structuredContent carries. The fixture
   * gives each bin more articles than the previous 2-per-bin render cap and asserts each URL
   * individually — "each bin includes representative article URLs" is the tool's stated value,
   * so a bin rendering only its count is a lossy text surface.
   */
  it('renders every article in every bin, past the previous 2-per-bin cap', () => {
    const histogram = Array.from({ length: 4 }, (_, b) => ({
      bin: b - 2,
      count: 6,
      articles: Array.from({ length: 6 }, (_, i) => ({
        url: `https://news.example/bin${b}/article${i}`,
        title: `Bin ${b} Headline ${i}`,
      })),
    }));
    const blocks = gdeltGetToneDistribution.format!({
      histogram,
      summary: { peakNegativeBin: -2, peakPositiveBin: 1, neutralPct: 25 },
    });
    const text = (blocks[0] as { text: string }).text;
    for (const bin of histogram) {
      for (const a of bin.articles) {
        expect(text).toContain(a.url);
        expect(text).toContain(a.title);
      }
    }
  });

  it('renders every bin label and count', () => {
    const histogram = [
      { bin: -7, count: 11, articles: [] },
      { bin: 0, count: 22, articles: [] },
      { bin: 9, count: 33, articles: [] },
    ];
    const blocks = gdeltGetToneDistribution.format!({
      histogram,
      summary: { peakNegativeBin: -7, peakPositiveBin: 9, neutralPct: 40 },
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('**Bin -7:** 11 articles');
    expect(text).toContain('**Bin 0:** 22 articles');
    expect(text).toContain('**Bin +9:** 33 articles');
  });
});
