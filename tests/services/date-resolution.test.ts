/**
 * @fileoverview Tests for inferDateResolution — the pure logic that classifies
 * GDELT date strings as hourly or daily data.
 * @module tests/services/date-resolution.test
 */

import { describe, expect, it } from 'vitest';
import { inferDateResolution } from '@/mcp-server/tools/date-resolution.js';

describe('inferDateResolution', () => {
  it('returns "hour" for ISO datetime strings', () => {
    expect(inferDateResolution(['2024-01-01T00:00:00Z', '2024-01-01T01:00:00Z'])).toBe('hour');
  });

  it('returns "day" for date-only strings', () => {
    expect(inferDateResolution(['2024-01-01', '2024-01-02'])).toBe('day');
  });

  it('returns "day" for a single-element array (insufficient to determine hourly)', () => {
    expect(inferDateResolution(['2024-01-01T00:00:00Z'])).toBe('day');
  });

  it('returns "day" for an empty array', () => {
    expect(inferDateResolution([])).toBe('day');
  });

  it('classifies by the first element only', () => {
    // Mixed array — infer from first element which is hourly
    const mixed = ['2024-01-01T00:00:00Z', '2024-01-02'];
    expect(inferDateResolution(mixed)).toBe('hour');
  });

  it('returns "day" when first element has no T separator', () => {
    expect(inferDateResolution(['20240101', '20240102'])).toBe('day');
  });
});
