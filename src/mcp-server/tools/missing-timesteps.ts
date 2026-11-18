/**
 * @fileoverview The gap check the DOC timeline and breakdown tools run over a whole DOC answer:
 * how many timesteps GDELT left out between the first and last it returned, and the notice
 * sentence naming each missing run.
 * @module mcp-server/tools/missing-timesteps
 */

import { type DocDateResolution, findMissingTimesteps } from '@/services/gdelt/date-resolution.js';

/** How the notice names one timestep at each resolution. */
const STEP_NAME = {
  '15min': '15-minute',
  hour: 'hourly',
  day: 'daily',
} as const satisfies Record<DocDateResolution, string>;

/**
 * The timesteps missing strictly between the first and last of `dates` at `resolution`, and the
 * notice sentence naming every run — one timestep by its date, a longer run by its first and last
 * and how many — or `undefined` when none is missing. DOC answers a timestep without matching
 * coverage with 0, so a missing one is a gap in GDELT's data; the sentence says so. Gaps are
 * counted only in an answer whose own timesteps step at `resolution`.
 */
export function timestepGaps(
  dates: readonly string[],
  resolution: DocDateResolution,
): { missingTimesteps: number; notice: string } | undefined {
  const runs = findMissingTimesteps(dates, resolution);
  if (runs.length === 0) return;
  const missingTimesteps = runs.reduce((total, run) => total + run.count, 0);
  const named = runs
    .map((run) => (run.count === 1 ? run.first : `${run.first}–${run.last} (${run.count})`))
    .join(', ');
  const subject = `${missingTimesteps} ${STEP_NAME[resolution]} ${missingTimesteps === 1 ? 'timestep is' : 'timesteps are'}`;
  return {
    missingTimesteps,
    notice: `${subject} missing between the first and last timestep GDELT returned: ${named}. A missing timestep is a gap in GDELT's data, not zero coverage.`,
  };
}
