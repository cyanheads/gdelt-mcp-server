/**
 * @fileoverview Test helper for DOC tool calls through the DOC source router: the real DOC
 * service, pacer (no request gap), and response cache with only the global `fetch` stubbed, and a
 * fake GKG mirror honoring the client's contract. The sentences a routed answer's notice carries
 * are written out here as literals, so a tool test asserts them independently of the code that
 * builds them.
 * @module tests/helpers/doc-source-fakes
 */

import { afterEach, beforeEach, vi } from 'vitest';
import {
  type DocMirror,
  disposeDocSourceRouter,
  initDocSourceRouter,
} from '@/services/gdelt/doc-source-router.js';
import { initGdeltDocService } from '@/services/gdelt/gdelt-doc-service.js';
import { disposeGdeltPacer, initGdeltPacer } from '@/services/gdelt/gdelt-pacer.js';
import {
  disposeGdeltResponseCache,
  initGdeltResponseCache,
} from '@/services/gdelt/gdelt-response-cache.js';
import type {
  MirrorCoverage,
  MirrorCoverageStatus,
  MirrorRequest,
  MirrorResponse,
  MirrorResult,
} from '@/services/gkg-mirror/types.js';

/** A routed call's explicit window, inside the slots {@link MIRROR_READY} holds. */
export const ROUTED_WINDOW = {
  startDatetime: '20261031000000',
  endDatetime: '20261101000000',
} as const;

/** A mirror that has completed a sync and holds slots around {@link ROUTED_WINDOW}. */
export const MIRROR_READY: MirrorCoverageStatus = {
  ready: true,
  oldestSlot: '20261025120000',
  newestSlot: '20261101113000',
};

/** A mirror no init has completed. */
export const MIRROR_NOT_READY: MirrorCoverageStatus = { ready: false };

/**
 * An explicit window a second short of the 30 minutes the DOC API accepts (#92), inside the slots
 * {@link MIRROR_READY} holds: never sent to DOC.
 */
export const SHORT_WINDOW = {
  startDatetime: '20261031120000',
  endDatetime: '20261031122959',
} as const;

/** {@link SHORT_WINDOW} answered whole by the mirror, so no coverage is disclosed. */
export const SHORT_WINDOW_COVERAGE: MirrorCoverage = {
  requestedStart: '2026-10-31T12:00:00Z',
  requestedEnd: '2026-10-31T12:29:59Z',
  answeredStart: '2026-10-31T12:00:00Z',
  answeredEnd: '2026-10-31T12:29:59Z',
  missingSlots: 0,
};

/** Why DOC is not asked for {@link SHORT_WINDOW}: the error message without a mirror, and the DOC attempt's detail. */
export const SHORT_WINDOW_FAULT =
  'The window 20261031120000–20261031122959 spans 29 minutes 59 seconds, under the 30 minutes the GDELT DOC API accepts for a startDatetime/endDatetime window.';

/** The recovery hint of a window under the DOC API's minimum, without a mirror. */
export const SHORT_WINDOW_HINT =
  'Set endDatetime at least 30 minutes after startDatetime, or omit both and use a timespan of 15 minutes or more for a window ending now.';

/** The `attempts` trailer of a {@link SHORT_WINDOW} call the mirror answered, with or without a match. */
export function shortWindowAttemptsLines(mirrorOutcome: 'answered' | 'empty'): string {
  return `**Attempts:**\n- doc_api: window_too_short — ${SHORT_WINDOW_FAULT}\n- gkg_mirror: ${mirrorOutcome}`;
}

/** {@link ROUTED_WINDOW} answered whole, with two slots inside it missing. */
export const PARTIAL_COVERAGE: MirrorCoverage = {
  requestedStart: '2026-10-31T00:00:00Z',
  requestedEnd: '2026-11-01T00:00:00Z',
  answeredStart: '2026-10-31T00:00:00Z',
  answeredEnd: '2026-11-01T00:00:00Z',
  missingSlots: 2,
};

/** The trailer line {@link PARTIAL_COVERAGE} renders as. */
export const PARTIAL_COVERAGE_LINE =
  '**Coverage:** the mirror answered 2026-10-31T00:00:00Z – 2026-11-01T00:00:00Z of the requested 2026-10-31T00:00:00Z – 2026-11-01T00:00:00Z; 2 15-minute slots missing inside the answered window.';

/** The message the real fetch path gives a DOC request GDELT answers with HTTP 429. */
export const DOC_429_DETAIL = 'Fetch failed for https://api.gdeltproject.org/…?…. Status: 429';

