/**
 * @fileoverview Tests for DOC mode emulation over the GKG mirror store: coverage from the slot
 * ledger, bucket width, volume/raw/info/tone timelines, the tone histogram, language and country
 * breakdowns, artlist sorts, and each predicate's SQL — against a real store built from the
 * production spec. Also: windows narrower than the store when rowids do not follow slot order,
 * ties at the artlist boundary, column predicates beside FTS membership in every mode, the
 * access path every statement takes to `gkg_articles`, and the index an older store gains.
 * @module tests/services/gkg-mirror-queries.test
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type SqliteHandle, type SqlValue, sqliteMirrorStore } from '@cyanheads/mcp-ts-core/mirror';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { compileDocQuery } from '@/services/gkg-mirror/doc-query-compiler.js';
import {
  executeMirrorRequest,
  readMirrorCoverage,
} from '@/services/gkg-mirror/gkg-mirror-queries.js';
import {
  buildGkgMirrorStoreSpec,
  type GkgArticleRow,
} from '@/services/gkg-mirror/gkg-mirror-schema.js';
import type {
  MirrorQueryPlan,
  MirrorRequest,
  MirrorResponse,
  MirrorResult,
} from '@/services/gkg-mirror/types.js';
import {
  type GkgMirrorFixture,
  gkgRow,
  gkgSlotsBetween,
  openGkgMirrorFixture,
  seedGkgBothFeeds,
  seedGkgRows,
  seedGkgSlots,
} from '../helpers/gkg-mirror-fixture.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function plan(query: string): MirrorQueryPlan {
  const result = compileDocQuery(query);
  if (!result.ok) throw new Error(`${query}: ${result.detail}`);
  return result.plan;
}

type Answered = Extract<MirrorResponse, { outcome: 'answered' }>;

/** A request without its plan and window, one member per request kind. */
type RequestKind<R = MirrorRequest> = R extends MirrorRequest ? Omit<R, 'plan' | 'window'> : never;

function answered(fixture: GkgMirrorFixture, request: MirrorRequest): Answered {
  const response = executeMirrorRequest(fixture.handle, request);
  if (response.outcome !== 'answered')
    throw new Error(`expected an answer: ${JSON.stringify(response)}`);
  return response;
}

function resultOf<K extends MirrorResult['kind']>(
  response: Answered,
  kind: K,
): Extract<MirrorResult, { kind: K }> {
  if (response.answer.kind !== kind)
    throw new Error(`expected ${kind}, got ${response.answer.kind}`);
  return response.answer as Extract<MirrorResult, { kind: K }>;
}

const DAY = '20261101';
const at = (hhmm: string) => `${DAY}${hhmm}00`;

// ─── Coverage ─────────────────────────────────────────────────────────────────

describe('readMirrorCoverage', () => {
  let fixture: GkgMirrorFixture;
  beforeEach(async () => {
    fixture = await openGkgMirrorFixture();
  });
  afterEach(async () => {
    await fixture.cleanup();
  });

  it('reports no slots for an empty store', () => {
    expect(readMirrorCoverage(fixture.handle)).toEqual({});
  });

  it('bounds coverage by the slots ingested in both feeds', async () => {
    seedGkgSlots(fixture.handle, [
      { feed: 'english', slot: at('1045') },
      { feed: 'english', slot: at('1100') },
      { feed: 'translation', slot: at('1100') },
      { feed: 'english', slot: at('1115') },
      { feed: 'translation', slot: at('1115'), status: 'gap' },
      { feed: 'english', slot: at('1130') },
      { feed: 'translation', slot: at('1130') },
      { feed: 'english', slot: at('1145') },
    ]);
    await seedGkgRows(fixture.store, [
      gkgRow({ url: 'u/1', date: at('1100'), domain: 'a.com' }),
      gkgRow({ url: 'u/2', date: at('1145'), domain: 'a.com' }),
    ]);
    expect(readMirrorCoverage(fixture.handle)).toEqual({
      oldestSlot: at('1100'),
      newestSlot: at('1130'),
    });
  });
});

describe('executeMirrorRequest — coverage', () => {
  let fixture: GkgMirrorFixture;
  const volRaw = (start: string, end: string): MirrorRequest => ({
    kind: 'timeline',
    mode: 'timelinevolraw',
    plan: plan('theme:TAX_FNCACT'),
    window: { startDatetime: start, endDatetime: end },
  });

  beforeEach(async () => {
    fixture = await openGkgMirrorFixture();
  });
  afterEach(async () => {
    await fixture.cleanup();
  });

  it('refuses every window while no slot is ingested in both feeds', () => {
    seedGkgSlots(fixture.handle, [{ feed: 'english', slot: at('1100') }]);
    expect(executeMirrorRequest(fixture.handle, volRaw(at('1000'), at('1200')))).toEqual({
      outcome: 'outside_coverage',
      detail: 'The GKG mirror holds no slot ingested in both feeds.',
    });
  });

  it.each([
    ['before the oldest slot', '20261101090000', '20261101105959'],
    ['after the newest slot', '20261101114600', '20261101130000'],
    ['holding only a one-feed gap slot', '20261101111000', '20261101112000'],
    ['between two slots', '20261101110100', '20261101111400'],
  ])('refuses a window %s', (_label, start, end) => {
    seedGkgBothFeeds(fixture.handle, [at('1100'), at('1130'), at('1145')]);
    seedGkgSlots(fixture.handle, [
      { feed: 'english', slot: at('1115') },
      { feed: 'translation', slot: at('1115'), status: 'gap' },
    ]);
    expect(executeMirrorRequest(fixture.handle, volRaw(start, end))).toEqual({
      outcome: 'outside_coverage',
      detail:
        'The requested window shares no slot with the GKG mirror, which covers 2026-11-01T11:00:00Z to 2026-11-01T11:45:00Z.',
      oldestSlot: at('1100'),
      newestSlot: at('1145'),
    });
  });

  it('clips the requested window to coverage and counts slots missing from either feed', () => {
    seedGkgBothFeeds(fixture.handle, [at('1000'), at('1015'), at('1100'), at('1115')]);
    seedGkgSlots(fixture.handle, [
      { feed: 'english', slot: at('1030') },
      { feed: 'translation', slot: at('1030'), status: 'gap' },
      { feed: 'english', slot: at('1045'), status: 'gap' },
      { feed: 'translation', slot: at('1045'), status: 'gap' },
      { feed: 'english', slot: at('1130') },
    ]);
    const response = answered(fixture, volRaw('20261101090000', '20261101120000'));
    expect(response.coverage).toEqual({
      requestedStart: '2026-11-01T09:00:00Z',
      requestedEnd: '2026-11-01T12:00:00Z',
      answeredStart: '2026-11-01T10:00:00Z',
      answeredEnd: '2026-11-01T11:15:00Z',
      missingSlots: 2,
    });
  });

  it('keeps an unclipped window as requested, with no missing slots', () => {
    seedGkgBothFeeds(fixture.handle, gkgSlotsBetween(at('1000'), at('1200')));
    expect(answered(fixture, volRaw('20261101100700', '20261101114459')).coverage).toEqual({
      requestedStart: '2026-11-01T10:07:00Z',
      requestedEnd: '2026-11-01T11:44:59Z',
      answeredStart: '2026-11-01T10:07:00Z',
      answeredEnd: '2026-11-01T11:44:59Z',
      missingSlots: 0,
    });
  });
});

