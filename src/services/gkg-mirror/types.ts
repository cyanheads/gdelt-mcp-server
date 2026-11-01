/**
 * @fileoverview Contracts between the GKG mirror's query compiler, its worker, and the DOC
 * source router: the compiled query plan, the request a DOC tool call becomes, and the answer
 * or refusal that comes back. Every type here crosses the worker boundary, so all of them are
 * plain structured-clone data.
 * @module services/gkg-mirror/types
 */

import type {
  ArticleSearchResult,
  BreakdownSeries,
  DocBreakdownMode,
  DocSearchParams,
  DocTimelineMode,
  TimelineSeries,
  ToneHistogramBin,
} from '../gdelt/gdelt-doc-service.js';

// ─── Compiled query plan ──────────────────────────────────────────────────────

/**
 * One DOC query element, compiled to a predicate over `gkg_articles`.
 *
 * - `keyword`: a word, or a phrase when `phrase` is true, matched by FTS against the keyword
 *   columns (`title`, `persons`, `organizations`, `locations`).
 * - `theme`: an exact GKG theme ID, matched by FTS against `themes` only.
 * - `domain`: suffix match on the lowercase domain (`un.org` matches `catholicsun.org`).
 * - `domainis`: exact lowercase domain.
 * - `sourcelang`: the stored `language` code (`eng`, `spa`), already resolved from a name.
 * - `sourcecountry`: the stored FIPS code, already resolved from a no-space name.
 * - `tone`: compares `tone`, or `abs(tone)` when `absolute` is true.
 */
export type MirrorPredicate =
  | { kind: 'keyword'; text: string; phrase: boolean }
  | { kind: 'theme'; theme: string }
  | { kind: 'domain'; domain: string }
  | { kind: 'domainis'; domain: string }
  | { kind: 'sourcelang'; language: string }
  | { kind: 'sourcecountry'; fips: string }
  | { kind: 'tone'; absolute: boolean; comparison: '<' | '>'; value: number };

/** A predicate kind, as the operators a plan uses are reported. */
export type MirrorPredicateKind = MirrorPredicate['kind'];

/**
 * One top-level clause; a plan matches a row when every clause does. `anyOf` holds one
 * predicate for a plain element and several for an `(a OR b …)` group. `negated` applies to the
 * whole clause and is set only for a single `-x` element.
 */
export type MirrorClause = {
  anyOf: MirrorPredicate[];
  negated: boolean;
};

/** A DOC query string compiled for the mirror. */
export type MirrorQueryPlan = {
  clauses: MirrorClause[];
  /** Distinct predicate kinds the plan uses, in the order of {@link MirrorPredicate}'s union. */
  kinds: MirrorPredicateKind[];
  /**
   * True when the plan holds no keyword predicate, negated or not: every element selects on a
   * stored GKG field.
   */
  filterOnly: boolean;
};

/**
 * Compile outcome. `operator` names the element the mirror cannot answer as the caller wrote it
 * (`near20:"a b"`, `-imagetag:"fire"`, `foo:bar`, a nested OR group, an unclosed quote), clipped
 * to 120 characters, so the refusal can say what to drop or fix; it is empty when no one element
 * is at fault. `detail` is a caller-facing sentence saying why. `hint`, when present, is the
 * caller-facing sentence naming the change that lets the mirror answer, for a refusal that
 * dropping `operator` would not fix.
 */
export type MirrorCompileResult =
  | { ok: true; plan: MirrorQueryPlan }
  | { ok: false; operator: string; detail: string; hint?: string };

// ─── Requests ─────────────────────────────────────────────────────────────────

/**
 * A requested window, both boundaries inclusive 14-digit UTC (`YYYYMMDDHHMMSS`). Structurally
 * the tools' `GdeltWindow`; a `timespan` is resolved to absolute boundaries before the request
 * is built. Bucket width follows this window's length, not the answered window's.
 */
export type MirrorWindow = {
  startDatetime: string;
  endDatetime: string;
};

type MirrorRequestBase = {
  plan: MirrorQueryPlan;
  window: MirrorWindow;
};

/** One DOC tool call, as the mirror answers it. `kind` names the DOC tool family. */
export type MirrorRequest = MirrorRequestBase &
  (
    | {
        kind: 'artlist';
        /** 1–250. */
        maxRecords: number;
        sort: NonNullable<DocSearchParams['sort']>;
      }
    | { kind: 'timeline'; mode: DocTimelineMode; smoothing?: number }
    | { kind: 'tonechart' }
    | { kind: 'breakdown'; mode: DocBreakdownMode; smoothing?: number }
  );

// ─── Responses ────────────────────────────────────────────────────────────────

/**
 * How much of the requested window the mirror answered. Boundaries are ISO 8601 UTC
 * (`2026-11-01T11:00:00Z`). `missingSlots` counts feed slots inside the answered window that
 * the ledger records as gaps.
 */
export type MirrorCoverage = {
  requestedStart: string;
  requestedEnd: string;
  answeredStart: string;
  answeredEnd: string;
  missingSlots: number;
};

/** The DOC-shaped result, by request kind. */
export type MirrorResult =
  | { kind: 'artlist'; result: ArticleSearchResult }
  | { kind: 'timeline'; result: TimelineSeries[] }
  | { kind: 'tonechart'; result: ToneHistogramBin[] }
  | {
      kind: 'breakdown';
      result: BreakdownSeries[];
      /** Matching rows left out because their domain has no source country (`timelinesourcecountry` only). */
      excludedWithoutCountry?: number;
    };

/**
 * The mirror's answer or refusal.
 *
 * - `answered`: `matched` counts matching rows in the answered window; zero is an answer.
 * - `outside_coverage`: the requested window shares no ingested slot with the mirror.
 * - `not_ready`: no init has completed.
 * - `store_error`: the store threw; the cause goes to logs, `detail` stays generic.
 *
 * `not_compiled` never appears here: the compiler runs on the main thread before a request is
 * built.
 */
export type MirrorResponse =
  | { outcome: 'answered'; answer: MirrorResult; coverage: MirrorCoverage; matched: number }
  | { outcome: 'outside_coverage'; detail: string; oldestSlot?: string; newestSlot?: string }
  | { outcome: 'not_ready'; detail: string }
  | { outcome: 'store_error'; detail: string };

/**
 * Mirror readiness and coverage, read without running a query (DOC-first routing and the
 * mirror-first eligibility check both use it). Slots are 14-digit UTC.
 */
export type MirrorCoverageStatus = {
  ready: boolean;
  /** Oldest slot ingested in both feeds. */
  oldestSlot?: string;
  /** Newest slot ingested in both feeds. */
  newestSlot?: string;
};
