/**
 * @fileoverview The `stations` entry check every TV tool runs before its request: which entries
 * reach GDELT and in what form, which are refused and with what message and recovery hint, and
 * its cost on caller-sized entries. Per-tool wiring is in `input-validation.test.ts`. Also the
 * sentences an empty TV result carries for selected stations whose monitoring range its window
 * misses; per-tool wiring is in each tool's own suite.
 * @module tests/tools/station-ids.test
 */

import { readFileSync } from 'node:fs';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';
import type { GdeltWindow } from '@/mcp-server/tools/date-range.js';
import { describeStationRangeMisses, parseStationIds } from '@/mcp-server/tools/station-ids.js';
import type { StationRanges } from '@/services/gdelt/gdelt-tv-service.js';
import type { TvStation } from '@/services/gdelt/types.js';

/** The live 159-station catalog (captured 2026-09-24). */
const CATALOG = (
  JSON.parse(
    readFileSync(new URL('../fixtures/tv-station-catalog.json', import.meta.url), 'utf8'),
  ) as { stations: TvStation[] }
).stations;

const HINT =
  'Look each station up with gdelt_list_tv_stations and pass its stationId (e.g. FOXNEWS) in stations, not its description (e.g. "FOX News").';

/** Zero-width space, zero-width joiner, soft hyphen — by code point, since none is visible. */
const [ZWSP, ZWJ, SHY] = [0x200b, 0x200d, 0x00ad].map((cp) => String.fromCodePoint(cp));

/** The error `parseStationIds` throws for `stations`, failing the test when it returns instead. */
function refusal(stations: readonly string[]): McpError {
  try {
    parseStationIds(stations);
  } catch (error) {
    expect(error).toBeInstanceOf(McpError);
    return error as McpError;
  }
  throw new Error(`Expected ${JSON.stringify(stations)} to be refused`);
}

describe('parseStationIds — what reaches GDELT', () => {
  it.each<[string, string[] | undefined, string[]]>([
    ['no stations', undefined, []],
    ['an empty list', [], []],
    ['blank entries only', ['', '  ', '\t\r\n'], []],
    ['an ID', ['CNN'], ['CNN']],
    ['an ID with a trailing space', ['CNN '], ['CNN']],
    ['an ID with a leading space', [' CNN'], ['CNN']],
    ['an ID padded with Unicode spaces', [' CNN '], ['CNN']],
    [
      'IDs carrying invisible format characters (zero-width space, zero-width joiner, soft hyphen)',
      [`CNN${ZWSP}`, `${ZWJ}MSNBC`, `FOX${SHY}NEWS`],
      ['CNN', 'MSNBC', 'FOXNEWS'],
    ],
    ['IDs in any case, kept as sent', ['cnn', 'FoxNews', 'MSNBC'], ['cnn', 'FoxNews', 'MSNBC']],
    ['IDs around blanks, in order', ['MSNBC', '', ' CNN ', ' ', 'CNN'], ['MSNBC', 'CNN', 'CNN']],
  ])('%s', (_label, stations, expected) => {
    expect(parseStationIds(stations)).toEqual(expected);
  });

  it('keeps every entry of a long selection', () => {
    const stations = Array.from({ length: 200 }, (_, i) => `STATION${i}`);
    expect(parseStationIds(stations.map((id) => ` ${id} `))).toEqual(stations);
  });

  it('passes every station ID in the catalog unchanged', () => {
    const ids = CATALOG.map((station) => station.stationId);
    expect(ids).toHaveLength(159);
    expect(parseStationIds(ids)).toEqual(ids);
  });
});

describe('parseStationIds — refused entries', () => {
  it.each([
    'NHK - Japan (NHK)',
    'FOX News',
    '"CNN"',
    'network:CBS',
    'CNN OR station:MSNBC',
    'station:CNN',
    'CNN_W',
    'C\nNN',
    'ÁRD',
    'ＣＮＮ',
    '*CNN*',
  ])('refuses %j with invalid_query, naming it', (entry) => {
    const error = refusal(['CNN', entry]);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.message).toBe(
      `Invalid stations entry ${JSON.stringify(entry)}: stations takes station IDs such as CNN or FOXNEWS (letters and digits only), not display labels. Find a station's ID with gdelt_list_tv_stations.`,
    );
    expect(error.data).toEqual({ reason: 'invalid_query', recovery: { hint: HINT } });
  });

  it('names every refused entry, trimmed and in order, and no valid one', () => {
    const error = refusal([' FOX News ', 'CNN', 'NHK - Japan (NHK)']);
    expect(error.message).toBe(
      'Invalid stations entries "FOX News", "NHK - Japan (NHK)": stations takes station IDs such as CNN or FOXNEWS (letters and digits only), not display labels. Find a station\'s ID with gdelt_list_tv_stations.',
    );
    expect(error.data).toEqual({ reason: 'invalid_query', recovery: { hint: HINT } });
  });

  it('refuses every catalog label that is not letters and digits alone', () => {
    const labels = CATALOG.map((station) => station.description).filter((label) =>
      /[^A-Za-z0-9]/.test(label),
    );
    expect(labels.length).toBeGreaterThan(140);
    for (const label of labels) {
      expect(refusal([label]).message).toContain(JSON.stringify(label));
    }
  });
});

