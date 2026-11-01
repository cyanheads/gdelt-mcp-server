/**
 * @fileoverview DOC mode emulation over the GKG mirror store: artlist, timelines, tone
 * histogram, and language/country breakdowns computed from `gkg_articles`, plus the coverage
 * read from the `gkg_slots` ledger. Runs inside the mirror worker on its open handle.
 *
 * Every row's `date` is its 15-minute slot, so each mode counts per slot in SQL
 * (`GROUP BY date`) and folds slots into DOC's buckets here. Output matches what
 * `GdeltDocService` returns for the same mode, so a tool renders a mirror answer unchanged.
 * @module services/gkg-mirror/gkg-mirror-queries
 */

import type { SqliteHandle, SqlValue } from '@cyanheads/mcp-ts-core/mirror';
import { normalizeGdeltDate } from '../gdelt/date-resolution.js';
import type {
  ArticleSearchResult,
  BreakdownSeries,
  DocTimelineMode,
  TimelineDataPoint,
  ToneHistogramBin,
} from '../gdelt/gdelt-doc-service.js';
import type { Article } from '../gdelt/types.js';
import { docCountryName } from './countries.js';
import { type FtsPredicate, ftsMatchText, isFtsPredicate } from './doc-query-compiler.js';
import { GKG_SLOT_MS, gkgSlotFromMs } from './gkg-feed.js';
import { GKG_ARTICLES_FTS, GKG_ARTICLES_TABLE, reverseDomain } from './gkg-mirror-schema.js';
import { docLanguageName } from './languages.js';
import type {
  MirrorCoverage,
  MirrorCoverageStatus,
  MirrorPredicate,
  MirrorQueryPlan,
  MirrorRequest,
  MirrorResponse,
  MirrorResult,
  MirrorWindow,
} from './types.js';

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/** Reference articles DOC lists per timeline bucket and per tone bin. */
const REFERENCES_PER_GROUP = 10;

/** Slots ingested in both feeds — the slots the mirror answers for. */
const BOTH_FEED_SLOTS = `SELECT slot FROM gkg_slots WHERE status = 'ingested' GROUP BY slot HAVING count(*) = 2`;

type Sql = { sql: string; params: SqlValue[] };

// ─── Time ─────────────────────────────────────────────────────────────────────

/** 14-digit UTC (`YYYYMMDDHHMMSS`) → epoch ms. */
function toMs(stamp: string): number {
  return Date.UTC(
    Number(stamp.slice(0, 4)),
    Number(stamp.slice(4, 6)) - 1,
    Number(stamp.slice(6, 8)),
    Number(stamp.slice(8, 10)),
    Number(stamp.slice(10, 12)),
    Number(stamp.slice(12, 14)),
  );
}

/** 14-digit UTC → DOC's compact `YYYYMMDDTHHMMSSZ`. */
function toDocStamp(stamp: string): string {
  return `${stamp.slice(0, 8)}T${stamp.slice(8, 14)}Z`;
}

/** 14-digit UTC → ISO 8601, as `normalizeGdeltDate` renders DOC's `20261101T110000Z`. */
function toIso(stamp: string): string {
  return normalizeGdeltDate(toDocStamp(stamp));
}

/**
 * DOC's timeline step for the requested window: under 72 hours → 15 minutes, 72 hours to one
 * week → hour, longer → day. UTC buckets, labelled by their start.
 */
function bucketWidth(window: MirrorWindow): number {
  const length = toMs(window.endDatetime) - toMs(window.startDatetime);
  if (length < 72 * HOUR_MS) return GKG_SLOT_MS;
  return length <= 7 * DAY_MS ? HOUR_MS : DAY_MS;
}

/** First and last slot instants (epoch ms) between two 14-digit boundaries, both included. */
function slotSpan(start: string, end: string): { first: number; last: number } {
  return {
    first: Math.ceil(toMs(start) / GKG_SLOT_MS) * GKG_SLOT_MS,
    last: Math.floor(toMs(end) / GKG_SLOT_MS) * GKG_SLOT_MS,
  };
}

