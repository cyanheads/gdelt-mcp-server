# gdelt-mcp-server

GDELT Project — real-time global event monitoring from news media worldwide. Tracks events, themes, people, organizations, locations, and sentiment across 100+ languages.

## API

- **Base**: `https://api.gdeltproject.org/api/v2/`
- **Auth**: None
- **Rate limits**: Reasonable (no published hard cap for standard queries)
- **Docs**: https://blog.gdeltproject.org/gdelt-2-0-our-global-world-in-realtime/
- **DOC API**: https://api.gdeltproject.org/api/v2/doc/doc
- **GEO API**: https://api.gdeltproject.org/api/v2/geo/geo
- **TV API**: https://api.gdeltproject.org/api/v2/tv/tv (television news monitoring)

## Key data

- **Events**: CAMEO-coded events (protests, diplomatic actions, military movements, etc.) with actors, locations, dates, tone
- **Global Knowledge Graph (GKG)**: Themes, organizations, people, locations, and sentiment extracted from every news article
- **DOC API**: Full-text article search with timeline, tone, and geographic analysis
- **GEO API**: Geographic heat maps of news coverage
- **TV API**: Television news monitoring (closed captions from 150+ stations)
- **Coverage**: 100+ languages, every country, updated every 15 minutes, data back to 1979 (events) and 2015 (GKG 2.0)

## Cross-domain value

| Chain to | Query |
|---|---|
| Wikipedia / Wikidata | Event actors → structured background |
| Congress | Media coverage spikes → legislative response timing |
| SEC EDGAR | Geopolitical events → company 8-K/10-K risk disclosures |
| WHO | Disease outbreak media coverage → official WHO reports (lead/lag) |
| NOAA | Natural disaster coverage → climate data |
| Earthquake | Seismic events → media coverage and response |
| World Bank | Country instability signals → economic indicators |
| arXiv / OpenAlex | Academic attention to events |

## Tool ideas

- `gdelt_search_articles` — full-text news search with date, location, theme, tone filters
- `gdelt_get_timeline` — volume timeline for a query (when did coverage spike?)
- `gdelt_get_tone` — sentiment analysis for a topic over time
- `gdelt_search_events` — CAMEO-coded events with actor, location, date filters
- `gdelt_get_geo` — geographic distribution of coverage for a query
- `gdelt_search_tv` — television news mention search
- `gdelt_get_themes` — trending themes and their volume

## Licensing (audited 2026-05-25)

- **Status: Clear to host**
- Explicit terms: "all datasets released by the GDELT Project are available for unlimited and unrestricted use for any academic, commercial, or governmental use of any kind without fee"
- Redistribution explicitly allowed: "You may redistribute, rehost, republish, and mirror any of the GDELT datasets in any form"
- **Requirement**: citation to the GDELT Project + link to https://www.gdeltproject.org/
- Source: https://www.gdeltproject.org/about.html#termsofuse

## Notes

- GDELT is well-recognized in data journalism and computational social science — keep the name
- The "pandemic signal detection" scenario in CROSS-DOMAIN.md is a natural fit — GDELT tracks early media signals before official reports
- 15-minute update cadence makes this near-real-time for current events
- TV API is unique — no other MCP server covers television news
