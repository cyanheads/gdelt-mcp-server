/**
 * @fileoverview Shared fixtures for the TV tools' empty-result notices that name selected
 * stations whose monitoring range the window misses: the catalog range, a frozen clock, and the
 * two-surface notice assertion.
 * @module tests/tools/station-range-fixtures
 */

import type { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { expect, onTestFinished, vi } from 'vitest';
import type { StationRanges } from '@/services/gdelt/gdelt-tv-service.js';
import { contentText, literalHtml, renderMarkdown } from './markdown-render.js';

/** CNN's monitoring range as the station catalog gives it. */
export const CNN_RANGE: StationRanges = new Map([
  ['CNN', { stationId: 'CNN', startDate: '2009-07-02', endDate: '2024-10-10', isActive: false }],
]);

/** Pin `Date` to 2026-11-10T12:00:00Z for the running test, so a relative timespan resolves to one window. */
export function freezeClock() {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-10T12:00:00Z'));
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

/** The notice on both surfaces: structuredContent verbatim, content[] as its one blockquote. */
export function expectNotice(result: Awaited<ReturnType<typeof runToolContract>>, notice: string) {
  expect(result.isError).toBeFalsy();
  expect((result.structuredContent as { notice?: string }).notice).toBe(notice);
  expect(renderMarkdown(contentText(result))).toContain(
    `<blockquote>\n<p>${literalHtml(notice)}</p>\n</blockquote>`,
  );
}
