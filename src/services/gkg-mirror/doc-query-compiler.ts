/**
 * @fileoverview Compiles a GDELT DOC query string into the GKG mirror's query plan, and renders
 * keyword and theme predicates as FTS5 MATCH text. Runs on the main thread with no store access;
 * the plan it returns crosses to the mirror worker by structured clone.
 *
 * Grammar (GDELT DOC 2.0): space-separated elements, all required. An element is a word, a
 * `"quoted phrase"`, an operator (`name:value`, `name:"value"`), or a tone comparison
 * (`tone<-5`); a leading `-` excludes it. `(a OR b …)` ORs elements, separated by the capitalized
 * word `OR`, and cannot nest. Operator names are matched case-insensitively.
 *
 * Caller text never reaches FTS5 as syntax: {@link ftsMatchText} emits every keyword, phrase, and
 * theme as an FTS5 string literal under a column filter chosen here.
 * @module services/gkg-mirror/doc-query-compiler
 */

import { resolveDocCountry } from './countries.js';
import { GKG_KEYWORD_COLUMNS } from './gkg-mirror-schema.js';
import { resolveDocLanguage } from './languages.js';
import type {
  MirrorClause,
  MirrorCompileResult,
  MirrorPredicate,
  MirrorPredicateKind,
} from './types.js';

/** Most predicates one plan may hold, OR-group members included. */
export const MAX_PLAN_PREDICATES = 100;

/** Longest query the mirror compiles, in UTF-16 code units; a longer query goes to DOC alone. */
export const MAX_QUERY_LENGTH = 1_000;

const TOO_LONG_REFUSAL: MirrorCompileResult = {
  ok: false,
  operator: '',
  detail: `The query is longer than the ${MAX_QUERY_LENGTH.toLocaleString('en-US')} characters the GKG mirror compiles.`,
  hint: `A query of up to ${MAX_QUERY_LENGTH.toLocaleString('en-US')} characters lets the local GKG mirror answer while GDELT refuses.`,
};

/** Longest `operator` echo a refusal carries. */
const OPERATOR_ECHO_LIMIT = 120;

/** Predicate kinds in the order a plan reports them. */
const KIND_ORDER: readonly MirrorPredicateKind[] = [
  'keyword',
  'theme',
  'domain',
  'domainis',
  'sourcelang',
  'sourcecountry',
  'tone',
];

/** DOC operators that select on image annotations (VGKG), which the GKG mirror does not store. */
const IMAGE_OPERATORS = new Set([
  'imagetag',
  'imagewebtag',
  'imageocrmeta',
  'imagefacetone',
  'imagenumfaces',
  'imagewebcount',
]);

const IMAGE_OPERATOR_DETAIL =
  'Image operators search image annotations, which the GKG mirror does not store.';

// ─── Scanner ──────────────────────────────────────────────────────────────────

/**
 * One scanned token with its source span. An `element` is a word, a quoted phrase (`word: ''`),
 * or a word ending in `:` or a bare `-` with the phrase that directly follows it attached
 * (`near20:"a b"`, `-"bird flu"`).
 */
type Token =
  | { type: '('; start: number; end: number }
  | { type: ')'; start: number; end: number }
  | {
      type: 'element';
      start: number;
      end: number;
      word: string;
      phrase?: { text: string; closed: boolean };
    };

function isSpace(code: number): boolean {
  return (
    code === 32 || (code >= 9 && code <= 13) || (code > 127 && /\s/.test(String.fromCharCode(code)))
  );
}

