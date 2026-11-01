/**
 * @fileoverview Tests for gdelt_search_articles tool.
 * @module tests/tools/search-articles.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gdeltSearchArticles } from '@/mcp-server/tools/definitions/search-articles.tool.js';
import * as docServiceModule from '@/services/gdelt/gdelt-doc-service.js';
import { initGdeltDocService } from '@/services/gdelt/gdelt-doc-service.js';
import { disposeGdeltPacer, initGdeltPacer } from '@/services/gdelt/gdelt-pacer.js';
import {
  disposeGdeltResponseCache,
  initGdeltResponseCache,
} from '@/services/gdelt/gdelt-response-cache.js';
import type { MirrorResult } from '@/services/gkg-mirror/types.js';
import {
  attachMirror,
  DOC_429_DETAIL,
  MIRROR_DIVERGENCE_SENTENCE,
  MIRROR_NO_MATCH_SENTENCE,
  MIRROR_NOT_READY,
  MIRROR_STANDS_IN_FOR,
  mirrorAnswers,
  OVERLOAD_RETRY_SENTENCE,
  PARTIAL_COVERAGE,
  PARTIAL_COVERAGE_LINE,
  RATE_LIMIT_HINT,
  ROUTED_WINDOW,
  refusedAttemptsLines,
  SOURCE_LINE,
  useRoutedDoc,
} from '../helpers/doc-source-fakes.js';
import { contentText, hrefFor, literalHtml, renderMarkdown } from './markdown-render.js';

const ARTICLE = {
  url: 'https://example.com/article',
  title: 'Test Article',
  seendate: '20240101T120000Z',
  domain: 'example.com',
  language: 'English',
  sourcecountry: 'United States',
};

describe('gdeltSearchArticles', () => {
  it('preserves the default request count', async () => {
    mockArticles([]);
    const result = await runToolContract(gdeltSearchArticles, { query: 'climate' });
    expect(result.isError).toBeFalsy();
    expect(gdeltSearchArticles.input.parse({ query: 'climate' }).maxRecords).toBe(75);
    expect(docServiceModule.getGdeltDocService().searchArticles).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ maxRecords: 75 }),
      expect.anything(),
    );
  });

  it('returns every same-second record on both surfaces', async () => {
    const fetched = Array.from({ length: 250 }, (_, i) => ({
      ...ARTICLE,
      url: `https://example.com/retained-${i}`,
      title: `record ${i} ${'ü'.repeat(500)}`,
      seendate: '20240101T120000Z',
    }));
    mockArticles(fetched);
    const result = await runToolContract(gdeltSearchArticles, {
      query: 'climate',
      maxRecords: 250,
      sort: 'dateDesc',
      startDatetime: '20240101000000',
      endDatetime: '20240102000000',
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as { articles: typeof fetched; totalCount: number };
    expect(sc.articles).toEqual(fetched);
    expect(sc.totalCount).toBe(250);
    expect(sc).not.toHaveProperty('withheldCount');
    const text = contentText(result);
    expect(text.match(/^### /gm)).toHaveLength(250);
    for (let i = 0; i < 250; i++) expect(text).toContain(`retained-${i}`);
  });
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

  /**
   * A query GDELT answers with no articles is a normal search outcome: the declared shape with
   * an empty list, the usual echoes, and a notice carrying the broadening guidance.
   */
  describe('zero-match answer', () => {
    beforeEach(() => {
      vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
        searchArticles: vi.fn().mockResolvedValue({ articles: [], totalReturned: 0 }),
      } as unknown as docServiceModule.GdeltDocService);
    });

    it('returns an empty article list with echoes and a broadening notice', async () => {
      const result = await runToolContract(gdeltSearchArticles, {
        query: 'nonexistent-xyzzy-query',
        timespan: '7d',
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({
        articles: [],
        effectiveQuery: 'nonexistent-xyzzy-query',
        totalCount: 0,
        timespan: '7d',
        notice: expect.stringMatching(/No articles matched "nonexistent-xyzzy-query".*[Bb]roaden/),
      });
      const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
      expect(text).toContain('No articles returned.');
      expect(text).toContain('**0 total**');
      expect(text.match(/^> /gm)).toHaveLength(1);
      expect((result.structuredContent as { notice: string }).notice).toMatch(
        /extend the timespan/,
      );
    });

    it('tells a caller who pinned explicit dates to widen that window, not the timespan', async () => {
      const result = await runToolContract(gdeltSearchArticles, {
        query: 'nonexistent-xyzzy-query',
        startDatetime: '20240101000000',
        endDatetime: '20240102000000',
      });
      const notice = (result.structuredContent as { notice: string }).notice;
      expect(notice).toMatch(/widen the 20240101000000–20240102000000 window/);
      expect(notice).not.toMatch(/timespan/);
    });

    it('never raises a cap-hit notice alongside the empty one', async () => {
      const result = await runToolContract(gdeltSearchArticles, { query: 'x', maxRecords: 1 });
      const notice = (result.structuredContent as { notice?: string }).notice ?? '';
      expect(notice).not.toMatch(/cap/);
    });

    it('no longer declares a no_articles contract entry', () => {
      expect(gdeltSearchArticles.errors?.map((e) => e.reason)).not.toContain('no_articles');
    });

    it('describes the empty case on the notice field', () => {
      expect(gdeltSearchArticles.enrichment?.notice?.description).toMatch(/no articles matched/i);
    });

    /**
     * The drop notice fires on an uncut page too, and a mirror answer always carries one, so the
     * absence condition names both.
     */
    it('counts an out-of-window drop and a mirror answer among the cases the notice is present for', () => {
      expect(gdeltSearchArticles.enrichment?.notice?.description).toMatch(
        /Absent when a non-empty result set from the DOC API is below the cap and no article was dropped as out of window\.$/,
      );
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
      expect(enrichment.notice).not.toMatch(/[Ii]ncrease maxRecords|[Rr]aise maxRecords/);
      expect(enrichment.notice).toMatch(/ceiling/);
    });

    it('takes the ceiling branch when a full 250 of compact articles are returned', async () => {
      const enrichment = await runAtCeiling({
        startDatetime: '20240101000000',
        endDatetime: '20240131000000',
      });
      expect(enrichment.totalCount).toBe(CEILING);
      expect(enrichment.withheldCount).toBeUndefined();
      expect(enrichment.notice).toMatch(
        /^Returned 250 articles — maxRecords is already at its 250 ceiling/,
      );
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
      expect(enrichment.notice).toMatch(/Raise maxRecords \(up to 250\)/);
      expect(enrichment.continuationWindows).toBeUndefined();
    });

    it('offers a larger upstream count without implying local record loss', async () => {
      mockArticles(Array.from({ length: 75 }, (_, i) => longArticle(i, seenAt(NOON, 0))));
      const result = await runToolContract(gdeltSearchArticles, {
        query: 'climate',
        maxRecords: 75,
      });
      const sc = result.structuredContent as ArticlePage;
      expect(sc.articles).toHaveLength(75);
      expect(sc.notice).toMatch(/Raise maxRecords/);
      expect(sc.notice).not.toMatch(/byte|withheld/);
      expect(sc).not.toHaveProperty('withheldCount');
    });
  });

  /**
   * Upstream text reaches content[] as literal text: every upstream value in format() goes
   * through the shared escaper, while structuredContent keeps the raw value. Plain values
   * render exactly as they did before escaping existed.
   */
  describe('Markdown escaping at the content[] boundary', () => {
    const HOSTILE = {
      url: 'https://example.com/a_(b)_c?x=1',
      title: '<b>A &amp; B</b> [x](y) *_z_* `code` Learn C# #',
      seendate: '20240101T120000Z',
      domain: 'snake_case.example',
      language: 'English\r\nFrench',
      sourcecountry: 'United *States*',
      socialimage: 'https://example.com/img_(1).jpg',
    };

    it('renders plain upstream values byte-identically to the pre-escaping format()', () => {
      const blocks = gdeltSearchArticles.format!({
        articles: [{ ...ARTICLE, socialimage: 'https://example.com/img.jpg' }],
      });
      expect((blocks[0] as { text: string }).text).toBe(
        '## GDELT Article Search\n\n### Test Article\n**URL:** https://example.com/article\n' +
          '**Source:** example.com | **Country:** United States | **Language:** English\n' +
          '**Date:** 20240101T120000Z\n**Image:** https://example.com/img.jpg',
      );
    });

    it('escapes markup in every upstream field of content[] and leaves structuredContent raw', async () => {
      mockArticles([HOSTILE]);
      const result = await runToolContract(gdeltSearchArticles, { query: 'x' });
      expect((result.structuredContent as { articles: unknown[] }).articles).toEqual([HOSTILE]);
      expect((result.content[0] as { text: string }).text).toBe(
        [
          '## GDELT Article Search',
          '',
          String.raw`### \<b>A \&amp; B\</b> \[x\](y) \*\_z\_\* \`code\` Learn C# \#`,
          '**URL:** <https://example.com/a_(b)_c?x=1>',
          String.raw`**Source:** snake_case.example | **Country:** United \*States\* | **Language:** English French`,
          '**Date:** 20240101T120000Z',
          '**Image:** <https://example.com/img_(1).jpg>',
        ].join('\n'),
      );
    });

    /**
     * The URL and image lines share one paragraph, so without the autolink form the boundary
     * `_` of one URL pairs with the next under a renderer that does not link bare URLs.
     */
    it.each([true, false])(
      'displays each upstream value literally under a CommonMark parser (GFM autolinks: %s)',
      async (gfmAutolinks) => {
        mockArticles([HOSTILE]);
        const result = await runToolContract(gdeltSearchArticles, { query: 'x' });
        const html = renderMarkdown(contentText(result), { gfmAutolinks });
        expect(html).toContain(`<h3>${literalHtml(HOSTILE.title)}</h3>`);
        expect(html).toContain(`<strong>Country:</strong> ${literalHtml(HOSTILE.sourcecountry)}`);
        expect(html).toContain('<strong>Language:</strong> English French');
        for (const [label, url] of [
          ['URL', HOSTILE.url],
          ['Image', HOSTILE.socialimage],
        ] as const) {
          expect(html).toContain(
            `<strong>${label}:</strong> <a href="${hrefFor(url)}">${literalHtml(url)}</a>`,
          );
        }
        expect(html).not.toMatch(/<(b|i|em|code)>|<a href="y"/);
      },
    );
  });

  describe('complete fetched records', () => {
    it('returns an oversized record beside all following records', async () => {
      const fetched = [
        { ...longArticle(0, seenAt(NOON, 0)), title: 'a'.repeat(60_000) },
        longArticle(1, seenAt(NOON, 0)),
        longArticle(2, seenAt(NOON, 0)),
      ];
      mockArticles(fetched);
      const result = await runToolContract(gdeltSearchArticles, {
        query: 'climate',
        maxRecords: 250,
      });
      expect(result.isError).toBeFalsy();
      const sc = result.structuredContent as ArticlePage;
      expect(sc.articles).toEqual(fetched);
      expect(sc.totalCount).toBe(3);
      expect(sc).not.toHaveProperty('withheldCount');
      expect(sc).not.toHaveProperty('continuationWindows');
      expect(sc).not.toHaveProperty('notice');
      expect(contentText(result)).toContain('a'.repeat(60_000));
      expect(contentText(result).match(/^### /gm)).toHaveLength(3);
    });

    it.each(['dateDesc', 'dateAsc', 'relevance', 'hybridRel', 'toneDesc', 'toneAsc'] as const)(
      'returns all fetched records below the cap without a continuation under %s',
      async (sort) => {
        const fetched = Array.from({ length: 200 }, (_, i) => longArticle(i, seenAt(NOON, 0)));
        mockArticles(fetched);
        const result = await runToolContract(gdeltSearchArticles, {
          query: 'climate',
          maxRecords: 250,
          sort,
        });
        const sc = result.structuredContent as ArticlePage;
        expect(sc.articles).toEqual(fetched);
        expect(sc.totalCount).toBe(200);
        expect(sc).not.toHaveProperty('withheldCount');
        expect(sc).not.toHaveProperty('notice');
        expect(sc).not.toHaveProperty('continuationWindows');
        expect(contentText(result).match(/^### /gm)).toHaveLength(200);
      },
    );

    it.each([
      ['dateDesc', 'exclusive'],
      ['dateDesc', 'inclusive'],
      ['dateDesc', 'bucket'],
      ['dateAsc', 'exclusive'],
      ['dateAsc', 'inclusive'],
      ['dateAsc', 'bucket'],
      ['relevance', 'exclusive'],
    ] as const)('walks cap continuations under %s with %s boundaries', async (sort, boundaries) => {
      const all = Array.from({ length: 600 }, (_, i) =>
        longArticle(i, seenAt('2024-01-15T00:00:00Z', 1 + Math.floor(i / 5) * 900)),
      );
      useDocUpstream(all, boundaries);
      const search = vi.mocked(docServiceModule.getGdeltDocService().searchArticles);
      const queue = [{ startDatetime: '20240110000000', endDatetime: '20240120000000' }];
      const seen = new Set<string>();
      let calls = 0;
      while (queue.length) {
        const window = queue.shift()!;
        const result = await runToolContract(gdeltSearchArticles, {
          query: 'climate',
          maxRecords: 250,
          sort,
          ...window,
        });
        calls++;
        expect(result.isError).toBeFalsy();
        const sc = result.structuredContent as ArticlePage;
        expect(contentText(result).match(/^### /gm)?.length ?? 0).toBe(sc.articles.length);
        for (const article of sc.articles) seen.add(article.url);
        if (sc.continuationWindows) queue.push(...sc.continuationWindows);
        expect(calls).toBeLessThan(60);
      }
      expect(calls).toBeGreaterThan(3);
      expect(search).toHaveBeenCalledTimes(calls);
      expect([...seen].sort()).toEqual(all.map((a) => a.url).sort());
    });
  });

  /**
   * DOC boundary behavior is unmeasured, so articles GDELT returns from outside an explicit
   * window are dropped — the drop never removes an article inside the
   * caller's window, and it keeps a continuation walk convergent whatever DOC does at the edge.
   */
  describe('articles dated outside an explicit window', () => {
    const WINDOW = { startDatetime: '20240115000000', endDatetime: '20240115120000' };

    it('drops them from both surfaces and counts them in the notice', async () => {
      const inside = [
        longArticle(1, '20240115T114500Z'),
        longArticle(2, '20240115T000000Z'),
        longArticle(3, '20240115T120000Z'),
      ];
      const outside = [longArticle(4, '20240115T121500Z'), longArticle(5, '20240114T234500Z')];
      mockArticles([outside[0], ...inside, outside[1]]);
      const result = await runToolContract(gdeltSearchArticles, {
        query: 'x',
        sort: 'dateDesc',
        ...WINDOW,
      });
      const sc = result.structuredContent as ArticlePage;
      expect(sc.articles).toEqual(inside);
      expect(sc.totalCount).toBe(3);
      for (const article of inside) expect(contentText(result)).toContain(article.url);
      for (const article of outside) expect(contentText(result)).not.toContain(article.url);
      expect(sc.notice).toMatch(
        /GDELT returned 2 articles dated outside 20240115000000–20240115120000; they were dropped/,
      );
      expect(sc.notice).toMatch(/not a sign of missing results/);
    });

    it('detects the upstream cap before explicit-window clipping', async () => {
      const inside = longArticle(1, '20240115T114500Z');
      const outside = longArticle(2, '20240115T121500Z');
      mockArticles([inside, outside]);
      const result = await runToolContract(gdeltSearchArticles, {
        query: 'climate',
        maxRecords: 2,
        ...WINDOW,
      });
      expect(result.structuredContent).toMatchObject({ articles: [inside], totalCount: 1 });
      expect(contentText(result)).toContain('maxRecords cap reached');
      expect(contentText(result)).toContain('returned 1 article dated outside');
      expect(contentText(result)).toContain(inside.url);
      expect(contentText(result)).not.toContain(outside.url);
    });

    it('gives the empty-result guidance when every returned article is outside', async () => {
      mockArticles([longArticle(4, '20240115T121500Z')]);
      const result = await runToolContract(gdeltSearchArticles, { query: 'x', ...WINDOW });
      const sc = result.structuredContent as ArticlePage;
      expect(sc.articles).toEqual([]);
      expect(sc.notice).toMatch(/returned 1 article dated outside/);
      expect(sc.notice).toMatch(/No article was published inside the window/);
      expect(sc.notice).toMatch(/[Bb]roaden the query/);
    });

    it('drops nothing on a timespan call, whose window GDELT resolves itself', async () => {
      const article = longArticle(1, '20000101T000000Z');
      mockArticles([article]);
      const result = await runToolContract(gdeltSearchArticles, { query: 'x', timespan: '7d' });
      expect((result.structuredContent as ArticlePage).articles).toEqual([article]);
    });
  });
});

/**
 * A maxRecords above the 250 ceiling, runs exactly as a call at 250 — the same
 * upstream request, cap-hit detection, notice, and continuation — and adds a
 * `limitClamp` disclosure on both surfaces. At or below 250 nothing is disclosed.
 */
describe('gdelt_search_articles maxRecords clamp', () => {
  it('rejects above the served cap before service access when clamping is disabled', async () => {
    vi.stubEnv('GDELT_CLAMP_LIMITS', 'false');
    vi.resetModules();
    try {
      const { gdeltSearchArticles: strictTool } = await import(
        '@/mcp-server/tools/definitions/search-articles.tool.js'
      );
      const service = await import('@/services/gdelt/gdelt-doc-service.js');
      const accessor = vi.spyOn(service, 'getGdeltDocService');
      for (const maxRecords of [251, '251']) {
        const result = await runToolContract(strictTool, { query: 'climate', maxRecords } as never);
        expect(result.isError).toBe(true);
        expect(contentText(result)).toContain('maxRecords');
      }
      expect(accessor).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it.each([0, -1, 1.5, true, false])(
    'rejects invalid count %s before service access',
    async (maxRecords) => {
      const accessor = vi.spyOn(docServiceModule, 'getGdeltDocService');
      const result = await runToolContract(gdeltSearchArticles, {
        query: 'climate',
        maxRecords,
      } as never);
      expect(result.isError).toBe(true);
      expect(accessor).not.toHaveBeenCalled();
      expect(contentText(result)).toContain('maxRecords');
    },
  );

  const WINDOW = { startDatetime: '20240110000000', endDatetime: '20240120000000' };

  type Run = { result: Awaited<ReturnType<typeof runToolContract>>; sent: unknown };

  /** Run one call against a DOC stand-in that applies the maxRecords it is sent. */
  async function run(all: Article[], extra: Record<string, unknown>): Promise<Run> {
    useDocUpstream(all, 'exclusive');
    const search = vi.mocked(docServiceModule.getGdeltDocService().searchArticles);
    const result = await runToolContract(gdeltSearchArticles, {
      query: 'climate',
      ...WINDOW,
      ...extra,
    } as never);
    return { result, sent: search.mock.calls[0]?.[0].maxRecords };
  }

  /** A run's structuredContent minus `limitClamp`, and its content[] lines minus the clamp line. */
  function withoutClamp({ result }: Run) {
    const { limitClamp: _, ...rest } = result.structuredContent as Record<string, unknown>;
    const lines = contentText(result)
      .split('\n')
      .filter((line) => !line.startsWith('**Limit clamped:**'));
    return { rest, lines };
  }

  it.each([
    // Long records retain the same cap behavior as compact records.
    ['a capped dateDesc page', 'dateDesc', (i: number) => longArticle(i, seenAt(NOON, -i * 60))],
    // Compact articles: the full 250 fit, so only the at-ceiling cap notice speaks.
    [
      'a capped relevance page',
      'relevance',
      (i: number) => ({
        ...ARTICLE,
        url: `https://example.com/a${i}`,
        seendate: seenAt(NOON, -i * 60),
      }),
    ],
  ] as const)('runs %s at 251 and 2500 exactly as at 250', async (_, sort, make) => {
    const all = Array.from({ length: 400 }, (_, i) => make(i));
    const atCap = await run(all, { sort, maxRecords: 250 });
    expect(atCap.sent).toBe(250);
    expect(atCap.result.structuredContent).not.toHaveProperty('limitClamp');
    expect(contentText(atCap.result)).not.toContain('Limit clamped');
    expect((atCap.result.structuredContent as ArticlePage).notice).toMatch(
      /maxRecords is already at its 250 ceiling/,
    );

    for (const requested of [251, 2500, 250_000]) {
      const clamped = await run(all, { sort, maxRecords: requested });
      expect(clamped.sent).toBe(250);
      expect(clamped.result.structuredContent).toMatchObject({
        limitClamp: { parameter: 'maxRecords', requested, applied: 250 },
      });
      expect(contentText(clamped.result)).toContain(
        `**Limit clamped:** maxRecords ${requested} → 250 (per-call cap)`,
      );
      expect(withoutClamp(clamped)).toEqual(withoutClamp(atCap));
    }
  });

  it('clamps a numeric string past the ceiling like the number', async () => {
    const all = Array.from({ length: 300 }, (_, i) => longArticle(i, seenAt(NOON, -i * 60)));
    const clamped = await run(all, { sort: 'dateDesc', maxRecords: '251' });
    expect(clamped.sent).toBe(250);
    expect(clamped.result.isError).toBeFalsy();
    expect(clamped.result.structuredContent).toMatchObject({
      limitClamp: { parameter: 'maxRecords', requested: 251, applied: 250 },
    });
  });

  it('discloses nothing at or below the ceiling, and still discloses a clamp on an empty result', async () => {
    for (const maxRecords of [1, 75, 250]) {
      const { result, sent } = await run([longArticle(0, seenAt(NOON, 0))], { maxRecords });
      expect(sent).toBe(maxRecords);
      expect(result.structuredContent).not.toHaveProperty('limitClamp');
      expect(contentText(result)).not.toContain('Limit clamped');
    }
    const empty = await run([], { maxRecords: 2500 });
    expect(empty.result.structuredContent).toMatchObject({
      articles: [],
      notice: expect.stringMatching(/No articles matched/),
      limitClamp: { parameter: 'maxRecords', requested: 2500, applied: 250 },
    });
  });

  /**
   * The applied value reaches the DOC request itself: the real service and fetch path, with
   * only the global `fetch` stubbed.
   */
  it('sends maxrecords=250 to GDELT for a clamped call', async () => {
    vi.restoreAllMocks();
    initGdeltPacer(0);
    initGdeltResponseCache();
    initGdeltDocService(
      {} as never,
      {} as never,
      {
        baseUrl: 'https://api.gdeltproject.org/api/v2',
        requestDelayMs: 0,
      } as never,
    );
    const upstream = vi.fn(async (_url: string) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', upstream);
    try {
      const result = await runToolContract(gdeltSearchArticles, {
        query: 'climate',
        maxRecords: 2500,
      });
      expect(result.isError).toBeFalsy();
      expect(upstream).toHaveBeenCalledTimes(1);
      const url = new URL(String(upstream.mock.calls[0]?.[0]));
      expect(url.searchParams.get('maxrecords')).toBe('250');
    } finally {
      vi.unstubAllGlobals();
      disposeGdeltPacer();
      disposeGdeltResponseCache();
    }
  });
});

/** The fetch layer writes `staleResponse` on the call's ctx; the tool carries it to both surfaces. */
describe('gdelt_search_articles stale response', () => {
  it('discloses a stored answer in structuredContent and as a trailer line', async () => {
    const staleResponse = {
      fetchedAt: '2026-10-15T12:00:00.000Z',
      ageSeconds: 900,
      reason: 'gdelt_rate_limited',
    };
    vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
      searchArticles: vi.fn(async (_params, ctx: { enrich: (fields: object) => void }) => {
        ctx.enrich({ staleResponse });
        return { articles: [ARTICLE], totalReturned: 1 };
      }),
    } as unknown as docServiceModule.GdeltDocService);

    const result = await runToolContract(gdeltSearchArticles, { query: 'climate' });

    expect(result.structuredContent).toMatchObject({ articles: [ARTICLE], staleResponse });
    expect(contentText(result)).toContain(
      "**Stale response:** the refetch failed with `gdelt_rate_limited`, so this is GDELT's stored answer from 2026-10-15T12:00:00.000Z (900s old) — nothing published after that time is included.",
    );
  });
});

/**
 * The tool's wiring to the DOC source router: the real DOC service and router with only `fetch`
 * stubbed, and a fake mirror. The router's outcome table lives in doc-source-router.test.ts;
 * these prove the tool declares and renders what the router writes, and adds its own notice
 * sentences.
 */
describe('gdelt_search_articles DOC source routing', () => {
  const doc = useRoutedDoc();
  const INPUT = { query: 'climate', ...ROUTED_WINDOW };
  const DOC_ARTICLE = { ...ARTICLE, seendate: '20261031T120000Z' };
  const MIRROR_ARTICLE = {
    url: 'https://example.org/mirror',
    title: 'From the mirror',
    seendate: '20261031T113000Z',
    domain: 'example.org',
    language: 'English',
    sourcecountry: '',
  };
  const MIRROR_ARTLIST = {
    kind: 'artlist',
    result: { articles: [MIRROR_ARTICLE], totalReturned: 1 },
  } satisfies MirrorResult;
  const MIRROR_NO_ARTICLES = {
    kind: 'artlist',
    result: { articles: [], totalReturned: 0 },
  } satisfies MirrorResult;
  const EMPTY_NOTICE =
    'No articles matched "climate". Broaden the query, remove operators, widen the 20261031000000–20261101000000 window, or try synonym terms.';
  const notice = (result: { structuredContent?: unknown }) =>
    (result.structuredContent as { notice?: string }).notice;

  it('with no mirror, adds no source field and renders as before', async () => {
    doc.answerDoc({ body: { articles: [DOC_ARTICLE] } });

    const result = await runToolContract(gdeltSearchArticles, INPUT);

    expect(result.structuredContent).toEqual({
      articles: [DOC_ARTICLE],
      effectiveQuery: 'climate',
      totalCount: 1,
    });
    expect(contentText(result)).toBe(
      [
        '## GDELT Article Search',
        '',
        '### Test Article',
        '**URL:** https://example.com/article',
        '**Source:** example.com | **Country:** United States | **Language:** English',
        '**Date:** 20261031T120000Z',
        '',
        'Query: "climate"',
        '**1 total**',
      ].join('\n'),
    );
  });

  it('with no mirror, adds the overload sentence to an empty answer on both surfaces (#77)', async () => {
    doc.answerDoc({ body: {} });

    const result = await runToolContract(gdeltSearchArticles, INPUT);

    expect(notice(result)).toBe(`${EMPTY_NOTICE} ${OVERLOAD_RETRY_SENTENCE}`);
    expect(contentText(result)).toContain(`> ${EMPTY_NOTICE} ${OVERLOAD_RETRY_SENTENCE}`);
    expect(result.structuredContent).not.toHaveProperty('source');
  });

  it('marks a DOC answer doc_api on both surfaces while a mirror stands behind it', async () => {
    const mirror = attachMirror(mirrorAnswers(MIRROR_ARTLIST, 1));
    doc.answerDoc({ body: { articles: [DOC_ARTICLE] } });

    const result = await runToolContract(gdeltSearchArticles, INPUT);

    expect(result.structuredContent).toEqual({
      articles: [DOC_ARTICLE],
      effectiveQuery: 'climate',
      totalCount: 1,
      source: 'doc_api',
    });
    expect(contentText(result)).toContain(SOURCE_LINE.doc_api);
    expect(mirror.execute).not.toHaveBeenCalled();
  });

  it('answers from the mirror when DOC refuses: source, attempts, coverage, and notice on both surfaces', async () => {
    attachMirror(mirrorAnswers(MIRROR_ARTLIST, 1));
    doc.answerDoc('refuse');

    const result = await runToolContract(gdeltSearchArticles, INPUT);

    const mirrorNotice = `${MIRROR_STANDS_IN_FOR.rate_limited} ${MIRROR_DIVERGENCE_SENTENCE}`;
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      articles: [MIRROR_ARTICLE],
      effectiveQuery: 'climate',
      totalCount: 1,
      source: 'gkg_mirror',
      attempts: [
        { source: 'doc_api', outcome: 'rate_limited', detail: DOC_429_DETAIL },
        { source: 'gkg_mirror', outcome: 'answered' },
      ],
      coverage: PARTIAL_COVERAGE,
      notice: mirrorNotice,
    });
    const text = contentText(result);
    expect(text).toContain(`**URL:** ${MIRROR_ARTICLE.url}`);
    expect(text).toContain(SOURCE_LINE.gkg_mirror);
    // `**Source:**` labels the one article's domain; the provenance line reads as no article field.
    expect(text.match(/\*\*Source:\*\*/g)).toHaveLength(1);
    expect(text).toContain(refusedAttemptsLines('answered'));
    expect(text).toContain(PARTIAL_COVERAGE_LINE);
    expect(text).toContain(`> ${mirrorNotice}`);
  });

  it("keeps the mirror's own sentence, not the overload one, on a mirror answer with no match", async () => {
    attachMirror(mirrorAnswers(MIRROR_NO_ARTICLES, 0));
    doc.answerDoc('refuse');

    const result = await runToolContract(gdeltSearchArticles, INPUT);

    expect(notice(result)).toBe(
      `${EMPTY_NOTICE} ${MIRROR_STANDS_IN_FOR.rate_limited} ${MIRROR_DIVERGENCE_SENTENCE} ${MIRROR_NO_MATCH_SENTENCE}`,
    );
    expect(result.structuredContent).toMatchObject({ articles: [], source: 'gkg_mirror' });
    expect(contentText(result)).toContain(refusedAttemptsLines('empty'));
  });

  it("keeps DOC's empty answer with the overload sentence when the mirror has no match either", async () => {
    attachMirror(mirrorAnswers(MIRROR_NO_ARTICLES, 0));
    doc.answerDoc({ body: {} });

    const result = await runToolContract(gdeltSearchArticles, INPUT);

    expect(result.structuredContent).toEqual({
      articles: [],
      effectiveQuery: 'climate',
      totalCount: 0,
      source: 'doc_api',
      attempts: [
        { source: 'doc_api', outcome: 'empty' },
        { source: 'gkg_mirror', outcome: 'empty' },
      ],
      notice: `${EMPTY_NOTICE} ${OVERLOAD_RETRY_SENTENCE}`,
    });
    expect(contentText(result)).toContain('**Attempts:**\n- doc_api: empty\n- gkg_mirror: empty');
  });

  it("replaces DOC's empty answer with the mirror's match, saying why", async () => {
    attachMirror(mirrorAnswers(MIRROR_ARTLIST, 1));
    doc.answerDoc({ body: {} });

    const result = await runToolContract(gdeltSearchArticles, INPUT);

    expect(result.structuredContent).toMatchObject({
      articles: [MIRROR_ARTICLE],
      source: 'gkg_mirror',
      attempts: [
        { source: 'doc_api', outcome: 'empty' },
        { source: 'gkg_mirror', outcome: 'answered' },
      ],
      notice: `${MIRROR_STANDS_IN_FOR.empty} ${MIRROR_DIVERGENCE_SENTENCE}`,
    });
  });

  it("rejects with DOC's code, reason, and both attempts when the mirror cannot answer", async () => {
    attachMirror(mirrorAnswers(MIRROR_ARTLIST, 1), MIRROR_NOT_READY);
    doc.answerDoc('refuse');

    const result = await runToolContract(gdeltSearchArticles, INPUT);

    const hint = `${RATE_LIMIT_HINT} The local GKG mirror answers once the server operator's first sync (mirror:init) has completed.`;
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: JsonRpcErrorCode.RateLimited,
          message: `${DOC_429_DETAIL} The local GKG mirror could not answer instead: The local GKG mirror has not completed an init run.`,
          data: {
            reason: 'gdelt_rate_limited',
            retryable: true,
            attempts: [
              { source: 'doc_api', outcome: 'rate_limited', detail: DOC_429_DETAIL },
              {
                source: 'gkg_mirror',
                outcome: 'not_ready',
                detail: 'The local GKG mirror has not completed an init run.',
              },
            ],
            recovery: { hint },
          },
        },
      },
    });
    expect(contentText(result)).toContain(`Recovery: ${hint}`);
  });
});

