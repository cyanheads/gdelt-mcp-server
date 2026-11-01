/**
 * @fileoverview The GKG mirror's sync walk against a stub network at the `fetch` seam: ledger
 * resume, the 404/gap rule, stop-on-refusal, CRC and manifest MD5 checks, window expiry by
 * stored date, the newest-row rule, FTS tokenization of ingested rows, and `mirror:verify`'s
 * report.
 * @module tests/services/gkg-mirror-store.test
 */

import type { SqliteHandle, SyncProgress } from '@cyanheads/mcp-ts-core/mirror';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { GkgFeed } from '@/services/gkg-mirror/gkg-mirror-schema.js';
import { createGkgMirror, inspectGkgMirror } from '@/services/gkg-mirror/gkg-mirror-store.js';
import {
  atSlot,
  buildGkgZip,
  DOMAIN_FILE_URL,
  MANIFEST_URL,
  manifestText,
  readGkgFixture,
  type ScenarioFile,
  type StubResponse,
  scenarioRoutes,
  slotFileUrl,
  stubFeedTransport,
} from '../helpers/gkg-feed-fixtures.js';
import {
  gkgRow,
  gkgSlotsBetween,
  openGkgMirrorFixture,
  seedGkgBothFeeds,
  seedGkgRows,
  seedGkgSlots,
} from '../helpers/gkg-mirror-fixture.js';

/** Newest manifest slot; with a 1-day window the window starts 95 slots earlier. */
const M = '20261101120000';
const WINDOW_START = '20261031121500';

/** A feed's fixture rows at `slot`, with `?slot=<slot>` on each URL so slots never share a URL. */
function slotTsv(feed: GkgFeed, slot: string): string {
  const fixture = feed === 'english' ? 'english-rows.tsv' : 'translation-dup-id-rows.tsv';
  return atSlot(readGkgFixture(fixture), slot)
    .split('\n')
    .map((line) => {
      const cols = line.split('\t');
      if (cols.length !== 27) return line;
      cols[4] = `${cols[4]}?slot=${slot}`;
      return cols.join('\t');
    })
    .join('\n');
}

function file(feed: GkgFeed, slot: string): ScenarioFile {
  return { feed, slot, tsv: slotTsv(feed, slot) };
}

/** Mark both feeds' slots through `through` as already ingested (no rows). */
function seedLedgerThrough(handle: SqliteHandle, through: string): void {
  seedGkgBothFeeds(handle, gkgSlotsBetween(WINDOW_START, through));
}

async function setup(routes: Record<string, StubResponse>) {
  const fixture = await openGkgMirrorFixture();
  const stub = stubFeedTransport(routes);
  const mirror = createGkgMirror({
    path: fixture.path,
    windowDays: 1,
    transport: stub.transport,
    logger: {},
  });
  onTestFinished(async () => {
    await mirror.close();
    await fixture.cleanup();
  });
  return { db: fixture.handle, fixture, mirror, stub, routes };
}

/** Ledger entries the run wrote: gaps, and slots ingested with rows (seeded entries have none). */
function ledger(
  db: SqliteHandle,
): Array<{ feed: string; slot: string; status: string; rows: number }> {
  return db
    .prepare<{ feed: string; slot: string; status: string; rows: number }>(
      "SELECT feed, slot, status, rows FROM gkg_slots WHERE status = 'gap' OR rows > 0 ORDER BY slot, feed",
    )
    .all();
}

function urlsAt(db: SqliteHandle, date: string): string[] {
  return db
    .prepare<{ url: string }>('SELECT url FROM gkg_articles WHERE date = ? ORDER BY url')
    .all(date)
    .map((r) => r.url);
}

function ftsMatch(db: SqliteHandle, match: string): string[] {
  return db
    .prepare<{ url: string }>(
      'SELECT url FROM gkg_articles WHERE rowid IN (SELECT rowid FROM gkg_articles_fts WHERE gkg_articles_fts MATCH ?) ORDER BY url',
    )
    .all(match)
    .map((r) => r.url);
}

const SLOT_1145 = '20261101114500';

