#!/usr/bin/env node
/**
 * @fileoverview gdelt-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from './config/server-config.js';
import { disposeDocSourceRouter, initDocSourceRouter } from './services/gdelt/doc-source-router.js';
import { initGdeltDocService } from './services/gdelt/gdelt-doc-service.js';
import { disposeGdeltPacer, initGdeltPacer } from './services/gdelt/gdelt-pacer.js';
import {
  disposeGdeltResponseCache,
  initGdeltResponseCache,
} from './services/gdelt/gdelt-response-cache.js';
import { initGdeltThemeService } from './services/gdelt/gdelt-theme-service.js';
import { initGdeltTvService } from './services/gdelt/gdelt-tv-service.js';

// Definitions depend on validated server configuration; setup runs after framework .env loading.
const tools: NonNullable<NonNullable<Parameters<typeof createApp>[0]>['tools']> = [];

/** Set by setup() when the GKG mirror is configured. */
let disposeGkgMirror: (() => Promise<void>) | undefined;

await createApp({
  name: 'gdelt-mcp-server',
  title: 'gdelt-mcp-server',
  tools,
  resources: [],
  prompts: [],
  skills: 'skills',
  // Public catalog — serve full tool/resource/prompt inventory to unauthenticated callers.
  landing: { requireAuth: false },
  // Every tool is a one-shot read of a public API — nothing here asks the caller for input
  // mid-handler, so no session state is worth holding. MCP_SESSION_MODE still wins when set.
  sessionMode: 'stateless',
  instructions:
    'Search recent global news with DOC tools and station-specific television archives with TV tools; no API key is required. Resolve theme operators with gdelt_search_themes and station IDs and monitoring dates with gdelt_list_tv_stations before filtering. Investigate recent spikes with gdelt_get_coverage_timeline, then inspect article evidence; investigate historical TV with gdelt_search_tv, then gdelt_get_tv_clips. Article search and timespan cover the last three months; explicit dates reach older windows in the volume and tone timelines, the language and country breakdowns, and the tone distribution. TV coverage varies by station, so verify the requested dates before interpreting absence. DOC and TV requests share pacing of at least five seconds; theme lookup uses a separate host. Follow pagination and continuation notices before claiming completeness. Where the server keeps a local GKG mirror, DOC tools may answer from it when the DOC API refuses a request or returns nothing, and mark those answers source: gkg_mirror.',

  async setup(core) {
    const serverConfig = getServerConfig();
    const definitions = await import('./mcp-server/tools/definitions/index.js');
    tools.push(
      definitions.gdeltSearchArticles,
      definitions.gdeltGetCoverageTimeline,
      definitions.gdeltGetToneDistribution,
      definitions.gdeltGetCoverageBreakdown,
      definitions.gdeltSearchThemes,
      definitions.gdeltSearchTv,
      definitions.gdeltGetTvBreakdown,
      definitions.gdeltGetTvClips,
      definitions.gdeltGetTvContext,
      definitions.gdeltListTvStations,
    );
    initGdeltPacer(serverConfig.requestDelayMs);
    initGdeltResponseCache();
    initGdeltDocService(core.config, core.storage, serverConfig);
    initGdeltTvService(core.config, core.storage, serverConfig);
    initGdeltThemeService(serverConfig.requestTimeoutMs);
    // Off unless GDELT_MIRROR_PATH is set; only then does the mirror's module graph load.
    if (serverConfig.mirrorPath) {
      const mirror = await import('./services/gkg-mirror/gkg-mirror-client.js');
      await mirror.initGkgMirrorClient(serverConfig, core.config.mcpTransportType);
      disposeGkgMirror = mirror.disposeGkgMirrorClient;
      // Read per call, so DOC tools stop consulting the mirror once teardown disposes it.
      initDocSourceRouter(() => mirror.getGkgMirrorClient());
    }
  },

  /**
   * The pacer holds a dispatch timer and a queue of waiters; the response cache holds up to
   * 128 MiB of stored answers; the GKG mirror holds a worker thread, its store, and a cron job.
   */
  async teardown() {
    disposeDocSourceRouter();
    disposeGdeltPacer();
    disposeGdeltResponseCache();
    await disposeGkgMirror?.();
  },
});
