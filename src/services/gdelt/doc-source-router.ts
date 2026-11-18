/**
 * @fileoverview Routes the four DOC tool calls — article search, timeline, tone distribution, and
 * breakdown — between the GDELT DOC API and the server's local GKG mirror. With no mirror attached,
 * every call goes to DOC exactly as the DOC service makes it and nothing is added to the answer.
 * With one, DOC answers first, and the mirror answers in its place when DOC refuses the request
 * (`gdelt_rate_limited`, `gdelt_unavailable`) or answers empty; every answer then carries `source`,
 * and `attempts` and `coverage` when the mirror was consulted.
 *
 * An explicit window shorter than DOC accepts is decided before DOC is touched: it is never sent,
 * paced, or looked up in the response cache. The mirror answers it when it can, with `attempts`
 * opening `window_too_short`; otherwise the call fails `invalid_date_range`.
 *
 * Before DOC is asked, the call is checked against the mirror: the query compiles, the mirror has
 * completed a sync, and the requested window overlaps the slots it holds. Only then is DOC held to
 * its fallback budget (`hasFallback`), so a refusal leaves the mirror time to answer inside the
 * client's timeout. A call the mirror cannot answer waits on DOC exactly as it would without one.
 * @module services/gdelt/doc-source-router
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { McpError, validationError } from '@cyanheads/mcp-ts-core/errors';
import { logger, requestContextService } from '@cyanheads/mcp-ts-core/utils';
import {
  articleSearchTimespan,
  DOC_SHORT_WINDOW_HINT,
  describeShortDocWindow,
  resolveEffectiveWindow,
} from '@/mcp-server/tools/date-range.js';
import { quoteText } from '@/mcp-server/tools/markdown-escape.js';
import { compileDocQuery, requiresKeyword } from '../gkg-mirror/doc-query-compiler.js';
import type { GkgMirrorClient } from '../gkg-mirror/gkg-mirror-client.js';
import type {
  MirrorCoverageStatus,
  MirrorQueryPlan,
  MirrorRequest,
  MirrorResponse,
  MirrorResult,
  MirrorWindow,
} from '../gkg-mirror/types.js';
import {
  type ArticleSearchResult,
  type BreakdownSeries,
  type DocBreakdownParams,
  type DocFetchOptions,
  type DocSearchParams,
  type DocSeriesAnswer,
  type DocTimelineParams,
  type DocToneParams,
  getGdeltDocService,
  type TimelineSeries,
  type ToneHistogramBin,
} from './gdelt-doc-service.js';
import { gdeltRefusalReason } from './gdelt-fetch.js';
import type { DocAttempt, DocCoverage, DocStoodInFor, MirrorStandIn } from './types.js';

/**
 * Latest instant a mirror answer is waited for, counted from the start of the routed call. DOC is
 * held to `GDELT_FALLBACK_BUDGET_MS` (45 s) when the mirror stands behind it, and the mirror gets
 * what remains before this, so the call settles inside the 60 seconds MCP clients commonly allow.
 */
const MIRROR_ANSWER_DEADLINE_MS = 55_000;

/** DOC's window for a call that sets neither a timespan nor dates. */
const DOC_DEFAULT_TIMESPAN = '3months';

/** What the router needs of the mirror client. */
export type DocMirror = Pick<GkgMirrorClient, 'status' | 'execute'>;

/** A routed DOC call's answer, and — when the mirror gave it — the facts its notice discloses. */
export type DocRouted<T> = { result: T; standIn?: MirrorStandIn };

let mirrorHandle: (() => DocMirror | undefined) | undefined;

/**
 * Stand the local GKG mirror behind DOC. `mirror` is read on every call, so a client that has been
 * disposed stops being consulted. Wired in `setup()` when `GDELT_MIRROR_PATH` is set.
 */
export function initDocSourceRouter(mirror: () => DocMirror | undefined): void {
  mirrorHandle = mirror;
}

/** Route every call to DOC alone again. */
export function disposeDocSourceRouter(): void {
  mirrorHandle = undefined;
}

// ─── The four DOC calls ───────────────────────────────────────────────────────

/**
 * Search articles (artlist). The tool always supplies `maxRecords` and `sort`. DOC is sent the
 * caller's `timespan`; the mirror is asked for the window artlist searches, which a longer
 * timespan does not widen past three months.
 */
