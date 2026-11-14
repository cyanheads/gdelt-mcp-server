/**
 * @fileoverview The shared `windowClamp` enrichment: its field schema, its `content[]` trailer
 * line, and the disclosure that writes it.
 * @module tests/tools/window-clamp.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import {
  discloseWindowClamp,
  renderWindowClamp,
  windowClampSchema,
} from '@/mcp-server/tools/window-clamp.js';

describe('windowClampSchema', () => {
  it('accepts both clampable parameters and is optional', () => {
    expect(windowClampSchema.parse(undefined)).toBeUndefined();
    for (const parameter of ['timespan', 'startDatetime'] as const) {
      expect(windowClampSchema.parse({ parameter, requested: 'a', applied: 'b' })).toEqual({
        parameter,
        requested: 'a',
        applied: 'b',
      });
    }
    expect(
      windowClampSchema.safeParse({ parameter: 'endDatetime', requested: 'a', applied: 'b' })
        .success,
    ).toBe(false);
  });
});

describe('renderWindowClamp', () => {
  it('quotes both values as inline text', () => {
    expect(renderWindowClamp({ parameter: 'timespan', requested: '7d', applied: '72h' })).toBe(
      `**Window clamped:** timespan "7d" → "72h" (beyond the API's reach)`,
    );
  });

  it('escapes caller text so it opens no markup', () => {
    expect(
      renderWindowClamp({ parameter: 'timespan', requested: '*7d*\n# x', applied: '72h' }),
    ).toBe(
      String.raw`**Window clamped:** timespan "\*7d\*\\n# x" → "72h" (beyond the API's reach)`,
    );
  });
});

describe('discloseWindowClamp', () => {
  it('writes the clamp as the windowClamp enrichment', () => {
    const ctx = createMockContext();
    const clamp = {
      parameter: 'startDatetime',
      requested: '20261109190753',
      applied: '20261111191253',
    } as const;
    discloseWindowClamp(ctx, clamp);
    expect(getEnrichment(ctx).windowClamp).toEqual(clamp);
  });
});
