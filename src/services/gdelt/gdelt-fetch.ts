/**
 * @fileoverview Shared fetch helper for GDELT API calls. Handles rate-limiting,
 * retries, HTML error detection, and JSON parsing.
 * @module services/gdelt/gdelt-fetch
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import {
  serializationError,
  serviceUnavailable,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
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

/**
 * Number of leading characters scanned for a rejection marker, and the length of
 * the body excerpt echoed in error messages. GDELT's rejection bodies are single
 * short sentences, so a bounded prefix is enough to classify them.
 */
const BODY_EXCERPT_LIMIT = 200;

/**
 * GDELT query-validation rejections, keyed by a distinctive substring of the body.
 *
 * GDELT serves these as **HTTP 200** with `Content-Type: text/html` despite the body
 * being a bare plain-text sentence, so neither `fetchWithTimeout` (which throws only
 * on non-2xx) nor the `<!DOCTYPE`/`<html` prefix check above catches them — they land
 * in `JSON.parse` and would otherwise surface as a server-fault SerializationError for
 * what is really invalid caller input.
 *
 * Matching is deliberately an enumerated marker list rather than a blanket
 * "non-JSON 200 means bad input" rule: a truncated or genuinely broken upstream body
 * is also a non-JSON 200, and must stay on the SerializationError path instead of
 * being misreported to the caller as their fault. Extend this list as new rejection
 * phrasings are confirmed against the live API.
 */
const GDELT_REJECTIONS: ReadonlyArray<{ marker: string; hint: string }> = [
  {
    marker: 'must contain at least one station',
    hint:
      'The GDELT TV API requires at least one station. Supply the stations parameter, or embed a ' +
      'station: selector in the query — use gdelt_list_tv_stations to find valid station IDs.',
  },
  {
    marker: 'too short or too long',
    hint:
      'GDELT rejected a keyword for its length — single characters are too short. Use a longer, ' +
      'more specific keyword, or quote a multi-word phrase such as "bird flu".',
  },
  {
    marker: 'parenthetical clauses had an error',
    hint:
      'A parenthetical clause is malformed. Balance every opening parenthesis with a closing one, ' +
      'e.g. (flu OR pandemic).',
  },
  {
    marker: 'illegal character',
    hint:
      'A keyword contains a character GDELT reserves. Wrap the term in double quotes to use it ' +
      'literally, e.g. "f-16".',
  },
];

/** Recovery hint for the GDELT rejection matching a non-JSON response body, if any. */
function matchGdeltRejectionHint(text: string): string | undefined {
  const head = text.slice(0, BODY_EXCERPT_LIMIT).toLowerCase();
  return GDELT_REJECTIONS.find((rejection) => head.includes(rejection.marker))?.hint;
}

/**
 * Parse a GDELT response body, classifying the non-JSON bodies GDELT returns for
 * upstream trouble (HTML, empty) and caller-side query rejections (see
 * `GDELT_REJECTIONS`) before falling back to a generic serialization failure.
 *
 * Exported for direct testing — production callers reach it through `gdeltFetch`.
 */
export function parseGdeltJson<T>(text: string, apiLabel: string): T {
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
    const hint = matchGdeltRejectionHint(text);
    if (hint) {
      // ValidationError is outside withRetry's transient set, so this fails fast
      // instead of replaying a query GDELT will reject identically every time.
      throw validationError(
        `${apiLabel} API rejected the query: ${text.trim().slice(0, BODY_EXCERPT_LIMIT)}`,
        { reason: 'invalid_query', recovery: { hint } },
      );
    }
    throw serializationError(
      `${apiLabel} API returned unparseable response: ${text.slice(0, BODY_EXCERPT_LIMIT)}`,
    );
  }
}
