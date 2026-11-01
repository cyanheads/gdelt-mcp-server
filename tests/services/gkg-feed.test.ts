/**
 * @fileoverview GKG feed layer of the local mirror: manifest parsing, slot arithmetic, row
 * mapping against real GKG rows, entity decoding, the single-entry zip check, and the paced
 * session at the `fetch` seam (User-Agent, 2 s pauses, 404 vs. refusal, MD5 on the manifest
 * slot, caller cancellation).
 * @module tests/services/gkg-feed.test
 */

import { describe, expect, it } from 'vitest';
import {
  addGkgSlots,
  decodeHtmlEntities,
  extractPageTitle,
  GkgFeedError,
  GkgFeedSession,
  inflateSingleEntryZip,
  minutesBetweenSlots,
  parseDomainCountryFile,
  parseGkgFile,
  parseGkgSlot,
  parseManifest,
} from '@/services/gkg-mirror/gkg-feed.js';
import {
  atSlot,
  buildGkgZip,
  DOMAIN_FILE_URL,
  MANIFEST_URL,
  manifestText,
  readGkgFixture,
  slotFileUrl,
  stubFeedTransport,
} from '../helpers/gkg-feed-fixtures.js';

const UA = 'gdelt-mcp-server (+https://github.com/cyanheads/gdelt-mcp-server)';
const noCountry = () => null;

describe('parseManifest', () => {
  it('returns the English GKG line with its URL on https, size, and MD5', () => {
    expect(parseManifest(readGkgFixture('lastupdate.txt'), 'english')).toEqual({
      feed: 'english',
      slot: '20261101120000',
      url: 'https://data.gdeltproject.org/gdeltv2/20261101120000.gkg.csv.zip',
      bytes: 2728270,
      md5: 'dde20037f067506a6614045ead6f164d',
    });
  });

  it('returns the translation GKG line', () => {
    expect(parseManifest(readGkgFixture('lastupdate-translation.txt'), 'translation')).toEqual({
      feed: 'translation',
      slot: '20261101114500',
      url: 'https://data.gdeltproject.org/gdeltv2/20261101114500.translation.gkg.csv.zip',
      bytes: 6850048,
      md5: '3111f3410065a479b1e6af335450a733',
    });
  });

  it('never takes the other feed’s GKG line', () => {
    expect(() => parseManifest(readGkgFixture('lastupdate-translation.txt'), 'english')).toThrow(
      GkgFeedError,
    );
    expect(() => parseManifest(readGkgFixture('lastupdate.txt'), 'translation')).toThrow(
      GkgFeedError,
    );
  });

  it.each([
    [
      'no GKG line',
      '40341 357e80f9e18cd6e4fde1930d0ae5551c http://data.gdeltproject.org/gdeltv2/20261101120000.export.CSV.zip\n',
    ],
    [
      'another host',
      '2728270 dde20037f067506a6614045ead6f164d http://example.com/gdeltv2/20261101120000.gkg.csv.zip\n',
    ],
    [
      'a slot off the 15-minute grid',
      '2728270 dde20037f067506a6614045ead6f164d http://data.gdeltproject.org/gdeltv2/20261101121000.gkg.csv.zip\n',
    ],
    [
      'a bad MD5',
      '2728270 not-an-md5 http://data.gdeltproject.org/gdeltv2/20261101120000.gkg.csv.zip\n',
    ],
    ['an empty body', ''],
  ])('rejects a manifest with %s as manifest_malformed', (_label, text) => {
    expect(() => parseManifest(text, 'english')).toThrow(
      expect.objectContaining({ reason: 'manifest_malformed' }),
    );
  });
});

describe('slots', () => {
  it.each([
    ['20261101120000', true],
    ['20261101114500', true],
    ['20261101121000', false], // minute 10
    ['20261101120001', false], // second 1
    ['20261301120000', false], // month 13
    ['20260230120000', false], // February 30
    ['2026110112000', false], // 13 digits
    ['2026110112000x', false],
  ])('%s is a slot: %s', (value, valid) => {
    expect(parseGkgSlot(value) !== undefined).toBe(valid);
  });

  it('steps across day and month boundaries', () => {
    expect(addGkgSlots('20261031234500', 1)).toBe('20261101000000');
    expect(addGkgSlots('20261101000000', -1)).toBe('20261031234500');
    expect(addGkgSlots('20261101120000', -(7 * 96 - 1))).toBe('20261025121500');
    expect(minutesBetweenSlots('20261101120000', '20261101100000')).toBe(120);
  });
});

