/**
 * @fileoverview Tests for gdelt_get_coverage_timeline tool.
 * @module tests/tools/get-coverage-timeline.tool.test
 */

import { readFileSync } from 'node:fs';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gdeltGetCoverageTimeline } from '@/mcp-server/tools/definitions/get-coverage-timeline.tool.js';
import * as docServiceModule from '@/services/gdelt/gdelt-doc-service.js';
import type { MirrorResult } from '@/services/gkg-mirror/types.js';
import {
  attachMirror,
  DOC_429_DETAIL,
  MIRROR_DIVERGENCE_SENTENCE,
  MIRROR_KEYWORD_CASES,
  MIRROR_NO_MATCH_SENTENCE,
  MIRROR_STANDS_IN_FOR,
  MIRROR_THEME_ROUTE_SENTENCE,
  mirrorAnswers,
  mirrorSentences,
  OVERLOAD_RETRY_SENTENCE,
  PARTIAL_COVERAGE,
  PARTIAL_COVERAGE_LINE,
  ROUTED_WINDOW,
  refusedAttemptsLines,
  SHORT_WINDOW,
  SHORT_WINDOW_COVERAGE,
  SHORT_WINDOW_FAULT,
  SHORT_WINDOW_HINT,
  SOURCE_LINE,
  shortWindowAttemptsLines,
  useRoutedDoc,
} from '../helpers/doc-source-fakes.js';
import { contentText, hrefFor, literalHtml, renderMarkdown } from './markdown-render.js';

const VOLUME_SERIES = [
  {
    label: 'Volume Intensity',
    data: [
      { date: '2024-01-01T00:00:00Z', value: 0.5 },
      { date: '2024-01-01T01:00:00Z', value: 1.2 },
    ],
  },
];

const DAY_SERIES = [
  {
    label: 'Volume Intensity',
    data: [
      { date: '2024-01-01', value: 0.5 },
      { date: '2024-01-02', value: 1.2 },
    ],
  },
];

