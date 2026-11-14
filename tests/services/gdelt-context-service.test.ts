/**
 * @fileoverview Tests for GdeltContextService: the request every call shape sends, and — through
 * the real `gdeltFetch`, pacer, and response cache with only the network stubbed — normalization
 * of recorded Context captures, both empty shapes, and Context rejections.
 * @module tests/services/gdelt-context-service.test
 */

import { readFileSync } from 'node:fs';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { fetchWithTimeout } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ContextSearchParams,
  GdeltContextService,
} from '@/services/gdelt/gdelt-context-service.js';
import { disposeGdeltPacer, initGdeltPacer } from '@/services/gdelt/gdelt-pacer.js';
import {
  disposeGdeltResponseCache,
  initGdeltResponseCache,
} from '@/services/gdelt/gdelt-response-cache.js';

vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return { ...actual, fetchWithTimeout: vi.fn() };
});

const mockedFetch = vi.mocked(fetchWithTimeout);

/** A recorded Context capture: `query=bird flu&timespan=24h&maxrecords=5`, three records. */
const BIRD_FLU = readFileSync(
  new URL('../fixtures/context/bird-flu-24h.json', import.meta.url),
  'utf8',
);

const service = () =>
  new GdeltContextService(
    {} as never,
    {} as never,
    {
      baseUrl: 'https://api.gdeltproject.org/api/v2',
    } as never,
  );

const BASE: ContextSearchParams = {
  query: 'bird flu',
  maxRecords: 25,
  sort: 'dateDesc',
  quotesOnly: false,
  window: { timespan: '72h' },
};

/** The URLs every stubbed network call was made with. */
const sentUrls = () => mockedFetch.mock.calls.map(([url]) => new URL(String(url)));

beforeEach(() => {
  mockedFetch.mockReset();
  mockedFetch.mockRejectedValue(new Error('unmocked fetch'));
  initGdeltPacer(0);
  initGdeltResponseCache();
});

afterEach(() => {
  disposeGdeltPacer();
  disposeGdeltResponseCache();
});

describe('GdeltContextService.searchSentences — the request', () => {
  beforeEach(() => {
    mockedFetch.mockImplementation(() => Promise.resolve(new Response(BIRD_FLU)));
  });

  it('sends the endpoint, mode, format, maxrecords, sort, and timespan on a timespan call', async () => {
    await service().searchSentences(BASE, createMockContext());
    const [url] = sentUrls();
    expect(url?.origin + (url?.pathname ?? '')).toBe(
      'https://api.gdeltproject.org/api/v2/context/context',
    );
    expect(Object.fromEntries(url?.searchParams ?? [])).toEqual({
      query: 'bird flu',
      mode: 'artlist',
      format: 'json',
      maxrecords: '25',
      sort: 'DateDesc',
      timespan: '72h',
    });
  });

  it('sends both boundaries, DateAsc, and isquote=1 on an explicit quotes-only call', async () => {
    await service().searchSentences(
      {
        ...BASE,
        maxRecords: 200,
        sort: 'dateAsc',
        quotesOnly: true,
        window: { startDatetime: '20261112190753', endDatetime: '20261112200753' },
      },
      createMockContext(),
    );
    expect(Object.fromEntries(sentUrls()[0]?.searchParams ?? [])).toEqual({
      query: 'bird flu',
      mode: 'artlist',
      format: 'json',
      maxrecords: '200',
      sort: 'DateAsc',
      startdatetime: '20261112190753',
      enddatetime: '20261112200753',
      isquote: '1',
    });
  });

  it('sends no isquote when quotes are not asked for', async () => {
    await service().searchSentences(BASE, createMockContext());
    expect(sentUrls()[0]?.searchParams.has('isquote')).toBe(false);
  });
});

