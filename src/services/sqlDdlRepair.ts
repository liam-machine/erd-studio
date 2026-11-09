/**
 * The repair ladder for a `CREATE TABLE` the grammar could not read as
 * written: degrade, don't drop. Each rung is a pure rewrite of the statement
 * (`applyEdits`: every line break kept, so a line number in a diagnostic
 * still points into the user's file), and the rungs are cumulative:
 *
 *  1. `options`: the head's modifiers (`OR REPLACE`, `TRANSIENT`, `IF NOT
 *     EXISTS`…) and every table option after the column list, of any kind and
 *     in any order (`CLUSTER BY`, `PARTITIONED BY`, `TBLPROPERTIES`,
 *     `LOCATION`, `WITH (…)`, `ON [PRIMARY]`, `ENGINE=`, `USING`,
 *     `TABLESPACE`, `INHERITS`…), set aside. The table's `COMMENT` is still
 *     kept (the converter reads it from the original tokens).
 *  2. `quote`: every name (the table, its columns, constraint column lists,
 *     referenced tables) quoted in the target grammar's style, so a name like
 *     a keyword (`FILE_FORMAT`, `ORDER`, `KEY`) reads as a name; a catalog
 *     qualifier is dropped.
 *  3. `types`: a type the grammars may not know (`XML(schema.coll)`,
 *     `VECTOR(FLOAT, 768)`, `geometry(Point,4326)`, `STRUCT<…>`, `int[][]`,
 *     a schema-qualified type) behind a placeholder every grammar reads, the
 *     original text restored after the parse (`PreparedSql.types`).
 *  4. `modifiers`: column modifiers and constraint extras the grammar has no
 *     rule for (`VIRTUAL`, `PERSISTED`, `MASK`, `ON UPDATE`, `INVISIBLE`,
 *     `SPARSE`, `ROWGUIDCOL`, `COLLATE`, `CHARACTER SET`, `SRID`,
 *     `AUTOINCREMENT START n INCREMENT m`, `NOT FOR REPLICATION`,
 *     `CONSTRAINT x DEFAULT`, `CLUSTERED`, `NOT ENFORCED`…) set aside, and
 *     index definitions inside the column list taken out for grammars that
 *     have none.
 *  5. `allTypes`: every type behind a placeholder.
 *
 * The converter (`sqlDdlImport.ts`) tries the rungs in order with the
 * dialect's own grammar, then the other grammars on the fully rewritten
 * statement, and records what the reading rewrite changed as `repaired`
 * ledger entries ({@link Repair}). It never runs for a statement that reads
 * as written.
 *
 * Pure: no `vscode`, no `@dbml/core`. Bundled into `dist/cli.js` and
 * `dist/sqlImport.js`.
 */

import type { LedgerCause } from './importLedger';
import { applyEdits, isName, isPunct, matchParen, splitTopLevel, upper, type Statement, type Token } from './sqlDdlLexer';
import type { PreparedSql, SqlDialect, SqlParseFormat } from './sqlDdlModel';

export type RepairRung = 'options' | 'quote' | 'types' | 'modifiers' | 'allTypes';

/** The rungs, cumulative, in the order they are tried. */
export const REPAIR_LADDER: ReadonlyArray<ReadonlySet<RepairRung>> = [
  new Set<RepairRung>(['options']),
  new Set<RepairRung>(['options', 'quote']),
  new Set<RepairRung>(['options', 'quote', 'types']),
  new Set<RepairRung>(['options', 'quote', 'types', 'modifiers']),
  new Set<RepairRung>(['options', 'quote', 'types', 'modifiers', 'allTypes']),
];

/** Every rung: what the other grammars are given. */
export const ALL_RUNGS: ReadonlySet<RepairRung> = REPAIR_LADDER[REPAIR_LADDER.length - 1];

/** One change a rewrite made, for the ledger (`repaired`). `what` is a fixed phrase, never file text beyond a type's or option's keyword. */
export interface Repair {
  rung: RepairRung;
  unit: 'table' | 'column';
  cause: LedgerCause;
  what: string;
  detail: string;
  line: number;
  column?: string;
}

export interface RewriteInput {
  /** The file's text (the statement's tokens point into it). */
  text: string;
  st: Statement;
  /** The table name's tokens `[first, next)`. */
  name: { parts: string[]; first: number; next: number };
  /** The column list's `(` and `)`. */
  open: number;
  close: number;
  dialect: SqlDialect;
  target: SqlParseFormat;
  rungs: ReadonlySet<RepairRung>;
}

export interface Rewrite {
  prepared: PreparedSql;
  repairs: Repair[];
  /** Index definitions taken out of the column list (counted as skipped indexes). */
  droppedIndexes: number;
}

/** The first placeholder type's length (`varchar(987650)`): no real column is that long, and every grammar reads a varchar. */
const PLACEHOLDER_BASE = 987650;

/** A placeholder type, and the keys `PreparedSql.types` needs for every way a grammar may hand it back. */
export function placeholderType(n: number): { sql: string; keys: string[] } {
  const sql = `varchar(${PLACEHOLDER_BASE + n})`;
  return { sql, keys: [sql, sql.toUpperCase(), `VARCHAR(${PLACEHOLDER_BASE + n})`, `character varying(${PLACEHOLDER_BASE + n})`] };
}

// ---------------------------------------------------------------------------
// Reading a column definition
// ---------------------------------------------------------------------------

/** Words that start a table constraint (or an index) inside a column list. */
const CONSTRAINT_HEADS = new Set(['CONSTRAINT', 'PRIMARY', 'FOREIGN', 'UNIQUE', 'CHECK', 'INDEX', 'KEY', 'FULLTEXT', 'SPATIAL', 'PERIOD', 'EXCLUDE', 'LIKE']);

/** Words that end a column's type and start its constraints or modifiers. */
const TYPE_STOP = new Set([
  'NOT', 'NULL', 'DEFAULT', 'GENERATED', 'COMMENT', 'PRIMARY', 'CONSTRAINT', 'REFERENCES', 'UNIQUE', 'CHECK',
  'MASK', 'MASKED', 'ENCRYPTED', 'COLLATE', 'IDENTITY', 'AUTO_INCREMENT', 'AUTOINCREMENT', 'AS', 'INVISIBLE', 'VISIBLE',
  'SPARSE', 'ROWGUIDCOL', 'FILESTREAM', 'PERSISTED', 'STORED', 'VIRTUAL', 'SRID', 'ENCODE', 'CHARSET', 'KEY', 'TAG',
  'ENFORCED', 'RELY', 'NORELY', 'CLUSTERED', 'NONCLUSTERED', 'COMPRESSION', 'STORAGE',
  // SQL Server's inline `int FOREIGN KEY REFERENCES t(id)`; Snowflake's policies without WITH; MySQL's column attributes.
  'FOREIGN', 'MASKING', 'PROJECTION', 'COLUMN_FORMAT', 'ENGINE_ATTRIBUTE', 'SECONDARY_ENGINE_ATTRIBUTE',
  // BigQuery's column OPTIONS(…); Redshift's column DISTKEY / SORTKEY; Oracle's ENCRYPT.
  'OPTIONS', 'DISTKEY', 'SORTKEY', 'ENCRYPT',
]);

