/**
 * @fileoverview Tests for the GKG mirror's DOC query compiler: the operator table, refusals that
 * name the element as written, the query length bound, the plan's `kinds` / `filterOnly` (DOC-free
 * routing reads them), FTS5 literal safety against a real store, and the scanner's linear cost.
 * @module tests/services/doc-query-compiler.test
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  compileDocQuery,
  ftsMatchText,
  MAX_PLAN_PREDICATES,
} from '@/services/gkg-mirror/doc-query-compiler.js';
import { GKG_ARTICLES_FTS } from '@/services/gkg-mirror/gkg-mirror-schema.js';
import type { MirrorQueryPlan } from '@/services/gkg-mirror/types.js';
import {
  type GkgMirrorFixture,
  gkgRow,
  openGkgMirrorFixture,
  seedGkgRows,
} from '../helpers/gkg-mirror-fixture.js';

function plan(query: string): MirrorQueryPlan {
  const result = compileDocQuery(query);
  if (!result.ok) throw new Error(`expected ${query} to compile: ${result.detail}`);
  return result.plan;
}

function refusal(query: string): { operator: string; detail: string } {
  const result = compileDocQuery(query);
  if (result.ok) throw new Error(`expected ${query} to be refused`);
  return { operator: result.operator, detail: result.detail };
}

describe('compileDocQuery — operator table', () => {
  it('compiles a word and a phrase as keyword predicates', () => {
    expect(plan('ukraine "bird flu"').clauses).toEqual([
      { anyOf: [{ kind: 'keyword', text: 'ukraine', phrase: false }], negated: false },
      { anyOf: [{ kind: 'keyword', text: 'bird flu', phrase: true }], negated: false },
    ]);
  });

  it('compiles an OR group into one clause and -x into a negated clause', () => {
    expect(plan('(flu OR "bird flu" OR theme:TAX_DISEASE) -domain:cnn.com').clauses).toEqual([
      {
        anyOf: [
          { kind: 'keyword', text: 'flu', phrase: false },
          { kind: 'keyword', text: 'bird flu', phrase: true },
          { kind: 'theme', theme: 'TAX_DISEASE' },
        ],
        negated: false,
      },
      { anyOf: [{ kind: 'domain', domain: 'cnn.com' }], negated: true },
    ]);
  });

  it('compiles -theme:X, (theme:A OR theme:B), and a negated phrase', () => {
    expect(plan('-theme:MANMADE_DISASTER').clauses).toEqual([
      { anyOf: [{ kind: 'theme', theme: 'MANMADE_DISASTER' }], negated: true },
    ]);
    expect(plan('(theme:TAX_FNCACT OR theme:EPU_ECONOMY)').clauses).toEqual([
      {
        anyOf: [
          { kind: 'theme', theme: 'TAX_FNCACT' },
          { kind: 'theme', theme: 'EPU_ECONOMY' },
        ],
        negated: false,
      },
    ]);
    expect(plan('-"climate change"').clauses).toEqual([
      { anyOf: [{ kind: 'keyword', text: 'climate change', phrase: true }], negated: true },
    ]);
  });

  it('upper-cases theme IDs and keeps hyphenated IDs whole', () => {
    expect(plan('theme:tax_fncact').clauses[0]?.anyOf).toEqual([
      { kind: 'theme', theme: 'TAX_FNCACT' },
    ]);
    expect(plan('theme:TAX_DISEASE_COVID-19').clauses[0]?.anyOf).toEqual([
      { kind: 'theme', theme: 'TAX_DISEASE_COVID-19' },
    ]);
  });

  it('compiles domain: and domainis: as distinct lowercase predicates', () => {
    expect(plan('domain:UN.org domainis:un.org').clauses.map((c) => c.anyOf[0])).toEqual([
      { kind: 'domain', domain: 'un.org' },
      { kind: 'domainis', domain: 'un.org' },
    ]);
  });

  it.each([
    ['sourcelang:spanish', 'spa'],
    ['sourcelang:spa', 'spa'],
    ['sourcelang:SPANISH', 'spa'],
    ['sourcelang:english', 'eng'],
    ['sourcelang:azerbaijani', 'axe'],
    ['sourcelang:norwegiannynorsk', 'nno'],
  ])('resolves %s to the stored code %s', (query, language) => {
    expect(plan(query).clauses[0]?.anyOf).toEqual([{ kind: 'sourcelang', language }]);
  });

  it.each([
    ['sourcecountry:unitedarabemirates', 'AE'],
    ['sourcecountry:AE', 'AE'],
    ['sourcecountry:ae', 'AE'],
    ['sourcecountry:UnitedKingdom', 'UK'],
    ['sourcecountry:germany', 'GM'],
    ['sourcecountry:cotedivoire', 'IV'],
    ['sourcecountry:ivorycoast', 'IV'],
    ['sourcecountry:guinea-bissau', 'PU'],
    ['sourcecountry:equatorialguinea', 'EK'],
    ['sourcecountry:guinea', 'GV'],
    ['sourcecountry:serbia', 'RI'],
    ['sourcecountry:RB', 'RB'],
  ])('resolves %s to FIPS %s', (query, fips) => {
    expect(plan(query).clauses[0]?.anyOf).toEqual([{ kind: 'sourcecountry', fips }]);
  });

  it.each([
    ['tone<-5', { absolute: false, comparison: '<', value: -5 }],
    ['tone>5', { absolute: false, comparison: '>', value: 5 }],
    ['toneabs<1', { absolute: true, comparison: '<', value: 1 }],
    ['toneabs>10.5', { absolute: true, comparison: '>', value: 10.5 }],
    ['TONE>+2.5', { absolute: false, comparison: '>', value: 2.5 }],
    ['tone<.5', { absolute: false, comparison: '<', value: 0.5 }],
  ])('compiles %s', (query, expected) => {
    expect(plan(query).clauses[0]?.anyOf).toEqual([{ kind: 'tone', ...expected }]);
  });

  it('matches operator names case-insensitively', () => {
    expect(plan('Theme:EPU_ECONOMY DOMAINIS:bbc.co.uk SourceLang:French').clauses).toEqual([
      { anyOf: [{ kind: 'theme', theme: 'EPU_ECONOMY' }], negated: false },
      { anyOf: [{ kind: 'domainis', domain: 'bbc.co.uk' }], negated: false },
      { anyOf: [{ kind: 'sourcelang', language: 'fra' }], negated: false },
    ]);
  });

  it('accepts a quoted operator value', () => {
    expect(plan('theme:"TAX_FNCACT" sourcelang:"german"').clauses.map((c) => c.anyOf[0])).toEqual([
      { kind: 'theme', theme: 'TAX_FNCACT' },
      { kind: 'sourcelang', language: 'deu' },
    ]);
  });

  it('treats line breaks and tabs as element separators', () => {
    expect(plan('theme:TAX_FNCACT\n\tsourcelang:spa\r\n').clauses).toHaveLength(2);
  });
});

describe('compileDocQuery — kinds and filterOnly', () => {
  it.each([
    ['ukraine', ['keyword'], false],
    ['"bird flu"', ['keyword'], false],
    ['theme:TAX_FNCACT', ['theme'], true],
    ['domain:cnn.com', ['domain'], true],
    ['domainis:un.org', ['domainis'], true],
    ['sourcelang:spanish', ['sourcelang'], true],
    ['sourcecountry:france', ['sourcecountry'], true],
    ['tone<-5', ['tone'], true],
    ['toneabs>10', ['tone'], true],
  ] as const)('%s → kinds %j, filterOnly %s', (query, kinds, filterOnly) => {
    const compiled = plan(query);
    expect(compiled.kinds).toEqual(kinds);
    expect(compiled.filterOnly).toBe(filterOnly);
  });

  it('collects every kind inside an OR group, in union order', () => {
    const compiled = plan('(sourcelang:spa OR theme:EPU_ECONOMY OR domain:elpais.com)');
    expect(compiled.kinds).toEqual(['theme', 'domain', 'sourcelang']);
    expect(compiled.filterOnly).toBe(true);
  });

  it('counts a keyword inside an OR group as not filter-only', () => {
    const compiled = plan('(theme:EPU_ECONOMY OR inflation)');
    expect(compiled.kinds).toEqual(['keyword', 'theme']);
    expect(compiled.filterOnly).toBe(false);
  });

  it('counts a negated keyword or phrase as not filter-only', () => {
    expect(plan('theme:EPU_ECONOMY -inflation').filterOnly).toBe(false);
    expect(plan('theme:EPU_ECONOMY -"interest rates"').filterOnly).toBe(false);
  });

  it('keeps a plan of negated filters filter-only', () => {
    const compiled = plan('-theme:EPU_ECONOMY -sourcelang:spanish -tone>5');
    expect(compiled.kinds).toEqual(['theme', 'sourcelang', 'tone']);
    expect(compiled.filterOnly).toBe(true);
  });

  it('reports each kind once however often it appears', () => {
    expect(plan('theme:A1 theme:B2 (theme:C3 OR theme:D4)').kinds).toEqual(['theme']);
  });
});

describe('compileDocQuery — refusals name the element as written', () => {
  it.each([
    ['near20:"a b"', 'near20:"a b"', /article text/],
    ['repeat3:"x"', 'repeat3:"x"', /article text/],
    ['imagetag:"fire"', 'imagetag:"fire"', /image annotations/],
    ['imagewebtag:"drone"', 'imagewebtag:"drone"', /image annotations/],
    ['imageocrmeta:"zika"', 'imageocrmeta:"zika"', /image annotations/],
    ['imagefacetone<-1.5', 'imagefacetone<-1.5', /image annotations/],
    ['imagenumfaces>3', 'imagenumfaces>3', /image annotations/],
    ['imagenumfaces=3', 'imagenumfaces=3', /image annotations/],
    ['imagewebcount<10', 'imagewebcount<10', /image annotations/],
    ['foo:bar', 'foo:bar', /not a GKG field/],
  ])('refuses %s', (query, operator, detail) => {
    const result = refusal(`theme:TAX_FNCACT ${query} ukraine`);
    expect(result.operator).toBe(operator);
    expect(result.detail).toMatch(detail);
  });

  it('keeps the exclusion sign in the named operator', () => {
    expect(refusal('ukraine -imagetag:"fire"').operator).toBe('-imagetag:"fire"');
  });

  it('refuses an uncompiled operator inside an OR group, naming only that element', () => {
    expect(refusal('(theme:A1 OR near5:"x y")').operator).toBe('near5:"x y"');
  });

  it('refuses a nested OR group, naming the outer group', () => {
    const result = refusal('ukraine (a1 OR (b1 OR c1)) russia');
    expect(result.operator).toBe('(a1 OR (b1 OR c1))');
    expect(result.detail).toMatch(/cannot be nested/);
  });

  it.each([
    ['ukraine "bird flu', '"bird flu', /never closed/],
    ['near20:"a b', 'near20:"a b', /never closed/],
    ['(flu OR pandemic', '(flu OR pandemic', /never closed/],
    ['flu OR pandemic)', 'OR', /only inside parentheses/],
    ['flu)', ')', /no opening/],
    ['()', '()', /empty or ends with OR/],
    ['(flu OR)', '(flu OR)', /empty or ends with OR/],
    ['(OR flu)', '(OR flu)', /between two elements/],
    ['(flu pandemic)', '(flu pandemic)', /separated by the capitalized word OR/],
    ['(flu or pandemic)', '(flu or pandemic)', /separated by the capitalized word OR/],
    ['-(flu OR pandemic)', '-(flu OR pandemic)', /cannot exclude an OR group/],
    ['(flu OR -pandemic)', '-pandemic', /inside an OR group/],
    ['--flu', '--flu', /single -/],
    ['flu - pandemic', '-', /followed by the element/],
    ['""', '""', /empty/],
    ['"  "', '"  "', /empty/],
    ['theme:', 'theme:', /no value/],
    ['x', 'x', /too short/],
    ['f-16', 'f-16', /hyphen/],
    ['...', '...', /no letter or digit/],
  ])('refuses malformed %j', (query, operator, detail) => {
    const result = refusal(query);
    expect(result.operator).toBe(operator);
    expect(result.detail).toMatch(detail);
  });

  it.each([
    ['theme:___', 'theme:___'],
    ['theme:TAX;DROP', 'theme:TAX;DROP'],
    ['domain:cnn,com', 'domain:cnn,com'],
    ['domain:cnn.com/news', 'domain:cnn.com/news'],
    ['sourcelang:klingon', 'sourcelang:klingon'],
    ['sourcelang:spa1', 'sourcelang:spa1'],
    ['sourcecountry:atlantis', 'sourcecountry:atlantis'],
    ['sourcecountry:ZZ', 'sourcecountry:ZZ'],
    ['sourcecountry:us1', 'sourcecountry:us1'],
    ['tone<', 'tone<'],
    ['tone=5', 'tone=5'],
    ['tone<=5', 'tone<=5'],
    ['tone>5>6', 'tone>5>6'],
    ['tone>1e3', 'tone>1e3'],
    ['toneabs<abc', 'toneabs<abc'],
  ])('refuses the invalid value in %j', (query, operator) => {
    expect(compileDocQuery(`ukraine ${query}`)).toMatchObject({ ok: false, operator });
  });

  it.each(['', '   ', '\n\t\r\n'])('refuses the empty query %j', (query) => {
    expect(compileDocQuery(query)).toEqual({
      ok: false,
      operator: '',
      detail: 'The query is empty.',
    });
  });

  it(`compiles ${MAX_PLAN_PREDICATES} elements and refuses the next one`, () => {
    const words = Array.from({ length: MAX_PLAN_PREDICATES + 1 }, (_, i) => `w${i}`);
    expect(compileDocQuery(words.slice(0, MAX_PLAN_PREDICATES).join(' ')).ok).toBe(true);
    const result = refusal(words.join(' '));
    expect(result.operator).toBe(`w${MAX_PLAN_PREDICATES}`);
    expect(result.detail).toMatch(/at most/);
  });

  it('counts OR-group members toward the element bound', () => {
    const members = Array.from({ length: MAX_PLAN_PREDICATES + 1 }, (_, i) => `w${i}`);
    expect(refusal(`(${members.join(' OR ')})`).operator).toBe(`w${MAX_PLAN_PREDICATES}`);
  });

  it('clips a long unclosed quote in the named operator', () => {
    const result = refusal(`"${'word '.repeat(190)}`);
    expect(result.operator).toHaveLength(121);
    expect(result.operator.startsWith('"word word')).toBe(true);
    expect(result.operator.endsWith('…')).toBe(true);
  });
});

describe('compileDocQuery — query length bound', () => {
  const TOO_LONG = {
    ok: false,
    operator: '',
    detail: 'The query is longer than the 1,000 characters the GKG mirror compiles.',
    hint: 'A query of up to 1,000 characters lets the local GKG mirror answer while GDELT refuses.',
  };

  it('compiles a query of exactly 1,000 characters', () => {
    expect(plan('a'.repeat(1_000)).clauses).toEqual([
      { anyOf: [{ kind: 'keyword', text: 'a'.repeat(1_000), phrase: false }], negated: false },
    ]);
    expect(plan(`"${'climate '.repeat(124)}summit"`).clauses).toHaveLength(1);
  });

  it.each([
    ['one word', 'a'.repeat(1_001)],
    ['one phrase', `"${'climate '.repeat(124)}summits"`],
    ['an OR group', `(${Array.from({ length: 90 }, (_, i) => `climate${i}`).join(' OR ')})`],
    ['an unclosed quote', `"${'climate '.repeat(126)}`],
    ['more elements than the plan holds', 'climate '.repeat(2_000)],
  ])('refuses %s over 1,000 characters with the bound, whatever its form', (_, query) => {
    expect(query.length).toBeGreaterThan(1_000);
    expect(compileDocQuery(query)).toEqual(TOO_LONG);
  });
});

describe('ftsMatchText', () => {
  it('renders keywords under the keyword columns and themes under themes', () => {
    expect(ftsMatchText({ kind: 'keyword', text: 'bird flu', phrase: true })).toBe(
      '{title persons organizations locations} : "bird flu"',
    );
    expect(ftsMatchText({ kind: 'theme', theme: 'TAX_FNCACT' })).toBe('themes : "TAX_FNCACT"');
  });

  it('doubles an inner quote so the literal cannot close early', () => {
    expect(ftsMatchText({ kind: 'keyword', text: 'a" OR themes : "x', phrase: true })).toBe(
      '{title persons organizations locations} : "a"" OR themes : ""x"',
    );
  });

  it('writes a NUL as a space, since FTS5 reads the expression only up to its first NUL', () => {
    expect(ftsMatchText({ kind: 'keyword', text: 'test\x00pay\x00\x00load', phrase: false })).toBe(
      '{title persons organizations locations} : "test pay  load"',
    );
  });
});

describe('FTS5 literal safety against a real store', () => {
  let fixture: GkgMirrorFixture;

  beforeAll(async () => {
    fixture = await openGkgMirrorFixture();
    await seedGkgRows(fixture.store, [
      gkgRow({
        url: 'u/near',
        date: '20261101110000',
        domain: 'a.com',
        title: 'Talks near the border',
      }),
      gkgRow({
        url: 'u/and-not',
        date: '20261101110000',
        domain: 'a.com',
        title: 'Bread and butter, not jam',
      }),
      gkgRow({ url: 'u/taxes', date: '20261101110000', domain: 'a.com', title: 'Taxes rise' }),
      gkgRow({ url: 'u/tax', date: '20261101110000', domain: 'a.com', title: 'Tax plan' }),
      gkgRow({
        url: 'u/caret',
        date: '20261101110000',
        domain: 'a.com',
        title: 'Plan for tax reform',
      }),
      gkgRow({
        url: 'u/quote',
        date: '20261101110000',
        domain: 'a.com',
        title: 'He said "go" today',
      }),
      gkgRow({
        url: 'u/theme-only',
        date: '20261101110000',
        domain: 'a.com',
        title: 'Budget vote',
        themes: 'TAX_FNCACT MANMADE_DISASTER_IMPLIED',
      }),
    ]);
  });

  afterAll(async () => {
    await fixture.cleanup();
  });

  function ftsUrls(match: string): string[] {
    return fixture.handle
      .prepare<{ url: string }>(
        `SELECT a.url FROM ${GKG_ARTICLES_FTS} f JOIN gkg_articles a ON a.rowid = f.rowid WHERE ${GKG_ARTICLES_FTS} MATCH ? ORDER BY a.url`,
      )
      .all(match)
      .map((row) => row.url);
  }

  /** URLs whose FTS row matches the compiled query's only predicate. */
  function matchUrls(query: string): string[] {
    const predicate = plan(query).clauses[0]?.anyOf[0];
    if (predicate?.kind !== 'keyword' && predicate?.kind !== 'theme') {
      throw new Error(`${query} did not compile to one FTS predicate`);
    }
    return ftsUrls(ftsMatchText(predicate));
  }

  it.each([
    ['NEAR', ['u/near']],
    ['"NEAR(talks border)"', []],
    ['AND', ['u/and-not']],
    ['NOT', ['u/and-not']],
    ['"bread AND jam"', []],
    ['"butter not jam"', ['u/and-not']],
    ['tax*', ['u/caret', 'u/tax']],
    ['^tax', ['u/caret', 'u/tax']],
    ['"title : budget"', []],
    ['"themes : TAX_FNCACT"', []],
    ['"{title} : plan"', []],
  ])('matches %s as literal text', (query, urls) => {
    expect(matchUrls(query)).toEqual(urls);
  });

  it('matches a keyword only against title and entity columns, never theme tokens', () => {
    expect(matchUrls('fncact')).toEqual([]);
    expect(matchUrls('tax_fncact')).toEqual([]);
  });

  it('matches a theme only as a whole token', () => {
    expect(matchUrls('theme:MANMADE_DISASTER')).toEqual([]);
    expect(matchUrls('theme:MANMADE_DISASTER_IMPLIED')).toEqual(['u/theme-only']);
    expect(matchUrls('theme:TAX')).toEqual([]);
  });

  it('keeps a quote-doubled literal from reaching FTS as syntax', () => {
    const injected = 'go" OR themes : "TAX_FNCACT';
    expect(ftsUrls(ftsMatchText({ kind: 'keyword', text: injected, phrase: true }))).toEqual([]);
  });

  /** The tokenizer splits stored text at a NUL as at any control character; a query does too. */
  it('reads a NUL in a word or phrase as a token separator', () => {
    expect(matchUrls('bread\x01and')).toEqual(['u/and-not']);
    expect(matchUrls('bread\x00and')).toEqual(['u/and-not']);
    expect(matchUrls('"butter\x00not jam"')).toEqual(['u/and-not']);
  });
});

