# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

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
