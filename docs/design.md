# gdelt-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `gdelt_search_articles` | Search the last 3 months of global news coverage (65 languages) with full-text and filter operators. Query supports phrases, boolean OR, `sourcecountry:`, `sourcelang:`, `domain:`, `theme:` (GKG taxonomy), `tone<`/`tone>`, `near:`, and `repeat:` operators. Fetches up to 250 articles with URL, title, source country, language, publication date, and social image URL, and returns as many as fit a 48,000-byte budget per surface; the rest are counted in `withheldCount`. 250 is a hard ceiling with no cursor past it — at the cap, or on a page cut to the budget, the response returns `continuationWindows` to re-query. A `maxRecords` up to 2,500 runs at 250 and is disclosed in `limitClamp`; above 2,500 it is rejected. | `query`, `timespan`, `startDatetime`, `endDatetime`, `maxRecords`, `sort` | `readOnlyHint: true`, `openWorldHint: true` |
| `gdelt_get_coverage_timeline` | Retrieve a time series showing when coverage of a topic spiked — either as normalized volume (% of all global coverage) or as average tone. Use `mode: volume_with_articles` for the signal-detection workflow: each timestep includes the top articles that drove that spike, so a single call reveals both the spike and its cause. Both surfaces carry the first 3 links per timestep beside `referenceCount`, its true count; `points` returns only the named timesteps, each in full. A response carries as many whole timesteps as fit a 48,000-byte budget per surface, with `nextOffset` for the next page. Tone timeline shows sentiment shifts over time; combine with `gdelt_get_tone_distribution` for the full tonal picture. | `query`, `mode` (volume \| volume_with_articles \| tone), `timespan`, `startDatetime`, `endDatetime`, `smoothing`, `points`, `offset` | `readOnlyHint: true`, `openWorldHint: true` |
| `gdelt_get_tone_distribution` | Get the tonal distribution of articles matching a query as a histogram (bins from ~-30 to +30). Unlike a single average tone score, the histogram reveals whether coverage is uniformly negative, bimodal (some extremely positive, some extremely negative), or clustered near neutral. Each bin carries its first 3 representative article links beside `referenceCount`; `bins` returns only the named bins, each in full. A response carries as many whole bins as fit a 48,000-byte budget per surface, with `nextOffset` for the next page; the summary covers the whole histogram. Distinct from `gdelt_get_coverage_timeline` (mode: tone) — this is a snapshot distribution across all matching articles, not a time series. | `query`, `timespan`, `startDatetime`, `endDatetime`, `bins`, `offset` | `readOnlyHint: true`, `openWorldHint: true` |
| `gdelt_get_coverage_breakdown` | Break down coverage volume over time by source language or source country, returning a multi-series time series (one series per language or country). Shows which countries or languages drove early vs. late coverage — useful for tracing how a story propagated geographically. Returns the top 10 series ranked by the sum of their values; every other series is named in `otherSeriesLabels`, and the `series` input returns only the named series, each complete, under `selectedSeries`. A response carries as many whole series as fit a 48,000-byte budget per surface, with `nextOffset` for the next page. Values are normalized — the topic's share of each source's media output, not absolute article counts, so small media markets with concentrated coverage rank above large markets with diverse output, and values from different sources are never summed into a share. | `query`, `breakdownBy` (language \| country), `timespan`, `startDatetime`, `endDatetime`, `series`, `offset` | `readOnlyHint: true`, `openWorldHint: true` |
| `gdelt_search_themes` | Find GKG theme identifiers for the `theme:` operator the four DOC tools accept, by matching query words against the identifiers in GDELT's GKG theme lookup (no labels exist). Every word must begin one of an identifier's `_`/`-`-separated parts or run across consecutive parts, or all the words joined must; one disclosed plural fallback on zero matches. Ranked exact identifier first, then by the lookup's listed count, then by identifier; each match carries a paste-ready `operator`. Pages of up to 100 matches; a `limit` up to 1,000 runs at 100 and is disclosed in `limitClamp`. | `query`, `offset`, `limit` | `readOnlyHint: true`, `openWorldHint: true` |
| `gdelt_search_tv` | Search US television news closed captions (2009–Oct 2024, 150+ stations) for spoken mentions of a query. Returns query-matching per-station coverage as normalized airtime percentages or raw 15-second clip counts. Up to 10 stations may be selected with `stations`, or a `station:` query operator can supply selection. Results are ISO-normalized; each series carries GDELT's label (`stationName`) and, when the label resolves, its station ID (`station`); page membership uses deterministic date-then-station-name order, and returned points are grouped by station. `nextOffset` retrieves the next page of up to 500 points; a `limit` up to 5,000 runs at 500 and is disclosed in `limitClamp`. | `query`, `stations`, `timespan`, `startDatetime`, `endDatetime`, `smoothing`, `normalize`, `dateres`, `offset`, `limit` | `readOnlyHint: true`, `openWorldHint: true` |
| `gdelt_get_tv_clips` | Retrieve the top matching TV news clips for a query from the Internet Archive's Television News Archive — up to 3,000 fetched, clips dated outside an explicit `startDatetime`/`endDatetime` window dropped, and as many as fit a 48,000-byte budget per surface returned; the rest are counted in `withheldCount`. Each clip includes show name, station label and — when the label resolves — station ID, air timestamp, a 15-second transcript excerpt, and a direct link to view the full one-minute clip. Use after `gdelt_search_tv`, passing a series' `station` as `stations`, to read the actual content driving a coverage spike. 3,000 is a hard ceiling with no cursor past it — at the cap, or on a page cut to the budget, the response returns `continuationWindows` to re-query. A `maxRecords` up to 30,000 runs at 3,000 and is disclosed in `limitClamp`; above 30,000 it is rejected. | `query`, `stations`, `timespan`, `startDatetime`, `endDatetime`, `maxRecords`, `sort` (relevance \| dateDesc \| dateAsc) | `readOnlyHint: true`, `openWorldHint: true` |
| `gdelt_get_tv_context` | Get the top co-occurring words and phrases from TV news clips matching a query — the vocabulary framing a topic on television. Returns the most frequent non-stopword terms, with relative frequency scores, from GDELT's relevance-ranked sample of matching clips (documented as the 200 most relevant), not all matching coverage. Use to understand narrative framing, identify related concepts, or generate follow-up search terms. | `query`, `stations`, `timespan`, `startDatetime`, `endDatetime` | `readOnlyHint: true`, `openWorldHint: true` |
| `gdelt_list_tv_stations` | List the television stations available for TV search with their market, network, monitoring start date, and monitoring end date — every station, or only those matching the optional `stations`, `network`, and `market` filters (exact, case-insensitive, combined with AND). Stations with an end date within the last 24 hours are considered active; stations with earlier end dates are discontinued. Use before querying to verify a station was active during the target time period. | `stations`, `network`, `market` (all optional) | `readOnlyHint: true`, `openWorldHint: true` |

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

