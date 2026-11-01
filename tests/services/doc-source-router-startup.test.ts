/**
 * @fileoverview `src/index.ts` wiring of the DOC source router: with `GDELT_MIRROR_PATH` set,
 * setup stands the router behind the mirror client, read on every call, and teardown routes every
 * call to DOC alone again; with it unset, no call consults a mirror. The real router and DOC
 * service run with the global `fetch` stubbed; the mirror client module is mocked.
 * @module tests/services/doc-source-router-startup.test
 */

import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocMirror } from '@/services/gdelt/doc-source-router.js';
import type { MirrorCoverageStatus } from '@/services/gkg-mirror/types.js';

const mocks = vi.hoisted(() => ({
  createApp: vi.fn<(options: AppOptions) => Promise<undefined>>(async () => undefined),
  getGkgMirrorClient: vi.fn<() => DocMirror | undefined>(),
}));

vi.mock('@cyanheads/mcp-ts-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core')>()),
  createApp: mocks.createApp,
}));

vi.mock('@/services/gkg-mirror/gkg-mirror-client.js', () => ({
  initGkgMirrorClient: vi.fn(async () => undefined),
  disposeGkgMirrorClient: vi.fn(async () => undefined),
  getGkgMirrorClient: mocks.getGkgMirrorClient,
}));

type AppOptions = NonNullable<Parameters<typeof import('@cyanheads/mcp-ts-core').createApp>[0]>;
type SetupCore = Parameters<NonNullable<AppOptions['setup']>>[0];

/** Service constructors only read configuration; the fake core performs no I/O. */
const CORE = { config: { mcpTransportType: 'stdio' }, storage: {} } as unknown as SetupCore;

const READY: MirrorCoverageStatus = {
  ready: true,
  oldestSlot: '20261025120000',
  newestSlot: '20261101113000',
};

const SEARCH = {
  query: 'climate',
  startDatetime: '20261031000000',
  endDatetime: '20261101000000',
  maxRecords: 10,
  sort: 'relevance',
} as const;

const ARTICLE = {
  url: 'https://example.com/doc',
  title: 'From DOC',
  seendate: '20261031T120000Z',
  domain: 'example.com',
  language: 'English',
  sourcecountry: 'United States',
};

/**
 * Import `src/index.ts` fresh, run its setup, and return its options with the module instances
 * that setup wired: the router, the pacer, and the response cache.
 */
async function startEntry() {
  vi.resetModules();
  mocks.createApp.mockClear();
  await import('@/index.js');
  const options = mocks.createApp.mock.calls[0]?.[0];
  if (!options?.setup || !options.teardown)
    throw new Error('createApp must register setup and teardown');
  await options.setup(CORE);
  return {
    options,
    router: await import('@/services/gdelt/doc-source-router.js'),
    pacer: await import('@/services/gdelt/gdelt-pacer.js'),
    cache: await import('@/services/gdelt/gdelt-response-cache.js'),
  };
}

function fakeMirror() {
  return {
    status: vi.fn(async () => READY),
    execute: vi.fn(async () => {
      throw new Error('DOC answered; the mirror is never asked');
    }),
  } satisfies DocMirror;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  mocks.getGkgMirrorClient.mockReset();
});

describe('src/index.ts DOC source router wiring', () => {
  it('with GDELT_MIRROR_PATH set, reads the mirror client on every call and stops consulting it on teardown', async () => {
    vi.stubEnv('GDELT_MIRROR_PATH', '/var/lib/gdelt-mirror/gkg.db');
    vi.stubEnv('GDELT_REQUEST_DELAY_MS', '0');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ articles: [ARTICLE] }), { status: 200 })),
    );
    const { options, router, pacer, cache } = await startEntry();
    const mirror = fakeMirror();

    // Setup ran before the client was asked for, so a client that appears later is still seen.
    const beforeClient = createMockContext();
    await router.routeArticleSearch(SEARCH, beforeClient);
    expect(getEnrichment(beforeClient)).toEqual({});

    mocks.getGkgMirrorClient.mockReturnValue(mirror);
    const withClient = createMockContext();
    await router.routeArticleSearch(SEARCH, withClient);
    expect(getEnrichment(withClient)).toEqual({ source: 'doc_api' });
    expect(mirror.status).toHaveBeenCalledOnce();
    expect(mocks.getGkgMirrorClient).toHaveBeenCalledTimes(2);

    // Teardown releases the pacer and cache too; the call after it needs fresh ones.
    await options.teardown?.(CORE);
    pacer.initGdeltPacer(0);
    cache.initGdeltResponseCache();
    try {
      const afterTeardown = createMockContext();
      await router.routeArticleSearch(SEARCH, afterTeardown);
      expect(getEnrichment(afterTeardown)).toEqual({});
      expect(mocks.getGkgMirrorClient).toHaveBeenCalledTimes(2);
      expect(mirror.status).toHaveBeenCalledOnce();
    } finally {
      pacer.disposeGdeltPacer();
      cache.disposeGdeltResponseCache();
    }
  });

  it('with GDELT_MIRROR_PATH unset, never consults a mirror', async () => {
    vi.stubEnv('GDELT_MIRROR_PATH', undefined);
    vi.stubEnv('GDELT_REQUEST_DELAY_MS', '0');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ articles: [ARTICLE] }), { status: 200 })),
    );
    const { options, router } = await startEntry();
    mocks.getGkgMirrorClient.mockReturnValue(fakeMirror());

    try {
      const ctx = createMockContext();
      await router.routeArticleSearch(SEARCH, ctx);
      expect(getEnrichment(ctx)).toEqual({});
      expect(mocks.getGkgMirrorClient).not.toHaveBeenCalled();
    } finally {
      await options.teardown?.(CORE);
    }
  });
});
