/**
 * @fileoverview Where a DOC tool's answer came from. The `source`, `attempts`, and `coverage`
 * enrichment fields every DOC tool declares, which the DOC source router writes while a local GKG
 * mirror stands behind the DOC API; their `content[]` trailer lines; and the notice sentences an
 * answer from the mirror, or an empty answer from DOC, carries.
 * @module mcp-server/tools/source-provenance
 */

import { z } from '@cyanheads/mcp-ts-core';
import {
  DOC_ATTEMPT_OUTCOMES,
  DOC_SOURCES,
  type DocAttempt,
  type DocCoverage,
  type DocSource,
  type DocStoodInFor,
  type MirrorStandIn,
} from '@/services/gdelt/types.js';
import { escapeMarkdown } from './markdown-escape.js';
import { renderStaleResponse, staleResponseSchema } from './stale-response.js';

/** The `source` enrichment field each DOC tool declares. */
export const sourceSchema = z
  .enum(DOC_SOURCES)
  .optional()
  .describe(
    "Where this answer came from: doc_api, the GDELT DOC API, or gkg_mirror, the server's local mirror of GDELT's Global Knowledge Graph, which answers when the DOC API refuses the request or returns nothing. Present on every answer while the server runs a mirror; absent otherwise.",
  );

/** The `attempts` enrichment field each DOC tool declares. */
export const attemptsSchema = z
  .array(
    z
      .object({
        source: z.enum(DOC_SOURCES).describe('The source tried.'),
        outcome: z
          .enum(DOC_ATTEMPT_OUTCOMES)
          .describe(
            'What the source did: answered, empty (answered with no matches), rate_limited, or unavailable; or why the mirror could not answer: not_ready (no completed sync), not_compiled (the query or its timespan is in a form the mirror cannot evaluate), outside_coverage (the window lies outside the days it holds), store_error.',
          ),
        detail: z
          .string()
          .optional()
          .describe("Why, when the outcome has a reason: DOC's failure message or the mirror's."),
      })
      .describe("One source's outcome for this call."),
  )
  .optional()
  .describe(
    'Each source tried for this call, in order. Present only when the DOC API did not answer with data and the mirror was consulted.',
  );

/** The `coverage` enrichment field each DOC tool declares. */
export const coverageSchema = z
  .object({
    requestedStart: z.string().describe('Start of the requested window, ISO 8601 UTC.'),
    requestedEnd: z.string().describe('End of the requested window, ISO 8601 UTC.'),
    answeredStart: z.string().describe('Start of the window the mirror answered, ISO 8601 UTC.'),
    answeredEnd: z.string().describe('End of the window the mirror answered, ISO 8601 UTC.'),
    missingSlots: z
      .number()
      .describe(
        '15-minute GKG slots inside the answered window that the mirror holds no data for.',
      ),
  })
  .optional()
  .describe(
    'Present only when the mirror answered less than the requested window. Every count, share, and article in this response comes from answeredStart through answeredEnd; nothing outside it, or in a missing slot, was counted.',
  ) satisfies z.ZodType<DocCoverage | undefined>;

const SOURCE_NAMES: Record<DocSource, string> = {
  doc_api: 'the GDELT DOC API',
  gkg_mirror: "the server's local GKG mirror",
};

/**
 * The `source` line of the `content[]` trailer. Labelled apart from an article row's
 * `**Source:**` (its domain), so the provenance line never reads as an article field.
 */
export function renderSource(source: DocSource): string {
  return `**Answer source:** ${source} (${SOURCE_NAMES[source]})`;
}

/** The `attempts` lines of the `content[]` trailer, one list item per source tried. */
export function renderAttempts(attempts: DocAttempt[]): string {
  return [
    '**Attempts:**',
    ...attempts.map(
      (a) => `- ${a.source}: ${a.outcome}${a.detail ? ` — ${escapeMarkdown(a.detail)}` : ''}`,
    ),
  ].join('\n');
}

/** The `coverage` line of the `content[]` trailer. */
export function renderCoverage(coverage: DocCoverage): string {
  const slots = coverage.missingSlots === 1 ? 'slot' : 'slots';
  return `**Coverage:** the mirror answered ${coverage.answeredStart} – ${coverage.answeredEnd} of the requested ${coverage.requestedStart} – ${coverage.requestedEnd}; ${coverage.missingSlots} 15-minute ${slots} missing inside the answered window.`;
}

/** The enrichment fields every DOC tool declares beside its own: stale-serve and provenance. */
export const docProvenanceEnrichment = {
  staleResponse: staleResponseSchema,
  source: sourceSchema,
  attempts: attemptsSchema,
  coverage: coverageSchema,
};

/** The `enrichmentTrailer` renderers for {@link docProvenanceEnrichment}. */
export const docProvenanceTrailer = {
  staleResponse: { render: renderStaleResponse },
  source: { render: renderSource },
  attempts: { render: renderAttempts },
  coverage: { render: renderCoverage },
};

/**
 * The sentence an empty-result notice adds when the empty answer is DOC's: GDELT also answers
 * `{}` while it sheds load, so an empty answer alone is not evidence of no coverage.
 */
export const DOC_EMPTY_RETRY_NOTE =
  'GDELT also returns an empty answer when it is overloaded, so retry the same call later before treating the result as no coverage.';

const STOOD_IN_FOR: Record<DocStoodInFor, string> = {
  rate_limited: 'GDELT rate-limited the DOC API request',
  unavailable: 'the GDELT DOC API did not answer with data',
  empty: 'the GDELT DOC API returned no results, which GDELT also does under load',
};

/** How a mirror answer differs from DOC's, joined into the notice of every mirror answer. */
const MIRROR_DIVERGENCE =
  "Keywords matched article titles and entity names, not article text (translated articles keep their source-language titles), and shares and counts are computed over mirrored articles, so they differ from DOC's.";

/** The notice sentences of an answer the local GKG mirror gave in DOC's place. */
export function mirrorAnswerNotice({
  standsInFor,
  matched,
  excludedWithoutCountry,
}: MirrorStandIn): string {
  const sentences = [
    `This answer comes from the server's local GKG mirror because ${STOOD_IN_FOR[standsInFor]}.`,
    MIRROR_DIVERGENCE,
  ];
  if (matched === 0) {
    sentences.push(
      'Matching titles and entity names found nothing, which is not evidence that no coverage exists.',
    );
  }
  if (excludedWithoutCountry) {
    const one = excludedWithoutCountry === 1;
    sentences.push(
      `${excludedWithoutCountry} matching ${one ? 'article' : 'articles'} from outlets with no known source country ${one ? 'was' : 'were'} left out of the country series.`,
    );
  }
  return sentences.join(' ');
}
