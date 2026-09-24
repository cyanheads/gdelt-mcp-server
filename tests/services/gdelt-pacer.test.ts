/**
 * @fileoverview Pacing behavior of `gdeltFetch` at its service seam — the gap held after the
 * previous response completed, the shared cooldown an upstream rate limit closes for every
 * queued caller, the doubling and reset of that cooldown, caller cancellation while queued,
 * the queue budget and the wait a shed reports, and disposal through the teardown hook. Mocks
 * the framework's `fetchWithTimeout` and keeps the real `withRetry` and pacer, so these assert
 * the sequencing a GDELT caller actually gets.
 * @module tests/services/gdelt-pacer.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { fetchWithTimeout } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gdeltFetch } from '@/services/gdelt/gdelt-fetch.js';
import {
  disposeGdeltPacer,
  GDELT_MAX_QUEUE_WAIT_MS,
  initGdeltPacer,
} from '@/services/gdelt/gdelt-pacer.js';

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

function callGdeltFetch(signal?: AbortSignal) {
  const ctx = createMockContext(signal ? { signal } : {});
  return gdeltFetch<{ ok: boolean }>(
    BASE_URL,
    new URLSearchParams({ query: 'climate' }),
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
  });

  afterEach(() => {
    disposeGdeltPacer();
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
    const third = callGdeltFetch();

    await vi.advanceTimersByTimeAsync(0);
    controller.abort();

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

    await vi.advanceTimersByTimeAsync(0);
    await expect(first).resolves.toEqual({ ok: true });

    disposeGdeltPacer();

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
   * The pacer projects `retryAfter` against the queue as it stands at the shed instant, which
   * is empty whenever `maxConcurrent` rather than the gate was the real constraint — so a
   * caller that waited out its entire budget is told to retry in 0s. The measured wait is the
   * number that caller can act on.
   */
  it('reports the wait it actually endured when the pacer projects none', async () => {
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
      new RegExp(`no slot opened in the ${GDELT_MAX_QUEUE_WAIT_MS / 1000}s this request waited`),
    );
    expect(error.data).toMatchObject({
      reason: 'gdelt_rate_limited',
      retryable: false,
      retryAfter: 0,
      recovery: { hint: expect.stringMatching(/wait about \d+ seconds/i) },
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
        retryable: false,
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
});
