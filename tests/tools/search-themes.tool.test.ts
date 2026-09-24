/**
 * @fileoverview Tests for gdelt_search_themes at the wire: structuredContent, content[], the
 * declared error reasons, and paging — over the real theme service with only `fetch` stubbed to
 * serve an excerpt of GDELT's GKG theme lookup.
 * @module tests/tools/search-themes.tool.test
 */

import { readFileSync } from 'node:fs';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { gdeltSearchThemes } from '@/mcp-server/tools/definitions/search-themes.tool.js';
import { GKG_THEMES_URL, initGdeltThemeService } from '@/services/gdelt/gdelt-theme-service.js';

const EXCERPT = readFileSync(
  new URL('../fixtures/gkg-themes-excerpt.txt', import.meta.url),
  'utf8',
);

type Match = { theme: string; count: number; operator: string };
type Output = {
  matches: Match[];
  totalMatches: number;
  offset: number;
  limit: number;
  nextOffset?: number;
  totalCount: number;
  effectiveQuery: string;
  notice?: string;
};

let fetchSpy: MockInstance<typeof fetch>;

function callWire(input: Record<string, unknown>) {
  return runToolContract(
    gdeltSearchThemes,
    input as Parameters<typeof gdeltSearchThemes.handler>[0],
  );
}

function textOf(result: Awaited<ReturnType<typeof callWire>>): string {
  return result.content.map((block) => (block as { text?: string }).text ?? '').join('\n');
}

function structured(result: Awaited<ReturnType<typeof callWire>>): Output {
  return result.structuredContent as Output;
}

/** Serves the excerpt for the lookup URL only; any other request is an unmocked fetch. */
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    if (String(url) !== GKG_THEMES_URL) throw new Error('unmocked fetch');
    return new Response(EXCERPT, { status: 200 });
  });
  initGdeltThemeService(1000);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('gdelt_search_themes definition', () => {
  it('is read-only and open-world, with the pinned input bounds', () => {
    expect(gdeltSearchThemes.annotations).toMatchObject({
      readOnlyHint: true,
      openWorldHint: true,
    });
    expect(gdeltSearchThemes.input.parse({ query: 'x' })).toEqual({
      query: 'x',
      offset: 0,
      limit: 25,
    });
  });

  it.each([
    [{ query: 'x', limit: 0 }],
    [{ query: 'x', limit: 101 }],
    [{ query: 'x', offset: -1 }],
    [{}],
  ])('rejects out-of-bounds input %j as InvalidParams', async (input) => {
    const result = await callWire(input);
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { error: { code: JsonRpcErrorCode.InvalidParams } },
    });
  });

  it('accepts limit 1 and 100', async () => {
    for (const limit of [1, 100]) {
      const result = await callWire({ query: 'drought', limit });
      expect(result.isError).toBeFalsy();
      expect(structured(result).limit).toBe(limit);
    }
  });
});

describe('gdelt_search_themes success', () => {
  it('returns theme, count, and operator on both surfaces', async () => {
    const result = await callWire({ query: 'drought' });
    expect(result.isError).toBeFalsy();
    const out = structured(result);
    expect(out).toMatchObject({
      totalMatches: 5,
      offset: 0,
      limit: 25,
      totalCount: 5,
      effectiveQuery: 'drought',
    });
    expect(out).not.toHaveProperty('nextOffset');
    expect(out).not.toHaveProperty('notice');
    expect(out.matches[0]).toEqual({
      theme: 'NATURAL_DISASTER_DROUGHT',
      count: 3962460,
      operator: 'theme:NATURAL_DISASTER_DROUGHT',
    });
    const text = textOf(result);
    expect(text).toContain('**Matches 1–5 of 5**');
    expect(text).toContain('**Page:** offset 0, limit 25');
    expect(text).toContain(
      '1. NATURAL_DISASTER_DROUGHT — count 3,962,460 — `theme:NATURAL_DISASTER_DROUGHT`',
    );
    for (const m of out.matches) expect(text).toContain(`\`${m.operator}\``);
    expect(text).not.toContain('Next offset');
  });

  it.each([
    ['cyberattack', 'CYBER_ATTACK'],
    ['plant disease', 'TAX_PLANTDISEASE'],
    ['DISEASE_OUTBREAK', 'TAX_DISEASE_OUTBREAK'],
    ['theme:terror', 'TERROR'],
  ])('%s ranks %s first', async (query, theme) => {
    const out = structured(await callWire({ query }));
    expect(out.matches[0]?.theme).toBe(theme);
  });

  it('ranks the exact identifier DISPLACED above a higher-count match', async () => {
    const out = structured(await callWire({ query: 'displaced' }));
    expect(out.matches.map((m) => m.theme).slice(0, 2)).toEqual([
      'DISPLACED',
      'CRISISLEX_T09_DISPLACEDRELOCATEDEVACUATED',
    ]);
    expect(out.matches[1]?.count).toBeGreaterThan(out.matches[0]?.count ?? 0);
  });

  it('discloses the plural fallback: protests returns PROTEST with a notice', async () => {
    const result = await callWire({ query: 'protests' });
    const out = structured(result);
    expect(out.matches[0]?.theme).toBe('PROTEST');
    expect(out.totalMatches).toBe(10);
    expect(out.notice).toMatch(/No theme matched "protests" as given/);
    expect(out.notice).toMatch(/"protest"/);
    expect(out.notice).toMatch(/trailing "s"/);
    expect(textOf(result)).toContain('No theme matched "protests" as given');
  });

  it('answers a query matching nothing with an empty success and a retry notice', async () => {
    const result = await callWire({ query: 'zzqxv' });
    expect(result.isError).toBeFalsy();
    const out = structured(result);
    expect(out).toMatchObject({ matches: [], totalMatches: 0, offset: 0, limit: 25 });
    expect(out).not.toHaveProperty('nextOffset');
    expect(out.notice).toMatch(/gdelt_search_themes/);
    expect(out.notice).toMatch(/fewer words, a singular, or a shorter stem/);
    expect(out.notice).toMatch(/displac/);
    const text = textOf(result);
    expect(text).toContain('**Matches:** 0 of 0');
    expect(text).toContain('No GKG theme matched "zzqxv"');
  });

  it('names the singular form it also tried when a plural matches nothing', async () => {
    const out = structured(await callWire({ query: 'zzqxs' }));
    expect(out.totalMatches).toBe(0);
    expect(out.notice).toMatch(/No GKG theme matched "zzqxs" or "zzqx"/);
  });

  it('never turns an empty result into offset_out_of_range', async () => {
    const result = await callWire({ query: 'zzqxv', offset: 40 });
    expect(result.isError).toBeFalsy();
    expect(structured(result)).toMatchObject({ totalMatches: 0, offset: 40 });
  });
});

