/**
 * @fileoverview The DOC source router at its own seam: every row of the DOC-then-mirror outcome
 * table (DOC answered, answered empty, or refused; the mirror answered, answered empty, or could
 * not answer), the gate-first refusal and the 45 s / 55 s bounds that keep each row under the 60 s
 * client timeout, the caller's cancellation in each phase, a stale DOC answer winning over the
 * mirror, and the unchanged path with no mirror attached. The real `gdeltFetch`, retry ladder,
 * pacer (at production spacing), and response cache run with the global `fetch` stubbed; the mirror
 * is a fake honoring the client's contract.
 * @module tests/services/doc-source-router.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type DocMirror,
  type DocRouted,
  disposeDocSourceRouter,
  initDocSourceRouter,
  routeArticleSearch,
  routeBreakdown,
  routeTimeline,
  routeToneDistribution,
} from '@/services/gdelt/doc-source-router.js';
import { getGdeltDocService, initGdeltDocService } from '@/services/gdelt/gdelt-doc-service.js';
import { gdeltFetch } from '@/services/gdelt/gdelt-fetch.js';
import { disposeGdeltPacer, getGdeltPacer, initGdeltPacer } from '@/services/gdelt/gdelt-pacer.js';
import {
  disposeGdeltResponseCache,
  initGdeltResponseCache,
} from '@/services/gdelt/gdelt-response-cache.js';
import type {
  MirrorCoverageStatus,
  MirrorRequest,
  MirrorResponse,
  MirrorResult,
  MirrorWindow,
} from '@/services/gkg-mirror/types.js';

const BASE_URL = 'https://api.gdeltproject.org/api/v2';
const NOW = Date.parse('2026-11-01T12:00:00Z');
const MINUTE = 60_000;

/** The production `GDELT_REQUEST_DELAY_MS` default. */
const PRODUCTION_GAP_MS = 5_300;
/** Past every settle the table expects, the 120 s DOC call deadline included. */
const HORIZON_MS = 150_000;

const OLDEST = '20261025120000';
const NEWEST = '20261101113000';
const READY: MirrorCoverageStatus = {
  ready: true,
  oldestSlot: OLDEST,
  newestSlot: NEWEST,
};

const RATE_LIMIT_TEXT = 'Please limit requests to one every 5 seconds.';
const RATE_LIMIT_HINT =
  'Back off before retrying; five seconds is minimum request spacing, not a recovery guarantee, and rate limiting may persist longer. Honor Retry-After when supplied.';
const UNAVAILABLE_HINT = 'Retry after a short delay; GDELT may be temporarily unavailable.';

const DOC_ARTICLE = {
  url: 'https://example.com/doc',
  title: 'From DOC',
  seendate: '20261101T110000Z',
  domain: 'example.com',
  language: 'English',
  sourcecountry: 'United States',
};
const MIRROR_ARTICLE = {
  url: 'https://example.org/mirror',
  title: 'From the mirror',
  seendate: '20261101T110000Z',
  domain: 'example.org',
  language: 'English',
  sourcecountry: '',
};

/** A 24-hour artlist call at NOW: requested 2026-10-31T12:00 – 2026-11-01T12:00. */
const SEARCH = { query: 'climate', timespan: '24h', maxRecords: 75, sort: 'relevance' } as const;

/** SEARCH with no timespan: DOC's default window, or explicit dates spread over it. */
const { timespan: _, ...UNTIMED } = SEARCH;

/** What the mirror answers SEARCH with: it holds slots only through NEWEST. */
const SEARCH_COVERAGE = {
  requestedStart: '2026-10-31T12:00:00Z',
  requestedEnd: '2026-11-01T12:00:00Z',
  answeredStart: '2026-10-31T12:00:00Z',
  answeredEnd: '2026-11-01T11:30:00Z',
  missingSlots: 0,
};

const MIRROR_ARTLIST: MirrorResult = {
  kind: 'artlist',
  result: { articles: [MIRROR_ARTICLE], totalReturned: 1 },
};
const MIRROR_NO_ARTICLES: MirrorResult = {
  kind: 'artlist',
  result: { articles: [], totalReturned: 0 },
};

// ─── Upstream and mirror fakes ────────────────────────────────────────────────

type Upstream = (url: string, init?: RequestInit) => Promise<Response>;
let upstream: ReturnType<typeof vi.fn<Upstream>>;

const ok = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200 });
const refused = () => new Response(RATE_LIMIT_TEXT, { status: 429 });

