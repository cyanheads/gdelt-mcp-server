/**
 * @fileoverview Tests for GDELT timeline date normalization, interval-based resolution
 * inference, the DOC resolution an answer reports, and the timesteps missing from a DOC answer.
 * @module tests/services/date-resolution.test
 */

import { describe, expect, it } from 'vitest';
import {
  findMissingTimesteps,
  inferDateResolution,
  normalizeGdeltDate,
  parseDocDateResolution,
} from '@/services/gdelt/date-resolution.js';

describe('normalizeGdeltDate', () => {
  it.each([
    ['20240101', '2024-01-01'],
    ['20240101T123456Z', '2024-01-01T12:34:56Z'],
    ['2024-01-01', '2024-01-01'],
    ['2024-01-01T12:34:56Z', '2024-01-01T12:34:56Z'],
  ])('normalizes %s without losing precision', (input, expected) => {
    expect(normalizeGdeltDate(input)).toBe(expected);
  });
});

describe('inferDateResolution', () => {
  it('returns "hour" for ISO datetime strings', () => {
    expect(inferDateResolution(['2024-01-01T00:00:00Z', '2024-01-01T01:00:00Z'])).toBe('hour');
  });

  it('returns "day" for date-only strings', () => {
    expect(inferDateResolution(['2024-01-01', '2024-01-02'])).toBe('day');
  });

  /**
   * Resolution is an interval, and fewer than two distinct usable timestamps have none — so
   * the answer is "undeterminable", never a guessed `'day'` that reads as a measured fact.
   */
  it.each([
    ['an empty array', []],
    ['a single timestamp', ['2024-01-01T00:00:00Z']],
    ['one timestamp repeated', ['2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z']],
    ['one usable timestamp beside malformed ones', ['2024-01-01', 'not-a-date']],
  ])('returns undefined for %s, for both APIs', (_label, dates) => {
    expect(inferDateResolution(dates)).toBeUndefined();
    expect(inferDateResolution(dates, 'tv')).toBeUndefined();
  });

  it('recognizes compact daily timestamps containing T', () => {
    expect(inferDateResolution(['20240101T000000Z', '20240102T000000Z'])).toBe('day');
  });

  it('recognizes hourly timestamps across a day boundary', () => {
    expect(inferDateResolution(['20240101T230000Z', '20240102T000000Z', '20240102T010000Z'])).toBe(
      'hour',
    );
  });

  it('uses the smallest positive interval across unsorted duplicate timestamps', () => {
    expect(
      inferDateResolution([
        '2024-01-03T00:00:00Z',
        '2024-01-01T00:00:00Z',
        '2024-01-01T01:00:00Z',
        '2024-01-01T01:00:00Z',
      ]),
    ).toBe('hour');
  });

  it('represents documented 15-minute DOC points', () => {
    expect(
      inferDateResolution(
        ['2024-01-01T00:00:00Z', '2024-01-01T00:15:00Z', '2024-01-01T00:30:00Z'],
        'doc',
      ),
    ).toBe('15min');
  });

  it.each([
    ['week', ['2024-01-01', '2024-01-08', '2024-01-15']],
    ['month', ['2024-01-01', '2024-02-01', '2024-03-01']],
    ['year', ['2022-01-01', '2023-01-01', '2024-01-01']],
  ] as const)('infers %s TV resolution when metadata is absent', (expected, dates) => {
    expect(inferDateResolution([...dates], 'tv')).toBe(expected);
  });

  it('returns "day" when first element has no T separator', () => {
    expect(inferDateResolution(['20240101', '20240102'])).toBe('day');
  });
});

describe('parseDocDateResolution', () => {
  it.each([
    ['hour', 'hour'],
    ['Hour', 'hour'],
    ['DAY', 'day'],
    ['day', 'day'],
    ['15m', '15min'],
    ['15M', '15min'],
    ['15min', '15min'],
    ['15 minutes', undefined],
    ['15', undefined],
    ['week', undefined],
    ['', undefined],
    ['constructor', undefined],
    ['__proto__', undefined],
    [undefined, undefined],
  ] as const)('reads %j as %j', (reported, expected) => {
    expect(parseDocDateResolution(reported)).toBe(expected);
  });
});

