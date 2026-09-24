/**
 * @fileoverview Tests for gdelt_search_articles tool.
 * @module tests/tools/search-articles.tool.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gdeltSearchArticles } from '@/mcp-server/tools/definitions/search-articles.tool.js';
import * as docServiceModule from '@/services/gdelt/gdelt-doc-service.js';
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

    it('takes the uncut ceiling branch when a full 250 of compact articles fits the budget', async () => {
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

    /**
     * A full 250 no longer arrives in one response — it is cut to the byte budget and handed
     * back with a continuation — so the uncut cap-hit notice says so instead of implying that
     * raising maxRecords returns every article at once.
     */
    it('tells callers a larger page is cut to the byte budget rather than returned whole', async () => {
      const articles = Array.from({ length: 75 }, (_, i) => ({
        ...ARTICLE,
        url: `https://example.com/a${i}`,
      }));
      mockArticles(articles);
      const result = await runToolContract(gdeltSearchArticles, { query: 'test', maxRecords: 75 });
      const notice = (result.structuredContent as { notice?: string }).notice ?? '';
      expect(notice).toMatch(/48,000-byte/);
      expect(notice).toMatch(/continuation/);
      expect(result.structuredContent).not.toHaveProperty('withheldCount');
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

  describe('48,000-byte response budget', () => {
    const WINDOW = { startDatetime: '20240110000000', endDatetime: '20240120000000' };

    it('keeps a full 250-article page of long multi-byte records within 50,000 bytes on each surface', async () => {
      const fetched = Array.from({ length: 250 }, (_, i) => longArticle(i, seenAt(NOON, -i * 60)));
      mockArticles(fetched);
      const result = await runToolContract(gdeltSearchArticles, {
        query: 'climate',
        maxRecords: 250,
        sort: 'dateDesc',
        ...WINDOW,
      });
      const sc = result.structuredContent as ArticlePage;
      const emitted = sc.articles.length;
      expect(utf8(JSON.stringify(sc))).toBeLessThanOrEqual(50_000);
      expect(utf8(contentText(result))).toBeLessThanOrEqual(50_000);
      expect(emitted).toBeGreaterThan(0);
      expect(sc.articles).toEqual(fetched.slice(0, emitted));
      expect(sc.totalCount).toBe(emitted);
      expect(sc.withheldCount).toBe(250 - emitted);
      const charges = fetched.map(chargeOf);
      expect(sum(charges.slice(0, emitted))).toBeLessThanOrEqual(BUDGET);
      expect(sum(charges.slice(0, emitted + 1))).toBeGreaterThan(BUDGET);
      // Both surfaces carry the same articles: content[] is exactly format() of the emitted set.
      expect((result.content[0] as { text: string }).text).toBe(
        (gdeltSearchArticles.format!({ articles: sc.articles })[0] as { text: string }).text,
      );
      expect(sc.notice).toMatch(new RegExp(`Emitted ${emitted} of 250 articles`));
      expect(sc.notice).not.toMatch(/[Rr]aise maxRecords|[Ii]ncrease maxRecords/);
    });

    it('leaves a page that fits unchanged: no size notice, no withheldCount, no continuation', async () => {
      const fetched = Array.from({ length: 74 }, (_, i) => ({
        ...ARTICLE,
        url: `https://example.com/a${i}`,
      }));
      mockArticles(fetched);
      const result = await runToolContract(gdeltSearchArticles, { query: 'bird flu' });
      expect(result.structuredContent).toEqual({
        articles: fetched,
        effectiveQuery: 'bird flu',
        totalCount: 74,
      });
    });

    it('emits every article of a page whose charges total exactly 48,000 bytes', async () => {
      const fetched = exactFitArticles(100, 480);
      mockArticles(fetched);
      const result = await runToolContract(gdeltSearchArticles, { query: 'x', maxRecords: 250 });
      expect(sum(fetched.map(chargeOf))).toBe(BUDGET);
      const sc = result.structuredContent as ArticlePage;
      expect(sc.articles).toHaveLength(100);
      expect(sc).not.toHaveProperty('withheldCount');
      expect(sc).not.toHaveProperty('notice');
    });

    it('withholds the article that takes the page one byte over the budget', async () => {
      const fetched = exactFitArticles(100, 480);
      const last = fetched[99]!;
      fetched[99] = { ...last, title: `${last.title}!` };
      mockArticles(fetched);
      const result = await runToolContract(gdeltSearchArticles, { query: 'x', maxRecords: 250 });
      const sc = result.structuredContent as ArticlePage;
      expect(sc.articles).toHaveLength(99);
      expect(sc.withheldCount).toBe(1);
    });

    it('emits an article larger than the whole budget alone, with the cut signal', async () => {
      const giant = { ...longArticle(0, seenAt(NOON, 0)), title: 'a'.repeat(60_000) };
      mockArticles([giant, longArticle(1, seenAt(NOON, -60)), longArticle(2, seenAt(NOON, -120))]);
      const dated = await runToolContract(gdeltSearchArticles, {
        query: 'x',
        sort: 'dateDesc',
        ...WINDOW,
      });
      const sc = dated.structuredContent as ArticlePage;
      expect(sc.articles).toEqual([giant]);
      expect(sc.withheldCount).toBe(2);
      expect(sc.notice).toMatch(/Emitted 1 of 3 articles/);
      // The withheld articles are a minute and two earlier: skipping past the giant's second
      // reaches them.
      expect(sc.continuationWindows).toEqual([
        { startDatetime: WINDOW.startDatetime, endDatetime: '20240115115959' },
      ]);
      expect(sc.notice).toMatch(/articles from that second not emitted here cannot be reached/);

      const ranked = await runToolContract(gdeltSearchArticles, { query: 'x', ...WINDOW });
      expect((ranked.structuredContent as ArticlePage).continuationWindows).toHaveLength(2);
    });

    it.each(['relevance', 'hybridRel', 'toneDesc', 'toneAsc'] as const)(
      'hands back the #21 halves for a %s cut, naming N of M and the sort',
      async (sort) => {
        mockArticles(Array.from({ length: 250 }, (_, i) => longArticle(i, seenAt(NOON, -i))));
        const result = await runToolContract(gdeltSearchArticles, {
          query: 'x',
          maxRecords: 250,
          sort,
          ...WINDOW,
        });
        const sc = result.structuredContent as ArticlePage;
        expect(sc.continuationWindows).toEqual([
          { startDatetime: '20240110000000', endDatetime: '20240115000000' },
          { startDatetime: '20240114235959', endDatetime: '20240120000000' },
        ]);
        expect(sc.notice).toMatch(new RegExp(`Emitted ${sc.articles.length} of 250 articles`));
        expect(sc.notice).toContain(`Sort ${sort} has no resume point`);
        expect(sc.notice).not.toMatch(/[Rr]aise maxRecords|[Ii]ncrease maxRecords/);
      },
    );

    it.each([
      ['dateDesc', -60],
      ['dateAsc', 60],
    ] as const)('resumes a %s cut from the last emitted article', async (sort, step) => {
      mockArticles(Array.from({ length: 250 }, (_, i) => longArticle(i, seenAt(NOON, step * i))));
      const result = await runToolContract(gdeltSearchArticles, {
        query: 'x',
        maxRecords: 250,
        sort,
        ...WINDOW,
      });
      const sc = result.structuredContent as ArticlePage;
      const lastMs = seendateMs(sc.articles.at(-1)!.seendate);
      expect(sc.continuationWindows).toEqual([
        sort === 'dateDesc'
          ? { startDatetime: WINDOW.startDatetime, endDatetime: gdeltAt(lastMs + 1000) }
          : { startDatetime: gdeltAt(lastMs - 1000), endDatetime: WINDOW.endDatetime },
      ]);
      expect(sc.notice).toMatch(/de-duplicate by url/);
      expect(sc.notice).toMatch(/maxRecords is already at its 250 ceiling/);
      expect(sc.notice).not.toMatch(/[Rr]aise maxRecords|[Ii]ncrease maxRecords/);
    });

    /**
     * DOC seendates sit on 15-minute boundaries, so the first page of a busy dateDesc query
     * commonly shares one seendate. Only the withheld articles at that second are out of reach;
     * every earlier bucket is reachable by skipping past it.
     */
    it('skips past a shared seendate to the earlier buckets, and reaches them', async () => {
      const shared = Array.from({ length: 120 }, (_, i) => longArticle(i, seenAt(NOON, 0)));
      const earlier = Array.from({ length: 130 }, (_, i) =>
        longArticle(200 + i, seenAt(NOON, -900 * (1 + Math.floor(i / 10)))),
      );
      useDocUpstream([...shared, ...earlier], 'exclusive');
      const base = { query: 'x', maxRecords: 250, sort: 'dateDesc' as const };
      const result = await runToolContract(gdeltSearchArticles, { ...base, ...WINDOW });
      const sc = result.structuredContent as ArticlePage;
      expect(sc.articles.every((a) => a.seendate === '20240115T120000Z')).toBe(true);
      expect(sc.continuationWindows).toEqual([
        { startDatetime: WINDOW.startDatetime, endDatetime: '20240115115959' },
      ]);
      expect(sc.notice).toContain(
        'Every emitted article is timestamped within a second of 20240115T120000Z',
      );
      expect(sc.notice).toMatch(/every earlier article/);

      const next = await runToolContract(
        gdeltSearchArticles,
        gdeltSearchArticles.input.parse({ ...base, ...sc.continuationWindows![0] }),
      );
      const followUp = (next.structuredContent as ArticlePage).articles;
      expect(followUp.length).toBeGreaterThan(0);
      expect(followUp.every((a) => earlier.some((e) => e.url === a.url))).toBe(true);
    });

    it('says the rest is unreachable when every fetched article shares the second and the cap was not hit', async () => {
      mockArticles(Array.from({ length: 200 }, (_, i) => longArticle(i, seenAt(NOON, 0))));
      const result = await runToolContract(gdeltSearchArticles, {
        query: 'x',
        maxRecords: 250,
        sort: 'dateDesc',
        ...WINDOW,
      });
      const sc = result.structuredContent as ArticlePage;
      expect(sc.withheldCount).toBeGreaterThan(0);
      expect(sc).not.toHaveProperty('continuationWindows');
      expect(sc.notice).toMatch(/cannot be reached by narrowing the date window/);
    });

    it('says the rest is unreachable when the window past the shared second would be empty', async () => {
      mockArticles(Array.from({ length: 250 }, (_, i) => longArticle(i, seenAt(NOON, 0))));
      const result = await runToolContract(gdeltSearchArticles, {
        query: 'x',
        maxRecords: 250,
        sort: 'dateDesc',
        startDatetime: '20240115120000',
        endDatetime: '20240116000000',
      });
      const sc = result.structuredContent as ArticlePage;
      expect(sc).not.toHaveProperty('continuationWindows');
      expect(sc.notice).toMatch(/cannot be reached by narrowing the date window/);
    });

    it('gives the resume timestamp to pair with the other boundary when no window is known', async () => {
      mockArticles(Array.from({ length: 250 }, (_, i) => longArticle(i, seenAt(NOON, i * 60))));
      const result = await runToolContract(gdeltSearchArticles, {
        query: 'x',
        maxRecords: 250,
        sort: 'dateAsc',
      });
      const sc = result.structuredContent as ArticlePage;
      const lastMs = seendateMs(sc.articles.at(-1)!.seendate);
      expect(sc).not.toHaveProperty('continuationWindows');
      expect(sc.notice).toContain(`startDatetime ${gdeltAt(lastMs - 1000)}`);
      expect(sc.notice).toMatch(/paired with an endDatetime/);
    });

    /**
     * Follow the continuation to the end: each resume window goes back through the input
     * schema and is cut again, DOC timestamps sit on 15-minute boundaries so several articles
     * share every resume second, and every call must emit articles no earlier call did.
     */
    it.each([
      ['dateDesc', 'exclusive'],
      ['dateDesc', 'inclusive'],
      ['dateDesc', 'bucket'],
      ['dateAsc', 'exclusive'],
      ['dateAsc', 'inclusive'],
      ['dateAsc', 'bucket'],
    ] as const)(
      'walks a %s continuation to completion against %s boundaries',
      async (sort, boundaries) => {
        // Heavier buckets under `bucket`: a widened boundary re-returns a whole neighboring
        // bucket, enough to fill the budget before any new article if it were not dropped.
        const perBucket = boundaries === 'bucket' ? 30 : 5;
        const all = Array.from({ length: 600 }, (_, i) =>
          longArticle(i, seenAt('2024-01-15T00:00:00Z', Math.floor(i / perBucket) * 900)),
        );
        useDocUpstream(all, boundaries);
        let input = gdeltSearchArticles.input.parse({
          query: 'x',
          maxRecords: 250,
          sort,
          ...WINDOW,
        });
        const seen = new Set<string>();
        let calls = 0;
        for (;;) {
          const result = await runToolContract(gdeltSearchArticles, input);
          calls++;
          const sc = result.structuredContent as ArticlePage;
          const before = seen.size;
          for (const a of sc.articles) seen.add(a.url);
          expect(seen.size).toBeGreaterThan(before);
          if (!sc.continuationWindows) {
            expect(sc).not.toHaveProperty('withheldCount');
            break;
          }
          expect(sc.continuationWindows).toHaveLength(1);
          input = gdeltSearchArticles.input.parse({ ...input, ...sc.continuationWindows[0] });
          expect(calls).toBeLessThan(100);
        }
        expect(calls).toBeGreaterThan(2);
        expect(seen.size).toBe(600);
      },
    );

    it('reaches every article under relevance by splitting cut windows until each fits', async () => {
      const all = Array.from({ length: 600 }, (_, i) =>
        longArticle(i, seenAt('2024-01-15T00:00:00Z', Math.floor(i / 5) * 900)),
      );
      useDocUpstream(all, 'exclusive');
      const queue = [WINDOW];
      const seen = new Set<string>();
      let calls = 0;
      while (queue.length > 0) {
        const window = queue.shift()!;
        const input = gdeltSearchArticles.input.parse({ query: 'x', maxRecords: 250, ...window });
        const result = await runToolContract(gdeltSearchArticles, input);
        calls++;
        const sc = result.structuredContent as ArticlePage;
        for (const a of sc.articles) seen.add(a.url);
        if (sc.continuationWindows) queue.push(...sc.continuationWindows);
        else expect(sc).not.toHaveProperty('withheldCount');
        expect(calls).toBeLessThan(500);
      }
      expect(seen.size).toBe(600);
    });
  });

  /**
   * DOC boundary behavior is unmeasured, so articles GDELT returns from outside an explicit
   * window are dropped before the budget — the drop never removes an article inside the
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
      expect(sc.notice).toMatch(
        /GDELT returned 2 articles dated outside 20240115000000–20240115120000; they were dropped/,
      );
      expect(sc.notice).toMatch(/not a sign of missing results/);
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

// ─── Fixtures and fakes ───────────────────────────────────────────────────────

const BUDGET = 48_000;
const NOON = '2024-01-15T12:00:00Z';
const HEADING = '## GDELT Article Search';

type Article = typeof ARTICLE & { socialimage?: string };
type ArticlePage = {
  articles: Article[];
  totalCount: number;
  withheldCount?: number;
  notice?: string;
  continuationWindows?: Array<{ startDatetime: string; endDatetime: string }>;
};

function utf8(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function sum(values: number[]): number {
  return values.reduce((total, v) => total + v, 0);
}

/** What one article adds to each surface, measured through the tool's own format(). */
function chargeOf(article: Article): number {
  const text = (gdeltSearchArticles.format!({ articles: [article] })[0] as { text: string }).text;
  return Math.max(utf8(JSON.stringify(article)) + 1, utf8(text) - utf8(HEADING));
}

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

function gdeltAt(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace(/[-:T]/g, '');
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

/** `count` articles each charged exactly `charge` bytes, found by padding the title. */
function exactFitArticles(count: number, charge: number): Article[] {
  return Array.from({ length: count }, (_, i) => {
    const base = { ...ARTICLE, url: `https://example.com/a${String(i).padStart(3, '0')}` };
    for (let pad = 0; pad < charge; pad++) {
      const article = { ...base, title: `t${'x'.repeat(pad)}` };
      if (chargeOf(article) === charge) return article;
    }
    throw new Error(`no padding gives a ${charge}-byte article`);
  });
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
