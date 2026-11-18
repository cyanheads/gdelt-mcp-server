/**
 * @fileoverview Tests for gdelt_get_coverage_breakdown tool.
 * @module tests/tools/get-coverage-breakdown.tool.test
 */

import { readFileSync } from 'node:fs';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { gdeltGetCoverageBreakdown } from '@/mcp-server/tools/definitions/get-coverage-breakdown.tool.js';
import * as docServiceModule from '@/services/gdelt/gdelt-doc-service.js';
import {
  executeMirrorRequest,
  readMirrorCoverage,
} from '@/services/gkg-mirror/gkg-mirror-queries.js';
import type { MirrorCoverageStatus, MirrorResult } from '@/services/gkg-mirror/types.js';
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
import {
  type GkgMirrorFixture,
  gkgRow,
  gkgSlotsBetween,
  openGkgMirrorFixture,
  seedGkgBothFeeds,
  seedGkgRows,
} from '../helpers/gkg-mirror-fixture.js';
import { contentText, literalHtml, renderMarkdown } from './markdown-render.js';

const SERIES = [
  {
    label: 'United States',
    data: [
      { date: '2024-01-01', value: 5.0 },
      { date: '2024-01-02', value: 3.0 },
    ],
  },
  {
    label: 'China',
    data: [
      { date: '2024-01-01', value: 2.0 },
      { date: '2024-01-02', value: 1.5 },
    ],
  },
];

/**
 * 12 series ranked by descending value, so Country10 and Country11 fall outside the
 * top 10 — the two whose identities the "Other" bucket used to dissolve.
 */
const MANY_SERIES = Array.from({ length: 12 }, (_, i) => ({
  label: `Country${i}`,
  data: [
    { date: '2024-01-01', value: 12 - i },
    { date: '2024-01-02', value: 6 - i / 2 },
  ],
}));

/** {@link SERIES} as the tool returns and renders it, each with its sum, point count, and peak. */
const SERIES_OUT = [
  { ...SERIES[0]!, sum: 8, pointCount: 2, peak: { date: '2024-01-01', value: 5 } },
  { ...SERIES[1]!, sum: 3.5, pointCount: 2, peak: { date: '2024-01-01', value: 2 } },
];

function mockBreakdown(series: unknown) {
  vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
    getBreakdown: vi.fn().mockResolvedValue({ series }),
  } as unknown as docServiceModule.GdeltDocService);
}

