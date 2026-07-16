/**
 * @fileoverview Shared date-range input constraints for the GDELT tools that accept
 * an explicit startDatetime/endDatetime window — the YYYYMMDDHHMMSS field pattern
 * and the both-or-neither pairing predicate.
 * @module mcp-server/tools/date-range
 */

/**
 * GDELT's datetime wire format: exactly 14 digits, YYYYMMDDHHMMSS, no separators.
 *
 * Applied as a field-level Zod `.regex()` so it serializes into the advertised JSON
 * Schema as `pattern`, letting a caller see the constraint before it calls.
 */
export const GDELT_DATETIME_PATTERN = /^\d{14}$/;

/**
 * True when exactly one of the two boundaries is present.
 *
 * GDELT honors an explicit date range only when both boundaries are set, so a lone
 * boundary is dropped during URL construction and the query silently runs against a
 * different window than the caller asked for.
 *
 * The rule is cross-field, so each tool handler enforces it rather than a Zod
 * object-level refinement: a schema-level rejection is raised before the handler runs,
 * which returns a raw Zod issue dump with no `structuredContent` — dropping the
 * `reason` + `recovery.hint` contract every other error path on these tools carries.
 */
export function isUnpairedDateRange(startDatetime?: string, endDatetime?: string): boolean {
  return Boolean(startDatetime) !== Boolean(endDatetime);
}
