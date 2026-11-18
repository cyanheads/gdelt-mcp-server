/**
 * @fileoverview GDELT coverage breakdown tool. Breaks down coverage volume by source
 * language or source country over time using the GDELT DOC API.
 * @module mcp-server/tools/definitions/get-coverage-breakdown.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { inferDateResolution } from '@/services/gdelt/date-resolution.js';
import { routeBreakdown } from '@/services/gdelt/doc-source-router.js';
import { DOC_MIN_WINDOW_MINUTES } from '@/services/gdelt/types.js';
import { sourceCountryOperator } from '@/services/gkg-mirror/countries.js';
import { sourceLangOperator } from '@/services/gkg-mirror/languages.js';
import {
  DOC_WINDOW_MINIMUM_NOTE,
  describeDateRangeFault,
  GDELT_DATETIME_PATTERN,
  refineDocTimespan,
} from '../date-range.js';
import {
  clampToCap,
  countInputSchema,
  limitClampSchema,
  renderLimitClamp,
} from '../limit-clamp.js';
import { escapeMarkdown, quoteText, renderNotice, renderQueryEcho } from '../markdown-escape.js';
import { timestepGaps } from '../missing-timesteps.js';
import { peakOf } from '../peak-of.js';
import { queryInputSchema } from '../query-input.js';
import {
  DOC_EMPTY_RETRY_NOTE,
  docProvenanceEnrichment,
  docProvenanceTrailer,
  mirrorAnswerNotice,
} from '../source-provenance.js';
import { sumValues } from '../sum-values.js';

/** The suffix GDELT puts after the language or country name in a breakdown series label. */
const LABEL_SUFFIX = ' Volume Intensity';

/**
 * One language or country coverage series. Shared by the ranked `topSeries` overview and
 * the `selectedSeries` arm so a label retrieved by name carries the identical shape it
 * has on its overview page.
 */
const breakdownSeriesSchema = z
  .object({
    label: z.string().describe('Series label (language name or country name).'),
    operator: z
      .string()
      .optional()
      .describe(
        "Paste-ready DOC query operator for this series' source: sourcecountry:<FIPS code> for a country (FIPS, not ISO — AU is Austria) or sourcelang:<language name> for a language. Add it to a gdelt_search_articles or gdelt_get_coverage_timeline query to see that source's articles or volume. Omitted when the series name maps to no GDELT code or to more than one.",
      ),
    sum: z
      .number()
      .describe(
        "Sum of the series' values over every point GDELT returned for it — the key the overview ranks series by. It ranks series and is neither a share of anything nor an article count.",
      ),
    pointCount: z
      .number()
      .describe(
        'Data points GDELT returned for the whole series — not the number of timesteps in the window, which is larger by missingTimesteps when GDELT left some out.',
      ),
    peak: z
      .object({
        date: z.string().describe('Timestep of the peak, in ISO 8601 format.'),
        value: z.number().describe('Value at the peak timestep.'),
      })
      .optional()
      .describe(
        'The point of the whole series with the largest absolute value, the earliest on a tie. Omitted when the series has no points.',
      ),
    data: z
      .array(
        z
          .object({
            date: z.string().describe('Timestep in ISO 8601 format.'),
            value: z
              .number()
              .describe(
                "Normalized coverage volume at this timestep — the topic's share of this " +
                  "source's media output, not an absolute article count.",
              ),
          })
          .describe('A single data point for this series.'),
      )
      .optional()
      .describe(
        'Time-ordered data points for this series. Present when includePoints is true (the default); omitted when it is false.',
      ),
  })
  .describe('A single language or country coverage series.');

/**
 * Render one series — header with its ranking key (the sum of its values, which ranks series but
 * is not itself a share of anything), point count, peak, and every data point it carries.
 */
