/**
 * @fileoverview Tests for gdelt_get_coverage_timeline tool.
 * @module tests/tools/get-coverage-timeline.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gdeltGetCoverageTimeline } from '@/mcp-server/tools/definitions/get-coverage-timeline.tool.js';
import * as docServiceModule from '@/services/gdelt/gdelt-doc-service.js';
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
  beforeEach(() => {
    vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
      getTimeline: vi.fn().mockResolvedValue(VOLUME_SERIES),
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
      getTimeline: vi.fn().mockResolvedValue(DAY_SERIES),
    } as unknown as docServiceModule.GdeltDocService);

    const ctx = createMockContext({ errors: gdeltGetCoverageTimeline.errors });
    const input = gdeltGetCoverageTimeline.input.parse({ query: 'test', mode: 'volume' });
    const result = await gdeltGetCoverageTimeline.handler(input, ctx);
    expect(result.dateResolution).toBe('day');
  });

  describe('zero-match answer', () => {
    function mockTimeline(series: unknown) {
      vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
        getTimeline: vi.fn().mockResolvedValue(series),
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
      getTimeline: vi
        .fn()
        .mockResolvedValue([
          { label: 'Volume Intensity', data: [{ date: '2024-01-01T00:00:00Z', value: 0.5 }] },
        ]),
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
    expect(text).toContain('1.200');
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
    for (const d of data) expect(text).toContain(`- ${d.date}: ${d.value.toFixed(3)}`);
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
   * true upstream article count *and* how many links it showed, and `points` lifts the cap.
   */
  it('discloses both the true article count and how many links it showed when capping', () => {
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
    expect(text).toContain('(8 articles, 3 shown)');
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
    expect(text).toContain('(1 articles)');
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
        getTimeline: vi.fn().mockResolvedValue(SPIKE_SERIES),
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
      expect(text).toContain('(8 articles, 3 shown)');
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
          '**Data points:** 2\n**Peak:** 1.500 at 2024-01-15T12:00:00Z\n' +
          '- 2024-01-15T12:00:00Z: 1.500 (1 articles)\n  - [Alpha story](https://example.com/a)\n' +
          '- 2024-01-15T13:00:00Z: 0.500',
      );
    });

    it('escapes labels, keeps destinations whole, and leaves structuredContent raw', async () => {
      vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
        getTimeline: vi.fn().mockResolvedValue(HOSTILE_SERIES),
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
          '**Peak:** 1.500 at 2024-01-15T12:00:00Z',
          '- 2024-01-15T12:00:00Z: 1.500 (2 articles)',
          String.raw`  - [\<b>A \&amp; B\</b> \[x\](y)](<https://example.com/a_(b)_c?x=1>)`,
          '  - [Plain title](<https://example.com/a b>)',
          '- 2024-01-15T13:00:00Z: 0.500',
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
   * #54: both surfaces are bounded by the shared per-surface byte budget. Fixtures sit at GDELT's
   * documented maxima — 288 15-minute timesteps for a window under 72 hours, 10 references per
   * timestep — with 100-character titles and URLs. Each response is cut into whole timesteps and
   * walked with offset/nextOffset.
   */
  describe('response budget (#54)', () => {
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
        getTimeline: vi.fn().mockResolvedValue(series),
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

    it('keeps both surfaces of the 288-step, 10-reference maximum at or under 50,000 bytes', async () => {
      const result = await call({});
      expect(result.isError).toBeFalsy();
      const bytes = surfaceBytes(result);
      expect(bytes.structured).toBeLessThanOrEqual(50_000);
      expect(bytes.text).toBeLessThanOrEqual(50_000);
      const sc = out(result);
      expect(sc.nextOffset).toBe(sc.series[0]!.data.length);
      expect(sc.notice).toBe(
        `Returned timesteps 1–${sc.nextOffset} of 288 timesteps; timestep ${sc.nextOffset! + 1} would ` +
          'push this response past its 48,000-byte budget. Continue with offset ' +
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
        expect(text).toContain(`**Peak:** -9.500 at ${ALL_DATES[250]}`);
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
        expect(text).toContain(`- ${point.date}: ${point.value.toFixed(3)} (10 articles, 3 shown)`);
        for (const a of upstream.articles.slice(0, 3)) expect(text).toContain(link(a));
        expect(text).not.toContain(link(upstream.articles[3]!));
      }
      expect(text.match(/^ {2}- \[/gm)).toHaveLength(page.length * 3);
    });

    it('walks nextOffset over every timestep exactly once, in order, each page within budget', async () => {
      const walked: string[] = [];
      let offset: number | undefined = 0;
      let pages = 0;
      while (offset !== undefined) {
        const result = await call({ offset });
        expect(result.isError).toBeFalsy();
        const bytes = surfaceBytes(result);
        expect(bytes.structured).toBeLessThanOrEqual(50_000);
        expect(bytes.text).toBeLessThanOrEqual(50_000);
        const sc = out(result);
        expect(sc.totalCount).toBe(288);
        walked.push(...sc.series[0]!.data.map((d) => d.date));
        offset = sc.nextOffset;
        pages++;
      }
      expect(pages).toBeGreaterThan(1);
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
     * Every page of a points selection carries the expandedPoints echo on both surfaces, so the
     * echo is charged ahead of the timesteps: all 288 named, each with its 10 references, still
     * keeps every page within 50,000 bytes.
     */
    it('walks points naming every timestep within budget, every timestep once and in order', async () => {
      const walked: string[] = [];
      let offset: number | undefined = 0;
      let pages = 0;
      while (offset !== undefined) {
        const result = await call({ points: ALL_DATES, offset });
        expect(result.isError).toBeFalsy();
        const bytes = surfaceBytes(result);
        expect(bytes.structured).toBeLessThanOrEqual(50_000);
        expect(bytes.text).toBeLessThanOrEqual(50_000);
        const sc = out(result);
        expect(sc.expandedPoints).toEqual(ALL_DATES);
        for (const point of sc.series[0]!.data) expect(point.articles).toHaveLength(10);
        walked.push(...sc.series[0]!.data.map((d) => d.date));
        offset = sc.nextOffset;
        pages++;
      }
      expect(pages).toBeGreaterThan(1);
      expect(walked).toEqual(ALL_DATES);
    });

    it('emits a timestep larger than the budget alone, continuing from the next one', async () => {
      const huge = volInfo(3, 10, 6_000);
      mock(huge);
      const dates = huge[0]!.data.map((d) => d.date);
      const first = out(await call({ points: dates }));
      expect(first.series[0]!.data.map((d) => d.date)).toEqual([dates[0]]);
      expect(first.series[0]!.data[0]!.articles).toHaveLength(10);
      expect(first.nextOffset).toBe(1);
      const second = out(await call({ points: dates, offset: 1 }));
      expect(second.series[0]!.data.map((d) => d.date)).toEqual([dates[1]]);
      expect(second.nextOffset).toBe(2);
      expect(second.notice).toMatch(/^Returned timestep 2 of 3 timesteps; timestep 3 would push/);
    });

    it('returns volume mode at 288 timesteps as one page with no continuation or notice', async () => {
      mock([
        {
          label: 'Volume Intensity',
          data: ALL_DATES.map((date, k) => ({ date, value: k / 1000 })),
        },
      ]);
      const result = await call({ mode: 'volume' });
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
