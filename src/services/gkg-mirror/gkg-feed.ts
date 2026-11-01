/**
 * @fileoverview GKG feed access for the local mirror: the two `lastupdate` manifests, 15-minute
 * slot arithmetic, paced downloads from data.gdeltproject.org, single-entry zip inflation with
 * its CRC-32 check (plus the manifest's size and MD5 for each feed's current slot), the
 * domain-to-country file, and the mapping from a GKG 2.1 row to a `gkg_articles` row.
 *
 * Runs inside the mirror worker and the mirror CLI scripts, so this module imports only
 * relative paths and Node built-ins.
 * @module services/gkg-mirror/gkg-feed
 */

import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { crc32, inflateRaw } from 'node:zlib';
import { type GkgArticleRow, type GkgFeed, reverseDomain } from './gkg-mirror-schema.js';

/** Both feeds, in the order a slot's files are fetched. */
export const GKG_FEEDS = ['english', 'translation'] as const satisfies readonly GkgFeed[];

const DATA_ORIGIN = 'https://data.gdeltproject.org';
const DATA_HOST = 'data.gdeltproject.org';

/** Each feed's manifest; the `http://` forms answer 301 to these. */
const GKG_MANIFEST_URLS: Readonly<Record<GkgFeed, string>> = {
  english: `${DATA_ORIGIN}/gdeltv2/lastupdate.txt`,
  translation: `${DATA_ORIGIN}/gdeltv2/lastupdate-translation.txt`,
};

const FILE_SUFFIX: Readonly<Record<GkgFeed, string>> = {
  english: '.gkg.csv.zip',
  translation: '.translation.gkg.csv.zip',
};

/** GDELT's domain → FIPS country file (37,472 domains; last modified 2015-12-26). */
const DOMAIN_COUNTRY_URL = `${DATA_ORIGIN}/blog/multilingual-source-country-crossreferencing-dataset/DOMAINSBYCOUNTRY-ALLLANGUAGES.TXT`;

/** Sent on every request so GDELT can identify the client. */
const GKG_USER_AGENT = 'gdelt-mcp-server (+https://github.com/cyanheads/gdelt-mcp-server)';

/** Fixed pause between consecutive requests of one sync run. */
const GKG_REQUEST_GAP_MS = 2000;

/** Deadline for one request, body included; the largest measured file is 12 MB. */
const GKG_REQUEST_TIMEOUT_MS = 120_000;

/** Ceiling on a zip entry's declared uncompressed size; measured files inflate to ≤ 40 MB. */
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;

const GKG_SLOT_MINUTES = 15;
export const GKG_SLOTS_PER_DAY = 96;
export const GKG_SLOT_MS = GKG_SLOT_MINUTES * 60_000;

/** GKG 2.1 rows have exactly this many tab-separated columns. */
const GKG_COLUMN_COUNT = 27;

// ─── Errors ───────────────────────────────────────────────────────────────────

/**
 * Why a sync run stopped.
 *
 * - `upstream_refused`: a status other than 200 (and other than 404 on a slot file).
 * - `network_error`: no response, or the response did not finish within the deadline.
 * - `integrity_mismatch`: a file failed its CRC-32, size, or manifest MD5 check, or is not a
 *   single-entry deflate zip.
 * - `manifest_malformed` / `domain_file_malformed`: a body that does not parse.
 */
type GkgFeedFailure =
  | 'upstream_refused'
  | 'network_error'
  | 'integrity_mismatch'
  | 'manifest_malformed'
  | 'domain_file_malformed';

/** A failure that stops the current sync run; the next run resumes from the slot ledger. */
export class GkgFeedError extends Error {
  override readonly name = 'GkgFeedError';
  readonly reason: GkgFeedFailure;
  readonly url: string;
  /** HTTP status, for `upstream_refused`. */
  readonly status: number | undefined;

