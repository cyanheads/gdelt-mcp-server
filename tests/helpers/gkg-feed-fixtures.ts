/**
 * @fileoverview Test helper for the GKG feed: the fixtures in `tests/fixtures/gkg/`, single-entry
 * deflate zips built in-test, manifests for them, and a stub `FeedTransport` that serves a route
 * table and records every request and pause.
 *
 * Fixtures: `lastupdate*.txt` are real manifests; `english-rows.tsv`,
 * `translation-dup-id-rows.tsv` (two rows sharing `GKGRECORDID` 20261030150000-T0), and
 * `translation-multiline-record.tsv` (a record whose `V2EXTRASXML` spans six physical lines) are
 * real GKG rows with the `V2GCAM` column replaced by `wc:100,c1.1:1`; `domains-by-country.txt` is
 * the head of `DOMAINSBYCOUNTRY-ALLLANGUAGES.TXT` plus the real lines for the fixture rows'
 * domains.
 *
 * Also loaded by the test worker entry, so it imports only relative paths.
 * @module tests/helpers/gkg-feed-fixtures
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { crc32, deflateRawSync } from 'node:zlib';
import type { FeedTransport } from '../../src/services/gkg-mirror/gkg-feed.js';
import type { GkgFeed } from '../../src/services/gkg-mirror/gkg-mirror-schema.js';

const FIXTURES = new URL('../fixtures/gkg/', import.meta.url);

export function readGkgFixture(name: string): string {
  return readFileSync(new URL(name, FIXTURES), 'utf8');
}

/** Rewrite every record's `GKGRECORDID` prefix and `V2.1DATE` to `slot`; continuation lines pass through. */
export function atSlot(tsv: string, slot: string): string {
  return tsv
    .split('\n')
    .map((line) => {
      const cols = line.split('\t');
      if (cols.length < 2 || !/^\d{14}-/.test(cols[0] ?? '')) return line;
      cols[0] = `${slot}${(cols[0] ?? '').slice(14)}`;
      cols[1] = slot;
      return cols.join('\t');
    })
    .join('\n');
}

/**
 * A zip holding one deflate entry, laid out as GDELT's files are (sizes and CRC in the local
 * header, no data descriptor). Overrides write a wrong header field.
 */
export function buildGkgZip(
  text: string,
  overrides: { crc?: number; size?: number; method?: number; flags?: number } = {},
): Uint8Array {
  const data = Buffer.from(text, 'utf8');
  const compressed = deflateRawSync(data);
  const name = Buffer.from('fixture.gkg.csv');
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(overrides.flags ?? 0, 6);
  header.writeUInt16LE(overrides.method ?? 8, 8);
  header.writeUInt32LE(overrides.crc ?? crc32(data), 14);
  header.writeUInt32LE(compressed.length, 18);
  header.writeUInt32LE(overrides.size ?? data.length, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28);
  return new Uint8Array(Buffer.concat([header, name, compressed]));
}

const FILE_SUFFIX: Record<GkgFeed, string> = {
  english: '.gkg.csv.zip',
  translation: '.translation.gkg.csv.zip',
};

export const MANIFEST_URL: Record<GkgFeed, string> = {
  english: 'https://data.gdeltproject.org/gdeltv2/lastupdate.txt',
  translation: 'https://data.gdeltproject.org/gdeltv2/lastupdate-translation.txt',
};

export const DOMAIN_FILE_URL =
  'https://data.gdeltproject.org/blog/multilingual-source-country-crossreferencing-dataset/DOMAINSBYCOUNTRY-ALLLANGUAGES.TXT';

export function slotFileUrl(feed: GkgFeed, slot: string): string {
  return `https://data.gdeltproject.org/gdeltv2/${slot}${FILE_SUFFIX[feed]}`;
}

/** A `lastupdate` manifest whose GKG line lists `slot` with `zip`'s size and MD5 (`http://`, as GDELT writes it). */
export function manifestText(feed: GkgFeed, slot: string, zip?: Uint8Array): string {
  const bytes = zip?.length ?? 1000;
  const md5 = zip ? createHash('md5').update(zip).digest('hex') : '0'.repeat(32);
  const base = `http://data.gdeltproject.org/gdeltv2/${slot}${feed === 'translation' ? '.translation' : ''}`;
  return [
    `40341 357e80f9e18cd6e4fde1930d0ae5551c ${base}.export.CSV.zip`,
    `53510 8d8f50ee6879ed2d84240f23fd0e79bb ${base}.mentions.CSV.zip`,
    `${bytes} ${md5} http://data.gdeltproject.org/gdeltv2/${slot}${FILE_SUFFIX[feed]}`,
    '',
  ].join('\n');
}

/** What the stub answers for one URL. Unlisted URLs answer 404. */
export type StubResponse =
  | { status: number; body?: Uint8Array | string }
  | { error: Error }
  /** Never answers; rejects with the request signal's reason when it aborts. */
  | 'hang';

export type StubEvent =
  | { kind: 'request'; url: string; userAgent: string | null }
  | { kind: 'pause'; ms: number };

/** A transport over `routes` (mutable between runs) that records requests and pauses in order. */
export function stubFeedTransport(routes: Record<string, StubResponse>): {
  transport: FeedTransport;
  events: StubEvent[];
  requested: () => string[];
} {
  const events: StubEvent[] = [];
  const transport: FeedTransport = {
    fetch(url, init) {
      events.push({ kind: 'request', url, userAgent: new Headers(init.headers).get('user-agent') });
      const route = routes[url] ?? { status: 404 };
      if (route === 'hang') {
        return new Promise((_, reject) => {
          const signal = init.signal as AbortSignal;
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      if ('error' in route) return Promise.reject(route.error);
      return Promise.resolve(new Response(route.body ?? null, { status: route.status }));
    },
    async sleep(ms, signal) {
      signal.throwIfAborted();
      events.push({ kind: 'pause', ms });
    },
  };
  const requested = () => events.flatMap((e) => (e.kind === 'request' ? [e.url] : []));
  return { transport, events, requested };
}

/** One feed's file for one slot: GKG text served as a zip, or an explicit response. */
export type ScenarioFile = { feed: GkgFeed; slot: string } & (
  | { tsv: string }
  | { response: StubResponse }
);

/**
 * Routes for a sync run: both manifests (each listing its slot with that slot's zip, when the
 * scenario serves one), the slot files, and the domain-to-country fixture.
 */
export function scenarioRoutes(scenario: {
  manifestSlots: Record<GkgFeed, string>;
  files: ScenarioFile[];
}): Record<string, StubResponse> {
  const routes: Record<string, StubResponse> = {
    [DOMAIN_FILE_URL]: { status: 200, body: readGkgFixture('domains-by-country.txt') },
  };
  const zips = new Map<string, Uint8Array>();
  for (const file of scenario.files) {
    const url = slotFileUrl(file.feed, file.slot);
    if ('tsv' in file) {
      const zip = buildGkgZip(file.tsv);
      zips.set(url, zip);
      routes[url] = { status: 200, body: zip };
    } else {
      routes[url] = file.response;
    }
  }
  for (const feed of ['english', 'translation'] as const) {
    const slot = scenario.manifestSlots[feed];
    routes[MANIFEST_URL[feed]] = {
      status: 200,
      body: manifestText(feed, slot, zips.get(slotFileUrl(feed, slot))),
    };
  }
  return routes;
}
