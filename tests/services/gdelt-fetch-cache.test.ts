/**
 * @fileoverview The DOC and TV response cache at the `gdeltFetch` seam: exact-URL hits that
 * spend no request or pacer slot, the 15-minute and 24-hour freshness windows, what is stored
 * and what is not, the byte-charged LRU, in-flight sharing and per-caller cancellation, stale
 * serves in place of a refused refetch, the 45-second fallback budget and closed-gate serves that
 * keep a stale answer under the client timeout, and the station-label lookup's fresh-only reads.
 * The real pacer, retry ladder, and `fetchWithTimeout` run; only the global `fetch` is stubbed.
 * @module tests/services/gdelt-fetch-cache.test
 */

import { JsonRpcErrorCode, type McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext,
  getEnrichment,
  type MockContextLogger,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gdeltGetCoverageBreakdown } from '@/mcp-server/tools/definitions/get-coverage-breakdown.tool.js';
import { gdeltGetCoverageTimeline } from '@/mcp-server/tools/definitions/get-coverage-timeline.tool.js';
import { gdeltGetToneDistribution } from '@/mcp-server/tools/definitions/get-tone-distribution.tool.js';
import { gdeltGetTvBreakdown } from '@/mcp-server/tools/definitions/get-tv-breakdown.tool.js';
import { gdeltGetTvClips } from '@/mcp-server/tools/definitions/get-tv-clips.tool.js';
import { gdeltGetTvContext } from '@/mcp-server/tools/definitions/get-tv-context.tool.js';
import { gdeltListTvStations } from '@/mcp-server/tools/definitions/list-tv-stations.tool.js';
import { gdeltSearchArticles } from '@/mcp-server/tools/definitions/search-articles.tool.js';
import { gdeltSearchTv } from '@/mcp-server/tools/definitions/search-tv.tool.js';
import { type GdeltFetchOptions, gdeltFetch } from '@/services/gdelt/gdelt-fetch.js';
import { disposeGdeltPacer, getGdeltPacer, initGdeltPacer } from '@/services/gdelt/gdelt-pacer.js';
import {
  disposeGdeltResponseCache,
  initGdeltResponseCache,
} from '@/services/gdelt/gdelt-response-cache.js';
import { GdeltTvService } from '@/services/gdelt/gdelt-tv-service.js';

