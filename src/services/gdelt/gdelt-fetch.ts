/**
 * @fileoverview Shared fetch helper for GDELT API calls. Handles rate-limiting,
 * retries, HTML error detection, and JSON parsing.
 * @module services/gdelt/gdelt-fetch
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { serializationError, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout, type RequestContextLike, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { getRateLimiter } from './rate-limiter.js';

/** Apply timespan or explicit date range to URL params. */
export function applyTimeRange(
  params: URLSearchParams,
  timespan?: string,
  startDatetime?: string,
  endDatetime?: string,
): void {
  if (startDatetime && endDatetime) {
    params.set('startdatetime', startDatetime);
    params.set('enddatetime', endDatetime);
  } else if (timespan) {
    params.set('timespan', timespan);
  }
}

/** Fetch a GDELT endpoint with rate-limiting, retries, and JSON parsing. */
export function gdeltFetch<T>(
  baseUrl: string,
  params: URLSearchParams,
  ctx: Context,
  operation: string,
  apiLabel: string,
): Promise<T> {
  const limiter = getRateLimiter();
  const rctx = ctx as unknown as RequestContextLike;
  return withRetry(
    async () => {
      await limiter.acquire();
      const url = `${baseUrl}?${params.toString()}`;
      ctx.log.debug(`${apiLabel} API request`, { url });
      const response = await fetchWithTimeout(url, 30_000, rctx, { signal: ctx.signal });
      const text = await response.text();
      return parseGdeltJson<T>(text, apiLabel);
    },
    { operation, context: rctx, baseDelayMs: 5100, signal: ctx.signal },
  );
}

function parseGdeltJson<T>(text: string, apiLabel: string): T {
  if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
    throw serviceUnavailable(
      `${apiLabel} API returned HTML — likely rate-limited or unavailable. Retry after 5 seconds.`,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw serializationError(
      `${apiLabel} API returned unparseable response: ${text.slice(0, 200)}`,
    );
  }
}
