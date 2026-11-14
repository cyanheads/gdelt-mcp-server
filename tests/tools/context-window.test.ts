/**
 * @fileoverview The Context API window rules at their own seam: the `timespan` grammar and its
 * bounds, the 72-hour reach clamp, the widening of short explicit windows (never past now or
 * before the reach), and the date-edge continuation with its convergence guarantee. Times are
 * pinned to the instant the live window probes ran.
 * @module tests/tools/context-window.test
 */

import { describe, expect, it } from 'vitest';
import {
  contextRequestWindow,
  planContextContinuation,
  planContextWindow,
} from '@/mcp-server/tools/context-window.js';
import { parseGdeltDatetime, toGdeltDatetime } from '@/mcp-server/tools/date-range.js';
import { expectLinearCost, fill } from '../helpers/linear-cost.js';

/** The instant the live explicit-window probes ran (`now=20261114190753`). */
const NOW = parseGdeltDatetime('20261114190753').getTime();
const MIN = 60_000;
const HOUR = 60 * MIN;

/** A 14-digit GDELT datetime `offsetMs` from NOW. */
const at = (offsetMs: number) => toGdeltDatetime(new Date(NOW + offsetMs));
const win = (startDatetime: string, endDatetime: string) => ({ startDatetime, endDatetime });

/** Five minutes inside the 72-hour reach at NOW. */
const REACH_START = at(-72 * HOUR + 5 * MIN);

function plan(
  input: Parameters<typeof planContextWindow>[0],
  sort: 'dateDesc' | 'dateAsc' = 'dateDesc',
) {
  return planContextWindow(input, sort, NOW);
}

describe('planContextWindow — timespan', () => {
  /** GDELT reads a timespan from now minus its length, 5 minutes before a 72-hour window. */
  it.each<[string, string, string, string]>([
    ['72h', '72h', REACH_START, at(-72 * HOUR)],
    ['3days', '3days', REACH_START, at(-72 * HOUR)],
    ['4320min', '4320min', REACH_START, at(-72 * HOUR)],
    ['31min', '31min', at(-31 * MIN), at(-31 * MIN)],
    ['24H', '24H', at(-24 * HOUR), at(-24 * HOUR)],
    ['24hours', '24hours', at(-24 * HOUR), at(-24 * HOUR)],
    ['2D', '2D', at(-48 * HOUR), at(-48 * HOUR)],
    ['048h', '048h', at(-48 * HOUR), at(-48 * HOUR)],
    [' 24h ', '24h', at(-24 * HOUR), at(-24 * HOUR)],
  ])('runs %j as %j from %s to now, read from %s', (timespan, sent, start, read) => {
    expect(plan({ timespan })).toEqual({
      kind: 'timespan',
      timespan: sent,
      window: win(start, at(0)),
      request: win(read, at(0)),
    });
  });

  it.each([undefined, '', '   ', '\t\n'])(
    'runs the 72h default for an unset timespan %j',
    (timespan) => {
      expect(plan({ timespan })).toEqual({
        kind: 'timespan',
        timespan: '72h',
        window: win(REACH_START, at(0)),
        request: win(at(-72 * HOUR), at(0)),
      });
    },
  );

  it.each(['7d', '73h', '4321min', '4days', '1000000000000000000000000h'])(
    'clamps %j to 72h and discloses the value sent',
    (timespan) => {
      expect(plan({ timespan })).toEqual({
        kind: 'timespan',
        timespan: '72h',
        window: win(REACH_START, at(0)),
        request: win(at(-72 * HOUR), at(0)),
        clamp: { parameter: 'timespan', requested: timespan, applied: '72h' },
      });
    },
  );

  it('keeps the value as sent, whitespace included, in the clamp', () => {
    expect(plan({ timespan: ' 7d ' })).toMatchObject({
      clamp: { parameter: 'timespan', requested: ' 7d ', applied: '72h' },
    });
  });

  it.each(['1w', '30m', '1m', '1months', '1month', '1.5d', 'banana', '24 h', 'h', '-1h', '1hour'])(
    'refuses %j as outside the grammar',
    (timespan) => {
      expect(plan({ timespan })).toEqual({
        kind: 'invalid_timespan',
        message: `Context timespan ${JSON.stringify(timespan)} is not a whole number followed by min, h, hours, d, or days.`,
        hint: 'Use a whole number followed by min, h, hours, d, or days, from 31min to 72h, such as "6h" or "3days", or supply startDatetime and endDatetime together.',
      });
    },
  );

  it.each(['30min', '20min', '0d', '0h', '15min'])(
    'refuses %j as shorter than 31 minutes',
    (timespan) => {
      expect(plan({ timespan })).toMatchObject({
        kind: 'invalid_timespan',
        message: `Context timespan ${JSON.stringify(timespan)} is shorter than the 31 minutes the Context API accepts.`,
      });
    },
  );

  it('leaves an unused timespan unread beside a valid pair', () => {
    expect(
      plan({ timespan: 'banana', startDatetime: at(-2 * HOUR), endDatetime: at(-HOUR) }),
    ).toMatchObject({ kind: 'explicit' });
  });
});