/** The declared `gdelt_rate_limited` recovery hint. */
export const RATE_LIMIT_HINT =
  'Back off before retrying; five seconds is minimum request spacing, not a recovery guarantee, and rate limiting may persist longer. Honor Retry-After when supplied.';

/** The sentence an empty-result notice adds when the empty answer is DOC's (#77). */
export const OVERLOAD_RETRY_SENTENCE =
  'GDELT also returns an empty answer when it is overloaded, so retry the same call later before treating the result as no coverage.';

/** How a mirror answer to a query holding a keyword or phrase says its figures differ from DOC's. */
export const MIRROR_DIVERGENCE_SENTENCE =
  "Keywords matched article titles and entity names, not article text (translated articles keep their source-language titles), and shares and counts are computed over mirrored articles, so they differ from DOC's.";

/** How a mirror answer to a query with no keyword or phrase says its figures differ from DOC's. */
const MIRROR_FILTER_DIVERGENCE_SENTENCE =
  "Shares and counts are computed over mirrored articles, so they differ from DOC's.";

/** A mirror answer's opening sentence, by what DOC did with the call. */
export const MIRROR_STANDS_IN_FOR = {
  rate_limited:
    "This answer comes from the server's local GKG mirror because GDELT rate-limited the DOC API request.",
  empty:
    "This answer comes from the server's local GKG mirror because the GDELT DOC API returned no results, which GDELT also does under load.",
  window_too_short:
    "This answer comes from the server's local GKG mirror because the window is under the 30 minutes the GDELT DOC API accepts, so DOC was not asked.",
} as const;

/** The sentence a mirror answer with zero matches adds when the query holds a keyword or phrase. */
export const MIRROR_NO_MATCH_SENTENCE =
  'Matching titles and entity names found nothing, which is not evidence that no coverage exists.';

/** The sentence a mirror answer with zero matches adds when the query holds no keyword or phrase. */
const MIRROR_FILTER_NO_MATCH_SENTENCE =
  'The mirror matched nothing, which is not evidence that no coverage exists.';

/** The sentence a mirror answer to a query holding a required keyword clause adds (#95). */
export const MIRROR_THEME_ROUTE_SENTENCE =
  'GKG themes are tagged on translated articles too, so a theme: element in place of the keyword (identifiers from gdelt_search_themes) reaches non-English coverage the keyword misses.';

/**
 * One mirror answer on a DOC 429 per side of the notice's keyword branches, with the mirror's
 * sentences it ends with: a required keyword clause adds the theme sentence, matched or not; a
 * keyword that is only negated keeps the keyword sentences without it; no keyword or phrase reads
 * the plain ones. Which plans hold a required keyword clause is tabled in doc-query-compiler.test.ts;
 * a tool test proves only that its notice carries these.
 */
export const MIRROR_KEYWORD_CASES = [
  {
    holds: 'a required keyword clause',
    query: 'earthquake sourcecountry:japan',
    matched: 2,
    sentences: `${MIRROR_STANDS_IN_FOR.rate_limited} ${MIRROR_DIVERGENCE_SENTENCE} ${MIRROR_THEME_ROUTE_SENTENCE}`,
  },
  {
    holds: 'a required keyword clause',
    query: 'earthquake sourcecountry:japan',
    matched: 0,
    sentences: `${MIRROR_STANDS_IN_FOR.rate_limited} ${MIRROR_DIVERGENCE_SENTENCE} ${MIRROR_NO_MATCH_SENTENCE} ${MIRROR_THEME_ROUTE_SENTENCE}`,
  },
  {
    holds: 'only a negated keyword',
    query: 'theme:NATURAL_DISASTER_EARTHQUAKE -aftershock',
    matched: 2,
    sentences: `${MIRROR_STANDS_IN_FOR.rate_limited} ${MIRROR_DIVERGENCE_SENTENCE}`,
  },
  {
    holds: 'only a negated keyword',
    query: 'theme:NATURAL_DISASTER_EARTHQUAKE -aftershock',
    matched: 0,
    sentences: `${MIRROR_STANDS_IN_FOR.rate_limited} ${MIRROR_DIVERGENCE_SENTENCE} ${MIRROR_NO_MATCH_SENTENCE}`,
  },
  {
    holds: 'no keyword or phrase',
    query: 'theme:NATURAL_DISASTER_EARTHQUAKE sourcecountry:japan',
    matched: 2,
    sentences: `${MIRROR_STANDS_IN_FOR.rate_limited} ${MIRROR_FILTER_DIVERGENCE_SENTENCE}`,
  },
  {
    holds: 'no keyword or phrase',
    query: 'theme:NATURAL_DISASTER_EARTHQUAKE sourcecountry:japan',
    matched: 0,
    sentences: `${MIRROR_STANDS_IN_FOR.rate_limited} ${MIRROR_FILTER_DIVERGENCE_SENTENCE} ${MIRROR_FILTER_NO_MATCH_SENTENCE}`,
  },
] as const;

