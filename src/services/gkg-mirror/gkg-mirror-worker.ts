/**
 * @fileoverview The GKG mirror worker: the one thread that owns the mirror store. It opens the
 * store on start, answers status and compiled DOC requests from the main thread, runs refreshes
 * when asked, and closes the store on request. Both SQLite drivers are synchronous, so keeping
 * every store call here keeps the serving thread's event loop free.
 *
 * `gkg-mirror-worker-entry.ts` starts it on the real network; tests start it with a stub
 * transport. Imports only relative paths, Node built-ins, and the framework: the worker runs
 * from `src/` under tests and from `dist/` in the package.
 * @module services/gkg-mirror/gkg-mirror-worker
 */

import type { MessagePort } from 'node:worker_threads';
import { McpError } from '@cyanheads/mcp-ts-core/errors';
import type { MirrorLogger, SqliteHandle, SyncResult } from '@cyanheads/mcp-ts-core/mirror';
import type { FeedTransport } from './gkg-feed.js';
import { executeMirrorRequest, readMirrorCoverage } from './gkg-mirror-queries.js';
import { createGkgMirror } from './gkg-mirror-store.js';
import type { MirrorCoverageStatus, MirrorRequest, MirrorResponse } from './types.js';

/** `workerData` of a mirror worker. */
export type GkgMirrorWorkerData = { path: string; windowDays: number };

/** Main thread → worker. */
export type GkgMirrorWorkerRequest =
  | { id: number; op: 'status' }
  | { id: number; op: 'execute'; req: MirrorRequest }
  | { id: number; op: 'refresh' }
  | { id: number; op: 'close' };

export type GkgMirrorWorkerOp = GkgMirrorWorkerRequest['op'];

/**
 * A refresh that ran, or the reason it did not: no init has completed yet, or another process
 * (an operator's `mirror:init` or `mirror:refresh`) holds the store's sync lease.
 */
export type GkgMirrorRefreshOutcome =
  | { ran: true; result: SyncResult }
  | { ran: false; reason: 'not_ready' | 'sync_locked' };

/** Reply value per operation. */
export type GkgMirrorWorkerReplies = {
  status: MirrorCoverageStatus;
  execute: MirrorResponse;
  refresh: GkgMirrorRefreshOutcome;
  close: null;
};

/**
 * An error as it crosses the thread boundary. `code` and `data` are an `McpError`'s; `systemCode`
 * is the string `code` a SQLite driver or Node system error carries (`SQLITE_NOTADB`, `EACCES`);
 * `cause` is the error's cause, serialized the same way.
 */
export type SerializedError = {
  name: string;
  message: string;
  code?: number;
  data?: unknown;
  systemCode?: string;
  cause?: SerializedError;
};

type GkgMirrorLogLevel = 'debug' | 'info' | 'notice' | 'warning' | 'error';

/** Worker → main thread. `ready` or `start_failed` comes first, once. */
export type GkgMirrorWorkerMessage =
  | { type: 'ready' }
  | { type: 'start_failed'; error: SerializedError }
  | { type: 'reply'; id: number; ok: true; value: GkgMirrorWorkerReplies[GkgMirrorWorkerOp] }
  | { type: 'reply'; id: number; ok: false; error: SerializedError }
  | { type: 'log'; level: GkgMirrorLogLevel; message: string; meta?: Record<string, unknown> };

const NOT_READY_DETAIL =
  'The local GKG mirror has not completed an init run; the operator runs `mirror:init` to build it.';
const STORE_ERROR_DETAIL = 'The local GKG mirror store failed while answering.';

/**
 * Serve the mirror on `port` until a `close` request. When the store cannot be opened (the
 * framework's `ConfigurationError` when Node has no `better-sqlite3`, a `DatabaseError`
 * otherwise), posts `start_failed` with that error and returns.
 */
