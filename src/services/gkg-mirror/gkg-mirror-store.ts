/**
 * @fileoverview The GKG mirror instance: `defineMirror` over the production store spec, and the
 * sync generator that walks both feeds' 15-minute slots into it. Init and refresh run the same
 * walk; the `gkg_slots` ledger, not the framework cursor, decides what is still to fetch, so an
 * interrupted run of either kind resumes where it stopped.
 *
 * Runs inside the mirror worker and the mirror CLI scripts, so this module imports only
 * relative paths, Node built-ins, and the framework.
 * @module services/gkg-mirror/gkg-mirror-store
 */

import {
  defineMirror,
  type Mirror,
  type MirrorLogger,
  type MirrorStatus,
  type SqliteHandle,
  type SyncPage,
  sqliteMirrorStore,
} from '@cyanheads/mcp-ts-core/mirror';
import {
  addGkgSlots,
  type FeedTransport,
  GKG_FEEDS,
  GKG_SLOTS_PER_DAY,
  GkgFeedSession,
  type GkgManifest,
  minutesBetweenSlots,
  parseDomainCountryFile,
  parseGkgFile,
} from './gkg-feed.js';
import {
  buildGkgMirrorStoreSpec,
  type GkgArticleRow,
  type GkgFeed,
  type GkgSlotStatus,
} from './gkg-mirror-schema.js';

/**
 * A slot file that answers 404 stays pending, and stops its feed's walk for the run, until it is
 * this many minutes older than the feed's manifest slot; then it is recorded as a gap.
 */
const GKG_GAP_AFTER_MINUTES = 120;

type GkgMirrorOptions = {
  /** SQLite database file (`GDELT_MIRROR_PATH`). */
  path: string;
  /** Days of slots kept, ending at the newer manifest slot (`GDELT_MIRROR_WINDOW_DAYS`). */
  windowDays: number;
  transport: FeedTransport;
  logger: MirrorLogger;
};

/** The GKG mirror. Nothing opens until the first call. */
export function createGkgMirror(options: GkgMirrorOptions): Mirror {
  const store = sqliteMirrorStore(buildGkgMirrorStoreSpec(options.path));
  const log = options.logger;
  return defineMirror({
    name: 'gkg',
    store,
    logger: log,
    async *sync({ signal }) {
      const db = await store.raw();
      const session = new GkgFeedSession(options.transport, signal);

      if (countDomainCountries(db) === 0) {
        const entries = parseDomainCountryFile(await session.domainCountryFile());
        insertDomainCountries(db, entries);
        log.info?.('Loaded the GKG domain-to-country map', { domains: entries.length });
      }
      const countries = readDomainCountryMap(db);
      const sourceCountry = (domain: string) => countries.get(domain) ?? null;

      const manifests: Record<GkgFeed, GkgManifest> = {
        english: await session.manifest('english'),
        translation: await session.manifest('translation'),
      };
      const { english, translation } = manifests;
      // Slots are fixed-width digit strings, so string order is time order.
      const newest =
        english.slot.localeCompare(translation.slot) > 0 ? english.slot : translation.slot;
      const windowStart = gkgWindowStart(newest, options.windowDays);

      /**
       * Coverage shrinks before the rows it covered are deleted, so the ledger never claims a
       * slot whose rows are gone.
       */
      deleteLedgerBefore(db, windowStart);

      const stopped = new Set<GkgFeed>();
      for (const { feed, slot } of pendingSlots(db, manifests, windowStart, newest)) {
        if (stopped.has(feed)) continue;
        const manifest = manifests[feed];
        const file = await session.slotFile(
          feed,
          slot,
          slot === manifest.slot ? manifest : undefined,
        );
        if (file.kind === 'missing') {
          if (minutesBetweenSlots(manifest.slot, slot) >= GKG_GAP_AFTER_MINUTES) {
            recordSlot(db, feed, slot, 'gap', 0);
            log.notice?.('GKG slot file missing; recorded as a gap', { feed, slot });
          } else {
            stopped.add(feed);
            log.info?.('GKG slot file not published yet; feed walk stops for this run', {
              feed,
              slot,
            });
          }
          continue;
        }
        const { rows, skipped } = parseGkgFile(file.text, sourceCountry);
        if (skipped > 0) log.warning?.('Skipped malformed GKG lines', { feed, slot, skipped });
        const records = withoutOlderDuplicates(db, rows);
        yield {
          records,
          tombstones: expiredTombstones(db, windowStart, records),
          checkpoint: slot,
        };
        // The page above has committed; only now does the ledger claim the slot.
        recordSlot(db, feed, slot, 'ingested', records.length);
        log.debug?.('Ingested GKG slot', { feed, slot, rows: records.length });
      }

      // Slots that left the window with no new file to ride along: one per page.
      for (;;) {
        const tombstones = expiredTombstones(db, windowStart, []);
        if (tombstones.length === 0) break;
        yield { records: [], tombstones } satisfies SyncPage;
      }
    },
  });
}

/** First slot of a `windowDays`-day window ending at `newest`. */
export function gkgWindowStart(newest: string, windowDays: number): string {
  return addGkgSlots(newest, -(windowDays * GKG_SLOTS_PER_DAY - 1));
}

/**
 * Slots from `windowStart` to `newest` absent from the ledger, oldest first, both feeds per slot
 * (English first). A feed's slots end at its own manifest slot.
 */
