/**
 * @fileoverview CommonMark rendering for tests that prove how a `content[]` surface displays.
 * Asserting raw Markdown shape only shows what was written; parsing it shows what a client
 * renders, which is the claim the escaping tests make.
 * @module tests/tools/markdown-render
 */

import MarkdownIt from 'markdown-it';

/**
 * CommonMark with the GFM extensions chat clients render: raw HTML, strikethrough, and
 * autolink literals — a bare `https://…` URL is a link, so its `_`/`*` never open emphasis.
 * Bare domains without a scheme stay text, as in GFM.
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

/** How a value renders when it is displayed literally, as HTML text. */
export function literalHtml(value: string): string {
  return md.utils.escapeHtml(value);
}

/** The `href` a link destination resolves to when it parses as exactly `url`. */
export function hrefFor(url: string): string {
  return md.utils.escapeHtml(md.normalizeLink(url));
}

/** Concatenated text of every text block in a tool result's `content[]`. */
export function contentText(result: { content: unknown[] }): string {
  return result.content.map((block) => (block as { text?: string }).text ?? '').join('');
}