/** Answer each DOC request by its `query`; `'hang'` holds it open until its signal aborts. */
function answerDoc(pick: (query: string) => 'hang' | (() => Response)): void {
  upstream.mockImplementation((url, init) => {
    const behaviour = pick(new URL(url).searchParams.get('query') ?? '');
    if (behaviour !== 'hang') return Promise.resolve(behaviour());
    const signal = init?.signal as AbortSignal;
    return new Promise<Response>((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
}

/** DOC requests sent for `query`. */
function requestsFor(query: string): number {
  return upstream.mock.calls.filter(([url]) => new URL(url).searchParams.get('query') === query)
    .length;
}

/** ISO 8601 for a 14-digit UTC stamp, as the mirror renders coverage. */
function iso(stamp: string): string {
  return `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:${stamp.slice(12, 14)}Z`;
}

/** An `answered` response over `window` clipped to the slots the fake holds. */
function answered(result: MirrorResult, matched: number) {
  return ({ window }: { window: MirrorWindow }): MirrorResponse => ({
    outcome: 'answered',
    answer: result,
    matched,
    coverage: {
      requestedStart: iso(window.startDatetime),
      requestedEnd: iso(window.endDatetime),
      answeredStart: iso(window.startDatetime > OLDEST ? window.startDatetime : OLDEST),
      answeredEnd: iso(window.endDatetime < NEWEST ? window.endDatetime : NEWEST),
      missingSlots: 0,
    },
  });
}

type FakeMirrorOptions = {
  status?: MirrorCoverageStatus | Error | (() => Promise<MirrorCoverageStatus>);
  respond?: (req: MirrorRequest) => MirrorResponse;
  /** How long `execute` takes; `Infinity` never answers. */
  delayMs?: number;
};

/**
 * Attach a fake mirror honoring the client's contract: `status()` and `execute()` reject with the
 * signal's reason, untouched, the moment it aborts.
 */
function attachMirror({
  status = READY,
  respond = answered(MIRROR_ARTLIST, 1),
  delayMs = 0,
}: FakeMirrorOptions = {}) {
  const signals: AbortSignal[] = [];
  const mirror = {
    status: vi.fn(async (signal?: AbortSignal) => {
      signal?.throwIfAborted();
      if (status instanceof Error) throw status;
      if (typeof status !== 'function') return status;
      const aborted = Promise.withResolvers<never>();
      signal?.addEventListener('abort', () => aborted.reject(signal.reason), { once: true });
      return Promise.race([status(), aborted.promise]);
    }),
    execute: vi.fn(
      (req: MirrorRequest, signal: AbortSignal) =>
        new Promise<MirrorResponse>((resolve, reject) => {
          signals.push(signal);
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          // An instant answer settles on the microtask queue, adding nothing to the clock.
          if (delayMs === 0) {
            resolve(respond(req));
            return;
          }
          const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason);
          };
          const timer =
            delayMs === Number.POSITIVE_INFINITY
              ? undefined
              : setTimeout(() => {
                  signal.removeEventListener('abort', onAbort);
                  resolve(respond(req));
                }, delayMs);
          signal.addEventListener('abort', onAbort, { once: true });
        }),
    ),
  } satisfies DocMirror;
  initDocSourceRouter(() => mirror);
  return { ...mirror, signals };
}

/**
 * Watch `pending` without driving the clock: `result()` resolves to its value or error and how
 * long after now, on the fake clock, it settled.
 */
function timed<T>(pending: Promise<T>) {
  const startedAt = Date.now();
  let settledAt: number | undefined;
  const outcome = pending.then(
    (value) => {
      settledAt = Date.now();
      return { value, error: undefined };
    },
    (error: unknown) => {
      settledAt = Date.now();
      return { value: undefined, error: error as McpError };
    },
  );
  return {
    async result() {
      const settled = await outcome;
      if (settledAt === undefined) throw new Error('the call never settled');
      return { ...settled, afterMs: settledAt - startedAt };
    },
  };
}

/** Run `pending` to the horizon and measure on the fake clock how long after now it settled. */
async function settle<T>(pending: Promise<T>) {
  const watched = timed(pending);
  await vi.advanceTimersByTimeAsync(HORIZON_MS);
  return watched.result();
}

/** Close the cooldown gate with one refused request for another query. */
async function closeCooldownGate(): Promise<void> {
  const refusal = gdeltFetch(
    `${BASE_URL}/doc/doc`,
    new URLSearchParams({ query: 'other' }),
    createMockContext(),
    'test',
    'GDELT DOC',
  ).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(0);
  await refusal;
  expect(getGdeltPacer().cooldown.remainingMs).toBe(5_000);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  // The midpoint draw makes every retry backoff exactly its nominal value.
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  upstream = vi.fn<Upstream>(async () => {
    throw new Error('unmocked fetch');
  });
  vi.stubGlobal('fetch', upstream);
  initGdeltPacer(PRODUCTION_GAP_MS);
  initGdeltResponseCache();
  initGdeltDocService({} as never, {} as never, { baseUrl: BASE_URL } as never);
});

afterEach(() => {
  disposeDocSourceRouter();
  disposeGdeltPacer();
  disposeGdeltResponseCache();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ─── No mirror ────────────────────────────────────────────────────────────────

describe('with no mirror attached', () => {
  it('calls DOC exactly as the tools did before routing, and adds nothing to the answer', async () => {
    answerDoc(() => ok({ articles: [DOC_ARTICLE] }));
    const search = vi.spyOn(getGdeltDocService(), 'searchArticles');
    const ctx = createMockContext();

    const { value, afterMs } = await settle(routeArticleSearch(SEARCH, ctx));

    expect(value).toEqual({ result: { articles: [DOC_ARTICLE], totalReturned: 1 } });
    expect(search.mock.calls).toEqual([[SEARCH, ctx]]);
    expect(getEnrichment(ctx)).toEqual({});
    expect(afterMs).toBe(0);
  });

  it('passes an empty answer through untouched', async () => {
    answerDoc(() => ok({}));
    const ctx = createMockContext();

    const { value } = await settle(routeArticleSearch(SEARCH, ctx));

    expect(value).toEqual({ result: { articles: [], totalReturned: 0 } });
    expect(getEnrichment(ctx)).toEqual({});
  });

  it("rejects with DOC's own error, carrying no attempts", async () => {
    answerDoc(() => refused);

    const { error } = await settle(routeArticleSearch(SEARCH, createMockContext()));

    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'gdelt_rate_limited', recovery: { hint: RATE_LIMIT_HINT } },
    });
    expect(error?.data).not.toHaveProperty('attempts');
  });

  it('treats a disposed mirror client as no mirror', async () => {
    initDocSourceRouter(() => undefined);
    answerDoc(() => ok({ articles: [DOC_ARTICLE] }));
    const ctx = createMockContext();

    await settle(routeArticleSearch(SEARCH, ctx));

    expect(getEnrichment(ctx)).toEqual({});
  });
});

