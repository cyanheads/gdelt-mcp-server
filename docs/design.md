# gdelt-mcp-server — Design

## Scope

Expose the GDELT DOC and TV APIs as read-only search and analysis tools. DOC covers the rolling last three months of global news; TV covers monitored television captions, with date ranges that vary by station. Historical television is a separate corpus, not a substitute for historical global newspapers.

No API key is required. DOC and TV share an outbound pacer; theme lookup uses a separate host. Tools return the same data through structuredContent and rendered content.

## MCP Surface

| Tool | Purpose | Chaining contract |
|:-----|:--------|:------------------|
| `gdelt_search_articles` | Recent-news links and sparse metadata | Inspect source URLs for full text; follow provider-cap continuation notices |
| `gdelt_get_coverage_timeline` | Normalized volume, raw matching-article counts, volume with references, or average tone over time | Use returned dates to expand supplied references with `points` |
| `gdelt_get_tone_distribution` | Tone-bin article counts and representative links | Use returned bins to expand supplied references |
| `gdelt_get_coverage_breakdown` | Topic intensity by source country or language | Copy exact returned labels into `series`; different source shares are not additive |
| `gdelt_search_themes` | GKG taxonomy identifier discovery | Use returned paste-ready `operator` in DOC queries |
| `gdelt_search_tv` | Separate-station or pooled Combined coverage timelines | Resolve IDs and monitoring dates through the station catalog |
| `gdelt_get_tv_clips` | Caption excerpts, show/station labels, air dates, and archive links | Inspect clips after locating relevant dates; no cursor past the provider cap |
| `gdelt_get_tv_context` | Relevance-sampled vocabulary with relative scores | Compare stations/windows in separate calls, then inspect clips |
| `gdelt_get_tv_breakdown` | Station/show rankings over a fixed window | Read valueUnit; show percentages remain percentages even when normalize is false |
| `gdelt_list_tv_stations` | Station IDs, network/market values, and monitoring ranges | Resolve identifiers and establish covered dates before TV analysis |

Every tool declares read-only and open-world annotations. No task prompts or domain-data resources are registered. The published `skills/gdelt-guide/SKILL.md` supplies workflow and interpretation gates; `createApp({ skills: 'skills' })` also serves it through the MCP Skills extension.

## Services and request lifecycle

| Service | Upstream | Responsibility |
|:--------|:---------|:---------------|
| `GdeltDocService` | `/api/v2/doc/doc` | Article lists, timelines, tone histogram, source breakdowns |
| `GdeltTvService` | `/api/v2/tv/tv` | TV timelines, clips, vocabulary, rankings, station metadata and ID resolution |
| `GdeltThemeService` | `data.gdeltproject.org/api/v2/guides/LOOKUP-GKGTHEMES.TXT` | Process-cached theme index and identifier search |

DOC and TV requests share one request slot. The minimum gap starts after the previous response completes, not when it starts. Rate-limit responses close a shared cooldown gate, and requests that cannot start within their queue allowance are shed before network I/O. Theme lookup bypasses this pacer because it uses a different host.

Request attempts have a timeout; the whole call, including retries, has a deadline of twice the configured attempt timeout. Caller cancellation propagates unchanged. Rate-limit responses fail fast within the retry loop, including recognized HTTP-200 HTML/text rate-limit bodies; the public `gdelt_rate_limited` error is retryable after that processing. It carries backoff guidance rather than promising recovery after five seconds. Transient upstream failures that exhaust retries become retryable `gdelt_unavailable`; caller input errors and non-retryable upstream failures retain their classification. Error text and recovery hints use the framework's rendering boundary.

### Configuration

| Variable | Default | Meaning |
|:---------|:--------|:--------|
| `GDELT_BASE_URL` | `https://api.gdeltproject.org/api/v2` | DOC/TV API root |
| `GDELT_REQUEST_DELAY_MS` | `5300` | Minimum milliseconds after a response before the next request |
| `GDELT_REQUEST_TIMEOUT_MS` | `60000` | Per-attempt timeout; total call deadline is twice this |
| `GDELT_CLAMP_LIMITS` | `true` | Clamp oversized count inputs; false restores strict served maxima |

Definitions are imported during application setup after environment loading, so lazy count schemas advertise the configured clamp policy.

## Output and count contracts

### Count pages

Aggregate results page whole units by `offset` and `limit`, with `nextOffset` when more remain. There is no response byte budget.

| Output | Page unit | Default | Cap |
|:-------|:----------|--------:|----:|
| DOC timeline | Timestep | 10 | 400 |
| Tone distribution | Histogram bin | 10 | 400 |
| DOC source breakdown | Complete series | 10 | 75 |
| TV timeline | Point across station series | 500 | 20,000 |
| TV context | Score-sorted term | 25 | 25,000 |
| TV ranking | Station/show row | 25 | 10,000 |
| Theme lookup | Match | 25 | 100 |