const BASE_URL = 'https://api.gdeltproject.org/api/v2/doc/doc';
const T0 = Date.parse('2026-10-15T12:00:00Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const MiB = 1024 * 1024;

/** The production `GDELT_REQUEST_DELAY_MS` default; the shed case needs a real queue to fill. */
const PRODUCTION_GAP_MS = 5_300;

const BODY = { articles: [{ url: 'https://example.com/a', title: 'A' }] };
const RATE_LIMIT_TEXT = 'Please limit requests to one every 5 seconds.';
const RATE_LIMIT_HINT =
  'Back off before retrying; five seconds is minimum request spacing, not a recovery guarantee, and rate limiting may persist longer. Honor Retry-After when supplied.';
const UNAVAILABLE_HINT = 'Retry after a short delay; GDELT may be temporarily unavailable.';

type Upstream = (url: string, init?: RequestInit) => Promise<Response>;

let upstream: ReturnType<typeof vi.fn<Upstream>>;

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

/** A body of `bytes` UTF-8 bytes, one non-empty top-level array holding one long string. */
function sizedBody(fill: string, bytes: number): string {
  const frame = '{"articles":[""]}';
  return `{"articles":["${fill.repeat(bytes - frame.length)}"]}`;
}

/** Every upstream request's `query` parameter, in order. */
function requestedQueries(): Array<string | null> {
  return upstream.mock.calls.map(([url]) => new URL(url).searchParams.get('query'));
}

function call(
  params: Record<string, string> = { query: 'climate' },
  options: GdeltFetchOptions = {},
  ctx = createMockContext(),
): Promise<unknown> {
  return gdeltFetch(BASE_URL, new URLSearchParams(params), ctx, 'test', 'GDELT DOC', options);
}

/** Resolve with a call's rejection; fail the test if it resolves. */
function rejection(pending: Promise<unknown>): Promise<McpError> {
  return pending.then(
    () => {
      throw new Error('expected the call to reject');
    },
    (error: unknown) => error as McpError,
  );
}

/** An upstream request held open until `release` answers it or its signal aborts it. */
function holdRequests() {
  const held: Array<{ release: (response: Response) => void; signal: AbortSignal }> = [];
  upstream.mockImplementation(
    (_url, init) =>
      new Promise<Response>((resolve, reject) => {
        const signal = init?.signal as AbortSignal;
        held.push({ release: resolve, signal });
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  );
  return held;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  upstream = vi.fn<Upstream>(async () => {
    throw new Error('unmocked fetch');
  });
  vi.stubGlobal('fetch', upstream);
  initGdeltPacer(0);
  initGdeltResponseCache();
});

afterEach(() => {
  disposeGdeltPacer();
  disposeGdeltResponseCache();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('hits', () => {
  it('answers a repeated call from the cache with equal data and no request', async () => {
    upstream.mockImplementation(async () => ok(BODY));

    await expect(call()).resolves.toEqual(BODY);
    await expect(call()).resolves.toEqual(BODY);

    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('takes no pacer slot: a hit resolves at once while a 429 holds the cooldown gate shut', async () => {
    upstream.mockImplementation(async (url) =>
      new URL(url).searchParams.get('query') === 'stored'
        ? ok(BODY)
        : new Response(RATE_LIMIT_TEXT, { status: 429 }),
    );
    await call({ query: 'stored' });
    await rejection(call({ query: 'refused' }));
    expect(getGdeltPacer().cooldown.remainingMs).toBeGreaterThan(0);

    let settled = false;
    const hit = call({ query: 'stored' }).finally(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toBe(true);
    await expect(hit).resolves.toEqual(BODY);
    expect(requestedQueries()).toEqual(['stored', 'refused']);
  });

  it('keys on the exact URL: a different parameter order is a different entry', async () => {
    upstream.mockImplementation(async () => ok(BODY));

    await call({ query: 'climate', mode: 'artlist' });
    await call({ mode: 'artlist', query: 'climate' });

    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it('hands each caller its own copy: mutating one answer changes no later hit', async () => {
    upstream.mockImplementation(async () => ok(BODY));

    const first = (await call()) as typeof BODY;
    first.articles[0]!.title = 'mutated';
    first.articles.push({ url: 'https://example.com/b', title: 'B' });

    await expect(call()).resolves.toEqual(BODY);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});

describe('what is stored', () => {
  it('stores no refusal: a 429, then a success, then a hit', async () => {
    upstream.mockResolvedValueOnce(new Response(RATE_LIMIT_TEXT, { status: 429 }));
    upstream.mockImplementation(async () => ok(BODY));

    await rejection(call());
    const retry = call();
    await vi.runAllTimersAsync();
    await expect(retry).resolves.toEqual(BODY);
    await expect(call()).resolves.toEqual(BODY);

    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['GDELT’s {}', {}],
    ['an empty top-level array', { articles: [] }],
    ['empty arrays beside a non-array field', { timeline: [], query_details: { a: 1 } }],
  ])('returns %s unchanged and asks again next time', async (_, body) => {
    upstream.mockImplementation(async () => ok(body));

    await expect(call()).resolves.toEqual(body);
    await expect(call()).resolves.toEqual(body);

    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it('returns a body over 32 MiB and does not store it', async () => {
    const text = sizedBody('x', 32 * MiB + 1);
    upstream.mockImplementation(async () => new Response(text, { status: 200 }));

    const answer = (await call()) as { articles: string[] };
    expect(answer.articles[0]).toHaveLength(32 * MiB + 1 - '{"articles":[""]}'.length);
    await call();

    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it('evicts the least-recently-used entry past 128 MiB, a hit counting as a use', async () => {
    upstream.mockImplementation(async (url) => {
      const query = new URL(url).searchParams.get('query') as string;
      return new Response(sizedBody(query, 30 * MiB), { status: 200 });
    });

    for (const query of ['a', 'b', 'c', 'd']) await call({ query });
    await call({ query: 'a' }); // a hit: b is now the least recently used
    await call({ query: 'e' }); // 150 MiB: one entry must go
    expect(requestedQueries()).toEqual(['a', 'b', 'c', 'd', 'e']);

    await call({ query: 'a' });
    await call({ query: 'b' });

    expect(requestedQueries()).toEqual(['a', 'b', 'c', 'd', 'e', 'b']);
  });
});

describe('freshness', () => {
  it.each([
    ['a timespan', { timespan: '7d' }, 15 * MINUTE],
    ['no window', {}, 15 * MINUTE],
    [
      'a window ending inside the last 24 hours',
      { startdatetime: '20261013120000', enddatetime: '20261014120100' },
      15 * MINUTE,
    ],
    [
      'a window ending in the future',
      { startdatetime: '20261015000000', enddatetime: '20261016000000' },
      15 * MINUTE,
    ],
    [
      'a window ending more than 24 hours before the fetch',
      { startdatetime: '20261013000000', enddatetime: '20261014115959' },
      24 * HOUR,
    ],
  ])('keeps an answer to %s fresh for its window, then asks again', async (_, window, freshMs) => {
    upstream.mockImplementation(async () => ok(BODY));
    const params = { query: 'climate', ...window };

    await call(params);
    vi.setSystemTime(T0 + freshMs - 1);
    await call(params);
    expect(upstream).toHaveBeenCalledTimes(1);

    vi.setSystemTime(T0 + freshMs);
    await call(params);
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it('keeps a settled window fresh past 15 minutes', async () => {
    upstream.mockImplementation(async () => ok(BODY));
    const params = {
      query: 'climate',
      startdatetime: '20261001000000',
      enddatetime: '20261002000000',
    };

    await call(params);
    vi.setSystemTime(T0 + 15 * MINUTE);
    await call(params);

    expect(upstream).toHaveBeenCalledTimes(1);
  });
});

/** Store BODY for `params` at T0, then move the clock to `T0 + ageMs`. */
async function storeAndAge(params: Record<string, string>, ageMs: number): Promise<void> {
  upstream.mockImplementation(async () => ok(BODY));
  await call(params);
  vi.setSystemTime(T0 + ageMs);
}

describe('stale serve', () => {
  const PARAMS = { query: 'stale' };

  it.each<
    [
      string,
      'gdelt_rate_limited' | 'gdelt_unavailable' | 'gdelt_empty',
      JsonRpcErrorCode | undefined,
      number,
      /** Arrange the refusal; a returned promise settles the background work it started. */
      () => Promise<unknown> | undefined,
    ]
  >([
    [
      'an HTTP 429',
      'gdelt_rate_limited',
      JsonRpcErrorCode.RateLimited,
      2,
      () => {
        upstream.mockImplementation(async () => new Response(RATE_LIMIT_TEXT, { status: 429 }));
      },
    ],
    [
      'an HTTP-200 rate-limit notice',
      'gdelt_rate_limited',
      JsonRpcErrorCode.RateLimited,
      2,
      () => {
        upstream.mockImplementation(async () => new Response(RATE_LIMIT_TEXT, { status: 200 }));
      },
    ],
    [
      'a pacer shed',
      'gdelt_rate_limited',
      JsonRpcErrorCode.RateLimited,
      1,
      () => {
        // At the production gap, one request in flight and sixteen queued behind it project the
        // next arrival past the 90-second budget, so it is shed on arrival.
        disposeGdeltPacer();
        initGdeltPacer(PRODUCTION_GAP_MS);
        upstream.mockImplementation(async () => ok({}));
        return Promise.allSettled(
          Array.from({ length: 17 }, (_, i) => call({ query: `queued ${i}` })),
        );
      },
    ],
    [
      'gdelt_unavailable after the retry ladder',
      'gdelt_unavailable',
      JsonRpcErrorCode.ServiceUnavailable,
      5,
      () => {
        upstream.mockImplementation(async () => new Response('Unavailable', { status: 503 }));
      },
    ],
    [
      'an empty answer',
      'gdelt_empty',
      undefined,
      2,
      () => {
        upstream.mockImplementation(async () => ok({}));
      },
    ],
  ])(
    'serves the stored answer when the refetch meets %s',
    async (_, reason, code, requests, refuse) => {
      await storeAndAge(PARAMS, 15 * MINUTE);
      const background = refuse();
      const ctx = createMockContext();

      const pending = call(PARAMS, {}, ctx);
      let servedAt = 0;
      const record = () => {
        servedAt = Date.now();
      };
      void pending.then(record, record);
      await vi.runAllTimersAsync();
      await background;

      await expect(pending).resolves.toEqual(BODY);
      expect(requestedQueries().filter((query) => query === 'stale')).toHaveLength(requests);
      expect(getEnrichment(ctx)).toEqual({
        staleResponse: {
          fetchedAt: '2026-10-15T12:00:00.000Z',
          ageSeconds: Math.floor((servedAt - T0) / 1000),
          reason,
        },
      });
      expect((ctx.log as MockContextLogger).calls).toContainEqual({
        level: 'warning',
        msg: 'GDELT DOC API refetch gave no data; serving the stored answer',
        data: expect.objectContaining({ reason, ...(code !== undefined && { code }) }),
      });
    },
  );

  it.each([
    ['a windowless answer just under 24 hours old', {}, 24 * HOUR - 1000, true],
    ['a windowless answer 24 hours old', {}, 24 * HOUR, false],
    ['a 1h timespan answer just under an hour old', { timespan: '1h' }, HOUR - 1000, true],
    ['a 1h timespan answer an hour old', { timespan: '1h' }, HOUR, false],
  ])('in place of a 429, serves %s: %s', async (_, window, ageMs, served) => {
    const params = { ...PARAMS, ...window };
    await storeAndAge(params, ageMs);
    upstream.mockImplementation(async () => new Response(RATE_LIMIT_TEXT, { status: 429 }));
    const ctx = createMockContext();

    if (served) {
      await expect(call(params, {}, ctx)).resolves.toEqual(BODY);
      return;
    }
    expect(await rejection(call(params, {}, ctx))).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'gdelt_rate_limited', retryable: true, recovery: { hint: RATE_LIMIT_HINT } },
    });
    expect(getEnrichment(ctx)).toEqual({});
  });

  it.each([
    ['a windowless answer just under 24 hours old', {}, 24 * HOUR - 1000, true],
    ['a windowless answer 24 hours old', {}, 24 * HOUR, false],
    ['a 1h timespan answer just under an hour old', { timespan: '1h' }, HOUR - 1000, true],
    ['a 1h timespan answer an hour old', { timespan: '1h' }, HOUR, false],
  ])('in place of an empty answer, serves %s: %s', async (_, window, ageMs, served) => {
    const params = { ...PARAMS, ...window };
    await storeAndAge(params, ageMs);
    upstream.mockImplementation(async () => ok({}));
    const ctx = createMockContext();

    await expect(call(params, {}, ctx)).resolves.toEqual(served ? BODY : {});
    expect(getEnrichment(ctx)).toEqual(
      served ? { staleResponse: expect.objectContaining({ reason: 'gdelt_empty' }) } : {},
    );
    // Nothing empty was stored over the entry: the next call asks again.
    await call(params);
    expect(upstream).toHaveBeenCalledTimes(3);
  });

  it.each([
    [
      'invalid_query',
      () =>
        upstream.mockImplementation(
          async () => new Response('Your query was too short or too long.', { status: 200 }),
        ),
      { code: JsonRpcErrorCode.ValidationError, data: { reason: 'invalid_query' } },
    ],
    [
      'a serialization failure',
      () =>
        upstream.mockImplementation(async () => new Response('{"articles": [', { status: 200 })),
      { code: JsonRpcErrorCode.SerializationError },
    ],
  ])('never falls back on %s', async (_, refuse, failure) => {
    await storeAndAge(PARAMS, 15 * MINUTE);
    refuse();
    const ctx = createMockContext();

    expect(await rejection(call(PARAMS, {}, ctx))).toMatchObject(failure);
    expect(getEnrichment(ctx)).toEqual({});
  });

  it('never falls back on the caller’s own cancellation', async () => {
    await storeAndAge(PARAMS, 15 * MINUTE);
    holdRequests();
    const controller = new AbortController();
    const ctx = createMockContext({ signal: controller.signal });

    const pending = rejection(call(PARAMS, {}, ctx));
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();

    expect(await pending).toMatchObject({
      code: JsonRpcErrorCode.RequestCancelled,
      data: { errorSource: 'FetchAborted' },
    });
    expect(getEnrichment(ctx)).toEqual({});
  });

  it('serves a freshOnly caller a fresh hit but never a stale one', async () => {
    await storeAndAge(PARAMS, 15 * MINUTE - 1);
    await expect(call(PARAMS, { freshOnly: true })).resolves.toEqual(BODY);
    expect(upstream).toHaveBeenCalledTimes(1);

    vi.setSystemTime(T0 + 15 * MINUTE);
    upstream.mockImplementation(async () => new Response(RATE_LIMIT_TEXT, { status: 429 }));
    const ctx = createMockContext();

    expect(await rejection(call(PARAMS, { freshOnly: true, maxRetries: 0 }, ctx))).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'gdelt_rate_limited' },
    });
    // The 429 closed the cooldown gate; the empty refetch runs once it reopens.
    upstream.mockImplementation(async () => ok({}));
    const empty = call(PARAMS, { freshOnly: true, maxRetries: 0 }, ctx);
    await vi.runAllTimersAsync();
    await expect(empty).resolves.toEqual({});
    expect(getEnrichment(ctx)).toEqual({});
  });
});

describe('in-flight sharing', () => {
  it('shares one request between concurrent identical calls, each with its own copy', async () => {
    const held = holdRequests();

    const first = call();
    const second = call();
    await vi.advanceTimersByTimeAsync(0);
    held[0]?.release(ok(BODY));
    const [a, b] = (await Promise.all([first, second])) as Array<typeof BODY>;

    expect(upstream).toHaveBeenCalledTimes(1);
    expect(a).toEqual(BODY);
    expect(b).toEqual(BODY);
    expect(a).not.toBe(b);
    expect(a?.articles).not.toBe(b?.articles);
  });

  it('rejects a cancelled caller alone while the other still gets the answer', async () => {
    const held = holdRequests();
    const controller = new AbortController();

    const cancelled = rejection(
      call(undefined, {}, createMockContext({ signal: controller.signal })),
    );
    const kept = call();
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();

    expect(await cancelled).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    expect(held[0]?.signal.aborted).toBe(false);
    held[0]?.release(ok(BODY));
    await expect(kept).resolves.toEqual(BODY);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('aborts the request once every caller has cancelled, and a later call starts afresh', async () => {
    const held = holdRequests();
    const first = new AbortController();
    const second = new AbortController();

    const a = rejection(call(undefined, {}, createMockContext({ signal: first.signal })));
    const b = rejection(call(undefined, {}, createMockContext({ signal: second.signal })));
    await vi.advanceTimersByTimeAsync(0);
    first.abort();
    second.abort();

    expect(await a).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    expect(await b).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    expect(held[0]?.signal.aborted).toBe(true);

    const later = call();
    await vi.advanceTimersByTimeAsync(0);
    held[1]?.release(ok(BODY));
    await expect(later).resolves.toEqual(BODY);
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it('shares by retry ladder: a maxRetries: 0 call fetches apart from two full-ladder calls', async () => {
    const held = holdRequests();

    const single = call(undefined, { maxRetries: 0 });
    const ladder = [call(), call()];
    await vi.advanceTimersByTimeAsync(0);
    held[0]?.release(ok(BODY));
    await expect(single).resolves.toEqual(BODY);
    await vi.advanceTimersByTimeAsync(0);
    held[1]?.release(ok(BODY));
    await expect(Promise.all(ladder)).resolves.toEqual([BODY, BODY]);

    expect(upstream).toHaveBeenCalledTimes(2);
  });
});

describe('under the client timeout', () => {
  const PARAMS = { query: 'stale' };
  const FRESH = { articles: [{ url: 'https://example.com/b', title: 'B' }] };
  const refused = () => new Response(RATE_LIMIT_TEXT, { status: 429 });

  /** Answer each upstream request by its `query`; `'hang'` holds it open until its signal aborts. */
  function answerBy(pick: (query: string) => 'hang' | (() => Response)): void {
    upstream.mockImplementation((url, init) => {
      const behaviour = pick(new URL(url).searchParams.get('query') ?? '');
      if (behaviour !== 'hang') return Promise.resolve(behaviour());
      const signal = init?.signal as AbortSignal;
      return new Promise<Response>((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
  }

  /** Flag a pending call once it settles, without consuming its outcome. */
  function track(pending: Promise<unknown>): { settled: () => boolean } {
    let settled = false;
    const mark = () => {
      settled = true;
    };
    void pending.then(mark, mark);
    return { settled: () => settled };
  }

  describe('settle times at production pacing', () => {
    const TARGET = { query: 'target' };
    /** Past the latest settle in the table: the 120-second call deadline. */
    const HORIZON_MS = 150_000;
    const CODES = {
      gdelt_rate_limited: JsonRpcErrorCode.RateLimited,
      gdelt_unavailable: JsonRpcErrorCode.ServiceUnavailable,
    } as const;
    const HINTS = {
      gdelt_rate_limited: RATE_LIMIT_HINT,
      gdelt_unavailable: UNAVAILABLE_HINT,
    } as const;

    type Row = {
      trigger: string;
      /** Set up the upstream and pacer; `background` registers calls that must settle too. */
      arrange: (background: (pending: Promise<unknown>) => void) => void | Promise<void>;
      /** With nothing stored and no option: the settle instant before the budget existed. */
      unchangedMs: number;
      /** With a servable stored answer. */
      storedMs: number;
      /** With nothing stored and `hasFallback`. */
      fallbackMs: number;
      /** The failure the stored answer stands in for, and the one a caller is rejected with. */
      reason: 'gdelt_rate_limited' | 'gdelt_unavailable' | 'gdelt_empty';
    };

    const ROWS: Row[] = [
      {
        trigger: 'an HTTP 429 with the cooldown gate open',
        arrange: () => answerBy(() => refused),
        unchangedMs: 0,
        storedMs: 0,
        fallbackMs: 0,
        reason: 'gdelt_rate_limited',
      },
      {
        trigger: 'an HTTP-200 rate-limit notice',
        arrange: () => answerBy(() => () => new Response(RATE_LIMIT_TEXT, { status: 200 })),
        unchangedMs: 0,
        storedMs: 0,
        fallbackMs: 0,
        reason: 'gdelt_rate_limited',
      },
      {
        trigger: 'an empty answer',
        arrange: () => answerBy(() => () => ok({})),
        unchangedMs: 0,
        storedMs: 0,
        fallbackMs: 0,
        reason: 'gdelt_empty',
      },
      {
        trigger: 'a pacer shed on arrival behind seventeen queued requests',
        arrange: (background) => {
          answerBy(() => () => ok({}));
          for (let i = 0; i < 17; i++) background(call({ query: `queued ${i}` }));
        },
        unchangedMs: 0,
        storedMs: 0,
        fallbackMs: 0,
        reason: 'gdelt_rate_limited',
      },
      {
        trigger: 'HTTP 503 on all four attempts',
        arrange: () => answerBy(() => () => new Response('Unavailable', { status: 503 })),
        unchangedMs: 35_900,
        storedMs: 35_900,
        fallbackMs: 35_900,
        reason: 'gdelt_unavailable',
      },
      {
        trigger: 'HTTP 503 on all four attempts at the widest backoff jitter',
        arrange: () => {
          vi.spyOn(Math, 'random').mockReturnValue(1);
          answerBy(() => () => new Response('Unavailable', { status: 503 }));
        },
        unchangedMs: 44_625,
        storedMs: 44_625,
        fallbackMs: 44_625,
        reason: 'gdelt_unavailable',
      },
      {
        trigger: 'an HTTP 429 behind the cooldown gate at its 60-second ceiling',
        arrange: async () => {
          answerBy(() => refused);
          // Five consecutive rate limits double the gate from 5 s to its 60 s ceiling.
          for (let i = 0; i < 5; i++) {
            const refusal = rejection(call({ query: `refused ${i}` }));
            await vi.runAllTimersAsync();
            await refusal;
          }
          expect(getGdeltPacer().cooldown.remainingMs).toBe(60_000);
        },
        unchangedMs: 60_000,
        storedMs: 0,
        fallbackMs: 0,
        reason: 'gdelt_rate_limited',
      },
      {
        trigger: 'an HTTP 429 queued behind one hung request',
        arrange: async (background) => {
          answerBy((query) => (query === 'target' ? refused : 'hang'));
          background(rejection(call({ query: 'hung' }, { maxRetries: 0 })));
          await vi.advanceTimersByTimeAsync(0);
        },
        unchangedMs: 65_300,
        storedMs: 45_000,
        fallbackMs: 45_000,
        reason: 'gdelt_rate_limited',
      },
      {
        trigger: 'a pacer shed once the queue wait runs out behind two hung requests',
        arrange: async (background) => {
          answerBy((query) => (query === 'target' ? refused : 'hang'));
          for (const query of ['hung 0', 'hung 1']) {
            background(rejection(call({ query }, { maxRetries: 0 })));
          }
          await vi.advanceTimersByTimeAsync(0);
        },
        unchangedMs: 90_000,
        storedMs: 45_000,
        fallbackMs: 45_000,
        reason: 'gdelt_rate_limited',
      },
      {
        trigger: 'a request that hangs on every attempt until the call deadline',
        arrange: () => answerBy(() => 'hang'),
        unchangedMs: 120_000,
        storedMs: 45_000,
        fallbackMs: 45_000,
        reason: 'gdelt_unavailable',
      },
    ];

    beforeEach(() => {
      // The midpoint draw makes every backoff exactly its nominal value.
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    /**
     * Run `row` against TARGET at production pacing, 15 minutes after T0, and measure on the fake
     * clock how long after its start the call settles.
     */
    async function settleTarget(
      row: Row,
      { stored, options = {} }: { stored: boolean; options?: GdeltFetchOptions },
      ctx = createMockContext(),
    ) {
      if (stored) await storeAndAge(TARGET, 15 * MINUTE);
      else vi.setSystemTime(T0 + 15 * MINUTE);
      disposeGdeltPacer();
      initGdeltPacer(PRODUCTION_GAP_MS);
      const background: Array<Promise<unknown>> = [];
      await row.arrange((pending) => background.push(pending));

      const startedAt = Date.now();
      let settledAt: number | undefined;
      const outcome = call(TARGET, options, ctx).then(
        (value) => {
          settledAt = Date.now();
          return { value, error: undefined };
        },
        (error: unknown) => {
          settledAt = Date.now();
          return { value: undefined, error: error as McpError };
        },
      );
      await vi.advanceTimersByTimeAsync(HORIZON_MS);
      await Promise.allSettled(background);
      if (settledAt === undefined) throw new Error('the call was still pending at the horizon');
      return {
        ...(await outcome),
        afterMs: settledAt - startedAt,
        targetRequests: requestedQueries().filter((query) => query === 'target').length,
      };
    }

    /** The outcome a caller without a stored answer gets: the classified failure, or `{}`. */
    function expectUnserved(result: Awaited<ReturnType<typeof settleTarget>>, row: Row): void {
      if (row.reason === 'gdelt_empty') {
        expect(result.value).toEqual({});
        return;
      }
      expect(result.error).toMatchObject({
        code: CODES[row.reason],
        data: { reason: row.reason, retryable: true },
      });
    }

    describe.each(ROWS)('$trigger', (row) => {
      it(`serves a servable stored answer ${row.storedMs} ms after the call starts`, async () => {
        const ctx = createMockContext();
        const result = await settleTarget(row, { stored: true }, ctx);

        expect(result.afterMs).toBe(row.storedMs);
        expect(result.value).toEqual(BODY);
        expect(getEnrichment(ctx)).toEqual({
          staleResponse: expect.objectContaining({ reason: row.reason }),
        });
      });

      it(`settles ${row.unchangedMs} ms after the call starts with nothing stored`, async () => {
        const result = await settleTarget(row, { stored: false });

        expect(result.afterMs).toBe(row.unchangedMs);
        expectUnserved(result, row);
      });

      it(`settles ${row.fallbackMs} ms after the call starts for a hasFallback caller`, async () => {
        const result = await settleTarget(row, { stored: false, options: { hasFallback: true } });

        expect(result.afterMs).toBe(row.fallbackMs);
        expectUnserved(result, row);
        if (row.fallbackMs === row.unchangedMs) return;
        // Left at the budget: the reason's own public recovery, and whether a request went out.
        expect(result.error?.data?.recovery).toEqual({
          hint: HINTS[row.reason as keyof typeof HINTS],
        });
        expect(result.targetRequests).toBe(row.reason === 'gdelt_unavailable' ? 1 : 0);
      });
    });
  });

  describe('closed cooldown gate', () => {
    it('serves a servable stored answer at once, spending no request', async () => {
      await storeAndAge(PARAMS, 15 * MINUTE);
      upstream.mockImplementation(async () => refused());
      await rejection(call({ query: 'other' }));
      const ctx = createMockContext();

      const pending = call(PARAMS, {}, ctx);
      const { settled } = track(pending);
      await vi.advanceTimersByTimeAsync(0);

      expect(settled()).toBe(true);
      await expect(pending).resolves.toEqual(BODY);
      expect(requestedQueries()).toEqual(['stale', 'other']);
      expect(getEnrichment(ctx)).toEqual({
        staleResponse: {
          fetchedAt: '2026-10-15T12:00:00.000Z',
          ageSeconds: 900,
          reason: 'gdelt_rate_limited',
        },
      });
      expect((ctx.log as MockContextLogger).calls).toContainEqual({
        level: 'warning',
        msg: 'GDELT DOC API refetch gave no data; serving the stored answer',
        data: expect.objectContaining({ reason: 'gdelt_rate_limited', cooldownRemainingMs: 5_000 }),
      });
    });

    it('rejects a hasFallback call at once with gdelt_rate_limited, spending no request or pacer slot', async () => {
      upstream.mockImplementation(async () => refused());
      await rejection(call({ query: 'other' }));
      const run = vi.spyOn(getGdeltPacer(), 'run');
      const ctx = createMockContext();

      const pending = rejection(call(PARAMS, { hasFallback: true }, ctx));
      const { settled } = track(pending);
      await vi.advanceTimersByTimeAsync(0);

      expect(settled()).toBe(true);
      expect(await pending).toMatchObject({
        code: JsonRpcErrorCode.RateLimited,
        data: {
          reason: 'gdelt_rate_limited',
          retryable: true,
          recovery: { hint: RATE_LIMIT_HINT },
        },
      });
      expect(run).not.toHaveBeenCalled();
      expect(requestedQueries()).toEqual(['other']);
      expect(getGdeltPacer().cooldown.remainingMs).toBe(5_000);
      expect(getEnrichment(ctx)).toEqual({});
    });

    it('still serves a servable stored answer to a hasFallback call ahead of that rejection', async () => {
      await storeAndAge(PARAMS, 15 * MINUTE);
      upstream.mockImplementation(async () => refused());
      await rejection(call({ query: 'other' }));
      const ctx = createMockContext();

      await expect(call(PARAMS, { hasFallback: true }, ctx)).resolves.toEqual(BODY);
      expect(requestedQueries()).toEqual(['stale', 'other']);
      expect(getEnrichment(ctx)).toEqual({
        staleResponse: expect.objectContaining({ reason: 'gdelt_rate_limited' }),
      });
    });

    it('waits for the gate as before when the stored answer has outlived its timespan', async () => {
      const params = { ...PARAMS, timespan: '1h' };
      await storeAndAge(params, HOUR);
      upstream.mockImplementation(async () => refused());
      await rejection(call({ query: 'other' }));
      const ctx = createMockContext();

      const pending = rejection(call(params, {}, ctx));
      const { settled } = track(pending);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(settled()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      expect(await pending).toMatchObject({
        code: JsonRpcErrorCode.RateLimited,
        data: { reason: 'gdelt_rate_limited' },
      });
      expect(requestedQueries()).toEqual(['stale', 'other', 'stale']);
      expect(getEnrichment(ctx)).toEqual({});
    });
  });

  describe('fallback budget', () => {
    it('serves a servable stored answer at 45 s, ahead of a hasFallback rejection', async () => {
      await storeAndAge(PARAMS, 15 * MINUTE);
      holdRequests();
      const ctx = createMockContext();

      const pending = call(PARAMS, { hasFallback: true }, ctx);
      const { settled } = track(pending);
      await vi.advanceTimersByTimeAsync(44_999);
      expect(settled()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      expect(settled()).toBe(true);
      await expect(pending).resolves.toEqual(BODY);
      expect(getEnrichment(ctx)).toEqual({
        staleResponse: {
          fetchedAt: '2026-10-15T12:00:00.000Z',
          ageSeconds: 945,
          reason: 'gdelt_unavailable',
        },
      });
    });

    it('keeps waiting past 45 s when the stored answer stopped being servable by then', async () => {
      const params = { ...PARAMS, timespan: '1h' };
      await storeAndAge(params, HOUR - 30_000);
      const held = holdRequests();
      const ctx = createMockContext();

      const pending = call(params, {}, ctx);
      const { settled } = track(pending);
      await vi.advanceTimersByTimeAsync(50_000);
      expect(settled()).toBe(false);
      held[0]?.release(ok(FRESH));

      await expect(pending).resolves.toEqual(FRESH);
      expect(getEnrichment(ctx)).toEqual({});
    });

    it('leaves a shared fetch at 45 s without aborting it while another caller still waits', async () => {
      const held = holdRequests();

      const withFallback = rejection(call(undefined, { hasFallback: true }));
      const { settled } = track(withFallback);
      const plain = call();
      await vi.advanceTimersByTimeAsync(45_000);

      expect(settled()).toBe(true);
      expect(await withFallback).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: {
          reason: 'gdelt_unavailable',
          retryable: true,
          recovery: { hint: UNAVAILABLE_HINT },
        },
      });
      expect(held[0]?.signal.aborted).toBe(false);
      held[0]?.release(ok(BODY));
      await expect(plain).resolves.toEqual(BODY);
      expect(upstream).toHaveBeenCalledTimes(1);
    });

    it('aborts the shared fetch when the caller leaving at 45 s was its last, and a later call starts afresh', async () => {
      const held = holdRequests();

      const withFallback = rejection(call(undefined, { hasFallback: true }));
      const { settled } = track(withFallback);
      await vi.advanceTimersByTimeAsync(44_999);
      expect(settled()).toBe(false);
      expect(held[0]?.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      expect(settled()).toBe(true);
      expect(await withFallback).toMatchObject({ data: { reason: 'gdelt_unavailable' } });
      expect(held[0]?.signal.aborted).toBe(true);
      const later = call();
      await vi.advanceTimersByTimeAsync(0);
      held[1]?.release(ok(BODY));
      await expect(later).resolves.toEqual(BODY);
      expect(upstream).toHaveBeenCalledTimes(2);
    });

    it('leaves the cooldown gate open when it abandons a request held behind the request gap', async () => {
      disposeGdeltPacer();
      initGdeltPacer(PRODUCTION_GAP_MS);
      const held = holdRequests();
      const blocker = call({ query: 'blocker' });
      await vi.advanceTimersByTimeAsync(0);

      const withFallback = rejection(call(PARAMS, { hasFallback: true }));
      await vi.advanceTimersByTimeAsync(40_000);
      // The slot frees at 40 s, so the request is held behind the gap until 45.3 s.
      held[0]?.release(ok(BODY));
      await vi.advanceTimersByTimeAsync(5_000);

      expect(await withFallback).toMatchObject({
        code: JsonRpcErrorCode.RateLimited,
        data: { reason: 'gdelt_rate_limited' },
      });
      await expect(blocker).resolves.toEqual(BODY);
      expect(getGdeltPacer().cooldown.remainingMs).toBe(0);
      expect(requestedQueries()).toEqual(['blocker']);
    });

    it.each([
      ['a servable stored answer', true, {}],
      ['hasFallback', false, { hasFallback: true }],
    ])(
      'with %s, a caller cancelling before 45 s is cancelled and served nothing',
      async (_, stored, options) => {
        if (stored) await storeAndAge(PARAMS, 15 * MINUTE);
        const held = holdRequests();
        const controller = new AbortController();
        const ctx = createMockContext({ signal: controller.signal });

        const pending = rejection(call(PARAMS, options, ctx));
        await vi.advanceTimersByTimeAsync(30_000);
        controller.abort();
        await vi.advanceTimersByTimeAsync(30_000);

        expect(await pending).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
        expect(held[0]?.signal.aborted).toBe(true);
        expect(getEnrichment(ctx)).toEqual({});
        expect((ctx.log as MockContextLogger).calls.map((record) => record.level)).not.toContain(
          'warning',
        );
      },
    );
  });
});

describe('station-label lookup', () => {
  const SERVER_CONFIG = {
    baseUrl: 'https://api.gdeltproject.org/api/v2',
    requestTimeoutMs: 60_000,
  } as ConstructorParameters<typeof GdeltTvService>[2];
  const CATALOG = {
    station_details: [
      {
        StationID: 'FOXNEWS',
        Description: 'FOX News',
        Market: 'National',
        Network: 'FOXNEWS',
        StartDate: '20090702',
        EndDate: '20241010',
      },
    ],
  };
  const TIMELINE = {
    timeline: [{ series: 'FOX News', data: [{ date: '20240101T000000Z', value: 1 }] }],
  };

  it.each([
    ['an HTTP 429', () => new Response(RATE_LIMIT_TEXT, { status: 429 })],
    ['an empty catalog', () => ok({ station_details: [] })],
  ])(
    'never serves the catalog stale in place of %s, nor marks the caller’s answer stale',
    async (_, refusal) => {
      const service = () => new GdeltTvService({} as never, {} as never, SERVER_CONFIG);
      upstream.mockImplementation(async (url) =>
        ok(new URL(url).searchParams.get('mode') === 'stationdetails' ? CATALOG : TIMELINE),
      );
      await service().listStations(createMockContext());

      vi.setSystemTime(T0 + 15 * MINUTE);
      upstream.mockImplementation(async (url) =>
        new URL(url).searchParams.get('mode') === 'stationdetails' ? refusal() : ok(TIMELINE),
      );
      const ctx = createMockContext();
      const result = await service().searchTv({ query: 'x', stations: ['FOXNEWS'] }, ctx);

      expect(result.stationCatalogUnavailable).toBe(true);
      expect(result.series[0]).not.toHaveProperty('station');
      expect(getEnrichment(ctx)).toEqual({});
    },
  );
});

describe('disclosure surface', () => {
  it.each([
    gdeltSearchArticles,
    gdeltGetCoverageTimeline,
    gdeltGetToneDistribution,
    gdeltGetCoverageBreakdown,
    gdeltSearchTv,
    gdeltGetTvClips,
    gdeltGetTvContext,
    gdeltGetTvBreakdown,
    gdeltListTvStations,
  ])('$name declares staleResponse with a trailer render', (definition) => {
    const enrichment = definition.enrichment as Record<string, unknown>;
    const trailer = definition.enrichmentTrailer as Record<string, { render?: unknown }>;
    expect(enrichment).toHaveProperty('staleResponse');
    expect(trailer.staleResponse?.render).toBeTypeOf('function');
  });
});
