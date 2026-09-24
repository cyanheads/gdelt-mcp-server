/**
 * @fileoverview GKG theme lookup: downloads GDELT's theme lookup file on first use, holds the
 * parsed index for the life of the process, and matches query words against theme identifiers.
 * The file lives on data.gdeltproject.org rather than the DOC/TV API host, so its one request
 * does not queue behind the API pacer.
 * @module services/gdelt/gdelt-theme-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import { fetchWithTimeout } from '@cyanheads/mcp-ts-core/utils';
import { GDELT_UNAVAILABLE_DATA } from './gdelt-fetch.js';

/** GDELT's GKG theme lookup — the list the DOC 2.0 documentation links for the `theme:` operator. */
export const GKG_THEMES_URL = 'https://data.gdeltproject.org/api/v2/guides/LOOKUP-GKGTHEMES.TXT';

/** One lookup line: an identifier of `A–Z`, `0–9`, `_`, `-`, a tab, and the count GDELT lists. */
const LOOKUP_LINE = /^([A-Z0-9_-]+)\t(\d{1,15})$/;

/** Shortest word the plural fallback trims, so `gas`, `bus`, and `is` stay whole. */
const PLURAL_TRIM_MIN_LENGTH = 4;

/** A theme identifier and the count the lookup lists for it. */
export type ThemeMatch = { readonly theme: string; readonly count: number };

/**
 * A parsed lookup row. `compact` is the lowercased identifier with its `_`/`-` separators
 * removed, and `starts` holds the offset in `compact` where each separator-delimited token
 * begins — so a word matches a token, or a run of consecutive tokens, exactly when `compact`
 * starts with it at one of those offsets.
 */
type ThemeRow = ThemeMatch & { readonly compact: string; readonly starts: readonly number[] };

/** Matches for a query, and the singular words retried when the query as given matched nothing. */
export type ThemeSearchResult = {
  /** Ranked matches: the exact identifier first, then count descending, then identifier. */
  matches: readonly ThemeMatch[];
  /** Set when the plural fallback ran — the words it retried, whether or not they matched. */
  singularWords?: string[];
};

/**
 * The query's search words: a leading `theme:` dropped, lowercased, split on every run of
 * characters other than `a–z`/`0–9`, deduplicated. Empty when the query has no letter or digit.
 */
export function themeQueryWords(query: string): string[] {
  const words = stripThemePrefix(query)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return [...new Set(words)];
}

export class GdeltThemeService {
  /** The one load in flight or finished. Reset on failure so the next call fetches again. */
  private index: Promise<readonly ThemeRow[]> | undefined;

  constructor(private readonly timeoutMs: number) {}

  /**
   * Match `query` against every theme identifier. A theme matches when each query word is a
   * prefix of one of its tokens or of consecutive tokens joined, or when all the words joined
   * are. When nothing matches, the search retries once with a trailing `s` dropped from each
   * word of four or more characters. The query must have at least one word — callers reject an
   * empty {@link themeQueryWords} first, since no words would match every theme.
   */
  async search(query: string, ctx: Context): Promise<ThemeSearchResult> {
    const rows = await this.load(ctx);
    const words = themeQueryWords(query);
    const exact = stripThemePrefix(query).trim().toUpperCase();
    const matches = rankExactFirst(matchRows(rows, words), exact);
    if (matches.length > 0) return { matches };

    const singularWords = [
      ...new Set(
        words.map((w) =>
          w.length >= PLURAL_TRIM_MIN_LENGTH && w.endsWith('s') ? w.slice(0, -1) : w,
        ),
      ),
    ];
    if (singularWords.join(' ') === words.join(' ')) return { matches };
    return { matches: matchRows(rows, singularWords), singularWords };
  }

  /** The parsed index, loading it on first use. Concurrent first calls share the one load. */
  private load(ctx: Context): Promise<readonly ThemeRow[]> {
    this.index ??= this.fetchIndex(ctx).catch((error: unknown) => {
      this.index = undefined;
      throw error;
    });
    return this.index;
  }

