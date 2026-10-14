/**
 * @fileoverview Tests for gdelt_get_tone_distribution tool.
 * @module tests/tools/get-tone-distribution.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gdeltGetToneDistribution } from '@/mcp-server/tools/definitions/get-tone-distribution.tool.js';
import * as docServiceModule from '@/services/gdelt/gdelt-doc-service.js';
import { contentText, hrefFor, literalHtml, renderMarkdown } from './markdown-render.js';

const BINS = [
  { bin: -5, count: 20, articles: [{ url: 'https://a.com/1', title: 'Negative Article' }] },
  { bin: 0, count: 30, articles: [{ url: 'https://a.com/2', title: 'Neutral Article' }] },
  { bin: 3, count: 10, articles: [{ url: 'https://a.com/3', title: 'Positive Article' }] },
];

/** Upstream bins in the output shape: each bin's referenceCount is every article it carries. */
function counted<T extends { articles: unknown[] }>(bins: T[]) {
  return bins.map((b) => ({ ...b, referenceCount: b.articles.length }));
}

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

  describe('zero-match answer', () => {
    beforeEach(() => {
      vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
        getToneDistribution: vi.fn().mockResolvedValue([]),
      } as unknown as docServiceModule.GdeltDocService);
    });

    it('returns an empty histogram with no derived summary values', async () => {
      const result = await runToolContract(gdeltGetToneDistribution, {
        query: 'noresults',
        startDatetime: '20240101000000',
        endDatetime: '20240131235959',
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({
        histogram: [],
        summary: {},
        effectiveQuery: 'noresults',
        totalCount: 0,
        startDatetime: '20240101000000',
        endDatetime: '20240131235959',
        notice: expect.stringMatching(/No tone data for "noresults".*[Bb]roaden/),
      });
      const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
      expect(text).not.toMatch(/Peak/);
      expect(text).not.toMatch(/Neutral articles/);
      expect(text).toContain('No tone bins returned.');
    });

    it('no longer declares a no_tone_data contract entry', () => {
      expect(gdeltGetToneDistribution.errors?.map((e) => e.reason)).not.toContain('no_tone_data');
    });

    it('describes the empty case on the notice field', () => {
      expect(gdeltGetToneDistribution.enrichment?.notice?.description).not.toMatch(
        /Absent on successful responses/,
      );
    });
  });

  it('omits the peak for a side with no bins rather than reporting bin 0', async () => {
    vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
      getToneDistribution: vi.fn().mockResolvedValue([
        { bin: 2, count: 10, articles: [] },
        { bin: 5, count: 15, articles: [] },
      ]),
    } as unknown as docServiceModule.GdeltDocService);

    const result = await runToolContract(gdeltGetToneDistribution, { query: 'positive topic' });
    const summary = (result.structuredContent as { summary: Record<string, number> }).summary;
    expect(summary).not.toHaveProperty('peakNegativeBin');
    expect(summary.peakPositiveBin).toBe(5);
    expect(summary.neutralPct).toBe(40);
    const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
    expect(text).not.toContain('Peak negative bin');
    expect(text).toContain('**Peak positive bin:** 5');
  });

  it('omits neutralPct when the bins carry no articles to take a share of', async () => {
    vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
      getToneDistribution: vi.fn().mockResolvedValue([{ bin: -3, count: 0, articles: [] }]),
    } as unknown as docServiceModule.GdeltDocService);

    const result = await runToolContract(gdeltGetToneDistribution, { query: 'x' });
    const summary = (result.structuredContent as { summary: Record<string, number> }).summary;
    expect(summary).not.toHaveProperty('neutralPct');
  });

  it('formats output with histogram bins and summary', () => {
    const output = {
      histogram: counted(BINS),
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
    const histogram = counted(
      Array.from({ length: 4 }, (_, b) => ({
        bin: b - 2,
        count: 6,
        articles: Array.from({ length: 6 }, (_, i) => ({
          url: `https://news.example/bin${b}/article${i}`,
          title: `Bin ${b} Headline ${i}`,
        })),
      })),
    );
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
    const histogram = counted([
      { bin: -7, count: 11, articles: [] },
      { bin: 0, count: 22, articles: [] },
      { bin: 9, count: 33, articles: [] },
    ]);
    const blocks = gdeltGetToneDistribution.format!({
      histogram,
      summary: { peakNegativeBin: -7, peakPositiveBin: 9, neutralPct: 40 },
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('**Bin -7:** 11 articles');
    expect(text).toContain('**Bin 0:** 22 articles');
    expect(text).toContain('**Bin +9:** 33 articles');
  });

  /**
   * Article titles reach content[] as literal link labels; link destinations stay unescaped
   * URLs that still parse as one destination; structuredContent keeps every raw value.
   */
  describe('Markdown escaping at the content[] boundary', () => {
    const HOSTILE_BINS = [
      {
        bin: -3,
        count: 12,
        articles: [
          { url: 'https://example.com/a_(b)_c?x=1', title: '*Grim* `news` <i>today</i>' },
          { url: 'https://example.com/a b', title: 'Plain title' },
        ],
      },
    ];

    /**
     * Plain values render unescaped. Each bin header opens with a blank line — the one layout
     * change from the pre-escaping format() (#49) — so it never folds into the previous bin's
     * article list.
     */
    it('renders plain upstream values exactly, each bin header opening its own block', () => {
      const blocks = gdeltGetToneDistribution.format!({
        histogram: counted([
          { bin: -3, count: 12, articles: [{ url: 'https://example.com/n', title: 'Grim news' }] },
          { bin: 2, count: 4, articles: [] },
        ]),
        summary: { peakNegativeBin: -3, peakPositiveBin: 2, neutralPct: 25 },
      });
      expect((blocks[0] as { text: string }).text).toBe(
        '## GDELT Tone Distribution\n**Peak negative bin:** -3\n**Peak positive bin:** 2\n' +
          '**Neutral articles (bins -2 to +2):** 25%\n\n### Histogram\n\n' +
          '**Bin -3:** 12 articles ███\n  - [Grim news](https://example.com/n)\n\n' +
          '**Bin +2:** 4 articles █',
      );
    });

    it('escapes link labels, keeps destinations whole, and leaves structuredContent raw', async () => {
      vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
        getToneDistribution: vi.fn().mockResolvedValue(HOSTILE_BINS),
      } as unknown as docServiceModule.GdeltDocService);
      const result = await runToolContract(gdeltGetToneDistribution, { query: 'x' });
      expect((result.structuredContent as { histogram: unknown }).histogram).toEqual(
        counted(HOSTILE_BINS),
      );
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain(
        String.raw`  - [\*Grim\* \`news\` \<i>today\</i>](<https://example.com/a_(b)_c?x=1>)`,
      );
      expect(text).toContain('  - [Plain title](<https://example.com/a b>)');

      const html = renderMarkdown(contentText(result));
      for (const a of HOSTILE_BINS[0]!.articles) {
        expect(html).toContain(`<a href="${hrefFor(a.url)}">${literalHtml(a.title)}</a>`);
      }
    });
  });

  /**
   * #49: a bin header directly under the previous bin's article list was folded into that
   * list's last item by CommonMark lazy continuation, and its own articles joined that list.
   */
  it.each([true, false])(
    'renders two populated bins as separate blocks, each over its own articles (GFM autolinks: %s)',
    (gfmAutolinks) => {
      const blocks = gdeltGetToneDistribution.format!({
        histogram: counted([
          { bin: -3, count: 12, articles: [{ url: 'https://example.com/n', title: 'Grim news' }] },
          { bin: 2, count: 4, articles: [{ url: 'https://example.com/g', title: 'Good news' }] },
        ]),
        summary: { peakNegativeBin: -3, peakPositiveBin: 2 },
      });
      const html = renderMarkdown((blocks[0] as { text: string }).text, { gfmAutolinks });
      expect(html).toContain(
        '<h3>Histogram</h3>\n' +
          '<p><strong>Bin -3:</strong> 12 articles ███</p>\n' +
          '<ul>\n<li><a href="https://example.com/n">Grim news</a></li>\n</ul>\n' +
          '<p><strong>Bin +2:</strong> 4 articles █</p>\n' +
          '<ul>\n<li><a href="https://example.com/g">Good news</a></li>\n</ul>\n',
      );
    },
  );

  /**
   * #54: both surfaces are bounded by the shared per-surface byte budget. The fixture sits at
   * GDELT's documented maximum — 61 bins (-30..+30), 10 representative references per bin — with
   * 100-character titles and URLs.
   */
  describe('response budget (#54)', () => {
    type Bin = {
      bin: number;
      count: number;
      articles: Array<{ url: string; title: string }>;
      referenceCount: number;
    };
    type Out = {
      histogram: Bin[];
      summary: { peakNegativeBin?: number; peakPositiveBin?: number; neutralPct?: number };
      nextOffset?: number;
      totalCount: number;
      notice?: string;
    };

    const article = (n: number, titleLength = 100) => ({
      url: `https://news.example/${'p'.repeat(70)}/${String(n).padStart(8, '0')}`,
      title: `Headline ${String(n).padStart(6, '0')} ${'drought '.repeat(800)}`.slice(
        0,
        titleLength,
      ),
    });
    function toneChart(refs: number, titleLength = 100) {
      let n = 0;
      return Array.from({ length: 61 }, (_, k) => ({
        bin: k - 30,
        count: (k * 53) % 500,
        articles: Array.from({ length: refs }, () => article(n++, titleLength)),
      }));
    }
    const FULL = toneChart(10);
    const ALL_BINS = FULL.map((b) => b.bin);
    const FULL_TOTAL = FULL.reduce((sum, b) => sum + b.count, 0);

    function mock(bins: unknown) {
      vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
        getToneDistribution: vi.fn().mockResolvedValue(bins),
      } as unknown as docServiceModule.GdeltDocService);
    }
    const call = (input: Record<string, unknown>) =>
      runToolContract(gdeltGetToneDistribution, {
        query: 'drought',
        ...input,
      } as Parameters<typeof gdeltGetToneDistribution.handler>[0]);
    const out = (result: { structuredContent?: unknown }) => result.structuredContent as Out;
    const surfaceBytes = (result: { structuredContent?: unknown; content: unknown[] }) => ({
      structured: Buffer.byteLength(JSON.stringify(result.structuredContent)),
      text: Buffer.byteLength(contentText(result)),
    });
    const link = (a: { url: string; title: string }) => `[${a.title}](${a.url})`;

    beforeEach(() => mock(FULL));

    it('keeps both surfaces of the 61-bin, 10-reference maximum at or under 50,000 bytes', async () => {
      const result = await call({});
      expect(result.isError).toBeFalsy();
      const bytes = surfaceBytes(result);
      expect(bytes.structured).toBeLessThanOrEqual(50_000);
      expect(bytes.text).toBeLessThanOrEqual(50_000);
    });

    it('carries the same first 3 references and referenceCount for every bin on both surfaces', async () => {
      const result = await call({});
      const sc = out(result);
      const text = contentText(result);
      expect(sc.histogram.map((b) => b.bin)).toEqual(ALL_BINS);
      for (const [i, bin] of sc.histogram.entries()) {
        const upstream = FULL[i]!;
        expect(bin.referenceCount).toBe(10);
        expect(bin.articles).toEqual(upstream.articles.slice(0, 3));
        for (const a of upstream.articles.slice(0, 3)) expect(text).toContain(link(a));
        expect(text).not.toContain(link(upstream.articles[3]!));
      }
      expect(text).toContain('**Bin -30:** 0 articles (3 of 10 links shown)');
      expect(text).toContain('bins: [');
      expect(text.match(/^ {2}- \[/gm)).toHaveLength(61 * 3);
    });

    it('returns only the bins named in bins, each with every reference, in histogram order', async () => {
      const result = await call({ bins: [4, -7] });
      const sc = out(result);
      expect(sc.histogram.map((b) => b.bin)).toEqual([-7, 4]);
      const text = contentText(result);
      for (const bin of sc.histogram) {
        const upstream = FULL.find((b) => b.bin === bin.bin)!;
        expect(bin.articles).toEqual(upstream.articles);
        expect(bin.referenceCount).toBe(10);
        for (const a of upstream.articles) expect(text).toContain(link(a));
      }
      expect(text).not.toContain('**Bin -6:**');
      expect(text).not.toContain('links shown');
    });

    it('pages every named bin exactly once, in order, each page within budget', async () => {
      const walked: number[] = [];
      let offset: number | undefined = 0;
      let pages = 0;
      let lastNotice: string | undefined;
      while (offset !== undefined) {
        const result = await call({ bins: ALL_BINS, offset });
        expect(result.isError).toBeFalsy();
        const bytes = surfaceBytes(result);
        expect(bytes.structured).toBeLessThanOrEqual(50_000);
        expect(bytes.text).toBeLessThanOrEqual(50_000);
        const sc = out(result);
        if (sc.nextOffset !== undefined) {
          expect(sc.notice).toMatch(
            new RegExp(
              `^Returned bins ${offset + 1}–${sc.nextOffset} of 61 bins; bin ${sc.nextOffset + 1} would push`,
            ),
          );
          expect(contentText(result)).toContain(`**Next offset:** ${sc.nextOffset}`);
        }
        walked.push(...sc.histogram.map((b) => b.bin));
        lastNotice = sc.notice;
        offset = sc.nextOffset;
        pages++;
      }
      expect(pages).toBeGreaterThan(1);
      expect(walked).toEqual(ALL_BINS);
      expect(lastNotice).toMatch(/of 61 bins — the last page\.$/);
    });

    it('computes summary and totalCount over the whole histogram, never the page', async () => {
      const whole = out(await call({}));
      const named = out(await call({ bins: [25] }));
      const paged = out(await call({ offset: 60 }));
      for (const sc of [named, paged]) {
        expect(sc.summary).toEqual(whole.summary);
        expect(sc.totalCount).toBe(FULL_TOTAL);
      }
      expect(paged.histogram.map((b) => b.bin)).toEqual([30]);
    });

    it('emits a bin larger than the budget alone, continuing from the next one', async () => {
      mock(toneChart(10, 6_000));
      const first = out(await call({ bins: [-30, -29, -28] }));
      expect(first.histogram.map((b) => b.bin)).toEqual([-30]);
      expect(first.nextOffset).toBe(1);
    });

    it('rejects a bins value matching no bin, listing the available bins', async () => {
      const result = await call({ bins: [-3, 99] });
      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          error: {
            code: JsonRpcErrorCode.NotFound,
            data: { reason: 'unknown_bin', unknownBins: [99] },
          },
        },
      });
      expect(contentText(result)).toContain(
        `This histogram has no bin 99. Available: ${ALL_BINS.join(', ')}.`,
      );
    });

    it('rejects an offset at or past the bin total, naming the valid range', async () => {
      const past = await call({ offset: 61 });
      expect(past).toMatchObject({
        isError: true,
        structuredContent: {
          error: {
            code: JsonRpcErrorCode.NotFound,
            data: { reason: 'offset_out_of_range', offset: 61, totalBins: 61 },
          },
        },
      });
      expect(contentText(past)).toContain('offset 0–60');
      const pastNamed = await call({ bins: [0, 1], offset: 2 });
      expect(contentText(pastNamed)).toContain('offset 0–1');
    });

    it('ignores bins and offset on an empty histogram, saying bins was not applied', async () => {
      mock([]);
      const result = await call({ bins: [3], offset: 4 });
      expect(result.isError).toBeFalsy();
      expect(out(result)).toMatchObject({ histogram: [], totalCount: 0 });
      expect(out(result).notice).toMatch(/No tone data for "drought".*bins input was not applied/);
    });
  });
});
