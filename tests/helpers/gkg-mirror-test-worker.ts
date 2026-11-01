/**
 * @fileoverview Worker entry for `GkgMirrorClient` tests: serves the GKG mirror worker over a stub
 * network whose manifests list {@link TEST_WORKER_SLOT} in both feeds, with that slot's fixture
 * rows. `GKG_TEST_WORKER_MODE` (read when the worker spawns) selects a variant:
 *
 * - `hang`: the slot files never answer, so a refresh stays in flight until it is aborted.
 * - `no-driver` (Node only): `better-sqlite3` does not resolve, as on a Node install without the
 *   optional peer.
 *
 * A test's main thread imports this module only for {@link TEST_WORKER_SLOT} (vitest runs test
 * files in forked processes, so their main thread is a main thread); everything else runs only
 * inside the worker. Bun runs `.ts` and maps `./x.js` to `./x.ts`. Node strips types but does
 * not map, so on Node a resolve hook retries a relative `.js` specifier that fails as `.ts`.
 * @module tests/helpers/gkg-mirror-test-worker
 */

import * as nodeModule from 'node:module';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';

/** The manifest slot the test worker's network lists in both feeds. */
export const TEST_WORKER_SLOT = '20261101120000';

/** Values of `GKG_TEST_WORKER_MODE`; unset serves the slot's fixture rows. */
export type GkgTestWorkerMode = 'hang' | 'no-driver';

if (!isMainThread) {
  const port = parentPort;
  if (!port) throw new Error('gkg-mirror-test-worker runs only as a worker thread.');
  const mode = process.env.GKG_TEST_WORKER_MODE as GkgTestWorkerMode | undefined;

  // Present on Node, absent on Bun.
  if (typeof nodeModule.registerHooks === 'function') {
    nodeModule.registerHooks({
      resolve(specifier, context, nextResolve) {
        if (mode === 'no-driver' && specifier === 'better-sqlite3') {
          throw Object.assign(
            new Error("Cannot find package 'better-sqlite3' (hidden by the test worker)"),
            { code: 'ERR_MODULE_NOT_FOUND' },
          );
        }
        try {
          return nextResolve(specifier, context);
        } catch (error) {
          const relative = specifier.startsWith('./') || specifier.startsWith('../');
          if (!relative || !specifier.endsWith('.js')) throw error;
          return nextResolve(`${specifier.slice(0, -'.js'.length)}.ts`, context);
        }
      },
    });
  }

  const { serveGkgMirrorWorker } = await import(
    '../../src/services/gkg-mirror/gkg-mirror-worker.js'
  );
  const { atSlot, readGkgFixture, scenarioRoutes, stubFeedTransport } = await import(
    './gkg-feed-fixtures.js'
  );

  const slot = TEST_WORKER_SLOT;
  const stub = stubFeedTransport(
    scenarioRoutes({
      manifestSlots: { english: slot, translation: slot },
      files:
        mode === 'hang'
          ? [
              { feed: 'english', slot, response: 'hang' },
              { feed: 'translation', slot, response: 'hang' },
            ]
          : [
              { feed: 'english', slot, tsv: atSlot(readGkgFixture('english-rows.tsv'), slot) },
              {
                feed: 'translation',
                slot,
                tsv: atSlot(readGkgFixture('translation-dup-id-rows.tsv'), slot),
              },
            ],
    }),
  );
  await serveGkgMirrorWorker(port, workerData, stub.transport);
}
