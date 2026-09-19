/**
 * @fileoverview Pacing behavior of `gdeltFetch` at its service seam — the minimum gap between
 * consecutive upstream requests, the shared cooldown an upstream rate limit closes for every
 * queued caller, the doubling and reset of that cooldown, caller cancellation while queued,
 * and disposal through the teardown hook. Mocks the framework's `fetchWithTimeout` and keeps
 * the real `withRetry` and pacer, so these assert the sequencing a GDELT caller actually gets.
 * @module tests/services/gdelt-pacer.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { fetchWithTimeout } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gdeltFetch } from '@/services/gdelt/gdelt-fetch.js';
import { disposeGdeltPacer, initGdeltPacer } from '@/services/gdelt/gdelt-pacer.js';

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

  it('sheds a caller whose projected wait exceeds the budget, spending no request', async () => {
    mockedFetch.mockResolvedValue(jsonBody({ ok: true }));

    // GDELT_MAX_QUEUE_WAIT_MS is 60s; at a 5s gap the 13th arrival cannot start in time.
    const queued = Array.from({ length: 13 }, () => swallow(callGdeltFetch()));
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
    await Promise.all(queued);
  });
});
