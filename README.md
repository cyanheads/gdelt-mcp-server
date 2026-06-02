<div align="center">
  <h1>@cyanheads/gdelt-mcp-server</h1>
  <p><b>Search and analyze global news coverage and US television transcripts via the GDELT Project's real-time APIs via MCP. STDIO or Streamable HTTP.</b>
  <div>9 Tools</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.7-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/gdelt-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/gdelt-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/gdelt-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/gdelt-mcp-server/releases/latest/download/gdelt-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=gdelt-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvZ2RlbHQtbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22gdelt-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fgdelt-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://gdelt.caseyjhand.com/mcp](https://gdelt.caseyjhand.com/mcp)

</div>

---

## Tools

Nine tools across two GDELT APIs — DOC API for global print/web news (last 3 months, 65 languages, no auth) and TV API for US television transcripts (2009–Oct 2024, 150+ stations):

| Tool | Description |
|:---|:---|
| `gdelt_search_articles` | Search the last 3 months of global news coverage (65 languages) with full-text and filter operators. Returns up to 250 articles. |
| `gdelt_get_coverage_timeline` | Retrieve a time series of coverage volume or average tone for a query. `volume_with_articles` mode includes top articles per spike timestep. |
| `gdelt_get_tone_distribution` | Get a tone histogram (bins ~−30 to +30) showing whether coverage is uniformly negative, bimodal, or clustered near neutral. |
| `gdelt_get_coverage_breakdown` | Break down coverage volume by source language or source country — a multi-series time series showing geographic propagation. |
| `gdelt_search_tv` | Search US television news closed captions (2009–Oct 2024) and return per-station airtime time series. |
| `gdelt_get_tv_clips` | Retrieve up to 3,000 matching TV clips with transcript excerpts and Internet Archive viewing links. |
| `gdelt_get_tv_context` | Get the 200 most frequent co-occurring words and phrases from TV clips matching a query. |
| `gdelt_get_tv_trending` | Retrieve trending topics currently dominating US television news (updated every 15 minutes; no query required). |
| `gdelt_list_tv_stations` | List all TV stations with market, network, and monitoring date ranges to verify station availability before querying. |

### `gdelt_search_articles`

Search the last 3 months of global news with GDELT's full query syntax.

- Keywords, phrases (`"bird flu"`), boolean OR, and exclusion (`-sports`)
- Filter operators: `sourcecountry:`, `sourcelang:`, `domain:`, `theme:` (GKG taxonomy), `tone<`/`tone>`
- Proximity and repetition: `near20:"flu virus"`, `repeat3:"outbreak"`
- Configurable sort (relevance, date) and result count (up to 250)
- Returns URL, title, publication date, domain, language, source country, and social image URL
- Query is echoed in response for chaining

---

### `gdelt_get_coverage_timeline`

Retrieve when coverage of a topic spiked, with three modes:

- `volume` — normalized percentage of all global coverage per timestep
- `volume_with_articles` — volume plus top articles driving each spike; use for signal detection without a follow-up search call
- `tone` — average sentiment score per timestep (combine with `gdelt_get_tone_distribution` for the full picture)
- Configurable smoothing and time range

---

### `gdelt_get_tone_distribution`

Snapshot tone histogram across all articles matching a query.

- Bins from approximately −30 to +30; each bin includes representative article URLs
- Summary fields: `peakNegativeBin`, `peakPositiveBin`, `neutralPct` (% of articles in the −2 to +2 range)
- Distinct from the tone timeline — distribution across all matching articles, not over time

---

### `gdelt_get_coverage_breakdown`

Multi-series time series showing which countries or languages drove coverage.

- Break down by `language` or `country`
- Top 10 series by total volume; remaining series aggregated into an "Other" bucket
- Use to trace how a story propagated geographically

---

### `gdelt_search_tv`

Search US television news transcripts (2009–Oct 2024) with per-station airtime analysis.