function renderSeries(series: z.infer<typeof breakdownSeriesSchema>): string[] {
  const lines = [`\n### ${escapeMarkdown(series.label)} (sum of values: ${series.sum})`];
  // A code span renders a backslash escape literally; an operator is a fixed prefix and table
  // letters (sourcecountry:GM, sourcelang:norwegiannynorsk), none of which ends the span.
  if (series.operator) lines.push(`Operator: \`${series.operator}\``);
  lines.push(`Data points: ${series.pointCount}`);
  if (series.peak) lines.push(`Peak: ${series.peak.value} at ${escapeMarkdown(series.peak.date)}`);
  for (const d of series.data ?? []) lines.push(renderPoint(d));
  return lines;
}

/**
 * The operator a series label names: its name — the label minus the suffix — looked up in the
 * breakdown dimension's table. A label without the suffix is not a shape GDELT names a source in.
 */
function seriesOperator(label: string, breakdownBy: 'language' | 'country'): string | undefined {
  if (!label.endsWith(LABEL_SUFFIX)) return;
  const name = label.slice(0, -LABEL_SUFFIX.length);
  return breakdownBy === 'country' ? sourceCountryOperator(name) : sourceLangOperator(name);
}

/** The otherSeriesLabels block, rendered on every overview page that leaves series out. */
function renderOtherLabels(labels: readonly string[]): string[] {
  return [
    `\n### Series not on this page (${labels.length})`,
    `Ranked by sum of values. Re-call with series: ["<label>"] to get any of them in full.`,
    ...labels.map((label) => `- ${escapeMarkdown(label, 'line-start')}`),
  ];
}

/** One `- date: value` list line; the upstream date is the list item's first text. */
function renderPoint(point: { date: string; value: number }): string {
  return `- ${escapeMarkdown(point.date, 'line-start')}: ${point.value}`;
}

