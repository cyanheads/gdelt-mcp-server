/**
 * @fileoverview Markdown escaping for upstream text interpolated into `content[]`. GDELT titles,
 * labels, snippets, and station metadata are third-party text; rendered raw they parse as
 * markup — a nested `[x](y)` breaks a link, `*…*` turns into emphasis, `<b>` renders as HTML, a
 * newline opens a new list item. Escaping applies to `content[]` only; `structuredContent` keeps
 * the raw value, and nothing is decoded or stripped.
 * @module mcp-server/tools/markdown-escape
 */

/**
 * Where a value sits in its rendered line, which decides the block-level markup it can open.
 * Inline markup is escaped in every slot.
 */
export type MarkdownSlot =
  /** Anywhere inside a line: after a label, inside a bold span, as a link label, mid-heading. */
  | 'inline'
  /** The end of an ATX heading, where a trailing `#` run reads as the closing sequence. */
  | 'heading-end'
  /** The first text of a list item, where a leading marker opens a nested block. */
  | 'line-start';

/** A character entity or numeric reference CommonMark would decode, matched in place. */
const ENTITY_AT = /&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{0,31});/y;

/**
 * A character that can follow `<` in a raw HTML tag, comment, declaration, or processing
 * instruction, or in a URI or email autolink. Anything else after `<` is plain text.
 */