/** One pass, left to right; every index is visited a bounded number of times. */
function scan(query: string): Token[] {
  const tokens: Token[] = [];
  const length = query.length;
  let i = 0;

  /** Read a phrase opening at `start` (a `"`); returns its text and the index past it. */
  const readPhrase = (start: number) => {
    const close = query.indexOf('"', start + 1);
    return close === -1
      ? { text: query.slice(start + 1), closed: false, end: length }
      : { text: query.slice(start + 1, close), closed: true, end: close + 1 };
  };

  while (i < length) {
    const code = query.charCodeAt(i);
    if (isSpace(code)) {
      i += 1;
    } else if (code === 40) {
      tokens.push({ type: '(', start: i, end: i + 1 });
      i += 1;
    } else if (code === 41) {
      tokens.push({ type: ')', start: i, end: i + 1 });
      i += 1;
    } else if (code === 34) {
      const { text, closed, end } = readPhrase(i);
      tokens.push({ type: 'element', start: i, end, word: '', phrase: { text, closed } });
      i = end;
    } else {
      let j = i;
      while (j < length) {
        const c = query.charCodeAt(j);
        if (isSpace(c) || c === 34 || c === 40 || c === 41) break;
        j += 1;
      }
      const word = query.slice(i, j);
      if (query.charCodeAt(j) === 34 && (word === '-' || word.endsWith(':'))) {
        const { text, closed, end } = readPhrase(j);
        tokens.push({ type: 'element', start: i, end, word, phrase: { text, closed } });
        i = end;
      } else {
        tokens.push({ type: 'element', start: i, end: j, word });
        i = j;
      }
    }
  }
  return tokens;
}

// ─── Element compilation ─────────────────────────────────────────────────────

type ElementToken = Extract<Token, { type: 'element' }>;
type CompiledElement = { negated: boolean; predicate: MirrorPredicate } | { detail: string };

const THEME_VALUE = /^[A-Z0-9_-]+$/;
const DOMAIN_VALUE = /^[a-z0-9._-]+$/;
const ALPHANUMERIC = /[A-Za-z0-9]/;
const DIGITS = /^[0-9]+$/;
const WORD_CHARACTER = /[\p{L}\p{N}]/u;

/** A signed decimal (`-5`, `+2.5`, `.5`), scanned without backtracking. */
function parseToneValue(text: string): number | undefined {
  let i = text[0] === '-' || text[0] === '+' ? 1 : 0;
  let digits = 0;
  let dot = false;
  for (; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code >= 48 && code <= 57) digits += 1;
    else if (code === 46 && !dot) dot = true;
    else return;
  }
  return digits > 0 ? Number(text) : undefined;
}

function isOrWord(token: Token): boolean {
  return token.type === 'element' && token.word === 'OR' && !token.phrase;
}

function compileOperator(name: string, value: string): MirrorPredicate | { detail: string } {
  switch (name) {
    case 'theme': {
      const theme = value.toUpperCase();
      return THEME_VALUE.test(theme) && ALPHANUMERIC.test(theme)
        ? { kind: 'theme', theme }
        : { detail: 'theme: takes a GKG theme identifier such as TAX_FNCACT.' };
    }
    case 'domain':
    case 'domainis': {
      const domain = value.toLowerCase();
      return DOMAIN_VALUE.test(domain) && ALPHANUMERIC.test(domain)
        ? { kind: name, domain }
        : { detail: `${name}: takes a domain name such as cnn.com.` };
    }
    case 'sourcelang': {
      const language = resolveDocLanguage(value);
      return language
        ? { kind: 'sourcelang', language }
        : {
            detail:
              'sourcelang: takes a GDELT language name or three-letter code, such as spanish or spa.',
          };
    }
    case 'sourcecountry': {
      const fips = resolveDocCountry(value);
      return fips
        ? { kind: 'sourcecountry', fips }
        : {
            detail:
              'sourcecountry: takes a FIPS country code or a country name without spaces, such as AE or unitedarabemirates.',
          };
    }
  }
  const counted = name.startsWith('near')
    ? name.slice(4)
    : name.startsWith('repeat')
      ? name.slice(6)
      : '';
  if (DIGITS.test(counted)) {
    return {
      detail:
        'Proximity and repeat operators need article text, which the GKG mirror does not store.',
    };
  }
  if (IMAGE_OPERATORS.has(name)) return { detail: IMAGE_OPERATOR_DETAIL };
  return { detail: 'The GKG mirror cannot answer this operator; it is not a GKG field.' };
}