/**
 * One trim, one anchored character-class test, and — for a refused entry — one JSON encoding of
 * it into the message: the cost grows with the entry's length, never its square. Thread CPU,
 * never wall clock. Every sample reads the same number of characters (sixty-four 5k entries, one
 * 320k), so the per-call cost of a linear check grows 64× across the span and a quadratic one
 * 4,096×; the 256× bound sits between them. Sizes double, and the absolute cap is checked at
 * each before the next runs, so a quadratic regression fails at its first oversized step.
 */
describe('parseStationIds — cost on caller-sized entries', () => {
  const SIZES = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000];
  const CHARS_PER_SAMPLE = 320_000;
  const CAP_US_PER_CALL = 25_000;

  function perCallMicros(entry: string): number {
    const calls = CHARS_PER_SAMPLE / entry.length;
    let fastest = Number.POSITIVE_INFINITY;
    for (let sample = 0; sample < 5; sample++) {
      const start = process.threadCpuUsage();
      for (let i = 0; i < calls; i++) {
        try {
          parseStationIds([entry]);
        } catch {
          // A refused shape is timed through its refusal.
        }
      }
      const used = process.threadCpuUsage(start);
      fastest = Math.min(fastest, (used.user + used.system) / calls);
    }
    return fastest;
  }

  it.each<[string, (n: number) => string, (entry: string) => void]>([
    [
      'a long ID (one digit run)',
      (n) => '1'.repeat(n),
      (entry) => expect(parseStationIds([entry])).toEqual([entry]),
    ],
    [
      'one long line ending in a break',
      (n) => `${'x'.repeat(n - 2)}\ny`,
      (entry) => expect(refusal([entry]).message).toContain(JSON.stringify(entry)),
    ],
    [
      'breaks throughout',
      (n) => '  \r\n'.repeat(n / 4),
      (entry) => expect(parseStationIds([entry])).toEqual([]),
    ],
  ])('stays linear for %s', (_shape, build, check) => {
    const costs: number[] = [];
    for (const size of SIZES) {
      const entry = build(size);
      expect(entry).toHaveLength(size);
      check(entry);
      const cost = perCallMicros(entry);
      expect(cost, `${size} characters`).toBeLessThan(CAP_US_PER_CALL);
      costs.push(cost);
    }
    const [first = 0] = costs;
    expect(Math.max(costs.at(-1) ?? 0, 1) / Math.max(first, 1)).toBeLessThan(256);
  });
});

/**
 * The live catalog's ranges, keyed as the TV service keys them: CNN ran 2009-07-02 – 2024-10-10,
 * HLN 2009-07-02 – 2010-05-17, DW 2017-09-19 – 2024-10-10. No station in it is active.
 */
const RANGES: StationRanges = new Map(
  CATALOG.map(({ stationId, startDate, endDate, isActive }) => [
    stationId.toUpperCase(),
    { stationId, startDate, endDate, isActive },
  ]),
);

const window = (startDatetime: string, endDatetime: string): GdeltWindow => ({
  startDatetime,
  endDatetime,
});

/** A relative six-month window resolved on 2026-11-10 — after every station's range. */
const AFTER = window('20260510000000', '20261110000000');

const ONE_RANGE = ' Set startDatetime and endDatetime inside that range to search that station.';
const CNN_AFTER =
  ' CNN was monitored 2009-07-02 – 2024-10-10; the window starts after that range ends.';
const CNN_BEFORE =
  ' CNN was monitored 2009-07-02 – 2024-10-10; the window ends before that range starts.';

