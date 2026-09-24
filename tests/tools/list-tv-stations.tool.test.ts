/**
 * @fileoverview Tests for gdelt_list_tv_stations tool.
 * @module tests/tools/list-tv-stations.tool.test
 */

import { readFileSync } from 'node:fs';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gdeltListTvStations } from '@/mcp-server/tools/definitions/list-tv-stations.tool.js';
import * as tvServiceModule from '@/services/gdelt/gdelt-tv-service.js';
import type { TvStation } from '@/services/gdelt/types.js';
import { literalHtml, renderMarkdown } from './markdown-render.js';

const STATIONS = [
  {
    stationId: 'CNN',
    description: 'CNN',
    market: 'National',
    network: 'CNN',
    startDate: '2009-07-02',
    endDate: '2024-10-31',
    isActive: false,
  },
  {
    stationId: 'FOXNEWS',
    description: 'Fox News',
    market: 'National',
    network: 'Fox News',
    startDate: '2009-07-02',
    endDate: '2024-10-31',
    isActive: false,
  },
  {
    stationId: 'KNTV',
    description: 'NBC Bay Area',
    market: 'San Francisco',
    network: 'NBC',
    startDate: '2010-01-01',
    endDate: '2024-10-31',
    isActive: false,
  },
];

function station(
  stationId: string,
  market: string,
  network: string,
  overrides: Partial<TvStation> = {},
): TvStation {
  return {
    stationId,
    description: `${stationId} description`,
    market,
    network,
    startDate: '2010-01-01',
    endDate: '2024-10-10',
    isActive: false,
    ...overrides,
  };
}

/**
 * One station per market category the catalog carries: the three `National*` markets, the
 * two non-US markets, and US cities — delivered out of ID order so sorting stays exercised.
 */
const CATALOG: TvStation[] = [
  station('KGO', 'San Francisco', 'ABC'),
  station('WABC', 'New York', 'ABC'),
  station('KTVU', 'San Francisco', 'FOX'),
  station('FOXNEWS', 'National', 'FOXNEWS'),
  station('CNN', 'National', 'CNN', { isActive: true }),
  station('LINKTV', 'NationalSpecialty', 'LINKTV'),
  station('ALJAZAM', 'NationalDiscontinued', 'ALJAZAM'),
  station('BBCNEWS', 'International', 'BBC'),
  station('ALJAZ', 'International', 'ALJAZ'),
  station('NHK', 'Japan', 'NHK'),
];

function mockStations(stations: TvStation[]) {
  vi.spyOn(tvServiceModule, 'getGdeltTvService').mockReturnValue({
    listStations: vi.fn().mockResolvedValue(stations),
  } as unknown as tvServiceModule.GdeltTvService);
}

/** Wire-level call — schema, handler, enrichment, and format() exactly as a client gets them. */
function callWire(input: Record<string, unknown>) {
  return runToolContract(
    gdeltListTvStations,
    input as Parameters<typeof gdeltListTvStations.handler>[0],
  );
}

function textOf(result: Awaited<ReturnType<typeof callWire>>): string {
  return result.content.map((block) => (block as { text?: string }).text ?? '').join('\n');
}

function idsOf(result: Awaited<ReturnType<typeof callWire>>): string[] {
  const structured = result.structuredContent as { stations: Array<{ stationId: string }> };
  return structured.stations.map((s) => s.stationId);
}

