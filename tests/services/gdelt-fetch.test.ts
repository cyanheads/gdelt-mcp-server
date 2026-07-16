/**
 * @fileoverview Tests for the gdelt-fetch helpers: applyTimeRange, resolveTimespan,
 * formatDateShort, and parseGdeltJson.
 * @module tests/services/gdelt-fetch.test
 */

import { describe, expect, it } from 'vitest';
import {
  applyTimeRange,
  formatDateShort,
  parseGdeltJson,
  resolveTimespan,
} from '@/services/gdelt/gdelt-fetch.js';

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

  /**
   * An unpaired boundary is rejected by every tool handler before the service layer
   * runs (`isUnpairedDateRange` → `ctx.fail('invalid_date_range')`), so these two cases
   * are a backstop, not the caller-facing contract: they pin that a lone boundary is
   * never silently widened into a half-open range against GDELT's default window.
   * The rejection callers actually see lives in tests/tools/input-validation.test.ts.
   */
  it('refuses to build a range from a lone startDatetime', () => {
    const params = new URLSearchParams();
    applyTimeRange(params, undefined, '20240101000000', undefined);
    expect(params.has('startdatetime')).toBe(false);
    expect(params.has('enddatetime')).toBe(false);
  });

  it('refuses to build a range from a lone endDatetime', () => {
    const params = new URLSearchParams();
    applyTimeRange(params, undefined, undefined, '20240131235959');
    expect(params.has('startdatetime')).toBe(false);
    expect(params.has('enddatetime')).toBe(false);
  });

  it('falls back to timespan when a lone boundary accompanies it', () => {
    const params = new URLSearchParams();
    applyTimeRange(params, '7d', '20240101000000', undefined);
    expect(params.get('timespan')).toBe('7d');
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

describe('parseGdeltJson', () => {
  it('parses a well-formed JSON body', () => {
    const parsed = parseGdeltJson<{ articles: Array<{ title: string }> }>(
      '{"articles":[{"title":"Example"}]}',
      'GDELT DOC',
    );
    expect(parsed.articles[0]?.title).toBe('Example');
  });

  describe('upstream trouble — retryable, not the caller’s fault', () => {
    it('maps an HTML body to ServiceUnavailable', () => {
      expect(() =>
        parseGdeltJson('<!DOCTYPE html><html><body>nope</body></html>', 'GDELT DOC'),
      ).toThrow(/returned HTML/);
    });

    it('maps an empty body to ServiceUnavailable', () => {
      expect(() => parseGdeltJson('   ', 'GDELT DOC')).toThrow(/empty response/);
    });
  });

  /**
   * GDELT serves query rejections as HTTP 200 with a bare plain-text sentence, so they
   * reach parseGdeltJson and must be reclassified from SerializationError (server fault)
   * to ValidationError (caller fault). Bodies below are the verbatim strings the live
   * API returns for each trigger.
   */
  describe('query rejections — HTTP 200 plain text', () => {
    const CASES = [
      {
        trigger: 'no station selected (TV clipgallery / wordcloud / timelinevolnorm)',
        body: 'Your query must contain at least one station.',
        apiLabel: 'GDELT TV',
        hint: /gdelt_list_tv_stations/,
      },
      {
        trigger: 'single-character keyword (DOC artlist)',
        body: 'Your query was too short or too long.',
        apiLabel: 'GDELT DOC',
        hint: /too short/i,
      },
      {
        trigger: 'unbalanced parenthesis (DOC artlist)',
        body: 'One or more of your parenthetical clauses had an error in it.',
        apiLabel: 'GDELT DOC',
        hint: /parenthesis/i,
      },
      {
        trigger: 'unquoted special character (DOC artlist)',
        body:
          'One or more of your keywords contained an illegal character. ' +
          'To use a dash in a word, place it in quotes like "f-16".',
        apiLabel: 'GDELT DOC',
        hint: /double quotes/i,
      },
    ] as const;

    for (const { trigger, body, apiLabel, hint } of CASES) {
      it(`classifies "${trigger}" as invalid_query with a tailored hint`, () => {
        expect(() => parseGdeltJson(body, apiLabel)).toThrowError(
          expect.objectContaining({
            data: expect.objectContaining({
              reason: 'invalid_query',
              recovery: expect.objectContaining({ hint: expect.stringMatching(hint) }),
            }),
          }),
        );
      });

      it(`echoes the GDELT rejection text for "${trigger}"`, () => {
        expect(() => parseGdeltJson(body, apiLabel)).toThrow(/rejected the query/);
      });
    }
  });

  /**
   * The marker list must not become a blanket "non-JSON 200 = bad input" rule — a
   * truncated or otherwise broken upstream body is also a non-JSON 200 and would then
   * be misreported to the caller as their fault.
   */
  describe('non-matching non-JSON bodies stay on the SerializationError path', () => {
    const NON_MATCHING = [
      { label: 'a truncated JSON payload', body: '{"articles":[{"title":"Exam' },
      { label: 'an opaque gateway string', body: 'upstream connect error or disconnect/reset' },
      {
        label: 'the rate-limit body (reaches here only if a 429 ever arrives as 200)',
        body: 'Please limit requests to one every 5 seconds.',
      },
    ] as const;

    for (const { label, body } of NON_MATCHING) {
      it(`does not classify ${label} as invalid_query`, () => {
        expect(() => parseGdeltJson(body, 'GDELT DOC')).toThrow(/unparseable response/);
        try {
          parseGdeltJson(body, 'GDELT DOC');
          expect.unreachable('parseGdeltJson should have thrown');
        } catch (err) {
          expect((err as { data?: { reason?: string } }).data?.reason).toBeUndefined();
        }
      });
    }
  });
});
