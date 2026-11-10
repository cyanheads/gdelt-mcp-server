/** Relative-timespan validation and date echoes through production tool contracts. */
import { z } from '@cyanheads/mcp-ts-core';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gdeltGetCoverageBreakdown } from '@/mcp-server/tools/definitions/get-coverage-breakdown.tool.js';
import { gdeltGetCoverageTimeline } from '@/mcp-server/tools/definitions/get-coverage-timeline.tool.js';
import { gdeltGetToneDistribution } from '@/mcp-server/tools/definitions/get-tone-distribution.tool.js';
import { gdeltGetTvBreakdown } from '@/mcp-server/tools/definitions/get-tv-breakdown.tool.js';
import { gdeltGetTvClips } from '@/mcp-server/tools/definitions/get-tv-clips.tool.js';
import { gdeltGetTvContext } from '@/mcp-server/tools/definitions/get-tv-context.tool.js';
import { gdeltSearchArticles } from '@/mcp-server/tools/definitions/search-articles.tool.js';
import { gdeltSearchTv } from '@/mcp-server/tools/definitions/search-tv.tool.js';
import * as doc from '@/services/gdelt/gdelt-doc-service.js';
import { parseGdeltJson } from '@/services/gdelt/gdelt-fetch.js';
import { disposeGdeltPacer, initGdeltPacer } from '@/services/gdelt/gdelt-pacer.js';
import {
  disposeGdeltResponseCache,
  initGdeltResponseCache,
} from '@/services/gdelt/gdelt-response-cache.js';
import * as tv from '@/services/gdelt/gdelt-tv-service.js';
import { contentText, literalHtml, renderMarkdown } from './markdown-render.js';