describe('gdeltListTvStations', () => {
  beforeEach(() => {
    mockStations(STATIONS);
  });

  it('returns sorted station list with counts', async () => {
    const ctx = createMockContext({ errors: gdeltListTvStations.errors });
    const input = gdeltListTvStations.input.parse({});
    const result = await gdeltListTvStations.handler(input, ctx);
    expect(result.totalCount).toBe(3);
    expect(result.stations).toHaveLength(3);
    // Sorted by stationId: CNN, FOXNEWS, KNTV
    expect(result.stations[0]?.stationId).toBe('CNN');
    expect(result.stations[1]?.stationId).toBe('FOXNEWS');
    expect(result.stations[2]?.stationId).toBe('KNTV');
  });

  it('counts active stations correctly', async () => {
    const activeStation = { ...STATIONS[0]!, isActive: true };
    mockStations([activeStation, STATIONS[1]!, STATIONS[2]!]);

    const ctx = createMockContext({ errors: gdeltListTvStations.errors });
    const input = gdeltListTvStations.input.parse({});
    const result = await gdeltListTvStations.handler(input, ctx);
    expect(result.activeCount).toBe(1);
  });

  /**
   * Characterization: the no-argument call's structuredContent, byte for byte. Filters and the
   * enrichment block that carries their notice must leave this exact serialization untouched.
   */
  it('keeps the no-argument structuredContent byte-identical', async () => {
    const result = await callWire({});
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.structuredContent)).toBe(
      '{"stations":[' +
        '{"stationId":"CNN","description":"CNN","market":"National","network":"CNN","startDate":"2009-07-02","endDate":"2024-10-31","isActive":false},' +
        '{"stationId":"FOXNEWS","description":"Fox News","market":"National","network":"Fox News","startDate":"2009-07-02","endDate":"2024-10-31","isActive":false},' +
        '{"stationId":"KNTV","description":"NBC Bay Area","market":"San Francisco","network":"NBC","startDate":"2010-01-01","endDate":"2024-10-31","isActive":false}' +
        '],"activeCount":0,"totalCount":3}',
    );
  });

  it('formats output with startDate and endDate for national stations', () => {
    const output = {
      stations: STATIONS,
      activeCount: 0,
      totalCount: 3,
    };
    const blocks = gdeltListTvStations.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('CNN');
    expect(text).toContain('FOXNEWS');
    expect(text).toContain('KNTV');
    expect(text).toContain('2009-07-02');
    expect(text).toContain('2024-10-31');
    expect(text).toContain('National');
    expect(text).toContain('San Francisco');
    expect(text).toContain('3');
    expect(text).toContain('0');
  });

  it('shows active marker for active stations in format output', () => {
    const withActive = [{ ...STATIONS[0]!, isActive: true }, ...STATIONS.slice(1)];
    const output = { stations: withActive, activeCount: 1, totalCount: 3 };
    const blocks = gdeltListTvStations.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('✓ Active');
  });

  it('groups national and local stations in format output', () => {
    const output = { stations: STATIONS, activeCount: 0, totalCount: 3 };
    const blocks = gdeltListTvStations.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('National Networks');
    expect(text).toContain('Local/Regional Stations');
  });

  it('declares that it calls a live upstream endpoint', () => {
    expect(gdeltListTvStations.annotations?.openWorldHint).toBe(true);
  });

  it('tells callers the list can be filtered and what the counts cover', () => {
    expect(gdeltListTvStations.description).toMatch(/stations.*network.*market/s);
    const shape = gdeltListTvStations.output.shape;
    expect(shape.totalCount.description).toMatch(/returned/i);
    expect(shape.activeCount.description).toMatch(/returned/i);
  });
});

describe('gdeltListTvStations empty catalog', () => {
  it('fails as retryable gdelt_unavailable, not NotFound', async () => {
    mockStations([]);
    const result = await callWire({});
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: JsonRpcErrorCode.ServiceUnavailable,
          data: {
            reason: 'gdelt_unavailable',
            retryable: true,
            recovery: { hint: expect.stringMatching(/retry after a short delay/i) },
          },
        },
      },
    });
  });

  it('stays an upstream failure when filters were supplied too', async () => {
    mockStations([]);
    const result = await callWire({ network: 'ABC' });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { data: { reason: 'gdelt_unavailable' } } },
    });
  });

  it('no longer declares a no_stations contract entry', () => {
    expect(gdeltListTvStations.errors?.map((e) => e.reason)).not.toContain('no_stations');
  });
});

