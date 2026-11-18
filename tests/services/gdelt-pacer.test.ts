/**
 * @fileoverview Pacing behavior of `gdeltFetch` at its service seam — the gap held after the
 * previous response completed, the cooldown an upstream rate limit closes for every caller queued
 * on that endpoint, the doubling and reset of that cooldown, caller cancellation while queued,
 * the queue budget and the wait a shed reports, and disposal through the teardown hook; then the
 * per-endpoint split: DOC, TV, and Context each with their own cooldown in front of the one
 * shared request slot and gap. Mocks the framework's `fetchWithTimeout` and keeps the real
 * `withRetry` and pacer, so these assert the sequencing a GDELT caller actually gets.
 * @module tests/services/gdelt-pacer.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { fetchWithTimeout } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type GdeltFetchOptions, gdeltFetch } from '@/services/gdelt/gdelt-fetch.js';
import {
  disposeGdeltPacer,
  GDELT_MAX_QUEUE_WAIT_MS,
  getGdeltPacer,
  initGdeltPacer,
} from '@/services/gdelt/gdelt-pacer.js';
import {
  disposeGdeltResponseCache,
  initGdeltResponseCache,
} from '@/services/gdelt/gdelt-response-cache.js';

vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return { ...actual, fetchWithTimeout: vi.fn() };
});

const mockedFetch = vi.mocked(fetchWithTimeout);

const BASE_URL = 'https://api.gdeltproject.org/api/v2/doc/doc';
const GAP_MS = 5_000;
/**
 * A start gap far below the cooldown, so a cooldown test can tell the two apart: with the
 * production 5s gap and a 5s base cooldown, "held by the gate" and "held by the gap" release
 * at the same instant.
 */
const SHORT_GAP_MS = 50;
/** `GDELT_COOLDOWN_BASE_MS` in `src/services/gdelt/gdelt-pacer.ts`. */
const COOLDOWN_BASE_MS = 5_000;

/** A GDELT 200 carrying a well-formed JSON body. */
function jsonBody(payload: unknown): Response {
  return { text: async () => JSON.stringify(payload) } as unknown as Response;
}

/** The transient `RateLimited` McpError `fetchWithTimeout` maps a GDELT 429 to. */
function upstream429(): McpError {
  return new McpError(JsonRpcErrorCode.RateLimited, 'GDELT returned 429', { status: 429 });
}

let callCount = 0;

/**
 * One call to a URL no other call uses: concurrent identical calls share one fetch, and these
 * cases pace distinct requests.
 */
function callGdeltFetch(signal?: AbortSignal) {
  const ctx = createMockContext(signal ? { signal } : {});
  callCount += 1;
  return gdeltFetch<{ ok: boolean }>(
    BASE_URL,
    new URLSearchParams({ query: `climate ${callCount}` }),
    ctx,
    'searchArticles',
    'GDELT DOC',
  );
}

/** Settle a rejection without leaving an unhandled rejection behind. */
function swallow(promise: Promise<unknown>): Promise<unknown> {
  return promise.catch(() => undefined);
}

