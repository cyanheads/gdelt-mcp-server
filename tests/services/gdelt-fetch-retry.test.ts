/**
 * @fileoverview Retry-boundary behavior of gdeltFetch: rate-limit rejections must fail fast
 * (no replay into GDELT's still-closed window), while ordinary transient failures still retry.
 * Mocks the framework's `fetchWithTimeout` while keeping the real `withRetry`, so these assert
 * the actual retry classification end to end.
 * @module tests/services/gdelt-fetch-retry.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { fetchWithTimeout } from '@cyanheads/mcp-ts-core/utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gdeltFetch } from '@/services/gdelt/gdelt-fetch.js';
import { initRateLimiter } from '@/services/gdelt/rate-limiter.js';

// Keep the real withRetry (the code under test) and stub only the network call.
vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return { ...actual, fetchWithTimeout: vi.fn() };
});

const mockedFetch = vi.mocked(fetchWithTimeout);

const BASE_URL = 'https://api.gdeltproject.org/api/v2/doc/doc';

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
    // No inter-request spacing in unit tests — the limiter is not what's under test here.
    initRateLimiter(0);
  });

  it('fails fast on an HTTP 429 — the underlying fetch runs exactly once, not 4×', async () => {
    // fetchWithTimeout maps a 429 to a transient RateLimited McpError.
    mockedFetch.mockRejectedValue(
      new McpError(JsonRpcErrorCode.RateLimited, 'GDELT returned 429', { status: 429 }),
    );

    await expect(callGdeltFetch()).rejects.toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { retryable: false },
    });
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it('fails fast on an HTTP-200 HTML rate-limit body — fetch runs exactly once', async () => {
    const htmlResponse = {
      text: async () => '<!DOCTYPE html><html><body>rate limited</body></html>',
    } as unknown as Response;
    mockedFetch.mockResolvedValue(htmlResponse);

    await expect(callGdeltFetch()).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { retryable: false },
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
});
