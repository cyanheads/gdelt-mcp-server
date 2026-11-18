/**
 * @fileoverview Tests for the shared GDELT date-range helpers — window resolution and the
 * overflow partition. The partition's boundary handling is load-bearing and easy to get
 * subtly wrong, so it is pinned directly rather than only through the tools that call it.
 * @module tests/tools/date-range.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  articleSearchTimespan,
  DOC_SHORT_WINDOW_HINT,
  describeDateRangeFault,
  describeResolvedTimespan,
  describeShortDocWindow,
  describeTvTimespanFault,
  isUnpairedDateRange,
  isWithinWindow,
  parseRecordTimestamp,
  planTvWindowContinuation,
  planWindowContinuation,
  refineDocTimespan,
  resolveEffectiveWindow,
  splitWindow,
  toGdeltDatetime,
  tvAnalyticsWindow,
  tvRequestWindow,
} from '@/mcp-server/tools/date-range.js';
import { defaultTvResolution } from '@/mcp-server/tools/tv-covered-window.js';
import { expectLinearCost, fill, REGEX_SAFE_SIZES } from '../helpers/linear-cost.js';

/** Seconds covered by a window, per GDELT's documented exclusive boundaries. */
function coveredSeconds({
  startDatetime,
  endDatetime,
}: {
  startDatetime: string;
  endDatetime: string;
}): number[] {
  const toEpoch = (v: string) =>
    Date.parse(
      `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T${v.slice(8, 10)}:${v.slice(10, 12)}:${v.slice(12, 14)}Z`,
    ) / 1000;
  const seconds: number[] = [];
  for (let s = toEpoch(startDatetime) + 1; s < toEpoch(endDatetime); s++) seconds.push(s);
  return seconds;
}

describe('isUnpairedDateRange', () => {
  it('is true for exactly one boundary and false for both or neither', () => {
    expect(isUnpairedDateRange('20240101000000', undefined)).toBe(true);
    expect(isUnpairedDateRange(undefined, '20240101000000')).toBe(true);
    expect(isUnpairedDateRange('20240101000000', '20240102000000')).toBe(false);
    expect(isUnpairedDateRange(undefined, undefined)).toBe(false);
  });
});

describe('describeDateRangeFault', () => {
  it('passes a usable window and a call that pinned no window at all', () => {
    expect(describeDateRangeFault('20240101000000', '20240131235959')).toBeUndefined();
    expect(describeDateRangeFault(undefined, undefined)).toBeUndefined();
  });

  it('names the pairing rule for a lone boundary', () => {
    expect(describeDateRangeFault('20240101000000', undefined)).toMatch(/supplied together/);
    expect(describeDateRangeFault(undefined, '20240131235959')).toMatch(/supplied together/);
  });

  /**
   * The two rollover cases are the reason this cannot be an Invalid-Date test: both produce a
   * valid instant one step past what the caller wrote, which is exactly the silent window shift
   * the check exists to stop. Leap-day handling has to survive alongside them.
   */
  it.each([
    ['month 13', '20241301000000'],
    ['month 00', '20240001000000'],
    ['day 32', '20240132000000'],
    ['day 00', '20240100000000'],
    ['hour 24', '20240101240000'],
    ['minute 60', '20240101006000'],
    ['second 60', '20240101000060'],
    ['Feb 29 of a non-leap year', '20230229000000'],
    ['Feb 30 of a leap year', '20240230000000'],
    ['April 31', '20240431000000'],
    ['a two-digit year Date.UTC would map into the 1900s', '00240101000000'],
  ])('rejects a startDatetime of %s', (_label, startDatetime) => {
    expect(describeDateRangeFault(startDatetime, '20250101000000')).toMatch(
      /startDatetime .* is not a real UTC calendar timestamp/,
    );
  });

  it('checks the end boundary as well as the start', () => {
    expect(describeDateRangeFault('20240101000000', '20240230000000')).toMatch(
      /endDatetime .* is not a real UTC calendar timestamp/,
    );
  });

  it.each([
    ['2024-02-29', '20240229000000', '20240301000000'],
    ['2000-02-29 — a century leap year', '20000229000000', '20000301000000'],
    ['the last second of a year', '20231231235959', '20240101000000'],
  ])('accepts %s', (_label, startDatetime, endDatetime) => {
    expect(describeDateRangeFault(startDatetime, endDatetime)).toBeUndefined();
  });

  it.each([
    ['a reversed window', '20240131235959', '20240101000000'],
    ['an equal window', '20240101000000', '20240101000000'],
  ])('rejects %s', (_label, startDatetime, endDatetime) => {
    expect(describeDateRangeFault(startDatetime, endDatetime)).toMatch(
      /must be earlier than endDatetime/,
    );
  });

  it('reports a boundary that is not a real date before comparing the two', () => {
    // Feb 29 2023 rolls to Mar 1, which would compare as ordered against Mar 1 — the calendar
    // check has to run first or the rollover is reported as a valid window.
    expect(describeDateRangeFault('20230229000000', '20230301000000')).toMatch(
      /not a real UTC calendar timestamp/,
    );
  });
});

