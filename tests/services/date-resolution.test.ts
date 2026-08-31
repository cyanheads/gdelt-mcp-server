/**
 * @fileoverview Tests for GDELT timeline date normalization and interval-based
 * resolution inference.
 * @module tests/services/date-resolution.test
 */

import { describe, expect, it } from 'vitest';
import { inferDateResolution, normalizeGdeltDate } from '@/services/gdelt/date-resolution.js';

describe('normalizeGdeltDate', () => {
  it.each([
    ['20240101', '2024-01-01'],
    ['20240101T123456Z', '2024-01-01T12:34:56Z'],
    ['2024-01-01', '2024-01-01'],
    ['2024-01-01T12:34:56Z', '2024-01-01T12:34:56Z'],
  ])('normalizes %s without losing precision', (input, expected) => {
    expect(normalizeGdeltDate(input)).toBe(expected);
  });
});

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

  it('recognizes compact daily timestamps containing T', () => {
    expect(inferDateResolution(['20240101T000000Z', '20240102T000000Z'])).toBe('day');
  });

  it('recognizes hourly timestamps across a day boundary', () => {
    expect(inferDateResolution(['20240101T230000Z', '20240102T000000Z', '20240102T010000Z'])).toBe(
      'hour',
    );
  });

  it('uses the smallest positive interval across unsorted duplicate timestamps', () => {
    expect(
      inferDateResolution([
        '2024-01-03T00:00:00Z',
        '2024-01-01T00:00:00Z',
        '2024-01-01T01:00:00Z',
        '2024-01-01T01:00:00Z',
      ]),
    ).toBe('hour');
  });

  it('represents documented 15-minute DOC points', () => {
    expect(
      inferDateResolution(
        ['2024-01-01T00:00:00Z', '2024-01-01T00:15:00Z', '2024-01-01T00:30:00Z'],
        'doc',
      ),
    ).toBe('15min');
  });

  it.each([
    ['week', ['2024-01-01', '2024-01-08', '2024-01-15']],
    ['month', ['2024-01-01', '2024-02-01', '2024-03-01']],
    ['year', ['2022-01-01', '2023-01-01', '2024-01-01']],
  ] as const)('infers %s TV resolution when metadata is absent', (expected, dates) => {
    expect(inferDateResolution([...dates], 'tv')).toBe(expected);
  });

  it('returns "day" when first element has no T separator', () => {
    expect(inferDateResolution(['20240101', '20240102'])).toBe('day');
  });
});
