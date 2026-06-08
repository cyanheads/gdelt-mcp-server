/**
 * @fileoverview Tests for the gdelt-fetch helpers: applyTimeRange, resolveTimespan,
 * and formatDateShort.
 * @module tests/services/gdelt-fetch.test
 */

import { describe, expect, it } from 'vitest';
import { applyTimeRange, formatDateShort, resolveTimespan } from '@/services/gdelt/gdelt-fetch.js';

describe('applyTimeRange', () => {
  it('sets timespan when only timespan is provided', () => {
    const params = new URLSearchParams();
    applyTimeRange(params, '7d');
    expect(params.get('timespan')).toBe('7d');
    expect(params.has('startdatetime')).toBe(false);
    expect(params.has('enddatetime')).toBe(false);
  });

  it('sets startdatetime and enddatetime when both are provided', () => {
    const params = new URLSearchParams();
    applyTimeRange(params, undefined, '20240101000000', '20240131235959');
    expect(params.get('startdatetime')).toBe('20240101000000');
    expect(params.get('enddatetime')).toBe('20240131235959');
    expect(params.has('timespan')).toBe(false);
  });

  it('prefers explicit date range over timespan when both are supplied', () => {
    const params = new URLSearchParams();
    applyTimeRange(params, '7d', '20240101000000', '20240131235959');
    expect(params.get('startdatetime')).toBe('20240101000000');
    expect(params.get('enddatetime')).toBe('20240131235959');
    expect(params.has('timespan')).toBe(false);
  });

  it('sets nothing when all arguments are omitted', () => {
    const params = new URLSearchParams();
    applyTimeRange(params);
    expect(params.toString()).toBe('');
  });

  it('does not set date range when only startDatetime is provided (missing pair)', () => {
    const params = new URLSearchParams();
    applyTimeRange(params, undefined, '20240101000000', undefined);
    // neither startdatetime nor enddatetime should be set — condition requires both
    expect(params.has('startdatetime')).toBe(false);
    expect(params.has('enddatetime')).toBe(false);
  });

  it('does not set date range when only endDatetime is provided (missing pair)', () => {
    const params = new URLSearchParams();
    applyTimeRange(params, undefined, undefined, '20240131235959');
    expect(params.has('startdatetime')).toBe(false);
    expect(params.has('enddatetime')).toBe(false);
  });
});

describe('resolveTimespan', () => {
  it('resolves minute span', () => {
    const before = Date.now();
    const result = resolveTimespan('15min');
    const after = Date.now();
    expect(result).not.toBeUndefined();
    // end should be approximately now
    expect(result!.end.getTime()).toBeGreaterThanOrEqual(before);
    expect(result!.end.getTime()).toBeLessThanOrEqual(after + 10);
    // start should be ~15 minutes ago
    const diffMs = result!.end.getTime() - result!.start.getTime();
    expect(diffMs).toBeGreaterThanOrEqual(15 * 60 * 1000 - 100);
    expect(diffMs).toBeLessThanOrEqual(15 * 60 * 1000 + 100);
  });

  it('resolves hour span', () => {
    const result = resolveTimespan('24h');
    expect(result).not.toBeUndefined();
    const diffMs = result!.end.getTime() - result!.start.getTime();
    const expected = 24 * 60 * 60 * 1000;
    expect(diffMs).toBeGreaterThanOrEqual(expected - 100);
    expect(diffMs).toBeLessThanOrEqual(expected + 100);
  });

  it('resolves day span', () => {
    const result = resolveTimespan('7d');
    expect(result).not.toBeUndefined();
    const diffMs = result!.end.getTime() - result!.start.getTime();
    const expected = 7 * 24 * 60 * 60 * 1000;
    expect(diffMs).toBeGreaterThanOrEqual(expected - 100);
    expect(diffMs).toBeLessThanOrEqual(expected + 100);
  });

  it('resolves month span (approximate)', () => {
    const result = resolveTimespan('1m');
    expect(result).not.toBeUndefined();
    // 1 month is ~28–31 days; just check range is roughly right
    const diffDays = (result!.end.getTime() - result!.start.getTime()) / (24 * 60 * 60 * 1000);
    expect(diffDays).toBeGreaterThanOrEqual(27);
    expect(diffDays).toBeLessThanOrEqual(32);
  });

  it('resolves year span (approximate)', () => {
    const result = resolveTimespan('1y');
    expect(result).not.toBeUndefined();
    const diffDays = (result!.end.getTime() - result!.start.getTime()) / (24 * 60 * 60 * 1000);
    expect(diffDays).toBeGreaterThanOrEqual(364);
    expect(diffDays).toBeLessThanOrEqual(367);
  });

  it('returns undefined for unrecognised format', () => {
    expect(resolveTimespan('invalid')).toBeUndefined();
    expect(resolveTimespan('1week')).toBeUndefined();
    expect(resolveTimespan('')).toBeUndefined();
  });
});

describe('formatDateShort', () => {
  it('formats a Date as YYYY-MM-DD', () => {
    const d = new Date('2024-10-15T12:30:00Z');
    expect(formatDateShort(d)).toBe('2024-10-15');
  });
});
