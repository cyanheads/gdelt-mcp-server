/**
 * @fileoverview Input validation tests for all tool schemas. Verifies that missing,
 * malformed, and out-of-range inputs are rejected by the Zod schemas before handlers run,
 * plus the cross-field date-range pairing rule the handlers enforce on top.
 * @module tests/tools/input-validation.test
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { ErrorContract } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { gdeltGetCoverageBreakdown } from '@/mcp-server/tools/definitions/get-coverage-breakdown.tool.js';
import { gdeltGetCoverageTimeline } from '@/mcp-server/tools/definitions/get-coverage-timeline.tool.js';
import { gdeltGetToneDistribution } from '@/mcp-server/tools/definitions/get-tone-distribution.tool.js';
import { gdeltGetTvClips } from '@/mcp-server/tools/definitions/get-tv-clips.tool.js';
import { gdeltGetTvContext } from '@/mcp-server/tools/definitions/get-tv-context.tool.js';
import { gdeltGetTvTrending } from '@/mcp-server/tools/definitions/get-tv-trending.tool.js';
import { gdeltListTvStations } from '@/mcp-server/tools/definitions/list-tv-stations.tool.js';
import { gdeltSearchArticles } from '@/mcp-server/tools/definitions/search-articles.tool.js';
import { gdeltSearchTv } from '@/mcp-server/tools/definitions/search-tv.tool.js';

describe('gdeltSearchArticles input validation', () => {
  it('rejects an empty query string', () => {
    expect(() => gdeltSearchArticles.input.parse({ query: '' })).toThrow();
  });

  it('rejects maxRecords below 1', () => {
    expect(() => gdeltSearchArticles.input.parse({ query: 'test', maxRecords: 0 })).toThrow();
  });

  it('rejects maxRecords above 250', () => {
    expect(() => gdeltSearchArticles.input.parse({ query: 'test', maxRecords: 251 })).toThrow();
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

  it('accepts all three valid sort values', () => {
    for (const sort of ['date', 'relevance', 'social'] as const) {
      expect(() => gdeltSearchArticles.input.parse({ query: 'test', sort })).not.toThrow();
    }
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

  it('rejects smoothing above 5', () => {
    expect(() =>
      gdeltGetCoverageTimeline.input.parse({ query: 'test', mode: 'volume', smoothing: 6 }),
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

  it('accepts all three valid mode values', () => {
    for (const mode of ['volume', 'volume_with_articles', 'tone'] as const) {
      expect(() => gdeltGetCoverageTimeline.input.parse({ query: 'test', mode })).not.toThrow();
    }
  });

  it('accepts smoothing at boundaries 0 and 5', () => {
    for (const smoothing of [0, 5]) {
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

describe('gdeltGetTvContext input validation', () => {
  it('rejects empty query', () => {
    expect(() => gdeltGetTvContext.input.parse({ query: '' })).toThrow();
  });

  it('accepts a valid query', () => {
    expect(() => gdeltGetTvContext.input.parse({ query: 'pandemic' })).not.toThrow();
  });
});

describe('gdeltGetTvTrending input validation', () => {
  it('accepts an empty input object', () => {
    expect(() => gdeltGetTvTrending.input.parse({})).not.toThrow();
  });
});

describe('gdeltListTvStations input validation', () => {
  it('accepts an empty input object', () => {
    expect(() => gdeltListTvStations.input.parse({})).not.toThrow();
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
 * The handler guard runs before the service is resolved, so these cases need no service
 * mock: if the guard ever stops firing, the call falls through to an uninitialized-service
 * plain Error carrying no `data.reason`, and the assertions below fail rather than pass.
 */
describe('date-range pairing — enforced in the handler', () => {
  for (const { name, tool, base } of DATE_RANGE_TOOLS) {
    describe(name, () => {
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
        const ctx = createMockContext({ errors: tool.errors });
        const input = tool.input.parse({ ...base, startDatetime: VALID_START });
        await expect(tool.handler(input, ctx)).rejects.toMatchObject({
          data: {
            recovery: {
              hint: expect.stringMatching(/startDatetime.*endDatetime.*timespan/s),
            },
          },
        });
      });
    });
  }
});