const OPENS_TAG_OR_AUTOLINK = /[A-Za-z0-9/!?.#$%&'*+=^_`{|}~-]/;

/** CommonMark's flanking classes: Unicode whitespace, punctuation, and symbols. */
const WHITESPACE_OR_PUNCTUATION = /[\s\p{P}\p{S}]/u;

/**
 * A block marker at the start of a list item's text: an ATX heading opener, a block quote, a
 * bullet, a thematic break of dashes, or an ordered-list number (whose `.`/`)` is escaped).
 */
const LEADING_BLOCK_MARKER =
  /^(?:#{1,6}(?=[ \t]|$)|>|[-+](?=[ \t]|$)|-[- \t]*$|\d{1,9}[.)](?=[ \t]|$))/;

/**
 * Escape `value` so CommonMark/GFM renders it as literal text in `slot`.
 *
 * One linear pass, escaping only where markup would parse: `\`, `` ` ``, `*`, `[`, `]`, `~`
 * always; `_` only at a word boundary (an intraword run cannot open emphasis); `<` only before
 * a character that can open a tag or autolink; `&` only before a complete entity reference.
 * Line breaks become a space, so a value can never open a new block. `.`, `-`, `(`, `)`, and
 * mid-text `#` pass through, so a value with no markup characters renders byte-identical.
 * Every lookahead is bounded, so the cost stays linear in the value's length.
 */
export function escapeMarkdown(value: string, slot: MarkdownSlot = 'inline'): string {
  const text = slot === 'line-start' ? value.replace(/^[ \t]+/, '') : value;
  const forced =
    slot === 'heading-end'
      ? closingSequenceIndex(text)
      : slot === 'line-start'
        ? blockMarkerIndex(text)
        : -1;

  let out = '';
  let flushed = 0;
  const replace = (from: number, to: number, replacement: string) => {
    out += text.slice(flushed, from) + replacement;
    flushed = to;
  };

  for (let i = 0; i < text.length; ) {
    const ch = text[i] as string;
    if (i === forced) {
      replace(i, i + 1, `\\${ch}`);
      i++;
      continue;
    }
    switch (ch) {
      case '\\':
      case '`':
      case '*':
      case '[':
      case ']':
      case '~':
        replace(i, i + 1, `\\${ch}`);
        i++;
        break;
      case '\n':
        replace(i, i + 1, ' ');
        i++;
        break;
      case '\r': {
        const next = text[i + 1] === '\n' ? i + 2 : i + 1;
        replace(i, next, ' ');
        i = next;
        break;
      }
      case '<':
        if (OPENS_TAG_OR_AUTOLINK.test(text[i + 1] ?? '')) replace(i, i + 1, '\\<');
        i++;
        break;
      case '&':
        ENTITY_AT.lastIndex = i;
        if (ENTITY_AT.test(text)) replace(i, i + 1, '\\&');
        i++;
        break;
      case '_': {
        let end = i + 1;
        while (text[end] === '_') end++;
        const intraword =
          isWordCodePoint(codePointBefore(text, i)) && isWordCodePoint(text.codePointAt(end));
        if (!intraword) replace(i, end, '\\_'.repeat(end - i));
        i = end;
        break;
      }
      default:
        i++;
    }
  }
  return out + text.slice(flushed);
}

/** A URI autolink's scheme, per CommonMark: a letter, then 1–31 letters, digits, `+`, `.`, `-`. */
const AUTOLINK_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:/;

/**
 * A URL rendered as its own text, never backslash-escaped. A plain URL passes through
 * byte-identical. One carrying a character CommonMark would read as markup — a boundary `_`,
 * `*`, `~`, a bracket, a backtick, a backslash, an entity — renders as an autolink
 * (`<https://…>`), whose content no renderer parses as emphasis, with or without GFM's own
 * linking of bare URLs. A space, `<`, `>`, and ASCII controls (line breaks included) cannot
 * sit in an autolink and no valid URL carries them raw, so they are percent-encoded first.
 * A value with no scheme cannot be an autolink; it is escaped as text instead.
 */
export function markdownUrl(url: string): string {
  const encoded = encodeUrlUnsafe(url).replaceAll(' ', '%20');
  if (escapeMarkdown(encoded) === encoded) return encoded;
  return AUTOLINK_SCHEME.test(encoded) ? `<${encoded}>` : escapeMarkdown(encoded);
}

/**
 * A URL as a `[label](destination)` destination that parses as exactly one destination and
 * resolves to exactly this URL: the angle-bracket form when it carries a space or a parenthesis,
 * the bare form otherwise, so a plain URL renders byte-identical. CommonMark decodes backslash
 * escapes and entity references inside a destination, so a `\` and an entity-forming `&` are
 * backslash-escaped there — the one place that yields the literal character. Percent-encoding
 * them would change the URL itself (`%26` is not a query separator; browsers read `\` as `/`).
 */
export function markdownLinkDestination(url: string): string {
  const encoded = encodeUrlUnsafe(url).replace(DESTINATION_DECODED, (ch) => `\\${ch}`);
  return /[ ()]/.test(encoded) ? `<${encoded}>` : encoded;
}

/** A backslash, or an `&` that opens an entity reference — both decoded inside a destination. */
const DESTINATION_DECODED =
  /\\|&(?=(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{0,31});)/g;

/** Percent-encode what no valid URL carries raw and no destination can hold: ASCII controls, `<`, `>`. */
function encodeUrlUnsafe(url: string): string {
  return url.replace(/[<>]|\p{Cc}/gu, (ch) => (ch.charCodeAt(0) > 0x7f ? ch : percentEncode(ch)));
}

function percentEncode(ch: string): string {
  return `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;
}

/**
 * Index of the `#` that would start a heading's closing sequence — a trailing `#` run at the
 * start of the value or after whitespace, followed only by whitespace — or -1. Escaping its
 * first `#` keeps the run as text.
 */
function closingSequenceIndex(text: string): number {
  let end = text.length;
  while (end > 0 && /[ \t\r\n]/.test(text[end - 1] as string)) end--;
  let start = end;
  while (start > 0 && text[start - 1] === '#') start--;
  if (start === end) return -1;
  return start === 0 || /[ \t\r\n]/.test(text[start - 1] as string) ? start : -1;
}

/** Index of the character that makes a leading block marker, or -1. */
function blockMarkerIndex(text: string): number {
  const match = LEADING_BLOCK_MARKER.exec(text);
  if (!match) return -1;
  return /^\d/.test(match[0]) ? match[0].length - 1 : 0;
}

/** Code point ending just before `index`, reassembling a surrogate pair. */
function codePointBefore(text: string, index: number): number | undefined {
  if (index <= 0) return;
  const low = text.charCodeAt(index - 1);
  if (low >= 0xdc00 && low <= 0xdfff && index >= 2) {
    const high = text.charCodeAt(index - 2);
    if (high >= 0xd800 && high <= 0xdbff) return text.codePointAt(index - 2);
  }
  return low;
}

/** True for a code point that is neither whitespace nor punctuation — a letter, digit, or mark. */
function isWordCodePoint(codePoint: number | undefined): boolean {
  return (
    codePoint !== undefined && !WHITESPACE_OR_PUNCTUATION.test(String.fromCodePoint(codePoint))
  );
}
