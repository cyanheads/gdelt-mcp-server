/**
 * @fileoverview Tests for the shared GDELT date-range helpers — window resolution and the
 * overflow partition. The partition's boundary handling is load-bearing and easy to get
 * subtly wrong, so it is pinned directly rather than only through the tools that call it.
 * @module tests/tools/date-range.test
 */

import { describe, expect, it } from 'vitest';
import {
  describeDateRangeFault,
  isUnpairedDateRange,
  isWithinWindow,
  parseRecordTimestamp,
  planTvWindowContinuation,
  planWindowContinuation,
  resolveEffectiveWindow,
  resumeBoundary,
  splitWindow,
  toGdeltDatetime,
  tvRequestWindow,
} from '@/mcp-server/tools/date-range.js';

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
    const window = { startDatetime: '20240101000000', endDatetime: '20240101000030' };
    const [first, second] = splitWindow(window)!;
    expect([...coveredSeconds(first), ...coveredSeconds(second)]).toEqual(coveredSeconds(window));
  });

  it('yields halves that are both strictly narrower, so recursion converges', () => {
    const span = (w: { startDatetime: string; endDatetime: string }) =>
      coveredSeconds(w).length + 1;
    const window = { startDatetime: '20240101000000', endDatetime: '20240101000004' };
    const halves = splitWindow(window)!;
    for (const half of halves) expect(span(half)).toBeLessThan(span(window));
  });

  it('refuses to split below four seconds, where a half would stop shrinking', () => {
    expect(
      splitWindow({ startDatetime: '20240101000000', endDatetime: '20240101000003' }),
    ).toBeUndefined();
    expect(
      splitWindow({ startDatetime: '20240101000000', endDatetime: '20240101000000' }),
    ).toBeUndefined();
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

  it('states that the remainder is unreachable once the window cannot be narrowed', () => {
    const plan = planWindowContinuation({
      startDatetime: '20240101000000',
      endDatetime: '20240101000002',
    });
    expect(plan.windows).toBeUndefined();
    expect(plan.guidance).toMatch(/not retrievable/);
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

describe('resumeBoundary', () => {
  const at = Date.parse('2024-01-15T12:00:00Z');

  it('resumes dateDesc with an endDatetime one second past the last emitted record', () => {
    expect(resumeBoundary('dateDesc', at)).toEqual({ endDatetime: '20240115120001' });
  });

  it('resumes dateAsc with a startDatetime one second before the last emitted record', () => {
    expect(resumeBoundary('dateAsc', at)).toEqual({ startDatetime: '20240115115959' });
  });

  /**
   * Under GDELT's documented exclusive boundaries the resumed window still covers the last
   * emitted record's second — the records cut from that second are reachable, not skipped.
   */
  it('keeps the last emitted second inside the resumed window under exclusive boundaries', () => {
    const window = { startDatetime: '20240110000000', endDatetime: '20240120000000' };
    const desc = { ...window, ...resumeBoundary('dateDesc', at) };
    const asc = { ...window, ...resumeBoundary('dateAsc', at) };
    expect(coveredSeconds(desc)).toContain(at / 1000);
    expect(coveredSeconds(asc)).toContain(at / 1000);
    expect(describeDateRangeFault(desc.startDatetime, desc.endDatetime)).toBeUndefined();
    expect(describeDateRangeFault(asc.startDatetime, asc.endDatetime)).toBeUndefined();
  });
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
 * in full, and rejects a window spanning under 30 minutes (20 rejected, 30 accepted).
 */
describe('tvRequestWindow', () => {
  it.each([
    ['20240116010500', '20240116012000', '20240116010000', '20240116015959'],
    ['20240116011900', '20240116013800', '20240116010000', '20240116015959'],
    ['20240116015959', '20240116020001', '20240116010000', '20240116020001'],
    ['20240116010500', '20240116031000', '20240116010000', '20240116031000'],
    // An end exactly on the hour would pull in that whole next hour for one second: it is
    // sent a second earlier, and that second — excluded, as GDELT documents ENDDATETIME — goes.
    ['20240116010000', '20240116020000', '20240116010000', '20240116015959'],
    ['20240116000000', '20240116010000', '20240116000000', '20240116005959'],
    ['20240116003000', '20240116020000', '20240116000000', '20240116015959'],
  ])('sends %s–%s as %s–%s', (start, end, sentStart, sentEnd) => {
    const sent = tvRequestWindow({ startDatetime: start, endDatetime: end });
    expect(sent).toEqual({ startDatetime: sentStart, endDatetime: sentEnd });
    // Always a span GDELT accepts, and never an hour the caller's window does not reach.
    expect(spanOf(sent)).toBeGreaterThanOrEqual(30 * 60);
    expect(hoursOf(sent)).toEqual(hoursOf({ startDatetime: start, endDatetime: lastSecond(end) }));
  });
});

describe('planTvWindowContinuation', () => {
  const cutAndCapped = { cut: true, cap: 'below-ceiling' } as const;

  it('splits on the hour nearest the middle, halves sharing no second', () => {
    const plan = planTvWindowContinuation(
      { startDatetime: '20240116011500', endDatetime: '20240116045000' },
      cutAndCapped,
    );
    expect(plan.windows).toEqual([
      { startDatetime: '20240116011500', endDatetime: '20240116025959' },
      { startDatetime: '20240116030000', endDatetime: '20240116045000' },
    ]);
  });

  it('gives disjoint hour sets to the two halves, so a capped hour is never fetched twice', () => {
    const plan = planTvWindowContinuation(
      { startDatetime: '20240116000000', endDatetime: '20240116020000' },
      { cut: false, cap: 'at-ceiling' },
    );
    const [a, b] = plan.windows!.map((w) => hoursOf(tvRequestWindow(w)));
    expect(a!.filter((h) => b!.includes(h))).toEqual([]);
  });

  /**
   * Only an uncut page capped at 3000 has nothing a narrower window can add: a cut page's
   * withheld clips were fetched and sit inside the window, so a sub-hour half reaches them.
   */
  it('stops only when a page capped at the ceiling was not cut and no hour lies inside', () => {
    const plan = planTvWindowContinuation(
      { startDatetime: '20240116010000', endDatetime: '20240116013800' },
      { cut: false, cap: 'at-ceiling' },
    );
    expect(plan.windows).toBeUndefined();
    expect(plan.guidance).toMatch(/whole clock hours/);
    expect(plan.guidance).toMatch(/not retrievable/);
  });

  it.each([
    [{ cut: true, cap: 'none' } as const, undefined],
    [
      { cut: true, cap: 'below-ceiling' } as const,
      /clips past that cap are out of reach of any narrower window/,
    ],
    [
      { cut: true, cap: 'at-ceiling' } as const,
      /more clips matched upstream than any window inside this hour can fetch/,
    ],
  ])('splits a cut window inside one hour at the second (%o)', (options, capNote) => {
    const plan = planTvWindowContinuation(
      { startDatetime: '20240116010500', endDatetime: '20240116015000' },
      options,
    );
    expect(plan.windows).toEqual([
      { startDatetime: '20240116010500', endDatetime: '20240116012730' },
      { startDatetime: '20240116012731', endDatetime: '20240116015000' },
    ]);
    expect(plan.guidance).not.toMatch(/not retrievable/);
    if (capNote) expect(plan.guidance).toMatch(capNote);
  });

  /** `[00:00, 01:00:00]` is sent as hour 00 alone, so it is a single-hour window. */
  it('treats a window ending exactly on the hour as the hour before it', () => {
    const plan = planTvWindowContinuation(
      { startDatetime: '20240116000000', endDatetime: '20240116010000' },
      { cut: false, cap: 'at-ceiling' },
    );
    expect(plan.windows).toBeUndefined();
    expect(
      hoursOf(tvRequestWindow({ startDatetime: '20240116000000', endDatetime: '20240116010000' })),
    ).toHaveLength(1);
  });

  it('stops when a cut window is too narrow to divide at one-second resolution', () => {
    const plan = planTvWindowContinuation(
      { startDatetime: '20240116010000', endDatetime: '20240116010002' },
      { cut: true, cap: 'none' },
    );
    expect(plan.windows).toBeUndefined();
    expect(plan.guidance).toMatch(/not retrievable/);
  });

  it('asks for a window when none is known', () => {
    const plan = planTvWindowContinuation(undefined, { cut: false, cap: 'at-ceiling' });
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
