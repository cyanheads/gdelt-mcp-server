/**
 * @fileoverview Input validation tests for all tool schemas. Verifies that missing,
 * malformed, and out-of-range inputs are rejected by the Zod schemas before handlers run,
 * that count inputs admit positive safe integers past the per-call cap, plus the rules the
 * handlers enforce on top: the cross-field date-range pairing, and the TV tools' `stations`
 * entries, cleaned and checked before any request.
 * @module tests/tools/input-validation.test
 */

import { type Context, z } from '@cyanheads/mcp-ts-core';
import { type ErrorContract, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gdeltGetCoverageBreakdown } from '@/mcp-server/tools/definitions/get-coverage-breakdown.tool.js';
import { gdeltGetCoverageTimeline } from '@/mcp-server/tools/definitions/get-coverage-timeline.tool.js';
import { gdeltGetToneDistribution } from '@/mcp-server/tools/definitions/get-tone-distribution.tool.js';
import { gdeltGetTvBreakdown } from '@/mcp-server/tools/definitions/get-tv-breakdown.tool.js';
import { gdeltGetTvClips } from '@/mcp-server/tools/definitions/get-tv-clips.tool.js';
import { gdeltGetTvContext } from '@/mcp-server/tools/definitions/get-tv-context.tool.js';
import { gdeltListTvStations } from '@/mcp-server/tools/definitions/list-tv-stations.tool.js';
import { gdeltSearchArticles } from '@/mcp-server/tools/definitions/search-articles.tool.js';
import { gdeltSearchThemes } from '@/mcp-server/tools/definitions/search-themes.tool.js';
import { gdeltSearchTv } from '@/mcp-server/tools/definitions/search-tv.tool.js';
import { disposeGdeltPacer, initGdeltPacer } from '@/services/gdelt/gdelt-pacer.js';
import {
  disposeGdeltResponseCache,
  initGdeltResponseCache,
} from '@/services/gdelt/gdelt-response-cache.js';
import * as tvServiceModule from '@/services/gdelt/gdelt-tv-service.js';
import { contentText, literalHtml, renderMarkdown } from './markdown-render.js';

describe('gdeltSearchArticles input validation', () => {
  it('rejects an empty query string', () => {
    expect(() => gdeltSearchArticles.input.parse({ query: '' })).toThrow();
  });

  it('rejects maxRecords below 1', () => {
    expect(() => gdeltSearchArticles.input.parse({ query: 'test', maxRecords: 0 })).toThrow();
  });

  it('rejects non-integer maxRecords', () => {
    expect(() => gdeltSearchArticles.input.parse({ query: 'test', maxRecords: 1.5 })).toThrow();
  });

  it('rejects an invalid sort value', () => {
    expect(() =>
      gdeltSearchArticles.input.parse({ query: 'test', sort: 'alphabetical' }),
    ).toThrow();
  });

  it('accepts valid query with defaults', () => {
    const parsed = gdeltSearchArticles.input.parse({ query: 'bird flu' });
    expect(parsed.query).toBe('bird flu');
    expect(parsed.maxRecords).toBe(75);
    expect(parsed.sort).toBe('relevance');
  });

  it('accepts every documented article sort value', () => {
    for (const sort of [
      'relevance',
      'dateDesc',
      'dateAsc',
      'toneDesc',
      'toneAsc',
      'hybridRel',
    ] as const) {
      expect(() => gdeltSearchArticles.input.parse({ query: 'test', sort })).not.toThrow();
    }
  });

  it.each(['date', 'social'])('rejects removed undocumented sort value %s', (sort) => {
    expect(() => gdeltSearchArticles.input.parse({ query: 'test', sort })).toThrow();
  });
});

