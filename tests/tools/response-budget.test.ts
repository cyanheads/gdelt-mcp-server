/**
 * @fileoverview Tests for the shared response byte budget — the fit rule and the continuation
 * a cut page hands back. The tools' own tests cover these through the wire; the branches no
 * realistic fixture reaches are pinned here directly.
 * @module tests/tools/response-budget.test
 */

import { describe, expect, it } from 'vitest';
import { planWindowContinuation } from '@/mcp-server/tools/date-range.js';
import {
  type CutPage,
  fitToBudget,
  pageByOffset,
  planCutNotice,
  RESPONSE_BYTE_BUDGET,
  recordCharge,
} from '@/mcp-server/tools/response-budget.js';

describe('recordCharge', () => {
  it('charges the larger of the JSON element and the rendered block, plus its separator', () => {
    expect(recordCharge({ a: 'ü' }, 'xy')).toBe(Buffer.byteLength('{"a":"ü"}') + 1);
    expect(recordCharge({ a: 1 }, 'ü'.repeat(50))).toBe(101);
  });
});

describe('fitToBudget', () => {
  it('emits every record when the charges total exactly the budget', () => {
    expect(fitToBudget([RESPONSE_BYTE_BUDGET / 2, RESPONSE_BYTE_BUDGET / 2])).toBe(2);
  });

  it('stops at the first record that crosses the budget, even if a later one would fit', () => {
    expect(fitToBudget([40_000, 8_001, 1])).toBe(1);
  });

  it('always emits the first record, however large', () => {
    expect(fitToBudget([RESPONSE_BYTE_BUDGET * 3, 1])).toBe(1);
  });

  it('emits nothing from nothing', () => {
    expect(fitToBudget([])).toBe(0);
  });

  it('charges reserved bytes before the first record', () => {
    expect(fitToBudget([20_000, 20_000], 8_000)).toBe(2);
    expect(fitToBudget([20_000, 20_000], 8_001)).toBe(1);
  });

  it('still emits one record when the reserve alone fills the budget', () => {
    expect(fitToBudget([1, 1], RESPONSE_BYTE_BUDGET + 1)).toBe(1);
  });
});

describe('pageByOffset', () => {
  const noun = { singular: 'timestep', plural: 'timesteps' };
  const quarter = RESPONSE_BYTE_BUDGET / 4;
  /** Units that are their own charges. */
  const pageOf = (charges: number[], offset: number, reserved?: number) =>
    pageByOffset(charges, (charge) => charge, offset, noun, reserved);

  it('returns the whole result with no continuation or notice when it fits', () => {
    expect(pageOf([quarter, quarter, quarter, quarter], 0)).toEqual({ end: 4 });
  });

  it('charges only the units from the offset through the first that crosses the budget', () => {
    const charged: number[] = [];
    const units = Array.from({ length: 200 }, (_, i) => i);
    const page = pageByOffset(
      units,
      (i) => {
        charged.push(i);
        return quarter;
      },
      40,
      noun,
    );
    expect(page.end).toBe(44);
    expect(charged).toEqual([40, 41, 42, 43, 44]);
  });

  it('cuts at the budget, naming the range, the total, and where to continue', () => {
    const page = pageOf([quarter, quarter, quarter, quarter, quarter, quarter], 0);
    expect(page.end).toBe(4);
    expect(page.nextOffset).toBe(4);
    expect(page.notice).toBe(
      'Returned timesteps 1–4 of 6 timesteps; timestep 5 would push this response past its ' +
        '48,000-byte budget. Continue with offset 4 (nextOffset) and otherwise identical inputs.',
    );
  });

  it('pages from the offset, and names a last page that does not start at zero', () => {
    const charges = [quarter, quarter, quarter, quarter, quarter, quarter];
    const page = pageOf(charges, 4);
    expect(page).toEqual({
      end: 6,
      notice: 'Returned timesteps 5–6 of 6 timesteps — the last page.',
    });
  });

  it('emits a unit larger than the budget alone, with a continuation when more remain', () => {
    const page = pageOf([RESPONSE_BYTE_BUDGET * 2, 1, 1], 0);
    expect(page.end).toBe(1);
    expect(page.nextOffset).toBe(1);
    expect(page.notice).toMatch(/^Returned timestep 1 of 3 timesteps; timestep 2 would push/);
  });

  it('charges the reserve on every page', () => {
    // Without the reserve, a page from offset 3 would hold all four remaining units.
    const charges = Array.from({ length: 7 }, () => quarter);
    expect(pageOf(charges, 0, quarter)).toMatchObject({ end: 3, nextOffset: 3 });
    expect(pageOf(charges, 3, quarter)).toMatchObject({ end: 6, nextOffset: 6 });
  });

  it('walks every unit exactly once, in order, across pages', () => {
    const charges = Array.from({ length: 50 }, (_, i) => 1_000 + ((i * 7_919) % 30_000));
    const seen: number[] = [];
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const page = pageOf(charges, offset);
      for (let i = offset; i < page.end; i++) seen.push(i);
      offset = page.nextOffset;
    }
    expect(seen).toEqual(charges.map((_, i) => i));
  });
});

