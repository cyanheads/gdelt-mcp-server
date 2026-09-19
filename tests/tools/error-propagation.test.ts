/**
 * @fileoverview Tests that upstream errors (non-200s, malformed payloads, network failures)
 * are surfaced correctly and not swallowed for all tools, and that the invalid_query reason
 * parseGdeltJson raises reaches the wire unchanged through each tool's handler.
 * @module tests/tools/error-propagation.test
 */

import type { ErrorContract } from '@cyanheads/mcp-ts-core/errors';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it, vi } from 'vitest';
import { gdeltGetCoverageBreakdown } from '@/mcp-server/tools/definitions/get-coverage-breakdown.tool.js';
import { gdeltGetCoverageTimeline } from '@/mcp-server/tools/definitions/get-coverage-timeline.tool.js';
import { gdeltGetToneDistribution } from '@/mcp-server/tools/definitions/get-tone-distribution.tool.js';
import { gdeltGetTvClips } from '@/mcp-server/tools/definitions/get-tv-clips.tool.js';
import { gdeltGetTvContext } from '@/mcp-server/tools/definitions/get-tv-context.tool.js';
import { gdeltGetTvTrending } from '@/mcp-server/tools/definitions/get-tv-trending.tool.js';
import { gdeltListTvStations } from '@/mcp-server/tools/definitions/list-tv-stations.tool.js';
import { gdeltSearchArticles } from '@/mcp-server/tools/definitions/search-articles.tool.js';
import { gdeltSearchTv } from '@/mcp-server/tools/definitions/search-tv.tool.js';
import * as docServiceModule from '@/services/gdelt/gdelt-doc-service.js';
import { parseGdeltJson } from '@/services/gdelt/gdelt-fetch.js';
import * as tvServiceModule from '@/services/gdelt/gdelt-tv-service.js';

describe('error propagation — doc service tools', () => {
  it('search-articles propagates network timeout from service', async () => {
    vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
      searchArticles: vi.fn().mockRejectedValue(new Error('Request timed out')),
    } as unknown as docServiceModule.GdeltDocService);
    const ctx = createMockContext({ errors: gdeltSearchArticles.errors });
    const input = gdeltSearchArticles.input.parse({ query: 'test' });
    await expect(gdeltSearchArticles.handler(input, ctx)).rejects.toThrow();
  });

  it('get-coverage-timeline propagates service unavailable error', async () => {
    vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
      getTimeline: vi.fn().mockRejectedValue(new Error('GDELT unavailable')),
    } as unknown as docServiceModule.GdeltDocService);
    const ctx = createMockContext({ errors: gdeltGetCoverageTimeline.errors });
    const input = gdeltGetCoverageTimeline.input.parse({ query: 'test', mode: 'volume' });
    await expect(gdeltGetCoverageTimeline.handler(input, ctx)).rejects.toThrow();
  });

  it('get-tone-distribution propagates serialization error from service', async () => {
    vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
      getToneDistribution: vi.fn().mockRejectedValue(new Error('JSON parse error')),
    } as unknown as docServiceModule.GdeltDocService);
    const ctx = createMockContext({ errors: gdeltGetToneDistribution.errors });
    const input = gdeltGetToneDistribution.input.parse({ query: 'test' });
    await expect(gdeltGetToneDistribution.handler(input, ctx)).rejects.toThrow();
  });

  it('get-coverage-breakdown propagates rate-limit error from service', async () => {
    vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
      getBreakdown: vi.fn().mockRejectedValue(new Error('Rate limit exceeded')),
    } as unknown as docServiceModule.GdeltDocService);
    const ctx = createMockContext({ errors: gdeltGetCoverageBreakdown.errors });
    const input = gdeltGetCoverageBreakdown.input.parse({
      query: 'test',
      breakdownBy: 'country',
    });
    await expect(gdeltGetCoverageBreakdown.handler(input, ctx)).rejects.toThrow();
  });
});