describe('gdeltGetCoverageTimeline', () => {
  it('renders smoothed raw values and the full-result peak without losing numeric precision', async () => {
    const getTimeline = vi.fn().mockResolvedValue({
      series: [
        {
          label: 'Article Count',
          data: [
            { date: '2026-10-21T15:00:00Z', value: 0.2837, norm: 11825 },
            { date: '2026-10-21T16:00:00Z', value: 1.23456789, norm: 12000 },
          ],
        },
      ],
    });
    vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
      getTimeline,
    } as unknown as docServiceModule.GdeltDocService);
    const response = await runToolContract(gdeltGetCoverageTimeline, {
      query: 'bird flu',
      mode: 'volume_raw',
      smoothing: 6,
      limit: 1,
    });
    expect(response.isError).toBeFalsy();
    expect(response.structuredContent).toMatchObject({
      series: [
        {
          data: [{ date: '2026-10-21T15:00:00Z', value: 0.2837, norm: 11825 }],
          peak: { date: '2026-10-21T16:00:00Z', value: 1.23456789, norm: 12000 },
        },
      ],
      nextOffset: 1,
    });
    expect(contentText(response)).toContain('- 2026-10-21T15:00:00Z: 0.2837 (monitored: 11825)');
    expect(contentText(response)).toContain(
      '**Peak:** 1.23456789 at 2026-10-21T16:00:00Z (monitored: 12000)',
    );
    expect(getTimeline).toHaveBeenCalledTimes(1);
  });
  it('preserves raw denominators through selection and count pages on both surfaces', async () => {
    const getTimeline = vi.fn().mockResolvedValue({
      series: [
        {
          label: 'Article Count',
          data: [
            { date: '2026-10-21T15:00:00Z', value: 0, norm: 10000 },
            { date: '2026-10-21T16:00:00Z', value: 11, norm: 11825 },
            { date: '2026-10-21T17:00:00Z', value: 5.5, norm: 12000 },
          ],
        },
      ],
    });
    vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
      getTimeline,
    } as unknown as docServiceModule.GdeltDocService);
    const result = await runToolContract(gdeltGetCoverageTimeline, {
      query: 'bird flu',
      mode: 'volume_raw',
      limit: 1,
      offset: 2,
      smoothing: 6,
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      mode: 'volume_raw',
      totalCount: 3,
      series: [{ data: [{ value: 5.5, norm: 12000 }], peak: { value: 11 } }],
    });
    expect(contentText(result)).toContain('monitored: 12000');
    expect(contentText(result)).toContain('moving average');
    expect(getTimeline).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'timelinevolraw', smoothing: 6 }),
      expect.anything(),
    );
  });

  it('uses a supplied-reference caption rather than a true matching-article total', () => {
    const text = contentText({
      content: gdeltGetCoverageTimeline.format!({
        series: [
          {
            label: 'Volume',
            data: [
              {
                date: '2026-10-21',
                value: 11,
                articles: [{ url: 'https://example.com', title: 'Title' }],
                referenceCount: 10,
              },
            ],
          },
        ],
      }),
    });
    expect(text).toContain('supplied references');
    expect(text).not.toContain('true total');
  });

  it('pages by requested timestep count even when all points fit the former byte budget', async () => {
    const getTimeline = vi.fn().mockResolvedValue({
      series: [
        {
          label: 'Volume',
          data: Array.from({ length: 12 }, (_, i) => ({
            date: `2026-10-${String(i + 1).padStart(2, '0')}`,
            value: i,
          })),
        },
      ],
    });
    vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
      getTimeline,
    } as unknown as docServiceModule.GdeltDocService);
    const result = await runToolContract(gdeltGetCoverageTimeline, { query: 'test', limit: 2 });
    expect(result.structuredContent).toMatchObject({
      series: [{ data: [{ value: 0 }, { value: 1 }] }],
      nextOffset: 2,
    });
    expect(contentText(result)).toContain('Next offset:** 2');
  });

  it('retains raw zero denominators and the full peak through exact point selection', async () => {
    const getTimeline = vi.fn().mockResolvedValue({
      series: [
        {
          label: 'Article Count',
          data: [
            { date: '2026-10-21T15:00:00Z', value: 0, norm: 0 },
            { date: '2026-10-21T16:00:00Z', value: 11, norm: 11825 },
          ],
        },
      ],
    });
    vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
      getTimeline,
    } as unknown as docServiceModule.GdeltDocService);
    const result = await runToolContract(gdeltGetCoverageTimeline, {
      query: 'bird flu',
      mode: 'volume_raw',
      points: ['2026-10-21T15:00:00Z'],
      limit: 1,
    });
    expect(result.structuredContent).toMatchObject({
      expandedPoints: ['2026-10-21T15:00:00Z'],
      series: [{ data: [{ value: 0, norm: 0 }], peak: { value: 11, norm: 11825 }, pointCount: 2 }],
    });
    expect(contentText(result)).toContain('0 (monitored: 0)');
    expect(contentText(result)).toContain('11 at 2026-10-21T16:00:00Z (monitored: 11825)');
    expect(contentText(result)).not.toContain('%');
  });

  it.each([undefined, 0, 1, 6, 30])(
    'composes smoothing %s with empty results without inventing data',
    async (smoothing) => {
      const getTimeline = vi.fn().mockResolvedValue({ series: [] });
      vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
        getTimeline,
      } as unknown as docServiceModule.GdeltDocService);
      const result = await runToolContract(gdeltGetCoverageTimeline, {
        query: 'bird flu',
        mode: 'volume_raw',
        offset: 42,
        ...(smoothing != null && { smoothing }),
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        series: [],
        notice: expect.stringContaining('No coverage data'),
      });
      expect(contentText(result)).not.toContain('Peak:');
      if ((smoothing ?? 0) > 1)
        expect(contentText(result)).toContain('leading steps without a full window');
      else expect(contentText(result)).not.toContain('moving average');
    },
  );

  it('applies and discloses the timestep cap once while retaining the next count page', async () => {
    const getTimeline = vi.fn().mockResolvedValue({
      series: [
        {
          label: 'Volume',
          data: Array.from({ length: 401 }, (_, value) => ({ date: String(value), value })),
        },
      ],
    });
    vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
      getTimeline,
    } as unknown as docServiceModule.GdeltDocService);
    const result = await runToolContract(gdeltGetCoverageTimeline, { query: 'test', limit: 401 });
    expect(result.structuredContent).toMatchObject({
      limitClamp: { parameter: 'limit', requested: 401, applied: 400 },
      nextOffset: 400,
      series: [{ pointCount: 401 }],
    });
    expect(
      (result.structuredContent as { series: Array<{ data: unknown[] }> }).series[0]!.data,
    ).toHaveLength(400);
    expect(contentText(result).match(/Limit clamped:/g)).toHaveLength(1);
    expect(getTimeline).toHaveBeenCalledTimes(1);
  });
  beforeEach(() => {
    vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
      getTimeline: vi.fn().mockResolvedValue({ series: VOLUME_SERIES }),
    } as unknown as docServiceModule.GdeltDocService);
  });

  it('returns timeline series for volume mode', async () => {
    const ctx = createMockContext({ errors: gdeltGetCoverageTimeline.errors });
    const input = gdeltGetCoverageTimeline.input.parse({ query: 'pandemic', mode: 'volume' });
    const result = await gdeltGetCoverageTimeline.handler(input, ctx);
    expect(result.series).toHaveLength(1);
    expect(result.series[0]?.data).toHaveLength(2);
  });

  it('populates enrichment with query echo, mode, and total count', async () => {
    const ctx = createMockContext({ errors: gdeltGetCoverageTimeline.errors });
    const input = gdeltGetCoverageTimeline.input.parse({ query: 'pandemic', mode: 'volume' });
    await gdeltGetCoverageTimeline.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBe('pandemic');
    expect(enrichment.mode).toBe('volume');
    expect(enrichment.totalCount).toBe(2);
  });

  it('infers hour resolution from ISO datetime strings', async () => {
    const ctx = createMockContext({ errors: gdeltGetCoverageTimeline.errors });
    const input = gdeltGetCoverageTimeline.input.parse({ query: 'test', mode: 'volume' });
    const result = await gdeltGetCoverageTimeline.handler(input, ctx);
    expect(result.dateResolution).toBe('hour');
  });

  it('infers day resolution from date-only strings', async () => {
    vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
      getTimeline: vi.fn().mockResolvedValue({ series: DAY_SERIES }),
    } as unknown as docServiceModule.GdeltDocService);

    const ctx = createMockContext({ errors: gdeltGetCoverageTimeline.errors });
    const input = gdeltGetCoverageTimeline.input.parse({ query: 'test', mode: 'volume' });
    const result = await gdeltGetCoverageTimeline.handler(input, ctx);
    expect(result.dateResolution).toBe('day');
  });

  describe('zero-match answer', () => {
    function mockTimeline(series: unknown) {
      vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
        getTimeline: vi.fn().mockResolvedValue({ series }),
      } as unknown as docServiceModule.GdeltDocService);
    }

    it('returns empty series with echoes and a notice, omitting dateResolution', async () => {
      mockTimeline([]);
      const result = await runToolContract(gdeltGetCoverageTimeline, {
        query: 'noresults',
        mode: 'volume',
        startDatetime: '20240101000000',
        endDatetime: '20240131235959',
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({
        series: [],
        effectiveQuery: 'noresults',
        totalCount: 0,
        mode: 'volume',
        startDatetime: '20240101000000',
        endDatetime: '20240131235959',
        notice: expect.stringMatching(/No coverage data found for "noresults".*[Bb]roaden/),
      });
      const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
      expect(text).not.toContain('Date Resolution');
      expect(text).not.toContain('Peak');
      expect(text).toContain('No timeline data returned.');
    });

    it('treats series that carry no points as empty', async () => {
      mockTimeline([{ label: 'Average Tone', data: [] }]);
      const result = await runToolContract(gdeltGetCoverageTimeline, {
        query: 'noresults',
        mode: 'tone',
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ totalCount: 0, notice: expect.any(String) });
      expect(result.structuredContent).not.toHaveProperty('dateResolution');
    });

    it('never turns an empty timeline into unknown_point, and omits expandedPoints', async () => {
      mockTimeline([]);
      const result = await runToolContract(gdeltGetCoverageTimeline, {
        query: 'noresults',
        mode: 'volume_with_articles',
        points: ['2024-01-01T00:00:00Z'],
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).not.toHaveProperty('expandedPoints');
      expect((result.structuredContent as { notice?: string }).notice).toContain('points');
    });

    it('no longer declares a no_timeline_data contract entry', () => {
      expect(gdeltGetCoverageTimeline.errors?.map((e) => e.reason)).not.toContain(
        'no_timeline_data',
      );
    });

    it('describes the empty case on the notice field', () => {
      expect(gdeltGetCoverageTimeline.enrichment?.notice?.description).not.toMatch(
        /Absent on successful responses/,
      );
    });
  });

  it('omits dateResolution when a single point leaves it undeterminable', async () => {
    vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
      getTimeline: vi.fn().mockResolvedValue({
        series: [
          { label: 'Volume Intensity', data: [{ date: '2024-01-01T00:00:00Z', value: 0.5 }] },
        ],
      }),
    } as unknown as docServiceModule.GdeltDocService);
    const result = await runToolContract(gdeltGetCoverageTimeline, { query: 'x', mode: 'volume' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).not.toHaveProperty('dateResolution');
    expect(result.structuredContent).toMatchObject({ totalCount: 1 });
  });

  it('formats output with resolution, series label, and peak', () => {
    const output = {
      dateResolution: 'day' as const,
      series: DAY_SERIES,
    };
    const blocks = gdeltGetCoverageTimeline.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('day');
    expect(text).toContain('Volume Intensity');
    expect(text).toContain('**Peak:** 1.2 at 2024-01-02');
    expect(text).toContain('2024-01-02');
  });

  it('echoes startDatetime/endDatetime in enrichment when provided', async () => {
    const ctx = createMockContext({ errors: gdeltGetCoverageTimeline.errors });
    const input = gdeltGetCoverageTimeline.input.parse({
      query: 'pandemic',
      mode: 'volume',
      startDatetime: '20240101000000',
      endDatetime: '20240131235959',
    });
    await gdeltGetCoverageTimeline.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.startDatetime).toBe('20240101000000');
    expect(enrichment.endDatetime).toBe('20240131235959');
  });

  it('omits date echo from enrichment when dates are not provided', async () => {
    const ctx = createMockContext({ errors: gdeltGetCoverageTimeline.errors });
    const input = gdeltGetCoverageTimeline.input.parse({ query: 'pandemic', mode: 'volume' });
    await gdeltGetCoverageTimeline.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.startDatetime).toBeUndefined();
    expect(enrichment.endDatetime).toBeUndefined();
  });

  /**
   * The echo is unconditional on the input being present, so before the pairing guard it
   * confirmed a boundary that applyTimeRange had silently dropped. The guard now rejects
   * first, making the echo accurate by construction.
   */
  it('never echoes an unpaired boundary — the pairing guard rejects before enrichment', async () => {
    const ctx = createMockContext({ errors: gdeltGetCoverageTimeline.errors });
    const input = gdeltGetCoverageTimeline.input.parse({
      query: 'pandemic',
      mode: 'volume',
      startDatetime: '20240101000000',
    });
    await expect(gdeltGetCoverageTimeline.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_date_range' },
    });
    const enrichment = getEnrichment(ctx);
    expect(enrichment.startDatetime).toBeUndefined();
    expect(enrichment.endDatetime).toBeUndefined();
  });

  /**
   * content[] must carry every point structuredContent carries. The fixture is larger than
   * the previous 10-point render cap, and every date/value is asserted individually — a
   * summary marker (count, peak) passing is not evidence the series survived the render.
   */
  it('renders every data point in format output, past the previous 10-point cap', () => {
    const data = Array.from({ length: 25 }, (_, i) => ({
      date: `2024-02-${String(i + 1).padStart(2, '0')}`,
      value: (i + 1) / 8,
    }));
    const blocks = gdeltGetCoverageTimeline.format!({
      dateResolution: 'day',
      series: [{ label: 'Volume Intensity', data }],
    });
    const text = (blocks[0] as { text: string }).text;
    for (const d of data) expect(text).toContain(`- ${d.date}: ${d.value}`);
    expect(text).not.toContain('more points');
  });

  it('renders every point across multiple series', () => {
    const blocks = gdeltGetCoverageTimeline.format!({
      dateResolution: 'day',
      series: [
        {
          label: 'Volume Intensity',
          data: [
            { date: '2024-01-01', value: 1.111 },
            { date: '2024-01-02', value: 2.222 },
          ],
        },
        {
          label: 'Average Tone',
          data: [
            { date: '2024-01-01', value: -3.333 },
            { date: '2024-01-02', value: -4.444 },
          ],
        },
      ],
    });
    const text = (blocks[0] as { text: string }).text;
    for (const v of ['1.111', '2.222', '-3.333', '-4.444']) expect(text).toContain(v);
    expect(text).toContain('Volume Intensity');
    expect(text).toContain('Average Tone');
  });

  /**
   * The per-point article list stays capped at ARTICLES_PER_POINT by default while every point
   * renders (see the constant's rationale — rendering all of them measures 566 KB of links at
   * the documented maximum). The cap is neither silent nor a dead end: each point renders its
   * supplied-reference count *and* how many links it showed, and `points` lifts the cap.
   */
  it('discloses both the supplied-reference count and how many links it showed when capping', () => {
    const articles = Array.from({ length: 8 }, (_, i) => ({
      url: `https://news.example/${i}`,
      title: `Headline ${i}`,
    }));
    const blocks = gdeltGetCoverageTimeline.format!({
      dateResolution: 'hour',
      series: [
        {
          label: 'Volume Intensity',
          data: [{ date: '2024-01-01T00:00:00Z', value: 2.5, articles }],
        },
      ],
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('(8 supplied references, 3 shown)');
    expect(text).toContain('Headline 0');
    expect(text).toContain('Headline 2');
    expect(text).not.toContain('Headline 3');
    // The withheld five need a stated route, not just a count.
    expect(text).toContain('points:');
  });

  it('does not claim links were withheld when every article fit under the cap', () => {
    const blocks = gdeltGetCoverageTimeline.format!({
      dateResolution: 'hour',
      series: [
        {
          label: 'Volume Intensity',
          data: [
            {
              date: '2024-01-01T00:00:00Z',
              value: 2.5,
              articles: [{ url: 'https://news.example/0', title: 'Headline 0' }],
            },
          ],
        },
      ],
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('(1 supplied references)');
    expect(text).not.toContain('shown');
  });

  /**
   * Point expansion. Both surfaces carry the first 3 references of a timestep beside its true
   * referenceCount (#54 — structuredContent used to carry every reference, unbounded); `points`
   * is the route to the rest, returning only the named timesteps with every reference.
   */
  describe('point expansion', () => {
    const ARTICLES = Array.from({ length: 8 }, (_, i) => ({
      url: `https://news.example/${i}`,
      title: `Headline ${i}`,
    }));
    const SPIKE_SERIES = [
      {
        label: 'Volume Intensity',
        data: [
          { date: '2024-01-01T00:00:00Z', value: 2.5, articles: ARTICLES },
          { date: '2024-01-01T01:00:00Z', value: 0.5, articles: ARTICLES },
        ],
      },
    ];

    beforeEach(() => {
      vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
        getTimeline: vi.fn().mockResolvedValue({ series: SPIKE_SERIES }),
      } as unknown as docServiceModule.GdeltDocService);
    });

    it('renders every article of a named point while other points stay capped', () => {
      const blocks = gdeltGetCoverageTimeline.format!({
        dateResolution: 'hour',
        series: SPIKE_SERIES,
        expandedPoints: ['2024-01-01T00:00:00Z'],
      });
      const text = (blocks[0] as { text: string }).text;
      // The expanded point reaches every article — including the five past the cap.
      for (const a of ARTICLES) expect(text).toContain(`[${a.title}](${a.url})`);
      // …and the point that was not named still shows 3 of its 8.
      expect(text).toContain('(8 supplied references, 3 shown)');
      expect(text).toContain('**Fully expanded timesteps:** 2024-01-01T00:00:00Z');
    });

    it('carries 3 references per timestep in structuredContent, and every reference only for a named one', async () => {
      const capped = await runToolContract(gdeltGetCoverageTimeline, {
        query: 'pandemic',
        mode: 'volume_with_articles',
      });
      const cappedSeries = (capped.structuredContent as { series: Array<{ data: unknown }> })
        .series;
      expect(cappedSeries[0]!.data).toEqual(
        SPIKE_SERIES[0]!.data.map((point) => ({
          ...point,
          articles: ARTICLES.slice(0, 3),
          referenceCount: 8,
        })),
      );

      const named = await runToolContract(gdeltGetCoverageTimeline, {
        query: 'pandemic',
        mode: 'volume_with_articles',
        points: ['2024-01-01T01:00:00Z'],
      });
      expect((named.structuredContent as { series: unknown }).series).toEqual([
        {
          label: 'Volume Intensity',
          data: [
            { date: '2024-01-01T01:00:00Z', value: 0.5, articles: ARTICLES, referenceCount: 8 },
          ],
          pointCount: 2,
          peak: { date: '2024-01-01T00:00:00Z', value: 2.5 },
        },
      ]);
    });

    it('echoes points into expandedPoints so format() can act on the selection', async () => {
      const ctx = createMockContext({ errors: gdeltGetCoverageTimeline.errors });
      const input = gdeltGetCoverageTimeline.input.parse({
        query: 'pandemic',
        mode: 'volume_with_articles',
        points: ['2024-01-01T01:00:00Z'],
      });
      const result = await gdeltGetCoverageTimeline.handler(input, ctx);
      expect(result.expandedPoints).toEqual(['2024-01-01T01:00:00Z']);
    });

    it('omits expandedPoints when points is not supplied', async () => {
      const ctx = createMockContext({ errors: gdeltGetCoverageTimeline.errors });
      const input = gdeltGetCoverageTimeline.input.parse({
        query: 'pandemic',
        mode: 'volume_with_articles',
      });
      const result = await gdeltGetCoverageTimeline.handler(input, ctx);
      expect(result.expandedPoints).toBeUndefined();
    });

    it('rejects a date matching no timestep rather than expanding nothing in silence', async () => {
      const ctx = createMockContext({ errors: gdeltGetCoverageTimeline.errors });
      const input = gdeltGetCoverageTimeline.input.parse({
        query: 'pandemic',
        mode: 'volume_with_articles',
        points: ['2024-06-01T00:00:00Z'],
      });
      const err = await Promise.resolve(gdeltGetCoverageTimeline.handler(input, ctx)).catch(
        (e: unknown) => e,
      );
      expect(err).toMatchObject({
        data: { reason: 'unknown_point', unknownPoints: ['2024-06-01T00:00:00Z'] },
      });
      const hint: string = (err as { data: { recovery: { hint: string } } }).data.recovery.hint;
      expect(hint).toContain('2024-01-01T00:00:00Z');
      expect(hint).toContain('2024-01-01T01:00:00Z');
    });
  });

  it('formats volume_with_articles mode including article links', () => {
    const output = {
      dateResolution: 'hour' as const,
      series: [
        {
          label: 'Volume Intensity',
          data: [
            {
              date: '2024-01-01T00:00:00Z',
              value: 2.5,
              articles: [{ url: 'https://news.com/a', title: 'Breaking News' }],
            },
          ],
        },
      ],
    };
    const blocks = gdeltGetCoverageTimeline.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Breaking News');
    expect(text).toContain('https://news.com/a');
  });

  /**
   * Upstream text reaches content[] as literal text: series labels and article link labels go
   * through the shared escaper, link destinations stay unescaped URLs that still parse as one
   * destination, and structuredContent keeps every raw value.
   */
  describe('Markdown escaping at the content[] boundary', () => {
    const HOSTILE_SERIES = [
      {
        label: 'Volume *Intensity* #',
        data: [
          {
            date: '2024-01-15T12:00:00Z',
            value: 1.5,
            articles: [
              { url: 'https://example.com/a_(b)_c?x=1', title: '<b>A &amp; B</b> [x](y)' },
              { url: 'https://example.com/a b', title: 'Plain title' },
            ],
          },
          { date: '2024-01-15T13:00:00Z', value: 0.5 },
        ],
      },
    ];

    it('renders plain upstream values byte-identically to the pre-escaping format()', () => {
      const blocks = gdeltGetCoverageTimeline.format!({
        dateResolution: 'hour',
        series: [
          {
            label: 'Volume Intensity',
            data: [
              {
                date: '2024-01-15T12:00:00Z',
                value: 1.5,
                articles: [{ url: 'https://example.com/a', title: 'Alpha story' }],
              },
              { date: '2024-01-15T13:00:00Z', value: 0.5 },
            ],
          },
        ],
      });
      expect((blocks[0] as { text: string }).text).toBe(
        '## GDELT Coverage Timeline\n**Date Resolution:** hour\n\n### Volume Intensity\n' +
          '**Data points:** 2\n**Peak:** 1.5 at 2024-01-15T12:00:00Z\n' +
          '- 2024-01-15T12:00:00Z: 1.5 (1 supplied references)\n  - [Alpha story](https://example.com/a)\n' +
          '- 2024-01-15T13:00:00Z: 0.5',
      );
    });

    it('escapes labels, keeps destinations whole, and leaves structuredContent raw', async () => {
      vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
        getTimeline: vi.fn().mockResolvedValue({ series: HOSTILE_SERIES }),
      } as unknown as docServiceModule.GdeltDocService);
      const result = await runToolContract(gdeltGetCoverageTimeline, {
        query: 'x',
        mode: 'volume_with_articles',
      });
      const [hostilePoint, plainPoint] = HOSTILE_SERIES[0]!.data;
      expect((result.structuredContent as { series: unknown }).series).toEqual([
        {
          label: HOSTILE_SERIES[0]!.label,
          data: [{ ...hostilePoint, referenceCount: 2 }, plainPoint],
          pointCount: 2,
          peak: { date: '2024-01-15T12:00:00Z', value: 1.5 },
        },
      ]);
      expect((result.content[0] as { text: string }).text).toBe(
        [
          '## GDELT Coverage Timeline',
          '**Date Resolution:** hour',
          '',
          String.raw`### Volume \*Intensity\* \#`,
          '**Data points:** 2',
          '**Peak:** 1.5 at 2024-01-15T12:00:00Z',
          '- 2024-01-15T12:00:00Z: 1.5 (2 supplied references)',
          String.raw`  - [\<b>A \&amp; B\</b> \[x\](y)](<https://example.com/a_(b)_c?x=1>)`,
          '  - [Plain title](<https://example.com/a b>)',
          '- 2024-01-15T13:00:00Z: 0.5',
        ].join('\n'),
      );

      const html = renderMarkdown(contentText(result));
      expect(html).toContain(`<h3>${literalHtml('Volume *Intensity* #')}</h3>`);
      for (const a of HOSTILE_SERIES[0]!.data[0]!.articles!) {
        expect(html).toContain(`<a href="${hrefFor(a.url)}">${literalHtml(a.title)}</a>`);
      }
    });
  });

  /**
   * Count pages retain every timestep and its selected references, independent of rendered size.
   */
  describe('count paging', () => {
    type Point = {
      date: string;
      value: number;
      articles?: Array<{ url: string; title: string }>;
      referenceCount?: number;
    };
    type Out = {
      series: Array<{
        label: string;
        data: Point[];
        pointCount?: number;
        peak?: { date: string; value: number };
      }>;
      dateResolution?: string;
      nextOffset?: number;
      expandedPoints?: string[];
      totalCount: number;
      notice?: string;
    };

    const stamp = (k: number) =>
      new Date(Date.UTC(2026, 9, 1) + k * 15 * 60_000).toISOString().replace('.000Z', 'Z');
    const article = (n: number, titleLength = 100) => ({
      url: `https://news.example/${'p'.repeat(70)}/${String(n).padStart(8, '0')}`,
      title: `Headline ${String(n).padStart(6, '0')} ${'drought '.repeat(800)}`.slice(
        0,
        titleLength,
      ),
    });
    function volInfo(steps: number, refs: number, titleLength = 100) {
      let n = 0;
      return [
        {
          label: 'Volume Intensity',
          data: Array.from({ length: steps }, (_, k) => ({
            date: stamp(k),
            value: ((k * 37) % 1000) / 1000,
            articles: Array.from({ length: refs }, () => article(n++, titleLength)),
          })),
        },
      ];
    }
    const FULL = volInfo(288, 10);
    const ALL_DATES = FULL[0]!.data.map((d) => d.date);

    function mock(series: unknown) {
      vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
        getTimeline: vi.fn().mockResolvedValue({ series }),
      } as unknown as docServiceModule.GdeltDocService);
    }
    const call = (input: Record<string, unknown>) =>
      runToolContract(gdeltGetCoverageTimeline, {
        query: 'drought',
        mode: 'volume_with_articles',
        ...input,
      } as Parameters<typeof gdeltGetCoverageTimeline.handler>[0]);
    const out = (result: { structuredContent?: unknown }) => result.structuredContent as Out;
    const surfaceBytes = (result: { structuredContent?: unknown; content: unknown[] }) => ({
      structured: Buffer.byteLength(JSON.stringify(result.structuredContent)),
      text: Buffer.byteLength(contentText(result)),
    });
    const link = (a: { url: string; title: string }) => `[${a.title}](${a.url})`;

    beforeEach(() => mock(FULL));

    it('returns ten timesteps by default with a count continuation on both surfaces', async () => {
      const result = await call({});
      expect(result.isError).toBeFalsy();
      const sc = out(result);
      expect(sc.series[0]!.data).toHaveLength(10);
      expect(sc.nextOffset).toBe(10);
      expect(sc.notice).toBe(
        `Returned timesteps 1–${sc.nextOffset} of 288 timesteps; continue with offset ` +
          `${sc.nextOffset} (nextOffset) and otherwise identical inputs.`,
      );
      expect(contentText(result)).toContain(`**Next offset:** ${sc.nextOffset}`);
    });

    // A one-timestep page has no spacing to infer a resolution from, and a count of 1.
    it('computes totalCount and dateResolution over the full timeline, not the page', async () => {
      const sc = out(await call({ offset: 287 }));
      expect(sc.series[0]!.data.map((d) => d.date)).toEqual([ALL_DATES[287]]);
      expect(sc.totalCount).toBe(288);
      expect(sc.dateResolution).toBe('15min');
    });

    /**
     * The per-series Data points and Peak lines read as a summary of the series, so they cover the
     * whole series on every page: the spike at timestep 251 is the peak on page 1 too, where it
     * is not among the returned timesteps.
     */
    it('summarizes each series over the full timeline on every page, on both surfaces', async () => {
      const spiked = [
        { ...FULL[0]!, data: FULL[0]!.data.map((d, k) => (k === 250 ? { ...d, value: -9.5 } : d)) },
      ];
      mock(spiked);
      for (const offset of [0, 280]) {
        const result = await call({ offset });
        const sc = out(result);
        const returned = sc.series[0]!.data.length;
        expect(returned).toBeLessThan(288);
        const text = contentText(result);
        expect(text).toContain(`**Peak:** -9.5 at ${ALL_DATES[250]}`);
        expect(text).toContain(`**Data points:** 288 in the series, ${returned} in this response`);
        expect(sc.series[0]).toMatchObject({
          pointCount: 288,
          peak: { date: ALL_DATES[250], value: -9.5 },
        });
      }
      expect(out(await call({})).nextOffset).toBeLessThan(250);
    });

    it('summarizes the full series when points restricts the response', async () => {
      const result = await call({ points: [ALL_DATES[3]!] });
      const sc = out(result);
      const fullPeak = FULL[0]!.data.reduce((max, d) =>
        Math.abs(d.value) > Math.abs(max.value) ? d : max,
      );
      expect(sc.series[0]).toMatchObject({
        pointCount: 288,
        peak: { date: fullPeak.date, value: fullPeak.value },
      });
      expect(contentText(result)).toContain(
        '**Data points:** 288 in the series, 1 in this response',
      );
    });

    it('carries the same first 3 references and referenceCount for every step on both surfaces', async () => {
      const result = await call({});
      const sc = out(result);
      const text = contentText(result);
      const page = sc.series[0]!.data;
      for (const [i, point] of page.entries()) {
        const upstream = FULL[0]!.data[i]!;
        expect(point.referenceCount).toBe(10);
        expect(point.articles).toEqual(upstream.articles.slice(0, 3));
        expect(text).toContain(`- ${point.date}: ${point.value} (10 supplied references, 3 shown)`);
        for (const a of upstream.articles.slice(0, 3)) expect(text).toContain(link(a));
        expect(text).not.toContain(link(upstream.articles[3]!));
      }
      expect(text.match(/^ {2}- \[/gm)).toHaveLength(page.length * 3);
    });

    it('walks nextOffset over every timestep exactly once in count pages', async () => {
      const walked: string[] = [];
      let offset: number | undefined = 0;
      let pages = 0;
      while (offset !== undefined) {
        const result = await call({ offset });
        expect(result.isError).toBeFalsy();
        const sc = out(result);
        expect(sc.series[0]!.data.length).toBeLessThanOrEqual(10);
        expect(sc.totalCount).toBe(288);
        walked.push(...sc.series[0]!.data.map((d) => d.date));
        offset = sc.nextOffset;
        pages++;
      }
      expect(pages).toBe(29);
      expect(walked).toEqual(ALL_DATES);
    });

    it('names the last page of a walk without offering another', async () => {
      const first = out(await call({}));
      let offset = first.nextOffset!;
      let last = out(await call({ offset }));
      while (last.nextOffset !== undefined) {
        offset = last.nextOffset;
        last = out(await call({ offset }));
      }
      expect(last.notice).toBe(
        `Returned timesteps ${offset + 1}–288 of 288 timesteps — the last page.`,
      );
    });

    it('returns only the points-named timesteps, each with every reference on both surfaces', async () => {
      const named = [ALL_DATES[200]!, ALL_DATES[5]!];
      const result = await call({ points: named });
      const sc = out(result);
      expect(sc.series[0]!.data.map((d) => d.date)).toEqual([ALL_DATES[5], ALL_DATES[200]]);
      const text = contentText(result);
      for (const point of sc.series[0]!.data) {
        const upstream = FULL[0]!.data.find((d) => d.date === point.date)!;
        expect(point.articles).toEqual(upstream.articles);
        expect(point.referenceCount).toBe(10);
        for (const a of upstream.articles) expect(text).toContain(link(a));
      }
      expect(text).not.toContain(ALL_DATES[6]);
      expect(sc).not.toHaveProperty('nextOffset');
      expect(sc).not.toHaveProperty('notice');
      expect(sc.totalCount).toBe(288);
      expect(sc.expandedPoints).toEqual(named);
    });

    /**
     * Every count page of a points selection carries the expandedPoints echo on both surfaces.
     */
    it('walks points naming every timestep once and in order', async () => {
      const walked: string[] = [];
      let offset: number | undefined = 0;
      let pages = 0;
      while (offset !== undefined) {
        const result = await call({ points: ALL_DATES, offset });
        expect(result.isError).toBeFalsy();
        const sc = out(result);
        expect(sc.series[0]!.data.length).toBeLessThanOrEqual(10);
        expect(sc.expandedPoints).toEqual(ALL_DATES);
        for (const point of sc.series[0]!.data) expect(point.articles).toHaveLength(10);
        walked.push(...sc.series[0]!.data.map((d) => d.date));
        offset = sc.nextOffset;
        pages++;
      }
      expect(pages).toBe(29);
      expect(walked).toEqual(ALL_DATES);
    });

    it('returns every requested large timestep without a byte cut', async () => {
      const huge = volInfo(3, 10, 6_000);
      mock(huge);
      const dates = huge[0]!.data.map((d) => d.date);
      const first = out(await call({ points: dates }));
      expect(first.series[0]!.data.map((d) => d.date)).toEqual(dates);
      expect(first.series[0]!.data[0]!.articles).toHaveLength(10);
      expect(first.nextOffset).toBeUndefined();
      const second = out(await call({ points: dates, offset: 1, limit: 1 }));
      expect(second.series[0]!.data.map((d) => d.date)).toEqual([dates[1]]);
      expect(second.nextOffset).toBe(2);
      expect(second.notice).toMatch(
        /^Returned timesteps 2–2 of 3 timesteps; continue with offset 2/,
      );
      expect(surfaceBytes(await call({ points: dates })).structured).toBeGreaterThan(50_000);
    });

    it('returns volume mode at 288 timesteps as one page with no continuation or notice', async () => {
      mock([
        {
          label: 'Volume Intensity',
          data: ALL_DATES.map((date, k) => ({ date, value: k / 1000 })),
        },
      ]);
      const result = await call({ mode: 'volume', limit: 400 });
      const sc = out(result);
      expect(sc.series[0]!.data).toHaveLength(288);
      expect(sc).not.toHaveProperty('nextOffset');
      expect(sc).not.toHaveProperty('notice');
      expect(surfaceBytes(result).structured).toBeLessThan(20_000);
    });

    it('rejects an offset at or past the timestep total, naming the valid range', async () => {
      const past = await call({ offset: 288 });
      expect(past).toMatchObject({
        isError: true,
        structuredContent: {
          error: {
            code: JsonRpcErrorCode.NotFound,
            data: {
              reason: 'offset_out_of_range',
              offset: 288,
              totalTimesteps: 288,
              recovery: { hint: expect.stringMatching(/offset 0–287/) },
            },
          },
        },
      });
      expect(contentText(past)).toContain('offset 0–287');
    });

    it('ranges offset over the points-named timesteps when points is supplied', async () => {
      const past = await call({ points: [ALL_DATES[1]!, ALL_DATES[2]!], offset: 2 });
      expect(past).toMatchObject({
        isError: true,
        structuredContent: {
          error: { data: { reason: 'offset_out_of_range', totalTimesteps: 2 } },
        },
      });
      expect(contentText(past)).toContain('offset 0–1');
    });

    it('ignores offset on an empty timeline', async () => {
      mock([]);
      const result = await call({ offset: 5 });
      expect(result.isError).toBeFalsy();
      expect(out(result)).toMatchObject({ series: [], totalCount: 0 });
    });

    it('keeps unknown_point ahead of the offset check', async () => {
      const result = await call({ points: ['2020-01-01T00:00:00Z'], offset: 50 });
      expect(result).toMatchObject({
        isError: true,
        structuredContent: { error: { data: { reason: 'unknown_point' } } },
      });
    });
  });
});