function pendingSlots(
  db: SqliteHandle,
  manifests: Record<GkgFeed, GkgManifest>,
  windowStart: string,
  newest: string,
): Array<{ feed: GkgFeed; slot: string }> {
  const known = new Set(
    db
      .prepare<{ feed: string; slot: string }>('SELECT feed, slot FROM gkg_slots WHERE slot >= ?')
      .all(windowStart)
      .map((r) => `${r.feed}/${r.slot}`),
  );
  const pending: Array<{ feed: GkgFeed; slot: string }> = [];
  for (let slot = windowStart; slot <= newest; slot = addGkgSlots(slot, 1)) {
    for (const feed of GKG_FEEDS) {
      if (slot <= manifests[feed].slot && !known.has(`${feed}/${slot}`))
        pending.push({ feed, slot });
    }
  }
  return pending;
}

/**
 * Drop rows whose URL the store already holds under a newer `date`, so a URL keeps its newest
 * row whatever order slots are ingested in (the expiry rule deletes by stored `date`). Within
 * the file, the last row of a repeated URL wins, as the upsert would.
 */
function withoutOlderDuplicates(db: SqliteHandle, rows: GkgArticleRow[]): GkgArticleRow[] {
  const byUrl = new Map(rows.map((row) => [row.url, row]));
  const storedDate = db.prepare<{ date: string }>('SELECT date FROM gkg_articles WHERE url = ?');
  const kept: GkgArticleRow[] = [];
  for (const row of byUrl.values()) {
    const stored = storedDate.get(row.url)?.date;
    if (stored === undefined || stored <= row.date) kept.push(row);
  }
  return kept;
}

/**
 * URLs of the oldest stored `date` before the window, minus any URL `records` is about to
 * rewrite (its row moves to the newer slot instead of going). Empty when nothing has expired.
 */
function expiredTombstones(
  db: SqliteHandle,
  windowStart: string,
  records: GkgArticleRow[],
): string[] {
  const oldest = db
    .prepare<{ date: string | null }>('SELECT MIN(date) AS date FROM gkg_articles WHERE date < ?')
    .get(windowStart)?.date;
  if (oldest == null) return [];
  const rewritten = new Set(records.map((r) => r.url));
  return db
    .prepare<{ url: string }>('SELECT url FROM gkg_articles WHERE date = ?')
    .all(oldest)
    .map((r) => r.url)
    .filter((url) => !rewritten.has(url));
}

function recordSlot(
  db: SqliteHandle,
  feed: GkgFeed,
  slot: string,
  status: GkgSlotStatus,
  rows: number,
): void {
  db.prepare('INSERT OR REPLACE INTO gkg_slots(feed, slot, status, rows) VALUES (?, ?, ?, ?)').run(
    feed,
    slot,
    status,
    rows,
  );
}

function deleteLedgerBefore(db: SqliteHandle, slot: string): void {
  db.prepare('DELETE FROM gkg_slots WHERE slot < ?').run(slot);
}

function countDomainCountries(db: SqliteHandle): number {
  const row = db.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM gkg_domain_country').get();
  if (!row) throw new Error('COUNT(*) over gkg_domain_country returned no row');
  return row.n;
}

function insertDomainCountries(
  db: SqliteHandle,
  entries: Array<{ domain: string; fips: string; country: string }>,
): void {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO gkg_domain_country(domain, fips, country) VALUES (?, ?, ?)',
  );
  db.transaction(() => {
    for (const e of entries) insert.run(e.domain, e.fips, e.country);
  });
}

function readDomainCountryMap(db: SqliteHandle): Map<string, string> {
  return new Map(
    db
      .prepare<{ domain: string; fips: string }>('SELECT domain, fips FROM gkg_domain_country')
      .all()
      .map((r) => [r.domain, r.fips]),
  );
}

// ─── Inspection (mirror:verify) ───────────────────────────────────────────────

/** One feed's ledger: slot counts, the covered range, and every gap slot in it. */
type GkgFeedCoverage = {
  ingested: number;
  gaps: string[];
  oldest?: string;
  newest?: string;
};

type GkgMirrorReport = {
  integrity: { ok: boolean; results: string[] };
  status: MirrorStatus;
  rows: number;
  domains: number;
  feeds: Record<GkgFeed, GkgFeedCoverage>;
};

/** Integrity check, sync status, row count, and per-feed ledger coverage with gaps. */
export async function inspectGkgMirror(mirror: Mirror): Promise<GkgMirrorReport> {
  const integrity = await mirror.store.integrityCheck();
  const status = await mirror.status();
  const rows = await mirror.store.count();
  const db = await mirror.raw();
  const ledger = db
    .prepare<{ feed: GkgFeed; slot: string; status: GkgSlotStatus }>(
      'SELECT feed, slot, status FROM gkg_slots ORDER BY slot',
    )
    .all();
  const feeds = {} as Record<GkgFeed, GkgFeedCoverage>;
  for (const feed of GKG_FEEDS) {
    const entries = ledger.filter((e) => e.feed === feed);
    const oldest = entries[0]?.slot;
    const newest = entries.at(-1)?.slot;
    feeds[feed] = {
      ingested: entries.filter((e) => e.status === 'ingested').length,
      gaps: entries.filter((e) => e.status === 'gap').map((e) => e.slot),
      ...(oldest !== undefined && { oldest }),
      ...(newest !== undefined && { newest }),
    };
  }
  return { integrity, status, rows, domains: countDomainCountries(db), feeds };
}
