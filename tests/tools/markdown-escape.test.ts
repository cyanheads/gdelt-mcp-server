/**
 * @fileoverview Tests for the shared Markdown escaper applied at every content[] interpolation
 * of upstream text. Exact escapes pin what is written; a CommonMark/GFM parser proves what a
 * client renders — every hostile value must display literally in every slot it can occupy.
 * @module tests/tools/markdown-escape.test
 */

import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import {
  escapeMarkdown,
  type MarkdownSlot,
  markdownLinkDestination,
  markdownUrl,
} from '@/mcp-server/tools/markdown-escape.js';
import { hrefFor, literalHtml, renderMarkdown } from './markdown-render.js';

/** How a value displays once its line breaks read as spaces. */
function displayed(value: string): string {
  return value.replace(/\r\n|\r|\n/g, ' ');
}

describe('escapeMarkdown', () => {
  it.each<[string, MarkdownSlot, string]>([
    [
      '<b>A &amp; B</b> [x](y) *_z_* `code` Learn C# #',
      'heading-end',
      String.raw`\<b>A \&amp; B\</b> \[x\](y) \*\_z\_\* \`code\` Learn C# \#`,
    ],
    [
      'line one\n- line two [x](y) <i>tag</i> &copy;',
      'inline',
      String.raw`line one - line two \[x\](y) \<i>tag\</i> \&copy;`,
    ],
    ['a\r\nb\rc\nd', 'inline', 'a b c d'],
    ['AT&T &nope &#169; &#xA9;', 'inline', String.raw`AT&T &nope \&#169; \&#xA9;`],
    ['a < b, 5<6, <5@a.bc>', 'inline', String.raw`a < b, 5\<6, \<5@a.bc>`],
    ['snake_case __init__ _lead', 'inline', String.raw`snake_case \_\_init\_\_ \_lead`],
    ['~~strike~~ back\\slash', 'inline', String.raw`\~\~strike\~\~ back\\slash`],
    ['Learn C#', 'heading-end', 'Learn C#'],
    ['## ##', 'heading-end', String.raw`## \##`],
    ['#', 'heading-end', String.raw`\#`],
    ['C# #\n', 'heading-end', String.raw`C# \# `],
    ['1. Rank', 'line-start', String.raw`1\. Rank`],
    ['10) Ten', 'line-start', String.raw`10\) Ten`],
    ['> quoted', 'line-start', String.raw`\> quoted`],
    ['- dash', 'line-start', String.raw`\- dash`],
    ['+ plus', 'line-start', String.raw`\+ plus`],
    ['---', 'line-start', String.raw`\---`],
    ['## Heading', 'line-start', String.raw`\## Heading`],
    ['    indented', 'line-start', 'indented'],
    ['1.5 million', 'line-start', '1.5 million'],
    ['#nospace', 'line-start', '#nospace'],
  ])('escapes %j in the %s slot', (value, slot, expected) => {
    expect(escapeMarkdown(value, slot)).toBe(expected);
  });

  it('passes values without markup characters or line breaks through byte-identical', () => {
    const plain = [
      'United States',
      'Anderson Cooper 360',
      '2024-01-15T20:00:00Z',
      '20240115T120000Z',
      'Learn C# today',
      'snake_case_name',
      'rock & roll',
      'a < b',
      'Prices (USD) fell 3.5% - again.',
      '日本語のニュース',
    ];
    for (const slot of ['inline', 'heading-end', 'line-start'] as const) {
      for (const value of plain) expect(escapeMarkdown(value, slot)).toBe(value);
    }
  });

  it('leaves every field of the live station catalog byte-identical', () => {
    const { stations } = JSON.parse(
      readFileSync(new URL('../fixtures/tv-station-catalog.json', import.meta.url), 'utf8'),
    ) as { stations: Array<Record<string, unknown>> };
    expect(stations.length).toBeGreaterThan(100);
    for (const station of stations) {
      for (const value of Object.values(station)) {
        if (typeof value === 'string') expect(escapeMarkdown(value)).toBe(value);
      }
    }
  });

  /**
   * The rendering proof: every hostile value, in every slot, parses to the literal text it
   * carried (line breaks as spaces) and nothing else.
   */
  describe('renders literally under a CommonMark/GFM parser', () => {
    const HOSTILE = [
      '<b>A &amp; B</b> [x](y) *_z_* `code` Learn C# #',
      'line one\n- line two [x](y) <i>tag</i> &copy;',
      'a\r\nb\rc',
      '&#169; &#xA9; &copy; AT&T &nope',
      '<!-- c --> <?pi?> <!DOCTYPE x> <![CDATA[x]]> </close> <5@a.bc> <mailto:a@b.c> a < b 5<6',
      'snake_case __init__ _lead trail_ mid_(p)_ x__y',
      '***bold*** ~~strike~~ ~one~ ```fence``` ~~~',
      '\\*already\\* back\\slash \\',
      'emoji_😀_ 😀_x_😀 日本_語 _日本_',
      '[^1]: footnote ![img](x) [ref]: /url',
      'C# #',
      '## ##',
      '#',
      '1. one',
      '10) ten',
      '- dash',
      '+ plus',
      '> quote',
      '---',
      '- - -',
      '    indented',
      '#nospace',
      '1.5 million',
      '| a | b |',
    ];

    it.each(HOSTILE)('%j as inline text after a label', (value) => {
      expect(renderMarkdown(`**Label:** ${escapeMarkdown(value)}`)).toBe(
        `<p><strong>Label:</strong> ${literalHtml(displayed(value).trimEnd())}</p>\n`,
      );
    });

    it.each(HOSTILE)('%j as a heading', (value) => {
      expect(renderMarkdown(`### ${escapeMarkdown(value, 'heading-end')}`)).toBe(
        `<h3>${literalHtml(displayed(value).trim())}</h3>\n`,
      );
    });

    it.each(HOSTILE)('%j as a link label', (value) => {
      expect(renderMarkdown(`[${escapeMarkdown(value)}](https://example.com/x)`)).toBe(
        `<p><a href="https://example.com/x">${literalHtml(displayed(value))}</a></p>\n`,
      );
    });

    it.each(HOSTILE)('%j as the first text of a list item', (value) => {
      expect(renderMarkdown(`- ${escapeMarkdown(value, 'line-start')}`)).toBe(
        `<ul>\n<li>${literalHtml(displayed(value).trim())}</li>\n</ul>\n`,
      );
    });
  });

  /**
   * One linear pass with bounded lookahead: the cost of the worst inputs grows with their
   * length, never with its square. The span ratio leaves 4× headroom over linear (16×) and
   * sits far below quadratic (256×).
   */
  it('stays linear on its worst cases', () => {
    const worstCases: Array<[string, (n: number) => string, MarkdownSlot]> = [
      ['nested <a<a<a…>>>', (n) => `${'<a'.repeat(n / 4)}${'>'.repeat(n / 2)}`, 'inline'],
      ['unclosed <', (n) => '<'.repeat(n), 'inline'],
      ['unclosed <a', (n) => '<a'.repeat(n / 2), 'inline'],
      ['* run', (n) => '*'.repeat(n), 'inline'],
      ['_ run', (n) => '_'.repeat(n), 'inline'],
      ['[ run', (n) => '['.repeat(n), 'inline'],
      ['entity-like &', (n) => `&${'a'.repeat(n - 1)}`, 'inline'],
      ['trailing # run', (n) => `x ${'#'.repeat(n - 2)}`, 'heading-end'],
      ['dash run', (n) => `${'- '.repeat(n / 2 - 1)}-x`, 'line-start'],
    ];
    const SIZES = [5_000, 20_000, 80_000] as const;
    const REPS = 20;

    const timeOf = (value: string, slot: MarkdownSlot) => {
      let best = Number.POSITIVE_INFINITY;
      for (let trial = 0; trial < 5; trial++) {
        const start = performance.now();
        for (let r = 0; r < REPS; r++) escapeMarkdown(value, slot);
        best = Math.min(best, (performance.now() - start) / REPS);
      }
      return best;
    };

    for (const [, build, slot] of worstCases) {
      escapeMarkdown(build(SIZES[0]), slot); // warm up
      const [t5k, , t80k] = SIZES.map((size) => timeOf(build(size), slot)) as [
        number,
        number,
        number,
      ];
      expect(t80k / Math.max(t5k, 0.01)).toBeLessThan(64);
      expect(t80k).toBeLessThan(25);
    }
  });

  it('escapes an 80,000-character nested value and an unclosed < exactly, and they render literally', () => {
    const nested = `${'<a'.repeat(20_000)}${'>'.repeat(40_000)}`;
    expect(escapeMarkdown(nested)).toBe(`${'\\<a'.repeat(20_000)}${'>'.repeat(40_000)}`);
    expect(renderMarkdown(escapeMarkdown(nested))).toBe(`<p>${literalHtml(nested)}</p>\n`);

    const unclosed = `x ${'<'.repeat(80_000)}`;
    expect(escapeMarkdown(unclosed)).toBe(unclosed);
    expect(renderMarkdown(escapeMarkdown(unclosed))).toBe(`<p>${literalHtml(unclosed)}</p>\n`);
  });
});

