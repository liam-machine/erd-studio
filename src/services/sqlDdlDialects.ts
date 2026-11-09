/**
 * The pre-steps for the dialects Import SQL DDL… reads with another
 * dialect's grammar: Oracle, Google BigQuery, Amazon Redshift and SQLite.
 *
 * `@dbml/core` 11.0.0 has no grammar for BigQuery, Redshift or SQLite, and
 * its Oracle grammar is not bundled (`esbuild.js` stubs it): it would add
 * about 5.7 MB to the minified `dist/sqlImport.js` (10.1 MB → 15.8 MB), and
 * these pre-steps read every Oracle schema in the import corpus as written.
 * Each of the four is read with the PostgreSQL grammar, the nearest to all
 * of them, once one CREATE TABLE has been rewritten by its own dialect's
 * rules ({@link rewriteDialectTable}):
 *
 *  - the head's modifiers go (`OR REPLACE`, `GLOBAL TEMPORARY`, `IF NOT
 *    EXISTS`), and so does everything after the column list (Oracle's
 *    `TABLESPACE`, `STORAGE`, `PARTITION BY …`, `ORGANIZATION INDEX`;
 *    BigQuery's `PARTITION BY`, `CLUSTER BY`, `OPTIONS(…)`; Redshift's
 *    `DISTSTYLE`, `DISTKEY`, `SORTKEY`, `BACKUP`; SQLite's `WITHOUT ROWID`,
 *    `STRICT`), which the converter counts as table options;
 *  - every name is double-quoted: SQLite's `[x]` and `` `x` ``, BigQuery's
 *    `` `project.dataset.table` `` (its last two parts, as a catalog is
 *    dropped elsewhere), and a name like a PostgreSQL keyword;
 *  - a type of the dialect's own that PostgreSQL's grammar has no rule for
 *    (`VARCHAR2(25 BYTE)`, `TIMESTAMP WITH LOCAL TIME ZONE`, `STRUCT<…>`,
 *    `VARCHAR(MAX)`, SQLite's `UNSIGNED BIG INT`) is read behind a
 *    placeholder, and a SQLite column with no type gets one; the model keeps
 *    the type exactly as the file wrote it (`sqlDdlColumns.ts` reads it from
 *    the file);
 *  - column attributes the grammar does not know are set aside: Redshift's
 *    `ENCODE x`, `DISTKEY`, `SORTKEY` and `IDENTITY(seed, step)`, BigQuery's
 *    `OPTIONS(description = …)` (the description is still read) and `NOT
 *    ENFORCED`, Oracle's `ENABLE`, `NOVALIDATE`, `USING INDEX …`, `DEFAULT ON
 *    NULL` and `GENERATED … AS IDENTITY (…)`, SQLite's `AUTOINCREMENT`, `ON
 *    CONFLICT x`, `COLLATE x` and key directions. An identity column stays one.
 *
 * Besides quoting the names, only what the dialect itself writes is
 * rewritten (a Redshift `ENCODE` in a SQLite script is left for the repair
 * ladder to report). Quoting every name reads a name like a PostgreSQL
 * keyword that PostgreSQL's own reading has to repair, so the dialect ranking
 * (`rankSqlDialectReadings`) puts a dialect with a grammar of its own, or the
 * detected one, before these four: a PostgreSQL script stays PostgreSQL.
 * Whatever the pre-step leaves that still does not read goes down the repair
 * ladder from the rewritten statement, as any other dialect's would. Every
 * edit keeps the statement's line breaks (`applyEdits`), so a line number
 * still points into the user's file.
 *
 * Pure: no `vscode`, no `@dbml/core`. Bundled into `dist/cli.js` and
 * `dist/sqlImport.js`.
 */

import { applyEdits, isName, isPunct, matchParen, splitTopLevel, upper, type Statement } from './sqlDdlLexer';
import type { PreparedSql, SqlDialect } from './sqlDdlModel';
import { cleanTypeText, columnTypeSpan, isConstraintItem, placeholderType } from './sqlDdlRepair';