describe('sync walk', () => {
  it('ingests pending slots oldest first, both feeds per slot, writing the ledger only after each page commits', async () => {
    const { db, mirror, stub } = await setup(
      scenarioRoutes({
        manifestSlots: { english: M, translation: M },
        files: [
          file('english', SLOT_1145),
          file('translation', SLOT_1145),
          file('english', M),
          file('translation', M),
        ],
      }),
    );
    seedLedgerThrough(db, '20261101113000');

    const atProgress: Array<{ ledgered: number; articles: number }> = [];
    const onProgress: SyncProgress = ({ checkpoint }) =>
      atProgress.push({
        ledgered: ledger(db).filter((e) => e.slot === checkpoint && e.rows > 0).length,
        articles: urlsAt(db, checkpoint ?? '').length,
      });
    const result = await mirror.runSync({ mode: 'init', onProgress });

    expect(result).toMatchObject({
      pagesFetched: 4,
      recordsApplied: 8,
      tombstonesApplied: 0,
      total: 8,
    });
    expect(stub.requested()).toEqual([
      DOMAIN_FILE_URL,
      MANIFEST_URL.english,
      MANIFEST_URL.translation,
      slotFileUrl('english', SLOT_1145),
      slotFileUrl('translation', SLOT_1145),
      slotFileUrl('english', M),
      slotFileUrl('translation', M),
    ]);
    // When each page's progress fires, its rows are in and the ledger does not yet claim the slot.
    expect(atProgress).toEqual([
      { ledgered: 0, articles: 2 },
      { ledgered: 1, articles: 4 }, // english 11:45 was ledgered when the walk resumed
      { ledgered: 0, articles: 2 },
      { ledgered: 1, articles: 4 },
    ]);
    expect(ledger(db)).toEqual([
      { feed: 'english', slot: SLOT_1145, status: 'ingested', rows: 2 },
      { feed: 'translation', slot: SLOT_1145, status: 'ingested', rows: 2 },
      { feed: 'english', slot: M, status: 'ingested', rows: 2 },
      { feed: 'translation', slot: M, status: 'ingested', rows: 2 },
    ]);
    expect(await mirror.ready()).toBe(true);
  });

  it('keeps both translingual rows sharing a GKGRECORDID, with language and source country', async () => {
    const { db, mirror } = await setup(
      scenarioRoutes({
        manifestSlots: { english: M, translation: M },
        files: [file('english', M), file('translation', M)],
      }),
    );
    seedLedgerThrough(db, SLOT_1145);
    await mirror.runSync({ mode: 'init' });

    const rows = db
      .prepare<{ domain: string; language: string; source_country: string | null }>(
        'SELECT domain, language, source_country FROM gkg_articles ORDER BY domain',
      )
      .all();
    expect(rows).toEqual([
      { domain: 'index.hu', language: 'hun', source_country: 'HU' },
      { domain: 'insidehalton.com', language: 'eng', source_country: 'CA' },
      { domain: 'lifo.gr', language: 'ell', source_country: 'GR' },
      { domain: 'zimbabwestar.com', language: 'eng', source_country: 'ZI' },
    ]);
    expect(db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM gkg_domain_country').get()?.n).toBe(
      24,
    );
  });

  it('loads the domain map only while it is empty and fetches nothing new when the ledger is current', async () => {
    const { db, mirror, stub } = await setup(
      scenarioRoutes({
        manifestSlots: { english: M, translation: M },
        files: [file('english', M), file('translation', M)],
      }),
    );
    seedLedgerThrough(db, SLOT_1145);
    await mirror.runSync({ mode: 'init' });
    const firstRun = stub.requested().length;
    await mirror.runSync({ mode: 'refresh' });
    expect(stub.requested().slice(firstRun)).toEqual([
      MANIFEST_URL.english,
      MANIFEST_URL.translation,
    ]);
  });

  it.each([
    ['a CRC-32 mismatch', (tsv: string) => buildGkgZip(tsv, { crc: 1 })],
    ['a size mismatch', (tsv: string) => buildGkgZip(tsv, { size: 3 })],
  ])('stops the run on %s with nothing from that file applied', async (_label, corrupt) => {
    const routes = scenarioRoutes({
      manifestSlots: { english: M, translation: M },
      files: [file('english', SLOT_1145), file('english', M), file('translation', M)],
    });
    routes[slotFileUrl('translation', SLOT_1145)] = {
      status: 200,
      body: corrupt(slotTsv('translation', SLOT_1145)),
    };
    const { db, mirror, stub } = await setup(routes);
    seedLedgerThrough(db, '20261101113000');

    await expect(mirror.runSync({ mode: 'init' })).rejects.toMatchObject({
      name: 'GkgFeedError',
      reason: 'integrity_mismatch',
      url: slotFileUrl('translation', SLOT_1145),
    });
    expect(
      urlsAt(db, SLOT_1145).every(
        (url) => url.includes('insidehalton') || url.includes('zimbabwestar'),
      ),
    ).toBe(true);
    expect(urlsAt(db, SLOT_1145)).toHaveLength(2);
    expect(ledger(db).map((e) => `${e.feed}/${e.slot}`)).toEqual([`english/${SLOT_1145}`]);
    expect(stub.requested()).not.toContain(slotFileUrl('english', M));
    expect(await mirror.status()).toMatchObject({ status: 'error', ready: false });
  });

  it('stops the run when a feed’s manifest slot does not match the manifest MD5, applying nothing from it', async () => {
    const routes = scenarioRoutes({
      manifestSlots: { english: M, translation: M },
      files: [file('english', M), file('translation', M)],
    });
    // The manifest describes a different file than the one served for its slot.
    routes[MANIFEST_URL.english] = {
      status: 200,
      body: manifestText('english', M, buildGkgZip('another file\n')),
    };
    const { db, mirror, stub } = await setup(routes);
    seedLedgerThrough(db, SLOT_1145);

    await expect(mirror.runSync({ mode: 'init' })).rejects.toMatchObject({
      reason: 'integrity_mismatch',
      url: slotFileUrl('english', M),
    });
    expect(urlsAt(db, M)).toEqual([]);
    expect(ledger(db)).toEqual([]);
    expect(stub.requested()).not.toContain(slotFileUrl('translation', M));
  });

  it('leaves a 404 slot under 2 hours old pending and stops that feed’s walk while the other feed continues', async () => {
    const { db, mirror, stub } = await setup(
      scenarioRoutes({
        manifestSlots: { english: M, translation: M },
        files: [
          file('english', SLOT_1145),
          { feed: 'translation', slot: SLOT_1145, response: { status: 404 } },
          file('english', M),
          file('translation', M),
        ],
      }),
    );
    seedLedgerThrough(db, '20261101113000');

    await expect(mirror.runSync({ mode: 'init' })).resolves.toMatchObject({ pagesFetched: 2 });
    expect(stub.requested().slice(3)).toEqual([
      slotFileUrl('english', SLOT_1145),
      slotFileUrl('translation', SLOT_1145),
      slotFileUrl('english', M),
    ]);
    expect(ledger(db).map((e) => `${e.feed}/${e.slot}/${e.status}`)).toEqual([
      `english/${SLOT_1145}/ingested`,
      `english/${M}/ingested`,
    ]);
  });

  it('records a 404 slot 2 hours older than its manifest slot as a gap and walks past it', async () => {
    const pending = gkgSlotsBetween('20261101100000', M);
    const { db, mirror, stub } = await setup(
      scenarioRoutes({
        manifestSlots: { english: M, translation: M },
        files: pending.flatMap((slot) =>
          slot === '20261101100000'
            ? [
                file('english', slot),
                { feed: 'translation' as const, slot, response: { status: 404 } },
              ]
            : [file('english', slot), file('translation', slot)],
        ),
      }),
    );
    seedLedgerThrough(db, '20261101094500');

    await mirror.runSync({ mode: 'init' });
    const translation = db
      .prepare<{ slot: string; status: string; rows: number }>(
        "SELECT slot, status, rows FROM gkg_slots WHERE feed = 'translation' AND slot >= '20261101100000' ORDER BY slot",
      )
      .all();
    expect(translation[0]).toEqual({ slot: '20261101100000', status: 'gap', rows: 0 });
    expect(translation.slice(1).map((e) => e.status)).toEqual(Array(8).fill('ingested'));
    expect(stub.requested()).toContain(slotFileUrl('translation', M));
  });

  it.each([429, 503])(
    'stops the run on HTTP %i; the next run resumes from the ledger',
    async (status) => {
      const routes = scenarioRoutes({
        manifestSlots: { english: M, translation: M },
        files: [file('english', SLOT_1145), file('translation', SLOT_1145), file('translation', M)],
      });
      const englishM = slotFileUrl('english', M);
      routes[englishM] = { status };
      const { db, mirror, stub } = await setup(routes);
      seedLedgerThrough(db, '20261101113000');

      await expect(mirror.runSync({ mode: 'init' })).rejects.toMatchObject({
        reason: 'upstream_refused',
        status,
      });
      expect(stub.requested()).not.toContain(slotFileUrl('translation', M));
      expect(await mirror.ready()).toBe(false);

      routes[englishM] = { status: 200, body: buildGkgZip(slotTsv('english', M)) };
      // The manifest's MD5 must describe the file now served.
      routes[MANIFEST_URL.english] = {
        status: 200,
        body: manifestText('english', M, routes[englishM].body as Uint8Array),
      };
      const firstRun = stub.requested().length;
      await mirror.runSync({ mode: 'init' });
      expect(stub.requested().slice(firstRun)).toEqual([
        MANIFEST_URL.english,
        MANIFEST_URL.translation,
        englishM,
        slotFileUrl('translation', M),
      ]);
      expect(await mirror.ready()).toBe(true);
    },
  );

  it('after an interrupted init, re-running fetches only the slots missing from the ledger', async () => {
    const { db, mirror, stub } = await setup(
      scenarioRoutes({
        manifestSlots: { english: M, translation: M },
        files: [
          file('english', SLOT_1145),
          file('translation', SLOT_1145),
          file('english', M),
          file('translation', M),
        ],
      }),
    );
    seedLedgerThrough(db, '20261101113000');
    const reason = new Error('operator interrupt');
    const controller = new AbortController();

    await expect(
      mirror.runSync({
        mode: 'init',
        signal: controller.signal,
        onProgress: ({ pages }) => {
          if (pages === 1) controller.abort(reason);
        },
      }),
    ).rejects.toBe(reason);
    expect(ledger(db).map((e) => `${e.feed}/${e.slot}`)).toEqual([`english/${SLOT_1145}`]);

    const firstRun = stub.requested().length;
    await mirror.runSync({ mode: 'init' });
    expect(stub.requested().slice(firstRun)).toEqual([
      MANIFEST_URL.english,
      MANIFEST_URL.translation,
      slotFileUrl('translation', SLOT_1145),
      slotFileUrl('english', M),
      slotFileUrl('translation', M),
    ]);
  });
});