// ─── Outcome table ────────────────────────────────────────────────────────────

describe('DOC answers with data', () => {
  it('returns it as doc_api without consulting the mirror', async () => {
    const mirror = attachMirror();
    answerDoc(() => ok({ articles: [DOC_ARTICLE] }));
    const search = vi.spyOn(getGdeltDocService(), 'searchArticles');
    const ctx = createMockContext();

    const { value, afterMs } = await settle(routeArticleSearch(SEARCH, ctx));

    expect(value).toEqual({ result: { articles: [DOC_ARTICLE], totalReturned: 1 } });
    expect(getEnrichment(ctx)).toEqual({ source: 'doc_api' });
    expect(mirror.execute).not.toHaveBeenCalled();
    // The mirror could answer, so DOC was held to its fallback budget.
    expect(search.mock.calls).toEqual([[SEARCH, ctx, { hasFallback: true }]]);
    expect(afterMs).toBe(0);
  });

  it('returns a stale stored DOC answer as doc_api on a refused refetch, without the mirror', async () => {
    const mirror = attachMirror();
    answerDoc(() => ok({ articles: [DOC_ARTICLE] }));
    await settle(routeArticleSearch(SEARCH, createMockContext()));
    vi.setSystemTime(Date.now() + 15 * MINUTE);
    answerDoc(() => refused);
    const ctx = createMockContext();

    const { value } = await settle(routeArticleSearch(SEARCH, ctx));

    expect(value).toEqual({ result: { articles: [DOC_ARTICLE], totalReturned: 1 } });
    expect(getEnrichment(ctx)).toEqual({
      source: 'doc_api',
      staleResponse: expect.objectContaining({ reason: 'gdelt_rate_limited' }),
    });
    expect(requestsFor('climate')).toBe(2);
    expect(mirror.execute).not.toHaveBeenCalled();
  });
});

describe('DOC answers empty', () => {
  it("replaces it with the mirror's answer when the mirror has a match", async () => {
    const mirror = attachMirror();
    answerDoc(() => ok({}));
    const ctx = createMockContext();

    const { value, afterMs } = await settle(routeArticleSearch(SEARCH, ctx));

    expect(value).toEqual({
      result: MIRROR_ARTLIST.result,
      standIn: { standsInFor: 'empty', matched: 1 },
    });
    expect(getEnrichment(ctx)).toEqual({
      source: 'gkg_mirror',
      attempts: [
        { source: 'doc_api', outcome: 'empty' },
        { source: 'gkg_mirror', outcome: 'answered' },
      ],
      coverage: SEARCH_COVERAGE,
    });
    expect(mirror.execute).toHaveBeenCalledOnce();
    expect(afterMs).toBe(0);
  });

  it("keeps DOC's empty answer when the mirror has no match either", async () => {
    attachMirror({ respond: answered(MIRROR_NO_ARTICLES, 0) });
    answerDoc(() => ok({}));
    const ctx = createMockContext();

    const { value } = await settle(routeArticleSearch(SEARCH, ctx));

    expect(value).toEqual({ result: { articles: [], totalReturned: 0 } });
    expect(getEnrichment(ctx)).toEqual({
      source: 'doc_api',
      attempts: [
        { source: 'doc_api', outcome: 'empty' },
        { source: 'gkg_mirror', outcome: 'empty' },
      ],
    });
  });

  it.each<[string, FakeMirrorOptions & { query?: string }, object]>([
    [
      'cannot compile the query',
      { query: 'near20:"flu virus"' },
      {
        outcome: 'not_compiled',
        detail:
          'It cannot evaluate "near20:\\"flu virus\\"": Proximity and repeat operators need article text, which the GKG mirror does not store.',
      },
    ],
    [
      'has not completed a sync',
      { status: { ready: false } },
      { outcome: 'not_ready', detail: 'The local GKG mirror has not completed an init run.' },
    ],
    [
      'fails in its store',
      {
        respond: () => ({ outcome: 'store_error', detail: 'The local GKG mirror did not answer.' }),
      },
      { outcome: 'store_error', detail: 'The local GKG mirror did not answer.' },
    ],
  ])("keeps DOC's empty answer when the mirror %s, listing why", async (_, options, attempt) => {
    const mirror = attachMirror(options);
    answerDoc(() => ok({}));
    const ctx = createMockContext();

    const { value } = await settle(
      routeArticleSearch({ ...SEARCH, query: options.query ?? SEARCH.query }, ctx),
    );

    expect(value).toEqual({ result: { articles: [], totalReturned: 0 } });
    expect(getEnrichment(ctx)).toEqual({
      source: 'doc_api',
      attempts: [
        { source: 'doc_api', outcome: 'empty' },
        { source: 'gkg_mirror', ...attempt },
      ],
    });
    if (options.query) expect(mirror.status).not.toHaveBeenCalled();
  });
});

