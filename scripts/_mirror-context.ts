/**
 * @fileoverview Shared setup for the GKG mirror lifecycle scripts (`mirror:init`,
 * `mirror:refresh`, `mirror:verify`): reads `GDELT_MIRROR_PATH` and `GDELT_MIRROR_WINDOW_DAYS`,
 * opens the mirror on the real network with a stderr logger, turns SIGINT/SIGTERM into a
 * cancelled run, and closes the store before exiting.
 *
 * Imports through `@/`, which resolves to `src/` in a checkout and to `dist/` in the Docker
 * image (the image writes a `tsconfig.json` mapping it). An npm install has neither mapping, so
 * build the mirror from a checkout or the image.
 * @module scripts/_mirror-context
 */

import { constants } from 'node:os';
import type { Mirror, MirrorLogger } from '@cyanheads/mcp-ts-core/mirror';
import { getServerConfig } from '@/config/server-config.js';
import { defaultFeedTransport } from '@/services/gkg-mirror/gkg-feed.js';
import { createGkgMirror } from '@/services/gkg-mirror/gkg-mirror-store.js';

/** A script's work; resolves to the process exit code. */
export type MirrorTask = (mirror: Mirror, signal: AbortSignal) => Promise<number>;

/**
 * Info and above, one line each, to stderr; stdout carries only the script's result. Silent once
 * `signal` aborts, so an interrupted run's teardown (the runner's `Mirror sync failed`) stays off
 * stderr.
 */
function stderrLogger(signal: AbortSignal): MirrorLogger {
  return Object.fromEntries(
    (['info', 'notice', 'warning', 'error'] as const).map((level) => [
      level,
      (message: string, meta?: Readonly<Record<string, unknown>>) => {
        if (signal.aborted) return;
        console.error(
          `${new Date().toISOString()} ${level} ${message}${meta ? ` ${JSON.stringify(meta)}` : ''}`,
        );
      },
    ]),
  );
}

/**
 * Open the mirror, run `task`, close the store, and exit with the task's code: 1 on a throw, or
 * 128 + the signal number (130 for SIGINT, 143 for SIGTERM) when the first SIGINT/SIGTERM stopped
 * the run. Interrupting and rerunning is the resume path, so an interrupt is never reported as a
 * failure.
 */
export async function runMirrorScript(name: string, task: MirrorTask): Promise<never> {
  const abort = new AbortController();
  let interrupted: NodeJS.Signals | undefined;
  const onSignal = (signal: NodeJS.Signals) => {
    if (interrupted) return;
    interrupted = signal;
    console.error(`${name}: ${signal} received; stopping. The next run resumes from the ledger.`);
    abort.abort(new Error(`${name} interrupted by ${signal}`));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  let mirror: Mirror | undefined;
  let code = 1;
  try {
    const config = getServerConfig();
    if (!config.mirrorPath) {
      console.error(
        `${name}: GDELT_MIRROR_PATH is not set. Set it to the SQLite database file that holds the mirror.`,
      );
    } else {
      mirror = createGkgMirror({
        path: config.mirrorPath,
        windowDays: config.mirrorWindowDays,
        transport: defaultFeedTransport,
        logger: stderrLogger(abort.signal),
      });
      code = await task(mirror, abort.signal);
    }
  } catch (error) {
    if (interrupted) code = 128 + constants.signals[interrupted];
    else console.error(`${name} failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await mirror?.close();
  }
  process.exit(code);
}