export function routeArticleSearch(
  params: DocSearchParams & Required<Pick<DocSearchParams, 'maxRecords' | 'sort'>>,
  ctx: Context,
): Promise<DocRouted<ArticleSearchResult>> {
  const searched = params.timespan
    ? { ...params, timespan: articleSearchTimespan(params.timespan) }
    : params;
  return route(ctx, searched, {
    doc: (...options) => getGdeltDocService().searchArticles(params, ctx, ...options),
    isEmpty: (result) => result.articles.length === 0,
    mirrorRequest: (plan, window) => ({
      kind: 'artlist',
      plan,
      window,
      maxRecords: params.maxRecords,
      sort: params.sort,
    }),
    fromMirror: (answer) => {
      if (answer.kind !== 'artlist') throw mismatchedAnswer('artlist', answer);
      return { result: answer.result };
    },
  });
}

/**
 * Fetch a coverage or tone timeline. Only a DOC answer carries a `reportedResolution`; the
 * mirror's carries its series alone.
 */
export function routeTimeline(
  params: DocTimelineParams,
  ctx: Context,
): Promise<DocRouted<DocSeriesAnswer<TimelineSeries>>> {
  return route(ctx, params, {
    doc: (...options) => getGdeltDocService().getTimeline(params, ctx, ...options),
    isEmpty: ({ series }) => series.every((s) => s.data.length === 0),
    mirrorRequest: (plan, window) => ({
      kind: 'timeline',
      plan,
      window,
      mode: params.mode,
      ...(params.smoothing != null && { smoothing: params.smoothing }),
    }),
    fromMirror: (answer) => {
      if (answer.kind !== 'timeline') throw mismatchedAnswer('timeline', answer);
      return { result: { series: answer.result } };
    },
  });
}

/** Fetch the tone histogram. */
export function routeToneDistribution(
  params: DocToneParams,
  ctx: Context,
): Promise<DocRouted<ToneHistogramBin[]>> {
  return route(ctx, params, {
    doc: (...options) => getGdeltDocService().getToneDistribution(params, ctx, ...options),
    isEmpty: (bins) => bins.length === 0,
    mirrorRequest: (plan, window) => ({ kind: 'tonechart', plan, window }),
    fromMirror: (answer) => {
      if (answer.kind !== 'tonechart') throw mismatchedAnswer('tonechart', answer);
      return { result: answer.result };
    },
  });
}

/**
 * Fetch a language or source-country breakdown. Only a DOC answer carries a `reportedResolution`;
 * the mirror's carries its series alone.
 */
export function routeBreakdown(
  params: DocBreakdownParams,
  ctx: Context,
): Promise<DocRouted<DocSeriesAnswer<BreakdownSeries>>> {
  return route(ctx, params, {
    doc: (...options) => getGdeltDocService().getBreakdown(params, ctx, ...options),
    isEmpty: ({ series }) => series.every((s) => s.data.length === 0),
    mirrorRequest: (plan, window) => ({
      kind: 'breakdown',
      plan,
      window,
      mode: params.mode,
      ...(params.smoothing != null && { smoothing: params.smoothing }),
    }),
    fromMirror: (answer) => {
      if (answer.kind !== 'breakdown') throw mismatchedAnswer('breakdown', answer);
      return {
        result: { series: answer.result },
        ...(answer.excludedWithoutCountry !== undefined && {
          excludedWithoutCountry: answer.excludedWithoutCountry,
        }),
      };
    },
  });
}

// ─── Routing ──────────────────────────────────────────────────────────────────

/** The query and window fields every DOC call carries. */
type DocQueryParams = Pick<DocToneParams, 'query' | 'timespan' | 'startDatetime' | 'endDatetime'>;

/** One DOC call, as the router asks each source for it. */
type DocCall<T> = {
  /** DOC's answer; the fetch options are passed only while the mirror stands behind DOC. */
  doc: (...options: [] | [DocFetchOptions]) => Promise<T>;
  isEmpty: (result: T) => boolean;
  mirrorRequest: (plan: MirrorQueryPlan, window: MirrorWindow) => MirrorRequest;
  fromMirror: (answer: MirrorResult) => { result: T; excludedWithoutCountry?: number };
};

/** DOC's attempt on a call the mirror may answer in its place. */
type DocStandInAttempt = DocAttempt & { outcome: DocStoodInFor };

/** Why the mirror did not answer, and the change that would let it. */
type MirrorRefusal = {
  outcome: 'not_ready' | 'not_compiled' | 'outside_coverage' | 'store_error';
  detail: string;
  hint: string;
};

/** Whether the mirror can answer a call: the request it would answer, or why it cannot. */
type MirrorReadiness =
  | { ready: true; request: MirrorRequest }
  | { ready: false; refusal: MirrorRefusal };

