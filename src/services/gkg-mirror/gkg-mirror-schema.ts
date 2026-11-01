/**
 * @fileoverview Store schema of the local GKG mirror: the `gkg_articles` table and its FTS5
 * index, the slot ledger (`gkg_slots`), and the domain-to-country map (`gkg_domain_country`).
 * Shared by the ingester, which writes rows in this shape, and the query layer, which reads them.
 * @module services/gkg-mirror/gkg-mirror-schema
 */

import type { Migration, SqliteMirrorStoreSpec } from '@cyanheads/mcp-ts-core/mirror';

/** Primary table; the framework names its FTS5 index `gkg_articles_fts` (external content, joined by rowid). */
export const GKG_ARTICLES_TABLE = 'gkg_articles';

/** FTS5 index over {@link GKG_FTS_COLUMNS}. */
export const GKG_ARTICLES_FTS = `${GKG_ARTICLES_TABLE}_fts`;

/** Columns DOC keywords and phrases match against. `themes` is matched only by `theme:`. */
export const GKG_KEYWORD_COLUMNS = ['title', 'persons', 'organizations', 'locations'] as const;

/** Every FTS5 column, in index order. */
const GKG_FTS_COLUMNS = [...GKG_KEYWORD_COLUMNS, 'themes'] as const;

/**
 * `tokenchars '_'` keeps a GKG theme ID (`TAX_FNCACT_PRESIDENT`) one token, so `theme:X`
 * matches the exact ID and never a longer ID it prefixes.
 */
const GKG_FTS_TOKENIZER = "unicode61 remove_diacritics 2 tokenchars '_'";

/** The two GKG feeds the mirror ingests. */
export type GkgFeed = 'english' | 'translation';

/** Ledger state of one feed slot. A slot absent from the ledger is pending. */
export type GkgSlotStatus = 'ingested' | 'gap';

/**
 * One `gkg_articles` row.
 *
 * - `date` is the 14-digit UTC slot (`YYYYMMDDHHMMSS`) the row was published in, which equals
 *   its `V2.1DATE`.
 * - `domain` is lowercase; `domain_rev` is it reversed character by character
 *   ({@link reverseDomain}), so a `domain:` suffix match is a `domain_rev` prefix range.
 * - `language` is the source language code as GKG writes it after `srclc:` (`fra`, `spa`), or
 *   `eng` for the English feed.
 * - `tone` is the first value of `V1.5TONE`, or null when GKG gave none.
 * - `themes` is the deduplicated theme IDs joined by single spaces; `persons`,
 *   `organizations`, and `locations` (location names only) are deduplicated names joined by
 *   `'; '`. Empty lists are `''`.
 * - `source_country` is the FIPS code from `gkg_domain_country` for `domain`, or null when the
 *   domain is not listed.
 * - `image` is `V2.1SHARINGIMAGE`, or null when empty.
 */
export type GkgArticleRow = {
  url: string;
  date: string;
  domain: string;
  domain_rev: string;
  title: string;
  language: string;
  tone: number | null;
  themes: string;
  persons: string;
  organizations: string;
  locations: string;
  source_country: string | null;
  image: string | null;
};

/** Reverse a lowercase domain character by character: `un.org` → `gro.nu`. */
export function reverseDomain(domain: string): string {
  return [...domain].reverse().join('');
}

/**
 * Creates the auxiliary tables the declarative spec does not describe. Idempotent: the
 * framework runs it on a new database as well as on upgrade.
 *
 * - `gkg_slots`: one row per ingested or skipped feed slot; the source of `coverage` and of
 *   init resume. Rows leave with their slot when it ages out of the window.
 * - `gkg_domain_country`: GDELT's DOMAINSBYCOUNTRY file (domain → FIPS code and country name),
 *   loaded at init.
 */
const auxiliaryTables: Migration = {
  version: 1,
  up(handle) {
    handle.exec(`CREATE TABLE IF NOT EXISTS gkg_slots (
  feed TEXT NOT NULL CHECK (feed IN ('english', 'translation')),
  slot TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ingested', 'gap')),
  rows INTEGER NOT NULL,
  PRIMARY KEY (feed, slot)
);
CREATE INDEX IF NOT EXISTS gkg_slots_slot_idx ON gkg_slots(slot);
CREATE TABLE IF NOT EXISTS gkg_domain_country (
  domain TEXT PRIMARY KEY NOT NULL,
  fips TEXT NOT NULL,
  country TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS gkg_domain_country_fips_idx ON gkg_domain_country(fips);`);
  },
};

/**
 * Store spec for `sqliteMirrorStore`, rooted at the operator's `GDELT_MIRROR_PATH`.
 *
 * Each `date`-leading index covers one family of DOC modes, so a query over a broad match reads
 * a narrow index instead of looking up the table row of every match: `(date)` the volume
 * timelines and artlist counts, `(date, language)` and `(date, source_country)` the breakdowns,
 * `(date, tone)` the tone timeline and histogram. The framework creates a missing index on open,
 * so a store built before one was declared gains it on its next start.
 */
export function buildGkgMirrorStoreSpec(path: string): SqliteMirrorStoreSpec {
  return {
    path,
    table: GKG_ARTICLES_TABLE,
    primaryKey: 'url',
    columns: {
      url: 'TEXT',
      date: 'TEXT NOT NULL',
      domain: 'TEXT NOT NULL',
      domain_rev: 'TEXT NOT NULL',
      title: 'TEXT NOT NULL',
      language: 'TEXT NOT NULL',
      tone: 'REAL',
      themes: 'TEXT NOT NULL',
      persons: 'TEXT NOT NULL',
      organizations: 'TEXT NOT NULL',
      locations: 'TEXT NOT NULL',
      source_country: 'TEXT',
      image: 'TEXT',
    } satisfies Record<keyof GkgArticleRow, string>,
    fts: [...GKG_FTS_COLUMNS],
    ftsTokenizer: GKG_FTS_TOKENIZER,
    indexes: [
      { columns: ['date'] },
      { columns: ['date', 'language'] },
      { columns: ['date', 'source_country'] },
      { columns: ['date', 'tone'] },
      { columns: ['domain_rev', 'date'] },
    ],
    version: 1,
    migrations: [auxiliaryTables],
  };
}