describe('gdeltGetCoverageTimeline input validation', () => {
  it('rejects an empty query string', () => {
    expect(() => gdeltGetCoverageTimeline.input.parse({ query: '', mode: 'volume' })).toThrow();
  });

  it('rejects an invalid mode value', () => {
    expect(() =>
      gdeltGetCoverageTimeline.input.parse({ query: 'test', mode: 'invalid_mode' }),
    ).toThrow();
  });

  it('rejects smoothing above 30', () => {
    expect(() =>
      gdeltGetCoverageTimeline.input.parse({ query: 'test', mode: 'volume', smoothing: 31 }),
    ).toThrow();
  });

  it('rejects smoothing below 0', () => {
    expect(() =>
      gdeltGetCoverageTimeline.input.parse({ query: 'test', mode: 'volume', smoothing: -1 }),
    ).toThrow();
  });

  it('rejects non-integer smoothing', () => {
    expect(() =>
      gdeltGetCoverageTimeline.input.parse({ query: 'test', mode: 'volume', smoothing: 1.5 }),
    ).toThrow();
  });

  it('accepts every valid mode value', () => {
    for (const mode of ['volume', 'volume_raw', 'volume_with_articles', 'tone'] as const) {
      expect(() => gdeltGetCoverageTimeline.input.parse({ query: 'test', mode })).not.toThrow();
    }
  });

  it('accepts smoothing at boundaries and beyond the old cap', () => {
    for (const smoothing of [0, 1, 6, 30]) {
      expect(() =>
        gdeltGetCoverageTimeline.input.parse({ query: 'test', mode: 'volume', smoothing }),
      ).not.toThrow();
    }
  });
});

describe('gdeltGetCoverageBreakdown input validation', () => {
  it('rejects missing query', () => {
    expect(() => gdeltGetCoverageBreakdown.input.parse({ breakdownBy: 'country' })).toThrow();
  });

  it('rejects empty query string', () => {
    expect(() =>
      gdeltGetCoverageBreakdown.input.parse({ query: '', breakdownBy: 'country' }),
    ).toThrow();
  });

  it('rejects missing breakdownBy', () => {
    expect(() => gdeltGetCoverageBreakdown.input.parse({ query: 'test' })).toThrow();
  });

  it('rejects invalid breakdownBy value', () => {
    expect(() =>
      gdeltGetCoverageBreakdown.input.parse({ query: 'test', breakdownBy: 'topic' }),
    ).toThrow();
  });

  it('accepts both valid breakdownBy values', () => {
    for (const breakdownBy of ['language', 'country'] as const) {
      expect(() =>
        gdeltGetCoverageBreakdown.input.parse({ query: 'test', breakdownBy }),
      ).not.toThrow();
    }
  });
});

describe('gdeltGetToneDistribution input validation', () => {
  it('rejects empty query', () => {
    expect(() => gdeltGetToneDistribution.input.parse({ query: '' })).toThrow();
  });

  it('accepts a minimal valid input', () => {
    expect(() => gdeltGetToneDistribution.input.parse({ query: 'test' })).not.toThrow();
  });
});

describe.each([
  ['coverage timeline', gdeltGetCoverageTimeline, { query: 'test', mode: 'volume' }],
  ['coverage breakdown', gdeltGetCoverageBreakdown, { query: 'test', breakdownBy: 'country' }],
  ['TV timeline', gdeltSearchTv, { query: 'test' }],
] as const)('%s smoothing range', (_name, tool, base) => {
  it.each([0, 1, 6, 30])('preserves supported width %i', (smoothing) => {
    expect(tool.input.parse({ ...base, smoothing }).smoothing).toBe(smoothing);
  });
  it.each([-1, 1.5, 31])('rejects unsupported width %s', (smoothing) => {
    expect(() => tool.input.parse({ ...base, smoothing })).toThrow();
  });
});

describe('gdeltGetTvClips input validation', () => {
  it('rejects empty query', () => {
    expect(() => gdeltGetTvClips.input.parse({ query: '' })).toThrow();
  });

  it('rejects maxRecords below 1', () => {
    expect(() => gdeltGetTvClips.input.parse({ query: 'test', maxRecords: 0 })).toThrow();
  });

  it('rejects invalid sort value', () => {
    expect(() => gdeltGetTvClips.input.parse({ query: 'test', sort: 'newest' })).toThrow();
  });

  it('accepts all three valid sort values', () => {
    for (const sort of ['relevance', 'dateDesc', 'dateAsc'] as const) {
      expect(() => gdeltGetTvClips.input.parse({ query: 'test', sort })).not.toThrow();
    }
  });
});