/**
 * The DOC API's explicit-window floor (#92), measured live: 29 minutes 59 seconds refused on every
 * DOC mode, 30 minutes answered on or off a quarter hour. Compared to the second, no rounding.
 */
describe('describeShortDocWindow', () => {
  it('names the window, its span, and the 30-minute minimum', () => {
    expect(describeShortDocWindow('20261113120000', '20261113122959')).toBe(
      'The window 20261113120000–20261113122959 spans 29 minutes 59 seconds, under the 30 minutes the GDELT DOC API accepts for a startDatetime/endDatetime window.',
    );
  });

  it.each([
    ['20 minutes on a quarter hour', '20261113120000', '20261113122000', '20 minutes'],
    ['29 minutes off a quarter hour', '20261113120100', '20261113123000', '29 minutes'],
    ['29 minutes 1 second', '20261113120059', '20261113123000', '29 minutes 1 second'],
    ['one minute', '20261113120000', '20261113120100', '1 minute'],
    ['45 seconds', '20261113120000', '20261113120045', '45 seconds'],
    ['one second', '20261113120000', '20261113120001', '1 second'],
    [
      '29 minutes 59 seconds across midnight',
      '20261113234500',
      '20261114001459',
      '29 minutes 59 seconds',
    ],
  ])('faults %s', (_label, startDatetime, endDatetime, span) => {
    expect(describeShortDocWindow(startDatetime, endDatetime)).toBe(
      `The window ${startDatetime}–${endDatetime} spans ${span}, under the 30 minutes the GDELT DOC API accepts for a startDatetime/endDatetime window.`,
    );
  });

  it.each([
    ['exactly 30 minutes on a quarter hour', '20261113120000', '20261113123000'],
    ['exactly 30 minutes off a quarter hour', '20261113120500', '20261113123500'],
    ['30 minutes 1 second', '20261113120000', '20261113123001'],
    ['60 minutes', '20261113120000', '20261113130000'],
    ['a week', '20261106000000', '20261113000000'],
  ])('passes %s', (_label, startDatetime, endDatetime) => {
    expect(describeShortDocWindow(startDatetime, endDatetime)).toBeUndefined();
  });

  /** Validity runs first: a pair it faults is reported by it, never as a short window. */
  it.each([
    ['no window', undefined, undefined],
    ['a lone start', '20261113120000', undefined],
    ['a lone end', undefined, '20261113122000'],
    ['a reversed 20-minute window', '20261113122000', '20261113120000'],
    ['an equal window', '20261113120000', '20261113120000'],
    ['an impossible start', '20261131120000', '20261131121000'],
  ])('leaves %s to describeDateRangeFault', (_label, startDatetime, endDatetime) => {
    expect(describeShortDocWindow(startDatetime, endDatetime)).toBeUndefined();
  });

  it('pairs with a recovery naming the 30-minute minimum and a timespan in place of the pair', () => {
    expect(DOC_SHORT_WINDOW_HINT).toBe(
      'Set endDatetime at least 30 minutes after startDatetime, or omit both and use a timespan of 15 minutes or more for a window ending now.',
    );
  });
});

