/**
 * @fileoverview The per-surface byte budget shared by the record-list tools
 * (`gdelt_search_articles`, `gdelt_get_tv_clips`) and the offset-paged DOC analytics tools
 * (`gdelt_get_coverage_timeline`, `gdelt_get_tone_distribution`, `gdelt_get_coverage_breakdown`):
 * how records are charged against it, how many fit, and the continuation a page cut to it hands back.
 * @module mcp-server/tools/response-budget
 */

import {
  type DateSort,
  type GdeltWindow,
  parseGdeltDatetime,
  parseRecordTimestamp,
  resumeBoundary,
  skipPastBoundary,
  type WindowBoundary,
  type WindowContinuation,
} from './date-range.js';

/**
 * Bytes a response's records may occupy on each surface — the `structuredContent` JSON and the
 * `content[]` text. Heading, enrichment, and trailer ride on top of it.
 */
export const RESPONSE_BYTE_BUDGET = 48_000;

/** A GDELT timestamp is one second wide; a resume boundary reaches one second past the record. */
const RESUME_REACH_MS = 1000;

/**
 * What one record adds to each surface: its JSON array element plus the joining comma, and its
 * rendered block plus the joining newline. Charged at the larger of the two, so one running
 * total bounds both surfaces. `rendered` must come from the renderer `format()` uses, so the
 * charge is exact rather than estimated.
 */
export function recordCharge(record: object, rendered: string): number {
  return Math.max(Buffer.byteLength(JSON.stringify(record)), Buffer.byteLength(rendered)) + 1;
}

/**
 * How many leading records fit the budget, in upstream order: stops at the first record whose
 * charge would cross it, and never returns fewer than one when any record exists — a single
 * record larger than the whole budget is still emitted, alone. `reserved` is charged first, for
 * content that rides on every page ahead of the records.
 */
export function fitToBudget(charges: Iterable<number>, reserved = 0): number {
  let used = reserved;
  let index = 0;
  for (const charge of charges) {
    used += charge;
    if (used > RESPONSE_BYTE_BUDGET) return Math.max(index, 1);
    index++;
  }
  return index;
}

/** One page of positional units cut from `offset` to the budget. */
export type OffsetPage = {
  /** Index one past the last emitted unit. */
  end: number;
  /** Where the next page starts; absent on the last page. */
  nextOffset?: number;
  /** Names the returned range and the unit total; absent when the page is the whole result. */
  notice?: string;
};

/**
 * Fits whole units from `offset` (which must be inside `units`) to the budget, always emitting
 * one. Units are charged lazily, from `offset` up to the first that crosses the budget, so a page
 * deep into a long list never renders the units before or after it. A page that is not the whole
 * result gets a notice naming its range and the unit total, and a cut page also gets the offset
 * of the next one.
 */
export function pageByOffset<T>(
  units: readonly T[],
  charge: (unit: T) => number,
  offset: number,
  noun: { singular: string; plural: string },
  reserved = 0,
): OffsetPage {
  const total = units.length;
  function* charges() {
    for (let index = offset; index < total; index++) yield charge(units[index] as T);
  }
  const end = offset + fitToBudget(charges(), reserved);
  const range =
    end - offset === 1 ? `${noun.singular} ${offset + 1}` : `${noun.plural} ${offset + 1}–${end}`;
  if (end < total) {
    return {
      end,
      nextOffset: end,
      notice:
        `Returned ${range} of ${total} ${noun.plural}; ${noun.singular} ${end + 1} would push this ` +
        `response past its ${RESPONSE_BYTE_BUDGET.toLocaleString('en-US')}-byte budget. Continue with ` +
        `offset ${end} (nextOffset) and otherwise identical inputs.`,
    };
  }
  if (offset > 0)
    return { end, notice: `Returned ${range} of ${total} ${noun.plural} — the last page.` };
  return { end };
}

/** The `continuationWindows` line of the `content[]` trailer. */
export function renderContinuationWindows(windows: readonly GdeltWindow[] = []): string {
  return [
    '**Continuation windows:**',
    ...windows.map((w) => `- startDatetime: ${w.startDatetime}, endDatetime: ${w.endDatetime}`),
  ].join('\n');
}

