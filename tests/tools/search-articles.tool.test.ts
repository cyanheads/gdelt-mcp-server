/**
 * @fileoverview Tests for gdelt_search_articles tool.
 * @module tests/tools/search-articles.tool.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
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
  });

  it('populates enrichment with query echo and total count', async () => {
    const ctx = createMockContext({ errors: gdeltSearchArticles.errors });
    const input = gdeltSearchArticles.input.parse({ query: 'bird flu' });
    await gdeltSearchArticles.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBe('bird flu');
    expect(enrichment.totalCount).toBe(1);
  });

  it('populates enrichment with timespan when provided', async () => {
    const svc = {
      searchArticles: vi.fn().mockResolvedValue({ articles: [ARTICLE], totalReturned: 1 }),
    } as unknown as docServiceModule.GdeltDocService;
    vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue(svc);

    const ctx = createMockContext({ errors: gdeltSearchArticles.errors });
    const input = gdeltSearchArticles.input.parse({ query: 'test', timespan: '7d' });
    await gdeltSearchArticles.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.timespan).toBe('7d');
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
    const output = { articles: [ARTICLE] };
    const blocks = gdeltSearchArticles.format!(output);
    expect(blocks).toHaveLength(1);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain(ARTICLE.url);
    expect(text).toContain(ARTICLE.title);
    expect(text).toContain(ARTICLE.domain);
    expect(text).toContain(ARTICLE.sourcecountry);
    expect(text).toContain(ARTICLE.language);
    expect(text).toContain(ARTICLE.seendate);
  });

  it('handles sparse article (no socialimage) without error', () => {
    const sparse = { ...ARTICLE };
    // socialimage omitted
    const output = { articles: [sparse] };
    const blocks = gdeltSearchArticles.format!(output);
    expect(blocks).toHaveLength(1);
  });

  it('sets cap-hit notice when returned articles equal maxRecords', async () => {
    const maxRecords = 3;
    const articles = Array.from({ length: maxRecords }, (_, i) => ({
      ...ARTICLE,
      url: `https://example.com/a${i}`,
    }));
    vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
      searchArticles: vi.fn().mockResolvedValue({ articles, totalReturned: maxRecords }),
    } as unknown as docServiceModule.GdeltDocService);

    const ctx = createMockContext({ errors: gdeltSearchArticles.errors });
    const input = gdeltSearchArticles.input.parse({ query: 'test', maxRecords });
    await gdeltSearchArticles.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toMatch(/cap reached/);
  });

  it('does not set notice when returned articles are below maxRecords', async () => {
    const ctx = createMockContext({ errors: gdeltSearchArticles.errors });
    const input = gdeltSearchArticles.input.parse({ query: 'bird flu', maxRecords: 10 });
    // mock returns 1 article, maxRecords is 10
    await gdeltSearchArticles.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.notice).toBeUndefined();
  });
});