It also reads GDELT's GKG theme lookup (`https://data.gdeltproject.org/api/v2/guides/LOOKUP-GKGTHEMES.TXT`) so callers can find the identifiers the DOC API's `theme:` operator takes.

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
- GKG theme identifier discovery for the DOC `theme:` operator
- No authentication required
- Rate limiting to 1 req/5s (with per-call minimum delay in service layer)
- DOC query syntax: keywords, phrases, boolean OR, `domain:`, `sourcecountry:`, `sourcelang:`, `theme:`, `tone<`, `near:`, `repeat:`
- TV query syntax: keywords, phrases, boolean OR, `station:`, `network:`, `market:`, `show:`, `context:`

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `GdeltDocService` | DOC API (`/api/v2/doc/doc`) | `gdelt_search_articles`, `gdelt_get_coverage_timeline`, `gdelt_get_tone_distribution`, `gdelt_get_coverage_breakdown` |
| `GdeltTvService` | TV API (`/api/v2/tv/tv`) | `gdelt_search_tv`, `gdelt_get_tv_clips`, `gdelt_get_tv_context`, `gdelt_list_tv_stations` |
| `GdeltThemeService` | GKG theme lookup file on `data.gdeltproject.org` | `gdelt_search_themes` |

The DOC and TV services queue behind a single outbound pacer (`src/services/gdelt/gdelt-pacer.ts`) — one request in flight, the request gap held from the *previous response's completion* rather than its start, and a shared cooldown gate a GDELT rate-limit response closes for every queued caller. GDELT's limiter counts from completion, and its answers routinely outrun the gap, so start-relative spacing alone leaves no gap at all. `GdeltThemeService` makes one request per process to a different host and bypasses the pacer (see [The GKG theme lookup is fetched once per process](#the-gkg-theme-lookup-is-fetched-once-per-process)).

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `GDELT_BASE_URL` | No | Override base URL for both APIs (default: `https://api.gdeltproject.org/api/v2`) |
| `GDELT_REQUEST_DELAY_MS` | No | Minimum milliseconds between requests (default: 5300 to satisfy 1 req/5s limit) |
| `GDELT_REQUEST_TIMEOUT_MS` | No | Deadline for a single request (default: 60000). The whole call, retries included, is bounded at twice this value |

No API key required.

## Implementation Order

1. Config and server setup (`server-config.ts`)
2. Outbound pacer (`gdelt-pacer.ts`)
3. `GdeltDocService` — article search + timeline modes
4. `GdeltTvService` — TV search + clip + station modes
5. Read-only tools (all tools in this server are read-only)
6. Format functions for each tool output

Each step is independently testable.

---

## Output Schemas

Each block is the tool's `structuredContent`: its `output` fields, then the `enrichment` fields
the framework merges in (also rendered as the `content[]` trailer).

### `gdelt_search_articles`
```ts
{
  articles: Array<{
    url: string;           // article URL
    title: string;         // article title
    seendate: string;      // GDELT format YYYYMMDDTHHMMSSZ
    domain: string;        // source domain
    language: string;      // e.g. "English", "Spanish"
    sourcecountry: string; // e.g. "United States"
    socialimage?: string;  // social sharing image URL if available
  }>;                      // the fetched prefix that fits the 48,000-byte budget, in upstream order
  // enrichment
  effectiveQuery: string;  // echoed query for chaining
  totalCount: number;      // articles in this response
  timespan?: string;       // echoed when supplied
  limitClamp?: { parameter: 'maxRecords'; requested: number; applied: number };  // only when maxRecords > 250 ran at 250
  withheldCount?: number;  // fetched minus returned; only on a page cut to the budget
  notice?: string;         // empty result, budget cut, or maxRecords cap reached
  continuationWindows?: Array<{ startDatetime: string; endDatetime: string }>;  // resume window or halves
}
```

### `gdelt_get_coverage_timeline`
```ts
{
  dateResolution?: '15min' | 'hour' | 'day';  // omitted with fewer than two distinct timesteps
  series: Array<{
    label: string;  // "Volume Intensity" or "Average Tone"
    data: Array<{   // the timesteps of this page
      date: string;   // ISO 8601
      value: number;  // normalized % (volume) or avg score (tone), -100 to +100
      articles?: Array<{ url: string; title: string }>;  // volume_with_articles only; first 3, or all for a `points`-named timestep
      referenceCount?: number;  // articles GDELT returned for the timestep; present whenever articles is
    }>;
    pointCount?: number;                       // points in the whole series, across every page
    peak?: { date: string; value: number };   // largest |value| in the whole series; may lie outside data
  }>;
  expandedPoints?: string[];  // echoes the `points` input — the timesteps this response is restricted to
  nextOffset?: number;        // offset of the next page; absent on the last page
  // enrichment
  effectiveQuery: string;
  mode: 'volume' | 'volume_with_articles' | 'tone';
  totalCount: number;         // data points across all series of the full timeline
  startDatetime?: string;     // echoed when supplied
  endDatetime?: string;       // echoed when supplied
  notice?: string;            // when the window held no coverage, or which timesteps of how many this page holds
}
```

Both surfaces carry the first 3 articles per timestep beside `referenceCount`; the `points: string[]`
input returns only the named timesteps, in timeline order, each with every article. An unmatched date
throws `unknown_point` listing the available dates. `offset` pages the timesteps (or the named ones);
past the last one it throws `offset_out_of_range` naming the valid range, and on an empty timeline it
is ignored. See
[Analytics responses page whole units within the byte budget](#analytics-responses-page-whole-units-within-the-byte-budget).

### `gdelt_get_tone_distribution`
```ts
{
  histogram: Array<{          // the bins of this page, most negative first
    bin: number;  // tone bin integer (typically -30 to +30)
    count: number;
    articles: Array<{ url: string; title: string }>;  // first 3 representative articles, or all for a `bins`-named bin
    referenceCount: number;   // representative articles GDELT returned for the bin
  }>;
  summary: {                  // over the whole histogram, never the page
    peakNegativeBin?: number;  // omitted when no negative bin was returned
    peakPositiveBin?: number;  // omitted when no positive bin was returned
    neutralPct?: number;       // % of articles in -2 to +2 range; omitted when no article was counted
  };
  nextOffset?: number;         // offset of the next page; absent on the last page
  // enrichment
  effectiveQuery: string;
  totalCount: number;          // articles across all bins
  startDatetime?: string;      // echoed when supplied
  endDatetime?: string;        // echoed when supplied
  notice?: string;             // when no articles matched, or which bins of how many this page holds
}
```

The `bins: number[]` input returns only the named bins, in histogram order, each with every
representative article; an unmatched bin throws `unknown_bin` listing the available bins. `offset`
pages the bins (or the named ones) like the timeline's.

### `gdelt_get_coverage_breakdown`
```ts
{
  dateResolution?: '15min' | 'hour' | 'day';  // omitted with fewer than two distinct timesteps
  topSeries?: Array<{       // overview page: of the top 10 by the sum of their values, those of this page in rank order
    label: string;          // language name or country name
    data: Array<{ date: string; value: number }>;  // normalized share of that source's media output, not article counts
  }>;
  otherSeriesLabels?: string[];   // overview pages: every series beyond the top 10, ranked
  selectedSeries?: Array<{        // selection page: complete series for the labels passed to `series`, in that order
    label: string;
    data: Array<{ date: string; value: number }>;
  }>;
  nextOffset?: number;            // offset of the next page; absent on the last page
  // enrichment
  effectiveQuery: string;
  breakdownBy: 'language' | 'country';
  totalCount: number;             // total series GDELT returned
  startDatetime?: string;         // echoed when supplied
  endDatetime?: string;           // echoed when supplied
  notice?: string;                // when the window held no coverage, or which series of how many this page holds
}
```

The `series: string[]` input takes labels from `otherSeriesLabels` (or `topSeries[].label`) and
returns only those, each complete, under `selectedSeries` — no overview. An unmatched label throws
`unknown_series` listing the available labels rather than being skipped. `offset` pages the ranked
top 10 — `otherSeriesLabels` is charged against the budget first, on every overview page — or the
selected series. Nothing sums series beyond the top 10: each value is a share of one source's output,
and shares of different sources' output do not add into a share; the per-series header labels its
ranking key "sum of values", not a total.

### `gdelt_search_themes`
```ts
{
  matches: Array<{
    theme: string;        // e.g. "NATURAL_DISASTER_DROUGHT"
    count: number;        // the count the lookup lists — static, not a live article total
    operator: string;     // "theme:NATURAL_DISASTER_DROUGHT"
  }>;                     // exact identifier first, then count descending, then identifier
  totalMatches: number;   // across all pages
  offset: number;
  limit: number;          // applied: 1–100, default 25; a request up to 1,000 runs at 100
  nextOffset?: number;    // only when more matches remain
  // enrichment
  effectiveQuery: string;
  totalCount: number;     // same figure as totalMatches
  limitClamp?: { parameter: 'limit'; requested: number; applied: number };  // only when limit > 100 ran at 100
  notice?: string;        // plural-fallback disclosure, or retry guidance on zero matches
}
```

| Reason | Code | When | Recovery |
|:-------|:-----|:-----|:---------|
| `invalid_query` | `ValidationError` | The query has no letter or digit (blank, whitespace, `___`); thrown before the lookup loads | Retry gdelt_search_themes with at least one word of letters or digits, such as "drought" or "cyber attack". |
| `offset_out_of_range` | `NotFound` | `offset` ≥ `totalMatches` on a non-empty result | Retry with an offset between 0 and totalMatches - 1 from the preceding response. |
| `gdelt_unavailable` | `ServiceUnavailable` (retryable) | The lookup could not be downloaded (any HTTP error status, a 404 included; a network error; a timeout) or is not `THEME<TAB>count` lines | Retry after a short delay; GDELT may be temporarily unavailable. |

Zero matches are a success with a notice routing to a retry with fewer words, a singular, or a
shorter stem (`displac`). `format()` renders a header with the page range and `totalMatches`, then
one line per match: identifier, count, and the operator in backticks.

### `gdelt_search_tv`
```ts
{
  dateResolution?: 'hour' | 'day' | 'week' | 'month' | 'year';  // reported, pinned via dateres, or inferred
  timeRange?: { start: string; end: string };  // omitted on an empty page
  series: Array<{
    station?: string;    // station ID, e.g. "FOXNEWS"; absent when the label did not resolve
    stationName: string; // GDELT's label, e.g. "FOX News"; empty when GDELT sent none
    data: Array<{ date: string; value: number }>;  // ISO date; normalized % or raw 15-second clip count
  }>;
  normalized: boolean;
  totalPoints: number; // complete upstream point count before paging
  offset: number;
  limit: number;       // applied: 1–500; a request up to 5,000 runs at 500
  nextOffset?: number;
  // enrichment
  effectiveQuery: string;
  totalCount: number;  // station series in this page
  limitClamp?: { parameter: 'limit'; requested: number; applied: number };  // only when limit > 500 ran at 500
  notice?: string;     // no TV coverage, or a returned series without a station ID
}
```

The `content[]` summary under each station heading — points, sum, peak — covers only that station's points on the returned page and says so (`Points on this page: 500 | Sum on this page: …`, `Page peak: …`); a timeline longer than one page has a different sum and peak on every page.

### `gdelt_get_tv_clips`
```ts
{
  clips: Array<{
    show: string;        // show name
    station?: string;    // station ID; absent when the label did not resolve
    stationName: string; // GDELT's label for the station; empty when GDELT sent none
    date: string;        // ISO 8601 air datetime
    snippet: string;     // 15-second transcript excerpt
    archiveUrl: string;  // Internet Archive clip URL
    thumbnail?: string;  // clip thumbnail URL if available
  }>;                    // the in-window fetched prefix that fits the 48,000-byte budget, in upstream order
  // enrichment
  effectiveQuery: string;
  totalCount: number;      // clips in this response
  limitClamp?: { parameter: 'maxRecords'; requested: number; applied: number };  // only when maxRecords > 3,000 ran at 3,000
  withheldCount?: number;  // in-window clips fetched minus returned; only on a page cut to the budget
  notice?: string;         // empty result, out-of-window drops, budget cut, maxRecords cap reached, or a clip without a station ID
  continuationWindows?: Array<{ startDatetime: string; endDatetime: string }>;  // resume window or halves
}
```

### `gdelt_get_tv_context`
```ts
{
  words: Array<{
    label: string;   // co-occurring word/phrase
    score: number;   // relative frequency score (0-100, query term = 100)
  }>;
  // enrichment
  effectiveQuery: string;
  totalCount?: number;  // clips the terms were computed from; absent when GDELT reports no count
  notice?: string;      // every non-empty result: the sampling disclosure; no clips matched: the no-data guidance
}
```

GDELT computes the word cloud from a relevance-ranked sample of the matching clips — its TV API documentation names the 200 most relevant — not from all matching coverage, and its response reports no analyzed-clip count. Every non-empty result says so in `notice`, as do the tool, `words`, and `score` descriptions: comparing windows or stations takes a separate, narrower call for each. No term ceiling is claimed — the documented 200-term ceiling is not enforced upstream (`trump` on CNN returned 448 terms for 2024-01-01–07, measured 2026-10-14) — and the sample size is cited as GDELT documents it, not as something this server enforces.

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
  }>;                    // stations matching every supplied filter; all when none is given
  activeCount: number;   // counts the returned stations
  totalCount: number;    // counts the returned stations
  // enrichment
  notice?: string;       // filter outcome: no match, or requested IDs not returned
}
```

The optional `stations`, `network`, and `market` inputs narrow the list (see
[Station-list filters match whole values](#station-list-filters-match-whole-values)); the
no-argument call's `structuredContent` is unchanged. An empty unfiltered catalog throws the
retryable `gdelt_unavailable`. `format()` groups stations as national (every `National*` market),
international (`International`, `Japan`), and local/regional (US cities), each line naming its market.

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
| Station metadata | list all stations with monitoring date ranges |

---

## Workflow Analysis

### `gdelt_get_coverage_timeline`

Used for: "When did coverage of X spike?" / pandemic signal detection workflow

| Mode | DOC API `mode` param | Returns |
|:-----|:---------------------|:--------|
| `volume` | `timelinevol` | Normalized % of all global coverage per timestep |
| `volume_with_articles` | `timelinevolinfo` | Same as volume + the first 3 of up to 10 top articles per spike timestep (all of them for timesteps named in `points`) |
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

### TV trending retired

The server once exposed GDELT's TV trending-topics endpoint as a zero-argument tool. That endpoint still answers HTTP 200 and regenerates its timestamp every 15 minutes, but every topic array is empty: it was computed over the live TV monitoring feed, which froze in October 2024, and it serves no archived snapshot. The tool therefore had no successful outcome, and it was removed rather than reworked — GDELT offers no precomputed trending view of the archive, and query-driven TV vocabulary over a chosen window is already `gdelt_get_tv_context`.

### Zero matches are a successful empty result

GDELT answers a valid query that matches nothing with HTTP 200 `{}`. Every query tool returns that as a success in its normal output shape — empty arrays, `totalCount: 0` (absent on `gdelt_get_tv_context` unless GDELT reports a clip count), the usual query and date echoes — plus a `notice` carrying the retry guidance, including the resolved `timespan` range on the TV tools. An empty result is a normal search outcome, and an error envelope would drop the shape, totals, and echoes an agent chains on.

Values that can only be derived from returned points are omitted, never defaulted: `dateResolution` (unless GDELT reported it or `dateres` pinned it), `gdelt_search_tv`'s `timeRange`, the tone summary's peaks (also when no bin exists on that side), and `neutralPct` when no article was counted. Fewer than two distinct timesteps leave `dateResolution` undeterminable, so it is omitted then too. Selectors that name timesteps, bins, series, or offsets (`points`, `bins`, `series`, `offset`) have nothing to be wrong about on an empty result, so they never raise `unknown_point`, `unknown_bin`, `unknown_series`, or `offset_out_of_range` there. Upstream rejections, rate limits, timeouts, and malformed or empty bodies stay errors.

The one exception is `gdelt_list_tv_stations`: its unfiltered catalog is static, so an empty one is GDELT failing and surfaces as the retryable `gdelt_unavailable`. A filter that matches no station is still a success — `stations: []` with a notice naming the filter.

### Station-list filters match whole values

`gdelt_list_tv_stations` narrows by `stations` (any listed ID), `network`, and `market`, combined with AND, each matched as a whole value case-insensitively after trimming. Substring matching was rejected because `network: "FOX"` would pull in `FOXNEWS` and `market: "National"` would pull in `NationalSpecialty`/`NationalDiscontinued`; pagination was rejected because callers know the station, network, or market they need, not a page number. Blank values and empty arrays count as omitted, so the no-argument call's `structuredContent` is unchanged. Requested station IDs that match nothing are named in the notice, split into IDs absent from the catalog and IDs another filter excluded.

### Record-cap overflow is a date partition

`gdelt_search_articles` (250) and `gdelt_get_tv_clips` (3,000) hit hard per-call ceilings that GDELT offers no cursor or offset past, so narrowing `startDatetime`/`endDatetime` is the only retrieval lever. At the ceiling both tools return `continuationWindows` — the queried window halved — instead of the old advice to raise a `maxRecords` already at its maximum.

The halves **overlap by one second** rather than meeting at a shared midpoint. GDELT documents both boundaries as exclusive — STARTDATETIME considers "only articles published *after* this date/time stamp", ENDDATETIME "only articles published *before*" it, in both the DOC 2.0 and TV 2.0 API docs — so halves that merely touched would silently drop any record timestamped exactly on the seam. The overlap tiles the window exactly under that documented reading, and if the boundaries turn out to behave inclusively instead, it costs at most two seconds of duplicates, which a caller can see and de-duplicate. Gap-free either way; a visible duplicate beats a silent loss.

Windows narrower than four seconds cannot yield two strictly-narrower halves, so the split stops there and the notice states plainly that the remainder is unreachable rather than implying the capped set was complete. A call that pinned no window at all gets guidance to pin one — the server never guesses GDELT's own default window.

`gdelt_get_tv_clips` splits differently, because of how the TV API answers a window (see *TV windows are answered in whole clock hours* below): its halves meet at a clock hour when one falls inside the window, as `[start, hour − 1 s]` and `[hour, end]`, and share no second — the handler keeps each response to its own window, so no seam needs covering. A split on the hour gives the halves disjoint hour sets, which is the split that helps when the cap left records behind: any window inside one hour fetches the same capped hour. A page cut to the byte budget whose window holds no clock hour still splits at the second — its withheld clips were fetched and lie inside the window, and each half fetches the hour again and keeps its own seconds — down to three seconds; measured live, a sub-hour half of a capped, cut `[01:05, 01:50]` page returned 22 of its 37 withheld clips. When that page was also capped, the notice adds that clips past the cap in that hour are out of reach of any narrower window — below the 3,000 ceiling the page's one `maxRecords` directive ("Continue with maxRecords 3000…") also says only a larger `maxRecords` reaches them; at the ceiling, that more matched upstream than any window inside the hour can fetch. A notice carries at most one `maxRecords` directive: the drop segment reports the slots the dropped clips took, and the directive comes from the cut continuation or, on an uncut capped page, the cap-reached segment. Only an uncut page capped at 3,000 with no hour inside its window has nothing a narrower window can add, and the notice then says the rest is unreachable.

### Record pages are cut to a 48,000-byte budget per surface

A full page overflows a client's context long before the record cap: 3,000 clips measured 1.88 MB of `structuredContent` and 1.84 MB of `content[]` text, and 250 articles at the measured median of 460 bytes come to about 115 KB. `gdelt_search_articles` and `gdelt_get_tv_clips` therefore emit fetched records in upstream order while their running charge fits 48,000 bytes, always emitting at least one. Each record is charged the larger of its `structuredContent` JSON element and its rendered `format()` block, each with its separator; the handler renders through the same per-record function `format()` uses, so the charge is exact and both surfaces carry the same records by construction. The charge is taken after Markdown escaping. Heading, enrichment, and trailer ride on top, so each surface stays under 50,000 bytes even for long multi-byte records. A budget, not a smaller `maxRecords` maximum, because record sizes vary with title, snippet, and URL length, and a count limit would either waste the context on short records or overflow it on long ones; `maxRecords` keeps its 250 and 3,000 per-call ceilings (larger values clamp to them — see *Oversized counts clamp to the per-call cap*) and still sets what GDELT is asked for. The three DOC analytics tools charge their units against the same budget and page them by `offset` — see *Analytics responses page whole units within the byte budget*.

A cut page reports `withheldCount` (fetched minus returned), one notice, and a continuation — never a larger `maxRecords` as the way to fit more into that response. (Below the ceiling, `gdelt_get_tv_clips` does tell the caller to continue at `maxRecords` 3,000, for the reason under *TV windows are answered in whole clock hours*.) Under `dateDesc`/`dateAsc` the last returned record is a resume point: `continuationWindows` holds one window from the caller's other boundary to one second past it (`endDatetime` for `dateDesc`, `startDatetime` for `dateAsc`), which re-returns that record's second so the records cut from it are not skipped; callers de-duplicate. DOC `seendate` values sit on 15-minute boundaries, so several articles routinely share that second. That resume window is offered only when a call on it would emit a record the page did not — at least one returned record lies outside it, and the next withheld record fits after the ones it re-returns. Otherwise (every returned record shares the resume second, which is common on DOC's 15-minute `seendate` buckets) only the withheld records at that second are out of reach: `continuationWindows` holds the window skipping past it (`endDatetime` one second before it under `dateDesc`, `startDatetime` one second after it under `dateAsc`), and the notice says the records at that second are lost and every earlier (or later) one is reachable. The notice says the rest cannot be reached by narrowing the date window only when that skipped window would be empty — inverted against the other boundary, or, on an uncapped page, holding none of the fetched records. A call with no known window gets the resume (or skip) timestamp to pair with a boundary of its choosing. The relevance, tone, and hybrid sorts have no resume point and get the halves above.

Records dated outside an explicit `startDatetime`/`endDatetime` window are dropped before the budget by both tools, and the notice counts them; a `timespan` window is resolved by GDELT on its own clock, which the server cannot observe, so a timespan call drops nothing. Cap-hit detection still uses the upstream count, since GDELT filled `maxRecords` whatever it filled it with — and when the cap was hit, the notice says how many of the `maxRecords` slots the dropped records took, since in-window records past them were not fetched; only an uncapped page calls the drop an expected edge effect. The drop never removes a record inside the caller's window; it keeps the echoed window exact and makes continuation converge whatever the upstream does at the edge. DOC's own boundary behavior is unmeasured (the API rate-limited every probe), and without the drop a DOC that widened a boundary to its 15-minute bucket would re-return a whole neighboring bucket on every `dateAsc` resume.

### TV windows are answered in whole clock hours

Measured live against the TV API with a known week of clips: a `startdatetime`/`enddatetime` window is answered on clip air time from the start floored to the clock hour through the end of the end's hour — a window of 17:30–18:30 returned clips from 17:22 and from 18:05, and 17:00–18:00 returned the same six, 18:05 included. A window spanning under 30 minutes is rejected with the plain-text body `Timespan is too short.` (20 minutes rejected, 30 accepted). `gdelt_get_tv_clips` therefore sends an explicit window widened to whole hours — the start floored to the hour, the end stretched to the end of that first hour when the window is shorter — which never adds an hour the caller's window does not reach but is always a span GDELT accepts, so continuation windows of any width work; the drop then keeps the caller's exact window. An end exactly on the hour is sent one second earlier: sent as is, GDELT would answer that whole next hour for the window's final second, spending `maxRecords` on clips the drop discards, so that second is left out — GDELT documents ENDDATETIME as exclusive. Because every request covers whole hours, the clips outside its window come back too and take `maxRecords` slots — a resumed `dateAsc` window floored to its hour gets the minutes already walked first — so below the ceiling a cut page tells the caller to continue at `maxRecords` 3,000 (measured live at 150: 146 of 150 slots went to the already-walked prefix). `gdelt_search_tv` and `gdelt_get_tv_context` return aggregates (timeline points, term counts) that cannot be trimmed back to an exact window, so they send the window as given; a window under 30 minutes gets GDELT's rejection with a recovery hint naming the TV minimum.

### Upstream text is escaped at the `content[]` boundary

GDELT titles, labels, clip shows and snippets, context terms, and station metadata are third-party text. Rendered raw, a nested `[x](y)` breaks an article link, `*…*` becomes emphasis, a trailing ` #` drops from a heading, `<b>` and `&copy;` render as HTML and ©, and a snippet line break opens a new list item. Every `format()` interpolation of upstream text goes through one shared escaper (`src/mcp-server/tools/markdown-escape.ts`); `structuredContent` keeps the raw value, and nothing is decoded or stripped. The escaper is a single linear pass that escapes only where CommonMark/GFM would parse markup — `_` only at a word boundary, `<` only before a tag or autolink opener, `&` only before a complete entity, a trailing `#` run only at a heading's end, a leading block marker only as a list item's first text — so a value without markup characters renders byte-identical (the live 159-station catalog is the regression fixture). Line breaks become spaces. Displayed URLs are never backslash-escaped. A plain bare URL passes through byte-identical; one carrying a character the escaper would change (a boundary `_`, `*`, `~`, a bracket, a backtick, a backslash, an entity) renders in autolink form, `<https://…>`, so it displays intact under strict CommonMark as well as under GFM's autolink literal — including two URLs in one paragraph whose underscores would otherwise pair up. A space, `<`, `>`, and ASCII controls cannot sit in an autolink and no valid URL carries them raw, so bare URLs percent-encode them; a value with no scheme cannot be an autolink and is escaped as text. A `[title](url)` destination is never displayed but must resolve to exactly the upstream URL: it takes the angle-bracket form when it contains a space or parenthesis, and its `\` and entity-forming `&` are backslash-escaped, because CommonMark decodes backslash escapes and entity references inside a destination and a backslash escape is the only way to keep the literal character — percent-encoding would change the URL (`%26` is not a query separator, and browsers read `\` as `/`).

Caller text that server prose quotes back goes through `markdownQuote` in the same module: the query in an empty-result notice and in the trailer's `Query:` line, a timespan, `gdelt_list_tv_stations` filters, and the `series` labels, `points` dates, and query named in an error or recovery hint. It is JSON-encoded, then escaped as text, so it displays as exactly its JSON encoding: a plain query reads `"climate change"`, while a newline, `#`, `>`, a fence, or `<script>` can neither end the notice's blockquote nor open markup. JSON rather than the escaper alone because the encoding keeps the quoted span unambiguous — a `"` inside the value is escaped, so it cannot fake the closing quote — and shows a line break as `\n` instead of folding it into a space. `structuredContent` keeps `effectiveQuery` and `timespan` verbatim; a notice or error message is one string on both surfaces, so it carries the quoted form. Upstream labels and dates listed beside them in a recovery hint go through the escaper.

Multi-line `format()` output separates a list from the next paragraph with a blank line; without one, CommonMark lazy continuation folds the paragraph into the list's last item (#49 — tone histogram bin headers joined the previous bin's article list).

