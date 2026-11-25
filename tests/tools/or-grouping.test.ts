/**
 * @fileoverview OR outside parentheses on the nine query tools (#101), through the real services
 * with only `fetch` stubbed. The grammar is tabled at its seam in query-grammar.test.ts; here each
 * tool proves it sends, echoes, and discloses the grouped query, and that a query with no single
 * reading fails before any request.
 * @module tests/tools/or-grouping.test
 */

import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, type vi } from 'vitest';
import { gdeltGetCoverageBreakdown } from '@/mcp-server/tools/definitions/get-coverage-breakdown.tool.js';
import { gdeltGetCoverageTimeline } from '@/mcp-server/tools/definitions/get-coverage-timeline.tool.js';
import { gdeltGetToneDistribution } from '@/mcp-server/tools/definitions/get-tone-distribution.tool.js';
import { gdeltGetTvBreakdown } from '@/mcp-server/tools/definitions/get-tv-breakdown.tool.js';
import { gdeltGetTvClips } from '@/mcp-server/tools/definitions/get-tv-clips.tool.js';
import { gdeltGetTvContext } from '@/mcp-server/tools/definitions/get-tv-context.tool.js';
import { gdeltSearchArticles } from '@/mcp-server/tools/definitions/search-articles.tool.js';
import { gdeltSearchSentences } from '@/mcp-server/tools/definitions/search-sentences.tool.js';
import { gdeltSearchTv } from '@/mcp-server/tools/definitions/search-tv.tool.js';
import { initGdeltContextService } from '@/services/gdelt/gdelt-context-service.js';
import { initGdeltTvService } from '@/services/gdelt/gdelt-tv-service.js';
import type { MirrorRequest, MirrorResult } from '@/services/gkg-mirror/types.js';
import {
  attachMirror,
  mirrorAnswers,
  ROUTED_WINDOW,
  useRoutedDoc,
} from '../helpers/doc-source-fakes.js';
import { contentText } from './markdown-render.js';

type Result = Awaited<ReturnType<typeof runToolContract>>;
type Run = (query: string) => Promise<Result>;

const TV = { stations: ['CNN'], timespan: '24h' };

const DOC_TOOLS: Array<[tool: string, run: Run]> = [
  [
    'gdelt_search_articles',
    (query) => runToolContract(gdeltSearchArticles, { query, ...ROUTED_WINDOW }),
  ],
  [
    'gdelt_get_coverage_timeline',
    (query) =>
      runToolContract(gdeltGetCoverageTimeline, { query, mode: 'volume', ...ROUTED_WINDOW }),
  ],
  [
    'gdelt_get_tone_distribution',
    (query) => runToolContract(gdeltGetToneDistribution, { query, ...ROUTED_WINDOW }),
  ],
  [
    'gdelt_get_coverage_breakdown',
    (query) =>
      runToolContract(gdeltGetCoverageBreakdown, {
        query,
        breakdownBy: 'language',
        ...ROUTED_WINDOW,
      }),
  ],
];

const OTHER_TOOLS: Array<[tool: string, run: Run]> = [
  ['gdelt_search_sentences', (query) => runToolContract(gdeltSearchSentences, { query })],
  ['gdelt_search_tv', (query) => runToolContract(gdeltSearchTv, { query, ...TV })],
  [
    'gdelt_get_tv_breakdown',
    (query) => runToolContract(gdeltGetTvBreakdown, { query, breakdownBy: 'station', ...TV }),
  ],
  ['gdelt_get_tv_clips', (query) => runToolContract(gdeltGetTvClips, { query, ...TV })],
  ['gdelt_get_tv_context', (query) => runToolContract(gdeltGetTvContext, { query, ...TV })],
];

const GROUPED_NOTICE =
  'GDELT accepts OR, in any case, only inside parentheses, so this query ran as "(climate OR energy)".';
const REFUSAL_HINT =
  'Wrap terms joined by OR in parentheses, e.g. (climate OR energy), and leave every other element outside them, e.g. (climate OR energy) policy. GDELT reads or in any case as OR: to search for text holding the word, quote it, e.g. "life or death".';