// ─── Timelines ────────────────────────────────────────────────────────────────

describe('executeMirrorRequest — timelines', () => {
  let fixture: GkgMirrorFixture;
  const window = { startDatetime: at('1100'), endDatetime: '20261101121459' };
  const themed = (url: string, date: string, extra: Partial<GkgArticleRow> = {}) =>
    gkgRow({ url, date, domain: 'a.com', themes: 'TAX_FNCACT', ...extra });
  const plain = (url: string, date: string, extra: Partial<GkgArticleRow> = {}) =>
    gkgRow({ url, date, domain: 'a.com', ...extra });

  beforeAll(async () => {
    fixture = await openGkgMirrorFixture();
    // Both feeds through 11:45; 12:00 is English-only, past the newest both-feed slot.
    seedGkgBothFeeds(fixture.handle, [at('1100'), at('1115'), at('1130'), at('1145')]);
    seedGkgSlots(fixture.handle, [{ feed: 'english', slot: at('1200') }]);
    await seedGkgRows(fixture.store, [
      // 11:00 — 3 of 4 match, across both feeds' languages.
      themed('u/1100a', at('1100'), { tone: -2 }),
      themed('u/1100b', at('1100'), { tone: 4, language: 'deu' }),
      themed('u/1100c', at('1100'), { tone: null, language: 'spa' }),
      plain('u/1100d', at('1100'), { tone: 9 }),
      // 11:15 — rows, none matching.
      plain('u/1115a', at('1115')),
      plain('u/1115b', at('1115')),
      // 11:30 — no rows at all.
      // 11:45 — 1 of 2 match.
      themed('u/1145a', at('1145'), { tone: 1 }),
      plain('u/1145b', at('1145')),
      // 12:00 — past coverage.
      themed('u/1200a', at('1200')),
    ]);
  });
  afterAll(async () => {
    await fixture.cleanup();
  });

  const timeline = (
    mode: Extract<MirrorRequest, { kind: 'timeline' }>['mode'],
    smoothing?: number,
  ) =>
    answered(fixture, {
      kind: 'timeline',
      mode,
      plan: plan('theme:TAX_FNCACT'),
      window,
      ...(smoothing !== undefined && { smoothing }),
    });

  it('timelinevol: 100 × matches ÷ every row of the bucket across both feeds; 0 where nothing matched', () => {
    const response = timeline('timelinevol');
    expect(resultOf(response, 'timeline').result).toEqual([
      {
        label: 'Volume Intensity',
        data: [
          { date: '2026-11-01T11:00:00Z', value: 75 },
          { date: '2026-11-01T11:15:00Z', value: 0 },
          { date: '2026-11-01T11:30:00Z', value: 0 },
          { date: '2026-11-01T11:45:00Z', value: 50 },
        ],
      },
    ]);
    expect(response.matched).toBe(4);
  });

  it('timelinevolraw: matches and norm per bucket', () => {
    expect(resultOf(timeline('timelinevolraw'), 'timeline').result).toEqual([
      {
        label: 'Article Count',
        data: [
          { date: '2026-11-01T11:00:00Z', value: 3, norm: 4 },
          { date: '2026-11-01T11:15:00Z', value: 0, norm: 2 },
          { date: '2026-11-01T11:30:00Z', value: 0, norm: 0 },
          { date: '2026-11-01T11:45:00Z', value: 1, norm: 2 },
        ],
      },
    ]);
  });

  it('smooths as a trailing mean, omits the leading steps, and leaves norm unsmoothed', () => {
    expect(resultOf(timeline('timelinevolraw', 2), 'timeline').result[0]?.data).toEqual([
      { date: '2026-11-01T11:15:00Z', value: 1.5, norm: 2 },
      { date: '2026-11-01T11:30:00Z', value: 0, norm: 0 },
      { date: '2026-11-01T11:45:00Z', value: 0.5, norm: 2 },
    ]);
    expect(resultOf(timeline('timelinevol', 3), 'timeline').result[0]?.data).toEqual([
      { date: '2026-11-01T11:30:00Z', value: 25 },
      { date: '2026-11-01T11:45:00Z', value: 50 / 3 },
    ]);
    expect(resultOf(timeline('timelinevol', 5), 'timeline').result[0]?.data).toEqual([]);
  });

  it('timelinetone: mean tone of matches; a bucket without a toned match is absent', () => {
    const response = timeline('timelinetone');
    expect(resultOf(response, 'timeline').result).toEqual([
      {
        label: 'Average Tone',
        data: [
          { date: '2026-11-01T11:00:00Z', value: 1 },
          { date: '2026-11-01T11:45:00Z', value: 1 },
        ],
      },
    ]);
    expect(response.matched).toBe(4);
  });

  it('timelinevolinfo: volume with newest-first references for a filter-only plan', () => {
    const data = resultOf(timeline('timelinevolinfo'), 'timeline').result[0]?.data;
    expect(data?.map((p) => p.articles?.map((a) => a.url))).toEqual([
      ['u/1100c', 'u/1100b', 'u/1100a'],
      undefined,
      undefined,
      ['u/1145a'],
    ]);
    expect(data?.[0]?.value).toBe(75);
  });

  it('caps references at 10 per bucket', async () => {
    const busy = await openGkgMirrorFixture();
    seedGkgBothFeeds(busy.handle, [at('1100')]);
    await seedGkgRows(
      busy.store,
      Array.from({ length: 12 }, (_, i) => themed(`u/${String(i).padStart(2, '0')}`, at('1100'))),
    );
    const data = resultOf(
      answered(busy, {
        kind: 'timeline',
        mode: 'timelinevolinfo',
        plan: plan('theme:TAX_FNCACT'),
        window,
      }),
      'timeline',
    ).result[0]?.data;
    expect(data?.[0]?.articles?.map((a) => a.url)).toEqual(
      ['11', '10', '09', '08', '07', '06', '05', '04', '03', '02'].map((n) => `u/${n}`),
    );
    expect(data?.[0]?.value).toBe(100);
    await busy.cleanup();
  });

  it('includes rows on both window boundaries', () => {
    const response = answered(fixture, {
      kind: 'timeline',
      mode: 'timelinevolraw',
      plan: plan('theme:TAX_FNCACT'),
      window: { startDatetime: at('1100'), endDatetime: at('1145') },
    });
    expect(response.matched).toBe(4);
  });
});

