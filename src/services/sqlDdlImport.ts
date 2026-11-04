/**
 * SQL DDL → DBML: the converter behind **Import SQL DDL…**. Its output is one
 * self-contained DBML file that the Import DBML flow (`readDbml`, then
 * `planDbmlImport`) turns into a new diagram, so everything after the
 * conversion — names the library already has, relationships stored from the
 * FK side, the summary — is Import DBML's.
 *
 * The SQL grammars are `@dbml/core`'s (ANTLR, one per dialect), which are
 * large, so they never enter `dist/extension.js` or `dist/cli.js`: this module
 * takes the parser as an argument ({@link SqlParseEngine}) and imports nothing
 * from `@dbml/core`. `sqlImportEngine.ts` binds the real parser and is the
 * entry of the separate `dist/sqlImport.js` bundle, which the host loads only
 * when an import runs (`sqlImportLoader.ts`). Host code may import this module
 * (for {@link detectSqlDialect}, the labels and the types) without pulling the
 * grammars in.
 *
 * How a file is read:
 *
 *  1. It is split into statements here (strings, quoted names, comments and
 *     `$$` bodies respected; `;`, a SQL Server `GO` line, or a new statement
 *     keyword at the start of a line ends one), each with its first line.
 *  2. Only `CREATE TABLE … ( … )` and Postgres `CREATE TYPE … AS ENUM` go to
 *     the grammar, one statement at a time, so a syntax error names its file
 *     and line and one table's references need no other table to parse.
 *     Databricks / Spark SQL has no grammar of its own: its statements are
 *     rewritten for the Postgres one first (Delta clauses, catalog
 *     qualifiers, backticks, `ARRAY<…>` / `STRUCT<…>` / `MAP<…>` types, column
 *     `COMMENT`s), always keeping the statement's line breaks so a line number
 *     still points into the user's file.
 *  3. `ALTER TABLE … ADD [CONSTRAINT …] FOREIGN KEY | PRIMARY KEY | UNIQUE`,
 *     `COMMENT ON TABLE | COLUMN` and SQL Server's `sp_addextendedproperty
 *     'MS_Description'` are read here, after every file's tables, so a file of
 *     constraints may follow the file of tables it names.
 *  4. Everything else (views, indexes, inserts, grants, routines, session
 *     settings, …) is skipped and counted per file, by kind.
 *
 * The files are merged into one model: a table defined twice is a problem;
 * a foreign key whose table or columns are not in the files is skipped (and
 * said so); the same foreign key written twice (inline and as an `ALTER`) is
 * one `Ref`. Refs are written many → one (`Ref: fk_table.col > pk_table.col`),
 * without the constraint name (Import would read it as a role) or its
 * `ON DELETE` / `ON UPDATE` actions (Import drops them). Plain (non-unique)
 * indexes are physical tuning, not design, so they are left out and counted;
 * keys, unique constraints, `NOT NULL`, defaults, identity columns and checks
 * are kept as DBML says them. Table names that `TABLE_NAME_PATTERN` rejects
 * are made into the nearest name it accepts (the original kept as the table's
 * warehouse `alias` when it can be one), and said so in `notes`.
 *
 * Pure: no `vscode`, no file access, no `@dbml/core` — text in, DBML or
 * problems out. Never echoes file contents in a message beyond a table,
 * column or constraint name.
 */

import { TABLE_NAME_PATTERN } from '../types/naming';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The SQL dialects Import SQL DDL… reads. */
export type SqlDialect = 'postgres' | 'mysql' | 'sqlserver' | 'snowflake' | 'databricks';

/** Every dialect, in the order a picker lists them. */
export const SQL_DIALECTS: readonly SqlDialect[] = Object.freeze(['postgres', 'mysql', 'sqlserver', 'snowflake', 'databricks']);

/** How a picker names each dialect. */
export const SQL_DIALECT_LABELS: Readonly<Record<SqlDialect, string>> = Object.freeze({
  postgres: 'PostgreSQL',
  mysql: 'MySQL / MariaDB',
  sqlserver: 'SQL Server / Azure SQL',
  snowflake: 'Snowflake',
  databricks: 'Databricks / Spark SQL',
});

/** Whether `value` is a {@link SqlDialect}. */
export function isSqlDialect(value: unknown): value is SqlDialect {
  return typeof value === 'string' && (SQL_DIALECTS as readonly string[]).includes(value);
}

export interface SqlDdlFile {
  /** How messages name the file (a base name or a workspace-relative path). */
  name: string;
  text: string;
}

export interface SqlDdlToDbmlInput {
  files: readonly SqlDdlFile[];
  dialect: SqlDialect;
}

export interface SqlDdlProblem {
  file: string;
  /** 1-based line in that file, when the problem has one. */
  line?: number;
  message: string;
}

export type SqlDdlToDbmlResult =
  | {
      ok: true;
      /** One self-contained DBML file (no `use` lines, no Records, no Project). */
      dbml: string;
      tableCount: number;
      refCount: number;
      /** What was not used, one short line each (`orders.sql: skipped 2 views, 1 index`); never file contents. */
      skipped: string[];
      /** Kept, but changed on the way: a renamed table or schema. */
      notes: string[];
    }
  | { ok: false; problems: SqlDdlProblem[] };

/** The grammar each dialect is read with (Databricks: rewritten for Postgres first). */
export type SqlParseFormat = 'postgres' | 'mysql' | 'mssql' | 'snowflake';

export const SQL_PARSE_FORMAT: Readonly<Record<SqlDialect, SqlParseFormat>> = Object.freeze({
  postgres: 'postgres',
  mysql: 'mysql',
  sqlserver: 'mssql',
  snowflake: 'snowflake',
  databricks: 'postgres',
});

/**
 * The parser: one statement's text in, `@dbml/core`'s raw (un-validated)
 * model out (`Parser.parsePostgresToJSONv2` and friends). It throws on a
 * syntax error: an array of `{ message, location: { start: { line } } }`
 * (lines relative to the text it was given), or an `Error`.
 */
export type SqlParseEngine = (sql: string, format: SqlParseFormat) => RawSqlDatabase;

/** The parts of `@dbml/core`'s `RawDatabase` the converter reads. */
export interface RawSqlDatabase {
  tables?: RawSqlTable[];
  refs?: RawSqlRef[];
  enums?: RawSqlEnum[];
}

export interface RawSqlTable {
  name: string;
  schemaName?: string | null;
  fields?: RawSqlField[];
  indexes?: RawSqlIndex[];
  checks?: RawSqlCheck[];
  note?: string | { value?: string } | null;
}

export interface RawSqlField {
  name: string;
  type?: { type_name?: string; schemaName?: string | null };
  pk?: boolean;
  unique?: boolean;
  not_null?: boolean;
  increment?: boolean;
  dbdefault?: { type?: string; value?: unknown } | null;
  note?: string | { value?: string } | null;
  checks?: RawSqlCheck[];
}

export interface RawSqlIndex {
  name?: string;
  pk?: boolean;
  unique?: boolean;
  columns?: Array<{ value: string; type?: string }>;
}

export interface RawSqlCheck {
  expression?: string;
  name?: string;
}

export interface RawSqlRef {
  name?: string | null;
  endpoints?: Array<{ tableName: string; schemaName?: string | null; fieldNames?: string[] | null; relation?: string }>;
}

export interface RawSqlEnum {
  name: string;
  schemaName?: string | null;
  values?: Array<{ name: string; note?: string | { value?: string } | null }>;
}

// ---------------------------------------------------------------------------
// Dialect detection
// ---------------------------------------------------------------------------