### TV timeline responses use bounded point pages

`gdelt_search_tv` selects page membership from the full result in date-then-station-name order, then returns those points grouped by station. Each response carries at most 500 points from the requested `offset`. The same bounded page is used for `structuredContent` and rendered in full in `content[]`; `nextOffset` retrieves the next non-overlapping page with identical query inputs. A deterministic page of the ten longest live station labels × 50 hourly points, each series carrying its ID and label, measures 23,892 bytes of structured JSON and 16,550 bytes of rendered text at the ceiling. Ten station selectors and the 500-point ceiling therefore keep request construction and both MCP surfaces bounded without hiding points on one client surface.

This is server-side pagination over a fresh upstream timeline, not a GDELT cursor. Historical archive queries are the intended workflow; callers paging a mutable window should keep every query input fixed and expect new upstream data to change later pages.

### TV station labels resolve to station IDs through the catalog

GDELT labels timeline series and clips with a station's catalog description (`FOX News`, `CBS - St. Petersburg (WTSP)`), never the ID its `station:` operator takes (`FOXNEWS`, `WTSP`) — passing a label back fails as `Invalid Station`. `gdelt_search_tv` and `gdelt_get_tv_clips` therefore return the ID as `station` and the label as `stationName`, resolving each label by exact match against the `stationdetails` description. Measured live, every label on 42 distinct stations — local affiliates under `network:` included — equals its description, and all 159 descriptions are unique; spelling or case heuristics fail outright (`Russia Today` is `RT`, `DeutscheWelle` is `DW`), and the clip URL prefix is not the ID either (`FOXNEWSW_…`). A bundled static map was the alternative; the live catalog was chosen so `gdelt_list_tv_stations` stays the one source of station data.