describe('executeMirrorRequest — bucket width follows the requested window', () => {
  let fixture: GkgMirrorFixture;
  beforeAll(async () => {
    fixture = await openGkgMirrorFixture();
    seedGkgBothFeeds(fixture.handle, gkgSlotsBetween('20261101100000', '20261101114500'));
    await seedGkgRows(fixture.store, [
      gkgRow({ url: 'u/a', date: '20261101100000', domain: 'a.com', themes: 'TAX_FNCACT' }),
      gkgRow({ url: 'u/b', date: '20261101113000', domain: 'a.com', themes: 'TAX_FNCACT' }),
    ]);
  });
  afterAll(async () => {
    await fixture.cleanup();
  });

  const dates = (start: string, end: string) =>
    resultOf(
      answered(fixture, {
        kind: 'timeline',
        mode: 'timelinevolraw',
        plan: plan('theme:TAX_FNCACT'),
        window: { startDatetime: start, endDatetime: end },
      }),
      'timeline',
    ).result[0]?.data.map((p) => p.date);

  it('uses 15-minute buckets under 72 hours (71 h)', () => {
    expect(dates('20261029130000', '20261101120000')).toHaveLength(8);
  });

  it('emits only buckets that hold a slot inside an unaligned window', () => {
    expect(dates('20261101100700', '20261101104459')).toEqual([
      '2026-11-01T10:15:00Z',
      '2026-11-01T10:30:00Z',
    ]);
  });

  it('uses hourly buckets from 72 hours (72 h)', () => {
    expect(dates('20261029120000', '20261101120000')).toEqual([
      '2026-11-01T10:00:00Z',
      '2026-11-01T11:00:00Z',
    ]);
  });

  it('uses hourly buckets up to one week (7 d)', () => {
    expect(dates('20261025120000', '20261101120000')).toEqual([
      '2026-11-01T10:00:00Z',
      '2026-11-01T11:00:00Z',
    ]);
  });

  it('uses daily buckets past one week (7 d + 1 s, 8 d)', () => {
    expect(dates('20261025115959', '20261101120000')).toEqual(['2026-11-01T00:00:00Z']);
    expect(dates('20261024120000', '20261101120000')).toEqual(['2026-11-01T00:00:00Z']);
  });
});

// ─── Tone histogram ───────────────────────────────────────────────────────────

describe('executeMirrorRequest — tonechart', () => {
  let fixture: GkgMirrorFixture;
  beforeAll(async () => {
    fixture = await openGkgMirrorFixture();
    seedGkgBothFeeds(fixture.handle, [at('1100'), at('1115')]);
    const row = (url: string, tone: number | null, date = at('1100')) =>
      gkgRow({ url, date, domain: 'a.com', themes: 'TAX_FNCACT', tone, title: url });
    await seedGkgRows(fixture.store, [
      row('u/neg-half', -0.5),
      row('u/pos-0.4', 0.4),
      row('u/neg-one', -1),
      row('u/neg-1.5', -1.5),
      row('u/pos-1.9', 1.9),
      row('u/neg-24', -24.19),
      row('u/null', null),
      row('u/later-0.2', 0.2, at('1115')),
      gkgRow({ url: 'u/other', date: at('1100'), domain: 'a.com', tone: 0 }),
    ]);
  });
  afterAll(async () => {
    await fixture.cleanup();
  });

  it('bins tone truncated toward zero, newest first, and counts toneless matches in matched', () => {
    const response = answered(fixture, {
      kind: 'tonechart',
      plan: plan('theme:TAX_FNCACT'),
      window: { startDatetime: at('1100'), endDatetime: at('1115') },
    });
    const bins = resultOf(response, 'tonechart').result;
    expect(bins.map((b) => [b.bin, b.count])).toEqual([
      [-24, 1],
      [-1, 2],
      [0, 3],
      [1, 1],
    ]);
    expect(Object.is(bins[2]?.bin, 0)).toBe(true);
    expect(bins[2]?.articles).toEqual([
      { url: 'u/later-0.2', title: 'u/later-0.2' },
      { url: 'u/pos-0.4', title: 'u/pos-0.4' },
      { url: 'u/neg-half', title: 'u/neg-half' },
    ]);
    expect(response.matched).toBe(8);
  });

  it('caps references at 10 per bin', async () => {
    const busy = await openGkgMirrorFixture();
    seedGkgBothFeeds(busy.handle, [at('1100')]);
    await seedGkgRows(
      busy.store,
      Array.from({ length: 15 }, (_, i) =>
        gkgRow({
          url: `u/${i}`,
          date: at('1100'),
          domain: 'a.com',
          themes: 'TAX_FNCACT',
          tone: 0.1,
        }),
      ),
    );
    const bins = resultOf(
      answered(busy, {
        kind: 'tonechart',
        plan: plan('theme:TAX_FNCACT'),
        window: { startDatetime: at('1100'), endDatetime: at('1100') },
      }),
      'tonechart',
    ).result;
    expect(bins).toHaveLength(1);
    expect(bins[0]?.count).toBe(15);
    expect(bins[0]?.articles).toHaveLength(10);
    await busy.cleanup();
  });

  it('returns no bins when nothing matches', () => {
    const response = answered(fixture, {
      kind: 'tonechart',
      plan: plan('theme:NOT_PRESENT'),
      window: { startDatetime: at('1100'), endDatetime: at('1115') },
    });
    expect(resultOf(response, 'tonechart').result).toEqual([]);
    expect(response.matched).toBe(0);
  });
});

