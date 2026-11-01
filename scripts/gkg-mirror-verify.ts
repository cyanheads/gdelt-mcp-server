/**
 * @fileoverview `bun run mirror:verify` — report the local GKG mirror's SQLite integrity check,
 * sync status, row count, and each feed's covered slots with the gaps among them. Exits 1 when
 * the integrity check fails.
 * @module scripts/gkg-mirror-verify
 */

import { inspectGkgMirror } from '@/services/gkg-mirror/gkg-mirror-store.js';
import { runMirrorScript } from './_mirror-context.js';

await runMirrorScript('mirror:verify', async (mirror) => {
  const report = await inspectGkgMirror(mirror);
  const { status } = report;
  const lines = [
    `Integrity: ${report.integrity.ok ? 'ok' : `FAILED\n  ${report.integrity.results.join('\n  ')}`}`,
    `Sync: ${status.status}${status.ready ? ' (ready)' : ' (not ready: no init has completed)'}${status.completedAt ? `, last completed ${status.completedAt}` : ''}${status.error ? `, last error: ${status.error}` : ''}`,
    `Rows: ${report.rows} · domain-to-country entries: ${report.domains}`,
  ];
  for (const [feed, coverage] of Object.entries(report.feeds)) {
    const range = coverage.oldest ? `${coverage.oldest} → ${coverage.newest}` : 'no slots';
    lines.push(
      `${feed}: ${coverage.ingested} slots ingested, ${coverage.gaps.length} gaps, ${range}`,
    );
    if (coverage.gaps.length > 0) lines.push(`  gaps: ${coverage.gaps.join(', ')}`);
  }
  console.log(lines.join('\n'));
  return report.integrity.ok ? 0 : 1;
});
