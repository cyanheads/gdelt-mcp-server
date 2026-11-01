# gdelt-mcp-server — Design

## Scope

Expose the GDELT DOC and TV APIs as read-only search and analysis tools. DOC article search and relative `timespan` windows cover the rolling last three months of global news. Explicit `startDatetime`/`endDatetime` windows reach older coverage only in the modes GDELT has answered for such windows: the `volume` and `tone` timelines, the language and country breakdowns, and the tone distribution. `volume_raw` and `volume_with_articles` keep the three-month limit. TV covers monitored television captions, with date ranges that vary by station. Historical television is a separate corpus, not a substitute for historical global newspapers.

No API key is required. DOC and TV share an outbound pacer and a response cache; theme lookup uses a separate host. An optional local GKG mirror can answer the DOC tools when the DOC API does not. Tools return the same data through structuredContent and rendered content.

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
| `GdeltResponseCache` | none (process memory) | Stored DOC and TV answers and the fetches in flight, behind `gdeltFetch` |
| DOC source router | none | Sends each DOC tool call to the DOC service, then to the mirror when DOC gives no data |
| `GkgMirrorClient` | `data.gdeltproject.org/gdeltv2` GKG files | Optional: worker thread that owns the mirror store, answers compiled DOC requests, and runs refreshes |

DOC and TV requests share one request slot. The minimum gap starts after the previous response completes, not when it starts. Rate-limit responses close a shared cooldown gate, and requests that cannot start within their queue allowance are shed before network I/O. Theme lookup bypasses this pacer because it uses a different host.

Request attempts have a timeout; the whole call, including retries, has a deadline of twice the configured attempt timeout. Caller cancellation propagates unchanged. Rate-limit responses fail fast within the retry loop, including recognized HTTP-200 HTML/text rate-limit bodies; the public `gdelt_rate_limited` error is retryable after that processing. It carries backoff guidance rather than promising recovery after five seconds. Transient upstream failures that exhaust retries become retryable `gdelt_unavailable`; caller input errors and non-retryable upstream failures retain their classification. Error text and recovery hints use the framework's rendering boundary.

### Response cache and stale serve

`gdeltFetch` keeps a process-wide cache of DOC and TV answers. GDELT data is public and requests carry no credentials, so one cache serves every session and tenant. The key is the exact upstream URL with no normalization: a `timespan` goes upstream verbatim, so its key does not move with the clock, and the freshness window bounds how far its answer drifts. Count-page `offset`/`limit` and `points`, `bins`, or `series` selectors are applied after the fetch, so every page and expansion of one query shares a key.