/** Folds slots into buckets of one width, caching each slot's bucket. */
function bucketer(width: number) {
  const cache = new Map<string, string>();
  return {
    of(stamp: string): string {
      let bucket = cache.get(stamp);
      if (bucket === undefined) {
        bucket = gkgSlotFromMs(Math.floor(toMs(stamp) / width) * width);
        cache.set(stamp, bucket);
      }
      return bucket;
    },
    /** Every bucket holding a slot instant between `start` and `end`, both included. */
    grid(start: string, end: string): string[] {
      const { first, last } = slotSpan(start, end);
      const buckets: string[] = [];
      for (
        let ms = Math.floor(first / width) * width;
        ms <= Math.floor(last / width) * width;
        ms += width
      ) {
        buckets.push(gkgSlotFromMs(ms));
      }
      return buckets;
    },
    /** SQL for a row's bucket as a prefix of its slot (`YYYYMMDDHH` for an hour); pad it to 14 digits for the bucket. */
    sql:
      width === GKG_SLOT_MS
        ? 'a.date'
        : width === HOUR_MS
          ? 'substr(a.date, 1, 10)'
          : 'substr(a.date, 1, 8)',
  };
}

/** The one row an aggregate query without GROUP BY returns. */
function aggregate<T>(db: SqliteHandle, sql: string, params: SqlValue[] = []): T {
  const row = db.prepare<T>(sql).get(...params);
  if (row === undefined) throw new Error(`Aggregate query returned no row: ${sql}`);
  return row;
}

// ─── Coverage ─────────────────────────────────────────────────────────────────

function bothFeedBounds(db: SqliteHandle): { oldest: string | null; newest: string | null } {
  return aggregate(db, `SELECT min(slot) AS oldest, max(slot) AS newest FROM (${BOTH_FEED_SLOTS})`);
}

/** 15-minute slot instants between two 14-digit boundaries, both included. */
function slotInstants(start: string, end: string): number {
  const { first, last } = slotSpan(start, end);
  return last >= first ? (last - first) / GKG_SLOT_MS + 1 : 0;
}

type Answered = { start: string; end: string; coverage: MirrorCoverage };

/**
 * Clip the requested window to the slots ingested in both feeds. Both boundaries stay inclusive,
 * as the DOC tools' window rule has them.
 */
function resolveCoverage(
  db: SqliteHandle,
  window: MirrorWindow,
): Answered | Extract<MirrorResponse, { outcome: 'outside_coverage' }> {
  const { oldest, newest } = bothFeedBounds(db);
  const inWindow = aggregate<{ n: number }>(
    db,
    `SELECT count(*) AS n FROM (SELECT slot FROM gkg_slots WHERE slot BETWEEN ? AND ? AND status = 'ingested' GROUP BY slot HAVING count(*) = 2)`,
    [window.startDatetime, window.endDatetime],
  ).n;

  if (oldest === null || newest === null || inWindow === 0) {
    return {
      outcome: 'outside_coverage',
      detail:
        oldest === null || newest === null
          ? 'The GKG mirror holds no slot ingested in both feeds.'
          : `The requested window shares no slot with the GKG mirror, which covers ${toIso(oldest)} to ${toIso(newest)}.`,
      ...(oldest !== null && { oldestSlot: oldest }),
      ...(newest !== null && { newestSlot: newest }),
    };
  }

  const start = gkgSlotFromMs(Math.max(toMs(window.startDatetime), toMs(oldest)));
  const end = gkgSlotFromMs(Math.min(toMs(window.endDatetime), toMs(newest)));
  return {
    start,
    end,
    coverage: {
      requestedStart: toIso(window.startDatetime),
      requestedEnd: toIso(window.endDatetime),
      answeredStart: toIso(start),
      answeredEnd: toIso(end),
      missingSlots: slotInstants(start, end) - inWindow,
    },
  };
}