describe('error propagation — tv service tools', () => {
  it('get-tv-clips propagates network error from service', async () => {
    vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
      getTvClips: vi.fn().mockRejectedValue(new Error('Network failure')),
    } as unknown as tvServiceModule.GdeltTvService);
    const ctx = createMockContext({ errors: gdeltGetTvClips.errors });
    const input = gdeltGetTvClips.input.parse({ query: 'test' });
    await expect(gdeltGetTvClips.handler(input, ctx)).rejects.toThrow();
  });

  it('get-tv-context propagates service error', async () => {
    vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
      getTvContext: vi.fn().mockRejectedValue(new Error('Service error')),
    } as unknown as tvServiceModule.GdeltTvService);
    const ctx = createMockContext({ errors: gdeltGetTvContext.errors });
    const input = gdeltGetTvContext.input.parse({ query: 'test' });
    await expect(gdeltGetTvContext.handler(input, ctx)).rejects.toThrow();
  });

  it('get-tv-trending propagates service error', async () => {
    vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
      getTvTrending: vi.fn().mockRejectedValue(new Error('API unreachable')),
    } as unknown as tvServiceModule.GdeltTvService);
    const ctx = createMockContext({ errors: gdeltGetTvTrending.errors });
    const input = gdeltGetTvTrending.input.parse({});
    await expect(gdeltGetTvTrending.handler(input, ctx)).rejects.toThrow();
  });

  it('search-tv propagates service serialization error', async () => {
    vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
      searchTv: vi.fn().mockRejectedValue(new Error('Unparseable response')),
    } as unknown as tvServiceModule.GdeltTvService);
    const ctx = createMockContext({ errors: gdeltSearchTv.errors });
    const input = gdeltSearchTv.input.parse({ query: 'test' });
    await expect(gdeltSearchTv.handler(input, ctx)).rejects.toThrow();
  });
});

/**
 * parseGdeltJson raises invalid_query from the service layer, below ctx.fail, so no lint
 * rule proves each tool's declared reason is reachable — these cases stand in for that,
 * pinning that every handler lets the error bubble untouched and `data.reason` stays stable
 * per tool. The fixture is produced by the real parseGdeltJson rather than a hand-written
 * double, so it cannot drift from what the service actually throws.
 */
function gdeltRejection(body: string, apiLabel: string): unknown {
  try {
    parseGdeltJson(body, apiLabel);
  } catch (err) {
    return err;
  }
  throw new Error(`Expected parseGdeltJson to reject: ${body}`);
}

const DOC_REJECTION = () => gdeltRejection('Your query was too short or too long.', 'GDELT DOC');
const TV_REJECTION = () =>
  gdeltRejection('Your query must contain at least one station.', 'GDELT TV');

const mockDoc = (impl: Record<string, unknown>) =>
  vi
    .spyOn(docServiceModule, 'getGdeltDocService')
    .mockReturnValue(impl as unknown as docServiceModule.GdeltDocService);

const mockTv = (impl: Record<string, unknown>) =>
  vi
    .spyOn(tvServiceModule, 'getGdeltTvService')
    .mockReturnValue(impl as unknown as tvServiceModule.GdeltTvService);