describe('parseGkgFile', () => {
  it('maps an English row per the column table, with language eng', () => {
    const { rows, skipped } = parseGkgFile(readGkgFixture('english-rows.tsv'), (domain) =>
      domain === 'zimbabwestar.com' ? 'ZI' : null,
    );
    expect(skipped).toBe(0);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual({
      url: 'http://www.zimbabwestar.com/news/279406493/hello-africa-rwandan-honey-producer-eyes-sweet-opportunities-in-chinese-market-ahead-of-ciie',
      date: '20261101114500',
      domain: 'zimbabwestar.com',
      domain_rev: 'moc.ratsewbabmiz',
      title:
        '(Hello Africa) Rwandan honey producer eyes sweet opportunities in Chinese market ahead of CIIE',
      language: 'eng',
      tone: 5.92705167173252,
      themes:
        'ECON_ENTREPRENEURSHIP TAX_FNCACT TAX_FNCACT_ENTREPRENEUR USPEC_POLICY1 EPU_POLICY EPU_POLICY_POLICY TAX_ETHNICITY TAX_ETHNICITY_CHINESE TAX_WORLDLANGUAGES TAX_WORLDLANGUAGES_CHINESE TAX_FNCACT_CHIEF TAX_FNCACT_EXECUTIVE TAX_FNCACT_CHIEF_EXECUTIVE TAX_MILITARY_TITLE TAX_MILITARY_TITLE_OFFICER TAX_FNCACT_OFFICER TAX_FNCACT_EXECUTIVE_OFFICER TAX_FNCACT_CHIEF_EXECUTIVE_OFFICER EPU_ECONOMY_HISTORIC AGRICULTURE UNGP_FORESTS_RIVERS_OCEANS WB_566_ENVIRONMENT_AND_NATURAL_RESOURCES WB_3007_NATIONAL_PARKS WB_1833_PROTECTED_AREAS_SYSTEMS WB_1829_ECOSYSTEM_MANAGEMENT TAX_ECON_PRICE TAX_FNCACT_WOMEN WB_2936_GOLD WB_507_ENERGY_AND_EXTRACTIVES WB_895_MINING_SYSTEMS WB_1699_METAL_ORE_MINING WB_1777_FORESTS WB_590_ECOSYSTEMS WB_178_PEST_MANAGEMENT WB_174_CROP_PRODUCTION WB_435_AGRICULTURE_AND_FOOD_SECURITY WB_1949_CLIMATE_SMART_AGRICULTURE WB_2914_PESTICIDES EPU_ECONOMY',
      persons: '',
      organizations:
        'animal resources development board; xinhua; akagera national park; m m sozo ltd; china international import expo',
      locations:
        'Shanghai, Shanghai, China; Rwanda; China; Kigali, (Rw09), Rwanda; Akagera, Sud, Rwanda; Kigali City, Kigali, Rwanda; Eastern Province, Est, Rwanda',
      source_country: 'ZI',
      image:
        'https://chitra-api.kreatio.com/api/v1/wps/2a6dc35/e2ef87c1-8138-48a3-a20c-fb14932062c4/0/CnbbeeE000316-20261101-PRMFN0A001-600x315.jpg',
    });
  });

  it('dedupes persons and decodes a numeric reference in the title', () => {
    const [row] = parseGkgFile(readGkgFixture('english-rows.tsv'), noCountry).rows;
    expect(row?.title).toBe("Lights On Stratford: Ontario's free Winter Festival of Light");
    expect(row?.persons).toBe('kaileigh krysztofiak; aurora borealis; justin bieber');
    expect(row?.locations).toBe(
      'Canada; Toronto, Ontario, Canada; Avon River, Nova Scotia, Canada',
    );
    expect(row?.source_country).toBeNull();
  });

  it('keeps both translingual rows that share a GKGRECORDID, with their srclc codes and decoded titles', () => {
    const { rows, skipped } = parseGkgFile(
      readGkgFixture('translation-dup-id-rows.tsv'),
      noCountry,
    );
    expect(skipped).toBe(0);
    expect(rows.map((r) => [r.url, r.language, r.title, r.image])).toEqual([
      [
        'https://index.hu/gazdasag/2026/10/30/gajdos-laszlo-zold-orseg-allatvedelem-szabalyszeges-fellepes/',
        'hun',
        'Index - Gazdaság - Új egységet hoznak létre az állatok védelmére: január 1-jétől megkezdi működését a Zöld Őrség',
        'https://kep.cdn.index.hu/1/0/7231/72316/723168/72316851_5329477_3f0c8118b57ef73238e90f29b70d2c68_wm.jpg',
      ],
      [
        'https://www.lifo.gr/now/perivallon/nekri-arkoyda-stis-prespes-efere-tria-traymata-apo-oplo',
        'ell',
        'Νεκρή αρκούδα στις Πρέσπες: Έφερε τρία τραύματα από όπλο',
        null,
      ],
    ]);
    expect(rows[1]?.tone).toBe(-1.18577075098814);
  });

  it('joins a record whose V2EXTRASXML spans several lines, so its title survives', () => {
    const text = `${readGkgFixture('translation-multiline-record.tsv')}${readGkgFixture('translation-dup-id-rows.tsv')}`;
    const { rows, skipped } = parseGkgFile(text, noCountry);
    expect(skipped).toBe(0);
    expect(rows.map((r) => r.domain)).toEqual(['berliner-zeitung.de', 'index.hu', 'lifo.gr']);
    expect(rows[0]?.title).toBe(
      'Streit um 200 Milliarden Euro: Euroclear legt Ertrag aus Russland-Reserven offen',
    );
    expect(rows[0]?.language).toBe('deu');
  });

  it('counts a record without 27 columns, a URL, or a slot date as skipped', () => {
    const [good = ''] = readGkgFixture('english-rows.tsv').split('\n');
    const cols = good.split('\t');
    const shortRow = cols.slice(0, 26).join('\t');
    const noUrl = cols.map((c, i) => (i === 4 ? '' : c)).join('\t');
    const orphan = 'a continuation line before any record';
    const { rows, skipped } = parseGkgFile([orphan, good, shortRow, noUrl].join('\n'), noCountry);
    expect(rows).toHaveLength(1);
    expect(skipped).toBe(3);
  });

  it('returns no rows for an empty file', () => {
    expect(parseGkgFile('', noCountry)).toEqual({ rows: [], skipped: 0 });
  });
});

