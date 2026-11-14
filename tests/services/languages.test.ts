/**
 * @fileoverview Tests for the DOC language table: the paste-ready `sourcelang:` operator a
 * breakdown series' language name carries.
 * @module tests/services/languages.test
 */

import { describe, expect, it } from 'vitest';
import { compileDocQuery } from '@/services/gkg-mirror/doc-query-compiler.js';
import { docLanguageName, sourceLangOperator } from '@/services/gkg-mirror/languages.js';

const LETTERS = [...'abcdefghijklmnopqrstuvwxyz'];

/** Every stored code the table names, found by asking it about all 17,576 three-letter codes. */
const CODES = LETTERS.flatMap((a) => LETTERS.flatMap((b) => LETTERS.map((c) => a + b + c))).filter(
  (code) => docLanguageName(code) !== undefined,
);

/** The stored code `operator` compiles to on the mirror, or undefined when it does not compile. */
function compiledLanguage(operator: string): string | undefined {
  const result = compileDocQuery(operator);
  if (!result.ok) return;
  const predicate = result.plan.clauses[0]?.anyOf[0];
  return predicate?.kind === 'sourcelang' ? predicate.language : undefined;
}

describe('sourceLangOperator', () => {
  it('gives each of the 65 language names its lowercased name, compiling to its code', () => {
    expect(CODES).toHaveLength(65);
    for (const code of CODES) {
      const name = docLanguageName(code) as string;
      const operator = sourceLangOperator(name);
      expect(operator).toBe(`sourcelang:${name.toLowerCase()}`);
      expect(compiledLanguage(operator as string)).toBe(code);
    }
  });

  it.each([
    ['English', 'sourcelang:english'],
    ['FRENCH', 'sourcelang:french'],
    ['NorwegianNynorsk', 'sourcelang:norwegiannynorsk'],
    ['Norwegian Nynorsk', 'sourcelang:norwegiannynorsk'],
    // A code is not a name.
    ['fra', undefined],
    ['eng', undefined],
    ['xyz', undefined],
    ['Klingon', undefined],
    ['', undefined],
  ])('maps the name %j to %s', (name, operator) => {
    expect(sourceLangOperator(name)).toBe(operator);
  });
});