afterEach(() => {
  disposeGdeltPacer();
  disposeGdeltResponseCache();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('DOC explicit-window precedence', () => {
  for (const tool of [
    gdeltSearchArticles,
    gdeltGetCoverageTimeline,
    gdeltGetCoverageBreakdown,
    gdeltGetToneDistribution,
  ]) {
    describe(tool.name, () => {
      function arrange() {
        initGdeltPacer(0);
        initGdeltResponseCache();
        doc.initGdeltDocService({} as never, {} as never, {
          baseUrl: 'https://api.gdeltproject.org/api/v2',
          requestDelayMs: 0,
          requestTimeoutMs: 60000,
          clampLimits: true,
          mirrorWindowDays: 7,
        });
        return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({}));
      }
      const base = {
        query: 'climate',
        ...(tool === gdeltGetCoverageTimeline ? { mode: 'volume' as const } : {}),
        ...(tool === gdeltGetCoverageBreakdown ? { breakdownBy: 'country' as const } : {}),
      };
      it.each(['1min', '0d', '0days', '0hours', '0weeks', '0months', '0years'])(
        'ignores unused %s and makes one request',
        async (timespan) => {
          const fetch = arrange();
          const result = await runToolContract(tool, {
            ...base,
            timespan,
            startDatetime: '20261015000000',
            endDatetime: '20261022000000',
          });
          expect(result.isError, JSON.stringify(result)).not.toBe(true);
          expect(fetch).toHaveBeenCalledTimes(1);
          const url = new URL(String(fetch.mock.calls[0]?.[0]));
          expect(url.searchParams.get('startdatetime')).toBe('20261015000000');
          expect(url.searchParams.get('enddatetime')).toBe('20261022000000');
          expect(url.searchParams.has('timespan')).toBe(false);
          expect(contentText(result)).not.toMatch(/15 minutes/);
        },
      );
      it.each(['1min', '0days'])('rejects active %s before I/O', async (timespan) => {
        const fetch = arrange();
        const result = await runToolContract(tool, { ...base, timespan });
        expect(result).toMatchObject({
          isError: true,
          structuredContent: { error: { code: -32602, data: { reason: 'invalid_arguments' } } },
        });
        expect(contentText(result)).toMatch(/15 minutes/);
        expect(fetch).not.toHaveBeenCalled();
      });
      it.each([
        { startDatetime: '20261015000000' },
        { startDatetime: '20260230000000', endDatetime: '20261022000000' },
      ])('preserves date-range failure ownership for %j', async (dates) => {
        const fetch = arrange();
        const result = await runToolContract(tool, { ...base, timespan: '0days', ...dates });
        expect(result).toMatchObject({
          isError: true,
          structuredContent: { error: { data: { reason: 'invalid_date_range' } } },
        });
        expect(contentText(result)).toMatch(/startDatetime/);
        expect(fetch).not.toHaveBeenCalled();
      });
      it('preserves unknown numeric-plus-unit syntax upstream', async () => {
        const fetch = arrange();
        const result = await runToolContract(tool, { ...base, timespan: '1futureunit' });
        expect(result.isError).not.toBe(true);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(new URL(String(fetch.mock.calls[0]?.[0])).searchParams.get('timespan')).toBe(
          '1futureunit',
        );
      });
      it('preserves scalar repair and emitted datetime/string schemas', async () => {
        const fetch = arrange();
        const schema = z.toJSONSchema(tool.input);
        expect(schema.properties?.timespan).toMatchObject({ type: 'string' });
        expect(schema.properties?.startDatetime).toMatchObject({
          type: 'string',
          pattern: '^\\d{14}$',
        });
        const result = await runToolContract(tool, {
          ...base,
          timespan: '0days',
          startDatetime: 20261015000000,
          endDatetime: 20261022000000,
        } as never);
        expect(result.isError).not.toBe(true);
        expect(fetch).toHaveBeenCalledTimes(1);
      });
    });
  }
});
describe('TV timespan input', () => {
  it.each([gdeltSearchTv, gdeltGetTvClips, gdeltGetTvContext])(
    '$name rejects garbage before service access',
    async (tool) => {
      const access = vi.spyOn(tv, 'getGdeltTvService');
      const result = await runToolContract(tool, {
        query: 'climate',
        stations: ['CNN'],
        timespan: 'garbage',
      });
      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          error: {
            data: {
              reason: 'invalid_query',
              recovery: { hint: expect.stringMatching(/timespan/i) },
            },
          },
        },
      });
      expect(contentText(result)).toMatch(/timespan/i);
      expect(access).not.toHaveBeenCalled();
    },
  );
  it.each(['', '   ', '1w', '2weeks', '1y', '30min', '2futureunit', '1.5h', '1 h', '-1h'])(
    'preserves %j for upstream interpretation',
    async (timespan) => {
      const searchTv = vi.fn().mockResolvedValue({ series: [], normalized: true });
      vi.spyOn(tv, 'getGdeltTvService').mockReturnValue({
        searchTv,
        stationRanges: vi.fn().mockResolvedValue(undefined),
      } as unknown as tv.GdeltTvService);
      const result = await runToolContract(gdeltSearchTv, {
        query: 'climate',
        stations: ['CNN'],
        timespan,
      });
      expect(result.isError).not.toBe(true);
      expect(searchTv).toHaveBeenCalledTimes(1);
    },
  );
  it('ignores malformed timespan when explicit dates win', async () => {
    const searchTv = vi.fn().mockResolvedValue({ series: [], normalized: true });
    vi.spyOn(tv, 'getGdeltTvService').mockReturnValue({
      searchTv,
      stationRanges: vi.fn().mockResolvedValue(undefined),
    } as unknown as tv.GdeltTvService);
    const result = await runToolContract(gdeltSearchTv, {
      query: 'climate',
      stations: ['CNN'],
      timespan: 'garbage',
      startDatetime: '20200101000000',
      endDatetime: '20200102000000',
    });
    expect(result.isError).not.toBe(true);
    expect(searchTv).toHaveBeenCalledTimes(1);
  });

  /**
   * A relative window counts back from now, past the end of most stations' monitoring, so no TV
   * timespan description offers a short one bare; each points to archived periods instead. Each
   * notice description names what the handler emits for selected stations outside the window,
   * and none promises a sentence no handler writes.
   */
  it.each([gdeltSearchTv, gdeltGetTvClips, gdeltGetTvContext, gdeltGetTvBreakdown])(
    '$name describes timespan and notice as the handler uses them',
    (tool) => {
      const timespan = (tool.input.shape as { timespan: z.ZodType }).timespan.description;
      expect(timespan).toMatch(/^Relative window counting back from now/);
      expect(timespan).toMatch(/past the end of most stations' monitoring/);
      expect(timespan).toMatch(
        /set startDatetime\/endDatetime inside a station's range from gdelt_list_tv_stations/,
      );
      expect(timespan).toMatch(/Ignored when startDatetime\/endDatetime are set\./);
      expect(timespan).not.toMatch(/\b\d+(?:m|y|d|w|h|min)\b/);
      const notice = tool.enrichment?.notice?.description;
      expect(notice).toMatch(
        /for each selected station whose monitoring range the window misses, that range and how to search inside it/,
      );
      expect(notice).not.toMatch(/October 2024|archive cutoff/);
      // The handler's own malformed-timespan rejection is part of the invalid_query contract.
      expect(tool.errors?.find((entry) => entry.reason === 'invalid_query')?.when).toMatch(
        /the TV timespan is malformed\.$/,
      );
    },
  );
});

