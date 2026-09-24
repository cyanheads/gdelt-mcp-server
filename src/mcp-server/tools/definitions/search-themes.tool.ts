/**
 * @fileoverview GKG theme search tool. Finds GDELT Global Knowledge Graph theme identifiers for
 * the `theme:` query operator the DOC tools accept, by matching query words against GDELT's
 * theme lookup.
 * @module mcp-server/tools/definitions/search-themes.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { getGdeltThemeService, themeQueryWords } from '@/services/gdelt/gdelt-theme-service.js';
import { escapeMarkdown } from '../markdown-escape.js';

/** Page-size ceiling: 100 of the longest identifiers stay near 17 KB of structuredContent. */
const MAX_MATCHES_PER_PAGE = 100;

export const gdeltSearchThemes = tool('gdelt_search_themes', {
  title: 'Search GDELT GKG Themes',
  description:
    'Find GDELT Global Knowledge Graph (GKG) theme identifiers for the theme: operator that ' +
    'gdelt_search_articles, gdelt_get_coverage_timeline, gdelt_get_tone_distribution, and ' +
    'gdelt_get_coverage_breakdown accept in query. Searches the identifiers in the GDELT GKG theme ' +
    'lookup, which carries no labels or descriptions: every query word must begin one of the ' +
    '_-separated parts of an identifier or run across consecutive parts, or all the words joined ' +
    'must, so "drought" finds ' +
    'NATURAL_DISASTER_DROUGHT, "cyberattack" finds CYBER_ATTACK, "plant disease" finds ' +
    'TAX_PLANTDISEASE, and "wb water" narrows to World Bank water themes. There is no stemming or ' +
    'synonym matching — "displacement" does not reach DISPLACED — except one fallback: when nothing ' +
    'matches, the search retries once with a trailing s dropped from each word of four or more ' +
    'letters, and says so. Matches rank an exact identifier first, then by the count the lookup ' +
    'lists — a static prevalence figure, not a live article total — and each carries a paste-ready ' +
    'operator such as theme:TAX_DISEASE_OUTBREAK. Page with offset and limit.',
  annotations: { readOnlyHint: true, openWorldHint: true },

  errors: [
    {
      reason: 'invalid_query',
      code: JsonRpcErrorCode.ValidationError,
      when: 'The query has no letter or digit to match — blank, whitespace, or only punctuation such as "___".',
      recovery:
        'Retry gdelt_search_themes with at least one word of letters or digits, such as "drought" or "cyber attack".',
    },
    {
      reason: 'offset_out_of_range',
      code: JsonRpcErrorCode.NotFound,
      when: 'The requested offset is at or beyond the end of a non-empty match list.',
      recovery: 'Retry with an offset between 0 and totalMatches - 1 from the preceding response.',
    },
    {
      reason: 'gdelt_unavailable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The GDELT GKG theme lookup could not be downloaded, or came back empty or not as THEME<TAB>count lines.',
      retryable: true,
      recovery: 'Retry after a short delay; GDELT may be temporarily unavailable.',
      thrownBy: 'service',
    },
  ],

  input: z.object({
    query: z
      .string()
      .describe(
        'Words to find in theme identifiers (e.g. "drought", "cyber attack", "refugee"), a family ' +
          'prefix with a word ("wb water", "crisislex"), or a whole identifier to confirm it is ' +
          'listed ("TAX_DISEASE_OUTBREAK"). Case-insensitive; a leading theme: is ignored; every ' +
          'word must match, or all the words joined must ("plant disease" matches TAX_PLANTDISEASE). ' +
          'Must contain at least one letter or digit.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Zero-based offset into the ranked matches. Use nextOffset from the preceding response with ' +
          'the same query to retrieve the next page.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_MATCHES_PER_PAGE)
      .default(25)
      .describe(`Maximum matches returned in this response (1–${MAX_MATCHES_PER_PAGE}).`),
  }),

  output: z.object({
    matches: z
      .array(
        z
          .object({
            theme: z.string().describe('GKG theme identifier (e.g. "NATURAL_DISASTER_DROUGHT").'),
            count: z
              .number()
              .describe(
                'Count the GDELT theme lookup lists for this theme — a static prevalence figure, not a ' +
                  'live article total.',
              ),
            operator: z
              .string()
              .describe(
                'Paste-ready query operator for the DOC tools (e.g. "theme:NATURAL_DISASTER_DROUGHT").',
              ),
          })
          .describe('A matching GKG theme.'),
      )
      .describe(
        'Matches on this page: an exact identifier match first, then by count descending, then by identifier.',
      ),
    totalMatches: z.number().describe('Total themes matching the query, across all pages.'),
    offset: z.number().describe('Zero-based offset of this page.'),
    limit: z.number().describe('Maximum matches requested for this page.'),
    nextOffset: z
      .number()
      .optional()
      .describe(
        'Offset for the next page with the same query. Absent when this is the final page.',
      ),
  }),

  // Agent-facing context — the query echo, the match total, and the search outcome. Reaches
  // structuredContent and content[] automatically; never in the domain return.
  enrichment: {
    effectiveQuery: z.string().describe('Echoed query string for use in follow-up calls.'),
    totalCount: z
      .number()
      .describe('Total themes matching the query — the same figure as totalMatches.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Search outcome: that the plural fallback supplied the matches and which words it tried, or, ' +
          'when nothing matched, how to retry. Absent when the query as given matched.',
      ),
  },

  async handler(input, ctx) {
    if (themeQueryWords(input.query).length === 0) {
      throw ctx.fail(
        'invalid_query',
        `Query "${input.query}" has no letter or digit to match against theme identifiers.`,
        ctx.recoveryFor('invalid_query'),
      );
    }

    ctx.log.info('gdelt_search_themes', { query: input.query });
    const { matches, singularWords } = await getGdeltThemeService().search(input.query, ctx);
    const totalMatches = matches.length;

    // An empty match list has no offsets at all, so no offset can be out of its range.
    if (totalMatches > 0 && input.offset >= totalMatches) {
      throw ctx.fail('offset_out_of_range', `Offset ${input.offset} is past the last match`, {
        offset: input.offset,
        totalMatches,
        recovery: {
          hint: `Retry with offset 0–${totalMatches - 1}; "${input.query}" has ${totalMatches} matches.`,
        },
      });
    }

    const page = matches.slice(input.offset, input.offset + input.limit).map((m) => ({
      theme: m.theme,
      count: m.count,
      operator: `theme:${m.theme}`,
    }));
    const nextOffset =
      input.offset + page.length < totalMatches ? input.offset + page.length : undefined;

    // Every notice segment accumulates here and is flushed once — ctx.enrich.notice is last-wins.
    const notices: string[] = [];
    const singular = singularWords && `"${singularWords.join(' ')}"`;
    if (totalMatches > 0 && singular) {
      notices.push(
        `No theme matched "${input.query}" as given; these are the matches for ${singular}, with a ` +
          'trailing "s" dropped from each word of four or more letters.',
      );
    }
    if (totalMatches === 0) {
      notices.push(
        `No GKG theme matched "${input.query}"${singular ? ` or ${singular}` : ''}. Theme ` +
          'identifiers carry no labels or synonyms — retry gdelt_search_themes with fewer words, a ' +
          'singular, or a shorter stem (e.g. "displac" instead of "displacement").',
      );
    }
    ctx.enrich.echo(input.query);
    ctx.enrich.total(totalMatches);
    if (notices.length > 0) ctx.enrich.notice(notices.join(' '));

    ctx.log.info('gdelt_search_themes completed', { totalMatches, returned: page.length });
    return {
      matches: page,
      totalMatches,
      offset: input.offset,
      limit: input.limit,
      ...(nextOffset != null && { nextOffset }),
    };
  },

  format: (result) => {
    const shown = result.matches.length;
    const lines: string[] = [
      '## GKG Themes',
      shown > 0
        ? `**Matches ${result.offset + 1}–${result.offset + shown} of ${result.totalMatches}**`
        : `**Matches:** 0 of ${result.totalMatches}`,
      `**Page:** offset ${result.offset}, limit ${result.limit}`,
    ];
    if (result.nextOffset != null) lines.push(`**Next offset:** ${result.nextOffset}`);
    if (shown > 0) lines.push('');
    // The operator sits in a code span, where a backslash escape would render literally; the
    // lookup parser admits only A–Z, 0–9, _ and - in an identifier, none of which ends the span.
    result.matches.forEach((m, i) => {
      lines.push(
        `${result.offset + i + 1}. ${escapeMarkdown(m.theme, 'line-start')} — count ` +
          `${m.count.toLocaleString('en-US')} — \`${m.operator}\``,
      );
    });
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