/** Record tools preserve their provider fetch ranges. */
describe('maxRecords provider ranges', () => {
  it.each([
    ['gdelt_search_articles', gdeltSearchArticles, 250],
    ['gdelt_get_tv_clips', gdeltGetTvClips, 3000],
  ] as const)('%s accepts 1 through its ceiling', (_, tool, ceiling) => {
    expect(tool.input.parse({ query: 'test', maxRecords: 1 }).maxRecords).toBe(1);
    expect(tool.input.parse({ query: 'test', maxRecords: ceiling }).maxRecords).toBe(ceiling);
  });
});

/** The slice of a tool definition `runToolContract` takes, erased across count tools. */
type CountTool = Parameters<typeof runToolContract>[0];

/**
 * Count schemas accept positive safe integers for handler clamping. Invalid cases run
 * through the production argument-repair contract and reject before upstream I/O.
 */
const CLAMPED_COUNT_INPUTS: ReadonlyArray<{
  name: string;
  tool: CountTool;
  parameter: 'maxRecords' | 'limit';
  cap: number;
  fallback: number;
  base: Record<string, unknown>;
}> = [
  {
    name: 'gdelt_search_articles',
    tool: gdeltSearchArticles as unknown as CountTool,
    parameter: 'maxRecords',
    cap: 250,
    fallback: 75,
    base: { query: 'test' },
  },
  {
    name: 'gdelt_get_tv_clips',
    tool: gdeltGetTvClips as unknown as CountTool,
    parameter: 'maxRecords',
    cap: 3000,
    fallback: 50,
    base: { query: 'test', stations: ['CNN'] },
  },
  {
    name: 'gdelt_search_tv',
    tool: gdeltSearchTv as unknown as CountTool,
    parameter: 'limit',
    cap: 20000,
    fallback: 500,
    base: { query: 'test', stations: ['CNN'] },
  },
  {
    name: 'gdelt_search_themes',
    tool: gdeltSearchThemes as unknown as CountTool,
    parameter: 'limit',
    cap: 100,
    fallback: 25,
    base: { query: 'drought' },
  },
  {
    name: 'gdelt_get_coverage_timeline',
    tool: gdeltGetCoverageTimeline as unknown as CountTool,
    parameter: 'limit',
    cap: 400,
    fallback: 10,
    base: { query: 'test', mode: 'volume' },
  },
  {
    name: 'gdelt_get_tone_distribution',
    tool: gdeltGetToneDistribution as unknown as CountTool,
    parameter: 'limit',
    cap: 400,
    fallback: 10,
    base: { query: 'test' },
  },
  {
    name: 'gdelt_get_coverage_breakdown',
    tool: gdeltGetCoverageBreakdown as unknown as CountTool,
    parameter: 'limit',
    cap: 75,
    fallback: 10,
    base: { query: 'test', breakdownBy: 'country' },
  },
  {
    name: 'gdelt_get_tv_context',
    tool: gdeltGetTvContext as unknown as CountTool,
    parameter: 'limit',
    cap: 25000,
    fallback: 25,
    base: { query: 'test' },
  },
  {
    name: 'gdelt_get_tv_breakdown',
    tool: gdeltGetTvBreakdown as unknown as CountTool,
    parameter: 'limit',
    cap: 10000,
    fallback: 25,
    base: { query: 'test', breakdownBy: 'station' },
  },
];

