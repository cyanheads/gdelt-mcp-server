# gdelt-mcp-server — Design

## Scope

Expose the GDELT DOC, Context, and TV APIs as read-only search and analysis tools. DOC article search and relative `timespan` windows cover the rolling last three months of global news. Explicit `startDatetime`/`endDatetime` windows reach older coverage only in the modes GDELT has answered for such windows: the `volume` and `tone` timelines, the language and country breakdowns, and the tone distribution. `volume_raw` and `volume_with_articles` keep the three-month limit. The Context API answers sentence-level search over the last 72 hours of English-language coverage only. TV covers monitored television captions, with date ranges that vary by station. Historical television is a separate corpus, not a substitute for historical global newspapers.

No API key is required. DOC, Context, and TV share one request slot and a response cache, each API behind its own rate-limit cooldown; theme lookup uses a separate host. An optional local GKG mirror can answer the DOC tools when the DOC API does not, or when the window is one DOC refuses. Tools return the same data through structuredContent and rendered content.

## MCP Surface

| Tool | Purpose | Chaining contract |
|:-----|:--------|:------------------|
| `gdelt_search_articles` | Recent-news links and sparse metadata | Inspect source URLs for full text; follow provider-cap continuation notices |
| `gdelt_search_sentences` | Matching sentences with surrounding text, one per article, over the last 72 hours | Read the sentences before assigning a cause to a spike; follow `continuationWindow` for further matches and de-duplicate by `url` |
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
| `GdeltContextService` | `/api/v2/context/context` | Sentence matches over the last 72 hours; never answered from the mirror |
| `GdeltTvService` | `/api/v2/tv/tv` | TV timelines, clips, vocabulary, rankings, station metadata and ID resolution |
| `GdeltThemeService` | `data.gdeltproject.org/api/v2/guides/LOOKUP-GKGTHEMES.TXT` | Process-cached theme index and identifier search |
| `GdeltResponseCache` | none (process memory) | Stored DOC, Context, and TV answers and the fetches in flight, behind `gdeltFetch` |
| DOC source router | none | Sends each DOC tool call to the DOC service, then to the mirror when DOC gives no data; an explicit window under 30 minutes goes to the mirror alone |
| `GkgMirrorClient` | `data.gdeltproject.org/gdeltv2` GKG files | Optional: worker thread that owns the mirror store, answers compiled DOC requests, and runs refreshes |

DOC, Context, and TV requests share one request slot, and the minimum gap after each response applies across all three. The gap starts after the previous response completes, not when it starts. Each API (DOC, TV with its station catalog, Context) has its own rate-limit cooldown in front of the slot: a rate limit closes only the cooldown of the API that returned it, starting at 5 s and doubling to 60 s on that API's consecutive rate limits, and that API's own success resets it. A call waits out its cooldown without holding the slot, the slot takes the APIs in turn, and the cooldown is checked again when the request would go out. The queue allowance (90 s) covers the cooldown wait and the slot wait together; a request that cannot start within it is shed before network I/O. Theme lookup bypasses this pacer because it uses a different host.

Request attempts have a timeout; the whole call, including retries, has a deadline of twice the configured attempt timeout. Caller cancellation propagates unchanged. Rate-limit responses fail fast within the retry loop, including recognized HTTP-200 HTML/text rate-limit bodies; the public `gdelt_rate_limited` error is retryable after that processing. It carries backoff guidance rather than promising recovery after five seconds. Transient upstream failures that exhaust retries become retryable `gdelt_unavailable`; caller input errors and non-retryable upstream failures retain their classification. Error text and recovery hints use the framework's rendering boundary.

### Response cache and stale serve

`gdeltFetch` keeps a process-wide cache of DOC, Context, and TV answers. GDELT data is public and requests carry no credentials, so one cache serves every session and tenant. The key is the exact upstream URL with no normalization: a `timespan` goes upstream verbatim, so its key does not move with the clock, and the freshness window bounds how far its answer drifts. Count-page `offset`/`limit` and `points`, `bins`, or `series` selectors are applied after the fetch, so every page and expansion of one query shares a key.