describe('decodeHtmlEntities', () => {
  it.each([
    ['&#1605;&#x62C;', 'مج'],
    ['Tom &amp; Jerry &quot;x&quot; &lt;b&gt; it&apos;s&nbsp;ok', 'Tom & Jerry "x" <b> it\'s ok'],
    ['&#X1F600;', '😀'],
    ['&amp;#x645;', '&#x645;'], // one pass: a decoded & does not start a reference
    [
      '&bogus; &#0; &#xD800; &#x110000; &#12345678; &amp &#x; &#;',
      '&bogus; &#0; &#xD800; &#x110000; &#12345678; &amp &#x; &#;',
    ],
    ['no references', 'no references'],
    ['', ''],
  ])('%j → %j', (input, expected) => {
    expect(decodeHtmlEntities(input)).toBe(expected);
  });

  it('reads the title between PAGE_TITLE tags, or nothing without them', () => {
    expect(
      extractPageTitle('<PAGE_LINKS>a;b</PAGE_LINKS><PAGE_TITLE> A &amp; B </PAGE_TITLE>'),
    ).toBe('A & B');
    expect(extractPageTitle('<PAGE_LINKS>a</PAGE_LINKS>')).toBe('');
    expect(extractPageTitle('<PAGE_TITLE>unterminated')).toBe('unterminated');
  });
});

/**
 * Thread CPU of `fn(input)`, fastest of 3. Wall clock never enters: other threads' and the
 * scheduler's time do not count.
 */
function fastestCpuMicros(fn: () => unknown): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < 3; i++) {
    const start = process.threadCpuUsage();
    fn();
    const used = process.threadCpuUsage(start);
    best = Math.min(best, used.user + used.system);
  }
  return best;
}

/**
 * Linear-time proof over sizes spanning 64×: the result is asserted at every size, each size's
 * CPU stays under an absolute cap before the next runs, and the full-span ratio stays under 256
 * (linear ≈ 64, quadratic ≈ 4096).
 */
function expectLinear(
  build: (units: number) => string,
  run: (input: string) => unknown,
  check: (result: unknown, units: number) => void,
): void {
  const sizes = [2_000, 8_000, 32_000, 128_000];
  const cpu: number[] = [];
  for (const units of sizes) {
    const input = build(units);
    let result: unknown;
    cpu.push(
      fastestCpuMicros(() => {
        result = run(input);
      }),
    );
    check(result, units);
    expect(cpu.at(-1)).toBeLessThan(1_500_000); // 1.5 s of CPU at any size
  }
  // Below 1 ms of CPU the clock's granularity, not the input, sets the smallest sample.
  const ratio = (cpu.at(-1) ?? 0) / Math.max(cpu[0] ?? 0, 1000);
  expect(ratio).toBeLessThan(256);
}