// ─── Breakdowns ───────────────────────────────────────────────────────────────

describe('executeMirrorRequest — breakdowns', () => {
  let fixture: GkgMirrorFixture;
  const window = { startDatetime: at('1100'), endDatetime: at('1115') };
  beforeAll(async () => {
    fixture = await openGkgMirrorFixture();
    seedGkgBothFeeds(fixture.handle, [at('1100'), at('1115')]);
    const row = (
      url: string,
      date: string,
      language: string,
      country: string | null,
      match: boolean,
    ) =>
      gkgRow({
        url,
        date,
        domain: 'a.com',
        language,
        source_country: country,
        themes: match ? 'TAX_FNCACT' : '',
      });
    await seedGkgRows(fixture.store, [
      row('u/e1', at('1100'), 'eng', 'US', true),
      row('u/e2', at('1100'), 'eng', 'US', true),
      row('u/e3', at('1100'), 'eng', 'UK', true),
      row('u/e4', at('1100'), 'eng', null, false),
      row('u/d1', at('1100'), 'deu', 'GM', true),
      row('u/d2', at('1100'), 'deu', 'GM', false),
      row('u/s1', at('1100'), 'spa', 'SP', false),
      row('u/r1', at('1100'), 'srp', 'RI', true),
      row('u/r2', at('1100'), 'srp', 'RB', true),
      row('u/r3', at('1100'), 'srp', 'RB', false),
      row('u/x1', at('1100'), 'xyz', null, true),
      row('u/o1', at('1100'), 'eng', 'OC', true),
      row('u/e5', at('1115'), 'eng', 'US', false),
    ]);
  });
  afterAll(async () => {
    await fixture.cleanup();
  });

  const breakdown = (mode: 'timelinelang' | 'timelinesourcecountry', smoothing?: number) =>
    answered(fixture, {
      kind: 'breakdown',
      mode,
      plan: plan('theme:TAX_FNCACT'),
      window,
      ...(smoothing !== undefined && { smoothing }),
    });

  it('timelinelang: each language over its own rows, labelled `<Name> Volume Intensity`', () => {
    const response = breakdown('timelinelang');
    const result = resultOf(response, 'breakdown');
    expect(result.result).toEqual([
      {
        label: 'English Volume Intensity',
        data: [
          { date: '2026-11-01T11:00:00Z', value: 80 },
          { date: '2026-11-01T11:15:00Z', value: 0 },
        ],
      },
      {
        label: 'Serbian Volume Intensity',
        data: [
          { date: '2026-11-01T11:00:00Z', value: (100 * 2) / 3 },
          { date: '2026-11-01T11:15:00Z', value: 0 },
        ],
      },
      {
        label: 'German Volume Intensity',
        data: [
          { date: '2026-11-01T11:00:00Z', value: 50 },
          { date: '2026-11-01T11:15:00Z', value: 0 },
        ],
      },
      {
        label: 'xyz Volume Intensity',
        data: [
          { date: '2026-11-01T11:00:00Z', value: 100 },
          { date: '2026-11-01T11:15:00Z', value: 0 },
        ],
      },
    ]);
    expect(result.excludedWithoutCountry).toBeUndefined();
    expect(response.matched).toBe(8);
  });

  it('timelinesourcecountry: merges codes sharing a name and excludes rows without a named country', () => {
    const result = resultOf(breakdown('timelinesourcecountry'), 'breakdown');
    expect(result.result.map((s) => [s.label, s.data[0]?.value])).toEqual([
      ['Serbia Volume Intensity', (100 * 2) / 3],
      ['United States Volume Intensity', 100],
      ['Germany Volume Intensity', 50],
      ['United Kingdom Volume Intensity', 100],
    ]);
    expect(result.result.every((s) => s.label.endsWith(' Volume Intensity'))).toBe(true);
    expect(result.excludedWithoutCountry).toBe(2);
  });

  it('smooths each breakdown series', () => {
    const result = resultOf(breakdown('timelinelang', 2), 'breakdown');
    expect(result.result[0]).toEqual({
      label: 'English Volume Intensity',
      data: [{ date: '2026-11-01T11:15:00Z', value: 40 }],
    });
  });
});

// ─── Artlist ──────────────────────────────────────────────────────────────────

