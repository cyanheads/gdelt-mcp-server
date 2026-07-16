# gdelt-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `gdelt_search_articles` | Search the last 3 months of global news coverage (65 languages) with full-text and filter operators. Query supports phrases, boolean OR, `sourcecountry:`, `sourcelang:`, `domain:`, `theme:` (GKG taxonomy), `tone<`/`tone>`, `near:`, and `repeat:` operators. Returns up to 250 articles with URL, title, source country, language, publication date, and social image URL. | `query`, `timespan`, `startDatetime`, `endDatetime`, `maxRecords`, `sort` | `readOnlyHint: true`, `openWorldHint: true` |
| `gdelt_get_coverage_timeline` | Retrieve a time series showing when coverage of a topic spiked — either as normalized volume (% of all global coverage) or as average tone. Use `mode: volume_with_articles` for the signal-detection workflow: each timestep includes the top articles that drove that spike, so a single call reveals both the spike and its cause. Tone timeline shows sentiment shifts over time; combine with `gdelt_get_tone_distribution` for the full tonal picture. | `query`, `mode` (volume \| volume_with_articles \| tone), `timespan`, `startDatetime`, `endDatetime`, `smoothing` | `readOnlyHint: true`, `openWorldHint: true` |
| `gdelt_get_tone_distribution` | Get the tonal distribution of articles matching a query as a histogram (bins from ~-30 to +30). Unlike a single average tone score, the histogram reveals whether coverage is uniformly negative, bimodal (some extremely positive, some extremely negative), or clustered near neutral. Each bin includes representative article URLs. Distinct from `gdelt_get_coverage_timeline` (mode: tone) — this is a snapshot distribution across all matching articles, not a time series. | `query`, `timespan`, `startDatetime`, `endDatetime` | `readOnlyHint: true`, `openWorldHint: true` |
| `gdelt_get_coverage_breakdown` | Break down coverage volume over time by source language or source country, returning a multi-series time series (one series per language or country). Shows which countries or languages drove early vs. late coverage — useful for tracing how a story propagated geographically. Returns the top 10 series by total volume to keep output size manageable; remaining series are aggregated into an "Other" bucket. Values are normalized — the topic's share of media output, not absolute article counts, so small media markets with concentrated coverage rank above large markets with diverse output. | `query`, `breakdownBy` (language \| country), `timespan`, `startDatetime`, `endDatetime` | `readOnlyHint: true`, `openWorldHint: true` |
| `gdelt_search_tv` | Search US television news closed captions (2009–Oct 2024, 150+ stations) for spoken mentions of a query. Returns a normalized per-station time series showing relative airtime devoted to the topic. Use `stations` to compare specific networks (e.g. CNN vs. FOXNEWS); omit to get combined national coverage. TV query also supports `market:`, `show:`, and `context:` operators. Note: most station monitoring ended Oct 2024 — use `gdelt_list_tv_stations` to verify active date ranges before querying recent events. | `query`, `stations` (array of station IDs), `timespan`, `startDatetime`, `endDatetime`, `smoothing`, `normalize` | `readOnlyHint: true`, `openWorldHint: true` |
| `gdelt_get_tv_clips` | Retrieve the top matching TV news clips (up to 3,000) for a query from the Internet Archive's Television News Archive. Each clip includes show name, station, air timestamp, a 15-second transcript excerpt, and a direct link to view the full one-minute clip. Use after `gdelt_search_tv` to read the actual content driving a coverage spike. | `query`, `stations`, `timespan`, `maxRecords`, `sort` (relevance \| dateDesc \| dateAsc) | `readOnlyHint: true`, `openWorldHint: true` |
| `gdelt_get_tv_context` | Get the top co-occurring words and phrases from TV news clips matching a query — the vocabulary framing a topic on television. Returns the most frequent non-stopword terms from matching clips, with relative frequency scores. Use to understand narrative framing, identify related concepts, or generate follow-up search terms. | `query`, `stations`, `timespan` | `readOnlyHint: true`, `openWorldHint: true` |
| `gdelt_get_tv_trending` | Retrieve trending topics, keywords, and phrases currently dominating US television news across national networks. Updated every 15 minutes. No query required — returns the top memes of the present news cycle. Note: coverage data ends Oct 2024; results reflect that archive endpoint, not a live feed. | *(none)* | `readOnlyHint: true`, `openWorldHint: true` |
| `gdelt_list_tv_stations` | List all television stations available for TV search with their market, network, monitoring start date, and monitoring end date. Stations with an end date within the last 24 hours are considered active; stations with earlier end dates are discontinued. Use before querying to verify a station was active during the target time period. | *(none)* | `readOnlyHint: true`, `openWorldHint: false` |