/** Signals per dialect: [pattern, weight]. Strong signals weigh 3, hints 1. */
const DIALECT_SIGNALS: ReadonlyArray<[SqlDialect, RegExp, number]> = [
  ['sqlserver', /^[ \t]*GO[ \t]*$/im, 3],
  ['sqlserver', /\[\w+\]\s*\.\s*\[\w+\]/, 3],
  ['sqlserver', /\bsp_addextendedproperty\b/i, 3],
  ['sqlserver', /\bIDENTITY\s*\(\s*\d+\s*,\s*\d+\s*\)/i, 2],
  ['sqlserver', /\bNVARCHAR\b|\bCLUSTERED\b|\bON\s+\[PRIMARY\]/i, 1],
  ['databricks', /\bUSING\s+(DELTA|PARQUET|ICEBERG|CSV|JSON|ORC|AVRO)\b/i, 3],
  ['databricks', /\bTBLPROPERTIES\b/i, 3],
  ['databricks', /\b(ARRAY|MAP|STRUCT)\s*</i, 3],
  ['databricks', /\bPARTITIONED\s+BY\b|\bZORDER\b/i, 1],
  ['databricks', /`[^`\n]+`[\s\S]*\bSTRING\b/i, 2],
  ['mysql', /\bENGINE\s*=/i, 3],
  ['mysql', /\bAUTO_INCREMENT\b/i, 3],
  ['mysql', /`/, 1],
  ['snowflake', /\bCREATE\s+OR\s+REPLACE\s+TRANSIENT\b|\bTRANSIENT\s+TABLE\b/i, 3],
  ['snowflake', /\bVARIANT\b/i, 3],
  ['snowflake', /\bNUMBER\s*\(\s*38\b|\bVARCHAR\s*\(\s*16777216\s*\)/i, 3],
  ['snowflake', /\bCREATE\s+OR\s+REPLACE\s+TABLE\b|\bTIMESTAMP_(NTZ|LTZ|TZ)\b/i, 1],
  ['postgres', /\b(BIG|SMALL)?SERIAL\b/i, 3],
  ['postgres', /::\s*\w/, 3],
  ['postgres', /\bTIMESTAMPTZ\b|\bJSONB\b|\$\$/i, 3],
  ['postgres', /\bTEXT\b|\bCOMMENT\s+ON\b/i, 1],
];

/** Each dialect's score from the text's signals (comments ignored). Never parses. */
function dialectScores(text: string): Map<SqlDialect, number> {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
  const scores = new Map<SqlDialect, number>();
  for (const [dialect, pattern, weight] of DIALECT_SIGNALS) {
    if (pattern.test(code)) scores.set(dialect, (scores.get(dialect) ?? 0) + weight);
  }
  return scores;
}

/**
 * A cheap guess at the dialect from the text (comments ignored), for the
 * picker's default; undefined when nothing points anywhere. Never parses.
 */
export function detectSqlDialect(text: string): SqlDialect | undefined {
  const scores = dialectScores(text);
  let best: SqlDialect | undefined;
  let bestScore = 0;
  let tie = false;
  for (const dialect of SQL_DIALECTS) {
    const score = scores.get(dialect) ?? 0;
    if (score > bestScore) { best = dialect; bestScore = score; tie = false; }
    else if (score > 0 && score === bestScore) tie = true;
  }
  return tie ? undefined : best;
}

/**
 * The order to try dialects in when the text does not decide one (the quick
 * import reads the scripts as each in turn and keeps the first that reads
 * every file): the most widely used first. Plain ANSI CREATE TABLEs read the
 * same in most of them.
 */
export const SQL_DIALECT_LIKELIHOOD: readonly SqlDialect[] = Object.freeze(['postgres', 'sqlserver', 'mysql', 'snowflake', 'databricks']);

/** Every dialect, most likely first: the text's signals, highest first, then {@link SQL_DIALECT_LIKELIHOOD}. Never parses. */
export function rankSqlDialects(text: string): SqlDialect[] {
  const scores = dialectScores(text);
  const rank = (d: SqlDialect): number => SQL_DIALECT_LIKELIHOOD.indexOf(d);
  return [...SQL_DIALECTS].sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0) || rank(a) - rank(b));
}

// ---------------------------------------------------------------------------
// Tokenizer and statement splitter
// ---------------------------------------------------------------------------

type TokenKind = 'word' | 'ident' | 'string' | 'number' | 'punct';

interface Token {
  kind: TokenKind;
  /** A word as written; a quoted identifier or string without its quotes. */
  value: string;
  start: number;
  end: number;
  /** 1-based line of the token's first character. */
  line: number;
}

interface Statement {
  tokens: Token[];
  start: number;
  end: number;
  line: number;
}

/** Dialects whose '…' strings take backslash escapes (`'it\'s'`). */
const BACKSLASH_ESCAPES: ReadonlySet<SqlDialect> = new Set<SqlDialect>(['mysql', 'databricks', 'snowflake']);

/** Words that start a statement when they open a line outside any parentheses. */
const STATEMENT_KEYWORDS = new Set(['CREATE', 'ALTER', 'DROP', 'INSERT', 'GRANT', 'REVOKE', 'EXEC', 'EXECUTE', 'USE', 'TRUNCATE']);

