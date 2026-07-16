/**
 * @fileoverview Tests for the shared GDELT date-range helpers — window resolution and the
 * overflow partition. The partition's boundary handling is load-bearing and easy to get
 * subtly wrong, so it is pinned directly rather than only through the tools that call it.
 * @module tests/tools/date-range.test
 */

import { describe, expect, it } from 'vitest';
import {
  isUnpairedDateRange,
  planWindowContinuation,
  resolveEffectiveWindow,
  splitWindow,
  toGdeltDatetime,
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