/** The mirror's answer and the request it answered, or why it did not answer. */
type MirrorConsulted =
  | {
      answered: true;
      request: MirrorRequest;
      response: Extract<MirrorResponse, { outcome: 'answered' }>;
    }
  | { answered: false; refusal: MirrorRefusal };

async function route<T>(
  ctx: Context,
  params: DocQueryParams,
  call: DocCall<T>,
): Promise<DocRouted<T>> {
  const mirror = mirrorHandle?.();
  const tooShort = describeShortDocWindow(params.startDatetime, params.endDatetime);
  if (tooShort) return routeShortWindow(ctx, mirror, params, call, tooShort);
  if (!mirror) return { result: await call.doc() };

  const startedAt = Date.now();
  const readiness = await mirrorReadiness(mirror, params, call, ctx);
  let answer: T;
  try {
    answer = await (readiness.ready ? call.doc({ hasFallback: true }) : call.doc());
  } catch (error) {
    if (ctx.signal.aborted || !(error instanceof McpError)) throw error;
    const docAttempt = docRefusal(error);
    if (!docAttempt) throw error;
    const consulted = await consultMirror(mirror, readiness, startedAt, ctx);
    if (consulted.answered) return answerFromMirror(ctx, call, docAttempt, consulted);
    throw refusalError(error, [docAttempt, refusalAttempt(consulted.refusal)], consulted.refusal);
  }

  if (!call.isEmpty(answer)) {
    ctx.enrich({ source: 'doc_api' });
    return { result: answer };
  }
  const docAttempt: DocStandInAttempt = { source: 'doc_api', outcome: 'empty' };
  const consulted = await consultMirror(mirror, readiness, startedAt, ctx);
  if (consulted.answered && consulted.response.matched > 0) {
    return answerFromMirror(ctx, call, docAttempt, consulted);
  }
  ctx.enrich({
    source: 'doc_api',
    attempts: [
      docAttempt,
      consulted.answered
        ? { source: 'gkg_mirror', outcome: 'empty' }
        : refusalAttempt(consulted.refusal),
    ],
  });
  return { result: answer };
}

/**
 * A window DOC refuses as too short (`fault` says why), never sent to DOC: the mirror's answer,
 * a match or none, with the whole answer deadline to give it; otherwise `invalid_date_range`,
 * carrying why the mirror could not answer when one is attached.
 */
async function routeShortWindow<T>(
  ctx: Context,
  mirror: DocMirror | undefined,
  params: DocQueryParams,
  call: DocCall<T>,
  fault: string,
): Promise<DocRouted<T>> {
  if (!mirror) throw shortWindowError(fault);
  const startedAt = Date.now();
  const readiness = await mirrorReadiness(mirror, params, call, ctx);
  const consulted = await consultMirror(mirror, readiness, startedAt, ctx);
  const docAttempt: DocStandInAttempt = {
    source: 'doc_api',
    outcome: 'window_too_short',
    detail: fault,
  };
  if (consulted.answered) return answerFromMirror(ctx, call, docAttempt, consulted);
  throw shortWindowError(fault, [docAttempt, refusalAttempt(consulted.refusal)], consulted.refusal);
}

/**
 * Check the call against the mirror before DOC is asked: the query compiles, the window resolves,
 * the mirror has completed a sync, and the window overlaps the slots it holds.
 */