function tokenize(text: string, dialect: SqlDialect): Token[] {
  const tokens: Token[] = [];
  const n = text.length;
  let i = 0;
  let line = 1;
  const advanceLines = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (text.charCodeAt(k) === 10) line++;
  };
  while (i < n) {
    const c = text[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v' || c === '\u00a0' || c === '\ufeff') { i++; continue; }
    // Comments.
    if (c === '-' && text[i + 1] === '-') { while (i < n && text[i] !== '\n') i++; continue; }
    if (c === '#' && dialect === 'mysql') { while (i < n && text[i] !== '\n') i++; continue; }
    if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      const stop = close < 0 ? n : close + 2;
      advanceLines(i, stop);
      i = stop;
      continue;
    }
    const start = i;
    const startLine = line;
    // Strings: '…' (and N'…' / E'…' prefixes, read as words followed by a string).
    if (c === "'") {
      let value = '';
      i++;
      while (i < n) {
        const ch = text[i];
        if (ch === '\\' && BACKSLASH_ESCAPES.has(dialect) && i + 1 < n) { value += unescapeChar(text[i + 1]); i += 2; continue; }
        if (ch === "'") {
          if (text[i + 1] === "'") { value += "'"; i += 2; continue; }
          i++;
          break;
        }
        value += ch;
        i++;
      }
      advanceLines(start, i);
      tokens.push({ kind: 'string', value, start, end: i, line: startLine });
      continue;
    }
    // Dollar-quoted bodies ($$ … $$, $tag$ … $tag$): one string token.
    if (c === '$') {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i, i + 64));
      if (tag) {
        const close = text.indexOf(tag[0], i + tag[0].length);
        const stop = close < 0 ? n : close + tag[0].length;
        advanceLines(i, stop);
        tokens.push({ kind: 'string', value: text.slice(i + tag[0].length, close < 0 ? n : close), start, end: stop, line: startLine });
        i = stop;
        continue;
      }
    }
    // Quoted identifiers.
    if (c === '"' || c === '`' || c === '[') {
      const closeChar = c === '[' ? ']' : c;
      let value = '';
      i++;
      while (i < n) {
        if (text[i] === closeChar) {
          if (text[i + 1] === closeChar) { value += closeChar; i += 2; continue; }
          i++;
          break;
        }
        value += text[i];
        i++;
      }
      advanceLines(start, i);
      tokens.push({ kind: 'ident', value, start, end: i, line: startLine });
      continue;
    }
    if (/[A-Za-z_\u0080-\uffff]/.test(c)) {
      while (i < n && /[A-Za-z0-9_$@#\u0080-\uffff]/.test(text[i])) i++;
      tokens.push({ kind: 'word', value: text.slice(start, i), start, end: i, line: startLine });
      continue;
    }
    if (c === '@') {
      i++;
      while (i < n && /[A-Za-z0-9_@$#]/.test(text[i])) i++;
      tokens.push({ kind: 'word', value: text.slice(start, i), start, end: i, line: startLine });
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(text[i + 1] ?? ''))) {
      while (i < n && /[0-9.eE]/.test(text[i])) i++;
      tokens.push({ kind: 'number', value: text.slice(start, i), start, end: i, line: startLine });
      continue;
    }
    if (c === ':' && text[i + 1] === ':') {
      tokens.push({ kind: 'punct', value: '::', start, end: i + 2, line: startLine });
      i += 2;
      continue;
    }
    tokens.push({ kind: 'punct', value: c, start, end: i + 1, line: startLine });
    i++;
  }
  return tokens;
}

function unescapeChar(ch: string): string {
  switch (ch) {
    case 'n': return '\n';
    case 't': return '\t';
    case 'r': return '\r';
    case '0': return '';
    default: return ch;
  }
}

/** SQL Server's batch separator: `GO` (optionally a count) alone on its line. */
const GO_LINE = /^[ \t]*GO(?:[ \t]+\d+)?[ \t]*;?[ \t]*$/i;

function splitStatements(text: string, dialect: SqlDialect): Statement[] {
  const tokens = tokenize(text, dialect);
  const goLines = new Set<number>();
  if (dialect === 'sqlserver') {
    text.split('\n').forEach((lineText, index) => { if (GO_LINE.test(lineText)) goLines.add(index + 1); });
  }
  const statements: Statement[] = [];
  let current: Token[] = [];
  let depth = 0;
  const flush = (): void => {
    if (current.length) {
      statements.push({ tokens: current, start: current[0].start, end: current[current.length - 1].end, line: current[0].line });
    }
    current = [];
    depth = 0;
  };
  let lastLine = 0;
  for (const token of tokens) {
    if (goLines.has(token.line) && token.kind === 'word' && /^GO$/i.test(token.value)) { flush(); continue; }
    if (goLines.has(token.line) && token.kind === 'number' && current.length === 0) continue;
    if (token.kind === 'punct' && token.value === ';' && depth <= 0) { flush(); lastLine = token.line; continue; }
    const startsLine = token.line !== lastLine;
    if (
      current.length && depth <= 0 && startsLine && token.kind === 'word' && isLineStart(text, token.start) &&
      STATEMENT_KEYWORDS.has(token.value.toUpperCase())
    ) {
      flush();
    }
    if (token.kind === 'punct' && token.value === '(') depth++;
    if (token.kind === 'punct' && token.value === ')') depth--;
    current.push(token);
    lastLine = token.line;
  }
  flush();
  return statements;
}

/** Whether only spaces precede `offset` on its line. */
function isLineStart(text: string, offset: number): boolean {
  for (let k = offset - 1; k >= 0; k--) {
    const ch = text[k];
    if (ch === '\n') return true;
    if (ch !== ' ' && ch !== '\t' && ch !== '\r') return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

const upper = (t: Token | undefined): string => (t && t.kind === 'word' ? t.value.toUpperCase() : '');
const isPunct = (t: Token | undefined, p: string): boolean => !!t && t.kind === 'punct' && t.value === p;
const isName = (t: Token | undefined): boolean => !!t && (t.kind === 'word' || t.kind === 'ident');

/** A dotted name from `i` (`a`, `a.b`, `[a].[b].[c]`); its parts, and the index after it. */
function readName(tokens: Token[], i: number): { parts: string[]; next: number; first: number } | undefined {
  if (!isName(tokens[i])) return undefined;
  const first = i;
  const parts = [tokens[i].value];
  i++;
  while (isPunct(tokens[i], '.') && isName(tokens[i + 1])) {
    parts.push(tokens[i + 1].value);
    i += 2;
  }
  // `a..b` (SQL Server's default-schema shorthand).
  while (isPunct(tokens[i], '.') && isPunct(tokens[i + 1], '.') && isName(tokens[i + 2])) {
    parts.push(tokens[i + 2].value);
    i += 3;
  }
  return { parts, next: i, first };
}

/** The index of the `)` closing the `(` at `open`, or -1. */
function matchParen(tokens: Token[], open: number): number {
  let depth = 0;
  for (let k = open; k < tokens.length; k++) {
    if (isPunct(tokens[k], '(')) depth++;
    else if (isPunct(tokens[k], ')')) { depth--; if (depth === 0) return k; }
  }
  return -1;
}

/** `(a, b DESC, [c])` from `open`: the names, and the index after `)`. */
function readColumnList(tokens: Token[], open: number): { columns: string[]; next: number } | undefined {
  if (!isPunct(tokens[open], '(')) return undefined;
  const close = matchParen(tokens, open);
  if (close < 0) return undefined;
  const columns: string[] = [];
  let expectName = true;
  for (let k = open + 1; k < close; k++) {
    const t = tokens[k];
    if (isPunct(t, ',')) { expectName = true; continue; }
    if (expectName && isName(t)) { columns.push(t.value); expectName = false; }
  }
  return { columns, next: close + 1 };
}

/** Split `[from, to)` at commas outside parentheses (and, when `angles`, outside `<…>`). */
function splitTopLevel(tokens: Token[], from: number, to: number, angles = false): Array<[number, number]> {
  const parts: Array<[number, number]> = [];
  let depth = 0;
  let angle = 0;
  let start = from;
  for (let k = from; k < to; k++) {
    const t = tokens[k];
    if (isPunct(t, '(')) depth++;
    else if (isPunct(t, ')')) depth--;
    else if (angles && depth === 0 && isPunct(t, '<')) angle++;
    else if (angles && depth === 0 && isPunct(t, '>') && angle > 0) angle--;
    else if (depth === 0 && angle === 0 && isPunct(t, ',')) { parts.push([start, k]); start = k + 1; }
  }
  if (start < to) parts.push([start, to]);
  return parts;
}

// ---------------------------------------------------------------------------
// The merged model
// ---------------------------------------------------------------------------

interface Origin { file: string; line: number }

interface ModelField {
  name: string;
  type: string;
  pk: boolean;
  unique: boolean;
  notNull: boolean;
  increment: boolean;
  default?: { type: 'number' | 'string' | 'boolean' | 'expression' | 'null'; value: string };
  note?: string;
  checks: string[];
}

interface ModelTable {
  name: string;
  schema: string | null;
  fields: ModelField[];
  /** Composite primary key columns (a single-column key is the field's `pk`). */
  primaryKey?: string[];
  uniques: string[][];
  checks: Array<{ expression: string; name?: string }>;
  note?: string;
  alias?: string;
  origin: Origin;
}

interface ModelEnum {
  name: string;
  schema: string | null;
  values: Array<{ name: string; note?: string }>;
  origin: Origin;
}

interface PendingRef {
  /** The FK side, as named in the SQL. */
  from: { parts: string[]; columns: string[] };
  /** The referenced side; no columns means its primary key. */
  to: { parts: string[]; columns: string[] };
  origin: Origin;
  /** The FK table itself, when the ref came from inside its CREATE TABLE. */
  fromTable?: ModelTable;
}

interface PendingComment {
  table: string[];
  column?: string;
  text: string;
  origin: Origin;
}

interface PendingKey {
  table: string[];
  kind: 'pk' | 'unique';
  columns: string[];
  origin: Origin;
}

/** Statement kinds that are skipped, with the phrase a summary line uses. */
const SKIP_LABELS = {
  view: ['view', 'views'],
  index: ['index', 'indexes'],
  plainIndex: ['non-unique index inside a table (indexes are not imported)', 'non-unique indexes inside tables (indexes are not imported)'],
  data: ['data statement (INSERT, UPDATE…)', 'data statements (INSERT, UPDATE…)'],
  grant: ['permission statement (GRANT, REVOKE)', 'permission statements (GRANT, REVOKE)'],
  routine: ['function, procedure or trigger', 'functions, procedures or triggers'],
  sequence: ['sequence', 'sequences'],
  schema: ['schema or database statement', 'schema or database statements'],
  session: ['session statement (SET, USE…)', 'session statements (SET, USE…)'],
  drop: ['DROP statement', 'DROP statements'],
  query: ['query', 'queries'],
  ctas: ['CREATE TABLE without a column list (AS SELECT, LIKE, CLONE)', 'CREATE TABLEs without a column list (AS SELECT, LIKE, CLONE)'],
  alter: ['ALTER TABLE other than adding a key', 'ALTER TABLEs other than adding a key'],
  comment: ['comment on something other than a table or column', 'comments on something other than a table or column'],
  type: ['type other than an enum', 'types other than enums'],
  other: ['other statement', 'other statements'],
} as const;
type SkipKind = keyof typeof SKIP_LABELS;

const DEFAULT_SCHEMA: Readonly<Record<SqlDialect, string | null>> = {
  postgres: 'public',
  mysql: null,
  sqlserver: 'dbo',
  snowflake: 'public',
  databricks: 'default',
};

class Converter {
  readonly tables: ModelTable[] = [];
  readonly enums: ModelEnum[] = [];
  readonly refs: PendingRef[] = [];
  readonly comments: PendingComment[] = [];
  readonly keys: PendingKey[] = [];
  readonly problems: SqlDdlProblem[] = [];
  readonly skippedLines: string[] = [];
  readonly notes: string[] = [];
  private readonly skippedByFile = new Map<string, Map<SkipKind, number>>();
  private placeholderCount = 0;

  constructor(private readonly dialect: SqlDialect, private readonly engine: SqlParseEngine) {}

  skip(file: string, kind: SkipKind, count = 1): void {
    let byKind = this.skippedByFile.get(file);
    if (!byKind) { byKind = new Map(); this.skippedByFile.set(file, byKind); }
    byKind.set(kind, (byKind.get(kind) ?? 0) + count);
  }

  skippedSummary(fileOrder: readonly string[]): string[] {
    const lines: string[] = [];
    for (const file of fileOrder) {
      const byKind = this.skippedByFile.get(file);
      if (!byKind || byKind.size === 0) continue;
      const parts = [...byKind].map(([kind, count]) => `${count} ${SKIP_LABELS[kind][count === 1 ? 0 : 1]}`);
      lines.push(`${file}: skipped ${parts.join(', ')}`);
    }
    return lines;
  }

  // -- files ---------------------------------------------------------------

  /** Reads one file; how many tables, enums, foreign keys, keys and comments it gave. */
  readFile(file: SqlDdlFile): number {
    const count = (): number => this.tables.length + this.enums.length + this.refs.length + this.keys.length + this.comments.length;
    const before = count();
    const text = file.text.replace(/^\ufeff/, '');
    for (const statement of splitStatements(text, this.dialect)) {
      this.readStatement(file.name, text, statement);
    }
    return count() - before;
  }

  private readStatement(file: string, text: string, st: Statement): void {
    const t = st.tokens;
    const origin: Origin = { file, line: st.line };
    const w0 = upper(t[0]);
    switch (w0) {
      case 'CREATE': return this.readCreate(file, text, st);
      case 'ALTER': return upper(t[1]) === 'TABLE' ? this.readAlterTable(st, origin) : this.skip(file, 'other');
      case 'COMMENT': return upper(t[1]) === 'ON' ? this.readCommentOn(st, origin) : this.skip(file, 'other');
      case 'EXEC': case 'EXECUTE': return this.readExec(st, origin);
      case 'INSERT': case 'UPDATE': case 'DELETE': case 'MERGE': case 'COPY': case 'TRUNCATE': case 'UPSERT':
        return this.skip(file, 'data');
      case 'GRANT': case 'REVOKE': case 'DENY': return this.skip(file, 'grant');
      case 'SET': case 'USE': case 'BEGIN': case 'COMMIT': case 'START': case 'END': case 'ROLLBACK': case 'PRINT':
      case 'DECLARE': case 'PRAGMA': case 'LOCK': case 'UNLOCK':
        return this.skip(file, 'session');
      case 'DROP': return this.skip(file, 'drop');
      case 'SELECT': case 'WITH': case 'SHOW': case 'DESCRIBE': case 'EXPLAIN': return this.skip(file, 'query');
      default: return this.skip(file, 'other');
    }
  }

  private readCreate(file: string, text: string, st: Statement): void {
    const t = st.tokens;
    let i = 1;
    // OR REPLACE, TEMPORARY, TRANSIENT, UNIQUE, MATERIALIZED, … before what is created.
    while (i < t.length && t[i].kind === 'word' && !CREATE_OBJECT_WORDS.has(upper(t[i]))) i++;
    const what = upper(t[i]);
    switch (what) {
      case 'TABLE': return this.readCreateTable(file, text, st, i + 1);
      case 'TYPE': return this.readCreateType(file, st, i + 1);
      case 'VIEW': return this.skip(file, 'view');
      case 'INDEX': return this.skip(file, 'index');
      case 'SCHEMA': case 'DATABASE': case 'CATALOG': return this.skip(file, 'schema');
      case 'SEQUENCE': return this.skip(file, 'sequence');
      case 'FUNCTION': case 'PROCEDURE': case 'PROC': case 'TRIGGER': return this.skip(file, 'routine');
      default: return this.skip(file, 'other');
    }
  }

  // -- CREATE TABLE --------------------------------------------------------

  private readCreateTable(file: string, text: string, st: Statement, at: number): void {
    const t = st.tokens;
    let i = at;
    if (upper(t[i]) === 'IF' && upper(t[i + 1]) === 'NOT' && upper(t[i + 2]) === 'EXISTS') i += 3;
    const name = readName(t, i);
    if (!name || !isPunct(t[name.next], '(')) { this.skip(file, 'ctas'); return; }
    const open = name.next;
    const close = matchParen(t, open);
    if (close < 0) {
      this.problems.push({ file, line: st.line, message: `CREATE TABLE ${name.parts.join('.')}: its column list has no closing parenthesis.` });
      return;
    }
    // `CREATE TABLE x (a, b) AS SELECT` names columns without types.
    for (let k = close + 1; k < t.length; k++) {
      if (upper(t[k]) === 'AS' && (upper(t[k + 1]) === 'SELECT' || isPunct(t[k + 1], '(') || upper(t[k + 1]) === 'WITH')) { this.skip(file, 'ctas'); return; }
    }
    const tableName = name.parts[name.parts.length - 1];
    const schema = name.parts.length >= 2 ? name.parts[name.parts.length - 2] : null;
    const label = name.parts.slice(-2).join('.');
    const origin: Origin = { file, line: st.line };

    const prepared = this.dialect === 'databricks'
      ? this.rewriteDatabricksTable(text, st, name, open, close)
      : { sql: text.slice(st.start, st.end), types: new Map<string, string>(), comments: new Map<string, string>(), identity: new Set<string>() };
    const columnSources = readColumnSources(t, open, close, this.dialect === 'databricks');

    let raw: RawSqlDatabase;
    try {
      raw = this.engine(prepared.sql, SQL_PARSE_FORMAT[this.dialect]);
    } catch (error) {
      const diagnostic = firstDiagnostic(error);
      this.problems.push({
        file,
        line: diagnostic.line ? st.line + diagnostic.line - 1 : st.line,
        message: `CREATE TABLE ${label} could not be read: ${diagnostic.message}`,
      });
      return;
    }
    const rawTable = (raw.tables ?? []).find((rt) => sameIdent(rt.name, tableName)) ?? raw.tables?.[0];
    if (!rawTable) {
      this.problems.push({ file, line: st.line, message: `CREATE TABLE ${label} could not be read: the parser found no table in it.` });
      return;
    }
    const table: ModelTable = {
      name: tableName,
      schema,
      fields: [],
      uniques: [],
      checks: [],
      origin,
    };
    const seen = new Set<string>();
    for (const rf of rawTable.fields ?? []) {
      const key = rf.name.toLowerCase();
      if (seen.has(key)) {
        this.problems.push({ file, line: st.line, message: `CREATE TABLE ${label} has the column ${rf.name} twice.` });
        return;
      }
      seen.add(key);
      table.fields.push(this.toField(rf, prepared, text, columnSources.get(key)));
    }
    if (table.fields.length === 0) {
      this.problems.push({ file, line: st.line, message: `CREATE TABLE ${label} has no columns.` });
      return;
    }
    let plainIndexes = 0;
    for (const index of rawTable.indexes ?? []) {
      const columns = (index.columns ?? []).filter((c) => c.type !== 'expression').map((c) => c.value);
      if (index.pk) this.setPrimaryKey(table, columns);
      else if (index.unique && columns.length) this.addUnique(table, columns);
      else plainIndexes++;
    }
    if (plainIndexes) this.skip(file, 'plainIndex', plainIndexes);
    for (const check of rawTable.checks ?? []) {
      if (check.expression) table.checks.push({ expression: check.expression, ...(check.name ? { name: check.name } : {}) });
    }
    table.note = tailComment(t, close + 1) ?? noteText(rawTable.note);
    this.tables.push(table);

    for (const ref of raw.refs ?? []) {
      const ends = ref.endpoints ?? [];
      if (ends.length !== 2) continue;
      const fkIndex = ends[0].relation?.includes('*') ? 0 : ends[1].relation?.includes('*') ? 1 : sameIdent(ends[0].tableName, tableName) ? 0 : 1;
      const fk = ends[fkIndex];
      const pk = ends[1 - fkIndex];
      this.refs.push({
        from: { parts: [...(fk.schemaName ? [fk.schemaName] : []), fk.tableName], columns: fk.fieldNames ?? [] },
        to: { parts: [...(pk.schemaName ? [pk.schemaName] : []), pk.tableName], columns: pk.fieldNames ?? [] },
        origin,
        fromTable: sameIdent(fk.tableName, tableName) ? table : undefined,
      });
    }
    for (const e of raw.enums ?? []) this.addEnum(e, origin);
  }

  private toField(rf: RawSqlField, prepared: PreparedSql, text: string, source: ColumnSource | undefined): ModelField {
    const parsedType = rf.type?.type_name ?? '';
    let type = prepared.types.get(parsedType) ?? (source ? spacedAsWritten(parsedType, text, source.typeOffset) : parsedType);
    let increment = !!rf.increment || prepared.identity.has(rf.name.toLowerCase());
    // SQL Server's grammar leaves `IDENTITY(1,1)` in the type text.
    const identity = /\s+IDENTITY\s*(\([^)]*\))?\s*$/i.exec(type);
    if (identity) { type = type.slice(0, identity.index); increment = true; }
    type = type.replace(/\s+/g, ' ').trim();
    if (rf.type?.schemaName) type = `${rf.type.schemaName}.${type}`;
    const field: ModelField = {
      name: rf.name,
      type: type || 'unknown',
      pk: !!rf.pk,
      unique: !!rf.unique,
      notNull: !!rf.not_null,
      increment,
      checks: (rf.checks ?? []).map((c) => c.expression ?? '').filter(Boolean),
    };
    // The grammars hand string literals back unevenly ('' and \' left in, or half-read): the tokenizer's reading wins.
    const note = source?.comment ?? prepared.comments.get(rf.name.toLowerCase()) ?? noteText(rf.note);
    if (note) field.note = note;
    const dflt = rf.dbdefault;
    if (dflt && dflt.value !== undefined) {
      const kind = dflt.type === 'number' || dflt.type === 'string' || dflt.type === 'boolean' || dflt.type === 'expression' ? dflt.type : 'expression';
      if (dflt.value === null || (kind !== 'string' && /^null$/i.test(String(dflt.value)))) field.default = { type: 'null', value: 'null' };
      else if (kind === 'string' && source?.stringDefault !== undefined) field.default = { type: kind, value: source.stringDefault };
      else field.default = { type: kind, value: String(dflt.value) };
    }
    return field;
  }

  private addUnique(table: ModelTable, columns: string[]): void {
    const field = columns.length === 1 ? table.fields.find((f) => sameIdent(f.name, columns[0])) : undefined;
    if (field) field.unique = true;
    else table.uniques.push(columns);
  }

  private setPrimaryKey(table: ModelTable, columns: string[]): void {
    if (columns.length === 0) return;
    if (columns.length === 1) {
      const field = table.fields.find((f) => sameIdent(f.name, columns[0]));
      if (field) { field.pk = true; return; }
    }
    table.primaryKey = columns;
  }

  /**
   * Rewrites one Databricks / Spark `CREATE TABLE` for the Postgres grammar,
   * keeping every line break: catalog qualifiers, `OR REPLACE` and the like,
   * Delta clauses after the column list, column `COMMENT`s, computed columns
   * and informational-constraint words go; complex types become placeholder
   * names, restored after the parse.
   */
  private rewriteDatabricksTable(text: string, st: Statement, name: { parts: string[]; next: number; first: number }, open: number, close: number): PreparedSql {
    const t = st.tokens;
    const edits: Array<{ start: number; end: number; text: string }> = [];
    const blank = (from: number, to: number): void => { edits.push({ start: from, end: to, text: '' }); };
    const types = new Map<string, string>();
    const comments = new Map<string, string>();
    const identity = new Set<string>();
    // CREATE [OR REPLACE] [TEMPORARY] [EXTERNAL] TABLE [IF NOT EXISTS] → CREATE TABLE.
    const tableWord = t.findIndex((tok) => upper(tok) === 'TABLE');
    if (tableWord > 1) blank(t[1].start, t[tableWord - 1].end);
    if (upper(t[tableWord + 1]) === 'IF') blank(t[tableWord + 1].start, t[tableWord + 3].end);
    // catalog.schema.table → schema.table.
    const quoteIdents = (from: number, to: number): void => {
      for (let k = from; k < to; k++) if (t[k].kind === 'ident') edits.push({ start: t[k].start, end: t[k].end, text: quoteIdent(t[k].value) });
    };
    const dropCatalog = (nameStart: number, parts: number): void => {
      if (parts > 2) blank(t[nameStart].start, t[nameStart + 2 * (parts - 2) - 1].end);
    };
    dropCatalog(name.first, name.parts.length);
    quoteIdents(name.first, name.next);
    // The column list.
    for (const [from, to] of splitTopLevel(t, open + 1, close, true)) {
      const head = upper(t[from]);
      if (head === 'CONSTRAINT' || head === 'PRIMARY' || head === 'FOREIGN' || head === 'UNIQUE' || head === 'CHECK') {
        for (let k = from; k < to; k++) {
          const word = upper(t[k]);
          if (word === 'RELY' || word === 'NORELY' || word === 'ENFORCED' || word === 'TIMESERIES') blank(t[k].start, t[k].end);
          else if (word === 'NOT' && upper(t[k + 1]) === 'ENFORCED') blank(t[k].start, t[k].end);
          else if (word === 'REFERENCES') {
            const ref = readName(t, k + 1);
            if (ref) { dropCatalog(k + 1, ref.parts.length); }
          }
        }
        quoteIdents(from, to);
        continue;
      }
      // A column: name, type, then constraints.
      if (!isName(t[from])) continue;
      const columnName = t[from].value;
      let k = from + 1;
      const typeStart = k;
      let depth = 0;
      let angle = 0;
      for (; k < to; k++) {
        const tok = t[k];
        if (isPunct(tok, '(')) depth++;
        else if (isPunct(tok, ')')) depth--;
        else if (depth === 0 && isPunct(tok, '<')) angle++;
        else if (depth === 0 && isPunct(tok, '>')) angle--;
        else if (depth === 0 && angle === 0 && COLUMN_CONSTRAINT_WORDS.has(upper(tok))) break;
      }
      const typeEnd = k;
      if (typeEnd > typeStart) {
        const typeText = text.slice(t[typeStart].start, t[typeEnd - 1].end);
        if (/[<>:]/.test(typeText)) {
          const placeholder = `erd_sql_type_${this.placeholderCount++}`;
          types.set(placeholder, typeText.replace(/\s+/g, ' ').replace(/\s*([<>,:])\s*/g, (_m, p: string) => (p === ',' || p === ':' ? `${p} ` : p)).trim());
          edits.push({ start: t[typeStart].start, end: t[typeEnd - 1].end, text: placeholder });
        }
      }
      quoteIdents(from, from + 1);
      // Constraints.
      for (; k < to; k++) {
        const word = upper(t[k]);
        if (word === 'COMMENT' && t[k + 1]?.kind === 'string') {
          comments.set(columnName.toLowerCase(), t[k + 1].value);
          blank(t[k].start, t[k + 1].end);
          k++;
        } else if (word === 'GENERATED') {
          // GENERATED { ALWAYS | BY DEFAULT } AS IDENTITY [(…)] stays (Postgres reads it);
          // GENERATED ALWAYS AS (expr) — a computed column — goes.
          let a = k + 1;
          while (a < to && upper(t[a]) !== 'AS') a++;
          if (upper(t[a + 1]) === 'IDENTITY') {
            identity.add(columnName.toLowerCase());
            let end = a + 1;
            if (isPunct(t[end + 1], '(')) end = matchParen(t, end + 1);
            blank(t[k].start, t[end].end);
            k = end;
          } else if (isPunct(t[a + 1], '(')) {
            const end = matchParen(t, a + 1);
            blank(t[k].start, t[end].end);
            k = end;
          }
        } else if (word === 'MASK') {
          blank(t[k].start, t[to - 1].end);
          break;
        } else if (word === 'REFERENCES') {
          const ref = readName(t, k + 1);
          if (ref) dropCatalog(k + 1, ref.parts.length);
          quoteIdents(k + 1, to);
        }
      }
    }
    // Spark strings take backslash escapes; Postgres reads only ''. (Line breaks come back from applyEdits.)
    for (let k = open + 1; k < close; k++) {
      if (t[k].kind === 'string') edits.push({ start: t[k].start, end: t[k].end, text: `'${t[k].value.replace(/'/g, "''").replace(/\n/g, ' ')}'` });
    }
    // Everything after the column list (USING, PARTITIONED BY, CLUSTER BY, LOCATION, OPTIONS, COMMENT, TBLPROPERTIES).
    if (close + 1 < t.length) blank(t[close + 1].start, t[t.length - 1].end);
    return { sql: applyEdits(text, st.start, st.end, edits), types, comments, identity };
  }

  // -- CREATE TYPE … AS ENUM -------------------------------------------------

  private readCreateType(file: string, st: Statement, at: number): void {
    const t = st.tokens;
    const name = readName(t, at);
    if (!name || upper(t[name.next]) !== 'AS' || upper(t[name.next + 1]) !== 'ENUM') { this.skip(file, 'type'); return; }
    const origin: Origin = { file, line: st.line };
    const list = readStringList(t, name.next + 2);
    if (!list) {
      this.problems.push({ file, line: st.line, message: `CREATE TYPE ${name.parts.join('.')} AS ENUM has no value list.` });
      return;
    }
    this.addEnum({
      name: name.parts[name.parts.length - 1],
      schemaName: name.parts.length >= 2 ? name.parts[name.parts.length - 2] : null,
      values: list.map((v) => ({ name: v })),
    }, origin);
  }

  private addEnum(e: RawSqlEnum, origin: Origin): void {
    const schema = e.schemaName ?? null;
    if (this.enums.some((x) => sameIdent(x.name, e.name) && sameSchema(x.schema, schema, this.dialect))) return;
    const values = (e.values ?? []).map((v) => {
      const note = noteText(v.note);
      return note ? { name: v.name, note } : { name: v.name };
    });
    if (values.length) this.enums.push({ name: e.name, schema, values, origin });
  }

  // -- ALTER TABLE, COMMENT ON, sp_addextendedproperty ----------------------

  private readAlterTable(st: Statement, origin: Origin): void {
    const t = st.tokens;
    let i = 2;
    while (upper(t[i]) === 'ONLY' || (upper(t[i]) === 'IF' && upper(t[i + 1]) === 'EXISTS')) i += upper(t[i]) === 'IF' ? 2 : 1;
    const name = readName(t, i);
    if (!name) { this.skip(origin.file, 'alter'); return; }
    let added = 0;
    let checkOnly = false;
    for (const [from, to] of splitTopLevel(t, name.next, t.length)) {
      let k = from;
      if (upper(t[k]) === 'WITH' && (upper(t[k + 1]) === 'CHECK' || upper(t[k + 1]) === 'NOCHECK')) k += 2;
      if ((upper(t[k]) === 'CHECK' || upper(t[k]) === 'NOCHECK') && upper(t[k + 1]) === 'CONSTRAINT') { checkOnly = true; continue; }
      if (upper(t[k]) !== 'ADD') continue;
      k++;
      if (upper(t[k]) === 'CONSTRAINT') k += 2;
      const kind = upper(t[k]);
      if (kind === 'FOREIGN' && upper(t[k + 1]) === 'KEY') {
        const fkCols = readColumnList(t, k + 2);
        if (!fkCols || upper(t[fkCols.next]) !== 'REFERENCES') continue;
        const target = readName(t, fkCols.next + 1);
        if (!target) continue;
        const pkCols = isPunct(t[target.next], '(') ? readColumnList(t, target.next) : undefined;
        this.refs.push({
          from: { parts: name.parts, columns: fkCols.columns },
          to: { parts: target.parts, columns: pkCols?.columns ?? [] },
          origin: { file: origin.file, line: t[from].line },
        });
        added++;
      } else if (kind === 'PRIMARY' && upper(t[k + 1]) === 'KEY') {
        let open = k + 2;
        while (t[open] && !isPunct(t[open], '(') && open < to) open++;
        const cols = readColumnList(t, open);
        if (cols) { this.keys.push({ table: name.parts, kind: 'pk', columns: cols.columns, origin }); added++; }
      } else if (kind === 'UNIQUE') {
        let open = k + 1;
        while (t[open] && !isPunct(t[open], '(') && open < to) open++;
        const cols = readColumnList(t, open);
        if (cols) { this.keys.push({ table: name.parts, kind: 'unique', columns: cols.columns, origin }); added++; }
      }
    }
    // `ALTER TABLE x CHECK CONSTRAINT fk` only re-enables a key SQL Server just added: nothing to say.
    if (!added && !checkOnly) this.skip(origin.file, 'alter');
  }

  private readCommentOn(st: Statement, origin: Origin): void {
    const t = st.tokens;
    const object = upper(t[2]);
    if (object !== 'TABLE' && object !== 'COLUMN') { this.skip(origin.file, 'comment'); return; }
    const name = readName(t, 3);
    if (!name || upper(t[name.next]) !== 'IS') { this.skip(origin.file, 'comment'); return; }
    const value = t[name.next + 1];
    if (!value || value.kind !== 'string') return; // IS NULL clears a comment.
    if (object === 'TABLE') this.comments.push({ table: name.parts, text: value.value, origin });
    else if (name.parts.length >= 2) this.comments.push({ table: name.parts.slice(0, -1), column: name.parts[name.parts.length - 1], text: value.value, origin });
  }

  private readExec(st: Statement, origin: Origin): void {
    const t = st.tokens;
    const proc = readName(t, 1);
    if (!proc || proc.parts[proc.parts.length - 1].toLowerCase() !== 'sp_addextendedproperty') { this.skip(origin.file, 'routine'); return; }
    // Named (@name = N'…') or positional arguments.
    const positional = ['@name', '@value', '@level0type', '@level0name', '@level1type', '@level1name', '@level2type', '@level2name'];
    const args = new Map<string, string>();
    let position = 0;
    for (const [from, to] of splitTopLevel(t, proc.next, t.length)) {
      let k = from;
      let key = positional[position];
      if (t[k]?.kind === 'word' && t[k].value.startsWith('@') && isPunct(t[k + 1], '=')) { key = t[k].value.toLowerCase(); k += 2; }
      if (upper(t[k]) === 'N' && t[k + 1]?.kind === 'string') k++;
      if (t[k]?.kind === 'string' && k < to && key) args.set(key, t[k].value);
      position++;
    }
    if ((args.get('@name') ?? '').toLowerCase() !== 'ms_description') { this.skip(origin.file, 'routine'); return; }
    const text = args.get('@value');
    const level1 = (args.get('@level1type') ?? '').toUpperCase();
    if (!text || level1 !== 'TABLE' || !args.get('@level1name')) { this.skip(origin.file, 'comment'); return; }
    const table = [...(args.get('@level0name') ? [args.get('@level0name') as string] : []), args.get('@level1name') as string];
    const level2 = (args.get('@level2type') ?? '').toUpperCase();
    if (level2 === 'COLUMN' && args.get('@level2name')) this.comments.push({ table, column: args.get('@level2name'), text, origin });
    else if (!level2) this.comments.push({ table, text, origin });
    else this.skip(origin.file, 'comment');
  }

  // -- merging ---------------------------------------------------------------

  findTable(parts: readonly string[]): ModelTable | undefined {
    const name = parts[parts.length - 1];
    const schema = parts.length >= 2 ? parts[parts.length - 2] : null;
    const candidates = this.tables.filter((tb) => sameIdent(tb.name, name));
    if (schema !== null) return candidates.find((tb) => sameSchema(tb.schema, schema, this.dialect));
    if (candidates.length === 1) return candidates[0];
    return candidates.find((tb) => sameSchema(tb.schema, null, this.dialect));
  }

  checkDuplicates(): void {
    for (let a = 0; a < this.tables.length; a++) {
      for (let b = 0; b < a; b++) {
        const x = this.tables[a];
        const y = this.tables[b];
        if (sameIdent(x.name, y.name) && sameSchema(x.schema, y.schema, this.dialect)) {
          this.problems.push({
            file: x.origin.file,
            line: x.origin.line,
            message: `Table ${tableLabel(x)} is defined twice (also in ${y.origin.file}, line ${y.origin.line}).`,
          });
          break;
        }
      }
    }
  }

  applyDeferred(): void {
    for (const key of this.keys) {
      const table = this.findTable(key.table);
      if (!table) { this.skippedLines.push(`${key.origin.file} line ${key.origin.line}: a key on ${key.table.join('.')}, which is not in the files`); continue; }
      const columns = key.columns.map((c) => table.fields.find((f) => sameIdent(f.name, c))?.name);
      if (columns.some((c) => !c)) { this.skippedLines.push(`${key.origin.file} line ${key.origin.line}: a key on ${tableLabel(table)} names a column it does not have`); continue; }
      if (key.kind === 'pk') this.setPrimaryKey(table, columns as string[]);
      else this.addUnique(table, columns as string[]);
    }
    for (const comment of this.comments) {
      const table = this.findTable(comment.table);
      if (!table) { this.skippedLines.push(`${comment.origin.file} line ${comment.origin.line}: a comment on ${comment.table.join('.')}, which is not in the files`); continue; }
      if (!comment.column) { table.note = comment.text; continue; }
      const field = table.fields.find((f) => sameIdent(f.name, comment.column as string));
      if (!field) { this.skippedLines.push(`${comment.origin.file} line ${comment.origin.line}: a comment on ${tableLabel(table)}.${comment.column}, which is not one of its columns`); continue; }
      field.note = comment.text;
    }
  }

  /** The refs to write, resolved and de-duplicated. */
  resolveRefs(): Array<{ from: ModelTable; fromColumns: string[]; to: ModelTable; toColumns: string[] }> {
    const out: Array<{ from: ModelTable; fromColumns: string[]; to: ModelTable; toColumns: string[] }> = [];
    const seen = new Set<string>();
    for (const ref of this.refs) {
      const where = `${ref.origin.file} line ${ref.origin.line}`;
      const fkLabel = `${ref.from.parts.slice(-2).join('.')}(${ref.from.columns.join(', ')})`;
      const from = ref.fromTable ?? this.findTable(ref.from.parts);
      const to = this.findTable(ref.to.parts);
      if (!from) { this.skippedLines.push(`${where}: foreign key ${fkLabel}: ${ref.from.parts.slice(-2).join('.')} is not in the files`); continue; }
      if (!to) { this.skippedLines.push(`${where}: foreign key ${fkLabel} → ${ref.to.parts.slice(-2).join('.')}: that table is not in the files`); continue; }
      const fromColumns = ref.from.columns.map((c) => from.fields.find((f) => sameIdent(f.name, c))?.name);
      let targetColumns = ref.to.columns;
      if (targetColumns.length === 0) targetColumns = primaryKeyOf(to);
      const toColumns = targetColumns.map((c) => to.fields.find((f) => sameIdent(f.name, c))?.name);
      if (fromColumns.length === 0 || fromColumns.some((c) => !c) || toColumns.some((c) => !c)) {
        this.skippedLines.push(`${where}: foreign key ${fkLabel} → ${tableLabel(to)}: a column it names is not in the table`);
        continue;
      }
      if (fromColumns.length !== toColumns.length) {
        this.skippedLines.push(`${where}: foreign key ${fkLabel} → ${tableLabel(to)}: ${fromColumns.length} column(s) reference ${toColumns.length}`);
        continue;
      }
      const key = [tableKey(from, this.dialect), ...fromColumns.map((c) => (c as string).toLowerCase()), '>', tableKey(to, this.dialect), ...toColumns.map((c) => (c as string).toLowerCase())].join('\u0000');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ from, fromColumns: fromColumns as string[], to, toColumns: toColumns as string[] });
    }
    return out;
  }

  /** Makes every table and schema name one ERD Studio accepts; says what changed. */
  sanitiseNames(): void {
    const keyOf = (schema: string | null, name: string): string => `${(schema ?? '').toLowerCase()}.${name.toLowerCase()}`;
    for (const table of this.tables) {
      if (table.schema === null || /^[A-Za-z0-9_]+$/.test(table.schema)) continue;
      const schema = table.schema.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'schema';
      if (!this.notes.some((n) => n.startsWith(`Schema "${table.schema}"`))) {
        this.notes.push(`Schema "${table.schema}" is imported as ${schema}: schema names use letters, digits and underscores.`);
      }
      table.schema = schema;
    }
    // Valid names first, so a renamed table never takes a name the files already use.
    const used = new Set(this.tables.filter((tb) => TABLE_NAME_PATTERN.test(tb.name)).map((tb) => keyOf(tb.schema, tb.name)));
    for (const table of this.tables) {
      const original = table.name;
      if (TABLE_NAME_PATTERN.test(original)) continue;
      const base = sanitiseTableName(original);
      let name = base;
      for (let n = 2; used.has(keyOf(table.schema, name)); n++) name = `${base}_${n}`;
      used.add(keyOf(table.schema, name));
      if (isWarehouseName(original)) table.alias = original;
      this.notes.push(
        `Table "${original}" (${table.origin.file}) is imported as ${name}: table names start with a letter and use only letters, digits and underscores` +
        (table.alias ? `; ${original} stays its warehouse name.` : '.'),
      );
      table.name = name;
    }
  }
}