/** The dialects read with the PostgreSQL grammar after their own pre-steps. */
export type PreSteppedDialect = 'oracle' | 'bigquery' | 'redshift' | 'sqlite';

export const PRE_STEPPED_DIALECTS: ReadonlySet<SqlDialect> = new Set<SqlDialect>(['oracle', 'bigquery', 'redshift', 'sqlite']);

export function isPreStepped(dialect: SqlDialect): dialect is PreSteppedDialect {
  return PRE_STEPPED_DIALECTS.has(dialect);
}

/** Dialects whose types nest with `<…>` (`ARRAY<STRUCT<a INT64, b STRING>>`): a comma inside them splits nothing. */
export const ANGLE_TYPE_DIALECTS: ReadonlySet<SqlDialect> = new Set<SqlDialect>(['databricks', 'bigquery']);

/** A pre-step's placeholders are numbered from here, apart from the repair ladder's (which count from 0). */
const PRE_STEP_PLACEHOLDERS = 100_000;

/** One CREATE TABLE as the PostgreSQL grammar is given it, and what was set aside. */
export interface DialectTable extends PreparedSql {
  /** Columns written without a type (SQLite), lower-cased: read with a placeholder, typed `unknown`. */
  typeless: Set<string>;
}

/** Words that end an Oracle `USING INDEX …` clause (what follows is the constraint's own). */
const USING_INDEX_END = new Set([
  'ENABLE', 'DISABLE', 'VALIDATE', 'NOVALIDATE', 'RELY', 'NORELY', 'DEFERRABLE', 'INITIALLY', 'NOT', 'CONSTRAINT', 'PRIMARY',
  'UNIQUE', 'REFERENCES', 'CHECK', 'NULL', 'DEFAULT', 'EXCEPTIONS',
]);

/** Oracle's constraint states, set aside wherever they stand (one word each). */
const ORACLE_STATE_WORDS = new Set(['ENABLE', 'DISABLE', 'VALIDATE', 'NOVALIDATE', 'RELY', 'NORELY']);

/** Oracle column attributes with no value (`INVISIBLE`, `SORT`). */
const ORACLE_COLUMN_WORDS = new Set(['VISIBLE', 'INVISIBLE', 'SORT']);

/** Multi-word types the PostgreSQL grammar reads (anything else of more than one word is read behind a placeholder, SQLite). */
const POSTGRES_MULTIWORD = /^(?:DOUBLE PRECISION|CHARACTER VARYING(?:\(\d+\))?|NATIONAL CHARACTER(?: VARYING)?(?:\(\d+\))?|BIT VARYING(?:\(\d+\))?|(?:TIMESTAMP|TIME)(?:\(\d+\))? WITH(?:OUT)? TIME ZONE)$/;

