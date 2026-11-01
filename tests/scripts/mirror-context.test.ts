/**
 * @fileoverview The mirror lifecycle scripts' shared runner (`scripts/_mirror-context.ts`),
 * driven through `mirror:init` against a real store at a temp path with the feed transport
 * stubbed: an interrupt prints only the stop line and exits 128 + the signal number, while a
 * genuine failure prints `mirror:init failed: …` and exits 1.
 * @module tests/scripts/mirror-context.test
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedTransport } from '@/services/gkg-mirror/gkg-feed.js';
import {
  atSlot,
  DOMAIN_FILE_URL,
  readGkgFixture,
  type StubResponse,
  scenarioRoutes,
  stubFeedTransport,
} from '../helpers/gkg-feed-fixtures.js';

const feed = vi.hoisted(() => ({ transport: undefined as FeedTransport | undefined }));

/** The scripts reach the network through `defaultFeedTransport`; route it to each test's stub. */
vi.mock('@/services/gkg-mirror/gkg-feed.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/gkg-mirror/gkg-feed.js')>();
  const current = (): FeedTransport => {
    if (!feed.transport) throw new Error('test did not install a feed transport');
    return feed.transport;
  };
  return {
    ...actual,
    defaultFeedTransport: {
      fetch: (url, init) => current().fetch(url, init),
      sleep: (ms, signal) => current().sleep(ms, signal),
    } satisfies FeedTransport,
  };
});

/** Newest manifest slot; with a 1-day window the walk starts 95 slots earlier. */
const M = '20261101120000';
const WINDOW_START = '20261031121500';

const stopLine = (signal: string) =>
  `mirror:init: ${signal} received; stopping. The next run resumes from the ledger.`;

let dir: string;
let signalHandlers: Map<string, (signal: NodeJS.Signals) => void>;
let exitCodes: unknown[];
let stderr: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gkg-mirror-script-'));
  vi.stubEnv('GDELT_MIRROR_PATH', join(dir, 'gkg-mirror.db'));
  vi.stubEnv('GDELT_MIRROR_WINDOW_DAYS', '1');

  signalHandlers = new Map();
  exitCodes = [];
  stderr = [];
  const realOnce = process.once.bind(process);
  vi.spyOn(process, 'once').mockImplementation(((
    event: string | symbol,
    listener: (...args: unknown[]) => void,
  ) => {
    if (event === 'SIGINT' || event === 'SIGTERM') {
      signalHandlers.set(event, listener);
      return process;
    }
    return realOnce(event, listener);
  }) as typeof process.once);
  vi.spyOn(process, 'exit').mockImplementation(((code?: unknown) => {
    exitCodes.push(code);
  }) as typeof process.exit);
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    stderr.push(args.join(' '));
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  feed.transport = undefined;
  await rm(dir, { recursive: true, force: true });
});

/**
 * Serve `routes` to the scripts. The returned promise resolves when a `'hang'` route is
 * requested; that request settles only when the run's signal aborts.
 */
function serve(routes: Record<string, StubResponse>): Promise<void> {
  const stub = stubFeedTransport(routes);
  const { promise: reached, resolve } = Promise.withResolvers<void>();
  feed.transport = {
    fetch(url, init) {
      if (routes[url] === 'hang') resolve();
      return stub.transport.fetch(url, init);
    },
    sleep: stub.transport.sleep,
  };
  return reached;
}

/** Run `scripts/gkg-mirror-init.ts` from a fresh module graph (fresh config, fresh handlers). */
function runInit(): Promise<unknown> {
  vi.resetModules();
  return import('../../scripts/gkg-mirror-init.js');
}

function sendSignal(signal: NodeJS.Signals): void {
  const handler = signalHandlers.get(signal);
  if (!handler) throw new Error(`the script registered no ${signal} handler`);
  handler(signal);
}

describe('runMirrorScript (through mirror:init)', () => {
  it('exits 1 with the setup hint when GDELT_MIRROR_PATH is unset', async () => {
    vi.stubEnv('GDELT_MIRROR_PATH', undefined);
    await runInit();

    expect(stderr).toEqual([
      'mirror:init: GDELT_MIRROR_PATH is not set. Set it to the SQLite database file that holds the mirror.',
    ]);
    expect(exitCodes).toEqual([1]);
  });

  it('reports a genuine failure through the logger and a `failed:` line, and exits 1', async () => {
    serve({ [DOMAIN_FILE_URL]: { error: new TypeError('fetch failed') } });
    await runInit();

    const reason = `Request to ${DOMAIN_FILE_URL} failed before a response arrived.`;
    expect(stderr).toEqual([
      expect.stringMatching(
        new RegExp(
          `^\\S+ error Mirror sync failed ${RegExp.escape(JSON.stringify({ mode: 'init', error: reason }))}$`,
        ),
      ),
      `mirror:init failed: ${reason}`,
    ]);
    expect(exitCodes).toEqual([1]);
  });

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)(
    'on %s during its first request, prints only the stop line and exits %i',
    async (signal, code) => {
      const reached = serve({ [DOMAIN_FILE_URL]: 'hang' });
      const run = runInit();
      await reached;
      sendSignal(signal);
      await run;

      expect(stderr).toEqual([stopLine(signal)]);
      expect(exitCodes).toEqual([code]);
    },
  );

  it('on an interrupt after a page committed, keeps the lines logged before it and adds only the stop line', async () => {
    const reached = serve(
      scenarioRoutes({
        manifestSlots: { english: M, translation: M },
        files: [
          {
            feed: 'english',
            slot: WINDOW_START,
            tsv: atSlot(readGkgFixture('english-rows.tsv'), WINDOW_START),
          },
          { feed: 'translation', slot: WINDOW_START, response: 'hang' },
        ],
      }),
    );
    const run = runInit();
    await reached;
    sendSignal('SIGINT');
    await run;

    expect(stderr).toEqual([
      expect.stringMatching(/^\S+ info Loaded the GKG domain-to-country map \{"domains":\d+\}$/),
      expect.stringMatching(
        new RegExp(`^page 1: [1-9]\\d* rows applied, 0 expired, through slot ${WINDOW_START}$`),
      ),
      stopLine('SIGINT'),
    ]);
    expect(exitCodes).toEqual([130]);
  });

  it('ignores a second signal after the first: one stop line, the first signal’s code', async () => {
    const reached = serve({ [DOMAIN_FILE_URL]: 'hang' });
    const run = runInit();
    await reached;
    sendSignal('SIGINT');
    sendSignal('SIGTERM');
    await run;

    expect(stderr).toEqual([stopLine('SIGINT')]);
    expect(exitCodes).toEqual([130]);
  });
});