interface PreparedSql {
  sql: string;
  /** Placeholder type name → the type as written. */
  types: Map<string, string>;
  /** Lower-cased column name → its `COMMENT`. */
  comments: Map<string, string>;
  /** Lower-cased names of identity columns whose clause was removed. */
  identity: Set<string>;
}

/** Words after CREATE [modifiers] that name what is created. */
const CREATE_OBJECT_WORDS = new Set([
  'TABLE', 'TYPE', 'VIEW', 'INDEX', 'SCHEMA', 'DATABASE', 'CATALOG', 'SEQUENCE', 'FUNCTION', 'PROCEDURE', 'PROC', 'TRIGGER',
  'EXTENSION', 'ROLE', 'USER', 'STAGE', 'STREAM', 'TASK', 'PIPE', 'WAREHOUSE', 'DOMAIN', 'POLICY', 'TAG', 'VOLUME', 'LOGIN',
  'SYNONYM', 'RULE', 'AGGREGATE', 'CAST', 'COLLATION', 'PUBLICATION', 'SUBSCRIPTION', 'SERVER', 'EVENT', 'FILE', 'SHARE',
]);

interface ColumnSource {
  /** Where the column's type starts in the file. */
  typeOffset: number;
  /** Its `COMMENT [=] '…'`, as the tokenizer reads the string. */
  comment?: string;
  /** Its `DEFAULT '…'`, likewise. */
  stringDefault?: string;
}