describe('linear scanning of upstream text', () => {
  // Decodable references first, then a long run of `&` with no `;` anywhere after it.
  const decoded = (result: unknown, units: number) => {
    expect(typeof result).toBe('string');
    expect([...(result as string)].filter((c) => c === 'م')).toHaveLength(units);
    expect((result as string).split('&x')).toHaveLength(units * 8 + 1);
  };

  it('decodes entities in linear time on one long line ending in a break', () => {
    expectLinear(
      (units) => `${'&#x645;'.repeat(units)}${'&x'.repeat(units * 8)}\n`,
      decodeHtmlEntities,
      decoded,
    );
  });

  it('decodes entities in linear time with breaks throughout', () => {
    expectLinear(
      (units) => `${'&#x645;\n'.repeat(units)}${'&x\n'.repeat(units * 8)}`,
      decodeHtmlEntities,
      (result, units) => {
        expect([...(result as string)].filter((c) => c === 'م')).toHaveLength(units);
        expect((result as string).split('&x\n')).toHaveLength(units * 8 + 1);
      },
    );
  });

  const record = (body: string) =>
    `${atSlot(readGkgFixture('english-rows.tsv').split('\n')[0] ?? '', '20261101120000').replace(/<PAGE_TITLE>.*$/, '')}${body}<PAGE_TITLE>T &amp; U</PAGE_TITLE>`;
  const oneRow = (result: unknown) => {
    const parsed = result as ReturnType<typeof parseGkgFile>;
    expect(parsed.skipped).toBe(0);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]?.title).toBe('T & U');
  };

  it('parses a record with one long V2EXTRASXML line in linear time', () => {
    expectLinear(
      (units) => `${record('&&&&&&&&&&&&&&&&x;'.repeat(units))}\n`,
      (input) => parseGkgFile(input, noCountry),
      oneRow,
    );
  });

  it('parses a record whose V2EXTRASXML breaks across many lines in linear time', () => {
    expectLinear(
      // Each line opens like a GKGRECORDID but has no tab, so it continues the record.
      (units) => `${record('20261101120000-link;\n'.repeat(units))}\n`,
      (input) => parseGkgFile(input, noCountry),
      oneRow,
    );
  });
});

describe('inflateSingleEntryZip', () => {
  const text = 'line one\tcol\nline two\tcol\n';
  const url = 'https://data.gdeltproject.org/gdeltv2/20261101120000.gkg.csv.zip';

  it('returns the entry when its CRC-32 and size match the header', async () => {
    const out = await inflateSingleEntryZip(buildGkgZip(text), url);
    expect(new TextDecoder().decode(out)).toBe(text);
  });

  it.each([
    ['a CRC-32 mismatch', { crc: 12345 }],
    ['a size larger than the entry', { size: text.length + 1 }],
    ['a size smaller than the entry', { size: text.length - 1 }],
    ['the stored method', { method: 0 }],
    ['a data descriptor', { flags: 0x08 }],
  ])('rejects %s as integrity_mismatch', async (_label, overrides) => {
    await expect(inflateSingleEntryZip(buildGkgZip(text, overrides), url)).rejects.toMatchObject({
      name: 'GkgFeedError',
      reason: 'integrity_mismatch',
      url,
    });
  });

  it('rejects a truncated file and a file that is not a zip', async () => {
    const zip = buildGkgZip(text);
    await expect(inflateSingleEntryZip(zip.subarray(0, zip.length - 4), url)).rejects.toMatchObject(
      { reason: 'integrity_mismatch' },
    );
    await expect(
      inflateSingleEntryZip(
        new TextEncoder().encode('<html>not a zip, but long enough</html>'),
        url,
      ),
    ).rejects.toMatchObject({ reason: 'integrity_mismatch' });
  });
});