async function mirrorReadiness<T>(
  mirror: DocMirror,
  params: DocQueryParams,
  call: DocCall<T>,
  ctx: Context,
): Promise<MirrorReadiness> {
  const cannot = (refusal: MirrorRefusal): MirrorReadiness => ({ ready: false, refusal });
  const compiled = compileDocQuery(params.query);
  if (!compiled.ok) {
    const operator = compiled.operator ? quoteText(compiled.operator) : undefined;
    return cannot({
      outcome: 'not_compiled',
      detail: operator ? `It cannot evaluate ${operator}: ${compiled.detail}` : compiled.detail,
      hint:
        compiled.hint ??
        (operator
          ? `Without ${operator} in the query, the local GKG mirror could answer while GDELT refuses.`
          : 'A query with a word, phrase, or GKG-field operator lets the local GKG mirror answer while GDELT refuses.'),
    });
  }
  const window = requestedWindow(params);
  if (!window) {
    return cannot({
      outcome: 'not_compiled',
      detail: `It cannot resolve timespan ${quoteText(params.timespan ?? '')} to a window.`,
      hint: 'A timespan such as "24h" or "7d", or an explicit startDatetime/endDatetime window, lets the local GKG mirror answer while GDELT refuses.',
    });
  }

  let status: MirrorCoverageStatus;
  try {
    status = await mirror.status(ctx.signal);
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    logger.error(
      'GKG mirror did not report its status',
      error instanceof Error ? error : new Error(String(error)),
      requestContextService.createRequestContext({
        operation: 'doc-source-router.status',
        additionalContext: { requestId: ctx.requestId },
      }),
    );
    return cannot(storeError('The local GKG mirror did not report its status.'));
  }
  // A caller who left as the status arrived goes no further.
  ctx.signal.throwIfAborted();
  if (!status.ready) {
    return cannot({
      outcome: 'not_ready',
      detail: 'The local GKG mirror has not completed an init run.',
      hint: NOT_READY_HINT,
    });
  }
  const { oldestSlot, newestSlot } = status;
  if (!oldestSlot || !newestSlot) {
    return cannot({
      outcome: 'outside_coverage',
      detail: 'The local GKG mirror holds no slot yet.',
      hint: NOT_READY_HINT,
    });
  }
  if (window.startDatetime > newestSlot || window.endDatetime < oldestSlot) {
    return cannot({
      outcome: 'outside_coverage',
      detail: `The requested window ${window.startDatetime}–${window.endDatetime} lies outside the slots the local GKG mirror holds, ${oldestSlot} to ${newestSlot}.`,
      hint: coverageHint(oldestSlot, newestSlot),
    });
  }
  return { ready: true, request: call.mirrorRequest(compiled.plan, window) };
}

/**
 * Ask the mirror, waiting no later than {@link MIRROR_ANSWER_DEADLINE_MS} after the call started.
 * The caller's cancellation rejects untouched; the deadline is a `store_error`.
 */
async function consultMirror(
  mirror: DocMirror,
  readiness: MirrorReadiness,
  startedAt: number,
  ctx: Context,
): Promise<MirrorConsulted> {
  if (!readiness.ready) return { answered: false, refusal: readiness.refusal };
  const remainingMs = startedAt + MIRROR_ANSWER_DEADLINE_MS - Date.now();
  if (remainingMs <= 0) return { answered: false, refusal: deadlinePassed(ctx) };

  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new Error('The mirror answer deadline passed.')),
    remainingMs,
  );
  let response: MirrorResponse;
  try {
    response = await mirror.execute(
      readiness.request,
      AbortSignal.any([ctx.signal, deadline.signal]),
    );
  } catch (error) {
    if (ctx.signal.aborted || !deadline.signal.aborted) throw error;
    return { answered: false, refusal: deadlinePassed(ctx) };
  } finally {
    clearTimeout(timer);
  }

  switch (response.outcome) {
    case 'answered':
      return { answered: true, request: readiness.request, response };
    case 'not_ready':
      return {
        answered: false,
        refusal: { outcome: 'not_ready', detail: response.detail, hint: NOT_READY_HINT },
      };
    case 'outside_coverage':
      return {
        answered: false,
        refusal: {
          outcome: 'outside_coverage',
          detail: response.detail,
          hint:
            response.oldestSlot && response.newestSlot
              ? coverageHint(response.oldestSlot, response.newestSlot)
              : NOT_READY_HINT,
        },
      };
    case 'store_error':
      return { answered: false, refusal: storeError(response.detail) };
    default: {
      const unknown: never = response;
      throw new TypeError(`Unknown mirror outcome: ${JSON.stringify(unknown)}`);
    }
  }
}

/** Return the mirror's answer in DOC's place and disclose it. */
function answerFromMirror<T>(
  ctx: Context,
  call: DocCall<T>,
  docAttempt: DocStandInAttempt,
  {
    request: { plan },
    response: { answer, coverage, matched },
  }: Extract<MirrorConsulted, { answered: true }>,
): DocRouted<T> {
  const { result, excludedWithoutCountry } = call.fromMirror(answer);
  ctx.enrich({
    source: 'gkg_mirror',
    attempts: [docAttempt, { source: 'gkg_mirror', outcome: matched > 0 ? 'answered' : 'empty' }],
    ...(isPartial(coverage) && { coverage }),
  });
  ctx.log.info('DOC call answered from the local GKG mirror', {
    standsInFor: docAttempt.outcome,
    matched,
  });
  return {
    result,
    standIn: {
      standsInFor: docAttempt.outcome,
      matched,
      keywords: plan.filterOnly ? 'none' : requiresKeyword(plan) ? 'required' : 'unrequired',
      ...(excludedWithoutCountry !== undefined && { excludedWithoutCountry }),
    },
  };
}