/** Each column definition's type offset, comment and string default, by lower-cased name. */
function readColumnSources(tokens: Token[], open: number, close: number, angles: boolean): Map<string, ColumnSource> {
  const sources = new Map<string, ColumnSource>();
  for (const [from, to] of splitTopLevel(tokens, open + 1, close, angles)) {
    if (to <= from + 1 || !isName(tokens[from]) || TABLE_CONSTRAINT_WORDS.has(upper(tokens[from]))) continue;
    const source: ColumnSource = { typeOffset: tokens[from + 1].start };
    let depth = 0;
    for (let k = from + 1; k < to; k++) {
      const tok = tokens[k];
      if (isPunct(tok, '(')) { depth++; continue; }
      if (isPunct(tok, ')')) { depth--; continue; }
      if (depth !== 0) continue;
      const word = upper(tok);
      if (word === 'COMMENT') {
        const value = isPunct(tokens[k + 1], '=') ? tokens[k + 2] : tokens[k + 1];
        if (value?.kind === 'string') source.comment = value.value;
      } else if (word === 'DEFAULT') {
        let v = k + 1;
        while (isPunct(tokens[v], '(')) v++;
        if (upper(tokens[v]) === 'N' && tokens[v + 1]?.kind === 'string') v++;
        if (tokens[v]?.kind === 'string') source.stringDefault = tokens[v].value;
      }
    }
    sources.set(tokens[from].value.toLowerCase(), source);
  }
  return sources;
}