describe('toGdeltDatetime', () => {
  it('formats a Date as 14 UTC digits', () => {
    expect(toGdeltDatetime(new Date('2024-01-16T12:30:45.678Z'))).toBe('20240116123045');
  });
});

describe('resolveEffectiveWindow', () => {
  it('prefers an explicit boundary pair, echoed verbatim', () => {
    expect(
      resolveEffectiveWindow({
        timespan: '7d',
        startDatetime: '20240101000000',
        endDatetime: '20240102000000',
      }),
    ).toEqual({ startDatetime: '20240101000000', endDatetime: '20240102000000' });
  });

  it('resolves a timespan against now when no explicit pair was pinned', () => {
    const window = resolveEffectiveWindow({ timespan: '24h' });
    expect(window?.startDatetime).toMatch(/^\d{14}$/);
    expect(window?.endDatetime).toMatch(/^\d{14}$/);
    expect(Number(window?.endDatetime)).toBeGreaterThan(Number(window?.startDatetime));
  });

  it('returns undefined rather than guessing when the call pinned no window at all', () => {
    expect(resolveEffectiveWindow({})).toBeUndefined();
    expect(resolveEffectiveWindow({ timespan: 'not-a-timespan' })).toBeUndefined();
    // A lone boundary is rejected upstream by isUnpairedDateRange; never treat it as a window.
    expect(resolveEffectiveWindow({ startDatetime: '20240101000000' })).toBeUndefined();
  });

  /**
   * The helpers every TV tool's empty-result notice and the DOC router's mirror window run on: a
   * timespan reaching back past what a Date holds resolves to no window and no sentence.
   */
  it('resolves no window and no notice sentence for a start no Date holds', () => {
    expect(resolveEffectiveWindow({ timespan: '99999999999d' })).toBeUndefined();
    expect(describeResolvedTimespan({ timespan: '99999999999d' })).toBe('');
  });
});

/**
 * The relative timespan forms every tool sends upstream verbatim: blank (unset), the documented DOC
 * forms, the TV-only `y` unit, any case, outer whitespace, zero-padding, and number-plus-unit syntax
 * this server does not resolve, which stays GDELT's to read.
 */
const NUMBER_THEN_UNIT = [
  '',
  '   ',
  '15min',
  '1h',
  '1H',
  '24hours',
  '1d',
  '1D',
  '7days',
  '1w',
  '1week',
  '2weeks',
  '1m',
  '3months',
  '1y',
  ' 1d ',
  '01d',
  '15mins',
  '1hour',
  '1.5d',
  '-1d',
  '+1d',
  '1 d',
] as const;

/** Text with no leading number — no relative window any GDELT API reads. */
const NOT_A_TIMESPAN = ['banana', 'd', 'garbage', 'min15'] as const;

/** A number and a unit with more text after them: the shape is anchored at both ends. */
const TEXT_AFTER_UNIT = ['7d foo', '24h!', '1d x', '15min;', '1d\nx'] as const;

describe('describeTvTimespanFault', () => {
  it.each(NUMBER_THEN_UNIT)('passes %j', (timespan) => {
    expect(describeTvTimespanFault({ timespan })).toBeUndefined();
  });

  it.each([...NOT_A_TIMESPAN, ...TEXT_AFTER_UNIT, '60', '0'])(
    'refuses %j while relative time is used',
    (timespan) => {
      expect(describeTvTimespanFault({ timespan })).toBe(
        'Use a numeric timespan followed by its unit, such as "24hours", "7d" or "1m", or supply startDatetime and endDatetime together.',
      );
    },
  );

  it('ignores any timespan once both explicit boundaries are set', () => {
    expect(
      describeTvTimespanFault({
        timespan: 'banana',
        startDatetime: '20240101000000',
        endDatetime: '20240102000000',
      }),
    ).toBeUndefined();
  });
});

