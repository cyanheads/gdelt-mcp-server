/**
 * @fileoverview Tests for gdelt_get_tv_trending tool.
 * @module tests/tools/get-tv-trending.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gdeltGetTvTrending } from '@/mcp-server/tools/definitions/get-tv-trending.tool.js';
import * as tvServiceModule from '@/services/gdelt/gdelt-tv-service.js';

const TOPICS = [
  { label: 'Ukraine', score: 8.5 },
  { label: 'inflation', score: 6.2 },
  { label: 'elections', score: 4.1 },
];

describe('gdeltGetTvTrending', () => {
  beforeEach(() => {
    vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
      getTvTrending: vi.fn().mockResolvedValue(TOPICS),
    } as unknown as tvServiceModule.GdeltTvService);
  });

  it('returns trending topics sorted by score descending', async () => {
    const ctx = createMockContext({ errors: gdeltGetTvTrending.errors });
    const input = gdeltGetTvTrending.input.parse({});
    const result = await gdeltGetTvTrending.handler(input, ctx);
    expect(result.topics).toHaveLength(3);
    expect(result.topics[0]?.label).toBe('Ukraine');
    expect(result.topics[0]?.score).toBe(8.5);
    expect(result.totalCount).toBe(3);
  });

  it('sorts topics even when service returns them out of order', async () => {
    vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
      getTvTrending: vi.fn().mockResolvedValue([
        { label: 'elections', score: 4.1 },
        { label: 'Ukraine', score: 8.5 },
        { label: 'inflation', score: 6.2 },
      ]),
    } as unknown as tvServiceModule.GdeltTvService);

    const ctx = createMockContext({ errors: gdeltGetTvTrending.errors });
    const input = gdeltGetTvTrending.input.parse({});
    const result = await gdeltGetTvTrending.handler(input, ctx);
    expect(result.topics[0]?.label).toBe('Ukraine');
    expect(result.topics[1]?.label).toBe('inflation');
  });

  it('throws no_trending when service returns empty array', async () => {
    vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
      getTvTrending: vi.fn().mockResolvedValue([]),
    } as unknown as tvServiceModule.GdeltTvService);

    const ctx = createMockContext({ errors: gdeltGetTvTrending.errors });
    const input = gdeltGetTvTrending.input.parse({});
    await expect(gdeltGetTvTrending.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_trending' },
    });
  });

  it('formats output with all topic labels and scores', () => {
    const output = { topics: TOPICS, totalCount: 3 };
    const blocks = gdeltGetTvTrending.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('3');
    expect(text).toContain('Ukraine');
    expect(text).toContain('8.50');
    expect(text).toContain('inflation');
    expect(text).toContain('elections');
    expect(text).toContain('October 2024');
  });

  it('truncates to top 50 in format output and shows remainder count', () => {
    const manyTopics = Array.from({ length: 55 }, (_, i) => ({
      label: `topic${i}`,
      score: 55 - i,
    }));
    const output = { topics: manyTopics, totalCount: 55 };
    const blocks = gdeltGetTvTrending.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('5 more topics');
  });
});