/**
 * The tool's wiring to the DOC source router: the real DOC service and router with only `fetch`
 * stubbed, and a fake mirror. The router's outcome table lives in doc-source-router.test.ts.
 */
describe('gdelt_get_coverage_timeline DOC source routing', () => {
  const doc = useRoutedDoc();
  const INPUT = { query: 'climate', ...ROUTED_WINDOW };
  const POINT = { date: '2026-10-31T12:00:00Z', value: 2.5 };
  const MIRROR_TIMELINE = {
    kind: 'timeline',
    result: [{ label: 'Volume Intensity', data: [POINT] }],
  } satisfies MirrorResult;
  const EMPTY_NOTICE =
    'No coverage data found for "climate". Broaden the query, extend the time window, or verify the query operators are correct.';
  const notice = (result: { structuredContent?: unknown }) =>
    (result.structuredContent as { notice?: string }).notice;

  it('with no mirror, adds no source field and renders as before', async () => {
    doc.answerDoc({
      body: {
        timeline: [
          { series: 'Volume Intensity', data: [{ date: '20261031T000000Z', value: 1.5 }] },
        ],
      },
    });

    const result = await runToolContract(gdeltGetCoverageTimeline, INPUT);

    const point = { date: '2026-10-31T00:00:00Z', value: 1.5 };
    expect(result.structuredContent).toEqual({
      series: [{ label: 'Volume Intensity', data: [point], pointCount: 1, peak: point }],
      effectiveQuery: 'climate',
      totalCount: 1,
      mode: 'volume',
      ...ROUTED_WINDOW,
    });
    expect(contentText(result)).toBe(
      [
        '## GDELT Coverage Timeline',
        '',
        '### Volume Intensity',
        '**Data points:** 1',
        '**Peak:** 1.5 at 2026-10-31T00:00:00Z',
        '- 2026-10-31T00:00:00Z: 1.5',
        '',
        'Query: "climate"',
        '**1 total**',
        '**mode:** `volume`',
        '**startDatetime:** `20261031000000`',
        '**endDatetime:** `20261101000000`',
      ].join('\n'),
    );
  });

  it('with no mirror, adds the overload sentence to an empty answer on both surfaces (#77)', async () => {
    doc.answerDoc({ body: {} });

    const result = await runToolContract(gdeltGetCoverageTimeline, INPUT);

    expect(notice(result)).toBe(`${EMPTY_NOTICE} ${OVERLOAD_RETRY_SENTENCE}`);
    expect(contentText(result)).toContain(`> ${EMPTY_NOTICE} ${OVERLOAD_RETRY_SENTENCE}`);
  });

  it('marks a DOC answer doc_api on both surfaces while a mirror stands behind it', async () => {
    attachMirror(mirrorAnswers(MIRROR_TIMELINE, 3));
    doc.answerDoc({
      body: {
        timeline: [
          { series: 'Volume Intensity', data: [{ date: '20261031T000000Z', value: 1.5 }] },
        ],
      },
    });

    const result = await runToolContract(gdeltGetCoverageTimeline, INPUT);

    expect(result.structuredContent).toMatchObject({ source: 'doc_api' });
    expect(result.structuredContent).not.toHaveProperty('attempts');
    expect(contentText(result)).toContain(SOURCE_LINE.doc_api);
  });

  it('answers from the mirror when DOC refuses: source, attempts, coverage, and notice on both surfaces', async () => {
    attachMirror(mirrorAnswers(MIRROR_TIMELINE, 3));
    doc.answerDoc('refuse');

    const result = await runToolContract(gdeltGetCoverageTimeline, INPUT);

    const mirrorNotice = `${MIRROR_STANDS_IN_FOR.rate_limited} ${MIRROR_DIVERGENCE_SENTENCE} ${MIRROR_THEME_ROUTE_SENTENCE}`;
    expect(result.structuredContent).toEqual({
      series: [{ label: 'Volume Intensity', data: [POINT], pointCount: 1, peak: POINT }],
      effectiveQuery: 'climate',
      totalCount: 1,
      mode: 'volume',
      ...ROUTED_WINDOW,
      source: 'gkg_mirror',
      attempts: [
        { source: 'doc_api', outcome: 'rate_limited', detail: DOC_429_DETAIL },
        { source: 'gkg_mirror', outcome: 'answered' },
      ],
      coverage: PARTIAL_COVERAGE,
      notice: mirrorNotice,
    });
    const text = contentText(result);
    expect(text).toContain('- 2026-10-31T12:00:00Z: 2.5');
    expect(text).toContain(SOURCE_LINE.gkg_mirror);
    expect(text).toContain(refusedAttemptsLines('answered'));
    expect(text).toContain(PARTIAL_COVERAGE_LINE);
    expect(text).toContain(`> ${mirrorNotice}`);
  });

  it("keeps the mirror's own sentence, not the overload one, on a mirror tone timeline with no match", async () => {
    attachMirror(
      mirrorAnswers({ kind: 'timeline', result: [{ label: 'Average Tone', data: [] }] }, 0),
    );
    doc.answerDoc('refuse');

    const result = await runToolContract(gdeltGetCoverageTimeline, { ...INPUT, mode: 'tone' });

    const mirrorNotice = `${EMPTY_NOTICE} ${MIRROR_STANDS_IN_FOR.rate_limited} ${MIRROR_DIVERGENCE_SENTENCE} ${MIRROR_NO_MATCH_SENTENCE} ${MIRROR_THEME_ROUTE_SENTENCE}`;
    expect(notice(result)).toBe(mirrorNotice);
    expect(contentText(result)).toContain(refusedAttemptsLines('empty'));
    expect(contentText(result).split('\n')).toContain(`> ${mirrorNotice}`);
  });

  it.each(MIRROR_KEYWORD_CASES)(
    'ends the notice with the mirror sentences for a query holding $holds, $matched matched, on both surfaces',
    async ({ query, matched, sentences }) => {
      attachMirror(
        mirrorAnswers(matched > 0 ? MIRROR_TIMELINE : { kind: 'timeline', result: [] }, matched),
      );
      doc.answerDoc('refuse');

      const result = await runToolContract(gdeltGetCoverageTimeline, { ...INPUT, query });

      expect(result.structuredContent).toMatchObject({ source: 'gkg_mirror' });
      expect(mirrorSentences(result)).toEqual({ structuredContent: sentences, content: sentences });
    },
  );

  it("keeps DOC's empty answer with the overload sentence when the mirror has no match either", async () => {
    attachMirror(
      mirrorAnswers({ kind: 'timeline', result: [{ label: 'Average Tone', data: [] }] }, 0),
    );
    doc.answerDoc({ body: {} });

    const result = await runToolContract(gdeltGetCoverageTimeline, { ...INPUT, mode: 'tone' });

    expect(result.structuredContent).toMatchObject({
      series: [],
      source: 'doc_api',
      attempts: [
        { source: 'doc_api', outcome: 'empty' },
        { source: 'gkg_mirror', outcome: 'empty' },
      ],
      notice: `${EMPTY_NOTICE} ${OVERLOAD_RETRY_SENTENCE}`,
    });
  });

  /** A window under the 30 minutes DOC accepts (#92); the router's table is in doc-source-router.test.ts. */
  it('with no mirror, fails a window under 30 minutes invalid_date_range before any request, on both surfaces', async () => {
    const fetch = doc.answerDoc({ body: {} });

    const result = await runToolContract(gdeltGetCoverageTimeline, { ...INPUT, ...SHORT_WINDOW });

    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: JsonRpcErrorCode.ValidationError,
          message: SHORT_WINDOW_FAULT,
          data: { reason: 'invalid_date_range', recovery: { hint: SHORT_WINDOW_HINT } },
        },
      },
    });
    expect(contentText(result)).toContain(SHORT_WINDOW_FAULT);
    expect(contentText(result)).toContain(`Recovery: ${SHORT_WINDOW_HINT}`);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('answers a window under 30 minutes from the mirror without asking DOC, saying why on both surfaces', async () => {
    attachMirror(mirrorAnswers(MIRROR_TIMELINE, 3, SHORT_WINDOW_COVERAGE));
    const fetch = doc.answerDoc({ body: {} });

    const result = await runToolContract(gdeltGetCoverageTimeline, { ...INPUT, ...SHORT_WINDOW });

    const mirrorNotice = `${MIRROR_STANDS_IN_FOR.window_too_short} ${MIRROR_DIVERGENCE_SENTENCE} ${MIRROR_THEME_ROUTE_SENTENCE}`;
    expect(result.structuredContent).toEqual({
      series: [{ label: 'Volume Intensity', data: [POINT], pointCount: 1, peak: POINT }],
      effectiveQuery: 'climate',
      totalCount: 1,
      mode: 'volume',
      ...SHORT_WINDOW,
      source: 'gkg_mirror',
      attempts: [
        { source: 'doc_api', outcome: 'window_too_short', detail: SHORT_WINDOW_FAULT },
        { source: 'gkg_mirror', outcome: 'answered' },
      ],
      notice: mirrorNotice,
    });
    const text = contentText(result);
    expect(text).toContain(SOURCE_LINE.gkg_mirror);
    expect(text).toContain(shortWindowAttemptsLines('answered'));
    expect(text).toContain(`> ${mirrorNotice}`);
    expect(fetch).not.toHaveBeenCalled();
  });
});