describe('describeStationRangeMisses', () => {
  it.each<[string, string[], GdeltWindow, string]>([
    ['a window after the range', ['CNN'], AFTER, CNN_AFTER + ONE_RANGE],
    [
      'a window starting the day after its last day',
      ['CNN'],
      window('20241011000000', '20241012000000'),
      CNN_AFTER + ONE_RANGE,
    ],
    [
      'a window starting in the last second of its last day',
      ['CNN'],
      window('20241010235959', '20241012000000'),
      '',
    ],
    [
      'a window before the range',
      ['CNN'],
      window('20080101000000', '20090101000000'),
      CNN_BEFORE + ONE_RANGE,
    ],
    [
      'a window ending the day before its first day',
      ['CNN'],
      window('20090601000000', '20090701235959'),
      CNN_BEFORE + ONE_RANGE,
    ],
    [
      'a window ending at the start of its first day',
      ['CNN'],
      window('20090601000000', '20090702000000'),
      '',
    ],
    ['a window inside the range', ['CNN'], window('20200101000000', '20200201000000'), ''],
    ['a window spanning the range', ['CNN'], window('20000101000000', '20260101000000'), ''],
    ['an ID in another case, named by its catalog ID', ['cnn'], AFTER, CNN_AFTER + ONE_RANGE],
    ['one ID sent twice, in two cases', ['CNN', 'cNn'], AFTER, CNN_AFTER + ONE_RANGE],
    ['an ID the catalog lacks', ['KZZZ'], AFTER, ''],
    ['no stations', [], AFTER, ''],
  ])('%s', (_label, stationIds, w, expected) => {
    expect(describeStationRangeMisses(stationIds, RANGES, w)).toBe(expected);
  });

  it('names only the stations whose range the window misses, in selection order', () => {
    expect(
      describeStationRangeMisses(
        ['DW', 'CNN', 'KZZZ', 'HLN'],
        RANGES,
        window('20120101000000', '20121231235959'),
      ),
    ).toBe(
      " DW was monitored 2017-09-19 – 2024-10-10; the window ends before that range starts. HLN was monitored 2009-07-02 – 2010-05-17; the window starts after that range ends. Set startDatetime and endDatetime inside a station's range to search that station.",
    );
  });

  it('names every catalog station for a window after all their ranges', () => {
    const sentences = describeStationRangeMisses(
      CATALOG.map((station) => station.stationId),
      RANGES,
      AFTER,
    );
    expect(sentences.match(/ was monitored /g)).toHaveLength(159);
    expect(sentences.match(/the window starts after that range ends\./g)).toHaveLength(159);
    expect(sentences).toMatch(
      / Set startDatetime and endDatetime inside a station's range to search that station\.$/,
    );
  });

  it.each([
    ['no start date', { stationId: 'X', startDate: '', endDate: '2010-01-01', isActive: false }],
    [
      'an end date GDELT sent unnormalized',
      { stationId: 'X', startDate: '2009-07-02', endDate: '20100101T235959Z', isActive: false },
    ],
  ])('names no range for a station with %s', (_label, range) => {
    expect(describeStationRangeMisses(['X'], new Map([['X', range]]), AFTER)).toBe('');
  });

  it('escapes the catalog ID it names', () => {
    const ranges = new Map([
      ['X', { stationId: 'X*', startDate: '2009-07-02', endDate: '2010-01-01', isActive: false }],
    ]);
    expect(describeStationRangeMisses(['x'], ranges, AFTER)).toBe(
      ` X\\* was monitored 2009-07-02 – 2010-01-01; the window starts after that range ends.${ONE_RANGE}`,
    );
  });
});

/**
 * A station still monitored when the catalog was read has an end date that moves on every day,
 * while the process keeps the one it read: a later window is no evidence it ended. Its start date
 * does not move, so a window before it is still named.
 */
describe('describeStationRangeMisses — a station active when the catalog was read', () => {
  /** The live ranges with CNN as a catalog read while it was still monitored would give it. */
  const CNN_ACTIVE: StationRanges = new Map([
    ...RANGES,
    ['CNN', { stationId: 'CNN', startDate: '2009-07-02', endDate: '2024-10-10', isActive: true }],
  ]);

  it.each<[string, StationRanges, GdeltWindow, string]>([
    ['an active station, for a window after its stored end date', CNN_ACTIVE, AFTER, ''],
    [
      'an active station, for a window starting the day after its stored end date',
      CNN_ACTIVE,
      window('20241011000000', '20241012000000'),
      '',
    ],
    [
      'an active station, for a window before its start',
      CNN_ACTIVE,
      window('20080101000000', '20090101000000'),
      CNN_BEFORE + ONE_RANGE,
    ],
    ['the same station inactive, for a window after its end', RANGES, AFTER, CNN_AFTER + ONE_RANGE],
  ])('%s', (_label, ranges, w, expected) => {
    expect(describeStationRangeMisses(['CNN'], ranges, w)).toBe(expected);
  });

  it('names only the inactive station in a mixed selection', () => {
    expect(describeStationRangeMisses(['CNN', 'HLN'], CNN_ACTIVE, AFTER)).toBe(
      ` HLN was monitored 2009-07-02 – 2010-05-17; the window starts after that range ends.${ONE_RANGE}`,
    );
  });
});