/** `refineDocTimespan` as every DOC tool's input schema applies it. */
const docWindowSchema = z
  .object({
    timespan: z.string().optional(),
    startDatetime: z.string().optional(),
    endDatetime: z.string().optional(),
  })
  .superRefine(refineDocTimespan);

/** The issue messages a DOC window input draws, or `[]` when it parses. */
function docTimespanIssues(input: Record<string, string>): string[] {
  const parsed = docWindowSchema.safeParse(input);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
}

describe('refineDocTimespan', () => {
  it.each([...NUMBER_THEN_UNIT, '60', '0060'])('passes active %j', (timespan) => {
    expect(docTimespanIssues({ timespan })).toEqual([]);
  });

  it.each([...NOT_A_TIMESPAN, ...TEXT_AFTER_UNIT])(
    'refuses active %j as not a number followed by a unit',
    (timespan) => {
      expect(docTimespanIssues({ timespan })).toEqual([
        'Use a numeric timespan followed by its unit, such as "24hours", "7d" or "1m", or supply startDatetime and endDatetime together.',
      ]);
    },
  );

  it.each(['0d', '14min', '0y'])('refuses active %j under the 15-minute minimum', (timespan) => {
    expect(docTimespanIssues({ timespan })).toEqual([
      'DOC timespan must be at least 15 minutes; use "15min" or a longer window.',
    ]);
  });

  /** A lone boundary leaves the timespan unread too: the handler's date-range guard owns that call. */
  it.each([
    { startDatetime: '20240101000000', endDatetime: '20240102000000' },
    { startDatetime: '20240101000000' },
    { endDatetime: '20240102000000' },
  ])('ignores banana and 0d beside %j', (dates) => {
    expect(docTimespanIssues({ timespan: 'banana', ...dates })).toEqual([]);
    expect(docTimespanIssues({ timespan: '0d', ...dates })).toEqual([]);
  });
});

/**
 * One trim and one anchored shape match per check, then — for DOC — the unit parse: each gives
 * back a run it matched at most once, so the cost grows with the timespan's length, never its
 * square. The digit run passes DOC's check as a bare number and is refused by TV's.
 */
describe('timespan shape checks — cost on caller-sized values', () => {
  it('stays linear in the timespan length', () => {
    expectLinearCost(
      [
        ['a long digit run', (n) => '1'.repeat(n)],
        [
          'digits, then spaces, then a stray mark',
          (n) => `${fill('1', n / 2)}${fill(' ', n / 2 - 1)}!`,
          REGEX_SAFE_SIZES,
        ],
        ['one long line ending in a break', (n) => `${fill('§1 x', n - 2)}\ny`],
        ['breaks throughout', (n) => fill('  \r\n', n), REGEX_SAFE_SIZES],
      ],
      (timespan) => {
        docWindowSchema.safeParse({ timespan });
        describeTvTimespanFault({ timespan });
      },
    );
  }, 0);
});

/**
 * Three UTC months before 2026-11-14T12:00:00Z is 2026-08-14T12:00:00Z: 92 days, 13 weeks and a
 * day, 2208 hours.
 */
describe('articleSearchTimespan', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-14T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(['1y', '1Y', ' 1y ', '2years', '6m', '4months', '93d', '14w', '2209h'])(
    'runs %j on three months',
    (timespan) => {
      expect(articleSearchTimespan(timespan)).toBe('3months');
    },
  );

  /** `99999999999d` reaches back past what a Date holds, so like `1year` it resolves to no window. */
  it.each([
    '3months',
    '3m',
    '92d',
    '13w',
    '2208h',
    '1m',
    '24h',
    '15min',
    '15mins',
    '1year',
    '1.5d',
    '99999999999d',
  ])('runs %j as sent', (timespan) => {
    expect(articleSearchTimespan(timespan)).toBe(timespan);
  });

  /** The calendar decides: on 2026-03-31 three months back is 2025-12-31, 90 days. */
  it('measures three months on the calendar at now', () => {
    vi.setSystemTime(new Date('2026-03-31T00:00:00Z'));
    expect(articleSearchTimespan('90d')).toBe('90d');
    expect(articleSearchTimespan('91d')).toBe('3months');
  });
});