/** A page `fitToBudget` cut short, described for its continuation notice. */
export type CutPage = {
  noun: { singular: string; plural: string };
  /** Field a caller de-duplicates re-assembled records on. */
  dedupeKey: string;
  sort: string;
  /** The window the call ran against, when known. */
  window: GdeltWindow | undefined;
  /** Raw timestamp of each emitted record, in emitted order. */
  emittedStamps: readonly string[];
  /** Charge of each emitted record, in emitted order. */
  emittedCharges: readonly number[];
  /** Charge of the first withheld record. */
  nextCharge: number;
  /** Raw timestamp of each withheld record, in upstream order. */
  withheldStamps: readonly string[];
  /** Records the upstream returned into the budget, emitted plus withheld. */
  fetchedCount: number;
  maxRecords: number;
  ceiling: number;
  /** True when the upstream answered with `maxRecords` records, so more may exist. */
  capHit: boolean;
  /** How this API's window divides for a sort with no resume point. */
  halve: (window: GdeltWindow | undefined) => WindowContinuation;
  /** A sentence appended whenever the notice offers a way to continue (e.g. what maxRecords to continue with). */
  continueNote?: string;
};

/**
 * The notice and continuation windows for a page cut to the budget. The notice never offers a
 * larger `maxRecords` as the way to fit more into this response — the budget, not the cap, cut
 * the page; an API may add a `continueNote` about the maxRecords its continuation calls need.
 *
 * Under `dateDesc`/`dateAsc` the last emitted record is a resume point: the notice hands back
 * one window from it, provided a call on that window emits at least one record this page did
 * not (it would first re-return every emitted record inside the window, then the first withheld
 * one). When it would not, the window skips past that second instead. Other sorts have no
 * resume point and get the halves the page's API divides its window into.
 */
export function planCutNotice(page: CutPage): { notice: string; windows?: GdeltWindow[] } {
  const { noun } = page;
  const emitted = page.emittedStamps.length;
  const withheld = page.fetchedCount - emitted;
  const lead =
    `Emitted ${emitted} of ${page.fetchedCount} ${noun.plural} — the other ${withheld} would push ` +
    'this response past its 48,000-byte budget.';
  const cap = !page.capHit
    ? ''
    : page.maxRecords >= page.ceiling
      ? ` maxRecords is already at its ${page.ceiling} ceiling, so more ${noun.plural} almost certainly matched upstream.`
      : ` The maxRecords cap was reached too, so more ${noun.plural} may have matched upstream.`;
  const continuation = planContinuation(page);
  const note = continuation.continues && page.continueNote ? ` ${page.continueNote}` : '';
  return {
    notice: `${lead}${cap} ${continuation.guidance}${note}`,
    ...(continuation.windows && { windows: continuation.windows }),
  };
}

/** Continuation guidance, and whether it offers a way to continue at all. */
type Continuation = { guidance: string; windows?: GdeltWindow[]; continues: boolean };