describe('relative windows on both surfaces', () => {
  it('continues a week window through the upstream ceiling and another capped half', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-02-15T12:00:00Z'));
    const searchArticles = vi.fn(
      async (params: Parameters<doc.GdeltDocService['searchArticles']>[0]) => {
        const start = params.startDatetime ?? '20240208120000';
        return {
          articles: Array.from({ length: 250 }, (_, index) => ({
            url: `https://e.co/${index}`,
            title: '',
            seendate: `${start.slice(0, 8)}T${start.slice(8)}Z`,
            domain: '',
            language: '',
            sourcecountry: '',
          })),
          totalReturned: 250,
        };
      },
    );
    vi.spyOn(doc, 'getGdeltDocService').mockReturnValue({
      searchArticles,
    } as unknown as doc.GdeltDocService);
    let args = { query: 'climate', timespan: '1week', maxRecords: 250 };
    for (let level = 0; level < 2; level++) {
      const result = await runToolContract(gdeltSearchArticles, args);
      expect(result.isError).not.toBe(true);
      const data = result.structuredContent as {
        continuationWindows: [
          { startDatetime: string; endDatetime: string },
          { startDatetime: string; endDatetime: string },
        ];
      };
      expect(data.continuationWindows).toHaveLength(2);
      expect(contentText(result)).toContain(data.continuationWindows[0].startDatetime);
      args = { ...args, ...data.continuationWindows[0] };
    }
    expect(searchArticles).toHaveBeenCalledTimes(2);
  });
  it('echoes resolved dates on empty long-unit results', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-02-15T12:00:00Z'));
    vi.spyOn(doc, 'getGdeltDocService').mockReturnValue({
      searchArticles: vi.fn().mockResolvedValue({ articles: [] }),
    } as unknown as doc.GdeltDocService);
    const result = await runToolContract(gdeltSearchArticles, {
      query: 'climate',
      timespan: '1week',
    });
    expect(result.structuredContent).toMatchObject({
      notice: expect.stringContaining('2024-02-08'),
    });
    expect(contentText(result)).toContain('2024-02-08');
  });
});

describe('tailored rejection recovery on both surfaces', () => {
  it.each([
    [
      'Your query must contain at least one station.',
      /stations.*station:.*network:.*market:.*gdelt_list_tv_stations/,
    ],
    ['Hourly DATERES not available for >7 day timespans.', /seven/],
    ['Invalid query start date, earliest start date is July 2, 2009.', /window/],
    [
      'You cannot have multiple standalone non-negative station/show/network/market selectors.',
      /selectors/,
    ],
    ['Invalid/Unsupported Country.', /FIPS/],
  ])('preserves recovery for %s', async (body, expected) => {
    vi.spyOn(tv, 'getGdeltTvService').mockReturnValue({
      searchTv: vi.fn(() => parseGdeltJson(body, 'GDELT TV')),
    } as unknown as tv.GdeltTvService);
    const result = await runToolContract(gdeltSearchTv, { query: 'climate', stations: ['CNN'] });
    const error = (
      result.structuredContent as {
        error: { data: { reason: string; recovery: { hint: string } } };
      }
    ).error;
    expect(error.data.reason).toBe('invalid_query');
    expect(error.data.recovery.hint).toMatch(expected);
    expect(renderMarkdown(contentText(result))).toContain(literalHtml(error.data.recovery.hint));
  });
});
