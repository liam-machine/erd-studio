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
 *
 * The converter is split by concern, each module as pure as this one:
 * `sqlDdlModel.ts` (the types, re-exported here, and `ConverterContext`),
 * `sqlDdlLexer.ts` (tokenizer, statement splitter, token helpers),
 * `sqlDdlStatements.ts` (every statement reader but CREATE TABLE, as
 * functions over `ConverterContext`), `sqlDdlColumns.ts` (a parsed column to
 * a field) and `sqlDdlWriter.ts` (resolving foreign keys, writing DBML).
 * What is not brought across as written is counted in the result's `ledger`
 * (`importLedger.ts`).
 */

import { TABLE_NAME_PATTERN } from '../types/naming';
import { createLedger, ledgerText, type ImportLedger, type LedgerCause, type LedgerEntry } from './importLedger';
import { noteText, readColumnSources, toField, COLUMN_CONSTRAINT_WORDS } from './sqlDdlColumns';
import {
  applyEdits,
  BACKSLASH_ESCAPES,
  CREATE_OBJECT_WORDS,
  GO_LINE,
  isName,
  isDoubleQuotedComment,
  isExpectation,
  isPunct,
  leadingTableComment,
  matchParen,
  readColumnList,
  readName,
  readStringList,
  splitStatements,
  splitTopLevel,
  STATEMENT_KEYWORDS,
  tailComment,
  tokenize,
  uncommentVersioned,
  upper,
  type Statement,
  type Token,
} from './sqlDdlLexer';
import {
  readerState,
  sameIdent,
  sameSchema,
  tableLabel,
  SKIP_LABELS,
  type ConverterContext,
  type ModelEnum,
  DEFAULT_SCHEMA,
  type ModelTable,
  type ResolvedRef,
  type Origin,
  type PendingComment,
  type PendingKey,
  type PendingRef,
  type PreparedSql,
  type RawSqlDatabase,
  type RawSqlEnum,
  type RawSqlTable,
  type SkipKind,
  type SkippedItem,
  type SqlClause,
  type SqlDdlFile,
  type SqlDdlProblem,
  type SqlDdlToDbmlInput,
  type SqlDialect,
  type SqlParseEngine,
  type SqlParseFormat,
  type SqlPartitionMode,
} from './sqlDdlModel';
import { ambiguousPlaceholderNames, neutralisePlaceholders } from './sqlDdlPlaceholders';
import { ALL_RUNGS, REPAIR_LADDER, columnNamesOf, isConstraintItem, missingCommas, repairHints, rewriteCreateTable, type MissingComma, type Repair, type RepairRung } from './sqlDdlRepair';
import { salvageCreateTable } from './sqlDdlSalvage';
import { ANGLE_TYPE_DIALECTS, isPreStepped, rewriteDialectTable } from './sqlDdlDialects';
import { resolvePartitions } from './sqlDdlPartitions';
import { isChildWithoutTable, isView, readStatement, replaceTable } from './sqlDdlStatements';
import { ownerOfLine, quoteIdent, resolveRefs, writeDbmlMapped } from './sqlDdlWriter';

export type {
  RawSqlCheck,
  RawSqlDatabase,
  RawSqlEnum,
  RawSqlField,
  RawSqlIndex,
  RawSqlRef,
  RawSqlTable,
  SqlClause,
  SqlDdlFile,
  SqlDdlProblem,
  SqlDdlToDbmlInput,
  SqlDialect,
  SqlParseEngine,
  SqlParseFormat,
  SqlPartitionMode,
  SqlProblemKind,
} from './sqlDdlModel';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Every dialect, in the order a picker lists them. */
export const SQL_DIALECTS: readonly SqlDialect[] = Object.freeze(['postgres', 'mysql', 'sqlserver', 'snowflake', 'databricks', 'oracle', 'bigquery', 'redshift', 'sqlite']);

/** How a picker names each dialect. */
export const SQL_DIALECT_LABELS: Readonly<Record<SqlDialect, string>> = Object.freeze({
  postgres: 'PostgreSQL',
  mysql: 'MySQL / MariaDB',
  sqlserver: 'SQL Server / Azure SQL',
  snowflake: 'Snowflake',
  databricks: 'Databricks / Spark SQL',
  oracle: 'Oracle',
  bigquery: 'Google BigQuery',
  redshift: 'Amazon Redshift',
  sqlite: 'SQLite',
});

/** Whether `value` is a {@link SqlDialect}. */
export function isSqlDialect(value: unknown): value is SqlDialect {
  return typeof value === 'string' && (SQL_DIALECTS as readonly string[]).includes(value);
}

/**
 * The dialect `erdStudio.importSqlDdl`'s argument chooses (`{ dialect }`, the
 * import guide's SQL cards): the flow then reads the scripts as that dialect
 * without asking. Anything else — no argument, a `{ quick: true }` (the quick
 * path, which works the dialect out itself), an unknown dialect, an array, a
 * string — is undefined: the ordinary step-by-step flow.
 */
export function sqlDialectOfImportArg(arg: unknown): SqlDialect | undefined {
  if (typeof arg !== 'object' || arg === null || Array.isArray(arg)) return undefined;
  const { dialect, quick } = arg as { dialect?: unknown; quick?: unknown };
  if (quick === true) return undefined;
  return isSqlDialect(dialect) ? dialect : undefined;
}

/**
 * The class of a statement or line by its leading keywords, or undefined when
 * it does not start one (a column definition, a closing parenthesis).
 * Matched on the device; only the class leaves.
 */
