/** Tests for relative-window compatibility and the GDELT retry boundary. */
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveEffectiveWindow } from '@/mcp-server/tools/date-range.js';
import { gdeltSearchArticles } from '@/mcp-server/tools/definitions/search-articles.tool.js';
import {
  applyTimeRange,
  gdeltFetch,
  parseGdeltJson,
  resolveTimespan,
} from '@/services/gdelt/gdelt-fetch.js';
import { disposeGdeltPacer, initGdeltPacer } from '@/services/gdelt/gdelt-pacer.js';
import {
  disposeGdeltResponseCache,
  initGdeltResponseCache,
} from '@/services/gdelt/gdelt-response-cache.js';

afterEach(() => {
  disposeGdeltPacer();
  disposeGdeltResponseCache();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('relative-window compatibility', () => {
  it.each([
    ['3months', '2023-11-15T12:00:00.000Z'],
    ['2years', '2022-02-15T12:00:00.000Z'],
    ['24hours', '2024-02-14T12:00:00.000Z'],
  ])('resolves %s', (value, start) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-02-15T12:00:00Z'));
    expect(resolveTimespan(value)?.start.toISOString()).toBe(start);
  });
  it('keeps the minimum check on known aliases and unknown syntax upstream-owned', () => {
    expect(
      gdeltSearchArticles.input.safeParse({ query: 'climate', timespan: '0days' }).success,
    ).toBe(false);
    expect(
      gdeltSearchArticles.input.safeParse({ query: 'climate', timespan: '15min' }).success,
    ).toBe(true);
    expect(
      gdeltSearchArticles.input.safeParse({ query: 'climate', timespan: '1futureunit' }).success,
    ).toBe(true);
  });
  it.each(['1w', '1week', '1weeks', '7days', '168hours'])(
    'resolves documented week-equivalent %s',
    (value) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-02-15T12:00:00Z'));
      expect(resolveTimespan(value)?.start.toISOString()).toBe('2024-02-08T12:00:00.000Z');
    },
  );
  it.each([
    ['Hourly DATERES not available for >7 day timespans.', /seven|7/],
    ['Invalid query start date, earliest start date is July 2, 2009.', /date|window/],
    [
      'The TIMESPAN is too far in the past, earliest start date is July 2, 2009.',
      /shorter timespan/,
    ],
    [
      'You cannot have multiple standalone non-negative station/show/network/market selectors.',
      /selector/,
    ],
    ['Invalid/Unsupported Country.', /FIPS/],
  ])('tailors recovery for %s', (body, hint) => {
    expect(() => parseGdeltJson(body, 'GDELT TV')).toThrowError(
      expect.objectContaining({
        data: expect.objectContaining({
          reason: 'invalid_query',
          recovery: { hint: expect.stringMatching(hint) },
        }),
      }),
    );
  });
  it('preserves explicit boundaries and existing month/year arithmetic', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-02-15T12:00:00Z'));
    expect(resolveTimespan(' 1M ')?.start.toISOString()).toBe('2024-01-15T12:00:00.000Z');
    expect(resolveTimespan('1y')?.start.toISOString()).toBe('2023-02-15T12:00:00.000Z');
    expect(
      resolveEffectiveWindow({
        timespan: 'garbage',
        startDatetime: '20200101000000',
        endDatetime: '20200201000000',
      }),
    ).toEqual({ startDatetime: '20200101000000', endDatetime: '20200201000000' });
    expect(
      gdeltSearchArticles.input.safeParse({ query: 'climate', timespan: '2futureunit' }).success,
    ).toBe(true);
    const params = new URLSearchParams();
    applyTimeRange(params, '', undefined, undefined);
    expect(params.toString()).toBe('');
  });
});

describe('public rate-limit retryability', () => {
  it.each([
    [429, 'Please limit requests to one every 5 seconds.'],
    [200, 'Please limit requests to one every 5 seconds.'],
    [200, '<!DOCTYPE html><html>rate limited</html>'],
  ])('makes one attempt for status %s and exposes a later retry', async (status, body) => {
    initGdeltPacer(0);
    initGdeltResponseCache();
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(body, { status, headers: { 'retry-after': '12' } }));
    await expect(
      gdeltFetch(
        'https://example.com/doc',
        new URLSearchParams(),
        createMockContext(),
        'probe',
        'GDELT DOC',
      ),
    ).rejects.toMatchObject({
      data: {
        reason: 'gdelt_rate_limited',
        retryable: true,
        ...(status === 429 ? { body, responseBody: body, retryAfter: '12' } : {}),
        recovery: { hint: expect.stringMatching(/back off/i) },
      },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