export const gdeltGetCoverageBreakdown = tool('gdelt_get_coverage_breakdown', {
  title: 'Get GDELT Coverage Breakdown',
  description:
    'Break down news coverage volume over time by source language or source country, returning a multi-series time series (one series per language or country). Shows which countries or languages drove early vs. late coverage — useful for tracing how a story propagated geographically or across language communities. Ranks every series by the sum of its values and returns limit of them per page (default 10, cap 75); when more remain it returns nextOffset — pass it back as offset with otherwise identical inputs for the next page. otherSeriesLabels names every series not on the page — pass any labels as the series input to get only those series, complete. Every series carries sum (its ranking key), pointCount, and peak; includePoints: false leaves out its data points for a lighter ranking. GDELT answers a timestep without matching coverage with 0 and leaves out a timestep its own data lacks; missingTimesteps counts those left out between the first and last returned. Each series whose name maps to one GDELT source code carries operator (sourcecountry:<FIPS> or sourcelang:<language>) — add it to a gdelt_search_articles or gdelt_get_coverage_timeline query to read that source\'s articles or volume. Values are normalized: each point is the topic\'s share of that source\'s media output, not an absolute article count, so values from different sources do not add up to a share. Small media markets with concentrated coverage therefore rank above large markets with diverse output — a high value means the topic dominated that source\'s coverage, not that it published the most articles. Use breakdownBy "country" with the signal-detection chain to map geographic attention, or "language" to detect non-English media surges.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'unknown_series',
      code: JsonRpcErrorCode.NotFound,
      when: 'A label passed in the series input matches no series in a non-empty breakdown.',
      recovery:
        'Read the labels listed in the error and retry series with exact matches from that list.',
    },
    {
      reason: 'offset_out_of_range',
      code: JsonRpcErrorCode.NotFound,
      when: 'The requested offset is at or beyond the last series of a non-empty overview, or of the series named in series.',
      recovery:
        'Retry with an offset inside the range the error names, or with nextOffset from the preceding response.',
    },
    {
      reason: 'invalid_date_range',
      code: JsonRpcErrorCode.ValidationError,
      when: `Only one of startDatetime / endDatetime was supplied, one of them is not a real UTC calendar timestamp, startDatetime is not earlier than endDatetime, or the window spans under the ${DOC_MIN_WINDOW_MINUTES} minutes the GDELT DOC API accepts and no local GKG mirror answers it in DOC's place.`,
      recovery: `Supply both startDatetime and endDatetime as real UTC calendar timestamps, with startDatetime at least ${DOC_MIN_WINDOW_MINUTES} minutes earlier than endDatetime, or omit both and use timespan instead.`,
    },
    {
      reason: 'invalid_query',
      code: JsonRpcErrorCode.ValidationError,
      when: 'GDELT rejected the query string as malformed — bad keyword length, unbalanced parentheses, or an illegal character.',
      recovery:
        'Read the recovery hint for the specific rule GDELT rejected, then fix the query and retry.',
      thrownBy: 'service',
    },
    {
      reason: 'gdelt_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'GDELT rejected the request for its one-request-per-five-seconds limit, or too many requests were already queued for this one to start in time.',
      retryable: true,
      recovery:
        'Back off before retrying; five seconds is minimum request spacing, not a recovery guarantee, and rate limiting may persist longer. Honor Retry-After when supplied.',
      thrownBy: 'service',
    },
    {
      reason: 'gdelt_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'GDELT DOC API is unreachable or temporarily returned no usable data.',
      retryable: true,
      recovery: 'Retry after a short delay; GDELT may be temporarily unavailable.',
      thrownBy: 'service',
    },
  ],

  input: z
    .object({
      query: queryInputSchema(
        'Search query using GDELT syntax. Same operators as gdelt_search_articles: phrases, boolean OR, sourcecountry:, sourcelang:, domain:, theme: (GKG theme identifiers come from gdelt_search_themes).',
      ),
      breakdownBy: z
        .enum(['language', 'country'])
        .describe(
          'Breakdown dimension: "language" for source language time series, ' +
            '"country" for source country time series.',
        ),
      timespan: z
        .string()
        .optional()
        .describe(
          'Time window relative to now, a number followed by its unit, minimum "15min"; other examples: "24h", "7d", "1m". Ignored when startDatetime/endDatetime are set. Maximum 3 months.',
        ),
      startDatetime: z
        .string()
        .regex(GDELT_DATETIME_PATTERN, 'startDatetime must be exactly 14 digits (YYYYMMDDHHMMSS).')
        .optional()
        .describe(
          `Start datetime in GDELT format YYYYMMDDHHMMSS — exactly 14 digits, no separators (e.g. 20240101000000). Must pair with endDatetime; supplying only one of the two is rejected. The window may predate the last 3 months. ${DOC_WINDOW_MINIMUM_NOTE}`,
        ),
      endDatetime: z
        .string()
        .regex(GDELT_DATETIME_PATTERN, 'endDatetime must be exactly 14 digits (YYYYMMDDHHMMSS).')
        .optional()
        .describe(
          `End datetime in GDELT format YYYYMMDDHHMMSS — exactly 14 digits, no separators (e.g. 20240131235959). Must pair with startDatetime; supplying only one of the two is rejected. The window may predate the last 3 months. ${DOC_WINDOW_MINIMUM_NOTE}`,
        ),
      smoothing: z
        .number()
        .int()
        .min(0)
        .max(30)
        .optional()
        .describe(
          'Trailing moving-average width in timesteps (0–30; 0 or 1 leaves values unsmoothed). Width N needs N source steps, omitting leading steps without a full window and potentially shifting peaks later.',
        ),
      series: z
        .array(z.string())
        .optional()
        .describe(
          'Exact series labels to return instead of the ranked overview, e.g. ["Portuguese Volume Intensity", "Vietnamese Volume Intensity"]. Take them verbatim from otherSeriesLabels or topSeries[].label in a response, or from the label list an unknown_series error prints — labels, not operators, which go in query. Each one comes back complete under selectedSeries (its points left out only under includePoints: false), in the order requested (every series carrying it, when several do); a label that matches nothing is rejected rather than silently skipped. Omit to get the ranked overview.',
        ),
      includePoints: z
        .boolean()
        .default(true)
        .describe(
          'Whether each series carries its data points. false returns every series of topSeries or selectedSeries without data, keeping its label, operator, sum, pointCount, and peak; ranking, paging, otherSeriesLabels, and every other field are unchanged. Default true.',
        ),
      limit: countInputSchema(
        75,
        10,
        'Maximum series per page (default 10, cap 75). Larger counts clamp with limitClamp; strict deployments reject them.',
      ),
      offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe(
          'Zero-based series offset — into the ranked overview, or into the series named in series. Pass nextOffset from the preceding response, with otherwise identical inputs, to get the next page.',
        ),
    })
    .superRefine(refineDocTimespan),

  output: z.object({
    dateResolution: z
      .enum(['15min', 'hour', 'day'])
      .optional()
      .describe(
        'Temporal resolution of data points — 15min, hour, or day — as GDELT reports it, or else ' +
          'inferred from the spacing of the returned timesteps. Omitted when GDELT reports none and ' +
          'fewer than two distinct timesteps came back.',
      ),
    missingTimesteps: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Timesteps GDELT left out between the first and last timestep of the whole breakdown, across every series, at dateResolution — gaps in GDELT's data, not zero coverage, which GDELT returns as 0. The notice names each missing run. The same on every page, under series, and with or without points. Omitted when none are missing, and never reported for an answer from the local GKG mirror.",
      ),
    topSeries: z
      .array(breakdownSeriesSchema)
      .optional()
      .describe(
        'The ranked overview: every series ranked by the sum of its values, those of this page in rank order, each with its points unless includePoints is false. Omitted when the series input selects series instead.',
      ),
    otherSeriesLabels: z
      .array(z.string())
      .optional()
      .describe(
        "Label of every ranked series not on this page, in rank order, on every overview page. Pass any of them to the series input to retrieve that series' complete data. Omitted when this page holds every series, or when the series input selects series instead.",
      ),
    selectedSeries: z
      .array(breakdownSeriesSchema)
      .optional()
      .describe(
        'Complete, untruncated time series for the labels requested via the series input — those of this ' +
          'page, in the order requested, without their points under includePoints: false. Omitted when ' +
          'series was not supplied.',
      ),
    nextOffset: z
      .number()
      .optional()
      .describe(
        'Offset of the next page, for the same inputs. Absent when this page reaches the last series.',
      ),
  }),

  // Agent-facing context — query echo, breakdown dimension, total series count, and the
  // empty-result or paging notice. Reaches structuredContent and content[] automatically; never
  // in the domain return.
  enrichment: {
    limitClamp: limitClampSchema,
    effectiveQuery: z.string().describe('Echoed query string for use in follow-up calls.'),
    breakdownBy: z
      .enum(['language', 'country'])
      .describe('Breakdown dimension used for this response.'),
    totalCount: z.number().describe('Total number of series GDELT returned, before paging.'),
    startDatetime: z
      .string()
      .optional()
      .describe('Echoed start datetime when provided (YYYYMMDDHHMMSS).'),
    endDatetime: z
      .string()
      .optional()
      .describe('Echoed end datetime when provided (YYYYMMDDHHMMSS).'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when the query matched no coverage in the window — how to broaden the query or ' +
          'extend the window — or, when this response is one page of several, which series it ' +
          'returned out of how many. Which timesteps GDELT left out of the breakdown (see ' +
          "missingTimesteps), and what smoothing omits. When the server's local GKG mirror answered " +
          "(source: gkg_mirror), why, how its figures differ from the DOC API's, and how many " +
          'matching articles a country breakdown left out for having no known source country. Absent ' +
          'when the DOC API answered a complete, unsmoothed breakdown whose every series fit in one ' +
          'response.',
      ),
    ...docProvenanceEnrichment,
  },

  enrichmentTrailer: {
    limitClamp: { render: renderLimitClamp },
    effectiveQuery: { render: renderQueryEcho },
    notice: { render: renderNotice },
    ...docProvenanceTrailer,
  },

  async handler(input, ctx) {
    const dateRangeFault = describeDateRangeFault(input.startDatetime, input.endDatetime);
    if (dateRangeFault) {
      throw ctx.fail('invalid_date_range', dateRangeFault);
    }

    ctx.log.info('gdelt_get_coverage_breakdown', {
      query: input.query,
      breakdownBy: input.breakdownBy,
    });
    const limit = clampToCap(ctx, 'limit', input.limit, 75);

    const modeMap = {
      language: 'timelinelang',
      country: 'timelinesourcecountry',
    } as const;

    const {
      result: { series: allSeries, reportedResolution },
      standIn,
    } = await routeBreakdown(
      {
        query: input.query,
        mode: modeMap[input.breakdownBy],
        ...(input.timespan && { timespan: input.timespan }),
        ...(input.startDatetime && { startDatetime: input.startDatetime }),
        ...(input.endDatetime && { endDatetime: input.endDatetime }),
        ...(input.smoothing != null && { smoothing: input.smoothing }),
      },
      ctx,
    );

    const isEmpty = allSeries.every((s) => s.data.length === 0);

    // Rank by the sum of each series' values, descending. The sum is only a ranking key: the
    // values are shares of different sources' output, so no sum of them is itself a share.
    const sorted = allSeries
      .map((s) => ({ s, sum: s.data.reduce((acc, d) => acc + d.value, 0) }))
      .sort((a, b) => b.sum - a.sum)
      .map(({ s }) => s);

    // Label selection re-filters the same complete upstream set the ranking ordered, so a
    // series named on a follow-up call reconstructs statelessly from query + dimension + label.
    // An empty breakdown has no labels to name, so there a selection is moot, not wrong.
    const isSelection = !isEmpty && (input.series?.length ?? 0) > 0;
    const selectedSeries: typeof sorted = [];
    if (isSelection) {
      // Nothing upstream makes labels unique, so a label selects every series carrying it.
      const byLabel = Map.groupBy(sorted, (s) => s.label);
      const unknown: string[] = [];
      for (const label of input.series ?? []) {
        const matches = byLabel.get(label);
        if (matches) selectedSeries.push(...matches);
        else unknown.push(label);
      }
      if (unknown.length > 0) {
        const named = unknown.map(quoteText).join(', ');
        const labels = sorted.map((s) => s.label).join(', ');
        throw ctx.fail('unknown_series', `No ${input.breakdownBy} series named ${named}`, {
          unknownLabels: unknown,
          recovery: {
            hint:
              `This breakdown has no ${input.breakdownBy} series named ${named}. Labels are exact and ` +
              `case-sensitive. Available for ${quoteText(input.query)}: ${labels}.`,
          },
        });
      }
    }

    // The pageable units: the selected series in requested order, or every ranked series, whose
    // pages each name the ranked series they leave out. An empty breakdown has no points to page
    // through, so it returns every series and ignores offset and limit.
    const units = isSelection ? selectedSeries : sorted;
    if (!isEmpty && input.offset >= units.length) {
      const scope = isSelection
        ? `the series input names ${units.length} series`
        : `the ranked overview holds ${units.length} series`;
      throw ctx.fail('offset_out_of_range', `Offset ${input.offset} is past the last series`, {
        offset: input.offset,
        totalSeries: units.length,
        recovery: { hint: `Retry with offset 0–${units.length - 1}; ${scope}.` },
      });
    }
    const start = isEmpty ? 0 : input.offset;
    const end = isEmpty ? units.length : Math.min(start + limit, units.length);
    const nextOffset = end < units.length ? end : undefined;
    // Each series' sum, point count, and peak cover its whole series, on every page and whether
    // or not its points come with it.
    const pageSeries = units.slice(start, end).map((s) => {
      const operator = seriesOperator(s.label, input.breakdownBy);
      const peak = peakOf(s.data);
      return {
        label: s.label,
        ...(operator && { operator }),
        sum: sumValues(s.data.map((d) => d.value)),
        pointCount: s.data.length,
        ...(peak && { peak: { date: peak.date, value: peak.value } }),
        ...(input.includePoints && { data: s.data }),
      };
    });
    const otherSeriesLabels = isSelection
      ? []
      : [...sorted.slice(0, start), ...sorted.slice(end)].map((s) => s.label);

    // The resolution DOC reports, else the one the spacing of every timestep implies. Gaps are
    // counted over every series of the whole answer, so every page, selection, and points setting
    // reports the same ones; the mirror builds its own steps, so its answer is never checked.
    const allDates = allSeries.flatMap((s) => s.data.map((d) => d.date));
    const dateResolution = reportedResolution ?? inferDateResolution(allDates);
    const gaps = !standIn && dateResolution ? timestepGaps(allDates, dateResolution) : undefined;

    ctx.enrich.echo(input.query);
    ctx.enrich.total(allSeries.length);
    ctx.enrich({
      breakdownBy: input.breakdownBy,
      ...(input.startDatetime && { startDatetime: input.startDatetime }),
      ...(input.endDatetime && { endDatetime: input.endDatetime }),
    });

    // Every notice segment for this response accumulates here and is flushed once —
    // ctx.enrich.notice is last-wins, so a second call would silently drop the first.
    const notices: string[] = [];
    if (isEmpty) {
      notices.push(
        `No breakdown data for ${quoteText(input.query)}. Broaden the query, extend the time window, or verify the query operators are correct.`,
      );
      if (!standIn) notices.push(DOC_EMPTY_RETRY_NOTE);
      if (input.series?.length) {
        notices.push('The series input was not applied — this breakdown has no series.');
      }
    }
    if (!isEmpty && (input.offset > 0 || nextOffset != null)) {
      notices.push(
        `Returned series ${input.offset + 1}–${end} of ${units.length} series${nextOffset != null ? `; continue with offset ${nextOffset} (nextOffset) and otherwise identical inputs.` : ' — the last page.'}`,
      );
    }
    if (gaps) notices.push(gaps.notice);
    if ((input.smoothing ?? 0) > 1) {
      notices.push(
        `A trailing moving average of width ${input.smoothing} needs that many source steps; leading steps without a full window are omitted and peaks may appear later.`,
      );
    }
    if (standIn) notices.push(mirrorAnswerNotice(standIn));
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    ctx.log.info('gdelt_get_coverage_breakdown completed', {
      totalSeries: allSeries.length,
      returnedSeries: pageSeries.length,
      selection: isSelection,
    });

    return {
      ...(dateResolution && { dateResolution }),
      ...(gaps && { missingTimesteps: gaps.missingTimesteps }),
      ...(isSelection ? { selectedSeries: pageSeries } : { topSeries: pageSeries }),
      ...(otherSeriesLabels.length > 0 && { otherSeriesLabels }),
      ...(nextOffset != null && { nextOffset }),
    };
  },

  /**
   * Every arm renders on its own field presence, never as an `if`/`else if` chain — the
   * format-parity linter populates all optional fields at once in its synthetic sample,
   * so a mutually-exclusive branch would leave the untaken arm unverified.
   */
  format: (result) => {
    const lines: string[] = [`## GDELT Coverage Breakdown`];
    if (result.dateResolution) lines.push(`**Date Resolution:** ${result.dateResolution}`);
    if (result.missingTimesteps) lines.push(`**Missing timesteps:** ${result.missingTimesteps}`);
    lines.push(
      `**Values:** normalized — each value is the topic's share of that source's media output, ` +
        `not an article count. Small media markets with concentrated coverage rank above large ` +
        `markets with diverse output.`,
    );
    if (result.nextOffset != null) lines.push(`**Next offset:** ${result.nextOffset}`);
    if ([...(result.topSeries ?? []), ...(result.selectedSeries ?? [])].some((s) => !s.data)) {
      lines.push(
        '**Points:** omitted (includePoints: false); each series keeps its sum, point count, and peak.',
      );
    }
    // Keyed on the count, not on data, which includePoints: false leaves out of a full page.
    if (result.topSeries?.every((s) => s.pointCount === 0)) {
      lines.push('No breakdown series returned.');
    }
    for (const s of result.topSeries ?? []) lines.push(...renderSeries(s));

    if (result.otherSeriesLabels?.length)
      lines.push(...renderOtherLabels(result.otherSeriesLabels));

    if (result.selectedSeries?.length) {
      lines.push(`\n## Selected Series (${result.selectedSeries.length})`);
      lines.push(`Complete series for the labels requested via the series input.`);
      for (const s of result.selectedSeries) lines.push(...renderSeries(s));
    }

    return [{ type: 'text', text: lines.join('\n') }];
  },
});
