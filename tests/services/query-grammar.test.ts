/**
 * @fileoverview Tests for GDELT's query grammar as the query tools read it (#101): which ORs
 * outside parentheses have one reading and the group they are written as, which have none, which
 * queries hold no such OR, and the cost of reading caller-sized text.
 * @module tests/services/query-grammar.test
 */

import { describe, expect, it } from 'vitest';
import { groupBareOr, type OrGrouping } from '@/services/gdelt/query-grammar.js';
import {
  type CostShape,
  expectLinearCost,
  fill,
  REGEX_SAFE_SIZES,
} from '../helpers/linear-cost.js';

describe('groupBareOr — terms joined by OR are one group', () => {
  it.each([
    ['two words', 'climate OR energy', '(climate OR energy)'],
    ['phrases', '"SOL" OR "sol" OR "bitcoin" OR "BTC"', '("SOL" OR "sol" OR "bitcoin" OR "BTC")'],
    ['a lowercase or', 'climate or energy', '(climate OR energy)'],
    ['mixed cases', 'climate Or energy oR storm', '(climate OR energy OR storm)'],
    ['an OR group and a word', '(flu OR cold) OR rsv', '(flu OR cold OR rsv)'],
    ['two OR groups', '(flu or cold) or (rsv OR "bird flu")', '(flu OR cold OR rsv OR "bird flu")'],
    ['groups of one element', '(climate) OR (energy)', '(climate OR energy)'],
    [
      'source filters',
      'domain:cnn.com OR DomainIs:bbc.co.uk',
      '(domain:cnn.com OR DomainIs:bbc.co.uk)',
    ],
    [
      'filters on different fields',
      'sourcelang:french or sourcecountry:FR',
      '(sourcelang:french OR sourcecountry:FR)',
    ],
    ['station filters', 'station:CNN OR station:MSNBC', '(station:CNN OR station:MSNBC)'],
    ['a theme and a word', 'climate OR theme:ENV_SOLAR', '(climate OR theme:ENV_SOLAR)'],
    ['a word holding a colon', 'domains:x OR climate', '(domains:x OR climate)'],
    ['an operator with a phrase', 'near20:"a b" OR flu', '(near20:"a b" OR flu)'],
    ['an excluded element', 'climate OR -energy', '(climate OR -energy)'],
    ['an excluded phrase', 'climate OR -"bird flu"', '(climate OR -"bird flu")'],
    ['a phrase against the OR', 'climate OR"energy"', '(climate OR "energy")'],
    ['groups against the OR', '(flu)OR(cold)', '(flu OR cold)'],
    [
      'a phrase holding or and parentheses',
      '"life or (death)" OR war',
      '("life or (death)" OR war)',
    ],
    ['CJK terms', '新冠病毒 OR 流感', '(新冠病毒 OR 流感)'],
    ['any whitespace', '\t climate \n OR  energy　', '(climate OR energy)'],
    ['a word that only contains or', 'major OR orbit', '(major OR orbit)'],
    ['words each in their own curly quotes', '“Trump” OR “Biden”', '(“Trump” OR “Biden”)'],
    ['words with apostrophes', "l’or OR l'argent", "(l’or OR l'argent)"],
  ])('%s', (_label, query, grouped) => {
    expect(groupBareOr(query)).toEqual({ kind: 'grouped', query: grouped });
    // What was sent has no OR left outside parentheses.
    expect(groupBareOr(grouped)).toEqual({ kind: 'none' });
  });

  it('keeps a phrase as written, inner spacing included', () => {
    expect(groupBareOr('"bird   flu" OR  "a\tb"')).toEqual({
      kind: 'grouped',
      query: '("bird   flu" OR "a\tb")',
    });
  });

  it('flattens a group holding more terms than a call takes arguments', () => {
    const terms = 'a OR '.repeat(1_200_000);
    expect(groupBareOr(`(${terms}b) OR c`).kind).toBe('grouped');
  });
});

describe('groupBareOr — an OR with no single reading', () => {
  it.each([
    ['a filter after the terms', 'climate OR energy sourcelang:english'],
    ['a filter before the terms', 'sourcelang:english climate OR energy'],
    ['a word joined to a language filter', 'prix or sourcelang:french'],
    ['a word joined to a country filter', 'climate OR SourceCountry:US'],
    ['a word joined to a domain filter', 'domain:bbc.co.uk OR climate'],
    ['a theme joined to an exact-domain filter', 'theme:ENV_SOLAR OR domainis:bbc.co.uk'],
    ['a word joined to an excluded filter', 'climate OR -domain:bbc.co.uk'],
    ['words joined to a station filter', 'climate OR energy OR station:CNN'],
    ['a word joined to a network filter', 'climate OR network:CBS'],
    ['a word joined to a show filter', 'climate OR show:"60 Minutes"'],
    ['a word joined to a market filter', 'climate OR market:"San Francisco"'],
    ['a group of filters joined to a word', '(domain:cnn.com OR domain:bbc.co.uk) OR climate'],
    ['two words before the OR', 'climate change OR energy'],
    ['two words after the OR', 'climate OR energy policy'],
    ['three words after the OR', 'climate OR energy policy change'],
    ['three words before the OR', 'global climate change OR energy'],
    ['a lowercase or among other words', 'war or peace talks'],
    ['a group among other elements', 'vaccine (flu OR cold) OR rsv'],
    ['a stray closing parenthesis', 'flu OR pandemic)'],
    ['a stray opening parenthesis', 'flu OR (pandemic'],
    ['an opening parenthesis after a chain', 'flu OR cold (pandemic'],
    ['two ORs together', 'climate OR OR energy'],
    ['an OR and an or together', 'climate OR or energy'],
    ['an OR that opens the query', 'OR climate'],
    ['an OR that closes the query', 'climate OR'],
    ['an OR alone', 'OR'],
    ['an OR that closes a chain', 'climate OR energy OR'],
    ['an or that closes a chain', 'argent OR or'],
    ['an unclosed quote', 'climate OR "energy'],
    ['an unclosed operator phrase', 'climate OR near20:"energy'],
    ['an excluded group', '-(flu OR cold) OR rsv'],
    ['a group of elements with no OR', '(flu cold) OR rsv'],
    ['a group of three elements with no OR', '(flu shot cold) OR rsv'],
    ['a nested group', '(flu OR (cold OR rsv)) OR covid'],
    ['an empty group', '() OR flu'],
    ['a group ending with OR', '(flu OR) OR cold'],
    ['a group opening with OR', '(OR flu) OR cold'],
    ['a group holding the word or as an element', '(argent OR or) OR france'],
    ['a phrase in curly quotes', '“life or death”'],
    ['a phrase in guillemets', '«vie or mort»'],
    ['a phrase in corner brackets', '「生 OR 死」'],
    ['a phrase in curly quotes inside a group', '(“life OR death”) OR war'],
  ])('%s', (_label, query) => {
    expect(groupBareOr(query)).toEqual({ kind: 'ambiguous' });
  });
});