function planContinuation(page: CutPage): Continuation {
  const { noun, dedupeKey, window } = page;
  const lastStamp = page.emittedStamps.at(-1) as string;
  const lastMs = parseRecordTimestamp(lastStamp);

  if (!isDateSort(page.sort) || lastMs === undefined) {
    const plan = page.halve(window);
    const lead = isDateSort(page.sort)
      ? `The last emitted ${noun.singular} carries no readable timestamp to resume from.`
      : `Sort ${page.sort} has no resume point.`;
    return {
      guidance: `${lead} ${plan.guidance}`,
      ...(plan.windows && { windows: plan.windows }),
      continues: plan.windows !== undefined,
    };
  }

  const reached = (ms: number | undefined) =>
    ms === undefined ||
    (page.sort === 'dateDesc' ? ms <= lastMs + RESUME_REACH_MS : ms >= lastMs - RESUME_REACH_MS);
  let reReturned = 0;
  let reReturnedCharge = 0;
  for (const [index, stamp] of page.emittedStamps.entries()) {
    if (!reached(parseRecordTimestamp(stamp))) continue;
    reReturned++;
    reReturnedCharge += page.emittedCharges[index] as number;
  }

  const stalled =
    reReturned === page.emittedStamps.length
      ? `Every emitted ${noun.singular} is timestamped within a second of ${lastStamp}, so a window resumed ` +
        `there would return the same ${noun.plural} first`
      : reReturnedCharge + page.nextCharge > RESPONSE_BYTE_BUDGET
        ? `A window resumed from ${lastStamp} would return ${reReturned} already-emitted ${noun.plural} ` +
          `first, and the next ${noun.singular} does not fit the budget after them`
        : undefined;
  if (stalled) return planSkipPast(page, page.sort, lastMs, stalled);

  const resume = resumeBoundary(page.sort, lastMs);
  const repeat =
    `${capitalize(noun.plural)} from the second of the last emitted ${noun.singular} (${lastStamp}) ` +
    `come back again — de-duplicate by ${dedupeKey}.`;
  if (!window) {
    return {
      guidance:
        `No date window was pinned for this call, so resume by re-running it with ${pairWith(resume)} of ` +
        `your choosing, and again from each response that comes back cut. ${repeat}`,
      continues: true,
    };
  }
  const resumed = { ...window, ...resume };
  return {
    windows: [resumed],
    guidance:
      `Resume with startDatetime ${resumed.startDatetime}, endDatetime ${resumed.endDatetime} (echoed ` +
      `in continuationWindows), and again from each response that comes back cut. ${repeat}`,
    continues: true,
  };
}

/**
 * When resuming at the last emitted second cannot make progress, only the withheld records at
 * that second are out of reach: everything earlier (`dateDesc`) or later (`dateAsc`) is reachable
 * by skipping the second. "Unreachable" is said outright only when the window past it would be
 * empty — inverted against the caller's other boundary, or, on an uncapped page, holding none of
 * the fetched records.
 */
function planSkipPast(
  page: CutPage,
  sort: DateSort,
  lastMs: number,
  stalled: string,
): Continuation {
  const { noun, window } = page;
  const past = skipPastBoundary(sort, lastMs);
  const beyond = sort === 'dateDesc' ? 'earlier' : 'later';
  const pastMs = boundaryMs(past);
  const nothingPast =
    !page.capHit &&
    page.withheldStamps.every((stamp) => {
      const ms = parseRecordTimestamp(stamp);
      return ms !== undefined && (sort === 'dateDesc' ? ms > pastMs : ms < pastMs);
    });
  const skipped = window && { ...window, ...past };
  if (nothingPast || (skipped && skipped.startDatetime >= skipped.endDatetime)) {
    return {
      guidance: `${stalled}, and no ${beyond} ${noun.singular} remains in the window — the rest cannot be reached by narrowing the date window.`,
      continues: false,
    };
  }
  const lost = `the ${noun.plural} from that second not emitted here cannot be reached`;
  if (!skipped) {
    return {
      guidance:
        `${stalled}, so ${lost}. Skip past it by re-running with ${pairWith(past)} of your choosing — ` +
        `every ${beyond} ${noun.singular} is reachable there.`,
      continues: true,
    };
  }
  return {
    windows: [skipped],
    guidance:
      `${stalled}, so ${lost}. Skip past it with startDatetime ${skipped.startDatetime}, endDatetime ` +
      `${skipped.endDatetime} (echoed in continuationWindows) — every ${beyond} ${noun.singular} is reachable there.`,
    continues: true,
  };
}

/** `endDatetime X paired with a startDatetime` for a one-sided boundary. */
function pairWith(boundary: WindowBoundary): string {
  return 'endDatetime' in boundary
    ? `endDatetime ${boundary.endDatetime} paired with a startDatetime`
    : `startDatetime ${boundary.startDatetime} paired with an endDatetime`;
}

function boundaryMs(boundary: WindowBoundary): number {
  return parseGdeltDatetime(
    'endDatetime' in boundary ? boundary.endDatetime : boundary.startDatetime,
  ).getTime();
}

function isDateSort(sort: string): sort is DateSort {
  return sort === 'dateDesc' || sort === 'dateAsc';
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