describe('gdeltListTvStations filters', () => {
  beforeEach(() => {
    mockStations(CATALOG);
  });

  it('narrows to the requested station IDs, case-insensitively and after trimming', async () => {
    const result = await callWire({ stations: ['cnn', ' foxnews '] });
    expect(result.isError).toBeFalsy();
    expect(idsOf(result)).toEqual(['CNN', 'FOXNEWS']);
    expect(result.structuredContent).toMatchObject({ totalCount: 2, activeCount: 1 });
    expect(result.structuredContent).not.toHaveProperty('notice');
  });

  it('matches network exactly — FOX does not pull in FOXNEWS', async () => {
    const result = await callWire({ network: 'fox' });
    expect(idsOf(result)).toEqual(['KTVU']);
  });

  it('matches market exactly — National does not pull in NationalSpecialty or NationalDiscontinued', async () => {
    const result = await callWire({ market: '  national ' });
    expect(idsOf(result)).toEqual(['CNN', 'FOXNEWS']);
  });

  it('combines filters with AND', async () => {
    const result = await callWire({ network: 'ABC', market: 'San Francisco' });
    expect(idsOf(result)).toEqual(['KGO']);
    expect(result.structuredContent).toMatchObject({ totalCount: 1, activeCount: 0 });
  });

  it('counts activeCount and totalCount over the returned stations only', async () => {
    const result = await callWire({ market: 'National' });
    expect(result.structuredContent).toMatchObject({ totalCount: 2, activeCount: 1 });
  });

  it('treats blank strings, an empty array, and blank entries as omitted', async () => {
    const unfiltered = await callWire({});
    const blanks = await callWire({ stations: ['', '   '], network: '  ', market: '' });
    expect(JSON.stringify(blanks.structuredContent)).toBe(
      JSON.stringify(unfiltered.structuredContent),
    );
    const emptyArray = await callWire({ stations: [] });
    expect(JSON.stringify(emptyArray.structuredContent)).toBe(
      JSON.stringify(unfiltered.structuredContent),
    );
  });

  it('ignores a blank entry alongside real IDs rather than reporting it unmatched', async () => {
    const result = await callWire({ stations: ['CNN', ' '] });
    expect(idsOf(result)).toEqual(['CNN']);
    expect(result.structuredContent).not.toHaveProperty('notice');
  });

  it('returns success with an empty list and a notice naming the filter when nothing matches', async () => {
    const result = await callWire({ network: 'Nope Network' });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      stations: [],
      totalCount: 0,
      activeCount: 0,
      notice: expect.stringContaining('network "Nope Network"'),
    });
    expect(textOf(result)).toContain('> No station matched');
  });

  it('names requested IDs that match no station while still returning the matched ones', async () => {
    const result = await callWire({ stations: ['CNN', 'XYZ1', 'xyz2'] });
    expect(idsOf(result)).toEqual(['CNN']);
    const notice = (result.structuredContent as { notice?: string }).notice ?? '';
    expect(notice).toContain('XYZ1');
    expect(notice).toContain('xyz2');
    expect(notice).not.toMatch(/No station matched/);
  });

  it('covers both an empty result and unmatched IDs in one notice', async () => {
    const result = await callWire({ stations: ['XYZ1'], market: 'Japan' });
    expect(result.structuredContent).toMatchObject({ stations: [], totalCount: 0 });
    const notice = (result.structuredContent as { notice?: string }).notice ?? '';
    expect(notice).toContain('No station matched');
    expect(notice).toContain('market "Japan"');
    expect(notice).toContain('XYZ1');
    // One trailer blockquote, not two competing notices.
    expect(textOf(result).match(/^> /gm)).toHaveLength(1);
  });

  it('names a real station ID another filter excluded', async () => {
    const result = await callWire({ stations: ['CNN', 'KGO'], network: 'ABC' });
    expect(idsOf(result)).toEqual(['KGO']);
    expect((result.structuredContent as { notice?: string }).notice).toMatch(/CNN/);
  });

  it('renders a filtered result through the same format as the full list', async () => {
    const result = await callWire({ network: 'ABC' });
    const text = textOf(result);
    expect(text).toContain('**Total:** 2 | **Active:** 0');
    expect(text).toContain('### Local/Regional Stations');
    expect(text).toContain('**KGO**');
    expect(text).toContain('**WABC**');
    expect(text).not.toContain('**CNN**');
  });

  it('renders a coherent body when a filter matches nothing', async () => {
    const result = await callWire({ market: 'Atlantis' });
    const text = textOf(result);
    expect(text).toContain('**Total:** 0 | **Active:** 0');
    expect(text).not.toContain('###');
  });
});