describe('DOC refuses', () => {
  type Refusal = {
    trigger: string;
    arrange: (background: (pending: Promise<unknown>) => void) => void | Promise<void>;
    outcome: 'rate_limited' | 'unavailable';
    /** When DOC's refusal reaches the router, from the call's start. */
    afterMs: number;
    /** DOC requests the call itself sent. */
    requests: number;
  };

  const REFUSALS: Refusal[] = [
    {
      trigger: 'an HTTP 429',
      arrange: () => answerDoc(() => refused),
      outcome: 'rate_limited',
      afterMs: 0,
      requests: 1,
    },
    {
      trigger: 'an HTTP-200 plain-text rate-limit notice',
      arrange: () => answerDoc(() => () => new Response(RATE_LIMIT_TEXT, { status: 200 })),
      outcome: 'rate_limited',
      afterMs: 0,
      requests: 1,
    },
    {
      trigger: 'an HTTP-200 HTML rate-limit notice',
      arrange: () =>
        answerDoc(
          () => () =>
            new Response('<!DOCTYPE html><html><body>Rate limit exceeded.</body></html>', {
              status: 200,
            }),
        ),
      outcome: 'rate_limited',
      afterMs: 0,
      requests: 1,
    },
    {
      trigger: 'a pacer shed behind seventeen queued requests',
      arrange: (background) => {
        answerDoc(() => ok({}));
        for (let i = 0; i < 17; i++) {
          background(
            gdeltFetch(
              `${BASE_URL}/doc/doc`,
              new URLSearchParams({ query: `queued ${i}` }),
              createMockContext(),
              'test',
              'GDELT DOC',
            ),
          );
        }
      },
      outcome: 'rate_limited',
      afterMs: 0,
      requests: 0,
    },
    {
      trigger: 'a closed cooldown gate (gate first)',
      arrange: async () => {
        answerDoc(() => refused);
        await closeCooldownGate();
      },
      outcome: 'rate_limited',
      afterMs: 0,
      requests: 0,
    },
    {
      trigger: 'HTTP 503 on all four attempts',
      arrange: () => answerDoc(() => () => new Response('Unavailable', { status: 503 })),
      outcome: 'unavailable',
      afterMs: 35_900,
      requests: 4,
    },
    {
      trigger: 'a request that hangs until the 45 s fallback budget',
      arrange: () => answerDoc(() => 'hang'),
      outcome: 'unavailable',
      afterMs: 45_000,
      requests: 1,
    },
  ];

  describe.each(REFUSALS)('with $trigger', (row) => {
    it(`answers from the mirror ${row.afterMs} ms after the call starts`, async () => {
      const mirror = attachMirror();
      const background: Array<Promise<unknown>> = [];
      await row.arrange((pending) => background.push(pending));
      const ctx = createMockContext();

      const { value, afterMs } = await settle(routeArticleSearch(SEARCH, ctx));
      await Promise.allSettled(background);

      expect(afterMs).toBe(row.afterMs);
      expect(afterMs).toBeLessThan(60_000);
      expect(value).toEqual({
        result: MIRROR_ARTLIST.result,
        standIn: { standsInFor: row.outcome, matched: 1 },
      });
      expect(getEnrichment(ctx)).toEqual({
        source: 'gkg_mirror',
        attempts: [
          { source: 'doc_api', outcome: row.outcome, detail: expect.any(String) },
          { source: 'gkg_mirror', outcome: 'answered' },
        ],
        coverage: SEARCH_COVERAGE,
      });
      expect(requestsFor('climate')).toBe(row.requests);
      expect(mirror.execute).toHaveBeenCalledOnce();
    });
  });

  it('answers from the mirror with zero matches, as an answer rather than an error', async () => {
    attachMirror({ respond: answered(MIRROR_NO_ARTICLES, 0) });
    answerDoc(() => refused);
    const ctx = createMockContext();

    const { value } = await settle(routeArticleSearch(SEARCH, ctx));

    expect(value).toEqual({
      result: MIRROR_NO_ARTICLES.result,
      standIn: { standsInFor: 'rate_limited', matched: 0 },
    });
    expect(getEnrichment(ctx)).toMatchObject({
      source: 'gkg_mirror',
      attempts: [
        { source: 'doc_api', outcome: 'rate_limited' },
        { source: 'gkg_mirror', outcome: 'empty' },
      ],
    });
  });

  it('omits coverage when the mirror answered the whole requested window', async () => {
    attachMirror();
    answerDoc(() => refused);
    const ctx = createMockContext();
    const window = { startDatetime: '20261030000000', endDatetime: '20261031000000' };

    await settle(routeArticleSearch({ ...UNTIMED, ...window }, ctx));

    expect(getEnrichment(ctx)).toMatchObject({ source: 'gkg_mirror' });
    expect(getEnrichment(ctx)).not.toHaveProperty('coverage');
  });

  it('discloses the slots missing inside an answered window', async () => {
    const coverage = { ...SEARCH_COVERAGE, missingSlots: 3 };
    attachMirror({
      respond: () => ({ outcome: 'answered', answer: MIRROR_ARTLIST, matched: 1, coverage }),
    });
    answerDoc(() => refused);
    const ctx = createMockContext();

    await settle(routeArticleSearch(SEARCH, ctx));

    expect(getEnrichment(ctx)).toMatchObject({ coverage });
  });

  describe('and the mirror cannot answer', () => {
    type Row = {
      name: string;
      mirror: FakeMirrorOptions;
      params?: Partial<Parameters<typeof routeArticleSearch>[0]>;
      /** Drop SEARCH's timespan: DOC's default window, or the explicit dates in `params`. */
      untimed?: true;
      outcome: string;
      detail: string;
      hint: string;
      /** The pre-check settled it: DOC was not held to the fallback budget and execute never ran. */
      beforeDoc: boolean;
    };

    const ROWS: Row[] = [
      {
        name: 'a query it cannot compile',
        mirror: {},
        params: { query: 'climate near20:"flu virus"' },
        outcome: 'not_compiled',
        detail:
          'It cannot evaluate "near20:\\"flu virus\\"": Proximity and repeat operators need article text, which the GKG mirror does not store.',
        hint: 'Without "near20:\\"flu virus\\"" in the query, the local GKG mirror could answer while GDELT refuses.',
        beforeDoc: true,
      },
      {
        name: 'a query longer than it compiles',
        mirror: {},
        params: { query: `climate ${'a'.repeat(993)}` },
        outcome: 'not_compiled',
        detail: 'The query is longer than the 1,000 characters the GKG mirror compiles.',
        hint: 'A query of up to 1,000 characters lets the local GKG mirror answer while GDELT refuses.',
        beforeDoc: true,
      },
      {
        name: 'a timespan it cannot resolve',
        mirror: {},
        params: { timespan: '2fortnights' },
        outcome: 'not_compiled',
        detail: 'It cannot resolve timespan "2fortnights" to a window.',
        hint: 'A timespan such as "24h" or "7d", or an explicit startDatetime/endDatetime window, lets the local GKG mirror answer while GDELT refuses.',
        beforeDoc: true,
      },
      {
        name: 'no completed sync',
        mirror: { status: { ready: false } },
        outcome: 'not_ready',
        detail: 'The local GKG mirror has not completed an init run.',
        hint: "The local GKG mirror answers once the server operator's first sync (mirror:init) has completed.",
        beforeDoc: true,
      },
      {
        name: 'a window before its oldest slot',
        mirror: {},
        params: { startDatetime: '20261001000000', endDatetime: '20261002000000' },
        untimed: true,
        outcome: 'outside_coverage',
        detail:
          'The requested window 20261001000000–20261002000000 lies outside the slots the local GKG mirror holds, 20261025120000 to 20261101113000.',
        hint: 'A startDatetime/endDatetime window inside 20261025120000–20261101113000 lets the local GKG mirror answer while GDELT refuses.',
        beforeDoc: true,
      },
      {
        name: 'DOC’s three-month default window sharing no ingested slot, found only by the query',
        mirror: {
          respond: () => ({
            outcome: 'outside_coverage',
            detail: 'The requested window shares no slot with the GKG mirror.',
            oldestSlot: OLDEST,
            newestSlot: NEWEST,
          }),
        },
        untimed: true,
        outcome: 'outside_coverage',
        detail: 'The requested window shares no slot with the GKG mirror.',
        hint: 'A startDatetime/endDatetime window inside 20261025120000–20261101113000 lets the local GKG mirror answer while GDELT refuses.',
        beforeDoc: false,
      },
      {
        name: 'a status read that fails',
        mirror: { status: new Error('worker gone') },
        outcome: 'store_error',
        detail: 'The local GKG mirror did not report its status.',
        hint: 'The local GKG mirror is unavailable for now.',
        beforeDoc: true,
      },
      {
        name: 'a store error while answering',
        mirror: {
          respond: () => ({
            outcome: 'store_error',
            detail: 'The local GKG mirror did not answer.',
          }),
        },
        outcome: 'store_error',
        detail: 'The local GKG mirror did not answer.',
        hint: 'The local GKG mirror is unavailable for now.',
        beforeDoc: false,
      },
      {
        name: 'a sync that disappeared between the status read and the query',
        mirror: {
          respond: () => ({
            outcome: 'not_ready',
            detail:
              'The local GKG mirror has not completed an init run; the operator runs `mirror:init` to build it.',
          }),
        },
        outcome: 'not_ready',
        detail:
          'The local GKG mirror has not completed an init run; the operator runs `mirror:init` to build it.',
        hint: "The local GKG mirror answers once the server operator's first sync (mirror:init) has completed.",
        beforeDoc: false,
      },
    ];

    describe.each(ROWS)('because of $name', (row) => {
      it("rejects with DOC's code and reason, both attempts, and what lets the mirror answer", async () => {
        const mirror = attachMirror(row.mirror);
        answerDoc(() => refused);
        const search = vi.spyOn(getGdeltDocService(), 'searchArticles');
        const ctx = createMockContext();
        const params = { ...(row.untimed ? UNTIMED : SEARCH), ...row.params };

        const { error, afterMs } = await settle(routeArticleSearch(params, ctx));

        expect(afterMs).toBe(0);
        expect(error).toBeInstanceOf(McpError);
        expect(error?.code).toBe(JsonRpcErrorCode.RateLimited);
        expect(error?.message).toMatch(
          new RegExp(
            ` The local GKG mirror could not answer instead: ${row.detail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
          ),
        );
        expect(error?.data).toMatchObject({
          reason: 'gdelt_rate_limited',
          retryable: true,
          attempts: [
            { source: 'doc_api', outcome: 'rate_limited', detail: expect.any(String) },
            { source: 'gkg_mirror', outcome: row.outcome, detail: row.detail },
          ],
          recovery: { hint: `${RATE_LIMIT_HINT} ${row.hint}` },
        });
        expect(getEnrichment(ctx)).toEqual({});
        expect(search).toHaveBeenCalledOnce();
        expect(search.mock.calls[0]?.[0]).toEqual(params);
        expect(search.mock.calls[0]?.[2]).toEqual(
          row.beforeDoc ? undefined : { hasFallback: true },
        );
        expect(mirror.execute).toHaveBeenCalledTimes(row.beforeDoc ? 0 : 1);
      });
    });

    it('keeps a gdelt_unavailable refusal’s code, reason, and hint', async () => {
      attachMirror({ status: { ready: false } });
      answerDoc(() => () => new Response('Unavailable', { status: 503 }));

      const { error } = await settle(routeArticleSearch(SEARCH, createMockContext()));

      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: {
          reason: 'gdelt_unavailable',
          retryable: true,
          attempts: [
            { source: 'doc_api', outcome: 'unavailable' },
            { source: 'gkg_mirror', outcome: 'not_ready' },
          ],
          recovery: {
            hint: `${UNAVAILABLE_HINT} The local GKG mirror answers once the server operator's first sync (mirror:init) has completed.`,
          },
        },
      });
    });

    it('waits on DOC as without a mirror: a closed gate is waited out, not refused at once', async () => {
      attachMirror({ status: { ready: false } });
      answerDoc(() => refused);
      await closeCooldownGate();

      const { error, afterMs } = await settle(routeArticleSearch(SEARCH, createMockContext()));

      // The gate reopens at 5 s; the request gap after the refusal that closed it holds to 5.3 s.
      expect(afterMs).toBe(PRODUCTION_GAP_MS);
      expect(requestsFor('climate')).toBe(1);
      expect(error?.data).toMatchObject({ reason: 'gdelt_rate_limited' });
    });
  });

  it.each([
    [
      'invalid_query',
      () => new Response('The specified phrase is too short or too long.', { status: 200 }),
      JsonRpcErrorCode.ValidationError,
    ],
    [
      'a serialization failure',
      () => new Response('{"articles": [', { status: 200 }),
      JsonRpcErrorCode.SerializationError,
    ],
  ])('rethrows %s untouched, never consulting the mirror', async (_, response, code) => {
    const mirror = attachMirror();
    answerDoc(() => response);

    const { error } = await settle(routeArticleSearch(SEARCH, createMockContext()));

    expect(error?.code).toBe(code);
    expect(error?.data ?? {}).not.toHaveProperty('attempts');
    expect(error?.message).not.toContain('GKG mirror');
    expect(mirror.execute).not.toHaveBeenCalled();
  });
});