export async function serveGkgMirrorWorker(
  port: MessagePort,
  data: GkgMirrorWorkerData,
  transport: FeedTransport,
): Promise<void> {
  const post = (message: GkgMirrorWorkerMessage) => port.postMessage(message);
  const logger = relayLogger(post);
  const mirror = createGkgMirror({ ...data, transport, logger });

  let db: SqliteHandle;
  try {
    db = await mirror.raw();
  } catch (error) {
    post({ type: 'start_failed', error: serializeError(error) });
    port.close();
    return;
  }

  let refresh: { abort: AbortController; done: Promise<SyncResult> } | undefined;
  let closing = false;
  const inflight = new Set<Promise<void>>();

  /** `earlier` holds the requests already running when this one arrived. */
  async function answer(
    request: GkgMirrorWorkerRequest,
    earlier: Promise<void>[],
  ): Promise<GkgMirrorWorkerReplies[GkgMirrorWorkerOp]> {
    switch (request.op) {
      case 'status':
        return { ready: await mirror.ready(), ...readMirrorCoverage(db) };
      case 'execute':
        try {
          if (!(await mirror.ready())) return { outcome: 'not_ready', detail: NOT_READY_DETAIL };
          return executeMirrorRequest(db, request.req);
        } catch (error) {
          logger.error?.('GKG mirror query failed', { kind: request.req.kind, error });
          return { outcome: 'store_error', detail: STORE_ERROR_DETAIL };
        }
      case 'refresh': {
        if (!(await mirror.ready())) return { ran: false, reason: 'not_ready' };
        const abort = new AbortController();
        const done = mirror.runSync({ mode: 'refresh', signal: abort.signal });
        refresh = { abort, done };
        try {
          return { ran: true, result: await done };
        } catch (error) {
          // The lease is claimed before the walk starts, so a locked run fetched and wrote nothing.
          if (error instanceof McpError && error.data?.reason === 'sync_locked') {
            return { ran: false, reason: 'sync_locked' };
          }
          throw error;
        } finally {
          refresh = undefined;
        }
      }
      case 'close':
        // A refresh's own failure is its reply's to report; close only waits it out.
        refresh?.abort.abort();
        await Promise.allSettled(earlier);
        await mirror.close();
        return null;
      default: {
        const unknown: never = request;
        throw new TypeError(`Unknown mirror worker request: ${JSON.stringify(unknown)}`);
      }
    }
  }

  async function handle(request: GkgMirrorWorkerRequest, earlier: Promise<void>[]): Promise<void> {
    try {
      if (closing && request.op !== 'close') throw new Error('The GKG mirror worker is closing.');
      if (request.op === 'close') closing = true;
      post({ type: 'reply', id: request.id, ok: true, value: await answer(request, earlier) });
    } catch (error) {
      post({ type: 'reply', id: request.id, ok: false, error: serializeError(error) });
    }
    if (request.op === 'close') port.close();
  }

  port.on('message', (request: GkgMirrorWorkerRequest) => {
    // handle() never rejects; the set lets close wait out every request already running.
    const task: Promise<void> = handle(request, [...inflight]).finally(() => inflight.delete(task));
    inflight.add(task);
  });

  post({ type: 'ready' });
}

/** Sync-run logs travel to the main thread, whose logger has sinks; this thread's has none. */
function relayLogger(post: (message: GkgMirrorWorkerMessage) => void): MirrorLogger {
  const at =
    (level: GkgMirrorLogLevel) => (message: string, meta?: Readonly<Record<string, unknown>>) =>
      post({ type: 'log', level, message, ...(meta && { meta: cloneableMeta(meta) }) });
  return {
    debug: at('debug'),
    info: at('info'),
    notice: at('notice'),
    warning: at('warning'),
    error: at('error'),
  };
}

/** Errors in log metadata become plain objects so name, message, stack, and cause survive the clone. */
function cloneableMeta(meta: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(meta).map(([key, value]) => [
      key,
      value instanceof Error ? errorMeta(value) : value,
    ]),
  );
}

function errorMeta(error: Error): Record<string, unknown> {
  return {
    name: error.name,
    message: error.message,
    ...(error.stack && { stack: error.stack }),
    ...(error.cause instanceof Error && { cause: errorMeta(error.cause) }),
  };
}

/**
 * The fields a caller rebuilds the error from, cause included. Only an `McpError` carries `code`
 * and `data`: other errors can hold a numeric `code` too (a `DOMException` abort's legacy 20),
 * which is no JSON-RPC code, so only a string `code` crosses for them.
 */
function serializeError(error: unknown): SerializedError {
  if (!(error instanceof Error)) return { name: 'Error', message: String(error) };
  const cause = error.cause === undefined ? undefined : serializeError(error.cause);
  if (error instanceof McpError) {
    return {
      name: error.name,
      message: error.message,
      code: error.code,
      ...(error.data !== undefined && { data: error.data }),
      ...(cause && { cause }),
    };
  }
  const { code } = error as { code?: unknown };
  return {
    name: error.name,
    message: error.message,
    ...(typeof code === 'string' && { systemCode: code }),
    ...(cause && { cause }),
  };
}
