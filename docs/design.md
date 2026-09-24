# gdelt-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `gdelt_search_articles` | Search the last 3 months of global news coverage (65 languages) with full-text and filter operators. Query supports phrases, boolean OR, `sourcecountry:`, `sourcelang:`, `domain:`, `theme:` (GKG taxonomy), `tone<`/`tone>`, `near:`, and `repeat:` operators. Fetches up to 250 articles with URL, title, source country, language, publication date, and social image URL, and returns as many as fit a 48,000-byte budget per surface; the rest are counted in `withheldCount`. 250 is a hard ceiling with no cursor past it — at the cap, or on a page cut to the budget, the response returns `continuationWindows` to re-query. | `query`, `timespan`, `startDatetime`, `endDatetime`, `maxRecords`, `sort` | `readOnlyHint: true`, `openWorldHint: true` |
| `gdelt_get_coverage_timeline` | Retrieve a time series showing when coverage of a topic spiked — either as normalized volume (% of all global coverage) or as average tone. Use `mode: volume_with_articles` for the signal-detection workflow: each timestep includes the top articles that drove that spike, so a single call reveals both the spike and its cause. The text surface renders the first 3 links per timestep beside its true count; `points` renders named timesteps in full. Tone timeline shows sentiment shifts over time; combine with `gdelt_get_tone_distribution` for the full tonal picture. | `query`, `mode` (volume \| volume_with_articles \| tone), `timespan`, `startDatetime`, `endDatetime`, `smoothing`, `points` | `readOnlyHint: true`, `openWorldHint: true` |
| `gdelt_get_tone_distribution` | Get the tonal distribution of articles matching a query as a histogram (bins from ~-30 to +30). Unlike a single average tone score, the histogram reveals whether coverage is uniformly negative, bimodal (some extremely positive, some extremely negative), or clustered near neutral. Each bin includes representative article URLs. Distinct from `gdelt_get_coverage_timeline` (mode: tone) — this is a snapshot distribution across all matching articles, not a time series. | `query`, `timespan`, `startDatetime`, `endDatetime` | `readOnlyHint: true`, `openWorldHint: true` |
| `gdelt_get_coverage_breakdown` | Break down coverage volume over time by source language or source country, returning a multi-series time series (one series per language or country). Shows which countries or languages drove early vs. late coverage — useful for tracing how a story propagated geographically. Returns the top 10 series by total volume to keep output size manageable; remaining series are aggregated into an "Other" bucket and named in `otherSeriesLabels`, so any of them can be retrieved complete via the `series` input. Values are normalized — the topic's share of media output, not absolute article counts, so small media markets with concentrated coverage rank above large markets with diverse output. | `query`, `breakdownBy` (language \| country), `timespan`, `startDatetime`, `endDatetime`, `series` | `readOnlyHint: true`, `openWorldHint: true` |
| `gdelt_search_tv` | Search US television news closed captions (2009–Oct 2024, 150+ stations) for spoken mentions of a query. Returns query-matching per-station coverage as normalized airtime percentages or raw 15-second clip counts. Up to 10 stations may be selected with `stations`, or a `station:` query operator can supply selection. Results are ISO-normalized; page membership uses deterministic date-then-station order, and returned points are grouped by station. `nextOffset` retrieves the next page of up to 500 points. | `query`, `stations`, `timespan`, `startDatetime`, `endDatetime`, `smoothing`, `normalize`, `dateres`, `offset`, `limit` | `readOnlyHint: true`, `openWorldHint: true` |
| `gdelt_get_tv_clips` | Retrieve the top matching TV news clips for a query from the Internet Archive's Television News Archive — up to 3,000 fetched, clips dated outside an explicit `startDatetime`/`endDatetime` window dropped, and as many as fit a 48,000-byte budget per surface returned; the rest are counted in `withheldCount`. Each clip includes show name, station, air timestamp, a 15-second transcript excerpt, and a direct link to view the full one-minute clip. Use after `gdelt_search_tv` to read the actual content driving a coverage spike. 3,000 is a hard ceiling with no cursor past it — at the cap, or on a page cut to the budget, the response returns `continuationWindows` to re-query. | `query`, `stations`, `timespan`, `startDatetime`, `endDatetime`, `maxRecords`, `sort` (relevance \| dateDesc \| dateAsc) | `readOnlyHint: true`, `openWorldHint: true` |
| `gdelt_get_tv_context` | Get the top co-occurring words and phrases from TV news clips matching a query — the vocabulary framing a topic on television. Returns the most frequent non-stopword terms from matching clips, with relative frequency scores. Use to understand narrative framing, identify related concepts, or generate follow-up search terms. | `query`, `stations`, `timespan` | `readOnlyHint: true`, `openWorldHint: true` |
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
- No authentication required
- Rate limiting to 1 req/5s (with per-call minimum delay in service layer)
- DOC query syntax: keywords, phrases, boolean OR, `domain:`, `sourcecountry:`, `sourcelang:`, `theme:`, `tone<`, `near:`, `repeat:`
- TV query syntax: keywords, phrases, boolean OR, `station:`, `network:`, `market:`, `show:`, `context:`

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `GdeltDocService` | DOC API (`/api/v2/doc/doc`) | `gdelt_search_articles`, `gdelt_get_coverage_timeline`, `gdelt_get_tone_distribution`, `gdelt_get_coverage_breakdown` |
| `GdeltTvService` | TV API (`/api/v2/tv/tv`) | `gdelt_search_tv`, `gdelt_get_tv_clips`, `gdelt_get_tv_context`, `gdelt_list_tv_stations` |