describe('GdeltContextService.searchSentences — recorded answers', () => {
  it('normalizes a recorded capture in upstream order', async () => {
    mockedFetch.mockResolvedValueOnce(new Response(BIRD_FLU));
    const matches = await service().searchSentences(BASE, createMockContext());
    const raw = (JSON.parse(BIRD_FLU) as { articles: Array<Record<string, unknown>> }).articles;
    expect(matches.map((m) => m.url)).toEqual(raw.map((r) => r.url));
    expect(matches[0]).toEqual({
      url: 'https://streetwiseprofessor.com/2009/04/',
      title: 'Streetwise Professor » 2009 » April',
      seendate: '20261114T154632Z',
      domain: 'streetwiseprofessor.com',
      language: 'ENGLISH',
      isquote: false,
      sentence: raw[0]?.sentence,
      context: raw[0]?.context,
    });
    expect(matches[0]).not.toHaveProperty('socialimage');
    expect(matches[1]?.socialimage).toBe(raw[1]?.socialimage);
  });

  it('reads isquote 1 as true and keeps text fields exactly as sent', async () => {
    const record = {
      url: 'https://example.com/a',
      title: 'Title',
      seendate: '20261114T120000Z',
      socialimage: 'https://example.com/i.jpg',
      domain: 'example.com',
      language: 'ENGLISH',
      isquote: 1,
      sentence: '  "Quoted," he said. ',
      context: ' Before.  "Quoted," he said. After *x* [y](z) ',
    };
    mockedFetch.mockResolvedValueOnce(new Response(JSON.stringify({ articles: [record] })));
    const [match] = await service().searchSentences(BASE, createMockContext());
    expect(match).toEqual({ ...record, isquote: true });
  });

  it.each([
    ['{}', '{}'],
    ['an empty article list', '{"articles": [ ] }'],
  ])('returns no matches for %s and never caches it', async (_shape, body) => {
    mockedFetch.mockImplementation(() => Promise.resolve(new Response(body)));
    const svc = service();
    expect(await svc.searchSentences(BASE, createMockContext())).toEqual([]);
    expect(await svc.searchSentences(BASE, createMockContext())).toEqual([]);
    expect(mockedFetch).toHaveBeenCalledTimes(2);
  });

  it('caches a non-empty answer', async () => {
    mockedFetch.mockImplementation(() => Promise.resolve(new Response(BIRD_FLU)));
    const svc = service();
    await svc.searchSentences(BASE, createMockContext());
    expect(await svc.searchSentences(BASE, createMockContext())).toHaveLength(3);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });
});

/**
 * A caller that gives up mid-fetch is cancelled, never told GDELT is unavailable: its signal
 * reaches the shared fetch, whose attempt aborts. The stub behaves as `fetchWithTimeout` does —
 * `FetchTimeout` at its deadline, `FetchAborted` when its signal aborts — so a call that lost the
 * caller's signal runs out its ladder and ends on `gdelt_unavailable` instead.
 */
describe('GdeltContextService.searchSentences — cancellation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('surfaces a caller abort mid-fetch as RequestCancelled', async () => {
    mockedFetch.mockImplementation(
      (_url, timeoutMs, _ctx, options) =>
        new Promise<Response>((_resolve, reject) => {
          const timer = setTimeout(
            () =>
              reject(
                new McpError(JsonRpcErrorCode.Timeout, 'fetch GET … timed out.', {
                  errorSource: 'FetchTimeout',
                }),
              ),
            timeoutMs,
          );
          options?.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(
                new McpError(JsonRpcErrorCode.RequestCancelled, 'fetch GET … was aborted.', {
                  errorSource: 'FetchAborted',
                }),
              );
            },
            { once: true },
          );
        }),
    );
    const controller = new AbortController();
    const pending = service()
      .searchSentences(BASE, createMockContext({ signal: controller.signal }))
      .then(
        () => {
          throw new Error('expected searchSentences to reject');
        },
        (error: unknown) => error as McpError,
      );
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await vi.runAllTimersAsync();

    const error = await pending;
    expect(error).toBeInstanceOf(McpError);
    expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
    expect(error.data?.reason).toBeUndefined();
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });
});

/** The rejection bodies the live Context API returned, byte for byte. */
describe('GdeltContextService.searchSentences — rejections', () => {
  it.each<[string, string, RegExp]>([
    [
      'a DOC-only operator',
      'One or more of your keywords were too short, too long or too common: (sourcecountry:france)\n',
      /^The Context API refuses the DOC-only operators sourcecountry:, theme:, and tone filters.*gdelt_search_articles/,
    ],
    [
      'a tone filter',
      'One or more of your keywords were too short, too long or too common: (tone<-5)\n',
      /DOC-only operators.*gdelt_search_articles/,
    ],
    [
      'a start older than the reach',
      'Invalid query start date.\n',
      /^The Context API reaches back only 72 hours/,
    ],
    [
      'a source language',
      'Invalid/Unsupported Language.\n',
      /^The Context API returns English-language coverage and refuses sourcelang:/,
    ],
  ])('fails invalid_query with the Context hint for %s', async (_case, body, hint) => {
    mockedFetch.mockResolvedValueOnce(new Response(body));
    await expect(service().searchSentences(BASE, createMockContext())).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      message: `GDELT Context API rejected the query: ${JSON.stringify(body.trim())}`,
      data: { reason: 'invalid_query', recovery: { hint: expect.stringMatching(hint) } },
    });
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });
});