// ─── Bounds ───────────────────────────────────────────────────────────────────

describe('under the 60 s client timeout', () => {
  it('gives the mirror until 55 s after the start: an answer at 54.999 s is returned', async () => {
    attachMirror({ delayMs: 9_999 });
    answerDoc(() => 'hang');
    const ctx = createMockContext();

    const { value, afterMs } = await settle(routeArticleSearch(SEARCH, ctx));

    expect(afterMs).toBe(54_999);
    expect(value?.standIn).toEqual({ standsInFor: 'unavailable', matched: 1 });
  });

  it('stops waiting on the mirror at 55 s and rejects with both attempts', async () => {
    const mirror = attachMirror({ delayMs: 10_001 });
    answerDoc(() => 'hang');

    const { error, afterMs } = await settle(routeArticleSearch(SEARCH, createMockContext()));

    expect(afterMs).toBe(55_000);
    expect(mirror.signals[0]?.aborted).toBe(true);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: {
        reason: 'gdelt_unavailable',
        attempts: [
          { source: 'doc_api', outcome: 'unavailable' },
          {
            source: 'gkg_mirror',
            outcome: 'store_error',
            detail: "The local GKG mirror did not answer within 55s of the call's start.",
          },
        ],
        recovery: { hint: `${UNAVAILABLE_HINT} The local GKG mirror is unavailable for now.` },
      },
    });
  });

  it('bounds a mirror that never answers after a fast refusal at 55 s', async () => {
    attachMirror({ delayMs: Number.POSITIVE_INFINITY });
    answerDoc(() => refused);

    const { error, afterMs } = await settle(routeArticleSearch(SEARCH, createMockContext()));

    expect(afterMs).toBe(55_000);
    expect(error?.data).toMatchObject({
      reason: 'gdelt_rate_limited',
      attempts: [{ outcome: 'rate_limited' }, { outcome: 'store_error' }],
    });
  });

  it('bounds the mirror after an empty DOC answer, keeping DOC’s empty answer at 55 s', async () => {
    attachMirror({ delayMs: Number.POSITIVE_INFINITY });
    answerDoc(() => ok({}));
    const ctx = createMockContext();

    const { value, afterMs } = await settle(routeArticleSearch(SEARCH, ctx));

    expect(afterMs).toBe(55_000);
    expect(value).toEqual({ result: { articles: [], totalReturned: 0 } });
    expect(getEnrichment(ctx)).toMatchObject({
      source: 'doc_api',
      attempts: [{ outcome: 'empty' }, { outcome: 'store_error' }],
    });
  });
});