describe('splitWindow', () => {
  it('overlaps the halves by one second so the seam cannot be dropped', () => {
    expect(splitWindow({ startDatetime: '20240101000000', endDatetime: '20240103000000' })).toEqual(
      [
        { startDatetime: '20240101000000', endDatetime: '20240102000000' },
        { startDatetime: '20240101235959', endDatetime: '20240103000000' },
      ],
    );
  });

  /**
   * The property the overlap exists for: GDELT documents both boundaries as exclusive
   * ("published after STARTDATETIME" / "before ENDDATETIME"), so halves that merely met at
   * a shared midpoint would silently drop whatever sat on it.
   */
  it('tiles the original window exactly under exclusive boundaries — no gap, no repeat', () => {
    const window = { startDatetime: '20240101000000', endDatetime: '20240101010007' };
    const [first, second] = splitWindow(window)!;
    expect([...coveredSeconds(first), ...coveredSeconds(second)]).toEqual(coveredSeconds(window));
  });

  it('yields halves that are both strictly narrower, so recursion converges', () => {
    const span = (w: { startDatetime: string; endDatetime: string }) =>
      coveredSeconds(w).length + 1;
    const window = { startDatetime: '20240101000000', endDatetime: '20240101010000' };
    const halves = splitWindow(window)!;
    for (const half of halves) expect(span(half)).toBeLessThan(span(window));
  });

  /** GDELT DOC refuses a window under 30 minutes (#92), so no half may fall under it. */
  it('splits a 60-minute window into halves DOC accepts: 30 minutes and 30 minutes 1 second', () => {
    expect(splitWindow({ startDatetime: '20261113120000', endDatetime: '20261113130000' })).toEqual(
      [
        { startDatetime: '20261113120000', endDatetime: '20261113123000' },
        { startDatetime: '20261113122959', endDatetime: '20261113130000' },
      ],
    );
  });

  it.each([
    ['59 minutes 59 seconds', '20261113125959'],
    ['45 minutes', '20261113124500'],
    ['3 seconds', '20261113120003'],
    ['no time at all', '20261113120000'],
  ])('refuses to split %s, where a half would fall under 30 minutes', (_label, endDatetime) => {
    expect(splitWindow({ startDatetime: '20261113120000', endDatetime })).toBeUndefined();
  });

  it('refuses an unparseable window rather than emitting NaN boundaries', () => {
    // 14 digits satisfies the field regex but is not a real calendar date.
    expect(
      splitWindow({ startDatetime: '20249901000000', endDatetime: '20240103000000' }),
    ).toBeUndefined();
  });
});

describe('planWindowContinuation', () => {
  it('explains how to pin a window when none is known, without inventing one', () => {
    const plan = planWindowContinuation(undefined);
    expect(plan.windows).toBeUndefined();
    expect(plan.guidance).toMatch(/startDatetime\/endDatetime/);
  });

  it.each([
    ['59 minutes 59 seconds', '20240101005959'],
    ['2 seconds', '20240101000002'],
  ])('gives a %s window no halves, saying a narrower window is not searched', (_l, endDatetime) => {
    const plan = planWindowContinuation({ startDatetime: '20240101000000', endDatetime });
    expect(plan.windows).toBeUndefined();
    expect(plan.guidance).toBe(
      `The window 20240101000000–${endDatetime} is under 60 minutes, so either half would fall under the 30 minutes the GDELT DOC API accepts: it does not search a narrower window, and the remaining records are not retrievable through this API.`,
    );
  });

  it('halves a 60-minute window, neither half under 30 minutes', () => {
    const plan = planWindowContinuation({
      startDatetime: '20240101000000',
      endDatetime: '20240101010000',
    });
    expect(plan.windows).toEqual([
      { startDatetime: '20240101000000', endDatetime: '20240101003000' },
      { startDatetime: '20240101002959', endDatetime: '20240101010000' },
    ]);
  });

  it('names both halves in the guidance, not just in the structured windows', () => {
    const plan = planWindowContinuation({
      startDatetime: '20240101000000',
      endDatetime: '20240103000000',
    });
    expect(plan.windows).toHaveLength(2);
    for (const w of plan.windows!) {
      expect(plan.guidance).toContain(`${w.startDatetime}–${w.endDatetime}`);
    }
  });
});

