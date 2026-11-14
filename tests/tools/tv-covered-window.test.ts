/**
 * @fileoverview The UTC window a GDELT TV answer covers: the resolution GDELT picks for a window
 * it was not given `dateres` for, and the notice sentence naming the whole periods a widened
 * window's values cover. Boundaries are tabled here once; each TV tool's suite proves only its
 * wiring.
 * @module tests/tools/tv-covered-window.test
 */

import { describe, expect, it } from 'vitest';
import {
  defaultTvResolution,
  describeTvCoveredWindow,
  TV_PERIOD_NAMES,
} from '@/mcp-server/tools/tv-covered-window.js';
import type { TvDateResolution } from '@/services/gdelt/date-resolution.js';

const window = (startDatetime: string, endDatetime: string) => ({ startDatetime, endDatetime });

describe('describeTvCoveredWindow', () => {
  /**
   * Measured live: GDELT widens outward — the start floored to its period, the end through its
   * period's last second — in UTC, with weeks running Sunday through Saturday.
   */
  it.each<[string, TvDateResolution, string, string, string | undefined]>([
    [
      'both edges inside a clock hour',
      'hour',
      '20191218203000',
      '20191218223000',
      '2019-12-18T20:00:00Z – 2019-12-18T22:59:59Z',
    ],
    ['both edges on the hour', 'hour', '20191218200000', '20191218225959', undefined],
    [
      'an end exactly on the hour, whose whole hour is counted',
      'hour',
      '20191218200000',
      '20191218230000',
      '2019-12-18T20:00:00Z – 2019-12-18T23:59:59Z',
    ],
    [
      'only the start inside its hour',
      'hour',
      '20191218201500',
      '20191218225959',
      '2019-12-18T20:00:00Z – 2019-12-18T22:59:59Z',
    ],
    [
      'both edges inside a UTC day',
      'day',
      '20191215180000',
      '20200115060000',
      '2019-12-15T00:00:00Z – 2020-01-15T23:59:59Z',
    ],
    ['both edges on UTC day boundaries', 'day', '20191215000000', '20200115235959', undefined],
    [
      'only the end inside its day',
      'day',
      '20191215000000',
      '20200115060000',
      '2019-12-15T00:00:00Z – 2020-01-15T23:59:59Z',
    ],
    [
      'a Wednesday start and a Wednesday end',
      'week',
      '20191218000000',
      '20200115235959',
      '2019-12-15T00:00:00Z – 2020-01-18T23:59:59Z',
    ],
    ['a Sunday start and a Saturday end', 'week', '20191215000000', '20200118235959', undefined],
    [
      "a start on a Saturday's last second, a week from its Sunday",
      'week',
      '20191221235959',
      '20200118235959',
      '2019-12-15T00:00:00Z – 2020-01-18T23:59:59Z',
    ],
    [
      'a start at Sunday noon and an end at the next Sunday midnight',
      'week',
      '20191215120000',
      '20191222000000',
      '2019-12-15T00:00:00Z – 2019-12-28T23:59:59Z',
    ],
    [
      'both edges inside a month',
      'month',
      '20191215000000',
      '20200115235959',
      '2019-12-01T00:00:00Z – 2020-01-31T23:59:59Z',
    ],
    ['both edges on month boundaries', 'month', '20191201000000', '20200131235959', undefined],
    [
      'a leap-year February',
      'month',
      '20200210000000',
      '20200210120000',
      '2020-02-01T00:00:00Z – 2020-02-29T23:59:59Z',
    ],
    [
      'a December end, through the last second of the year',
      'month',
      '20191101000000',
      '20191215000000',
      '2019-11-01T00:00:00Z – 2019-12-31T23:59:59Z',
    ],
    [
      'both edges inside a year',
      'year',
      '20191215000000',
      '20200115235959',
      '2019-01-01T00:00:00Z – 2020-12-31T23:59:59Z',
    ],
    ['both edges on year boundaries', 'year', '20190101000000', '20201231235959', undefined],
  ])('%s (%s)', (_label, resolution, start, end, covered) => {
    const sentence = describeTvCoveredWindow('Values', window(start, end), resolution);
    expect(sentence).toBe(
      covered === undefined
        ? undefined
        : `Values cover whole ${TV_PERIOD_NAMES[resolution]}, ${covered}, wider than the requested ${start}–${end}.`,
    );
  });

  it('names the subject, the periods, the covered window, and the requested window', () => {
    expect(
      describeTvCoveredWindow('Values', window('20191215180000', '20200115060000'), 'day'),
    ).toBe(
      'Values cover whole UTC days, 2019-12-15T00:00:00Z – 2020-01-15T23:59:59Z, wider than the requested 20191215180000–20200115060000.',
    );
    expect(
      describeTvCoveredWindow('Ranking values', window('20191218000000', '20200115235959'), 'week'),
    ).toBe(
      'Ranking values cover whole UTC weeks (Sunday–Saturday), 2019-12-15T00:00:00Z – 2020-01-18T23:59:59Z, wider than the requested 20191218000000–20200115235959.',
    );
  });

  it("falls back to GDELT's window-length default when the answer reported no resolution", () => {
    expect(describeTvCoveredWindow('Values', window('20191218203000', '20191218223000'))).toBe(
      'Values cover whole clock hours, 2019-12-18T20:00:00Z – 2019-12-18T22:59:59Z, wider than the requested 20191218203000–20191218223000.',
    );
    expect(describeTvCoveredWindow('Values', window('20191215180000', '20200115060000'))).toBe(
      'Values cover whole UTC days, 2019-12-15T00:00:00Z – 2020-01-15T23:59:59Z, wider than the requested 20191215180000–20200115060000.',
    );
  });

  it.each<[string, Record<string, string>]>([
    ['a timespan', { timespan: '1m' }],
    ['no window', {}],
    ['only a start', { startDatetime: '20191215180000' }],
  ])('says nothing for %s, whose window GDELT resolves on its own clock', (_label, args) => {
    expect(describeTvCoveredWindow('Values', args, 'day')).toBeUndefined();
  });

  it('names every resolution’s periods', () => {
    expect(TV_PERIOD_NAMES).toEqual({
      hour: 'clock hours',
      day: 'UTC days',
      week: 'UTC weeks (Sunday–Saturday)',
      month: 'UTC months',
      year: 'UTC years',
    });
  });
});

/** Measured live on station charts, which report the resolution they ranked over. */
describe('defaultTvResolution', () => {
  it.each<[string, string, string, TvDateResolution]>([
    ['a 30-minute window', '20191218203000', '20191218210000', 'hour'],
    ['a second under 7 days', '20191215000000', '20191221235959', 'hour'],
    ['exactly 7 days', '20191215000000', '20191222000000', 'hour'],
    ['a second over 7 days', '20191215000000', '20191222000001', 'day'],
    ['31 days', '20191215180000', '20200115060000', 'day'],
    ['a second under 3 × 365 days', '20160101000000', '20181230235959', 'day'],
    ['exactly 3 × 365 days', '20160101000000', '20181231000000', 'month'],
    ['ten years', '20100101000000', '20191231235959', 'month'],
  ])('%s → %s', (_label, start, end, resolution) => {
    expect(defaultTvResolution(window(start, end))).toBe(resolution);
  });
});