- **Fresh hits.** An answer is fresh for 15 minutes, GDELT 2.0's update interval, or for 24 hours when the URL's `enddatetime` fell more than 24 hours before the fetch (TV's documented processing lag is up to 24 hours, and DOC indexes behind each batch). A fresh hit is answered before the retry loop, so it takes no pacer slot, request gap, or cooldown wait. Each hit decodes its own copy of the stored bytes, so callers never share objects.
- **What is stored.** Only parsed answers with a non-empty top-level array. Refusals, failures, and empty answers (GDELT's `{}` among them) are returned as they came and never stored, so a degraded answer is not pinned. The store is byte-charged against 128 MiB, least recently used first; a body over 32 MiB is returned but not kept. Entries are kept 24 hours after their fetch unless evicted sooner.
- **Shared fetches.** Concurrent calls for the same URL and retry count share one fetch under its own signal and deadline. A caller that cancels fails alone with `RequestCancelled`; the fetch aborts when its last caller leaves.
- **Stale serve.** When a refetch ends in `gdelt_rate_limited` or `gdelt_unavailable` (decided on the final classified error), or comes back empty, the stored answer is returned while it is still servable: under 24 hours old and, for a `timespan` URL, no older than the timespan itself. A timespan the server cannot parse is never served stale. `invalid_query`, serialization failures, and the caller's cancellation never fall back. The response carries `staleResponse` (`fetchedAt`, `ageSeconds`, `reason`: `gdelt_rate_limited`, `gdelt_unavailable`, or `gdelt_empty`), written by the fetch layer so a handler's notice cannot overwrite it, and the absorbed failure is logged at warning level. A stale `timespan` answer covers the window ending at `fetchedAt`, not now.
- **Gate first.** A call that holds a servable answer, or a fallback to the mirror, does not queue behind its API's closed cooldown. While that API's cooldown is closed it serves the stored answer at once as `gdelt_rate_limited`, or rejects at once with that reason when only a mirror stands behind it, spending no request and no queue slot. Another API's closed cooldown does not count: that call goes upstream.
- **45 s budget.** Such a call also stops waiting on GDELT 45 seconds after it started, so the answer arrives inside the 60 seconds MCP clients commonly allow. It serves the stored answer (or rejects, for a mirror fallback) as `gdelt_rate_limited` if its request never went upstream, and `gdelt_unavailable` once one did. A call with neither a stored answer nor a fallback waits as long as the fetch takes.
- **Station labels.** The TV station-label lookup takes fresh hits only. It runs on the first caller's context, where a stale serve would mark that caller's own fresh answer as stale.

### Configuration

| Variable | Default | Meaning |
|:---------|:--------|:--------|
| `GDELT_BASE_URL` | `https://api.gdeltproject.org/api/v2` | DOC, Context, and TV API root |
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

Cap detection uses the upstream count before clipping, or the mirror's own match count on an answer it gave, where the notice states it. A cap-hit notice distinguishes a provider ceiling from a complete result and offers continuation windows when useful. A DOC window under 60 minutes has no halves, since each would fall under the 30-minute minimum DOC accepts: where the mirror can answer the query, it gets one window per 15-minute slot the mirror holds, and a mirror answer down to one slot says to narrow the query, because every article in a slot carries the same `seendate`. When the window DOC searched has slots before the mirror's oldest or after its newest, the notice names the part the mirror holds and says the rest is out of reach. Neither API exposes a record offset/cursor. Returned windows and notices govern continuation; narrowing the time range does not guarantee that all matching records become retrievable.

TV clip requests are answered in whole clock hours for a window up to 7 days, whole UTC days under 3×365 days, and whole UTC months beyond. A window under two hours goes out widened to its clock hours, which meets GDELT's 30-minute minimum; a longer one goes out as given, so GDELT picks its period from the caller's own span. The tool keeps only records within the caller's exact explicit window; edge clips from a wider period still spend `maxRecords`. An on-the-hour end is sent one second earlier to avoid spending the provider cap on the following hour, the end rule every TV tool shares (see TV timelines, rankings, and context). When an hour itself exceeds the 3,000-clip ceiling, narrower windows inside it fetch the same capped set; the remaining clips are unreachable through this API.

Sentence search returns one match per article, newest first by default, and `maxRecords` (default 25, cap 200) counts sentences before GDELT keeps one per article, so a page runs short of it. A page that is not every match carries `continuationWindow`, the window to re-run for the next matches. GDELT reads Context window bounds only to the minute, so the next window's edge sits on the whole minute at or past the page's far-edge match, the matches seen in that minute repeat, and the caller de-duplicates by `url`. The notice distinguishes a page that holds every match in its window from one where no narrower window reaches further and only a larger `maxRecords` can; a page whose matches all fall in one minute is the second kind. At the 200 ceiling that page hands back the window past its minute, ending on the minute's first second under `dateDesc` and starting on the next minute under `dateAsc`: no bound splits the minute, but the rest of the window is still in reach (measured live, a dense-minute `dateAsc` page and then the window from the next minute answered the newer matches), so a broad walk loses that minute's remainder rather than everything after it.

Article fields include URL, title, seendate (when GDELT saw the article, not its publication time), domain, language, source country, and optional social image. They do not include full article text or author metadata. Sentence fields add the matching sentence, its surrounding context, and whether it holds a quotation mark. Clip fields include show, stationName, optional resolved station, date, snippet, archiveUrl, and optional thumbnail.

### DOC timeline and evidence

| Mode | Upstream mode | Value |
|:-----|:--------------|:------|
| `volume` | `timelinevol` | Topic's normalized share of monitored coverage |
| `volume_raw` | `timelinevolraw` | Distinct matching-article count; moving average when smoothed |
| `volume_with_articles` | `timelinevolinfo` | Normalized volume plus supplied article references |
| `tone` | `timelinetone` | Average tone score |

Raw volume alone preserves `norm`, the unsmoothed monitored-article denominator, on data points and the peak. A smoothed matching count divided by an unsmoothed denominator is not an independently reconstructed normalized timeline.

Reference previews contain the first three links GDELT supplied per timestep or histogram bin. `referenceCount` is the supplied-link count, not the matching-article count. Exact `points` or `bins` selectors return only requested units with all supplied references; they do not retrieve every matching article. Unknown selectors fail with available values instead of being silently ignored.

Timeline `totalCount`, resolution, series `pointCount` and peak cover the full upstream result, not the returned page. The resolution is the recognized `query_details.date_resolution` GDELT reports, else inferred from the spacing of the returned timesteps. `pointCount` counts the points GDELT returned, which is fewer than the window's timesteps when GDELT left some out. Tone `totalCount` sums article counts across all bins; its summary also covers the whole histogram. Page notices identify which units were returned.

`missingTimesteps` counts the timesteps missing between the first and last timestep returned, one resolution step apart, with a notice naming every missing run; GDELT answers a timestep without matching coverage with 0, so a left-out one is a gap in its data and the notice says so. It is computed over the whole answer (the union of every series' dates) before paging, `points`, `series` selection, or `includePoints`, so every page reports the same figure, and a stale-served answer is checked like a live one. Every timeline mode is checked: measured live, the tone timeline of a query and window carries the same timesteps as its volume timeline (159 of 169 hourly steps, 0 where no article matched). It is never reported for an answer from the mirror, which builds its own steps, or when no resolution is known. A resolution names the step without showing the answer takes it: an inferred one is only the nearest DOC uses to the smallest interval (dates a week apart infer `day`), and a reported one is DOC's label, not its spacing. So a count is reported only when two returned timesteps sit exactly one step apart; a false "gap in GDELT's data" costs a caller more than a missed one.

### Source breakdowns

The overview ranks every country/language series by the sum of values, pages them by count, and lists the exact labels of ranked series not on the page in `otherSeriesLabels`. Selecting labels returns only those complete series under `selectedSeries`, paged by count; a label that several series share selects all of them. Unknown labels fail with `unknown_series`. Every returned series carries `sum` (its ranking key), `pointCount`, and `peak` over its whole series, on every page; `includePoints: false` leaves `data` out of each returned series without changing ranking, paging, or any other field. The breakdown reports `dateResolution` and `missingTimesteps` as the timeline does, counted over every series of the whole answer, so every page, selection, and `includePoints` setting reports the same figure.

Each point is the topic's share of that source's media output. Values from different sources do not add into a global share, and the sum used to rank one series is not an absolute article count. `sourcecountry` describes outlet origin, not event location. Preserve provider labels exactly. Each series carries `operator` (`sourcecountry:<FIPS>`, FIPS rather than ISO, or `sourcelang:<name>`), looked up in GDELT's own country and language code tables from the label's name and never inferred from its spelling; a name that maps to no code or to several has none.

### TV timelines, rankings, and context

Separate-station timeline pages order membership by date then stationName and group the selected points by station. `totalPoints` covers the full result, and each series' `pointCount` and `peak` cover its whole series on every page; timeRange and the rendered per-station sum and page peak describe the returned page. Each point counts one whole UTC period (clock hour, day, Sunday–Saturday week, month, or year) and is dated by the period's label: the hour's start, or 12:00:00Z of the first day for longer periods.

GDELT widens an explicit window outward to whole periods, so a timeline, ranking, or word cloud covers more than the window asked for. Every period starts on the clock hour and GDELT documents ENDDATETIME as exclusive, so every TV tool that takes a window sends an end exactly on the clock hour one second earlier; sent as is, it would count the whole period starting there for one second outside the window. An on-the-hour end inside a longer period stays in that period, and its values do not change. GDELT picks the period from the span it is sent, so the trimmed second moves a window to the finer period at exactly two lengths, 3×365 days (months to days) and 7 days and a second (days to hours). There `gdelt_search_tv` sends the caller's span's resolution as `dateres` unless the caller set one, so the timeline keeps its points, while rankings and word clouds take the finer answer. A window the trim would leave under 30 minutes goes as given, because GDELT refuses 29 minutes 59 seconds (`Timespan is too short.`); its values count the hour after its end. When an explicit edge falls off a period boundary, the notice names the UTC window the values cover, at the resolution GDELT reported, or the one its window-length rule picks (see Dates and smoothing); it reads the window sent and quotes the window requested, so an end on a period boundary draws none when the start is aligned too. A `timespan` is resolved on GDELT's clock and draws no such sentence. Normalized values are percentages of station airtime; raw values count matching 15-second clips.

Combined mode pools matching clips and monitored denominators across selected stations. It is not an arithmetic average of station percentages. Preserve the provider's Combined label without fabricating a station ID or producing an unresolved-station warning; no station-catalog lookup is needed for that pooled series.

Station rankings use percent_station_airtime when normalized and matching_clips when raw. Show rankings always use percent_matching_clips, even when normalize is false. The returned valueUnit is authoritative. Provider-ellipsized show labels are display text and may not work as exact show selectors.

Context returns words sorted by score and then exact label, with totalTerms, offset, nextOffset, and truncated; GDELT's own order among tied scores varies between identical calls. totalTerms counts vocabulary, never analyzed clips. GDELT does not provide a reliable analyzed-clip count for context, so none is invented.

Context terms come from a relevance-ranked sample, documented by GDELT as the 200 most relevant matching clips. This is a sampling disclosure, not a server-enforced sample size or an exhaustive corpus count. Scores describe that sample's vocabulary; they do not establish prevalence across all matching coverage or prove editorial stance.

### Station identity

Station catalog filters match complete station IDs, network values, or market values case-insensitively, combined with AND. No filters returns the whole catalog; an empty unfiltered catalog is an upstream failure. isActive means the monitoring end date, read as a UTC day, is within the last 24 hours, while historical validity depends on each station's startDate/endDate.

Provider timeline/clip labels resolve against catalog descriptions to optional station IDs. Labels, IDs, and archive URL prefixes are different identifiers. A failed side lookup preserves the answer and stationName, omits station, and discloses the failure. Missing labels stay empty rather than becoming fabricated names. The shared successful catalog is process-cached; failed loads are not retained. Waiting is bounded by 45 seconds from the call's start or the shorter call deadline, and an abandoned shared lookup is aborted when it has no remaining waiter.

The TV tools' `stations` input takes station IDs only. Each entry has invisible format characters removed and is trimmed, blank entries are dropped, and a list left empty selects nothing. An entry that is then not letters and digits (a display label, a quoted ID, an operator, an ID with punctuation) is refused as `invalid_query` before any request and never resolved to an ID: every row the catalog resolves already carries its `station`, and a label it could not resolve on output could not be resolved on input either. The check is on shape alone, with no catalog request, so an unknown ID of the right shape still reaches GDELT and fails there. GDELT's own reading of a station token is undocumented: it drops some punctuation (`CNN.` and `CNN*` answer as CNN) and cuts the token at other characters (`CNN-W` and `CNN,MSNBC` answer as CNN alone). The server refuses all of these instead of copying that clean-up, since part of what the caller wrote would be ignored without a word.

The same catalog load keeps each station's monitoring start and end dates. When a TV result comes back empty for selected `stations` and the window is known (explicit dates or a resolved timespan), the notice names each selected station whose range the window misses (after or before), by catalog ID and dates; the catalog does not promise coverage inside a range, so the sentence claims only that the window is outside it. A station still monitored when the catalog was read is never reported as ended, because the process keeps the end date it read. The lookup makes at most one catalog request per call, none once a load has landed, and waits no longer than the same bound. It never fails the answer, and a cancelled call still fails as cancelled.

### OR outside parentheses

GDELT joins elements with OR only inside parentheses and reads `or` in any case: DOC, Context, and TV reject a bare one between two elements, and the mirror's compiler refuses a capitalized one. The nine query tools read the query's top level before any request. A query that is nothing but elements and OR groups joined by OR has one reading, so it is sent as one flat group (`(flu OR cold) OR rsv` as `(flu OR cold OR rsv)`); the grouped query is what `effectiveQuery`, the notices, and the response cache carry. Any other query with OR outside parentheses fails `invalid_query`, since `climate OR energy sourcelang:english` could filter one term or both. So does a chain joining a source filter (`domain:`, `domainis:`, `sourcelang:`, `sourcecountry:`, `station:`, `network:`, `show:`, `market:`) with any other element, where the filter more likely scopes the query (`prix or sourcelang:french`) than widens it, and one that splits a phrase in typographic quotation marks (`“life or death”`). OR inside a quoted phrase or an operator value is text, and a lowercase `or` that opens or closes the query joins nothing and stays a word. Inside parentheses the mirror's compiler takes the separator in any case.

### Dates and smoothing

Explicit dates are paired real UTC calendar timestamps in YYYYMMDDHHMMSS form, with start earlier than end. A complete explicit pair takes precedence over timespan. DOC explicit dates pass to GDELT unchanged, with no age check, unless the window is under 30 minutes (below; the TV and Context requests are described with their tools); which modes answer a window older than three months is stated in Scope. Relative windows the server resolves itself (for out-of-window filtering, continuation windows, and notices) step back in UTC, as GDELT reads `timespan`, so hours, days, and weeks are exact multiples of an hour whatever the host's time zone. Relative parsing handles short and documented long units, weeks, case, and outer whitespace. DOC rejects a recognized relative `timespan` under 15 minutes. TV rejects obvious malformed relative text locally while leaving blanks and unknown numeric-unit syntax to the provider; a provider date rejection receives a specific hint rather than automatically being called a malformed timespan.

DOC and TV apply one shape check to a relative `timespan`: a number followed by its unit, with a blank value counted as unset. DOC admits a bare number, as GDELT DOC's answer to one is unmeasured, and TV refuses it. A blank `query` is refused at the schema on the DOC and Context tools. Both refusals happen before any request. The DOC "too short" hint names both minimums (15 minutes for a timespan, 30 for an explicit window), though the tools never send DOC an explicit window under 30 minutes. Article search reaches back three months, so a longer `timespan` goes upstream as given, runs on three months, and says so in `windowClamp`; the analytics modes are not clamped.

The four DOC tools never send DOC an explicit window under 30 minutes (1,800 seconds, compared to the second). Measured live on all eight DOC modes the tools send, 29 minutes 59 seconds draws `Timespan is too short.` and 30 minutes is accepted (on `artlist`, on or off a quarter hour). The floor applies only to a pair that passed the date validity check, and a relative `timespan` keeps its own 15-minute rule. Such a window is decided before DOC is touched, so it takes no pacer slot and no cache lookup: the mirror answers it where it can (see Routing rule), and otherwise the call fails `invalid_date_range`, naming the 30-minute minimum and the mirror's reason when one is attached.

Context reads its own grammar, measured live: `timespan` is a whole number followed by `min`, `h`, `hours`, `d`, or `days`, from 31 minutes to 72 hours, and anything else is refused as `invalid_query`. A longer timespan runs as 72 hours with `windowClamp`. An explicit window that starts before the 72-hour reach runs from five minutes inside it, with `windowClamp`; one that ends before the reach, or starts in the future, is `invalid_date_range`. A window under 60 minutes goes upstream widened, never past now. Measured live, GDELT reads Context window bounds only to the minute, both ends included (a start of `100134` returned matches seen from `100120`; an end of `100130` returned none of the matches seen at `100120`–`100130`), so an explicit end goes upstream rounded up to the next whole minute. Matches outside the requested window are dropped and counted in the notice.

DOC dates normalize to ISO date/date-time with 15min, hour, or day resolution: the recognized `query_details.date_resolution` first (`15m`, `hour`, or `day` as DOC spells them, and `15min`, case-insensitive; a spelling it does not recognize falls through), then inference from the smallest positive point interval. TV uses hour, day, week, month, or year; recognized provider metadata wins, then requested resolution, then inference from the smallest positive point interval. Where GDELT reports no resolution (word clouds), the covered-window notice reads the resolution GDELT picks from the length of the window sent: hour up to 7 days, day under 3×365 days, month beyond.

Timeline and breakdown smoothing accepts 0–30 timesteps and is sent as TIMELINESMOOTH. Zero and one leave values unsmoothed. Width N requires N source steps; notices explain missing leading moving-average steps and potential lag without inventing an observed loss count or measured peak delay. Leading steps dropped by smoothing are not counted as gaps; `missingTimesteps` counts only interior ones. Notices compose with paging and empty-result guidance.

### Theme lookup

Theme discovery searches identifiers, because the lookup provides no natural-language labels. Matching uses token prefixes, allows adjacent tokens to join, and makes one disclosed singular retry only when plural words return no matches. Exact identifiers rank first, followed by listed count and identifier. The listed count is an undocumented static lookup figure, never a live article total.

The parsed lookup is cached once per process, with concurrent initial callers sharing one load; a failed load is not cached. A load failure is retryable gdelt_unavailable rather than a successful empty taxonomy result. Not bundling a snapshot avoids growing every installation for a tool that may never be called.

## GKG mirror

GDELT's DOC API sometimes refuses requests for long stretches and answers `{}` while shedding load. The mirror is a local copy of the Global Knowledge Graph that GDELT publishes as static files, which the four DOC tools can fall back to. It is off unless `GDELT_MIRROR_PATH` is set, and it never serves the sentence, TV, or theme tools.

### Services

| Piece | Role |
|:------|:-----|
| `gkg-feed` | The two `lastupdate` manifests, 15-minute slot arithmetic, paced downloads (fixed 2 s between files, `User-Agent` naming this repo), zip inflation with CRC-32 and, for each feed's current slot, manifest size and MD5 checks, and the mapping from a GKG 2.1 row to a stored row |
| `gkg-mirror-store` | Store spec on the framework's SQLite mirror (FTS5 over title, persons, organizations, locations, themes), the `gkg_slots` ledger, the domain-to-country table, and the sync generator behind init and refresh |
| `doc-query-compiler` | Compiles a DOC query string to a predicate plan, or refuses it naming the operator |
| `gkg-mirror-queries` | Emulates `artlist`, the timeline modes, `tonechart`, and the two breakdowns from stored rows, with DOC's bucket widths for the requested window |
| worker and client | One worker thread owns the store; the main thread posts status, query, refresh, and close requests. Bun uses `bun:sqlite`; Node needs `better-sqlite3` |
| DOC source router | Decides, per call, whether the mirror can answer, and combines DOC's and the mirror's outcomes |

Only slots ingested in both feeds are answered for. Rows are keyed by URL and carry the 15-minute slot as `date`. Init and refresh are the same walk over slots missing from the ledger, so an interrupted run of either resumes where it stopped. `mirror:init`, `mirror:refresh`, and `mirror:verify` run out-of-band; the server never initializes the store. On HTTP transport the server schedules a refresh every 15 minutes from startup, and a run before an init has completed does nothing; on stdio the operator schedules `mirror:refresh`. The framework's sync lease lets one process sync a store at a time: a scheduled tick that finds the store held (`sync_locked`) is skipped and logged, not failed, and the next tick catches up from the ledger.

### Routing rule

An explicit window under 30 minutes is decided first, with DOC never asked: the mirror answers it whenever it can, a match or none, with `attempts` reading DOC's `window_too_short` and then the mirror's outcome; otherwise the call fails `invalid_date_range` (with those two attempts when a mirror is attached). Every other call is routed as follows.

Before DOC is asked, the router checks that the mirror could answer: the query compiles, the window resolves (a `timespan`, explicit dates, or DOC's three-month default), the mirror has completed an init, and the window overlaps the slots it holds. If any check fails, DOC is called alone and the call waits on it as it would without a mirror. Otherwise DOC is called under the 45 s fallback budget, and:

| DOC | Mirror | Result |
|:----|:-------|:-------|
| answered | not consulted | `source: doc_api` |
| empty | at least one match | `source: gkg_mirror`, notice says DOC returned nothing, which GDELT also does under load |
| empty | zero matches, or cannot answer | DOC's empty result, `source: doc_api`, `attempts` lists both |
| rate-limited or unavailable | answered, matches or not | `source: gkg_mirror`, notice discloses the divergence; zero matches adds that the mirror's matching is not evidence of no coverage |
| rate-limited or unavailable | answered part of the window | as above, plus `coverage` |
| rate-limited or unavailable | cannot answer | DOC's error code and reason, with the mirror's reason in the message and a hint naming the change that would let it answer; `data.attempts` lists both |

`invalid_query` and the caller's cancellation never reach the mirror. A stored answer served stale counts as DOC's answer, so the mirror is not consulted. The mirror gets what remains of 55 s after the call started, and a query it has not answered within 30 s; past either it is a `store_error`.

Mirror-computed shares, tone means, and smoothed values carry four decimals, as DOC's normalized values do; upstream DOC and TV values are never rounded. A mirror answer to a query holding a keyword or phrase says that keywords matched titles and entity names rather than article text and that counts and shares are over mirrored articles, and with zero matches that matching titles and entity names is not evidence of no coverage. A query with no keyword or phrase claims no keyword matching: the notice says only that counts and shares are over mirrored articles, and with zero matches that the mirror matched nothing, which is not evidence that no coverage exists. A query that requires a keyword (a keyword or phrase that is not excluded, or an OR group of keywords and phrases alone) adds that GKG themes are tagged on translated articles too, so a `theme:` element in place of the keyword reaches non-English coverage the keyword misses; an excluded keyword, or one OR-ed with an operator, does not draw it. A country breakdown also counts matching articles from outlets with no known source country, which it leaves out.

## Workflow Analysis

### Recent-news spike investigation

Resolve a suitable theme with gdelt_search_themes when taxonomy search fits, then run gdelt_get_coverage_timeline with article references. Locate candidate spikes, expand supplied evidence at exact returned dates, and inspect article URLs before explaining the pattern. For a spike inside the last 72 hours, gdelt_search_sentences shows what the matching sentences said. Use gdelt_search_articles for broader reporting in the same recent window, source breakdowns for outlet-country/language attention, and tone histograms for the distribution behind an average.

A source breakdown cannot establish where an event began, and representative links cannot prove the cause of a spike. Keep measured attention, tone, and evidence-supported explanations separate.

### Historical television comparison

List stations first and intersect their monitoring dates with the desired period. Pin explicit historical dates, compare station timelines with matching units/resolution/smoothing, then request context separately per station and inspect clips from the relevant dates. A Combined timeline answers pooled attention; separate station series answer station comparison.

Do not append a historical TV query to a recent DOC workflow without establishing a shared covered period. Do not treat historical TV captions as historical global newspaper evidence. Confirm coverage before interpreting absence, read continuation notices before claiming completeness, and distinguish sampled context vocabulary from measured coverage.

## Design Decisions

- Separate DOC and TV tools because their corpus and temporal scope differ; one historical-search interface would conceal that distinction.
- Consolidate DOC volume/tone timeline modes because they share query and output shape, while keeping tone histograms separate because distributions answer a different question.
- Use count pages for aggregate outputs and full fetched record lists for article/clip outputs. Provider caps and exact evidence selectors remain explicit; response byte size does not silently choose membership.
- Resolve station IDs from the live catalog rather than guessing from labels or bundling a parallel identifier map.
- Preserve source-series labels and units instead of inferring additive totals. A breakdown series' `operator` is a lookup in GDELT's own country and language code tables, never inferred from the label's spelling, so a name that maps to no code or to several carries none rather than a guess.
- Rank and page every breakdown series instead of cutting at ten, with the ranked series not on the page named in `otherSeriesLabels`, so every ranked series is reachable by paging and not only by naming its label.
- Name the sentence tool `gdelt_search_sentences`: `context` already names the TV word-cloud tool `gdelt_get_tv_context`, and the Context API's unit is the sentence.
- Offer no relevance order for sentence search. Measured live, GDELT answers every `sort` other than `DateAsc` newest first, so the tool requests `DateDesc` by name and advertises two date orders only.
- Continue sentence search by date edge: the next window resumes on the whole minute at or past the page's far-edge match, since GDELT reads Context bounds only to the minute and a second-precise edge would skip the rest of that minute. `maxRecords` counts sentences before GDELT keeps one per article, so a page cannot be continued by a record offset, and GDELT has no cursor.
- Widen an explicit sentence-search window under 60 minutes before sending it and drop the matches outside the requested window, since GDELT refuses a short window and never widens one itself.
- Read each TV series' `pointCount` and `peak` over the whole series on every page, so a page's figures do not change what the series reports about itself.
- Break ties between equal context scores by exact label, as TV rankings do, because GDELT's order among tied scores varies between identical calls and a fresh page would otherwise repeat or skip a term.
- Name the UTC window a TV timeline, ranking, or word cloud covers when GDELT widened an explicit window to whole periods, because the values carry no other sign of it.
- Refuse a blank `query`, and a `timespan` that is not a number followed by its unit (DOC also takes a bare number), at the schema before any request: neither has one clear reading, and refusing locally spares the call its wait on the shared pacer.
- Keep workflow gates in one published gdelt-guide, with essential scope and identifier guidance in the concise server instructions.
- Exclude the GEO API: its endpoint returned 404 during verification. Source-country breakdown describes outlet origin and is not a geographic event heat map.
- Retire unfiltered TV trending: TV analysis requires a selected station population, rather than silently presenting an undefined global aggregate.
- Cache DOC, Context, and TV answers by exact upstream URL, fresh for 15 minutes (24 hours once an explicit window ended over a day ago), because GDELT refuses requests long after the documented pacing is met and each repeat of a page or evidence expansion would spend a scarce slot. No normalization, since a `timespan` already goes upstream verbatim.
- Never store an empty answer, and stale-serve on an empty refetch as well as on refusals: GDELT answers `{}` while shedding load, including to queries that certainly match, so an empty refetch is not evidence that the stored answer is wrong, and a stored empty would pin the degradation.
- Key mirror rows by URL, not by GKG record ID: record IDs restart within a file and name different articles, while URLs did not collide in sampled rows. A URL that reappears in a newer slot keeps its newer row.
- Run the mirror store on one worker thread. Both SQLite drivers are synchronous, and a broad filter aggregates hundreds of thousands of rows per call, which would stall the serving event loop.
- Compile mirror queries of at most 1,000 characters and 100 elements. The worker answers one query at a time, so the bound caps what any one call can hold it for; a longer query goes to DOC alone, as it would without a mirror.
- Treat a 404 on a slot file as pending, stopping that feed's walk for the run, until the slot is two hours older than the feed's manifest slot, then record a gap and continue. A manifest-listed file can answer 404 for a few minutes (the translation feed has), so a short wait recovers the slot; other non-200 statuses stop the run and the next run resumes from the ledger.
- Consult the mirror when DOC is rate-limited, unavailable, or empty, and accept an empty DOC answer's replacement only when the mirror has a match. Empty is a trigger because GDELT sends `{}` under load as well as for no matches; requiring a match keeps a true zero from being replaced by a weaker source's zero.
- Pass explicit dates to GDELT unclamped, and advertise an older window on a surface only for a mode GDELT has answered live for one. The documentation contradicts itself on the reach of `startdatetime`, and answering for five modes does not establish the other two, so those keep the three-month wording until their own check passes.
- Resolve relative windows with UTC arithmetic. GDELT reads `timespan` in UTC, and stepping with local-time setters puts a window that crosses a daylight-saving change an hour off on hosts in such a zone.
- Key the rate-limit cooldown by API (DOC, TV, Context) in front of one shared request slot and gap. GDELT throttles the three APIs separately (TV and Context answered 200 within 60 s of DOC rate limits), and a shared streak let one API's success reset another's backoff. The cost is a separate backoff ladder per API when several refuse at once, still inside the shared one-request-per-gap rate.
- Send an on-the-hour end one second earlier on every TV tool that takes a window, because every period starts on the clock hour and ENDDATETIME is exclusive, so an untrimmed end counts a whole extra period. Pin `dateres` on `gdelt_search_tv` where the trimmed second would move GDELT to a finer period, because trimming without it would return 1,095 daily points for a three-year window. Send a window the trim would leave under 30 minutes as given, because GDELT refuses 29 minutes 59 seconds.
- Answer an explicit DOC window under 30 minutes from the mirror instead of refusing it outright, because the mirror answers those calls whenever DOC refuses the request, and refusing them would reject calls it can answer. With no mirror, or one that cannot answer, the call fails `invalid_date_range` before any request.
- Group a query that is only terms joined by OR instead of refusing it, because it has one reading and grouping answers it; refuse a mixed one, a source filter joined to a term included, because a group could hold different elements and guessing would run a query the caller did not write. Both happen before any request, since GDELT rejects the query only after its turn on the shared pacer, and a refusal while GDELT sheds load reads as retryable.
- Continue a capped DOC window under 60 minutes through the mirror's 15-minute slots, because the mirror answers windows DOC does not search and one slot is the narrowest window that separates articles.
- Report `missingTimesteps` apart from zero coverage, over the whole answer before paging, because DOC answers a timestep without coverage with 0, so a step left out is a hole in GDELT's data that a reader would otherwise take for a quiet period or a lost page. Mirror answers are exempt: the mirror builds its own steps.

## Known Limitations

- DOC's rolling three-month window excludes historical global article retrieval. Bulk historical GDELT data is outside this server.
- Sentence search reaches back 72 hours, covers English-language coverage only, and sees a subset of what DOC indexes; for older coverage, other languages, or the DOC-only filters (`sourcecountry:`, `sourcelang:`, `theme:`, tone, `domain:`), use `gdelt_search_articles`. The local mirror holds no sentences and never answers it.
- TV monitoring varies by station, network, and market; consult current catalog dates rather than applying one universal archive boundary. The catalog does not guarantee uninterrupted coverage inside a date range.
- Provider caps can prevent complete article/clip retrieval, especially dense TV hours. There is no cursor past those caps.
- GDELT rate limiting and temporary failures can persist beyond minimum spacing; no TV-availability guarantee is made. The response cache serves stored answers only for requests this process has already made, for at most 24 hours, and DOC also answers empty while overloaded, so an empty DOC answer is not by itself evidence of no coverage.
- Article metadata and short TV excerpts are discovery evidence, not full documents.
- Taxonomy identifiers have no labels or synonym index; a zero identifier search does not prove no related theme exists.
- Query-driven upstream data is not a transactionally stable pagination snapshot beyond the cache's freshness window.
- Mirror answers differ from DOC's: keywords match titles and entity names, not article text, and translated articles keep source-language titles; `theme:` matches the exact theme ID, and because GKG themes are tagged on translated articles too, it reaches non-English coverage a keyword misses; `sourcecountry` comes from GDELT's 2015 domain-to-country file, which covered 83–92% of sampled rows; counts and shares are over mirrored articles. `nearN:`, `repeatN:`, the image operators, unknown `name:` operators, and comparisons other than `tone`/`toneabs` are not compiled, a `sourcelang:` or `sourcecountry:` value it cannot resolve is refused, and so are an unquoted one-character or hyphenated keyword, an OR group that nests or holds an exclusion, an excluded OR group, and a query over 100 elements or 1,000 characters. The mirror answers only inside the window it holds; when that is less than the requested window, `coverage` says so.
