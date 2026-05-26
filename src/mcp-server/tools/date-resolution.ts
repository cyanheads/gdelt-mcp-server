/**
 * @fileoverview Shared date resolution inference for GDELT timeline data.
 * @module mcp-server/tools/date-resolution
 */

/** Infer date resolution from a list of GDELT date strings. */
export function inferDateResolution(dates: string[]): 'hour' | 'day' {
  if (dates.length < 2) return 'day';
  const sample = dates[0] ?? '';
  // GDELT timeline dates include a time component for hourly data
  return sample.includes('T') && sample.length > 10 ? 'hour' : 'day';
}