describe('OR outside parentheses', () => {
  const doc = useRoutedDoc();

  beforeEach(() => {
    const config = {
      baseUrl: 'https://api.gdeltproject.org/api/v2',
      requestDelayMs: 0,
      requestTimeoutMs: 60_000,
    } as never;
    initGdeltContextService({} as never, {} as never, config);
    initGdeltTvService({} as never, {} as never, config);
  });

  /** The `query` each request was sent with; a request without one (a station catalog) is not a query. */
  const sentQueries = (fetch: ReturnType<typeof vi.fn>) =>
    fetch.mock.calls
      .map(([url]) => new URL(String(url)).searchParams.get('query'))
      .filter((query) => query !== null);

  describe.each([...DOC_TOOLS, ...OTHER_TOOLS])('%s', (tool, run) => {
    it('sends, echoes, and discloses a chain of terms as one group', async () => {
      const fetch = doc.answerDoc({ body: {} });

      const result = await run('climate or energy');

      expect(result.isError).toBeFalsy();
      const station = /_tv/.test(tool) ? ' station:CNN' : '';
      expect(sentQueries(fetch)).toEqual([`(climate OR energy)${station}`]);
      const sc = result.structuredContent as { effectiveQuery: string; notice: string };
      expect(sc.effectiveQuery).toBe('(climate OR energy)');
      expect(sc.notice.startsWith(`${GROUPED_NOTICE} `)).toBe(true);
      // An empty answer quotes the query it ran, never the one given.
      expect(sc.notice).not.toContain('climate or energy');
      const text = contentText(result);
      expect(text).toContain('Query: "(climate OR energy)"');
      expect(text).toContain(`> ${GROUPED_NOTICE} `);
    });

    it.each([
      'climate OR energy sourcelang:english',
      'prix or sourcelang:french',
      'climate change OR energy',
      'flu OR pandemic)',
      'climate OR OR energy',
      'OR climate',
    ])('refuses %j before any request', async (query) => {
      const fetch = doc.answerDoc({ body: {} });
      const mirror = attachMirror(() => {
        throw new Error('the mirror was asked');
      });

      const result = await run(query);

      expect(result.isError).toBe(true);
      const { error } = result.structuredContent as {
        error: { message: string; data: Record<string, unknown> };
      };
      expect(error.data).toMatchObject({
        reason: 'invalid_query',
        recovery: { hint: REFUSAL_HINT },
      });
      expect(error.data.retryable).toBeFalsy();
      expect(error.message).toBe(
        'GDELT accepts OR only between terms inside parentheses, and this query has an OR outside them with no single reading.',
      );
      const text = contentText(result);
      expect(text).toContain(error.message);
      expect(text).toContain(`Recovery: ${REFUSAL_HINT}`);
      expect(fetch).not.toHaveBeenCalled();
      expect(mirror.status).not.toHaveBeenCalled();
      expect(mirror.execute).not.toHaveBeenCalled();
    });

    it('leaves a grouped query as it is, with no grouping notice', async () => {
      const fetch = doc.answerDoc({ body: {} });

      const result = await run('(flu OR pandemic) vaccine');

      const station = /_tv/.test(tool) ? ' station:CNN' : '';
      expect(sentQueries(fetch)).toEqual([`(flu OR pandemic) vaccine${station}`]);
      const sc = result.structuredContent as { effectiveQuery: string; notice?: string };
      expect(sc.effectiveQuery).toBe('(flu OR pandemic) vaccine');
      expect(sc.notice ?? '').not.toContain('only inside parentheses');
    });
  });

  it('names the query that ran in the hint for an unknown breakdown series', async () => {
    doc.answerDoc({
      body: {
        timeline: [{ series: 'English', data: [{ date: '20261031T120000Z', value: 1 }] }],
      },
    });

    const result = await runToolContract(gdeltGetCoverageBreakdown, {
      query: 'climate or energy',
      breakdownBy: 'language',
      series: ['French'],
      ...ROUTED_WINDOW,
    });

    expect(contentText(result)).toContain('Available for "(climate OR energy)": English.');
  });

  /** The query shape a poller sends, which neither source could answer ungrouped. */
  describe.each(DOC_TOOLS)('%s with DOC refusing', (tool, run) => {
    const ANSWERS: Record<string, MirrorResult> = {
      gdelt_search_articles: {
        kind: 'artlist',
        result: {
          articles: [
            {
              url: 'https://example.com/a',
              title: 'Bitcoin climbs',
              seendate: '20261031T120000Z',
              domain: 'example.com',
              language: 'English',
              sourcecountry: 'United States',
            },
          ],
          totalReturned: 1,
        },
      },
      gdelt_get_coverage_timeline: {
        kind: 'timeline',
        result: [{ label: 'Volume Intensity', data: [{ date: '20261031T120000Z', value: 1 }] }],
      },
      gdelt_get_tone_distribution: {
        kind: 'tonechart',
        result: [{ bin: 0, count: 1, articles: [] }],
      },
      gdelt_get_coverage_breakdown: {
        kind: 'breakdown',
        result: [{ label: 'English', data: [{ date: '20261031T120000Z', value: 1 }] }],
      },
    };

    it('sends one grouped request and the mirror answers it', async () => {
      const fetch = doc.answerDoc('refuse');
      const mirror = attachMirror(mirrorAnswers(ANSWERS[tool] as MirrorResult, 1));
      const grouped = '("SOL" OR "sol" OR "bitcoin" OR "BTC")';

      const result = await run('"SOL" OR "sol" OR "bitcoin" OR "BTC"');

      expect(result.isError).toBeFalsy();
      expect(sentQueries(fetch)).toEqual([grouped]);
      expect(mirror.execute).toHaveBeenCalledTimes(1);
      const [request] = mirror.execute.mock.calls[0] as [MirrorRequest, AbortSignal];
      expect(request.plan.clauses).toEqual([
        {
          anyOf: ['SOL', 'sol', 'bitcoin', 'BTC'].map((text) => ({
            kind: 'keyword',
            text,
            phrase: true,
          })),
          negated: false,
        },
      ]);
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc.source).toBe('gkg_mirror');
      expect(sc.effectiveQuery).toBe(grouped);
      expect(sc.notice).toContain(
        `GDELT accepts OR, in any case, only inside parentheses, so this query ran as ${JSON.stringify(grouped)}.`,
      );
    });
  });
});