export function sqlClauseOf(text: string): SqlClause | undefined {
  const words = text.replace(/^[\s(]+/, '').toUpperCase().split(/[^A-Z_]+/).filter(Boolean).slice(0, 8);
  const [w0, w1] = words;
  if (w0 === 'CREATE') {
    if (w1 === 'OR' && words[2] === 'REPLACE') return 'CreateOrReplace';
    // CREATE [GLOBAL] [TEMPORARY | TRANSIENT | …] TABLE, CREATE [UNIQUE] [CLUSTERED] INDEX, CREATE [MATERIALIZED] VIEW.
    const what = words.slice(1).find((w) => w === 'TABLE' || w === 'VIEW' || w === 'INDEX');
    if (what === 'TABLE') return 'CreateTable';
    if (what === 'VIEW') return 'CreateView';
    if (what === 'INDEX') return 'CreateIndex';
    return 'Other';
  }
  if (w0 === 'ALTER') return w1 === 'TABLE' ? 'AlterTable' : 'Other';
  if (w0 === 'COMMENT' && w1 === 'ON') return 'CommentOn';
  if (w0 === 'GRANT' || w0 === 'REVOKE' || w0 === 'DENY') return 'Grant';
  if (w0 === 'SET' || w0 === 'USE') return 'SetUse';
  if (w0 === 'INSERT' || w0 === 'UPDATE' || w0 === 'DELETE' || w0 === 'DROP' || w0 === 'SELECT' || w0 === 'WITH'
    || w0 === 'EXEC' || w0 === 'EXECUTE' || w0 === 'TRUNCATE' || w0 === 'MERGE' || w0 === 'COPY' || w0 === 'RENAME') return 'Other';
  return undefined;
}

/**
 * The clause a parse problem names: the line the parser stopped on when it
 * starts a statement of its own (a COMMENT ON or GRANT run into the CREATE
 * TABLE before it, for want of a semicolon), else the statement's own
 * leading keywords.
 */
export function rejectedSqlClause(statementSql: string, line: number | undefined): SqlClause {
  if (line !== undefined && line >= 1) {
    const atLine = sqlClauseOf(statementSql.split(/\r?\n/)[line - 1] ?? '');
    if (atLine) return atLine;
  }
  return sqlClauseOf(statementSql) ?? 'Other';
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
      /** Units that did not read but did not stop the import ([] when everything read). */
      problems: SqlDdlProblem[];
      /** Everything not brought across as written (`importLedger.ts`): plain data, it crosses the bundle. */
      ledger: LedgerEntry[];
      /** CREATE TABLE statements with a column list found in the files (read or not); a table a later CREATE OR REPLACE replaces is counted once. */
      tablesFound: number;
      /** How the tables were read: as written, rewritten by the repair ladder, or salvaged without a grammar. */
      readWith?: SqlReadWith;
      /** The reading stopped before the end of the files (cancelled, or the time limit): what was read is the result, the rest is in the ledger. */
      stopped?: SqlConvertStop;
      /**
       * Partition and inheritance children (`PARTITION OF`, `ATTACH PARTITION`, `INHERITS`): how many were
       * folded into their parent and how many kept as tables. Absent when the scripts have none.
       */
      partitions?: { folded: number; kept: number };
    }
  | { ok: false; problems: SqlDdlProblem[]; ledger?: LedgerEntry[]; tablesFound?: number; readWith?: SqlReadWith; stopped?: SqlConvertStop };

/** Why a reading stopped before the end of the files: the user cancelled it, or the import's time limit was reached. */
export type SqlStopReason = 'cancelled' | 'timeLimit';

/**
 * A reading that stopped early: how far it got, and what it left unread.
 * Every unread statement is also in the ledger (`problem` entries with the
 * stop's cause, one or two per file: its CREATE TABLEs and its other
 * statements, each placed at the line where the unread part of that file
 * starts), so conservation holds: tables found = read + reported.
 */
export interface SqlConvertStop {
  reason: SqlStopReason;
  /** Statements read before the stop. */
  statementsRead: number;
  /** Statements not read (the rest of the file it stopped in, and every later file). */
  statementsUnread: number;
  /** Of those, CREATE TABLE statements with a column list (counted in `tablesFound`). */
  tablesUnread: number;
  /** Where the unread part starts. */
  at: { file: string; line: number };
}

/** How far a reading has got, reported after every statement (`SqlDdlConvertOptions.onProgress`). */
export interface SqlConvertProgress {
  /** Statements read so far, in every file. */
  statementsRead: number;
  /** Tables read so far (by a grammar, rewritten or salvaged). */
  tablesRead: number;
  /** Files read to the end, of `files`. */
  filesRead: number;
  files: number;
  /** How much of the SQL text has been read, 0 to 1 (by characters). */
  fraction: number;
}

/** How a conversion's tables were read (`sqlDdlRepair.ts`, `sqlDdlSalvage.ts`). */
export interface SqlReadWith {
  /** By the dialect's grammar, as written. */
  grammar: number;
  /** By a grammar, once rewritten (the repair ladder). */
  repaired: number;
  /** Without a grammar (salvage). */
  salvaged: number;
}

/** How hard a conversion tries before a table is a problem. */
export interface SqlDdlConvertOptions {
  /** false: the grammar only, as written (no repair ladder, no salvage). Default true. */
  repair?: boolean;
  /** At most this many tables go through the repair ladder; the rest go straight to salvage (default {@link REPAIR_LADDER_MAX_TABLES}). */
  ladderTables?: number;
  /** After this many milliseconds of repairs, the rest go straight to salvage (default {@link REPAIR_LADDER_MAX_MS}). */
  ladderMs?: number;
  /** Called after every statement read (a worker throttles what it posts). */
  onProgress?: (progress: SqlConvertProgress) => void;
  /**
   * Asked before every statement: a reason stops the reading there. What was
   * read is converted as usual and the rest goes into the ledger (`stopped`).
   */
  shouldStop?: () => SqlStopReason | undefined;
  /**
   * Called once, when the reading has ended (every statement read, or the
   * stop recorded): what is left is converting what was read, which is never
   * stopped (a worker tells its host, so the host never ends it for that).
   */
  onReadingEnd?: () => void;
  /** The time limit the caller set (ms), only for the ledger's wording when `shouldStop` says `timeLimit`. */
  timeLimitMs?: number;
  /**
   * Partition and inheritance children with no columns of their own: `fold` (default) reads each as its
   * parent's rows (one ledger note per child); `tables` keeps each as a table with its parent's columns.
   */
  partitions?: SqlPartitionMode;
}

/** The repair ladder's budget: tables beyond it go straight to salvage, so a huge file of failing tables stays fast. */
export const REPAIR_LADDER_MAX_TABLES = 300;
export const REPAIR_LADDER_MAX_MS = 8000;

/**
 * One dialect's reading of the scripts: how many of the CREATE TABLEs found
 * it read, and how (the dialect pick's labels and the quick path's choice).
 */
export interface SqlDialectReading {
  dialect: SqlDialect;
  /** CREATE TABLE statements with a column list it read (by a grammar or salvage). */
  tablesRead: number;
  /** CREATE TABLE statements with a column list in the files. */
  tablesFound: number;
  /** Of those read: rewritten by the repair ladder, and read without a grammar. */
  repaired: number;
  salvaged: number;
  result: SqlDdlToDbmlResult;
}

export function sqlDialectReading(dialect: SqlDialect, result: SqlDdlToDbmlResult): SqlDialectReading {
  const w = result.readWith ?? { grammar: result.ok ? result.tableCount : 0, repaired: 0, salvaged: 0 };
  const read = w.grammar + w.repaired + w.salvaged;
  return {
    dialect,
    tablesRead: read,
    tablesFound: Math.max(result.tablesFound ?? 0, read),
    repaired: w.repaired,
    salvaged: w.salvaged,
    result,
  };
}

/**
 * Readings best first: the most tables read; then the fewest read without a
 * grammar; then a dialect with a grammar of its own (or the detected one)
 * before Oracle, BigQuery, Redshift and SQLite, whose pre-steps read more as
 * written than PostgreSQL's grammar does on its own (they quote every name),
 * so a PostgreSQL script stays PostgreSQL; then the fewest rewritten (a
 * dialect that reads the files as written is the one they are in); ties go to
 * `detected`, then to {@link SQL_DIALECT_LIKELIHOOD}.
 */
export function rankSqlDialectReadings(readings: readonly SqlDialectReading[], detected?: SqlDialect): SqlDialectReading[] {
  const likely = (d: SqlDialect): number => SQL_DIALECT_LIKELIHOOD.indexOf(d);
  const borrowed = (d: SqlDialect): number => (d !== detected && isPreStepped(d) ? 1 : 0);
  return [...readings].sort((a, b) =>
    b.tablesRead - a.tablesRead
    || a.salvaged - b.salvaged
    || borrowed(a.dialect) - borrowed(b.dialect)
    || a.repaired - b.repaired
    || (a.dialect === detected ? -1 : b.dialect === detected ? 1 : 0)
    || likely(a.dialect) - likely(b.dialect));
}

/** How the dialect pick describes a reading: `reads 70 of 71 tables`, `reads none of the 4 tables`. */
export function sqlDialectReadingLabel(r: Pick<SqlDialectReading, 'tablesRead' | 'tablesFound' | 'salvaged'>): string {
  const found = Math.max(r.tablesFound, r.tablesRead);
  if (found === 0) return 'finds no tables';
  if (r.tablesRead === 0) return found === 1 ? 'does not read the table' : `reads none of the ${found.toLocaleString('en-US')} tables`;
  const of = found === 1 ? 'reads the table' : r.tablesRead === found ? `reads all ${found.toLocaleString('en-US')} tables` : `reads ${r.tablesRead.toLocaleString('en-US')} of ${found.toLocaleString('en-US')} tables`;
  return r.salvaged > 0 ? `${of} (${r.salvaged.toLocaleString('en-US')} without its grammar)` : of;
}

/**
 * The grammar each dialect is read with. Databricks is rewritten for the
 * PostgreSQL grammar first; Oracle, BigQuery, Redshift and SQLite have their
 * own pre-steps for it (`sqlDdlDialects.ts`): `@dbml/core` has no grammar for
 * the last three, and its Oracle one is not bundled (`esbuild.js`).
 */
export const SQL_PARSE_FORMAT: Readonly<Record<SqlDialect, SqlParseFormat>> = Object.freeze({
  postgres: 'postgres',
  mysql: 'mysql',
  sqlserver: 'mssql',
  snowflake: 'snowflake',
  databricks: 'postgres',
  oracle: 'postgres',
  bigquery: 'postgres',
  redshift: 'postgres',
  sqlite: 'postgres',
});

// ---------------------------------------------------------------------------
// Dialect detection
// ---------------------------------------------------------------------------

/**
 * Signals per dialect: [pattern, weight, flag?]. Strong signals weigh 3, hints
 * 1. Patterns test the text without its comments and without what its '…'
 * strings hold (a row of data that says `Number` or `bool` is no type), unless
 * the flag is `strings` (the signal is a string: `FROM 's3://…'`) or `comments`
 * (the signal is a comment: a Databricks notebook's `-- COMMAND ----------`). `beside`:
 * the signal counts only beside another of the same dialect's (a syntax two
 * dialects share, which alone points to the one that had it first).
 */
const DIALECT_SIGNALS: ReadonlyArray<[SqlDialect, RegExp, number, ('strings' | 'beside' | 'comments')?]> = [
  ['sqlserver', /^[ \t]*GO[ \t]*$/im, 3],
  ['sqlserver', /\[\w+\]\s*\.\s*\[\w+\]/, 3],
  ['sqlserver', /\bsp_addextendedproperty\b/i, 3],
  ['sqlserver', /\bIDENTITY\s*\(\s*\d+\s*,\s*\d+\s*\)/i, 2],
  ['sqlserver', /\bNVARCHAR\b|\bCLUSTERED\b|\bON\s+\[PRIMARY\]/i, 1],
  ['databricks', /\bUSING\s+(DELTA|PARQUET|ICEBERG|CSV|JSON|ORC|AVRO)\b/i, 3],
  ['databricks', /\bTBLPROPERTIES\b/i, 3],
  ['databricks', /\b(ARRAY|MAP|STRUCT)\s*</i, 3],
  ['databricks', /\bPARTITIONED\s+BY\b|\bZORDER\b/i, 1],
  // A Databricks notebook exported as SQL: its header, cell separators and `-- MAGIC` lines.
  ['databricks', /^-- (?:Databricks notebook source|COMMAND -{5,}|MAGIC )/m, 3, 'comments'],
  // Lakeflow (Delta Live Tables) pipelines.
  ['databricks', /\bCREATE\s+OR\s+REFRESH\b|\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:STREAMING|LIVE)\s+TABLE\b|\bCONSTRAINT\s+\w+\s+EXPECT\s*\(/i, 3],
  // Unity Catalog's catalogs (Snowflake has none: its CREATE CATALOG INTEGRATION is an Iceberg link).
  ['databricks', /\bUSE\s+CATALOG\b|\bCREATE\s+CATALOG\b(?!\s+INTEGRATION\b)/i, 3],
  // A column's own `[CONSTRAINT n] FOREIGN KEY REFERENCES t` is Databricks' and Snowflake's alike: beside one of their own signals.
  ['databricks', /\bFOREIGN\s+KEY\s+REFERENCES\b/i, 3, 'beside'],
  ['snowflake', /\bFOREIGN\s+KEY\s+REFERENCES\b/i, 3, 'beside'],
  // An identity column written GENERATED … AS IDENTITY in a CREATE OR REPLACE TABLE: Databricks'. PostgreSQL and
  // Oracle have no CREATE OR REPLACE TABLE, and Snowflake writes IDENTITY / AUTOINCREMENT.
  ['databricks', /^(?=[\s\S]*\bCREATE\s+OR\s+REPLACE\s+TABLE\b)[\s\S]*\bGENERATED\s+(?:ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY\b/i, 3],
  // TIMESTAMP_NTZ and TIMESTAMP_LTZ are Spark's types too (Databricks Runtime 13+); TIMESTAMP_TZ is Snowflake's alone.
  ['databricks', /\bTIMESTAMP_(NTZ|LTZ)\b/i, 1],
  // STRING as a type, in a script that backquotes a name (one part each: a whole `a.b.c` path is BigQuery's).
  ['databricks', /^(?=[\s\S]*`[^`\n.]+`)[\s\S]*?[\w`][ \t]+STRING\b/i, 2],
  ['mysql', /\bENGINE\s*=/i, 3],
  ['mysql', /\bAUTO_INCREMENT\b/i, 3],
  // Backquoted names: MySQL's (or Databricks', whose other signals then decide); never SQL Server's.
  ['mysql', /`/, 2],
  ['databricks', /`/, 1],
  ['snowflake', /\bCREATE\s+OR\s+REPLACE\s+TRANSIENT\b|\bTRANSIENT\s+TABLE\b/i, 3],
  ['snowflake', /\bVARIANT\b/i, 3],
  ['snowflake', /\bNUMBER\s*\(\s*38\b|\bVARCHAR\s*\(\s*16777216\s*\)/i, 3],
  ['snowflake', /\bCREATE\s+OR\s+REPLACE\s+TABLE\b/i, 1],
  // Snowflake's timestamp types and its own objects (PostgreSQL shares its `::` casts and `$$` bodies).
  ['snowflake', /\bTIMESTAMP_TZ\b/i, 3],
  ['snowflake', /\bTIMESTAMP_(NTZ|LTZ)\b/i, 2],
  ['snowflake', /\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:WAREHOUSE|STAGE|STREAM|TASK|PIPE|FILE\s+FORMAT|DYNAMIC\s+TABLE|HYBRID\s+TABLE|ICEBERG\s+TABLE)\b|\bUSE\s+(?:WAREHOUSE|ROLE)\b/i, 3],
  // `::` casts and `$$` bodies are Snowflake's and Databricks' too: beside one of their own signals, theirs as much as PostgreSQL's.
  ['snowflake', /::\s*\w/, 3, 'beside'],
  ['snowflake', /\$\$/, 3, 'beside'],
  ['databricks', /::\s*\w/, 3, 'beside'],
  ['postgres', /\b(BIG|SMALL)?SERIAL\b/i, 3],
  ['postgres', /::\s*\w/, 3],
  ['postgres', /\bTIMESTAMPTZ\b|\bJSONB\b|\$\$/i, 3],
  ['postgres', /\bTEXT\b|\bCOMMENT\s+ON\b/i, 1],
  ['oracle', /\bN?VARCHAR2\b/i, 3],
  ['oracle', /\(\s*\d+\s+(?:BYTE|CHAR)\s*\)/i, 3],
  ['oracle', /\bSEGMENT\s+CREATION\b|\bPCTFREE\b|\bNOCOMPRESS\b|\bORGANIZATION\s+INDEX\b|\bNOCACHE\b|\bNOCYCLE\b|\bNOLOGGING\b/i, 2],
  ['oracle', /^[ \t]*\/[ \t]*$|^[ \t]*(?:PROMPT|REM|REMARK)\b/im, 2],
  ['oracle', /\bN?CLOB\b|\bBINARY_(?:FLOAT|DOUBLE)\b|\bSYSDATE\b|\bSYSTIMESTAMP\b|\bLONG\s+RAW\b|\bRAW\s*\(/i, 2],
  // A type, after a column's name (a column named `number` is no signal).
  ['oracle', /[\w"\]`][ \t]+NUMBER\b/i, 1],
  ['bigquery', /\bINT64\b|\bFLOAT64\b|\bBIGNUMERIC\b|\bBIGDECIMAL\b/i, 3],
  ['bigquery', /\bOPTIONS\s*\(\s*(?:description|labels|expiration_timestamp|partition_expiration_days|require_partition_filter|friendly_name)\s*=/i, 3],
  ['bigquery', /\bPARTITION\s+BY\s+(?:DATE|DATE_TRUNC|TIMESTAMP_TRUNC|DATETIME_TRUNC|RANGE_BUCKET|_PARTITIONDATE)\b|@@(?:dataset_id|project_id)\b/i, 3],
  // A whole path in one pair of backticks (`my-project.dataset.table`): Databricks and MySQL quote each part.
  ['bigquery', /`[A-Za-z_][\w-]*(?:\.[\w-]+){1,2}`/, 3],
  // The same with template placeholders in it (`${project_id}.${dataset}.t`, `{project_id}.{dataset_id}.events_*`).
  ['bigquery', /`(?:[\w-]|\$?\{\w+\})+(?:\.(?:[\w-]|\$?\{\w+\})+){1,2}\*?`/, 3],
  // BigQuery nests types as Databricks does (ARRAY<STRUCT<…>>): alone, the Databricks it was read as before.
  ['bigquery', /\b(?:ARRAY|STRUCT)\s*</i, 3, 'beside'],
  // STRING is BigQuery's type as much as Databricks': beside a BigQuery signal (INT64), a backquoted `offset STRING` is no Databricks.
  ['bigquery', /[\w`][ \t]+STRING\b/i, 2, 'beside'],
  // A type after a column's name. (GEOGRAPHY and BOOL are PostgreSQL's too, PostGIS and an alias.)
  ['bigquery', /[\w"\]`][ \t]+BYTES\b/i, 1],
  // DISTKEY and SORTKEY as a clause (`DISTKEY (a)`, `COMPOUND SORTKEY`) or after a column's type (`a int DISTKEY`),
  // never as a column's name (`sortkey varchar(50)`, `ORDER BY sortkey`).
  ['redshift', /\bDISTSTYLE\s+(?:KEY|ALL|EVEN|AUTO)\b|\b(?:DISTKEY|SORTKEY)\s*\(|\b(?:COMPOUND|INTERLEAVED)\s+SORTKEY\b|\bSORTKEY\s+AUTO\b|(?<=[\w)])(?<!\b(?:BY|AS|ON|SET|TABLE|COLUMN|SELECT|DISTINCT))[ \t]+(?:DISTKEY|SORTKEY)\b(?=[ \t]*(?:[,)\r\n]|(?:NOT|NULL|PRIMARY|UNIQUE|REFERENCES|DEFAULT|ENCODE|DISTKEY|SORTKEY|IDENTITY|CONSTRAINT|COLLATE)\b))/i, 3],
  ['redshift', /\bENCODE\s+(?:RAW|AZ64|BYTEDICT|DELTA|DELTA32K|LZO|MOSTLY8|MOSTLY16|MOSTLY32|RUNLENGTH|TEXT255|TEXT32K|ZSTD|AUTO)\b/i, 3],
  ['redshift', /\bBACKUP\s+(?:YES|NO)\b/i, 2],
  ['redshift', /\bFROM\s+'s3:\/\//i, 2, 'strings'],
  ['sqlite', /\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/i, 3],
  ['sqlite', /\bWITHOUT\s+ROWID\b|\bCREATE\s+VIRTUAL\s+TABLE\b|\bPRAGMA\b|\bsqlite_\w+|\)\s*STRICT\s*[;,]/i, 3],
  // Square brackets without SQL Server's batches, schemas or types: `[AlbumId] INTEGER` (SQLite's affinity name).
  ['sqlite', /\[\w+\]\s+INTEGER\b/i, 2],
];

/** A '…' string on one line (a stray quote spoils one line only), for {@link dialectScores}. */
const ONE_LINE_STRING = /'(?:[^'\\\n]|\\.|'')*'/g;

/**
 * Each dialect's score from the text's signals (comments and what strings hold
 * ignored). A hint (weight 1) counts for Oracle, BigQuery, Redshift or SQLite
 * only beside a stronger signal of the same dialect: a hint alone never makes
 * one of them, read with another dialect's grammar, the pick. So does a
 * `beside` signal, in any dialect. Never parses.
 */
function dialectScores(text: string): Map<SqlDialect, number> {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
  // String literals (a dump's data: 'String Quartet', 'USING DELTA') say nothing about the dialect.
  const bare = code.replace(ONE_LINE_STRING, "''");
  const scores = new Map<SqlDialect, number>();
  const hints = new Map<SqlDialect, number>();
  for (const [dialect, pattern, weight, flag] of DIALECT_SIGNALS) {
    if (!pattern.test(flag === 'comments' ? text : flag === 'strings' ? code : bare)) continue;
    const into = flag === 'beside' || (weight === 1 && isPreStepped(dialect)) ? hints : scores;
    into.set(dialect, (into.get(dialect) ?? 0) + weight);
  }
  for (const [dialect, weight] of hints) {
    if (scores.has(dialect)) scores.set(dialect, scores.get(dialect)! + weight);
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
export const SQL_DIALECT_LIKELIHOOD: readonly SqlDialect[] = Object.freeze(['postgres', 'sqlserver', 'mysql', 'snowflake', 'databricks', 'redshift', 'bigquery', 'oracle', 'sqlite']);

/** Every dialect, most likely first: the text's signals, highest first, then {@link SQL_DIALECT_LIKELIHOOD}. Never parses. */
export function rankSqlDialects(text: string): SqlDialect[] {
  const scores = dialectScores(text);
  const rank = (d: SqlDialect): number => SQL_DIALECT_LIKELIHOOD.indexOf(d);
  return [...SQL_DIALECTS].sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0) || rank(a) - rank(b));
}

// ---------------------------------------------------------------------------
// What the folder looks count, and what a dump's data is
// ---------------------------------------------------------------------------

/**
 * A file's text as the converter reads it: no byte order mark, a lone `\r`
 * (classic Mac line endings) read as a line break, and template placeholders
 * neutralised (`sqlDdlPlaceholders.ts`). Every step keeps the text's length,
 * so offsets and line numbers still point into the user's file.
 */
function prepareText(raw: string, dialect: SqlDialect, ambiguous?: ReadonlySet<string>): ReturnType<typeof neutralisePlaceholders> {
  const pass = neutralisePlaceholders(withoutPlaceholdersYet(raw, dialect), dialect, ambiguous);
  return dialect === 'snowflake' ? { ...pass, text: clusterByAfterColumns(pass.text) } : pass;
}

/** {@link prepareText}'s steps before the placeholder pass. */
function withoutPlaceholdersYet(raw: string, dialect: SqlDialect): string {
  const text = plainSpaces(withoutNulBytes(raw.charCodeAt(0) === 0xfeff ? ` ${raw.slice(1)}` : raw).replace(/\r(?!\n)/g, '\n'));
  return dialect === 'mysql' ? uncommentVersioned(text) : text;
}

/**
 * Snowflake's `GET_DDL` writes a clustering key before the column list
 * (`create or replace TABLE t cluster by (d)(\n  id NUMBER, …)`), where no
 * grammar has it: the two are swapped, so the clause reads as the table
 * option it is. Only when neither the clause nor the space after it holds a
 * line break, so the swap keeps the text's length and every line number.
 */
function clusterByAfterColumns(text: string): string {
  if (!/\bcluster\s+by\s*\(/i.test(text)) return text;
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const st of splitStatements(text, 'snowflake')) {
    const t = st.tokens;
    if (upper(t[0]) !== 'CREATE') continue;
    let i = 1;
    while (i < t.length && i < 12 && !(t[i].kind === 'word' && CREATE_OBJECT_WORDS.has(upper(t[i])))) i++;
    if (upper(t[i]) !== 'TABLE') continue;
    i++;
    if (upper(t[i]) === 'IF' && upper(t[i + 1]) === 'NOT' && upper(t[i + 2]) === 'EXISTS') i += 3;
    const name = readName(t, i);
    if (!name) continue;
    const c = name.next;
    if (upper(t[c]) !== 'CLUSTER' || upper(t[c + 1]) !== 'BY' || !isPunct(t[c + 2], '(')) continue;
    const keyClose = matchParen(t, c + 2);
    if (keyClose < 0 || !isPunct(t[keyClose + 1], '(')) continue;
    const listClose = matchParen(t, keyClose + 1);
    if (listClose < 0) continue;
    const clause = text.slice(t[c].start, t[keyClose].end);
    const gap = text.slice(t[keyClose].end, t[keyClose + 1].start);
    if (clause.includes('\n') || gap.includes('\n')) continue;
    const list = text.slice(t[keyClose + 1].start, t[listClose].end);
    // `)cluster by (d)` reads the same as `) cluster by (d)`: the swap needs no space it does not have.
    edits.push({ start: t[c].start, end: t[listClose].end, text: `${list}${gap}${clause}` });
  }
  if (edits.length === 0) return text;
  let out = '';
  let at = 0;
  for (const e of edits) { out += text.slice(at, e.start) + e.text; at = e.end; }
  return out + text.slice(at);
}

/**
 * UTF-16 text read as UTF-8 (a file saved without its byte order mark, read
 * by something that did not look): every other character a NUL. The NULs go
 * (no line break is a NUL, so every line number still holds); a stray NUL
 * in a real script stays a character the grammar rejects.
 */
function withoutNulBytes(text: string): string {
  const first = text.indexOf('\0');
  if (first < 0 || first > 4) return text;
  const sample = text.slice(0, 512);
  const nuls = sample.split('\0').length - 1;
  return nuls * 3 >= sample.length ? text.replace(/\0/g, '') : text;
}

/** Spaces the grammars do not read as spaces: no-break, typographic and zero-width spaces, form feed and vertical tab. */
const ODD_SPACES = /[\f\v\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]/;
const ODD_SPACES_ALL = new RegExp(ODD_SPACES.source, 'g');

/**
 * The text with every odd space ({@link ODD_SPACES}) outside a '…' string a
 * plain space, one for one (a no-break space pasted from a web page, a form
 * feed between pages of a printed script): offsets and lines stay. A string
 * keeps its own characters.
 */
function plainSpaces(text: string): string {
  if (!ODD_SPACES.test(text)) return text;
  let out = '';
  let at = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "'") continue;
    out += text.slice(at, i).replace(ODD_SPACES_ALL, ' ');
    let j = i + 1;
    while (j < text.length && !(text[j] === "'" && text[j + 1] !== "'") && text[j] !== '\n') j += text[j] === "'" ? 2 : 1;
    out += text.slice(i, j + 1);
    at = j + 1;
    i = j;
  }
  return out + text.slice(at).replace(ODD_SPACES_ALL, ' ');
}