describe.each(CLAMPED_COUNT_INPUTS)(
  '$name $parameter — clamped count input',
  ({ tool, parameter, cap, fallback, base }) => {
    const parse = (value: unknown) =>
      (tool.input as unknown as { parse: (v: unknown) => Record<string, unknown> }).parse({
        ...base,
        ...(value !== undefined && { [parameter]: value }),
      });
    const call = (value: unknown) =>
      runToolContract(tool, { ...base, [parameter]: value } as never);
    const expectInvalidParams = (result: Awaited<ReturnType<typeof call>>) =>
      expect(result).toMatchObject({
        isError: true,
        structuredContent: { error: { code: JsonRpcErrorCode.InvalidParams } },
      });

    it('admits safe integers beyond the cap to the handler as sent', () => {
      expect(parse(cap + 1)[parameter]).toBe(cap + 1);
      expect(parse(cap * 10 + 1)[parameter]).toBe(cap * 10 + 1);
      expect(parse(Number.MAX_SAFE_INTEGER)[parameter]).toBe(Number.MAX_SAFE_INTEGER);
    });

    it('rejects an unsafe integer sent as a numeric string', async () => {
      expectInvalidParams(await call(String(Number.MAX_SAFE_INTEGER + 1)));
    });

    it.each([0, -1, 1.5, true, 'many', Number.MAX_SAFE_INTEGER + 1])(
      'rejects %j as invalid_arguments',
      async (value) => {
        expectInvalidParams(await call(value));
      },
    );

    it('keeps its default', () => {
      expect(parse(undefined)[parameter]).toBe(fallback);
    });
  },
);

describe('gdeltGetTvContext input validation', () => {
  it('rejects empty query', () => {
    expect(() => gdeltGetTvContext.input.parse({ query: '' })).toThrow();
  });

  it('accepts a valid query', () => {
    expect(() => gdeltGetTvContext.input.parse({ query: 'pandemic' })).not.toThrow();
  });
});

describe('gdeltListTvStations input validation', () => {
  it('accepts an empty input object', () => {
    expect(() => gdeltListTvStations.input.parse({})).not.toThrow();
  });

  it('accepts every optional filter, blanks included', () => {
    const parsed = gdeltListTvStations.input.parse({
      stations: ['CNN', ''],
      network: ' ',
      market: 'San Francisco',
    });
    expect(parsed).toEqual({ stations: ['CNN', ''], network: ' ', market: 'San Francisco' });
  });

  it.each([{ stations: 'CNN' }, { stations: [42] }, { network: ['ABC'] }, { market: 7 }])(
    'rejects a wrongly typed filter %o',
    (input) => {
      expect(() => gdeltListTvStations.input.parse(input)).toThrow();
    },
  );

  it('rejects an unknown key rather than dropping it', () => {
    expect(() => gdeltListTvStations.input.parse({ station: 'CNN' })).toThrow();
  });
});

describe('gdeltSearchTv input validation', () => {
  it('rejects empty query', () => {
    expect(() => gdeltSearchTv.input.parse({ query: '' })).toThrow();
  });

  it('rejects non-integer smoothing', () => {
    expect(() => gdeltSearchTv.input.parse({ query: 'test', smoothing: 1.7 })).toThrow();
  });

  it('accepts valid query with optional fields', () => {
    const parsed = gdeltSearchTv.input.parse({ query: 'vaccine', stations: ['CNN'] });
    expect(parsed.query).toBe('vaccine');
    expect(parsed.stations).toEqual(['CNN']);
  });

  it('preserves every requested station beyond the old ten-station cap', () => {
    const stations = Array.from({ length: 40 }, (_, index) => `STATION${index}`);
    expect(gdeltSearchTv.input.parse({ query: 'test', stations }).stations).toEqual(stations);
  });

  it('preserves omitted and explicitly empty station selection', () => {
    expect(gdeltSearchTv.input.parse({ query: 'test station:CNN' }).stations).toBeUndefined();
    expect(gdeltSearchTv.input.parse({ query: 'test station:CNN', stations: [] }).stations).toEqual(
      [],
    );
  });

  it('accepts every documented TV date resolution and rejects unknown values', () => {
    for (const dateres of ['hour', 'day', 'week', 'month', 'year'] as const) {
      expect(() => gdeltSearchTv.input.parse({ query: 'test', dateres })).not.toThrow();
    }
    expect(() => gdeltSearchTv.input.parse({ query: 'test', dateres: 'minute' })).toThrow();
  });

  it('bounds point-page inputs', () => {
    expect(gdeltSearchTv.input.parse({ query: 'test' })).toMatchObject({ offset: 0, limit: 500 });
    expect(() => gdeltSearchTv.input.parse({ query: 'test', offset: -1 })).toThrow();
    expect(() => gdeltSearchTv.input.parse({ query: 'test', limit: 0 })).toThrow();
  });
});