/** Whether the token at `k` ends a column's type (`ON UPDATE`, `CHARACTER SET`, `WITH (…)` and the {@link TYPE_STOP} words). */
export function endsType(t: readonly Token[], k: number): boolean {
  const w = upper(t[k]);
  if (TYPE_STOP.has(w)) return true;
  // MySQL's `ON UPDATE CURRENT_TIMESTAMP`; SQLite's `ON CONFLICT REPLACE`.
  if (w === 'ON') return upper(t[k + 1]) === 'UPDATE' || upper(t[k + 1]) === 'CONFLICT';
  if (w === 'CHARACTER') return upper(t[k + 1]) === 'SET';
  if (w === 'WITH') return !(upper(t[k + 1]) === 'TIME' || upper(t[k + 1]) === 'LOCAL');
  return false;
}

/** Whether the item `[from, to)` of a column list is a table constraint or index, not a column. */
/** What follows a SQL Server inline index's name (`INDEX ix NONCLUSTERED (…)`). */
const SQLSERVER_INDEX_WORDS = new Set(['CLUSTERED', 'NONCLUSTERED', 'COLUMNSTORE', 'HASH', 'UNIQUE']);

export function isConstraintItem(t: readonly Token[], from: number, to: number): boolean {
  const head = upper(t[from]);
  if (!CONSTRAINT_HEADS.has(head) || t[from].kind !== 'word') return false;
  // `key varchar(10)`, `index int`: a column named like the word.
  // `KEY idx (a, b)` is an index; `key varchar(20)` (a number in the parentheses) a column.
  if (head === 'KEY' || head === 'INDEX') {
    // SQL Server's inline `INDEX ix [UNIQUE] CLUSTERED COLUMNSTORE | NONCLUSTERED (…) | HASH (…)`: no type is spelled so.
    if (head === 'INDEX' && isName(t[from + 1]) && SQLSERVER_INDEX_WORDS.has(upper(t[from + 2]))) return true;
    return isPunct(t[from + 1], '(') || (isName(t[from + 1]) && isPunct(t[from + 2], '(') && t[from + 3]?.kind !== 'number' && upper(t[from + 3]) !== 'MAX');
  }
  if (head === 'LIKE') return from + 1 < to && isName(t[from + 1]) && !isPunct(t[from + 2], '(');
  if (head === 'PERIOD') return upper(t[from + 1]) === 'FOR';
  // `fulltext tsvector`, `spatial geometry`: columns; `FULLTEXT [KEY | INDEX] [name] (…)`: an index.
  if (head === 'FULLTEXT' || head === 'SPATIAL') {
    const next = upper(t[from + 1]);
    return next === 'KEY' || next === 'INDEX' || isPunct(t[from + 1], '(') || (isName(t[from + 1]) && isPunct(t[from + 2], '('));
  }
  if (head === 'EXCLUDE') return upper(t[from + 1]) === 'USING' || isPunct(t[from + 1], '(');
  return from + 1 < to;
}

/** A column item's type: tokens `[start, end)` after its name (empty when it has none, a computed column). */
export function columnTypeSpan(t: readonly Token[], from: number, to: number): { start: number; end: number } {
  let depth = 0;
  let angle = 0;
  let k = from + 1;
  for (; k < to; k++) {
    const tok = t[k];
    if (isPunct(tok, '(')) depth++;
    else if (isPunct(tok, ')')) depth--;
    else if (depth === 0 && isPunct(tok, '<')) angle++;
    else if (depth === 0 && isPunct(tok, '>')) angle--;
    else if (depth === 0 && angle === 0 && endsType(t, k)) break;
  }
  return { start: from + 1, end: k };
}

/** Words that may follow a type's first word and still be its type (`double precision`, `with local time zone`, `int unsigned`). */
const TYPE_TAIL_WORDS = new Set([
  'PRECISION', 'VARYING', 'CHARACTER', 'CHAR', 'NATIONAL', 'WITH', 'WITHOUT', 'LOCAL', 'TIME', 'ZONE', 'UNSIGNED', 'SIGNED',
  'ZEROFILL', 'DAY', 'HOUR', 'MINUTE', 'SECOND', 'YEAR', 'MONTH', 'TO', 'LONG', 'RAW', 'BINARY', 'ARRAY', 'VARCHAR', 'BYTE',
  'LARGE', 'OBJECT', 'DOUBLE', 'INT', 'INTEGER', 'TEXT', 'BLOB', 'MEDIUM', 'TINY', 'NCHAR', 'NVARCHAR', 'FRACTION', 'BIT', 'VARBINARY',
]);

/**
 * Tail words that only ever continue a type, so one that starts a line is
 * still the type's (`double\n  precision`, `timestamp\n  with time zone`).
 * Any other name that starts a line inside a type starts the next column.
 */
const TYPE_CONTINUATION_WORDS = new Set([
  'PRECISION', 'VARYING', 'WITH', 'WITHOUT', 'LOCAL', 'ZONE', 'UNSIGNED', 'SIGNED', 'ZEROFILL', 'TO', 'ARRAY', 'BYTE', 'LARGE', 'OBJECT',
]);

/** Words a type may carry after its parenthesised arguments (`decimal(10,2) unsigned`, `time(3) with time zone`, `interval day(2) to second`, `char(10) binary`). */
const AFTER_ARGUMENT_WORDS = new Set(['UNSIGNED', 'SIGNED', 'ZEROFILL', 'WITH', 'WITHOUT', 'TO', 'ARRAY', 'BINARY', 'BYTE', 'CHAR', 'VARYING']);

/** Type head words that never follow another word of the same type, except after {@link TYPE_HEAD_PREFIXES} (`long varchar`, `national char`). */
const STRONG_TYPE_HEADS = new Set([
  'INT', 'INTEGER', 'BIGINT', 'SMALLINT', 'TINYINT', 'MEDIUMINT', 'TEXT', 'VARCHAR', 'NVARCHAR', 'NCHAR', 'CHAR', 'DECIMAL', 'NUMERIC',
  'FLOAT', 'REAL', 'BOOLEAN', 'BOOL', 'DATE', 'DATETIME', 'DATETIME2', 'TIMESTAMP', 'UUID', 'BLOB', 'VARBINARY', 'JSON', 'JSONB',
  'STRING', 'BIT', 'MONEY', 'SERIAL', 'BIGSERIAL',
]);
const TYPE_HEAD_PREFIXES = new Set(['LONG', 'NATIONAL']);