/** Words that start a table constraint inside a column list. */
const TABLE_CONSTRAINT_WORDS = new Set(['CONSTRAINT', 'PRIMARY', 'FOREIGN', 'UNIQUE', 'CHECK', 'KEY', 'INDEX', 'FULLTEXT', 'SPATIAL', 'PERIOD', 'EXCLUDE', 'LIKE']);

/**
 * The parser's type text with the spaces the file wrote: the grammars join a
 * type's words (`DOUBLE PRECISION` comes back as `DOUBLEPRECISION`). Reads
 * the file from the column's type on, matching the parsed text character by
 * character with whitespace ignored; anything else (a bracketed SQL Server
 * type, say) keeps the parsed text.
 */
function spacedAsWritten(parsed: string, text: string, offset: number): string {
  const compact = parsed.replace(/\s+/g, '');
  if (!compact) return parsed;
  let out = '';
  let j = 0;
  for (let i = offset; i < text.length && j < compact.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) { if (out && !out.endsWith(' ')) out += ' '; continue; }
    if (ch.toLowerCase() !== compact[j].toLowerCase()) return parsed;
    out += ch;
    j++;
  }
  return j === compact.length ? out.trim() : parsed;
}

/** Words that end a Spark column's type and start its constraints. */
const COLUMN_CONSTRAINT_WORDS = new Set(['NOT', 'NULL', 'DEFAULT', 'GENERATED', 'COMMENT', 'PRIMARY', 'CONSTRAINT', 'REFERENCES', 'UNIQUE', 'CHECK', 'MASK', 'COLLATE']);

