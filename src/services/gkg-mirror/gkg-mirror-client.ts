/**
 * @fileoverview Main-thread handle on the GKG mirror worker: spawns it, posts status, query,
 * refresh, and close requests, and relays its logs. Also the server's init/accessor pair, which
 * schedules the 15-minute refresh on HTTP transport.
 *
 * Loads nothing of the store: the framework mirror, the SQLite driver, the feed, and the query
 * layer load only inside the worker.
 * @module services/gkg-mirror/gkg-mirror-client
 */

import { statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  configurationError,
  JsonRpcErrorCode,
  McpError,
  serviceUnavailable,
} from '@cyanheads/mcp-ts-core/errors';
import { logger, requestContextService, schedulerService } from '@cyanheads/mcp-ts-core/utils';
import type { ServerConfig } from '@/config/server-config.js';
import type {
  GkgMirrorRefreshOutcome,
  GkgMirrorWorkerData,
  GkgMirrorWorkerMessage,
  GkgMirrorWorkerOp,
  GkgMirrorWorkerReplies,
  GkgMirrorWorkerRequest,
  SerializedError,
} from './gkg-mirror-worker.js';
import type { MirrorCoverageStatus, MirrorRequest, MirrorResponse } from './types.js';

/** The worker entry beside this module (`.ts` under tests, which Bun resolves; `.js` in `dist/`). */
const GKG_MIRROR_WORKER_URL = new URL('./gkg-mirror-worker-entry.js', import.meta.url);

/** Spawn plus store open (the store waits up to 5 s on another connection's lock). */
const START_TIMEOUT_MS = 30_000;
/** Ceiling on one query's wait, so a wedged worker cannot hold a tool call. */
const QUERY_TIMEOUT_MS = 30_000;
const STATUS_TIMEOUT_MS = 10_000;
/** Under the framework's 10 s teardown ceiling. */
const CLOSE_TIMEOUT_MS = 8_000;

const REFRESH_JOB_ID = 'gkg-mirror-refresh';
/** GDELT publishes a slot every 15 minutes; each run also catches up any slot an earlier one missed. */
const REFRESH_SCHEDULE = '*/15 * * * *';

const STORE_ERROR_DETAIL = 'The local GKG mirror did not answer.';

type Pending = { resolve: (value: unknown) => void; reject: (error: unknown) => void };

type RequestFields<Op extends GkgMirrorWorkerOp> = Omit<
  Extract<GkgMirrorWorkerRequest, { op: Op }>,
  'id' | 'op'
>;

/** A running mirror worker. Obtain one with {@link GkgMirrorClient.start}. */
export class GkgMirrorClient {
  readonly #worker: Worker;
  readonly #pending = new Map<number, Pending>();
  readonly #started = Promise.withResolvers<void>();
  #nextId = 1;
  /** The worker has opened the store. */
  #running = false;
  /** Set once the worker has died; every later call fails with it. */
  #failure: Error | undefined;
  #closing: Promise<void> | undefined;
  #refreshing: Promise<GkgMirrorRefreshOutcome> | undefined;

  private constructor(worker: Worker) {
    this.#worker = worker;
    worker.on('message', (message: GkgMirrorWorkerMessage) => this.#onMessage(message));
    worker.on('error', (error) => this.#fail(toError(error)));
    worker.on('exit', (code) => {
      if (!this.#closing) this.#fail(new Error(`The GKG mirror worker exited with code ${code}.`));
    });
  }

  /**
   * Spawn the worker and wait until it has opened the store. Rejects with the store's open error
   * rebuilt on this thread (the framework's `ConfigurationError` on Node without
   * `better-sqlite3`, its `DatabaseError` otherwise), or when the worker does not come up within
   * 30 s. `workerUrl` is the entry to spawn; tests pass one with a stub network.
   */
  static async start(
    data: GkgMirrorWorkerData,
    workerUrl: URL = GKG_MIRROR_WORKER_URL,
  ): Promise<GkgMirrorClient> {
    const client = new GkgMirrorClient(new Worker(workerUrl, { workerData: data }));
    const timer = setTimeout(
      () =>
        client.#fail(
          new Error(`The GKG mirror worker did not start within ${START_TIMEOUT_MS / 1000} s.`),
        ),
      START_TIMEOUT_MS,
    );
    try {
      await client.#started.promise;
    } catch (error) {
      await client.#worker.terminate();
      throw error;
    } finally {
      clearTimeout(timer);
    }
    return client;
  }

  /**
   * Readiness and ledger coverage. Rejects with `ServiceUnavailable` when the worker cannot
   * answer within 10 s. Aborting `signal` rejects with its reason, untouched, at once.
   */
  async status(signal?: AbortSignal): Promise<MirrorCoverageStatus> {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(STATUS_TIMEOUT_MS);
    try {
      return await this.#call('status', {}, signal ? AbortSignal.any([signal, timeout]) : timeout);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw serviceUnavailable('The local GKG mirror did not report its status.', undefined, {
        cause: error,
      });
    }
  }