describe('markdownUrl', () => {
  it('passes plain URLs through byte-identical', () => {
    for (const url of [
      'https://example.com/article',
      'https://archive.org/details/CNNW_20240701_120000_CNN_News_Central#start/2631/end/2666',
      'https://example.com/a?x=1&y=2',
      'https://example.com/path(1)/#frag',
    ]) {
      expect(markdownUrl(url)).toBe(url);
    }
  });

  it.each([
    ['https://example.com/a_(b)_c?x=1'],
    ['https://example.com/img_(1).jpg'],
    ['https://e.com/*a*'],
    ['https://e.com/~user/'],
    ['https://e.com/[c]'],
    ['https://e.com/?d=1&amp;e=2'],
    ['https://e.com/a\\b'],
    ['https://e.com/`x`'],
  ])(
    'renders %j, which carries a CommonMark-significant character, as an autolink — never backslash-escaped',
    (url) => {
      expect(markdownUrl(url)).toBe(`<${url}>`);
    },
  );

  it('percent-encodes a space, <, >, and control characters, none of which an autolink can hold', () => {
    expect(markdownUrl('https://e.com/a b')).toBe('https://e.com/a%20b');
    expect(markdownUrl('https://e.com/a\nb\r<c>\td')).toBe('https://e.com/a%0Ab%0D%3Cc%3E%09d');
    expect(markdownUrl('https://e.com/a_(b) <x>_')).toBe('<https://e.com/a_(b)%20%3Cx%3E_>');
  });

  /** Without a scheme a value cannot be an autolink, so it is escaped as text and still displays intact. */
  it('escapes a scheme-less value that no autolink can carry', () => {
    expect(markdownUrl('example.com/a_(b)_c')).toBe(String.raw`example.com/a\_(b)\_c`);
    expect(markdownUrl('example.com/plain')).toBe('example.com/plain');
  });

  /**
   * The proof: several bare URLs in one paragraph — so a `_` in one URL could pair with a `_` in
   * the next — display intact whether or not the renderer links bare URLs itself.
   */
  it.each([true, false])(
    'displays bare URLs intact in one paragraph (GFM autolinks: %s)',
    (gfmAutolinks) => {
      const urls = [
        'https://example.com/a_(b)_c?x=1',
        'https://example.com/img_(1).jpg',
        'https://e.com/*a*/~b~/[c]?d=1&amp;e=2',
        'https://archive.org/details/CNNW_20240701_120000_CNN_News_Central#start/2631/end/2666',
        'https://example.com/article',
      ];
      const text = urls.map((url, i) => `**URL ${i}:** ${markdownUrl(url)}`).join('\n');
      const html = renderMarkdown(text, { gfmAutolinks });
      expect(html).not.toMatch(/<(em|s|code|del)>/);
      for (const [i, url] of urls.entries()) {
        const linked = gfmAutolinks || markdownUrl(url) !== url;
        const shown = linked
          ? `<a href="${hrefFor(url)}">${literalHtml(url)}</a>`
          : literalHtml(url);
        const end = i === urls.length - 1 ? '</p>' : '\n';
        expect(html).toContain(`<strong>URL ${i}:</strong> ${shown}${end}`);
      }
    },
  );
});

