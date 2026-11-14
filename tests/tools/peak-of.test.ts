/**
 * @fileoverview The peak rule a timeline's summary reports: the point with the largest absolute
 * value, the first such point on a tie. Per-tool wiring is in each tool's own suite.
 * @module tests/tools/peak-of.test
 */

import { describe, expect, it } from 'vitest';
import { peakOf } from '@/mcp-server/tools/peak-of.js';

const point = (date: string, value: number) => ({ date, value });

describe('peakOf', () => {
  it.each<[string, Array<{ date: string; value: number }>, string | undefined]>([
    ['no points', [], undefined],
    ['one point', [point('2024-01-01', 0)], '2024-01-01'],
    [
      'the largest value',
      [point('2024-01-01', 1), point('2024-01-02', 3), point('2024-01-03', 2)],
      '2024-01-02',
    ],
    [
      'a negative value larger in magnitude than every positive one',
      [point('2024-01-01', 2.5), point('2024-01-02', -4), point('2024-01-03', 3.9)],
      '2024-01-02',
    ],
    [
      'the first of two equal values',
      [point('2024-01-01', 1), point('2024-01-02', 5), point('2024-01-03', 5)],
      '2024-01-02',
    ],
    [
      'the first of a value and its negation',
      [point('2024-01-01', -5), point('2024-01-02', 5)],
      '2024-01-01',
    ],
    [
      'the first point when every value is zero',
      [point('2024-01-01', 0), point('2024-01-02', 0)],
      '2024-01-01',
    ],
  ])('picks %s', (_label, points, date) => {
    expect(peakOf(points)?.date).toBe(date);
  });

  it('returns the point itself, other fields included', () => {
    const peak = { date: '2024-01-02', value: 7, norm: 90 };
    const points = [{ date: '2024-01-01', value: 1, norm: 80 }, peak];
    expect(peakOf(points)).toBe(peak);
  });
});