  /**
   * Answer a compiled DOC request. A mirror with no completed init resolves `not_ready`; a store
   * error, a dead worker, or no answer within 30 s resolves `store_error`, with the cause
   * logged. Aborting `signal` rejects with its reason, untouched, at once: the worker's
   * synchronous query runs on, and its late answer is dropped.
   */
  async execute(req: MirrorRequest, signal: AbortSignal): Promise<MirrorResponse> {
    signal.throwIfAborted();
    try {
      return await this.#call(
        'execute',
        { req },
        AbortSignal.any([signal, AbortSignal.timeout(QUERY_TIMEOUT_MS)]),
      );
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      logger.error(
        'GKG mirror query did not complete',
        toError(error),
        requestContextService.createRequestContext({
          operation: 'gkg-mirror.execute',
          additionalContext: { kind: req.kind },
        }),
      );
      return { outcome: 'store_error', detail: STORE_ERROR_DETAIL };
    }
  }

  /**
   * Run one refresh in the worker; a call while one runs joins it rather than starting another.
   * Resolves `{ ran: false }` until an init has completed. Rejects when the run fails (it has
   * already been logged); the next run resumes from the slot ledger.
   */
  refresh(): Promise<GkgMirrorRefreshOutcome> {
    this.#refreshing ??= this.#call('refresh', {}).finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  /**
   * Abort a running refresh, close the store, and stop the worker. Idempotent. A worker that does
   * not close within 8 s is terminated.
   */
  close(): Promise<void> {
    if (!this.#closing) {
      const reply = this.#failure
        ? Promise.resolve(null)
        : this.#call('close', {}, AbortSignal.timeout(CLOSE_TIMEOUT_MS));
      this.#closing = this.#finishClose(reply);
    }
    return this.#closing;
  }

  async #finishClose(reply: Promise<null>): Promise<void> {
    try {
      await reply;
    } catch (error) {
      logger.warning(
        'GKG mirror worker did not close cleanly; terminating it',
        requestContextService.createRequestContext({
          operation: 'gkg-mirror.close',
          additionalContext: { error: toError(error).message },
        }),
      );
    }
    await this.#worker.terminate();
  }

  #call<Op extends GkgMirrorWorkerOp>(
    op: Op,
    fields: RequestFields<Op>,
    signal?: AbortSignal,
  ): Promise<GkgMirrorWorkerReplies[Op]> {
    if (this.#failure) return Promise.reject(this.#failure);
    if (this.#closing) return Promise.reject(new Error('The GKG mirror client is closed.'));
    if (signal?.aborted) return Promise.reject(signal.reason);
    const id = this.#nextId++;
    const { promise, resolve, reject } = Promise.withResolvers<GkgMirrorWorkerReplies[Op]>();
    const onAbort = () => {
      this.#pending.delete(id);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    this.#pending.set(id, {
      resolve: (value) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(value as GkgMirrorWorkerReplies[Op]);
      },
      reject: (error) => {
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      },
    });
    this.#worker.postMessage({ id, op, ...fields });
    return promise;
  }

  #onMessage(message: GkgMirrorWorkerMessage): void {
    switch (message.type) {
      case 'ready':
        this.#running = true;
        this.#started.resolve();
        return;
      case 'start_failed':
        this.#fail(deserializeError(message.error));
        return;
      case 'log':
        relayLog(message);
        return;
      case 'reply': {
        const pending = this.#pending.get(message.id);
        if (!pending) return; // the caller stopped waiting
        this.#pending.delete(message.id);
        if (message.ok) pending.resolve(message.value);
        else pending.reject(deserializeError(message.error));
        return;
      }
      default: {
        const unknown: never = message;
        throw new TypeError(`Unknown mirror worker message: ${JSON.stringify(unknown)}`);
      }
    }
  }

  #fail(error: Error): void {
    if (this.#failure) return;
    this.#failure = error;
    this.#started.reject(error);
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    // Before `ready`, start() rejects with the error and startup reports it.
    if (this.#running && !this.#closing) {
      logger.error(
        'GKG mirror worker failed',
        error,
        requestContextService.createRequestContext({ operation: 'gkg-mirror.worker' }),
      );
    }
  }
}

