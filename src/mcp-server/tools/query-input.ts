/**
 * @fileoverview The `query` input the DOC and Context search tools declare: a string holding at
 * least one non-space character. A blank query goes upstream as `query=+`, which GDELT answers with a
 * rejection or a refusal only after the request has waited its turn, so the schema refuses it
 * before any request, and the advertised JSON Schema carries the rule as a `pattern`.
 * @module mcp-server/tools/query-input
 */

import { z } from '@cyanheads/mcp-ts-core';

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