// ─── Plan → SQL ───────────────────────────────────────────────────────────────

/** Upper bound of a prefix range: the prefix with its last character incremented (ASCII domains). */
function prefixUpperBound(prefix: string): string {
  return prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
}

/** SQL for a column predicate. Null-safe: a missing tone or country is a non-match, never NULL. */
function columnPredicateSql(predicate: Exclude<MirrorPredicate, FtsPredicate>): Sql {
  switch (predicate.kind) {
    case 'domain': {
      const reversed = reverseDomain(predicate.domain);
      return {
        sql: '(a.domain_rev >= ? AND a.domain_rev < ?)',
        params: [reversed, prefixUpperBound(reversed)],
      };
    }
    case 'domainis':
      return { sql: 'a.domain = ?', params: [predicate.domain] };
    case 'sourcelang':
      return { sql: 'a.language = ?', params: [predicate.language] };
    case 'sourcecountry':
      return { sql: 'a.source_country IS ?', params: [predicate.fips] };
    case 'tone': {
      const column = predicate.absolute ? 'abs(a.tone)' : 'a.tone';
      return {
        sql: `(a.tone IS NOT NULL AND ${column} ${predicate.comparison} ?)`,
        params: [predicate.value],
      };
    }
    default: {
      const unreachable: never = predicate;
      throw new Error(`Unhandled predicate ${JSON.stringify(unreachable)}`);
    }
  }
}

/** Inclusive rowid bounds; `lo > hi` when the window holds no row. */
type RowidRange = { lo: number; hi: number };

/**
 * Rowid bounds of the rows the answered window holds. A loose scan of the `(date)` index visits
 * each distinct date once — the next date, then its first and last rowid — so its cost follows
 * the number of slots, not of rows. Rows enter slot by slot, so the range sits close to the
 * window's own rows; a URL re-listed in a newer slot keeps its first rowid and widens it. It
 * bounds FTS subqueries and never filters on its own: every query still checks `date`.
 */
function windowRowids(db: SqliteHandle, start: string, end: string): RowidRange {
  const { lo, hi } = aggregate<{ lo: number | null; hi: number | null }>(
    db,
    `WITH RECURSIVE d(date) AS (
  SELECT min(date) FROM ${GKG_ARTICLES_TABLE} WHERE date >= ?
  UNION ALL
  SELECT (SELECT min(date) FROM ${GKG_ARTICLES_TABLE} WHERE date > d.date) FROM d WHERE d.date <= ?
)
SELECT min((SELECT min(rowid) FROM ${GKG_ARTICLES_TABLE} WHERE date = d.date)) AS lo,
  max((SELECT max(rowid) FROM ${GKG_ARTICLES_TABLE} WHERE date = d.date)) AS hi
FROM d WHERE d.date <= ?`,
    [start, end, end],
  );
  return lo === null || hi === null ? { lo: 1, hi: 0 } : { lo, hi };
}

/** FTS5 rowids matching `match` inside the window's rowid range. */
function ftsSubquery(match: string, rowids: RowidRange): Sql {
  return {
    sql: `SELECT rowid FROM ${GKG_ARTICLES_FTS} WHERE ${GKG_ARTICLES_FTS} MATCH ? AND rowid BETWEEN ? AND ?`,
    params: [match, rowids.lo, rowids.hi],
  };
}

/**
 * The plan as SQL conditions over `a` (`gkg_articles`), ANDed. Clauses made only of keyword and
 * theme predicates merge into one FTS5 query (positives ANDed, negations under `NOT`); any other
 * clause becomes column conditions, with an FTS subquery for its keyword or theme members.
 *
 * FTS membership is written `+a.rowid IN (…)`. The unary `+` keeps SQLite from driving the scan
 * by the FTS rowids, which looks up the table row of every match — most of a 2 GB table on a
 * broad match. Each query instead scans a `date`-leading index over the window, tests each entry
 * against the FTS rowids (materialized once per statement), and reads the table only for the
 * columns no index covers, after the membership test has passed.
 */