The catalog is a side lookup and never sinks the answer. It is loaded once per process, after the call's own request and only when a label needs resolving, and shared by both tools; concurrent first calls share one load, which runs under its own signal so a cancelled caller cannot fail the others. The load is a single request, never the retry ladder: a failed or empty load leaves every row with `stationName` and no `station`, the notice says IDs could not be resolved, nothing is kept, and the next call loads it again; a caller's own cancellation still fails its call as cancelled. A call waits for the catalog at most 45 seconds from its start (or its whole deadline, twice `GDELT_REQUEST_TIMEOUT_MS`, when that is shorter), then answers without IDs. A load still running once every call awaiting it has stopped waiting is abandoned: its request is aborted, freeing the one GDELT request slot it holds, and it counts as failed — nothing is kept, and the next call loads again. Left to its own 60-second attempt timeout, a hung catalog request held that slot after the call had answered, delaying the next GDELT request from any tool by about 15 seconds. MCP clients commonly give up on a call at 60 seconds; retried through the full ladder, a catalog 5xx adds about 36 seconds to the first TV call, and a wait bounded only by the 120-second call deadline lets a slow main request plus a retrying catalog cost the caller the whole answer the IDs only label. A label the catalog lacks keeps `stationName`, omits `station` (optional in both schemas), and is named in the notice — quoted there with `markdownQuote`, since the notice reaches `content[]` as written. A series or clip GDELT sends with no label at all has nothing to resolve: its `stationName` is empty rather than a stand-in that would read as a label, it is never looked up, and the notice says GDELT returned it without a station label. Pages order by `stationName`, which every row carries whether or not its ID resolved, so a missing ID never changes page membership.

