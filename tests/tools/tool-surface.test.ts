/**
 * @fileoverview Pins the registered tool surface: `src/index.ts` hands `createApp()` exactly
 * the ten live tools after setup, the retired TV trending feature leaves no service path,
 * and record-list tools no longer advertise withheldCount.
 * @module tests/tools/tool-surface.test
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { disposeGdeltPacer } from '@/services/gdelt/gdelt-pacer.js';
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
  const options = vi.mocked(createApp).mock.calls[0]?.[0];
  if (!options?.setup) throw new Error('createApp must register setup');
  // Service constructors only read server configuration; the fake core performs no I/O.
  await options.setup({ config: {}, storage: {} } as Parameters<typeof options.setup>[0]);
  registered = options.tools as Registered[];
});

afterAll(() => disposeGdeltPacer());

describe('registered tool surface', () => {
  it('registers exactly the ten live tools', () => {
    expect(registered.map((definition) => definition.name).sort()).toEqual([
      'gdelt_get_coverage_breakdown',
      'gdelt_get_coverage_timeline',
      'gdelt_get_tone_distribution',
      'gdelt_get_tv_breakdown',
      'gdelt_get_tv_clips',
      'gdelt_get_tv_context',
      'gdelt_list_tv_stations',
      'gdelt_search_articles',
      'gdelt_search_themes',
      'gdelt_search_tv',
    ]);
  });

  it('keeps no service path for the retired trending-topics request', () => {
    expect('getTvTrending' in GdeltTvService.prototype).toBe(false);
  });

  it('never advertises withheldCount', () => {
    const withholding = registered
      .filter((definition) => 'withheldCount' in (definition.enrichment ?? {}))
      .map((definition) => definition.name)
      .sort();
    expect(withholding).toEqual([]);
  });
});
