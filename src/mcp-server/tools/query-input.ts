/**
 * @fileoverview The `query` input of the query tools: the non-blank schema the DOC and Context tools
 * declare, and the query each of the nine sends for the one it was given. A blank query goes
 * upstream as `query=+`, which GDELT answers with a rejection or a refusal only after the request
 * has waited its turn, so the schema refuses it before any request, and the advertised JSON Schema
 * carries the rule as a `pattern`. OR outside parentheses, which GDELT rejects just as late, is
 * grouped where the query has one reading and refused where it has not.
 * @module mcp-server/tools/query-input
 */

import { z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';
import { groupBareOr } from '@/services/gdelt/query-grammar.js';
import { quoteText } from './markdown-escape.js';

/** Matches any string holding a non-whitespace character; emitted as JSON Schema `pattern: "\\S"`. */
const NON_BLANK_PATTERN = /\S/;

/**
 * A `query` field refusing an empty or whitespace-only value at the input schema. A value with
 * any non-space character passes unchanged, surrounding whitespace included.
 */
export function queryInputSchema(description: string) {
  return z
    .string()
    .regex(NON_BLANK_PATTERN, 'query must contain at least one non-whitespace character.')
    .describe(description);
}

/** The `effectiveQuery` enrichment field each query tool declares. */
export const effectiveQuerySchema = z
  .string()
  .describe(
    'The query the call ran, for use in follow-up calls: the query given or, when it only joins terms with OR outside parentheses, those terms as one group.',
  );

/** The sentence each query tool's `notice` description carries for {@link EffectiveQuery}'s notice. */
export const GROUPED_QUERY_NOTE =
  "When the query's terms were joined by OR outside parentheses, the grouped query that ran.";

/** The query a call runs: the one given, or its terms as one OR group and the notice saying so. */
type EffectiveQuery = { query: string; notice?: string };

/**
 * The query to send for the one a caller gave. GDELT accepts OR only inside parentheses, so a query
 * that is nothing but terms joined by OR is sent as one group; any other query with OR outside
 * parentheses is refused before it costs a request.
 * @throws McpError `ValidationError` with reason `invalid_query`.
 */
export function resolveEffectiveQuery(query: string): EffectiveQuery {
  const grouping = groupBareOr(query);
  switch (grouping.kind) {
    case 'none':
      return { query };
    case 'grouped':
      return {
        query: grouping.query,
        notice: `GDELT accepts OR, in any case, only inside parentheses, so this query ran as ${quoteText(grouping.query)}.`,
      };
    case 'ambiguous':
      throw validationError(
        'GDELT accepts OR only between terms inside parentheses, and this query has an OR outside them with no single reading.',
        {
          reason: 'invalid_query',
          recovery: {
            hint: 'Wrap terms joined by OR in parentheses, e.g. (climate OR energy), and leave every other element outside them, e.g. (climate OR energy) policy. GDELT reads or in any case as OR: to search for text holding the word, quote it, e.g. "life or death".',
          },
        },
      );
    default:
      return grouping satisfies never;
  }
}
