/**
 * @fileoverview Test helper: a throwaway GKG mirror store on disk, built from the production
 * store spec, with seeding for articles, the slot ledger, and the domain-to-country map.
 * @module tests/helpers/gkg-mirror-fixture
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type MirrorStore,
  type SqliteHandle,
  sqliteMirrorStore,
} from '@cyanheads/mcp-ts-core/mirror';
import {
  buildGkgMirrorStoreSpec,
  type GkgArticleRow,
  type GkgFeed,
  type GkgSlotStatus,
  reverseDomain,
} from '@/services/gkg-mirror/gkg-mirror-schema.js';

export type GkgMirrorFixture = {
  store: MirrorStore;
  handle: SqliteHandle;
  path: string;
  /** Close the store and delete its directory. */
  cleanup(): Promise<void>;
};

/** Open an empty store at a fresh temp path. */
export async function openGkgMirrorFixture(): Promise<GkgMirrorFixture> {
  const dir = await mkdtemp(join(tmpdir(), 'gkg-mirror-test-'));
  const path = join(dir, 'gkg-mirror.db');
  const store = sqliteMirrorStore(buildGkgMirrorStoreSpec(path));
  const handle = await store.raw();
  return {
    store,
    handle,
    path,
    async cleanup() {
      await store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** A complete row: `url`, `date`, and `domain` are required; `domain_rev` is derived from `domain`. */
export function gkgRow(
  fields: Pick<GkgArticleRow, 'url' | 'date' | 'domain'> &
    Partial<Omit<GkgArticleRow, 'domain_rev'>>,
): GkgArticleRow {
  return {
    title: '',
    language: 'eng',
    tone: 0,
    themes: '',
    persons: '',
    organizations: '',
    locations: '',
    source_country: null,
    image: null,
    ...fields,
    domain_rev: reverseDomain(fields.domain),
  };
}

/** Insert rows through the store's upsert path, so the FTS triggers run. */
export async function seedGkgRows(store: MirrorStore, rows: GkgArticleRow[]): Promise<void> {
  await store.applyBatch(rows, []);
}

/** Record ledger rows for slots. */
export function seedGkgSlots(
  handle: SqliteHandle,
  slots: Array<{ feed: GkgFeed; slot: string; status?: GkgSlotStatus; rows?: number }>,
): void {
  const insert = handle.prepare(
    'INSERT OR REPLACE INTO gkg_slots(feed, slot, status, rows) VALUES (?, ?, ?, ?)',
  );
  handle.transaction(() => {
    for (const s of slots) insert.run(s.feed, s.slot, s.status ?? 'ingested', s.rows ?? 0);
  });
}

/** Every 15-minute slot from `from` through `to`, both included (14-digit UTC). */
export function gkgSlotsBetween(from: string, to: string): string[] {
  const ms = (slot: string) =>
    Date.UTC(
      Number(slot.slice(0, 4)),
      Number(slot.slice(4, 6)) - 1,
      Number(slot.slice(6, 8)),
      Number(slot.slice(8, 10)),
      Number(slot.slice(10, 12)),
    );
  const slots: string[] = [];
  for (let t = ms(from); t <= ms(to); t += 15 * 60_000) {
    slots.push(new Date(t).toISOString().slice(0, 19).replace(/[-:T]/g, ''));
  }
  return slots;
}

/** Record `slots` as ingested (no rows) in both feeds. */
export function seedGkgBothFeeds(handle: SqliteHandle, slots: string[]): void {
  seedGkgSlots(
    handle,
    slots.flatMap((slot) => [
      { feed: 'english' as const, slot },
      { feed: 'translation' as const, slot },
    ]),
  );
}

/** Load domain-to-country entries. */
export function seedGkgDomainCountries(
  handle: SqliteHandle,
  entries: Array<{ domain: string; fips: string; country: string }>,
): void {
  const insert = handle.prepare(
    'INSERT OR REPLACE INTO gkg_domain_country(domain, fips, country) VALUES (?, ?, ?)',
  );
  handle.transaction(() => {
    for (const e of entries) insert.run(e.domain, e.fips, e.country);
  });
}