  /**
   * Download and parse the lookup. Every failure — an HTTP error status (a 404 included, which
   * would otherwise read as "no such theme"), a network error, a timeout, or a body that is not
   * `THEME<TAB>count` lines — surfaces as the retryable `gdelt_unavailable`.
   */
  private async fetchIndex(ctx: Context): Promise<readonly ThemeRow[]> {
    const startedAt = Date.now();
    let text: string;
    try {
      const response = await fetchWithTimeout(GKG_THEMES_URL, this.timeoutMs, ctx);
      text = await response.text();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw serviceUnavailable(
        `GDELT's GKG theme lookup could not be downloaded: ${detail}`,
        { ...GDELT_UNAVAILABLE_DATA },
        { cause: error },
      );
    }
    const rows = parseThemeLookup(text);
    ctx.log.info('GKG theme lookup loaded', {
      themes: rows.length,
      durationInMs: Date.now() - startedAt,
    });
    return rows;
  }
}

/** Strip one leading `theme:` (any case, after leading whitespace) — the operator, not a word. */
function stripThemePrefix(query: string): string {
  return query.replace(/^\s*theme:/i, '');
}

/**
 * Parse the lookup into rows ranked by count descending, then identifier. The file arrives
 * sorted by count already; ranking here keeps the order independent of that, and lets every
 * search return matches in rank order by filtering alone.
 */
function parseThemeLookup(text: string): readonly ThemeRow[] {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  if (lines.length === 0) {
    throw serviceUnavailable("GDELT's GKG theme lookup came back empty.", {
      ...GDELT_UNAVAILABLE_DATA,
    });
  }
  const rows = lines.map((line, i): ThemeRow => {
    const match = LOOKUP_LINE.exec(line);
    if (!match) {
      throw serviceUnavailable(
        `GDELT's GKG theme lookup is malformed: line ${i + 1} is not a THEME<TAB>count pair.`,
        { ...GDELT_UNAVAILABLE_DATA },
      );
    }
    const theme = match[1] as string;
    const tokens = theme.toLowerCase().split(/[_-]+/).filter(Boolean);
    const starts: number[] = [];
    let offset = 0;
    for (const token of tokens) {
      starts.push(offset);
      offset += token.length;
    }
    return { theme, count: Number(match[2]), compact: tokens.join(''), starts };
  });
  return rows.sort((a, b) => b.count - a.count || compareIdentifiers(a.theme, b.theme));
}

/** Code-unit order, so ties rank the same on every runtime and locale. */
function compareIdentifiers(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Rows (in rank order) that every word matches, or that all the words joined match. */
function matchRows(rows: readonly ThemeRow[], words: readonly string[]): ThemeRow[] {
  const joined = words.length > 1 ? words.join('') : undefined;
  return rows.filter(
    (row) =>
      words.every((word) => startsAtToken(row, word)) ||
      (joined !== undefined && startsAtToken(row, joined)),
  );
}

function startsAtToken(row: ThemeRow, word: string): boolean {
  return row.starts.some((start) => row.compact.startsWith(word, start));
}

/** Move the match whose identifier equals the query as typed to the front. */
function rankExactFirst(matches: ThemeRow[], exact: string): ThemeRow[] {
  const at = matches.findIndex((row) => row.theme === exact);
  if (at <= 0) return matches;
  return [matches[at] as ThemeRow, ...matches.slice(0, at), ...matches.slice(at + 1)];
}

// ─── Init/accessor pattern ────────────────────────────────────────────────────

let _service: GdeltThemeService | undefined;

export function initGdeltThemeService(timeoutMs: number): void {
  _service = new GdeltThemeService(timeoutMs);
}

export function getGdeltThemeService(): GdeltThemeService {
  if (!_service)
    throw new Error('GdeltThemeService not initialized — call initGdeltThemeService() in setup()');
  return _service;
}
