/**
 * @fileoverview GKG mirror startup wiring: `src/index.ts` loads the mirror client only when
 * `GDELT_MIRROR_PATH` is set, hands it the config and transport, and disposes it on teardown;
 * `initGkgMirrorClient` schedules the 15-minute refresh on HTTP only, logs each completed run,
 * closes the client when scheduling fails, and `disposeGkgMirrorClient` removes the job. A store
 * path the mirror cannot open stops a real boot with the framework's configuration banner.
 * @module tests/services/gkg-mirror-startup.test
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configurationError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { logger, schedulerService } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GkgMirrorClient } from '@/services/gkg-mirror/gkg-mirror-client.js';
import type { GkgMirrorRefreshOutcome } from '@/services/gkg-mirror/gkg-mirror-worker.js';

type MirrorClientModule = typeof import('@/services/gkg-mirror/gkg-mirror-client.js');

const mocks = vi.hoisted(() => ({
  createApp: vi.fn<(options: AppOptions) => Promise<undefined>>(async () => undefined),
  clientModuleLoaded: vi.fn(),
  initGkgMirrorClient: vi.fn<MirrorClientModule['initGkgMirrorClient']>(async () => undefined),
  disposeGkgMirrorClient: vi.fn(async () => undefined),
}));

vi.mock('@cyanheads/mcp-ts-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cyanheads/mcp-ts-core')>()),
  createApp: mocks.createApp,
}));

vi.mock('@/services/gkg-mirror/gkg-mirror-client.js', () => {
  mocks.clientModuleLoaded();
  return {
    initGkgMirrorClient: mocks.initGkgMirrorClient,
    disposeGkgMirrorClient: mocks.disposeGkgMirrorClient,
  };
});

type AppOptions = NonNullable<Parameters<typeof import('@cyanheads/mcp-ts-core').createApp>[0]>;
type SetupCore = Parameters<NonNullable<AppOptions['setup']>>[0];

/** Import `src/index.ts` fresh and return the options its `createApp()` call received. */
async function loadEntry(): Promise<AppOptions> {
  vi.resetModules();
  mocks.createApp.mockClear();
  await import('@/index.js');
  const options = mocks.createApp.mock.calls[0]?.[0];
  if (!options?.setup || !options.teardown)
    throw new Error('createApp must register setup and teardown');
  return options;
}

/** Service constructors only read configuration; the fake core performs no I/O. */
function fakeCore(transport: 'http' | 'stdio'): SetupCore {
  return { config: { mcpTransportType: transport }, storage: {} } as unknown as SetupCore;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('src/index.ts mirror wiring', () => {
  it('never loads the mirror client with GDELT_MIRROR_PATH unset, and registers the same ten tools', async () => {
    vi.stubEnv('GDELT_MIRROR_PATH', undefined);
    const options = await loadEntry();

    await options.setup?.(fakeCore('http'));
    expect((options.tools as Array<{ name: string }>).map((t) => t.name).sort()).toEqual([
      'gdelt_get_coverage_breakdown',
      'gdelt_get_coverage_timeline',
      'gdelt_get_tone_distribution',
      'gdelt_get_tv_breakdown',
      'gdelt_get_tv_clips',
      'gdelt_get_tv_context',
      'gdelt_list_tv_stations',
      'gdelt_search_articles',
      'gdelt_search_themes',
      'gdelt_search_tv',
    ]);
    await options.teardown?.(fakeCore('http'));

    expect(mocks.clientModuleLoaded).not.toHaveBeenCalled();
    expect(mocks.initGkgMirrorClient).not.toHaveBeenCalled();
    expect(mocks.disposeGkgMirrorClient).not.toHaveBeenCalled();
  });

  it('starts the mirror client with the config and transport when GDELT_MIRROR_PATH is set, and disposes it on teardown', async () => {
    vi.stubEnv('GDELT_MIRROR_PATH', '/var/lib/gdelt-mirror/gkg.db');
    vi.stubEnv('GDELT_MIRROR_WINDOW_DAYS', '3');
    const options = await loadEntry();

    await options.setup?.(fakeCore('stdio'));
    expect(mocks.clientModuleLoaded).toHaveBeenCalledTimes(1);
    expect(mocks.initGkgMirrorClient).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ mirrorPath: '/var/lib/gdelt-mirror/gkg.db', mirrorWindowDays: 3 }),
      'stdio',
    );
    expect(mocks.disposeGkgMirrorClient).not.toHaveBeenCalled();

    await options.teardown?.(fakeCore('stdio'));
    expect(mocks.disposeGkgMirrorClient).toHaveBeenCalledTimes(1);
  });
});

