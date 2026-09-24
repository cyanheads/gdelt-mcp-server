/**
 * @fileoverview Pins the registered tool surface: `src/index.ts` hands `createApp()` exactly
 * the eight live tools, the retired TV trending feature leaves no tool or service path behind,
 * and only the byte-budgeted tools advertise withheldCount.
 * @module tests/tools/tool-surface.test
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { GdeltTvService } from '@/services/gdelt/gdelt-tv-service.js';

vi.mock('@cyanheads/mcp-ts-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core')>()),
  createApp: vi.fn(async () => undefined),
}));

type Registered = { name: string; enrichment?: Record<string, unknown> };

/** The tool list `src/index.ts` registers, captured from its `createApp()` call. */
let registered: Registered[];

beforeAll(async () => {
  await import('@/index.js');
  const options = vi.mocked(createApp).mock.calls[0]?.[0] as { tools: Registered[] };
  registered = options.tools;
});

describe('registered tool surface', () => {
  it('registers exactly the eight live tools', () => {
    expect(registered.map((definition) => definition.name).sort()).toEqual([
      'gdelt_get_coverage_breakdown',
      'gdelt_get_coverage_timeline',
      'gdelt_get_tone_distribution',
      'gdelt_get_tv_clips',
      'gdelt_get_tv_context',
      'gdelt_list_tv_stations',
      'gdelt_search_articles',
      'gdelt_search_tv',
    ]);
  });

  it('keeps no service path for the retired trending-topics request', () => {
    expect('getTvTrending' in GdeltTvService.prototype).toBe(false);
  });

  it('advertises withheldCount on exactly the two byte-budgeted record-list tools', () => {
    const budgeted = registered
      .filter((definition) => 'withheldCount' in (definition.enrichment ?? {}))
      .map((definition) => definition.name)
      .sort();
    expect(budgeted).toEqual(['gdelt_get_tv_clips', 'gdelt_search_articles']);
  });
});
