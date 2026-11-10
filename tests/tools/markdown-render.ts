/**
 * @fileoverview CommonMark rendering for tests that prove how a `content[]` surface displays.
 * Asserting raw Markdown shape only shows what was written; parsing it shows what a client
 * renders, which is the claim the escaping tests make.
 * @module tests/tools/markdown-render
 */

import MarkdownIt from 'markdown-it';
import { micromark } from 'micromark';
import { gfm, gfmHtml } from 'micromark-extension-gfm';

/**
 * CommonMark with the GFM extensions chat clients render: raw HTML, strikethrough, and
 * autolink literals — a bare `https://…` URL is a link, so its `_`/`*` never open emphasis.
 * With `fuzzyLink: false` a scheme-less `www.` form stays text here, though GFM links it;
 * `renderMicromark` is the model that does.
 */
const md = new MarkdownIt({ html: true, linkify: true });
md.linkify.set({ fuzzyLink: false });

/** Strict CommonMark (raw HTML, strikethrough) with no autolink literals — a bare URL is text. */
const strict = new MarkdownIt({ html: true });

/**
 * Render Markdown to HTML — GFM-style by default; `gfmAutolinks: false` models a renderer
 * without autolink literals, where a bare URL's `_`/`*` can still open emphasis.
 */
export function renderMarkdown(text: string, { gfmAutolinks = true } = {}): string {
  return (gfmAutolinks ? md : strict).render(text);
}

/**
 * Render Markdown to HTML with micromark — GFM by default, an implementation independent of
 * markdown-it that links `www.` forms in any case, as GFM does, and reads every autolink literal
 * from the raw source, backslash escapes included; `gfm: false` is its strict CommonMark.
 */
export function renderMicromark(text: string, { gfm: withGfm = true } = {}): string {
  return micromark(text, {
    allowDangerousHtml: true,
    ...(withGfm && { extensions: [gfm()], htmlExtensions: [gfmHtml()] }),
  });
}

/** markdown-it's linkify over plain text: every other rule is off, so no markup cuts a URL short. */
const linkifyOnly = new MarkdownIt('zero', { linkify: true }).enable('linkify');
linkifyOnly.linkify.set({ fuzzyLink: false });

/** micromark's GFM autolink literals over plain text: every other inline construct is off. */
function micromarkLiteralsOnly(text: string): string {
  const markup = [
    'attention',
    'autolink',
    'characterEscape',
    'characterReference',
    'codeText',
    'hardBreakEscape',
    'htmlText',
    'labelEnd',
    'labelStartImage',
    'labelStartLink',
    'strikethrough',
  ];
  return micromark(text, {
    extensions: [gfm(), { disable: { null: markup } }],
    htmlExtensions: [gfmHtml()],
  });
}

/**
 * The parsers a rendering proof runs through, two GFM readings and two strict CommonMark ones,
 * each with the GFM reading of plain text its links are checked against.
 */
const RENDERERS = [
  {
    name: 'markdown-it GFM',
    render: (text: string) => renderMarkdown(text),
    literals: (text: string) => linkifyOnly.render(text),
  },
  {
    name: 'micromark GFM',
    render: (text: string) => renderMicromark(text),
    literals: micromarkLiteralsOnly,
  },
  {
    name: 'markdown-it strict',
    render: (text: string) => renderMarkdown(text, { gfmAutolinks: false }),
    literals: micromarkLiteralsOnly,
  },
  {
    name: 'micromark strict',
    render: (text: string) => renderMicromark(text, { gfm: false }),
    literals: micromarkLiteralsOnly,
  },
];

/** A link element whose content is plain text. */
const LINK = /<a href="[^"]*">([^<]*)<\/a>/g;

/**
 * How `markdown` fails to render as `html` in each parser of `RENDERERS`; `[]` when it renders
 * as `html` in all of them. Links are unwrapped to their text before the comparison, and each
 * link must be one that parser's GFM reading (micromark's, for a strict parser) makes of
 * `written` — the text as it displays — read as plain text and split at spaces, tabs, and line
 * breaks: the link's text is a URL exactly as written there, ending where GFM ends it, and its
 * href is what GFM derives from that text.
 */
export function renderingFailures(markdown: string, html: string, written: string): string[] {
  const failures: string[] = [];
  for (const { name, render, literals } of RENDERERS) {
    const rendered = render(markdown).trimEnd();
    if (rendered.replace(LINK, '$1') !== html.trimEnd()) {
      failures.push(`${name}: ${JSON.stringify(markdown)} renders ${JSON.stringify(rendered)}`);
      continue;
    }
    const links = rendered.match(LINK) ?? [];
    if (links.length === 0) continue;
    const asWritten = written
      .split(/[ \t\r\n]+/)
      .flatMap((run) => (run ? (literals(`x ${run}`).match(LINK) ?? []) : []));
    for (const link of links) {
      const at = asWritten.indexOf(link);
      if (at === -1) {
        failures.push(
          `${name}: ${JSON.stringify(markdown)} makes ${link}, not a link GFM makes of the text`,
        );
      } else asWritten.splice(at, 1);
    }
  }
  return failures;
}

/** How a value renders when it is displayed literally, as HTML text. */
export function literalHtml(value: string): string {
  return md.utils.escapeHtml(value);
}

const HTML_ENTITIES = new Map([
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&quot;', '"'],
  ['&amp;', '&'],
]);

/**
 * The text rendered HTML displays: its tags stripped, repeating until a pass removes nothing so
 * no removal can leave a tag behind, and the entities `literalHtml` writes decoded.
 */
export function displayedText(html: string): string {
  let text = html;
  let previous: string;
  do {
    previous = text;
    text = text.replace(/<[^>]*>/g, '');
  } while (text !== previous);
  return text.replace(/&(?:lt|gt|quot|amp);/g, (entity) => HTML_ENTITIES.get(entity) as string);
}

/** The `href` a link destination resolves to when it parses as exactly `url`. */
export function hrefFor(url: string): string {
  return md.utils.escapeHtml(md.normalizeLink(url));
}

/**
 * Rendered HTML with the links GFM makes of bare http(s) URLs unwrapped to their text — a URL in
 * escaped text whose run needs no escape is still linked that way, as any URL in prose is, and
 * that is the one element such text may produce. What remains shows whether the text displays
 * intact; whether each link's href is right is `renderingFailures`'s check.
 */
export function withoutWebAutolinks(html: string): string {
  return html.replace(/<a href="https?:\/\/[^"]*">|<\/a>/g, '');
}

/** Concatenated text of every text block in a tool result's `content[]`. */
export function contentText(result: { content: unknown[] }): string {
  return result.content.map((block) => (block as { text?: string }).text ?? '').join('');
}
