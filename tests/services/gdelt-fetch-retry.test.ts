/**
 * @fileoverview Retry-boundary behavior of gdeltFetch: rate-limit rejections must fail fast
 * (no replay into GDELT's still-closed window), ordinary transient failures still retry, each
 * attempt is bounded by the configured request deadline and the call as a whole by twice it,
 * and every failure the ladder treats as transient carries the declared `gdelt_unavailable`
 * contract. Mocks the framework's `fetchWithTimeout` while keeping the real `withRetry`, so these
 * assert the actual retry classification end to end; the last block delegates that mock to the
 * real `fetchWithTimeout` and stubs the global `fetch` beneath it.
 * @module tests/services/gdelt-fetch-retry.test
 */

import { JsonRpcErrorCode, McpError, requestCancelled } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { fetchWithTimeout } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gdeltFetch } from '@/services/gdelt/gdelt-fetch.js';
import { disposeGdeltPacer, initGdeltPacer } from '@/services/gdelt/gdelt-pacer.js';

// Keep the real withRetry (the code under test) and stub only the network call.
vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return { ...actual, fetchWithTimeout: vi.fn() };
});

const mockedFetch = vi.mocked(fetchWithTimeout);

const BASE_URL = 'https://api.gdeltproject.org/api/v2/doc/doc';

/** `GDELT_REQUEST_TIMEOUT_MS`'s default — the deadline handed to a single attempt's fetch. */
const REQUEST_TIMEOUT_MS = 60_000;

/** The `Timeout` `fetchWithTimeout` raises when one attempt runs out its own deadline. */
function fetchTimeout(): McpError {
  return new McpError(
    JsonRpcErrorCode.Timeout,
    'fetch GET https://api.gdeltproject.org/api/v2/doc/doc?… timed out.',
    { errorSource: 'FetchTimeout' },
  );
}

function callGdeltFetch() {
  return gdeltFetch(
    BASE_URL,
    new URLSearchParams({ query: 'climate' }),
    createMockContext(),
    'searchArticles',
    'GDELT DOC',
  );
}

describe('gdeltFetch retry boundary', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
    // GDELT is rate-limited: a call no case arranged fails loudly instead of passing silently.
    mockedFetch.mockRejectedValue(new Error('unmocked fetch'));
    // No inter-request spacing in unit tests — pacing is not what's under test here.
    initGdeltPacer(0);
  });

  afterEach(() => {
    disposeGdeltPacer();
  });

  it('fails fast on an HTTP 429 — the underlying fetch runs exactly once, not 4×', async () => {
    // fetchWithTimeout maps a 429 to a transient RateLimited McpError.
    mockedFetch.mockRejectedValue(
      new McpError(JsonRpcErrorCode.RateLimited, 'GDELT returned 429', { status: 429 }),
    );

    await expect(callGdeltFetch()).rejects.toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: {
        reason: 'gdelt_rate_limited',
        retryable: false,
        recovery: { hint: expect.stringMatching(/wait at least 5 seconds/i) },
      },
    });
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it('fails fast on an HTTP-200 HTML rate-limit body — fetch runs exactly once', async () => {
    const htmlResponse = {
      text: async () => '<!DOCTYPE html><html><body>rate limited</body></html>',
    } as unknown as Response;
    mockedFetch.mockResolvedValue(htmlResponse);

    await expect(callGdeltFetch()).rejects.toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: {
        reason: 'gdelt_rate_limited',
        retryable: false,
        recovery: { hint: expect.stringMatching(/wait at least 5 seconds/i) },
      },
    });
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it('still retries an ordinary transient failure the full 4 attempts', async () => {
    vi.useFakeTimers();
    try {
      // A non-McpError (raw network blip) is transient by default — it must NOT be opted out.
      mockedFetch.mockRejectedValue(new Error('transient network blip'));

      const expectation = expect(callGdeltFetch()).rejects.toThrow(/transient network blip/);
      await vi.runAllTimersAsync();
      await expectation;

      expect(mockedFetch).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives an attempt the configured per-request deadline', async () => {
    mockedFetch.mockResolvedValue({ text: async () => '{"ok":true}' } as unknown as Response);

    await callGdeltFetch();

    expect(mockedFetch.mock.calls[0]?.[1]).toBe(REQUEST_TIMEOUT_MS);
  });

  /**
   * The per-attempt deadline alone cannot bound the call: four 60s attempts plus backoff
   * outlast any client's request timeout. `withRetry` carries a total budget of twice the
   * per-request deadline, and each attempt clamps its fetch to what is left of it.
   */
  it('clamps a later attempt to what is left of the call budget, then ends the call', async () => {
    vi.useFakeTimers();
    try {
      mockedFetch.mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 70_000));
        throw fetchTimeout();
      });

      const expectation = expect(callGdeltFetch()).rejects.toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'gdelt_unavailable', retryable: true },
      });
      await vi.runAllTimersAsync();
      await expectation;

      expect(mockedFetch.mock.calls[0]?.[1]).toBe(REQUEST_TIMEOUT_MS);
      const laterDeadline = mockedFetch.mock.calls[1]?.[1] as number;
      expect(laterDeadline).toBeGreaterThan(0);
      expect(laterDeadline).toBeLessThan(REQUEST_TIMEOUT_MS);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The timeout → `gdelt_unavailable` mapping is keyed on the timeout shape. A caller abort
   * reaches the same seam as a `RequestCancelled` carrying `errorSource: 'FetchAborted'`;
   * relabelling it would tell a client to retry a request nobody is waiting for.
   */
  it('leaves a caller-abort RequestCancelled unmapped', async () => {
    mockedFetch.mockRejectedValue(
      requestCancelled('fetch GET https://api.gdeltproject.org/api/v2/doc/doc?… was aborted.', {
        errorSource: 'FetchAborted',
      }),
    );

    const error = (await callGdeltFetch().catch((err: unknown) => err)) as McpError;

    expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(error.data).toMatchObject({ errorSource: 'FetchAborted' });
    expect(error.data?.reason).toBeUndefined();
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });
});

