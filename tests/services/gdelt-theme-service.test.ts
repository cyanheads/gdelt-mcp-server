/**
 * @fileoverview Tests for the GKG theme lookup service: the one-time download and its failure
 * handling (through the real fetchWithTimeout, with only `fetch` stubbed), and the matcher and
 * ranking over an excerpt of real lookup lines.
 * @module tests/services/gdelt-theme-service.test
 */

import { readFileSync } from 'node:fs';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import {
  GdeltThemeService,
  GKG_THEMES_URL,
  themeQueryWords,
} from '@/services/gdelt/gdelt-theme-service.js';

const EXCERPT = readFileSync(
  new URL('../fixtures/gkg-themes-excerpt.txt', import.meta.url),
  'utf8',
);

let fetchSpy: MockInstance<typeof fetch>;

/** Answer every fetch with a fresh 200 carrying `body`. */
function serve(body: string) {
  fetchSpy.mockImplementation(async () => new Response(body, { status: 200 }));
}

function themesOf(result: { matches: readonly { theme: string }[] }): string[] {
  return result.matches.map((m) => m.theme);
}

/** The shape every load failure reaches the caller in. */
const UNAVAILABLE = {
  code: JsonRpcErrorCode.ServiceUnavailable,
  data: {
    reason: 'gdelt_unavailable',
    retryable: true,
    recovery: { hint: expect.stringMatching(/retry after a short delay/i) },
  },
};

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unmocked fetch'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('themeQueryWords', () => {
  it('lowercases, splits on non-alphanumerics, drops a leading theme:, and dedupes', () => {
    expect(themeQueryWords('Cyber-Attack  cyber')).toEqual(['cyber', 'attack']);
    expect(themeQueryWords('  theme:TAX_DISEASE_OUTBREAK')).toEqual(['tax', 'disease', 'outbreak']);
  });

  it('returns no words for a query without a letter or digit', () => {
    expect(themeQueryWords('')).toEqual([]);
    expect(themeQueryWords('   ')).toEqual([]);
    expect(themeQueryWords('___')).toEqual([]);
    expect(themeQueryWords('theme:')).toEqual([]);
  });
});