describe('gdelt_search_themes paging', () => {
  it('walks every page through nextOffset to exhaustion, then rejects the offset past the end', async () => {
    const all = structured(await callWire({ query: 'plant disease', limit: 100 }));
    expect(all.totalMatches).toBe(14);

    const walked: string[] = [];
    let offset: number | undefined = 0;
    let pages = 0;
    while (offset !== undefined) {
      const result = await callWire({ query: 'plant disease', limit: 5, offset });
      const out = structured(result);
      expect(out.totalMatches).toBe(14);
      expect(out.matches.length).toBeLessThanOrEqual(5);
      const text = textOf(result);
      expect(text).toContain(`**Matches ${offset + 1}–${offset + out.matches.length} of 14**`);
      if (out.nextOffset !== undefined)
        expect(text).toContain(`**Next offset:** ${out.nextOffset}`);
      expect(text).toContain(`${offset + 1}. ${out.matches[0]?.theme}`);
      walked.push(...out.matches.map((m) => m.theme));
      offset = out.nextOffset;
      pages++;
    }
    expect(pages).toBe(3);
    expect(walked).toEqual(all.matches.map((m) => m.theme));

    const past = await callWire({ query: 'plant disease', limit: 5, offset: 14 });
    expect(past).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: JsonRpcErrorCode.NotFound,
          data: {
            reason: 'offset_out_of_range',
            totalMatches: 14,
            recovery: { hint: expect.stringMatching(/offset 0–13/) },
          },
        },
      },
    });
    expect(textOf(past)).toContain('offset 0–13');
  });

  it('discloses a capped page with nextOffset and the full total', async () => {
    const out = structured(await callWire({ query: 'protest', limit: 3 }));
    expect(out).toMatchObject({ totalMatches: 10, limit: 3, nextOffset: 3, totalCount: 10 });
    expect(out.matches).toHaveLength(3);
  });

  it('returns the last match at offset totalMatches - 1', async () => {
    const out = structured(await callWire({ query: 'drought', offset: 4 }));
    expect(out.matches.map((m) => m.theme)).toEqual(['TAX_DISEASE_WORSTER_DROUGHT_SYNDROME']);
    expect(out).not.toHaveProperty('nextOffset');
  });
});

describe('gdelt_search_themes format()', () => {
  it('escapes the identifier as list-item text and keeps the operator verbatim in its code span', () => {
    const [block] = gdeltSearchThemes.format!({
      matches: [{ theme: '_LEAD_', count: 1234, operator: 'theme:_LEAD_' }],
      totalMatches: 1,
      offset: 0,
      limit: 25,
    });
    expect((block as { text: string }).text).toContain(
      '1. \\_LEAD\\_ — count 1,234 — `theme:_LEAD_`',
    );
  });
});

describe('gdelt_search_themes errors', () => {
  it.each(['', '   ', '___', 'theme:'])(
    'rejects %j as invalid_query without loading the lookup',
    async (query) => {
      const result = await callWire({ query });
      expect(result).toMatchObject({
        isError: true,
        structuredContent: {
          error: {
            code: JsonRpcErrorCode.ValidationError,
            data: {
              reason: 'invalid_query',
              recovery: { hint: expect.stringMatching(/gdelt_search_themes/) },
            },
          },
        },
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it('surfaces an unloadable lookup as retryable gdelt_unavailable on both surfaces', async () => {
    fetchSpy.mockImplementation(async () => new Response('', { status: 404 }));
    const result = await callWire({ query: 'drought' });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        error: {
          code: JsonRpcErrorCode.ServiceUnavailable,
          data: { reason: 'gdelt_unavailable', retryable: true },
        },
      },
    });
    const text = textOf(result);
    expect(text).toContain('Recovery: Retry after a short delay');
    expect(text).toContain('(reason gdelt_unavailable · retryable)');
  });
});
