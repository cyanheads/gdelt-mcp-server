/**
 * @fileoverview The sum a `format()` summary line prints: the values' exact decimal sum, with the
 * floating-point accumulation error of adding them removed and no digit the values carry dropped.
 * Per-tool wiring is in the gdelt_search_tv and gdelt_get_coverage_breakdown suites.
 * @module tests/tools/sum-values.test
 */

import { describe, expect, it } from 'vitest';
import { sumValues } from '@/mcp-server/tools/sum-values.js';

describe('sumValues', () => {
  it.each<[string, number[], number]>([
    ['no values', [], 0],
    ['integer counts, as an integer', [125, 250, 1_000], 1375],
    ['0.1 + 0.2', [0.1, 0.2], 0.3],
    ['four-decimal shares', [0.2837, 0.1929, 0.1987], 0.6753],
    ['a value carrying eight decimals, keeping all eight', [0.2837, 0.19291234], 0.47661234],
    ['values of mixed sign', [1.1, -2.2, 3.3], 2.2],
    ['values in exponent form', [1e-8, 2e-8], 3e-8],
    ['a value in exponent form with a fraction', [1e-8, 1.1e-7], 1.2e-7],
    ['a large integer and a fraction', [1e21, 0.5], 1e21],
  ])('sums %s', (_label, values, expected) => {
    expect(sumValues(values)).toBe(expected);
  });

  /** Many four-decimal values accumulate error past the fourth decimal; the sum drops only that. */
  it('sums 186 four-decimal values to their exact decimal sum', () => {
    const values = Array.from({ length: 186 }, (_, i) => (20_000 + ((i * 7919) % 5000)) / 1e4);
    const exact = values.reduce((total, v) => total + Math.round(v * 1e4), 0) / 1e4;
    const naive = values.reduce((total, v) => total + v, 0);
    expect(naive).not.toBe(exact);
    expect(sumValues(values)).toBe(exact);
  });

  it('keeps the sum as added when a value carries more decimals than rounding can name', () => {
    expect(sumValues([5e-324, 5e-324])).toBe(1e-323);
  });
});