/**
 * The first token in a column's type `[start, end)` that cannot be part of a
 * type (a stray word: `BIGINT oops`), or -1 when it is type-shaped: a name,
 * then parenthesised arguments, `<…>`, `.` parts, `[]`, and the words types
 * are made of.
 *
 * A comma missing between two columns makes the next column's name and type
 * look like more of this one's type (`price decimal(5,2)⏎ year int`, `title
 * varchar(20)⏎ text text`): the column list splits on commas only. So a tail
 * word is stray, the start of the next column ({@link missingCommaAt}), when
 * it starts a line (and only ever continues a type elsewhere), when it follows
 * the type's arguments and no type has it there, or when a type's head word
 * follows it.
 */
export function strayTypeToken(t: readonly Token[], start: number, end: number): number {
  let angle = 0;
  for (let k = start; k < end; k++) {
    const tok = t[k];
    if (k > start) {
      const afterArguments = isPunct(t[k - 1], ')') && angle === 0;
      if (isPunct(tok, '(')) { const close = matchParen(t as Token[], k); if (close < 0) return k; k = close; continue; }
      if (isPunct(tok, '<')) { angle++; continue; }
      if (isPunct(tok, '>')) { angle--; continue; }
      if (isPunct(tok, ',') || isPunct(tok, ':') || isPunct(tok, '.')) continue;
      if (tok.kind === 'ident' && /^\s*\d*\s*$/.test(tok.value)) continue; // int[], int[3]
      if (tok.kind === 'number' || angle > 0) continue;
      if (isName(tok) && isPunct(t[k - 1], '.')) continue;
      if (tok.kind !== 'word' || !TYPE_TAIL_WORDS.has(upper(tok))) return k;
      // A tail word that starts the next column (a comma missing before it).
      if (tok.line > t[k - 1].line && !TYPE_CONTINUATION_WORDS.has(upper(tok))) return k;
      if (afterArguments && !AFTER_ARGUMENT_WORDS.has(upper(tok))) return k;
    }
    // A type's head word after this one (`int year int`, `text text text`): the next column's type.
    if (angle === 0 && tok.kind === 'word' && k + 1 < end && t[k + 1].kind === 'word'
      && STRONG_TYPE_HEADS.has(upper(t[k + 1])) && !TYPE_HEAD_PREFIXES.has(upper(tok))) {
      return k === start || TYPE_CONTINUATION_WORDS.has(upper(tok)) ? k + 1 : k;
    }
  }
  return -1;
}

/**
 * Where a comma looks missing in a column's type `[start, end)`: the stray
 * token's index when it is a word the type's words are made of, or a name
 * that starts a line (either way it reads as the next column's name), else -1.
 */
export function missingCommaAt(t: readonly Token[], start: number, end: number): number {
  const stray = strayTypeToken(t, start, end);
  if (stray <= start) return -1;
  const tok = t[stray];
  return (tok.kind === 'word' && TYPE_TAIL_WORDS.has(upper(tok))) || (isName(tok) && tok.line > t[stray - 1].line) ? stray : -1;
}

/** A comma missing between two column definitions: where it goes, and the two columns it separates (for the ledger). */
export interface MissingComma {
  /** Offset in the file's text to insert `,` at: right after the first column's type, so no line moves. */
  offset: number;
  /** The line of the column that follows it. */
  line: number;
  /** The column before the missing comma, and the name read as the next column. */
  after: string;
  before: string;
}

/**
 * Every column in a column list whose type runs into the next column's
 * definition ({@link missingCommaAt}): one per column item, so a second
 * missing comma in the same item is found on the next pass over the repaired
 * text.
 */
export function missingCommas(t: readonly Token[], open: number, close: number): MissingComma[] {
  const found: MissingComma[] = [];
  for (const [from, to] of splitTopLevel(t as Token[], open + 1, close, true)) {
    if (from >= to || isConstraintItem(t, from, to) || !isName(t[from])) continue;
    const span = columnTypeSpan(t, from, to);
    if (span.end <= span.start) continue;
    let at = missingCommaAt(t, span.start, span.end);
    if (at <= span.start) at = nextColumnAfterConstraints(t, span.end, to);
    if (at < 0) continue;
    found.push({ offset: t[at - 1].end, line: t[at].line, after: t[from].value, before: t[at].value });
  }
  return found;
}

/**
 * A comma missing after a column's constraints (`a_id int REFERENCES a(id)⏎
 * note varchar(10)`): a name that starts a line outside any parentheses and
 * is followed by a type's head word, the next column. Index, or -1.
 */
function nextColumnAfterConstraints(t: readonly Token[], from: number, to: number): number {
  let depth = 0;
  for (let k = from; k < to - 1; k++) {
    if (isPunct(t[k], '(')) { depth++; continue; }
    if (isPunct(t[k], ')')) { depth--; continue; }
    if (depth !== 0 || k === 0 || t[k].line <= t[k - 1].line || !isName(t[k])) continue;
    if (t[k].kind === 'word' && (TYPE_STOP.has(upper(t[k])) || CONSTRAINT_TAIL_WORDS.has(upper(t[k])))) continue;
    if (t[k + 1].kind === 'word' && STRONG_TYPE_HEADS.has(upper(t[k + 1]))) return k;
  }
  return -1;
}

/** Words that continue a column's constraints on a new line (`ON DELETE CASCADE`, `MATCH FULL`, `DEFERRABLE`). */
const CONSTRAINT_TAIL_WORDS = new Set(['ON', 'DELETE', 'UPDATE', 'CASCADE', 'SET', 'NO', 'ACTION', 'RESTRICT', 'MATCH', 'FULL', 'SIMPLE', 'PARTIAL', 'DEFERRABLE', 'INITIALLY', 'DEFERRED', 'IMMEDIATE', 'WITH', 'ALWAYS', 'BY', 'IDENTITY', 'START', 'INCREMENT', 'ASC', 'DESC']);

/** The names of a column list's columns (not its constraints), lower-cased, in order. */
export function columnNamesOf(t: readonly Token[], open: number, close: number): string[] {
  const names: string[] = [];
  for (const [from, to] of splitTopLevel(t as Token[], open + 1, close, true)) {
    if (from < to && !isConstraintItem(t, from, to) && isName(t[from])) names.push(t[from].value.toLowerCase());
  }
  return names;
}

