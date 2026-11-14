/**
 * @fileoverview Tests for the FIPS country table: the code a `sourcecountry:` value resolves to,
 * and the paste-ready operator a breakdown series' country name carries.
 * @module tests/services/countries.test
 */

import { describe, expect, it } from 'vitest';
import {
  docCountryName,
  resolveDocCountry,
  sourceCountryOperator,
} from '@/services/gkg-mirror/countries.js';
import { compileDocQuery } from '@/services/gkg-mirror/doc-query-compiler.js';

const LETTERS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];

/** Every FIPS code the table names, found by asking it about all 676 two-letter codes. */
const CODES = LETTERS.flatMap((a) => LETTERS.map((b) => a + b)).filter(
  (code) => docCountryName(code) !== undefined,
);

/** The FIPS code `operator` compiles to on the mirror, or undefined when it does not compile. */
function compiledFips(operator: string): string | undefined {
  const result = compileDocQuery(operator);
  if (!result.ok) return;
  const predicate = result.plan.clauses[0]?.anyOf[0];
  return predicate?.kind === 'sourcecountry' ? predicate.fips : undefined;
}

describe('resolveDocCountry', () => {
  it.each([
    ['serbia', 'RI'],
    ['equatorialguinea', 'EK'],
    ['guinea', 'GV'],
    ['bahamas,the', 'BF'],
    ['AU', 'AU'],
    ['United Kingdom', undefined],
  ])('resolves the sourcecountry: value %s to %s', (value, fips) => {
    expect(resolveDocCountry(value)).toBe(fips);
  });
});

describe('sourceCountryOperator', () => {
  it('reads a table of 275 codes under 274 display names', () => {
    expect(CODES).toHaveLength(275);
    expect(new Set(CODES.map(docCountryName)).size).toBe(274);
  });

  it('gives each display name with one code that code, compiling to it on the mirror', () => {
    const withoutOperator: string[] = [];
    for (const code of CODES) {
      const name = docCountryName(code) as string;
      const operator = sourceCountryOperator(name);
      if (operator === undefined) {
        withoutOperator.push(`${name} (${code})`);
        continue;
      }
      expect(operator).toBe(`sourcecountry:${code}`);
      expect(compiledFips(operator)).toBe(code);
    }
    expect(withoutOperator).toEqual(['Equatorial Guinea (EK)', 'Serbia (RB)', 'Serbia (RI)']);
  });

  it.each([
    ['Bahamas, The', 'BF'],
    ['Cote dIvoire', 'IV'],
    ['Cocos Keeling Islands', 'CK'],
    ['Czechoslovakia', 'LO'],
    ['Vietnam, Democratic Republic of', 'VM'],
  ])("gives DOC's lookup name %s the code %s", (name, fips) => {
    expect(sourceCountryOperator(name)).toBe(`sourcecountry:${fips}`);
    expect(compiledFips(`sourcecountry:${fips}`)).toBe(fips);
  });

  it.each([
    ['United Arab Emirates', 'sourcecountry:AE'],
    ['united arab emirates', 'sourcecountry:AE'],
    ['Guinea-Bissau', 'sourcecountry:PU'],
    ['Guinea', 'sourcecountry:GV'],
    // FIPS, not ISO 3166: AU is Austria, and Australia is AS.
    ['Austria', 'sourcecountry:AU'],
    ['Australia', 'sourcecountry:AS'],
    // Two codes: Serbia names RI and RB; Equatorial Guinea is EK's name and DOC's lookup name for GV.
    ['Serbia', undefined],
    ['Equatorial Guinea', undefined],
    // A code is not a name.
    ['GM', undefined],
    ['Atlantis', undefined],
    ['', undefined],
  ])('maps the name %j to %s', (name, operator) => {
    expect(sourceCountryOperator(name)).toBe(operator);
  });
});