/**
 * Compile cost on both runtimes: the length bound caps what the scanner reads, so a query over it
 * is refused at a cost independent of its length, and every shape up to it stays within a CPU cap.
 * Thread CPU (never wall clock), fastest of three samples per size, sizes spanning 64×, an absolute
 * cap checked at each size, and the parsed result asserted at every size.
 */
describe('compileDocQuery — bounded cost', () => {
  /** Element counts spanning 64×; the largest query of every shape stays under the length bound. */
  const SIZES = [2, 8, 32, 128];
  /** Compiles per CPU sample, so the smallest query costs more than the clock's resolution. */
  const REPEAT = 200;
  const CAP_US = 50_000;

  function cpuMicros(run: () => void, repeat = REPEAT): number {
    let fastest = Number.POSITIVE_INFINITY;
    for (let sample = 0; sample < 3; sample += 1) {
      const start = process.threadCpuUsage();
      for (let i = 0; i < repeat; i += 1) run();
      const used = process.threadCpuUsage(start);
      fastest = Math.min(fastest, used.user + used.system);
    }
    return fastest;
  }

  /** A plan of `units` elements compiles; one over the predicate bound is refused at that element. */
  const elementsCheck = (operator: string) => (query: string, units: number) =>
    expect(compileDocQuery(query)).toMatchObject(
      units > MAX_PLAN_PREDICATES ? { ok: false, operator } : { ok: true },
    );

  const shapes: Array<{
    name: string;
    build: (units: number, separator: string) => string;
    check: (query: string, units: number) => void;
  }> = [
    {
      name: 'many words',
      build: (units, sep) => `${'alpha'.concat(sep).repeat(units)}\n`,
      check: elementsCheck('alpha'),
    },
    {
      name: 'an unclosed quote',
      build: (units, sep) => `"${'alpha'.concat(sep).repeat(units)}\n`,
      check: (query) =>
        expect(compileDocQuery(query)).toMatchObject({
          ok: false,
          detail: 'The quote is never closed.',
        }),
    },
    {
      name: 'many quoted phrases',
      build: (units, sep) => `${'"a b"'.concat(sep).repeat(units)}\n`,
      check: elementsCheck('"a b"'),
    },
    {
      name: 'one long word',
      build: (units) => `${'abcde'.repeat(units)}\n`,
      check: (query, units) => {
        const result = compileDocQuery(query);
        expect(result.ok && result.plan.clauses[0]?.anyOf[0]).toMatchObject({
          kind: 'keyword',
          text: 'abcde'.repeat(units),
        });
      },
    },
    {
      name: 'nested parentheses',
      build: (units, sep) => `${'(a1'.concat(sep, 'OR', sep).repeat(units)}\n`,
      check: (query) =>
        expect(compileDocQuery(query)).toMatchObject({
          ok: false,
          detail: 'OR groups cannot be nested.',
        }),
    },
  ];

  for (const shape of shapes) {
    for (const [layout, separator] of [
      ['one long line ending in a break', ' '],
      ['breaks throughout', '\n'],
    ] as const) {
      it(`stays within the CPU cap for ${shape.name} up to the length bound (${layout})`, () => {
        const costs: number[] = [];
        for (const units of SIZES) {
          const query = shape.build(units, separator);
          expect(query.length).toBeLessThanOrEqual(1_000);
          shape.check(query, units);
          const cost = cpuMicros(() => compileDocQuery(query));
          expect(cost).toBeLessThan(CAP_US);
          costs.push(cost);
        }
        expect(Math.max(costs.at(-1) ?? 0, 1) / Math.max(costs[0] ?? 0, 1)).toBeLessThan(256);
      });
    }
  }

  for (const [layout, separator] of [
    ['one long line ending in a break', ' '],
    ['breaks throughout', '\n'],
  ] as const) {
    it(`refuses a query over the length bound without reading it (${layout})`, () => {
      // 2,000 refusals per sample; reading the query before the bound check exceeds the cap.
      const cap = 20_000;
      const costs: number[] = [];
      for (const units of [200, 800, 3_200, 12_800]) {
        const query = `${'alpha'.concat(separator).repeat(units)}\n`;
        expect(compileDocQuery(query)).toMatchObject({ ok: false, operator: '' });
        const cost = cpuMicros(() => compileDocQuery(query), 2_000);
        expect(cost).toBeLessThan(cap);
        costs.push(cost);
      }
      expect(Math.max(costs.at(-1) ?? 0, 1) / Math.max(costs[0] ?? 0, 1)).toBeLessThan(256);
    });
  }
});