// ─── Fixtures and fakes ───────────────────────────────────────────────────────

const NOON = '2024-01-15T12:00:00Z';

type Article = typeof ARTICLE & { socialimage?: string };
type ArticlePage = {
  articles: Article[];
  totalCount: number;
  notice?: string;
  continuationWindows?: Array<{ startDatetime: string; endDatetime: string }>;
};

/** GDELT DOC seendate (YYYYMMDDTHHMMSSZ) `seconds` after `iso`. */
function seenAt(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1000)
    .toISOString()
    .slice(0, 19)
    .replace(/[-:]/g, '')
    .concat('Z');
}

function seendateMs(seendate: string): number {
  return Date.parse(
    `${seendate.slice(0, 4)}-${seendate.slice(4, 6)}-${seendate.slice(6, 8)}T` +
      `${seendate.slice(9, 11)}:${seendate.slice(11, 13)}:${seendate.slice(13, 15)}Z`,
  );
}

/** An article with a long multi-byte title and long URLs — heavier than any live sample. */
function longArticle(i: number, seendate: string): Article {
  return {
    url: `https://news.example.org/${'section/'.repeat(20)}story-${i}?utm_source=${'x'.repeat(80)}`,
    title: `気候変動と「エネルギー転換」— Überraschende Wendung Nr. ${i} ${'ü'.repeat(60)} ${'世界'.repeat(40)}`,
    seendate,
    domain: 'news.example.org',
    language: 'Japanese',
    sourcecountry: 'Japan',
    socialimage: `https://img.example.org/${'p/'.repeat(40)}${i}.jpg`,
  };
}

