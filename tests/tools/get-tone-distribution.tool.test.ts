/**
 * @fileoverview Tests for gdelt_get_tone_distribution tool.
 * @module tests/tools/get-tone-distribution.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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
    expect(result.query).toBe('climate');
    expect(result.histogram).toHaveLength(3);
    expect(result.summary.peakNegativeBin).toBe(-5);
    expect(result.summary.peakPositiveBin).toBe(3);
    expect(result.summary.neutralPct).toBeGreaterThan(0);
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
      query: 'climate',
      histogram: BINS,
      summary: { peakNegativeBin: -5, peakPositiveBin: 3, neutralPct: 50 },
    };
    const blocks = gdeltGetToneDistribution.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('climate');
    expect(text).toContain('-5');
    expect(text).toContain('3');
    expect(text).toContain('50%');
    expect(text).toContain('Negative Article');
    expect(text).toContain('Positive Article');
  });

  it('formats output with notice when present', () => {
    const output = {
      query: 'test',
      histogram: BINS,
      summary: { peakNegativeBin: -5, peakPositiveBin: 3, neutralPct: 50 },
      notice: 'No data found',
    };
    const blocks = gdeltGetToneDistribution.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('No data found');
  });
});