describe('markdownLinkDestination', () => {
  it('keeps a plain URL byte-identical', () => {
    expect(markdownLinkDestination('https://example.com/a')).toBe('https://example.com/a');
  });

  it.each([
    'https://example.com/a_(b)_c?x=1',
    'https://example.com/a)b',
    'https://example.com/(a',
    'https://example.com/a b',
    'https://example.com/a\nb',
    'https://example.com/<x>',
    'https://example.com/*a*_b_',
    'https://example.com/a\\*b',
    'https://example.com/x&copy;y',
    'https://example.com/?a=1&amp;b=2&#169;',
    'https://example.com/a (b)\\c&amp;d',
    'https://example.com/ends-with\\',
  ])('parses %j as exactly one destination resolving to the exact URL', (url) => {
    for (const gfmAutolinks of [true, false]) {
      expect(renderMarkdown(`[t](${markdownLinkDestination(url)})`, { gfmAutolinks })).toBe(
        `<p><a href="${hrefFor(url)}">t</a></p>\n`,
      );
    }
  });

  it('escapes only the backslash and an entity-forming & — never percent-encoding them', () => {
    expect(markdownLinkDestination('https://e.com/a\\*b?x=1&y=2&amp;z')).toBe(
      String.raw`https://e.com/a\\*b?x=1&y=2\&amp;z`,
    );
  });
});
