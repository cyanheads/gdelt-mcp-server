<div align="center">
  <h1>@cyanheads/gdelt-mcp-server</h1>
  <p><b>Search and analyze global news coverage and US television transcripts from the GDELT Project's real-time APIs via MCP. STDIO or Streamable HTTP.</b>
  <div>10 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.8.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/gdelt-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.4.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/gdelt-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/gdelt-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/gdelt-mcp-server/releases/latest/download/gdelt-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=gdelt-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvZ2RlbHQtbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22gdelt-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fgdelt-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://gdelt.caseyjhand.com/mcp](https://gdelt.caseyjhand.com/mcp)

</div>

---

## Overview

News and TV coverage analysis from the GDELT Project: the last 3 months of global news in 65+ languages, and historical TV transcripts across 150+ stations, with coverage dates varying by station. Search articles and clips, track coverage spikes, analyze tone, and compare coverage across languages, countries, stations, and shows.

### Tools

| Tool | Description |
|:---|:---|
| `gdelt_search_articles` | Search recent global news with full-text and filter operators. Returns every fetched in-window article, up to 250 per call, with date-window continuation guidance at the provider ceiling. |
| `gdelt_get_coverage_timeline` | Track normalized coverage, raw matching-article counts with monitored denominators, or average tone. Expand supplied article references for selected timesteps. |
| `gdelt_get_tone_distribution` | Get a tone histogram (bins ~−30 to +30) showing whether coverage is uniformly negative, bimodal, or clustered near neutral. |
| `gdelt_get_coverage_breakdown` | Compare coverage by source language or source country. Values are normalized shares of each source population's media output, not additive article counts. |
| `gdelt_search_themes` | Find GKG theme identifiers for the `theme:` operator the DOC tools accept — `drought` finds `NATURAL_DISASTER_DROUGHT`, `cyberattack` finds `CYBER_ATTACK` — ranked by the count GDELT's theme lookup lists. |
| `gdelt_search_tv` | Search television news closed captions and return separate station timelines or pooled coverage. |
| `gdelt_get_tv_breakdown` | Rank stations by airtime share or matching-clip count, and shows by share of matching clips. |
| `gdelt_get_tv_clips` | Retrieve up to 3,000 matching TV clips with transcript excerpts and Internet Archive viewing links, returning every fetched in-window clip. |
| `gdelt_get_tv_context` | Get the most frequent co-occurring words and phrases from GDELT's relevance-ranked sample of TV clips matching a query. |
| `gdelt_list_tv_stations` | List TV stations with market, network, and monitoring date ranges — all of them, or filtered by station ID, network, or market — to verify station availability before querying. |

## Capability reference

### `gdelt_search_articles` <sub>tool</sub>

- Full GDELT query syntax: phrases, boolean OR, exclusion, filter operators (`sourcecountry:`, `sourcelang:`, `domain:`, `theme:`, `tone<`/`tone>`), proximity (`near20:`) and repetition (`repeat3:`) — `gdelt_search_themes` finds the identifiers `theme:` takes
- Configurable sort (`relevance`, `dateDesc`, `dateAsc`, `toneDesc`, `toneAsc`, `hybridRel`) and fetch count, up to 250 per call; larger `maxRecords` values clamp to 250 by default
- Returns URL, title, publication date, domain, language, source country, and social image URL
- Returns every fetched in-window article. At the provider ceiling, `continuationWindows` gives narrower date windows to re-query (de-duplicate by `url`). The ceiling is not a cursor; an indivisible window can still contain more matches than GDELT returns
- Articles outside an explicit `startDatetime`/`endDatetime` window are dropped, and the notice counts them

---

### `gdelt_get_coverage_timeline` <sub>tool</sub>

- Four modes: `volume` (normalized % per timestep), `volume_raw` (matching-article counts with the monitored-article denominator `norm`), `volume_with_articles` (volume plus supplied top articles), and `tone` (average sentiment)
- Reference-bearing timesteps carry their first 3 links beside `referenceCount`, the number of references GDELT supplied, not all matching articles. `points: ["<date>"]` selects named timesteps with every supplied link; GDELT's reference list itself is capped at ten
- Pages whole timesteps with `offset` and `limit` (default 10, cap 400); `nextOffset` retrieves the next page. Each series' `pointCount` and `peak` cover the full series on every page
- Smoothing accepts 0–30 timesteps. Width N > 1 returns trailing moving averages: the first N−1 source steps cannot produce a value, and peaks can appear later. In `volume_raw`, smoothing changes `value`, not `norm`
- Time range uses `timespan` or explicit `startDatetime`/`endDatetime`; date resolution (`15min`/`hour`/`day`) is inferred from returned intervals
- A `points` date matching no timestep, or an `offset` past the last timestep, is rejected with the valid values