When clamping is enabled, count schemas advertise a minimum and default without an artificial multiple-of-cap headroom maximum. A count beyond its cap runs at the cap and produces one `limitClamp` disclosure, log record, and counter increment. At or below the cap none is emitted. Strict deployments reject counts over the cap. Station arrays are selectors, not counts: every supplied ID is forwarded, with no ten-station cap or silent subset.

Pagination reruns an upstream query rather than following a provider snapshot cursor. Keep query inputs fixed while paging; changing upstream data can change subsequent pages.

### Article and clip lists

Article search defaults to 75 records and caps at 250; TV clips default to 50 and cap at 3,000. Return all fetched records within an explicit requested window, in upstream order, without byte cuts or `withheldCount`. Explicit-window clipping removes out-of-window upstream records and discloses the drop. Relative windows are resolved by the provider, so those records are not clipped against an invented server-side clock.

Cap detection uses the upstream count before clipping. A cap-hit notice distinguishes a provider ceiling from a complete result and offers continuation windows when useful. Neither API exposes a record offset/cursor. Returned windows and notices govern continuation; narrowing the time range does not guarantee that all matching records become retrievable.

TV clip requests are answered in whole clock hours. The service sends a compatible widened request, and the tool keeps only records within the caller's exact explicit window. An on-the-hour end is sent one second earlier to avoid spending the provider cap on the following hour. When an hour itself exceeds the 3,000-clip ceiling, narrower windows inside it fetch the same capped set; the remaining clips are unreachable through this API.

Article fields include URL, title, seendate, domain, language, source country, and optional social image. They do not include full article text or author metadata. Clip fields include show, stationName, optional resolved station, date, snippet, archiveUrl, and optional thumbnail.

### DOC timeline and evidence

| Mode | Upstream mode | Value |
|:-----|:--------------|:------|
| `volume` | `timelinevol` | Topic's normalized share of monitored coverage |
| `volume_raw` | `timelinevolraw` | Distinct matching-article count; moving average when smoothed |
| `volume_with_articles` | `timelinevolinfo` | Normalized volume plus supplied article references |
| `tone` | `timelinetone` | Average tone score |

Raw volume alone preserves `norm`, the unsmoothed monitored-article denominator, on data points and the peak. A smoothed matching count divided by an unsmoothed denominator is not an independently reconstructed normalized timeline.

Reference previews contain the first three links GDELT supplied per timestep or histogram bin. `referenceCount` is the supplied-link count, not the matching-article count. Exact `points` or `bins` selectors return only requested units with all supplied references; they do not retrieve every matching article. Unknown selectors fail with available values instead of being silently ignored.

Timeline `totalCount`, resolution, series `pointCount` and peak cover the full upstream result, not the returned page. Tone `totalCount` sums article counts across all bins; its summary also covers the whole histogram. Page notices identify which units were returned.

### Source breakdowns

The overview exposes the top ten country/language series ranked by the sum of values and lists remaining exact labels in `otherSeriesLabels`. Selecting labels returns only those complete series under `selectedSeries`, paged by count. Unknown labels fail with `unknown_series`.

Each point is the topic's share of that source's media output. Values from different sources do not add into a global share, and the sum used to rank one series is not an absolute article count. `sourcecountry` describes outlet origin, not event location. Preserve provider labels exactly; operator spellings are not inferred from display labels.

### TV timelines, rankings, and context

Separate-station timeline pages order membership by date then stationName and group the selected points by station. `totalPoints` covers the full result; timeRange and rendered per-station sums/peaks describe the returned page. Normalized values are percentages of station airtime; raw values count matching 15-second clips.

Combined mode pools matching clips and monitored denominators across selected stations. It is not an arithmetic average of station percentages. Preserve the provider's Combined label without fabricating a station ID or producing an unresolved-station warning; no station-catalog lookup is needed for that pooled series.

Station rankings use percent_station_airtime when normalized and matching_clips when raw. Show rankings always use percent_matching_clips, even when normalize is false. The returned valueUnit is authoritative. Provider-ellipsized show labels are display text and may not work as exact show selectors.

Context returns score-sorted words, totalTerms, offset, nextOffset, and truncated. totalTerms counts vocabulary, never analyzed clips. GDELT does not provide a reliable analyzed-clip count for context, so none is invented.

Context terms come from a relevance-ranked sample, documented by GDELT as the 200 most relevant matching clips. This is a sampling disclosure, not a server-enforced sample size or an exhaustive corpus count. Scores describe that sample's vocabulary; they do not establish prevalence across all matching coverage or prove editorial stance.

### Station identity

Station catalog filters match complete station IDs, network values, or market values case-insensitively, combined with AND. No filters returns the whole catalog; an empty unfiltered catalog is an upstream failure. isActive means the monitoring end date is within the last 24 hours, while historical validity depends on each station's startDate/endDate.

