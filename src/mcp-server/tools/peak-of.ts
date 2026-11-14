/**
 * @fileoverview The peak a timeline summary reports for a run of points.
 * @module mcp-server/tools/peak-of
 */

/**
 * The point with the largest absolute value — the first such point on a tie, which is the
 * earliest timestep for points in date order — or `undefined` when there are none.
 */
export function peakOf<P extends { date: string; value: number }>(
  points: readonly P[],
): P | undefined {
  return points.reduce<P | undefined>(
    (max, d) => (max === undefined || Math.abs(d.value) > Math.abs(max.value) ? d : max),
    undefined,
  );
}