describe('window expiry', () => {
  const OLDEST = '20261031114500';
  const OLDER = '20261031120000';

  it('takes an expired slot’s rows and FTS entries with the page that ingests the new slot, keeping a URL that reappeared', async () => {
    const reappearing = `http://www.zimbabwestar.com/news/279406493/hello-africa-rwandan-honey-producer-eyes-sweet-opportunities-in-chinese-market-ahead-of-ciie?slot=${M}`;
    const { db, fixture, mirror } = await setup(
      scenarioRoutes({
        manifestSlots: { english: M, translation: SLOT_1145 },
        files: [file('english', M)],
      }),
    );
    seedLedgerThrough(db, SLOT_1145);
    seedGkgSlots(db, [
      { feed: 'english', slot: OLDEST, rows: 2 },
      { feed: 'english', slot: OLDER, rows: 2 },
    ]);
    await seedGkgRows(fixture.store, [
      gkgRow({ url: reappearing, date: OLDEST, domain: 'zimbabwestar.com', title: 'old copy' }),
      gkgRow({
        url: 'https://expired.example/a',
        date: OLDEST,
        domain: 'expired.example',
        title: 'zebracorn',
      }),
      gkgRow({
        url: 'https://expired.example/b',
        date: OLDER,
        domain: 'expired.example',
        title: 'quokkafish',
      }),
      gkgRow({
        url: 'https://expired.example/c',
        date: OLDER,
        domain: 'expired.example',
        title: 'quokkafish',
      }),
    ]);

    const pages: Array<{ records: number; tombstones: number }> = [];
    await mirror.runSync({
      mode: 'refresh',
      onProgress: ({ records, tombstones }) => pages.push({ records, tombstones }),
    });

    /**
     * Cumulative counts: the new slot's page carries the oldest expired slot (less the URL it
     * rewrites); the next expired slot leaves in a page of its own.
     */
    expect(pages).toEqual([
      { records: 2, tombstones: 1 },
      { records: 2, tombstones: 3 },
    ]);
    expect(urlsAt(db, OLDEST)).toEqual([]);
    expect(urlsAt(db, OLDER)).toEqual([]);
    expect(
      db
        .prepare<{ date: string; title: string }>(
          'SELECT date, title FROM gkg_articles WHERE url = ?',
        )
        .get(reappearing),
    ).toEqual({
      date: M,
      title:
        '(Hello Africa) Rwandan honey producer eyes sweet opportunities in Chinese market ahead of CIIE',
    });
    expect(ftsMatch(db, 'zebracorn')).toEqual([]);
    expect(ftsMatch(db, 'quokkafish')).toEqual([]);
    expect(
      db
        .prepare<{ n: number }>('SELECT COUNT(*) AS n FROM gkg_slots WHERE slot < ?')
        .get(WINDOW_START)?.n,
    ).toBe(0);
  });

  it('expires slots even when no new file rides along', async () => {
    const { db, fixture, mirror } = await setup(
      scenarioRoutes({ manifestSlots: { english: M, translation: M }, files: [] }),
    );
    seedLedgerThrough(db, M);
    await seedGkgRows(fixture.store, [
      gkgRow({ url: 'https://expired.example/a', date: OLDEST, domain: 'expired.example' }),
      gkgRow({ url: 'https://expired.example/b', date: OLDER, domain: 'expired.example' }),
      gkgRow({ url: 'https://kept.example/c', date: WINDOW_START, domain: 'kept.example' }),
    ]);
    const result = await mirror.runSync({ mode: 'refresh' });
    expect(result).toMatchObject({
      pagesFetched: 2,
      recordsApplied: 0,
      tombstonesApplied: 2,
      total: 1,
    });
    expect(urlsAt(db, WINDOW_START)).toEqual(['https://kept.example/c']);
  });

  it('keeps a URL’s newer row when an older slot carrying it is ingested later', async () => {
    const url = `http://www.zimbabwestar.com/news/279406493/hello-africa-rwandan-honey-producer-eyes-sweet-opportunities-in-chinese-market-ahead-of-ciie?slot=${SLOT_1145}`;
    const { db, fixture, mirror } = await setup(
      scenarioRoutes({
        manifestSlots: { english: M, translation: M },
        files: [file('english', SLOT_1145)],
      }),
    );
    seedLedgerThrough(db, '20261101113000');
    seedGkgSlots(db, [
      { feed: 'translation', slot: SLOT_1145 },
      { feed: 'english', slot: M },
      { feed: 'translation', slot: M },
    ]);
    await seedGkgRows(fixture.store, [
      gkgRow({ url, date: M, domain: 'zimbabwestar.com', title: 'newer' }),
    ]);

    await mirror.runSync({ mode: 'refresh' });
    expect(
      db
        .prepare<{ date: string; title: string }>(
          'SELECT date, title FROM gkg_articles WHERE url = ?',
        )
        .get(url),
    ).toEqual({
      date: M,
      title: 'newer',
    });
    expect(ledger(db).find((e) => e.feed === 'english' && e.slot === SLOT_1145)?.rows).toBe(1);
  });
});