describe('parseDomainCountryFile', () => {
  it('skips the header, lowercases domains, and keeps the first entry of a repeated domain', () => {
    const entries = parseDomainCountryFile(
      `${readGkgFixture('domains-by-country.txt')}ZimbabweStar.com\tUS\tUnited States\n`,
    );
    expect(entries).toHaveLength(24); // 25 lines: the header, 19 domains, the 5 fixture domains
    expect(entries[0]).toEqual({ domain: '00221.info', fips: 'SG', country: 'Senegal' });
    expect(entries.find((e) => e.domain === 'zimbabwestar.com')).toEqual({
      domain: 'zimbabwestar.com',
      fips: 'ZI',
      country: 'Zimbabwe',
    });
  });

  it('rejects a file with no domain lines', () => {
    expect(() => parseDomainCountryFile('SourceCommonName\tlocation\t\n')).toThrow(
      expect.objectContaining({ reason: 'domain_file_malformed' }),
    );
  });
});

describe('GkgFeedSession at the fetch seam', () => {
  const slot = '20261101120000';
  const zip = buildGkgZip(atSlot(readGkgFixture('english-rows.tsv'), slot));

  it('sends the User-Agent on every request and pauses 2 s before each one after the first', async () => {
    const stub = stubFeedTransport({
      [MANIFEST_URL.english]: { status: 200, body: manifestText('english', slot, zip) },
      [slotFileUrl('english', slot)]: { status: 200, body: zip },
      [DOMAIN_FILE_URL]: { status: 200, body: readGkgFixture('domains-by-country.txt') },
    });
    const session = new GkgFeedSession(stub.transport, new AbortController().signal);
    const manifest = await session.manifest('english');
    const file = await session.slotFile('english', slot, manifest);
    await session.domainCountryFile();

    expect(file.kind).toBe('file');
    expect(stub.events).toEqual([
      { kind: 'request', url: MANIFEST_URL.english, userAgent: UA },
      { kind: 'pause', ms: 2000 },
      { kind: 'request', url: slotFileUrl('english', slot), userAgent: UA },
      { kind: 'pause', ms: 2000 },
      { kind: 'request', url: DOMAIN_FILE_URL, userAgent: UA },
    ]);
  });

  it('reports a 404 slot file as missing', async () => {
    const stub = stubFeedTransport({});
    const session = new GkgFeedSession(stub.transport, new AbortController().signal);
    await expect(session.slotFile('translation', slot)).resolves.toEqual({ kind: 'missing' });
  });

  it.each([403, 429, 500, 503])('stops on HTTP %i with upstream_refused', async (status) => {
    const stub = stubFeedTransport({ [slotFileUrl('english', slot)]: { status } });
    const session = new GkgFeedSession(stub.transport, new AbortController().signal);
    await expect(session.slotFile('english', slot)).rejects.toMatchObject({
      reason: 'upstream_refused',
      status,
      url: slotFileUrl('english', slot),
    });
  });

  it('stops on a 404 manifest: only slot files may be missing', async () => {
    const session = new GkgFeedSession(
      stubFeedTransport({}).transport,
      new AbortController().signal,
    );
    await expect(session.manifest('english')).rejects.toMatchObject({
      reason: 'upstream_refused',
      status: 404,
    });
  });

  it('stops on a network error with network_error, keeping the cause', async () => {
    const cause = new TypeError('fetch failed');
    const stub = stubFeedTransport({ [slotFileUrl('english', slot)]: { error: cause } });
    const session = new GkgFeedSession(stub.transport, new AbortController().signal);
    await expect(session.slotFile('english', slot)).rejects.toMatchObject({
      reason: 'network_error',
      cause,
    });
  });

  it('checks the manifest slot’s download against the manifest size and MD5', async () => {
    const other = buildGkgZip('a different file\n');
    const stub = stubFeedTransport({
      [MANIFEST_URL.english]: { status: 200, body: manifestText('english', slot, zip) },
      [slotFileUrl('english', slot)]: { status: 200, body: other },
    });
    const session = new GkgFeedSession(stub.transport, new AbortController().signal);
    const manifest = await session.manifest('english');
    await expect(session.slotFile('english', slot, manifest)).rejects.toMatchObject({
      reason: 'integrity_mismatch',
    });
    // Without the manifest (any other slot) only the zip's own CRC-32 applies.
    await expect(session.slotFile('english', slot)).resolves.toMatchObject({ kind: 'file' });
  });

  it('rejects with the caller’s abort reason untouched, mid-request and mid-pause', async () => {
    const reason = new Error('caller cancelled');
    const controller = new AbortController();
    const stub = stubFeedTransport({ [slotFileUrl('english', slot)]: 'hang' });
    const session = new GkgFeedSession(stub.transport, controller.signal);
    const pending = session.slotFile('english', slot);
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    // The next request pauses first; an aborted signal rejects there.
    await expect(session.slotFile('english', slot)).rejects.toBe(reason);
  });
});