---

### `gdelt_get_tone_distribution` <sub>tool</sub>

- Histogram bins from approximately −30 to +30; each bin's `count` counts matching articles, while `referenceCount` counts supplied links. The default preview shows 3 links; `bins: [<bin>]` selects named bins with every supplied link. An unknown bin is rejected with the available bins
- Summary fields over the whole histogram: `peakNegativeBin`, `peakPositiveBin`, `neutralPct` (% of articles in the −2 to +2 range)
- Pages whole bins with `offset` and `limit` (default 10, cap 400), returning `nextOffset` when more remain. This is a snapshot across matching articles, unlike the tone timeline

---

### `gdelt_get_coverage_breakdown` <sub>tool</sub>

- Breaks down by `language` or `country` into a multi-series time series: the top 10 series by summed value, with every other series named in `otherSeriesLabels`
- `series: ["<label>"]` returns only those series, complete, under `selectedSeries`; a label matching no series is rejected with the available labels
- Pages whole series with `offset` and `limit` (default 10, cap 75), returning `nextOffset` when more remain. Copy exact labels from the response for `series` selections
- Smoothing accepts 0–30 timesteps with the same moving-average disclosure as coverage timelines
- Values are normalized shares of each source's media output, not article counts, so don't sum them across sources

---

### `gdelt_search_themes` <sub>tool</sub>

- Searches the identifiers in GDELT's [GKG theme lookup](https://data.gdeltproject.org/api/v2/guides/LOOKUP-GKGTHEMES.TXT) (59,315 themes); each match is the identifier, its listed count, and a paste-ready `operator` such as `theme:TAX_DISEASE_OUTBREAK`
- Case-insensitive, with no stemming or synonyms: words match parts of an identifier (`cyberattack` → `CYBER_ATTACK`, `plant disease` → `TAX_PLANTDISEASE`). If nothing matches, it retries once with a trailing `s` dropped (`protests` → `PROTEST`) and the notice says so
- Ranked by exact match, then listed count (a static prevalence figure, not a live article total), then identifier
- Pages with `offset` / `limit` (default 25, cap 100); larger limits clamp by default. `nextOffset` appears only when more matches remain, and an offset past a non-empty result fails `offset_out_of_range`
- Does not queue behind the DOC and TV rate limit

---

### `gdelt_search_tv` <sub>tool</sub>