function planSql(plan: MirrorQueryPlan, rowids: RowidRange): Sql[] {
  const fragments: Sql[] = [];
  const positive: string[] = [];
  const excluded: string[] = [];

  for (const clause of plan.clauses) {
    const fts = clause.anyOf.filter(isFtsPredicate);
    if (fts.length === clause.anyOf.length) {
      (clause.negated ? excluded : positive).push(`(${fts.map(ftsMatchText).join(' OR ')})`);
      continue;
    }
    const parts: Sql[] = [];
    if (fts.length > 0) {
      const sub = ftsSubquery(fts.map(ftsMatchText).join(' OR '), rowids);
      parts.push({ sql: `+a.rowid IN (${sub.sql})`, params: sub.params });
    }
    for (const predicate of clause.anyOf) {
      if (!isFtsPredicate(predicate)) parts.push(columnPredicateSql(predicate));
    }
    const sql = `(${parts.map((p) => p.sql).join(' OR ')})`;
    fragments.push({
      sql: clause.negated ? `NOT ${sql}` : sql,
      params: parts.flatMap((p) => p.params),
    });
  }

  if (positive.length > 0) {
    const core = positive.join(' AND ');
    const sub = ftsSubquery(
      excluded.length > 0 ? `(${core}) NOT (${excluded.join(' OR ')})` : core,
      rowids,
    );
    fragments.unshift({ sql: `+a.rowid IN (${sub.sql})`, params: sub.params });
  } else if (excluded.length > 0) {
    const sub = ftsSubquery(excluded.join(' OR '), rowids);
    fragments.unshift({ sql: `+a.rowid NOT IN (${sub.sql})`, params: sub.params });
  }
  return fragments;
}

/** Rows of the answered window that match the plan. */
function matchSql(plan: MirrorQueryPlan, start: string, end: string, rowids: RowidRange): Sql {
  const fragments = [
    { sql: 'a.date BETWEEN ? AND ?', params: [start, end] },
    ...planSql(plan, rowids),
  ];
  return {
    sql: fragments.map((f) => f.sql).join(' AND '),
    params: fragments.flatMap((f) => f.params),
  };
}

/**
 * FTS5 query scoring relevance: the plan's non-excluded keywords and phrases, ORed. Undefined for
 * a plan without one, which then orders newest-first.
 */
function relevanceMatch(plan: MirrorQueryPlan): string | undefined {
  const keywords = plan.clauses
    .filter((clause) => !clause.negated)
    .flatMap((clause) => clause.anyOf.filter((p) => p.kind === 'keyword'))
    .map((p) => `(${ftsMatchText(p)})`);
  return keywords.length > 0 ? keywords.join(' OR ') : undefined;
}

type Relevance = { with: string; join: string; params: SqlValue[] };

/**
 * Relevance scores as a materialized CTE `r` — bm25 (lower ranks higher) of every row in the
 * window's rowid range that `match` matches — and the LEFT JOIN exposing `r.score` on `a`. The
 * MATCH runs once per statement; joining the FTS table directly would rerun it for every row.
 * Empty without a relevance query.
 */
function relevanceSql(match: string | undefined, rowids: RowidRange): Relevance {
  if (match === undefined) return { with: '', join: '', params: [] };
  return {
    with: `WITH r AS MATERIALIZED (SELECT rowid AS rid, bm25(${GKG_ARTICLES_FTS}) AS score FROM ${GKG_ARTICLES_FTS} WHERE ${GKG_ARTICLES_FTS} MATCH ? AND rowid BETWEEN ? AND ?) `,
    join: 'LEFT JOIN r ON r.rid = a.rowid',
    params: [match, rowids.lo, rowids.hi],
  };
}

// ─── Shared reads ─────────────────────────────────────────────────────────────