describe('planCutNotice', () => {
  const base: CutPage = {
    noun: { singular: 'clip', plural: 'clips' },
    dedupeKey: 'archiveUrl',
    sort: 'dateDesc',
    window: { startDatetime: '20240701000000', endDatetime: '20240702000000' },
    emittedStamps: ['2024-07-01T12:00:10Z', '2024-07-01T12:00:05Z', '2024-07-01T12:00:00Z'],
    emittedCharges: [1_000, 1_000, 1_000],
    nextCharge: 1_000,
    withheldStamps: ['2024-07-01T11:59:00Z', '2024-07-01T11:58:00Z'],
    fetchedCount: 10,
    maxRecords: 50,
    ceiling: 3000,
    capHit: false,
    halve: planWindowContinuation,
  };

  it('offers a resume window when the follow-up call would emit a new record', () => {
    const plan = planCutNotice(base);
    expect(plan.windows).toEqual([
      { startDatetime: '20240701000000', endDatetime: '20240701120001' },
    ]);
    expect(plan.notice).toMatch(/^Emitted 3 of 10 clips — the other 7 would push/);
  });

  /**
   * The follow-up re-returns every emitted record inside the resumed window first; when the
   * next record cannot fit after them, resuming there would emit nothing new. The window past
   * that second still reaches the earlier withheld records — only the ones at it are lost.
   */
  it('skips past the last second when the next record would not fit after the re-returned ones', () => {
    const plan = planCutNotice({
      ...base,
      emittedStamps: ['2024-07-01T12:00:10Z', '2024-07-01T12:00:00Z', '2024-07-01T12:00:00Z'],
      emittedCharges: [1_000, 20_000, 20_000],
      nextCharge: 9_000,
    });
    expect(plan.windows).toEqual([
      { startDatetime: '20240701000000', endDatetime: '20240701115959' },
    ]);
    expect(plan.notice).toMatch(/would return 2 already-emitted clips first/);
    expect(plan.notice).toMatch(/clips from that second not emitted here cannot be reached/);
  });

  it('skips forward past the last second under dateAsc', () => {
    const plan = planCutNotice({
      ...base,
      sort: 'dateAsc',
      emittedStamps: ['2024-07-01T12:00:00Z', '2024-07-01T12:00:00Z'],
      emittedCharges: [1_000, 1_000],
      withheldStamps: ['2024-07-01T12:00:00Z', '2024-07-01T12:05:00Z'],
    });
    expect(plan.windows).toEqual([
      { startDatetime: '20240701120001', endDatetime: '20240702000000' },
    ]);
    expect(plan.notice).toMatch(/every later clip/);
  });

  it('gives the skip-past timestamp when no window is known', () => {
    const plan = planCutNotice({
      ...base,
      window: undefined,
      emittedStamps: ['2024-07-01T12:00:00Z'],
      emittedCharges: [1_000],
    });
    expect(plan.windows).toBeUndefined();
    expect(plan.notice).toMatch(/endDatetime 20240701115959 paired with a startDatetime/);
  });

  it('says the rest is unreachable when nothing fetched lies past the shared second and the cap was not hit', () => {
    const plan = planCutNotice({
      ...base,
      emittedStamps: ['2024-07-01T12:00:00Z'],
      emittedCharges: [1_000],
      withheldStamps: ['2024-07-01T12:00:00Z'],
    });
    expect(plan.windows).toBeUndefined();
    expect(plan.notice).toMatch(/cannot be reached by narrowing the date window/);
  });

  it('falls back to the #21 halves when the last emitted timestamp does not parse', () => {
    const plan = planCutNotice({
      ...base,
      emittedStamps: ['2024-07-01T12:00:10Z', 'not a date'],
      emittedCharges: [1_000, 1_000],
    });
    expect(plan.windows).toHaveLength(2);
    expect(plan.notice).toMatch(/carries no readable timestamp/);
  });

  it('names the ceiling, never raising maxRecords, when the cut page also filled it', () => {
    const plan = planCutNotice({ ...base, capHit: true, maxRecords: 3000, fetchedCount: 3000 });
    expect(plan.notice).toMatch(/maxRecords is already at its 3000 ceiling/);
    expect(plan.notice).not.toMatch(/[Rr]aise maxRecords|[Ii]ncrease maxRecords/);
  });
});