Both services queue behind a single outbound pacer (`src/services/gdelt/gdelt-pacer.ts`) — one request in flight, the request gap held from the *previous response's completion* rather than its start, and a shared cooldown gate a GDELT rate-limit response closes for every queued caller. GDELT's limiter counts from completion, and its answers routinely outrun the gap, so start-relative spacing alone leaves no gap at all.

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
    data: Array<{
      date: string;   // ISO 8601
      value: number;  // normalized % (volume) or avg score (tone), -100 to +100
      articles?: Array<{ url: string; title: string }>;  // volume_with_articles only; always complete
    }>;
  }>;
  expandedPoints?: string[];  // timestep dates rendered with their full article list; echoes the `points` input
  // enrichment
  effectiveQuery: string;
  mode: 'volume' | 'volume_with_articles' | 'tone';
  totalCount: number;         // data points across all series
  startDatetime?: string;     // echoed when supplied
  endDatetime?: string;       // echoed when supplied
  notice?: string;            // only when the window held no coverage
}
```

`structuredContent` always carries every article for every timestep. `format()` renders the first
3 per timestep next to that timestep's true count; the `points: string[]` input names timesteps to
render in full. An unmatched date throws `unknown_point` listing the available dates. See
[Per-point article rendering stays capped by default](#per-point-article-rendering-stays-capped-by-default).

### `gdelt_get_tone_distribution`
```ts
{
  histogram: Array<{
    bin: number;  // tone bin integer (typically -30 to +30)
    count: number;
    articles: Array<{ url: string; title: string }>;  // top articles in this bin
  }>;
  summary: {
    peakNegativeBin?: number;  // omitted when no negative bin was returned
    peakPositiveBin?: number;  // omitted when no positive bin was returned
    neutralPct?: number;       // % of articles in -2 to +2 range; omitted when no article was counted
  };
  // enrichment
  effectiveQuery: string;
  totalCount: number;          // articles across all bins
  startDatetime?: string;      // echoed when supplied
  endDatetime?: string;        // echoed when supplied
  notice?: string;             // only when no articles matched
}
```

### `gdelt_get_coverage_breakdown`
```ts
{
  dateResolution?: '15min' | 'hour' | 'day';  // omitted with fewer than two distinct timesteps
  topSeries: Array<{        // top 10 by total volume
    label: string;          // language name or country name
    data: Array<{ date: string; value: number }>;  // normalized share of media output, not article counts
  }>;
  otherAggregated?: Array<{ date: string; value: number }>;  // remaining series combined; same normalized scale
  otherSeriesLabels?: string[];   // labels of every series folded into otherAggregated, ranked
  selectedSeries?: Array<{        // complete series for each label passed to the `series` input
    label: string;
    data: Array<{ date: string; value: number }>;
  }>;
  // enrichment
  effectiveQuery: string;
  breakdownBy: 'language' | 'country';
  totalCount: number;             // total series before truncation to the top 10
  startDatetime?: string;         // echoed when supplied
  endDatetime?: string;           // echoed when supplied
  notice?: string;                // only when the window held no coverage
}
```

The `series: string[]` input takes labels from `otherSeriesLabels` (or `topSeries[].label`) and
returns each one complete under `selectedSeries`, alongside the unchanged overview. An unmatched
label throws `unknown_series` listing the available labels rather than being skipped.

### `gdelt_search_tv`
```ts
{
  dateResolution?: 'hour' | 'day' | 'week' | 'month' | 'year';  // reported, pinned via dateres, or inferred
  timeRange?: { start: string; end: string };  // omitted on an empty page
  series: Array<{
    station: string;   // e.g. "CNN"
    data: Array<{ date: string; value: number }>;  // ISO date; normalized % or raw 15-second clip count
  }>;
  normalized: boolean;
  totalPoints: number; // complete upstream point count before paging
  offset: number;
  limit: number;       // 1–500
  nextOffset?: number;
  // enrichment
  effectiveQuery: string;
  totalCount: number;  // station series in this page
  notice?: string;     // only when the query matched no TV coverage
}
```

### `gdelt_get_tv_clips`
```ts
{
  clips: Array<{
    show: string;        // show name
    station: string;     // station ID
    date: string;        // ISO 8601 air datetime
    snippet: string;     // 15-second transcript excerpt
    archiveUrl: string;  // Internet Archive clip URL
    thumbnail?: string;  // clip thumbnail URL if available
  }>;                    // the in-window fetched prefix that fits the 48,000-byte budget, in upstream order
  // enrichment
  effectiveQuery: string;
  totalCount: number;      // clips in this response
  withheldCount?: number;  // in-window clips fetched minus returned; only on a page cut to the budget
  notice?: string;         // empty result, out-of-window drops, budget cut, or maxRecords cap reached
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
  notice?: string;      // only when no clips matched
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

### TV trending retired

The server once exposed GDELT's TV trending-topics endpoint as a zero-argument tool. That endpoint still answers HTTP 200 and regenerates its timestamp every 15 minutes, but every topic array is empty: it was computed over the live TV monitoring feed, which froze in October 2024, and it serves no archived snapshot. The tool therefore had no successful outcome, and it was removed rather than reworked — GDELT offers no precomputed trending view of the archive, and query-driven TV vocabulary over a chosen window is already `gdelt_get_tv_context`.

### Zero matches are a successful empty result

GDELT answers a valid query that matches nothing with HTTP 200 `{}`. Every query tool returns that as a success in its normal output shape — empty arrays, `totalCount: 0` (absent on `gdelt_get_tv_context` unless GDELT reports a clip count), the usual query and date echoes — plus a `notice` carrying the guidance an error's recovery hint used to carry, including the resolved `timespan` range on the TV tools. An empty result is a normal search outcome, and an error envelope would drop the shape, totals, and echoes an agent chains on.

Values that can only be derived from returned points are omitted, never defaulted: `dateResolution` (unless GDELT reported it or `dateres` pinned it), `gdelt_search_tv`'s `timeRange`, the tone summary's peaks (also when no bin exists on that side), and `neutralPct` when no article was counted. Fewer than two distinct timesteps leave `dateResolution` undeterminable, so it is omitted then too. Selectors that name timesteps, series, or offsets (`points`, `series`, `offset`) have nothing to be wrong about on an empty result, so they never raise `unknown_point`, `unknown_series`, or `offset_out_of_range` there. Upstream rejections, rate limits, timeouts, and malformed or empty bodies stay errors.

The one exception is `gdelt_list_tv_stations`: its unfiltered catalog is static, so an empty one is GDELT failing and surfaces as the retryable `gdelt_unavailable`. A filter that matches no station is still a success — `stations: []` with a notice naming the filter.

### Station-list filters match whole values

`gdelt_list_tv_stations` narrows by `stations` (any listed ID), `network`, and `market`, combined with AND, each matched as a whole value case-insensitively after trimming. Substring matching was rejected because `network: "FOX"` would pull in `FOXNEWS` and `market: "National"` would pull in `NationalSpecialty`/`NationalDiscontinued`; pagination was rejected because callers know the station, network, or market they need, not a page number. Blank values and empty arrays count as omitted, so the no-argument call's `structuredContent` is unchanged. Requested station IDs that match nothing are named in the notice, split into IDs absent from the catalog and IDs another filter excluded.

### Record-cap overflow is a date partition

`gdelt_search_articles` (250) and `gdelt_get_tv_clips` (3,000) hit hard per-call ceilings that GDELT offers no cursor or offset past, so narrowing `startDatetime`/`endDatetime` is the only retrieval lever. At the ceiling both tools return `continuationWindows` — the queried window halved — instead of the old advice to raise a `maxRecords` already at its maximum.

The halves **overlap by one second** rather than meeting at a shared midpoint. GDELT documents both boundaries as exclusive — STARTDATETIME considers "only articles published *after* this date/time stamp", ENDDATETIME "only articles published *before*" it, in both the DOC 2.0 and TV 2.0 API docs — so halves that merely touched would silently drop any record timestamped exactly on the seam. The overlap tiles the window exactly under that documented reading, and if the boundaries turn out to behave inclusively instead, it costs at most two seconds of duplicates, which a caller can see and de-duplicate. Gap-free either way; a visible duplicate beats a silent loss.

Windows narrower than four seconds cannot yield two strictly-narrower halves, so the split stops there and the notice states plainly that the remainder is unreachable rather than implying the capped set was complete. A call that pinned no window at all gets guidance to pin one — the server never guesses GDELT's own default window.

`gdelt_get_tv_clips` splits differently, because of how the TV API answers a window (see *TV windows are answered in whole clock hours* below): its halves meet at a clock hour when one falls inside the window, as `[start, hour − 1 s]` and `[hour, end]`, and share no second — the handler keeps each response to its own window, so no seam needs covering. A split on the hour gives the halves disjoint hour sets, which is the split that helps when the cap left records behind: any window inside one hour fetches the same capped hour. A page cut to the byte budget whose window holds no clock hour still splits at the second — its withheld clips were fetched and lie inside the window, and each half fetches the hour again and keeps its own seconds — down to three seconds; measured live, a sub-hour half of a capped, cut `[01:05, 01:50]` page returned 22 of its 37 withheld clips. When that page was also capped, the notice adds that clips past the cap in that hour are out of reach of any narrower window — below the 3,000 ceiling the page's one `maxRecords` directive ("Continue with maxRecords 3000…") also says only a larger `maxRecords` reaches them; at the ceiling, that more matched upstream than any window inside the hour can fetch. A notice carries at most one `maxRecords` directive: the drop segment reports the slots the dropped clips took, and the directive comes from the cut continuation or, on an uncut capped page, the cap-reached segment. Only an uncut page capped at 3,000 with no hour inside its window has nothing a narrower window can add, and the notice then says the rest is unreachable.

### Record pages are cut to a 48,000-byte budget per surface

A full page overflows a client's context long before the record cap: 3,000 clips measured 1.88 MB of `structuredContent` and 1.84 MB of `content[]` text, and 250 articles at the measured median of 460 bytes come to about 115 KB. `gdelt_search_articles` and `gdelt_get_tv_clips` therefore emit fetched records in upstream order while their running charge fits 48,000 bytes, always emitting at least one. Each record is charged the larger of its `structuredContent` JSON element and its rendered `format()` block, each with its separator; the handler renders through the same per-record function `format()` uses, so the charge is exact and both surfaces carry the same records by construction. The charge is taken after Markdown escaping. Heading, enrichment, and trailer ride on top, so each surface stays under 50,000 bytes even for long multi-byte records. A budget, not a smaller `maxRecords` maximum, because record sizes vary with title, snippet, and URL length, and a count limit would either waste the context on short records or overflow it on long ones; `maxRecords` keeps its 1–250 and 1–3,000 ranges and still sets what GDELT is asked for.

A cut page reports `withheldCount` (fetched minus returned), one notice, and a continuation — never a larger `maxRecords` as the way to fit more into that response. (Below the ceiling, `gdelt_get_tv_clips` does tell the caller to continue at `maxRecords` 3,000, for the reason under *TV windows are answered in whole clock hours*.) Under `dateDesc`/`dateAsc` the last returned record is a resume point: `continuationWindows` holds one window from the caller's other boundary to one second past it (`endDatetime` for `dateDesc`, `startDatetime` for `dateAsc`), which re-returns that record's second so the records cut from it are not skipped; callers de-duplicate. DOC `seendate` values sit on 15-minute boundaries, so several articles routinely share that second. That resume window is offered only when a call on it would emit a record the page did not — at least one returned record lies outside it, and the next withheld record fits after the ones it re-returns. Otherwise (every returned record shares the resume second, which is common on DOC's 15-minute `seendate` buckets) only the withheld records at that second are out of reach: `continuationWindows` holds the window skipping past it (`endDatetime` one second before it under `dateDesc`, `startDatetime` one second after it under `dateAsc`), and the notice says the records at that second are lost and every earlier (or later) one is reachable. The notice says the rest cannot be reached by narrowing the date window only when that skipped window would be empty — inverted against the other boundary, or, on an uncapped page, holding none of the fetched records. A call with no known window gets the resume (or skip) timestamp to pair with a boundary of its choosing. The relevance, tone, and hybrid sorts have no resume point and get the halves above.

Records dated outside an explicit `startDatetime`/`endDatetime` window are dropped before the budget by both tools, and the notice counts them; a `timespan` window is resolved by GDELT on its own clock, which the server cannot observe, so a timespan call drops nothing. Cap-hit detection still uses the upstream count, since GDELT filled `maxRecords` whatever it filled it with — and when the cap was hit, the notice says how many of the `maxRecords` slots the dropped records took, since in-window records past them were not fetched; only an uncapped page calls the drop an expected edge effect. The drop never removes a record inside the caller's window; it keeps the echoed window exact and makes continuation converge whatever the upstream does at the edge. DOC's own boundary behavior is unmeasured (the API rate-limited every probe), and without the drop a DOC that widened a boundary to its 15-minute bucket would re-return a whole neighboring bucket on every `dateAsc` resume.

### TV windows are answered in whole clock hours

Measured live against the TV API with a known week of clips: a `startdatetime`/`enddatetime` window is answered on clip air time from the start floored to the clock hour through the end of the end's hour — a window of 17:30–18:30 returned clips from 17:22 and from 18:05, and 17:00–18:00 returned the same six, 18:05 included. A window spanning under 30 minutes is rejected with the plain-text body `Timespan is too short.` (20 minutes rejected, 30 accepted). `gdelt_get_tv_clips` therefore sends an explicit window widened to whole hours — the start floored to the hour, the end stretched to the end of that first hour when the window is shorter — which never adds an hour the caller's window does not reach but is always a span GDELT accepts, so continuation windows of any width work; the drop then keeps the caller's exact window. An end exactly on the hour is sent one second earlier: sent as is, GDELT would answer that whole next hour for the window's final second, spending `maxRecords` on clips the drop discards, so that second is left out — GDELT documents ENDDATETIME as exclusive. Because every request covers whole hours, the clips outside its window come back too and take `maxRecords` slots — a resumed `dateAsc` window floored to its hour gets the minutes already walked first — so below the ceiling a cut page tells the caller to continue at `maxRecords` 3,000 (measured live at 150: 146 of 150 slots went to the already-walked prefix). `gdelt_search_tv` and `gdelt_get_tv_context` return aggregates (timeline points, term counts) that cannot be trimmed back to an exact window, so they send the window as given; a window under 30 minutes gets GDELT's rejection with a recovery hint naming the TV minimum.

### Upstream text is escaped at the `content[]` boundary

GDELT titles, labels, clip shows and snippets, context terms, and station metadata are third-party text. Rendered raw, a nested `[x](y)` breaks an article link, `*…*` becomes emphasis, a trailing ` #` drops from a heading, `<b>` and `&copy;` render as HTML and ©, and a snippet line break opens a new list item. Every `format()` interpolation of upstream text goes through one shared escaper (`src/mcp-server/tools/markdown-escape.ts`); `structuredContent` keeps the raw value, and nothing is decoded or stripped. The escaper is a single linear pass that escapes only where CommonMark/GFM would parse markup — `_` only at a word boundary, `<` only before a tag or autolink opener, `&` only before a complete entity, a trailing `#` run only at a heading's end, a leading block marker only as a list item's first text — so a value without markup characters renders byte-identical (the live 159-station catalog is the regression fixture). Line breaks become spaces. Displayed URLs are never backslash-escaped. A plain bare URL passes through byte-identical; one carrying a character the escaper would change (a boundary `_`, `*`, `~`, a bracket, a backtick, a backslash, an entity) renders in autolink form, `<https://…>`, so it displays intact under strict CommonMark as well as under GFM's autolink literal — including two URLs in one paragraph whose underscores would otherwise pair up. A space, `<`, `>`, and ASCII controls cannot sit in an autolink and no valid URL carries them raw, so bare URLs percent-encode them; a value with no scheme cannot be an autolink and is escaped as text. A `[title](url)` destination is never displayed but must resolve to exactly the upstream URL: it takes the angle-bracket form when it contains a space or parenthesis, and its `\` and entity-forming `&` are backslash-escaped, because CommonMark decodes backslash escapes and entity references inside a destination and a backslash escape is the only way to keep the literal character — percent-encoding would change the URL (`%26` is not a query separator, and browsers read `\` as `/`).

Multi-line `format()` output separates a list from the next paragraph with a blank line; without one, CommonMark lazy continuation folds the paragraph into the list's last item (#49 — tone histogram bin headers joined the previous bin's article list).

### TV timeline responses use bounded point pages

`gdelt_search_tv` selects page membership from the full result in date-then-station order, then returns those points grouped by station. Each response carries at most 500 points from the requested `offset`. The same bounded page is used for `structuredContent` and rendered in full in `content[]`; `nextOffset` retrieves the next non-overlapping page with identical query inputs. A deterministic 10-station × 50-point formatter fixture measures 28,449 bytes of structured JSON and 15,936 bytes of rendered text at the ceiling. Ten station selectors and the 500-point ceiling therefore keep request construction and both MCP surfaces bounded without hiding points on one client surface.

This is server-side pagination over a fresh upstream timeline, not a GDELT cursor. Historical archive queries are the intended workflow; callers paging a mutable window should keep every query input fixed and expect new upstream data to change later pages.

### Timeline dates and request enums mirror GDELT

DOC and TV timeline dates are normalized at the service boundary (`YYYYMMDD` → `YYYY-MM-DD`, `YYYYMMDDTHHMMSSZ` → ISO date-time). Resolution fallback uses the smallest positive interval across all usable points instead of the timestamp's spelling. DOC represents 15-minute, hourly, and daily intervals; TV preserves or infers `hour`, `day`, `week`, `month`, and `year`, and exposes the same values through `dateres`.

Timeline smoothing is sent upstream as `TIMELINESMOOTH`. TV clips use `DateAsc`/`DateDesc`; DOC article search exposes `dateDesc`, `dateAsc`, `toneDesc`, `toneAsc`, and `hybridRel`, while `relevance` omits `SORT` to use GDELT's documented default.

### Per-point article rendering stays capped by default

`gdelt_get_coverage_timeline`'s `structuredContent` carries every article reference GDELT returns for every timestep; only `format()` caps the rendered links, at 3 per point. Measured with the real `format()` at the documented maximum (288 timesteps × 10 articles), rendering all of them produces **567 KB** of `content[]` against **180 KB** capped — roughly triple, and far past what any sibling tool emits. The cap therefore stays, but it is neither silent nor terminal: each point prints its true count alongside how many links it showed, and `points: [...]` renders named timesteps in full for **+1.4 KB** per point. Cheap selective expansion is what makes the default cap defensible.

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
