/**
 * @fileoverview Tests for gdelt_get_coverage_breakdown tool.
 * @module tests/tools/get-coverage-breakdown.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
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
    expect(result.topSeries?.[0]?.label).toBe('United States');
    expect(result.topSeries?.[1]?.label).toBe('China');
  });

  it('names the series beyond the top 10 without summing them when more than 10 series', async () => {
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
      topSeries: SERIES,
    };
    const blocks = gdeltGetCoverageBreakdown.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('United States');
    expect(text).toContain('China');
    // Peak data point for US is 5.0
    expect(text).toContain('5.000');
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

    it('returns only selectedSeries for a selection, without the ranked overview (#54)', async () => {
      const ctx = createMockContext({ errors: gdeltGetCoverageBreakdown.errors });
      const input = gdeltGetCoverageBreakdown.input.parse({
        query: 'global',
        breakdownBy: 'country',
        series: ['Country10'],
      });
      const result = await gdeltGetCoverageBreakdown.handler(input, ctx);
      expect(result).toEqual({ dateResolution: 'day', selectedSeries: [MANY_SERIES[10]] });
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
        otherSeriesLabels: ['Portugal', 'Viet Nam'],
        selectedSeries: [{ label: 'Portugal', data: [{ date: '2024-01-15', value: 0.1 }] }],
      });
      expect((blocks[0] as { text: string }).text).toBe(
        '## GDELT Coverage Breakdown\n**Date Resolution:** day\n**Values:** normalized — each ' +
          "value is the topic's share of that source's media output, not an article count. Small " +
          'media markets with concentrated coverage rank above large markets with diverse output.\n\n' +
          '### United States (sum of values: 2.00)\nData points: 1\nPeak: 2.000 at 2024-01-15\n' +
          '- 2024-01-15: 2.000\n\n### Series beyond the top 10 (2)\nRanked by sum of values. ' +
          'Re-call with series: ["<label>"] to get any of them in full.\n- Portugal\n- Viet Nam\n\n' +
          '## Selected Series (1)\nComplete series for the labels requested via the series input.\n\n' +
          '### Portugal (sum of values: 0.10)\nData points: 1\nPeak: 0.100 at 2024-01-15\n- 2024-01-15: 0.100',
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
      expect(text).toContain(String.raw`### United \*States\* (sum of values: 20.00)`);
      expect(text).toContain(
        ['- 1\\. Rank', '- \\> quoted', '- \\- dash', '- \\[Portugal\\]'].join('\n'),
      );
      expect((selection.content[0] as { text: string }).text).toContain(
        String.raw`### \[Portugal\] (sum of values: 1.00)`,
      );

      const html = renderMarkdown(contentText(overview));
      expect(html).toContain(`<h3>${literalHtml('United *States*')} (sum of values: 20.00)</h3>`);
      for (const label of sc.otherSeriesLabels) {
        expect(html).toContain(`<li>${literalHtml(label)}</li>`);
      }
      expect(html).not.toMatch(/<(ol|blockquote|em)>|<li>\s*<ul>/);
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
      expect(text).toContain('### Country A (sum of values: 60.00)');
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
        TWELVE[11],
      ]);
    });
  });

  /**
   * #54: both surfaces are bounded by the shared per-surface byte budget. The fixture sits at
   * 200 country series of 288 15-minute points. The overview pages topSeries in rank order with
   * otherSeriesLabels on every page; a series selection pages selectedSeries alone.
   */
  describe('response budget (#54)', () => {
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
        const bytes = surfaceBytes(result);
        expect(bytes.structured).toBeLessThanOrEqual(50_000);
        expect(bytes.text).toBeLessThanOrEqual(50_000);
        const sc = out(result);
        if (sc.nextOffset !== undefined) {
          expect(contentText(result)).toContain(`**Next offset:** ${sc.nextOffset}`);
        }
        pages.push(sc);
        offset = sc.nextOffset;
      }
      return { pages, labels: pages.flatMap((p) => (p[field] ?? []).map((s) => s.label)) };
    }

    beforeEach(() => mockBreakdown(BIG));

    it('pages the overview in rank order, with otherSeriesLabels on every page', async () => {
      const { pages, labels } = await walk({}, 'topSeries');
      expect(pages.length).toBeGreaterThan(1);
      expect(labels).toEqual(RANKED.slice(0, 10));
      for (const page of pages) {
        expect(page.otherSeriesLabels).toEqual(FOLDED);
        expect(page.totalCount).toBe(200);
        expect(page.dateResolution).toBe('15min');
        expect(page).not.toHaveProperty('selectedSeries');
      }
      expect(pages[0]!.notice).toMatch(
        /^Returned series 1–\d+ of 10 series; series \d+ would push/,
      );
      expect(pages.at(-1)!.notice).toMatch(/of 10 series — the last page\.$/);
    });

    it('returns every series and point unchanged across the overview pages', async () => {
      const { pages } = await walk({}, 'topSeries');
      expect(pages.flatMap((p) => p.topSeries ?? [])).toEqual(BIG.slice(0, 10));
    });

    // 64 full tool calls over a 200 × 288 fixture: about 1 s alone, several times that under
    // full-suite load, so the timeout is sized to the walk rather than the 5 s default.
    it('pages a selection of all 190 folded labels as selectedSeries alone, in requested order', {
      timeout: 30_000,
    }, async () => {
      const { pages, labels } = await walk({ series: FOLDED }, 'selectedSeries');
      expect(labels).toEqual(FOLDED);
      for (const page of pages) {
        expect(page).not.toHaveProperty('topSeries');
        expect(page).not.toHaveProperty('otherSeriesLabels');
        expect(page.totalCount).toBe(200);
      }
    });

    it('charges otherSeriesLabels before any series, still emitting one series', async () => {
      const longLabels = Array.from({ length: 200 }, (_, s) => ({
        ...BIG[s]!,
        label: `${'L'.repeat(400)} ${s}`,
      }));
      mockBreakdown(longLabels);
      const result = await call({});
      const sc = out(result);
      expect(sc.topSeries).toHaveLength(1);
      expect(sc.nextOffset).toBe(1);
      expect(sc.otherSeriesLabels).toHaveLength(190);
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
      const overview = await call({ offset: 10 });
      expect(overview).toMatchObject({
        isError: true,
        structuredContent: {
          error: {
            code: JsonRpcErrorCode.NotFound,
            data: { reason: 'offset_out_of_range', offset: 10, totalSeries: 10 },
          },
        },
      });
      expect(contentText(overview)).toContain('offset 0–9');
      const selection = await call({ series: FOLDED.slice(0, 2), offset: 2 });
      expect(contentText(selection)).toContain('offset 0–1');
    });

    it('ignores offset on an empty breakdown', async () => {
      mockBreakdown([]);
      const result = await call({ offset: 3 });
      expect(result.isError).toBeFalsy();
      expect(out(result)).toMatchObject({ topSeries: [], totalCount: 0 });
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