### Resources

None planned. All data is query-driven and time-bounded — no stable addressable entities.

### Prompts

None planned for v1.

---

## Overview

gdelt-mcp-server exposes the GDELT (Global Database of Events, Language, and Tone) Project's real-time APIs for monitoring global news media. GDELT indexes 100+ languages across every country, updating every 15 minutes, and applies NLP to extract themes, sentiment, people, organizations, and locations from every article. It also separately monitors closed captions from 150+ US TV news stations back to 2009.

This server targets two primary APIs:
- **DOC API** — full-text search over the last 3 months of global news with volume, tone, and language breakdowns
- **TV API** — television news transcript search from 2009 through October 2024 with per-station volume analysis (archive feed stopped updating around Oct 2024)

No auth required. Rate limit: 1 request per 5 seconds (enforced by the server). Data is free to use and redistribute with attribution to the GDELT Project.

## Requirements

- Full-text search across last 3 months of global news in 65 languages (DOC API)
- Coverage volume timeline showing when a topic spiked in the news
- Average tone timeline and tone distribution histogram for sentiment analysis
- Breakdown by source country and language to map geographic attention
- Television news transcript search (2009–Oct 2024) across 150+ US stations
- Per-station TV airtime comparison for network-level coverage analysis
- TV clip retrieval with transcript snippets and Archive.org viewing links
- TV word cloud / co-occurrence vocabulary for framing analysis
- Live TV trending topics updated every 15 minutes
- No authentication required
- Rate limiting to 1 req/5s (with per-call minimum delay in service layer)
- DOC query syntax: keywords, phrases, boolean OR, `domain:`, `sourcecountry:`, `sourcelang:`, `theme:`, `tone<`, `near:`, `repeat:`
- TV query syntax: keywords, phrases, boolean OR, `station:`, `network:`, `market:`, `show:`, `context:`

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `GdeltDocService` | DOC API (`/api/v2/doc/doc`) | `gdelt_search_articles`, `gdelt_get_coverage_timeline`, `gdelt_get_tone_distribution`, `gdelt_get_coverage_breakdown` |
| `GdeltTvService` | TV API (`/api/v2/tv/tv`) | `gdelt_search_tv`, `gdelt_get_tv_clips`, `gdelt_get_tv_context`, `gdelt_get_tv_trending`, `gdelt_list_tv_stations` |

Both services share a single rate-limit queue (1 req/5s across all calls) implemented in a `GdeltRateLimiter` singleton.

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `GDELT_BASE_URL` | No | Override base URL for both APIs (default: `https://api.gdeltproject.org/api/v2`) |
| `GDELT_REQUEST_DELAY_MS` | No | Minimum milliseconds between requests (default: 5100 to satisfy 1 req/5s limit) |

No API key required.

## Implementation Order

1. Config and server setup (`server-config.ts`)
2. Rate limiter utility (`GdeltRateLimiter`)
3. `GdeltDocService` — article search + timeline modes
4. `GdeltTvService` — TV search + clip + station modes
5. Read-only tools (all tools in this server are read-only)
6. Format functions for each tool output

Each step is independently testable.

---