/**
 * Every upstream failure the retry ladder treats as transient ends on the `gdelt_unavailable`
 * contract, whatever shape it took and at the default timeout — not only an exhausted timeout.
 * Here the stubbed `fetchWithTimeout` delegates to the real one and the global `fetch` is
 * stubbed instead, so the framework's own status mapping, network-error wrapping, and abort
 * classification decide each error's code and data, as they do in production.
 */
describe('gdeltFetch failure classification over the real fetchWithTimeout', () => {
  const GDELT_UNAVAILABLE = {
    reason: 'gdelt_unavailable',
    retryable: true,
    recovery: { hint: 'Retry after a short delay; GDELT may be temporarily unavailable.' },
  };

  let upstream: ReturnType<typeof vi.fn<(url: string, init?: RequestInit) => Promise<Response>>>;

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('@cyanheads/mcp-ts-core/utils')>(
      '@cyanheads/mcp-ts-core/utils',
    );
    mockedFetch.mockReset();
    mockedFetch.mockImplementation(actual.fetchWithTimeout);
    upstream = vi.fn(async () => {
      throw new Error('unmocked fetch');
    });
    vi.stubGlobal('fetch', upstream);
    initGdeltPacer(0);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    disposeGdeltPacer();
  });

  /** Start one call; resolves with what it rejected with. */
  function start(ctx = createMockContext()): Promise<McpError> {
    return gdeltFetch(
      BASE_URL,
      new URLSearchParams({ query: 'climate' }),
      ctx,
      'searchArticles',
      'GDELT DOC',
    ).then(
      () => {
        throw new Error('expected gdeltFetch to reject');
      },
      (error: unknown) => error as McpError,
    );
  }

  /** Drive the fake clock through every remaining timer, then read the call's rejection. */
  async function settle(pending = start()): Promise<McpError> {
    await vi.runAllTimersAsync();
    return pending;
  }

  /** An upstream that holds the request open until the attempt's signal aborts it. */
  function hangUntilAborted(): void {
    upstream.mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
  }

  it.each([
    ['an HTML 200 body', 200, '<!DOCTYPE html><html><body>Service Unavailable</body></html>', {}],
    ['an empty 200 body', 200, '', {}],
    ['HTTP 500', 500, 'Internal Server Error', { status: 500, errorSource: 'FetchHttpError' }],
    ['HTTP 502', 502, 'Bad Gateway', { status: 502, errorSource: 'FetchHttpError' }],
    ['HTTP 503', 503, 'Service Unavailable', { status: 503, errorSource: 'FetchHttpError' }],
    ['HTTP 504', 504, 'Gateway Timeout', { status: 504, errorSource: 'FetchHttpError' }],
  ] as const)(
    'ends %s on gdelt_unavailable after the full ladder',
    async (_, status, body, kept) => {
      upstream.mockImplementation(async () => new Response(body, { status }));

      const error = await settle();

      expect(error).toBeInstanceOf(McpError);
      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data).toMatchObject({ ...GDELT_UNAVAILABLE, ...kept, retryAttempts: 4 });
      expect(upstream).toHaveBeenCalledTimes(4);
    },
  );

  it('ends a network error on gdelt_unavailable after the full ladder', async () => {
    upstream.mockImplementation(async () => {
      throw new TypeError('fetch failed');
    });

    const error = await settle();

    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({
      ...GDELT_UNAVAILABLE,
      errorSource: 'FetchNetworkErrorWrapper',
      retryAttempts: 4,
    });
    expect(upstream).toHaveBeenCalledTimes(4);
  });

  it('passes an HTTP 501 through unchanged — it opts out of retry as retryable: false', async () => {
    upstream.mockImplementation(async () => new Response('Not Implemented', { status: 501 }));

    const error = await settle();

    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({ status: 501, retryable: false });
    expect(error.data?.reason).toBeUndefined();
    expect(error.data?.recovery).toBeUndefined();
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('keeps an HTTP 429 on gdelt_rate_limited', async () => {
    upstream.mockImplementation(
      async () => new Response('Please limit requests to one every 5 seconds.', { status: 429 }),
    );

    const error = await settle();

    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.data).toMatchObject({ reason: 'gdelt_rate_limited', retryable: false });
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('keeps a query rejection on invalid_query', async () => {
    upstream.mockImplementation(
      async () => new Response('Your query was too short or too long.', { status: 200 }),
    );

    const error = await settle();

    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data?.reason).toBe('invalid_query');
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('keeps an unparseable body a SerializationError', async () => {
    upstream.mockImplementation(async () => new Response('{"articles": [', { status: 200 }));

    const error = await settle();

    expect(error.code).toBe(JsonRpcErrorCode.SerializationError);
    expect(error.data?.reason).toBeUndefined();
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('keeps a caller abort mid-fetch a RequestCancelled', async () => {
    hangUntilAborted();
    const controller = new AbortController();
    const pending = start(createMockContext({ signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();

    const error = await settle(pending);

    expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(error.data).toMatchObject({ errorSource: 'FetchAborted' });
    expect(error.data?.reason).toBeUndefined();
  });

  it('keeps a caller TimeoutError abort mid-fetch a Timeout', async () => {
    hangUntilAborted();
    const controller = new AbortController();
    const pending = start(createMockContext({ signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(100);
    controller.abort(new DOMException('client deadline', 'TimeoutError'));

    const error = await settle(pending);

    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(error.data).toMatchObject({ errorSource: 'FetchSignalTimeout' });
    expect(error.data?.reason).toBeUndefined();
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  /**
   * An abort during a backoff rethrows the signal's own reason. A reason that happens to be a
   * transient-coded `McpError` must still come back as the caller's, not as advice to retry a
   * request nobody is waiting for.
   */
  it.each([
    ['the default abort reason', undefined],
    [
      'a transient-coded McpError reason',
      new McpError(JsonRpcErrorCode.Timeout, 'caller gave up', { origin: 'caller' }),
    ],
  ])('rethrows %s on an abort mid-backoff', async (_, reason) => {
    upstream.mockImplementation(async () => new Response('Service Unavailable', { status: 503 }));
    const controller = new AbortController();
    const pending = start(createMockContext({ signal: controller.signal }));
    // The first attempt fails at once; the ladder is now sleeping its ~5 s backoff.
    await vi.advanceTimersByTimeAsync(1000);
    expect(upstream).toHaveBeenCalledTimes(1);
    controller.abort(reason);

    const error = await settle(pending);

    expect(error).toBe(controller.signal.reason);
    expect((error as { data?: { reason?: unknown } }).data?.reason).toBeUndefined();
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});