describe('executeMirrorRequest — artlist', () => {
  let fixture: GkgMirrorFixture;
  const window = { startDatetime: at('1100'), endDatetime: at('1145') };
  beforeAll(async () => {
    fixture = await openGkgMirrorFixture();
    seedGkgBothFeeds(fixture.handle, [at('1100'), at('1115'), at('1130'), at('1145')]);
    await seedGkgRows(fixture.store, [
      gkgRow({
        url: 'u/flood-strong',
        date: at('1100'),
        domain: 'reuters.com',
        title: 'Flood flood flood',
        tone: -6,
        language: 'deu',
        source_country: 'US',
        image: 'https://img.example/a.jpg',
        themes: 'NATURAL_DISASTER',
      }),
      gkgRow({
        url: 'u/flood-weak',
        date: at('1145'),
        domain: 'bbc.co.uk',
        title: 'Report says a flood may come after many dry weeks across the region this year',
        tone: 3,
        language: 'xyz',
        source_country: null,
        themes: 'NATURAL_DISASTER',
      }),
      gkgRow({
        url: 'u/no-keyword',
        date: at('1130'),
        domain: 'apnews.com',
        title: 'Storm season',
        tone: 0.5,
        source_country: 'OC',
        themes: 'NATURAL_DISASTER',
      }),
      gkgRow({
        url: 'u/null-tone',
        date: at('1115'),
        domain: 'apnews.com',
        title: 'Quiet day',
        tone: null,
        themes: 'NATURAL_DISASTER',
      }),
    ]);
  });
  afterAll(async () => {
    await fixture.cleanup();
  });

  const urls = (
    query: string,
    sort: Extract<MirrorRequest, { kind: 'artlist' }>['sort'],
    maxRecords = 250,
  ) =>
    resultOf(
      answered(fixture, { kind: 'artlist', plan: plan(query), window, maxRecords, sort }),
      'artlist',
    ).result.articles.map((a) => a.url);

  it.each([
    ['dateDesc', ['u/flood-weak', 'u/no-keyword', 'u/null-tone', 'u/flood-strong']],
    ['dateAsc', ['u/flood-strong', 'u/null-tone', 'u/no-keyword', 'u/flood-weak']],
    ['toneDesc', ['u/flood-weak', 'u/no-keyword', 'u/flood-strong', 'u/null-tone']],
    ['toneAsc', ['u/flood-strong', 'u/no-keyword', 'u/flood-weak', 'u/null-tone']],
    ['relevance', ['u/flood-weak', 'u/no-keyword', 'u/null-tone', 'u/flood-strong']],
    ['hybridRel', ['u/flood-weak', 'u/no-keyword', 'u/null-tone', 'u/flood-strong']],
  ] as const)('sorts a filter-only plan by %s', (sort, expected) => {
    expect(urls('theme:NATURAL_DISASTER', sort)).toEqual(expected);
  });

  it.each(['relevance', 'hybridRel'] as const)(
    'ranks keyword matches by bm25 under %s, rows without a keyword hit last',
    (sort) => {
      expect(urls('(flood OR domainis:apnews.com)', sort)).toEqual([
        'u/flood-strong',
        'u/flood-weak',
        'u/no-keyword',
        'u/null-tone',
      ]);
    },
  );

  it('maps each row to DOC article fields', () => {
    const response = answered(fixture, {
      kind: 'artlist',
      plan: plan('theme:NATURAL_DISASTER'),
      window,
      maxRecords: 250,
      sort: 'dateAsc',
    });
    expect(resultOf(response, 'artlist').result).toEqual({
      totalReturned: 4,
      articles: [
        {
          url: 'u/flood-strong',
          title: 'Flood flood flood',
          seendate: '20261101T110000Z',
          domain: 'reuters.com',
          language: 'German',
          sourcecountry: 'United States',
          socialimage: 'https://img.example/a.jpg',
        },
        {
          url: 'u/null-tone',
          title: 'Quiet day',
          seendate: '20261101T111500Z',
          domain: 'apnews.com',
          language: 'English',
          sourcecountry: '',
        },
        {
          url: 'u/no-keyword',
          title: 'Storm season',
          seendate: '20261101T113000Z',
          domain: 'apnews.com',
          language: 'English',
          sourcecountry: '',
        },
        {
          url: 'u/flood-weak',
          title: 'Report says a flood may come after many dry weeks across the region this year',
          seendate: '20261101T114500Z',
          domain: 'bbc.co.uk',
          language: 'xyz',
          sourcecountry: '',
        },
      ],
    });
    expect(response.matched).toBe(4);
  });

  it('returns an empty list with matched 0 when nothing matches', () => {
    const response = answered(fixture, {
      kind: 'artlist',
      plan: plan('theme:NOT_PRESENT'),
      window,
      maxRecords: 75,
      sort: 'relevance',
    });
    expect(resultOf(response, 'artlist').result).toEqual({ articles: [], totalReturned: 0 });
    expect(response.matched).toBe(0);
  });

  it('honors maxRecords up to 250 and reports every match in matched', async () => {
    const busy = await openGkgMirrorFixture();
    seedGkgBothFeeds(busy.handle, [at('1100')]);
    await seedGkgRows(
      busy.store,
      Array.from({ length: 300 }, (_, i) =>
        gkgRow({
          url: `u/${String(i).padStart(3, '0')}`,
          date: at('1100'),
          domain: 'a.com',
          themes: 'X1',
        }),
      ),
    );
    const list = (maxRecords: number) =>
      answered(busy, {
        kind: 'artlist',
        plan: plan('theme:X1'),
        window: { startDatetime: at('1100'), endDatetime: at('1100') },
        maxRecords,
        sort: 'dateDesc',
      });
    const full = list(250);
    expect(resultOf(full, 'artlist').result.totalReturned).toBe(250);
    expect(full.matched).toBe(300);
    expect(resultOf(list(1), 'artlist').result.articles.map((a) => a.url)).toEqual(['u/000']);
    await busy.cleanup();
  });
});

// ─── Predicates ───────────────────────────────────────────────────────────────