describe('planContextWindow — explicit window', () => {
  /**
   * GDELT reads both bounds only to the minute, so a request ending mid-minute would never read
   * the rest of that minute; the end goes up to the next whole minute, and the start, which GDELT
   * reads from its own minute's first second anyway, goes as it is.
   */
  it('sends a 60-minute window inside the reach with its end rounded up to the minute (e01)', () => {
    expect(plan({ startDatetime: '20261112190753', endDatetime: '20261112200753' })).toEqual({
      kind: 'explicit',
      window: win('20261112190753', '20261112200753'),
      request: win('20261112190753', '20261112200800'),
    });
  });

  it('sends a window already on whole minutes as it is', () => {
    expect(plan({ startDatetime: '20261112190700', endDatetime: '20261112200700' })).toEqual({
      kind: 'explicit',
      window: win('20261112190700', '20261112200700'),
      request: win('20261112190700', '20261112200700'),
    });
  });

  it.each<[string, string | undefined, string | undefined, string]>([
    [
      'a lone start',
      '20261112190753',
      undefined,
      'startDatetime and endDatetime must be supplied together',
    ],
    [
      'a lone end',
      undefined,
      '20261112190753',
      'startDatetime and endDatetime must be supplied together',
    ],
    [
      'an unreal start',
      '20261131000000',
      '20261113000000',
      'startDatetime 20261131000000 is not a real UTC calendar timestamp',
    ],
    [
      'a reversed window',
      '20261113000000',
      '20261112000000',
      'startDatetime 20261113000000 must be earlier than endDatetime 20261112000000',
    ],
  ])('refuses %s as the DOC tools do', (_case, startDatetime, endDatetime, message) => {
    expect(plan({ startDatetime, endDatetime })).toEqual({ kind: 'invalid_date_range', message });
  });

  it('refuses a window starting now or later', () => {
    expect(plan({ startDatetime: at(0), endDatetime: at(HOUR) })).toEqual({
      kind: 'invalid_date_range',
      message: `startDatetime ${at(0)} is not in the past; the Context API searches the 72 hours up to now`,
    });
  });

  it('refuses a window entirely older than the reach (e03)', () => {
    expect(plan({ startDatetime: '20261104190753', endDatetime: '20261105190753' })).toEqual({
      kind: 'invalid_date_range',
      message: `The window 20261104190753–20261105190753 ends before ${REACH_START}, so it holds nothing the Context API searches; it reaches back only 72 hours`,
      hint: `Use a window ending after ${REACH_START}, or gdelt_search_articles for older coverage.`,
    });
  });

  it('refuses a window ending inside the five-minute margin of the reach', () => {
    expect(
      plan({ startDatetime: at(-96 * HOUR), endDatetime: at(-72 * HOUR + 2 * MIN) }),
    ).toMatchObject({
      kind: 'invalid_date_range',
    });
  });

  it('refuses a window ending exactly five minutes inside the reach', () => {
    expect(plan({ startDatetime: at(-96 * HOUR), endDatetime: REACH_START })).toMatchObject({
      kind: 'invalid_date_range',
    });
  });

  it('runs a straddling window from five minutes inside the reach (e04)', () => {
    expect(plan({ startDatetime: '20261109190753', endDatetime: '20261113190753' })).toEqual({
      kind: 'explicit',
      window: win(REACH_START, '20261113190753'),
      request: win(REACH_START, '20261113190800'),
      clamp: { parameter: 'startDatetime', requested: '20261109190753', applied: REACH_START },
    });
  });

  it('leaves a start inside the reach but inside its margin unclamped', () => {
    const start = at(-72 * HOUR + MIN);
    expect(plan({ startDatetime: start, endDatetime: at(-HOUR) })).toEqual({
      kind: 'explicit',
      window: win(start, at(-HOUR)),
      request: win(start, '20261114180800'),
    });
  });

  /** Every request end below is the widened end rounded up to its next whole minute (NOW is :53). */
  it.each<[string, 'dateDesc' | 'dateAsc', string, string, string, string]>([
    // e05's 20-minute window: the start moves back under dateDesc, the end forward under dateAsc.
    [
      'dateDesc',
      'dateDesc',
      '20261112190753',
      '20261112192753',
      '20261112182753',
      '20261112192800',
    ],
    ['dateAsc', 'dateAsc', '20261112190753', '20261112192753', '20261112190753', '20261112200800'],
    // Ending at now, the end cannot move: dateAsc takes the whole hour at the start.
    ['dateAsc ending at now', 'dateAsc', at(-20 * MIN), at(0), at(-HOUR), '20261114190800'],
    [
      'dateAsc ending 10 minutes ago',
      'dateAsc',
      at(-30 * MIN),
      at(-10 * MIN),
      at(-HOUR),
      '20261114190800',
    ],
    // A start one minute inside the reach cannot move back: dateDesc takes the hour at the end.
    [
      'dateDesc at the reach',
      'dateDesc',
      at(-72 * HOUR + MIN),
      at(-72 * HOUR + 21 * MIN),
      at(-72 * HOUR + MIN),
      '20261111200900',
    ],
    // GDELT measures a window only up to now: 20 minutes ago to 40 minutes ahead is 20 minutes.
    [
      'dateDesc ending in the future',
      'dateDesc',
      at(-20 * MIN),
      at(40 * MIN),
      at(-HOUR),
      '20261114190800',
    ],
    [
      'dateAsc ending in the future',
      'dateAsc',
      at(-20 * MIN),
      at(40 * MIN),
      at(-HOUR),
      '20261114190800',
    ],
  ])(
    'widens a short window under %s',
    (_case, sort, startDatetime, endDatetime, requestStart, requestEnd) => {
      expect(plan({ startDatetime, endDatetime }, sort)).toEqual({
        kind: 'explicit',
        window: win(startDatetime, endDatetime),
        request: win(requestStart, requestEnd),
      });
    },
  );

  it('sends a window spanning an hour up to now unwidened, a future end included', () => {
    expect(plan({ startDatetime: at(-HOUR), endDatetime: at(HOUR) })).toMatchObject({
      request: win(at(-HOUR), '20261114200800'),
    });
  });

  /** The widening adds exactly what the 60 minutes lack; rounding the end up adds under a minute. */
  it('widens to 60 minutes, its end rounded up to the minute, for every width under it', () => {
    for (let minutes = 1; minutes < 60; minutes++) {
      for (const sort of ['dateDesc', 'dateAsc'] as const) {
        const request = contextRequestWindow(
          win(at(-10 * HOUR), at(-10 * HOUR + minutes * MIN)),
          sort,
          NOW,
        );
        const end = parseGdeltDatetime(request.endDatetime).getTime();
        const span = end - parseGdeltDatetime(request.startDatetime).getTime();
        expect(request.endDatetime, `${minutes} minutes, ${sort}`).toMatch(/00$/);
        expect(span, `${minutes} minutes, ${sort}`).toBe(HOUR + 7_000);
      }
    }
  });
});

