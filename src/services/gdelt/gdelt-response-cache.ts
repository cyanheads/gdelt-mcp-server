/**
 * @fileoverview Process-wide memory of GDELT DOC and TV answers: a byte-charged LRU of stored
 * response bodies, and the fetches in flight that concurrent identical calls share. GDELT data
 * is public and requests carry no credentials, so one cache serves every session and tenant.
 * @module services/gdelt/gdelt-response-cache
 */

/** Byte budget for every stored body together; least-recently-used entries go first. */
const GDELT_CACHE_BUDGET_BYTES = 128 * 1024 * 1024;

/** Largest body stored. A larger answer is returned to its caller and not kept. */
export const GDELT_CACHE_MAX_ENTRY_BYTES = 32 * 1024 * 1024;

/**
 * How long an entry is kept after its fetch, unless evicted sooner. Also the ceiling on serving
 * it stale, so an expired entry is still there when a refetch is refused or comes back empty.
 */
export const GDELT_CACHE_RETENTION_MS = 24 * 60 * 60 * 1000;

/** One stored answer. Times are epoch milliseconds. */
export type GdeltCacheEntry = {
  /** The response body as UTF-8 bytes; every hit decodes and parses its own copy. */
  readonly body: Uint8Array;
  readonly fetchedAt: number;
  /** Served as a hit before this instant; refetched from it on. */
  readonly freshUntil: number;
  /** Servable in place of a refused, failed, or empty refetch before this instant. */
  readonly staleUntil: number;
};

/** An upstream answer as a fetch settles with it: the raw body and its parse. */
export type FetchedAnswer = { readonly text: string; readonly value: unknown };

/** A fetch in flight, shared by every concurrent call for the same URL and retry ladder. */
export type GdeltSharedFetch = {
  /** Settles with the answer, or the classified failure. */
  readonly result: Promise<FetchedAnswer>;
  /** Aborts the fetch; fired only when its last waiter leaves. */
  readonly controller: AbortController;
  /**
   * Whether a request for it has gone upstream yet. True from the first send on, across
   * retries; false while it waits in the queue, behind the request gap, or behind the cooldown.
   */
  readonly sent: () => boolean;
  /** Calls still waiting on `result`. */
  waiters: number;
  /** Set once a waiter has taken `result`'s parse; later waiters parse their own copy. */
  valueTaken: boolean;
};

/** Byte-charged LRU over stored GDELT answers, plus the fetches in flight. */
export class GdeltResponseCache {
  /** Map order is recency: the first key is the least recently used. */
  private readonly entries = new Map<string, GdeltCacheEntry>();
  private storedBytes = 0;
  /** Keyed by URL plus retry ladder; an entry leaves when its fetch settles or is abandoned. */
  readonly inFlight = new Map<string, GdeltSharedFetch>();

  /**
   * The stored answer for `url`, marked as the most recent use. An entry past its retention
   * is dropped and reads as a miss.
   */
  get(url: string): GdeltCacheEntry | undefined {
    const entry = this.entries.get(url);
    if (!entry) return;
    this.delete(url, entry);
    if (Date.now() - entry.fetchedAt >= GDELT_CACHE_RETENTION_MS) return;
    this.entries.set(url, entry);
    this.storedBytes += entry.body.byteLength;
    return entry;
  }

  /**
   * Store an answer, replacing any entry for `url`. A body over
   * {@link GDELT_CACHE_MAX_ENTRY_BYTES} is not stored. Entries past their retention are swept
   * first, then least-recently-used entries until the budget fits.
   */
  set(url: string, entry: GdeltCacheEntry): void {
    if (entry.body.byteLength > GDELT_CACHE_MAX_ENTRY_BYTES) return;
    const existing = this.entries.get(url);
    if (existing) this.delete(url, existing);
    const now = Date.now();
    for (const [key, stored] of this.entries) {
      if (now - stored.fetchedAt >= GDELT_CACHE_RETENTION_MS) this.delete(key, stored);
    }
    for (const [key, stored] of this.entries) {
      if (this.storedBytes + entry.body.byteLength <= GDELT_CACHE_BUDGET_BYTES) break;
      this.delete(key, stored);
    }
    this.entries.set(url, entry);
    this.storedBytes += entry.body.byteLength;
  }

  private delete(url: string, entry: GdeltCacheEntry): void {
    this.entries.delete(url);
    this.storedBytes -= entry.body.byteLength;
  }
}

let _cache: GdeltResponseCache | undefined;

/** Build the process-wide response cache, empty. Wired to `createApp({ setup })`. */
export function initGdeltResponseCache(): void {
  _cache = new GdeltResponseCache();
}

export function getGdeltResponseCache(): GdeltResponseCache {
  if (!_cache) {
    throw new Error(
      'GDELT response cache not initialized — call initGdeltResponseCache() in setup()',
    );
  }
  return _cache;
}

/**
 * Drop every stored answer. A fetch still in flight finishes for its waiters and stores into
 * the cache it started under. Wired to `createApp({ teardown })`.
 */
export function disposeGdeltResponseCache(): void {
  _cache = undefined;
}