type SlotCount = { slot: string; n: number };

function countsBySlot(db: SqliteHandle, where: Sql): SlotCount[] {
  return db
    .prepare<SlotCount>(
      `SELECT a.date AS slot, count(*) AS n FROM ${GKG_ARTICLES_TABLE} a WHERE ${where.sql} GROUP BY a.date`,
    )
    .all(...where.params);
}

/** Every mirrored row per slot, both feeds — DOC's `norm`. */
function normBySlot(db: SqliteHandle, start: string, end: string): SlotCount[] {
  return db
    .prepare<SlotCount>(
      `SELECT date AS slot, count(*) AS n FROM ${GKG_ARTICLES_TABLE} WHERE date BETWEEN ? AND ? GROUP BY date`,
    )
    .all(start, end);
}

function sumByBucket(
  rows: readonly SlotCount[],
  bucketOf: (slot: string) => string,
): Map<string, number> {
  const sums = new Map<string, number>();
  for (const row of rows) {
    const bucket = bucketOf(row.slot);
    sums.set(bucket, (sums.get(bucket) ?? 0) + row.n);
  }
  return sums;
}

/**
 * Up to {@link REFERENCES_PER_GROUP} reference articles per group (a bucket or tone bin): by
 * relevance when the plan has keywords, otherwise newest first.
 */
function referencesByGroup<K extends string | number>(
  db: SqliteHandle,
  where: Sql,
  groupSql: string,
  relevance: Relevance,
): Map<K, Array<{ url: string; title: string }>> {
  const order =
    relevance.join === ''
      ? 'a.date DESC, a.rowid DESC'
      : 'r.score IS NULL, r.score, a.date DESC, a.rowid DESC';
  const rows = db
    .prepare<{ grp: K; url: string; title: string }>(
      `${relevance.with}SELECT w.grp AS grp, b.url AS url, b.title AS title FROM (
  SELECT a.rowid AS rid, ${groupSql} AS grp, ROW_NUMBER() OVER (PARTITION BY ${groupSql} ORDER BY ${order}) AS rn
  FROM ${GKG_ARTICLES_TABLE} a ${relevance.join} WHERE ${where.sql}
) w JOIN ${GKG_ARTICLES_TABLE} b ON b.rowid = w.rid WHERE w.rn <= ${REFERENCES_PER_GROUP} ORDER BY w.grp, w.rn`,
    )
    .all(...relevance.params, ...where.params);
  const groups = new Map<K, Array<{ url: string; title: string }>>();
  for (const row of rows) {
    const list = groups.get(row.grp) ?? [];
    list.push({ url: row.url, title: row.title });
    groups.set(row.grp, list);
  }
  return groups;
}

/** Trailing mean over `width` points; the leading `width − 1` points are omitted. Other fields ride along. */
function smooth<T extends { value: number }>(points: T[], width: number | undefined): T[] {
  if (width === undefined || width < 2) return points;
  return points.slice(width - 1).map((point, i) => {
    const sum = points.slice(i, i + width).reduce((total, p) => total + p.value, 0);
    return { ...point, value: sum / width };
  });
}

// ─── Modes ────────────────────────────────────────────────────────────────────

type ModeAnswer = { answer: MirrorResult; matched: number };
type Context = {
  db: SqliteHandle;
  plan: MirrorQueryPlan;
  answered: Answered;
  rowids: RowidRange;
  where: Sql;
  buckets: ReturnType<typeof bucketer>;
};

const TIMELINE_LABELS: Record<DocTimelineMode, string> = {
  timelinevol: 'Volume Intensity',
  timelinevolraw: 'Article Count',
  timelinevolinfo: 'Volume Intensity',
  timelinetone: 'Average Tone',
};