## Output Schemas

### `gdelt_search_articles`
```ts
{
  articles: Array<{
    url: string;           // article URL
    title: string;         // article title
    seendate: string;      // ISO 8601 publication datetime
    domain: string;        // source domain
    language: string;      // e.g. "English", "Spanish"
    sourcecountry: string; // e.g. "United States"
    socialimage?: string;  // social sharing image URL if available
  }>;
  totalReturned: number;
  query: string;           // echoed query for chaining
  timespan: string;        // echoed timespan
}
```

### `gdelt_get_coverage_timeline`
```ts
{
  query: string;
  mode: 'volume' | 'volume_with_articles' | 'tone';
  dateResolution: 'hour' | 'day';
  series: Array<{
    label: string;  // "Volume Intensity" or "Average Tone"
    data: Array<{
      date: string;   // ISO 8601
      value: number;  // normalized % (volume) or avg score (tone), -100 to +100
      articles?: Array<{ url: string; title: string }>;  // volume_with_articles only
    }>;
  }>;
}
```

### `gdelt_get_tone_distribution`
```ts
{
  query: string;
  histogram: Array<{
    bin: number;  // tone bin integer (typically -30 to +30)
    count: number;
    articles: Array<{ url: string; title: string }>;  // top articles in this bin
  }>;
  summary: {
    peakNegativeBin: number;
    peakPositiveBin: number;
    neutralPct: number;  // % of articles in -2 to +2 range
  };
}
```

### `gdelt_get_coverage_breakdown`
```ts
{
  query: string;
  breakdownBy: 'language' | 'country';
  dateResolution: 'hour' | 'day';
  topSeries: Array<{        // top 10 by total volume
    label: string;          // language name or country name
    data: Array<{ date: string; value: number }>;  // normalized share of media output, not article counts
  }>;
  otherAggregated?: Array<{ date: string; value: number }>;  // remaining series combined; same normalized scale
  seriesCount: number;      // total series before truncation
}
```

### `gdelt_search_tv`
```ts
{
  query: string;
  dateResolution: 'hour' | 'day' | 'month';
  timeRange: { start: string; end: string };
  series: Array<{
    station: string;   // e.g. "CNN"
    data: Array<{ date: string; value: number }>;  // normalized % or raw count
  }>;
  normalized: boolean;
}
```

### `gdelt_get_tv_clips`
```ts
{
  query: string;
  clips: Array<{
    show: string;        // show name
    station: string;     // station ID
    date: string;        // ISO 8601 air datetime
    snippet: string;     // 15-second transcript excerpt
    archiveUrl: string;  // Internet Archive clip URL
    thumbnail?: string;  // clip thumbnail URL if available
  }>;
  totalReturned: number;
}
```

### `gdelt_get_tv_context`
```ts
{
  query: string;
  words: Array<{
    label: string;   // co-occurring word/phrase
    score: number;   // relative frequency score (0-100, query term = 100)
  }>;
  clipsAnalyzed: number;
}
```

### `gdelt_list_tv_stations`
```ts
{
  stations: Array<{
    stationId: string;   // e.g. "CNN"
    description: string;
    market: string;      // e.g. "National", "San Francisco"
    network: string;
    startDate: string;   // ISO 8601
    endDate: string;     // ISO 8601
    isActive: boolean;   // endDate within last 24h
  }>;
  activeCount: number;
  totalCount: number;
}
```

---

## Domain Mapping

### DOC API — nouns and operations

| Noun | Operations |
|:-----|:-----------|
| Articles | search (artlist), by tone filter, by source country, by language, by theme, by domain |
| Coverage volume | timeline by day/hour/15min, with top articles per step |
| Tone | timeline over time, distribution histogram |
| Language breakdown | coverage volume per language over time |
| Source country | coverage volume per country over time |

### TV API — nouns and operations