// ─── Cancellation ─────────────────────────────────────────────────────────────

describe("the caller's cancellation", () => {
  it('while the mirror status is read: rejects with the abort reason, asking neither source', async () => {
    const status = Promise.withResolvers<MirrorCoverageStatus>();
    const mirror = attachMirror({ status: () => status.promise });
    answerDoc(() => ok({ articles: [DOC_ARTICLE] }));
    const controller = new AbortController();

    const pending = settle(
      routeArticleSearch(SEARCH, createMockContext({ signal: controller.signal })),
    );
    controller.abort();
    status.resolve(READY);
    const { error } = await pending;

    expect(error).toBe(controller.signal.reason);
    expect(upstream).not.toHaveBeenCalled();
    expect(mirror.execute).not.toHaveBeenCalled();
  });

  it('while the mirror status is read: rejects at once, without waiting for a status that never comes', async () => {
    const mirror = attachMirror({ status: () => new Promise<MirrorCoverageStatus>(() => {}) });
    answerDoc(() => ok({ articles: [DOC_ARTICLE] }));
    const controller = new AbortController();
    const ctx = createMockContext({ signal: controller.signal });

    let outcome: unknown = 'pending';
    routeArticleSearch(SEARCH, ctx).then(
      () => {
        outcome = 'answered';
      },
      (error: unknown) => {
        outcome = error;
      },
    );
    await vi.advanceTimersByTimeAsync(3_000);
    expect(outcome).toBe('pending');
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(mirror.status).toHaveBeenCalledExactlyOnceWith(ctx.signal);
    expect(outcome).toBe(controller.signal.reason);
    expect(upstream).not.toHaveBeenCalled();
    expect(mirror.execute).not.toHaveBeenCalled();
  });

  it('while DOC is asked: rejects as cancelled, never consulting the mirror', async () => {
    const mirror = attachMirror();
    answerDoc(() => 'hang');
    const controller = new AbortController();

    const watched = timed(
      routeArticleSearch(SEARCH, createMockContext({ signal: controller.signal })),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    const { error, afterMs } = await watched.result();

    expect(afterMs).toBe(10_000);
    expect(error?.code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(error?.data ?? {}).not.toHaveProperty('attempts');
    expect(mirror.execute).not.toHaveBeenCalled();
  });

  it.each([
    ['refused', refused],
    ['answered empty', ok({})],
  ])(
    'while the mirror answers after DOC %s: rejects with the abort reason untouched',
    async (_, response) => {
      const mirror = attachMirror({ delayMs: 20_000 });
      answerDoc(() => response);
      const controller = new AbortController();
      const ctx = createMockContext({ signal: controller.signal });

      const watched = timed(routeArticleSearch(SEARCH, ctx));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(mirror.execute).toHaveBeenCalledOnce();
      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      const { error, afterMs } = await watched.result();

      expect(error).toBe(controller.signal.reason);
      expect(afterMs).toBe(5_000);
      expect(getEnrichment(ctx)).toEqual({});
    },
  );
});

// ─── Per DOC call ─────────────────────────────────────────────────────────────

describe('each DOC call', () => {
  const WINDOW_24H = { startDatetime: '20261031120000', endDatetime: '20261101120000' };
  const PLAN = expect.objectContaining({ kinds: ['theme'], filterOnly: true });

  const CALLS = [
    {
      name: 'routeTimeline',
      run: (ctx: ReturnType<typeof createMockContext>) =>
        routeTimeline(
          { query: 'theme:TAX_FNCACT', mode: 'timelinevolraw', timespan: '24h', smoothing: 3 },
          ctx,
        ),
      empty: { timeline: [{ series: 'Volume Intensity', data: [] }] },
      request: { kind: 'timeline', mode: 'timelinevolraw', smoothing: 3 },
      answer: {
        kind: 'timeline',
        result: [
          {
            label: 'Volume Intensity',
            data: [{ date: '2026-11-01T11:00:00Z', value: 34, norm: 2_526 }],
          },
        ],
      },
    },
    {
      name: 'routeToneDistribution',
      run: (ctx: ReturnType<typeof createMockContext>) =>
        routeToneDistribution({ query: 'theme:TAX_FNCACT', timespan: '24h' }, ctx),
      empty: { tonechart: [] },
      request: { kind: 'tonechart' },
      answer: { kind: 'tonechart', result: [{ bin: 0, count: 400, articles: [] }] },
    },
    {
      name: 'routeBreakdown',
      run: (ctx: ReturnType<typeof createMockContext>) =>
        routeBreakdown(
          { query: 'theme:TAX_FNCACT', mode: 'timelinesourcecountry', timespan: '24h' },
          ctx,
        ),
      empty: {},
      request: { kind: 'breakdown', mode: 'timelinesourcecountry' },
      answer: {
        kind: 'breakdown',
        result: [
          {
            label: 'Germany Volume Intensity',
            data: [{ date: '2026-11-01T11:00:00Z', value: 83.33 }],
          },
        ],
        excludedWithoutCountry: 12,
      },
    },
    {
      name: 'routeArticleSearch',
      run: (ctx: ReturnType<typeof createMockContext>) =>
        routeArticleSearch(
          { ...SEARCH, query: 'theme:TAX_FNCACT', sort: 'dateDesc', maxRecords: 250 },
          ctx,
        ),
      empty: { articles: [] },
      request: { kind: 'artlist', maxRecords: 250, sort: 'dateDesc' },
      answer: MIRROR_ARTLIST,
    },
  ] as const;

  describe.each(CALLS)('$name', (call) => {
    it('builds its mirror request and returns the mirror’s answer when DOC refuses', async () => {
      const mirror = attachMirror({ respond: answered(call.answer as MirrorResult, 3) });
      answerDoc(() => refused);
      const ctx = createMockContext();

      const { value } = await settle<DocRouted<unknown>>(call.run(ctx));

      expect(mirror.execute).toHaveBeenCalledExactlyOnceWith(
        { ...call.request, plan: PLAN, window: WINDOW_24H },
        expect.any(AbortSignal),
      );
      const { kind: _, ...mapped } = call.answer as MirrorResult & {
        excludedWithoutCountry?: number;
      };
      expect(value).toEqual({
        result: mapped.result,
        standIn: {
          standsInFor: 'rate_limited',
          matched: 3,
          ...('excludedWithoutCountry' in mapped && {
            excludedWithoutCountry: mapped.excludedWithoutCountry,
          }),
        },
      });
      expect(getEnrichment(ctx)).toMatchObject({ source: 'gkg_mirror' });
    });

    it('treats its own empty DOC shape as empty and consults the mirror', async () => {
      const mirror = attachMirror({ respond: answered(call.answer as MirrorResult, 3) });
      answerDoc(() => ok(call.empty));
      const ctx = createMockContext();

      const { value } = await settle<DocRouted<unknown>>(call.run(ctx));

      expect(mirror.execute).toHaveBeenCalledOnce();
      expect(value?.standIn).toMatchObject({ standsInFor: 'empty', matched: 3 });
    });
  });

  it('asks the mirror for DOC’s three-month default when a call sets no window', async () => {
    const mirror = attachMirror();
    answerDoc(() => refused);

    await settle(routeArticleSearch(UNTIMED, createMockContext()));

    expect(mirror.execute.mock.calls[0]?.[0].window).toEqual({
      startDatetime: '20260801120000',
      endDatetime: '20261101120000',
    });
  });

  it('asks the mirror for an explicit window verbatim', async () => {
    const mirror = attachMirror();
    answerDoc(() => refused);
    const window = { startDatetime: '20261030000000', endDatetime: '20261031000000' };

    await settle(routeArticleSearch({ ...SEARCH, timespan: '1h', ...window }, createMockContext()));

    expect(mirror.execute.mock.calls[0]?.[0].window).toEqual(window);
  });
});