// ─── Outcomes ─────────────────────────────────────────────────────────────────

const NOT_READY_HINT =
  "The local GKG mirror answers once the server operator's first sync (mirror:init) has completed.";
const STORE_ERROR_HINT = 'The local GKG mirror is unavailable for now.';

const DOC_REFUSALS = {
  gdelt_rate_limited: 'rate_limited',
  gdelt_unavailable: 'unavailable',
} as const satisfies Record<string, DocStoodInFor>;

/** DOC's attempt, when `error` is a refusal the mirror may answer in place of. */
function docRefusal(error: McpError): DocStandInAttempt | undefined {
  const reason = gdeltRefusalReason(error);
  return reason && { source: 'doc_api', outcome: DOC_REFUSALS[reason], detail: error.message };
}

function storeError(detail: string): MirrorRefusal {
  return { outcome: 'store_error', detail, hint: STORE_ERROR_HINT };
}

function deadlinePassed(ctx: Context): MirrorRefusal {
  const seconds = MIRROR_ANSWER_DEADLINE_MS / 1000;
  ctx.log.warning('GKG mirror did not answer before the call deadline', {
    deadlineSeconds: seconds,
  });
  return storeError(`The local GKG mirror did not answer within ${seconds}s of the call's start.`);
}

function refusalAttempt(refusal: MirrorRefusal): DocAttempt {
  return { source: 'gkg_mirror', outcome: refusal.outcome, detail: refusal.detail };
}

/** A hint naming the window the mirror can answer, in the tools' 14-digit datetime format. */
function coverageHint(oldestSlot: string, newestSlot: string): string {
  return `A startDatetime/endDatetime window inside ${oldestSlot}–${newestSlot} lets the local GKG mirror answer while GDELT refuses.`;
}

/**
 * DOC's refusal, carrying both attempts: its code, reason, and retryability stay DOC's, the message
 * adds why the mirror could not answer, and the hint adds what would let it.
 */
function refusalError(error: McpError, attempts: DocAttempt[], refusal: MirrorRefusal): McpError {
  const docHint = recoveryHint(error.data?.recovery);
  return new McpError(
    error.code,
    `${error.message} The local GKG mirror could not answer instead: ${refusal.detail}`,
    {
      ...error.data,
      attempts,
      recovery: { hint: docHint ? `${docHint} ${refusal.hint}` : refusal.hint },
    },
    { cause: error },
  );
}

/**
 * The `invalid_date_range` failure of a window too short for DOC: with a mirror attached, both
 * attempts, the message adding why the mirror could not answer, and the hint what would let it.
 */
function shortWindowError(
  fault: string,
  attempts?: DocAttempt[],
  refusal?: MirrorRefusal,
): McpError {
  return validationError(
    refusal ? `${fault} The local GKG mirror could not answer instead: ${refusal.detail}` : fault,
    {
      reason: 'invalid_date_range',
      ...(attempts && { attempts }),
      recovery: {
        hint: refusal ? `${DOC_SHORT_WINDOW_HINT} ${refusal.hint}` : DOC_SHORT_WINDOW_HINT,
      },
    },
  );
}

function recoveryHint(recovery: unknown): string | undefined {
  return typeof recovery === 'object' &&
    recovery !== null &&
    'hint' in recovery &&
    typeof recovery.hint === 'string'
    ? recovery.hint
    : undefined;
}

/** True when the mirror answered less than the requested window. */
function isPartial(coverage: DocCoverage): boolean {
  return (
    coverage.missingSlots > 0 ||
    coverage.answeredStart !== coverage.requestedStart ||
    coverage.answeredEnd !== coverage.requestedEnd
  );
}

/**
 * The window DOC answers, in `applyTimeRange`'s precedence: explicit boundaries, then a non-blank
 * timespan resolved against now, then DOC's three-month default. `undefined` for a timespan this
 * server cannot resolve.
 */
function requestedWindow({
  timespan,
  startDatetime,
  endDatetime,
}: DocQueryParams): MirrorWindow | undefined {
  if (startDatetime && endDatetime) return { startDatetime, endDatetime };
  return resolveEffectiveWindow({ timespan: timespan?.trim() ? timespan : DOC_DEFAULT_TIMESPAN });
}

function mismatchedAnswer(expected: MirrorResult['kind'], answer: MirrorResult): Error {
  return new Error(`The GKG mirror answered a ${answer.kind} request for a ${expected} call.`);
}