| Noun | Operations |
|:-----|:-----------|
| TV clips | search (clip gallery), sort by date or relevance |
| Station volume | timeline per station, normalized or raw |
| Station chart | % of coverage from each station |
| Word cloud | co-occurring words in matching clips |
| Trending topics | current top topics across national networks |
| Station metadata | list all stations with monitoring date ranges |

---

## Workflow Analysis

### `gdelt_get_coverage_timeline`

Used for: "When did coverage of X spike?" / pandemic signal detection workflow

| Mode | DOC API `mode` param | Returns |
|:-----|:---------------------|:--------|
| `volume` | `timelinevol` | Normalized % of all global coverage per timestep |
| `volume_with_articles` | `timelinevolinfo` | Same as volume + top 10 articles per spike timestep |
| `tone` | `timelinetone` | Average sentiment score per timestep |

The `volume_with_articles` mode is the key signal-detection mode — it lets an agent identify a spike and immediately see what was driving it without a follow-up `gdelt_search_articles` call.

### Signal detection chain (pandemic use case)

**Important constraint:** The DOC API only covers the last 3 months. Retrospective signal detection (e.g., "when did COVID coverage first appear in early 2020") requires the TV API's historical reach (2009–Oct 2024) or GDELT's BigQuery raw data, which is out of scope for this server. For ongoing/recent topics within the last 3 months, the full chain works:

1. `gdelt_get_coverage_timeline` (mode: `volume_with_articles`, query: `"respiratory illness" OR pneumonia OR "unknown fever"`) → identify early coverage spikes with representative articles
2. `gdelt_get_coverage_breakdown` (breakdownBy: `country`) → see which countries drove early coverage vs. which caught on later
3. `gdelt_get_tone_distribution` → understand emotional temperature of coverage at peak
4. `gdelt_search_tv` → check if TV coverage tracked or lagged print media (note: TV data ends Oct 2024)
5. Cross-chain to WHO (who_query_indicator_data) or pubmed_search_articles to compare official report timing vs. media signal

### TV network comparison

1. `gdelt_search_tv` (stations: multiple networks, normalize: true) → compare per-station coverage intensity
2. `gdelt_get_tv_context` → see what vocabulary/framing each network used
3. `gdelt_get_tv_clips` → retrieve actual transcript snippets for qualitative review

---

## Design Decisions

### GEO API excluded

The GDELT GEO 2.0 API (`/api/v2/geo/geo`) returns HTTP 404 for all requests as of 2026-05-25, including the exact example URLs from its official documentation. It appears to be defunct. Geographic analysis of coverage can be approximated via `gdelt_get_coverage_breakdown` with `breakdownBy: "country"` for source-country breakdowns, which remains functional.

### TV station syntax: in-query operators, not URL params

The TV API requires station, network, market, and show filters embedded in the `query` string (e.g. `pandemic station:CNN`) rather than as separate URL parameters. The tools accept these as structured parameters and build the query string internally to shield callers from this quirk.

### DOC API 3-month window vs. TV API 15-year window

These are fundamentally different windows: DOC is near-real-time but short (3 months), TV is historical but TV-only (2009–present). The split into separate tools (`gdelt_search_articles` vs `gdelt_search_tv`) makes this constraint explicit rather than letting an agent discover it mid-workflow.

### `gdelt_get_coverage_timeline` mode consolidation

Coverage volume and tone-over-time are consolidated under one tool with a `mode` enum rather than split into `gdelt_get_volume_timeline` and `gdelt_get_tone_timeline`. Both return the same shape (time series), both take the same query parameters, and separating them into two tools would create decision overhead for an agent that just wants "the timeline for this topic."

### `volume_with_articles` mode in timeline

The DOC API's `timelinevolinfo` mode returns top articles per timestep alongside the volume values. This is surfaced as the `volume_with_articles` mode option because it's the primary tool for the signal-detection use case — agents can see spikes and their driving articles in a single call rather than needing to separately call `gdelt_search_articles` for each spike point.