function compileComparison(word: string, at: number): MirrorPredicate | { detail: string } {
  const name = word.slice(0, at).toLowerCase();
  const op = word[at];
  if (name === 'tone' || name === 'toneabs') {
    const value = parseToneValue(word.slice(at + 1));
    return (op === '<' || op === '>') && value !== undefined
      ? { kind: 'tone', absolute: name === 'toneabs', comparison: op, value }
      : { detail: `${name} takes < or > and a number, such as ${name}<-5.` };
  }
  if (IMAGE_OPERATORS.has(name)) return { detail: IMAGE_OPERATOR_DETAIL };
  return {
    detail: 'The GKG mirror cannot answer this comparison; only tone and toneabs are GKG fields.',
  };
}

function compileKeyword(text: string, phrase: boolean): MirrorPredicate | { detail: string } {
  if (!WORD_CHARACTER.test(text))
    return { detail: 'The term has no letter or digit to search for.' };
  if (!phrase) {
    const singleCharacter =
      text.length === 1 || (text.length === 2 && (text.codePointAt(0) ?? 0) > 0xffff);
    if (singleCharacter) {
      return {
        detail: 'Single-character keywords are too short; use a longer keyword or a quoted phrase.',
      };
    }
    if (text.includes('-')) {
      return { detail: 'A hyphen inside a keyword is reserved; quote the term, such as "f-16".' };
    }
  }
  return { kind: 'keyword', text, phrase };
}

function compileElement(token: ElementToken): CompiledElement {
  let word = token.word;
  const negated = word.startsWith('-');
  if (negated) word = word.slice(1);
  if (word.startsWith('-')) return { detail: 'Use a single - to exclude an element.' };
  if (token.phrase && !token.phrase.closed) return { detail: 'The quote is never closed.' };

  let compiled: MirrorPredicate | { detail: string };
  const colon = word.indexOf(':');
  if (word === '') {
    compiled = token.phrase
      ? token.phrase.text.trim() === ''
        ? { detail: 'The quoted phrase is empty.' }
        : compileKeyword(token.phrase.text, true)
      : { detail: 'A - must be followed by the element it excludes.' };
  } else if (colon !== -1) {
    const value = token.phrase ? token.phrase.text : word.slice(colon + 1);
    compiled =
      value === ''
        ? { detail: 'The operator has no value.' }
        : compileOperator(word.slice(0, colon).toLowerCase(), value);
  } else {
    let at = -1;
    for (let i = 0; i < word.length && at === -1; i += 1) {
      const c = word[i];
      if (c === '<' || c === '>' || c === '=') at = i;
    }
    compiled = at === -1 ? compileKeyword(word, false) : compileComparison(word, at);
  }
  return 'detail' in compiled ? compiled : { negated, predicate: compiled };
}

// ─── Parser ───────────────────────────────────────────────────────────────────

/**
 * Compile a DOC query string. Linear in the query's length; a query over
 * {@link MAX_QUERY_LENGTH} is refused before it is read.
 */