describe('executeMirrorRequest — predicates', () => {
  let fixture: GkgMirrorFixture;
  beforeAll(async () => {
    fixture = await openGkgMirrorFixture();
    seedGkgBothFeeds(fixture.handle, [at('1100')]);
    const row = (url: string, fields: Partial<GkgArticleRow> & { domain: string }) =>
      gkgRow({ url, date: at('1100'), ...fields });
    await seedGkgRows(fixture.store, [
      row('u/un', {
        domain: 'un.org',
        tone: -6,
        language: 'eng',
        source_country: 'US',
        themes: 'MANMADE_DISASTER',
      }),
      row('u/catholicsun', {
        domain: 'catholicsun.org',
        tone: 6,
        language: 'deu',
        source_country: 'GM',
      }),
      row('u/unorg', {
        domain: 'unorg.com',
        tone: 0.5,
        language: 'spa',
        themes: 'MANMADE_DISASTER_IMPLIED',
      }),
      row('u/un-uk', {
        domain: 'un.org.uk',
        tone: -12,
        language: 'eng',
        source_country: 'UK',
        themes: 'TAX_FNCACT',
      }),
      row('u/null', {
        domain: 'example.com',
        tone: null,
        title: 'Tax vote tonight',
        themes: 'TAX_FNCACT',
      }),
    ]);
  });
  afterAll(async () => {
    await fixture.cleanup();
  });

  const matching = (query: string) =>
    resultOf(
      answered(fixture, {
        kind: 'artlist',
        plan: plan(query),
        window: { startDatetime: at('1100'), endDatetime: at('1100') },
        maxRecords: 250,
        sort: 'dateDesc',
      }),
      'artlist',
    )
      .result.articles.map((a) => a.url)
      .sort();

  it.each([
    ['domain:un.org', ['u/catholicsun', 'u/un']],
    ['domainis:un.org', ['u/un']],
    ['-domain:un.org', ['u/null', 'u/un-uk', 'u/unorg']],
    ['sourcelang:german', ['u/catholicsun']],
    ['sourcelang:eng', ['u/null', 'u/un', 'u/un-uk']],
    ['sourcecountry:unitedstates', ['u/un']],
    ['-sourcecountry:US', ['u/catholicsun', 'u/null', 'u/un-uk', 'u/unorg']],
    ['tone<-5', ['u/un', 'u/un-uk']],
    ['tone>5', ['u/catholicsun']],
    ['-tone>5', ['u/null', 'u/un', 'u/un-uk', 'u/unorg']],
    ['toneabs<1', ['u/unorg']],
    ['toneabs>10', ['u/un-uk']],
    ['theme:MANMADE_DISASTER', ['u/un']],
    ['theme:MANMADE_DISASTER_IMPLIED', ['u/unorg']],
    ['-theme:MANMADE_DISASTER', ['u/catholicsun', 'u/null', 'u/un-uk', 'u/unorg']],
    ['theme:TAX_FNCACT -tax', ['u/un-uk']],
    ['tax', ['u/null']],
    ['(theme:MANMADE_DISASTER OR domainis:unorg.com)', ['u/un', 'u/unorg']],
    ['(tax OR toneabs>10)', ['u/null', 'u/un-uk']],
    ['(sourcelang:deu OR sourcelang:spa) tone>0', ['u/catholicsun', 'u/unorg']],
    ['domain:un.org -theme:MANMADE_DISASTER', ['u/catholicsun']],
    ['theme:TAX_FNCACT sourcecountry:UK', ['u/un-uk']],
  ])('%s', (query, urls) => {
    expect(matching(query)).toEqual(urls);
  });

  it('never matches a keyword against a theme token', () => {
    expect(matching('fncact')).toEqual([]);
    expect(matching('disaster')).toEqual([]);
  });
});

// ─── Windows narrower than the store ──────────────────────────────────────────

describe('executeMirrorRequest — windows narrower than the store', () => {
  let fixture: GkgMirrorFixture;
  const themed = (url: string, date: string, title = '') =>
    gkgRow({ url, date, domain: 'a.com', themes: 'TAX_FNCACT', title });
  const plain = (url: string, date: string) => gkgRow({ url, date, domain: 'a.com' });

  beforeAll(async () => {
    fixture = await openGkgMirrorFixture();
    seedGkgBothFeeds(fixture.handle, [at('1100'), at('1115'), at('1130'), at('1145'), at('1200')]);
    /**
     * Rowids follow ingest order, not slot order: 11:15 lands before a late 11:00, and the
     * upsert moves u/moved from 11:15 to 11:30 under the rowid it took first.
     */
    await seedGkgRows(fixture.store, [
      themed('u/b1', at('1115'), 'Flood warning'),
      plain('u/b2', at('1115')),
      themed('u/moved', at('1115'), 'Storm'),
    ]);
    await seedGkgRows(fixture.store, [
      themed('u/a1', at('1100'), 'Flood flood flood'),
      plain('u/a2', at('1100')),
    ]);
    await seedGkgRows(fixture.store, [themed('u/d1', at('1145'), 'Flood flood flood')]);
    await seedGkgRows(fixture.store, [themed('u/moved', at('1130'), 'Flood report')]);
  });
  afterAll(async () => {
    await fixture.cleanup();
  });

  const list = (
    query: string,
    start: string,
    end: string,
    sort: Extract<MirrorRequest, { kind: 'artlist' }>['sort'] = 'dateDesc',
  ) => {
    const response = answered(fixture, {
      kind: 'artlist',
      plan: plan(query),
      window: { startDatetime: start, endDatetime: end },
      maxRecords: 250,
      sort,
    });
    const urls = resultOf(response, 'artlist').result.articles.map((a) => a.url);
    expect(response.matched).toBe(urls.length);
    return urls;
  };

  it.each([
    ['an upserted row under its first rowid', at('1130'), at('1130'), ['u/moved'], []],
    ['a slot ingested late', at('1100'), at('1100'), ['u/a1'], ['u/a2']],
    ['slots ingested out of order', at('1100'), at('1115'), ['u/a1', 'u/b1'], ['u/a2', 'u/b2']],
    ['a covered slot without rows', at('1200'), at('1200'), [], []],
  ])('matches and excludes FTS rows in %s', (_label, start, end, matching, excluded) => {
    expect(list('theme:TAX_FNCACT', start, end).sort()).toEqual(matching);
    expect(list('-theme:TAX_FNCACT', start, end).sort()).toEqual(excluded);
  });

  it('matches keywords against the rows the window holds, by their current title', () => {
    expect(list('flood', at('1115'), at('1130')).sort()).toEqual(['u/b1', 'u/moved']);
    expect(list('-flood', at('1100'), at('1115')).sort()).toEqual(['u/a2', 'u/b2']);
  });

  it('ranks only the window’s keyword matches under relevance', () => {
    expect(list('flood', at('1100'), at('1130'), 'relevance')).toEqual(['u/a1', 'u/moved', 'u/b1']);
  });

  it('counts each row in the slot its stored date names', () => {
    const response = answered(fixture, {
      kind: 'timeline',
      mode: 'timelinevolraw',
      plan: plan('theme:TAX_FNCACT'),
      window: { startDatetime: at('1100'), endDatetime: at('1200') },
    });
    expect(resultOf(response, 'timeline').result[0]?.data).toEqual([
      { date: '2026-11-01T11:00:00Z', value: 1, norm: 2 },
      { date: '2026-11-01T11:15:00Z', value: 1, norm: 2 },
      { date: '2026-11-01T11:30:00Z', value: 1, norm: 1 },
      { date: '2026-11-01T11:45:00Z', value: 1, norm: 1 },
      { date: '2026-11-01T12:00:00Z', value: 0, norm: 0 },
    ]);
    expect(response.matched).toBe(4);
  });
});

