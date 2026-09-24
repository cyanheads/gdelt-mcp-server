/**
 * @fileoverview Tests for gdelt_search_tv tool.
 * @module tests/tools/search-tv.tool.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gdeltSearchTv } from '@/mcp-server/tools/definitions/search-tv.tool.js';
import * as tvServiceModule from '@/services/gdelt/gdelt-tv-service.js';
import { contentText, literalHtml, renderMarkdown } from './markdown-render.js';

const TV_RESULT = {
  series: [
    {
      station: 'CNN',
      data: [
        { date: '2024-01-01', value: 0.5 },
        { date: '2024-01-02', value: 0.8 },
      ],
    },
  ],
  dateResolution: 'day' as const,
  normalized: true,
};

describe('gdeltSearchTv', () => {
  beforeEach(() => {
    vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
      searchTv: vi.fn().mockResolvedValue(TV_RESULT),
    } as unknown as tvServiceModule.GdeltTvService);
  });

  it('returns TV coverage series', async () => {
    const ctx = createMockContext({ errors: gdeltSearchTv.errors });
    const input = gdeltSearchTv.input.parse({ query: 'vaccine' });
    const result = await gdeltSearchTv.handler(input, ctx);
    expect(result.series).toHaveLength(1);
    expect(result.series[0]?.station).toBe('CNN');
    expect(result.normalized).toBe(true);
  });

  it('populates enrichment with query echo and station count', async () => {
    const ctx = createMockContext({ errors: gdeltSearchTv.errors });
    const input = gdeltSearchTv.input.parse({ query: 'vaccine' });
    await gdeltSearchTv.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBe('vaccine');
    expect(enrichment.totalCount).toBe(1);
  });

  it('passes stations filter to the service', async () => {
    const svc = {
      searchTv: vi.fn().mockResolvedValue(TV_RESULT),
    } as unknown as tvServiceModule.GdeltTvService;
    vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue(svc);

    const ctx = createMockContext({ errors: gdeltSearchTv.errors });
    const input = gdeltSearchTv.input.parse({ query: 'test', stations: ['CNN', 'FOXNEWS'] });
    await gdeltSearchTv.handler(input, ctx);
    expect(svc.searchTv).toHaveBeenCalledWith(
      expect.objectContaining({ stations: ['CNN', 'FOXNEWS'] }),
      ctx,
    );
  });

  it('preserves selector-only and explicitly empty station requests', async () => {
    const svc = {
      searchTv: vi.fn().mockResolvedValue(TV_RESULT),
    } as unknown as tvServiceModule.GdeltTvService;
    vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue(svc);

    const ctx = createMockContext({ errors: gdeltSearchTv.errors });
    const input = gdeltSearchTv.input.parse({ query: 'vaccine station:CNN', stations: [] });
    await gdeltSearchTv.handler(input, ctx);
    expect(svc.searchTv).toHaveBeenCalledWith(
      expect.not.objectContaining({ stations: expect.anything() }),
      ctx,
    );
  });

  it('passes the selected TV date resolution to the service', async () => {
    const svc = {
      searchTv: vi.fn().mockResolvedValue({ ...TV_RESULT, dateResolution: 'week' }),
    } as unknown as tvServiceModule.GdeltTvService;
    vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue(svc);

    const ctx = createMockContext({ errors: gdeltSearchTv.errors });
    const input = gdeltSearchTv.input.parse({ query: 'test', dateres: 'week' });
    const result = await gdeltSearchTv.handler(input, ctx);
    expect(svc.searchTv).toHaveBeenCalledWith(expect.objectContaining({ dateres: 'week' }), ctx);
    expect(result.dateResolution).toBe('week');
  });

  /**
   * The service hands back what a `{}` answer normalizes to — no series, nothing to derive a
   * resolution or time range from — unless the caller pinned `dateres`.
   */
  describe('zero-match answer', () => {
    const EMPTY_RESULT = { series: [], normalized: true };

    function mockSearch(result: unknown) {
      vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
        searchTv: vi.fn().mockResolvedValue(result),
      } as unknown as tvServiceModule.GdeltTvService);
    }

    it('returns an empty page with echoes and a notice, omitting derived values', async () => {
      mockSearch(EMPTY_RESULT);
      const result = await runToolContract(gdeltSearchTv, {
        query: 'zqxwvjkplmq',
        stations: ['CNN'],
        timespan: '1y',
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({
        series: [],
        normalized: true,
        totalPoints: 0,
        offset: 0,
        limit: 500,
        effectiveQuery: 'zqxwvjkplmq',
        totalCount: 0,
        notice: expect.stringMatching(
          /No TV coverage for "zqxwvjkplmq"\. Timespan "1y" resolved to \d{4}-\d{2}-\d{2} – \d{4}-\d{2}-\d{2}\..*gdelt_list_tv_stations/,
        ),
      });
    });

    it('treats station series that carry no points as empty', async () => {
      mockSearch({ series: [{ station: 'CNN', data: [] }], normalized: true });
      const result = await runToolContract(gdeltSearchTv, { query: 'x', stations: ['CNN'] });
      expect(result.structuredContent).toMatchObject({
        series: [],
        totalPoints: 0,
        totalCount: 0,
        notice: expect.any(String),
      });
    });

    it('keeps a caller-pinned dateres as dateResolution', async () => {
      mockSearch({ ...EMPTY_RESULT, dateResolution: 'week' });
      const result = await runToolContract(gdeltSearchTv, {
        query: 'x',
        stations: ['CNN'],
        dateres: 'week',
      });
      expect(result.structuredContent).toMatchObject({ dateResolution: 'week' });
      expect(result.structuredContent).not.toHaveProperty('timeRange');
    });

    it('never turns an empty timeline into offset_out_of_range, and omits nextOffset', async () => {
      mockSearch(EMPTY_RESULT);
      const result = await runToolContract(gdeltSearchTv, {
        query: 'x',
        stations: ['CNN'],
        offset: 40,
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ offset: 40, totalPoints: 0 });
      expect(result.structuredContent).not.toHaveProperty('nextOffset');
    });

    it('renders a coherent empty body — no blank range, no 1–0 page, no peak', async () => {
      mockSearch(EMPTY_RESULT);
      const result = await runToolContract(gdeltSearchTv, { query: 'x', stations: ['CNN'] });
      const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
      expect(text).not.toContain('Time Range');
      expect(text).not.toContain('Date Resolution');
      expect(text).not.toMatch(/Points 1–0/);
      expect(text).not.toContain('Peak');
      expect(text).toContain('**Points:** 0 of 0');
    });

    it('no longer declares a no_tv_coverage contract entry', () => {
      expect(gdeltSearchTv.errors?.map((e) => e.reason)).not.toContain('no_tv_coverage');
    });

    it('describes the empty case on the notice field', () => {
      expect(gdeltSearchTv.enrichment?.notice?.description).not.toMatch(
        /Absent on successful responses/,
      );
    });
  });

  it('formats output with all required fields', () => {
    const output = {
      dateResolution: 'day' as const,
      timeRange: { start: '2024-01-01', end: '2024-01-02' },
      series: TV_RESULT.series,
      normalized: true,
      totalPoints: 2,
      offset: 0,
      limit: 500,
    };
    const blocks = gdeltSearchTv.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('day');
    expect(text).toContain('2024-01-01');
    expect(text).toContain('2024-01-02');
    expect(text).toContain('Yes');
    expect(text).toContain('CNN');
    // Peak value is 0.8
    expect(text).toContain('0.800');
    expect(text).toContain('2024-01-01: 0.500');
    expect(text).toContain('2024-01-02: 0.800');
    expect(text).toContain('Points 1–2 of 2');
  });

  describe('bounded point pages', () => {
    const PAGED_RESULT = {
      ...TV_RESULT,
      series: [
        {
          station: 'CNN',
          data: [
            { date: '2024-01-01', value: 1 },
            { date: '2024-01-02', value: 2 },
            { date: '2024-01-03', value: 3 },
          ],
        },
        {
          station: 'FOXNEWS',
          data: [
            { date: '2024-01-01', value: 4 },
            { date: '2024-01-02', value: 5 },
            { date: '2024-01-03', value: 6 },
          ],
        },
      ],
    };

    beforeEach(() => {
      vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
        searchTv: vi.fn().mockResolvedValue(PAGED_RESULT),
      } as unknown as tvServiceModule.GdeltTvService);
    });

    it('returns a deterministic page with the same points in structured output and text', async () => {
      const ctx = createMockContext({ errors: gdeltSearchTv.errors });
      const input = gdeltSearchTv.input.parse({ query: 'test', limit: 3 });
      const result = await gdeltSearchTv.handler(input, ctx);
      const returned = result.series.flatMap((series) =>
        series.data.map((point) => `${series.station}:${point.date}:${point.value.toFixed(3)}`),
      );
      expect(result).toMatchObject({ totalPoints: 6, offset: 0, limit: 3, nextOffset: 3 });
      expect(returned).toEqual([
        'CNN:2024-01-01:1.000',
        'CNN:2024-01-02:2.000',
        'FOXNEWS:2024-01-01:4.000',
      ]);

      const text = (gdeltSearchTv.format!(result)[0] as { text: string }).text;
      for (const point of returned) {
        const [, date, value] = point.split(':');
        expect(text).toContain(`${date}: ${value}`);
      }
      expect(text).toContain('Next offset:** 3');
    });

    it('retrieves a non-overlapping later page and omits nextOffset on the final page', async () => {
      const ctx = createMockContext({ errors: gdeltSearchTv.errors });
      const input = gdeltSearchTv.input.parse({ query: 'test', limit: 3, offset: 3 });
      const result = await gdeltSearchTv.handler(input, ctx);
      expect(result).toMatchObject({ totalPoints: 6, offset: 3, limit: 3 });
      expect(result.nextOffset).toBeUndefined();
      expect(
        result.series.flatMap((series) =>
          series.data.map((point) => `${series.station}:${point.date}:${point.value.toFixed(3)}`),
        ),
      ).toEqual(['CNN:2024-01-03:3.000', 'FOXNEWS:2024-01-02:5.000', 'FOXNEWS:2024-01-03:6.000']);
    });

    it('rejects an offset past the result with a recovery-bearing error', async () => {
      const ctx = createMockContext({ errors: gdeltSearchTv.errors });
      const input = gdeltSearchTv.input.parse({ query: 'test', offset: 6 });
      await expect(gdeltSearchTv.handler(input, ctx)).rejects.toMatchObject({
        data: {
          reason: 'offset_out_of_range',
          recovery: { hint: expect.stringMatching(/offset 0.*5/s) },
        },
      });
    });
  });

  /** Station names reach the content[] headings as literal text; structuredContent stays raw. */
  describe('Markdown escaping at the content[] boundary', () => {
    it('renders plain upstream values byte-identically to the pre-escaping format()', () => {
      const blocks = gdeltSearchTv.format!({
        dateResolution: 'day',
        timeRange: { start: '2024-01-15', end: '2024-01-16' },
        series: [
          {
            station: 'CNN',
            data: [
              { date: '2024-01-15', value: 0.5 },
              { date: '2024-01-16', value: 0.25 },
            ],
          },
        ],
        normalized: true,
        totalPoints: 2,
        offset: 0,
        limit: 500,
      });
      expect((blocks[0] as { text: string }).text).toBe(
        '## GDELT TV News Coverage\n**Date Resolution:** day\n**Time Range:** 2024-01-15 to 2024-01-16\n' +
          '**Normalized:** Yes (% of airtime)\n**Stations:** 1\n**Point page:** offset 0, limit 500\n' +
          '**Points 1–2 of 2**\n\n### CNN\nPoints: 2 | Total: 0.75\nPeak: 0.500 at 2024-01-15\n' +
          '- 2024-01-15: 0.500\n- 2024-01-16: 0.250',
      );
    });

    it('escapes station headings and leaves structuredContent raw', async () => {
      const series = [
        { station: 'KGO <b>', data: [{ date: '2024-01-15', value: 0.5 }] },
        { station: 'WABC #', data: [{ date: '2024-01-16', value: 0.25 }] },
      ];
      vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
        searchTv: vi.fn().mockResolvedValue({ series, dateResolution: 'day', normalized: true }),
      } as unknown as tvServiceModule.GdeltTvService);
      const result = await runToolContract(gdeltSearchTv, { query: 'x', stations: ['KGO'] });
      expect((result.structuredContent as { series: unknown }).series).toEqual(series);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain(String.raw`### KGO \<b>`);
      expect(text).toContain(String.raw`### WABC \#`);

      const html = renderMarkdown(contentText(result));
      expect(html).toContain(`<h3>${literalHtml('KGO <b>')}</h3>`);
      expect(html).toContain(`<h3>${literalHtml('WABC #')}</h3>`);
    });
  });
});