describe('parseRecordTimestamp', () => {
  it('reads a DOC seendate and a TV ISO 8601 clip date as the same instant', () => {
    const ms = Date.parse('2024-01-15T12:34:56Z');
    expect(parseRecordTimestamp('20240115T123456Z')).toBe(ms);
    expect(parseRecordTimestamp('2024-01-15T12:34:56Z')).toBe(ms);
  });

  it.each(['', '2024-01-15', '2024-01-15T12:34:56', '2024-13-45T99:99:99Z', 'yesterday'])(
    'returns undefined for %j rather than guessing',
    (value) => {
      expect(parseRecordTimestamp(value)).toBeUndefined();
    },
  );
});

describe('isWithinWindow', () => {
  const window = { startDatetime: '20240701000000', endDatetime: '20240701120000' };

  it('includes both boundary seconds', () => {
    expect(isWithinWindow(window, Date.parse('2024-07-01T00:00:00Z'))).toBe(true);
    expect(isWithinWindow(window, Date.parse('2024-07-01T12:00:00Z'))).toBe(true);
  });

  it('excludes a record aired past the end, as the TV API returns them', () => {
    expect(isWithinWindow(window, Date.parse('2024-07-01T12:49:08Z'))).toBe(false);
    expect(isWithinWindow(window, Date.parse('2024-06-30T23:59:59Z'))).toBe(false);
  });
});

/**
 * Measured live: GDELT TV floors a window's start to the clock hour, includes the end's hour
 * in full, and rejects a window spanning under 30 minutes (20 rejected, 30 accepted). It picks
 * the period from the span it is sent — 7 days answered hourly, 7 days and a second daily — so
 * a floored start that lengthens the span past a threshold coarsens the whole answer.
 */
describe('tvRequestWindow', () => {
  it.each([
    ['20240116010500', '20240116012000', '20240116010000', '20240116015959'],
    ['20240116011900', '20240116013800', '20240116010000', '20240116015959'],
    // Just under 30 minutes.
    ['20240116010500', '20240116013459', '20240116010000', '20240116015959'],
    ['20240116015959', '20240116020001', '20240116010000', '20240116020001'],
    // Just under two hours, still floored; two hours and longer go out as given.
    ['20240116010500', '20240116030459', '20240116010000', '20240116030459'],
    ['20240116010500', '20240116030500', '20240116010500', '20240116030500'],
    ['20240116010500', '20240116031000', '20240116010500', '20240116031000'],
    // An end exactly on the hour would pull in that whole next hour for one second: it is
    // sent a second earlier, and that second — excluded, as GDELT documents ENDDATETIME — goes.
    ['20240116010000', '20240116020000', '20240116010000', '20240116015959'],
    ['20240116000000', '20240116010000', '20240116000000', '20240116005959'],
    ['20240116003000', '20240116020000', '20240116000000', '20240116015959'],
    ['20240116003000', '20240116030000', '20240116003000', '20240116025959'],
    // Exactly 7 days, on and off the hour: both answered hourly.
    ['20191215000000', '20191222000000', '20191215000000', '20191221235959'],
    ['20191215003000', '20191222003000', '20191215003000', '20191222003000'],
    // Ten minutes short of 3 × 365 days: answered daily, as the caller's span is.
    ['20170101003000', '20200101002000', '20170101003000', '20200101002000'],
  ])('sends %s–%s as %s–%s', (start, end, sentStart, sentEnd) => {
    const sent = tvRequestWindow({ startDatetime: start, endDatetime: end });
    expect(sent).toEqual({ startDatetime: sentStart, endDatetime: sentEnd });
    // Always a span GDELT accepts, never an hour the caller's window does not reach, and
    // never a span answered at a coarser period than the caller's own.
    expect(spanOf(sent)).toBeGreaterThanOrEqual(30 * 60);
    expect(hoursOf(sent)).toEqual(hoursOf({ startDatetime: start, endDatetime: lastSecond(end) }));
    expect(defaultTvResolution(sent)).toBe(
      defaultTvResolution({ startDatetime: start, endDatetime: end }),
    );
  });

  /**
   * The on-the-hour end rule shortens the span by a second, so at exactly 3 × 365 days or 7 days
   * and a second GDELT answers clips in the next finer period: fewer edge clips spend maxRecords.
   */
  it.each([
    ['20161201000000', '20191201000000', '20191130235959', 'day'],
    ['20240920235959', '20240928000000', '20240927235959', 'hour'],
  ])(
    'sends %s–%s, at a period threshold, as ending %s, answered in %s',
    (start, end, sentEnd, period) => {
      const sent = tvRequestWindow({ startDatetime: start, endDatetime: end });
      expect(sent).toEqual({ startDatetime: start, endDatetime: sentEnd });
      expect(defaultTvResolution(sent)).toBe(period);
    },
  );
});

