/**
 * @fileoverview The shared non-blank `query` input: what it refuses and accepts, the pattern it
 * advertises, and its cost on caller-sized values.
 * @module tests/tools/query-input.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import { queryInputSchema } from '@/mcp-server/tools/query-input.js';
import { expectLinearCost, fill, REGEX_SAFE_SIZES } from '../helpers/linear-cost.js';

const schema = queryInputSchema('Search query.');

describe('queryInputSchema', () => {
  it.each(['', ' ', '\t', ' \n ', '\r\n', ' ', '   '])('refuses the blank query %j', (query) => {
    const result = schema.safeParse(query);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(
      'query must contain at least one non-whitespace character.',
    );
  });

  it.each(['a', ' bird flu ', '\t"x"\n', '-russia', '日本'])(
    'passes %j through unchanged',
    (query) => {
      expect(schema.parse(query)).toBe(query);
    },
  );

  it('advertises the rule as a JSON Schema pattern beside its description', () => {
    expect(z.toJSONSchema(schema)).toMatchObject({
      type: 'string',
      pattern: '\\S',
      description: 'Search query.',
    });
  });
});

/** Every blank shape scans to its end before failing; a non-blank one stops at its first character. */
describe('queryInputSchema — cost on caller-sized values', () => {
  it('stays linear in the query length', () => {
    expectLinearCost(
      [
        ['spaces with no other character', (n) => ' '.repeat(n), REGEX_SAFE_SIZES],
        ['one long line ending in a break', (n) => `${fill('§1 x', n - 2)}\ny`],
        ['breaks throughout', (n) => fill('  \r\n', n), REGEX_SAFE_SIZES],
        ['a long digit run', (n) => '1'.repeat(n)],
      ],
      (value) => {
        schema.safeParse(value);
      },
    );
  }, 0);
});
