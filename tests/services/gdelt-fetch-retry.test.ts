/**
 * @fileoverview Retry-boundary behavior of gdeltFetch: rate-limit rejections must fail fast
 * (no replay into GDELT's still-closed window), ordinary transient failures still retry, each
 * attempt is bounded by the configured request deadline and the call as a whole by twice it,
 * and an exhausted timeout carries the declared `gdelt_unavailable` contract. Mocks the
 * framework's `fetchWithTimeout` while keeping the real `withRetry`, so these assert the actual
 * retry classification end to end.
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