/** A cheap first test: no CREATE … TABLE at all means no statement to split. */
const MAY_CREATE_TABLE = /\bcreate\b[^;]*?\btable\b/i;

/**
 * How many `CREATE TABLE` statements with a column list the text holds, by
 * the converter's own reading (its statement splitter and its test for a
 * column list: the name, then `(`, and no `AS SELECT` after it), so a CTAS,
 * `CREATE TABLE … LIKE` or a dbt macro's `create table {{ relation }} as (…)`
 * never counts, while a commented-out one or one inside a string never does
 * either. `dialect` decides how comments and strings read (default: the
 * detected one, else Postgres). Never parses a column.
 */
export function countCreateTablesWithColumns(text: string, dialect?: SqlDialect): number {
  if (!MAY_CREATE_TABLE.test(text)) return 0;
  const d = dialect ?? detectSqlDialect(text) ?? 'postgres';
  let count = 0;
  for (const st of splitStatements(prepareText(text, d).text, d)) {
    if (isCreateTableWithColumns(st.tokens)) count++;
  }
  return count;
}

/** Where a `CREATE … TABLE` statement's name starts (after any `IF NOT EXISTS`), or undefined when it is not one. */
function createTableName(t: Token[]): { at: number; ifNotExists: boolean } | undefined {
  if (upper(t[0]) !== 'CREATE') return undefined;
  let i = 1;
  while (i < t.length && t[i].kind === 'word' && !CREATE_OBJECT_WORDS.has(upper(t[i]))) i++;
  if (upper(t[i]) !== 'TABLE') return undefined;
  i++;
  const ifNotExists = upper(t[i]) === 'IF' && upper(t[i + 1]) === 'NOT' && upper(t[i + 2]) === 'EXISTS';
  return { at: ifNotExists ? i + 3 : i, ifNotExists };
}

/** SQL Server's `#tmp` / `##global` scratch table name at `i` (never one of the design's tables). */
function isTempTableName(t: Token[], i: number): boolean {
  return isPunct(t[i], '#') || (t[i]?.kind === 'word' && t[i].value.startsWith('#'));
}

/** One column of a typed empty SELECT ({@link typedSelectColumns}): its item's span, name and type. */
interface TypedSelectColumn {
  /** The item's first and last token. */
  first: number;
  last: number;
  name: string;
  /** The type as written (`decimal(10, 2)`). */
  type: string;
  /** The type is a CAST inside a larger expression (`IF(try_cast(NULL AS DATE) …)`), not the whole item. */
  inner: boolean;
  line: number;
}

const CAST_WORDS = new Set(['CAST', 'TRY_CAST', 'SAFE_CAST']);

/**
 * `[USING x …] AS SELECT CAST(NULL AS integer) AS person_id, … [WHERE 1 = 0]`
 * after a CREATE TABLE's name (`at`): a SELECT with no FROM whose every item
 * is `<expression> AS <name>` with a CAST in it, the idiom generators use for
 * an empty table of typed columns (OHDSI's SqlRender for Spark). Its columns,
 * or undefined for any other statement (a CTAS reading a table stays a CTAS).
 */
function typedSelectColumns(t: Token[], text: string | undefined, at: number): { select: number; end: number; columns: TypedSelectColumn[] } | undefined {
  let k = at;
  while (k < t.length && !(upper(t[k]) === 'AS' && upper(t[k + 1]) === 'SELECT')) {
    if (isPunct(t[k], '(') || isPunct(t[k], ';')) return undefined;
    k++;
  }
  if (k >= t.length) return undefined;
  const select = k + 1;
  // The list ends at a top-level WHERE / LIMIT, or the statement's end; a FROM anywhere at the top is a real CTAS.
  let end = t.length;
  let depth = 0;
  for (let j = select + 1; j < t.length; j++) {
    if (isPunct(t[j], '(')) depth++;
    else if (isPunct(t[j], ')')) depth--;
    else if (depth === 0 && t[j].kind === 'word') {
      const w = upper(t[j]);
      if (w === 'FROM' || w === 'UNION' || w === 'JOIN') return undefined;
      if (w === 'WHERE' || w === 'LIMIT') { end = j; break; }
    } else if (depth === 0 && isPunct(t[j], ';')) { end = j; break; }
  }
  const columns: TypedSelectColumn[] = [];
  for (const [from, to] of splitTopLevel(t, select + 1, end)) {
    const last = to - 1;
    if (last - from < 2 || upper(t[last - 1]) !== 'AS' || !isName(t[last])) return undefined;
    const exprEnd = last - 1;
    let type: string | undefined;
    let inner = true;
    for (let j = from; j < exprEnd && type === undefined; j++) {
      if (t[j].kind !== 'word' || !CAST_WORDS.has(upper(t[j])) || !isPunct(t[j + 1], '(')) continue;
      const close = matchParen(t, j + 1);
      if (close < 0 || close >= exprEnd) return undefined;
      let d = 0;
      for (let m = j + 2; m < close; m++) {
        if (isPunct(t[m], '(')) d++;
        else if (isPunct(t[m], ')')) d--;
        else if (d === 0 && upper(t[m]) === 'AS' && m + 1 < close) {
          type = (text !== undefined ? text.slice(t[m + 1].start, t[close - 1].end) : t.slice(m + 1, close).map((x) => x.value).join(' ')).replace(/\s+/g, ' ').trim();
          inner = !(j === from && close === exprEnd - 1);
          break;
        }
      }
    }
    if (!type) return undefined;
    columns.push({ first: from, last, name: t[last].value, type, inner, line: t[from].line });
  }
  return columns.length ? { select, end, columns } : undefined;
}

/** Words that make a CREATE TABLE one without a column list of its own (or one read elsewhere): never a stray before one. */
const NO_COLUMN_LIST_WORDS = new Set(['AS', 'LIKE', 'CLONE', 'PARTITION', 'OF', 'INHERITS', 'SELECT', 'COPY', 'USING', 'LOCATION']);
const NO_COLUMN_LIST_TEXT = new RegExp(`\\b(?:${[...NO_COLUMN_LIST_WORDS].join('|')})\\b`, 'i');

/**
 * Whether the tokens from `next` (just after a CREATE TABLE's name) are a
 * column list with a stray token before it: one or two tokens that are not
 * words of their own (a quoted name or string a lost quote left, a stray
 * punctuation mark) then `(`, or a quote left open that took the `(` to the
 * end of its line. Never when what stands before the list makes the
 * statement a CTAS, `LIKE`, `CLONE` or partition (`NO_COLUMN_LIST_WORDS`, in
 * the stray text too), when the list is a lone `LIKE t`, or when an `AS
 * SELECT` follows it. Words inside the column list are the columns' own (a
 * column named `location`, a generated column's `AS (…)`).
 */
