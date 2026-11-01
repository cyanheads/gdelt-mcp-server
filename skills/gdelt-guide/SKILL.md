---
name: gdelt-guide
description: Investigate recent news spikes and compare historical television coverage with gdelt_* tools. Use for theme resolution, evidence searches, station comparisons, or coverage and framing claims that require date-range, identifier, sampling, and completeness checks.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Scope

Use DOC analysis for recent global news and TV analysis for monitored television captions. TV archives cannot substitute for historical global newspaper coverage. Article results contain links and metadata, not full article text; TV clips contain short caption excerpts and archive links.

## Identifiers

- Obtain GKG theme identifiers and paste-ready `theme:` operators from `gdelt_search_themes`. Its listed count is a lookup figure, not a live article total. Search words in identifiers; a zero match does not establish that a concept is absent from the taxonomy.
- Obtain station IDs, network and market values, and monitoring dates from `gdelt_list_tv_stations`. Use `stationId` or a resolved result's `station` for filtering. A display name or archive URL prefix is not a station ID. If a result omits its station ID, resolve it through the catalog before chaining.
- Obtain exact breakdown labels from `gdelt_get_coverage_breakdown`, timestep dates from `gdelt_get_coverage_timeline`, and histogram bins from `gdelt_get_tone_distribution` before requesting expanded evidence. Preserve labels as returned.

## Gates

1. Verify temporal coverage before interpreting an empty result. DOC has a rolling three-month window; TV monitoring ranges differ by station. Intersect station ranges for comparisons and pin explicit historical dates. An empty answer outside coverage says nothing about whether a topic was discussed.
2. Keep the query, window, station population, resolution, normalization, and smoothing comparable. Raw TV values count matching 15-second clips; normalized values measure airtime share. DOC raw-volume values count distinct matching articles, or moving averages when smoothed; `norm` remains an unsmoothed monitored denominator. Do not compare those units interchangeably.
3. Treat a source country as the outlet's origin, not the event's location. DOC country/language breakdown values are shares of each source's output; do not add different sources into a global share or infer absolute article totals from their rank.
4. Inspect linked articles or TV excerpts before explaining a spike, claiming stance, or inferring causation. `referenceCount` counts links supplied by GDELT, not all matching articles. Expanding references retrieves supplied evidence only.
5. Treat TV context as vocabulary from a relevance-ranked sample, not exhaustive term prevalence or proof of editorial stance. Compare stations or windows with a separate context call for each, then inspect clips. `totalTerms` is a vocabulary count, never an analyzed-clip count.
6. Follow `nextOffset` with otherwise identical inputs and read cap/continuation notices before claiming completeness. Article and clip APIs have provider caps rather than record cursors; use returned continuation windows and deduplicate records. Dense TV hours can contain clips that no narrower window retrieves. A failed or rate-limited request is not zero coverage.
7. Use unsmoothed timelines when timing matters. A trailing moving average needs a full source window, omits leading steps without one, and can move apparent peaks later.
8. Read TV ranking units before comparing rows. Station rankings measure airtime percentages or raw matching clips; show rankings always measure percentages of matching clips, even when normalization is disabled. An ellipsized show label may not work as an exact show selector.

## Core chain

Resolve the vocabulary and covered dates → locate a signal in a timeline → expand the evidence at the relevant dates → inspect the underlying reporting → compare coverage or tone using the same scope. Separate the measured pattern from the explanation the evidence supports.

## Workflows

### Investigate a recent-news spike

Start with keywords, or use `gdelt_search_themes` when a taxonomy theme fits the question. Run `gdelt_get_coverage_timeline` with article references to locate candidate spikes. Expand the interesting timesteps to see every reference GDELT supplied; use `gdelt_search_articles` for a wider set of reporting within that same window.

Read the evidence before assigning a cause. Then use `gdelt_get_coverage_breakdown` to compare source-country or language attention, and `gdelt_get_tone_distribution` to distinguish a broad tonal shift from mixed positive and negative coverage. A tone timeline answers when average tone changed; a histogram answers how tone is distributed across matching articles. Keep the two interpretations separate.

### Compare historical television coverage

Start with `gdelt_list_tv_stations` and choose stations whose monitoring ranges overlap the target period. Run `gdelt_search_tv` with fixed historical dates to compare separate station timelines. Normalized values compare attention within each station's monitored airtime; raw values compare clip counts. A Combined timeline pools matching and monitored clips, rather than averaging station percentages, and does not identify an individual station.

Use `gdelt_get_tv_breakdown` when the question is which stations or shows ranked highest across the whole window. A ranking answers a window-level question; return to the timeline to establish when its coverage occurred.

Use `gdelt_get_tv_context` separately for each station and the same period to discover candidate framing vocabulary. Retrieve `gdelt_get_tv_clips` for the stations and dates that support the comparison, inspect caption excerpts, and follow archive links when more context is needed. Report vocabulary as sampled evidence and distinguish it from measured coverage intensity.