### Oversized counts clamp to the per-call cap

`maxRecords` on `gdelt_search_articles` (250) and `gdelt_get_tv_clips` (3,000), and `limit` on `gdelt_search_tv` (500) and `gdelt_search_themes` (100), accept up to ten times their cap. A value above the cap runs exactly as a call at the cap — the upstream request, cap-hit detection, byte-budget cut, notices, continuation, and the `limit` output all use the applied value — and the response adds `limitClamp: { parameter, requested, applied }`, rendered in `content[]` as `**Limit clamped:** maxRecords 400 → 250 (per-call cap)`. Above ten times the cap the call is rejected as invalid arguments, which keeps a hard ceiling against absurd input. Rejecting every value past the cap made a caller repeat an otherwise valid read that has one obvious reading; raising the caps would undo the output and provider bounds they exist for. More than 10 `stations` on `gdelt_search_tv` still rejects: the station list scopes one measurement, so running a subset would change the answer rather than defer part of it.

### Every transient upstream failure is `gdelt_unavailable`

Each DOC and TV tool declares `gdelt_unavailable` (`ServiceUnavailable`, retryable, with a recovery hint). The shared fetch helper attaches it to every `ServiceUnavailable` or `Timeout` the retry ladder treated as transient once the ladder gives up — an HTML or empty HTTP 200 body, an HTTP 5xx (a 504 arrives as `Timeout`), a network error, a timeout on the last attempt, and the call deadline expiring — keeping `status`, `errorSource`, and `retryAttempts` in `data`. What the ladder refused to retry passes through unchanged: HTTP 501 (`retryable: false`), a caller-side `TimeoutError`, rate limits (`gdelt_rate_limited`), query rejections (`invalid_query`), and unparseable bodies. A call whose own signal has aborted is never relabelled — a client that went away is not told to retry.