/** Whether a type, as written, is one of the dialect's own that the PostgreSQL grammar has no rule for. */
export function needsPlaceholder(dialect: PreSteppedDialect, raw: string): boolean {
  const s = cleanTypeText(raw).toUpperCase();
  if (!s) return false;
  switch (dialect) {
    case 'oracle':
      // A quoted part (`"SYS"."XMLTYPE"`), `VARCHAR2(25 BYTE)`, `NUMBER(*,0)`, `WITH LOCAL TIME ZONE`, `INTERVAL DAY(2) TO SECOND`…
      return /"/.test(raw) || /\(\s*(?:\d+|\*)\s*(?:,\s*-?\d+\s*)?\s*(?:BYTE|CHAR)\s*\)|\(\s*\*|\bLOCAL TIME ZONE\b|\bINTERVAL\b|\bLONG RAW\b|%(?:ROW)?TYPE\b|,\s*-\d/.test(s)
        || /^(?:XMLTYPE|SDO_\w+|URITYPE|ANYDATA|SYS\.\w+|MDSYS\.\w+)/.test(s);
    case 'bigquery':
      return /[<>`]/.test(raw) || /\bINTERVAL\b/.test(s) || /^(?:STRUCT|ARRAY|RANGE)\b/.test(s);
    case 'redshift':
      return /\(\s*MAX\s*\)/.test(s) || /\bVARBYTE\b|\bHLLSKETCH\b/.test(s);
    case 'sqlite':
      return /[[\]`"]/.test(raw) || (s.includes(' ') && !POSTGRES_MULTIWORD.test(s));
  }
}

/** A name for the PostgreSQL grammar: double-quoted, so a name like a keyword (`timestamp`, `order`) still reads as a name. */
function quoted(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * One CREATE TABLE of a {@link PreSteppedDialect}, rewritten for the
 * PostgreSQL grammar (see the module comment): `name` is the table name's
 * tokens, `open` / `close` its column list's parentheses.
 */
export function rewriteDialectTable(
  dialect: PreSteppedDialect, text: string, st: Statement,
  name: { parts: string[]; first: number; next: number }, open: number, close: number,
): DialectTable {
  const t = st.tokens;
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const replace = (from: number, to: number, value: string): void => { edits.push({ start: t[from].start, end: t[to].end, text: value }); };
  const blank = (from: number, to: number): void => replace(from, to, '');
  const types = new Map<string, string>();
  const identity = new Set<string>();
  const typeless = new Set<string>();
  let placeholders = PRE_STEP_PLACEHOLDERS;
  const oracle = dialect === 'oracle';
  const bigquery = dialect === 'bigquery';
  const redshift = dialect === 'redshift';
  const sqlite = dialect === 'sqlite';
  const placeholder = (asWritten: string): string => {
    const p = placeholderType(placeholders++);
    for (const key of p.keys) types.set(key, asWritten);
    return p.sql;
  };

  // A dotted name `t[from, next)`: its last two parts, quoted (a BigQuery project, a catalog, dropped).
  const replaceName = (from: number, next: number): void => {
    const parts: string[] = [];
    for (let k = from; k < next; k++) if (isName(t[k])) parts.push(t[k].value);
    if (parts.length) replace(from, next - 1, parts.slice(-2).map(quoted).join('.'));
  };
  const nameEnd = (from: number): number => {
    let k = from;
    if (!isName(t[k])) return k;
    k++;
    while (isPunct(t[k], '.') && isName(t[k + 1])) k += 2;
    return k;
  };
  // A key's or a reference's column list `(a, b DESC, c COLLATE x)`: the names quoted, directions and collations set aside.
  const columnList = (openAt: number): number => {
    const end = matchParen(t, openAt);
    if (end < 0) return openAt;
    for (const [cf, ct] of splitTopLevel(t, openAt + 1, end)) {
      if (cf >= ct || !isName(t[cf])) continue;
      replace(cf, cf, quoted(t[cf].value));
      for (let k = cf + 1; k < ct; k++) {
        const w = upper(t[k]);
        if (w === 'ASC' || w === 'DESC') blank(k, k);
        else if (w === 'COLLATE' && k + 1 < ct) { blank(k, k + 1); k++; }
      }
    }
    return end;
  };
  // `REFERENCES t [(cols)]` at `k`: the table's last two parts quoted, its columns too. The index after it.
  const references = (k: number, to: number): number => {
    const end = nameEnd(k + 1);
    if (end === k + 1) return k;
    replaceName(k + 1, end);
    if (isPunct(t[end], '(') && end < to) return columnList(end);
    return end - 1;
  };
  // Oracle's `USING INDEX [(CREATE INDEX …) | name | TABLESPACE x STORAGE (…) …]` at `k`: set aside, to the next constraint word.
  const usingIndex = (k: number, to: number): number => {
    let e = k + 2;
    while (e < to && !(t[e].kind === 'word' && USING_INDEX_END.has(upper(t[e])))) {
      if (isPunct(t[e], '(')) { const m = matchParen(t, e); if (m < 0 || m >= to) { e = to; break; } e = m; }
      e++;
    }
    blank(k, e - 1);
    return e - 1;
  };
  /**
   * What follows a column's type or a table constraint's keyword, `t[from, to)`:
   * the dialect's attributes set aside, references and key lists quoted.
   * `column`: the column's lower-cased name (for identity), when it is one.
   */
  const attributes = (from: number, to: number, column?: string): void => {
    for (let k = from; k < to; k++) {
      const tok = t[k];
      const w = upper(tok);
      if (isPunct(tok, '(')) {
        // A key's column list (`PRIMARY KEY (a)`, `UNIQUE (a)`, `FOREIGN KEY (a)`); any other group (CHECK, DEFAULT) as written.
        const before = upper(t[k - 1]);
        if (before === 'KEY' || before === 'UNIQUE') { k = columnList(k); continue; }
        const end = matchParen(t, k);
        if (end < 0 || end >= to) return;
        k = end;
        continue;
      }
      if (!w) continue;
      if (w === 'REFERENCES') { k = references(k, to); continue; }
      if (w === 'CONSTRAINT' && isName(t[k + 1])) { replace(k + 1, k + 1, quoted(t[k + 1].value)); k++; continue; }
      // Each dialect's own words only: a PostgreSQL script read as one of these reads as it does as PostgreSQL.
      if (oracle && ORACLE_STATE_WORDS.has(w)) { blank(k, k); continue; }
      if (oracle && w === 'USING' && upper(t[k + 1]) === 'INDEX') { k = usingIndex(k, to); continue; }
      if (bigquery && w === 'NOT' && upper(t[k + 1]) === 'ENFORCED') { blank(k, k + 1); k++; continue; }
      if (sqlite && w === 'ON' && upper(t[k + 1]) === 'CONFLICT') { const e = Math.min(k + 2, to - 1); blank(k, e); k = e; continue; }
      if (w === 'COLLATE' && k + 1 < to) { blank(k, k + 1); k++; continue; }
      if (column === undefined) continue;
      // Column attributes.
      if (sqlite && (w === 'ASC' || w === 'DESC')) { blank(k, k); continue; }
      if (sqlite && w === 'AUTOINCREMENT') { blank(k, k); identity.add(column); continue; }
      if (redshift && w === 'ENCODE' && k + 1 < to) { blank(k, k + 1); k++; continue; }
      if (redshift && (w === 'DISTKEY' || w === 'SORTKEY')) { blank(k, k); continue; }
      if (redshift && w === 'IDENTITY') {
        let e = k;
        if (isPunct(t[k + 1], '(')) { const m = matchParen(t, k + 1); if (m > 0 && m < to) e = m; }
        blank(k, e);
        identity.add(column);
        k = e;
        continue;
      }
      if (bigquery && w === 'OPTIONS' && isPunct(t[k + 1], '(')) {
        const m = matchParen(t, k + 1);
        if (m < 0 || m >= to) { blank(k, to - 1); return; }
        blank(k, m);
        k = m;
        continue;
      }
      if (oracle && w === 'DEFAULT' && upper(t[k + 1]) === 'ON' && upper(t[k + 2]) === 'NULL') { blank(k + 1, k + 2); k += 2; continue; }
      if (oracle && ORACLE_COLUMN_WORDS.has(w)) { blank(k, k); continue; }
      if (!bigquery && (w === 'GENERATED' || (w === 'AS' && isPunct(t[k + 1], '(')))) {
        // GENERATED { ALWAYS | BY DEFAULT [ON NULL] } AS IDENTITY [(…)]: an identity column. GENERATED ALWAYS AS (expr)
        // [VIRTUAL | STORED] and SQLite's / Oracle's `AS (expr)`: a generated column (its expression is read from the file).
        let a = k;
        if (w === 'GENERATED') { a = k + 1; while (a < to && upper(t[a]) !== 'AS') a++; }
        if (a >= to) continue;
        let e = a;
        if (upper(t[a + 1]) === 'IDENTITY') {
          // Oracle's and Redshift's identity columns (`(START WITH 1 …)`, `(1, 1)`); SQLite has none.
          if (sqlite) continue;
          e = a + 1;
          if (isPunct(t[e + 1], '(')) { const m = matchParen(t, e + 1); if (m > 0 && m < to) e = m; }
          identity.add(column);
        } else if (isPunct(t[a + 1], '(')) {
          // Oracle's virtual columns and SQLite's generated ones; Redshift has neither.
          if (redshift) continue;
          const m = matchParen(t, a + 1);
          if (m < 0 || m >= to) continue;
          e = m;
          if (upper(t[e + 1]) === 'VIRTUAL' || upper(t[e + 1]) === 'STORED') e++;
        } else {
          continue;
        }
        blank(k, e);
        k = e;
      }
    }
  };

  // The head: CREATE [OR REPLACE] [GLOBAL TEMPORARY | TEMP | …] TABLE [IF NOT EXISTS] name → CREATE TABLE name.
  const tableWord = t.findIndex((tok) => upper(tok) === 'TABLE');
  if (tableWord > 1) blank(1, tableWord - 1);
  if (name.first > tableWord + 1) blank(tableWord + 1, name.first - 1);
  replaceName(name.first, name.next);

  for (const [from, to] of splitTopLevel(t, open + 1, close, ANGLE_TYPE_DIALECTS.has(dialect))) {
    if (from >= to) continue;
    if (isConstraintItem(t, from, to)) { attributes(from, to); continue; }
    if (!isName(t[from])) continue;
    const column = t[from].value;
    replace(from, from, quoted(column));
    const span = columnTypeSpan(t, from, to);
    if (span.end > span.start) {
      const raw = text.slice(t[span.start].start, t[span.end - 1].end);
      if (needsPlaceholder(dialect, raw)) replace(span.start, span.end - 1, placeholder(cleanTypeText(raw)));
    } else if (sqlite || (oracle && (upper(t[from + 1]) === 'AS' || upper(t[from + 1]) === 'GENERATED'))) {
      // No type: SQLite's loosely typed columns (the model types them unknown), or an Oracle virtual column
      // (`total AS (a + b)`: the model's computed column). Either way, one the grammar reads.
      if (!(upper(t[from + 1]) === 'AS' || upper(t[from + 1]) === 'GENERATED')) typeless.add(column.toLowerCase());
      edits.push({ start: t[from].end, end: t[from].end, text: ` ${placeholder('')}` });
    }
    attributes(span.end, to, column.toLowerCase());
  }

  // Strings as the PostgreSQL grammar reads them: BigQuery's "…" and backslash escapes become '…' (a line break a space).
  if (dialect === 'bigquery') {
    for (let k = open + 1; k < close; k++) {
      const tok = t[k];
      const isString = tok.kind === 'string' || (tok.kind === 'ident' && tok.quote === '"');
      if (isString) edits.push({ start: tok.start, end: tok.end, text: `'${tok.value.replace(/'/g, "''").replace(/\r?\n/g, ' ')}'` });
    }
  }
  // Any other quoted name (SQLite's `[x]` and `` `x` ``, BigQuery's `` `x` ``) double-quoted: inside a CHECK or DEFAULT, say.
  for (let k = name.first; k < close && (sqlite || bigquery); k++) {
    const tok = t[k];
    if (tok.kind === 'ident' && ((sqlite && tok.quote === '[') || tok.quote === '`')) edits.push({ start: tok.start, end: tok.end, text: quoted(tok.value) });
  }
  // Everything after the column list: table options (the converter counts them from the file's own tokens).
  if (close + 1 < t.length) blank(close + 1, t.length - 1);

  return { sql: applyEdits(text, st.start, st.end, edits), types, comments: new Map(), identity, typeless };
}
