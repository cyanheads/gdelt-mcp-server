/**
 * @fileoverview Tests for gdelt_search_articles tool.
 * @module tests/tools/search-articles.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gdeltSearchArticles } from '@/mcp-server/tools/definitions/search-articles.tool.js';
import * as docServiceModule from '@/services/gdelt/gdelt-doc-service.js';

const ARTICLE = {
  url: 'https://example.com/article',
  title: 'Test Article',
  seendate: '20240101T120000Z',
  domain: 'example.com',
  language: 'English',
  sourcecountry: 'United States',
};

describe('gdeltSearchArticles', () => {
  beforeEach(() => {
    vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
      searchArticles: vi.fn().mockResolvedValue({ articles: [ARTICLE], totalReturned: 1 }),
    } as unknown as docServiceModule.GdeltDocService);
  });

  it('returns articles for a valid query', async () => {
    const ctx = createMockContext({ errors: gdeltSearchArticles.errors });
    const input = gdeltSearchArticles.input.parse({ query: 'bird flu' });
    const result = await gdeltSearchArticles.handler(input, ctx);
    expect(result.articles).toHaveLength(1);
    expect(result.articles[0]?.url).toBe(ARTICLE.url);
    expect(result.totalReturned).toBe(1);
    expect(result.query).toBe('bird flu');
  });

  it('passes timespan to the service', async () => {
    const svc = {
      searchArticles: vi.fn().mockResolvedValue({ articles: [ARTICLE], totalReturned: 1 }),
    } as unknown as docServiceModule.GdeltDocService;
    vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue(svc);

    const ctx = createMockContext({ errors: gdeltSearchArticles.errors });
    const input = gdeltSearchArticles.input.parse({ query: 'test', timespan: '7d' });
    await gdeltSearchArticles.handler(input, ctx);
    expect(svc.searchArticles).toHaveBeenCalledWith(
      expect.objectContaining({ timespan: '7d' }),
      ctx,
    );
  });

  it('throws no_articles when service returns empty list', async () => {
    vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
      searchArticles: vi.fn().mockResolvedValue({ articles: [], totalReturned: 0 }),
    } as unknown as docServiceModule.GdeltDocService);

    const ctx = createMockContext({ errors: gdeltSearchArticles.errors });
    const input = gdeltSearchArticles.input.parse({ query: 'nonexistent-xyzzy-query' });
    await expect(gdeltSearchArticles.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'no_articles' },
    });
  });

  it('propagates service errors', async () => {
    vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
      searchArticles: vi.fn().mockRejectedValue(new Error('GDELT unavailable')),
    } as unknown as docServiceModule.GdeltDocService);

    const ctx = createMockContext({ errors: gdeltSearchArticles.errors });
    const input = gdeltSearchArticles.input.parse({ query: 'test' });
    await expect(gdeltSearchArticles.handler(input, ctx)).rejects.toThrow();
  });

  it('formats output with all required fields', () => {
    const output = {
      articles: [ARTICLE],
      totalReturned: 1,
      query: 'bird flu',
      timespan: '7d',
    };
    const blocks = gdeltSearchArticles.format!(output);
    expect(blocks).toHaveLength(1);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('bird flu');
    expect(text).toContain(ARTICLE.url);
    expect(text).toContain(ARTICLE.title);
    expect(text).toContain(ARTICLE.domain);
    expect(text).toContain(ARTICLE.sourcecountry);
    expect(text).toContain(ARTICLE.language);
    expect(text).toContain(ARTICLE.seendate);
    expect(text).toContain('7d');
    expect(text).toContain('1');
  });

  it('formats output without timespan when omitted', () => {
    const output = {
      articles: [ARTICLE],
      totalReturned: 1,
      query: 'bird flu',
    };
    const blocks = gdeltSearchArticles.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).not.toContain('Timespan:');
  });

  it('handles sparse article (no socialimage) without error', () => {
    const sparse = { ...ARTICLE };
    // socialimage omitted
    const output = { articles: [sparse], totalReturned: 1, query: 'test' };
    const blocks = gdeltSearchArticles.format!(output);
    expect(blocks).toHaveLength(1);
  });
});