describe('GdeltThemeService loading', () => {
  it('fetches the https lookup once and serves later searches from the held index', async () => {
    serve(EXCERPT);
    const svc = new GdeltThemeService(1000);
    const ctx = createMockContext();
    await svc.search('drought', ctx);
    await svc.search('terror', ctx);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(GKG_THEMES_URL);
    expect(GKG_THEMES_URL.startsWith('https://data.gdeltproject.org/')).toBe(true);
  });

  it('shares one load between concurrent first calls', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fetchSpy.mockImplementation(async () => {
      await gate;
      return new Response(EXCERPT, { status: 200 });
    });
    const svc = new GdeltThemeService(1000);
    const pending = Promise.all([
      svc.search('drought', createMockContext()),
      svc.search('cyberattack', createMockContext()),
    ]);
    release();
    const [drought, cyber] = await pending;
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(themesOf(drought)[0]).toBe('NATURAL_DISASTER_DROUGHT');
    expect(themesOf(cyber)).toEqual(['CYBER_ATTACK']);
  });

  it('does not cache a failed load: the next call fetches again and succeeds', async () => {
    fetchSpy
      .mockImplementationOnce(async () => new Response('', { status: 404 }))
      .mockImplementationOnce(async () => new Response(EXCERPT, { status: 200 }));
    const svc = new GdeltThemeService(1000);
    await expect(svc.search('drought', createMockContext())).rejects.toMatchObject(UNAVAILABLE);
    const second = await svc.search('drought', createMockContext());
    expect(themesOf(second)).toContain('NATURAL_DISASTER_DROUGHT');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('fails every caller sharing a failed load, then refetches on the next call', async () => {
    fetchSpy
      .mockImplementationOnce(async () => new Response('', { status: 503 }))
      .mockImplementationOnce(async () => new Response(EXCERPT, { status: 200 }));
    const svc = new GdeltThemeService(1000);
    const results = await Promise.allSettled([
      svc.search('drought', createMockContext()),
      svc.search('terror', createMockContext()),
    ]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await expect(svc.search('terror', createMockContext())).resolves.toBeDefined();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('surfaces a 404 as gdelt_unavailable, never NotFound', async () => {
    fetchSpy.mockImplementation(async () => new Response('', { status: 404 }));
    const error = await new GdeltThemeService(1000)
      .search('drought', createMockContext())
      .catch((e: unknown) => e);
    expect(error).toMatchObject(UNAVAILABLE);
    expect(error).not.toMatchObject({ code: JsonRpcErrorCode.NotFound });
  });

  it.each([
    ['an HTML page', '<!DOCTYPE html><html><body>Service moved</body></html>'],
    ['a malformed line', `${EXCERPT}TERROR 123\n`],
    ['a line with no count', 'TERROR\t67837722\nPROTEST\n'],
    ['an empty body', ''],
  ])('surfaces %s as gdelt_unavailable', async (_label, body) => {
    serve(body);
    await expect(
      new GdeltThemeService(1000).search('drought', createMockContext()),
    ).rejects.toMatchObject(UNAVAILABLE);
  });

  it('names the malformed line', async () => {
    serve('TERROR\t67837722\nPROTEST 57786333\n');
    await expect(new GdeltThemeService(1000).search('terror', createMockContext())).rejects.toThrow(
      /line 2/,
    );
  });

  it('surfaces a network error as gdelt_unavailable', async () => {
    fetchSpy.mockRejectedValue(new TypeError('fetch failed'));
    await expect(
      new GdeltThemeService(1000).search('drought', createMockContext()),
    ).rejects.toMatchObject(UNAVAILABLE);
  });

  it('surfaces a timeout as gdelt_unavailable', async () => {
    fetchSpy.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    await expect(
      new GdeltThemeService(20).search('drought', createMockContext()),
    ).rejects.toMatchObject(UNAVAILABLE);
  });

  it('accepts CRLF line endings', async () => {
    serve(EXCERPT.replaceAll('\n', '\r\n'));
    const result = await new GdeltThemeService(1000).search('cyberattack', createMockContext());
    expect(themesOf(result)).toEqual(['CYBER_ATTACK']);
  });
});

describe('GdeltThemeService matching and ranking', () => {
  let svc: GdeltThemeService;

  beforeEach(() => {
    serve(EXCERPT);
    svc = new GdeltThemeService(1000);
  });

  const search = (query: string) => svc.search(query, createMockContext());

  it('matches a word against a token prefix: drought finds DROUGHT and DROUGHTS', async () => {
    const result = await search('drought');
    expect(themesOf(result)).toEqual([
      'NATURAL_DISASTER_DROUGHT',
      'NATURAL_DISASTER_DROUGHTS',
      'TAX_AIDGROUPS_PERMANENT_INTERSTATE_COMMITTEE_FOR_DROUGHT',
      'WB_1710_DROUGHT_RISK_REDUCTION',
      'TAX_DISEASE_WORSTER_DROUGHT_SYNDROME',
    ]);
    expect(result.singularWords).toBeUndefined();
  });

  it('matches one word across consecutive tokens: cyberattack finds CYBER_ATTACK', async () => {
    expect(themesOf(await search('cyberattack'))).toEqual(['CYBER_ATTACK']);
  });

  it('matches all the words joined: plant disease finds TAX_PLANTDISEASE first', async () => {
    const themes = themesOf(await search('plant disease'));
    expect(themes[0]).toBe('TAX_PLANTDISEASE');
    expect(themes.every((t) => t.startsWith('TAX_PLANTDISEASE'))).toBe(true);
    expect(themes).toHaveLength(14);
  });

  it('resolves the advertised DISEASE_OUTBREAK example to TAX_DISEASE_OUTBREAK', async () => {
    expect(themesOf(await search('DISEASE_OUTBREAK'))).toEqual(['TAX_DISEASE_OUTBREAK']);
    expect(themesOf(await search('theme:DISEASE_OUTBREAK'))).toEqual(['TAX_DISEASE_OUTBREAK']);
  });

  it('ranks an exact identifier above a higher-count match', async () => {
    const result = await search('displaced');
    expect(themesOf(result).slice(0, 2)).toEqual([
      'DISPLACED',
      'CRISISLEX_T09_DISPLACEDRELOCATEDEVACUATED',
    ]);
    expect(result.matches[1]?.count).toBeGreaterThan(result.matches[0]?.count ?? 0);
  });

  it('ranks by count descending, breaking ties by identifier regardless of file order', async () => {
    serve(EXCERPT.trimEnd().split('\n').reverse().join('\n'));
    const themes = themesOf(
      await new GdeltThemeService(1000).search('plant disease', createMockContext()),
    );
    expect(themes.slice(-4)).toEqual([
      'TAX_PLANTDISEASE_BASAL_STEM_ROT',
      'TAX_PLANTDISEASE_PHYTOPHTHORA_CROWN',
      'TAX_PLANTDISEASE_SEED_PIECE_DECAY',
      'TAX_PLANTDISEASE_STING_NEMATODE',
    ]);
  });

  it('requires every word to match', async () => {
    expect(themesOf(await search('wb water'))).toEqual(['WB_137_WATER']);
  });

  it('retries a zero-match plural once without its trailing s: protests finds PROTEST', async () => {
    const result = await search('protests');
    expect(result.singularWords).toEqual(['protest']);
    expect(themesOf(result)[0]).toBe('PROTEST');
    expect(result.matches).toHaveLength(10);
  });

  it('does not trim words shorter than four characters', async () => {
    const result = await search('gas');
    expect(result.matches).toEqual([]);
    expect(result.singularWords).toBeUndefined();
  });

  it('returns zero matches when neither the query nor its singular form matches', async () => {
    const plain = await search('zzqxv');
    expect(plain).toEqual({ matches: [] });
    const plural = await search('zzqxs');
    expect(plural).toEqual({ matches: [], singularWords: ['zzqx'] });
  });

  it('does not use the plural fallback when the query as given matches', async () => {
    const result = await search('refugees');
    expect(themesOf(result)).toEqual(['REFUGEES']);
    expect(result.singularWords).toBeUndefined();
  });
});