// ─── Artlist boundary ─────────────────────────────────────────────────────────

describe('executeMirrorRequest — artlist ties at the maxRecords boundary', () => {
  let fixture: GkgMirrorFixture;
  const window = { startDatetime: at('1100'), endDatetime: at('1100') };
  beforeAll(async () => {
    fixture = await openGkgMirrorFixture();
    seedGkgBothFeeds(fixture.handle, [at('1100')]);
    // Inserted against url order, so rowid order and url order disagree on every tie.
    const row = (url: string, title: string) =>
      gkgRow({ url, date: at('1100'), domain: 'a.com', themes: 'TAX_FNCACT', tone: 1, title });
    await seedGkgRows(fixture.store, [
      ...['u/e', 'u/d', 'u/c', 'u/b', 'u/a'].map((url) => row(url, 'Flood warning')),
      row('u/z', 'Flood flood flood'),
    ]);
  });
  afterAll(async () => {
    await fixture.cleanup();
  });

  const urls = (
    query: string,
    sort: Extract<MirrorRequest, { kind: 'artlist' }>['sort'],
    maxRecords: number,
  ) =>
    resultOf(
      answered(fixture, { kind: 'artlist', plan: plan(query), window, maxRecords, sort }),
      'artlist',
    ).result.articles.map((a) => a.url);

  it.each([
    ['flood', 'relevance', 3, ['u/z', 'u/a', 'u/b']],
    ['flood', 'hybridRel', 3, ['u/z', 'u/a', 'u/b']],
    ['flood', 'relevance', 250, ['u/z', 'u/a', 'u/b', 'u/c', 'u/d', 'u/e']],
    ['theme:TAX_FNCACT', 'toneDesc', 2, ['u/a', 'u/b']],
    ['theme:TAX_FNCACT', 'toneAsc', 2, ['u/a', 'u/b']],
    ['theme:TAX_FNCACT', 'dateDesc', 4, ['u/a', 'u/b', 'u/c', 'u/d']],
    ['theme:TAX_FNCACT', 'dateAsc', 1, ['u/a']],
  ] as const)('%s by %s, %i records: ties resolve by url', (query, sort, maxRecords, expected) => {
    expect(urls(query, sort, maxRecords)).toEqual(expected);
  });
});

// ─── Column predicates beside FTS membership ──────────────────────────────────

describe('executeMirrorRequest — column predicates beside FTS membership', () => {
  let fixture: GkgMirrorFixture;
  const window = { startDatetime: at('1100'), endDatetime: at('1100') };
  beforeAll(async () => {
    fixture = await openGkgMirrorFixture();
    seedGkgBothFeeds(fixture.handle, [at('1100')]);
    const row = (
      url: string,
      themes: string,
      language: string,
      tone: number | null,
      domain: string,
      country: string,
    ) => gkgRow({ url, date: at('1100'), domain, themes, language, tone, source_country: country });
    await seedGkgRows(fixture.store, [
      row('u/1', 'TAX_FNCACT', 'deu', -2.5, 'x.de', 'GM'),
      row('u/2', 'TAX_FNCACT', 'deu', 3.5, 'y.de', 'GM'),
      row('u/3', 'TAX_FNCACT', 'eng', 1.5, 'x.com', 'US'),
      row('u/4', '', 'deu', 0.5, 'x.de', 'GM'),
      row('u/5', 'TAX_FNCACT', 'spa', null, 'x.es', 'SP'),
    ]);
  });
  afterAll(async () => {
    await fixture.cleanup();
  });

  const request = (query: string, kind: RequestKind) =>
    answered(fixture, { ...kind, plan: plan(query), window } as MirrorRequest);
  const bins = (query: string) =>
    resultOf(request(query, { kind: 'tonechart' }), 'tonechart').result.map((b) => [
      b.bin,
      b.count,
    ]);
  const lang = (query: string) =>
    resultOf(request(query, { kind: 'breakdown', mode: 'timelinelang' }), 'breakdown').result.map(
      (s) => [s.label, s.data[0]?.value],
    );

  it('a language filter in the tone modes', () => {
    const query = 'theme:TAX_FNCACT sourcelang:deu';
    expect(bins(query)).toEqual([
      [-2, 1],
      [3, 1],
    ]);
    expect(
      resultOf(request(query, { kind: 'timeline', mode: 'timelinetone' }), 'timeline').result[0]
        ?.data,
    ).toEqual([{ date: '2026-11-01T11:00:00Z', value: 0.5 }]);
    expect(
      resultOf(request(query, { kind: 'timeline', mode: 'timelinevolraw' }), 'timeline').result[0]
        ?.data,
    ).toEqual([{ date: '2026-11-01T11:00:00Z', value: 2, norm: 5 }]);
    expect(lang(query)).toEqual([['German Volume Intensity', (100 * 2) / 3]]);
  });

  it('an OR group mixing FTS and a domain beside an excluded language', () => {
    const query = '(theme:TAX_FNCACT OR domainis:x.de) -sourcelang:eng';
    expect(bins(query)).toEqual([
      [-2, 1],
      [0, 1],
      [3, 1],
    ]);
    expect(request(query, { kind: 'tonechart' }).matched).toBe(4);
    const countries = resultOf(
      request(query, { kind: 'breakdown', mode: 'timelinesourcecountry' }),
      'breakdown',
    );
    expect(countries.result.map((s) => [s.label, s.data[0]?.value])).toEqual([
      ['Germany Volume Intensity', 100],
      ['Spain Volume Intensity', 100],
    ]);
    expect(countries.excludedWithoutCountry).toBe(0);
  });

  it('a tone filter in the breakdown modes', () => {
    expect(lang('theme:TAX_FNCACT tone>0')).toEqual([
      ['English Volume Intensity', 100],
      ['German Volume Intensity', 100 / 3],
    ]);
  });
});