describe('gdeltGetCoverageBreakdown', () => {
  it('renders exact breakdown values and peaks in both the overview and selection', async () => {
    const supplied = [
      {
        label: 'English Volume Intensity',
        data: [
          { date: '2026-10-21', value: 0.2837 },
          { date: '2026-10-22', value: 1.23456789 },
        ],
      },
    ];
    const getBreakdown = vi.fn().mockResolvedValue({ series: supplied });
    vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
      getBreakdown,
    } as unknown as docServiceModule.GdeltDocService);
    for (const series of [undefined, ['English Volume Intensity']]) {
      const response = await runToolContract(gdeltGetCoverageBreakdown, {
        query: 'bird flu',
        breakdownBy: 'language',
        ...(series && { series }),
      });
      expect(response.isError).toBeFalsy();
      expect(response.structuredContent).toMatchObject(
        series ? { selectedSeries: supplied } : { topSeries: supplied },
      );
      expect(contentText(response)).toContain('- 2026-10-21: 0.2837');
      expect(contentText(response)).toContain('- 2026-10-22: 1.23456789');
      expect(contentText(response)).toContain('Peak: 1.23456789 at 2026-10-22');
    }
    expect(getBreakdown).toHaveBeenCalledTimes(2);
  });
  it('prints the exact sum of a series in the overview and a selection', async () => {
    const supplied = [
      {
        label: 'English Volume Intensity',
        data: [0.1, 0.2, 0.2837].map((value, d) => ({ date: `2026-10-2${d}`, value })),
      },
    ];
    mockBreakdown(supplied);
    for (const series of [undefined, ['English Volume Intensity']]) {
      const response = await runToolContract(gdeltGetCoverageBreakdown, {
        query: 'bird flu',
        breakdownBy: 'language',
        ...(series && { series }),
      });
      expect(response.structuredContent).toMatchObject(
        series ? { selectedSeries: supplied } : { topSeries: supplied },
      );
      expect(contentText(response)).toContain(
        '### English Volume Intensity (sum of values: 0.5837)\n',
      );
    }
  });
  it('pages by count and composes a smoothing notice without altering selected labels', async () => {
    const getBreakdown = vi.fn().mockResolvedValue({ series: MANY_SERIES });
    vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
      getBreakdown,
    } as unknown as docServiceModule.GdeltDocService);
    const result = await runToolContract(gdeltGetCoverageBreakdown, {
      query: 'test',
      breakdownBy: 'language',
      limit: 1,
      smoothing: 30,
      series: ['Country11', 'Country0'],
    });
    expect(result.structuredContent).toMatchObject({
      selectedSeries: [MANY_SERIES[11]],
      nextOffset: 1,
      notice: expect.stringContaining('moving average'),
    });
    expect(contentText(result)).toContain('moving average');
    expect(contentText(result)).toContain('Next offset:** 1');
    expect(getBreakdown).toHaveBeenCalledWith(
      expect.objectContaining({ smoothing: 30 }),
      expect.anything(),
    );
  });

  it.each([undefined, 0, 1, 6, 30])(
    'composes smoothing %s with an empty breakdown and ignores offset',
    async (smoothing) => {
      mockBreakdown([]);
      const result = await runToolContract(gdeltGetCoverageBreakdown, {
        query: 'test',
        breakdownBy: 'language',
        offset: 42,
        ...(smoothing != null && { smoothing }),
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        topSeries: [],
        notice: expect.stringContaining('No breakdown data'),
      });
      if ((smoothing ?? 0) > 1)
        expect(contentText(result)).toContain('leading steps without a full window');
      else expect(contentText(result)).not.toContain('moving average');
    },
  );

  it('caps selected series at 75 and preserves exact provider labels on each page', async () => {
    const supplied = Array.from({ length: 76 }, (_, i) => ({
      label: `Language ${i} Volume Intensity`,
      data: [{ date: '2026-10-21', value: i }],
    }));
    const getBreakdown = vi.fn().mockResolvedValue({ series: supplied });
    vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
      getBreakdown,
    } as unknown as docServiceModule.GdeltDocService);
    const series = supplied.map((s) => s.label).reverse();
    const result = await runToolContract(gdeltGetCoverageBreakdown, {
      query: 'test',
      breakdownBy: 'language',
      series,
      limit: 76,
    });
    expect(result.structuredContent).toMatchObject({
      limitClamp: { parameter: 'limit', requested: 76, applied: 75 },
      nextOffset: 75,
    });
    // One point each: its value is the series' sum and its peak.
    expect((result.structuredContent as { selectedSeries: unknown[] }).selectedSeries).toEqual(
      supplied
        .toReversed()
        .slice(0, 75)
        .map((s) => ({ ...s, sum: s.data[0]!.value, pointCount: 1, peak: s.data[0] })),
    );
    expect(contentText(result).match(/Limit clamped:/g)).toHaveLength(1);
    expect(getBreakdown).toHaveBeenCalledTimes(1);
    const last = await runToolContract(gdeltGetCoverageBreakdown, {
      query: 'test',
      breakdownBy: 'language',
      series,
      limit: 75,
      offset: 75,
    });
    expect(last.structuredContent).toMatchObject({ selectedSeries: [supplied[0]] });
    expect(last.structuredContent).not.toHaveProperty('limitClamp');
    expect(last.structuredContent).not.toHaveProperty('nextOffset');
    expect(contentText(last)).toContain('Language 0 Volume Intensity');
  });
  beforeEach(() => {
    mockBreakdown(SERIES);
  });

  it('returns breakdown by country', async () => {
    const ctx = createMockContext({ errors: gdeltGetCoverageBreakdown.errors });
    const input = gdeltGetCoverageBreakdown.input.parse({
      query: 'pandemic',
      breakdownBy: 'country',
    });
    const result = await gdeltGetCoverageBreakdown.handler(input, ctx);
    expect(result.topSeries).toHaveLength(2);
  });

  it('populates enrichment with query echo, breakdownBy, and total series count', async () => {
    const ctx = createMockContext({ errors: gdeltGetCoverageBreakdown.errors });
    const input = gdeltGetCoverageBreakdown.input.parse({
      query: 'pandemic',
      breakdownBy: 'country',
    });
    await gdeltGetCoverageBreakdown.handler(input, ctx);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.effectiveQuery).toBe('pandemic');
    expect(enrichment.breakdownBy).toBe('country');
    expect(enrichment.totalCount).toBe(2);
  });

  it('returns breakdown by language', async () => {
    const ctx = createMockContext({ errors: gdeltGetCoverageBreakdown.errors });
    const input = gdeltGetCoverageBreakdown.input.parse({ query: 'flu', breakdownBy: 'language' });
    const result = await gdeltGetCoverageBreakdown.handler(input, ctx);
    expect(result.topSeries).toHaveLength(2);
  });

  it('sorts topSeries by total volume descending', async () => {
    const ctx = createMockContext({ errors: gdeltGetCoverageBreakdown.errors });
    const input = gdeltGetCoverageBreakdown.input.parse({ query: 'test', breakdownBy: 'country' });
    const result = await gdeltGetCoverageBreakdown.handler(input, ctx);
    // US total = 8.0, China total = 3.5 — US should come first
    expect(result.topSeries?.[0]?.label).toBe('United States');
    expect(result.topSeries?.[1]?.label).toBe('China');
  });

  it('names the series beyond the top 10 without summing them when more than 10 series', async () => {
    const manySeries = Array.from({ length: 12 }, (_, i) => ({
      label: `Country${i}`,
      data: [{ date: '2024-01-01', value: 12 - i }],
    }));
    vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
      getBreakdown: vi.fn().mockResolvedValue({ series: manySeries }),
    } as unknown as docServiceModule.GdeltDocService);

    const ctx = createMockContext({ errors: gdeltGetCoverageBreakdown.errors });
    const input = gdeltGetCoverageBreakdown.input.parse({
      query: 'global',
      breakdownBy: 'country',
    });
    const result = await gdeltGetCoverageBreakdown.handler(input, ctx);
    expect(result.topSeries).toHaveLength(10);
    expect(result).not.toHaveProperty('otherAggregated');
    expect(result.otherSeriesLabels).toEqual(['Country10', 'Country11']);
    const enrichment = getEnrichment(ctx);
    expect(enrichment.totalCount).toBe(12);
  });

  /**
   * The echo is unconditional on the input being present, so before the pairing guard it
   * confirmed a boundary that applyTimeRange had silently dropped. The guard now rejects
   * first, making the echo accurate by construction.
   */
  it('never echoes an unpaired boundary — the pairing guard rejects before enrichment', async () => {
    const ctx = createMockContext({ errors: gdeltGetCoverageBreakdown.errors });
    const input = gdeltGetCoverageBreakdown.input.parse({
      query: 'global',
      breakdownBy: 'country',
      startDatetime: '20240101000000',
    });
    await expect(gdeltGetCoverageBreakdown.handler(input, ctx)).rejects.toMatchObject({
      data: { reason: 'invalid_date_range' },
    });
    const enrichment = getEnrichment(ctx);
    expect(enrichment.startDatetime).toBeUndefined();
    expect(enrichment.endDatetime).toBeUndefined();
  });

  describe('zero-match answer', () => {
    beforeEach(() => {
      mockBreakdown([]);
    });

    it('returns an empty overview with echoes and a notice, omitting dateResolution', async () => {
      const result = await runToolContract(gdeltGetCoverageBreakdown, {
        query: 'noresults',
        breakdownBy: 'language',
        startDatetime: '20240101000000',
        endDatetime: '20240131235959',
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({
        topSeries: [],
        effectiveQuery: 'noresults',
        breakdownBy: 'language',
        totalCount: 0,
        startDatetime: '20240101000000',
        endDatetime: '20240131235959',
        notice: expect.stringMatching(/No breakdown data for "noresults".*[Bb]roaden/),
      });
      const text = result.content.map((b) => (b as { text?: string }).text ?? '').join('\n');
      expect(text).not.toContain('Date Resolution');
      expect(text).not.toContain('Peak');
      expect(text).toContain('No breakdown series returned.');
    });

    it('never turns an empty breakdown into unknown_series, and omits selectedSeries', async () => {
      const result = await runToolContract(gdeltGetCoverageBreakdown, {
        query: 'noresults',
        breakdownBy: 'country',
        series: ['Atlantis'],
      });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).not.toHaveProperty('selectedSeries');
      expect((result.structuredContent as { notice?: string }).notice).toContain('series');
    });

    it('no longer declares a no_breakdown_data contract entry', () => {
      expect(gdeltGetCoverageBreakdown.errors?.map((e) => e.reason)).not.toContain(
        'no_breakdown_data',
      );
    });

    it('describes the empty case on the notice field', () => {
      expect(gdeltGetCoverageBreakdown.enrichment?.notice?.description).not.toMatch(
        /Absent on successful responses/,
      );
    });
  });

  it('omits dateResolution when a single timestep leaves it undeterminable', async () => {
    mockBreakdown([{ label: 'English', data: [{ date: '2024-01-01', value: 1 }] }]);
    const result = await runToolContract(gdeltGetCoverageBreakdown, {
      query: 'x',
      breakdownBy: 'language',
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).not.toHaveProperty('dateResolution');
  });

  it('formats output with series labels and peaks', () => {
    const output = {
      dateResolution: 'day' as const,
      topSeries: SERIES_OUT,
    };
    const blocks = gdeltGetCoverageBreakdown.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('United States');
    expect(text).toContain('China');
    // Peak data point for US is 5.0
    expect(text).toContain('Peak: 5 at 2024-01-01');
  });

  /**
   * content[] must carry every point structuredContent carries. Previously only each series'
   * total/peak was rendered, so a text-surface client saw an aggregate derived from the points
   * but never the points themselves. Every date/value is asserted individually.
   */
  it('renders every data point of every topSeries', () => {
    const topSeries = [
      {
        label: 'United States',
        sum: 30,
        pointCount: 15,
        peak: { date: '2024-03-15', value: 3.75 },
        data: Array.from({ length: 15 }, (_, i) => ({
          date: `2024-03-${String(i + 1).padStart(2, '0')}`,
          value: (i + 1) / 4,
        })),
      },
      {
        label: 'China',
        sum: 7.5,
        pointCount: 15,
        peak: { date: '2024-03-15', value: 0.9375 },
        data: Array.from({ length: 15 }, (_, i) => ({
          date: `2024-03-${String(i + 1).padStart(2, '0')}`,
          value: (i + 1) / 16,
        })),
      },
    ];
    const blocks = gdeltGetCoverageBreakdown.format!({ dateResolution: 'day', topSeries });
    const text = (blocks[0] as { text: string }).text;
    for (const s of topSeries) {
      for (const d of s.data) expect(text).toContain(`- ${d.date}: ${d.value}`);
    }
  });

  /**
   * The values are normalized shares of media output, which is why small media markets can
   * outrank large ones. The text surface must say so — an agent reading only content[] would
   * otherwise have no way to interpret the ranking.
   */
  it('discloses in format output that values are normalized, not article counts', () => {
    const blocks = gdeltGetCoverageBreakdown.format!({
      dateResolution: 'day',
      topSeries: SERIES_OUT,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('normalized');
    expect(text).toContain('not an article count');
  });

  /**
   * Series selection. The top-10 ranking used to discard the omitted series' identities
   * outright — only a summed "Other" bucket survived, itself removed in #55 — so a caller could
   * see that N series existed but never learn their names or reach their data. These cases pin
   * the disclose-then-select-by-label contract that replaced that dead end.
   */
  describe('series selection', () => {
    beforeEach(() => {
      mockBreakdown(MANY_SERIES);
    });

    it('names every series beyond the top 10, ranked, so each one is selectable', async () => {
      const ctx = createMockContext({ errors: gdeltGetCoverageBreakdown.errors });
      const input = gdeltGetCoverageBreakdown.input.parse({
        query: 'global',
        breakdownBy: 'country',
      });
      const result = await gdeltGetCoverageBreakdown.handler(input, ctx);
      expect(result.otherSeriesLabels).toEqual(['Country10', 'Country11']);
    });

    it('omits otherSeriesLabels when every series fits in the top 10', async () => {
      mockBreakdown(SERIES);
      const ctx = createMockContext({ errors: gdeltGetCoverageBreakdown.errors });
      const input = gdeltGetCoverageBreakdown.input.parse({
        query: 'test',
        breakdownBy: 'country',
      });
      const result = await gdeltGetCoverageBreakdown.handler(input, ctx);
      expect(result.otherSeriesLabels).toBeUndefined();
    });

    it('returns the complete, untruncated series for a label beyond the top 10', async () => {
      const ctx = createMockContext({ errors: gdeltGetCoverageBreakdown.errors });
      const input = gdeltGetCoverageBreakdown.input.parse({
        query: 'global',
        breakdownBy: 'country',
        series: ['Country11'],
      });
      const result = await gdeltGetCoverageBreakdown.handler(input, ctx);
      expect(result.selectedSeries).toEqual([
        { ...MANY_SERIES[11], sum: 1.5, pointCount: 2, peak: { date: '2024-01-01', value: 1 } },
      ]);
    });

    it('returns selected series in the order requested, top-10 labels included', async () => {
      const ctx = createMockContext({ errors: gdeltGetCoverageBreakdown.errors });
      const input = gdeltGetCoverageBreakdown.input.parse({
        query: 'global',
        breakdownBy: 'country',
        series: ['Country11', 'Country0'],
      });
      const result = await gdeltGetCoverageBreakdown.handler(input, ctx);
      expect(result.selectedSeries?.map((s) => s.label)).toEqual(['Country11', 'Country0']);
    });

    it('returns only selectedSeries for a selection, without the ranked overview (#54)', async () => {
      const ctx = createMockContext({ errors: gdeltGetCoverageBreakdown.errors });
      const input = gdeltGetCoverageBreakdown.input.parse({
        query: 'global',
        breakdownBy: 'country',
        series: ['Country10'],
      });
      const result = await gdeltGetCoverageBreakdown.handler(input, ctx);
      expect(result).toEqual({
        dateResolution: 'day',
        selectedSeries: [
          { ...MANY_SERIES[10], sum: 3, pointCount: 2, peak: { date: '2024-01-01', value: 2 } },
        ],
      });
    });

    it('omits selectedSeries when series is not supplied', async () => {
      const ctx = createMockContext({ errors: gdeltGetCoverageBreakdown.errors });
      const input = gdeltGetCoverageBreakdown.input.parse({
        query: 'global',
        breakdownBy: 'country',
      });
      const result = await gdeltGetCoverageBreakdown.handler(input, ctx);
      expect(result.selectedSeries).toBeUndefined();
    });

    it('rejects an unknown label, naming every miss and listing what is available', async () => {
      const ctx = createMockContext({ errors: gdeltGetCoverageBreakdown.errors });
      const input = gdeltGetCoverageBreakdown.input.parse({
        query: 'global',
        breakdownBy: 'country',
        series: ['country0', 'Atlantis'],
      });
      const err = await Promise.resolve(gdeltGetCoverageBreakdown.handler(input, ctx)).catch(
        (e: unknown) => e,
      );
      expect(err).toMatchObject({
        data: { reason: 'unknown_series', unknownLabels: ['country0', 'Atlantis'] },
      });
      const hint: string = (err as { data: { recovery: { hint: string } } }).data.recovery.hint;
      expect(hint).toContain('"country0"');
      expect(hint).toContain('"Atlantis"');
      // The recovery has to carry the labels — a rejection has no response body to read them from.
      expect(hint).toContain('Country0');
      expect(hint).toContain('Country11');
    });

    it('renders every point of every selected series, and the folded-in labels', () => {
      const selectedSeries = [
        {
          label: 'Country11',
          sum: 30,
          pointCount: 20,
          peak: { date: '2024-05-20', value: 20 / 7 },
          data: Array.from({ length: 20 }, (_, i) => ({
            date: `2024-05-${String(i + 1).padStart(2, '0')}`,
            value: (i + 1) / 7,
          })),
        },
      ];
      const blocks = gdeltGetCoverageBreakdown.format!({
        dateResolution: 'day',
        topSeries: SERIES_OUT,
        otherSeriesLabels: ['Country10', 'Country11'],
        selectedSeries,
      });
      const text = (blocks[0] as { text: string }).text;
      for (const d of selectedSeries[0]!.data) {
        expect(text).toContain(`- ${d.date}: ${d.value}`);
      }
      expect(text).toContain('Country10');
      expect(text).toContain('series:');
    });

    /**
     * Nothing upstream makes labels unique: the DOC parser maps series one to one (and names
     * every unnamed one `Series`), so a label two series share selects both, never only the last.
     */
    it('returns every series carrying a selected label, in rank order', async () => {
      const shared = [
        { label: 'Series', data: [{ date: '2024-01-01', value: 1 }] },
        { label: 'Country0', data: [{ date: '2024-01-01', value: 2 }] },
        { label: 'Series', data: [{ date: '2024-01-01', value: 3 }] },
      ];
      mockBreakdown(shared);
      const result = await runToolContract(gdeltGetCoverageBreakdown, {
        query: 'global',
        breakdownBy: 'country',
        series: ['Series', 'Country0'],
      });
      expect(result.structuredContent).toMatchObject({
        selectedSeries: [shared[2], shared[0], shared[1]],
      });
      expect(contentText(result)).toContain(
        [
          '## Selected Series (3)',
          'Complete series for the labels requested via the series input.',
          '',
          '### Series (sum of values: 3)',
          'Data points: 1',
          'Peak: 3 at 2024-01-01',
          '- 2024-01-01: 3',
          '',
          '### Series (sum of values: 1)',
        ].join('\n'),
      );
    });
  });

  /**
   * #91: each series names the operator that filters a query to its source. The name-to-code
   * tables are tabled in countries.test.ts and languages.test.ts; these cases prove the wiring.
   */
  describe('source operators (#91)', () => {
    const one = (label: string, value: number) => ({
      label,
      data: [{ date: '2024-01-01', value }],
    });
    const run = (breakdownBy: 'country' | 'language', series?: string[]) =>
      runToolContract(gdeltGetCoverageBreakdown, {
        query: 'x',
        breakdownBy,
        ...(series && { series }),
      });
    const operators = (result: { structuredContent?: unknown }, field = 'topSeries') =>
      (
        (result.structuredContent as Record<string, Array<{ label: string; operator?: string }>>)[
          field
        ] ?? []
      ).map((s) => [s.label, s.operator]);

    it('sets sourcecountry:<FIPS> for a country name with one code, and none otherwise', async () => {
      mockBreakdown([
        one('Germany Volume Intensity', 6),
        one('Austria Volume Intensity', 5),
        one('Serbia Volume Intensity', 4),
        one('Atlantis Volume Intensity', 3),
        one('French Volume Intensity', 2),
        one('Germany', 1),
      ]);
      const result = await run('country');
      expect(operators(result)).toEqual([
        ['Germany Volume Intensity', 'sourcecountry:GM'],
        ['Austria Volume Intensity', 'sourcecountry:AU'],
        ['Serbia Volume Intensity', undefined],
        ['Atlantis Volume Intensity', undefined],
        ['French Volume Intensity', undefined],
        ['Germany', undefined],
      ]);
      const text = contentText(result);
      expect(text).toContain(
        '### Germany Volume Intensity (sum of values: 6)\nOperator: `sourcecountry:GM`\nData points: 1\n',
      );
      expect(text).toContain('### Serbia Volume Intensity (sum of values: 4)\nData points: 1\n');
      expect(text.match(/^Operator: /gm)).toHaveLength(2);
    });

    it('sets sourcelang:<name> for a language name, and none for a code or a country', async () => {
      mockBreakdown([
        one('NorwegianNynorsk Volume Intensity', 4),
        one('French Volume Intensity', 3),
        one('fra Volume Intensity', 2),
        one('France Volume Intensity', 1),
      ]);
      const result = await run('language');
      expect(operators(result)).toEqual([
        ['NorwegianNynorsk Volume Intensity', 'sourcelang:norwegiannynorsk'],
        ['French Volume Intensity', 'sourcelang:french'],
        ['fra Volume Intensity', undefined],
        ['France Volume Intensity', undefined],
      ]);
      expect(contentText(result)).toContain(
        '### French Volume Intensity (sum of values: 3)\nOperator: `sourcelang:french`\nData points: 1\n',
      );
    });

    it('sets the operator on selected series, leaving labels as returned', async () => {
      mockBreakdown([one('United Kingdom Volume Intensity', 2), one('Serbia Volume Intensity', 1)]);
      const result = await run('country', [
        'Serbia Volume Intensity',
        'United Kingdom Volume Intensity',
      ]);
      expect(operators(result, 'selectedSeries')).toEqual([
        ['Serbia Volume Intensity', undefined],
        ['United Kingdom Volume Intensity', 'sourcecountry:UK'],
      ]);
      expect(contentText(result)).toContain(
        '### United Kingdom Volume Intensity (sum of values: 2)\nOperator: `sourcecountry:UK`\n',
      );
    });
  });

  /**
   * Series labels reach content[] as literal text — in headings and as the first text of a
   * list item, where a leading marker would otherwise open a nested block — while
   * structuredContent keeps every raw label.
   */
  describe('Markdown escaping at the content[] boundary', () => {
    const point = (value: number) => [{ date: '2024-01-15', value }];
    const HOSTILE_SERIES = [
      { label: 'United *States*', data: point(20) },
      ...Array.from({ length: 9 }, (_, i) => ({ label: `Country${i + 1}`, data: point(19 - i) })),
      { label: '1. Rank', data: point(3) },
      { label: '> quoted', data: point(2) },
      { label: '- dash', data: point(1.5) },
      { label: '[Portugal]', data: point(1) },
    ];

    it('renders plain upstream values byte-identically to the pre-escaping format()', () => {
      const blocks = gdeltGetCoverageBreakdown.format!({
        dateResolution: 'day',
        topSeries: [
          {
            label: 'United States',
            sum: 2,
            pointCount: 1,
            peak: { date: '2024-01-15', value: 2 },
            data: [{ date: '2024-01-15', value: 2 }],
          },
        ],
        otherSeriesLabels: ['Portugal', 'Viet Nam'],
        selectedSeries: [
          {
            label: 'Portugal',
            sum: 0.1,
            pointCount: 1,
            peak: { date: '2024-01-15', value: 0.1 },
            data: [{ date: '2024-01-15', value: 0.1 }],
          },
        ],
      });
      expect((blocks[0] as { text: string }).text).toBe(
        '## GDELT Coverage Breakdown\n**Date Resolution:** day\n**Values:** normalized — each ' +
          "value is the topic's share of that source's media output, not an article count. Small " +
          'media markets with concentrated coverage rank above large markets with diverse output.\n\n' +
          '### United States (sum of values: 2)\nData points: 1\nPeak: 2 at 2024-01-15\n' +
          '- 2024-01-15: 2\n\n### Series not on this page (2)\nRanked by sum of values. ' +
          'Re-call with series: ["<label>"] to get any of them in full.\n- Portugal\n- Viet Nam\n\n' +
          '## Selected Series (1)\nComplete series for the labels requested via the series input.\n\n' +
          '### Portugal (sum of values: 0.1)\nData points: 1\nPeak: 0.1 at 2024-01-15\n- 2024-01-15: 0.1',
      );
    });

    it('escapes labels in headings and list items, and leaves structuredContent raw', async () => {
      mockBreakdown(HOSTILE_SERIES);
      // The ranked overview and a series selection are separate pages (#54).
      const overview = await runToolContract(gdeltGetCoverageBreakdown, {
        query: 'x',
        breakdownBy: 'country',
      });
      const selection = await runToolContract(gdeltGetCoverageBreakdown, {
        query: 'x',
        breakdownBy: 'country',
        series: ['[Portugal]'],
      });
      const sc = overview.structuredContent as {
        topSeries: Array<{ label: string }>;
        otherSeriesLabels: string[];
      };
      const selected = selection.structuredContent as { selectedSeries: Array<{ label: string }> };
      expect(sc.topSeries[0]?.label).toBe('United *States*');
      expect(sc.otherSeriesLabels).toEqual(['1. Rank', '> quoted', '- dash', '[Portugal]']);
      expect(selected.selectedSeries[0]?.label).toBe('[Portugal]');

      const text = (overview.content[0] as { text: string }).text;
      expect(text).toContain(String.raw`### United \*States\* (sum of values: 20)`);
      expect(text).toContain(
        ['- 1\\. Rank', '- \\> quoted', '- \\- dash', '- \\[Portugal\\]'].join('\n'),
      );
      expect((selection.content[0] as { text: string }).text).toContain(
        String.raw`### \[Portugal\] (sum of values: 1)`,
      );

      const html = renderMarkdown(contentText(overview));
      expect(html).toContain(`<h3>${literalHtml('United *States*')} (sum of values: 20)</h3>`);
      for (const label of sc.otherSeriesLabels) {
        expect(html).toContain(`<li>${literalHtml(label)}</li>`);
      }
      expect(html).not.toMatch(/<(ol|em)>|<li>\s*<ul>/);
      // The one blockquote is the server's paging notice (the page stops at 10 of 14 series).
      expect(html.match(/<blockquote>/g)).toHaveLength(1);
      expect(html).toContain('<blockquote>\n<p>Returned series 1–10 of 14 series;');
      expect(renderMarkdown(contentText(selection))).not.toMatch(
        /<(ol|blockquote|em)>|<li>\s*<ul>/,
      );
    });
  });

  /**
   * #55: values are each source's share of its own media output, and shares of different
   * sources' output do not add into a share — so nothing sums series beyond the top 10, and no
   * header calls a sum of values a "total".
   */
  describe('no aggregate of folded series (#55)', () => {
    const TWELVE = Array.from({ length: 12 }, (_, i) => ({
      label: `Country ${String.fromCharCode(65 + i)}`,
      data: [{ date: '2026-10-01T00:00:00Z', value: 60 }],
    }));

    beforeEach(() => mockBreakdown(TWELVE));

    it('returns no otherAggregated and no "Other" section, naming the folded labels in rank order', async () => {
      const result = await runToolContract(gdeltGetCoverageBreakdown, {
        query: 'drought',
        breakdownBy: 'country',
      });
      const sc = result.structuredContent as Record<string, unknown>;
      expect(sc).not.toHaveProperty('otherAggregated');
      expect(sc.otherSeriesLabels).toEqual(['Country K', 'Country L']);
      const text = contentText(result);
      expect(text).not.toMatch(/^### Other$/m);
      expect(text).not.toContain('Total: 120');
      expect(text).not.toMatch(/\(total: /);
      expect(text).toContain('### Country A (sum of values: 60)');
    });

    it('no longer declares otherAggregated in its output schema', () => {
      expect(Object.keys(gdeltGetCoverageBreakdown.output.shape)).not.toContain('otherAggregated');
    });

    it('returns a folded series unchanged when its label is passed to series', async () => {
      const result = await runToolContract(gdeltGetCoverageBreakdown, {
        query: 'drought',
        breakdownBy: 'country',
        series: ['Country L'],
      });
      expect((result.structuredContent as { selectedSeries: unknown }).selectedSeries).toEqual([
        {
          ...TWELVE[11],
          sum: 60,
          pointCount: 1,
          peak: { date: '2026-10-01T00:00:00Z', value: 60 },
        },
      ]);
    });
  });

  /**
   * Count pages preserve full series and exact labels, independent of rendered size.
   */
  describe('count paging', () => {
    type Series = { label: string; data: Array<{ date: string; value: number }> };
    type Out = {
      topSeries?: Series[];
      otherSeriesLabels?: string[];
      selectedSeries?: Series[];
      dateResolution?: string;
      nextOffset?: number;
      totalCount: number;
      notice?: string;
    };

    const stamp = (k: number) =>
      new Date(Date.UTC(2026, 9, 1) + k * 15 * 60_000).toISOString().replace('.000Z', 'Z');
    // Descending series sums: series s ranks s-th.
    const BIG = Array.from({ length: 200 }, (_, s) => ({
      label: `Country Name ${s}`,
      data: Array.from({ length: 288 }, (_, k) => ({
        date: stamp(k),
        value: Math.round((200 - s) * 1000 + ((k * 7919) % 1000)) / 10_000,
      })),
    }));
    const RANKED = BIG.map((s) => s.label);
    const FOLDED = RANKED.slice(10);
    /**
     * A BIG series as the overview returns it. Each value is a whole number of ten-thousandths, so
     * the exact sum is their integer total over 10,000; a series' values are distinct, so its peak
     * is the one largest.
     */
    const summarized = (s: Series) => {
      const tenThousandths = s.data.map((d) => Math.round(d.value * 10_000));
      return {
        ...s,
        sum: tenThousandths.reduce((total, n) => total + n, 0) / 10_000,
        pointCount: s.data.length,
        peak: s.data[tenThousandths.indexOf(Math.max(...tenThousandths))],
      };
    };

    const call = (input: Record<string, unknown>) =>
      runToolContract(gdeltGetCoverageBreakdown, {
        query: 'drought',
        breakdownBy: 'country',
        ...input,
      } as Parameters<typeof gdeltGetCoverageBreakdown.handler>[0]);
    const out = (result: { structuredContent?: unknown }) => result.structuredContent as Out;
    const surfaceBytes = (result: { structuredContent?: unknown; content: unknown[] }) => ({
      structured: Buffer.byteLength(JSON.stringify(result.structuredContent)),
      text: Buffer.byteLength(contentText(result)),
    });

    async function walk(input: Record<string, unknown>, field: 'topSeries' | 'selectedSeries') {
      const pages: Out[] = [];
      let offset: number | undefined = 0;
      while (offset !== undefined) {
        const result = await call({ ...input, offset });
        expect(result.isError).toBeFalsy();
        const sc = out(result);
        const text = contentText(result);
        // The page's lines, read once: searching the whole text for each point is quadratic.
        const lines = new Set(text.split('\n'));
        expect(sc[field]!.length).toBeLessThanOrEqual(Number(input.limit ?? 10));
        const unprinted = sc[field]!.flatMap((series) =>
          series.data
            .map((point) => `- ${point.date}: ${point.value}`)
            .filter((line) => !lines.has(line)),
        );
        expect(unprinted).toEqual([]);
        if (sc.nextOffset !== undefined) {
          expect(text).toContain(`**Next offset:** ${sc.nextOffset}`);
        }
        pages.push(sc);
        offset = sc.nextOffset;
      }
      return { pages, labels: pages.flatMap((p) => (p[field] ?? []).map((s) => s.label)) };
    }

    beforeEach(() => mockBreakdown(BIG));

    it('walks every ranked series once, in rank order, naming the rest on every page (#86)', async () => {
      const { pages, labels } = await walk({ limit: 7 }, 'topSeries');
      expect(pages.length).toBe(29);
      expect(labels).toEqual(RANKED);
      for (const page of pages) {
        const onPage = new Set(page.topSeries!.map((s) => s.label));
        expect(page.otherSeriesLabels).toEqual(RANKED.filter((label) => !onPage.has(label)));
        expect(page.totalCount).toBe(200);
        expect(page.dateResolution).toBe('15min');
        expect(page).not.toHaveProperty('selectedSeries');
      }
      expect(pages[0]!.notice).toMatch(
        /^Returned series 1–7 of 200 series; continue with offset 7/,
      );
      expect(pages.at(-1)!.notice).toMatch(
        /^Returned series 197–200 of 200 series — the last page\.$/,
      );
      expect(pages.at(-1)).not.toHaveProperty('nextOffset');
    });

    it('returns every series and point unchanged across the overview pages', async () => {
      const { pages } = await walk({}, 'topSeries');
      expect(pages).toHaveLength(20);
      expect(pages.flatMap((p) => p.topSeries ?? [])).toEqual(BIG.map(summarized));
    });

    /** The 45-series country breakdown #86 reported, at each of its three calls. */
    describe('a 45-series overview (#86)', () => {
      const FORTY_FIVE = BIG.slice(0, 45);
      beforeEach(() => mockBreakdown(FORTY_FIVE));

      it('returns all 45 series on one page at limit 75, with nothing left to name', async () => {
        const result = await call({ limit: 75 });
        expect(result.isError).toBeFalsy();
        const sc = out(result);
        expect(sc.topSeries).toEqual(FORTY_FIVE.map(summarized));
        expect(sc).not.toHaveProperty('otherSeriesLabels');
        expect(sc).not.toHaveProperty('nextOffset');
        expect(sc).not.toHaveProperty('notice');
        expect(contentText(result)).not.toContain('Series not on this page');
      });

      it('returns the top 10 by default, naming the other 35, with nextOffset 10', async () => {
        const result = await call({});
        const sc = out(result);
        expect(sc.topSeries).toEqual(FORTY_FIVE.slice(0, 10).map(summarized));
        expect(sc.otherSeriesLabels).toEqual(RANKED.slice(10, 45));
        expect(sc.nextOffset).toBe(10);
        expect(sc.totalCount).toBe(45);
        expect(contentText(result)).toContain('**Next offset:** 10');
      });

      it('answers offset 10 with the next ten, naming the series before and after the page', async () => {
        const sc = out(await call({ offset: 10 }));
        expect(sc.topSeries).toEqual(FORTY_FIVE.slice(10, 20).map(summarized));
        expect(sc.otherSeriesLabels).toEqual([...RANKED.slice(0, 10), ...RANKED.slice(20, 45)]);
        expect(sc.nextOffset).toBe(20);
      });

      it('clamps limit 200 to 75 and fills the page from the whole ranked list', async () => {
        const result = await call({ limit: 200 });
        expect(out(result)).toMatchObject({
          limitClamp: { parameter: 'limit', requested: 200, applied: 75 },
          topSeries: FORTY_FIVE,
        });
        expect(out(result)).not.toHaveProperty('nextOffset');
      });

      it('rejects offset 45, naming 0–44 and the ranked total', async () => {
        const result = await call({ offset: 45 });
        expect(result).toMatchObject({
          isError: true,
          structuredContent: {
            error: { data: { reason: 'offset_out_of_range', offset: 45, totalSeries: 45 } },
          },
        });
        expect(contentText(result)).toContain(
          'Retry with offset 0–44; the ranked overview holds 45 series.',
        );
      });
    });

    it('pages a selection of all 190 folded labels as selectedSeries alone, in requested order', async () => {
      const { pages, labels } = await walk({ series: FOLDED }, 'selectedSeries');
      expect(labels).toEqual(FOLDED);
      for (const page of pages) {
        expect(page).not.toHaveProperty('topSeries');
        expect(page).not.toHaveProperty('otherSeriesLabels');
        expect(page.totalCount).toBe(200);
      }
    });

    it('returns all ten series of the default page despite large labels and data', async () => {
      const longLabels = Array.from({ length: 200 }, (_, s) => ({
        ...BIG[s]!,
        label: `${'L'.repeat(400)} ${s}`,
      }));
      mockBreakdown(longLabels);
      const result = await call({});
      const sc = out(result);
      expect(sc.topSeries).toHaveLength(10);
      expect(sc.nextOffset).toBe(10);
      expect(sc.otherSeriesLabels).toHaveLength(190);
      expect(surfaceBytes(result).structured).toBeGreaterThan(50_000);
      expect(surfaceBytes(result).text).toBeGreaterThan(50_000);
    });

    it('fits a 10-or-fewer overview in one page with no continuation or notice', async () => {
      mockBreakdown(BIG.slice(0, 3).map((s) => ({ ...s, data: s.data.slice(0, 40) })));
      const sc = out(await call({}));
      expect(sc.topSeries).toHaveLength(3);
      expect(sc).not.toHaveProperty('nextOffset');
      expect(sc).not.toHaveProperty('notice');
      expect(sc).not.toHaveProperty('otherSeriesLabels');
    });

    it('rejects an offset at or past the series total of the page kind, naming the valid range', async () => {
      const overview = await call({ offset: 200 });
      expect(overview).toMatchObject({
        isError: true,
        structuredContent: {
          error: {
            code: JsonRpcErrorCode.NotFound,
            data: { reason: 'offset_out_of_range', offset: 200, totalSeries: 200 },
          },
        },
      });
      expect(contentText(overview)).toContain('offset 0–199');
      expect((await call({ offset: 199 })).isError).toBeFalsy();
      const selection = await call({ series: FOLDED.slice(0, 2), offset: 2 });
      expect(contentText(selection)).toContain('offset 0–1');
    });

    it('ignores offset on an empty breakdown', async () => {
      mockBreakdown([]);
      const result = await call({ offset: 3 });
      expect(result.isError).toBeFalsy();
      expect(out(result)).toMatchObject({ topSeries: [], totalCount: 0 });
    });

    it('returns every pointless series of an empty breakdown, naming none and ignoring offset and limit', async () => {
      const pointless = ['A', 'B', 'C'].map((label) => ({ label, data: [] }));
      mockBreakdown(pointless);
      const result = await call({ offset: 5, limit: 1 });
      expect(result.isError).toBeFalsy();
      const sc = out(result);
      expect(sc.topSeries).toEqual(pointless.map((s) => ({ ...s, sum: 0, pointCount: 0 })));
      expect(sc).not.toHaveProperty('otherSeriesLabels');
      expect(sc).not.toHaveProperty('nextOffset');
      expect(sc.notice).toMatch(/^No breakdown data for "drought"\./);
    });

    it('keeps unknown_series ahead of the offset check', async () => {
      const result = await call({ series: ['Atlantis'], offset: 9 });
      expect(result).toMatchObject({
        isError: true,
        structuredContent: { error: { data: { reason: 'unknown_series' } } },
      });
    });
  });
});

/**
 * The tool's wiring to the DOC source router: the real DOC service and router with only `fetch`
 * stubbed, and a fake mirror. The router's outcome table lives in doc-source-router.test.ts.
 */
describe('gdelt_get_coverage_breakdown DOC source routing', () => {
  const doc = useRoutedDoc();
  const INPUT = { query: 'climate', breakdownBy: 'country', ...ROUTED_WINDOW } as const;
  const DOC_BREAKDOWN = {
    timeline: [
      { series: 'Germany Volume Intensity', data: [{ date: '20261031T000000Z', value: 83.33 }] },
    ],
  };
  const MIRROR_SERIES = {
    label: 'France Volume Intensity',
    data: [{ date: '2026-10-31T12:00:00Z', value: 4.5 }],
  };
  const MIRROR_BREAKDOWN = {
    kind: 'breakdown',
    result: [MIRROR_SERIES],
    excludedWithoutCountry: 12,
  } satisfies MirrorResult;
  const EMPTY_NOTICE =
    'No breakdown data for "climate". Broaden the query, extend the time window, or verify the query operators are correct.';
  const EXCLUDED_SENTENCE =
    '12 matching articles from outlets with no known source country were left out of the country series.';
  const notice = (result: { structuredContent?: unknown }) =>
    (result.structuredContent as { notice?: string }).notice;

  it('with no mirror, adds no source field and renders as before', async () => {
    doc.answerDoc({ body: DOC_BREAKDOWN });

    const result = await runToolContract(gdeltGetCoverageBreakdown, INPUT);

    expect(result.structuredContent).toEqual({
      topSeries: [
        {
          label: 'Germany Volume Intensity',
          operator: 'sourcecountry:GM',
          sum: 83.33,
          pointCount: 1,
          peak: { date: '2026-10-31T00:00:00Z', value: 83.33 },
          data: [{ date: '2026-10-31T00:00:00Z', value: 83.33 }],
        },
      ],
      effectiveQuery: 'climate',
      totalCount: 1,
      breakdownBy: 'country',
      ...ROUTED_WINDOW,
    });
    expect(contentText(result)).toBe(
      [
        '## GDELT Coverage Breakdown',
        "**Values:** normalized — each value is the topic's share of that source's media output, not an article count. Small media markets with concentrated coverage rank above large markets with diverse output.",
        '',
        '### Germany Volume Intensity (sum of values: 83.33)',
        'Operator: `sourcecountry:GM`',
        'Data points: 1',
        'Peak: 83.33 at 2026-10-31T00:00:00Z',
        '- 2026-10-31T00:00:00Z: 83.33',
        '',
        'Query: "climate"',
        '**1 total**',
        '**breakdownBy:** `country`',
        '**startDatetime:** `20261031000000`',
        '**endDatetime:** `20261101000000`',
      ].join('\n'),
    );
  });

  it('with no mirror, adds the overload sentence to an empty answer on both surfaces (#77)', async () => {
    doc.answerDoc({ body: {} });

    const result = await runToolContract(gdeltGetCoverageBreakdown, INPUT);

    expect(notice(result)).toBe(`${EMPTY_NOTICE} ${OVERLOAD_RETRY_SENTENCE}`);
    expect(contentText(result)).toContain(`> ${EMPTY_NOTICE} ${OVERLOAD_RETRY_SENTENCE}`);
  });

  it('marks a DOC answer doc_api on both surfaces while a mirror stands behind it', async () => {
    attachMirror(mirrorAnswers(MIRROR_BREAKDOWN, 30));
    doc.answerDoc({ body: DOC_BREAKDOWN });

    const result = await runToolContract(gdeltGetCoverageBreakdown, INPUT);

    expect(result.structuredContent).toMatchObject({ source: 'doc_api' });
    expect(result.structuredContent).not.toHaveProperty('attempts');
    expect(contentText(result)).toContain(SOURCE_LINE.doc_api);
  });

  it('answers from the mirror when DOC refuses, naming the articles left out for no known country', async () => {
    attachMirror(mirrorAnswers(MIRROR_BREAKDOWN, 30));
    doc.answerDoc('refuse');

    const result = await runToolContract(gdeltGetCoverageBreakdown, INPUT);

    const mirrorNotice = `${MIRROR_STANDS_IN_FOR.rate_limited} ${MIRROR_DIVERGENCE_SENTENCE} ${MIRROR_THEME_ROUTE_SENTENCE} ${EXCLUDED_SENTENCE}`;
    expect(result.structuredContent).toEqual({
      topSeries: [
        {
          ...MIRROR_SERIES,
          operator: 'sourcecountry:FR',
          sum: 4.5,
          pointCount: 1,
          peak: { date: '2026-10-31T12:00:00Z', value: 4.5 },
        },
      ],
      effectiveQuery: 'climate',
      totalCount: 1,
      breakdownBy: 'country',
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
    expect(text).toContain(
      '### France Volume Intensity (sum of values: 4.5)\nOperator: `sourcecountry:FR`\n',
    );
    expect(text).toContain(SOURCE_LINE.gkg_mirror);
    expect(text).toContain(refusedAttemptsLines('answered'));
    expect(text).toContain(PARTIAL_COVERAGE_LINE);
    expect(text).toContain(`> ${mirrorNotice}`);
  });

  it("keeps the mirror's own sentence, not the overload one, on a mirror answer with no match", async () => {
    attachMirror(mirrorAnswers({ kind: 'breakdown', result: [] }, 0));
    doc.answerDoc('refuse');

    const result = await runToolContract(gdeltGetCoverageBreakdown, INPUT);

    const mirrorNotice = `${EMPTY_NOTICE} ${MIRROR_STANDS_IN_FOR.rate_limited} ${MIRROR_DIVERGENCE_SENTENCE} ${MIRROR_NO_MATCH_SENTENCE} ${MIRROR_THEME_ROUTE_SENTENCE}`;
    expect(notice(result)).toBe(mirrorNotice);
    expect(contentText(result)).toContain(refusedAttemptsLines('empty'));
    expect(contentText(result).split('\n')).toContain(`> ${mirrorNotice}`);
  });

  /** A matching answer here also leaves articles out for no known country: that sentence comes last. */
  it.each(MIRROR_KEYWORD_CASES)(
    'ends the notice with the mirror sentences for a query holding $holds, $matched matched, on both surfaces',
    async ({ query, matched, sentences }) => {
      attachMirror(
        mirrorAnswers(matched > 0 ? MIRROR_BREAKDOWN : { kind: 'breakdown', result: [] }, matched),
      );
      doc.answerDoc('refuse');

      const result = await runToolContract(gdeltGetCoverageBreakdown, { ...INPUT, query });

      const expected = matched > 0 ? `${sentences} ${EXCLUDED_SENTENCE}` : sentences;
      expect(result.structuredContent).toMatchObject({ source: 'gkg_mirror' });
      expect(mirrorSentences(result)).toEqual({ structuredContent: expected, content: expected });
    },
  );

  /**
   * A mirror answer's labels are the table's own names, so every series but the ones whose name
   * has two codes carries an operator — the merged Serbia series (RI and RB) and EK's Equatorial
   * Guinea among those without one, as is a stored language code the table does not name.
   */
  describe('operators on a mirror answer (#91)', () => {
    let fixture: GkgMirrorFixture;
    let status: MirrorCoverageStatus;

    beforeAll(async () => {
      fixture = await openGkgMirrorFixture();
      seedGkgBothFeeds(fixture.handle, gkgSlotsBetween('20261031000000', '20261101000000'));
      const row = (id: string, source_country: string, language: string) =>
        gkgRow({
          url: `https://example.com/${id}`,
          date: '20261031120000',
          domain: 'example.com',
          themes: 'TAX_FNCACT',
          source_country,
          language,
        });
      await seedGkgRows(fixture.store, [
        row('gm', 'GM', 'deu'),
        row('ri', 'RI', 'srp'),
        row('rb', 'RB', 'srp'),
        row('ek', 'EK', 'spa'),
        row('gv', 'GV', 'fra'),
        row('uk', 'UK', 'xyz'),
        row('no', 'NO', 'nno'),
      ]);
      status = { ready: true, ...readMirrorCoverage(fixture.handle) };
    });

    afterAll(async () => {
      await fixture.cleanup();
    });

    beforeEach(() => {
      attachMirror((req) => executeMirrorRequest(fixture.handle, req), status);
      doc.answerDoc('refuse');
    });

    const operatorsOf = async (breakdownBy: 'country' | 'language') => {
      const result = await runToolContract(gdeltGetCoverageBreakdown, {
        query: 'theme:TAX_FNCACT',
        breakdownBy,
        ...ROUTED_WINDOW,
      });
      const sc = result.structuredContent as {
        source: string;
        topSeries: Array<{ label: string; operator?: string }>;
      };
      expect(sc.source).toBe('gkg_mirror');
      for (const { label, operator } of sc.topSeries) {
        if (operator) expect(contentText(result)).toContain(`Operator: \`${operator}\``);
        else expect(contentText(result)).toMatch(new RegExp(`### ${label} \\(.*\\)\\nData points`));
      }
      return Object.fromEntries(sc.topSeries.map((s) => [s.label, s.operator]));
    };

    it('names the operator of each country series with one code', async () => {
      expect(await operatorsOf('country')).toEqual({
        'Germany Volume Intensity': 'sourcecountry:GM',
        'Serbia Volume Intensity': undefined,
        'Equatorial Guinea Volume Intensity': undefined,
        'Guinea Volume Intensity': 'sourcecountry:GV',
        'United Kingdom Volume Intensity': 'sourcecountry:UK',
        'Norway Volume Intensity': 'sourcecountry:NO',
      });
    });

    it('names the operator of each language series the table names', async () => {
      expect(await operatorsOf('language')).toEqual({
        'German Volume Intensity': 'sourcelang:german',
        'Serbian Volume Intensity': 'sourcelang:serbian',
        'Spanish Volume Intensity': 'sourcelang:spanish',
        'French Volume Intensity': 'sourcelang:french',
        'xyz Volume Intensity': undefined,
        'NorwegianNynorsk Volume Intensity': 'sourcelang:norwegiannynorsk',
      });
    });
  });

  it("keeps DOC's empty answer with the overload sentence when the mirror has no match either", async () => {
    attachMirror(mirrorAnswers({ kind: 'breakdown', result: [] }, 0));
    doc.answerDoc({ body: {} });

    const result = await runToolContract(gdeltGetCoverageBreakdown, INPUT);

    expect(result.structuredContent).toMatchObject({
      topSeries: [],
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
    const fetch = doc.answerDoc({ body: DOC_BREAKDOWN });

    const result = await runToolContract(gdeltGetCoverageBreakdown, { ...INPUT, ...SHORT_WINDOW });

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
    attachMirror(mirrorAnswers(MIRROR_BREAKDOWN, 30, SHORT_WINDOW_COVERAGE));
    const fetch = doc.answerDoc({ body: DOC_BREAKDOWN });

    const result = await runToolContract(gdeltGetCoverageBreakdown, { ...INPUT, ...SHORT_WINDOW });

    const mirrorNotice = `${MIRROR_STANDS_IN_FOR.window_too_short} ${MIRROR_DIVERGENCE_SENTENCE} ${MIRROR_THEME_ROUTE_SENTENCE} ${EXCLUDED_SENTENCE}`;
    expect(result.structuredContent).toMatchObject({
      topSeries: [{ label: 'France Volume Intensity', operator: 'sourcecountry:FR', sum: 4.5 }],
      ...SHORT_WINDOW,
      source: 'gkg_mirror',
      attempts: [
        { source: 'doc_api', outcome: 'window_too_short', detail: SHORT_WINDOW_FAULT },
        { source: 'gkg_mirror', outcome: 'answered' },
      ],
      notice: mirrorNotice,
    });
    expect(result.structuredContent).not.toHaveProperty('coverage');
    const text = contentText(result);
    expect(text).toContain(SOURCE_LINE.gkg_mirror);
    expect(text).toContain(shortWindowAttemptsLines('answered'));
    expect(text).toContain(`> ${mirrorNotice}`);
    expect(fetch).not.toHaveBeenCalled();
  });
});

type SummarySeries = {
  label: string;
  operator?: string;
  sum?: number;
  pointCount?: number;
  peak?: { date: string; value: number };
  data?: Array<{ date: string; value: number }>;
};
type SummaryOut = {
  topSeries?: SummarySeries[];
  selectedSeries?: SummarySeries[];
  otherSeriesLabels?: string[];
  dateResolution?: string;
  missingTimesteps?: number;
  nextOffset?: number;
  totalCount: number;
  notice?: string;
  source?: string;
};
const summaryOut = (result: { structuredContent?: unknown }) =>
  result.structuredContent as SummaryOut;

/** A raw DOC `timelinesourcecountry` answer: `points` dated by `dates`, one series per entry. */
function countryAnswer(
  dates: readonly string[],
  series: Record<string, readonly number[]>,
  dateResolution: string | undefined = 'hour',
) {
  return {
    ...(dateResolution && { query_details: { title: 'climate', date_resolution: dateResolution } }),
    timeline: Object.entries(series).map(([name, values]) => ({
      series: `${name} Volume Intensity`,
      data: dates.map((date, k) => ({ date, value: values[k] ?? 0 })),
    })),
  };
}

/**
 * #96: each series carries the sum it is ranked by, its point count, and its peak on both
 * surfaces, and `includePoints: false` leaves its points out. Run through the real DOC service
 * with only `fetch` stubbed.
 */
describe('gdelt_get_coverage_breakdown series summaries (#96)', () => {
  const doc = useRoutedDoc();
  const DATES = ['20261031T000000Z', '20261031T010000Z', '20261031T020000Z', '20261031T030000Z'];
  const ISO = [
    '2026-10-31T00:00:00Z',
    '2026-10-31T01:00:00Z',
    '2026-10-31T02:00:00Z',
    '2026-10-31T03:00:00Z',
  ];
  /** France's values add up to 2.0000000000000004 as doubles; its printed and returned sum is 2. */
  const BODY = countryAnswer(DATES, {
    Japan: [0, 0, 0, 0],
    France: [1.1, 0.2, 0.3, 0.4],
    Serbia: [0.1, 0, 0, 0],
    Germany: [0.5, 2.25, 0, 1.25],
  });
  const points = (values: number[]) => values.map((value, k) => ({ date: ISO[k]!, value }));
  /** The ranked overview, every field written out. */
  const RANKED: SummarySeries[] = [
    {
      label: 'Germany Volume Intensity',
      operator: 'sourcecountry:GM',
      sum: 4,
      pointCount: 4,
      peak: { date: '2026-10-31T01:00:00Z', value: 2.25 },
      data: points([0.5, 2.25, 0, 1.25]),
    },
    {
      label: 'France Volume Intensity',
      operator: 'sourcecountry:FR',
      sum: 2,
      pointCount: 4,
      peak: { date: '2026-10-31T00:00:00Z', value: 1.1 },
      data: points([1.1, 0.2, 0.3, 0.4]),
    },
    {
      label: 'Serbia Volume Intensity',
      sum: 0.1,
      pointCount: 4,
      peak: { date: '2026-10-31T00:00:00Z', value: 0.1 },
      data: points([0.1, 0, 0, 0]),
    },
    {
      label: 'Japan Volume Intensity',
      operator: 'sourcecountry:JA',
      sum: 0,
      pointCount: 4,
      peak: { date: '2026-10-31T00:00:00Z', value: 0 },
      data: points([0, 0, 0, 0]),
    },
  ];
  const withoutPoints = ({ data: _, ...summary }: SummarySeries) => summary;
  const INPUT = { query: 'climate', breakdownBy: 'country', ...ROUTED_WINDOW } as const;
  const call = (input: Record<string, unknown> = {}) =>
    runToolContract(gdeltGetCoverageBreakdown, {
      ...INPUT,
      ...input,
    } as Parameters<typeof gdeltGetCoverageBreakdown.handler>[0]);

  async function walk(input: Record<string, unknown>) {
    const pages: Array<{ sc: SummaryOut; text: string }> = [];
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const result = await call({ ...input, offset });
      expect(result.isError).toBeFalsy();
      pages.push({ sc: summaryOut(result), text: contentText(result) });
      offset = summaryOut(result).nextOffset;
    }
    return pages;
  }

  it('returns sum, pointCount, and peak beside every series and its points, on both surfaces', async () => {
    doc.answerDoc({ body: BODY });

    const result = await call();

    expect(summaryOut(result).topSeries).toEqual(RANKED);
    expect(contentText(result)).toContain(
      [
        '### France Volume Intensity (sum of values: 2)',
        'Operator: `sourcecountry:FR`',
        'Data points: 4',
        'Peak: 1.1 at 2026-10-31T00:00:00Z',
        '- 2026-10-31T00:00:00Z: 1.1',
      ].join('\n'),
    );
    expect(contentText(result)).not.toContain('Points:**');
  });

  it('leaves every point out under includePoints: false and still prints each summary', async () => {
    doc.answerDoc({ body: BODY });

    const result = await call({ includePoints: false });

    expect(summaryOut(result).topSeries).toEqual(RANKED.map(withoutPoints));
    const text = contentText(result);
    expect(text).toContain(
      [
        '### Germany Volume Intensity (sum of values: 4)',
        'Operator: `sourcecountry:GM`',
        'Data points: 4',
        'Peak: 2.25 at 2026-10-31T01:00:00Z',
        '',
        '### France Volume Intensity (sum of values: 2)',
      ].join('\n'),
    );
    expect(text).not.toMatch(/^- 2026-10-31T/m);
    expect(text).toContain(
      '**Points:** omitted (includePoints: false); each series keeps its sum, point count, and peak.',
    );
    expect(text).not.toContain('No breakdown series returned.');
  });

  it('leaves the points out of selectedSeries too, in the order requested', async () => {
    doc.answerDoc({ body: BODY });

    const result = await call({
      includePoints: false,
      series: ['Japan Volume Intensity', 'Germany Volume Intensity'],
    });

    expect(summaryOut(result).selectedSeries).toEqual([
      withoutPoints(RANKED[3]!),
      withoutPoints(RANKED[0]!),
    ]);
    expect(contentText(result)).toContain('### Japan Volume Intensity (sum of values: 0)\n');
    expect(contentText(result)).not.toMatch(/^- 2026-10-31T/m);
  });

  /** Ranking, pages, and the labels each page leaves out never depend on whether points come. */
  it('pages and ranks the same with or without points, each summary identical on every page and in a selection', async () => {
    doc.answerDoc({ body: BODY });

    const withPoints = await walk({ limit: 1 });
    const summaries = await walk({ limit: 1, includePoints: false });

    expect(withPoints).toHaveLength(4);
    expect(
      summaries.map(({ sc }) => ({ ...sc, topSeries: sc.topSeries?.map(withoutPoints) })),
    ).toEqual(withPoints.map(({ sc }) => ({ ...sc, topSeries: sc.topSeries?.map(withoutPoints) })));
    for (const [k, { sc }] of withPoints.entries()) expect(sc.topSeries).toEqual([RANKED[k]]);
    for (const series of RANKED) {
      const selected = summaryOut(await call({ series: [series.label] })).selectedSeries;
      expect(selected).toEqual([series]);
    }
  });

  it('returns each pointless series of an empty breakdown with a zero sum and count and no peak', async () => {
    doc.answerDoc({ body: countryAnswer([], { Germany: [], France: [] }) });

    const full = await call();
    const summaries = await call({ includePoints: false });

    expect(summaryOut(full).topSeries).toEqual([
      {
        label: 'Germany Volume Intensity',
        operator: 'sourcecountry:GM',
        sum: 0,
        pointCount: 0,
        data: [],
      },
      {
        label: 'France Volume Intensity',
        operator: 'sourcecountry:FR',
        sum: 0,
        pointCount: 0,
        data: [],
      },
    ]);
    expect(summaryOut(summaries).topSeries).toEqual([
      { label: 'Germany Volume Intensity', operator: 'sourcecountry:GM', sum: 0, pointCount: 0 },
      { label: 'France Volume Intensity', operator: 'sourcecountry:FR', sum: 0, pointCount: 0 },
    ]);
    for (const result of [full, summaries]) {
      expect(contentText(result)).toContain('No breakdown series returned.');
      expect(contentText(result)).not.toContain('Peak:');
    }
  });
});

/**
 * #98: DOC leaves a timestep out of every series of a breakdown where GDELT's own data has a gap
 * (measured: an `earthquake` country breakdown over 2026-09-01 – 09-08 returned 116 series on the
 * quokka timeline's 159 hourly steps). The fixture puts three series on that step set.
 */
describe('gdelt_get_coverage_breakdown missing timesteps (#98)', () => {
  const doc = useRoutedDoc();
  const QUOKKA_DATES = (
    JSON.parse(
      readFileSync(
        new URL('../fixtures/doc/quokka-timelinevol-20260901-20260908.json', import.meta.url),
        'utf8',
      ),
    ) as { timeline: Array<{ data: Array<{ date: string }> }> }
  ).timeline[0]!.data.map((d) => d.date);
  const wave = (shift: number) => QUOKKA_DATES.map((_, k) => ((k + shift) % 7) / 4);
  const GAPPED = countryAnswer(QUOKKA_DATES, { Germany: wave(0), France: wave(3), Japan: wave(5) });
  const GAP_NOTICE =
    "10 hourly timesteps are missing between the first and last timestep GDELT returned: 2026-09-02T18:00:00Z, 2026-09-03T17:00:00Z–2026-09-03T21:00:00Z (5), 2026-09-04T11:00:00Z, 2026-09-05T22:00:00Z, 2026-09-06T04:00:00Z, 2026-09-06T23:00:00Z. A missing timestep is a gap in GDELT's data, not zero coverage.";
  const INPUT = {
    query: 'earthquake',
    breakdownBy: 'country',
    startDatetime: '20260901000000',
    endDatetime: '20260908000000',
  } as const;
  const call = (input: Record<string, unknown> = {}) =>
    runToolContract(gdeltGetCoverageBreakdown, {
      ...INPUT,
      ...input,
    } as Parameters<typeof gdeltGetCoverageBreakdown.handler>[0]);

  it('counts the ten hours every series lacks, once per response, on both surfaces', async () => {
    doc.answerDoc({ body: GAPPED });

    const result = await call();

    expect(summaryOut(result)).toMatchObject({
      dateResolution: 'hour',
      missingTimesteps: 10,
      notice: GAP_NOTICE,
      totalCount: 3,
    });
    for (const series of summaryOut(result).topSeries ?? []) {
      expect(series).not.toHaveProperty('missingTimesteps');
      expect(series.data).toHaveLength(159);
      // The points the series holds, not the 169 timesteps its first and last span.
      expect(series.pointCount).toBe(159);
    }
    expect(contentText(result)).toContain('**Date Resolution:** hour\n**Missing timesteps:** 10\n');
    expect(contentText(result)).toContain(`> ${GAP_NOTICE}`);
    expect(contentText(result).match(/^Data points: 159$/gm)).toHaveLength(3);
  });

  it.each([
    ['every page of a limit-1 walk', { limit: 1 }],
    ['every page of a limit-1 walk without points', { limit: 1, includePoints: false }],
    [
      'a series selection, paged',
      { limit: 1, series: ['Japan Volume Intensity', 'France Volume Intensity'] },
    ],
  ])('carries the same count and runs on %s', async (_label, input) => {
    doc.answerDoc({ body: GAPPED });
    const pages: SummaryOut[] = [];
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const result = await call({ ...input, offset });
      expect(result.isError).toBeFalsy();
      expect(contentText(result)).toContain('**Missing timesteps:** 10\n');
      expect(contentText(result)).toContain(GAP_NOTICE);
      pages.push(summaryOut(result));
      offset = summaryOut(result).nextOffset;
    }
    expect(pages.length).toBeGreaterThan(1);
    expect(pages[0]!.notice).toMatch(/^Returned series 1–1 of \d series; continue with offset 1 /);
    for (const page of pages) {
      expect(page.missingTimesteps).toBe(10);
      expect(page.notice?.endsWith(` ${GAP_NOTICE}`)).toBe(true);
    }
  });

  /**
   * Germany, ranked first, holds only the first 40 hours, which run without a gap; France holds
   * all 159. The gaps are the whole answer's: a step France carries is present, and a page or a
   * selection holding only Germany reports France's gaps too.
   */
  it("counts the whole answer's gaps when its series carry different timesteps, on every page and under a selection", async () => {
    doc.answerDoc({
      body: {
        query_details: { title: 'earthquake', date_resolution: 'hour' },
        timeline: [
          {
            series: 'France Volume Intensity',
            data: QUOKKA_DATES.map((date) => ({ date, value: 0.01 })),
          },
          {
            series: 'Germany Volume Intensity',
            data: QUOKKA_DATES.slice(0, 40).map((date) => ({ date, value: 1 })),
          },
        ],
      },
    });

    for (const [input, pageCount] of [
      [{ limit: 1 }, 2],
      [{ series: ['Germany Volume Intensity'] }, 1],
    ] as const) {
      const pages: SummaryOut[] = [];
      let offset: number | undefined = 0;
      while (offset !== undefined) {
        const result = await call({ ...input, offset });
        expect(result.isError).toBeFalsy();
        expect(contentText(result)).toContain('**Missing timesteps:** 10\n');
        expect(contentText(result)).toContain(GAP_NOTICE);
        pages.push(summaryOut(result));
        offset = summaryOut(result).nextOffset;
      }
      expect(pages).toHaveLength(pageCount);
      expect([...(pages[0]!.topSeries ?? []), ...(pages[0]!.selectedSeries ?? [])]).toMatchObject([
        { label: 'Germany Volume Intensity', pointCount: 40 },
      ]);
      for (const page of pages) {
        expect(page).toMatchObject({ dateResolution: 'hour', missingTimesteps: 10 });
        expect(page.notice?.endsWith(GAP_NOTICE)).toBe(true);
      }
    }
  });

  /**
   * Timesteps a week apart infer `day`, the nearest resolution DOC uses, with no daily step among
   * them: the answer reports that resolution and claims no gap at it. An empty `dateResolution`
   * leaves `query_details` out of the answer.
   */
  it.each([
    ['names a resolution the server does not use', 'week'],
    ['names none', ''],
  ])('claims no gap between weekly timesteps when DOC %s', async (_label, reported) => {
    const weeks = ['20260601T000000Z', '20260608T000000Z', '20260615T000000Z', '20260622T000000Z'];
    doc.answerDoc({
      body: countryAnswer(weeks, { Germany: [1, 2, 3, 4], France: [4, 3, 2, 1] }, reported),
    });

    const result = await call({ startDatetime: '20260601000000', endDatetime: '20260623000000' });

    expect(summaryOut(result)).toMatchObject({ dateResolution: 'day', totalCount: 2 });
    expect(summaryOut(result)).not.toHaveProperty('missingTimesteps');
    expect(summaryOut(result).notice ?? '').not.toMatch(/missing/i);
    expect(contentText(result)).not.toContain('Missing timesteps');
  });

  it('takes the resolution DOC reports on a one-timestep answer inference cannot read', async () => {
    doc.answerDoc({ body: countryAnswer(['20260904T000000Z'], { Germany: [1], France: [0.5] }) });

    const result = await call();

    expect(summaryOut(result)).toMatchObject({ dateResolution: 'hour', totalCount: 2 });
    expect(summaryOut(result)).not.toHaveProperty('missingTimesteps');
    expect(contentText(result)).toContain('**Date Resolution:** hour\n');
  });

  /**
   * DOC's reported resolution is the answer's `dateResolution` even where the spacing implies a
   * coarser one, but it is DOC's label, not its spacing: timesteps a day apart never step hourly,
   * so the 46 hours between them are not claimed as gaps.
   */
  it('reports the resolution DOC names over the one the spacing implies, and claims no gap the spacing does not show', async () => {
    const days = ['20260901T000000Z', '20260902T000000Z', '20260903T000000Z'];
    doc.answerDoc({ body: countryAnswer(days, { Germany: [1, 2, 3], France: [3, 2, 1] }) });

    const result = await call();

    expect(summaryOut(result)).toMatchObject({ dateResolution: 'hour', totalCount: 2 });
    expect(summaryOut(result)).not.toHaveProperty('missingTimesteps');
    expect(summaryOut(result).notice ?? '').not.toMatch(/missing/i);
    expect(contentText(result)).toContain('**Date Resolution:** hour\n');
    expect(contentText(result)).not.toContain('Missing timesteps');
  });

  it('leaves a mirror answer with interior holes unchecked', async () => {
    attachMirror(
      mirrorAnswers(
        {
          kind: 'breakdown',
          result: [
            {
              label: 'France Volume Intensity',
              data: [
                { date: '2026-10-31T10:00:00Z', value: 4.5 },
                { date: '2026-10-31T13:00:00Z', value: 1 },
                { date: '2026-10-31T14:00:00Z', value: 0 },
              ],
            },
          ],
        },
        3,
      ),
    );
    doc.answerDoc('refuse');

    const result = await call({ ...ROUTED_WINDOW, query: 'climate' });

    expect(summaryOut(result)).toMatchObject({ source: 'gkg_mirror', dateResolution: 'hour' });
    expect(summaryOut(result)).not.toHaveProperty('missingTimesteps');
    expect(summaryOut(result).notice).toBe(
      `${MIRROR_STANDS_IN_FOR.rate_limited} ${MIRROR_DIVERGENCE_SENTENCE} ${MIRROR_THEME_ROUTE_SENTENCE}`,
    );
  });

  it('draws no count or gap notice for contiguous series, smoothed or not, on any page', async () => {
    const hours = QUOKKA_DATES.slice(0, 40);
    doc.answerDoc({ body: countryAnswer(hours, { Germany: [], France: [1], Japan: [0, 2] }) });

    for (const input of [{ limit: 1 }, { limit: 1, smoothing: 6, query: 'tremor' }]) {
      let offset: number | undefined = 0;
      while (offset !== undefined) {
        const result = await call({ ...input, offset });
        expect(summaryOut(result)).not.toHaveProperty('missingTimesteps');
        expect(summaryOut(result).notice).not.toMatch(/missing/i);
        expect(contentText(result)).not.toContain('Missing timesteps');
        offset = summaryOut(result).nextOffset;
      }
    }
  });

  /** #68: smoothing drops leading steps and says so; they are not gaps. Hours 5–39 run unbroken. */
  it('keeps the smoothing notice alone when a smoothed answer starts late', async () => {
    const smoothingNotice =
      'A trailing moving average of width 6 needs that many source steps; leading steps without a full window are omitted and peaks may appear later.';
    doc.answerDoc({
      body: countryAnswer(QUOKKA_DATES.slice(5, 40), { Germany: [1, 2, 3], France: [0, 1] }),
    });

    const result = await call({ smoothing: 6 });

    expect(summaryOut(result).topSeries?.[0]?.data?.[0]?.date).toBe('2026-09-01T05:00:00Z');
    expect(summaryOut(result)).not.toHaveProperty('missingTimesteps');
    expect(summaryOut(result).notice).toBe(smoothingNotice);
    expect(contentText(result)).toContain(`> ${smoothingNotice}`);
  });

  /**
   * A window that ended under 24 hours before the fetch is fresh for 15 minutes, then served
   * stale when a refetch is refused: still DOC's data, so it is checked like a live answer.
   */
  it('checks a stored DOC answer served stale like a live one', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-09-08T06:00:00Z') });
    try {
      doc.answerDoc({ body: GAPPED });
      await call();
      vi.setSystemTime(Date.parse('2026-09-08T06:16:00Z'));
      doc.answerDoc('refuse');

      const result = await call();

      expect(result.structuredContent).toMatchObject({
        staleResponse: { reason: 'gdelt_rate_limited' },
        missingTimesteps: 10,
        notice: GAP_NOTICE,
      });
      expect(contentText(result)).toContain('**Missing timesteps:** 10\n');
    } finally {
      vi.useRealTimers();
    }
  });
});
