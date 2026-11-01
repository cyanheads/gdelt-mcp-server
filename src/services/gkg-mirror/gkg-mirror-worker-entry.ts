/**
 * @fileoverview Worker-thread entry the mirror client spawns: serves the GKG mirror on the real
 * network. Imports only relative paths (see `gkg-mirror-worker.ts`).
 * @module services/gkg-mirror/gkg-mirror-worker-entry
 */

import { parentPort, workerData } from 'node:worker_threads';
import { defaultFeedTransport } from './gkg-feed.js';
import { type GkgMirrorWorkerData, serveGkgMirrorWorker } from './gkg-mirror-worker.js';

if (!parentPort) throw new Error('gkg-mirror-worker-entry runs only as a worker thread.');
await serveGkgMirrorWorker(parentPort, workerData as GkgMirrorWorkerData, defaultFeedTransport);