function toneTimeline(ctx: Context, smoothing: number | undefined): ModeAnswer {
  const rows = ctx.db
    .prepare<{ slot: string; n: number; toned: number; total: number | null }>(
      `SELECT a.date AS slot, count(*) AS n, count(a.tone) AS toned, sum(a.tone) AS total FROM ${GKG_ARTICLES_TABLE} a WHERE ${ctx.where.sql} GROUP BY a.date`,
    )
    .all(...ctx.where.params);
  const byBucket = new Map<string, { toned: number; total: number }>();
  let matched = 0;
  for (const row of rows) {
    matched += row.n;
    if (row.toned === 0) continue;
    const bucket = ctx.buckets.of(row.slot);
    const acc = byBucket.get(bucket) ?? { toned: 0, total: 0 };
    acc.toned += row.toned;
    acc.total += row.total ?? 0;
    byBucket.set(bucket, acc);
  }
  const points: TimelineDataPoint[] = [];
  for (const bucket of ctx.buckets.grid(ctx.answered.start, ctx.answered.end)) {
    const acc = byBucket.get(bucket);
    if (acc) points.push({ date: toIso(bucket), value: acc.total / acc.toned });
  }
  return {
    answer: {
      kind: 'timeline',
      result: [{ label: TIMELINE_LABELS.timelinetone, data: smooth(points, smoothing) }],
    },
    matched,
  };
}

function volumeTimeline(
  ctx: Context,
  mode: Exclude<DocTimelineMode, 'timelinetone'>,
  smoothing: number | undefined,
): ModeAnswer {
  const matchRows = countsBySlot(ctx.db, ctx.where);
  const matches = sumByBucket(matchRows, ctx.buckets.of);
  const norms = sumByBucket(
    normBySlot(ctx.db, ctx.answered.start, ctx.answered.end),
    ctx.buckets.of,
  );
  const references =
    mode === 'timelinevolinfo'
      ? new Map(
          [
            ...referencesByGroup<string>(
              ctx.db,
              ctx.where,
              ctx.buckets.sql,
              relevanceSql(relevanceMatch(ctx.plan), ctx.rowids),
            ),
          ].map(([key, articles]) => [key.padEnd(14, '0'), articles]),
        )
      : undefined;

  const points: TimelineDataPoint[] = ctx.buckets
    .grid(ctx.answered.start, ctx.answered.end)
    .map((bucket) => {
      const count = matches.get(bucket) ?? 0;
      const norm = norms.get(bucket) ?? 0;
      if (mode === 'timelinevolraw') return { date: toIso(bucket), value: count, norm };
      const articles = references?.get(bucket);
      return {
        date: toIso(bucket),
        value: norm > 0 ? (100 * count) / norm : 0,
        ...(articles && { articles }),
      };
    });
  return {
    answer: {
      kind: 'timeline',
      result: [{ label: TIMELINE_LABELS[mode], data: smooth(points, smoothing) }],
    },
    matched: matchRows.reduce((sum, row) => sum + row.n, 0),
  };
}

function toneChart(ctx: Context): ModeAnswer {
  const binSql = 'CAST(a.tone AS INTEGER)';
  const rows = ctx.db
    .prepare<{ bin: number | null; n: number }>(
      `SELECT ${binSql} AS bin, count(*) AS n FROM ${GKG_ARTICLES_TABLE} a WHERE ${ctx.where.sql} GROUP BY bin ORDER BY bin`,
    )
    .all(...ctx.where.params);
  const toned: Sql = { sql: `${ctx.where.sql} AND a.tone IS NOT NULL`, params: ctx.where.params };
  const references = referencesByGroup<number>(
    ctx.db,
    toned,
    binSql,
    relevanceSql(relevanceMatch(ctx.plan), ctx.rowids),
  );
  const bins: ToneHistogramBin[] = rows
    .filter((row): row is { bin: number; n: number } => row.bin !== null)
    .map((row) => ({ bin: row.bin, count: row.n, articles: references.get(row.bin) ?? [] }));
  return {
    answer: { kind: 'tonechart', result: bins },
    matched: rows.reduce((sum, row) => sum + row.n, 0),
  };
}