/**
 * Every UTC period GDELT TV counts starts on the clock hour, and GDELT counts the whole period an
 * end falls in: an end on a period's first second, sent as is, adds that whole period. Measured
 * live: 30 minutes is GDELT TV's shortest window (29 minutes 59 seconds and 20 minutes refused).
 */
describe('tvAnalyticsWindow', () => {
  it.each([
    ['a clock hour', '20240927220000', '20240928000000', '20240927235959'],
    ['a Sunday', '20240922000000', '20241006000000', '20241005235959'],
    ['the 1st of a month', '20161201000000', '20191201000000', '20191130235959'],
    ['1 January', '20190101000000', '20210101000000', '20201231235959'],
    ['the hour inside a day', '20240920000000', '20240928060000', '20240928055959'],
    ['a window 31 minutes long', '20240927232900', '20240928000000', '20240927235959'],
    // Trimmed to exactly 30 minutes, the shortest window GDELT TV answers.
    ['a window 30 minutes and a second long', '20240927232959', '20240928000000', '20240927235959'],
  ])('sends an end on %s a second earlier', (_label, start, end, sentEnd) => {
    expect(tvAnalyticsWindow({ startDatetime: start, endDatetime: end })).toEqual({
      startDatetime: start,
      endDatetime: sentEnd,
    });
  });

  it.each([
    ['half past the hour', '20240924000000', '20241004063000'],
    ["a day's last second", '20191215000000', '20200115235959'],
    ['a minute past the hour', '20240927220000', '20240928000100'],
    ['the hour, 30 minutes from the start', '20240927233000', '20240928000000'],
    ['the hour, 15 minutes from the start', '20240927234500', '20240928000000'],
  ])('sends an end on %s as given', (_label, start, end) => {
    expect(tvAnalyticsWindow({ startDatetime: start, endDatetime: end })).toEqual({
      startDatetime: start,
      endDatetime: end,
    });
  });

  /** GDELT picks the period from the span it is sent, and the trim takes off one second. */
  it.each([
    ['exactly 3 × 365 days', 'month', 'day', '20161201000000', '20191201000000'],
    ['exactly 3 × 365 days, over 29 February', 'month', 'day', '20170302000000', '20200301000000'],
    ['7 days and a second', 'day', 'hour', '20240920235959', '20240928000000'],
    ['exactly 7 days', 'hour', 'hour', '20191215000000', '20191222000000'],
    ['3 × 365 days and an hour', 'month', 'month', '20161201000000', '20191201010000'],
  ])('moves a span of %s from %s to %s', (_label, untrimmed, sent, start, end) => {
    const window = { startDatetime: start, endDatetime: end };
    expect(defaultTvResolution(window)).toBe(untrimmed);
    expect(defaultTvResolution(tvAnalyticsWindow(window))).toBe(sent);
  });
});

