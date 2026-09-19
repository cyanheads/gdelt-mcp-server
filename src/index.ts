#!/usr/bin/env node
/**
 * @fileoverview gdelt-mcp-server MCP server entry point.
 * @module index
 */

import { createApp } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from './config/server-config.js';
import {
  gdeltGetCoverageBreakdown,
  gdeltGetCoverageTimeline,
  gdeltGetToneDistribution,
  gdeltGetTvClips,
  gdeltGetTvContext,
  gdeltGetTvTrending,
  gdeltListTvStations,
  gdeltSearchArticles,
  gdeltSearchTv,
} from './mcp-server/tools/definitions/index.js';
import { initGdeltDocService } from './services/gdelt/gdelt-doc-service.js';
import { disposeGdeltPacer, initGdeltPacer } from './services/gdelt/gdelt-pacer.js';
import { initGdeltTvService } from './services/gdelt/gdelt-tv-service.js';

await createApp({
  name: 'gdelt-mcp-server',
  title: 'gdelt-mcp-server',
  tools: [
    gdeltSearchArticles,
    gdeltGetCoverageTimeline,
    gdeltGetToneDistribution,
    gdeltGetCoverageBreakdown,
    gdeltSearchTv,
    gdeltGetTvClips,
    gdeltGetTvContext,
    gdeltGetTvTrending,
    gdeltListTvStations,
  ],
  resources: [],
  prompts: [],
  // Public catalog — serve full tool/resource/prompt inventory to unauthenticated callers.
  landing: { requireAuth: false },
  // Every tool is a one-shot read of a public API — nothing here asks the caller for input
  // mid-handler, so no session state is worth holding. MCP_SESSION_MODE still wins when set.
  sessionMode: 'stateless',
  instructions:
    'GDELT MCP Server — global news and TV transcript analysis.\n' +
    '- gdelt_search_articles: full-text news search (last 3 months, 65+ languages)\n' +
    '- gdelt_get_coverage_timeline: when did coverage spike? (use mode volume_with_articles for signal detection)\n' +
    '- gdelt_get_tone_distribution: emotional distribution of coverage (histogram)\n' +
    '- gdelt_get_coverage_breakdown: which countries/languages drove coverage?\n' +
    '- gdelt_search_tv: US TV transcript search (2009–Oct 2024, 150+ stations)\n' +
    '- gdelt_get_tv_clips: read actual TV transcript excerpts with archive links\n' +
    '- gdelt_get_tv_context: vocabulary framing a topic on television\n' +
    '- gdelt_get_tv_trending: current trending topics on TV news (Oct 2024 archive cutoff)\n' +
    '- gdelt_list_tv_stations: verify station IDs and active date ranges before TV queries\n' +
    'Rate limit: 1 request per 5 seconds — multi-step workflows take 15+ seconds.',

  setup(core) {
    const serverConfig = getServerConfig();
    initGdeltPacer(serverConfig.requestDelayMs);
    initGdeltDocService(core.config, core.storage, serverConfig);
    initGdeltTvService(core.config, core.storage, serverConfig);
  },

  // The pacer holds a dispatch timer and a queue of waiters; nothing else in setup() allocates.
  teardown() {
    disposeGdeltPacer();
  },
});