function relayLog(message: Extract<GkgMirrorWorkerMessage, { type: 'log' }>): void {
  const context = requestContextService.createRequestContext({
    operation: 'gkg-mirror.worker',
    ...(message.meta && { additionalContext: message.meta }),
  });
  if (message.level === 'error') logger.error(message.message, context);
  else logger[message.level](message.message, context);
}

/**
 * Rebuild a worker-side error with its cause chain. An `McpError` keeps its code, so a
 * `ConfigurationError` stays one; another error keeps its name and its string `code`.
 */
function deserializeError(error: SerializedError): Error {
  const options = error.cause && { cause: deserializeError(error.cause) };
  if (error.code !== undefined) {
    return new McpError(
      error.code as JsonRpcErrorCode,
      error.message,
      error.data as ConstructorParameters<typeof McpError>[2],
      options,
    );
  }
  const rebuilt = new Error(error.message, options);
  rebuilt.name = error.name;
  if (error.systemCode !== undefined) Object.assign(rebuilt, { code: error.systemCode });
  return rebuilt;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

// ─── Server init/accessor ─────────────────────────────────────────────────────

let activeClient: GkgMirrorClient | undefined;
let refreshScheduled = false;

/**
 * Start the mirror worker when `GDELT_MIRROR_PATH` is set, and on HTTP transport schedule a
 * refresh every 15 minutes (skipped until an init has completed; a tick never overlaps a running
 * one). Init never runs here: it is the operator's `mirror:init`. stdio operators run
 * `mirror:refresh` from cron instead.
 *
 * A store that will not open rejects with a `ConfigurationError` naming the path, why, and the
 * fix, which the framework prints as its startup banner before exiting 1.
 */
export async function initGkgMirrorClient(
  config: Pick<ServerConfig, 'mirrorPath' | 'mirrorWindowDays'>,
  transport: 'http' | 'stdio',
): Promise<void> {
  if (!config.mirrorPath) return;
  let client: GkgMirrorClient;
  try {
    client = await GkgMirrorClient.start({
      path: config.mirrorPath,
      windowDays: config.mirrorWindowDays,
    });
  } catch (error) {
    if (error instanceof McpError && error.code === JsonRpcErrorCode.DatabaseError) {
      throw storeOpenError(config.mirrorPath, error);
    }
    throw error;
  }
  activeClient = client;
  if (transport !== 'http') return;
  try {
    await schedulerService.schedule(
      REFRESH_JOB_ID,
      REFRESH_SCHEDULE,
      async (context) => {
        const outcome = await client.refresh();
        if (outcome.ran) {
          /**
           * The logger writes only a context's canonical fields and `extra`, so the counts go in
           * `extra`; a child context keeps the job's request ID and is stamped as the run ends.
           */
          logger.info(
            'GKG mirror refresh complete',
            requestContextService.createRequestContext({
              parentContext: context,
              additionalContext: { ...outcome.result },
            }),
          );
        } else logger.debug('GKG mirror refresh skipped: no init has completed', context);
      },
      'Refresh the local GKG mirror from the 15-minute GKG feeds',
    );
  } catch (error) {
    activeClient = undefined;
    await client.close();
    throw error;
  }
  schedulerService.start(REFRESH_JOB_ID);
  refreshScheduled = true;
}

/** Why the store at `GDELT_MIRROR_PATH` would not open. */
type StoreFailure =
  | 'permission_denied'
  | 'cannot_create'
  | 'not_a_database'
  | 'is_a_directory'
  | 'unavailable';

/**
 * The startup error for a store that would not open: the configured path, why (from the driver's
 * or the filesystem's code on the open error's cause chain), and the fix, as the banner's text.
 * `data` carries the same as typed fields, and `cause` the open error.
 */
function storeOpenError(path: string, error: McpError): McpError {
  const code = causeCode(error);
  const failure = storeFailure(path, code);
  return configurationError(
    storeFailureMessage(failure, path, code),
    { path, storeFailure: failure, ...(code !== undefined && { causeCode: code }) },
    { cause: error },
  );
}

/** The first string `code` on the cause chain: a SQLite result code or a Node system error code. */
function causeCode(error: Error): string | undefined {
  for (let cause: unknown = error.cause; cause instanceof Error; cause = cause.cause) {
    const { code } = cause as { code?: unknown };
    if (typeof code === 'string') return code;
  }
  return;
}

function storeFailure(path: string, code: string | undefined): StoreFailure {
  if (code === undefined) return 'unavailable';
  if (code === 'SQLITE_NOTADB') return 'not_a_database';
  if (code.startsWith('SQLITE_CANTOPEN')) {
    return isDirectory(path) ? 'is_a_directory' : 'permission_denied';
  }
  if (code.startsWith('SQLITE_READONLY') || code === 'SQLITE_PERM') return 'permission_denied';
  // The open's one filesystem call creates the store's directory.
  if (/^E[A-Z]+$/.test(code)) return 'cannot_create';
  return 'unavailable';
}

/** A path the server cannot stat is a permission failure, never a directory it can name. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function storeFailureMessage(
  failure: StoreFailure,
  path: string,
  code: string | undefined,
): string {
  const configured = `GDELT_MIRROR_PATH ${JSON.stringify(path)}`;
  const directory = JSON.stringify(dirname(resolve(path)));
  switch (failure) {
    case 'permission_denied':
      return `${configured}: permission denied; the server cannot create or write the GKG mirror store there.\nGive the server's user write access to ${directory} and any store files in it, or set GDELT_MIRROR_PATH to a file in a writable directory.`;
    case 'cannot_create':
      return `${configured}: cannot create the directory ${directory} that holds the GKG mirror store.\nCreate that directory with write access for the server's user, or set GDELT_MIRROR_PATH to a file in a directory it can write.`;
    case 'not_a_database':
      return `${configured}: not a database; the file exists but is not a SQLite store.\nSet GDELT_MIRROR_PATH to a new file name or to a store mirror:init built, or move the file aside.`;
    case 'is_a_directory':
      return `${configured}: is a directory, not the GKG mirror store's file.\nSet GDELT_MIRROR_PATH to a database file inside it, such as ${JSON.stringify(join(path, 'gkg.db'))}.`;
    case 'unavailable':
      return `${configured}: the GKG mirror store could not be opened${code === undefined ? '' : ` (${code})`}.\nCheck that the file is a GKG mirror store and that no other process holds it locked, then restart the server.`;
    default: {
      const unknown: never = failure;
      throw new TypeError(`Unknown store failure: ${String(unknown)}`);
    }
  }
}

/** The running mirror client, or undefined when `GDELT_MIRROR_PATH` is unset. */
export function getGkgMirrorClient(): GkgMirrorClient | undefined {
  return activeClient;
}

/** Stop the scheduled refresh and close the worker. */
export async function disposeGkgMirrorClient(): Promise<void> {
  if (refreshScheduled) {
    schedulerService.remove(REFRESH_JOB_ID);
    refreshScheduled = false;
  }
  const client = activeClient;
  activeClient = undefined;
  await client?.close();
}
