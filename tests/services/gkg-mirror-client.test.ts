/**
 * @fileoverview `GkgMirrorClient` against a real worker thread (`tests/helpers/gkg-mirror-test-worker.ts`,
 * the production worker over a stub network) on a store on disk: readiness, cancellation, store
 * errors, refresh in the worker, the refresh join, close (with a refresh in flight too), a store
 * open error crossing the thread with its cause, the missing-driver startup error on Node, and one
 * answered query round trip.
 * @module tests/services/gkg-mirror-client.test
 */

import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { SqliteHandle } from '@cyanheads/mcp-ts-core/mirror';
import { logger } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { compileDocQuery } from '@/services/gkg-mirror/doc-query-compiler.js';
import { addGkgSlots } from '@/services/gkg-mirror/gkg-feed.js';
import { GkgMirrorClient } from '@/services/gkg-mirror/gkg-mirror-client.js';
import { createGkgMirror, gkgWindowStart } from '@/services/gkg-mirror/gkg-mirror-store.js';
import type { MirrorRequest } from '@/services/gkg-mirror/types.js';
import { scenarioRoutes, stubFeedTransport } from '../helpers/gkg-feed-fixtures.js';
import {
  type GkgMirrorFixture,
  gkgSlotsBetween,
  openGkgMirrorFixture,
  seedGkgBothFeeds,
} from '../helpers/gkg-mirror-fixture.js';
import { type GkgTestWorkerMode, TEST_WORKER_SLOT } from '../helpers/gkg-mirror-test-worker.js';

const WORKER_URL = new URL('../helpers/gkg-mirror-test-worker.ts', import.meta.url);
const SLOT = TEST_WORKER_SLOT;
const PREVIOUS_SLOT = addGkgSlots(SLOT, -1);

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/**
 * A store at a fresh temp path, with no connection left open on this thread. `ready` runs an
 * init over a stub network whose manifests stop one slot before {@link SLOT}, with every slot of
 * that window already in the ledger: the init completes without fetching a slot file, and a
 * worker refresh then has exactly {@link SLOT} pending in both feeds. `prepare` runs on the open
 * handle before it closes.
 */
async function prepareStore(
  options: { ready: boolean; prepare?: (handle: SqliteHandle) => void } = { ready: false },
): Promise<GkgMirrorFixture> {
  const fixture = await openGkgMirrorFixture();
  onTestFinished(() => fixture.cleanup());
  if (options.ready) {
    seedGkgBothFeeds(
      fixture.handle,
      gkgSlotsBetween(gkgWindowStart(PREVIOUS_SLOT, 1), PREVIOUS_SLOT),
    );
    const init = createGkgMirror({
      path: fixture.path,
      windowDays: 1,
      transport: stubFeedTransport(
        scenarioRoutes({
          manifestSlots: { english: PREVIOUS_SLOT, translation: PREVIOUS_SLOT },
          files: [],
        }),
      ).transport,
      logger: {},
    });
    await init.runSync({ mode: 'init' });
    await init.close();
  }
  options.prepare?.(fixture.handle);
  await fixture.store.close();
  return fixture;
}

/** Spawn the test worker on `path`; `mode` is read by the worker when it spawns. */
async function startClient(path: string, mode?: GkgTestWorkerMode): Promise<GkgMirrorClient> {
  if (mode) vi.stubEnv('GKG_TEST_WORKER_MODE', mode);
  const client = await GkgMirrorClient.start({ path, windowDays: 1 }, WORKER_URL);
  onTestFinished(() => client.close());
  return client;
}

/** An artlist request for `query` over the worker's slot. */
function artlistRequest(query: string): MirrorRequest {
  const compiled = compileDocQuery(query);
  if (!compiled.ok) throw new Error(`Fixture query did not compile: ${compiled.detail}`);
  return {
    kind: 'artlist',
    plan: compiled.plan,
    window: { startDatetime: SLOT, endDatetime: SLOT },
    maxRecords: 10,
    sort: 'dateDesc',
  };
}

const REQUEST = artlistRequest('domainis:index.hu');
const live = () => new AbortController().signal;