describe('findMissingTimesteps', () => {
  const HOUR = 3_600_000;
  /** `count` ISO instants `stepMs` apart from `start`. */
  const instants = (start: string, count: number, stepMs: number) =>
    Array.from({ length: count }, (_, k) =>
      new Date(Date.parse(start) + k * stepMs).toISOString().replace('.000Z', 'Z'),
    );
  /** The quokka answer's ten absent hours of 2026-09-01T00:00Z – 09-08T00:00Z, as DOC measured them. */
  const QUOKKA_ABSENT = new Set([
    '2026-09-02T18:00:00Z',
    '2026-09-03T17:00:00Z',
    '2026-09-03T18:00:00Z',
    '2026-09-03T19:00:00Z',
    '2026-09-03T20:00:00Z',
    '2026-09-03T21:00:00Z',
    '2026-09-04T11:00:00Z',
    '2026-09-05T22:00:00Z',
    '2026-09-06T04:00:00Z',
    '2026-09-06T23:00:00Z',
  ]);
  const QUOKKA_DATES = instants('2026-09-01T00:00:00Z', 169, HOUR).filter(
    (date) => !QUOKKA_ABSENT.has(date),
  );
  /** {@link QUOKKA_ABSENT} as runs, in date order. */
  const QUOKKA_RUNS = [
    { first: '2026-09-02T18:00:00Z', last: '2026-09-02T18:00:00Z', count: 1 },
    { first: '2026-09-03T17:00:00Z', last: '2026-09-03T21:00:00Z', count: 5 },
    { first: '2026-09-04T11:00:00Z', last: '2026-09-04T11:00:00Z', count: 1 },
    { first: '2026-09-05T22:00:00Z', last: '2026-09-05T22:00:00Z', count: 1 },
    { first: '2026-09-06T04:00:00Z', last: '2026-09-06T04:00:00Z', count: 1 },
    { first: '2026-09-06T23:00:00Z', last: '2026-09-06T23:00:00Z', count: 1 },
  ];

  it.each<[string, string[], Parameters<typeof findMissingTimesteps>[1]]>([
    ['no timesteps', [], 'hour'],
    ['one timestep', ['2026-09-01T00:00:00Z'], 'hour'],
    ['one timestep repeated', ['2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'], 'hour'],
    ['contiguous hours', instants('2026-09-01T00:00:00Z', 169, HOUR), 'hour'],
    ['contiguous 15-minute steps', instants('2026-09-07T00:00:00Z', 96, HOUR / 4), '15min'],
    ['contiguous ISO days', ['2024-02-28', '2024-02-29', '2024-03-01'], 'day'],
    [
      'contiguous compact days',
      ['20240228T000000Z', '20240229T000000Z', '20240301T000000Z'],
      'day',
    ],
    ['hours read at day resolution', ['2026-09-01T00:00:00Z', '2026-09-01T05:00:00Z'], 'day'],
    ['strings that are not ISO timesteps', ['0', '1', '400', 'not-a-date', '2026-09'], 'hour'],
    [
      'one ISO timestep beside strings Date.parse would still read',
      ['2026-09-01T00:00:00Z', '12', '2026-09-01 05:00'],
      'hour',
    ],
  ])('finds none in %s', (_label, dates, resolution) => {
    expect(findMissingTimesteps(dates, resolution)).toEqual([]);
  });

  it('names the quokka answer’s ten absent hours as six runs, in date order', () => {
    expect(findMissingTimesteps(QUOKKA_DATES, 'hour')).toEqual(QUOKKA_RUNS);
  });

  it('reads unsorted, duplicated, compact dates the same as sorted ISO ones', () => {
    const compact = QUOKKA_DATES.map((date) => date.replaceAll(/[-:]/g, ''));
    expect(findMissingTimesteps([...compact, ...compact].reverse(), 'hour')).toEqual(QUOKKA_RUNS);
  });

  /** Several series' timesteps are one set: a step any of them carries is no gap. */
  it('counts only the steps every series lacks', () => {
    const germany = ['2026-09-01T00:00:00Z', '2026-09-01T02:00:00Z', '2026-09-01T05:00:00Z'];
    const france = ['2026-09-01T00:00:00Z', '2026-09-01T01:00:00Z', '2026-09-01T05:00:00Z'];
    expect(findMissingTimesteps([...germany, ...france], 'hour')).toEqual([
      { first: '2026-09-01T03:00:00Z', last: '2026-09-01T04:00:00Z', count: 2 },
    ]);
  });

  /**
   * A resolution names the step without showing the series takes it: dates a week apart infer
   * `day`, and the resolution DOC reports is its label, not its spacing. With no two timesteps one
   * step apart, a series shows no gap at the resolution.
   */
  it.each<[string, string[], Parameters<typeof findMissingTimesteps>[1]]>([
    [
      'ISO days a week apart, as days',
      ['2024-01-01', '2024-01-08', '2024-01-15', '2024-01-22'],
      'day',
    ],
    ['ISO days a month apart, as days', ['2024-01-01', '2024-02-01', '2024-03-01'], 'day'],
    [
      'instants two hours apart, as hours',
      ['2026-09-01T00:00:00Z', '2026-09-01T02:00:00Z', '2026-09-01T04:00:00Z'],
      'hour',
    ],
    [
      'instants a day apart, as hours',
      ['2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z', '2026-09-03T00:00:00Z'],
      'hour',
    ],
    [
      'instants half an hour apart, as 15-minute steps',
      ['2026-09-07T00:00:00Z', '2026-09-07T00:30:00Z'],
      '15min',
    ],
    [
      'instants an hour apart, as 15-minute steps',
      instants('2026-09-07T00:00:00Z', 10, HOUR),
      '15min',
    ],
  ])('finds none in %s, with no two timesteps one step apart', (_label, dates, resolution) => {
    expect(findMissingTimesteps(dates, resolution)).toEqual([]);
  });

  it('counts once any two timesteps sit one step apart', () => {
    expect(findMissingTimesteps(['2024-01-09', '2024-01-01', '2024-01-02'], 'day')).toEqual([
      { first: '2024-01-03', last: '2024-01-08', count: 6 },
    ]);
  });

  it.each<[string, string[], Parameters<typeof findMissingTimesteps>[1], unknown]>([
    [
      'across a month end',
      ['2026-09-30T22:00:00Z', '2026-09-30T23:00:00Z', '2026-10-01T02:00:00Z'],
      'hour',
      { first: '2026-10-01T00:00:00Z', last: '2026-10-01T01:00:00Z', count: 2 },
    ],
    [
      'between 15-minute steps',
      ['2026-09-07T00:00:00Z', '2026-09-07T00:15:00Z', '2026-09-07T01:00:00Z'],
      '15min',
      { first: '2026-09-07T00:30:00Z', last: '2026-09-07T00:45:00Z', count: 2 },
    ],
    [
      'between ISO days, as days',
      ['2024-02-26', '2024-02-27', '2024-03-01'],
      'day',
      { first: '2024-02-28', last: '2024-02-29', count: 2 },
    ],
    [
      'between compact instants at day resolution, as instants',
      ['20240226T000000Z', '20240227T000000Z', '20240229T000000Z'],
      'day',
      { first: '2024-02-28T00:00:00Z', last: '2024-02-28T00:00:00Z', count: 1 },
    ],
    [
      'between timesteps off the step grid, one step on from the earlier',
      ['2026-08-31T23:00:00Z', '2026-09-01T00:00:00Z', '2026-09-01T02:30:00Z'],
      'hour',
      { first: '2026-09-01T01:00:00Z', last: '2026-09-01T02:00:00Z', count: 2 },
    ],
    [
      'between timesteps off the step grid, under half a step past the last one missed',
      ['2026-08-31T23:00:00Z', '2026-09-01T00:00:00Z', '2026-09-01T02:20:00Z'],
      'hour',
      { first: '2026-09-01T01:00:00Z', last: '2026-09-01T02:00:00Z', count: 2 },
    ],
    [
      'between two ISO timesteps with junk between them',
      ['2026-08-31T23:00:00Z', '2026-09-01T00:00:00Z', '7', 'n/a', '2026-09-01T03:00:00Z'],
      'hour',
      { first: '2026-09-01T01:00:00Z', last: '2026-09-01T02:00:00Z', count: 2 },
    ],
  ])('finds the run %s', (_label, dates, resolution, run) => {
    expect(findMissingTimesteps(dates, resolution)).toEqual([run]);
  });
});