/**
 * Structural slice of a tool definition the shared date-range cases exercise. The seven
 * tools carry unrelated input/output generics, so the table erases them.
 */
type DateRangeTool = {
  input: { parse: (value: unknown) => Record<string, unknown> };
  errors: readonly ErrorContract[];
  handler: (input: Record<string, unknown>, ctx: Context) => Promise<unknown>;
};

/** Every tool accepting an explicit window, with the minimum otherwise-valid input for each. */
const DATE_RANGE_TOOLS: ReadonlyArray<{
  name: string;
  tool: DateRangeTool;
  base: Record<string, unknown>;
}> = [
  {
    name: 'gdelt_get_tv_breakdown',
    tool: gdeltGetTvBreakdown as unknown as DateRangeTool,
    base: { query: 'test', breakdownBy: 'station' },
  },
  {
    name: 'gdelt_search_articles',
    tool: gdeltSearchArticles as unknown as DateRangeTool,
    base: { query: 'test' },
  },
  {
    name: 'gdelt_get_coverage_timeline',
    tool: gdeltGetCoverageTimeline as unknown as DateRangeTool,
    base: { query: 'test', mode: 'volume' },
  },
  {
    name: 'gdelt_get_tone_distribution',
    tool: gdeltGetToneDistribution as unknown as DateRangeTool,
    base: { query: 'test' },
  },
  {
    name: 'gdelt_get_coverage_breakdown',
    tool: gdeltGetCoverageBreakdown as unknown as DateRangeTool,
    base: { query: 'test', breakdownBy: 'country' },
  },
  {
    name: 'gdelt_search_tv',
    tool: gdeltSearchTv as unknown as DateRangeTool,
    base: { query: 'test' },
  },
  {
    name: 'gdelt_get_tv_clips',
    tool: gdeltGetTvClips as unknown as DateRangeTool,
    base: { query: 'test' },
  },
  {
    name: 'gdelt_get_tv_context',
    tool: gdeltGetTvContext as unknown as DateRangeTool,
    base: { query: 'test' },
  },
];

const VALID_START = '20240101000000';
const VALID_END = '20240131235959';

/** Every DOC tool that exposes the API's relative timespan input. */
const DOC_TIMESPAN_TOOLS = [
  { name: 'gdelt_search_articles', tool: gdeltSearchArticles, base: { query: 'test' } },
  {
    name: 'gdelt_get_coverage_timeline',
    tool: gdeltGetCoverageTimeline,
    base: { query: 'test', mode: 'volume' },
  },
  { name: 'gdelt_get_tone_distribution', tool: gdeltGetToneDistribution, base: { query: 'test' } },
  {
    name: 'gdelt_get_coverage_breakdown',
    tool: gdeltGetCoverageBreakdown,
    base: { query: 'test', breakdownBy: 'country' },
  },
] as const;

describe('DOC timespan minimum — enforced at the schema edge', () => {
  for (const { name, tool, base } of DOC_TIMESPAN_TOOLS) {
    describe(name, () => {
      it.each(['1min', '14min', '0h', '0d', '0m', '0y'])(
        'rejects parseable sub-15-minute timespan %s',
        (timespan) => {
          expect(() => tool.input.parse({ ...base, timespan })).toThrow(/15 minutes/i);
        },
      );

      it.each(['15min', '16min', '1h', '1d', '1m', '1y'])(
        'accepts supported timespan %s',
        (timespan) => {
          expect(() => tool.input.parse({ ...base, timespan })).not.toThrow();
        },
      );

      it('preserves unparsed syntax for the upstream classifier fallback', () => {
        expect(() => tool.input.parse({ ...base, timespan: '15mins' })).not.toThrow();
      });
    });
  }
});