describe('planContextContinuation', () => {
  const S = '20261112190753';
  const E = '20261112200753';
  const ms = (datetime: string) => parseGdeltDatetime(datetime).getTime();
  const continuation = (
    window: { startDatetime: string; endDatetime: string },
    request: { startDatetime: string; endDatetime: string },
    sort: 'dateDesc' | 'dateAsc',
    seen: string[],
  ) => planContextContinuation(window, request, sort, seen.map(ms), NOW);

  /** What the e01 window [S, E] goes upstream as: its end rounded up to the minute. */
  const REQUEST = win(S, '20261112200800');

  it('has nothing to continue from on an empty page', () => {
    expect(continuation(win(S, E), REQUEST, 'dateDesc', [])).toEqual({ kind: 'none' });
  });

  it.each(['dateDesc', 'dateAsc'] as const)(
    'builds the %s page request the table below assumes',
    (sort) => {
      expect(contextRequestWindow(win(S, E), sort, NOW)).toEqual(REQUEST);
    },
  );

  /**
   * GDELT reads a window from its start's minute through the first second of its end's minute,
   * so the next window's moving edge sits on a whole minute: under dateDesc the one at or after
   * the oldest match (an end on the oldest second itself would read only up to that minute's
   * first second, skipping the rest of it), under dateAsc the one at or before the newest. The
   * matches between that minute and the edge match repeat; none falls through.
   */
  it.each<[string, 'dateDesc' | 'dateAsc', string[], string, string]>([
    [
      'the oldest match, rounded up to its minute (e01 → e02)',
      'dateDesc',
      ['20261112200750', '20261112200156'],
      S,
      '20261112200200',
    ],
    [
      'an oldest match on a whole minute, as it is',
      'dateDesc',
      ['20261112200750', '20261112200100'],
      S,
      '20261112200100',
    ],
    [
      'an oldest match a minute short of the read edge',
      'dateDesc',
      ['20261112200750', '20261112200700'],
      S,
      '20261112200700',
    ],
    [
      'the newest match, rounded down to its minute',
      'dateAsc',
      ['20261112190800', '20261112191459'],
      '20261112191400',
      E,
    ],
    [
      'a newest match on a whole minute, as it is',
      'dateAsc',
      ['20261112190800', '20261112191500'],
      '20261112191500',
      E,
    ],
    [
      'a newest match in the minute after the start',
      'dateAsc',
      ['20261112190753', '20261112190800'],
      '20261112190800',
      E,
    ],
  ])('continues %s under %s', (_case, sort, seen, startDatetime, endDatetime) => {
    expect(continuation(win(S, E), REQUEST, sort, seen)).toEqual({
      kind: 'next',
      window: win(startDatetime, endDatetime),
    });
  });

  /**
   * One minute: no window bound on a whole minute falls between the page's matches, so the next
   * window would read this page again. At the edge GDELT reads first that is the minute up to the
   * rounded end or from the start — a match past the window but inside the minute its request was
   * rounded out to included, which is not a widening; anywhere else it is a page whose matches all
   * fall in one minute, with nothing between them and the edge. Each carries the window past that
   * minute — ending on its first second under dateDesc, starting on the next minute under dateAsc
   * — unless its request would read the same edge again.
   */
  it.each<[string, 'dateDesc' | 'dateAsc', string[], [string, string, string] | undefined]>([
    [
      'the minute up to the rounded end',
      'dateDesc',
      ['20261112200752', '20261112200701'],
      [S, '20261112200700', '20261112200700'],
    ],
    ['a match past the end, inside its minute', 'dateDesc', ['20261112200800'], undefined],
    [
      'one minute short of the end',
      'dateDesc',
      ['20261112195559', '20261112195510'],
      [S, '20261112195500', '20261112195500'],
    ],
    [
      'the minute the start falls in',
      'dateAsc',
      ['20261112190753', '20261112190759'],
      ['20261112190800', E, '20261112190700'],
    ],
    [
      'a match before the start, inside its minute',
      'dateAsc',
      ['20261112190720'],
      ['20261112190800', E, '20261112190700'],
    ],
    [
      'one minute past the start',
      'dateAsc',
      ['20261112193010', '20261112193055'],
      ['20261112193100', E, '20261112193000'],
    ],
  ])('is blocked within one minute: %s under %s', (_case, sort, seen, skip) => {
    expect(continuation(win(S, E), REQUEST, sort, seen)).toEqual({
      kind: 'blocked',
      cause: 'one_minute',
      ...(skip && { skip: { window: win(skip[0], skip[1]), minute: skip[2] } }),
    });
  });

  it("carries no window past a minute that is the window's last under dateAsc or first under dateDesc", () => {
    expect(
      continuation(win(S, E), REQUEST, 'dateAsc', ['20261112200710', '20261112200750']),
    ).toEqual({ kind: 'blocked', cause: 'one_minute' });
    const onMinute = win('20261112190700', E);
    expect(
      continuation(onMinute, win('20261112190700', '20261112200800'), 'dateDesc', [
        '20261112190759',
        '20261112190710',
      ]),
    ).toEqual({ kind: 'blocked', cause: 'one_minute' });
  });

  /**
   * GDELT reads a 72-hour timespan from 5 minutes before its window, so under dateAsc the oldest
   * matches it returns can all precede the window. Nothing was widened: the window itself reaches
   * the next matches.
   */
  it('continues a 72-hour dateAsc page that fell before its window from the window itself', () => {
    const window = win(REACH_START, at(0));
    const request = win(at(-72 * HOUR), at(0));
    expect(
      continuation(window, request, 'dateAsc', [at(-72 * HOUR + MIN), at(-72 * HOUR + 3 * MIN)]),
    ).toEqual({ kind: 'next', window });
    // Straddling the window's first minute, it continues from the window's start as well.
    expect(continuation(window, request, 'dateAsc', [at(-72 * HOUR + MIN), REACH_START])).toEqual({
      kind: 'next',
      window,
    });
  });

  it('continues a timespan window from its own start', () => {
    const window = win(at(-24 * HOUR), at(0));
    expect(continuation(window, window, 'dateDesc', [at(-55 * MIN), at(-HOUR)])).toEqual({
      kind: 'next',
      window: win(at(-24 * HOUR), '20261114180800'),
    });
  });

  it('continues dateAsc past a window the next request widens forward', () => {
    const window = win(at(-3 * HOUR), at(-2 * HOUR));
    expect(
      continuation(window, contextRequestWindow(window, 'dateAsc', NOW), 'dateAsc', [
        at(-2.75 * HOUR),
        at(-2.5 * HOUR),
      ]),
    ).toEqual({
      kind: 'next',
      window: win('20261114163700', at(-2 * HOUR)),
    });
  });

  /**
   * A match on the window's own edge second is inside the window, and more may share that second,
   * so only a match past the edge proves the page reached it.
   */
  it.each<[string, 'dateDesc' | 'dateAsc', string[], string, string]>([
    ['the oldest match on the start', 'dateDesc', ['20261112200750', S], S, '20261112190800'],
    ['the newest match on the end', 'dateAsc', ['20261112190800', E], '20261112200700', E],
  ])('continues %s under %s, not complete', (_case, sort, seen, startDatetime, endDatetime) => {
    expect(continuation(win(S, E), REQUEST, sort, seen)).toEqual({
      kind: 'next',
      window: win(startDatetime, endDatetime),
    });
  });

  it('calls a widened dateDesc page that reached past the start complete', () => {
    expect(
      continuation(
        win('20261112190753', '20261112192753'),
        win('20261112182753', '20261112192800'),
        'dateDesc',
        ['20261112192000', '20261112185000'],
      ),
    ).toEqual({ kind: 'complete' });
  });

  it('calls a widened dateAsc page that reached past the end complete', () => {
    expect(
      continuation(
        win('20261112190753', '20261112192753'),
        win('20261112190753', '20261112200800'),
        'dateAsc',
        ['20261112191000', '20261112193000'],
      ),
    ).toEqual({ kind: 'complete' });
  });

  it('is blocked when matches past a dateAsc window widened back fill the page', () => {
    const window = win(at(-20 * MIN), at(0));
    const request = win(at(-HOUR), '20261114190800');
    expect(continuation(window, request, 'dateAsc', [at(-50 * MIN), at(-45 * MIN)])).toEqual({
      kind: 'blocked',
      cause: 'widened',
    });
  });

  it('never hands back a dateAsc window whose request starts where this one did', () => {
    const window = win(at(-20 * MIN), at(0));
    const request = win(at(-HOUR), '20261114190800');
    expect(continuation(window, request, 'dateAsc', [at(-50 * MIN), at(-10 * MIN)])).toEqual({
      kind: 'blocked',
      cause: 'widened',
    });
  });

  it('is blocked when matches past a dateDesc window widened forward fill the page', () => {
    const window = win(at(-72 * HOUR + MIN), at(-72 * HOUR + 21 * MIN));
    const request = win(at(-72 * HOUR + MIN), '20261111200900');
    expect(
      continuation(window, request, 'dateDesc', [at(-71 * HOUR), at(-71 * HOUR - 10 * MIN)]),
    ).toEqual({
      kind: 'blocked',
      cause: 'widened',
    });
  });

  it('never hands back a dateDesc window whose request ends where this one did', () => {
    const window = win(at(-72 * HOUR + MIN), at(-72 * HOUR + 21 * MIN));
    const request = win(at(-72 * HOUR + MIN), '20261111200900');
    expect(
      continuation(window, request, 'dateDesc', [at(-71 * HOUR), at(-72 * HOUR + 10 * MIN)]),
    ).toEqual({
      kind: 'blocked',
      cause: 'widened',
    });
  });

  /** A walk handed back by each page reaches a page with no continuation in finitely many steps. */
  it('narrows the window on every step of a walk', () => {
    for (const sort of ['dateDesc', 'dateAsc'] as const) {
      let window = win(at(-6 * HOUR), at(-HOUR));
      for (let step = 0; step < 400; step++) {
        const request = contextRequestWindow(window, sort, NOW);
        // A page of three matches, one minute apart, at the edge GDELT reads first.
        const first =
          sort === 'dateDesc' ? ms(request.endDatetime) - 1000 : ms(request.startDatetime);
        const direction = sort === 'dateDesc' ? -1 : 1;
        const seen = [0, 1, 2].map((i) => first + direction * i * MIN);
        const next = planContextContinuation(window, request, sort, seen, NOW);
        if (next.kind !== 'next') break;
        const narrower =
          sort === 'dateDesc'
            ? next.window.endDatetime < window.endDatetime
            : next.window.startDatetime > window.startDatetime;
        expect(narrower, `${sort} step ${step}`).toBe(true);
        window = next.window;
        expect(step, `${sort} walk never ends`).toBeLessThan(399);
      }
    }
  });
});

/** The grammar check trims the value and runs one anchored regex; a refusal quotes it once. */
describe('planContextWindow — cost on caller-sized timespans', () => {
  it('stays linear in the timespan length', () => {
    expectLinearCost(
      [
        ['a long digit run and a unit', (n) => `${'1'.repeat(n - 1)}h`],
        ['a long digit run and no unit', (n) => `${'1'.repeat(n - 1)}x`],
        ['one long line ending in a break', (n) => `${fill('§1 x', n - 2)}\ny`],
        ['breaks throughout', (n) => fill('  \r\n', n)],
      ],
      (timespan) => {
        plan({ timespan });
      },
    );
  }, 0);
});