const REJECTION_CASES: ReadonlyArray<{
  name: string;
  errors: readonly ErrorContract[];
  arrange: () => void;
  run: () => Promise<unknown>;
}> = [
  {
    name: 'gdelt_search_articles',
    errors: gdeltSearchArticles.errors!,
    arrange: () => mockDoc({ searchArticles: vi.fn().mockRejectedValue(DOC_REJECTION()) }),
    run: () =>
      Promise.resolve(
        gdeltSearchArticles.handler(
          gdeltSearchArticles.input.parse({ query: 'x' }),
          createMockContext({ errors: gdeltSearchArticles.errors }),
        ),
      ),
  },
  {
    name: 'gdelt_get_coverage_timeline',
    errors: gdeltGetCoverageTimeline.errors!,
    arrange: () => mockDoc({ getTimeline: vi.fn().mockRejectedValue(DOC_REJECTION()) }),
    run: () =>
      Promise.resolve(
        gdeltGetCoverageTimeline.handler(
          gdeltGetCoverageTimeline.input.parse({ query: 'x', mode: 'volume' }),
          createMockContext({ errors: gdeltGetCoverageTimeline.errors }),
        ),
      ),
  },
  {
    name: 'gdelt_get_tone_distribution',
    errors: gdeltGetToneDistribution.errors!,
    arrange: () => mockDoc({ getToneDistribution: vi.fn().mockRejectedValue(DOC_REJECTION()) }),
    run: () =>
      Promise.resolve(
        gdeltGetToneDistribution.handler(
          gdeltGetToneDistribution.input.parse({ query: 'x' }),
          createMockContext({ errors: gdeltGetToneDistribution.errors }),
        ),
      ),
  },
  {
    name: 'gdelt_get_coverage_breakdown',
    errors: gdeltGetCoverageBreakdown.errors!,
    arrange: () => mockDoc({ getBreakdown: vi.fn().mockRejectedValue(DOC_REJECTION()) }),
    run: () =>
      Promise.resolve(
        gdeltGetCoverageBreakdown.handler(
          gdeltGetCoverageBreakdown.input.parse({ query: 'x', breakdownBy: 'country' }),
          createMockContext({ errors: gdeltGetCoverageBreakdown.errors }),
        ),
      ),
  },
  {
    name: 'gdelt_search_tv',
    errors: gdeltSearchTv.errors!,
    arrange: () => mockTv({ searchTv: vi.fn().mockRejectedValue(TV_REJECTION()) }),
    run: () =>
      Promise.resolve(
        gdeltSearchTv.handler(
          gdeltSearchTv.input.parse({ query: 'climate' }),
          createMockContext({ errors: gdeltSearchTv.errors }),
        ),
      ),
  },
  {
    name: 'gdelt_get_tv_clips',
    errors: gdeltGetTvClips.errors!,
    arrange: () => mockTv({ getTvClips: vi.fn().mockRejectedValue(TV_REJECTION()) }),
    run: () =>
      Promise.resolve(
        gdeltGetTvClips.handler(
          gdeltGetTvClips.input.parse({ query: 'climate' }),
          createMockContext({ errors: gdeltGetTvClips.errors }),
        ),
      ),
  },
  {
    name: 'gdelt_get_tv_context',
    errors: gdeltGetTvContext.errors!,
    arrange: () => mockTv({ getTvContext: vi.fn().mockRejectedValue(TV_REJECTION()) }),
    run: () =>
      Promise.resolve(
        gdeltGetTvContext.handler(
          gdeltGetTvContext.input.parse({ query: 'climate' }),
          createMockContext({ errors: gdeltGetTvContext.errors }),
        ),
      ),
  },
];

describe('invalid_query propagates from parseGdeltJson to the wire', () => {
  for (const { name, errors, arrange, run } of REJECTION_CASES) {
    it(`${name} surfaces reason invalid_query as a ValidationError`, async () => {
      arrange();
      await expect(run()).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: {
          reason: 'invalid_query',
          recovery: { hint: expect.any(String) },
        },
      });
    });

    it(`${name} declares invalid_query in its error contract`, () => {
      expect(errors.map((e) => e.reason)).toContain('invalid_query');
    });
  }
});

const RATE_LIMIT_BODY = 'Please limit requests to one every 5 seconds.';