describe('gdeltListTvStations market grouping', () => {
  /** The lines rendered under one `###` heading, up to the next heading. */
  function section(text: string, heading: string): string {
    const start = text.indexOf(`### ${heading}`);
    expect(start).toBeGreaterThanOrEqual(0);
    const next = text.indexOf('\n### ', start + 4);
    return text.slice(start, next === -1 ? undefined : next);
  }

  function render(stations: TvStation[]): string {
    const sorted = stations.slice().sort((a, b) => a.stationId.localeCompare(b.stationId));
    const blocks = gdeltListTvStations.format!({
      stations: sorted,
      activeCount: sorted.filter((s) => s.isActive).length,
      totalCount: sorted.length,
    });
    return (blocks[0] as { text: string }).text;
  }

  it('groups every National* market under the national heading, each line naming its market', () => {
    const national = section(render(CATALOG), 'National Networks');
    expect(national).toContain('**CNN**');
    expect(national).toContain('**FOXNEWS**');
    expect(national).toMatch(/\*\*LINKTV\*\*.*Market: NationalSpecialty/);
    expect(national).toMatch(/\*\*ALJAZAM\*\*.*Market: NationalDiscontinued/);
    expect(national).toMatch(/\*\*CNN\*\*.*Market: National \|/);
  });

  it('groups International and Japan markets under an international heading', () => {
    const international = section(render(CATALOG), 'International Stations');
    expect(international).toMatch(/\*\*BBCNEWS\*\*.*Market: International/);
    expect(international).toMatch(/\*\*ALJAZ\*\*.*Market: International/);
    expect(international).toMatch(/\*\*NHK\*\*.*Market: Japan/);
  });

  it('keeps only US city markets under Local/Regional Stations', () => {
    const local = section(render(CATALOG), 'Local/Regional Stations');
    for (const id of ['KGO', 'KTVU', 'WABC']) expect(local).toContain(`**${id}**`);
    for (const id of ['BBCNEWS', 'ALJAZ', 'NHK', 'LINKTV', 'ALJAZAM', 'CNN']) {
      expect(local).not.toContain(`**${id}**`);
    }
  });

  it('omits a heading whose group is empty', () => {
    const text = render(CATALOG.filter((s) => s.market === 'Japan'));
    expect(text).toContain('### International Stations');
    expect(text).not.toContain('### National Networks');
    expect(text).not.toContain('### Local/Regional Stations');
  });
});

/**
 * Station metadata reaches content[] as literal text. The live 159-station catalog carries
 * only `-`, `.`, `(`, `)` beyond alphanumerics, so escaping must leave its rendering
 * byte-identical — the captured pre-escaping content[] is the regression fixture.
 */
describe('gdeltListTvStations Markdown escaping', () => {
  const catalog = JSON.parse(
    readFileSync(new URL('../fixtures/tv-station-catalog.json', import.meta.url), 'utf8'),
  ) as { stations: TvStation[]; activeCount: number; totalCount: number; content: string };

  it('renders the live station catalog byte-identically to the pre-escaping format()', async () => {
    mockStations(catalog.stations);
    const result = await callWire({});
    expect(result.structuredContent).toEqual({
      stations: catalog.stations,
      activeCount: catalog.activeCount,
      totalCount: catalog.totalCount,
    });
    expect(result.content).toEqual([{ type: 'text', text: catalog.content }]);
  });

  it('escapes every upstream field of a station line and leaves structuredContent raw', async () => {
    const hostile = station('K_GO_', 'San *Francisco*', 'A_B', {
      description: 'ABC <b>News</b> [7]',
      startDate: '2010-01-01',
      endDate: '2024-10-10 `x`',
    });
    mockStations([hostile]);
    const result = await callWire({});
    expect((result.structuredContent as { stations: unknown[] }).stations).toEqual([hostile]);
    expect(textOf(result)).toContain(
      String.raw`- **K_GO\_** — ABC \<b>News\</b> \[7\] | Market: San \*Francisco\* | A_B | ` +
        String.raw`2010-01-01–2024-10-10 \`x\` | Ended 2024-10-10 \`x\``,
    );

    const html = renderMarkdown(textOf(result));
    expect(html).toContain(`<strong>${literalHtml('K_GO_')}</strong>`);
    expect(html).toContain(literalHtml('ABC <b>News</b> [7] | Market: San *Francisco* | A_B'));
    expect(html).not.toMatch(/<(b|em|code)>/);
  });
});