describe('initGkgMirrorClient / disposeGkgMirrorClient', () => {
  const JOB_ID = 'gkg-mirror-refresh';
  const CONFIG = { mirrorPath: '/var/lib/gdelt-mirror/gkg.db', mirrorWindowDays: 3 };

  let real: typeof import('@/services/gkg-mirror/gkg-mirror-client.js');
  let fake: {
    client: GkgMirrorClient;
    refresh: ReturnType<typeof vi.fn<() => Promise<GkgMirrorRefreshOutcome>>>;
    close: ReturnType<typeof vi.fn<() => Promise<void>>>;
  };
  let start: ReturnType<typeof vi.spyOn>;

  const job = () => schedulerService.listJobs().find((j) => j.id === JOB_ID);

  beforeEach(async () => {
    // Fake timers hold node-cron's real 15-minute timer; the test runs the job by hand.
    vi.useFakeTimers();
    real = await vi.importActual('@/services/gkg-mirror/gkg-mirror-client.js');
    const refresh = vi.fn(
      async (): Promise<GkgMirrorRefreshOutcome> => ({
        ran: false,
        reason: 'not_ready',
      }),
    );
    const close = vi.fn(async () => undefined);
    fake = { client: { refresh, close } as unknown as GkgMirrorClient, refresh, close };
    start = vi.spyOn(real.GkgMirrorClient, 'start').mockResolvedValue(fake.client);
  });

  afterEach(async () => {
    await real.disposeGkgMirrorClient();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('on HTTP, schedules the refresh every 15 minutes, and the job runs refresh()', async () => {
    await real.initGkgMirrorClient(CONFIG, 'http');

    expect(start).toHaveBeenCalledExactlyOnceWith({
      path: '/var/lib/gdelt-mirror/gkg.db',
      windowDays: 3,
    });
    expect(real.getGkgMirrorClient()).toBe(fake.client);
    expect(job()).toMatchObject({ id: JOB_ID, schedule: '*/15 * * * *' });
    expect(fake.refresh).not.toHaveBeenCalled();

    await job()?.task.execute();
    expect(fake.refresh).toHaveBeenCalledTimes(1);
  });

  it("logs a completed refresh with the run's counts, stamped when it completed, under the job's request ID", async () => {
    const result = {
      pagesFetched: 4,
      recordsApplied: 4912,
      tombstonesApplied: 5252,
      total: 179_335,
    };
    vi.setSystemTime(new Date('2026-11-01T15:30:00.000Z'));
    fake.refresh.mockImplementation(async () => {
      vi.setSystemTime(new Date('2026-11-01T15:30:15.000Z'));
      return { ran: true, result };
    });
    const info = vi.spyOn(logger, 'info');
    await real.initGkgMirrorClient(CONFIG, 'http');

    await job()?.task.execute();

    const logged = (message: string) => info.mock.calls.find(([msg]) => msg === message)?.[1];
    const started = logged(`Starting job '${JOB_ID}'...`);
    expect(started).toMatchObject({ timestamp: '2026-11-01T15:30:00.000Z' });
    // The logger writes a context's canonical fields and flattens `extra`; nothing else.
    expect(logged('GKG mirror refresh complete')).toMatchObject({
      requestId: started?.requestId,
      operation: `scheduler:job:${JOB_ID}`,
      timestamp: '2026-11-01T15:30:15.000Z',
      extra: { jobId: JOB_ID, schedule: '*/15 * * * *', ...result },
    });
  });

  it('on stdio, starts the client and schedules nothing', async () => {
    await real.initGkgMirrorClient(CONFIG, 'stdio');

    expect(real.getGkgMirrorClient()).toBe(fake.client);
    expect(job()).toBeUndefined();
  });

  it('rethrows a ConfigurationError from start() untouched and schedules nothing', async () => {
    const noDriver = configurationError(
      'Install "better-sqlite3" to use the SQLite mirror store on Node: bun add better-sqlite3',
    );
    start.mockRejectedValue(noDriver);

    await expect(real.initGkgMirrorClient(CONFIG, 'http')).rejects.toBe(noDriver);
    expect(real.getGkgMirrorClient()).toBeUndefined();
    expect(job()).toBeUndefined();
  });

  it('closes the client and rethrows when scheduling fails', async () => {
    // A job already holding the refresh ID makes schedule() reject with Conflict.
    await schedulerService.schedule(JOB_ID, '0 0 1 1 *', () => undefined, 'holds the job ID');
    try {
      await expect(real.initGkgMirrorClient(CONFIG, 'http')).rejects.toMatchObject({
        code: JsonRpcErrorCode.Conflict,
      });
      expect(fake.close).toHaveBeenCalledTimes(1);
      expect(real.getGkgMirrorClient()).toBeUndefined();

      // Disposing afterwards leaves the job it never scheduled alone.
      await real.disposeGkgMirrorClient();
      expect(job()).toMatchObject({ description: 'holds the job ID' });
    } finally {
      schedulerService.remove(JOB_ID);
    }
  });

  it('removes the job and closes the client on dispose', async () => {
    await real.initGkgMirrorClient(CONFIG, 'http');
    expect(job()).toBeDefined();

    await real.disposeGkgMirrorClient();
    expect(job()).toBeUndefined();
    expect(fake.close).toHaveBeenCalledTimes(1);
    expect(real.getGkgMirrorClient()).toBeUndefined();
  });
});

/**
 * A real boot of `src/index.ts` through the framework's `createApp`, with the mirror worker on the
 * test entry (the production worker over a stub network) and a store path it cannot open. The
 * framework prints its configuration banner to stderr and exits 1; here `process.exit` only
 * records the code, so `createApp` goes on to reject with the error it printed.
 */
describe('booting with a GDELT_MIRROR_PATH the store cannot open', () => {
  const WORKER_URL = new URL('../helpers/gkg-mirror-test-worker.ts', import.meta.url);
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gkg-mirror-boot-'));
    mkdirSync(join(dir, 'locked'));
    chmodSync(join(dir, 'locked'), 0o555);
    writeFileSync(join(dir, 'notes.db'), 'Field notes, not a database.\n'.repeat(20));
    mkdirSync(join(dir, 'store-dir'));
  });

  afterEach(() => {
    chmodSync(join(dir, 'locked'), 0o755);
    rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function boot(path: string) {
    vi.stubEnv('GDELT_MIRROR_PATH', path);
    vi.stubEnv('MCP_TRANSPORT_TYPE', 'stdio');
    vi.stubEnv('DEBUG', undefined);
    // createApp writes these to process.env; stubbing them first restores them afterwards.
    for (const name of [
      'NO_COLOR',
      'FORCE_COLOR',
      'MCP_SERVER_NAME',
      'OTEL_SERVICE_NAME',
      'MCP_SESSION_MODE',
    ]) {
      vi.stubEnv(name, process.env[name]);
    }
    const options = await loadEntry();

    const actual = await vi.importActual<MirrorClientModule>(
      '@/services/gkg-mirror/gkg-mirror-client.js',
    );
    const start = actual.GkgMirrorClient.start.bind(actual.GkgMirrorClient);
    vi.spyOn(actual.GkgMirrorClient, 'start').mockImplementation((data) => start(data, WORKER_URL));
    mocks.initGkgMirrorClient.mockImplementationOnce(actual.initGkgMirrorClient);
    const { createApp } =
      await vi.importActual<typeof import('@cyanheads/mcp-ts-core')>('@cyanheads/mcp-ts-core');
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const stderr: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });

    const error = await createApp(options).then(
      () => undefined,
      (reason: unknown) => reason,
    );
    await options.teardown?.(fakeCore('stdio'));
    return { error, exitCodes: exit.mock.calls.map(([code]) => code), stderr: stderr.join('') };
  }

  /** The framework's startup banner around `message`, without DEBUG. */
  const banner = (message: string) => {
    const divider = '-'.repeat(60);
    return `\n${divider}\n Configuration error — server failed to start\n${divider}\n${message}\n\nCheck your .env file or environment variables, then retry.\nSet DEBUG=true for the full stack trace.\n${divider}\n\n`;
  };

  it.each([
    {
      name: 'an unwritable directory',
      path: () => join(dir, 'locked', 'gkg.db'),
      storeFailure: 'permission_denied',
      causeCode: 'SQLITE_CANTOPEN',
      message: () =>
        `GDELT_MIRROR_PATH "${join(dir, 'locked', 'gkg.db')}": permission denied; the server cannot create or write the GKG mirror store there.\nGive the server's user write access to "${join(dir, 'locked')}" and any store files in it, or set GDELT_MIRROR_PATH to a file in a writable directory.`,
    },
    {
      name: 'a directory that cannot be created',
      path: () => join(dir, 'locked', 'mirror', 'gkg.db'),
      storeFailure: 'cannot_create',
      causeCode: 'EACCES',
      message: () =>
        `GDELT_MIRROR_PATH "${join(dir, 'locked', 'mirror', 'gkg.db')}": cannot create the directory "${join(dir, 'locked', 'mirror')}" that holds the GKG mirror store.\nCreate that directory with write access for the server's user, or set GDELT_MIRROR_PATH to a file in a directory it can write.`,
    },
    {
      name: 'a file that is not a database',
      path: () => join(dir, 'notes.db'),
      storeFailure: 'not_a_database',
      causeCode: 'SQLITE_NOTADB',
      message: () =>
        `GDELT_MIRROR_PATH "${join(dir, 'notes.db')}": not a database; the file exists but is not a SQLite store.\nSet GDELT_MIRROR_PATH to a new file name or to a store mirror:init built, or move the file aside.`,
    },
    {
      name: 'a directory',
      path: () => join(dir, 'store-dir'),
      storeFailure: 'is_a_directory',
      causeCode: 'SQLITE_CANTOPEN',
      message: () =>
        `GDELT_MIRROR_PATH "${join(dir, 'store-dir')}": is a directory, not the GKG mirror store's file.\nSet GDELT_MIRROR_PATH to a database file inside it, such as "${join(dir, 'store-dir', 'gkg.db')}".`,
    },
  ])('prints the configuration banner and exits 1 for $name', async (row) => {
    const { error, exitCodes, stderr } = await boot(row.path());

    expect(exitCodes).toEqual([1]);
    expect(stderr).toContain(banner(row.message()));
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ConfigurationError,
      message: row.message(),
      data: { path: row.path(), storeFailure: row.storeFailure, causeCode: row.causeCode },
    });
  });
});