  constructor(
    reason: GkgFeedFailure,
    message: string,
    details: { url: string; status?: number; cause?: unknown },
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.reason = reason;
    this.url = details.url;
    this.status = details.status;
  }
}

// ─── Slots ────────────────────────────────────────────────────────────────────

/**
 * Epoch milliseconds of a 14-digit UTC slot (`YYYYMMDDHHMMSS` on a 15-minute boundary), or
 * undefined for anything else.
 */
export function parseGkgSlot(value: string): number | undefined {
  if (value.length !== 14) return;
  for (let i = 0; i < 14; i++) {
    const c = value.charCodeAt(i);
    if (c < 48 || c > 57) return;
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const hour = Number(value.slice(8, 10));
  const minute = Number(value.slice(10, 12));
  const second = Number(value.slice(12, 14));
  if (second !== 0 || minute % GKG_SLOT_MINUTES !== 0) return;
  const ms = Date.UTC(year, month - 1, day, hour, minute);
  return gkgSlotFromMs(ms) === value ? ms : undefined;
}

/** The 14-digit UTC slot label of an instant already on a slot boundary. */
export function gkgSlotFromMs(ms: number): string {
  return new Date(ms).toISOString().replace(/\D/g, '').slice(0, 14);
}

/** The slot `count` slots after `slot` (before it when negative). `slot` must be valid. */
export function addGkgSlots(slot: string, count: number): string {
  return gkgSlotFromMs(requireSlot(slot) + count * GKG_SLOT_MS);
}

/** Minutes from `earlier` to `later`. */
export function minutesBetweenSlots(later: string, earlier: string): number {
  return (requireSlot(later) - requireSlot(earlier)) / 60_000;
}

function requireSlot(slot: string): number {
  const ms = parseGkgSlot(slot);
  if (ms === undefined) throw new TypeError(`Not a GKG slot: ${slot}`);
  return ms;
}

/** Download URL of one feed's file for one slot. */
function gkgFileUrl(feed: GkgFeed, slot: string): string {
  return `${DATA_ORIGIN}/gdeltv2/${slot}${FILE_SUFFIX[feed]}`;
}

// ─── Manifests ────────────────────────────────────────────────────────────────

/** The GKG line of a feed's manifest: its newest slot, that file's `https://` URL, size, and MD5. */
export type GkgManifest = {
  feed: GkgFeed;
  slot: string;
  url: string;
  bytes: number;
  /** Lowercase hex. */
  md5: string;
};

/**
 * Pick the GKG line out of a `lastupdate` manifest (three `<bytes> <md5> <url>` lines: export,
 * mentions, gkg). The URL must name this feed's GKG file on data.gdeltproject.org; it is
 * returned rewritten to `https://`.
 */
export function parseManifest(text: string, feed: GkgFeed): GkgManifest {
  const manifestUrl = GKG_MANIFEST_URLS[feed];
  for (const line of text.split('\n')) {
    const parts = line.trim().split(' ');
    if (parts.length !== 3) continue;
    const [bytesText = '', md5 = '', rawUrl = ''] = parts;
    const slot = gkgSlotOfUrl(rawUrl, feed);
    if (slot === undefined) continue;
    const bytes = Number(bytesText);
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || !isMd5Hex(md5)) break;
    return { feed, slot, url: gkgFileUrl(feed, slot), bytes, md5: md5.toLowerCase() };
  }
  throw new GkgFeedError(
    'manifest_malformed',
    `The ${feed} GKG manifest (${manifestUrl}) has no well-formed GKG line.`,
    { url: manifestUrl },
  );
}

/** The slot a manifest URL names when it is this feed's GKG file on data.gdeltproject.org. */
function gkgSlotOfUrl(rawUrl: string, feed: GkgFeed): string | undefined {
  if (!URL.canParse(rawUrl)) return;
  const url = new URL(rawUrl);
  if (url.hostname !== DATA_HOST || (url.protocol !== 'http:' && url.protocol !== 'https:')) return;
  const name = url.pathname.startsWith('/gdeltv2/') ? url.pathname.slice('/gdeltv2/'.length) : '';
  const slot = name.slice(0, 14);
  if (name !== `${slot}${FILE_SUFFIX[feed]}` || parseGkgSlot(slot) === undefined) return;
  return slot;
}