### The GKG theme lookup is fetched once per process

`gdelt_search_themes` downloads the lookup (59,315 `THEME<TAB>count` lines, 2.0 MB, last modified 2021-11-25) on first use and holds the parsed, ranked index for the life of the process. Bundling a snapshot was rejected on install cost: it grows every npm tarball from 129 KB to 683 KB whether or not the tool is ever called, while a fetch costs 2.0 MB once per process and only when the tool runs; freshness does not separate the two, since the file has not changed since 2021 and a restart re-fetches. No TTL — nothing in the file changes within a process lifetime. A failed load is not cached, so the next call retries it, and concurrent first calls share one in-flight load. The load bypasses the DOC/TV pacer: the file is served from `data.gdeltproject.org`, not the rate-limited API host, and a theme lookup should not queue behind up to 90 s of DOC/TV traffic. It is not tied to the first caller's cancellation signal, because other callers may be waiting on the same load. Every load failure — including a 404, which would otherwise surface as `NotFound` and read as "no such theme" — throws the retryable `gdelt_unavailable`, never an empty result. Parsed and indexed it retains about 13 MB of heap; the load raises process RSS by about 60 MB.

### Theme matching is token-prefix, with one plural fallback

The lookup carries identifiers and counts only, so the identifier text is the whole searchable surface. Matching was measured over the full file against three rules: exact token misses plurals (`refugee` misses `REFUGEES`, the top match), substring drowns short words (`art` 2,013 hits, `ice` 491 through `WB_840_JUSTICE`), and token prefix sits between. Token prefix is the rule, widened so a word may run across consecutive tokens and all the words joined may match (`cyberattack` → `CYBER_ATTACK`, `plant disease` → `TAX_PLANTDISEASE`), which added no noise on the measured sample. There is no stemming or synonym bridging; the one exception is a single retry on zero matches with a trailing `s` dropped from each word of four or more characters, disclosed in the notice, so `protests` reaches `PROTEST`. An exact identifier match ranks first, which keeps `DISPLACED` above the higher-count `CRISISLEX_T09_DISPLACEDRELOCATEDEVACUATED` and makes the tool usable for confirming an identifier a caller already holds; a "whole-token matches first" tier was rejected because it demoted `REFUGEES` below eleven `REFUGEE` whole-token matches. The index is ranked once at load, so a search is a single filter pass, linear in rows × words — under 20 ms per call on the full file.