describe('gdelt_rate_limited propagates through production-shaped tool contracts', () => {
  it('surfaces matching structured and text recovery from a DOC tool', async () => {
    mockDoc({
      searchArticles: vi.fn().mockRejectedValue(gdeltRejection(RATE_LIMIT_BODY, 'GDELT DOC')),
    });

    const result = await runToolContract(gdeltSearchArticles, { query: 'climate' });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: JsonRpcErrorCode.RateLimited,
          data: {
            reason: 'gdelt_rate_limited',
            retryable: false,
            recovery: { hint: expect.stringMatching(/wait at least 5 seconds/i) },
          },
        },
      },
    });
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringMatching(/Recovery:.*wait at least 5 seconds/is),
        }),
      ]),
    );
  });

  it('surfaces matching structured and text recovery from a TV tool', async () => {
    mockTv({
      getTvClips: vi.fn().mockRejectedValue(gdeltRejection(RATE_LIMIT_BODY, 'GDELT TV')),
    });

    const result = await runToolContract(gdeltGetTvClips, { query: 'climate' });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: JsonRpcErrorCode.RateLimited,
          data: {
            reason: 'gdelt_rate_limited',
            retryable: false,
            recovery: { hint: expect.stringMatching(/wait at least 5 seconds/i) },
          },
        },
      },
    });
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringMatching(/Recovery:.*wait at least 5 seconds/is),
        }),
      ]),
    );
  });

  it.each([
    gdeltSearchArticles,
    gdeltGetCoverageTimeline,
    gdeltGetToneDistribution,
    gdeltGetCoverageBreakdown,
    gdeltSearchTv,
    gdeltGetTvClips,
    gdeltGetTvContext,
    gdeltGetTvTrending,
    gdeltListTvStations,
  ])('$name declares separate rate-limited and unavailable contracts', (tool) => {
    expect(tool.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: 'gdelt_rate_limited',
          code: JsonRpcErrorCode.RateLimited,
          retryable: false,
        }),
        expect.objectContaining({
          reason: 'gdelt_unavailable',
          code: JsonRpcErrorCode.ServiceUnavailable,
          retryable: true,
        }),
      ]),
    );
  });
});

/**
 * Framework-owned wire shaping a caller sees on every tool. Pinned here because the shapes
 * are what an agent branches on, and a framework upgrade that moves them should fail loudly
 * rather than silently change what callers read.
 */
describe('framework error envelope as a caller receives it', () => {
  /** A call the tool's input type forbids — the point of the case is that the wire allows it. */
  const callWithRawArguments = (args: Record<string, unknown>) =>
    runToolContract(gdeltSearchArticles, args as Parameters<typeof gdeltSearchArticles.handler>[0]);

  const expectTextContaining = (content: unknown, fragment: string) =>
    expect(content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: expect.stringContaining(fragment) }),
      ]),
    );

  it('closes a declared failure’s text with its reason and retryable terms', async () => {
    mockDoc({
      searchArticles: vi.fn().mockRejectedValue(gdeltRejection(RATE_LIMIT_BODY, 'GDELT DOC')),
    });

    const result = await runToolContract(gdeltSearchArticles, { query: 'climate' });
    expectTextContaining(result.content, '(reason gdelt_rate_limited · not retryable)');
  });

  it('rejects out-of-schema arguments as InvalidParams with a recovery line', async () => {
    const result = await callWithRawArguments({ query: 42 });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: JsonRpcErrorCode.InvalidParams,
          data: { reason: 'invalid_arguments' },
        },
      },
    });
    expectTextContaining(result.content, 'query');
    expectTextContaining(result.content, 'Recovery:');
  });

  it('drops a client-added root key instead of rejecting the call', async () => {
    mockDoc({
      searchArticles: vi.fn().mockResolvedValue({
        articles: [
          {
            url: 'https://example.com/1',
            title: 'Article',
            seendate: '20240101T120000Z',
            domain: 'example.com',
            language: 'English',
            sourcecountry: 'United States',
          },
        ],
        totalReturned: 1,
      }),
    });

    const result = await callWithRawArguments({
      query: 'climate',
      _clientAnnotation: 'ignored',
    });
    expect(result.isError).toBeFalsy();
  });

  it('rewrites a case-style variant of a declared key instead of rejecting it', async () => {
    const searchArticles = vi.fn().mockResolvedValue({ articles: [], totalReturned: 0 });
    mockDoc({ searchArticles });

    await callWithRawArguments({ query: 'climate', max_records: 3 });
    expect(searchArticles).toHaveBeenCalledWith(
      expect.objectContaining({ maxRecords: 3 }),
      expect.anything(),
    );
  });
});

