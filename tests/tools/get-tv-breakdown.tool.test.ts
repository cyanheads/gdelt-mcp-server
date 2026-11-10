/**
 * @fileoverview TV ranking paging, units, selectors, and error contracts.
 * @module tests/tools/get-tv-breakdown.tool.test
 */

import { rateLimited, requestCancelled } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gdeltGetTvBreakdown } from '@/mcp-server/tools/definitions/get-tv-breakdown.tool.js';
import * as service from '@/services/gdelt/gdelt-tv-service.js';
import { contentText } from './markdown-render.js';
import { CNN_RANGE, expectNotice, freezeClock } from './station-range-fixtures.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function mockService(result: unknown) {
  const svc = {
    getTvBreakdown: vi.fn().mockResolvedValue(result),
    stationRanges: vi.fn().mockResolvedValue(CNN_RANGE),
  };
  vi.spyOn(service, 'getGdeltTvService').mockReturnValue(svc as unknown as service.GdeltTvService);
  return svc;
}

function mockResult(result: unknown) {
  return mockService(result).getTvBreakdown;
}

describe('gdeltGetTvBreakdown', () => {
  it('sorts full results by descending value and exact labels, then walks every page', async () => {
    const get = mockResult({
      rows: [
        { label: 'b', value: 2, station: 'B' },
        { label: 'a', value: 2, station: 'A' },
        { label: 'Z', value: 2, station: 'Z' },
        { label: 'high', value: 3, station: 'H' },
        { label: 'low', value: 1, station: 'L' },
      ],
      valueUnit: 'percent_station_airtime',
    });
    const seen: string[] = [];
    for (const offset of [0, 2, 4]) {
      const response = await runToolContract(gdeltGetTvBreakdown, {
        query: 'x',
        breakdownBy: 'station',
        limit: 2,
        offset,
      });
      expect(response.isError).toBeFalsy();
      const sc = response.structuredContent as {
        rows: Array<{ label: string; station: string }>;
        nextOffset?: number;
      };
      expect(response.structuredContent).toMatchObject({
        totalRows: 5,
        offset,
        limit: 2,
        valueUnit: 'percent_station_airtime',
        truncated: offset < 4,
      });
      expect(sc.nextOffset).toBe(offset < 4 ? offset + 2 : undefined);
      for (const row of sc.rows) {
        expect(contentText(response)).toContain(`**${row.label}** (${row.station})`);
        seen.push(row.label);
      }
      expect(contentText(response)).toContain('percent_station_airtime');
      expect(contentText(response)).toContain(`offset ${offset}, limit 2, total 5`);
    }
    expect(seen).toEqual(['high', 'Z', 'a', 'b', 'low']);
    expect(get).toHaveBeenCalledTimes(3);
    const past = await runToolContract(gdeltGetTvBreakdown, {
      query: 'x',
      breakdownBy: 'station',
      offset: 5,
    });
    expect(past.isError).toBe(true);
    expect(past.structuredContent).toMatchObject({
      error: {
        data: { reason: 'offset_out_of_range', recovery: { hint: expect.stringContaining('0–4') } },
      },
    });
    expect(contentText(past)).toContain('0–4');
  });

  it('retains ellipsized show labels and matching-clip units with normalize=false', async () => {
    const label = 'Campaign 2020 Rep. Katie Porter Campaigns for Sen. Elizabeth Warren D-MA in...';
    const get = mockResult({
      rows: [{ label, value: 0.3149 }],
      valueUnit: 'percent_matching_clips',
    });
    const response = await runToolContract(gdeltGetTvBreakdown, {
      query: '"climate change" market:"National"',
      breakdownBy: 'show',
      normalize: false,
    });
    expect(get).toHaveBeenCalledWith(
      expect.objectContaining({ normalize: false, breakdownBy: 'show' }),
      expect.anything(),
    );
    expect(response.structuredContent).toMatchObject({
      rows: [{ label, value: 0.3149 }],
      valueUnit: 'percent_matching_clips',
      notice: expect.stringContaining('regardless of normalize'),
    });
    expect(contentText(response)).toContain(label);
    expect(contentText(response)).toContain('percent_matching_clips');
    expect(contentText(response)).toContain('0.3149');
    expect(contentText(response)).toContain('may not work as exact show: selectors');
  });

  it.each([true, false])(
    'preserves station labels with catalogUnavailable=%s',
    async (unavailable) => {
      mockResult({
        rows: [{ label: '*unknown*', value: 5 }],
        valueUnit: 'matching_clips',
        ...(unavailable && { stationCatalogUnavailable: true }),
      });
      const response = await runToolContract(gdeltGetTvBreakdown, {
        query: 'x',
        breakdownBy: 'station',
        normalize: false,
      });
      expect(response.structuredContent).toMatchObject({
        rows: [{ label: '*unknown*', value: 5 }],
        valueUnit: 'matching_clips',
        notice: expect.stringContaining('Station IDs could not be resolved'),
      });
      expect(contentText(response)).toContain('**\\*unknown\\***: 5');
      expect(contentText(response)).toContain('gdelt_list_tv_stations');
    },
  );

  it('defaults to 25 rows and reaches the cap without a byte cut', async () => {
    const rows = Array.from({ length: 10001 }, (_, i) => ({
      label: `show${String(i).padStart(5, '0')}`,
      value: 1,
    }));
    mockResult({ rows, valueUnit: 'percent_matching_clips' });
    const first = await runToolContract(gdeltGetTvBreakdown, { query: 'x', breakdownBy: 'show' });
    expect(first.structuredContent).toMatchObject({ limit: 25, nextOffset: 25, totalRows: 10001 });
    const atCap = await runToolContract(gdeltGetTvBreakdown, {
      query: 'x',
      breakdownBy: 'show',
      limit: 10000,
    });
    expect((atCap.structuredContent as { rows: unknown[] }).rows).toHaveLength(10000);
    expect(contentText(atCap)).toContain('**show09999**: 1');
    expect(atCap.structuredContent).not.toHaveProperty('limitClamp');
    const clamped = await runToolContract(gdeltGetTvBreakdown, {
      query: 'x',
      breakdownBy: 'show',
      limit: '10001',
    } as never);
    expect(clamped.structuredContent).toMatchObject({
      limit: 10000,
      limitClamp: { parameter: 'limit', requested: 10001, applied: 10000 },
    });
    expect(contentText(clamped)).toContain('10001 → 10000');
    const last = await runToolContract(gdeltGetTvBreakdown, {
      query: 'x',
      breakdownBy: 'show',
      offset: 10000,
    });
    expect(last.structuredContent).toMatchObject({
      rows: [{ label: 'show10000', value: 1 }],
      truncated: false,
    });
    expect(last.structuredContent).not.toHaveProperty('nextOffset');
  });

  it('ignores offsets on empty results and composes the show notice', async () => {
    mockResult({ rows: [], valueUnit: 'percent_matching_clips' });
    const response = await runToolContract(gdeltGetTvBreakdown, {
      query: 'x',
      breakdownBy: 'show',
      offset: 500,
    });
    expect(response.isError).toBeFalsy();
    expect(response.structuredContent).toMatchObject({
      rows: [],
      totalRows: 0,
      offset: 500,
      truncated: false,
    });
    expect(contentText(response)).toContain('No TV rankings');
    expect(contentText(response)).toContain('Show values are percentages');
  });

  it.each([-1, 0, 1.5, true])('rejects invalid count %s without service I/O', async (limit) => {
    const get = mockResult({ rows: [], valueUnit: 'matching_clips' });
    const response = await runToolContract(gdeltGetTvBreakdown, {
      query: 'x',
      breakdownBy: 'station',
      limit,
    } as never);
    expect(response.isError).toBe(true);
    expect(get).not.toHaveBeenCalled();
  });

  it('rejects strict oversized counts before I/O', async () => {
    vi.stubEnv('GDELT_CLAMP_LIMITS', 'false');
    vi.resetModules();
    try {
      const { gdeltGetTvBreakdown: strictTool } = await import(
        '@/mcp-server/tools/definitions/get-tv-breakdown.tool.js'
      );
      const strictService = await import('@/services/gdelt/gdelt-tv-service.js');
      const accessor = vi.spyOn(strictService, 'getGdeltTvService');
      for (const limit of [10001, '10001']) {
        const response = await runToolContract(strictTool, {
          query: 'x',
          breakdownBy: 'station',
          limit,
        } as never);
        expect(response.isError).toBe(true);
      }
      expect(accessor).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it.each([{ startDatetime: '20200101000000' }, { timespan: 'last week' }, { offset: -1 }])(
    'rejects invalid window/offset before service I/O: %s',
    async (extra) => {
      const get = mockResult({ rows: [], valueUnit: 'matching_clips' });
      const response = await runToolContract(gdeltGetTvBreakdown, {
        query: 'x',
        breakdownBy: 'station',
        ...extra,
      });
      expect(response.isError).toBe(true);
      expect(get).not.toHaveBeenCalled();
    },
  );

  it('forwards the full selector list and explicit pair over an invalid timespan', async () => {
    const get = mockResult({ rows: [], valueUnit: 'matching_clips' });
    const stations = Array.from({ length: 15 }, (_, i) => `S${i}`);
    const response = await runToolContract(gdeltGetTvBreakdown, {
      query: 'x',
      breakdownBy: 'station',
      stations,
      timespan: '7h',
      startDatetime: '20200101000000',
      endDatetime: '20200201000000',
    });
    expect(response.isError).toBeFalsy();
    expect(get).toHaveBeenCalledWith(
      expect.objectContaining({
        stations,
        startDatetime: '20200101000000',
        endDatetime: '20200201000000',
      }),
      expect.anything(),
    );
  });

  it('propagates cancellation without a successful ranking', async () => {
    const controller = new AbortController();
    const get = vi.fn().mockImplementation(async (_params, ctx) => {
      controller.abort();
      expect(ctx.signal.aborted).toBe(true);
      throw requestCancelled('Ranking cancelled.');
    });
    vi.spyOn(service, 'getGdeltTvService').mockReturnValue({
      getTvBreakdown: get,
    } as unknown as service.GdeltTvService);
    const response = await runToolContract(
      gdeltGetTvBreakdown,
      { query: 'x', breakdownBy: 'show' },
      { context: { signal: controller.signal } },
    );
    expect(response.isError).toBe(true);
    expect(contentText(response)).toContain('cancelled');
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('carries declared rate-limit recovery on both surfaces', async () => {
    const get = mockResult({});
    get.mockRejectedValue(rateLimited('Rate limited.', { reason: 'gdelt_rate_limited' }));
    const response = await runToolContract(gdeltGetTvBreakdown, {
      query: 'x',
      breakdownBy: 'station',
    });
    expect(response.isError).toBe(true);
    expect(contentText(response)).toContain('Back off');
    expect(response.structuredContent).toMatchObject({
      error: { data: { reason: 'gdelt_rate_limited' } },
    });
  });
});

/**
 * An empty ranking for selected stations names each one whose monitoring range the window
 * misses, right after the resolved-timespan sentence; the sentence itself is tabled in
 * station-ids.test.ts. The catalog is consulted only when that sentence can be built.
 */
describe('gdeltGetTvBreakdown selected stations outside the window', () => {
  const EMPTY = { rows: [], valueUnit: 'percent_station_airtime' };
  const NAMED_AFTER =
    'CNN was monitored 2009-07-02 – 2024-10-10; the window starts after that range ends. Set startDatetime and endDatetime inside that range to search that station.';
  const TAIL = 'Check station monitoring ranges with gdelt_list_tv_stations or broaden the query.';

  it('names a range the resolved timespan starts after, looked up once from the call start', async () => {
    freezeClock();
    const svc = mockService(EMPTY);
    // The main request takes time; the catalog wait still counts from the call's start.
    svc.getTvBreakdown.mockImplementation(async () => {
      vi.setSystemTime(new Date('2026-11-10T12:00:30Z'));
      return EMPTY;
    });
    const result = await runToolContract(gdeltGetTvBreakdown, {
      query: 'inflation',
      breakdownBy: 'station',
      stations: [' cnn '],
      timespan: '6m',
    });
    expectNotice(
      result,
      `No TV rankings for "inflation". Timespan "6m" resolved to 2026-05-10 – 2026-11-10. ${NAMED_AFTER} ${TAIL}`,
    );
    expect(svc.stationRanges).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      Date.parse('2026-11-10T12:00:00Z'),
    );
  });

  it('names a range an explicit window ends before, ahead of the show notice', async () => {
    mockService({ rows: [], valueUnit: 'percent_matching_clips' });
    const result = await runToolContract(gdeltGetTvBreakdown, {
      query: 'x',
      breakdownBy: 'show',
      stations: ['CNN'],
      startDatetime: '20080101000000',
      endDatetime: '20080201000000',
    });
    expectNotice(
      result,
      `No TV rankings for "x". CNN was monitored 2009-07-02 – 2024-10-10; the window ends before that range starts. Set startDatetime and endDatetime inside that range to search that station. ${TAIL} Show values are percentages of matching clips, regardless of normalize. Provider labels may contain ellipses and may not work as exact show: selectors.`,
    );
  });

  it('keeps the notice as it was when the catalog is unavailable to the call', async () => {
    freezeClock();
    const svc = mockService(EMPTY);
    svc.stationRanges.mockResolvedValue(undefined);
    const result = await runToolContract(gdeltGetTvBreakdown, {
      query: 'x',
      breakdownBy: 'station',
      stations: ['CNN'],
      timespan: '6m',
    });
    expectNotice(
      result,
      `No TV rankings for "x". Timespan "6m" resolved to 2026-05-10 – 2026-11-10. ${TAIL}`,
    );
  });

  it.each<[string, Record<string, unknown>, unknown]>([
    ['no window is known', { stations: ['CNN'] }, EMPTY],
    ['stations are selected only in query', { query: 'x station:CNN', timespan: '6m' }, EMPTY],
    [
      'rows were returned',
      { stations: ['CNN'], timespan: '6m' },
      { rows: [{ label: 'CNN', value: 1, station: 'CNN' }], valueUnit: 'percent_station_airtime' },
    ],
    [
      'the catalog already failed to load in this call',
      { stations: ['CNN'], timespan: '6m' },
      { ...EMPTY, stationCatalogUnavailable: true },
    ],
  ])('never consults the catalog when %s', async (_case, input, answer) => {
    const svc = mockService(answer);
    const result = await runToolContract(gdeltGetTvBreakdown, {
      query: 'x',
      breakdownBy: 'station',
      ...input,
    } as never);
    expect(result.isError).toBeFalsy();
    expect(svc.stationRanges).not.toHaveBeenCalled();
    expect(String((result.structuredContent as { notice?: string }).notice)).not.toContain(
      'was monitored',
    );
  });
});
