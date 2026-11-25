/**
 * @fileoverview GDELT's query syntax as the DOC, Context, and TV APIs read it: the scanner the GKG
 * mirror's compiler and the OR grouping share, and the grouping itself. Space-separated elements
 * are all required; OR joins elements only inside `( … )`, and GDELT reads `or` in any case as it.
 * @module services/gdelt/query-grammar
 */

/**
 * One scanned token with its source span. An `element` is a word, a quoted phrase (`word: ''`),
 * or a word ending in `:` or a bare `-` with the phrase that directly follows it attached
 * (`near20:"a b"`, `-"bird flu"`).
 */
type QueryToken =
  | { type: '('; start: number; end: number }
  | { type: ')'; start: number; end: number }
  | {
      type: 'element';
      start: number;
      end: number;
      word: string;
      phrase?: { text: string; closed: boolean };
    };

export type ElementToken = Extract<QueryToken, { type: 'element' }>;

function isSpace(code: number): boolean {
  return (
    code === 32 || (code >= 9 && code <= 13) || (code > 127 && /\s/.test(String.fromCharCode(code)))
  );
}

/** One pass, left to right; every index is visited a bounded number of times. */
export function scanQuery(query: string): QueryToken[] {
  const tokens: QueryToken[] = [];
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

/** True for the word `or` in any case, which GDELT reads as OR between two elements. */
export function isOrWord(token: QueryToken): boolean {
  return (
    token.type === 'element' &&
    !token.phrase &&
    token.word.length === 2 &&
    token.word.toUpperCase() === 'OR'
  );
}

/** True for the capitalized `OR` alone, an operator wherever it stands. */
export function isCapitalOr(token: QueryToken): boolean {
  return token.type === 'element' && !token.phrase && token.word === 'OR';
}

/** Operators that choose the sources searched, whatever their text says. */
const SOURCE_FILTERS = new Set([
  'domain',
  'domainis',
  'market',
  'network',
  'show',
  'sourcecountry',
  'sourcelang',
  'station',
]);

function isSourceFilter({ word }: ElementToken): boolean {
  const name = word.slice(word.startsWith('-') ? 1 : 0, Math.max(word.indexOf(':'), 0));
  return SOURCE_FILTERS.has(name.toLowerCase());
}

/**
 * How a query with OR outside parentheses is read. `none`: it has no such OR. `grouped`: it is
 * nothing but elements and OR groups joined by OR, which has one reading, written as one group in
 * `query`. `ambiguous`: it has one among other elements, where a group could hold different ones;
 * in a place that joins nothing; or between a source filter and any other element, where the
 * filter more likely scopes the query (`prix or sourcelang:french`) than widens it.
 */
export type OrGrouping =
  | { kind: 'none' }
  | { kind: 'grouped'; query: string }
  | { kind: 'ambiguous' };

/**
 * A top-level piece of a query: an element, or a parenthesized clause, with its members when it is
 * an OR group of plain elements and nothing else.
 */
type Item = { token: ElementToken } | { members: ElementToken[] | undefined };

/**
 * Read the ORs of `query` that stand outside parentheses. A lowercase `or` that opens or closes
 * the query joins nothing and stays a word (French `prix or`); a capitalized one there is an
 * operator with an element missing. Linear in the query's length.
 */
export function groupBareOr(query: string): OrGrouping {
  const items = topLevelItems(query);
  const isOr = (item: Item) => 'token' in item && isOrWord(item.token);
  const hasBareOr = items.some(
    (item, i) =>
      'token' in item &&
      (isCapitalOr(item.token) || (isOrWord(item.token) && i > 0 && i < items.length - 1)),
  );
  if (!hasBareOr) return { kind: 'none' };

  if (items.length % 2 === 0) return { kind: 'ambiguous' };
  const operands: ElementToken[] = [];
  for (const [i, item] of items.entries()) {
    if (i % 2 === 1) {
      if (!isOr(item)) return { kind: 'ambiguous' };
    } else if ('members' in item) {
      if (!item.members) return { kind: 'ambiguous' };
      for (const member of item.members) operands.push(member);
    } else {
      if (!isOperand(item.token)) return { kind: 'ambiguous' };
      operands.push(item.token);
    }
  }
  const filters = operands.filter(isSourceFilter).length;
  if (filters > 0 && filters < operands.length) return { kind: 'ambiguous' };
  const members = operands.map((token) => query.slice(token.start, token.end));
  return { kind: 'grouped', query: `(${members.join(' OR ')})` };
}

/** Quotation marks other than `"`, which GDELT reads as letters of a word. */
const TYPOGRAPHIC_QUOTE = /[“”„‟«»「」『』＂]/g;

/**
 * An element OR can join: not `or` itself, and no quote left open. A word with an unpaired
 * typographic quotation mark (`“life or death”`) is one end of a phrase that holds the `or`.
 */
function isOperand(token: ElementToken): boolean {
  return (
    !isOrWord(token) &&
    token.phrase?.closed !== false &&
    (token.word.match(TYPOGRAPHIC_QUOTE)?.length ?? 0) % 2 === 0
  );
}

/**
 * The query's tokens with each balanced `( … )` folded into one item. A closing parenthesis with
 * no opening one, and an opening one never closed, is an item no group can be read from.
 */
function topLevelItems(query: string): Item[] {
  const items: Item[] = [];
  /** The clause being read: its members so far, or `undefined` once it is no plain OR group. */
  let clause:
    | { depth: number; members: ElementToken[] | undefined; expectElement: boolean }
    | undefined;

  for (const token of scanQuery(query)) {
    if (!clause) {
      if (token.type === 'element') items.push({ token });
      else if (token.type === ')') items.push({ members: undefined });
      else clause = { depth: 1, members: [], expectElement: true };
    } else if (token.type === '(') {
      clause.depth += 1;
      clause.members = undefined;
    } else if (token.type === ')') {
      clause.depth -= 1;
      if (clause.depth === 0) {
        items.push({ members: clause.expectElement ? undefined : clause.members });
        clause = undefined;
      }
    } else if (clause.members) {
      if (clause.expectElement ? !isOperand(token) : !isOrWord(token)) clause.members = undefined;
      else if (clause.expectElement) clause.members.push(token);
      clause.expectElement = !clause.expectElement;
    }
  }
  if (clause) items.push({ members: undefined });
  return items;
}