function applyEdits(text: string, start: number, end: number, edits: Array<{ start: number; end: number; text: string }>): string {
  const sorted = [...edits].sort((a, b) => a.start - b.start || b.end - a.end);
  let out = '';
  let at = start;
  for (const edit of sorted) {
    if (edit.start < at) continue; // nested in an edit already applied
    out += text.slice(at, edit.start);
    // Keep the line breaks the replaced text had, so lines still match the file.
    const breaks = (text.slice(edit.start, edit.end).match(/\n/g) ?? []).length;
    out += edit.text + (edit.text ? '' : ' ') + '\n'.repeat(breaks);
    at = edit.end;
  }
  return out + text.slice(at, end);
}

function readStringList(tokens: Token[], open: number): string[] | undefined {
  if (!isPunct(tokens[open], '(')) return undefined;
  const close = matchParen(tokens, open);
  if (close < 0) return undefined;
  return tokens.slice(open + 1, close).filter((t) => t.kind === 'string').map((t) => t.value);
}

/** A table's `COMMENT [=] '…'` after its column list (Snowflake, Databricks, MySQL). */
function tailComment(tokens: Token[], from: number): string | undefined {
  for (let k = from; k < tokens.length; k++) {
    if (upper(tokens[k]) !== 'COMMENT') continue;
    const value = isPunct(tokens[k + 1], '=') ? tokens[k + 2] : tokens[k + 1];
    if (value?.kind === 'string') return value.value;
  }
  return undefined;
}

