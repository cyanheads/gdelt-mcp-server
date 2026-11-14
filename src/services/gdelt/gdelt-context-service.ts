/**
 * @fileoverview Service wrapping the GDELT Context 2.0 API: sentence-level search over the last
 * 72 hours, one matching sentence and the text around it per article. Shares the DOC and TV
 * pacer, response cache, stale serve, and error classification through `gdeltFetch`; the local
 * GKG mirror holds no sentences, so it never stands in here.
 * @module services/gdelt/gdelt-context-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import type { ServerConfig } from '@/config/server-config.js';
import { gdeltFetch } from './gdelt-fetch.js';
import type { RawContextArticle, SentenceMatch } from './types.js';

const CONTEXT_ENDPOINT = '/context/context';

/**
 * Every order the Context API delivers. GDELT documents a relevance default, but measured live
 * every `sort` value other than `DateAsc` — relevance and tone orders included, and no value at
 * all — answers newest first, so the newest-first order is always requested by name.
 */
const SORT_PARAM = { dateDesc: 'DateDesc', dateAsc: 'DateAsc' } as const;

export type ContextSort = keyof typeof SORT_PARAM;

/** The window a Context request covers: a relative timespan, or both boundaries (YYYYMMDDHHMMSS). */
export type ContextRequestWindow =
  | { timespan: string }
  | { startDatetime: string; endDatetime: string };

export type ContextSearchParams = {
  query: string;
  /** Sent on every request: without `maxrecords` the Context API answers no records at all. */
  maxRecords: number;
  sort: ContextSort;
  quotesOnly: boolean;
  window: ContextRequestWindow;
};

export class GdeltContextService {
  private readonly baseUrl: string;

  constructor(_config: AppConfig, _storage: StorageService, serverConfig: ServerConfig) {
    this.baseUrl = serverConfig.baseUrl + CONTEXT_ENDPOINT;
  }

  /** Search sentences (artlist mode), in the order GDELT returns them. */
  async searchSentences(params: ContextSearchParams, ctx: Context): Promise<SentenceMatch[]> {
    const urlParams = new URLSearchParams({
      query: params.query,
      mode: 'artlist',
      format: 'json',
      maxrecords: String(params.maxRecords),
      sort: SORT_PARAM[params.sort],
    });
    if ('timespan' in params.window) {
      urlParams.set('timespan', params.window.timespan);
    } else {
      urlParams.set('startdatetime', params.window.startDatetime);
      urlParams.set('enddatetime', params.window.endDatetime);
    }
    if (params.quotesOnly) urlParams.set('isquote', '1');

    // GDELT answers no match as `{}` or as `{"articles": [ ] }`.
    const raw = await gdeltFetch<{ articles?: RawContextArticle[] }>(
      this.baseUrl,
      urlParams,
      ctx,
      'GdeltContextService.searchSentences',
      'GDELT Context',
    );
    return (raw.articles ?? []).map(normalizeSentenceMatch);
  }
}

/** Text fields stay exactly as sent, surrounding whitespace included. */
function normalizeSentenceMatch(raw: RawContextArticle): SentenceMatch {
  return {
    url: raw.url,
    title: raw.title,
    seendate: raw.seendate,
    domain: raw.domain,
    language: raw.language,
    isquote: raw.isquote === 1,
    sentence: raw.sentence,
    context: raw.context,
    ...(raw.socialimage ? { socialimage: raw.socialimage } : {}),
  };
}

// ─── Init/accessor pattern ────────────────────────────────────────────────────

let _service: GdeltContextService | undefined;

export function initGdeltContextService(
  config: AppConfig,
  storage: StorageService,
  serverConfig: ServerConfig,
): void {
  _service = new GdeltContextService(config, storage, serverConfig);
}

export function getGdeltContextService(): GdeltContextService {
  if (!_service)
    throw new Error(
      'GdeltContextService not initialized — call initGdeltContextService() in setup()',
    );
  return _service;
}
