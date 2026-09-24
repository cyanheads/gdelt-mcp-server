<div align="center">
  <h1>@cyanheads/gdelt-mcp-server</h1>
  <p><b>Search and analyze global news coverage and US television transcripts via the GDELT Project's real-time APIs via MCP. STDIO or Streamable HTTP.</b>
  <div>8 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.4.3-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/gdelt-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/gdelt-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/gdelt-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

News and television coverage analysis from the GDELT Project's DOC and TV APIs — the last 3 months of global news in 65+ languages, and US TV transcripts from 2009 through October 2024 across 150+ stations. Search articles and clips, track coverage spikes, analyze tone, and trace how a story propagated across languages and countries. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

| Tool | Description |
|:---|:---|
| `gdelt_search_articles` | Search the last 3 months of global news coverage (65+ languages) with full-text and filter operators. Fetches up to 250 articles, returns as many as fit a 48,000-byte response, and hands back the date windows to re-query for the rest. |
| `gdelt_get_coverage_timeline` | Retrieve a time series of coverage volume or average tone for a query. `volume_with_articles` mode includes top articles per spike timestep, with `points` to render a timestep's full article list. |
| `gdelt_get_tone_distribution` | Get a tone histogram (bins ~−30 to +30) showing whether coverage is uniformly negative, bimodal, or clustered near neutral. |
| `gdelt_get_coverage_breakdown` | Break down coverage volume by source language or source country — a multi-series time series showing geographic propagation. Values are normalized shares of media output, not article counts. |
| `gdelt_search_tv` | Search US television news closed captions (2009–Oct 2024) and return per-station airtime time series. |
| `gdelt_get_tv_clips` | Retrieve matching TV clips with transcript excerpts and Internet Archive viewing links — up to 3,000 fetched, as many as fit a 48,000-byte response returned — and the date windows to re-query for the rest. |
| `gdelt_get_tv_context` | Get the most frequent co-occurring words and phrases from TV clips matching a query. |
| `gdelt_list_tv_stations` | List TV stations with market, network, and monitoring date ranges — all of them, or filtered by station ID, network, or market — to verify station availability before querying. |

## Capability reference

### `gdelt_search_articles` <sub>tool</sub>

- Full GDELT query syntax: phrases, boolean OR, exclusion, filter operators (`sourcecountry:`, `sourcelang:`, `domain:`, `theme:`, `tone<`/`tone>`), proximity (`near20:`) and repetition (`repeat3:`)
- Configurable sort (`relevance`, `dateDesc`, `dateAsc`, `toneDesc`, `toneAsc`, `hybridRel`) and fetch count, up to 250 per call
- Returns URL, title, publication date, domain, language, source country, and social image URL
- Each response carries as many fetched articles as fit a 48,000-byte budget on each surface; the rest are counted in `withheldCount`, and the notice says how to reach them — never by raising `maxRecords`
- `continuationWindows` on a page cut under `dateDesc`/`dateAsc` holds one window resuming from the last returned article — or skipping past its second when every returned article shares it; under the other sorts, and whenever `maxRecords` sits at its 250 ceiling, it holds the queried window halved and overlapping by a second so nothing falls through the seam. Articles on a boundary second can come back twice — de-duplicate by `url`
- Articles GDELT returns from outside an explicit `startDatetime`/`endDatetime` window are dropped, and the notice counts them
- 250 is a hard per-call ceiling, not a page size — GDELT exposes no cursor, so narrowing the date window is the only way past it

---

### `gdelt_get_coverage_timeline` <sub>tool</sub>

- Three modes: `volume` (normalized % per timestep), `volume_with_articles` (volume plus top articles per spike — signal detection in one call), `tone` (average sentiment per timestep)
- Every article reference is always in `structuredContent`; the text surface renders the first 3 links per timestep beside that timestep's true count, and `points: ["<date>"]` renders named timesteps in full
- Configurable smoothing (0–5 timesteps) and time range (`timespan`, or explicit `startDatetime`/`endDatetime`)
- Date resolution (`15min`/`hour`/`day`) is inferred from the returned intervals, and omitted when fewer than two timesteps come back
- A `points` date matching no timestep is rejected with the available timestep list, rather than silently ignored

---

### `gdelt_get_tone_distribution` <sub>tool</sub>

- Histogram bins from approximately −30 to +30; each bin includes representative article URLs
- Summary fields: `peakNegativeBin`, `peakPositiveBin`, `neutralPct` (% of articles in the −2 to +2 range)
- A snapshot across all matching articles — distinct from the tone timeline (`gdelt_get_coverage_timeline` mode `tone`), which is a time series

---

### `gdelt_get_coverage_breakdown` <sub>tool</sub>

- Breaks down by `language` or `country` into a multi-series time series
- Top 10 series by total volume; the rest aggregate into `otherAggregated`, with every folded-in label named in `otherSeriesLabels`
- Pass any label to `series: ["<label>"]` to retrieve that series complete under `selectedSeries`, ranked or not
- Values are normalized shares of media output, not article counts — a high value means the topic dominated that source's coverage, not that it published the most articles
- A `series` label matching no series is rejected with the available label list, rather than silently skipped

---

### `gdelt_search_tv` <sub>tool</sub>