describe('date-range format — enforced by the Zod field regex', () => {
  for (const { name, tool, base } of DATE_RANGE_TOOLS) {
    describe(name, () => {
      it('accepts a complete 14-digit range', () => {
        expect(() =>
          tool.input.parse({ ...base, startDatetime: VALID_START, endDatetime: VALID_END }),
        ).not.toThrow();
      });

      it.each([
        ['thirteen digits', '2024010100000'],
        ['fifteen digits', '202401010000000'],
        ['ISO 8601 rather than GDELT format', '2024-01-01T00:00:00'],
        ['date only', '20240101'],
        ['trailing non-digit', '2024010100000x'],
        ['empty string', ''],
      ])('rejects a startDatetime of %s', (_label, value) => {
        expect(() =>
          tool.input.parse({ ...base, startDatetime: value, endDatetime: VALID_END }),
        ).toThrow();
      });

      it.each([
        ['thirteen digits', '2024013123595'],
        ['ISO 8601 rather than GDELT format', '2024-01-31T23:59:59'],
        ['empty string', ''],
      ])('rejects an endDatetime of %s', (_label, value) => {
        expect(() =>
          tool.input.parse({ ...base, startDatetime: VALID_START, endDatetime: value }),
        ).toThrow();
      });

      /**
       * Pairing is a cross-field rule, so it deliberately does not live in the schema —
       * a lone boundary parses cleanly here and is rejected by the handler instead.
       * Keeping it out of the schema preserves the reason + recovery.hint contract that a
       * Zod object-level refinement would strip from the wire.
       */
      it('parses a lone boundary — pairing is the handler’s job, not the schema’s', () => {
        expect(() => tool.input.parse({ ...base, startDatetime: VALID_START })).not.toThrow();
        expect(() => tool.input.parse({ ...base, endDatetime: VALID_END })).not.toThrow();
      });
    });
  }
});

/**
 * Fourteen digits is a shape, not a date. These are the 14-digit values that are not real UTC
 * instants — and the two that matter most are the ones `isNaN(new Date(...))` cannot catch:
 * Feb 29 of a non-leap year and hour 24 both roll forward into a valid instant, which is the
 * same silent window shift the guard exists to stop.
 */
const IMPOSSIBLE_WINDOWS = [
  ['month 13', '20241301000000', '20241302000000'],
  ['day 32', '20240132000000', '20240201000000'],
  ['day 00', '20240100000000', '20240201000000'],
  ['minute 60', '20240101006000', '20240102000000'],
  ['second 60', '20240101000060', '20240102000000'],
  ['Feb 29 of a non-leap year', '20230229000000', '20230301000000'],
  ['April 31', '20240431000000', '20240501000000'],
  ['hour 24', '20240101240000', '20240102000000'],
  ['an impossible endDatetime', '20240101000000', '20240230000000'],
] as const;

/**
 * Wire-level call: schema, handler, and the error envelope as a client gets it — including
 * the declared `recovery` the framework fills onto a bare `ctx.fail(reason)`, which a direct
 * `handler()` throw does not carry.
 */
function callWire(tool: DateRangeTool, input: Record<string, unknown>) {
  return runToolContract(tool as unknown as Parameters<typeof runToolContract>[0], input as never);
}

/**
 * The handler guard runs before the service is resolved, so these cases need no service
 * mock: if the guard ever stops firing, the call falls through to an uninitialized-service
 * plain Error carrying no `data.reason`, and the assertions below fail rather than pass.
 */
