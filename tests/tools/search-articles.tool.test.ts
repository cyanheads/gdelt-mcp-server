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

  /**
   * Cap-hit overflow at the schema ceiling. The notice used to say "Increase maxRecords up to
   * 250" unconditionally — including at maxRecords: 250, where it instructed the caller to
   * raise the value already in use. GDELT has no cursor, so the only real route past 250 is a
   * narrower date window; these cases pin that the ceiling branch says so and hands back the
   * exact windows to use.
   */
  describe('overflow at the 250 ceiling', () => {
    const CEILING = 250;

    function mockFullPage() {
      const articles = Array.from({ length: CEILING }, (_, i) => ({
        ...ARTICLE,
        url: `https://example.com/a${i}`,
      }));
      vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
        searchArticles: vi.fn().mockResolvedValue({ articles, totalReturned: CEILING }),
      } as unknown as docServiceModule.GdeltDocService);
    }

    async function runAtCeiling(extra: Record<string, unknown>) {
      mockFullPage();
      const ctx = createMockContext({ errors: gdeltSearchArticles.errors });
      const input = gdeltSearchArticles.input.parse({
        query: 'test',
        maxRecords: CEILING,
        ...extra,
      });
      await gdeltSearchArticles.handler(input, ctx);
      return getEnrichment(ctx);
    }

    it('never tells the caller to raise maxRecords once it is already at 250', async () => {
      const enrichment = await runAtCeiling({
        startDatetime: '20240101000000',
        endDatetime: '20240131000000',
      });
      expect(enrichment.notice).not.toMatch(/[Ii]ncrease maxRecords/);
      expect(enrichment.notice).toMatch(/ceiling/);
    });

    it('hands back the window halved, overlapping by a second so nothing falls through', async () => {
      const enrichment = await runAtCeiling({
        startDatetime: '20240101000000',
        endDatetime: '20240103000000',
      });
      expect(enrichment.continuationWindows).toEqual([
        { startDatetime: '20240101000000', endDatetime: '20240102000000' },
        { startDatetime: '20240101235959', endDatetime: '20240103000000' },
      ]);
      expect(enrichment.notice).toMatch(/de-duplicate/);
    });

    it('derives the continuation window from a timespan when no explicit dates were pinned', async () => {
      const enrichment = await runAtCeiling({ timespan: '7d' });
      const windows = enrichment.continuationWindows as Array<{ startDatetime: string }>;
      expect(windows).toHaveLength(2);
      expect(windows[0]?.startDatetime).toMatch(/^\d{14}$/);
    });

    it('says how to pin a window when the call never set one, and emits no windows', async () => {
      const enrichment = await runAtCeiling({});
      expect(enrichment.continuationWindows).toBeUndefined();
      expect(enrichment.notice).toMatch(/startDatetime\/endDatetime/);
    });

    /**
     * The honest terminal case: a window already at GDELT's resolution still full at 250 means
     * the remainder is unreachable. Saying nothing would imply the 250 were complete.
     */
    it('discloses that the rest is unreachable when the window cannot be narrowed further', async () => {
      const enrichment = await runAtCeiling({
        startDatetime: '20240101000000',
        endDatetime: '20240101000002',
      });
      expect(enrichment.continuationWindows).toBeUndefined();
      expect(enrichment.notice).toMatch(/not retrievable/);
    });

    it('still recommends raising maxRecords below the ceiling', async () => {
      const articles = Array.from({ length: 75 }, (_, i) => ({
        ...ARTICLE,
        url: `https://example.com/a${i}`,
      }));
      vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
        searchArticles: vi.fn().mockResolvedValue({ articles, totalReturned: 75 }),
      } as unknown as docServiceModule.GdeltDocService);

      const ctx = createMockContext({ errors: gdeltSearchArticles.errors });
      const input = gdeltSearchArticles.input.parse({ query: 'test', maxRecords: 75 });
      await gdeltSearchArticles.handler(input, ctx);
      const enrichment = getEnrichment(ctx);
      expect(enrichment.notice).toMatch(/Increase maxRecords up to 250/);
      expect(enrichment.continuationWindows).toBeUndefined();
    });
  });
});
