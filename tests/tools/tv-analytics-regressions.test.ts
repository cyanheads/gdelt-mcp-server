/**
 * @fileoverview TV count pages, selector forwarding, and smoothing disclosures.
 * @module tests/tools/tv-analytics-regressions.test
 */
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gdeltGetTvContext } from '@/mcp-server/tools/definitions/get-tv-context.tool.js';
import { gdeltSearchTv } from '@/mcp-server/tools/definitions/search-tv.tool.js';
import * as service from '@/services/gdelt/gdelt-tv-service.js';
import { contentText } from './markdown-render.js';

afterEach(() => vi.restoreAllMocks());

describe('TV analytics regression contracts', () => {
  it('retains date-then-station ordering across small point pages', async () => {
    vi.spyOn(service, 'getGdeltTvService').mockReturnValue({
      searchTv: vi.fn().mockResolvedValue({
        normalized: true,
        series: [
          {
            station: 'CNN',
            stationName: 'CNN',
            data: [
              { date: '2020-01-02', value: 2 },
              { date: '2020-01-01', value: 1 },
            ],
          },
        ],
      }),
    } as unknown as service.GdeltTvService);
    const response = await runToolContract(gdeltSearchTv, { query: 'x', limit: 1 });
    expect(response.structuredContent).toMatchObject({
      totalPoints: 2,
      nextOffset: 1,
      series: [{ data: [{ date: '2020-01-01', value: 1 }] }],
    });
    expect(contentText(response)).toContain('2020-01-01: 1');
  });

  it('forwards all station selectors while serving more than 500 points', async () => {
    const searchTv = vi.fn().mockResolvedValue({
      normalized: true,
      series: [
        {
          station: 'CNN',
          stationName: 'CNN',
          data: Array.from({ length: 601 }, (_, value) => ({ date: '2020-01-01', value })),
        },
      ],
    });
    vi.spyOn(service, 'getGdeltTvService').mockReturnValue({
      searchTv,
    } as unknown as service.GdeltTvService);
    const stations = Array.from({ length: 15 }, (_, i) => `S${i}`);
    const response = await runToolContract(gdeltSearchTv, { query: 'x', stations, limit: 601 });
    expect(response.isError).toBeFalsy();
    expect(searchTv).toHaveBeenCalledWith(expect.objectContaining({ stations }), expect.anything());
    expect(response.structuredContent).toMatchObject({ totalPoints: 601, limit: 601 });
    expect(contentText(response)).toContain('Points on this page: 601');
    expect(response.structuredContent).not.toHaveProperty('limitClamp');
  });

  it.each([0, 1, 6, 30])(
    'forwards smoothing %s and composes its notice only above one',
    async (smoothing) => {
      const searchTv = vi
        .fn()
        .mockResolvedValue({ normalized: true, series: [], stationCatalogUnavailable: true });
      vi.spyOn(service, 'getGdeltTvService').mockReturnValue({
        searchTv,
      } as unknown as service.GdeltTvService);
      const response = await runToolContract(gdeltSearchTv, { query: 'x', smoothing });
      expect(response.isError).toBeFalsy();
      expect(searchTv).toHaveBeenCalledWith(
        expect.objectContaining({ smoothing }),
        expect.anything(),
      );
      expect(contentText(response)).toContain('No TV coverage');
      if (smoothing > 1) {
        expect((response.structuredContent as { notice: string }).notice).toMatch(/leading.*lag/i);
        expect(contentText(response)).toMatch(/leading.*lag/i);
      } else expect(contentText(response)).not.toContain('moving average');
    },
  );

  it('walks score-sorted context pages without inventing clip counts', async () => {
    const words = Array.from({ length: 28 }, (_, i) => ({ label: `term${i}`, score: i }));
    vi.spyOn(service, 'getGdeltTvService').mockReturnValue({
      getTvContext: vi.fn().mockResolvedValue({ words }),
    } as unknown as service.GdeltTvService);
    const seen: string[] = [];
    for (const offset of [0, 25]) {
      const response = await runToolContract(gdeltGetTvContext, { query: 'x', offset });
      expect(response.isError).toBeFalsy();
      const sc = response.structuredContent as {
        words: typeof words;
        totalTerms: number;
        nextOffset?: number;
        notice: string;
      };
      expect(sc.totalTerms).toBe(28);
      expect(response.structuredContent).toHaveProperty('truncated', offset === 0);
      expect(contentText(response)).toContain(`**Truncated:** ${offset === 0}`);
      expect(sc.nextOffset).toBe(offset === 0 ? 25 : undefined);
      expect(sc.notice).toContain('relevance-ranked sample');
      expect(response.structuredContent).not.toHaveProperty('totalCount');
      for (const word of sc.words) expect(contentText(response)).toContain(`**${word.label}**`);
      seen.push(...sc.words.map((word) => word.label));
    }
    expect(seen).toEqual(Array.from({ length: 28 }, (_, i) => `term${27 - i}`));
    const past = await runToolContract(gdeltGetTvContext, { query: 'x', offset: 28 });
    expect(past.isError).toBe(true);
    expect(contentText(past)).toContain('offset_out_of_range');
    expect(past.structuredContent).toMatchObject({
      error: {
        data: {
          reason: 'offset_out_of_range',
          recovery: { hint: expect.stringContaining('0–27') },
        },
      },
    });
    expect(contentText(past)).toContain('0–27');
  });

  it('serves 601 points with a single selector', async () => {
    const data = Array.from({ length: 601 }, (_, value) => ({ date: '2020-01-01', value }));
    vi.spyOn(service, 'getGdeltTvService').mockReturnValue({
      searchTv: vi.fn().mockResolvedValue({
        normalized: true,
        series: [{ station: 'CNN', stationName: 'CNN', data }],
      }),
    } as unknown as service.GdeltTvService);
    const response = await runToolContract(gdeltSearchTv, {
      query: 'x',
      stations: ['CNN'],
      limit: 601,
    });
    expect(response.structuredContent).toMatchObject({ limit: 601, series: [{ data }] });
    expect(contentText(response)).toContain('Points on this page: 601');
  });

  it('keeps smoothing and unresolved-catalog notices beside a partial page', async () => {
    const data = [
      { date: '2020-01-30T12:00:00Z', value: 0.1987 },
      { date: '2020-01-31T12:00:00Z', value: 0.1929 },
      { date: '2020-02-01T12:00:00Z', value: 0.1871 },
    ];
    vi.spyOn(service, 'getGdeltTvService').mockReturnValue({
      searchTv: vi.fn().mockResolvedValue({
        normalized: true,
        stationCatalogUnavailable: true,
        series: [{ stationName: 'CNN', data }],
      }),
    } as unknown as service.GdeltTvService);
    const response = await runToolContract(gdeltSearchTv, { query: 'x', smoothing: 30, limit: 2 });
    expect(response.structuredContent).toMatchObject({
      totalPoints: 3,
      nextOffset: 2,
      series: [{ data: data.slice(0, 2) }],
      notice: expect.stringMatching(/leading.*lag.*Station IDs could not be resolved/),
    });
    expect(contentText(response)).toContain('2020-01-30T12:00:00Z: 0.1987');
    expect(contentText(response)).toContain('**Next offset:** 2');
    expect(contentText(response)).toMatch(/leading.*lag.*Station IDs could not be resolved/);
  });

  it('ignores offsets on empty context and keeps the clamp beside its notice', async () => {
    vi.spyOn(service, 'getGdeltTvService').mockReturnValue({
      getTvContext: vi.fn().mockResolvedValue({ words: [] }),
    } as unknown as service.GdeltTvService);
    const response = await runToolContract(gdeltGetTvContext, {
      query: 'x',
      offset: 20,
      limit: 25001,
    });
    expect(response.structuredContent).toMatchObject({
      words: [],
      totalTerms: 0,
      offset: 20,
      truncated: false,
      limitClamp: { parameter: 'limit', requested: 25001, applied: 25000 },
    });
    expect(response.structuredContent).not.toHaveProperty('nextOffset');
    expect(contentText(response)).toContain('No TV context data');
    expect(contentText(response)).toContain('**Truncated:** false');
    expect(contentText(response)).toContain('25001 → 25000');
  });

  it('returns exactly 25000 terms at the cap and retrieves the final term', async () => {
    const words = Array.from({ length: 25001 }, (_, i) => ({ label: `term${i}`, score: 1 }));
    vi.spyOn(service, 'getGdeltTvService').mockReturnValue({
      getTvContext: vi.fn().mockResolvedValue({ words }),
    } as unknown as service.GdeltTvService);
    const response = await runToolContract(gdeltGetTvContext, { query: 'x', limit: 25000 });
    expect(response.structuredContent).toMatchObject({ totalTerms: 25001, nextOffset: 25000 });
    expect((response.structuredContent as { words: unknown[] }).words).toHaveLength(25000);
    expect(contentText(response)).toContain('**term24999**');
    expect(contentText(response)).not.toContain('**term25000**');
    const final = await runToolContract(gdeltGetTvContext, {
      query: 'x',
      limit: 25000,
      offset: 25000,
    });
    expect(final.structuredContent).toMatchObject({
      words: [{ label: 'term25000', score: 1 }],
      totalTerms: 25001,
    });
    expect(final.structuredContent).not.toHaveProperty('nextOffset');
    expect(contentText(final)).toContain('**term25000**');
  });
});