function isMd5Hex(value: string): boolean {
  if (value.length !== 32) return false;
  for (let i = 0; i < 32; i++) {
    const c = value.charCodeAt(i) | 0x20; // ASCII lowercase
    if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 102))) return false;
  }
  return true;
}

// ─── Zip ──────────────────────────────────────────────────────────────────────

const inflateRawAsync = promisify(inflateRaw);
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const DEFLATE = 8;
const FLAG_DATA_DESCRIPTOR = 0x08;

/**
 * Inflate the first entry of a GKG zip and check it against its local header: deflate method,
 * sizes in the header, the declared uncompressed size, and the CRC-32. Any mismatch throws
 * `integrity_mismatch` and nothing from the file is used.
 */
export async function inflateSingleEntryZip(zip: Uint8Array, url: string): Promise<Uint8Array> {
  const fail = (detail: string) =>
    new GkgFeedError('integrity_mismatch', `GKG file ${url} failed its zip check: ${detail}.`, {
      url,
    });
  if (zip.length < 30) throw fail('shorter than a zip local header');
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  if (view.getUint32(0, true) !== LOCAL_HEADER_SIGNATURE) throw fail('no zip local header');
  const flags = view.getUint16(6, true);
  const method = view.getUint16(8, true);
  const crc = view.getUint32(14, true);
  const compressedSize = view.getUint32(18, true);
  const size = view.getUint32(22, true);
  const dataStart = 30 + view.getUint16(26, true) + view.getUint16(28, true);
  if (method !== DEFLATE) throw fail(`compression method ${method}, expected deflate`);
  if (flags & FLAG_DATA_DESCRIPTOR) throw fail('sizes are not in the local header');
  if (dataStart + compressedSize > zip.length) throw fail('entry runs past the end of the file');
  if (size > MAX_ENTRY_BYTES) throw fail(`declared size ${size} exceeds ${MAX_ENTRY_BYTES} bytes`);

  let inflated: Uint8Array;
  try {
    inflated = await inflateRawAsync(zip.subarray(dataStart, dataStart + compressedSize), {
      maxOutputLength: Math.max(size, 1),
    });
  } catch (error) {
    throw new GkgFeedError('integrity_mismatch', `GKG file ${url} failed to inflate.`, {
      url,
      cause: error,
    });
  }
  if (inflated.length !== size)
    throw fail(`inflated to ${inflated.length} bytes, header says ${size}`);
  if (crc32(inflated) >>> 0 !== crc) throw fail('CRC-32 mismatch');
  return inflated;
}

/** Check a downloaded file against its manifest line's byte size and MD5. */
function verifyManifestDigest(zip: Uint8Array, manifest: GkgManifest): void {
  const md5 = createHash('md5').update(zip).digest('hex');
  if (zip.length !== manifest.bytes || md5 !== manifest.md5) {
    throw new GkgFeedError(
      'integrity_mismatch',
      `GKG file ${manifest.url} does not match its manifest (${zip.length} bytes, md5 ${md5}; manifest: ${manifest.bytes} bytes, md5 ${manifest.md5}).`,
      { url: manifest.url },
    );
  }
}

// ─── Transport and session ────────────────────────────────────────────────────

/** The network seam: `fetch`, and a sleep that rejects with the signal's reason when it aborts. */
export type FeedTransport = {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
};

/** The real network. */
export const defaultFeedTransport: FeedTransport = {
  fetch: (url, init) => fetch(url, init),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    }),
};

/** A slot file's fetch outcome: 404 is `missing`; every other non-200 throws. */
type GkgSlotFile = { kind: 'missing' } | { kind: 'file'; text: string };

