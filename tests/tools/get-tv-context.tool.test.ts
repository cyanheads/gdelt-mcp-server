/**
 * @fileoverview Tests for gdelt_get_tv_context tool.
 * @module tests/tools/get-tv-context.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gdeltGetTvContext } from '@/mcp-server/tools/definitions/get-tv-context.tool.js';
import * as tvServiceModule from '@/services/gdelt/gdelt-tv-service.js';

const CONTEXT_RESULT = {
  words: [
    { label: 'pandemic', score: 100 },
    { label: 'vaccine', score: 75 },
    { label: 'health', score: 50 },
  ],
  clipsAnalyzed: 42,
};

describe('gdeltGetTvContext', () => {
  beforeEach(() => {
    vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
      getTvContext: vi.fn().mockResolvedValue(CONTEXT_RESULT),
    } as unknown as tvServiceModule.GdeltTvService);
  });

  it('returns context words sorted by score descending', async () => {
    const ctx = createMockContext({ errors: gdeltGetTvContext.errors });
    const input = gdeltGetTvContext.input.parse({ query: 'pandemic' });
    const result = await gdeltGetTvContext.handler(input, ctx);
    expect(result.words).toHaveLength(3);
    expect(result.words[0]?.label).toBe('pandemic');
    expect(result.words[0]?.score).toBe(100);
  });

  it('populates enrichment with query echo and clips analyzed count when provided', async () => {
    const ctx = createMockContext({ errors: gdeltGetTvContext.errors });
    const input = gdeltGetTvContext.input.parse({ query: 'pandemic' });
    await gdeltGetTvContext.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBe('pandemic');
    expect(enrichment.totalCount).toBe(42);
  });

  it('omits totalCount from enrichment when service returns no clipsAnalyzed', async () => {
    vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
      getTvContext: vi.fn().mockResolvedValue({
        words: [{ label: 'test', score: 100 }],
        // clipsAnalyzed intentionally absent — upstream field missing
      }),
    } as unknown as tvServiceModule.GdeltTvService);

    const ctx = createMockContext({ errors: gdeltGetTvContext.errors });
    const input = gdeltGetTvContext.input.parse({ query: 'test' });
    await gdeltGetTvContext.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBe('test');
    expect(enrichment.totalCount).toBeUndefined();
  });

  it('sorts words by score even when service returns them out of order', async () => {
    vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
      getTvContext: vi.fn().mockResolvedValue({
        words: [
          { label: 'health', score: 50 },
          { label: 'pandemic', score: 100 },
          { label: 'vaccine', score: 75 },
        ],
        clipsAnalyzed: 10,
      }),
    } as unknown as tvServiceModule.GdeltTvService);

    const ctx = createMockContext({ errors: gdeltGetTvContext.errors });
    const input = gdeltGetTvContext.input.parse({ query: 'test' });
    const result = await gdeltGetTvContext.handler(input, ctx);
    expect(result.words[0]?.label).toBe('pandemic');
    expect(result.words[1]?.label).toBe('vaccine');
    expect(result.words[2]?.label).toBe('health');
  });

  it('throws no_context when service returns empty words', async () => {
    vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
      getTvContext: vi.fn().mockResolvedValue({ words: [], clipsAnalyzed: 0 }),
    } as unknown as tvServiceModule.GdeltTvService);

    const ctx = createMockContext({ errors: gdeltGetTvContext.errors });
    const input = gdeltGetTvContext.input.parse({ query: 'noresults' });
    await expect(gdeltGetTvContext.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_context' },
    });
  });

  it('includes resolved date range in no_context error when timespan is provided', async () => {
    vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
      getTvContext: vi.fn().mockResolvedValue({ words: [] }),
    } as unknown as tvServiceModule.GdeltTvService);

    const ctx = createMockContext({ errors: gdeltGetTvContext.errors });
    const input = gdeltGetTvContext.input.parse({ query: 'noresults', timespan: '7d' });
    const err = await gdeltGetTvContext.handler(input, ctx).catch((e: unknown) => e);
    expect(err).toMatchObject({ data: { reason: 'no_context' } });
    // recovery hint should contain the resolved date range
    const hint: string = (err as { data: { recovery: { hint: string } } }).data.recovery.hint;
    // e.g. 'Timespan "7d" resolved to 2026-06-01 – 2026-06-08'
    expect(hint).toMatch(/Timespan "7d" resolved to \d{4}-\d{2}-\d{2} – \d{4}-\d{2}-\d{2}/);
  });

  it('passes startDatetime/endDatetime through to the service', async () => {
    const mockGetTvContext = vi.fn().mockResolvedValue(CONTEXT_RESULT);
    vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
      getTvContext: mockGetTvContext,
    } as unknown as tvServiceModule.GdeltTvService);

    const ctx = createMockContext({ errors: gdeltGetTvContext.errors });
    const input = gdeltGetTvContext.input.parse({
      query: 'test',
      startDatetime: '20230101000000',
      endDatetime: '20231231235959',
    });
    await gdeltGetTvContext.handler(input, ctx);
    expect(mockGetTvContext).toHaveBeenCalledWith(
      expect.objectContaining({
        startDatetime: '20230101000000',
        endDatetime: '20231231235959',
      }),
      ctx,
    );
  });

  it('formats output with word count and top terms', () => {
    const output = { words: CONTEXT_RESULT.words };
    const blocks = gdeltGetTvContext.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('100.0');
    expect(text).toContain('vaccine');
    expect(text).toContain('health');
  });

  /**
   * content[] must carry every term structuredContent carries — a text-surface client
   * that reads only the rendered block must not see a shorter list than a structured one.
   * Asserted per-element against a fixture larger than any previous render cap.
   */
  it('renders every term in format output, past the previous 50-term cap', () => {
    const manyWords = Array.from({ length: 60 }, (_, i) => ({ label: `word${i}`, score: 60 - i }));
    const blocks = gdeltGetTvContext.format!({ words: manyWords });
    const text = (blocks[0] as { text: string }).text;
    for (const w of manyWords) expect(text).toContain(`**${w.label}**`);
    expect(text).not.toContain('more terms');
  });

  it('renders each term score, not just the label', () => {
    const words = [
      { label: 'alpha', score: 91.5 },
      { label: 'beta', score: 42.25 },
      { label: 'gamma', score: 7.75 },
    ];
    const blocks = gdeltGetTvContext.format!({ words });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('91.5');
    expect(text).toContain('42.3');
    expect(text).toContain('7.8');
  });
});
