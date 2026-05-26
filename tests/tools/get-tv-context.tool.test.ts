/**
 * @fileoverview Tests for gdelt_get_tv_context tool.
 * @module tests/tools/get-tv-context.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
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
    expect(result.query).toBe('pandemic');
    expect(result.words).toHaveLength(3);
    expect(result.words[0]?.label).toBe('pandemic');
    expect(result.words[0]?.score).toBe(100);
    expect(result.clipsAnalyzed).toBe(42);
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

  it('formats output with query, clips analyzed, and top terms', () => {
    const output = {
      query: 'pandemic',
      words: CONTEXT_RESULT.words,
      clipsAnalyzed: 42,
    };
    const blocks = gdeltGetTvContext.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('pandemic');
    expect(text).toContain('42');
    expect(text).toContain('100.0');
    expect(text).toContain('vaccine');
    expect(text).toContain('health');
  });

  it('truncates to top 50 terms in format output', () => {
    const manyWords = Array.from({ length: 60 }, (_, i) => ({ label: `word${i}`, score: 60 - i }));
    const output = { query: 'test', words: manyWords, clipsAnalyzed: 100 };
    const blocks = gdeltGetTvContext.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('10 more terms');
  });
});