const EMPTY = new Uint8Array(0);

/**
 * One sync run's view of data.gdeltproject.org: every request carries {@link GKG_USER_AGENT},
 * waits {@link GKG_REQUEST_GAP_MS} after the previous one finished, and is bounded by its own
 * deadline. Aborting the run's signal rejects with the signal's reason, untouched.
 */
export class GkgFeedSession {
  readonly #transport: FeedTransport;
  readonly #signal: AbortSignal;
  #requested = false;

  constructor(transport: FeedTransport, signal: AbortSignal) {
    this.#transport = transport;
    this.#signal = signal;
  }

  /** A feed's current manifest line. */
  async manifest(feed: GkgFeed): Promise<GkgManifest> {
    const url = GKG_MANIFEST_URLS[feed];
    return parseManifest(new TextDecoder().decode(await this.#getOk(url)), feed);
  }

  /**
   * One feed's file for one slot, inflated and checked. Pass the feed's manifest when `slot`
   * is its manifest slot, so the download is also checked against the manifest's size and MD5.
   */
  async slotFile(feed: GkgFeed, slot: string, manifest?: GkgManifest): Promise<GkgSlotFile> {
    const url = gkgFileUrl(feed, slot);
    const { status, body } = await this.#get(url);
    if (status === 404) return { kind: 'missing' };
    if (status !== 200) throw refused(url, status);
    if (manifest) verifyManifestDigest(body, manifest);
    return { kind: 'file', text: new TextDecoder().decode(await inflateSingleEntryZip(body, url)) };
  }

  /** The domain-to-country file's text. */
  async domainCountryFile(): Promise<string> {
    return new TextDecoder().decode(await this.#getOk(DOMAIN_COUNTRY_URL));
  }

  async #getOk(url: string): Promise<Uint8Array> {
    const { status, body } = await this.#get(url);
    if (status !== 200) throw refused(url, status);
    return body;
  }

  async #get(url: string): Promise<{ status: number; body: Uint8Array }> {
    if (this.#requested) await this.#transport.sleep(GKG_REQUEST_GAP_MS, this.#signal);
    this.#requested = true;
    const signal = AbortSignal.any([this.#signal, AbortSignal.timeout(GKG_REQUEST_TIMEOUT_MS)]);
    try {
      const response = await this.#transport.fetch(url, {
        headers: { 'User-Agent': GKG_USER_AGENT },
        signal,
      });
      if (response.status !== 200) {
        await response.body?.cancel();
        return { status: response.status, body: EMPTY };
      }
      return { status: 200, body: new Uint8Array(await response.arrayBuffer()) };
    } catch (error) {
      if (this.#signal.aborted) throw this.#signal.reason;
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      throw new GkgFeedError(
        'network_error',
        timedOut
          ? `Request to ${url} did not finish within ${GKG_REQUEST_TIMEOUT_MS / 1000} s.`
          : `Request to ${url} failed before a response arrived.`,
        { url, cause: error },
      );
    }
  }
}

function refused(url: string, status: number): GkgFeedError {
  return new GkgFeedError(
    'upstream_refused',
    `data.gdeltproject.org answered HTTP ${status} for ${url}; the run stopped and the next run resumes from the slot ledger.`,
    { url, status },
  );
}

// ─── Domain-to-country file ───────────────────────────────────────────────────

type DomainCountry = { domain: string; fips: string; country: string };

/**
 * Parse `DOMAINSBYCOUNTRY-ALLLANGUAGES.TXT`: a `SourceCommonName\tlocation\t` header, then
 * `domain\tFIPS\tCountry Name` lines. A domain listed more than once (148 are, with conflicting
 * codes) keeps its first entry. Throws when no line parses.
 */
export function parseDomainCountryFile(text: string): DomainCountry[] {
  const byDomain = new Map<string, DomainCountry>();
  for (const line of text.split('\n')) {
    const [rawDomain = '', rawFips = '', rawCountry = ''] = line.split('\t');
    const domain = rawDomain.trim().toLowerCase();
    const fips = rawFips.trim().toUpperCase();
    const country = rawCountry.trim();
    if (!domain || fips.length !== 2 || !country || domain === 'sourcecommonname') continue;
    if (!byDomain.has(domain)) byDomain.set(domain, { domain, fips, country });
  }
  if (byDomain.size === 0) {
    throw new GkgFeedError(
      'domain_file_malformed',
      `The domain-to-country file (${DOMAIN_COUNTRY_URL}) has no domain lines.`,
      { url: DOMAIN_COUNTRY_URL },
    );
  }
  return [...byDomain.values()];
}

// ─── Rows ─────────────────────────────────────────────────────────────────────

/** Column positions in a GKG 2.1 row, 0-based (the issue's table is 1-based). */
const COL = {
  date: 1,
  sourceCommonName: 3,
  documentIdentifier: 4,
  themes: 7,
  locations: 9,
  persons: 11,
  organizations: 13,
  tone: 15,
  sharingImage: 18,
  translationInfo: 25,
  extrasXml: 26,
} as const;

/** Rows mapped from one GKG file, and the count of records that were not GKG 2.1 rows. */
type ParsedGkgFile = { rows: GkgArticleRow[]; skipped: number };

/**
 * Map a GKG 2.1 file to `gkg_articles` rows (column table in issue #75). A record runs from a
 * line that starts with a `GKGRECORDID` to the next such line: `V2EXTRASXML` can carry raw
 * newlines (a `<PAGE_LINKS>` list broken across lines, with `<PAGE_TITLE>` on the last one), so
 * the lines in between belong to the record's last column. A record without 27 columns, a URL,
 * or a slot-shaped `V2.1DATE` is skipped and counted. `sourceCountry` resolves a lowercase domain
 * to its FIPS code, or null when the domain is not listed.
 */
export function parseGkgFile(
  text: string,
  sourceCountry: (domain: string) => string | null,
): ParsedGkgFile {
  const rows: GkgArticleRow[] = [];
  let skipped = 0;
  let record: string | undefined;
  const flush = () => {
    if (record === undefined) return;
    const cols = record.split('\t');
    const row = cols.length === GKG_COLUMN_COUNT ? mapGkgColumns(cols, sourceCountry) : undefined;
    if (row) rows.push(row);
    else skipped++;
    record = undefined;
  };
  for (const line of text.split('\n')) {
    const raw = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (raw === '') continue;
    if (startsGkgRecord(raw)) {
      flush();
      record = raw;
    } else if (record !== undefined) {
      record += `\n${raw}`;
    } else {
      skipped++;
    }
  }
  flush();
  return { rows, skipped };
}

/** A line opens a record when it starts `<slot>-<n>\t<slot>\t`: `GKGRECORDID`, then `V2.1DATE`. */
function startsGkgRecord(line: string): boolean {
  const tab = line.indexOf('\t');
  if (tab < 16 || line.charCodeAt(14) !== 45 /* - */) return false;
  const date = line.slice(0, 14);
  return line.startsWith(`${date}\t`, tab + 1) && parseGkgSlot(date) !== undefined;
}

function mapGkgColumns(
  cols: string[],
  sourceCountry: (domain: string) => string | null,
): GkgArticleRow | undefined {
  const col = (i: number) => cols[i] ?? '';
  const url = col(COL.documentIdentifier).trim();
  const date = col(COL.date);
  if (!url || parseGkgSlot(date) === undefined) return;
  const domain = col(COL.sourceCommonName).trim().toLowerCase();
  const toneText = col(COL.tone);
  const comma = toneText.indexOf(',');
  const tone = Number.parseFloat(comma === -1 ? toneText : toneText.slice(0, comma));
  const image = col(COL.sharingImage).trim();
  return {
    url,
    date,
    domain,
    domain_rev: reverseDomain(domain),
    title: extractPageTitle(col(COL.extrasXml)),
    language: sourceLanguage(col(COL.translationInfo)),
    tone: Number.isFinite(tone) ? tone : null,
    themes: distinct(col(COL.themes).split(';')).join(' '),
    persons: distinct(col(COL.persons).split(';')).join('; '),
    organizations: distinct(col(COL.organizations).split(';')).join('; '),
    locations: distinct(
      col(COL.locations)
        .split(';')
        .map((entry) => entry.split('#')[1] ?? ''),
    ).join('; '),
    source_country: domain ? sourceCountry(domain) : null,
    image: image || null,
  };
}

/** Non-empty trimmed values, first occurrence kept. */
function distinct(values: string[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen];
}

/** `srclc:fas;eng:GT-FAS 1.0` → `fas`; empty (the English feed) → `eng`. */
function sourceLanguage(translationInfo: string): string {
  for (const part of translationInfo.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith('srclc:') && trimmed.length > 6) return trimmed.slice(6).toLowerCase();
  }
  return 'eng';
}

const TITLE_OPEN = '<PAGE_TITLE>';
const TITLE_CLOSE = '</PAGE_TITLE>';

/** The `<PAGE_TITLE>` of a `V2EXTRASXML` value, entities decoded and trimmed; `''` when absent. */
export function extractPageTitle(extrasXml: string): string {
  const open = extrasXml.indexOf(TITLE_OPEN);
  if (open === -1) return '';
  const start = open + TITLE_OPEN.length;
  const close = extrasXml.indexOf(TITLE_CLOSE, start);
  return decodeHtmlEntities(extrasXml.slice(start, close === -1 ? undefined : close)).trim();
}

/** The named references GKG titles carry; every other character arrives as a numeric reference. */
const NAMED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', ' '],
]);