function strayBeforeColumnList(t: Token[], next: number): boolean {
  const stray = t[next];
  let open: number;
  let close: number;
  if (stray && (stray.kind === 'ident' || stray.kind === 'string') && /\(\s*$/.test(stray.value)) {
    // A quote opened just before the `(` ran to the end of the line and took the `(` with it (`a" (`).
    if (NO_COLUMN_LIST_TEXT.test(stray.value.replace(/\(\s*$/, ''))) return false;
    open = next;
    close = -1;
    for (let k = next + 1, depth = 1; k < t.length; k++) {
      if (isPunct(t[k], '(')) depth++;
      else if (isPunct(t[k], ')') && --depth === 0) { close = k; break; }
    }
    if (close < 0 || close < next + 2) return false;
  } else {
    const at = [next + 1, next + 2].find((k) => isPunct(t[k], '('));
    if (at === undefined) return false;
    for (let k = next; k < at; k++) if (t[k].kind === 'word' || isPunct(t[k], ';') || isPunct(t[k], '.')) return false;
    for (let k = next; k < at; k++) if ((t[k].kind === 'ident' || t[k].kind === 'string') && NO_COLUMN_LIST_TEXT.test(t[k].value)) return false;
    open = at;
    close = matchParen(t, open);
    if (close <= open + 1) return false;
  }
  // `(LIKE y INCLUDING ALL)`: a copy of another table's columns.
  if (upper(t[open + 1]) === 'LIKE' && splitTopLevel(t, open + 1, close).length === 1) return false;
  for (let k = close + 1; k < t.length; k++) {
    if (upper(t[k]) === 'AS' && (upper(t[k + 1]) === 'SELECT' || isPunct(t[k + 1], '(') || upper(t[k + 1]) === 'WITH')) return false;
  }
  return true;
}

/** Whether a statement is a `CREATE TABLE` with a column list (never a CTAS or `LIKE`): {@link countCreateTablesWithColumns}'s test. */
function isCreateTableWithColumns(t: Token[]): boolean {
  const head = createTableName(t);
  if (!head) return false;
  const name = readName(t, head.at);
  // `CREATE TABLE x COMMENT = '…' (columns)`: read as the table without the clause, as readCreateTable reads it.
  const leading = name ? leadingTableComment(t, name.next) : undefined;
  if (leading) return isCreateTableWithColumns([...t.slice(0, leading.from), ...t.slice(leading.to + 1)]);
  if (name && !isPunct(t[name.next], '(') && typedSelectColumns(t, undefined, name.next)) return true;
  if (name && !isPunct(t[name.next], '(') && strayBeforeColumnList(t, name.next)) return true;
  if (!name || !isPunct(t[name.next], '(')) return false;
  const close = matchParen(t, name.next);
  if (close < 0 || close === name.next + 1) return false;
  for (let k = close + 1; k < t.length; k++) {
    if (upper(t[k]) === 'AS' && (upper(t[k + 1]) === 'SELECT' || isPunct(t[k + 1], '(') || upper(t[k + 1]) === 'WITH')) return typedColumnList(t, name.next, close);
  }
  return true;
}

/** The columns of a column list's own `[CONSTRAINT n] PRIMARY KEY [CLUSTERED] (a, b)` item, if it has one. */
function tablePrimaryKeyItem(t: Token[], open: number, close: number): string[] | undefined {
  for (const [from, to] of splitTopLevel(t, open + 1, close)) {
    let k = from;
    if (upper(t[k]) === 'CONSTRAINT') k += isName(t[k + 1]) ? 2 : 1;
    if (upper(t[k]) !== 'PRIMARY' || upper(t[k + 1]) !== 'KEY') continue;
    k += 2;
    while (k < to && !isPunct(t[k], '(')) k++;
    const list = k < to ? readColumnList(t, k) : undefined;
    return list && list.columns.length ? list.columns : undefined;
  }
  return undefined;
}

/**
 * A key's columns as the table spells them: an unquoted name is the same
 * name in any case (`Primary Key(L_ORDERKEY)` on `l_orderkey`), and DBML
 * reads a key's column only as its table writes it.
 */
function spelledAsColumns(table: ModelTable, columns: readonly string[]): string[] {
  return columns.map((c) => table.fields.find((f) => f.name === c)?.name ?? table.fields.find((f) => sameIdent(f.name, c))?.name ?? c);
}

/** How many times a converted DBML file is read back and what it rejects left out (each pass leaves out at least one statement). */
const MAX_DBML_CHECKS = 5;

/** The longest a skipped-summary line runs before the file's next kinds go on a line of their own. */
const SKIPPED_LINE_MAX = 300;

/**
 * A file's path as a skipped line names it: whole, or, when it would not leave
 * `room` characters of the line for what follows it, its end after `…` (short
 * enough, with its colon, that the shown line's cut of long runs leaves it whole).
 */
function skippedFileLabel(file: string, room: number): string {
  if (file.length <= SKIPPED_LINE_MAX - room) return file;
  const max = Math.max(24, Math.min(SKIPPED_LINE_MAX - room, MAX_SHOWN_RUN - 1));
  return `…${file.slice(file.length - max + 1)}`;
}

/** Above this many characters a script's INSERT statements are taken out before it is read (a dump with its data). */
export const STRIP_INSERTS_ABOVE_CHARS = 1024 * 1024;

/** `COPY … FROM stdin;` alone on its line: pg_dump's data block starts on the next line. */
const COPY_FROM_STDIN = /^[ \t]*COPY\b[^\n;]*\bFROM\s+stdin\b[^\n]*;[ \t]*\r?$/gim;
/** `INSERT INTO` at the start of a line. */
const INSERT_INTO = /^[ \t]*INSERT\s+(?:IGNORE\s+)?INTO\b/gim;

/**
 * A script without a dump's data, as the import reads it: pg_dump's
 * `COPY … FROM stdin;` blocks lose their rows (up to the `\.` line), and in a
 * script of more than {@link STRIP_INSERTS_ABOVE_CHARS} characters
 * (`mysqldump`, `pg_dump --inserts`) each `INSERT INTO … ;` becomes `INSERT;`.
 * Every line break is kept, so a line number still points into the user's
 * file, and the statements still count as skipped data. `sqlChars`: how
 * much SQL is left, not counting what stands in for the data taken out (its
 * line breaks, the `INSERT;`s): what the import's size limit is about.
 */
export function withoutSqlData(text: string): { text: string; sqlChars: number } {
  // [start, end, characters of SQL the placeholder keeps that are not SQL to count]
  const removed: Array<[number, number, number]> = [];
  COPY_FROM_STDIN.lastIndex = 0;
  for (let m = COPY_FROM_STDIN.exec(text); m; m = COPY_FROM_STDIN.exec(text)) {
    const dataStart = text.indexOf('\n', m.index + m[0].length - 1);
    if (dataStart < 0) break;
    const end = findCopyEnd(text, dataStart + 1);
    removed.push([dataStart + 1, end, 0]);
    COPY_FROM_STDIN.lastIndex = end;
  }
  if (text.length > STRIP_INSERTS_ABOVE_CHARS) {
    const escapes = BACKSLASH_ESCAPES.has(detectSqlDialect(text.slice(0, 256 * 1024)) ?? 'postgres') || /^-- (?:MySQL|MariaDB) dump/m.test(text.slice(0, 4096));
    INSERT_INTO.lastIndex = 0;
    let r = 0;
    for (let m = INSERT_INTO.exec(text); m; m = INSERT_INTO.exec(text)) {
      while (r < removed.length && removed[r][1] <= m.index) r++;
      if (r < removed.length && removed[r][0] <= m.index) { INSERT_INTO.lastIndex = removed[r][1]; continue; }
      const word = m.index + m[0].search(/INSERT/i);
      const end = findStatementEnd(text, word, escapes);
      // `INSERT` and its `;` stay (the statement is still counted as skipped data), but are not SQL to import.
      // With no `;` (it ends at a line break), `INSERT` and that line break.
      const lineEnd = text[end] !== ';' ? 1 : text.startsWith('\r\n', end + 1) ? 2 : text.startsWith('\n', end + 1) ? 1 : 0;
      removed.splice(r, 0, [word + 'INSERT'.length, end, (text[end] === ';' ? 'INSERT;' : 'INSERT').length + lineEnd]);
      r++;
      INSERT_INTO.lastIndex = end;
    }
  }
  if (removed.length === 0) return { text, sqlChars: text.length };
  removed.sort((a, b) => a[0] - b[0]);
  const parts: string[] = [];
  let at = 0;
  let padding = 0;
  for (const [start, end, kept] of removed) {
    parts.push(text.slice(at, start));
    const breaks = countLineBreaks(text, start, end);
    parts.push('\n'.repeat(breaks));
    padding += breaks + kept;
    at = end;
  }
  parts.push(text.slice(at));
  const out = parts.join('');
  return { text: out, sqlChars: out.length - padding };
}

/** Where a COPY data block that starts at `from` ends: after its `\.` line (or the end of the text). */
function findCopyEnd(text: string, from: number): number {
  let at = from;
  for (;;) {
    const eol = text.indexOf('\n', at);
    const line = text.slice(at, eol < 0 ? text.length : eol).replace(/\r$/, '');
    if (line === '\\.') return eol < 0 ? text.length : eol;
    if (eol < 0) return text.length;
    at = eol + 1;
  }
}

/**
 * Where the statement at `from` ends (outside strings, quoted names and
 * comments): its `;`, or, where a script writes none (SQL Server's
 * `Insert Into … Values (…)` lines batched by GO), the line break before a
 * `GO` line or a line that starts the next statement, as `splitStatements`
 * reads one. Else the end of the text.
 */
function findStatementEnd(text: string, from: number, escapes: boolean): number {
  const n = text.length;
  let depth = 0;
  for (let i = from; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c === 59 /* ; */) return i;
    if (c === 40 /* ( */) depth++;
    else if (c === 41 /* ) */) depth--;
    else if (c === 10 /* \n */ && depth <= 0 && startsNextStatement(text, i + 1)) return i;
    else if (c === 45 /* - */ && text.charCodeAt(i + 1) === 45) {
      const eol = text.indexOf('\n', i);
      if (eol < 0) return n;
      i = eol - 1;
      continue;
    } else if (c === 47 /* / */ && text.charCodeAt(i + 1) === 42 /* * */) {
      const close = text.indexOf('*/', i + 2);
      if (close < 0) return n;
      i = close + 1;
      continue;
    }
    if (c === 39 /* ' */ || c === 34 /* " */ || c === 96 /* ` */) {
      for (i++; i < n; i++) {
        const d = text.charCodeAt(i);
        if (escapes && d === 92 /* \ */) { i++; continue; }
        if (d === c) {
          if (text.charCodeAt(i + 1) === c) { i++; continue; }
          break;
        }
      }
    }
  }
  return n;
}

/** Whether the line at `at` is a `GO` line or starts a statement (`CREATE`, `INSERT`, `COMMENT ON`…). */
function startsNextStatement(text: string, at: number): boolean {
  const eol = text.indexOf('\n', at);
  const line = text.slice(at, eol < 0 ? text.length : eol);
  if (GO_LINE.test(line)) return true;
  const word = /^[ \t]*([A-Za-z]+)\b(?:[ \t]+([A-Za-z]+))?/.exec(line);
  if (!word) return false;
  const first = word[1].toUpperCase();
  return STATEMENT_KEYWORDS.has(first) || (first === 'COMMENT' && word[2]?.toUpperCase() === 'ON');
}

function countLineBreaks(text: string, from: number, to: number): number {
  let count = 0;
  for (let i = text.indexOf('\n', from); i >= 0 && i < to; i = text.indexOf('\n', i + 1)) count++;
  return count;
}

/**
 * Whether a statement defines or changes tables: CREATE … TABLE, ALTER TABLE,
 * RENAME TABLE, or SQL Server's `sp_rename`. A file with none (only DROPs) is
 * a teardown, not a migration.
 */
function definesOrChangesTables(t: Token[]): boolean {
  const w0 = upper(t[0]);
  if (w0 === 'CREATE') return t.slice(1, 8).some((tok) => upper(tok) === 'TABLE');
  if (w0 === 'ALTER' || w0 === 'RENAME') return upper(t[1]) === 'TABLE';
  if (w0 === 'EXEC' || w0 === 'EXECUTE') return t.slice(1, 6).some((tok) => /(^|\.)sp_rename$/i.test(tok.value));
  return false;
}

/** A file named like an ordered migration (Flyway `V3__…`, a numbered `003_…`, or one under a `migrations/` folder): its DROPs apply. */
export function looksLikeMigrationFile(name: string): boolean {
  return /(^|[\\/])(migrations?|flyway|changelogs?)[\\/]/i.test(name)
    || /(^|[\\/])(V\d+(?:[._]\d+)*__|\d{3,}[_-])[^\\/]*$/i.test(name);
}

/**
 * The converter: reads files statement by statement into one merged model
 * (`ConverterContext`, whose statement readers live in `sqlDdlStatements.ts`),
 * then resolves what was deferred and writes DBML (`sqlDdlWriter.ts`).
 */
class Converter implements ConverterContext {
  readonly tables: ModelTable[] = [];
  readonly enums: ModelEnum[] = [];
  readonly refs: PendingRef[] = [];
  readonly comments: PendingComment[] = [];
  readonly keys: PendingKey[] = [];
  readonly problems: SqlDdlProblem[] = [];
  readonly skippedLines: string[] = [];
  readonly notes: string[] = [];
  readonly skippedItems: SkippedItem[] = [];
  readonly ledger: ImportLedger = createLedger();
  private readonly skippedByFile = new Map<string, Map<SkipKind, number>>();
  /** `schema.table` names read as the table of that name with no schema ({@link findTable}), each said once. */
  private readonly qualifierNoted = new Set<string>();
  private placeholderCount = 0;
  /** Schema changes applied in file order (ALTER TABLE column changes, renames, DROP TABLE). */
  appliedChanges = 0;
  /** Whether the file being read applies its DROP TABLEs (a migration, not a teardown script). */
  dropsApply = true;
  /** The schema unqualified names are in (`USE`, `SET search_path`, `USE SCHEMA`); null: the dialect's default. */
  currentSchema: string | null = null;
  /** CREATE TABLE statements with a column list met in the files (an ALTER's added columns, read as a table of their own, aside). */
  tablesFound = 0;
  /** Inside {@link readColumnDefinitions}: a CREATE TABLE read there is not one of the files' tables. */
  private readingColumns = 0;
  /** While a table is read again with its missing commas put in: the commas, for the ledger. */
  private commaRepairs: MissingComma[] | undefined;
  /** How the files' tables were read. */
  readonly readWith: SqlReadWith = { grammar: 0, repaired: 0, salvaged: 0 };
  /** How each table counted in {@link readWith} was read: one the DBML read-back leaves out is taken off again. */
  readonly readHow = new Map<ModelTable, keyof SqlReadWith>();
  /** The statement being read (a skipped one is named in the log from it). */
  private currentStatement: Statement | undefined;
  /** Tables that went through the repair ladder, and when the first did (its budget). */
  private ladderTables = 0;
  private ladderStarted = 0;
  private ladderCapped = false;
  /** Statements read so far (every file), for progress and the stop. */
  statementsRead = 0;
  /** Set once `options.shouldStop` stops the reading: what was read, and where the unread part starts. */
  stopped: SqlConvertStop | undefined;
  /** A stop `options.shouldStop` gave during a statement (the repair ladder asks between tries): the next statement boundary stops there. */
  private stopSaid: SqlStopReason | undefined;
  /** For progress: characters in every file, and in the files read before this one. */
  totalChars = 0;
  private charsBefore = 0;
  private filesRead = 0;
  fileCount = 0;

  /** Placeholder names two different placeholders share across the files (`ambiguousPlaceholderNames`). */
  placeholderNames?: ReadonlySet<string>;

  constructor(readonly dialect: SqlDialect, readonly engine: SqlParseEngine, private readonly options: SqlDdlConvertOptions = {}) {}

  get partitionMode(): SqlPartitionMode {
    return this.options.partitions === 'tables' ? 'tables' : 'fold';
  }

  qualify(parts: readonly string[]): string[] {
    if (this.currentSchema === null || parts.length !== 1) return [...parts];
    return [this.currentSchema, ...parts];
  }

  skip(file: string, kind: SkipKind, count = 1, item?: { line?: number; name?: string }): void {
    let byKind = this.skippedByFile.get(file);
    if (!byKind) { byKind = new Map(); this.skippedByFile.set(file, byKind); }
    byKind.set(kind, (byKind.get(kind) ?? 0) + count);
    // A skipped object is named in the log with its line (`index job_log_uuid, line 12`); the draft keeps the counts.
    const placed = item ?? (count === 1 && NAMED_SKIPS.has(kind) && this.currentStatement ? skippedObject(this.currentStatement) : undefined);
    if (placed && this.skippedItems.length < MAX_NAMED_SKIPS) {
      this.skippedItems.push({ file, kind, ...(placed.line !== undefined ? { line: placed.line } : {}), ...(placed.name ? { name: placed.name } : {}) });
    }
  }

  /** Whether any statement of `file` was skipped (it was read, so it is not unused). */
  skippedIn(file: string): boolean {
    return (this.skippedByFile.get(file)?.size ?? 0) > 0;
  }

  /**
   * One line per file (`orders.sql: skipped 2 views, 1 index`); a file that
   * skipped many kinds goes on in `… also skipped …` lines, so no line runs
   * past {@link SKIPPED_LINE_MAX} characters and every kind is still counted.
   */
  skippedSummary(fileOrder: readonly string[]): string[] {
    const lines: string[] = [];
    for (const file of fileOrder) {
      const byKind = this.skippedByFile.get(file);
      if (!byKind || byKind.size === 0) continue;
      const parts = [...byKind].map(([kind, count]) => `${count} ${SKIP_LABELS[kind][count === 1 ? 0 : 1]}`);
      const where = skippedFileLabel(file, Math.max(...parts.map((p) => p.length)) + 16);
      let line = `${where}: skipped ${parts[0]}`;
      for (const part of parts.slice(1)) {
        if (line.length + 2 + part.length > SKIPPED_LINE_MAX) {
          lines.push(line);
          line = `${where}: also skipped ${part}`;
        } else {
          line += `, ${part}`;
        }
      }
      lines.push(line);
      // A table made from a query or another table is still a table the user may look for: named.
      const named = this.skippedItems.filter((item) => item.file === file && item.kind === 'ctas' && item.name);
      if (named.length) {
        const shown = named.slice(0, MAX_NAMED_CTAS).map((item) => (item.line !== undefined ? `${item.name} (line ${item.line})` : item.name!));
        const more = named.length - shown.length;
        const tail = more > 0 ? ` and ${more} more` : '';
        // As the counts: lines of at most SKIPPED_LINE_MAX characters, the rest on `… also not imported …` lines
        // (a path so long that a name would not fit beside it is shown by its end).
        const head = ': not imported, made from a query or another table with no column list of its own: ';
        const where = skippedFileLabel(file, head.length + Math.max(...shown.map((p) => p.length)) + tail.length);
        let named0 = `${where}${head}${shown[0]}`;
        for (const part of shown.slice(1)) {
          if (named0.length + 2 + part.length + tail.length > SKIPPED_LINE_MAX) {
            lines.push(named0);
            named0 = `${where}: also not imported (made from a query or another table): ${part}`;
          } else {
            named0 += `, ${part}`;
          }
        }
        lines.push(named0 + tail);
      }
    }
    return lines;
  }

  // -- files ---------------------------------------------------------------

  /** Reads one file; how many tables, enums, foreign keys, keys, comments and schema changes it gave (0: nothing). */
  readFile(file: SqlDdlFile): number {
    const count = (): number => this.tables.length + this.enums.length + this.refs.length + this.keys.length + this.comments.length + readerState(this).checks.length;
    const before = count();
    const appliedBefore = this.appliedChanges;
    const pass = prepareText(file.text, this.dialect, this.placeholderNames);
    const text = pass.text;
    const statements = splitStatements(text, this.dialect);
    if (pass.count > 0 && pass.example) {
      // One entry per file: how many statements held a placeholder, and the first as an example.
      let touched = 0;
      let p = 0;
      for (const st of statements) {
        while (p < pass.offsets.length && pass.offsets[p] < st.start) p++;
        if (p < pass.offsets.length && pass.offsets[p] <= st.end) touched++;
      }
      const detail = [
        `read as the names inside them (first: ${pass.example.text})`,
        ...(pass.catalogs ? [`${pass.catalogs.toLocaleString('en-US')} catalog ${pass.catalogs === 1 ? 'placeholder' : 'placeholders'} dropped`] : []),
        ...(pass.qualified ? [`${pass.qualified.toLocaleString('en-US')} read with every part, so two names stay apart`] : []),
      ].join('; ');
      this.ledger.repaired('statement', 'templatePlaceholder', 'template placeholders', { file: file.name, line: pass.example.line }, detail, Math.max(1, touched));
    }
    // DROP TABLE is applied only in a migration: a file that also defines or
    // changes tables, or one named like a migration. A file of DROPs alone (a
    // teardown or reset script, read after the CREATEs it undoes) is skipped
    // DROP statements, as the quick path never takes it (`isSqlScriptTaken`).
    this.dropsApply = looksLikeMigrationFile(file.name) || statements.some((st) => definesOrChangesTables(st.tokens));
    const { onProgress } = this.options;
    for (let j = 0; j < statements.length; j++) {
      // Between statements only: a statement is read whole or not at all.
      const reason = this.stopAsked();
      if (reason) { this.stop(reason, file.name, statements.slice(j)); break; }
      const statement = statements[j];
      this.currentStatement = statement;
      readStatement(this, file.name, text, statement);
      this.statementsRead++;
      if (onProgress) {
        const within = text.length ? (statement.end / text.length) * file.text.length : 0;
        this.reportProgress(Math.min(file.text.length, within));
      }
    }
    this.currentStatement = undefined;
    if (!this.stopped) {
      this.filesRead++;
      this.charsBefore += file.text.length;
    }
    const applied = this.appliedChanges - appliedBefore;
    const added = count() - before;
    // A migration that only drops or renames still did something.
    return applied > 0 ? Math.max(1, added + applied) : Math.max(0, added);
  }

  // -- stopping early ------------------------------------------------------

  /**
   * Whether the reading should stop: asked before every statement, and
   * between the repair ladder's tries (a stop then ends the climb, and the
   * table is salvaged, so one table's ladder never overruns the limit). Once
   * said, it holds until the next statement boundary stops there.
   */
  private stopAsked(): SqlStopReason | undefined {
    this.stopSaid ??= this.options.shouldStop?.();
    return this.stopSaid;
  }

  private reportProgress(charsInFile: number): void {
    this.options.onProgress?.({
      statementsRead: this.statementsRead,
      tablesRead: this.readWith.grammar + this.readWith.repaired + this.readWith.salvaged,
      filesRead: this.filesRead,
      files: this.fileCount,
      fraction: this.totalChars > 0 ? Math.min(1, (this.charsBefore + charsInFile) / this.totalChars) : 0,
    });
  }

  /** Stops the reading at the first of `rest` (statements of `file` not read): records it and the rest of the file. */
  private stop(reason: SqlStopReason, file: string, rest: readonly Statement[]): void {
    this.stopped = { reason, statementsRead: this.statementsRead, statementsUnread: 0, tablesUnread: 0, at: { file, line: rest[0]?.line ?? 1 } };
    this.recordUnread(file, rest);
  }

  /** A file the reading stopped before: every statement of it is unread. */
  skipUnreadFile(file: SqlDdlFile): void {
    const text = prepareText(file.text, this.dialect, this.placeholderNames).text;
    this.recordUnread(file.name, splitStatements(text, this.dialect));
  }

  /**
   * Unread statements of one file in the ledger, placed at the line where the
   * unread part starts: its CREATE TABLEs with a column list as one `table`
   * entry (counted in `tablesFound`, so the tables found are the tables read
   * plus the tables reported), the others as one `statement` entry.
   */
  private recordUnread(file: string, statements: readonly Statement[]): void {
    const stop = this.stopped;
    if (!stop || statements.length === 0) return;
    const tables = this.unreadTables(statements);
    const others = statements.length - tables;
    const where = { file, line: statements[0].line };
    const limit = this.options.timeLimitMs;
    const detail = stop.reason === 'cancelled'
      ? 'not read: the import was cancelled first'
      : `not read: the time limit${limit ? ` (${timeLimitText(limit)})` : ''} was reached first`;
    if (tables > 0) this.ledger.problem('table', stop.reason, 'CREATE TABLE', where, detail, tables);
    if (others > 0) this.ledger.problem('statement', stop.reason, '', where, detail, others);
    stop.statementsUnread += statements.length;
    stop.tablesUnread += tables;
    this.tablesFound += tables;
  }

  /** Names of the unread CREATE TABLEs counted so far, so a later `IF NOT EXISTS` of one is not counted again. */
  private readonly unreadTableNames: string[][] = [];

  /**
   * How many of `statements` (unread) are tables a full reading would count
   * in `tablesFound`: a CREATE TABLE with a column list, never a `#temp`
   * table or an `IF NOT EXISTS` of a table already defined (read, or unread
   * before it), as {@link readCreateTable} skips both.
   */
  private unreadTables(statements: readonly Statement[]): number {
    let count = 0;
    for (const st of statements) {
      const t = st.tokens;
      if (!isCreateTableWithColumns(t)) continue;
      const head = createTableName(t)!;
      if (isTempTableName(t, head.at) || isSessionTable(t, head.at, this.dialect)) continue;
      const name = readName(t, head.at);
      if (!name) continue;
      const parts = this.qualify(name.parts);
      const same = (other: readonly string[]): boolean => sameIdent(other[other.length - 1], parts[parts.length - 1])
        && sameSchema(other.length >= 2 ? other[other.length - 2] : null, parts.length >= 2 ? parts[parts.length - 2] : null, this.dialect);
      // An IF NOT EXISTS of a table defined before does nothing; a CREATE OR REPLACE of one replaces it (one table, counted once).
      if ((head.ifNotExists || replacesTable(t)) && (this.findTable(parts) || this.unreadTableNames.some(same))) continue;
      this.unreadTableNames.push(parts);
      count++;
    }
    return count;
  }

  // -- CREATE TABLE --------------------------------------------------------

  readCreateTable(file: string, text: string, st: Statement, at: number): void {
    const t = st.tokens;
    let i = at;
    const ifNotExists = upper(t[i]) === 'IF' && upper(t[i + 1]) === 'NOT' && upper(t[i + 2]) === 'EXISTS';
    if (ifNotExists) i += 3;
    // SQL Server's `#tmp` / `##global` scratch tables (the name reads after its `#`s).
    if (isTempTableName(t, i)) { this.skip(file, 'temporary'); return; }
    // `CREATE [LOCAL | GLOBAL] TEMP[ORARY] | VOLATILE TABLE`: a session's scratch table, gone when it ends (a
    // procedure's work table). Oracle's GLOBAL TEMPORARY TABLE is a lasting definition (only its rows are not).
    if (isSessionTable(t, at, this.dialect)) { this.skip(file, 'sessionTable'); return; }
    const name = readName(t, i);
    // SQLite keeps its own bookkeeping in tables named `sqlite_…` (`.schema` prints `CREATE TABLE sqlite_sequence(name,seq)`).
    if (name && this.dialect === 'sqlite' && /^sqlite_/i.test(name.parts[name.parts.length - 1])) { this.skip(file, 'internalTable'); return; }
    if (name && !isPunct(t[name.next], '(') && !this.readingTypedSelect) {
      // `CREATE TABLE x AS SELECT CAST(NULL AS int) AS a, … WHERE 1 = 0`: read as the column list it means.
      const typed = typedSelectColumns(t, text, name.next);
      if (typed) { this.readTypedSelect(file, text, st, at, name.next, typed); return; }
    }
    // `CREATE TABLE x COMMENT = '…' (columns)` (Snowflake takes the table's comment before its column list): the comment set aside, the table read.
    const leading = name && !this.readingLeadingComment ? leadingTableComment(t, name.next) : undefined;
    if (leading) { this.readLeadingComment(file, text, st, at, leading); return; }
    if (name && !isPunct(t[name.next], '(') && strayBeforeColumnList(t, name.next)) {
      // A column list behind a stray quote or word (`CREATE TABLE a" (`): a table that did not read, never a CTAS.
      if (this.readingColumns === 0) this.tablesFound++;
      this.problems.push({ file, line: st.line, message: `CREATE TABLE ${name.parts.join('.')}: something stands between its name and its column list (a stray quote or word).`, kind: 'structure', table: name.parts.slice(-2).join('.') });
      return;
    }
    if (!name || !isPunct(t[name.next], '(')) { this.skip(file, 'ctas'); return; }
    // A later migration's CREATE TABLE IF NOT EXISTS of a table already defined (or a partition created with none of its own columns) does nothing.
    if (ifNotExists && (this.findTable(this.qualify(name.parts)) || isChildWithoutTable(this, this.qualify(name.parts)))) { this.skip(file, 'existing'); return; }
    const open = name.next;
    const close = matchParen(t, open);
    if (close < 0) {
      if (this.readingColumns === 0) this.tablesFound++;
      this.problems.push({ file, line: st.line, message: `CREATE TABLE ${name.parts.join('.')}: its column list has no closing parenthesis.`, kind: 'structure', table: name.parts.slice(-2).join('.') });
      return;
    }
    // `CREATE TABLE x (LIKE y [INCLUDING …])` (PostgreSQL, Redshift): a copy of another table's columns, no list of its own.
    if (upper(t[open + 1]) === 'LIKE' && splitTopLevel(t, open + 1, close).length === 1) { this.skip(file, 'ctas'); return; }
    // `CREATE TABLE x (a, b) AS SELECT` names columns without types. `CREATE TABLE x (a INT, b STRING) AS SELECT`
    // (Snowflake, Databricks) types every one: the column list is the table, the query only fills it.
    for (let k = close + 1; k < t.length; k++) {
      if (upper(t[k]) === 'AS' && (upper(t[k + 1]) === 'SELECT' || isPunct(t[k + 1], '(') || upper(t[k + 1]) === 'WITH')) {
        if (!this.readingTypedSelect && typedColumnList(t, open, close)) { this.readColumnListOfQuery(file, text, st, at, k); return; }
        this.skip(file, 'ctas');
        return;
      }
    }
    if (this.readingColumns === 0) this.tablesFound++;
    const qualified = this.qualify(name.parts);
    const tableName = qualified[qualified.length - 1];
    const schema = qualified.length >= 2 ? qualified[qualified.length - 2] : null;
    const label = name.parts.slice(-2).join('.');
    const origin: Origin = { file, line: st.line };

    const read = this.parseCreateTable(file, text, st, name, open, close, label, tableName);
    if ('problem' in read) {
      // A comma missing between two columns: put it in and read the table again (once), recorded in the ledger.
      const fixed = this.commaRepairs ? undefined : this.withMissingCommas(text, st, open);
      if (fixed) {
        if (this.readingColumns === 0) this.tablesFound--;
        const problemsBefore = this.problems.length;
        this.commaRepairs = fixed.commas;
        try {
          this.readCreateTable(file, fixed.text, fixed.st, at);
        } finally {
          this.commaRepairs = undefined;
        }
        // Still unreadable: report it as the file has it (the problem names the missing comma), not the rewrite's.
        const added = this.problems.splice(problemsBefore);
        const parse = added.some((p) => p.kind === 'parse');
        this.problems.push(...added.filter((p) => p.kind !== 'parse'), ...(parse ? [read.problem] : []));
        return;
      }
      this.problems.push(read.problem);
      return;
    }
    const { raw, prepared } = read;
    // A grammar can hand a quoted keyword back with its quotes (SQL Server: `[VALUE]`): names are kept without them.
    const rawTable: RawSqlTable = {
      ...read.rawTable,
      fields: (read.rawTable.fields ?? []).map((f) => (grammarName(f.name) === f.name ? f : { ...f, name: grammarName(f.name) })),
      indexes: (read.rawTable.indexes ?? []).map((ix) => ({ ...ix, columns: (ix.columns ?? []).map((c) => (c.type === 'expression' ? c : { ...c, value: grammarName(c.value) })) })),
    };
    const columnSources = readColumnSources(t, open, close, ANGLE_TYPE_DIALECTS.has(this.dialect));
    const table: ModelTable = {
      name: tableName,
      schema,
      fields: [],
      uniques: [],
      checks: [],
      origin,
    };
    const seen = new Set<string>();
    const typelessColumns: string[] = [];
    for (const rf of rawTable.fields ?? []) {
      const key = rf.name.toLowerCase();
      if (seen.has(key)) {
        this.problems.push({ file, line: st.line, message: `CREATE TABLE ${label} has the column ${rf.name} twice.`, kind: 'structure', table: label });
        return;
      }
      seen.add(key);
      const field = toField(rf, prepared, text, columnSources.get(key));
      table.fields.push(field);
      if (read.typeless?.has(key) && field.type === 'unknown' && this.readingColumns === 0) {
        typelessColumns.push(field.name);
      }
    }
    if (table.fields.length === 0) {
      this.problems.push({ file, line: st.line, message: `CREATE TABLE ${label} has no columns.`, kind: 'structure', table: label });
      return;
    }
    let plainIndexes = 0;
    // Keys left out, recorded once the table is known to be kept (not a second definition).
    const keyLosses: Array<() => void> = [];
    for (const index of rawTable.indexes ?? []) {
      const parts = index.columns ?? [];
      const columns = parts.filter((c) => c.type !== 'expression').map((c) => c.value);
      if (!index.pk && !index.unique) { plainIndexes++; continue; }
      const unit = index.pk ? 'primaryKey' : 'uniqueKey';
      const where = { file, line: st.line, table: label, ...(index.name ? { column: index.name } : {}) };
      // A key on an expression is not a list of columns, and its other columns alone are a stronger key than the source's.
      if (parts.some((c) => c.type === 'expression')) {
        keyLosses.push(() => this.ledger.lost(unit, 'noField', index.pk ? 'expression primary key' : 'expression unique key', where, 'not kept: a key is a list of columns, not an expression'));
        continue;
      }
      // A key naming a column the table does not have would make the whole DBML unreadable: left out, said.
      const unknown = columns.find((c) => !table.fields.some((f) => sameIdent(f.name, c)));
      if (unknown !== undefined) {
        keyLosses.push(() => this.ledger.lost(unit, 'noField', index.pk ? 'primary key' : 'unique key', where, `not kept: it names ${unknown.length > 32 ? `${unknown.slice(0, 31)}…` : unknown}, which is not a column of the table`));
        continue;
      }
      // Unquoted names fold case (`Primary Key(L_ORDERKEY)` names the column l_orderkey): the key names the columns as the table does.
      const named = columns.map((c) => table.fields.find((f) => sameIdent(f.name, c))?.name ?? c);
      if (index.pk) this.setPrimaryKey(table, named);
      else if (named.length) this.addUnique(table, named);
    }
    // MySQL's and Snowflake's grammars put a one-column `PRIMARY KEY (C)` on the field spelled exactly `C`,
    // and drop it when the column is written `c`: an unquoted name is the same name in any case.
    if (!table.primaryKey && !table.fields.some((f) => f.pk)) {
      const key = tablePrimaryKeyItem(t, open, close);
      if (key && key.every((c) => table.fields.some((f) => sameIdent(f.name, c)))) this.setPrimaryKey(table, key);
    }
    plainIndexes += read.droppedIndexes;
    if (plainIndexes) this.skip(file, 'plainIndex', plainIndexes);
    for (const check of rawTable.checks ?? []) {
      if (check.expression) table.checks.push({ expression: check.expression, ...(check.name ? { name: check.name } : {}) });
    }
    table.note = tailComment(t, close + 1) ?? noteText(rawTable.note);
    if (this.readingColumns === 0) {
      // A table defined twice: the first definition stays, the second is reported and read no further.
      // CREATE OR REPLACE (OR ALTER, OR REFRESH) replaces it, as the database does: the later definition is the table.
      const first = this.findTable(qualified);
      if (first && sameIdent(first.name, tableName) && sameSchema(first.schema, schema, this.dialect) && replacesTable(t)) {
        replaceTable(this, first, upper(t[2]) === 'ALTER' ? table : undefined);
        // One table, read once: the definition replaced is no longer found or read (the dialect pick counts what the import yields).
        const how = this.readHow.get(first);
        if (how) { this.readWith[how]--; this.readHow.delete(first); this.tablesFound--; }
        this.appliedChanges++;
        this.ledger.changed('table', 'duplicate', 'CREATE OR REPLACE', { file, line: st.line, table: label }, upper(t[2]) === 'ALTER'
          ? `changes the definition at ${first.origin.file}, line ${first.origin.line}, to this column list; its foreign keys stay, as the database does`
          : `replaces the definition at ${first.origin.file}, line ${first.origin.line}, as the database does`);
      } else if (first && sameIdent(first.name, tableName) && sameSchema(first.schema, schema, this.dialect)) {
        this.problems.push({
          file,
          line: st.line,
          message: `Table ${tableLabel(table)} is defined twice (also in ${first.origin.file}, line ${first.origin.line}); the first definition is kept.`,
          kind: 'duplicateTable',
          cause: 'duplicate',
          table: label,
        });
        return;
      }
      this.readWith[read.how]++;
      this.readHow.set(table, read.how);
      for (const c of this.commaRepairs ?? []) {
        this.ledger.repaired('column', 'parseError', 'missing comma', { file, line: c.line, table: label, column: c.after },
          `a comma added between ${shortName(c.after)} and ${shortName(c.before)}`);
      }
      for (const r of read.repairs) {
        this.ledger.repaired(r.unit, r.cause, r.what, { file, line: r.line, table: label, ...(r.column ? { column: r.column } : {}) }, r.detail);
      }
      for (const record of keyLosses) record();
      for (const column of typelessColumns) {
        const at = t.find((tok, k) => k > open && k < close && isName(tok) && tok.value === column)?.line ?? st.line;
        this.ledger.changed('type', 'inferred', 'column without a type', { file, line: at, table: label, column }, 'none declared: typed unknown');
      }
    }
    this.tables.push(table);

    for (const ref of raw.refs ?? []) {
      // The grammars hand a quoted name back with its doubled quotes (`"a""b"` as a""b): read as the file means it.
      const ends = (ref.endpoints ?? []).map((e) => ({
        ...e,
        tableName: grammarName(e.tableName),
        ...(e.schemaName ? { schemaName: grammarName(e.schemaName) } : {}),
        ...(e.fieldNames ? { fieldNames: e.fieldNames.map(grammarName) } : {}),
      }));
      if (ends.length !== 2) continue;
      const fkIndex = ends[0].relation?.includes('*') ? 0 : ends[1].relation?.includes('*') ? 1 : sameIdent(ends[0].tableName, tableName) ? 0 : 1;
      const fk = ends[fkIndex];
      const pk = ends[1 - fkIndex];
      this.refs.push({
        from: { parts: this.qualify([...(fk.schemaName ? [fk.schemaName] : []), fk.tableName]), columns: fk.fieldNames ?? [] },
        to: { parts: this.qualify([...(pk.schemaName ? [pk.schemaName] : []), pk.tableName]), columns: pk.fieldNames ?? [] },
        origin,
        fromTable: sameIdent(fk.tableName, tableName) ? table : undefined,
        ...(ref.name ? { name: ref.name } : {}),
        ...(typeof ref.onDelete === 'string' && ref.onDelete ? { onDelete: ref.onDelete } : {}),
        ...(typeof ref.onUpdate === 'string' && ref.onUpdate ? { onUpdate: ref.onUpdate } : {}),
      });
    }
    for (const e of raw.enums ?? []) this.addEnum(e, origin);
  }

  /**
   * One CREATE TABLE's raw model: as written by the dialect's grammar; else
   * rewritten by the repair ladder (its rungs with this grammar, then the
   * other grammars); else salvaged without a grammar; else a problem with
   * its line, a cause and a short reason.
   */
  private parseCreateTable(
    file: string, text: string, st: Statement, name: { parts: string[]; next: number; first: number },
    open: number, close: number, label: string, tableName: string,
  ): { raw: RawSqlDatabase; prepared: PreparedSql; rawTable: RawSqlTable; repairs: Repair[]; how: keyof SqlReadWith; droppedIndexes: number; typeless?: ReadonlySet<string> } | { problem: SqlDdlProblem } {
    const own = SQL_PARSE_FORMAT[this.dialect];
    const preStepped = isPreStepped(this.dialect) ? rewriteDialectTable(this.dialect, text, st, name, open, close) : undefined;
    const strict: PreparedSql = preStepped
      ?? (this.dialect === 'databricks'
        ? this.rewriteDatabricksTable(text, st, name, open, close)
        : { sql: this.dialect === 'snowflake' ? snowflakeInlineReferences(text, st, open, close) : text.slice(st.start, st.end), types: new Map<string, string>(), comments: new Map<string, string>(), identity: new Set<string>() });
    // The repair ladder starts from what the dialect's pre-steps made of the statement (Oracle, BigQuery, Redshift, SQLite).
    let ladderFrom: Restatement | undefined;
    const withPreSteps = (prepared: PreparedSql): PreparedSql => (preStepped ? mergePrepared(preStepped, prepared) : prepared);
    const tableOf = (raw: RawSqlDatabase): RawSqlTable | undefined => {
      const found = (raw.tables ?? []).find((rt) => sameIdent(rt.name, tableName)) ?? raw.tables?.[0];
      return found && (found.fields?.length ?? 0) > 0 ? found : undefined;
    };
    let strictError: unknown;
    // Parentheses nested deeper than any real definition (a generated or hostile CHECK) take the
    // grammars seconds to minutes each: such a table is read without them (salvage), at once.
    const tooDeep = parenDepth(st.tokens, open, close) > MAX_GRAMMAR_PAREN_DEPTH;
    if (tooDeep) {
      strictError = new Error(`parentheses nested more than ${MAX_GRAMMAR_PAREN_DEPTH} deep`);
    } else try {
      const raw = this.engine(strict.sql, own);
      const rawTable = tableOf(raw);
      if (rawTable) return { raw, prepared: strict, rawTable, repairs: [], how: 'grammar', droppedIndexes: 0, typeless: preStepped?.typeless };
      strictError = new Error('the parser found no table in it');
    } catch (error) {
      strictError = error;
    }
    const repairOn = this.options.repair !== false;
    // A rewrite reads only when it reads the columns the file lists (a forgiving grammar can read stray words as a column).
    const expected = columnNamesOf(st.tokens, open, close);
    const sameColumns = (rawTable: RawSqlTable): boolean => {
      const got = (rawTable.fields ?? []).map((f) => grammarName(f.name).toLowerCase());
      return got.length === expected.length && got.every((n, k) => n === expected[k]);
    };
    // The ladder, within its budget.
    if (repairOn && !tooDeep && this.ladderAllowed()) {
      this.ladderTables++;
      type Attempt = { raw: RawSqlDatabase; rawTable: RawSqlTable; rewrite: ReturnType<typeof rewriteCreateTable> } | undefined;
      if (preStepped) ladderFrom = restatement(strict.sql, st.line);
      // Each rewrite is parsed once; the same SQL again (a rung that changed nothing) has the same answer.
      const tried = new Map<string, Attempt>();
      const attempt = (format: SqlParseFormat, rungs: ReadonlySet<RepairRung>): Attempt => {
        const rewrite = ladderFrom
          ? rewriteCreateTable({ ...ladderFrom, dialect: 'postgres', target: format, rungs })
          : rewriteCreateTable({ text, st, name, open, close, dialect: this.dialect, target: format, rungs });
        const key = `${format}\u0000${rewrite.prepared.sql}`;
        if (tried.has(key)) { const seen = tried.get(key); return seen && { ...seen, rewrite }; }
        let result: Attempt;
        try {
          const raw = this.engine(rewrite.prepared.sql, format);
          const rawTable = tableOf(raw);
          result = rawTable && sameColumns(rawTable) ? { raw, rawTable, rewrite } : undefined;
        } catch {
          result = undefined;
        }
        tried.set(key, result);
        return result;
      };
      for (const rungs of REPAIR_LADDER) {
        // Stopped (cancelled, or the time limit) part-way up: no more tries, the table is salvaged.
        if (this.stopAsked()) break;
        let ok = attempt(own, rungs);
        if (!ok) continue;
        // The rungs are cumulative: keep only those the table needed, so the ledger names what made it read
        // (a column named like a keyword is not "quoted so it reads" when a VIRTUAL column was the problem).
        const needed = new Set(rungs);
        for (const rung of rungs) {
          if (needed.size === 1 || this.stopAsked()) break;
          const fewer = new Set([...needed].filter((r) => r !== rung));
          const smaller = attempt(own, fewer);
          if (smaller) { needed.delete(rung); ok = smaller; }
        }
        return { raw: ok.raw, prepared: withPreSteps(ok.rewrite.prepared), rawTable: ok.rawTable, repairs: ok.rewrite.repairs, how: 'repaired', droppedIndexes: ok.rewrite.droppedIndexes, typeless: preStepped?.typeless };
      }
      for (const format of OTHER_GRAMMARS) {
        if (this.stopAsked()) break;
        if (format === own) continue;
        const ok = attempt(format, ALL_RUNGS);
        if (ok) {
          const repairs: Repair[] = [...ok.rewrite.repairs, { rung: 'allTypes', unit: 'table', cause: 'grammarGap', what: 'CREATE TABLE', detail: 'read with another dialect\'s grammar', line: st.line }];
          return { raw: ok.raw, prepared: withPreSteps(ok.rewrite.prepared), rawTable: ok.rawTable, repairs, how: 'repaired', droppedIndexes: ok.rewrite.droppedIndexes, typeless: preStepped?.typeless };
        }
      }
    }
    // Salvage: the column list read without a grammar. A pre-stepped dialect's from what its pre-step made of the
    // statement (Oracle's `NOT NULL ENABLE`, BigQuery's `OPTIONS(…)` set aside), else from the file as written.
    const steppedFrom = preStepped ? (ladderFrom ?? restatement(strict.sql, st.line)) : undefined;
    let salvaged = repairOn && steppedFrom
      ? salvageCreateTable(steppedFrom.text, steppedFrom.st, steppedFrom.name, steppedFrom.open, steppedFrom.close)
      : undefined;
    let salvagedStepped = !!salvaged?.ok;
    if (repairOn && !salvaged?.ok) {
      const plain = salvageCreateTable(text, st, name, open, close);
      if (plain.ok || !salvaged) { salvaged = plain; salvagedStepped = false; }
    }
    if (salvaged?.ok) {
      const rawTable = salvaged.raw.tables![0];
      const repairs: Repair[] = [tooDeep
        ? { rung: 'allTypes', unit: 'table', cause: 'grammarGap', what: 'column list', detail: `read without the SQL grammar (names, types, keys, references): parentheses nested more than ${MAX_GRAMMAR_PAREN_DEPTH} deep`, line: st.line }
        : { rung: 'allTypes', unit: 'table', cause: 'grammarGap', what: 'column list', detail: 'read without the SQL grammar (names, types, keys, references)', line: st.line }];
      const prepared: PreparedSql = salvagedStepped && preStepped
        ? { sql: '', types: preStepped.types, comments: preStepped.comments, identity: preStepped.identity }
        : { sql: '', types: new Map(), comments: new Map(), identity: new Set() };
      return { raw: salvaged.raw, prepared, rawTable, repairs, how: 'salvaged', droppedIndexes: 0, ...(salvagedStepped ? { typeless: preStepped?.typeless } : {}) };
    }
    // A problem: the hint the scan found on the failing line, else the reason salvage gave, else the grammar's.
    const diagnostic = firstDiagnostic(strictError);
    const diagnosticLine = diagnostic.line ? st.line + diagnostic.line - 1 : undefined;
    const failLine = salvaged && !salvaged.ok ? salvaged.line : undefined;
    // The hints from what the pre-step left (a type it reads behind a placeholder is not the cause), at the file's lines.
    const hints = steppedFrom
      ? repairHints(steppedFrom.text, steppedFrom.st, steppedFrom.open, steppedFrom.close)
      : repairHints(text, st, open, close);
    const hint = hints.find((h) => h.line === failLine || h.line === diagnosticLine) ?? (failLine === undefined && diagnosticLine === undefined ? hints[0] : undefined);
    const reason = hint?.phrase ?? (salvaged && !salvaged.ok ? salvaged.reason : diagnostic.message);
    const cause: LedgerCause = hint?.cause ?? (salvaged && !salvaged.ok ? salvaged.cause : diagnostic.crash ? 'grammarGap' : 'parseError');
    return {
      problem: {
        file,
        line: failLine ?? diagnosticLine ?? hint?.line ?? st.line,
        message: `CREATE TABLE ${label} could not be read: ${reason}`,
        kind: 'parse',
        clause: rejectedSqlClause(strict.sql, diagnostic.line),
        cause,
        table: label,
      },
    };
  }

  /**
   * The statement with every missing comma between column definitions put
   * in ({@link missingCommas}), re-read; undefined when none is missing.
   * Commas go right after a type, so every line keeps its number; a few
   * passes catch several missing in one run of columns.
   */
  /** Set while a typed empty SELECT is read as its column list ({@link readTypedSelect}): never twice. */
  private readingTypedSelect = false;

  /**
   * A CREATE TABLE whose SELECT is a typed empty table ({@link typedSelectColumns})
   * read as `CREATE TABLE x (a type, …)`: the rewrite keeps every line break,
   * so each column is at its own line; the reading, and each type taken from
   * inside an expression, are in the ledger.
   */
  private readTypedSelect(file: string, text: string, st: Statement, at: number, nameEnd: number, typed: NonNullable<ReturnType<typeof typedSelectColumns>>): void {
    const t = st.tokens;
    const cols = typed.columns;
    const edits = [
      { start: t[nameEnd].start, end: t[cols[0].first].start, text: '(' },
      ...cols.map((c) => ({ start: t[c.first].start, end: t[c.last].end, text: `${text.slice(t[c.last].start, t[c.last].end)} ${c.type}` })),
      { start: t[cols[cols.length - 1].last].end, end: st.end, text: ')' },
    ];
    const rewritten = applyEdits(text, st.start, st.end, edits);
    const newText = text.slice(0, st.start) + rewritten + text.slice(st.end);
    const tokens = tokenize(rewritten, this.dialect).map((tok) => ({ ...tok, start: tok.start + st.start, end: tok.end + st.start, line: tok.line + st.line - 1 }));
    // The table this statement made (a CREATE OR REPLACE takes the old one out, so the count may not grow).
    const lastBefore = this.tables[this.tables.length - 1];
    this.readingTypedSelect = true;
    try {
      this.readCreateTable(file, newText, { ...st, tokens, end: st.start + rewritten.length }, at);
    } finally {
      this.readingTypedSelect = false;
    }
    const newest = this.tables[this.tables.length - 1];
    const table = newest !== lastBefore ? newest : undefined;
    if (!table || this.readingColumns > 0) return;
    const label = tableLabel(table);
    this.ledger.changed('table', 'inferred', 'CREATE TABLE … AS SELECT', { file, line: st.line, table: label },
      'its columns read from a SELECT of typed values with no FROM (an empty table of those types)');
    for (const c of cols) {
      if (c.inner) this.ledger.changed('type', 'inferred', 'type from an expression', { file, line: c.line, table: label, column: c.name }, 'the type of the CAST inside it');
    }
  }

  /** Set while a table's leading `COMMENT = '…'` is set aside ({@link readLeadingComment}): never twice. */
  private readingLeadingComment = false;

  /**
   * `CREATE TABLE x COMMENT = '…' (a INT, …)` read as `CREATE TABLE x (a INT, …)`
   * with the comment as the table's note (unless the statement has its own
   * after the column list). The clause is blanked, so every line keeps its number.
   */
  private readLeadingComment(file: string, text: string, st: Statement, at: number, leading: { from: number; to: number; comment: string }): void {
    const t = st.tokens;
    const start = t[leading.from].start;
    const end = t[leading.to].end;
    const newText = text.slice(0, start) + text.slice(start, end).replace(/[^\n]/g, ' ') + text.slice(end);
    const tokens = [...t.slice(0, leading.from), ...t.slice(leading.to + 1)];
    // The table this statement made (a CREATE OR REPLACE takes the old one out, so the count may not grow).
    const lastBefore = this.tables[this.tables.length - 1];
    this.readingLeadingComment = true;
    try {
      this.readCreateTable(file, newText, { ...st, tokens }, at);
    } finally {
      this.readingLeadingComment = false;
    }
    const newest = this.tables[this.tables.length - 1];
    const table = newest !== lastBefore ? newest : undefined;
    if (table && table.note === undefined && leading.comment) table.note = leading.comment;
  }

  /**
   * `CREATE TABLE x (a INT, …) AS SELECT …` read as `CREATE TABLE x (a INT, …)`:
   * the statement ends before its `AS` (index `as`), so the query is never
   * given to a grammar. The reading is in the ledger.
   */
  private readColumnListOfQuery(file: string, text: string, st: Statement, at: number, as: number): void {
    const tokens = st.tokens.slice(0, as);
    // The table this statement made (a CREATE OR REPLACE takes the old one out, so the count may not grow).
    const lastBefore = this.tables[this.tables.length - 1];
    this.readingTypedSelect = true;
    try {
      this.readCreateTable(file, text, { ...st, tokens, end: tokens[tokens.length - 1].end }, at);
    } finally {
      this.readingTypedSelect = false;
    }
    const newest = this.tables[this.tables.length - 1];
    const table = newest !== lastBefore ? newest : undefined;
    if (!table || this.readingColumns > 0) return;
    this.ledger.changed('table', 'inferred', 'CREATE TABLE … AS SELECT', { file, line: st.line, table: tableLabel(table) },
      'its columns read from the typed column list; the query that fills it is not imported');
  }

  private withMissingCommas(text: string, st: Statement, open: number): { text: string; st: Statement; commas: MissingComma[] } | undefined {
    const commas: MissingComma[] = [];
    let curText = text;
    let cur = st;
    for (let pass = 0; pass < MAX_COMMA_PASSES; pass++) {
      const close = matchParen(cur.tokens, open);
      if (close < 0) break;
      const found = missingCommas(cur.tokens, open, close);
      if (found.length === 0) break;
      const offsets = found.map((c) => c.offset).sort((a, b) => b - a);
      for (const at of offsets) curText = `${curText.slice(0, at)},${curText.slice(at)}`;
      const end = cur.end + found.length;
      const tokens = tokenize(curText.slice(cur.start, end), this.dialect).map((tok) => ({ ...tok, start: tok.start + cur.start, end: tok.end + cur.start, line: tok.line + cur.line - 1 }));
      // The statement's own tokens end where it does: no `;` the split did not give it.
      const last = cur.tokens[cur.tokens.length - 1];
      if (tokens.length && isPunct(tokens[tokens.length - 1], ';') && !(last && isPunct(last, ';'))) tokens.pop();
      cur = { ...cur, tokens, end };
      commas.push(...found);
    }
    return commas.length ? { text: curText, st: cur, commas } : undefined;
  }

  /** Whether another table may go through the repair ladder (its budget: a count and a time). */
  private ladderAllowed(): boolean {
    const maxTables = this.options.ladderTables ?? REPAIR_LADDER_MAX_TABLES;
    const maxMs = this.options.ladderMs ?? REPAIR_LADDER_MAX_MS;
    if (this.ladderTables === 0) this.ladderStarted = Date.now();
    const allowed = this.ladderTables < maxTables && Date.now() - this.ladderStarted <= maxMs;
    if (!allowed && !this.ladderCapped && this.readingColumns === 0) {
      this.ladderCapped = true;
      this.ledger.repaired('statement', 'capped', 'repair budget', undefined,
        `more than ${maxTables.toLocaleString('en-US')} tables needed rewriting: the rest were read without the SQL grammar`);
    }
    return allowed;
  }

  addUnique(table: ModelTable, columns: string[]): void {
    const field = columns.length === 1 ? table.fields.find((f) => sameIdent(f.name, columns[0])) : undefined;
    if (field) field.unique = true;
    else table.uniques.push(spelledAsColumns(table, columns));
  }

  setPrimaryKey(table: ModelTable, columns: string[]): void {
    if (columns.length === 0) return;
    if (columns.length === 1) {
      const field = table.fields.find((f) => sameIdent(f.name, columns[0]));
      if (field) { field.pk = true; return; }
    }
    table.primaryKey = spelledAsColumns(table, columns);
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
      // A Lakeflow expectation (`CONSTRAINT n EXPECT (…) [ON VIOLATION …]`): a pipeline's data-quality rule, not a
      // constraint; it goes with the comma before it (or after it, when it comes first). afterCreateTable records it.
      if (isExpectation(t, from)) {
        if (isPunct(t[from - 1], ',')) blank(t[from - 1].start, t[to - 1].end);
        else blank(t[from].start, isPunct(t[to], ',') && to < close ? t[to].end : t[to - 1].end);
        continue;
      }
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
        // Spark takes a double-quoted string too (`COMMENT "…"`).
        if (word === 'COMMENT' && (t[k + 1]?.kind === 'string' || isDoubleQuotedComment(t[k + 1]))) {
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

  readCreateType(file: string, st: Statement, at: number): void {
    const t = st.tokens;
    const name = readName(t, at);
    if (!name || upper(t[name.next]) !== 'AS' || upper(t[name.next + 1]) !== 'ENUM') { this.skip(file, 'type'); return; }
    const origin: Origin = { file, line: st.line };
    const list = readStringList(t, name.next + 2);
    if (!list) {
      this.problems.push({ file, line: st.line, message: `CREATE TYPE ${name.parts.join('.')} AS ENUM has no value list.`, kind: 'structure' });
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

  // -- schema changes, applied in file order ---------------------------------

  /** A change the files make to something they do not define (yet): said, with its file and line. */
  notApplied(where: Origin, what: string): void {
    this.skippedLines.push(`${where.file} line ${where.line}: ${what}`);
  }

  /** Column definitions `t[from, to)`, read by this dialect's grammar as a table of their own; undefined when they do not read. */
  readColumnDefinitions(text: string, tokens: Token[], from: number, to: number, file: string): { table: ModelTable; refs: PendingRef[] } | undefined {
    if (from >= to) return undefined;
    const definition = text.slice(tokens[from].start, tokens[to - 1].end);
    const synthetic = `CREATE TABLE ${ALTER_COLUMNS_TABLE} (\n${definition}\n)`;
    const statement = splitStatements(synthetic, this.dialect)[0];
    if (!statement) return undefined;
    const before = { tables: this.tables.length, refs: this.refs.length, problems: this.problems.length, enums: this.enums.length };
    this.readingColumns++;
    try {
      this.readCreateTable(file, synthetic, statement, 2);
    } finally {
      this.readingColumns--;
    }
    const table = this.tables.length > before.tables ? this.tables[before.tables] : undefined;
    const refs = this.refs.splice(before.refs);
    const failed = this.problems.length > before.problems;
    this.tables.splice(before.tables);
    this.problems.splice(before.problems);
    this.enums.splice(before.enums);
    if (failed || !table) return undefined;
    return { table, refs: refs.filter((r) => r.fromTable === table) };
  }

  // -- merging ---------------------------------------------------------------

  /**
   * Tables some of which name the dialect's default schema (`[dbo].[Region]`)
   * and some none (`"Orders"`, which is in it too) are one schema: the ones
   * with none are written in it, as the files spell it (said once). PostgreSQL's
   * and Snowflake's `public` is no schema to DBML already.
   */
  oneDefaultSchema(): void {
    const fallback = DEFAULT_SCHEMA[this.dialect];
    if (!fallback || fallback === 'public') return;
    const spelled = this.tables.find((tb) => tb.schema !== null && sameIdent(tb.schema, fallback))?.schema;
    const bare = this.tables.filter((tb) => tb.schema === null);
    if (!spelled || bare.length === 0) return;
    for (const tb of bare) tb.schema = spelled;
    this.ledger.changed('table', 'normalised', 'default schema', undefined,
      `${bare.length === 1 ? 'a table' : `${bare.length} tables`} with no schema written in ${shortName(spelled)}, the default schema other CREATE TABLEs name`);
  }

  findTable(parts: readonly string[]): ModelTable | undefined {
    const name = parts[parts.length - 1];
    const schema = parts.length >= 2 ? parts[parts.length - 2] : null;
    const candidates = this.tables.filter((tb) => sameIdent(tb.name, name));
    if (schema !== null) {
      const found = candidates.find((tb) => sameSchema(tb.schema, schema, this.dialect));
      if (found) return found;
      // Oracle and BigQuery scripts often create a table unqualified (in the user's schema, the default dataset)
      // and name it qualified elsewhere (`ALTER TABLE hr.employees`, `REFERENCES project.dataset.t`): the one table.
      if (QUALIFIED_MATCHES_UNQUALIFIED.has(this.dialect) && candidates.length === 1 && candidates[0].schema === null) return candidates[0];
      // `ALTER TABLE TPCD.REGION` in a script whose CREATE TABLEs name no schema (run with TPCD as the
      // default): when no table at all is in that schema, the one table of that name with none.
      const bare = candidates.filter((tb) => sameSchema(tb.schema, null, this.dialect));
      if (bare.length !== 1 || this.tables.some((tb) => tb.schema !== null && sameIdent(tb.schema, schema))) return undefined;
      const label = `${schema}.${name}`;
      if (!this.qualifierNoted.has(label.toLowerCase())) {
        this.qualifierNoted.add(label.toLowerCase());
        this.ledger.changed('table', 'inferred', 'schema qualifier', { table: label },
          `read as ${shortName(bare[0].name)}: no CREATE TABLE in the files is in schema ${shortName(schema)}`);
      }
      return bare[0];
    }
    if (candidates.length === 1) return candidates[0];
    return candidates.find((tb) => sameSchema(tb.schema, null, this.dialect));
  }

  applyDeferred(): void {
    // Partition children folded into their parents (or kept as tables) first: what the files say about one is then about its table.
    resolvePartitions(this);
    for (const key of this.keys) {
      const table = this.findTable(key.table);
      if (!table) { this.skippedLines.push(`${key.origin.file} line ${key.origin.line}: a key on ${key.table.join('.')}, which is not in the files`); continue; }
      const columns = key.columns.map((c) => table.fields.find((f) => sameIdent(f.name, c))?.name);
      if (columns.some((c) => !c)) { this.skippedLines.push(`${key.origin.file} line ${key.origin.line}: a key on ${tableLabel(table)} names a column it does not have`); continue; }
      if (key.kind === 'pk') this.setPrimaryKey(table, columns as string[]);
      else this.addUnique(table, columns as string[]);
    }
    for (const comment of this.comments) {
      const table = comment.target && this.tables.includes(comment.target) ? comment.target : this.findTable(comment.table);
      // A comment on a view (Oracle's sample schemas describe theirs): views are not imported, so neither is it.
      if (!table && isView(this, comment.table)) { this.skip(comment.origin.file, 'comment', 1, { line: comment.origin.line, name: ledgerText(comment.table.join('.'), 64) }); continue; }
      if (!table) { this.skippedLines.push(`${comment.origin.file} line ${comment.origin.line}: a comment on ${comment.table.join('.')}, which is not in the files`); continue; }
      // An empty text (`IS NULL`) clears what an earlier comment set.
      if (!comment.column) { if (comment.text) table.note = comment.text; else delete table.note; continue; }
      const field = table.fields.find((f) => sameIdent(f.name, comment.column as string));
      if (!field) { this.skippedLines.push(`${comment.origin.file} line ${comment.origin.line}: a comment on ${tableLabel(table)}.${comment.column}, which is not one of its columns`); continue; }
      if (comment.text) field.note = comment.text; else delete field.note;
    }
  }

  /**
   * The ledger as the result carries it: what was recorded while reading,
   * every problem (a unit that did not read), and the skipped statements
   * counted per file and kind (those the reader could place, one each).
   */
  ledgerEntries(fileOrder: readonly string[]): LedgerEntry[] {
    const ledger = createLedger(this.ledger.entries);
    for (const p of this.problems) {
      const cause = p.cause ?? (p.kind === 'parse' ? 'parseError' : p.kind === 'duplicateTable' ? 'duplicate' : 'other');
      const what = p.kind === 'duplicateTable' ? 'table defined twice' : p.table !== undefined ? 'CREATE TABLE' : 'statement';
      const detail = p.kind === 'duplicateTable' ? 'not read again: the first definition is kept' : PROBLEM_DETAILS[cause] ?? PROBLEM_DETAILS.other;
      ledger.problem(p.table !== undefined || p.kind === 'duplicateTable' ? 'table' : 'statement', cause, what,
        { file: p.file, ...(p.line !== undefined ? { line: p.line } : {}), ...(p.table ? { table: p.table } : {}) }, detail);
    }
    const placed = new Map<string, number>();
    for (const item of this.skippedItems) {
      const key = `${item.file}\u0000${item.kind}`;
      placed.set(key, (placed.get(key) ?? 0) + 1);
      ledger.skipped('statement', 'notDesign', SKIP_LABELS[item.kind][0], { file: item.file, ...(item.line !== undefined ? { line: item.line } : {}), ...(item.name ? { table: item.name } : {}) });
    }
    for (const file of fileOrder) {
      for (const [kind, count] of this.skippedByFile.get(file) ?? []) {
        const rest = count - (placed.get(`${file}\u0000${kind}`) ?? 0);
        if (rest > 0) ledger.skipped('statement', 'notDesign', SKIP_LABELS[kind][0], { file }, undefined, rest);
      }
    }
    return ledger.entries;
  }

  /** Makes every table and schema name one ERD Studio accepts; says what changed. */
  sanitiseNames(): void {
    const keyOf = (schema: string | null, name: string): string => `${(schema ?? '').toLowerCase()}.${name.toLowerCase()}`;
    for (const table of this.tables) {
      if (table.schema === null || /^[A-Za-z0-9_]+$/.test(table.schema)) continue;
      const schema = withoutAccents(table.schema).replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'schema';
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

/** Dialects whose unqualified tables are in a schema the script does not name (Oracle's user, BigQuery's default dataset). */
const QUALIFIED_MATCHES_UNQUALIFIED: ReadonlySet<SqlDialect> = new Set<SqlDialect>(['oracle', 'bigquery']);

/** The name an ALTER TABLE's added columns are read under (as a table of their own). */
const ALTER_COLUMNS_TABLE = 'erd_studio_added_columns';

/** What a problem's ledger line says, by cause (the log has each one's line and reason). */
const PROBLEM_DETAILS: Partial<Record<LedgerCause, string>> = {
  parseError: 'could not be read: a syntax error (Show Logs has each line)',
  grammarGap: 'could not be read: the SQL parser has no rule for it (Show Logs has each line)',
  templatePlaceholder: 'could not be read: a template placeholder (Show Logs has each line)',
  unknownType: 'could not be read: a type the SQL parser does not know (Show Logs has each line)',
  reservedWord: 'could not be read: a name like a keyword (Show Logs has each line)',
  trailingOption: 'could not be read: a table option (Show Logs has each line)',
  unsupportedModifier: 'could not be read: a column modifier (Show Logs has each line)',
  other: 'could not be read (Show Logs has each line)',
};

/**
 * A Snowflake CREATE TABLE as its grammar reads it: a column's inline
 * `REFERENCES t (c)` (which Snowflake accepts) spelt `FOREIGN KEY REFERENCES`,
 * the only form `@dbml/core`'s Snowflake grammar has. The same meaning, so
 * still "as written"; without it every table with an inline reference went
 * down the repair ladder (and past its budget, to salvage).
 */
function snowflakeInlineReferences(text: string, st: Statement, open: number, close: number): string {
  const t = st.tokens;
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const [from, to] of splitTopLevel(t, open + 1, close, true)) {
    // Columns only: a table constraint's `FOREIGN KEY (a) REFERENCES` already reads.
    if (to <= from + 1 || !isName(t[from]) || isConstraintItem(t, from, to)) continue;
    let depth = 0;
    for (let k = from + 1; k < to; k++) {
      if (isPunct(t[k], '(')) depth++;
      else if (isPunct(t[k], ')')) depth--;
      else if (depth === 0 && upper(t[k]) === 'REFERENCES' && upper(t[k - 1]) !== 'KEY') edits.push({ start: t[k].start, end: t[k].start, text: 'FOREIGN KEY ' });
    }
  }
  return edits.length ? applyEdits(text, st.start, st.end, edits) : text.slice(st.start, st.end);
}

/** A rewritten CREATE TABLE as a statement of its own, for the repair ladder: its tokens' lines are the file's. */
interface Restatement {
  text: string;
  st: Statement;
  name: { parts: string[]; next: number; first: number };
  open: number;
  close: number;
}

/** {@link Restatement} of a pre-step's SQL (`sqlDdlDialects.ts`), whose first line is the file's `line`; undefined when it is no CREATE TABLE with a column list. */
function restatement(sql: string, line: number): Restatement | undefined {
  const tokens = tokenize(sql, 'postgres').map((tok) => ({ ...tok, line: tok.line + line - 1 }));
  const head = createTableName(tokens);
  if (!head) return undefined;
  const name = readName(tokens, head.at);
  if (!name || !isPunct(tokens[name.next], '(')) return undefined;
  const close = matchParen(tokens, name.next);
  if (close < 0) return undefined;
  return { text: sql, st: { tokens, start: 0, end: sql.length, line }, name, open: name.next, close };
}

/** What a pre-step set aside, with what the repair ladder then set aside on top of it (a ladder placeholder over a pre-step's one reads as the file's type). */
function mergePrepared(pre: PreparedSql, ladder: PreparedSql): PreparedSql {
  const types = new Map(pre.types);
  for (const [key, value] of ladder.types) types.set(key, pre.types.get(value) ?? value);
  return {
    sql: ladder.sql,
    types,
    comments: new Map([...pre.comments, ...ladder.comments]),
    identity: new Set([...pre.identity, ...ladder.identity]),
  };
}

/** Deeper than this, a column list never goes to a grammar (their parse time grows steeply with depth: 200 levels take seconds). */
export const MAX_GRAMMAR_PAREN_DEPTH = 40;

/** How many passes put missing commas into one column list (each finds at most one per column). */
const MAX_COMMA_PASSES = 8;

/** A column name as the ledger shows it: at most 32 characters. */
function shortName(name: string): string {
  return name.length > 32 ? `${name.slice(0, 31)}…` : name;
}

/**
 * Whether the words between CREATE and the table's name (`t[1..at)`) make it a session's temporary table.
 * Never a Lakeflow (Delta Live Tables) `TEMPORARY LIVE` / `TEMPORARY STREAMING` table: a pipeline's dataset,
 * kept for the pipeline and read downstream as `LIVE.x` (TEMPORARY there means only that it is not published).
 */
function isSessionTable(t: readonly Token[], at: number, dialect: SqlDialect): boolean {
  let temporary = false;
  let global = false;
  let pipeline = false;
  for (let k = 1; k < at && k < 12; k++) {
    const w = upper(t[k]);
    if (w === 'TEMP' || w === 'TEMPORARY' || w === 'VOLATILE') temporary = true;
    if (w === 'GLOBAL') global = true;
    if (w === 'LIVE' || w === 'STREAMING') pipeline = true;
  }
  return temporary && !pipeline && !(global && dialect === 'oracle');
}

/** Whether a CREATE TABLE replaces a table of its name: `CREATE OR REPLACE | OR ALTER | OR REFRESH`. */
function replacesTable(t: readonly Token[]): boolean {
  return upper(t[0]) === 'CREATE' && upper(t[1]) === 'OR' && ['REPLACE', 'ALTER', 'REFRESH'].includes(upper(t[2]));
}

/**
 * Whether the column list `t(open, close)` declares a type for every column
 * (`(a INT, b STRING COMMENT 'x', PRIMARY KEY (a))`), not only names
 * (`(a, b)`, `(a COMMENT 'x')`): a CREATE TABLE … AS SELECT's own table.
 */
function typedColumnList(t: readonly Token[], open: number, close: number): boolean {
  let columns = 0;
  for (const [from, to] of splitTopLevel(t as Token[], open + 1, close, true)) {
    if (from >= to || isConstraintItem(t, from, to)) continue;
    if (!isName(t[from]) || to - from < 2 || t[from + 1].kind !== 'word' || /^(COMMENT|NOT|NULL|DEFAULT|PRIMARY|UNIQUE|REFERENCES|MASK|WITH)$/i.test(t[from + 1].value)) return false;
    columns++;
  }
  return columns > 0;
}

/** The deepest parenthesis nesting inside a column list `t(open, close)`. */
function parenDepth(t: readonly Token[], open: number, close: number): number {
  let depth = 0;
  let max = 0;
  for (let k = open + 1; k < close; k++) {
    if (isPunct(t[k], '(')) { depth++; if (depth > max) max = depth; } else if (isPunct(t[k], ')')) depth--;
  }
  return max;
}

/** The grammars the repair ladder tries after the dialect's own, most forgiving first. */
const OTHER_GRAMMARS: readonly SqlParseFormat[] = ['postgres', 'mssql', 'mysql', 'snowflake'];

/** Skipped statements named in the log, one each (data, session and permission statements are only counted). */
const NAMED_SKIPS: ReadonlySet<SkipKind> = new Set<SkipKind>(['view', 'index', 'routine', 'sequence', 'type', 'ctas', 'internalTable', 'sessionTable', 'existing', 'alter', 'comment', 'schema', 'other']);
/** At most this many tables made from a query are named in a file's skipped lines (the log names them all). */
const MAX_NAMED_CTAS = 20;
/** At most this many skipped statements are named (a dump of thousands is counted). */
const MAX_NAMED_SKIPS = 2000;

/** A skipped statement's line, and the object it names when it names one (`CREATE INDEX x`, `CREATE VIEW s.v`, `ALTER TABLE t`). */
function skippedObject(st: Statement): { line: number; name?: string } {
  const t = st.tokens;
  let i = -1;
  if (upper(t[0]) === 'CREATE') {
    // CREATE [OR REPLACE] [ALGORITHM=x DEFINER=`u`@`h` SQL SECURITY y] VIEW name: the name after the object word.
    const limit = Math.min(t.length, 24);
    i = 1;
    while (i < limit && !(t[i].kind === 'word' && CREATE_OBJECT_WORDS.has(upper(t[i])))) i++;
    if (i >= limit) return { line: st.line };
    i++;
  } else if (upper(t[0]) === 'ALTER' || upper(t[0]) === 'DROP' || upper(t[0]) === 'COMMENT') {
    i = 2;
  }
  if (i < 0) return { line: st.line };
  // `IF NOT EXISTS`, and Oracle's `PACKAGE BODY` / `TYPE BODY` (the body's name follows).
  while (/^(IF|NOT|EXISTS|ONLY|ON|CONCURRENTLY|BODY)$/.test(upper(t[i])) && t[i + 1] && t[i + 1].kind !== 'punct') i++;
  const name = readName(t, i);
  return name ? { line: st.line, name: ledgerText(name.parts.join('.'), 64) } : { line: st.line };
}

/** The longest a parser's reason may run in a problem message. */
const MAX_DIAGNOSTIC = 80;

/**
 * A parser's first diagnostic as one short line a user can read: its line
 * (relative to the statement), and a message of at most
 * {@link MAX_DIAGNOSTIC} characters with no echoed comments, line breaks or
 * literal `\r\n` escapes, the echoed input cut to its last word and an
 * `expecting {…}` list trimmed to its first few. A grammar crash (not a
 * syntax error) says nothing a user can act on, so it is said plainly
 * (`crash`).
 */
export function firstDiagnostic(error: unknown): { line?: number; message: string; crash: boolean } {
  const first = Array.isArray(error) ? error[0] : (error as { diags?: unknown[] } | undefined)?.diags?.[0] ?? error;
  const candidate = first as { message?: unknown; text?: unknown; location?: { start?: { line?: unknown } } } | undefined;
  const line = typeof candidate?.location?.start?.line === 'number' ? candidate.location.start.line : undefined;
  const raw = typeof candidate?.message === 'string' && candidate.message ? candidate.message
    : typeof candidate?.text === 'string' ? candidate.text : String(first);
  if (/Cannot read properties|is not a function|undefined|null \(reading/.test(raw)) {
    return { ...(line !== undefined ? { line } : {}), message: 'the SQL parser could not read this statement', crash: true };
  }
  return { ...(line !== undefined ? { line } : {}), message: cleanDiagnostic(raw), crash: false };
}

/** A parser message, cleaned (see {@link firstDiagnostic}). */
export function cleanDiagnostic(raw: string): string {
  // Literal escapes are line breaks the parser echoed: read them as such, so an echoed `--` comment ends with its line.
  let m = raw
    .replace(/\\r\\n|\\n|\\r/g, '\n')
    .replace(/\\t/g, ' ')
    .replace(/\/\*[\s\S]*?(\*\/|$)/g, ' ')
    .replace(/--[^\n]*/g, ' ');
  // `no viable alternative at input 'CREATE TABLE … FILE_FORMAT'`: only the word it stopped on.
  m = m.replace(/at input '([\s\S]*)'\s*$/, (_all, input: string) => {
    const words = input.replace(/\s+/g, ' ').trim().split(' ');
    const last = words[words.length - 1] ?? '';
    return `at input '${last.length > 24 ? `${last.slice(0, 23)}…` : last}'`;
  });
  // `expecting {'INDEX', ')', ','}`: the first two.
  m = m.replace(/expecting \{([^}]*)\}/g, (_all, list: string) => {
    const items = list.split(/,\s*(?=')/).map((x) => x.trim()).filter(Boolean);
    return items.length <= 2 ? `expecting ${items.join(' or ')}` : `expecting ${items.slice(0, 2).join(' or ')}…`;
  });
  return ledgerText(m, MAX_DIAGNOSTIC, true);
}

/** A name without the quotes a grammar left on it (`[VALUE]`, `"x"`, `` `x` ``). */
function unquotedName(name: string): string {
  const m = /^\[(.+)\]$|^"(.+)"$|^`(.+)`$/.exec(name);
  return m ? (m[1] ?? m[2] ?? m[3]) : name;
}

/**
 * A name as a grammar handed it back, as the file means it: without its
 * quotes (`[VALUE]`), and an embedded quote no longer doubled (`a""b`,
 * ``a``b``, `a]]b` → `a"b`, `` a`b ``, `a]b`), as the tokenizer reads it.
 */
function grammarName(name: string): string {
  return unquotedName(name).replace(/""/g, '"').replace(/``/g, '`').replace(/\]\]/g, ']');
}

/** The nearest `TABLE_NAME_PATTERN` name (Import DBML's rule: `sanitiseDbmlTableName`). */
function sanitiseTableName(name: string): string {
  if (TABLE_NAME_PATTERN.test(name)) return name;
  let out = withoutAccents(name).replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!out) return 'table';
  if (!/^[A-Za-z]/.test(out)) out = `t_${out}`;
  return out;
}

/** A name with its letters' accents taken off (`Über` → `Uber`, `naïve` → `naive`), so a rename keeps the word. */
function withoutAccents(name: string): string {
  return name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss').replace(/[Ææ]/g, (c) => (c === 'Æ' ? 'AE' : 'ae')).replace(/[Øø]/g, (c) => (c === 'Ø' ? 'O' : 'o'));
}

/** Whether a name can be a model's warehouse `alias` (core's `isValidTableAlias`). */
function isWarehouseName(name: string): boolean {
  return name.length <= 128 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Converts SQL DDL files to one DBML file, with `engine` as the SQL parser
 * (`sqlImportEngine.ts`'s `sqlDdlToDbml` passes `@dbml/core`'s). Every file
 * is read, and one statement that does not read never stops the rest: a
 * table the grammar cannot read as written goes down the repair ladder
 * (`sqlDdlRepair.ts`), then salvage (`sqlDdlSalvage.ts`), and only then is a
 * problem; a table defined twice keeps its first definition. When at least
 * one table reads the result is `ok: true`, its `problems` the units that did
 * not read (each also a `problem` ledger entry). `ok: false` only when there
 * are no files, or no table read at all.
 */
/**
 * Reads a converted DBML file as Import DBML will (`readDbml`): the lines it
 * rejects, 1-based. `sqlImportEngine.ts` passes one, so a table or reference
 * the converter wrote but DBML cannot read is left out and said, never the
 * reason the whole import fails.
 */
export type DbmlCheck = (dbml: string) => ReadonlyArray<{ line: number; message: string }>;

export function convertSqlDdl(input: SqlDdlToDbmlInput & { options?: SqlDdlConvertOptions }, engine: SqlParseEngine, check?: DbmlCheck): SqlDdlToDbmlResult {
  const result = convertFiles(input, engine, check);
  const safe = safeShownText((input.files ?? []).map((f) => f.name));
  const problems = result.problems.map((p) => ({ ...p, message: safe(p.message) }));
  return result.ok
    ? { ...result, problems, skipped: result.skipped.map(safe), notes: result.notes.map(safe) }
    : { ...result, problems };
}

/** The longest run of characters without a space a shown line keeps (a 5,000-character quoted name is cut). */
export const MAX_SHOWN_RUN = 96;
const LONG_RUN = new RegExp(`[^\\s\\ue000\\ue001]{${MAX_SHOWN_RUN + 1},}`, 'g');

/**
 * What every line the user reads goes through: control characters and line
 * breaks (a quoted name may hold them) become spaces, and any run of more
 * than {@link MAX_SHOWN_RUN} characters without a space (a generated or
 * hostile name) is cut, so a message never echoes a wall of file text. The
 * files' own names are kept whole (a long path is still the user's file).
 */
function safeShownText(fileNames: readonly string[]): (text: string) => string {
  const names = [...new Set(fileNames.filter((n) => n.length > MAX_SHOWN_RUN / 2))].sort((a, b) => b.length - a.length);
  return (text) => {
    // eslint-disable-next-line no-control-regex
    let out = text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ');
    const kept: string[] = [];
    for (const name of names) {
      if (!out.includes(name)) continue;
      out = out.split(name).join(`\ue000${kept.length}\ue001`);
      kept.push(name);
    }
    out = out.replace(LONG_RUN, (run) => `${run.slice(0, MAX_SHOWN_RUN - 1)}…`);
    return kept.length ? out.replace(/\ue000(\d+)\ue001/g, (_m, k: string) => kept[Number(k)]) : out;
  };
}

function convertFiles(input: SqlDdlToDbmlInput & { options?: SqlDdlConvertOptions }, engine: SqlParseEngine, check?: DbmlCheck): SqlDdlToDbmlResult {
  if (!isSqlDialect(input.dialect)) {
    return { ok: false, problems: [{ file: '', message: `Unknown SQL dialect: ${String(input.dialect)}.` }] };
  }
  if (input.files.length === 0) return { ok: false, problems: [{ file: '', message: 'No SQL files to import.', kind: 'noFiles' }] };
  const converter = new Converter(input.dialect, engine, input.options);
  converter.fileCount = input.files.length;
  converter.totalChars = input.files.reduce((n, f) => n + f.text.length, 0);
  // A placeholder reads the same in every file: by its full name wherever its short one would name two things.
  converter.placeholderNames = ambiguousPlaceholderNames(input.files.map((f) => withoutPlaceholdersYet(f.text, input.dialect)), input.dialect);
  const unused: string[] = [];
  for (const file of input.files) {
    // Stopped (cancelled, or the time limit): every later file is unread, and in the ledger.
    if (converter.stopped) { converter.skipUnreadFile(file); continue; }
    const read = converter.readFile(file);
    // A file the reading stopped in was not read to its end: never "no tables in it".
    if (converter.stopped) continue;
    // A file whose statements were only skipped was read: its skipped line says what it held.
    if (read === 0 && !converter.problems.some((p) => p.file === file.name) && !converter.skippedIn(file.name)) unused.push(file.name);
  }
  input.options?.onReadingEnd?.();
  const fileOrder = input.files.map((f) => f.name);
  const stopped = converter.stopped ? { stopped: converter.stopped } : {};
  if (converter.tables.length === 0) {
    if (converter.problems.length || converter.stopped) {
      return { ok: false, problems: converter.problems, ledger: converter.ledgerEntries(fileOrder), tablesFound: converter.tablesFound, readWith: converter.readWith, ...stopped };
    }
    const problem: SqlDdlProblem = { file: input.files.length === 1 ? input.files[0].name : '', message: `No CREATE TABLE statements with a column list were found in ${input.files.length === 1 ? 'the file' : 'the files'}.`, kind: 'noCreateTable' };
    // One entry per file, each where the report and the log can point (its first line).
    for (const file of input.files) converter.ledger.problem('file', 'other', 'no CREATE TABLE with a column list', { file: file.name, line: 1 });
    return { ok: false, problems: [problem], ledger: converter.ledgerEntries(fileOrder), tablesFound: converter.tablesFound, readWith: converter.readWith };
  }
  converter.applyDeferred();
  let refs = resolveRefs(converter);
  if (converter.appliedChanges > 0) {
    converter.notes.push(`${converter.appliedChanges} later schema ${converter.appliedChanges === 1 ? 'change was' : 'changes were'} applied in file order (columns added, renamed, changed or dropped; keys dropped; tables renamed or dropped).`);
  }
  converter.sanitiseNames();
  converter.oneDefaultSchema();
  const usedEnums = converter.enums.filter((e) =>
    converter.tables.some((tb) => tb.fields.some((f) => {
      const parts = f.type.split('.');
      return sameIdent(parts[parts.length - 1], e.name) && (parts.length === 1 || sameSchema(parts[0], e.schema, input.dialect));
    })),
  );
  const unusedEnums = converter.enums.length - usedEnums.length;
  let written = writeDbmlMapped(usedEnums, converter.tables, refs);
  // What DBML cannot read is left out at its statement, never the whole import (a key naming a column
  // the table spells otherwise once failed every table, pointing into the converted file).
  for (let pass = 0; check && pass < MAX_DBML_CHECKS; pass++) {
    const diagnostics = check(written.dbml);
    if (diagnostics.length === 0) break;
    const tables = new Map<ModelTable, string>();
    const badRefs = new Map<ResolvedRef, string>();
    for (const d of diagnostics) {
      const owner = ownerOfLine(written.owners, d.line);
      if (owner?.ref && !badRefs.has(owner.ref)) badRefs.set(owner.ref, d.message);
      else if (owner?.table && !owner.ref && !tables.has(owner.table)) tables.set(owner.table, d.message);
    }
    // Two references between the same columns (`a.x → b.y` and `b.y → a.x`): DBML rejects every one of them, though
    // the first alone reads. It is kept, the others left out (a reference rejected for anything else is read again).
    const sameEnds = new Map<string, ResolvedRef[]>();
    for (const r of refs) {
      if (!SAME_ENDPOINTS.test(badRefs.get(r) ?? '')) continue;
      const key = refEndpointsKey(r);
      sameEnds.set(key, [...(sameEnds.get(key) ?? []), r]);
    }
    for (const group of sameEnds.values()) if (group.length > 1) badRefs.delete(group[0]);
    if (tables.size === 0 && badRefs.size === 0) break;
    for (const [table, message] of tables) {
      converter.tables.splice(converter.tables.indexOf(table), 1);
      // A table left out was not read, whichever way it first read (the dialect ranking compares these counts).
      const how = converter.readHow.get(table);
      if (how) { converter.readWith[how]--; converter.readHow.delete(table); }
      converter.problems.push({
        file: table.origin.file, line: table.origin.line, kind: 'structure', table: tableLabel(table),
        message: `Table ${tableLabel(table)} could not be written as DBML (${ledgerText(cleanDiagnostic(message), 120, true)}), so it is left out.`,
      });
    }
    refs = refs.filter((r) => {
      const dropped = tables.has(r.from) || tables.has(r.to);
      const message = badRefs.get(r);
      if (!dropped && message === undefined) return true;
      const origin = r.pending?.origin;
      converter.ledger.lost('relationship', 'parseError', 'foreign key',
        { ...(origin ? { file: origin.file, line: origin.line } : {}), table: tableLabel(r.from), column: r.fromColumns.join('+') },
        dropped ? `not kept: ${tableLabel(tables.has(r.from) ? r.from : r.to)} is left out` : `not kept: it could not be written as DBML (${ledgerText(cleanDiagnostic(message ?? ''), 80, true)})`);
      return false;
    });
    if (converter.tables.length === 0) {
      return { ok: false, problems: converter.problems, ledger: converter.ledgerEntries(fileOrder), tablesFound: converter.tablesFound, readWith: converter.readWith, ...stopped };
    }
    written = writeDbmlMapped(usedEnums, converter.tables, refs);
  }
  const partitions = readerState(converter).partitionsResolved;
  const skipped = [
    ...unused.map((name) => `${name}: no tables, keys or comments in it`),
    ...converter.skippedSummary(fileOrder),
    ...converter.skippedLines,
    ...(unusedEnums ? [`${unusedEnums} enum type${unusedEnums === 1 ? '' : 's'} no column uses`] : []),
  ];
  return {
    ok: true,
    dbml: written.dbml,
    tableCount: converter.tables.length,
    refCount: refs.length,
    skipped,
    notes: converter.notes,
    problems: converter.problems,
    ledger: converter.ledgerEntries(fileOrder),
    tablesFound: converter.tablesFound,
    readWith: converter.readWith,
    ...stopped,
    ...(partitions && (partitions.folded || partitions.kept) ? { partitions: { ...partitions } } : {}),
  };
}

/** DBML's message for two references between the same columns (`dbmlFileCompile.ts`'s SAME_ENDPOINTS_MESSAGE). */
const SAME_ENDPOINTS = /References with same endpoints exist/i;

/** A reference's two ends, in either direction: two references with the same key join the same columns. */
function refEndpointsKey(r: ResolvedRef): string {
  const end = (table: ModelTable, columns: string[]): string => `${(table.schema ?? '').toLowerCase()}.${table.name.toLowerCase()}(${columns.map((c) => c.toLowerCase()).join(',')})`;
  return [end(r.from, r.fromColumns), end(r.to, r.toColumns)].sort().join('|');
}

/** `0.5 s`, `90 s`, `2 min`, `2 min 30 s`: a time limit as the ledger and the messages say it. */
export function timeLimitText(ms: number): string {
  if (ms < 10_000) return `${Number((ms / 1000).toFixed(1))} s`;
  const s = Math.round(ms / 1000);
  if (s < 120) return `${s} s`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
}