Provider timeline/clip labels resolve against catalog descriptions to optional station IDs. Labels, IDs, and archive URL prefixes are different identifiers. A failed side lookup preserves the answer and stationName, omits station, and discloses the failure. Missing labels stay empty rather than becoming fabricated names. The shared successful catalog is process-cached; failed loads are not retained. Waiting is bounded by 45 seconds from the call's start or the shorter call deadline, and an abandoned shared lookup is aborted when it has no remaining waiter.

### Dates and smoothing

Explicit dates are paired real UTC calendar timestamps in YYYYMMDDHHMMSS form, with start earlier than end. A complete explicit pair takes precedence over timespan. Relative parsing handles short and documented long units, weeks, case, and outer whitespace. DOC rejects recognized windows shorter than 15 minutes. TV rejects obvious malformed relative text locally while leaving blanks and unknown numeric-unit syntax to the provider; a provider date rejection receives a specific hint rather than automatically being called a malformed timespan.

DOC dates normalize to ISO date/date-time with 15min, hour, or day resolution. TV uses hour, day, week, month, or year; recognized provider metadata wins, then requested resolution, then inference from the smallest positive point interval.

Timeline and breakdown smoothing accepts 0–30 timesteps and is sent as TIMELINESMOOTH. Zero and one leave values unsmoothed. Width N requires N source steps; notices explain missing leading moving-average steps and potential lag without inventing an observed loss count or measured peak delay. Notices compose with paging and empty-result guidance.

### Theme lookup

Theme discovery searches identifiers, because the lookup provides no natural-language labels. Matching uses token prefixes, allows adjacent tokens to join, and makes one disclosed singular retry only when plural words return no matches. Exact identifiers rank first, followed by listed count and identifier. The listed count is an undocumented static lookup figure, never a live article total.

The parsed lookup is cached once per process, with concurrent initial callers sharing one load; a failed load is not cached. A load failure is retryable gdelt_unavailable rather than a successful empty taxonomy result. Not bundling a snapshot avoids growing every installation for a tool that may never be called.

## Workflow Analysis

### Recent-news spike investigation

Resolve a suitable theme with gdelt_search_themes when taxonomy search fits, then run gdelt_get_coverage_timeline with article references. Locate candidate spikes, expand supplied evidence at exact returned dates, and inspect article URLs before explaining the pattern. Use gdelt_search_articles for broader reporting in the same recent window, source breakdowns for outlet-country/language attention, and tone histograms for the distribution behind an average.

A source breakdown cannot establish where an event began, and representative links cannot prove the cause of a spike. Keep measured attention, tone, and evidence-supported explanations separate.

### Historical television comparison

List stations first and intersect their monitoring dates with the desired period. Pin explicit historical dates, compare station timelines with matching units/resolution/smoothing, then request context separately per station and inspect clips from the relevant dates. A Combined timeline answers pooled attention; separate station series answer station comparison.

Do not append a historical TV query to a recent DOC workflow without establishing a shared covered period. Do not treat historical TV captions as historical global newspaper evidence. Confirm coverage before interpreting absence, read continuation notices before claiming completeness, and distinguish sampled context vocabulary from measured coverage.

## Design Decisions

- Separate DOC and TV tools because their corpus and temporal scope differ; one historical-search interface would conceal that distinction.
- Consolidate DOC volume/tone timeline modes because they share query and output shape, while keeping tone histograms separate because distributions answer a different question.
- Use count pages for aggregate outputs and full fetched record lists for article/clip outputs. Provider caps and exact evidence selectors remain explicit; response byte size does not silently choose membership.
- Resolve station IDs from the live catalog rather than guessing from labels or bundling a parallel identifier map.
- Preserve source-series labels and units instead of inferring query operators or additive totals.
- Keep workflow gates in one published gdelt-guide, with essential scope and identifier guidance in the concise server instructions.
- Exclude the GEO API: its endpoint returned 404 during verification. Source-country breakdown describes outlet origin and is not a geographic event heat map.
- Retire unfiltered TV trending: TV analysis requires a selected station population, rather than silently presenting an undefined global aggregate.

## Known Limitations

- DOC's rolling three-month window excludes historical global article retrieval. Bulk historical GDELT data is outside this server.
- TV monitoring varies by station, network, and market; consult current catalog dates rather than applying one universal archive boundary. The catalog does not guarantee uninterrupted coverage inside a date range.
- Provider caps can prevent complete article/clip retrieval, especially dense TV hours. There is no cursor past those caps.
- GDELT rate limiting and temporary failures can persist beyond minimum spacing; no TV-availability guarantee is made.
- Article metadata and short TV excerpts are discovery evidence, not full documents.
- Taxonomy identifiers have no labels or synonym index; a zero identifier search does not prove no related theme exists.
- Query-driven upstream data is not a transactionally stable pagination snapshot.