/**
 * Bytes in the store's WAL. The last connection's close checkpoints it: SQLite deletes it, while
 * macOS's system SQLite (which bun:sqlite uses there) keeps it, emptied. Absent counts as 0.
 */
function walBytes(path: string): number {
  const wal = `${path}-wal`;
  return existsSync(wal) ? statSync(wal).size : 0;
}

describe('GkgMirrorClient', () => {
  it('answers not_ready from a store no init has completed', async () => {
    const fixture = await prepareStore();
    const client = await startClient(fixture.path);

    await expect(client.execute(REQUEST, live())).resolves.toEqual({
      outcome: 'not_ready',
      detail:
        'The local GKG mirror has not completed an init run; the operator runs `mirror:init` to build it.',
    });
    await expect(client.status()).resolves.toEqual({ ready: false });
  });

  it("rejects a pre-aborted and a mid-flight cancelled query with the caller's own reason, and keeps serving", async () => {
    const fixture = await prepareStore();
    const client = await startClient(fixture.path);

    const before = new AbortController();
    const beforeReason = new Error('caller cancelled before the call');
    before.abort(beforeReason);
    await expect(client.execute(REQUEST, before.signal)).rejects.toBe(beforeReason);

    const during = new AbortController();
    const duringReason = new DOMException('caller cancelled mid-flight', 'AbortError');
    // The request is posted when execute() returns; its reply cannot arrive before this abort.
    const pending = client.execute(REQUEST, during.signal);
    during.abort(duringReason);
    await expect(pending).rejects.toBe(duringReason);

    await expect(client.execute(REQUEST, live())).resolves.toMatchObject({ outcome: 'not_ready' });
  });

  it("rejects a pre-aborted and a mid-flight cancelled status read with the caller's own reason, and keeps serving", async () => {
    const fixture = await prepareStore();
    const client = await startClient(fixture.path);

    const before = new AbortController();
    const beforeReason = new Error('caller cancelled before the status read');
    before.abort(beforeReason);
    await expect(client.status(before.signal)).rejects.toBe(beforeReason);

    const during = new AbortController();
    const duringReason = new DOMException('caller cancelled mid-flight', 'AbortError');
    // The request is posted when status() returns; its reply cannot arrive before this abort.
    const pending = client.status(during.signal);
    during.abort(duringReason);
    await expect(pending).rejects.toBe(duringReason);

    await expect(client.status(live())).resolves.toEqual({ ready: false });
  });

  it('answers store_error when the store throws, logs the cause, and rejects status() with ServiceUnavailable', async () => {
    const fixture = await prepareStore({
      ready: true,
      // The ledger is migration-owned, so reopening the store does not recreate it.
      prepare: (handle) => handle.exec('DROP TABLE gkg_slots'),
    });
    const client = await startClient(fixture.path);
    const errorLog = vi.spyOn(logger, 'error');

    await expect(client.execute(REQUEST, live())).resolves.toEqual({
      outcome: 'store_error',
      detail: 'The local GKG mirror store failed while answering.',
    });
    expect(errorLog).toHaveBeenCalledWith(
      'GKG mirror query failed',
      expect.objectContaining({
        operation: 'gkg-mirror.worker',
        extra: expect.objectContaining({
          kind: 'artlist',
          error: expect.objectContaining({
            message: expect.stringContaining('no such table: gkg_slots'),
          }),
        }),
      }),
    );
    await expect(client.status()).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
  });

  it('runs a refresh in the worker, whose rows are on disk after close', async () => {
    const fixture = await prepareStore({ ready: true });
    const client = await startClient(fixture.path);

    await expect(client.refresh()).resolves.toEqual({
      ran: true,
      result: { pagesFetched: 2, recordsApplied: 4, tombstonesApplied: 0, total: 4 },
    });
    await client.close();

    const handle = await fixture.store.raw();
    expect(
      handle
        .prepare<{ domain: string; date: string }>(
          'SELECT domain, date FROM gkg_articles ORDER BY domain',
        )
        .all(),
    ).toEqual([
      { domain: 'index.hu', date: SLOT },
      { domain: 'insidehalton.com', date: SLOT },
      { domain: 'lifo.gr', date: SLOT },
      { domain: 'zimbabwestar.com', date: SLOT },
    ]);
    expect(
      handle
        .prepare<{ feed: string; rows: number }>(
          'SELECT feed, rows FROM gkg_slots WHERE slot = ? ORDER BY feed',
        )
        .all(SLOT),
    ).toEqual([
      { feed: 'english', rows: 2 },
      { feed: 'translation', rows: 2 },
    ]);
  });

  it('joins a refresh called while one runs, and starts a new run once it settles', async () => {
    const fixture = await prepareStore({ ready: true });
    const client = await startClient(fixture.path);

    const first = client.refresh();
    const second = client.refresh();
    expect(second).toBe(first);
    // A second run in the worker would have rejected with the mirror's Conflict.
    await expect(first).resolves.toMatchObject({ ran: true, result: { pagesFetched: 2 } });

    const third = client.refresh();
    expect(third).not.toBe(first);
    await expect(third).resolves.toMatchObject({ ran: true, result: { pagesFetched: 0 } });
  });

  it('closes the store on close(), checkpointing its WAL, after which a query answers store_error', async () => {
    const fixture = await prepareStore({ ready: true });
    const client = await startClient(fixture.path);
    await client.refresh();
    expect(walBytes(fixture.path)).toBeGreaterThan(0);

    await client.close();
    expect(walBytes(fixture.path)).toBe(0);
    await expect(client.execute(REQUEST, live())).resolves.toEqual({
      outcome: 'store_error',
      detail: 'The local GKG mirror did not answer.',
    });
  });

  it('aborts a refresh in flight on close(), rejecting it as an abort, and still closes the store', async () => {
    const fixture = await prepareStore({ ready: true });
    const client = await startClient(fixture.path, 'hang');

    const refresh = client.refresh();
    const closed = client.close();
    const error = await refresh.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    // The abort crosses the thread as an abort, not as an McpError carrying DOMException's legacy code 20.
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ name: 'AbortError' });
    expect(error).not.toHaveProperty('code');
    await closed;
    expect(walBytes(fixture.path)).toBe(0);
  });

  it('rejects start() on a file that is not a database with the open error and its cause, rebuilt on this thread', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gkg-mirror-client-'));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'notes.db');
    writeFileSync(path, 'Field notes, not a database.\n'.repeat(20));

    const error = await GkgMirrorClient.start({ path, windowDays: 1 }, WORKER_URL).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.DatabaseError,
      message: 'Failed to open mirror store "notes.db".',
    });
    const cause = (error as Error).cause;
    expect(cause).toBeInstanceOf(Error);
    expect(cause).toMatchObject({ code: 'SQLITE_NOTADB', message: 'file is not a database' });
  });

  it.runIf(process.versions.bun === undefined)(
    'rejects start() with ConfigurationError on Node without better-sqlite3',
    async () => {
      const fixture = await prepareStore();
      vi.stubEnv('GKG_TEST_WORKER_MODE', 'no-driver' satisfies GkgTestWorkerMode);

      await expect(
        GkgMirrorClient.start({ path: fixture.path, windowDays: 1 }, WORKER_URL),
      ).rejects.toMatchObject({ code: JsonRpcErrorCode.ConfigurationError });
    },
  );

  it('answers a compiled query through the worker', async () => {
    const fixture = await prepareStore({ ready: true });
    const client = await startClient(fixture.path);
    await client.refresh();

    await expect(client.execute(REQUEST, live())).resolves.toMatchObject({
      outcome: 'answered',
      matched: 1,
      coverage: {
        requestedStart: '2026-11-01T12:00:00Z',
        requestedEnd: '2026-11-01T12:00:00Z',
        missingSlots: 0,
      },
      answer: {
        kind: 'artlist',
        result: {
          totalReturned: 1,
          articles: [
            {
              url: 'https://index.hu/gazdasag/2026/10/30/gajdos-laszlo-zold-orseg-allatvedelem-szabalyszeges-fellepes/',
              domain: 'index.hu',
              seendate: '20261101T120000Z',
            },
          ],
        },
      },
    });
  });
});