// ─── Access path ──────────────────────────────────────────────────────────────

describe('executeMirrorRequest — access path to gkg_articles', () => {
  let fixture: GkgMirrorFixture;
  const window = { startDatetime: at('1100'), endDatetime: at('1115') };
  beforeAll(async () => {
    fixture = await openGkgMirrorFixture();
    seedGkgBothFeeds(fixture.handle, [at('1100'), at('1115')]);
    await seedGkgRows(fixture.store, [
      gkgRow({ url: 'u/1', date: at('1100'), domain: 'a.com', themes: 'TAX_FNCACT' }),
      gkgRow({ url: 'u/2', date: at('1115'), domain: 'b.com', title: 'Flood', tone: -3 }),
    ]);
  });
  afterAll(async () => {
    await fixture.cleanup();
  });

  /** Wraps a handle, recording each statement as it runs. */
  function recording(handle: SqliteHandle, sink: Array<{ sql: string; params: SqlValue[] }>) {
    return {
      close: () => handle.close(),
      exec: (sql: string) => handle.exec(sql),
      transaction: <T>(fn: () => T) => handle.transaction(fn),
      prepare<T>(sql: string) {
        const statement = handle.prepare<T>(sql);
        return {
          all: (...params: SqlValue[]) => {
            sink.push({ sql, params });
            return statement.all(...params);
          },
          get: (...params: SqlValue[]) => {
            sink.push({ sql, params });
            return statement.get(...params);
          },
          run: (...params: SqlValue[]) => statement.run(...params),
        };
      },
    } satisfies SqliteHandle;
  }

  const kinds: RequestKind[] = [
    ...(['dateDesc', 'dateAsc', 'toneDesc', 'toneAsc', 'relevance'] as const).map((sort) => ({
      kind: 'artlist' as const,
      maxRecords: 250,
      sort,
    })),
    ...(['timelinevol', 'timelinevolraw', 'timelinevolinfo', 'timelinetone'] as const).map(
      (mode) => ({ kind: 'timeline' as const, mode }),
    ),
    { kind: 'tonechart' },
    { kind: 'breakdown', mode: 'timelinelang' },
    { kind: 'breakdown', mode: 'timelinesourcecountry' },
  ];

  it.each(['theme:TAX_FNCACT', 'flood', 'theme:TAX_FNCACT -flood', '(flood OR domainis:a.com)'])(
    '%s: every mode reads matches through a date-leading index, never by FTS rowid',
    (query) => {
      for (const kind of kinds) {
        const statements: Array<{ sql: string; params: SqlValue[] }> = [];
        const request = { ...kind, plan: plan(query), window } as MirrorRequest;
        expect(executeMirrorRequest(recording(fixture.handle, statements), request).outcome).toBe(
          'answered',
        );
        const accesses = statements.flatMap(({ sql, params }) =>
          fixture.handle
            .prepare<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`)
            .all(...params)
            .map((row) => row.detail)
            .filter((detail) => /^(SEARCH|SCAN) a\b/.test(detail)),
        );
        expect(accesses.length, JSON.stringify(kind)).toBeGreaterThan(0);
        for (const access of accesses) {
          expect(access, JSON.stringify(kind)).toMatch(
            /^(SEARCH|SCAN) a USING (COVERING )?INDEX gkg_articles_date/,
          );
        }
      }
    },
  );
});

// ─── Store schema ─────────────────────────────────────────────────────────────

describe('gkg mirror store schema', () => {
  it('adds the (date, tone) index to a store built before it was declared', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gkg-mirror-upgrade-'));
    const path = join(dir, 'gkg-mirror.db');
    const indexNames = (handle: SqliteHandle) =>
      handle
        .prepare<{ name: string }>(`SELECT name FROM pragma_index_list('gkg_articles')`)
        .all()
        .map((row) => row.name);
    try {
      const spec = buildGkgMirrorStoreSpec(path);
      const before = sqliteMirrorStore({
        ...spec,
        indexes: (spec.indexes ?? []).filter((index) => index.columns.join(',') !== 'date,tone'),
      });
      await seedGkgRows(before, [
        gkgRow({ url: 'u/1', date: at('1100'), domain: 'a.com', themes: 'X1', tone: -1.5 }),
        gkgRow({ url: 'u/2', date: at('1100'), domain: 'a.com', themes: 'X1', tone: 2.5 }),
      ]);
      const old = await before.raw();
      seedGkgSlots(old, [
        { feed: 'english', slot: at('1100') },
        { feed: 'translation', slot: at('1100') },
      ]);
      expect(indexNames(old)).not.toContain('gkg_articles_date_tone_idx');
      await before.close();

      const after = sqliteMirrorStore(buildGkgMirrorStoreSpec(path));
      const handle = await after.raw();
      expect(indexNames(handle)).toContain('gkg_articles_date_tone_idx');
      const response = executeMirrorRequest(handle, {
        kind: 'tonechart',
        plan: plan('theme:X1'),
        window: { startDatetime: at('1100'), endDatetime: at('1100') },
      });
      expect(
        response.outcome === 'answered' &&
          response.answer.kind === 'tonechart' &&
          response.answer.result.map((b) => [b.bin, b.count]),
      ).toEqual([
        [-1, 1],
        [2, 1],
      ]);
      await after.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