### Timeline dates and request enums mirror GDELT

DOC and TV timeline dates are normalized at the service boundary (`YYYYMMDD` → `YYYY-MM-DD`, `YYYYMMDDTHHMMSSZ` → ISO date-time). Resolution fallback uses the smallest positive interval across all usable points instead of the timestamp's spelling. DOC represents 15-minute, hourly, and daily intervals; TV preserves or infers `hour`, `day`, `week`, `month`, and `year`, and exposes the same values through `dateres`.

Timeline smoothing is sent upstream as `TIMELINESMOOTH`. TV clips use `DateAsc`/`DateDesc`; DOC article search exposes `dateDesc`, `dateAsc`, `toneDesc`, `toneAsc`, and `hybridRel`, while `relevance` omits `SORT` to use GDELT's documented default.

### Analytics responses page whole units within the byte budget

`gdelt_get_coverage_timeline`, `gdelt_get_tone_distribution`, and `gdelt_get_coverage_breakdown` page their results because a whole result overflows a client's context. At GDELT's documented maxima — 288 15-minute timesteps under 72 hours, 10 references per timestep or bin, 61 tone bins — with 100-character titles and URLs, every unit of a timeline in one response comes to about 657 KB of `structuredContent` (every reference) and 196 KB of `content[]`, a tone histogram to about 138 / 133 KB, and a 200-country breakdown to about 158 / 104 KB, reaching about 2.8 / 1.8 MB with all 190 labels beyond the top 10 selected.

