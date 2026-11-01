/**
 * @fileoverview `bun run mirror:init` — build the local GKG mirror: load the domain-to-country
 * map, then download every slot of both feeds inside `GDELT_MIRROR_WINDOW_DAYS` that the slot
 * ledger does not hold yet, 2 s apart. Resumable: an interrupted run continues from the ledger.
 * Runs out-of-band; the server never starts an init.
 * @module scripts/gkg-mirror-init
 */

import { runMirrorScript } from './_mirror-context.js';

await runMirrorScript('mirror:init', async (mirror, signal) => {
  const result = await mirror.runSync({
    mode: 'init',
    signal,
    onProgress: (p) =>
      console.error(
        `page ${p.pages}: ${p.records} rows applied, ${p.tombstones} expired, through slot ${p.checkpoint ?? '-'}`,
      ),
  });
  console.log(
    `mirror:init complete: ${result.pagesFetched} pages, ${result.recordsApplied} rows applied, ${result.tombstonesApplied} expired, ${result.total} rows stored.`,
  );
  return 0;
});