/** A type's text as the model keeps it: SQL Server's brackets and quotes off its names (never an array's `[]`), runs of spaces one space, none just inside parentheses. */
export function cleanTypeText(raw: string): string {
  return raw
    .replace(/\[([A-Za-z_@#][^\]]*)\]|"([^"]*)"|`([^`]*)`/g, (_m, a: string | undefined, b: string | undefined, c: string | undefined) => a ?? b ?? c ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\s*([(<.[\]])\s*/g, '$1')
    .replace(/\s+([)>,])/g, '$1')
    .replace(/\)(?=[A-Za-z])/g, ') ')
    .trim();
}

/** A type's head word, upper-cased, without its schema (`public.vector(20)` → VECTOR). */
export function typeHead(raw: string): string {
  const head = cleanTypeText(raw).split(/[ (<[]/)[0];
  return (head.split('.').pop() ?? head).toUpperCase();
}

/** Types every grammar reads: a head word, optional numeric (or MAX) arguments, more words (`double precision`, `with time zone`). */
const PLAIN_TYPE = /^[A-Z_][A-Z0-9_]*(?: [A-Z_][A-Z0-9_]*)*(?:\((?:\d+|MAX)(?:, ?\d+)?\))?(?: [A-Z_][A-Z0-9_]*)*$/;
/** Head words the grammars do not all know, whatever follows them. */
const EXOTIC_TYPE_HEADS = new Set([
  'VECTOR', 'GEOGRAPHY', 'GEOMETRY', 'HIERARCHYID', 'SQL_VARIANT', 'INTERVAL', 'ARRAY', 'STRUCT', 'MAP', 'OBJECT',
  'VARIANT', 'SUPER', 'POINT', 'LINESTRING', 'POLYGON', 'MULTIPOINT', 'MULTILINESTRING', 'MULTIPOLYGON', 'GEOMETRYCOLLECTION',
  'TSVECTOR', 'TSQUERY', 'CIDR', 'INET', 'MACADDR', 'LTREE', 'HSTORE', 'CITEXT',
]);

/** Whether a type (as written) is one a grammar may not know: generics, arrays, a schema-qualified type, arguments that are not numbers, or an exotic head word. */
export function isExoticType(raw: string): boolean {
  const s = cleanTypeText(raw).toUpperCase();
  if (/[<>:[\]]|\.[A-Z_]/.test(s)) return true;
  if (!PLAIN_TYPE.test(s)) return true;
  return EXOTIC_TYPE_HEADS.has(typeHead(raw));
}

// ---------------------------------------------------------------------------
// The rewrite
// ---------------------------------------------------------------------------

/** Table options after the column list, by their first word: the phrase the ledger names them by. */
const OPTION_PHRASES: Readonly<Record<string, string>> = {
  CLUSTER: 'CLUSTER BY', PARTITIONED: 'PARTITIONED BY', PARTITION: 'PARTITION BY', TBLPROPERTIES: 'TBLPROPERTIES',
  LOCATION: 'LOCATION', USING: 'USING', WITH: 'WITH (…)', ON: 'ON <filegroup>', TEXTIMAGE_ON: 'TEXTIMAGE_ON',
  FILESTREAM_ON: 'FILESTREAM_ON', ENGINE: 'ENGINE', CHARSET: 'CHARSET', CHARACTER: 'CHARSET', COLLATE: 'COLLATE',
  ROW_FORMAT: 'ROW_FORMAT', AUTO_INCREMENT: 'AUTO_INCREMENT', INHERITS: 'INHERITS', TABLESPACE: 'TABLESPACE',
  DATA_RETENTION_TIME_IN_DAYS: 'DATA_RETENTION_TIME_IN_DAYS', MAX_DATA_EXTENSION_TIME_IN_DAYS: 'MAX_DATA_EXTENSION_TIME_IN_DAYS',
  CHANGE_TRACKING: 'CHANGE_TRACKING', COPY: 'COPY GRANTS', STAGE_FILE_FORMAT: 'STAGE_FILE_FORMAT', STAGE_COPY_OPTIONS: 'STAGE_COPY_OPTIONS',
  OPTIONS: 'OPTIONS', ZORDER: 'ZORDER', DISTKEY: 'DISTKEY', SORTKEY: 'SORTKEY', DISTSTYLE: 'DISTSTYLE', DISTRIBUTED: 'DISTRIBUTED BY',
  STORED: 'STORED AS', ROW: 'ROW FORMAT', ENABLE_SCHEMA_EVOLUTION: 'ENABLE_SCHEMA_EVOLUTION', DEFAULT_DDL_COLLATION: 'DEFAULT_DDL_COLLATION',
  STARTS: 'STARTS', AUTO: 'AUTO_REFRESH', PCTFREE: 'PCTFREE', LOGGING: 'LOGGING', NOLOGGING: 'NOLOGGING', COMPRESS: 'COMPRESS',
  ORGANIZATION: 'ORGANIZATION', SERVER: 'SERVER', ORDER: 'ORDER BY', PRIMARY: 'PRIMARY KEY', SETTINGS: 'SETTINGS', TTL: 'TTL',
};

/** Phrases for the options found after `close` (COMMENT and `=` aside), first-seen order. */
function optionPhrases(t: readonly Token[], close: number): { phrases: string[]; comment: boolean } {
  const phrases: string[] = [];
  let comment = false;
  let depth = 0;
  let expectWord = true;
  for (let k = close + 1; k < t.length; k++) {
    const tok = t[k];
    if (isPunct(tok, '(')) { depth++; continue; }
    if (isPunct(tok, ')')) { depth--; expectWord = depth === 0; continue; }
    if (depth !== 0) continue;
    if (isPunct(tok, ',') || isPunct(tok, '=')) { expectWord = isPunct(tok, ','); continue; }
    if (tok.kind !== 'word') { expectWord = true; continue; }
    const w = upper(tok);
    if (w === 'COMMENT') { comment = true; expectWord = false; continue; }
    if (w === 'DEFAULT') continue;
    if (expectWord || OPTION_PHRASES[w]) {
      const phrase = OPTION_PHRASES[w] ?? 'other table options';
      if (!phrases.includes(phrase)) phrases.push(phrase);
    }
    expectWord = false;
  }
  return { phrases, comment };
}

function quoteFor(target: SqlParseFormat, name: string): string {
  switch (target) {
    case 'mysql': return `\`${name.replace(/`/g, '``')}\``;
    case 'mssql': return `[${name.replace(/\]/g, ']]')}]`;
    default: return `"${name.replace(/"/g, '""')}"`;
  }
}

/** Grammars whose strings read backslash escapes. */
const BACKSLASH_TARGETS = new Set<SqlParseFormat>(['mysql', 'snowflake']);
const BACKSLASH_DIALECTS = new Set<SqlDialect>(['mysql', 'databricks', 'snowflake']);

/** The home grammar of each identity spelling: elsewhere it is set aside and the column marked as an identity. */
const IDENTITY_HOME: Readonly<Record<string, SqlParseFormat>> = { IDENTITY: 'mssql', AUTO_INCREMENT: 'mysql', AUTOINCREMENT: 'snowflake' };

/** Column modifiers set aside in every grammar (a word, and how many tokens after it are its value). */
const PLAIN_MODIFIERS: Readonly<Record<string, number>> = {
  INVISIBLE: 0, VISIBLE: 0, SPARSE: 0, ROWGUIDCOL: 0, FILESTREAM: 0, ENFORCED: 0, RELY: 0, NORELY: 0, NOVALIDATE: 0,
  VALIDATE: 0, DEFERRABLE: 0, CLUSTERED: 0, NONCLUSTERED: 0, SRID: 1, ENCODE: 1, COLLATE: 1, CHARSET: 1, COMPRESSION: 1, STORAGE: 1,
};

/**
 * The statement rewritten by `rungs` for the `target` grammar: the SQL to
 * parse, what was set aside (types, comments, identity columns), and what was
 * changed, for the ledger.
 */
export function rewriteCreateTable(input: RewriteInput): Rewrite {
  const { text, st, name, open, close, dialect, target, rungs } = input;
  const t = st.tokens;
  const edits: Array<{ start: number; end: number; text: string }> = [];
  const repairs: Repair[] = [];
  const types = new Map<string, string>();
  const comments = new Map<string, string>();
  const identity = new Set<string>();
  let droppedIndexes = 0;
  let placeholders = 0;
  const replace = (from: number, to: number, value: string): void => { edits.push({ start: t[from].start, end: t[to].end, text: value }); };
  const blank = (from: number, to: number): void => replace(from, to, '');
  const q = (value: string): string => quoteFor(target, value);
  const tableWord = t.findIndex((tok) => upper(tok) === 'TABLE');

  // 1. Options: the head's modifiers, IF NOT EXISTS, everything after the column list.
  if (rungs.has('options')) {
    if (tableWord > 1) blank(1, tableWord - 1);
    if (upper(t[tableWord + 1]) === 'IF' && upper(t[tableWord + 2]) === 'NOT' && upper(t[tableWord + 3]) === 'EXISTS') blank(tableWord + 1, tableWord + 3);
    if (close + 1 < t.length) {
      const { phrases, comment } = optionPhrases(t, close);
      blank(close + 1, t.length - 1);
      if (phrases.length || comment) {
        repairs.push({
          rung: 'options', unit: 'table', cause: 'trailingOption', what: 'table options',
          // `set aside: CLUSTER BY; COMMENT kept as the table note`, or the COMMENT alone (never `readCOMMENT …`).
          detail: [
            ...(phrases.length ? [`set aside: ${phrases.slice(0, 4).join(', ')}${phrases.length > 4 ? '…' : ''}`] : []),
            ...(comment ? ['COMMENT kept as the table note'] : []),
          ].join('; '),
          line: t[close + 1].line,
        });
      }
    }
  }

  // 2. Quote: the table's name (no catalog), and every name in the column list.
  let quoted = 0;
  const quoteName = (from: number, to: number): void => {
    // A dotted name t[from, to): its last two parts, quoted.
    const parts: string[] = [];
    for (let k = from; k < to; k++) if (isName(t[k])) parts.push(t[k].value);
    if (parts.length === 0) return;
    for (let k = from; k < to; k++) if (t[k].kind === 'word' && KEYWORD_NAMES.has(upper(t[k]))) quoted++;
    replace(from, to - 1, parts.slice(-2).map(q).join('.'));
  };
  const nameEnd = (from: number): number => {
    let k = from;
    if (!isName(t[k])) return k;
    k++;
    while ((isPunct(t[k], '.') && isName(t[k + 1])) || (isPunct(t[k], '.') && isPunct(t[k + 1], '.') && isName(t[k + 2]))) k += isPunct(t[k + 1], '.') ? 3 : 2;
    return k;
  };
  const quoteList = (openAt: number): void => {
    const end = matchParen(t as Token[], openAt);
    if (end < 0) return;
    for (let k = openAt + 1; k < end; k++) {
      if (isName(t[k]) && (isPunct(t[k - 1], '(') || isPunct(t[k - 1], ',')) && !isPunct(t[k + 1], '(')) {
        if (t[k].kind === 'word' && KEYWORD_NAMES.has(upper(t[k]))) quoted++;
        replace(k, k, q(t[k].value));
      }
    }
  };
  if (rungs.has('quote')) quoteName(name.first, name.next);

  const items = splitTopLevel(t as Token[], open + 1, close, true);
  const dropped = new Set<number>();
  items.forEach(([from, to], index) => {
    if (from >= to) return;
    if (isConstraintItem(t, from, to)) {
      rewriteConstraintItem(from, to, index);
      return;
    }
    if (!isName(t[from])) return;
    const column = t[from].value;
    const span = columnTypeSpan(t, from, to);
    if (rungs.has('quote')) { if (t[from].kind === 'word' && KEYWORD_NAMES.has(upper(t[from]))) quoted++; replace(from, from, q(column)); }
    // 3. Types.
    if (span.end > span.start) {
      const raw = text.slice(t[span.start].start, t[span.end - 1].end);
      const exotic = isExoticType(raw);
      const head = typeHead(raw);
      if (/^(SMALL|BIG)?SERIAL[248]?$/.test(head)) identity.add(column.toLowerCase());
      // Never a type with a stray word in it: that is a syntax error, not a type the grammar lacks.
      if (((rungs.has('types') && exotic) || rungs.has('allTypes')) && strayTypeToken(t, span.start, span.end) < 0) {
        const placeholder = placeholderType(placeholders++);
        for (const key of placeholder.keys) types.set(key, cleanTypeText(raw));
        replace(span.start, span.end - 1, placeholder.sql);
        if (exotic) {
          repairs.push({ rung: 'types', unit: 'column', cause: 'unknownType', what: `${head.slice(0, 24) || 'unknown'} type`, detail: 'read as written', line: t[span.start].line, column });
        }
      }
    } else if (rungs.has('modifiers') && hasComputedClause(span.end, to) && target !== 'mssql' && target !== 'mysql') {
      // A computed column has no type of its own: give the grammar one to read.
      const placeholder = placeholderType(placeholders++);
      for (const key of placeholder.keys) types.set(key, '');
      edits.push({ start: t[from].end, end: t[from].end, text: ` ${placeholder.sql}` });
    }
    rewriteModifiers(column, span.end, to);
  });

  // Index definitions inside the list (and their commas) out, for grammars that have none.
  if (dropped.size) {
    const kept = items.map((_r, i) => i).filter((i) => !dropped.has(i));
    for (let i = 0; i < items.length - 1; i++) {
      const comma = items[i][1];
      const keepComma = !dropped.has(i) && kept.some((k) => k > i);
      if (!keepComma && isPunct(t[comma], ',')) blank(comma, comma);
    }
    for (const i of dropped) if (items[i][1] > items[i][0]) blank(items[i][0], items[i][1] - 1);
  }

  if (rungs.has('quote') && quoted > 0) {
    repairs.push({ rung: 'quote', unit: 'table', cause: 'reservedWord', what: 'names like keywords', detail: 'quoted so they read as names', line: st.line });
  }

  // Strings in the target grammar's escaping (line breaks inside one become spaces; applyEdits keeps the line count).
  const fromBackslash = BACKSLASH_DIALECTS.has(dialect);
  const toBackslash = BACKSLASH_TARGETS.has(target);
  if (fromBackslash || toBackslash) {
    for (let k = open + 1; k < close; k++) {
      if (t[k].kind !== 'string') continue;
      let value = t[k].value.replace(/\r?\n/g, ' ');
      if (toBackslash) value = value.replace(/\\/g, '\\\\');
      edits.push({ start: t[k].start, end: t[k].end, text: `'${value.replace(/'/g, "''")}'` });
    }
  }

  return { prepared: { sql: applyEdits(text, st.start, st.end, edits), types, comments, identity }, repairs, droppedIndexes };

  function hasComputedClause(from: number, to: number): boolean {
    return upper(t[from]) === 'AS' && isPunct(t[from + 1], '(') && from + 1 < to;
  }

  /**
   * PostgreSQL 15's `ON DELETE SET NULL (col, …)` / `SET DEFAULT (col, …)`:
   * the column list goes (no grammar has it); the action stays. True when
   * `t[k]` is such a SET (its list then blanked).
   */
  function setNullColumns(k: number): boolean {
    if (upper(t[k]) !== 'SET' || !/^(NULL|DEFAULT)$/.test(upper(t[k + 1])) || !isPunct(t[k + 2], '(') || upper(t[k - 1]) !== 'DELETE') return false;
    const end = matchParen(t as Token[], k + 2);
    if (end < 0) return false;
    blank(k + 2, end);
    note(undefined, `ON DELETE SET ${upper(t[k + 1])} (columns)`, k, 'the column list set aside; the action is kept');
    return true;
  }

  function note(column: string | undefined, what: string, at: number, detail = 'set aside so the table reads'): void {
    repairs.push({ rung: 'modifiers', unit: column ? 'column' : 'table', cause: 'unsupportedModifier', what, detail, line: t[at].line, ...(column ? { column } : {}) });
  }

  function rewriteConstraintItem(from: number, to: number, index: number): void {
    const head = upper(t[from]);
    const indexHead = head === 'INDEX' || head === 'KEY' || head === 'FULLTEXT' || head === 'SPATIAL';
    if (rungs.has('modifiers')) {
      // SQL Server's `INDEX ix UNIQUE [NON]CLUSTERED (cols)` is a unique key: `UNIQUE [NON]CLUSTERED (cols)`.
      const uniqueIndex = head === 'INDEX' && isName(t[from + 1]) && upper(t[from + 2]) === 'UNIQUE';
      if (uniqueIndex) blank(from, from + 1);
      else if (head === 'PERIOD' || head === 'EXCLUDE' || head === 'LIKE' || (indexHead && target !== 'mysql')) {
        dropped.add(index);
        if (indexHead) droppedIndexes++;
        else note(undefined, `${head === 'PERIOD' ? 'PERIOD FOR' : head} in the column list`, from);
        return;
      }
    }
    for (let k = from; k < to; k++) {
      const w = upper(t[k]);
      if (rungs.has('quote')) {
        if (isPunct(t[k], '(') && (isPunct(t[k - 1], ')') === false)) {
          const before = upper(t[k - 1]);
          if (before === 'KEY' || before === 'UNIQUE' || before === 'INDEX' || isName(t[k - 1]) || before === 'CLUSTERED' || before === 'NONCLUSTERED') {
            if (before !== 'CHECK' && upper(t[k - 2]) !== 'CHECK') quoteList(k);
          }
        }
        if (w === 'REFERENCES' && isName(t[k + 1])) quoteName(k + 1, nameEnd(k + 1));
        if (w === 'CONSTRAINT' && isName(t[k + 1])) replace(k + 1, k + 1, q(t[k + 1].value));
      }
      if (!rungs.has('modifiers')) continue;
      if (w === 'CHECK' && isPunct(t[k + 1], '(')) { k = Math.max(k, matchParen(t as Token[], k + 1)); continue; }
      if (setNullColumns(k)) continue;
      if (isPunct(t[k], '(')) {
        // A column list: only ASC / DESC go (for grammars without them); names stay.
        const end = matchParen(t as Token[], k);
        if (end < 0) continue;
        if (target !== 'mssql' && target !== 'mysql') {
          for (let j = k + 1; j < end; j++) if ((upper(t[j]) === 'ASC' || upper(t[j]) === 'DESC') && isName(t[j - 1])) blank(j, j);
        }
        k = end;
        continue;
      }
      if ((w === 'CLUSTERED' || w === 'NONCLUSTERED') && target !== 'mssql') { blank(k, k); continue; }
      if ((w === 'KEY' || w === 'INDEX') && upper(t[k - 1]) === 'UNIQUE' && target !== 'mysql') {
        // UNIQUE KEY name (cols) → UNIQUE (cols).
        blank(k, isName(t[k + 1]) && !isPunct(t[k + 1], '(') && isPunct(t[k + 2], '(') ? k + 1 : k);
        continue;
      }
      if (w === 'WITH' && isPunct(t[k + 1], '(') && target !== 'mssql') {
        const end = matchParen(t as Token[], k + 1);
        if (end > 0) { blank(k, end); k = end; }
        continue;
      }
      if (w === 'ON' && upper(t[k + 1]) !== 'DELETE' && upper(t[k + 1]) !== 'UPDATE' && target !== 'mssql' && isName(t[k + 1])) { blank(k, k + 1); k++; continue; }
      if (w === 'NOT' && (upper(t[k + 1]) === 'ENFORCED' || upper(t[k + 1]) === 'DEFERRABLE')) { blank(k, k + 1); k++; continue; }
      if (w === 'INITIALLY' && (upper(t[k + 1]) === 'DEFERRED' || upper(t[k + 1]) === 'IMMEDIATE')) { blank(k, k + 1); k++; continue; }
      if (w === 'MATCH' && /^(SIMPLE|FULL|PARTIAL)$/.test(upper(t[k + 1]))) { blank(k, k + 1); k++; continue; }
      if (w === 'USING' && upper(t[k + 1]) === 'INDEX') {
        let end = k + 1;
        if (upper(t[end + 1]) === 'TABLESPACE' && isName(t[end + 2])) end += 2;
        blank(k, end);
        k = end;
        continue;
      }
      if (w === 'INCLUDE' && isPunct(t[k + 1], '(')) { const end = matchParen(t as Token[], k + 1); if (end > 0) { blank(k, end); k = end; } continue; }
      if (w === 'COMMENT' && t[k + 1]?.kind === 'string') { blank(k, k + 1); k++; continue; }
      if (PLAIN_MODIFIERS[w] === 0 && w !== 'CLUSTERED' && w !== 'NONCLUSTERED') { blank(k, k); continue; }
      if (w === 'TIMESERIES') { blank(k, k); continue; }
    }
  }

  function rewriteModifiers(column: string, from: number, to: number): void {
    let references = false;
    for (let k = from; k < to; k++) {
      const w = upper(t[k]);
      if (w === 'REFERENCES') references = true;
      // After REFERENCES, `ON DELETE | UPDATE <action>` is the reference's action (kept), never MySQL's `ON UPDATE CURRENT_TIMESTAMP`.
      if (references && w === 'ON' && (upper(t[k + 1]) === 'DELETE' || upper(t[k + 1]) === 'UPDATE')) {
        if (rungs.has('modifiers') && setNullColumns(k + 2)) { k += 2; continue; }
        k++;
        continue;
      }
      if (rungs.has('quote') && w === 'REFERENCES' && isName(t[k + 1])) {
        const end = nameEnd(k + 1);
        quoteName(k + 1, end);
        if (isPunct(t[end], '(')) quoteList(end);
        continue;
      }
      if (!rungs.has('modifiers')) continue;
      if (setNullColumns(k)) continue;
      if (isPunct(t[k], '(')) { const end = matchParen(t as Token[], k); if (end > 0) k = end; continue; }
      // COMMENT '…': the converter reads it from the file.
      if (w === 'COMMENT') {
        const value = isPunct(t[k + 1], '=') ? k + 2 : k + 1;
        if (t[value]?.kind === 'string') { blank(k, value); k = value; }
        continue;
      }
      if (w === 'GENERATED') {
        let a = k + 1;
        while (a < to && upper(t[a]) !== 'AS') a++;
        if (upper(t[a + 1]) === 'IDENTITY') {
          let end = a + 1;
          if (isPunct(t[end + 1], '(')) end = matchParen(t as Token[], end + 1);
          if (target !== 'postgres' && end > 0) { identity.add(column.toLowerCase()); blank(k, end); }
          k = Math.max(k, end);
          continue;
        }
        if (isPunct(t[a + 1], '(')) {
          const end = matchParen(t as Token[], a + 1);
          if (end < 0) continue;
          const kind = upper(t[end + 1]);
          const kindAt = kind === 'STORED' || kind === 'VIRTUAL' ? end + 1 : -1;
          if (target === 'postgres' && kind === 'VIRTUAL') {
            replace(kindAt, kindAt, 'STORED');
            note(column, 'VIRTUAL generated column', kindAt, 'VIRTUAL read as STORED so the table reads');
          } else if (target === 'postgres' && kindAt < 0) {
            // Spark's GENERATED ALWAYS AS (expr): Postgres needs the STORED.
            edits.push({ start: t[end].end, end: t[end].end, text: ' STORED' });
          } else if (target !== 'mysql' && target !== 'postgres') {
            blank(k, kindAt > 0 ? kindAt : end);
            note(column, 'generated column', k, 'expression set aside so the table reads');
          }
          k = kindAt > 0 ? kindAt : end;
        }
        continue;
      }
      if (w === 'AS' && isPunct(t[k + 1], '(')) {
        // A computed column (SQL Server `AS (expr) PERSISTED`, MySQL `AS (expr) STORED`).
        const end = matchParen(t as Token[], k + 1);
        if (end < 0) continue;
        const kind = upper(t[end + 1]);
        const kindAt = kind === 'PERSISTED' || kind === 'STORED' || kind === 'VIRTUAL' ? end + 1 : -1;
        if (target === 'mssql') {
          if (kindAt > 0 && kind !== 'PERSISTED') blank(kindAt, kindAt);
        } else if (target === 'mysql') {
          if (kind === 'PERSISTED') replace(kindAt, kindAt, 'STORED');
        } else {
          blank(k, kindAt > 0 ? kindAt : end);
          note(column, 'computed column', k, 'expression set aside so the table reads');
        }
        k = kindAt > 0 ? kindAt : end;
        continue;
      }
      if (w === 'PERSISTED' || w === 'STORED' || w === 'VIRTUAL') { blank(k, k); note(column, w, k); continue; }
      if (w in IDENTITY_HOME) {
        // IDENTITY[(a, b)] [START n] [INCREMENT m] [ORDER | NOORDER], AUTO_INCREMENT, AUTOINCREMENT.
        let end = k;
        if (isPunct(t[end + 1], '(')) end = Math.max(end, matchParen(t as Token[], end + 1));
        for (;;) {
          const next = upper(t[end + 1]);
          if ((next === 'START' || next === 'INCREMENT') && (t[end + 2]?.kind === 'number' || upper(t[end + 2]) === 'WITH' || upper(t[end + 2]) === 'BY')) {
            end += t[end + 2]?.kind === 'number' ? 2 : 3;
            continue;
          }
          if (next === 'ORDER' || next === 'NOORDER') { end++; continue; }
          break;
        }
        if (IDENTITY_HOME[w] === target) {
          if (end > k) blank(k + 1, end);
        } else {
          identity.add(column.toLowerCase());
          blank(k, end);
        }
        k = end;
        continue;
      }
      if (w === 'NOT' && upper(t[k + 1]) === 'FOR' && upper(t[k + 2]) === 'REPLICATION') { blank(k, k + 2); note(column, 'NOT FOR REPLICATION', k); k += 2; continue; }
      if (w === 'NOT' && (upper(t[k + 1]) === 'ENFORCED' || upper(t[k + 1]) === 'DEFERRABLE')) { blank(k, k + 1); k++; continue; }
      if (w === 'ON' && upper(t[k + 1]) === 'UPDATE') {
        let end = k + 2;
        if (isPunct(t[end + 1], '(')) end = Math.max(end, matchParen(t as Token[], end + 1));
        blank(k, end);
        note(column, 'ON UPDATE', k);
        k = end;
        continue;
      }
      if (w === 'CHARACTER' && upper(t[k + 1]) === 'SET') { blank(k, k + 2); note(column, 'CHARACTER SET', k); k += 2; continue; }
      if (w === 'CONSTRAINT' && isName(t[k + 1]) && target !== 'mssql') { blank(k, k + 1); k++; continue; }
      if ((w === 'MASKING' || w === 'PROJECTION' || (w === 'WITH' && (upper(t[k + 1]) === 'MASKING' || upper(t[k + 1]) === 'PROJECTION')))
        && upper(t[w === 'WITH' ? k + 2 : k + 1]) === 'POLICY' && isName(t[w === 'WITH' ? k + 3 : k + 2])) {
        // Snowflake's [WITH] MASKING | PROJECTION POLICY [db.schema.]fn [USING (col, …)].
        const policy = w === 'WITH' ? k + 3 : k + 2;
        let end = nameEnd(policy) - 1;
        if (upper(t[end + 1]) === 'USING' && isPunct(t[end + 2], '(')) end = Math.max(end, matchParen(t as Token[], end + 2));
        end = Math.min(end, to - 1);
        blank(k, end);
        note(column, `${upper(t[policy - 2])} POLICY`, k);
        k = end;
        continue;
      }
      if (w === 'MASK' && isName(t[k + 1])) {
        // Databricks' MASK [catalog.schema.]fn [USING COLUMNS (…)].
        let end = nameEnd(k + 1) - 1;
        if (upper(t[end + 1]) === 'USING') {
          end++;
          if (upper(t[end + 1]) === 'COLUMNS') end++;
          if (isPunct(t[end + 1], '(')) end = Math.max(end, matchParen(t as Token[], end + 1));
        }
        blank(k, end);
        note(column, 'MASK', k);
        k = end;
        continue;
      }
      if ((w === 'MASKED' || w === 'ENCRYPTED') && upper(t[k + 1]) === 'WITH' && isPunct(t[k + 2], '(')) {
        const end = matchParen(t as Token[], k + 2);
        if (end > 0) { blank(k, end); note(column, w, k); k = end; }
        continue;
      }
      if ((w === 'TAG' || (w === 'WITH' && upper(t[k + 1]) === 'TAG')) && isPunct(t[w === 'TAG' ? k + 1 : k + 2], '(')) {
        const end = matchParen(t as Token[], w === 'TAG' ? k + 1 : k + 2);
        if (end > 0) { blank(k, end); note(column, 'TAG', k); k = end; }
        continue;
      }
      if (w === 'WITH' && isPunct(t[k + 1], '(') && target !== 'mssql') {
        const end = matchParen(t as Token[], k + 1);
        if (end > 0) { blank(k, end); k = end; }
        continue;
      }
      if (w in PLAIN_MODIFIERS) {
        if ((w === 'CLUSTERED' || w === 'NONCLUSTERED') && target === 'mssql') continue;
        const end = Math.min(k + PLAIN_MODIFIERS[w], to - 1);
        blank(k, end);
        if (!['ENFORCED', 'RELY', 'NORELY', 'NOVALIDATE', 'VALIDATE', 'DEFERRABLE', 'CLUSTERED', 'NONCLUSTERED'].includes(w)) note(column, w, k);
        k = end;
        continue;
      }
      if (w === 'INITIALLY' && (upper(t[k + 1]) === 'DEFERRED' || upper(t[k + 1]) === 'IMMEDIATE')) { blank(k, k + 1); k++; continue; }
      if (w === 'MATCH' && /^(SIMPLE|FULL|PARTIAL)$/.test(upper(t[k + 1]))) { blank(k, k + 1); k++; continue; }
    }
  }
}

// ---------------------------------------------------------------------------
// Why a statement did not read: the hints a problem message names
// ---------------------------------------------------------------------------

export interface RepairHint {
  /** A fixed phrase (`a VIRTUAL generated column (PostgreSQL 18)`); a type's text is cut short. */
  phrase: string;
  cause: LedgerCause;
  line: number;
}

/** Names that are keywords in at least one grammar the import reads. */
const KEYWORD_NAMES = new Set([
  'FILE_FORMAT', 'ORDER', 'USER', 'KEY', 'VALUE', 'VALUES', 'TYPE', 'COMMENT', 'DATE', 'LEVEL', 'ROWS', 'ROW', 'GROUP', 'TABLE',
  'SELECT', 'FROM', 'WHERE', 'INDEX', 'CHECK', 'DEFAULT', 'LIMIT', 'OFFSET', 'POSITION', 'RANGE', 'SCHEMA', 'COLUMN',
  'TIMESTAMP', 'TIME', 'YEAR', 'MONTH', 'DAY', 'HOUR', 'MINUTE', 'SECOND', 'STATUS', 'NAME', 'OPTION', 'PERCENT', 'REFERENCES',
  'CONSTRAINT', 'PRIMARY', 'UNIQUE', 'FOREIGN', 'GRANT', 'TO', 'AS', 'BY', 'ON', 'IN', 'IS', 'OF', 'AND', 'OR', 'NOT', 'ALL',
  'ANY', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'START', 'WINDOW', 'FUNCTION', 'TRIGGER', 'SEQUENCE', 'STAGE', 'WAREHOUSE',
  'DATABASE', 'ACCOUNT', 'ROLE', 'SHOW', 'LOCATION', 'REGION', 'LANGUAGE', 'PARTITION', 'INTERVAL', 'IDENTITY', 'CURRENT',
]);

/**
 * What in a statement a grammar is likely to have stumbled on, first-seen
 * order: a VIRTUAL generated column, a template placeholder left in, a
 * COMMENT before CLUSTER BY, an exotic type, a column named like a keyword.
 */
export function repairHints(text: string, st: Statement, open: number, close: number): RepairHint[] {
  const t = st.tokens;
  const hints: RepairHint[] = [];
  const statementText = text.slice(st.start, st.end);
  const placeholder = /\$\{[^}\n]*\}|\{\{[^}\n]*\}\}/.exec(statementText);
  if (placeholder) {
    hints.push({ phrase: 'a template placeholder such as ${…}', cause: 'templatePlaceholder', line: st.line + (statementText.slice(0, placeholder.index).match(/\n/g) ?? []).length });
  }
  for (const [from, to] of splitTopLevel(t as Token[], open + 1, close, true)) {
    if (from >= to || isConstraintItem(t, from, to) || !isName(t[from])) continue;
    const span = columnTypeSpan(t, from, to);
    if (t[from].kind === 'word' && KEYWORD_NAMES.has(upper(t[from]))) hints.push({ phrase: 'a column named like a keyword', cause: 'reservedWord', line: t[from].line });
    if (span.end > span.start) {
      const comma = missingCommaAt(t, span.start, span.end);
      if (comma >= 0) {
        const next = t[comma].value.length > 32 ? `${t[comma].value.slice(0, 31)}…` : t[comma].value;
        hints.push({ phrase: `a comma missing before ${next} (after the column ${t[from].value.length > 32 ? `${t[from].value.slice(0, 31)}…` : t[from].value})`, cause: 'parseError', line: t[comma].line });
        continue;
      }
      const raw = text.slice(t[span.start].start, t[span.end - 1].end);
      if (isExoticType(raw)) {
        const shown = cleanTypeText(raw);
        hints.push({ phrase: `the type ${shown.length > 32 ? `${shown.slice(0, 31)}…` : shown}`, cause: 'unknownType', line: t[span.start].line });
      }
    }
    for (let k = span.end; k < to; k++) {
      if (upper(t[k]) === 'VIRTUAL') hints.push({ phrase: 'a VIRTUAL generated column (PostgreSQL 18)', cause: 'unsupportedModifier', line: t[k].line });
    }
  }
  // COMMENT before CLUSTER BY (Snowflake's grammar reads them only the other way round).
  let commentAt = -1;
  for (let k = close + 1; k < t.length; k++) {
    if (upper(t[k]) === 'COMMENT') commentAt = k;
    if (upper(t[k]) === 'CLUSTER' && commentAt > 0) { hints.push({ phrase: 'CLUSTER BY after COMMENT', cause: 'trailingOption', line: t[k].line }); break; }
  }
  return hints;
}