describe('date-range validity — enforced in the handler', () => {
  for (const { name, tool, base } of DATE_RANGE_TOOLS) {
    describe(name, () => {
      it.each(IMPOSSIBLE_WINDOWS)(
        'rejects %s with invalid_date_range',
        async (_label, startDatetime, endDatetime) => {
          const ctx = createMockContext({ errors: tool.errors });
          const input = tool.input.parse({ ...base, startDatetime, endDatetime });
          await expect(tool.handler(input, ctx)).rejects.toMatchObject({
            data: { reason: 'invalid_date_range' },
          });
        },
      );

      it.each([
        ['a reversed window', VALID_END, VALID_START],
        ['an equal window', VALID_START, VALID_START],
      ])('rejects %s with invalid_date_range', async (_label, startDatetime, endDatetime) => {
        const ctx = createMockContext({ errors: tool.errors });
        const input = tool.input.parse({ ...base, startDatetime, endDatetime });
        await expect(tool.handler(input, ctx)).rejects.toMatchObject({
          data: { reason: 'invalid_date_range' },
        });
      });

      it('names ordering in the recovery hint', async () => {
        const result = await callWire(tool, {
          ...base,
          startDatetime: VALID_END,
          endDatetime: VALID_START,
        });
        expect(result).toMatchObject({
          isError: true,
          structuredContent: {
            error: {
              data: {
                reason: 'invalid_date_range',
                recovery: { hint: expect.stringMatching(/earlier than endDatetime/i) },
              },
            },
          },
        });
      });

      it('accepts a real leap day', async () => {
        const ctx = createMockContext({ errors: tool.errors });
        const input = tool.input.parse({
          ...base,
          startDatetime: '20240229000000',
          endDatetime: '20240301000000',
        });
        const outcome = await tool.handler(input, ctx).catch((error: unknown) => error);
        expect((outcome as { data?: { reason?: string } })?.data?.reason).not.toBe(
          'invalid_date_range',
        );
      });

      it('rejects a start-only window with invalid_date_range', async () => {
        const ctx = createMockContext({ errors: tool.errors });
        const input = tool.input.parse({ ...base, startDatetime: VALID_START });
        await expect(tool.handler(input, ctx)).rejects.toMatchObject({
          data: { reason: 'invalid_date_range' },
        });
      });

      it('rejects an end-only window with invalid_date_range', async () => {
        const ctx = createMockContext({ errors: tool.errors });
        const input = tool.input.parse({ ...base, endDatetime: VALID_END });
        await expect(tool.handler(input, ctx)).rejects.toMatchObject({
          data: { reason: 'invalid_date_range' },
        });
      });

      it('surfaces a recovery hint naming both boundaries and the timespan fallback', async () => {
        const result = await callWire(tool, { ...base, startDatetime: VALID_START });
        expect(result).toMatchObject({
          isError: true,
          structuredContent: {
            error: {
              data: {
                reason: 'invalid_date_range',
                recovery: {
                  hint: expect.stringMatching(/startDatetime.*endDatetime.*timespan/s),
                },
              },
            },
          },
        });
      });
    });
  }
});

/** The four TV tools that splice `stations` into the query, with the minimum valid input for each. */
const STATION_TOOLS: ReadonlyArray<{
  name: string;
  tool: DateRangeTool;
  base: Record<string, unknown>;
}> = [
  { name: 'gdelt_search_tv', tool: gdeltSearchTv as unknown as DateRangeTool, base: {} },
  { name: 'gdelt_get_tv_clips', tool: gdeltGetTvClips as unknown as DateRangeTool, base: {} },
  { name: 'gdelt_get_tv_context', tool: gdeltGetTvContext as unknown as DateRangeTool, base: {} },
  {
    name: 'gdelt_get_tv_breakdown',
    tool: gdeltGetTvBreakdown as unknown as DateRangeTool,
    base: { breakdownBy: 'station' },
  },
];

/**
 * Wiring only — the full entry table is `tests/tools/station-ids.test.ts`. Each tool runs its real
 * service and fetch path with only the global `fetch` stubbed, so what a case asserts is the
 * query GDELT receives, or that no request left at all. A `{}` body is GDELT's zero-match
 * answer: without both a selected station and a known window it needs no station-catalog
 * lookup, so a passing call makes exactly one request.
 */