function breakdown(
  ctx: Context,
  mode: 'timelinelang' | 'timelinesourcecountry',
  smoothing: number | undefined,
): ModeAnswer {
  const column = mode === 'timelinelang' ? 'language' : 'source_country';
  /** Series label for a stored value; undefined leaves the row out (no named source country). */
  const nameOf = (value: string | null): string | undefined =>
    value === null
      ? undefined
      : mode === 'timelinelang'
        ? (docLanguageName(value) ?? value)
        : docCountryName(value);

  type GroupCount = { slot: string; grp: string | null; n: number };
  const matchRows = ctx.db
    .prepare<GroupCount>(
      `SELECT a.date AS slot, a.${column} AS grp, count(*) AS n FROM ${GKG_ARTICLES_TABLE} a WHERE ${ctx.where.sql} GROUP BY a.date, a.${column}`,
    )
    .all(...ctx.where.params);
  const allRows = ctx.db
    .prepare<GroupCount>(
      `SELECT date AS slot, ${column} AS grp, count(*) AS n FROM ${GKG_ARTICLES_TABLE} WHERE date BETWEEN ? AND ? GROUP BY date, ${column}`,
    )
    .all(ctx.answered.start, ctx.answered.end);

  /** label → bucket → count. Groups merge by label, as DOC's series are named. */
  const fold = (rows: readonly GroupCount[]) => {
    const byLabel = new Map<string, Map<string, number>>();
    let unnamed = 0;
    for (const row of rows) {
      const label = nameOf(row.grp);
      if (label === undefined) {
        unnamed += row.n;
        continue;
      }
      const bucket = ctx.buckets.of(row.slot);
      const counts = byLabel.get(label) ?? new Map<string, number>();
      counts.set(bucket, (counts.get(bucket) ?? 0) + row.n);
      byLabel.set(label, counts);
    }
    return { byLabel, unnamed };
  };
  const matched = fold(matchRows);
  const all = fold(allRows);
  const grid = ctx.buckets.grid(ctx.answered.start, ctx.answered.end);

  const series = [...matched.byLabel]
    .map(([label, counts]) => {
      const totals = all.byLabel.get(label);
      const points = grid.map((bucket) => {
        const count = counts.get(bucket) ?? 0;
        const denominator = totals?.get(bucket) ?? 0;
        return { date: toIso(bucket), value: denominator > 0 ? (100 * count) / denominator : 0 };
      });
      let total = 0;
      for (const n of counts.values()) total += n;
      return { label: `${label} Volume Intensity`, total, data: smooth(points, smoothing) };
    })
    .sort((a, b) => b.total - a.total || a.label.localeCompare(b.label))
    .map(({ label, data }): BreakdownSeries => ({ label, data }));

  return {
    answer: {
      kind: 'breakdown',
      result: series,
      ...(mode === 'timelinesourcecountry' && { excludedWithoutCountry: matched.unnamed }),
    },
    matched: matchRows.reduce((sum, row) => sum + row.n, 0),
  };
}

/** Artlist sort keys, before the final `url` tie-break. */
const ARTLIST_KEYS = {
  dateDesc: 'a.date DESC',
  dateAsc: 'a.date ASC',
  toneDesc: 'a.tone IS NULL, a.tone DESC, a.date DESC',
  toneAsc: 'a.tone IS NULL, a.tone ASC, a.date DESC',
} as const;

/**
 * The first `maxRecords` matches by the sort's keys, then `url`. Matches are ranked on their
 * keys alone, which a `date`-leading index (and `r`) supply, so the table is read only for the
 * rows that rank within `maxRecords`, ties at the boundary included; a single `ORDER BY … url`
 * would read the `url` of every match.
 */