describe('FTS over ingested rows', () => {
  it('matches theme IDs exactly and never matches a keyword inside a theme ID', async () => {
    const { db, fixture, mirror } = await setup(
      scenarioRoutes({
        manifestSlots: { english: M, translation: M },
        files: [file('english', M), file('translation', M)],
      }),
    );
    seedLedgerThrough(db, SLOT_1145);
    await mirror.runSync({ mode: 'init' });
    await seedGkgRows(fixture.store, [
      gkgRow({
        url: 'https://exact.example/a',
        date: M,
        domain: 'exact.example',
        themes: 'MANMADE_DISASTER TAX_FNCACT',
      }),
    ]);
    const lifo = `https://www.lifo.gr/now/perivallon/nekri-arkoyda-stis-prespes-efere-tria-traymata-apo-oplo?slot=${M}`;

    // The lifo.gr row carries MANMADE_DISASTER_IMPLIED only.
    expect(
      db.prepare<{ themes: string }>('SELECT themes FROM gkg_articles WHERE url = ?').get(lifo)
        ?.themes,
    ).toContain('MANMADE_DISASTER_IMPLIED');
    expect(ftsMatch(db, 'themes : "MANMADE_DISASTER"')).toEqual(['https://exact.example/a']);
    expect(ftsMatch(db, 'themes : "MANMADE_DISASTER_IMPLIED"')).toEqual([lifo]);
    expect(ftsMatch(db, 'themes : tax')).toEqual([]);
    expect(ftsMatch(db, '{title persons organizations locations} : tax')).toEqual([]);
    expect(ftsMatch(db, 'themes : "TAX_FNCACT"')).toHaveLength(5);
  });
});

describe('inspectGkgMirror (mirror:verify)', () => {
  it('reports integrity, status, rows, domains, and each feed’s covered slots with gaps', async () => {
    const { db, mirror } = await setup(
      scenarioRoutes({
        manifestSlots: { english: M, translation: M },
        files: [
          file('english', SLOT_1145),
          file('translation', SLOT_1145),
          file('english', M),
          file('translation', M),
        ],
      }),
    );
    seedLedgerThrough(db, '20261101113000');
    seedGkgSlots(db, [{ feed: 'translation', slot: '20261101113000', status: 'gap' }]);
    await mirror.runSync({ mode: 'init' });

    const report = await inspectGkgMirror(mirror);
    expect(report).toMatchObject({
      integrity: { ok: true },
      status: { status: 'complete', ready: true },
      rows: 8,
      domains: 24,
      feeds: {
        english: { ingested: 96, gaps: [], oldest: WINDOW_START, newest: M },
        translation: { ingested: 95, gaps: ['20261101113000'], oldest: WINDOW_START, newest: M },
      },
    });
  });
});