describe('groupBareOr — no OR outside parentheses', () => {
  it.each([
    ['a word', 'climate'],
    ['words', 'climate change policy'],
    ['an OR group beside a filter', '(flu OR pandemic) sourcecountry:US'],
    ['an OR group alone', ' (flu OR pandemic) '],
    ['a lowercase or in a group', '(climate or energy)'],
    ['the word or as a group element', '(argent OR or) france'],
    ['a phrase holding or', '"life or death"'],
    ['an unclosed quote holding OR', '"climate OR energy'],
    ['an unclosed group holding OR', '(climate OR summit'],
    ['an OR after a group that never closes', '(flu OR (cold) OR rsv'],
    ['an OR after a quote that never closes, in a group', '(flu OR "cold) OR rsv'],
    ['a nested group holding OR', '(climate OR (summit OR flood))'],
    ['an excluded group', '-(flu OR influenza)'],
    ['an operator value', 'theme:OR_TEST'],
    ['an excluded OR', '-OR climate'],
    ['an operator named or', 'or:test climate'],
    ['OR with a phrase attached', 'OR:"x" climate'],
    ['a lowercase or that opens the query', 'or climate'],
    ['a lowercase or that closes the query', 'prix or'],
    ['a mixed-case or that closes the query', 'prix Or'],
    ['a lowercase or alone', 'or'],
    ['an elided word', "marché de l'or"],
    ['ORs in other scripts', 'ＯＲ climate ＯＲ'],
    ['the empty query', ''],
    ['whitespace', ' \t '],
  ])('%s', (_label, query) => {
    expect(groupBareOr(query)).toEqual({ kind: 'none' });
  });
});

/** `first` joined to copies of itself by `join`, exactly `n` characters, the last copy padded before `close`. */
function chain(first: string, join: string, n: number, close = ''): string {
  const text =
    first + `${join}${first}`.repeat(Math.floor((n - first.length) / (join.length + first.length)));
  return `${text.slice(0, text.length - close.length)}${'z'.repeat(n - text.length)}${close}`;
}

/** Each shape is read to its end; its kind is checked at every size, so none is timed on an early return. */
describe('groupBareOr — cost on caller-sized queries', () => {
  const SHAPES: Array<[kind: OrGrouping['kind'], shape: CostShape]> = [
    ['grouped', ['a chain of words', (n) => chain('ab', ' OR ', n)]],
    ['grouped', ['a chain of phrases', (n) => chain('"a b"', ' or ', n, '"')]],
    ['grouped', ['a chain of groups', (n) => chain('(a OR b)', ' OR ', n, ')')]],
    ['grouped', ['a chain with a break per term', (n) => chain('ab', ' OR\r\n', n)]],
    ['ambiguous', ['or words throughout', (n) => fill('or ', n)]],
    ['ambiguous', ['an OR before a long word', (n) => `a OR b ${'c'.repeat(n - 7)}`]],
    [
      'ambiguous',
      ['an OR, then one long line ending in a break', (n) => `a OR b ${fill('x y', n - 9)}\nz`],
    ],
    ['ambiguous', ['an OR after openers', (n) => `a OR ${'('.repeat(n - 5)}`]],
    ['ambiguous', ['an OR before closers', (n) => `a OR ${')'.repeat(n - 5)}`]],
    ['ambiguous', ['groups with no OR between', (n) => `a OR ${fill('(a) ', n - 5)}`]],
    ['none', ['nested openers', (n) => '('.repeat(n)]],
    ['none', ['one long word', (n) => 'a'.repeat(n)]],
    ['none', ['quotes throughout', (n) => fill('"" ', n)]],
    ['none', ['an unclosed quote', (n) => `"${fill('a OR ', n - 1)}`]],
    ['none', ['colons before a quote', (n) => fill('a:"', n)]],
    ['none', ['spaces', (n) => ' '.repeat(n)]],
    ['none', ['wide spaces', (n) => fill('\u3000a', n), REGEX_SAFE_SIZES]],
    ['none', ['one group of terms', (n) => `(${chain('ab', ' OR ', n - 2)})`]],
  ];

  it.each(SHAPES.map(([kind, shape]) => [shape[0], kind, shape] as const))(
    'stays linear on %s',
    (_name, kind, shape) => {
      const kinds = new Set<string>();
      expectLinearCost([shape], (value) => {
        kinds.add(groupBareOr(value).kind);
      });
      expect([...kinds]).toEqual([kind]);
    },
    0,
  );
});