- **Fresh hits.** An answer is fresh for 15 minutes, GDELT 2.0's update interval, or for 24 hours when the URL's `enddatetime` fell more than 24 hours before the fetch (TV's documented processing lag is up to 24 hours, and DOC indexes behind each batch). A fresh hit is answered before the retry loop, so it takes no pacer slot, request gap, or cooldown wait. Each hit decodes its own copy of the stored bytes, so callers never share objects.
- **What is stored.** Only parsed answers with a non-empty top-level array. Refusals, failures, and empty answers (GDELT's `{}` among them) are returned as they came and never stored, so a degraded answer is not pinned. The store is byte-charged against 128 MiB, least recently used first; a body over 32 MiB is returned but not kept. Entries are kept 24 hours after their fetch unless evicted sooner.
- **Shared fetches.** Concurrent calls for the same URL and retry count share one fetch under its own signal and deadline. A caller that cancels fails alone with `RequestCancelled`; the fetch aborts when its last caller leaves.
- **Stale serve.** When a refetch ends in `gdelt_rate_limited` or `gdelt_unavailable` (decided on the final classified error), or comes back empty, the stored answer is returned while it is still servable: under 24 hours old and, for a `timespan` URL, no older than the timespan itself. A timespan the server cannot parse is never served stale. `invalid_query`, serialization failures, and the caller's cancellation never fall back. The response carries `staleResponse` (`fetchedAt`, `ageSeconds`, `reason`: `gdelt_rate_limited`, `gdelt_unavailable`, or `gdelt_empty`), written by the fetch layer so a handler's notice cannot overwrite it, and the absorbed failure is logged at warning level. A stale `timespan` answer covers the window ending at `fetchedAt`, not now.
- **Gate first.** A call that holds a servable answer, or a fallback to the mirror, does not queue behind a closed cooldown gate. While the pacer's gate is closed it serves the stored answer at once as `gdelt_rate_limited`, or rejects at once with that reason when only a mirror stands behind it, spending no request and no queue slot.
- **45 s budget.** Such a call also stops waiting on GDELT 45 seconds after it started, so the answer arrives inside the 60 seconds MCP clients commonly allow. It serves the stored answer (or rejects, for a mirror fallback) as `gdelt_rate_limited` if its request never went upstream, and `gdelt_unavailable` once one did. A call with neither a stored answer nor a fallback waits as long as the fetch takes.
- **Station labels.** The TV station-label lookup takes fresh hits only. It runs on the first caller's context, where a stale serve would mark that caller's own fresh answer as stale.

### Configuration

| Variable | Default | Meaning |
|:---------|:--------|:--------|
| `GDELT_BASE_URL` | `https://api.gdeltproject.org/api/v2` | DOC/TV API root |
| `GDELT_REQUEST_DELAY_MS` | `5300` | Minimum milliseconds after a response before the next request |
| `GDELT_REQUEST_TIMEOUT_MS` | `60000` | Per-attempt timeout; total call deadline is twice this |
| `GDELT_CLAMP_LIMITS` | `true` | Clamp oversized count inputs; false restores strict served maxima |
| `GDELT_MIRROR_PATH` | unset | SQLite file of the local GKG mirror; unset leaves the mirror off |
| `GDELT_MIRROR_WINDOW_DAYS` | `7` | Days of 15-minute GKG slots the mirror keeps, 1–90, ending at the newest published slot |

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

Pagination re-reads an upstream query rather than following a provider snapshot cursor. Within the response cache's freshness window every page comes from one stored answer, so pages of a query agree; past it the query is fetched again, and changing upstream data can change subsequent pages. Keep query inputs fixed while paging.

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

Station catalog filters match complete station IDs, network values, or market values case-insensitively, combined with AND. No filters returns the whole catalog; an empty unfiltered catalog is an upstream failure. isActive means the monitoring end date, read as a UTC day, is within the last 24 hours, while historical validity depends on each station's startDate/endDate.

Provider timeline/clip labels resolve against catalog descriptions to optional station IDs. Labels, IDs, and archive URL prefixes are different identifiers. A failed side lookup preserves the answer and stationName, omits station, and discloses the failure. Missing labels stay empty rather than becoming fabricated names. The shared successful catalog is process-cached; failed loads are not retained. Waiting is bounded by 45 seconds from the call's start or the shorter call deadline, and an abandoned shared lookup is aborted when it has no remaining waiter.

### Dates and smoothing

Explicit dates are paired real UTC calendar timestamps in YYYYMMDDHHMMSS form, with start earlier than end. A complete explicit pair takes precedence over timespan. Explicit dates pass to GDELT unchanged, with no age check; which modes answer a window older than three months is stated in Scope. Relative windows the server resolves itself (for out-of-window filtering, continuation windows, and notices) step back in UTC, as GDELT reads `timespan`, so hours, days, and weeks are exact multiples of an hour whatever the host's time zone. Relative parsing handles short and documented long units, weeks, case, and outer whitespace. DOC rejects recognized windows shorter than 15 minutes. TV rejects obvious malformed relative text locally while leaving blanks and unknown numeric-unit syntax to the provider; a provider date rejection receives a specific hint rather than automatically being called a malformed timespan.

DOC dates normalize to ISO date/date-time with 15min, hour, or day resolution. TV uses hour, day, week, month, or year; recognized provider metadata wins, then requested resolution, then inference from the smallest positive point interval.

Timeline and breakdown smoothing accepts 0–30 timesteps and is sent as TIMELINESMOOTH. Zero and one leave values unsmoothed. Width N requires N source steps; notices explain missing leading moving-average steps and potential lag without inventing an observed loss count or measured peak delay. Notices compose with paging and empty-result guidance.

### Theme lookup

Theme discovery searches identifiers, because the lookup provides no natural-language labels. Matching uses token prefixes, allows adjacent tokens to join, and makes one disclosed singular retry only when plural words return no matches. Exact identifiers rank first, followed by listed count and identifier. The listed count is an undocumented static lookup figure, never a live article total.

The parsed lookup is cached once per process, with concurrent initial callers sharing one load; a failed load is not cached. A load failure is retryable gdelt_unavailable rather than a successful empty taxonomy result. Not bundling a snapshot avoids growing every installation for a tool that may never be called.

## GKG mirror

GDELT's DOC API sometimes refuses requests for long stretches and answers `{}` while shedding load. The mirror is a local copy of the Global Knowledge Graph that GDELT publishes as static files, which the four DOC tools can fall back to. It is off unless `GDELT_MIRROR_PATH` is set, and it never serves TV or theme tools.

### Services

| Piece | Role |
|:------|:-----|
| `gkg-feed` | The two `lastupdate` manifests, 15-minute slot arithmetic, paced downloads (fixed 2 s between files, `User-Agent` naming this repo), zip inflation with CRC-32 and, for each feed's current slot, manifest size and MD5 checks, and the mapping from a GKG 2.1 row to a stored row |
| `gkg-mirror-store` | Store spec on the framework's SQLite mirror (FTS5 over title, persons, organizations, locations, themes), the `gkg_slots` ledger, the domain-to-country table, and the sync generator behind init and refresh |
| `doc-query-compiler` | Compiles a DOC query string to a predicate plan, or refuses it naming the operator |
| `gkg-mirror-queries` | Emulates `artlist`, the timeline modes, `tonechart`, and the two breakdowns from stored rows, with DOC's bucket widths for the requested window |
| worker and client | One worker thread owns the store; the main thread posts status, query, refresh, and close requests. Bun uses `bun:sqlite`; Node needs `better-sqlite3` |
| DOC source router | Decides, per call, whether the mirror can answer, and combines DOC's and the mirror's outcomes |

Only slots ingested in both feeds are answered for. Rows are keyed by URL and carry the 15-minute slot as `date`. Init and refresh are the same walk over slots missing from the ledger, so an interrupted run of either resumes where it stopped. `mirror:init`, `mirror:refresh`, and `mirror:verify` run out-of-band; the server never initializes the store. On HTTP transport the server schedules a refresh every 15 minutes from startup, and a run before an init has completed does nothing; on stdio the operator schedules `mirror:refresh`.

### Routing rule

Before DOC is asked, the router checks that the mirror could answer: the query compiles, the window resolves (a `timespan`, explicit dates, or DOC's three-month default), the mirror has completed an init, and the window overlaps the slots it holds. If any check fails, DOC is called alone and the call waits on it as it would without a mirror. Otherwise DOC is called under the 45 s fallback budget, and:

| DOC | Mirror | Result |
|:----|:-------|:-------|
| answered | not consulted | `source: doc_api` |
| empty | at least one match | `source: gkg_mirror`, notice says DOC returned nothing, which GDELT also does under load |
| empty | zero matches, or cannot answer | DOC's empty result, `source: doc_api`, `attempts` lists both |
| rate-limited or unavailable | answered, matches or not | `source: gkg_mirror`, notice discloses the divergence; zero matches adds that title-and-entity matching is not evidence of no coverage |
| rate-limited or unavailable | answered part of the window | as above, plus `coverage` |
| rate-limited or unavailable | cannot answer | DOC's error code and reason, with the mirror's reason in the message and a hint naming the change that would let it answer; `data.attempts` lists both |

`invalid_query` and the caller's cancellation never reach the mirror. A stored answer served stale counts as DOC's answer, so the mirror is not consulted. The mirror gets what remains of 55 s after the call started, and a query it has not answered within 30 s; past either it is a `store_error`.

Every mirror answer says that keywords matched titles and entity names rather than article text and that counts and shares are over mirrored articles. A country breakdown also counts matching articles from outlets with no known source country, which it leaves out.

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
- Cache DOC and TV answers by exact upstream URL, fresh for 15 minutes (24 hours once an explicit window ended over a day ago), because GDELT refuses requests long after the documented pacing is met and each repeat of a page or evidence expansion would spend a scarce slot. No normalization, since a `timespan` already goes upstream verbatim.
- Never store an empty answer, and stale-serve on an empty refetch as well as on refusals: GDELT answers `{}` while shedding load, including to queries that certainly match, so an empty refetch is not evidence that the stored answer is wrong, and a stored empty would pin the degradation.
- Key mirror rows by URL, not by GKG record ID: record IDs restart within a file and name different articles, while URLs did not collide in sampled rows. A URL that reappears in a newer slot keeps its newer row.
- Run the mirror store on one worker thread. Both SQLite drivers are synchronous, and a broad filter aggregates hundreds of thousands of rows per call, which would stall the serving event loop.
- Compile mirror queries of at most 1,000 characters and 100 elements. The worker answers one query at a time, so the bound caps what any one call can hold it for; a longer query goes to DOC alone, as it would without a mirror.
- Treat a 404 on a slot file as pending, stopping that feed's walk for the run, until the slot is two hours older than the feed's manifest slot, then record a gap and continue. A manifest-listed file can answer 404 for a few minutes (the translation feed has), so a short wait recovers the slot; other non-200 statuses stop the run and the next run resumes from the ledger.
- Consult the mirror when DOC is rate-limited, unavailable, or empty, and accept an empty DOC answer's replacement only when the mirror has a match. Empty is a trigger because GDELT sends `{}` under load as well as for no matches; requiring a match keeps a true zero from being replaced by a weaker source's zero.
- Pass explicit dates to GDELT unclamped, and advertise an older window on a surface only for a mode GDELT has answered live for one. The documentation contradicts itself on the reach of `startdatetime`, and answering for five modes does not establish the other two, so those keep the three-month wording until their own check passes.
- Resolve relative windows with UTC arithmetic. GDELT reads `timespan` in UTC, and stepping with local-time setters puts a window that crosses a daylight-saving change an hour off on hosts in such a zone.

## Known Limitations

- DOC's rolling three-month window excludes historical global article retrieval. Bulk historical GDELT data is outside this server.
- TV monitoring varies by station, network, and market; consult current catalog dates rather than applying one universal archive boundary. The catalog does not guarantee uninterrupted coverage inside a date range.
- Provider caps can prevent complete article/clip retrieval, especially dense TV hours. There is no cursor past those caps.
- GDELT rate limiting and temporary failures can persist beyond minimum spacing; no TV-availability guarantee is made. The response cache serves stored answers only for requests this process has already made, for at most 24 hours, and DOC also answers empty while overloaded, so an empty DOC answer is not by itself evidence of no coverage.
- Article metadata and short TV excerpts are discovery evidence, not full documents.
- Taxonomy identifiers have no labels or synonym index; a zero identifier search does not prove no related theme exists.
- Query-driven upstream data is not a transactionally stable pagination snapshot beyond the cache's freshness window.
- Mirror answers differ from DOC's: keywords match titles and entity names, not article text, and translated articles keep source-language titles; `theme:` matches the exact theme ID; `sourcecountry` comes from GDELT's 2015 domain-to-country file, which covered 83–92% of sampled rows; counts and shares are over mirrored articles. `nearN:`, `repeatN:`, the image operators, unknown `name:` operators, and comparisons other than `tone`/`toneabs` are not compiled, a `sourcelang:` or `sourcecountry:` value it cannot resolve is refused, and so are an unquoted one-character or hyphenated keyword, an OR group that nests or holds an exclusion, an excluded OR group, and a query over 100 elements or 1,000 characters. The mirror answers only inside the window it holds; when that is less than the requested window, `coverage` says so.