/**
 * #98: DOC leaves a timestep out of its answer where GDELT's own data has a gap, and answers a
 * timestep with no matching coverage with 0. The fixture is a real DOC answer (quokka,
 * 2026-09-01 – 09-08): 159 of the window's 169 hourly steps, 158 of them 0, run through the real
 * DOC service with only `fetch` stubbed. The gap count's own table is in date-resolution.test.ts
 * and the notice's in missing-timesteps.test.ts; these cases prove the wiring.
 */
describe('gdelt_get_coverage_timeline missing timesteps (#98)', () => {
  const doc = useRoutedDoc();
  type RawDoc = {
    query_details?: { title?: string; date_resolution?: string };
    timeline: Array<{ series: string; data: Array<{ date: string; value: number }> }>;
  };
  type Out = {
    dateResolution?: string;
    missingTimesteps?: number;
    notice?: string;
    totalCount: number;
    nextOffset?: number;
    series: Array<{ label: string; pointCount?: number; data: Array<{ date: string }> }>;
    staleResponse?: unknown;
  };
  const QUOKKA = JSON.parse(
    readFileSync(
      new URL('../fixtures/doc/quokka-timelinevol-20260901-20260908.json', import.meta.url),
      'utf8',
    ),
  ) as RawDoc;
  /** DOC's tone timeline of the same query and window: the same 159 steps, 0 where no article matched. */
  const QUOKKA_TONE = JSON.parse(
    readFileSync(
      new URL('../fixtures/doc/quokka-timelinetone-20260901-20260908.json', import.meta.url),
      'utf8',
    ),
  ) as RawDoc;
  const QUOKKA_INPUT = {
    query: 'quokka',
    startDatetime: '20260901000000',
    endDatetime: '20260908000000',
  } as const;
  const GAP_NOTICE =
    "10 hourly timesteps are missing between the first and last timestep GDELT returned: 2026-09-02T18:00:00Z, 2026-09-03T17:00:00Z–2026-09-03T21:00:00Z (5), 2026-09-04T11:00:00Z, 2026-09-05T22:00:00Z, 2026-09-06T04:00:00Z, 2026-09-06T23:00:00Z. A missing timestep is a gap in GDELT's data, not zero coverage.";
  const SMOOTHING_NOTICE =
    'A trailing moving average of width 6 needs that many source steps; leading steps without a full window are omitted and peaks may appear later.';
  const out = (result: { structuredContent?: unknown }) => result.structuredContent as Out;
  const call = (input: Record<string, unknown>) =>
    runToolContract(gdeltGetCoverageTimeline, {
      ...QUOKKA_INPUT,
      ...input,
    } as Parameters<typeof gdeltGetCoverageTimeline.handler>[0]);

  /** Every page of a walk from offset 0 with `input`. */
  async function walk(input: Record<string, unknown>) {
    const pages: Array<{ sc: Out; text: string }> = [];
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const result = await call({ ...input, offset });
      expect(result.isError).toBeFalsy();
      pages.push({ sc: out(result), text: contentText(result) });
      offset = out(result).nextOffset;
    }
    return pages;
  }

  /** `count` steps of `stepMs` from `start`, as DOC writes them (YYYYMMDDTHHMMSSZ), each 0. */
  function steps(start: string, count: number, stepMs: number) {
    return Array.from({ length: count }, (_, k) => ({
      date: new Date(Date.parse(start) + k * stepMs)
        .toISOString()
        .replace(/\.000Z$/, 'Z')
        .replaceAll(/[-:]/g, ''),
      value: 0,
    }));
  }
  const HOUR = 3_600_000;

  it('counts the ten hours the quokka answer lacks and names each run on both surfaces', async () => {
    doc.answerDoc({ body: QUOKKA });

    const result = await call({ limit: 400 });

    expect(result.isError).toBeFalsy();
    expect(out(result)).toMatchObject({
      dateResolution: 'hour',
      missingTimesteps: 10,
      totalCount: 159,
      notice: GAP_NOTICE,
      series: [{ label: 'Volume Intensity', pointCount: 159 }],
    });
    expect(out(result).series[0]!.data).toHaveLength(159);
    const text = contentText(result);
    expect(text).toContain('**Date Resolution:** hour\n**Missing timesteps:** 10\n');
    expect(text).toContain(`> ${GAP_NOTICE}`);
  });

  it('carries the same count and runs on every page of a limit-10 walk', async () => {
    doc.answerDoc({ body: QUOKKA });

    const pages = await walk({ limit: 10 });

    expect(pages).toHaveLength(16);
    expect(pages[0]!.sc.notice).toBe(
      `Returned timesteps 1–10 of 159 timesteps; continue with offset 10 (nextOffset) and otherwise identical inputs. ${GAP_NOTICE}`,
    );
    expect(pages.at(-1)!.sc.notice).toBe(
      `Returned timesteps 151–159 of 159 timesteps — the last page. ${GAP_NOTICE}`,
    );
    for (const { sc, text } of pages) {
      expect(sc.missingTimesteps).toBe(10);
      expect(sc.notice?.split(GAP_NOTICE)).toHaveLength(2);
      expect(text).toContain('**Missing timesteps:** 10\n');
      expect(text).toContain(GAP_NOTICE);
    }
  });

  it('carries the same count and runs when points restricts the response', async () => {
    doc.answerDoc({ body: QUOKKA });

    const result = await call({ points: ['2026-09-04T00:00:00Z'] });

    expect(out(result)).toMatchObject({
      missingTimesteps: 10,
      notice: GAP_NOTICE,
      series: [{ pointCount: 159, data: [{ date: '2026-09-04T00:00:00Z', value: 0.0307 }] }],
    });
    expect(contentText(result)).toContain('**Missing timesteps:** 10\n');
  });

  it('takes the resolution DOC reports before inferring one, and infers past one it does not use', async () => {
    doc.answerDoc({
      body: {
        query_details: { date_resolution: 'hour' },
        timeline: [{ series: 'Volume Intensity', data: steps('2026-09-04T00:00:00Z', 1, HOUR) }],
      },
    });
    const reported = await call({});
    expect(out(reported)).toMatchObject({ dateResolution: 'hour', totalCount: 1 });
    expect(out(reported)).not.toHaveProperty('missingTimesteps');
    expect(contentText(reported)).toContain('**Date Resolution:** hour\n');

    // The spelling DOC gives its 15-minute resolution, on one timestep inference cannot read.
    doc.answerDoc({
      body: {
        query_details: { date_resolution: '15m' },
        timeline: [{ series: 'Volume Intensity', data: steps('2026-09-04T00:00:00Z', 1, HOUR) }],
      },
    });
    const quarterHour = await call({ query: 'bilby' });
    expect(out(quarterHour)).toMatchObject({ dateResolution: '15min', totalCount: 1 });
    expect(contentText(quarterHour)).toContain('**Date Resolution:** 15min\n');

    doc.answerDoc({
      body: {
        query_details: { date_resolution: 'fortnight' },
        timeline: [{ series: 'Volume Intensity', data: steps('2026-09-04T00:00:00Z', 2, HOUR) }],
      },
    });
    expect(out(await call({ query: 'numbat' }))).toMatchObject({ dateResolution: 'hour' });
  });

  /**
   * DOC's reported resolution is the answer's `dateResolution` even where the spacing implies a
   * coarser one, but it is DOC's label, not its spacing: timesteps a day apart never step hourly,
   * so the 46 hours between them are not claimed as gaps.
   */
  it('reports the resolution DOC names over the one the spacing implies, and claims no gap the spacing does not show', async () => {
    doc.answerDoc({
      body: {
        query_details: { date_resolution: 'hour' },
        timeline: [
          { series: 'Volume Intensity', data: steps('2026-09-01T00:00:00Z', 3, 24 * HOUR) },
        ],
      },
    });

    const result = await call({});

    expect(out(result)).toMatchObject({ dateResolution: 'hour', totalCount: 3 });
    expect(out(result)).not.toHaveProperty('missingTimesteps');
    expect(out(result).notice ?? '').not.toMatch(/missing/i);
    expect(contentText(result)).toContain('**Date Resolution:** hour\n');
    expect(contentText(result)).not.toContain('Missing timesteps');
  });

  /**
   * Timesteps a week apart infer `day`, the nearest resolution DOC uses, with no daily step among
   * them: the answer reports that resolution and claims no gap at it.
   */
  it.each([
    ['names a resolution the server does not use', { date_resolution: 'week' }],
    ['names none', undefined],
  ])('claims no gap between weekly timesteps when DOC %s', async (_label, query_details) => {
    doc.answerDoc({
      body: {
        ...(query_details && { query_details }),
        timeline: [
          { series: 'Volume Intensity', data: steps('2026-06-01T00:00:00Z', 8, 7 * 24 * HOUR) },
        ],
      },
    });

    const result = await call({ startDatetime: '20260601000000', endDatetime: '20260727000000' });

    expect(out(result)).toMatchObject({ dateResolution: 'day', totalCount: 8 });
    expect(out(result)).not.toHaveProperty('missingTimesteps');
    expect(out(result).notice ?? '').not.toMatch(/missing/i);
    expect(contentText(result)).not.toContain('Missing timesteps');
  });

  it('counts the gaps of an answer that names no resolution at the one its timesteps step at', async () => {
    doc.answerDoc({ body: { timeline: QUOKKA.timeline } });

    const result = await call({ limit: 400 });

    expect(out(result)).toMatchObject({
      dateResolution: 'hour',
      missingTimesteps: 10,
      notice: GAP_NOTICE,
    });
  });

  /**
   * A window that ended under 24 hours before the fetch is fresh for 15 minutes, then served
   * stale when a refetch is refused: still DOC's data, so it is checked like a live answer.
   */
  it('checks a stored DOC answer served stale like a live one', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-09-08T06:00:00Z') });
    try {
      doc.answerDoc({ body: QUOKKA });
      await call({ limit: 400 });
      vi.setSystemTime(Date.parse('2026-09-08T06:16:00Z'));
      doc.answerDoc('refuse');

      const result = await call({ limit: 400 });

      expect(out(result)).toMatchObject({
        staleResponse: { reason: 'gdelt_rate_limited' },
        missingTimesteps: 10,
        notice: GAP_NOTICE,
      });
      expect(contentText(result)).toContain('**Missing timesteps:** 10\n');
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts the gaps of a tone timeline like a volume one', async () => {
    doc.answerDoc({ body: QUOKKA_TONE });

    const result = await call({ mode: 'tone', limit: 400 });

    expect(out(result)).toMatchObject({
      dateResolution: 'hour',
      totalCount: 159,
      missingTimesteps: 10,
      notice: GAP_NOTICE,
    });
    expect(contentText(result)).toContain('**Missing timesteps:** 10\n');
    expect(contentText(result)).toContain(`> ${GAP_NOTICE}`);
  });

  it('leaves a mirror answer with interior holes unchecked', async () => {
    attachMirror(
      mirrorAnswers(
        {
          kind: 'timeline',
          result: [
            {
              label: 'Volume Intensity',
              data: [
                { date: '2026-10-31T10:00:00Z', value: 1 },
                { date: '2026-10-31T13:00:00Z', value: 2 },
                { date: '2026-10-31T14:00:00Z', value: 0 },
              ],
            },
          ],
        },
        3,
      ),
    );
    doc.answerDoc('refuse');

    const result = await runToolContract(gdeltGetCoverageTimeline, {
      query: 'climate',
      ...ROUTED_WINDOW,
    });

    expect(out(result)).toMatchObject({ source: 'gkg_mirror', dateResolution: 'hour' });
    expect(out(result)).not.toHaveProperty('missingTimesteps');
    expect(out(result).notice).toBe(
      `${MIRROR_STANDS_IN_FOR.rate_limited} ${MIRROR_DIVERGENCE_SENTENCE} ${MIRROR_THEME_ROUTE_SENTENCE}`,
    );
  });

  /**
   * The primary guard: an answer whose timesteps are contiguous draws neither the count nor the
   * notice, zeros included, smoothed or not, however far its first or last step sits from the
   * window's edges, at any resolution, on any page.
   */
  describe('a complete answer', () => {
    const FILLED = steps('2026-09-01T00:00:00Z', 169, HOUR);
    const answer = (data: Array<{ date: string; value: number }>, dateResolution?: string) => ({
      ...(dateResolution && {
        query_details: { title: 'quokka', date_resolution: dateResolution },
      }),
      timeline: [{ series: 'Volume Intensity', data }],
    });

    it.each([
      ['every hourly step of the window, zeros included', answer(FILLED, 'hour'), {}],
      ['one that stops 12 hours short of the window end', answer(FILLED.slice(0, 157), 'hour'), {}],
      [
        'a timespan answer starting and ending away from any edge',
        answer(steps('2026-09-03T05:00:00Z', 46, HOUR), 'hour'),
        { startDatetime: undefined, endDatetime: undefined, timespan: '7d' },
      ],
      [
        'contiguous 15-minute steps with no reported resolution',
        answer(steps('2026-09-07T00:00:00Z', 96, HOUR / 4)),
        {},
      ],
      [
        'contiguous days at a reported day resolution',
        answer(steps('2026-06-01T00:00:00Z', 60, 24 * HOUR), 'Day'),
        {},
      ],
    ])('draws no count or gap notice for %s, on any page', async (_label, body, input) => {
      doc.answerDoc({ body });

      const pages = await walk({ limit: 10, ...input });

      expect(pages.length).toBeGreaterThan(1);
      for (const { sc, text } of pages) {
        expect(sc).not.toHaveProperty('missingTimesteps');
        expect(sc.notice).not.toMatch(/missing/i);
        expect(text).not.toContain('Missing timesteps');
      }
    });

    /** #68: smoothing drops leading steps and says so; they are not gaps. */
    it('keeps the smoothing notice alone when a smoothed answer starts late', async () => {
      doc.answerDoc({ body: answer(FILLED.slice(5), 'hour') });

      const result = await call({ smoothing: 6, limit: 400 });

      expect(out(result)).not.toHaveProperty('missingTimesteps');
      expect(out(result).notice).toBe(SMOOTHING_NOTICE);
      expect(contentText(result)).toContain(`> ${SMOOTHING_NOTICE}`);
    });
  });
});