function artlist(
  ctx: Context,
  maxRecords: number,
  sort: Extract<MirrorRequest, { kind: 'artlist' }>['sort'],
): ModeAnswer {
  const relevance = relevanceSql(
    sort === 'relevance' || sort === 'hybridRel' ? relevanceMatch(ctx.plan) : undefined,
    ctx.rowids,
  );
  const keys =
    sort === 'relevance' || sort === 'hybridRel'
      ? relevance.join === ''
        ? ARTLIST_KEYS.dateDesc
        : `r.score IS NULL, r.score, ${ARTLIST_KEYS.dateDesc}`
      : ARTLIST_KEYS[sort];

  const matched = aggregate<{ n: number }>(
    ctx.db,
    `SELECT count(*) AS n FROM ${GKG_ARTICLES_TABLE} a WHERE ${ctx.where.sql}`,
    ctx.where.params,
  ).n;
  const rows = ctx.db
    .prepare<{
      url: string;
      title: string;
      date: string;
      domain: string;
      language: string;
      source_country: string | null;
      image: string | null;
    }>(
      `${relevance.with}SELECT b.url, b.title, b.date, b.domain, b.language, b.source_country, b.image FROM (
  SELECT a.rowid AS rid, RANK() OVER (ORDER BY ${keys}) AS rk FROM ${GKG_ARTICLES_TABLE} a ${relevance.join} WHERE ${ctx.where.sql}
) c JOIN ${GKG_ARTICLES_TABLE} b ON b.rowid = c.rid WHERE c.rk <= ? ORDER BY c.rk, b.url LIMIT ?`,
    )
    .all(...relevance.params, ...ctx.where.params, maxRecords, maxRecords);

  const articles: Article[] = rows.map((row) => ({
    url: row.url,
    title: row.title,
    seendate: toDocStamp(row.date),
    domain: row.domain,
    language: docLanguageName(row.language) ?? row.language,
    sourcecountry: row.source_country === null ? '' : (docCountryName(row.source_country) ?? ''),
    ...(row.image && { socialimage: row.image }),
  }));
  const result: ArticleSearchResult = { articles, totalReturned: articles.length };
  return { answer: { kind: 'artlist', result }, matched };
}

// ─── Entry points ─────────────────────────────────────────────────────────────

/**
 * Answer one compiled DOC request from the store. Synchronous: the handle is. Produces
 * `answered` or `outside_coverage`; readiness and store errors are the worker's to report.
 */
export function executeMirrorRequest(db: SqliteHandle, req: MirrorRequest): MirrorResponse {
  const answered = resolveCoverage(db, req.window);
  if ('outcome' in answered) return answered;

  const rowids = windowRowids(db, answered.start, answered.end);
  const ctx: Context = {
    db,
    plan: req.plan,
    answered,
    rowids,
    where: matchSql(req.plan, answered.start, answered.end, rowids),
    buckets: bucketer(bucketWidth(req.window)),
  };

  let mode: ModeAnswer;
  switch (req.kind) {
    case 'artlist':
      mode = artlist(ctx, req.maxRecords, req.sort);
      break;
    case 'timeline':
      mode =
        req.mode === 'timelinetone'
          ? toneTimeline(ctx, req.smoothing)
          : volumeTimeline(ctx, req.mode, req.smoothing);
      break;
    case 'tonechart':
      mode = toneChart(ctx);
      break;
    case 'breakdown':
      mode = breakdown(ctx, req.mode, req.smoothing);
      break;
    default: {
      const unreachable: never = req;
      throw new Error(`Unhandled mirror request ${JSON.stringify(unreachable)}`);
    }
  }
  return {
    outcome: 'answered',
    answer: mode.answer,
    coverage: answered.coverage,
    matched: mode.matched,
  };
}

/** Read slot coverage from the ledger. `ready` is the caller's to fill from the mirror status. */
export function readMirrorCoverage(db: SqliteHandle): Omit<MirrorCoverageStatus, 'ready'> {
  const { oldest, newest } = bothFeedBounds(db);
  return {
    ...(oldest !== null && { oldestSlot: oldest }),
    ...(newest !== null && { newestSlot: newest }),
  };
}
