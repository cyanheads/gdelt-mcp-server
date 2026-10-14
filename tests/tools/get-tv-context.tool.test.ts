/**
 * @fileoverview Tests for gdelt_get_tv_context tool.
 * @module tests/tools/get-tv-context.tool.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gdeltGetTvContext } from '@/mcp-server/tools/definitions/get-tv-context.tool.js';
import * as tvServiceModule from '@/services/gdelt/gdelt-tv-service.js';
import { contentText, literalHtml, renderMarkdown } from './markdown-render.js';

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
        effectiveQuery: 'noresults',
        notice: expect.stringMatching(
          /No TV context data for "noresults"\. Timespan "7d" resolved to \d{4}-\d{2}-\d{2} – \d{4}-\d{2}-\d{2}\./,
        ),
      });
      const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
      expect(text).toContain('**Co-occurring terms:** 0');
      expect(text).toContain('No terms returned.');
    });

    it('reports the upstream clip count when GDELT supplies one', async () => {
      mockContext({ words: [], clipsAnalyzed: 0 });
      const result = await runToolContract(gdeltGetTvContext, { query: 'noresults' });
      expect(result.structuredContent).toMatchObject({ words: [], totalCount: 0 });
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
      expect(sc.totalCount).toBe(42);
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

  /** Term labels reach content[] as literal text inside their bold span; structuredContent stays raw. */
  describe('Markdown escaping at the content[] boundary', () => {
    it('renders plain upstream values byte-identically to the pre-escaping format()', () => {
      const blocks = gdeltGetTvContext.format!({
        words: [
          { label: 'vaccine', score: 100 },
          { label: 'health officials', score: 42.5 },
        ],
      });
      expect((blocks[0] as { text: string }).text).toBe(
        '## GDELT TV Context\n**Co-occurring terms:** 2\n\n### Terms\n' +
          '- **vaccine**: 100.0 ████████████████████\n- **health officials**: 42.5 █████████',
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
      expect(text).toContain(String.raw`- **\*vaccine\***: 100.0`);
      expect(text).toContain('- **snake_case**: 60.0');
      expect(text).toContain(String.raw`- **\[x\](y)**: 40.0`);

      const html = renderMarkdown(contentText(result));
      for (const w of words) expect(html).toContain(`<strong>${literalHtml(w.label)}</strong>`);
    });
  });
});