- Structured `stations` parameter (e.g. `["CNN", "FOXNEWS"]`) — the server embeds station filters in the query string
- Normalize results to relative % or return raw counts
- TV-specific operators: `market:`, `show:`, `context:`
- Use `gdelt_list_tv_stations` to verify station active date ranges before querying recent events

---

### `gdelt_get_tv_clips`

Retrieve actual TV news clips driving a coverage signal.

- Up to 3,000 clips per call
- Each clip: show name, station, air timestamp, 15-second transcript excerpt, direct Archive.org link, and optional thumbnail
- Sort by relevance, date descending, or date ascending

---

### `gdelt_get_tv_context`

Vocabulary framing analysis for TV coverage of a topic.

- Returns the 200 most frequent non-stopword terms from matching clips
- Relative frequency scores (query term = 100)
- Use to identify narrative framing, related concepts, or follow-up search terms

---

### `gdelt_get_tv_trending`

Zero-argument entry point for the current TV news cycle.

- Returns trending topics, keywords, and phrases dominating national networks
- Updated every 15 minutes
- Note: coverage data ends Oct 2024; results reflect the archive endpoint, not a live feed

---

### `gdelt_list_tv_stations`

Station metadata lookup before querying.

- All available stations with market, network, monitoring start date, and end date
- `isActive` flag — `true` when end date is within the last 24 hours
- Use to verify a station was active during a target time period

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool definitions — single file per tool, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats
- Pluggable auth: `none`, `jwt`, `oauth`
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

GDELT-specific:

- Shared rate-limit queue (1 req/5s) across all tools — enforces GDELT's published limit without caller coordination
- Two service layers (`GdeltDocService`, `GdeltTvService`) mapping clean tool parameters to the DOC and TV API URL conventions
- TV station filter operators embedded in query strings internally — callers pass structured `stations` arrays, not raw query syntax

Agent-friendly output:

- Query echo on every response — searches return the original query and applied timespan so agents can chain calls without re-deriving parameters
- Discriminated series labels — timeline and breakdown responses carry typed `label` fields (`"Volume Intensity"`, `"Average Tone"`, language/country names) rather than positional arrays
- Structured station metadata — `isActive` boolean and ISO 8601 date fields let agents reason about TV station availability without parsing date strings
- Partial-coverage signals in distribution output — `neutralPct`, `peakNegativeBin`, `peakPositiveBin` summary fields let agents branch on sentiment without histogramming the raw bins themselves

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

- [Bun v1.3.0](https://bun.sh/) or higher (or Node.js v24+).
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
| `GDELT_REQUEST_DELAY_MS` | Minimum milliseconds between GDELT requests (enforces 1 req/5s limit). | `5100` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for the HTTP server. | `3010` |
| `MCP_HTTP_ENDPOINT_PATH` | HTTP endpoint path where the MCP server is mounted. | `/mcp` |
| `MCP_PUBLIC_URL` | Public origin override for TLS-terminating reverse-proxy deployments. | none |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `MCP_GC_PRESSURE_INTERVAL_MS` | Opt-in Bun-only forced-GC pressure loop in ms. Try `60000` if heap growth is observed under sustained HTTP load. | `0` (disabled) |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<project-root>/logs` |
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
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). Nine tools across DOC and TV APIs. |
| `src/services/gdelt-doc` | `GdeltDocService` — wraps the DOC API for article search, timelines, tone, and breakdowns. |
| `src/services/gdelt-tv` | `GdeltTvService` — wraps the TV API for transcript search, clips, context, and trending. |
| `src/services/gdelt-rate-limiter` | `GdeltRateLimiter` singleton — shared 1 req/5s queue across both services. |
| `tests/` | Unit and integration tests mirroring `src/`. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools via the barrels in `src/mcp-server/tools/definitions/index.ts`
- Wrap GDELT API calls: validate raw JSON → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.