Each tool fills a page from `offset` with whole units — timesteps, bins, series — while their running charge fits the shared 48,000-byte budget, always emitting one; the charge is the record-list rule (*Record pages are cut to a 48,000-byte budget per surface*), taken through the same per-unit renderer `format()` uses. A cut page returns `nextOffset`, and any page that is not the whole result carries a notice naming the units it returned out of the total, so a `content[]` reader knows the response is a slice. Walking `nextOffset` with identical inputs returns every unit once, in order. `offset` rather than continuation windows because these are aggregates over one upstream request: re-fetching with the same inputs reproduces the same unit list, and a window cannot split a histogram or a series. `totalCount`, `dateResolution`, the tone `summary`, and each timeline series' `pointCount` and `peak` are computed over the full upstream result, never the page — a line that reads as a series summary reads the same on every page, and the timeline's text says `**Data points:** 288 in the series, 63 in this response` when the page holds only part of it. Breakdown series and tone bins are never split across pages, so their per-unit sums, peaks, and counts are whole by construction. Charges are taken lazily, from `offset` to the first unit that crosses the budget.

Both surfaces carry the first 3 references per timestep or bin beside `referenceCount`, so they hold the same units and references by construction; `points` (timeline) and `bins` (tone) return only the named units, each with every reference. A breakdown `series` selection returns only `selectedSeries`; the ranked overview pages `topSeries` with `otherSeriesLabels` on every page, charged before any series, and a `points` selection's `expandedPoints` echo is charged ahead of its timesteps the same way. Measured on those fixtures — the `response budget (#54)` suites in `tests/tools/get-coverage-timeline.tool.test.ts`, `get-tone-distribution.tool.test.ts`, and `get-coverage-breakdown.tool.test.ts` — no page exceeds about 48.2 KB on either surface, and one named timestep is about 2.5 KB. The timeline walks in 5 pages, all 288 timesteps named in 17, and `volume` mode at 288 timesteps is one page; the tone histogram fits one page and all 61 bins named walk in 3; the breakdown overview walks in 4 pages, the 190-label selection in 64.

---

## Known Limitations

- **DOC API searches last 3 months only.** No historical article search beyond 90 days. For historical analysis, the GDELT raw data files (BigQuery) are the only option — out of scope for this server.
- **GEO API is defunct.** Point-level and country-level geographic heat maps from the GEO 2.0 API are unavailable. Source-country breakdown via the DOC API is a partial substitute.
- **TV API coverage gap post-Oct 2024.** Most TV stations in the station list have end dates of October 2024, suggesting the Internet Archive's Television News Archive feed into GDELT TV stopped being updated around that time. Recent TV queries will return thin or zero results.
- **Rate limit: 1 req/5s.** Tools that call multiple API modes must serialize calls. Multi-step workflows (e.g. tone + volume + article list) will take 15+ seconds.
- **DOC API article fields are sparse.** The article list returns URL, title, seendate, socialimage, domain, language, and sourcecountry only — no article text, no author, no full metadata. Full content requires fetching the source URL directly.
- **Theme identifiers have no labels.** The `theme:` query operator takes GKG taxonomy identifiers (e.g. `TAX_DISEASE_OUTBREAK`, `TERROR`). `gdelt_search_themes` searches them, but GDELT's lookup (`https://data.gdeltproject.org/api/v2/guides/LOOKUP-GKGTHEMES.TXT`) carries only the identifier and a count, so a concept is found only through words in the identifier itself — `displacement` never reaches `DISPLACED` or `REFUGEES`. The count column is undocumented: GDELT describes the list as themes seen in at least 100 articles over two years, yet 33,974 of its rows list a count under 100, so it is reported as the lookup's figure, never as an article count.

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
| Theme | `theme:TAX_DISEASE_OUTBREAK` | GKG taxonomy theme — find identifiers with `gdelt_search_themes` |
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
