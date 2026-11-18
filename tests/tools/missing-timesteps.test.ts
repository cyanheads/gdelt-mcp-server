/**
 * @fileoverview The gap count and notice sentence the DOC timeline and breakdown tools report
 * for a DOC answer that lacks timesteps. Which timesteps are missing is tabled in
 * date-resolution.test.ts; per-tool wiring is in each tool's own suite.
 * @module tests/tools/missing-timesteps.test
 */

import { describe, expect, it } from 'vitest';
import { timestepGaps } from '@/mcp-server/tools/missing-timesteps.js';

const TAIL = "A missing timestep is a gap in GDELT's data, not zero coverage.";

describe('timestepGaps', () => {
  it.each<[string, string[], Parameters<typeof timestepGaps>[1]]>([
    ['no timesteps', [], 'hour'],
    ['one timestep', ['2026-09-01T00:00:00Z'], 'hour'],
    ['contiguous hours', ['2026-09-01T00:00:00Z', '2026-09-01T01:00:00Z'], 'hour'],
    ['timesteps a week apart, read as days', ['2024-01-01', '2024-01-08', '2024-01-15'], 'day'],
  ])('reports nothing for %s', (_label, dates, resolution) => {
    expect(timestepGaps(dates, resolution)).toBeUndefined();
  });

  it.each<[string, string[], Parameters<typeof timestepGaps>[1], number, string]>([
    [
      'one missing hour, in the singular',
      ['2026-09-02T16:00:00Z', '2026-09-02T17:00:00Z', '2026-09-02T19:00:00Z'],
      'hour',
      1,
      `1 hourly timestep is missing between the first and last timestep GDELT returned: 2026-09-02T18:00:00Z. ${TAIL}`,
    ],
    [
      'a run, by its first, last, and length',
      ['2026-09-03T15:00:00Z', '2026-09-03T16:00:00Z', '2026-09-03T22:00:00Z'],
      'hour',
      5,
      `5 hourly timesteps are missing between the first and last timestep GDELT returned: 2026-09-03T17:00:00Z–2026-09-03T21:00:00Z (5). ${TAIL}`,
    ],
    [
      'two runs in date order',
      [
        '2026-09-07T01:15:00Z',
        '2026-09-07T01:00:00Z',
        '2026-09-07T00:00:00Z',
        '2026-09-07T00:30:00Z',
      ],
      '15min',
      2,
      `2 15-minute timesteps are missing between the first and last timestep GDELT returned: 2026-09-07T00:15:00Z, 2026-09-07T00:45:00Z. ${TAIL}`,
    ],
    [
      'missing days, as days',
      ['2024-02-26', '2024-02-27', '2024-03-01'],
      'day',
      2,
      `2 daily timesteps are missing between the first and last timestep GDELT returned: 2024-02-28–2024-02-29 (2). ${TAIL}`,
    ],
  ])('counts and names %s', (_label, dates, resolution, missingTimesteps, notice) => {
    expect(timestepGaps(dates, resolution)).toEqual({ missingTimesteps, notice });
  });
});