function firstDiagnostic(error: unknown): { line?: number; message: string } {
  const first = Array.isArray(error) ? error[0] : (error as { diags?: unknown[] } | undefined)?.diags?.[0] ?? error;
  const candidate = first as { message?: unknown; text?: unknown; location?: { start?: { line?: unknown } } } | undefined;
  const line = typeof candidate?.location?.start?.line === 'number' ? candidate.location.start.line : undefined;
  const raw = typeof candidate?.message === 'string' && candidate.message ? candidate.message
    : typeof candidate?.text === 'string' ? candidate.text : String(first);
  // A grammar crash (not a syntax error) says nothing a user can act on.
  const message = /Cannot read properties|is not a function|undefined/.test(raw) ? 'the SQL parser could not read this statement' : raw;
  return { line, message };
}

function noteText(note: RawSqlField['note']): string | undefined {
  if (typeof note === 'string') return note || undefined;
  if (note && typeof note === 'object' && typeof note.value === 'string') return note.value || undefined;
  return undefined;
}

const sameIdent = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

function sameSchema(a: string | null, b: string | null, dialect: SqlDialect): boolean {
  const fallback = DEFAULT_SCHEMA[dialect];
  const norm = (s: string | null): string => (s ?? fallback ?? '').toLowerCase();
  return norm(a) === norm(b);
}

function tableKey(table: ModelTable, dialect: SqlDialect): string {
  return `${(table.schema ?? DEFAULT_SCHEMA[dialect] ?? '').toLowerCase()}.${table.name.toLowerCase()}`;
}

function tableLabel(table: ModelTable): string {
  return table.schema ? `${table.schema}.${table.name}` : table.name;
}

function primaryKeyOf(table: ModelTable): string[] {
  if (table.primaryKey) return table.primaryKey;
  return table.fields.filter((f) => f.pk).map((f) => f.name);
}

/** The nearest `TABLE_NAME_PATTERN` name (Import DBML's rule: `sanitiseDbmlTableName`). */
function sanitiseTableName(name: string): string {
  if (TABLE_NAME_PATTERN.test(name)) return name;
  let out = name.replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!out) return 'table';
  if (!/^[A-Za-z]/.test(out)) out = `t_${out}`;
  return out;
}

/** Whether a name can be a model's warehouse `alias` (core's `isValidTableAlias`). */
function isWarehouseName(name: string): boolean {
  return name.length <= 128 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

// ---------------------------------------------------------------------------
// DBML output
// ---------------------------------------------------------------------------

function quoteIdent(name: string): string {
  return `"${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function dbmlString(text: string): string {
  if (text.includes('\n')) return `'''${text.replace(/\\/g, '\\\\').replace(/'''/g, "\\'''")}'''`;
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function dbmlType(type: string): string {
  // Bare when the parser reads it as one: `int`, `varchar(255)`, `numeric(10, 2)`, `sales.mood`.
  if (/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?(\(\s*[A-Za-z0-9_]+(\s*,\s*[A-Za-z0-9_]+)*\s*\))?$/.test(type)) return type;
  return quoteIdent(type);
}

function dbmlTableName(table: { schema: string | null; name: string }): string {
  return table.schema ? `${quoteIdent(table.schema)}.${quoteIdent(table.name)}` : quoteIdent(table.name);
}

function dbmlExpression(expr: string): string {
  return `\`${expr.replace(/`/g, "'")}\``;
}

function fieldSettings(field: ModelField): string {
  const settings: string[] = [];
  if (field.pk) settings.push('pk');
  if (field.increment) settings.push('increment');
  if (field.notNull && !field.pk) settings.push('not null');
  if (field.unique && !field.pk) settings.push('unique');
  if (field.default) {
    const d = field.default;
    if (d.type === 'number' && /^-?\d+(\.\d+)?$/.test(d.value)) settings.push(`default: ${d.value}`);
    else if (d.type === 'boolean' && /^(true|false)$/i.test(d.value)) settings.push(`default: ${d.value.toLowerCase()}`);
    else if (d.type === 'null') settings.push('default: null');
    else if (d.type === 'string') settings.push(`default: ${dbmlString(d.value)}`);
    else settings.push(`default: ${dbmlExpression(d.value)}`);
  }
  for (const check of field.checks) settings.push(`check: ${dbmlExpression(check)}`);
  if (field.note) settings.push(`note: ${dbmlString(field.note)}`);
  return settings.length ? ` [${settings.join(', ')}]` : '';
}

function writeDbml(
  enums: readonly ModelEnum[],
  tables: readonly ModelTable[],
  refs: ReadonlyArray<{ from: ModelTable; fromColumns: string[]; to: ModelTable; toColumns: string[] }>,
): string {
  const blocks: string[] = [];
  for (const e of enums) {
    const lines = e.values.map((v) => `  ${quoteIdent(v.name)}${v.note ? ` [note: ${dbmlString(v.note)}]` : ''}`);
    blocks.push(`Enum ${dbmlTableName(e)} {\n${lines.join('\n')}\n}`);
  }
  for (const table of tables) {
    const header = table.alias ? ` [alias: ${dbmlString(table.alias)}]` : '';
    const lines = table.fields.map((f) => `  ${quoteIdent(f.name)} ${dbmlType(f.type)}${fieldSettings(f)}`);
    const indexes: string[] = [];
    if (table.primaryKey) indexes.push(`    (${table.primaryKey.map(quoteIdent).join(', ')}) [pk]`);
    for (const unique of table.uniques) indexes.push(`    (${unique.map(quoteIdent).join(', ')}) [unique]`);
    if (indexes.length) lines.push('', '  Indexes {', ...indexes, '  }');
    if (table.checks.length) {
      lines.push('', '  checks {', ...table.checks.map((c) => `    ${dbmlExpression(c.expression)}${c.name ? ` [name: ${dbmlString(c.name)}]` : ''}`), '  }');
    }
    if (table.note) lines.push('', `  Note: ${dbmlString(table.note)}`);
    blocks.push(`Table ${dbmlTableName(table)}${header} {\n${lines.join('\n')}\n}`);
  }
  if (refs.length) {
    const end = (table: ModelTable, columns: string[]): string =>
      columns.length === 1 ? `${dbmlTableName(table)}.${quoteIdent(columns[0])}` : `${dbmlTableName(table)}.(${columns.map(quoteIdent).join(', ')})`;
    blocks.push(refs.map((r) => `Ref: ${end(r.from, r.fromColumns)} > ${end(r.to, r.toColumns)}`).join('\n'));
  }
  return blocks.join('\n\n') + '\n';
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Converts SQL DDL files to one DBML file, with `engine` as the SQL parser
 * (`sqlImportEngine.ts`'s `sqlDdlToDbml` passes `@dbml/core`'s). Every file is
 * read; any problem (a statement that does not parse, a table defined twice,
 * no tables at all) makes the result `ok: false` with every problem found.
 */
export function convertSqlDdl(input: SqlDdlToDbmlInput, engine: SqlParseEngine): SqlDdlToDbmlResult {
  if (!isSqlDialect(input.dialect)) {
    return { ok: false, problems: [{ file: '', message: `Unknown SQL dialect: ${String(input.dialect)}.` }] };
  }
  if (input.files.length === 0) return { ok: false, problems: [{ file: '', message: 'No SQL files to import.' }] };
  const converter = new Converter(input.dialect, engine);
  const unused: string[] = [];
  for (const file of input.files) {
    if (converter.readFile(file) === 0 && !converter.problems.some((p) => p.file === file.name)) unused.push(file.name);
  }
  converter.checkDuplicates();
  if (converter.problems.length) return { ok: false, problems: converter.problems };
  if (converter.tables.length === 0) {
    return {
      ok: false,
      problems: [{ file: input.files.length === 1 ? input.files[0].name : '', message: `No CREATE TABLE statements with a column list were found in ${input.files.length === 1 ? 'the file' : 'the files'}.` }],
    };
  }
  converter.applyDeferred();
  const refs = converter.resolveRefs();
  converter.sanitiseNames();
  const usedEnums = converter.enums.filter((e) =>
    converter.tables.some((tb) => tb.fields.some((f) => {
      const parts = f.type.split('.');
      return sameIdent(parts[parts.length - 1], e.name) && (parts.length === 1 || sameSchema(parts[0], e.schema, input.dialect));
    })),
  );
  const unusedEnums = converter.enums.length - usedEnums.length;
  const skipped = [
    ...unused.map((name) => `${name}: no tables, keys or comments in it`),
    ...converter.skippedSummary(input.files.map((f) => f.name)),
    ...converter.skippedLines,
    ...(unusedEnums ? [`${unusedEnums} enum type${unusedEnums === 1 ? '' : 's'} no column uses`] : []),
  ];
  return {
    ok: true,
    dbml: writeDbml(usedEnums, converter.tables, refs),
    tableCount: converter.tables.length,
    refCount: refs.length,
    skipped,
    notes: converter.notes,
  };
}