describe('stations entries — cleaned and checked in the handler', () => {
  afterEach(() => {
    disposeGdeltPacer();
    disposeGdeltResponseCache();
    vi.restoreAllMocks();
  });

  function arrange() {
    initGdeltPacer(0);
    initGdeltResponseCache();
    vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue(
      new tvServiceModule.GdeltTvService(
        {} as never,
        {} as never,
        {
          baseUrl: 'https://api.gdeltproject.org/api/v2',
          requestDelayMs: 0,
          requestTimeoutMs: 60_000,
        } as never,
      ),
    );
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({}));
  }

  /** The `query` parameter of the one request the call made. */
  function sentQuery(fetch: ReturnType<typeof arrange>): string | null {
    expect(fetch).toHaveBeenCalledTimes(1);
    return new URL(String(fetch.mock.calls[0]?.[0])).searchParams.get('query');
  }

  for (const { name, tool, base } of STATION_TOOLS) {
    describe(name, () => {
      it('refuses a display label before any request, with a station-ID recovery on both surfaces', async () => {
        const fetch = arrange();
        const result = await callWire(tool, {
          ...base,
          query: 'climate',
          stations: ['CNN', 'FOX News'],
        });

        expect(fetch).not.toHaveBeenCalled();
        expect(result).toMatchObject({
          isError: true,
          structuredContent: {
            error: {
              code: JsonRpcErrorCode.ValidationError,
              message: expect.stringMatching(
                /"FOX News".*station IDs such as CNN or FOXNEWS.*gdelt_list_tv_stations/,
              ),
              data: {
                reason: 'invalid_query',
                recovery: { hint: expect.stringMatching(/gdelt_list_tv_stations.*stationId/) },
              },
            },
          },
        });
        const { message, data } = (
          result.structuredContent as {
            error: { message: string; data: { recovery: { hint: string } } };
          }
        ).error;
        expect(message).not.toContain('"CNN"');
        // The wire hint is this throw's own, not the declared one about GDELT's query syntax.
        const declared = tool.errors.find((entry) => entry.reason === 'invalid_query')?.recovery;
        expect(declared).toMatch(/^Read the recovery hint for the (specific|rejected) rule/);
        expect(data.recovery.hint).not.toBe(declared);
        expect(data.recovery.hint).not.toMatch(/parenthes|syntax|operator/i);
        const rendered = renderMarkdown(contentText(result));
        expect(rendered).toContain(literalHtml(message));
        expect(rendered).toContain(literalHtml(`Recovery: ${data.recovery.hint}`));
      });

      it('sends every entry trimmed, blanks dropped and case kept, as one complete OR-group', async () => {
        const ids = ['CNN', 'FoxNews', 'cnn', ...Array.from({ length: 12 }, (_, i) => `S${i}`)];
        const fetch = arrange();
        const result = await callWire(tool, {
          ...base,
          query: 'climate',
          stations: ids.flatMap((id, i) => [i % 2 === 0 ? ` ${id}` : `${id}\t`, i % 5 ? '' : '  ']),
        });

        expect(result.isError).toBeFalsy();
        expect(sentQuery(fetch)).toBe(`climate (${ids.map((id) => `station:${id}`).join(' OR ')})`);
      });

      it('sends a lone entry trimmed', async () => {
        const fetch = arrange();
        await callWire(tool, { ...base, query: 'climate', stations: ['CNN '] });
        expect(sentQuery(fetch)).toBe('climate station:CNN');
      });

      // A known window: an empty answer for selected stations would look their ranges up too.
      it.each([[[]], [['', '  ']]])('treats stations %j as no stations', async (stations) => {
        const fetch = arrange();
        const result = await callWire(tool, {
          ...base,
          query: 'climate station:CNN',
          stations,
          timespan: '6m',
        });
        expect(result.isError).toBeFalsy();
        expect(sentQuery(fetch)).toBe('climate station:CNN');
      });

      it('names the stations check in its invalid_query contract', () => {
        expect(tool.errors.find((entry) => entry.reason === 'invalid_query')?.when).toMatch(
          /stations entry is not a station ID/,
        );
      });

      it('publishes stations as an unconstrained list of strings', () => {
        const schema = z.toJSONSchema(tool.input as unknown as z.ZodType) as {
          properties: Record<string, unknown>;
          required?: string[];
        };
        expect(schema.properties.stations).toEqual({
          type: 'array',
          items: { type: 'string' },
          description: expect.any(String),
        });
        expect(schema.required ?? []).not.toContain('stations');
      });
    });
  }
});