- Structured `stations` (e.g. `["CNN", "FOXNEWS"]`) preserve the entire requested list. TV queries can also use station, network, or market selectors; verify IDs and coverage dates through the station catalog
- `normalize` toggles relative airtime % (default) vs. raw matching 15-second clip counts; optional `dateres` aggregation (`hour`/`day`/`week`/`month`/`year`). TV operators: `station:`, `network:`, `market:`, `show:`, `context:`
- Each series carries `station` (the ID the `stations` input takes, `FOXNEWS`) and `stationName` (GDELT's label, `FOX News`). If an ID can't be resolved, the series keeps `stationName` without `station` and the notice says so
- Pages points in date-then-station-name order (default 500, cap 20,000); pass `nextOffset` with the same inputs for the next page. The text surface's per-station count, sum, and peak cover only the returned page
- `combined: true` pools stations into a `Combined` timeline. Normalized values use pooled matching clips divided by pooled monitored clips, not an average of station percentages; no station ID is assigned to the combined series
- Smoothing accepts 0–30 timesteps and discloses leading-window loss and possible lag. Recognized upstream date resolution takes precedence over requested or inferred resolution
- Check station date ranges with `gdelt_list_tv_stations` before querying recent events

---

### `gdelt_get_tv_clips` <sub>tool</sub>

- Up to 3,000 clips fetched per call, sorted by relevance, date descending, or date ascending; larger `maxRecords` values clamp to 3,000 by default
- Each clip: show name, `station` and `stationName` (resolved as in `gdelt_search_tv`, so a series' `station` passes straight into `stations`), air timestamp, 15-second transcript excerpt, direct Archive.org link, and optional thumbnail
- The server requests whole clock hours, so any window width works; clips outside an explicit `startDatetime`/`endDatetime` window are dropped and counted in the notice (a `timespan` call drops nothing)
- Returns every fetched in-window clip. At the provider ceiling, `continuationWindows` gives narrower windows to re-query (de-duplicate by `archiveUrl`); whole-hour retrieval can still prevent reaching every match in a dense hour

---

### `gdelt_get_tv_breakdown` <sub>tool</sub>

- Station rankings report percentages of station airtime by default, or matching 15-second clip counts with `normalize: false`; resolvable rows include a station ID
- Show rankings always report percentages of matching clips, including when `normalize: false`. Labels are preserved exactly, but GDELT sometimes abbreviates them with ellipses, so they are not all reusable `show:` selectors
- Rows sort by descending value, then label, with `offset` / `limit` paging (default 25, cap 10,000), `totalRows`, and `nextOffset`

---

### `gdelt_get_tv_context` <sub>tool</sub>

- Returns the most frequent non-stopword terms co-occurring with the query
- Terms and scores come from GDELT's sample of the 200 most relevant matching clips, not all coverage; every non-empty response says so in `notice`. Compare windows or stations with a separate, narrower call for each
- Relative frequency scores 0–100, where the query term itself scores 100
- Terms sort by score and page with `offset` / `limit` (default 25, cap 25,000). `totalTerms` counts the returned vocabulary across all pages, not matching clips; `nextOffset` and `truncated` disclose remaining terms

---

### `gdelt_list_tv_stations` <sub>tool</sub>

- Returns every station with market, network, monitoring start date, and end date — or only those matching the optional `stations`, `network`, and `market` filters
- Filters match whole values case-insensitively and combine with AND (`network: "FOX"` does not match `FOXNEWS`); `activeCount` and `totalCount` count the returned stations
- A filter or station ID that matches nothing is named in the notice; `isActive` is true when the end date is within the last 24 hours
- Use to verify a station was active during a target period, or to find valid station IDs for the `stations` parameter on other TV tools

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

GDELT-specific:

- Shared request pacer across the DOC and TV tools: one request in flight at 1 req/5s, with a backoff (5s, doubling to 60s) after any rate-limit response
- Structured `stations` arrays instead of raw TV query syntax
- GKG theme lookup held in memory after first download

Agent-friendly output:

- Query echo on every response: the original query and applied timespan, so calls chain without re-deriving parameters
- Typed series `label` fields (`"Volume Intensity"`, `"Average Tone"`, language/country names) instead of positional arrays
- Station metadata with an `isActive` boolean and ISO 8601 dates
- Zero matches return the normal output shape with empty arrays and a `notice` on how to broaden the query

## Getting started

### Public Hosted Instance

A public instance is available at `https://gdelt.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "gdelt-mcp-server": {
      "type": "streamable-http",
      "url": "https://gdelt.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "gdelt-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/gdelt-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "gdelt-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/gdelt-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "gdelt-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "ghcr.io/cyanheads/gdelt-mcp-server:latest"
      ]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- No API key required — GDELT is a free public API.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/gdelt-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd gdelt-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env if you need to override defaults
```

## Configuration

All configuration is validated at startup via Zod schemas in `src/config/server-config.ts`. Key environment variables:

| Variable | Description | Default |
|:---------|:------------|:--------|
| `GDELT_BASE_URL` | Override the GDELT API base URL for both DOC and TV APIs. | `https://api.gdeltproject.org/api/v2` |
| `GDELT_REQUEST_DELAY_MS` | Minimum milliseconds between GDELT requests (enforces 1 req/5s limit). | `5300` |
| `GDELT_REQUEST_TIMEOUT_MS` | Deadline for a single GDELT request (a call with retries is bounded at twice this). | `60000` |
| `GDELT_CLAMP_LIMITS` | Clamp oversized positive integer counts to each tool's served cap, with `limitClamp`, a log, and a counter. Set `false` to reject above-cap counts instead. | `true` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for the HTTP server. | `3010` |
| `MCP_HTTP_ENDPOINT_PATH` | HTTP endpoint path where the MCP server is mounted. | `/mcp` |
| `MCP_PUBLIC_URL` | Public origin override for TLS-terminating reverse-proxy deployments. | none |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_SESSION_MODE` | HTTP session mode: `auto`, `stateful`, or `stateless`. | `stateless` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `MCP_GC_PRESSURE_INTERVAL_MS` | Opt-in Bun-only forced-GC loop interval in ms. | `0` (disabled) |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<app-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1`. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security audit
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t gdelt-mcp-server .
docker run --rm -p 3010:3010 gdelt-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/gdelt-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:----------|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools and inits services. |
| `src/config` | Server-specific environment variable parsing and validation with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Ten tools across the DOC and TV APIs and the GKG theme lookup. |
| `src/services/gdelt` | `GdeltDocService` and `GdeltTvService` wrapping the DOC and TV APIs, the shared outbound pacer every DOC and TV call queues behind, and `GdeltThemeService` for the GKG theme lookup. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools via the barrels in `src/mcp-server/tools/definitions/index.ts`
- Wrap GDELT API calls: validate raw JSON → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.
