/**
 * @fileoverview The sum a `format()` summary line prints over a series' values.
 * @module mcp-server/tools/sum-values
 */

/** Decimal places in `value`'s shortest round-trip form: `0.2837` → 4, `1.5e-7` → 8, `12` → 0. */
function decimalPlaces(value: number): number {
  const [mantissa = '', exponent = '0'] = String(value).split('e');
  const fraction = mantissa.split('.')[1]?.length ?? 0;
  return Math.max(0, fraction - Number(exponent));
}

/** The most places `toFixed` can round to; past it the sum is printed as added. */
const MAX_FIXED_PLACES = 100;

/**
 * The sum of `values`, rounded to the most decimal places any of them carries. Their exact decimal
 * sum has no more places than that, and the error of adding a page of them as doubles stays below
 * half a unit in the last one, so the rounding removes that error and nothing else: `0.1 + 0.2`
 * is `0.3`, `0.2837 + 0.19291234` is `0.47661234`, and integer counts stay integers. Values are
 * summed as given, never rounded themselves.
 */
export function sumValues(values: readonly number[]): number {
  let sum = 0;
  let places = 0;
  for (const value of values) {
    sum += value;
    places = Math.max(places, decimalPlaces(value));
  }
  return places <= MAX_FIXED_PLACES ? Number(sum.toFixed(places)) : sum;
}