- Up to 10 structured `stations` (e.g. `["CNN", "FOXNEWS"]`), or a `station:` selector embedded in the query — the TV API requires at least one, either way
- `normalize` toggles relative airtime % (default) vs. raw matching 15-second clip counts; optional `dateres` aggregation (`hour`/`day`/`week`/`month`/`year`)
- Responses page at most 500 points per call in deterministic date-then-station order; use `nextOffset` with the same inputs to retrieve the next page
- TV-specific operators: `station:`, `network:`, `market:`, `show:`, `context:`
- Verify station active date ranges with `gdelt_list_tv_stations` before querying recent events

---

### `gdelt_get_tv_clips` <sub>tool</sub>

- Up to 3,000 clips fetched per call, sorted by relevance, date descending, or date ascending
- Each clip: show name, station, air timestamp, 15-second transcript excerpt, direct Archive.org link, and optional thumbnail
- The TV API answers a window in whole clock hours (start floored to the hour, the end's hour included) and rejects one under 30 minutes, so the server requests whole hours — any window width works; an end exactly on the hour leaves out that final second — and drops clips dated outside an explicit `startDatetime`/`endDatetime` window, counting them in the notice (a `timespan` call drops nothing)
- Each response carries as many in-window clips as fit a 48,000-byte budget on each surface; the rest are counted in `withheldCount`, and the notice says how to reach them. Below the 3,000 ceiling it says to continue at `maxRecords` 3,000, since each continuation request fetches whole hours and the clips outside its window take slots first
- `continuationWindows` on a page cut under `dateDesc`/`dateAsc` holds one window resuming from the last returned clip (de-duplicate by `archiveUrl`) — or skipping past its second when every returned clip shares it; under `relevance`, and whenever `maxRecords` sits at its 3,000 ceiling, it holds the window split in two — on a clock hour when one falls inside it, otherwise at the second on a cut page — with the halves sharing no second
- 3,000 is a hard per-call ceiling, not a page size — GDELT exposes no cursor, so narrowing the date window is the only way past it

---

### `gdelt_get_tv_context` <sub>tool</sub>

- Returns the most frequent non-stopword terms co-occurring with the query across matching clips
- Relative frequency scores 0–100, where the query term itself scores 100
- Use to identify narrative framing, related concepts, or follow-up search terms

---

### `gdelt_list_tv_stations` <sub>tool</sub>

- Returns every station with market, network, monitoring start date, and end date — or only those matching the optional `stations`, `network`, and `market` filters
- Filters match whole values case-insensitively and combine with AND (`network: "FOX"` does not match `FOXNEWS`); `activeCount` and `totalCount` count the returned stations
- A filter that matches nothing returns an empty list with a notice naming it, and requested station IDs that match no station are named in the notice
- The text surface groups stations as national (every `National*` market), international (`International`, `Japan`), and local/regional (US cities), each line naming its market
- `isActive` is true when the end date is within the last 24 hours
- Use to verify a station was active during a target time period, or to discover valid station IDs for the `stations` parameter on other TV tools

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

GDELT-specific:

- Shared outbound pacer across all tools — one request in flight at 1 req/5s, plus a cooldown gate that any GDELT rate-limit response closes for every queued caller (5s, doubling to 60s, reset by the next success)
- Two service layers (`GdeltDocService`, `GdeltTvService`) mapping clean tool parameters to the DOC and TV API URL conventions
- TV station filter operators embedded in query strings internally — callers pass structured `stations` arrays, not raw query syntax

Agent-friendly output:

- Query echo on every response — searches return the original query and applied timespan so agents can chain calls without re-deriving parameters
- Discriminated series labels — timeline and breakdown responses carry typed `label` fields (`"Volume Intensity"`, `"Average Tone"`, language/country names) rather than positional arrays
- Structured station metadata — `isActive` boolean and ISO 8601 date fields let agents reason about TV station availability without parsing date strings
- Partial-coverage signals in distribution output — `neutralPct`, `peakNegativeBin`, `peakPositiveBin` summary fields let agents branch on sentiment without histogramming the raw bins themselves
- Zero matches are a result, not an error — a query GDELT answers with nothing returns the normal output shape with empty arrays and a `notice` on how to broaden it; values that would have to be derived from returned data (`dateResolution`, `timeRange`, tone peaks, `neutralPct`) are omitted rather than defaulted

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
| `GDELT_REQUEST_TIMEOUT_MS` | Deadline for a single GDELT request. The whole call, retries included, is bounded at twice this value. | `60000` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for the HTTP server. | `3010` |
| `MCP_HTTP_ENDPOINT_PATH` | HTTP endpoint path where the MCP server is mounted. | `/mcp` |
| `MCP_PUBLIC_URL` | Public origin override for TLS-terminating reverse-proxy deployments. | none |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_SESSION_MODE` | HTTP session mode: `auto`, `stateful`, or `stateless`. `createApp()` declares `stateless` in code — this server holds no per-session state — and setting this variable overrides that declaration. | `stateless` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `MCP_GC_PRESSURE_INTERVAL_MS` | Opt-in Bun-only forced-GC pressure loop in ms. Try `60000` if heap growth is observed under sustained HTTP load. | `0` (disabled) |
| `LOGS_DIR` | Directory for log files (Node.js only). Absolute paths are used verbatim; a relative path resolves against the application root. | `<app-root>/logs` |
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
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Eight tools across DOC and TV APIs. |
| `src/services/gdelt` | `GdeltDocService` and `GdeltTvService` wrapping the DOC and TV APIs, plus the shared outbound pacer every call queues behind. |
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
