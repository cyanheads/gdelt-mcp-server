/**
 * @fileoverview Tests for gdelt_get_tv_context tool.
 * @module tests/tools/get-tv-context.tool.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gdeltGetTvContext } from '@/mcp-server/tools/definitions/get-tv-context.tool.js';
import * as tvServiceModule from '@/services/gdelt/gdelt-tv-service.js';
import { contentText, literalHtml, renderMarkdown } from './markdown-render.js';
import { CNN_RANGE, expectNotice, freezeClock } from './station-range-fixtures.js';

const CONTEXT_RESULT = {
  words: [
    { label: 'pandemic', score: 100 },
    { label: 'vaccine', score: 75 },
    { label: 'health', score: 50 },
  ],
};

describe('gdeltGetTvContext', () => {
  it('preserves exact term scores on both surfaces across score-sorted pages', async () => {
    const getTvContext = vi.fn().mockResolvedValue({
      words: [
        { label: 'health', score: 7.751234 },
        { label: 'vaccine', score: 42.25 },
      ],
    });
    vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
      getTvContext,
    } as unknown as tvServiceModule.GdeltTvService);
    const first = await runToolContract(gdeltGetTvContext, {
      query: 'pandemic',
      stations: ['CNN'],
      limit: 1,
    });
    expect(first.isError).toBeFalsy();
    expect(first.structuredContent).toMatchObject({
      words: [{ label: 'vaccine', score: 42.25 }],
      nextOffset: 1,
    });
    expect(contentText(first)).toContain('- **vaccine**: 42.25 ');
    const second = await runToolContract(gdeltGetTvContext, {
      query: 'pandemic',
      stations: ['CNN'],
      limit: 1,
      offset: 1,
    });
    expect(second.structuredContent).toMatchObject({
      words: [{ label: 'health', score: 7.751234 }],
    });
    expect(contentText(second)).toContain('- **health**: 7.751234 ');
    expect(getTvContext).toHaveBeenCalledTimes(2);
  });
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

  it('populates query echo without an unsupported clip count', async () => {
    const ctx = createMockContext({ errors: gdeltGetTvContext.errors });
    const input = gdeltGetTvContext.input.parse({ query: 'pandemic' });
    await gdeltGetTvContext.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBe('pandemic');
    expect(enrichment).not.toHaveProperty('totalCount');
  });

  it('omits totalCount from enrichment when service returns no clipsAnalyzed', async () => {
    vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
      getTvContext: vi.fn().mockResolvedValue({
        words: [{ label: 'test', score: 100 }],
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
      }),
    } as unknown as tvServiceModule.GdeltTvService);

    const ctx = createMockContext({ errors: gdeltGetTvContext.errors });
    const input = gdeltGetTvContext.input.parse({ query: 'test' });
    const result = await gdeltGetTvContext.handler(input, ctx);
    expect(result.words[0]?.label).toBe('pandemic');
    expect(result.words[1]?.label).toBe('vaccine');
    expect(result.words[2]?.label).toBe('health');
  });

  describe('zero-match answer', () => {
    function mockContext(result: unknown) {
      vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
        getTvContext: vi.fn().mockResolvedValue(result),
      } as unknown as tvServiceModule.GdeltTvService);
    }

    it('returns an empty word list and leaves totalCount absent without numclips', async () => {
      mockContext({ words: [] });
      const result = await runToolContract(gdeltGetTvContext, {
        query: 'noresults',
        timespan: '7d',
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({
        words: [],
        totalTerms: 0,
        offset: 0,
        truncated: false,
        effectiveQuery: 'noresults',
        notice: expect.stringMatching(
          /No TV context data for "noresults"\. Timespan "7d" resolved to \d{4}-\d{2}-\d{2} – \d{4}-\d{2}-\d{2}\./,
        ),
      });
      const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
      expect(text).toContain('**Co-occurring terms:** 0');
      expect(text).toContain('No terms returned.');
    });

    it('ignores unsupported service clip-count fields', async () => {
      mockContext({ words: [], clipsAnalyzed: 0 });
      const result = await runToolContract(gdeltGetTvContext, { query: 'noresults' });
      expect(result.structuredContent).toMatchObject({ words: [], totalTerms: 0 });
      expect(result.structuredContent).not.toHaveProperty('totalCount');
    });

    it('no longer declares a no_context contract entry', () => {
      expect(gdeltGetTvContext.errors?.map((e) => e.reason)).not.toContain('no_context');
    });

    it('describes the empty case on the notice field', () => {
      expect(gdeltGetTvContext.enrichment?.notice?.description).not.toMatch(
        /Absent on successful responses/,
      );
    });
  });

  /**
   * An empty answer for selected stations names each one whose monitoring range the window
   * misses, right after the resolved-timespan sentence; the sentence itself is tabled in
   * station-ids.test.ts. The catalog is consulted only when that sentence can be built.
   */
  describe('selected stations outside the window', () => {
    const TAIL =
      'Archive coverage varies by station — verify monitoring dates with gdelt_list_tv_stations and choose a matching window, or broaden the query.';

    function mockService(result: unknown) {
      const svc = {
        getTvContext: vi.fn().mockResolvedValue(result),
        stationRanges: vi.fn().mockResolvedValue(CNN_RANGE),
      };
      vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue(
        svc as unknown as tvServiceModule.GdeltTvService,
      );
      return svc;
    }

    it('names a range the resolved timespan starts after, looked up once from the call start', async () => {
      freezeClock();
      const svc = mockService({ words: [] });
      // The main request takes time; the catalog wait still counts from the call's start.
      svc.getTvContext.mockImplementation(async () => {
        vi.setSystemTime(new Date('2026-11-10T12:00:30Z'));
        return { words: [] };
      });
      const result = await runToolContract(gdeltGetTvContext, {
        query: 'inflation',
        stations: [' cnn '],
        timespan: '6m',
      });
      expectNotice(
        result,
        `No TV context data for "inflation". Timespan "6m" resolved to 2026-05-10 – 2026-11-10. CNN was monitored 2009-07-02 – 2024-10-10; the window starts after that range ends. Set startDatetime and endDatetime inside that range to search that station. ${TAIL}`,
      );
      expect(svc.stationRanges).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        Date.parse('2026-11-10T12:00:00Z'),
      );
    });

    it('keeps the notice as it was when the catalog is unavailable to the call', async () => {
      freezeClock();
      const svc = mockService({ words: [] });
      svc.stationRanges.mockResolvedValue(undefined);
      const result = await runToolContract(gdeltGetTvContext, {
        query: 'x',
        stations: ['CNN'],
        timespan: '6m',
      });
      expectNotice(
        result,
        `No TV context data for "x". Timespan "6m" resolved to 2026-05-10 – 2026-11-10. ${TAIL}`,
      );
    });

    it.each<[string, Record<string, unknown>, unknown]>([
      ['no window is known', { stations: ['CNN'] }, { words: [] }],
      [
        'stations are selected only in query',
        { query: 'x station:CNN', timespan: '6m' },
        { words: [] },
      ],
      ['terms were returned', { stations: ['CNN'], timespan: '6m' }, CONTEXT_RESULT],
    ])('never consults the catalog when %s', async (_case, input, answer) => {
      const svc = mockService(answer);
      const result = await runToolContract(gdeltGetTvContext, { query: 'x', ...input } as never);
      expect(result.isError).toBeFalsy();
      expect(svc.stationRanges).not.toHaveBeenCalled();
      expect(String((result.structuredContent as { notice?: string }).notice)).not.toContain(
        'was monitored',
      );
    });
  });

  /**
   * GDELT computes the word cloud from a relevance-ranked sample of the matching clips (its TV API
   * documentation says the 200 most relevant), not from every matching clip — so two windows or
   * stations cannot be compared from one call. Every non-empty result says so.
   */
  describe('sampling disclosure', () => {
    const SAMPLE =
      /GDELT's relevance-ranked sample of matching clips, documented as the 200 most relevant, not all matching coverage/;
    const COMPARE = /compare windows or stations with a separate, narrower call for each/;

    function mockContext(result: unknown) {
      vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
        getTvContext: vi.fn().mockResolvedValue(result),
      } as unknown as tvServiceModule.GdeltTvService);
    }

    it('carries the sampling notice on both surfaces of a non-empty result', async () => {
      mockContext(CONTEXT_RESULT);
      const result = await runToolContract(gdeltGetTvContext, {
        query: 'climate',
        stations: ['CNN'],
        startDatetime: '20240101000000',
        endDatetime: '20240107235959',
      });
      const sc = result.structuredContent as { notice: string; totalCount: number };
      expect(sc.notice).toMatch(SAMPLE);
      expect(sc.notice).toMatch(COMPARE);
      expect(sc).not.toHaveProperty('totalCount');
      expect(contentText(result)).toContain(sc.notice);
    });

    it('carries it without a clip count, leaving totalCount absent', async () => {
      mockContext({ words: [{ label: 'climate', score: 100 }] });
      const result = await runToolContract(gdeltGetTvContext, {
        query: 'climate',
        stations: ['CNN'],
      });
      expect(result.structuredContent).toMatchObject({ notice: expect.stringMatching(SAMPLE) });
      expect(result.structuredContent).not.toHaveProperty('totalCount');
    });

    it('keeps the no-data notice alone on an empty result', async () => {
      mockContext({ words: [] });
      const result = await runToolContract(gdeltGetTvContext, {
        query: 'noresults',
        stations: ['CNN'],
      });
      const notice = (result.structuredContent as { notice: string }).notice;
      expect(notice).toMatch(/^No TV context data for "noresults"\./);
      expect(notice).not.toMatch(/relevance-ranked/);
    });

    it('describes the sample in the tool, words, score, and notice descriptions — and no term cap', () => {
      const word = gdeltGetTvContext.output.shape.words.element.shape;
      const descriptions = [
        gdeltGetTvContext.description,
        gdeltGetTvContext.output.shape.words.description,
        word.score.description,
        gdeltGetTvContext.enrichment?.notice?.description,
      ];
      for (const text of descriptions) {
        expect(text).toMatch(/relevance-ranked sample of matching clips/);
        expect(text).toMatch(/documented as the 200 most relevant/);
        expect(text).not.toMatch(/200 (terms|words)|(at most|up to|top) 200/i);
      }
      expect(gdeltGetTvContext.enrichment?.notice?.description).toMatch(/every non-empty result/i);
    });
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
    const output = { words: CONTEXT_RESULT.words, offset: 0, totalTerms: 3, truncated: false };
    const blocks = gdeltGetTvContext.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('- **pandemic**: 100 ');
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
    const blocks = gdeltGetTvContext.format!({
      words: manyWords,
      offset: 0,
      totalTerms: 60,
      truncated: false,
    });
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
    const blocks = gdeltGetTvContext.format!({ words, offset: 0, totalTerms: 3, truncated: false });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('91.5');
    expect(text).toContain('42.25');
    expect(text).toContain('7.75');
  });

  /** Term labels reach content[] as literal text inside their bold span; structuredContent stays raw. */
  describe('Markdown escaping at the content[] boundary', () => {
    it('renders plain upstream values byte-identically to the pre-escaping format()', () => {
      const blocks = gdeltGetTvContext.format!({
        offset: 0,
        totalTerms: 2,
        truncated: false,
        words: [
          { label: 'vaccine', score: 100 },
          { label: 'health officials', score: 42.5 },
        ],
      });
      expect((blocks[0] as { text: string }).text).toBe(
        '## GDELT TV Context\n**Co-occurring terms:** 2\n**Term page:** offset 0, total 2\n**Truncated:** false\n\n### Terms\n' +
          '- **vaccine**: 100 ████████████████████\n- **health officials**: 42.5 █████████',
      );
    });

    it('escapes term labels and leaves structuredContent raw', async () => {
      const words = [
        { label: '*vaccine*', score: 100 },
        { label: 'snake_case', score: 60 },
        { label: '[x](y)', score: 40 },
      ];
      vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
        getTvContext: vi.fn().mockResolvedValue({ words, clipsAnalyzed: 3 }),
      } as unknown as tvServiceModule.GdeltTvService);
      const result = await runToolContract(gdeltGetTvContext, { query: 'x', stations: ['CNN'] });
      expect((result.structuredContent as { words: unknown }).words).toEqual(words);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain(String.raw`- **\*vaccine\***: 100`);
      expect(text).toContain('- **snake_case**: 60');
      expect(text).toContain(String.raw`- **\[x\](y)**: 40`);

      const html = renderMarkdown(contentText(result));
      for (const w of words) expect(html).toContain(`<strong>${literalHtml(w.label)}</strong>`);
    });
  });

  /**
   * GDELT's order among tied scores varies between identical calls (measured live: the same 360
   * terms and scores, with 309 positions differing among ties), so the label breaks a score tie
   * as it does in gdelt_get_tv_breakdown — an offset page fetched fresh neither repeats nor skips
   * a tied term.
   */
  describe('tied scores', () => {
    const TIED = [
      { label: 'Recognized', score: 15.2482 },
      { label: 'Impeachment', score: 100 },
      { label: 'trump', score: 15.2482 },
      { label: 'Process', score: 15.2482 },
      { label: 'Trump', score: 15.2482 },
      { label: 'Gentleman', score: 41.844 },
    ];
    const ORDER = ['Impeachment', 'Gentleman', 'Process', 'Recognized', 'Trump', 'trump'];

    function mockContext(words: unknown[]) {
      vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
        getTvContext: vi.fn().mockResolvedValue({ words }),
      } as unknown as tvServiceModule.GdeltTvService);
    }

    it('breaks a score tie by exact label, whatever order GDELT sent the terms in', async () => {
      for (const words of [TIED, TIED.toReversed()]) {
        mockContext(words);
        const result = await runToolContract(gdeltGetTvContext, { query: 'impeachment' });
        expect(
          (result.structuredContent as { words: Array<{ label: string }> }).words.map(
            (w) => w.label,
          ),
        ).toEqual(ORDER);
      }
    });

    it('pages tied terms without a repeat or a gap when each page is fetched fresh', async () => {
      const seen: string[] = [];
      for (const [offset, words] of [
        [0, TIED],
        [3, TIED.toReversed()],
      ] as const) {
        mockContext(words);
        const result = await runToolContract(gdeltGetTvContext, {
          query: 'impeachment',
          limit: 3,
          offset,
        });
        seen.push(
          ...(result.structuredContent as { words: Array<{ label: string }> }).words.map(
            (w) => w.label,
          ),
        );
      }
      expect(seen).toEqual(ORDER);
    });

    it('describes the order on the offset and words fields', () => {
      expect(gdeltGetTvContext.input.shape.offset.description).toMatch(
        /descending score order, ties broken by exact label/,
      );
      expect(gdeltGetTvContext.output.shape.words.description).toMatch(
        /sorted by score descending, ties broken by exact label/,
      );
    });
  });

  /**
   * GDELT computes the word cloud over whole UTC periods at the resolution it picks from the
   * window length, widening an explicit window outward to them (measured live: the same terms
   * and scores for 20:30–22:30 as for 20:00–22:59:59). Its answer reports no resolution, so the
   * notice names the documented default. Boundary rules are tabled in tv-covered-window.test.ts.
   */
  describe('covered window', () => {
    const SAMPLING =
      "Terms and scores come from GDELT's relevance-ranked sample of matching clips, documented as the 200 most relevant, not all matching coverage — compare windows or stations with a separate, narrower call for each.";

    function mockContext(words: unknown[]) {
      vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
        getTvContext: vi.fn().mockResolvedValue({ words }),
        stationRanges: vi.fn().mockResolvedValue(CNN_RANGE),
      } as unknown as tvServiceModule.GdeltTvService);
    }

    it('names the window after the sampling notice', async () => {
      mockContext(CONTEXT_RESULT.words);
      const result = await runToolContract(gdeltGetTvContext, {
        query: 'impeachment',
        stations: ['FOXNEWS'],
        startDatetime: '20191218203000',
        endDatetime: '20191218223000',
      });
      expectNotice(
        result,
        `${SAMPLING} Terms and scores cover whole clock hours, 2019-12-18T20:00:00Z – 2019-12-18T22:59:59Z, wider than the requested 20191218203000–20191218223000.`,
      );
    });

    it.each<[string, Record<string, unknown>]>([
      [
        'both edges sit on period boundaries',
        { startDatetime: '20191218200000', endDatetime: '20191218225959' },
      ],
      ['the call ran on a timespan', { timespan: '1m' }],
    ])('adds nothing when %s', async (_label, window) => {
      mockContext(CONTEXT_RESULT.words);
      const result = await runToolContract(gdeltGetTvContext, {
        query: 'impeachment',
        stations: ['FOXNEWS'],
        ...window,
      });
      expectNotice(result, SAMPLING);
    });

    it('adds nothing on an empty result', async () => {
      mockContext([]);
      const result = await runToolContract(gdeltGetTvContext, {
        query: 'impeachment',
        stations: ['CNN'],
        startDatetime: '20191218203000',
        endDatetime: '20191218223000',
      });
      const notice = (result.structuredContent as { notice: string }).notice;
      expect(notice).toMatch(/^No TV context data for "impeachment"\./);
      expect(notice).not.toMatch(/cover whole/);
    });

    it('states the rule on the window and notice descriptions', () => {
      const shape = gdeltGetTvContext.input.shape;
      for (const field of [shape.startDatetime, shape.endDatetime]) {
        expect(field.description).toMatch(
          /whole UTC periods at the resolution GDELT picks from the window length — clock hours up to 7 days, days under 3 years, months beyond/,
        );
      }
      expect(gdeltGetTvContext.enrichment?.notice?.description).toMatch(
        /the resolution and the UTC window the terms and scores cover/,
      );
    });
  });
});