describe('empty/sparse payload edge cases', () => {
  it('get-coverage-timeline: single data point series resolves without throwing', async () => {
    vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
      getTimeline: vi
        .fn()
        .mockResolvedValue([
          { label: 'Volume Intensity', data: [{ date: '2024-01-01T00:00:00Z', value: 0.5 }] },
        ]),
    } as unknown as docServiceModule.GdeltDocService);
    const ctx = createMockContext({ errors: gdeltGetCoverageTimeline.errors });
    const input = gdeltGetCoverageTimeline.input.parse({ query: 'test', mode: 'volume' });
    const result = await gdeltGetCoverageTimeline.handler(input, ctx);
    expect(result.series).toHaveLength(1);
    expect(result.series[0]?.data).toHaveLength(1);
  });

  it('get-tone-distribution: single bin with zero articles resolves correctly', async () => {
    vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
      getToneDistribution: vi.fn().mockResolvedValue([{ bin: 0, count: 5, articles: [] }]),
    } as unknown as docServiceModule.GdeltDocService);
    const ctx = createMockContext({ errors: gdeltGetToneDistribution.errors });
    const input = gdeltGetToneDistribution.input.parse({ query: 'test' });
    const result = await gdeltGetToneDistribution.handler(input, ctx);
    expect(result.histogram).toHaveLength(1);
    expect(result.summary.neutralPct).toBe(100);
  });

  it('get-coverage-breakdown: series with all-zero data still returns results', async () => {
    vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
      getBreakdown: vi
        .fn()
        .mockResolvedValue([{ label: 'English', data: [{ date: '2024-01-01', value: 0 }] }]),
    } as unknown as docServiceModule.GdeltDocService);
    const ctx = createMockContext({ errors: gdeltGetCoverageBreakdown.errors });
    const input = gdeltGetCoverageBreakdown.input.parse({
      query: 'test',
      breakdownBy: 'language',
    });
    const result = await gdeltGetCoverageBreakdown.handler(input, ctx);
    expect(result.topSeries).toHaveLength(1);
    expect(result.topSeries[0]?.label).toBe('English');
  });

  it('search-articles with exactly 250 articles (max) returns all of them', async () => {
    const articles = Array.from({ length: 250 }, (_, i) => ({
      url: `https://example.com/${i}`,
      title: `Article ${i}`,
      seendate: '20240101T120000Z',
      domain: 'example.com',
      language: 'English',
      sourcecountry: 'United States',
    }));
    vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
      searchArticles: vi.fn().mockResolvedValue({ articles, totalReturned: 250 }),
    } as unknown as docServiceModule.GdeltDocService);
    const ctx = createMockContext({ errors: gdeltSearchArticles.errors });
    const input = gdeltSearchArticles.input.parse({ query: 'test', maxRecords: 250 });
    const result = await gdeltSearchArticles.handler(input, ctx);
    expect(result.articles).toHaveLength(250);
  });

  it('get-tv-clips: clip without thumbnail is returned without error', async () => {
    vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
      getTvClips: vi.fn().mockResolvedValue([
        {
          show: 'Morning Show',
          station: 'MSNBC',
          date: '2020-05-01T06:00:00Z',
          snippet: 'Coverage here…',
          archiveUrl: 'https://archive.org/details/MSNBC_20200501',
        },
      ]),
    } as unknown as tvServiceModule.GdeltTvService);
    const ctx = createMockContext({ errors: gdeltGetTvClips.errors });
    const input = gdeltGetTvClips.input.parse({ query: 'test' });
    const result = await gdeltGetTvClips.handler(input, ctx);
    expect(result.clips[0]).not.toHaveProperty('thumbnail');
  });

  it('search-tv: single data point series resolves without throwing', async () => {
    vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
      searchTv: vi.fn().mockResolvedValue({
        series: [{ station: 'CNN', data: [{ date: '2024-01-01', value: 1.0 }] }],
        dateResolution: 'day',
        timeRange: { start: '2024-01-01', end: '2024-01-01' },
        normalized: true,
      }),
    } as unknown as tvServiceModule.GdeltTvService);
    const ctx = createMockContext({ errors: gdeltSearchTv.errors });
    const input = gdeltSearchTv.input.parse({ query: 'test' });
    const result = await gdeltSearchTv.handler(input, ctx);
    expect(result.series).toHaveLength(1);
  });
});