describe('gdeltFetch pacing', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
    // GDELT is rate-limited: a call no case arranged fails loudly instead of passing silently.
    mockedFetch.mockRejectedValue(new Error('unmocked fetch'));
    vi.useFakeTimers();
    initGdeltPacer(GAP_MS);
    initGdeltResponseCache();
  });

  afterEach(() => {
    disposeGdeltPacer();
    disposeGdeltResponseCache();
    vi.useRealTimers();
  });

  it('holds a second request back until the minimum gap has elapsed', async () => {
    mockedFetch.mockResolvedValue(jsonBody({ ok: true }));

    const first = callGdeltFetch();
    const second = callGdeltFetch();

    await vi.advanceTimersByTimeAsync(0);
    expect(mockedFetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(GAP_MS - 1);
    expect(mockedFetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(mockedFetch).toHaveBeenCalledTimes(2);

    await expect(first).resolves.toEqual({ ok: true });
    await expect(second).resolves.toEqual({ ok: true });
  });

  it('rejects a queued caller whose signal fires, without stalling the one behind it', async () => {
    mockedFetch.mockResolvedValue(jsonBody({ ok: true }));
    const controller = new AbortController();

    const first = callGdeltFetch();
    const aborted = callGdeltFetch(controller.signal);
    const { settled } = track(aborted);
    const third = callGdeltFetch();

    await vi.advanceTimersByTimeAsync(0);
    controller.abort();

    // Rejected at once, while still queued, not once its turn comes.
    await vi.advanceTimersByTimeAsync(0);
    expect(settled()).toBe(true);
    await expect(aborted).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(GAP_MS);

    await expect(first).resolves.toEqual({ ok: true });
    await expect(third).resolves.toEqual({ ok: true });
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it('serializes concurrent callers in arrival order', async () => {
    const seen: string[] = [];
    mockedFetch.mockImplementation((url) => {
      seen.push(new URL(url as string).searchParams.get('query') as string);
      return Promise.resolve(jsonBody({ ok: true }));
    });

    const calls = ['a', 'b', 'c'].map((query) =>
      gdeltFetch<{ ok: boolean }>(
        BASE_URL,
        new URLSearchParams({ query }),
        createMockContext(),
        'searchArticles',
        'GDELT DOC',
      ),
    );

    await vi.advanceTimersByTimeAsync(GAP_MS * 3);
    await Promise.all(calls);

    expect(seen).toEqual(['a', 'b', 'c']);
  });

  it('closes the gate on a 429, holding an already-queued sibling for the cooldown', async () => {
    disposeGdeltPacer();
    initGdeltPacer(SHORT_GAP_MS);
    mockedFetch.mockRejectedValueOnce(upstream429()).mockResolvedValue(jsonBody({ ok: true }));

    const failing = swallow(callGdeltFetch());
    const queued = callGdeltFetch();

    await vi.advanceTimersByTimeAsync(0);
    await failing;
    expect(mockedFetch).toHaveBeenCalledTimes(1);

    // Ten start gaps would long since have released the sibling; the gate holds it.
    await vi.advanceTimersByTimeAsync(SHORT_GAP_MS * 10);
    expect(mockedFetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(COOLDOWN_BASE_MS);
    expect(mockedFetch).toHaveBeenCalledTimes(2);
    await expect(queued).resolves.toEqual({ ok: true });
  });

  it('doubles the cooldown on consecutive 429s and resets it after a success', async () => {
    disposeGdeltPacer();
    initGdeltPacer(SHORT_GAP_MS);
    mockedFetch.mockRejectedValue(upstream429());

    const first = swallow(callGdeltFetch());
    await vi.advanceTimersByTimeAsync(0);
    await first;
    expect(mockedFetch).toHaveBeenCalledTimes(1);

    const second = swallow(callGdeltFetch());
    await vi.advanceTimersByTimeAsync(COOLDOWN_BASE_MS);
    await second;
    expect(mockedFetch).toHaveBeenCalledTimes(2);

    // Second consecutive rate limit → 2 × base. One base-length wait is not enough.
    const third = callGdeltFetch();
    await vi.advanceTimersByTimeAsync(COOLDOWN_BASE_MS);
    expect(mockedFetch).toHaveBeenCalledTimes(2);

    mockedFetch.mockResolvedValue(jsonBody({ ok: true }));
    await vi.advanceTimersByTimeAsync(COOLDOWN_BASE_MS);
    expect(mockedFetch).toHaveBeenCalledTimes(3);
    await expect(third).resolves.toEqual({ ok: true });

    // That success reset the counter, so only the start gap separates the next request.
    const fourth = callGdeltFetch();
    await vi.advanceTimersByTimeAsync(SHORT_GAP_MS);
    expect(mockedFetch).toHaveBeenCalledTimes(4);
    await expect(fourth).resolves.toEqual({ ok: true });
  });

  it('rejects queued waiters when the pacer is disposed through teardown', async () => {
    mockedFetch.mockResolvedValue(jsonBody({ ok: true }));

    const first = callGdeltFetch();
    const queued = callGdeltFetch();
    const { settled } = track(queued);

    await vi.advanceTimersByTimeAsync(0);
    await expect(first).resolves.toEqual({ ok: true });

    disposeGdeltPacer();

    // Rejected by the disposal itself, with no timer left to run.
    await vi.advanceTimersByTimeAsync(0);
    expect(settled()).toBe(true);
    await expect(queued).rejects.toMatchObject({
      code: JsonRpcErrorCode.RequestCancelled,
      message: expect.stringMatching(/pacer has been disposed/i),
    });
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  /**
   * GDELT's limiter counts from the previous response, not the previous request: a request
   * sent seconds after the last one *completed* is still rejected. The pacer spaces starts, so
   * with one request in flight any response slower than the gap leaves no gap at all after it
   * completes — which is the normal case against an API that answers in tens of seconds.
   */
  it('holds the next request until the gap has elapsed since the previous one completed', async () => {
    const SLOW_RESPONSE_MS = GAP_MS * 2;
    mockedFetch.mockImplementation(
      () =>
        new Promise<Response>((resolve) =>
          setTimeout(() => resolve(jsonBody({ ok: true })), SLOW_RESPONSE_MS),
        ),
    );

    const first = callGdeltFetch();
    const second = callGdeltFetch();

    await vi.advanceTimersByTimeAsync(SLOW_RESPONSE_MS);
    await expect(first).resolves.toEqual({ ok: true });
    // The start gap elapsed long ago, so start-relative spacing alone would dispatch now.
    expect(mockedFetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(GAP_MS - 1);
    expect(mockedFetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(mockedFetch).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(SLOW_RESPONSE_MS);
    await expect(second).resolves.toEqual({ ok: true });
  });

  it('holds after a failed request too — a rejection still spends the upstream slot', async () => {
    // A gap wider than the cooldown so the hold, not the reopening gate, is what is measured.
    const LONG_GAP_MS = COOLDOWN_BASE_MS * 2;
    disposeGdeltPacer();
    initGdeltPacer(LONG_GAP_MS);
    mockedFetch
      .mockImplementationOnce(
        () =>
          new Promise<Response>((_resolve, reject) =>
            setTimeout(() => reject(upstream429()), LONG_GAP_MS),
          ),
      )
      .mockResolvedValue(jsonBody({ ok: true }));

    const failing = swallow(callGdeltFetch());
    const second = callGdeltFetch();

    await vi.advanceTimersByTimeAsync(LONG_GAP_MS);
    await failing;
    expect(mockedFetch).toHaveBeenCalledTimes(1);

    // The gate reopened a cooldown after the rejection; the hold runs a full gap past it.
    await vi.advanceTimersByTimeAsync(LONG_GAP_MS - 1);
    expect(mockedFetch).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(mockedFetch).toHaveBeenCalledTimes(2);
    await expect(second).resolves.toEqual({ ok: true });
  });

  /**
   * When `maxConcurrent` rather than the gate is the real constraint, the pacer floors
   * `retryAfter` at the longest queued wait — the shed caller's own included — so a caller
   * that waited out its entire budget is told to wait that long, never 0s.
   */
  it('reports the queued wait when the in-flight slot, not the gate, held the caller', async () => {
    disposeGdeltPacer();
    initGdeltPacer(SHORT_GAP_MS);
    mockedFetch.mockImplementation(
      () =>
        new Promise<Response>((resolve) =>
          setTimeout(() => resolve(jsonBody({ ok: true })), GDELT_MAX_QUEUE_WAIT_MS * 2),
        ),
    );

    const inFlight = swallow(callGdeltFetch());
    const shed = callGdeltFetch().catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(GDELT_MAX_QUEUE_WAIT_MS);
    const error = (await shed) as McpError;

    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.message).toMatch(
      new RegExp(`no slot opens within ${GDELT_MAX_QUEUE_WAIT_MS / 1000}s`),
    );
    expect(error.data).toMatchObject({
      reason: 'gdelt_rate_limited',
      retryable: true,
      retryAfter: GDELT_MAX_QUEUE_WAIT_MS / 1000,
      recovery: {
        hint: expect.stringMatching(
          new RegExp(`wait about ${GDELT_MAX_QUEUE_WAIT_MS / 1000} seconds`, 'i'),
        ),
      },
    });

    await vi.runAllTimersAsync();
    await inFlight;
  });

  it('sheds a caller whose projected wait exceeds the budget, spending no request', async () => {
    mockedFetch.mockResolvedValue(jsonBody({ ok: true }));

    // GDELT_MAX_QUEUE_WAIT_MS is 90s; at a 5s gap the 20th arrival cannot start in time.
    const queued = Array.from({ length: 19 }, () =>
      callGdeltFetch().catch((error: unknown) => error),
    );
    const shed = callGdeltFetch();

    const expectation = expect(shed).rejects.toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: {
        reason: 'gdelt_rate_limited',
        retryable: true,
        recovery: { hint: expect.stringMatching(/wait about \d+ seconds/i) },
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    await expectation;
    // Only the head of the queue has reached the network; the shed spent nothing.
    expect(mockedFetch).toHaveBeenCalledTimes(1);

    await vi.runAllTimersAsync();
    // The budget is decoupled from the 60s cooldown ceiling: at that ceiling the 14th arrival,
    // projecting a 65s wait, was shed on arrival and could never wait a closed gate out.
    expect((await Promise.all(queued))[13]).toEqual({ ok: true });
  });

  /**
   * GDELT throttles DOC, TV, and Context separately: a rate limit from one closes only that
   * endpoint's cooldown, which doubles on its own consecutive rate limits and resets on its own
   * success. The one request slot and the gap after each response stay shared.
   */
  describe('per-endpoint cooldown', () => {
    const ENDPOINTS = {
      doc: BASE_URL,
      tv: 'https://api.gdeltproject.org/api/v2/tv/tv',
      context: 'https://api.gdeltproject.org/api/v2/context/context',
    } as const;
    const LABELS = { doc: 'GDELT DOC', tv: 'GDELT TV', context: 'GDELT Context' } as const;
    type Endpoint = keyof typeof ENDPOINTS;

    /** Every upstream request as `[endpoint, ms after the case started]`, in send order. */
    let sent: Array<[Endpoint, number]>;
    let caseStartedAt: number;

    beforeEach(() => {
      disposeGdeltPacer();
      initGdeltPacer(SHORT_GAP_MS);
      sent = [];
      caseStartedAt = Date.now();
    });

    const refuse = () => Promise.reject(upstream429());
    const answer = () => Promise.resolve(jsonBody({ ok: true }));

    /** Answer each request by its endpoint, logging when it went out. */
    function answerBy(pick: (endpoint: Endpoint) => () => Promise<Response>): void {
      mockedFetch.mockImplementation((url) => {
        const endpoint = new URL(url as string).pathname.split('/').pop() as Endpoint;
        sent.push([endpoint, Date.now() - caseStartedAt]);
        return pick(endpoint)();
      });
    }

    /** One call to `endpoint`, for `params` or else a URL no other call uses. */
    function callAt(
      endpoint: Endpoint,
      options: GdeltFetchOptions = {},
      ctx = createMockContext(),
      params?: URLSearchParams,
    ) {
      callCount += 1;
      return gdeltFetch<unknown>(
        ENDPOINTS[endpoint],
        params ?? new URLSearchParams({ query: `climate ${callCount}` }),
        ctx,
        'test',
        LABELS[endpoint],
        options,
      );
    }

    it.each<[Endpoint, Endpoint, Endpoint]>([
      ['doc', 'tv', 'context'],
      ['tv', 'doc', 'context'],
    ])(
      'after two %s rate limits, %s and %s calls go out after the request gap alone',
      async (refusing, first, second) => {
        answerBy((endpoint) => (endpoint === refusing ? refuse : answer));
        const refusal = swallow(callAt(refusing));
        await vi.advanceTimersByTimeAsync(0);
        await refusal;
        const again = swallow(callAt(refusing));
        await vi.advanceTimersByTimeAsync(COOLDOWN_BASE_MS);
        await again;

        const others = [callAt(first), callAt(second)];
        await vi.advanceTimersByTimeAsync(SHORT_GAP_MS * 2);

        expect(sent).toEqual([
          [refusing, 0],
          [refusing, COOLDOWN_BASE_MS],
          [first, COOLDOWN_BASE_MS + SHORT_GAP_MS],
          [second, COOLDOWN_BASE_MS + SHORT_GAP_MS * 2],
        ]);
        await expect(Promise.all(others)).resolves.toEqual([{ ok: true }, { ok: true }]);
        // The refusing endpoint's own cooldown is still closed, at twice the base.
        expect(getGdeltPacer(ENDPOINTS[refusing]).cooldown).toEqual({
          remainingMs: COOLDOWN_BASE_MS * 2 - SHORT_GAP_MS * 2,
          consecutive: 2,
        });
        expect(getGdeltPacer(ENDPOINTS[first]).cooldown).toEqual({
          remainingMs: 0,
          consecutive: 0,
        });
      },
    );

    it.each<[Endpoint, Endpoint]>([
      ['doc', 'tv'],
      ['tv', 'context'],
    ])(
      'keeps doubling the %s cooldown across a %s success: 429, 429, 200, 429 closes it for 4x the base',
      async (refusing, answering) => {
        answerBy((endpoint) => (endpoint === refusing ? refuse : answer));
        const first = swallow(callAt(refusing));
        await vi.advanceTimersByTimeAsync(0);
        await first;
        const second = swallow(callAt(refusing));
        await vi.advanceTimersByTimeAsync(COOLDOWN_BASE_MS);
        await second;
        const success = callAt(answering);
        await vi.advanceTimersByTimeAsync(SHORT_GAP_MS);
        expect(sent.at(-1)).toEqual([answering, COOLDOWN_BASE_MS + SHORT_GAP_MS]);
        await expect(success).resolves.toEqual({ ok: true });

        // The second refusal closed the cooldown for 2x the base, from the base onward.
        const third = swallow(callAt(refusing));
        const { settled } = track(third);
        await vi.advanceTimersByTimeAsync(COOLDOWN_BASE_MS * 2 - SHORT_GAP_MS);
        expect(settled()).toBe(true);
        await third;
        expect(getGdeltPacer(ENDPOINTS[refusing]).cooldown).toEqual({
          remainingMs: COOLDOWN_BASE_MS * 4,
          consecutive: 3,
        });

        const fourth = swallow(callAt(refusing));
        await vi.advanceTimersByTimeAsync(COOLDOWN_BASE_MS * 4 - 1);
        expect(sent).toHaveLength(4);
        await vi.advanceTimersByTimeAsync(1);
        expect(sent).toEqual([
          [refusing, 0],
          [refusing, COOLDOWN_BASE_MS],
          [answering, COOLDOWN_BASE_MS + SHORT_GAP_MS],
          [refusing, COOLDOWN_BASE_MS * 3],
          [refusing, COOLDOWN_BASE_MS * 7],
        ]);
        await fourth;
      },
    );

    /**
     * The station catalog (`mode=stationdetails`) is a request to the TV endpoint, so it waits on
     * and closes TV's one cooldown: DOC, TV, and Context each have exactly one.
     */
    it.each<[string, 'query' | 'catalog', 'query' | 'catalog']>([
      ['a refused TV request holds a station-catalog request', 'query', 'catalog'],
      ['a refused station-catalog request holds a TV request', 'catalog', 'query'],
    ])(
      '%s until TV’s cooldown opens, and that success resets it',
      async (_label, refused, held) => {
        const requests: Array<['query' | 'catalog', number]> = [];
        mockedFetch.mockImplementation((url) => {
          const kind =
            new URL(url as string).searchParams.get('mode') === 'stationdetails'
              ? 'catalog'
              : 'query';
          requests.push([kind, Date.now() - caseStartedAt]);
          return kind === refused ? refuse() : answer();
        });
        const callTv = (kind: 'query' | 'catalog') =>
          callAt(
            'tv',
            {},
            createMockContext(),
            kind === 'catalog' ? new URLSearchParams({ mode: 'stationdetails' }) : undefined,
          );

        const refusal = swallow(callTv(refused));
        await vi.advanceTimersByTimeAsync(0);
        await refusal;
        expect(getGdeltPacer(ENDPOINTS.tv).cooldown).toEqual({
          remainingMs: COOLDOWN_BASE_MS,
          consecutive: 1,
        });

        const pending = callTv(held);
        await vi.advanceTimersByTimeAsync(COOLDOWN_BASE_MS - 1);
        expect(requests).toEqual([[refused, 0]]);
        await vi.advanceTimersByTimeAsync(1);
        expect(requests).toEqual([
          [refused, 0],
          [held, COOLDOWN_BASE_MS],
        ]);
        await expect(pending).resolves.toEqual({ ok: true });
        expect(getGdeltPacer(ENDPOINTS.tv).cooldown).toEqual({ remainingMs: 0, consecutive: 0 });
      },
    );

    /**
     * One call per endpoint waits for the shared slot at a time, the rest behind their endpoint's
     * cooldown, so the slot takes endpoints in turn rather than strictly by arrival.
     */
    it('takes endpoints in turn for the shared slot: a TV call queued behind two DOC calls goes second', async () => {
      answerBy(() => answer);
      const calls = [callAt('doc'), callAt('doc'), callAt('tv')];

      await vi.advanceTimersByTimeAsync(SHORT_GAP_MS * 2);

      expect(sent).toEqual([
        ['doc', 0],
        ['tv', SHORT_GAP_MS],
        ['doc', SHORT_GAP_MS * 2],
      ]);
      await Promise.all(calls);
    });

    it('holds calls queued behind a 429 on the same endpoint for its cooldown, and sends those for other endpoints after the gap', async () => {
      const RESPONSE_MS = 1_000;
      answerBy((endpoint) =>
        endpoint === 'doc'
          ? () =>
              new Promise<Response>((_resolve, reject) =>
                setTimeout(() => reject(upstream429()), RESPONSE_MS),
              )
          : answer,
      );

      const docs = [callAt('doc'), callAt('doc')].map(swallow);
      const tv = callAt('tv');
      docs.push(swallow(callAt('doc')));
      const context = callAt('context');

      // The first DOC request is refused at 1 s; DOC's cooldown then runs to 6 s.
      await vi.advanceTimersByTimeAsync(RESPONSE_MS + COOLDOWN_BASE_MS - 1);
      expect(sent).toEqual([
        ['doc', 0],
        ['tv', RESPONSE_MS + SHORT_GAP_MS],
        ['context', RESPONSE_MS + SHORT_GAP_MS * 2],
      ]);
      await expect(Promise.all([tv, context])).resolves.toEqual([{ ok: true }, { ok: true }]);

      await vi.advanceTimersByTimeAsync(1);
      expect(sent.at(-1)).toEqual(['doc', RESPONSE_MS + COOLDOWN_BASE_MS]);

      // That second DOC refusal lands at 7 s and doubles the cooldown, to 17 s.
      const secondRefusedAt = RESPONSE_MS * 2 + COOLDOWN_BASE_MS;
      await vi.advanceTimersByTimeAsync(RESPONSE_MS + COOLDOWN_BASE_MS * 2 - 1);
      expect(sent).toHaveLength(4);
      await vi.advanceTimersByTimeAsync(1);
      expect(sent.at(-1)).toEqual(['doc', secondRefusedAt + COOLDOWN_BASE_MS * 2]);
      await vi.runAllTimersAsync();
      await Promise.all(docs);
    });

    it.each<[string, GdeltFetchOptions, boolean]>([
      ['hasFallback', { hasFallback: true }, false],
      ['a servable stored answer', {}, true],
    ])(
      'rejects a call waiting on its cooldown with the caller’s own cancellation when it holds %s',
      async (_, options, stored) => {
        const params = new URLSearchParams({ query: 'waiting' });
        if (stored) {
          mockedFetch.mockResolvedValueOnce(
            jsonBody({ articles: [{ url: 'https://example.com/a' }] }),
          );
          await callAt('doc', {}, createMockContext(), params);
          // Past its 15-minute freshness, still servable stale for a day.
          vi.setSystemTime(Date.now() + 15 * 60_000);
          caseStartedAt = Date.now();
        }
        const RESPONSE_MS = 1_000;
        answerBy(
          () => () =>
            new Promise<Response>((_resolve, reject) =>
              setTimeout(() => reject(upstream429()), RESPONSE_MS),
            ),
        );
        const refusal = swallow(callAt('doc'));
        const controller = new AbortController();
        const ctx = createMockContext({ signal: controller.signal });
        // The cooldown is open when the call arrives, so it queues rather than answering at once.
        const pending = callAt('doc', options, ctx, params);
        const outcome = pending.then(
          () => 'resolved',
          (error: unknown) => error,
        );
        const { settled } = track(outcome);

        await vi.advanceTimersByTimeAsync(RESPONSE_MS * 3);
        await refusal;
        expect(getGdeltPacer(ENDPOINTS.doc).cooldown.remainingMs).toBeGreaterThan(0);
        controller.abort();

        // Rejected at once, while the cooldown is still closed.
        await vi.advanceTimersByTimeAsync(0);
        expect(settled()).toBe(true);
        expect(await outcome).toBe(controller.signal.reason);
        await vi.advanceTimersByTimeAsync(COOLDOWN_BASE_MS * 2);
        expect(sent).toEqual([['doc', 0]]);
        expect(getEnrichment(ctx)).toEqual({});
      },
    );

    it('charges the wait on a cooldown to the queue budget: a call that cannot start within it is shed, sending nothing', async () => {
      const RETRY_AFTER_S = 60;
      const HUNG_MS = GDELT_MAX_QUEUE_WAIT_MS * 2;
      answerBy((endpoint) =>
        endpoint === 'doc'
          ? () =>
              Promise.reject(
                new McpError(JsonRpcErrorCode.RateLimited, 'GDELT returned 429', {
                  status: 429,
                  retryAfter: RETRY_AFTER_S,
                }),
              )
          : () =>
              new Promise<Response>((resolve) =>
                setTimeout(() => resolve(jsonBody({ ok: true })), HUNG_MS),
              ),
      );
      const refusal = swallow(callAt('doc'));
      await vi.advanceTimersByTimeAsync(0);
      await refusal;
      // Retry-After is honored on the endpoint that sent it, and nowhere else.
      expect(getGdeltPacer(ENDPOINTS.doc).cooldown.remainingMs).toBe(RETRY_AFTER_S * 1000);
      expect(getGdeltPacer(ENDPOINTS.tv).cooldown.remainingMs).toBe(0);

      // TV takes the shared slot after the gap and holds it; the DOC call waits 60 s on its own
      // cooldown, then queues for the slot with 30 s of its budget left.
      const hung = swallow(callAt('tv'));
      const shed = callAt('doc');
      const { settled } = track(shed);
      await vi.advanceTimersByTimeAsync(SHORT_GAP_MS);
      expect(sent).toEqual([
        ['doc', 0],
        ['tv', SHORT_GAP_MS],
      ]);

      await vi.advanceTimersByTimeAsync(GDELT_MAX_QUEUE_WAIT_MS - SHORT_GAP_MS - 1);
      expect(settled()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled()).toBe(true);
      await expect(shed).rejects.toMatchObject({
        code: JsonRpcErrorCode.RateLimited,
        data: {
          reason: 'gdelt_rate_limited',
          retryable: true,
          recovery: { hint: expect.stringMatching(/wait about \d+ seconds/i) },
        },
      });
      expect(sent).toHaveLength(2);
      // No upstream answered the shed, so it leaves DOC's cooldown as it found it: open.
      expect(getGdeltPacer(ENDPOINTS.doc).cooldown.remainingMs).toBe(0);

      await vi.runAllTimersAsync();
      await hung;
    });

    it('backs a refusing endpoint off to the 60 s ceiling while another endpoint keeps answering', async () => {
      answerBy((endpoint) => (endpoint === 'doc' ? refuse : answer));
      const refusal = swallow(callAt('doc'));
      await vi.advanceTimersByTimeAsync(0);
      await refusal;

      let refusedAt = 0;
      for (const cooldownMs of [5_000, 10_000, 20_000, 40_000, 60_000, 60_000]) {
        // A TV success between two DOC refusals resets nothing on DOC.
        const tv = callAt('tv');
        const doc = swallow(callAt('doc'));
        await vi.advanceTimersByTimeAsync(cooldownMs - 1);
        expect(sent.at(-1)).toEqual(['tv', refusedAt + SHORT_GAP_MS]);
        await vi.advanceTimersByTimeAsync(1);
        expect(sent.at(-1)).toEqual(['doc', refusedAt + cooldownMs]);
        await doc;
        await expect(tv).resolves.toEqual({ ok: true });
        refusedAt += cooldownMs;
      }
      expect(sent.filter(([endpoint]) => endpoint === 'doc')).toHaveLength(7);
    });

    it('when every endpoint refuses, asks each no faster than its own doubling, and sheds what cannot start within the budget', async () => {
      answerBy(() => refuse);
      const queued = (['doc', 'tv', 'context'] as const).flatMap((endpoint) =>
        Array.from({ length: 6 }, () => callAt(endpoint).catch((error: unknown) => error)),
      );

      await vi.runAllTimersAsync();
      const outcomes = (await Promise.all(queued)) as McpError[];

      // Each ladder runs 0, 5, 15, 35, 75 s, offset by the shared gap; a sixth request would land
      // at 135 s, past the 90 s budget, so the sixth call per endpoint is shed without one.
      const ladder = [0, 5_000, 15_000, 35_000, 75_000];
      expect(sent).toEqual(
        ladder.flatMap((at) => [
          ['doc', at],
          ['tv', at + SHORT_GAP_MS],
          ['context', at + SHORT_GAP_MS * 2],
        ]),
      );
      for (const outcome of outcomes) {
        expect(outcome).toMatchObject({
          code: JsonRpcErrorCode.RateLimited,
          data: { reason: 'gdelt_rate_limited', retryable: true },
        });
      }
    });
  });
});

/** Flag a pending call once it settles, without consuming its outcome. */
function track(pending: Promise<unknown>): { settled: () => boolean } {
  let settled = false;
  const mark = () => {
    settled = true;
  };
  void pending.then(mark, mark);
  return { settled: () => settled };
}