/** Longest reference body scanned for its `;` (`#x10FFFF` is 8; named ones are shorter). */
const MAX_REFERENCE_LENGTH = 10;

/**
 * Decode numeric (`&#1605;`, `&#x645;`) and {@link NAMED_ENTITIES} references in one pass. A
 * reference that does not decode is kept as written. Each `&` scans at most
 * {@link MAX_REFERENCE_LENGTH} characters for its `;`, so the pass is linear in the input.
 */
export function decodeHtmlEntities(text: string): string {
  let amp = text.indexOf('&');
  if (amp === -1) return text;
  let out = '';
  let copied = 0;
  while (amp !== -1) {
    const limit = Math.min(text.length, amp + 2 + MAX_REFERENCE_LENGTH);
    let semi = amp + 1;
    while (semi < limit && text.charCodeAt(semi) !== 59 /* ; */) semi++;
    const decoded = semi < limit ? decodeReference(text.slice(amp + 1, semi)) : undefined;
    if (decoded === undefined) {
      amp = text.indexOf('&', amp + 1);
      continue;
    }
    out += text.slice(copied, amp) + decoded;
    copied = semi + 1;
    amp = text.indexOf('&', copied);
  }
  return out + text.slice(copied);
}

function decodeReference(body: string): string | undefined {
  if (body.charCodeAt(0) !== 35 /* # */) return NAMED_ENTITIES.get(body);
  const hex = body.charCodeAt(1) === 120 || body.charCodeAt(1) === 88; // x X
  const digits = body.slice(hex ? 2 : 1);
  if (digits.length === 0 || digits.length > (hex ? 6 : 7)) return;
  let codePoint = 0;
  for (let i = 0; i < digits.length; i++) {
    const c = digits.charCodeAt(i);
    const lower = c | 0x20;
    let value: number;
    if (c >= 48 && c <= 57) value = c - 48;
    else if (hex && lower >= 97 && lower <= 102) value = lower - 87;
    else return;
    codePoint = codePoint * (hex ? 16 : 10) + value;
  }
  if (codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff))
    return;
  return String.fromCodePoint(codePoint);
}
