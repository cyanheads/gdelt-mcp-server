/**
 * @fileoverview Tests for gdelt_search_tv tool.
 * @module tests/tools/search-tv.tool.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { gdeltSearchTv } from '@/mcp-server/tools/definitions/search-tv.tool.js';
import * as gdeltFetchModule from '@/services/gdelt/gdelt-fetch.js';
import * as tvServiceModule from '@/services/gdelt/gdelt-tv-service.js';
import { contentText, literalHtml, renderMarkdown } from './markdown-render.js';

const TV_RESULT = {
  series: [
    {
      station: 'CNN',
      stationName: 'CNN',
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
      mockSearch({ series: [{ station: 'CNN', stationName: 'CNN', data: [] }], normalized: true });
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
          stationName: 'CNN',
          data: [
            { date: '2024-01-01', value: 1 },
            { date: '2024-01-02', value: 2 },
            { date: '2024-01-03', value: 3 },
          ],
        },
        {
          station: 'FOXNEWS',
          stationName: 'FOX News',
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

  /**
   * A limit above the 500-point page bound, up to 5000, runs exactly as limit 500: the same
   * page, nextOffset, and `limit` output, plus a `limitClamp` disclosure on both surfaces.
   */
  describe('limit clamp', () => {
    // 2 stations × 300 days = 600 points: a 500-point page leaves 100 for nextOffset.
    const LONG_RESULT = {
      ...TV_RESULT,
      series: ['CNN', 'FOXNEWS'].map((station, s) => ({
        station,
        stationName: station,
        data: Array.from({ length: 300 }, (_, d) => ({
          date: new Date(Date.UTC(2023, 0, 1 + d)).toISOString().slice(0, 10),
          value: s + d / 1000,
        })),
      })),
    };

    const run = (limit: number, result: unknown = LONG_RESULT) => {
      vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
        searchTv: vi.fn().mockResolvedValue(result),
      } as unknown as tvServiceModule.GdeltTvService);
      return runToolContract(gdeltSearchTv, { query: 'x', stations: ['CNN'], limit });
    };

    const points = (structured: unknown) =>
      (structured as { series: Array<{ data: unknown[] }> }).series.reduce(
        (n, s) => n + s.data.length,
        0,
      );

    it('runs limit 501 and 5000 exactly as limit 500, disclosing the clamp', async () => {
      const atCap = await run(500);
      expect(atCap.structuredContent).toMatchObject({ limit: 500, nextOffset: 500 });
      expect(points(atCap.structuredContent)).toBe(500);
      expect(atCap.structuredContent).not.toHaveProperty('limitClamp');
      expect(contentText(atCap)).not.toContain('Limit clamped');

      for (const requested of [501, 5000]) {
        const clamped = await run(requested);
        const { limitClamp, ...rest } = clamped.structuredContent as Record<string, unknown>;
        expect(limitClamp).toEqual({ parameter: 'limit', requested, applied: 500 });
        expect(rest).toEqual(atCap.structuredContent);
        expect(contentText(clamped)).toContain(
          `**Limit clamped:** limit ${requested} → 500 (per-call cap)`,
        );
        expect(contentText(clamped)).toContain('**Point page:** offset 0, limit 500');
        expect(contentText(clamped)).toContain('**Next offset:** 500');
      }
    });

    it('keeps the empty-result notice beside the clamp disclosure', async () => {
      const clamped = await run(5000, { series: [], normalized: true });
      expect(clamped.structuredContent).toMatchObject({
        series: [],
        limit: 500,
        notice: expect.stringMatching(/No TV coverage for "x"/),
        limitClamp: { parameter: 'limit', requested: 5000, applied: 500 },
      });
      expect(contentText(clamped)).toContain('No TV coverage for "x"');
      expect(contentText(clamped)).toContain('**Limit clamped:** limit 5000 → 500 (per-call cap)');
    });
  });

  /** Station names reach the content[] headings as literal text; structuredContent stays raw. */
  describe('Markdown escaping at the content[] boundary', () => {
    it('renders plain upstream values byte-identically to the expected format()', () => {
      const blocks = gdeltSearchTv.format!({
        dateResolution: 'day',
        timeRange: { start: '2024-01-15', end: '2024-01-16' },
        series: [
          {
            station: 'CNN',
            stationName: 'CNN',
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
          '**Points 1–2 of 2**\n\n### CNN (CNN)\nPoints on this page: 2 | Sum on this page: 0.75\n' +
          'Page peak: 0.500 at 2024-01-15\n- 2024-01-15: 0.500\n- 2024-01-16: 0.250',
      );
    });

    it('escapes station headings and leaves structuredContent raw', async () => {
      const series = [
        { station: 'KGO', stationName: 'KGO <b>', data: [{ date: '2024-01-15', value: 0.5 }] },
        { stationName: 'WABC *x*', data: [{ date: '2024-01-16', value: 0.25 }] },
      ];
      vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
        searchTv: vi.fn().mockResolvedValue({ series, dateResolution: 'day', normalized: true }),
      } as unknown as tvServiceModule.GdeltTvService);
      const result = await runToolContract(gdeltSearchTv, { query: 'x', stations: ['KGO'] });
      expect((result.structuredContent as { series: unknown }).series).toEqual(series);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain(String.raw`### KGO \<b> (KGO)`);
      expect(text).toContain(String.raw`### WABC \*x\* (no station ID)`);

      const html = renderMarkdown(contentText(result));
      expect(html).toContain(`<h3>${literalHtml('KGO <b> (KGO)')}</h3>`);
      expect(html).toContain(`<h3>${literalHtml('WABC *x* (no station ID)')}</h3>`);
    });
  });

  /**
   * GDELT labels each series with the station's catalog description; the service resolves it to
   * the station ID. `station` carries that ID, `stationName` the label, on both surfaces.
   */
  describe('station IDs', () => {
    const point = (date: string, value = 1) => ({ date, value });

    function mockSearch(result: unknown) {
      vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
        searchTv: vi.fn().mockResolvedValue(result),
      } as unknown as tvServiceModule.GdeltTvService);
    }

    it('returns the station ID and the label on both surfaces', async () => {
      const series = [
        { station: 'FOXNEWS', stationName: 'FOX News', data: [point('2024-01-01')] },
        { station: 'CNN', stationName: 'CNN', data: [point('2024-01-01')] },
      ];
      mockSearch({ series, normalized: true });
      const result = await runToolContract(gdeltSearchTv, {
        query: 'climate',
        stations: ['CNN', 'FOXNEWS'],
      });
      expect(result.structuredContent).toMatchObject({ series });
      expect(result.structuredContent).not.toHaveProperty('notice');
      expect(contentText(result)).toContain('### FOX News (FOXNEWS)');
      expect(contentText(result)).toContain('### CNN (CNN)');
    });

    /** Local affiliates' labels already end in their ID; the heading names it once. */
    it('renders a label that already ends in its (ID) alone, and appends the ID to one that does not', async () => {
      mockSearch({
        series: [
          { station: 'KYW', stationName: 'CBS - Philadelphia (KYW)', data: [point('2024-01-01')] },
          { station: 'FBC', stationName: 'FOX Business', data: [point('2024-01-01')] },
        ],
        normalized: true,
      });
      const text = contentText(
        await runToolContract(gdeltSearchTv, { query: 'x', stations: ['KYW'] }),
      );
      expect(text).toContain('### CBS - Philadelphia (KYW)\n');
      expect(text).not.toContain('(KYW) (KYW)');
      expect(text).toContain('### FOX Business (FBC)\n');
    });

    /**
     * Ordered by ID, FOXNEWS would precede KGO; ordered by label, "ABC - San Francisco (KGO)"
     * precedes "FOX News". The page keeps the label order it always had.
     */
    it('orders a page by date, then station name — not station ID', async () => {
      mockSearch({
        series: [
          { station: 'FOXNEWS', stationName: 'FOX News', data: [point('2024-01-01')] },
          { station: 'KGO', stationName: 'ABC - San Francisco (KGO)', data: [point('2024-01-01')] },
        ],
        normalized: true,
      });
      const first = await runToolContract(gdeltSearchTv, {
        query: 'x',
        stations: ['KGO'],
        limit: 1,
      });
      expect(first.structuredContent).toMatchObject({
        series: [{ station: 'KGO' }],
        nextOffset: 1,
      });
      const second = await runToolContract(gdeltSearchTv, {
        query: 'x',
        stations: ['KGO'],
        limit: 1,
        offset: 1,
      });
      expect(second.structuredContent).toMatchObject({ series: [{ station: 'FOXNEWS' }] });
    });

    it('names a label with no catalog entry in the notice and returns the rest of the result', async () => {
      const unmapped = { stationName: 'KZZZ Local News', data: [point('2024-01-01', 2)] };
      mockSearch({
        series: [
          { station: 'FOXNEWS', stationName: 'FOX News', data: [point('2024-01-01')] },
          unmapped,
        ],
        normalized: true,
      });
      const result = await runToolContract(gdeltSearchTv, { query: 'x', stations: ['FOXNEWS'] });
      const sc = result.structuredContent as { series: unknown[]; notice: string };
      expect(sc.series).toEqual([
        { station: 'FOXNEWS', stationName: 'FOX News', data: [point('2024-01-01')] },
        unmapped,
      ]);
      expect(sc.notice).toMatch(/labeled "KZZZ Local News".*gdelt_list_tv_stations/);
      expect(contentText(result)).toContain(sc.notice);
      expect(contentText(result)).toContain('### KZZZ Local News (no station ID)');
    });

    it('names only the unresolved labels on the returned page', async () => {
      mockSearch({
        series: [
          { station: 'CNN', stationName: 'CNN', data: [point('2024-01-01')] },
          { stationName: 'KZZZ Local News', data: [point('2024-01-02')] },
        ],
        normalized: true,
      });
      const first = await runToolContract(gdeltSearchTv, {
        query: 'x',
        stations: ['CNN'],
        limit: 1,
      });
      expect(first.structuredContent).not.toHaveProperty('notice');
      const second = await runToolContract(gdeltSearchTv, {
        query: 'x',
        stations: ['CNN'],
        limit: 1,
        offset: 1,
      });
      expect((second.structuredContent as { notice: string }).notice).toMatch(/"KZZZ Local News"/);
    });

    it('says station IDs could not be resolved when the catalog was unavailable', async () => {
      mockSearch({
        series: [{ stationName: 'FOX News', data: [point('2024-01-01')] }],
        normalized: true,
        stationCatalogUnavailable: true,
      });
      const result = await runToolContract(gdeltSearchTv, {
        query: 'x',
        stations: ['FOXNEWS'],
        limit: 5000,
      });
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.series).toEqual([{ stationName: 'FOX News', data: [point('2024-01-01')] }]);
      expect(sc.notice).toMatch(/Station IDs could not be resolved.*gdelt_list_tv_stations/);
      expect(sc.limitClamp).toEqual({ parameter: 'limit', requested: 5000, applied: 500 });
      expect(contentText(result)).toContain(sc.notice as string);
      expect(contentText(result)).toContain('### FOX News (no station ID)');
    });

    /**
     * Through the real service, with only GDELT stubbed: a timeline series that carries no label
     * is not a label the catalog lacks, so the notice says GDELT sent it without one.
     */
    it('says GDELT returned a series without a station label, beside a label the catalog lacks', async () => {
      const svc = new tvServiceModule.GdeltTvService(
        {} as never,
        {} as never,
        {
          baseUrl: 'https://api.gdeltproject.org/api/v2',
          requestTimeoutMs: 60_000,
        } as never,
      );
      vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue(svc);
      const fetchSpy = vi.spyOn(gdeltFetchModule, 'gdeltFetch');
      onTestFinished(() => fetchSpy.mockRestore());
      fetchSpy.mockImplementation(async (_url, params) =>
        params.get('mode') === 'stationdetails'
          ? {
              station_details: [
                {
                  StationID: 'FOXNEWS',
                  Description: 'FOX News',
                  Market: 'National',
                  Network: 'FOX',
                  StartDate: '20110101',
                  EndDate: '20241010',
                },
              ],
            }
          : {
              timeline: [
                { data: [{ date: '20240101T000000Z', value: 1 }] },
                { series: 'KZZZ Local News', data: [{ date: '20240101T000000Z', value: 2 }] },
                { series: 'FOX News', data: [{ date: '20240101T000000Z', value: 3 }] },
              ],
            },
      );
      const result = await runToolContract(gdeltSearchTv, { query: 'x', stations: ['FOXNEWS'] });
      const sc = result.structuredContent as {
        series: Array<{ station?: string; stationName: string }>;
        notice: string;
      };
      expect(sc.series.map((s) => [s.stationName, s.station])).toEqual([
        ['', undefined],
        ['KZZZ Local News', undefined],
        ['FOX News', 'FOXNEWS'],
      ]);
      expect(sc.notice).toBe(
        'GDELT returned 1 series without a station label, so its stationName is empty and station ' +
          'is absent. No station in GDELT\'s station catalog is labeled "KZZZ Local News", so station ' +
          'is absent where stationName is "KZZZ Local News"; find its ID with gdelt_list_tv_stations.',
      );
      expect(contentText(result)).toContain(sc.notice);
      expect(contentText(result)).toContain('### (no station label)\n');
      expect(contentText(result)).toContain('### FOX News (FOXNEWS)\n');
    });

    it('describes the station fields and the unresolved-ID notice', () => {
      const item = gdeltSearchTv.output.shape.series.element.shape;
      expect(item.station.description).toMatch(
        /^Station ID — the value the stations input and the station: operator take .*Absent when GDELT's label for the station could not be resolved to an ID/,
      );
      expect(item.stationName.description).toMatch(
        /^GDELT's display label for the station .*Empty when GDELT returned the series without one/,
      );
      expect(gdeltSearchTv.enrichment?.notice?.description).toMatch(
        /When a returned series has no station ID, why: GDELT returned it without a station label, or its station catalog did not load or has no entry for the named label — with how to look the ID up\./,
      );
    });
  });

  /**
   * The per-station lines in content[] summarize only the points on the returned page — a
   * timeline longer than one page has a different sum and peak on every page.
   */
  describe('page-scoped station summaries', () => {
    // One station, 600 hourly points valued 1..600: page 1 holds 1..500, page 2 holds 501..600.
    const LONG = {
      series: [
        {
          station: 'CNN',
          stationName: 'CNN',
          data: Array.from({ length: 600 }, (_, h) => ({
            date: new Date(Date.UTC(2024, 0, 1, h)).toISOString().replace('.000Z', 'Z'),
            value: h + 1,
          })),
        },
      ],
      dateResolution: 'hour' as const,
      normalized: false,
    };

    beforeEach(() => {
      vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
        searchTv: vi.fn().mockResolvedValue(LONG),
      } as unknown as tvServiceModule.GdeltTvService);
    });

    it('labels both pages of a two-page timeline as covering that page', async () => {
      const first = contentText(
        await runToolContract(gdeltSearchTv, { query: 'x', stations: ['CNN'], limit: 500 }),
      );
      const second = contentText(
        await runToolContract(gdeltSearchTv, {
          query: 'x',
          stations: ['CNN'],
          limit: 500,
          offset: 500,
        }),
      );
      expect(first).toContain('Points on this page: 500 | Sum on this page: 125250.00');
      expect(first).toContain('Page peak: 500.000 at 2024-01-21T19:00:00Z');
      expect(second).toContain('Points on this page: 100 | Sum on this page: 55050.00');
      expect(second).toContain('Page peak: 600.000 at 2024-01-25T23:00:00Z');
      for (const text of [first, second]) {
        expect(text).not.toMatch(/Total:/);
        expect(text).not.toMatch(/^Peak:/m);
      }
    });

    it('labels a one-page result the same way', async () => {
      const short = {
        ...LONG,
        series: [{ ...LONG.series[0]!, data: LONG.series[0]!.data.slice(0, 3) }],
      };
      vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
        searchTv: vi.fn().mockResolvedValue(short),
      } as unknown as tvServiceModule.GdeltTvService);
      const result = await runToolContract(gdeltSearchTv, { query: 'x', stations: ['CNN'] });
      expect(result.structuredContent).not.toHaveProperty('nextOffset');
      const text = contentText(result);
      expect(text).toContain('Points on this page: 3 | Sum on this page: 6.00');
      expect(text).toContain('Page peak: 3.000 at 2024-01-01T02:00:00Z');
      expect(text).not.toMatch(/Total:/);
    });
  });
});
