/**
 * @fileoverview `bun run mirror:refresh` — one refresh of the local GKG mirror: fetch the slots
 * published since the last run and expire those that left the window. The HTTP server schedules
 * this itself every 15 minutes; stdio operators run this script from cron instead. While another
 * process syncs the store, the run stops before fetching anything and the script exits 1.
 * @module scripts/gkg-mirror-refresh
 */

import { runMirrorScript } from './_mirror-context.js';

await runMirrorScript('mirror:refresh', async (mirror, signal) => {
  const result = await mirror.runSync({ mode: 'refresh', signal });
  console.log(
    `mirror:refresh complete: ${result.pagesFetched} pages, ${result.recordsApplied} rows applied, ${result.tombstonesApplied} expired, ${result.total} rows stored.`,
  );
  return 0;
});
