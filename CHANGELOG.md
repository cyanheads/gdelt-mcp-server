# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.2.6](changelog/0.2.x/0.2.6.md) — 2026-07-24

Fixed: unenumerated GDELT query-rejection sentences no longer serialize as server errors (#25); rate-limit responses fail fast instead of burning the retry budget (#26); mcp-ts-core ^0.10.15 clears 2 of 3 bun audit advisories

## [0.2.5](changelog/0.2.x/0.2.5.md) — 2026-07-15

Added: selectable series (#20) and named point expansion (#24); search_articles/get_tv_clips return continuationWindows instead of a dead-end cap notice (#21)

## [0.2.4](changelog/0.2.x/0.2.4.md) — 2026-07-15

Fixed: content[] omitted array data five tools returned in full in structuredContent (#19); gdelt_get_coverage_breakdown now documents its normalized values (#10)

## [0.2.3](changelog/0.2.x/0.2.3.md) — 2026-07-15

Fixed: unpaired date-range boundaries silently ignored (#22) and confusing GDELT query-rejection errors (#18); mcp-ts-core ^0.10.9 → ^0.10.14 clears 8 transitive advisories; new install-time supply-chain guard

## [0.2.2](changelog/0.2.x/0.2.2.md) — 2026-06-20

Maintenance: @cyanheads/mcp-ts-core ^0.10.6 → ^0.10.9, biome 2.5 + dev-dep refresh, re-synced framework skills/scripts, and the new dependency-specifier + plugin-manifest devcheck guards

## [0.2.1](changelog/0.2.x/0.2.1.md) — 2026-06-12

Adopt mcp-ts-core ^0.10.6, set explicit createApp name/title identity, MCPB bundle hygiene (clean-mcpb + packaging guards), Dockerfile healthcheck and version labels

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-06-08

Rate-limiter abort signal, get_tv_context date-range params, resolved-timespan echoes, cap-hit notices, @types/node bump

## [0.1.8](changelog/0.1.x/0.1.8.md) — 2026-06-04

Fix multi-station TV query syntax, clipsAnalyzed false-zero, and trending recovery hint

## [0.1.7](changelog/0.1.x/0.1.7.md) — 2026-06-02

mcp-ts-core 0.9.21: per-request log context fix, secret-stripping in fetchWithTimeout, withRetry fail-fast on non-retryable errors; updated scripts and synced skills

## [0.1.6](changelog/0.1.x/0.1.6.md) — 2026-05-30

enrichment adoption: query/filter echoes, result counts, and empty-result guidance surface in a typed enrichment block on all search and analysis tools

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-05-28

mcp-ts-core ^0.9.13: HTTP 413 body cap, session-init gate, quieter error logs, GET /mcp keywords; public landing page; hosted endpoint

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-05-26

Package metadata, install badges, Docker image, bun run scripts

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-05-25

Fix Docker build — invoke tsc/tsc-alias directly instead of via bun run to avoid tsx/Bun module resolution failure on Linux

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-05-25

Add mcpName to package.json and publish-mcp script; trim server.json description to fit MCP Registry 100-char limit

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-05-25

Fix 7 API contract bugs — wrong response keys, invalid query modes, and empty-response handling across TV and DOC tools

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-05-25

Initial release — 9 tools for GDELT DOC and TV API search, timelines, tone analysis, and TV transcript coverage