### TV trending requires no query

`gdelt_get_tv_trending` is a zero-argument tool. The TV API's `trendingtopics` mode returns the current top memes without a query, and exposing it as a distinct tool (vs. a mode on `gdelt_search_tv`) makes it discoverable as a "what's happening right now on TV" entry point.

---

## Known Limitations

- **DOC API searches last 3 months only.** No historical article search beyond 90 days. For historical analysis, the GDELT raw data files (BigQuery) are the only option — out of scope for this server.
- **GEO API is defunct.** Point-level and country-level geographic heat maps from the GEO 2.0 API are unavailable. Source-country breakdown via the DOC API is a partial substitute.
- **TV API coverage gap post-Oct 2024.** Most TV stations in the station list have end dates of October 2024, suggesting the Internet Archive's Television News Archive feed into GDELT TV stopped being updated around that time. Recent TV queries will return thin or zero results.
- **Rate limit: 1 req/5s.** Tools that call multiple API modes must serialize calls. Multi-step workflows (e.g. tone + volume + article list) will take 15+ seconds.
- **DOC API article fields are sparse.** The article list returns URL, title, seendate, socialimage, domain, language, and sourcecountry only — no article text, no author, no full metadata. Full content requires fetching the source URL directly.
- **Theme taxonomy is opaque.** The `theme:` query operator references an internal GKG taxonomy (e.g. `DISEASE_OUTBREAK`, `TERROR`). The lookup file is available at `http://data.gdeltproject.org/api/v2/guides/LOOKUP-GKGTHEMES.TXT` but is not surfaced as a tool in v1.

---

## API Reference

### Query syntax (DOC API)

| Operator | Example | Effect |
|:---------|:--------|:-------|
| Phrase | `"bird flu"` | Exact phrase match |
| Boolean OR | `(flu OR pandemic OR outbreak)` | Any of the terms |
| Exclude | `-sports` | Exclude the term |
| Source country | `sourcecountry:china` | Articles from Chinese outlets |
| Source language | `sourcelang:spanish` | Spanish-language articles |
| Domain | `domain:who.int` | Articles from a specific domain |
| Theme | `theme:DISEASE_OUTBREAK` | GKG taxonomy theme |
| Tone filter | `tone<-5` | Articles more negative than -5 |
| Proximity | `near20:"flu virus"` | Terms within 20 words of each other |
| Repeat | `repeat3:"outbreak"` | Word appears ≥3 times in article |

### TV query syntax (additional operators)

| Operator | Example | Effect |
|:---------|:--------|:-------|
| Station | `station:CNN` | CNN only |
| Network | `network:CBS` | All CBS affiliates |
| Market | `market:"National"` | Major national networks |
| Show | `show:"Anderson Cooper 360"` | Specific show |
| Context | `context:"vaccine"` | Term in adjacent 15s clip |

### DOC API modes → tool mapping

| DOC mode | Tool | Notes |
|:---------|:-----|:------|
| `artlist` | `gdelt_search_articles` | |
| `timelinevol` | `gdelt_get_coverage_timeline` (mode: `volume`) | |
| `timelinevolinfo` | `gdelt_get_coverage_timeline` (mode: `volume_with_articles`) | Includes top articles per spike |
| `timelinetone` | `gdelt_get_coverage_timeline` (mode: `tone`) | |
| `tonechart` | `gdelt_get_tone_distribution` | Histogram, not time series |
| `timelinelang` | `gdelt_get_coverage_breakdown` (breakdownBy: `language`) | |
| `timelinesourcecountry` | `gdelt_get_coverage_breakdown` (breakdownBy: `country`) | |

### Rate limits

- 1 request per 5 seconds (HTTP 429 when exceeded; error body: "Please limit requests to one every 5 seconds")
- No published daily/monthly quota
- Cache-Control: `public, max-age=900` (15 minutes) on all responses — implement HTTP-level caching in service layer to avoid duplicate calls