/**
 * The mirror's sentences a notice ends with on a DOC 429, read from `structuredContent.notice` and
 * from the `content[]` notice line: each surface from the mirror's opening sentence on, which every
 * tool writes last. A surface without that sentence is returned whole.
 */
export function mirrorSentences(result: { structuredContent?: unknown; content: unknown[] }): {
  structuredContent: string | undefined;
  content: string | undefined;
} {
  const from = (text: string | undefined) => {
    const at = text?.indexOf(MIRROR_STANDS_IN_FOR.rate_limited) ?? -1;
    return at === -1 ? text : text?.slice(at);
  };
  const text = result.content.map((block) => (block as { text?: string }).text ?? '').join('');
  const line = text.split('\n').find((l) => l.startsWith('> '));
  return {
    structuredContent: from((result.structuredContent as { notice?: string }).notice),
    content: from(line),
  };
}

/** The trailer lines of `source`. */
export const SOURCE_LINE = {
  doc_api: '**Answer source:** doc_api (the GDELT DOC API)',
  gkg_mirror: "**Answer source:** gkg_mirror (the server's local GKG mirror)",
} as const;

/** The `attempts` trailer of a DOC 429 the mirror answered, with or without a match. */
export function refusedAttemptsLines(mirrorOutcome: 'answered' | 'empty'): string {
  return `**Attempts:**\n- doc_api: rate_limited — ${DOC_429_DETAIL}\n- gkg_mirror: ${mirrorOutcome}`;
}

/** What the stubbed DOC API does with every request: refuse it with HTTP 429, or answer `body`. */
export type DocBehaviour = 'refuse' | { body: unknown };

/**
 * Run each test of the calling suite against the real DOC service, pacer, and response cache,
 * fresh per test so one test's 429 leaves no cooldown behind, and tear them and any attached
 * mirror down after it. Mocks set by an enclosing suite's hooks are restored first, so the real
 * service runs. `answerDoc` returns the stubbed `fetch`, to count the requests DOC was sent.
 */
export function useRoutedDoc(): {
  answerDoc: (behaviour: DocBehaviour) => ReturnType<typeof vi.fn>;
} {
  beforeEach(() => {
    vi.restoreAllMocks();
    initGdeltPacer(0);
    initGdeltResponseCache();
    initGdeltDocService(
      {} as never,
      {} as never,
      {
        baseUrl: 'https://api.gdeltproject.org/api/v2',
        requestDelayMs: 0,
      } as never,
    );
  });

  afterEach(() => {
    disposeDocSourceRouter();
    disposeGdeltPacer();
    disposeGdeltResponseCache();
    vi.unstubAllGlobals();
  });

  return {
    answerDoc(behaviour) {
      const fetch = vi.fn(async () =>
        behaviour === 'refuse'
          ? new Response('Please limit requests to one every 5 seconds.', { status: 429 })
          : new Response(JSON.stringify(behaviour.body), { status: 200 }),
      );
      vi.stubGlobal('fetch', fetch);
      return fetch;
    },
  };
}

/**
 * Stand a fake mirror behind DOC. Like the client, `status()` and `execute()` reject with an
 * aborted signal's reason, untouched.
 */
export function attachMirror(
  respond: (req: MirrorRequest) => MirrorResponse,
  status: MirrorCoverageStatus = MIRROR_READY,
) {
  const mirror = {
    status: vi.fn(async (signal?: AbortSignal) => {
      signal?.throwIfAborted();
      return status;
    }),
    execute: vi.fn(async (req: MirrorRequest, signal: AbortSignal) => {
      signal.throwIfAborted();
      return respond(req);
    }),
  } satisfies DocMirror;
  initDocSourceRouter(() => mirror);
  return mirror;
}

/**
 * A mirror response answering with a copy of `answer`, `matched` rows matching, over `coverage`. A
 * copy, so a test comparing the routed answer with `answer` catches a change made on the way.
 */
export function mirrorAnswers(
  answer: MirrorResult,
  matched: number,
  coverage: MirrorCoverage = PARTIAL_COVERAGE,
): () => MirrorResponse {
  return () => ({ outcome: 'answered', answer: structuredClone(answer), matched, coverage });
}
