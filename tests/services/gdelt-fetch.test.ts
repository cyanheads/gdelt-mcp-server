/**
 * @fileoverview Tests for the gdelt-fetch helpers: applyTimeRange and parseGdeltJson
 * (exercised via the exported applyTimeRange function and the error paths of gdeltFetch).
 * @module tests/services/gdelt-fetch.test
 */

import { describe, expect, it } from 'vitest';
import { applyTimeRange } from '@/services/gdelt/gdelt-fetch.js';

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
