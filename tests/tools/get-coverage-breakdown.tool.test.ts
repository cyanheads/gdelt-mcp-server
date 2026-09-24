/**
 * @fileoverview Tests for gdelt_get_coverage_breakdown tool.
 * @module tests/tools/get-coverage-breakdown.tool.test
 */

import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gdeltGetCoverageBreakdown } from '@/mcp-server/tools/definitions/get-coverage-breakdown.tool.js';
import * as docServiceModule from '@/services/gdelt/gdelt-doc-service.js';
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

function mockBreakdown(series: unknown) {
  vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
    getBreakdown: vi.fn().mockResolvedValue(series),
  } as unknown as docServiceModule.GdeltDocService);
}

describe('gdeltGetCoverageBreakdown', () => {
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
    expect(result.topSeries[0]?.label).toBe('United States');
    expect(result.topSeries[1]?.label).toBe('China');
  });

  it('aggregates remaining series into otherAggregated when more than 10 series', async () => {
    const manySeries = Array.from({ length: 12 }, (_, i) => ({
      label: `Country${i}`,
      data: [{ date: '2024-01-01', value: 12 - i }],
    }));
    vi.spyOn(docServiceModule, 'getGdeltDocService').mockReturnValue({
      getBreakdown: vi.fn().mockResolvedValue(manySeries),
    } as unknown as docServiceModule.GdeltDocService);

    const ctx = createMockContext({ errors: gdeltGetCoverageBreakdown.errors });
    const input = gdeltGetCoverageBreakdown.input.parse({
      query: 'global',
      breakdownBy: 'country',
    });
    const result = await gdeltGetCoverageBreakdown.handler(input, ctx);
    expect(result.topSeries).toHaveLength(10);
    expect(result.otherAggregated).toBeDefined();
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

  it('omits otherAggregated when all series fit in top 10', async () => {
    const ctx = createMockContext({ errors: gdeltGetCoverageBreakdown.errors });
    const input = gdeltGetCoverageBreakdown.input.parse({ query: 'test', breakdownBy: 'country' });
    const result = await gdeltGetCoverageBreakdown.handler(input, ctx);
    expect(result.otherAggregated).toBeUndefined();
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
      topSeries: SERIES,
    };
    const blocks = gdeltGetCoverageBreakdown.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('United States');
    expect(text).toContain('China');
    // Peak data point for US is 5.0
    expect(text).toContain('5.000');
  });

  it('formats otherAggregated when present', () => {
    const output = {
      dateResolution: 'day' as const,
      topSeries: SERIES,
      otherAggregated: [{ date: '2024-01-01', value: 1.0 }],
    };
    const blocks = gdeltGetCoverageBreakdown.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Other');
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
        data: Array.from({ length: 15 }, (_, i) => ({
          date: `2024-03-${String(i + 1).padStart(2, '0')}`,
          value: (i + 1) / 4,
        })),
      },
      {
        label: 'China',
        data: Array.from({ length: 15 }, (_, i) => ({
          date: `2024-03-${String(i + 1).padStart(2, '0')}`,
          value: (i + 1) / 16,
        })),
      },
    ];
    const blocks = gdeltGetCoverageBreakdown.format!({ dateResolution: 'day', topSeries });
    const text = (blocks[0] as { text: string }).text;
    for (const s of topSeries) {
      for (const d of s.data) expect(text).toContain(`- ${d.date}: ${d.value.toFixed(3)}`);
    }
  });

  it('renders every point of the otherAggregated bucket, not just its total and peak', () => {
    const otherAggregated = Array.from({ length: 12 }, (_, i) => ({
      date: `2024-04-${String(i + 1).padStart(2, '0')}`,
      value: (i + 1) / 3,
    }));
    const blocks = gdeltGetCoverageBreakdown.format!({
      dateResolution: 'day',
      topSeries: SERIES,
      otherAggregated,
    });
    const text = (blocks[0] as { text: string }).text;
    for (const d of otherAggregated) expect(text).toContain(`- ${d.date}: ${d.value.toFixed(3)}`);
  });

  /**
   * The values are normalized shares of media output, which is why small media markets can
   * outrank large ones. The text surface must say so — an agent reading only content[] would
   * otherwise have no way to interpret the ranking.
   */
  it('discloses in format output that values are normalized, not article counts', () => {
    const blocks = gdeltGetCoverageBreakdown.format!({
      dateResolution: 'day',
      topSeries: SERIES,
    });
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('normalized');
    expect(text).toContain('not an article count');
  });

  /**
   * Series selection. The top-10 ranking used to discard the omitted series' identities
   * outright — only the summed otherAggregated survived — so a caller could see that N
   * series existed but never learn their names or reach their data. These cases pin the
   * disclose-then-select-by-label contract that replaced that dead end.
   */
  describe('series selection', () => {
    beforeEach(() => {
      mockBreakdown(MANY_SERIES);
    });

    it('names every series folded into Other, ranked, so each one is selectable', async () => {
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

    it('returns the complete, untruncated series for a label folded into Other', async () => {
      const ctx = createMockContext({ errors: gdeltGetCoverageBreakdown.errors });
      const input = gdeltGetCoverageBreakdown.input.parse({
        query: 'global',
        breakdownBy: 'country',
        series: ['Country11'],
      });
      const result = await gdeltGetCoverageBreakdown.handler(input, ctx);
      expect(result.selectedSeries).toEqual([MANY_SERIES[11]]);
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

    it('keeps the ranked overview alongside a selection', async () => {
      const ctx = createMockContext({ errors: gdeltGetCoverageBreakdown.errors });
      const input = gdeltGetCoverageBreakdown.input.parse({
        query: 'global',
        breakdownBy: 'country',
        series: ['Country10'],
      });
      const result = await gdeltGetCoverageBreakdown.handler(input, ctx);
      expect(result.topSeries).toHaveLength(10);
      expect(result.otherAggregated).toBeDefined();
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
          data: Array.from({ length: 20 }, (_, i) => ({
            date: `2024-05-${String(i + 1).padStart(2, '0')}`,
            value: (i + 1) / 7,
          })),
        },
      ];
      const blocks = gdeltGetCoverageBreakdown.format!({
        dateResolution: 'day',
        topSeries: SERIES,
        otherSeriesLabels: ['Country10', 'Country11'],
        selectedSeries,
      });
      const text = (blocks[0] as { text: string }).text;
      for (const d of selectedSeries[0]!.data) {
        expect(text).toContain(`- ${d.date}: ${d.value.toFixed(3)}`);
      }
      expect(text).toContain('Country10');
      expect(text).toContain('series:');
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
        topSeries: [{ label: 'United States', data: [{ date: '2024-01-15', value: 2 }] }],
        otherAggregated: [{ date: '2024-01-15', value: 0.25 }],
        otherSeriesLabels: ['Portugal', 'Viet Nam'],
        selectedSeries: [{ label: 'Portugal', data: [{ date: '2024-01-15', value: 0.1 }] }],
      });
      expect((blocks[0] as { text: string }).text).toBe(
        '## GDELT Coverage Breakdown\n**Date Resolution:** day\n**Values:** normalized — each ' +
          "value is the topic's share of that source's media output, not an article count. Small " +
          'media markets with concentrated coverage rank above large markets with diverse output.\n\n' +
          '### United States (total: 2.00)\nData points: 1\nPeak: 2.000 at 2024-01-15\n' +
          '- 2024-01-15: 2.000\n\n### Other\nTotal: 0.25\nPeak: 0.250 at 2024-01-15\n' +
          '- 2024-01-15: 0.250\n\n### Series folded into "Other" (2)\nRanked by total volume. ' +
          'Re-call with series: ["<label>"] to get any of them in full.\n- Portugal\n- Viet Nam\n\n' +
          '## Selected Series (1)\nComplete series for the labels requested via the series input.\n\n' +
          '### Portugal (total: 0.10)\nData points: 1\nPeak: 0.100 at 2024-01-15\n- 2024-01-15: 0.100',
      );
    });

    it('escapes labels in headings and list items, and leaves structuredContent raw', async () => {
      mockBreakdown(HOSTILE_SERIES);
      const result = await runToolContract(gdeltGetCoverageBreakdown, {
        query: 'x',
        breakdownBy: 'country',
        series: ['[Portugal]'],
      });
      const sc = result.structuredContent as {
        topSeries: Array<{ label: string }>;
        otherSeriesLabels: string[];
        selectedSeries: Array<{ label: string }>;
      };
      expect(sc.topSeries[0]?.label).toBe('United *States*');
      expect(sc.otherSeriesLabels).toEqual(['1. Rank', '> quoted', '- dash', '[Portugal]']);
      expect(sc.selectedSeries[0]?.label).toBe('[Portugal]');

      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain(String.raw`### United \*States\* (total: 20.00)`);
      expect(text).toContain(
        ['- 1\\. Rank', '- \\> quoted', '- \\- dash', '- \\[Portugal\\]'].join('\n'),
      );
      expect(text).toContain(String.raw`### \[Portugal\] (total: 1.00)`);

      const html = renderMarkdown(contentText(result));
      expect(html).toContain(`<h3>${literalHtml('United *States*')} (total: 20.00)</h3>`);
      for (const label of sc.otherSeriesLabels) {
        expect(html).toContain(`<li>${literalHtml(label)}</li>`);
      }
      expect(html).not.toMatch(/<(ol|blockquote|em)>|<li>\s*<ul>/);
    });
  });
});
