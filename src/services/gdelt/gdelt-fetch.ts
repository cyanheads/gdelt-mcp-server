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

/**
 * Resolve a GDELT timespan string (e.g. "1y", "6m", "7d", "24h", "15min") to an
 * absolute `{ start, end }` date range anchored to now.
 * Returns `undefined` when the string cannot be parsed.
 */
export function resolveTimespan(timespan: string): { start: Date; end: Date } | undefined {
  const match = /^(\d+)(min|h|d|m|y)$/i.exec(timespan.trim());
  if (!match) return;
  const n = parseInt(match[1] as string, 10);
  const unit = (match[2] as string).toLowerCase();
  const end = new Date();
  const start = new Date(end);
  switch (unit) {
    case 'min':
      start.setMinutes(start.getMinutes() - n);
      break;
    case 'h':
      start.setHours(start.getHours() - n);
      break;
    case 'd':
      start.setDate(start.getDate() - n);
      break;
    case 'm':
      start.setMonth(start.getMonth() - n);
      break;
    case 'y':
      start.setFullYear(start.getFullYear() - n);
      break;
  }
  return { start, end };
}

/** Format a Date as YYYY-MM-DD for human-readable display. */
export function formatDateShort(d: Date): string {
  return d.toISOString().slice(0, 10);
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
      await limiter.acquire(ctx.signal);
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
  if (text.trim().length === 0) {
    throw serviceUnavailable(
      `${apiLabel} API returned an empty response — endpoint may be temporarily unavailable.`,
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