/**
 * A DOC artlist stand-in. DOC's boundary behavior is unmeasured (the API rate-limited every
 * probe), so it models three readings: exclusive boundaries (as documented), inclusive, and
 * `bucket` — each boundary widened to its whole 15-minute seendate bucket, the way the TV API
 * widens to the hour. Orders by the requested sort (rank sorts are fixed shuffles) and applies
 * maxRecords.
 */
function useDocUpstream(all: Article[], boundaries: 'exclusive' | 'inclusive' | 'bucket') {
  const BUCKET = 900_000;
  const parse = (v: string) =>
    Date.parse(
      `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T${v.slice(8, 10)}:${v.slice(10, 12)}:${v.slice(12, 14)}Z`,
    );
  const within = (at: number, start: number, end: number): boolean => {
    if (boundaries === 'inclusive') return at >= start && at <= end;
    if (boundaries === 'exclusive') return at > start && at < end;
    return (
      at >= Math.floor(start / BUCKET) * BUCKET && at < Math.floor(end / BUCKET) * BUCKET + BUCKET
    );
  };
  const searchArticles = vi.fn(async (params: docServiceModule.DocSearchParams) => {
    const start = parse(params.startDatetime!);
    const end = parse(params.endDatetime!);
    const matched = all
      .map((article, index) => ({ article, index, at: seendateMs(article.seendate) }))
      .filter(({ at }) => within(at, start, end));
    if (params.sort === 'dateDesc') matched.sort((a, b) => b.at - a.at || a.index - b.index);
    else if (params.sort === 'dateAsc') matched.sort((a, b) => a.at - b.at || a.index - b.index);
    else matched.sort((a, b) => ((a.index * 7919) % 613) - ((b.index * 7919) % 613));
    const articles = matched.slice(0, params.maxRecords).map(({ article }) => article);
    return { articles, totalReturned: articles.length };
  });
  vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
    searchArticles,
  } as unknown as docServiceModule.GdeltDocService);
}

function mockArticles(articles: unknown[]) {
  vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
    searchArticles: vi.fn().mockResolvedValue({ articles, totalReturned: articles.length }),
  } as unknown as docServiceModule.GdeltDocService);
}