export function compileDocQuery(query: string): MirrorCompileResult {
  if (query.length > MAX_QUERY_LENGTH) return TOO_LONG_REFUSAL;
  const tokens = scan(query);
  const clauses: MirrorClause[] = [];
  let predicateCount = 0;

  const fail = (start: number, end: number, detail: string): MirrorCompileResult => {
    const text = query.slice(start, end).trim();
    return {
      ok: false,
      operator: text.length > OPERATOR_ECHO_LIMIT ? `${text.slice(0, OPERATOR_ECHO_LIMIT)}…` : text,
      detail,
    };
  };

  /** Source end of the group opening at token `open`, counting nested parentheses. */
  const groupEnd = (open: number): number => {
    let depth = 0;
    for (const token of tokens.slice(open)) {
      if (token.type === '(') depth += 1;
      else if (token.type === ')' && --depth === 0) return token.end;
    }
    return query.length;
  };

  const tooMany = (token: ElementToken) =>
    ++predicateCount > MAX_PLAN_PREDICATES
      ? fail(
          token.start,
          token.end,
          `The GKG mirror compiles at most ${MAX_PLAN_PREDICATES} elements.`,
        )
      : undefined;

  /** The OR group being read: its opening token's index and source start. */
  let group:
    | { open: number; start: number; anyOf: MirrorPredicate[]; expectElement: boolean }
    | undefined;

  for (const [t, token] of tokens.entries()) {
    if (group) {
      if (token.type === ')') {
        if (group.expectElement) {
          return fail(group.start, token.end, 'The OR group is empty or ends with OR.');
        }
        clauses.push({ anyOf: group.anyOf, negated: false });
        group = undefined;
      } else if (token.type === '(') {
        return fail(group.start, groupEnd(group.open), 'OR groups cannot be nested.');
      } else if (!group.expectElement) {
        if (!isOrWord(token)) {
          return fail(
            group.start,
            groupEnd(group.open),
            'Elements inside parentheses must be separated by the capitalized word OR.',
          );
        }
        group.expectElement = true;
      } else if (isOrWord(token)) {
        return fail(group.start, groupEnd(group.open), 'An OR must sit between two elements.');
      } else {
        const compiled = compileElement(token);
        if ('detail' in compiled) return fail(token.start, token.end, compiled.detail);
        if (compiled.negated) {
          return fail(
            token.start,
            token.end,
            'The GKG mirror cannot exclude an element inside an OR group; exclude it outside the parentheses.',
          );
        }
        const refusal = tooMany(token);
        if (refusal) return refusal;
        group.anyOf.push(compiled.predicate);
        group.expectElement = false;
      }
      continue;
    }

    if (token.type === ')') {
      return fail(token.start, token.end, 'A closing parenthesis has no opening one.');
    }
    if (token.type === '(') {
      group = { open: t, start: token.start, anyOf: [], expectElement: true };
      continue;
    }
    if (isOrWord(token)) {
      return fail(
        token.start,
        token.end,
        'OR may appear only inside parentheses, such as (a OR b).',
      );
    }
    if (token.word === '-' && !token.phrase && tokens[t + 1]?.type === '(') {
      return fail(
        token.start,
        groupEnd(t + 1),
        'The GKG mirror cannot exclude an OR group; exclude each element instead.',
      );
    }
    const compiled = compileElement(token);
    if ('detail' in compiled) return fail(token.start, token.end, compiled.detail);
    const refusal = tooMany(token);
    if (refusal) return refusal;
    clauses.push({ anyOf: [compiled.predicate], negated: compiled.negated });
  }

  if (group) return fail(group.start, query.length, 'An opening parenthesis is never closed.');
  if (clauses.length === 0) return { ok: false, operator: '', detail: 'The query is empty.' };

  const used = new Set(clauses.flatMap((c) => c.anyOf.map((p) => p.kind)));
  return {
    ok: true,
    plan: {
      clauses,
      kinds: KIND_ORDER.filter((kind) => used.has(kind)),
      filterOnly: !used.has('keyword'),
    },
  };
}

// ─── FTS rendering ────────────────────────────────────────────────────────────

/** A keyword or theme predicate: the two kinds the FTS index answers. */
export type FtsPredicate = Extract<MirrorPredicate, { kind: 'keyword' | 'theme' }>;

/** True for a predicate the FTS index answers. */
export function isFtsPredicate(predicate: MirrorPredicate): predicate is FtsPredicate {
  return predicate.kind === 'keyword' || predicate.kind === 'theme';
}

const KEYWORD_COLUMN_FILTER = `{${GKG_KEYWORD_COLUMNS.join(' ')}}`;

/**
 * FTS5 MATCH text for one predicate: its text as an FTS5 string literal (inner `"` doubled) under
 * a column filter — the keyword columns for a keyword or phrase, `themes` for a theme. A string
 * literal is matched as a phrase of its tokens, so FTS5 operators, `*`, `^`, and `col:` inside it
 * are plain text. FTS5 reads the expression only up to its first NUL, so a NUL is written as a
 * space: the tokenizer splits text there either way, as at every control character.
 */
export function ftsMatchText(predicate: FtsPredicate): string {
  const literal = (text: string) => `"${text.replaceAll('"', '""').replaceAll('\0', ' ')}"`;
  return predicate.kind === 'theme'
    ? `themes : ${literal(predicate.theme)}`
    : `${KEYWORD_COLUMN_FILTER} : ${literal(predicate.text)}`;
}