describe('planTvWindowContinuation', () => {
  it('splits on the hour nearest the middle, halves sharing no second', () => {
    const plan = planTvWindowContinuation({
      startDatetime: '20240116011500',
      endDatetime: '20240116045000',
    });
    expect(plan.windows).toEqual([
      { startDatetime: '20240116011500', endDatetime: '20240116025959' },
      { startDatetime: '20240116030000', endDatetime: '20240116045000' },
    ]);
  });

  /** A half over 7 days is answered in whole UTC days, so the guidance names no single period. */
  it('tells the halves of a window over 7 days they are answered in whole UTC periods', () => {
    const plan = planTvWindowContinuation({
      startDatetime: '20191201000000',
      endDatetime: '20191215000000',
    });
    expect(plan.windows).toEqual([
      { startDatetime: '20191201000000', endDatetime: '20191207235959' },
      { startDatetime: '20191208000000', endDatetime: '20191215000000' },
    ]);
    expect(plan.guidance).toBe(
      'GDELT exposes no offset or cursor. Re-run this query unchanged against each half of the current window — 20191201000000–20191207235959, then 20191208000000–20191215000000 (both echoed in continuationWindows) — and split a half again if it also hits the cap. The TV API answers in whole UTC periods and each response keeps only its own window, so the halves share no second and no clip.',
    );
  });

  it('gives disjoint hour sets to the two halves, so a capped hour is never fetched twice', () => {
    const plan = planTvWindowContinuation({
      startDatetime: '20240116000000',
      endDatetime: '20240116020000',
    });
    const [a, b] = plan.windows!.map((w) => hoursOf(tvRequestWindow(w)));
    expect(a!.filter((h) => b!.includes(h))).toEqual([]);
  });

  it('stops when no hour lies inside a window capped at the ceiling', () => {
    const plan = planTvWindowContinuation({
      startDatetime: '20240116010000',
      endDatetime: '20240116013800',
    });
    expect(plan.windows).toBeUndefined();
    expect(plan.guidance).toBe(
      'No clock hour falls inside the window 20240116010000–20240116013800, and the TV API answers in whole clock hours, so every narrower window inside it fetches the same capped set — the remaining clips are not retrievable through this API.',
    );
  });

  /** `[00:00, 01:00:00]` is sent as hour 00 alone, so it is a single-hour window. */
  it('treats a window ending exactly on the hour as the hour before it', () => {
    const plan = planTvWindowContinuation({
      startDatetime: '20240116000000',
      endDatetime: '20240116010000',
    });
    expect(plan.windows).toBeUndefined();
    expect(
      hoursOf(tvRequestWindow({ startDatetime: '20240116000000', endDatetime: '20240116010000' })),
    ).toHaveLength(1);
  });

  it('asks for a window when none is known', () => {
    const plan = planTvWindowContinuation(undefined);
    expect(plan.windows).toBeUndefined();
    expect(plan.guidance).toMatch(/startDatetime\/endDatetime/);
  });
});

/** The last second a window keeps when sent to GDELT TV: the end, or a second before an on-hour end. */
function lastSecond(end: string): string {
  return end.endsWith('0000') ? toGdeltDatetime(new Date(toMs(end) - 1000)) : end;
}

function toMs(v: string): number {
  return Date.parse(
    `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}T${v.slice(8, 10)}:${v.slice(10, 12)}:${v.slice(12, 14)}Z`,
  );
}

function spanOf(w: { startDatetime: string; endDatetime: string }): number {
  return (toMs(w.endDatetime) - toMs(w.startDatetime)) / 1000;
}

/** The clock hours GDELT TV answers for a window: floor(start) through end's hour. */
function hoursOf(w: { startDatetime: string; endDatetime: string }): number[] {
  const hour = 3_600_000;
  const hours: number[] = [];
  for (
    let h = Math.floor(toMs(w.startDatetime) / hour);
    h <= Math.floor(toMs(w.endDatetime) / hour);
    h++
  ) {
    hours.push(h);
  }
  return hours;
}
