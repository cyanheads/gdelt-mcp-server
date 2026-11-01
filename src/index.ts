#!/usr/bin/env node
/**
 * @fileoverview gdelt-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from './config/server-config.js';
import { initGdeltDocService } from './services/gdelt/gdelt-doc-service.js';
import { disposeGdeltPacer, initGdeltPacer } from './services/gdelt/gdelt-pacer.js';
import { initGdeltThemeService } from './services/gdelt/gdelt-theme-service.js';
import { initGdeltTvService } from './services/gdelt/gdelt-tv-service.js';

// Definitions depend on validated server configuration; setup runs after framework .env loading.
const tools: NonNullable<NonNullable<Parameters<typeof createApp>[0]>['tools']> = [];

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
    'Search recent global news with DOC tools and station-specific television archives with TV tools; no API key is required. Resolve theme operators with gdelt_search_themes and station IDs and monitoring dates with gdelt_list_tv_stations before filtering. Investigate recent spikes with gdelt_get_coverage_timeline, then inspect article evidence; investigate historical TV with gdelt_search_tv, then gdelt_get_tv_clips. DOC covers the last three months; TV coverage varies by station, so verify the requested dates before interpreting absence. DOC and TV requests share pacing of at least five seconds; theme lookup uses a separate host. Follow pagination and continuation notices before claiming completeness.',

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
    initGdeltDocService(core.config, core.storage, serverConfig);
    initGdeltTvService(core.config, core.storage, serverConfig);
    initGdeltThemeService(serverConfig.requestTimeoutMs);
  },

  // The pacer holds a dispatch timer and a queue of waiters; nothing else in setup() allocates.
  teardown() {
    disposeGdeltPacer();
  },
});
