/**
 * The SQL DDL converter's types: the public shapes `sqlDdlImport.ts`
 * re-exports (dialects, problems, the parser's raw model), the merged model
 * the converter builds (tables, enums and the foreign keys, keys and
 * comments still to resolve), and {@link ConverterContext}, the interface the
 * statement readers (`sqlDdlStatements.ts`) work against.
 *
 * Pure: no `vscode`, no `@dbml/core`. Bundled into `dist/cli.js` and
 * `dist/sqlImport.js`.
 */

import type { ImportLedger, LedgerCause } from './importLedger';
import type { Statement, Token } from './sqlDdlLexer';

// ---------------------------------------------------------------------------
// Public types (re-exported by sqlDdlImport.ts)
// ---------------------------------------------------------------------------

/** The SQL dialects Import SQL DDL… reads. */
export type SqlDialect = 'postgres' | 'mysql' | 'sqlserver' | 'snowflake' | 'databricks';

export interface SqlDdlFile {
  /** How messages name the file (a base name or a workspace-relative path). */
  name: string;
  text: string;
}

export interface SqlDdlToDbmlInput {
  files: readonly SqlDdlFile[];
  dialect: SqlDialect;
}

/**
 * What a partition or inheritance child with no columns of its own becomes
 * (`PARTITION OF`, `ATTACH PARTITION`, `INHERITS`): `fold` (the default) reads
 * it as its parent's rows, so it is no table of its own (one ledger note per
 * child); `tables` keeps each as a table with its parent's columns.
 */
export type SqlPartitionMode = 'fold' | 'tables';

/**
 * The kinds of {@link SqlDdlProblem}: a statement the grammar could not read
 * (`parse`), one it read but that cannot be a table (`structure`: no closing
 * parenthesis, no columns, a column twice, an enum with no values), a table
 * defined twice, no CREATE TABLE at all, or no files.
 */
export type SqlProblemKind = 'parse' | 'structure' | 'duplicateTable' | 'noCreateTable' | 'noFiles';

/** The leading keywords of a rejected clause, as fixed classes (telemetry only). */
export type SqlClause = 'CreateTable' | 'CreateOrReplace' | 'AlterTable' | 'CreateView' | 'CommentOn' | 'CreateIndex' | 'Grant' | 'SetUse' | 'Other';

export interface SqlDdlProblem {
  file: string;
  /** 1-based line in that file, when the problem has one. */
  line?: number;
  message: string;
  /** What kind of problem (telemetry only, never shown): absent for a dialect that is not one. */
  kind?: SqlProblemKind;
  /** A `parse` problem: the clause the parser rejected, matched on the device against fixed keywords (telemetry only). */
  clause?: SqlClause;
  /** Why, as a fixed class (the ledger's cause): what the message explains in words. */
  cause?: LedgerCause;
  /** The table it is about, when it is about one (its name as written, schema-qualified when the SQL was). */
  table?: string;
}

/** The grammar each dialect is read with (Databricks: rewritten for Postgres first). */
export type SqlParseFormat = 'postgres' | 'mysql' | 'mssql' | 'snowflake';

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
  onDelete?: string | null;
  onUpdate?: string | null;
}

export interface RawSqlEnum {
  name: string;
  schemaName?: string | null;
  values?: Array<{ name: string; note?: string | { value?: string } | null }>;
}

// ---------------------------------------------------------------------------
// The merged model
// ---------------------------------------------------------------------------

export interface Origin { file: string; line: number }

export interface ModelField {
  name: string;
  type: string;
  pk: boolean;
  unique: boolean;
  notNull: boolean;
  increment: boolean;
  default?: { type: 'number' | 'string' | 'boolean' | 'expression' | 'null'; value: string };
  note?: string;
  checks: string[];
  /** The type exactly as the file wrote it, when `type` differs (a placeholder restored, a detail the writer could not say). */
  typeAsWritten?: string;
  /** A generated column's expression and kind (`GENERATED ALWAYS AS (…) STORED | VIRTUAL`). */
  generated?: { expression: string; kind?: 'stored' | 'virtual' };
  /** A SQL Server computed column (`AS <expr> [PERSISTED]`). */
  computed?: { expression: string; persisted: boolean };
  /** Column modifiers DBML has no field for, as fixed phrases (`ON UPDATE`, `COLLATE`…): the ledger counts them. Never written. */
  modifiers?: string[];
  /** Its inline named constraints (`CONSTRAINT pk_x PRIMARY KEY`): the table's `constraintNames`. Never written. */
  constraints?: Array<{ name: string; kind: 'pk' | 'unique' | 'fk' | 'check' }>;
}

export interface ModelTable {
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
  /** Constraint names by kind, as written (`DROP CONSTRAINT` replays them): name → what it constrains. */
  constraintNames?: Array<{ name: string; kind: 'pk' | 'unique' | 'fk' | 'check'; columns: string[] }>;
  /** A partition of another table (`PARTITION OF parent`, `ATTACH PARTITION`): the parent's name parts. */
  partitionOf?: string[];
}

export interface ModelEnum {
  name: string;
  schema: string | null;
  values: Array<{ name: string; note?: string }>;
  origin: Origin;
}

export interface PendingRef {
  /** The FK side, as named in the SQL. */
  from: { parts: string[]; columns: string[] };
  /** The referenced side; no columns means its primary key. */
  to: { parts: string[]; columns: string[] };
  origin: Origin;
  /** The FK table itself, when the ref came from inside its CREATE TABLE. */
  fromTable?: ModelTable;
  /** The constraint's name, as written. */
  name?: string;
  /** `ON DELETE` / `ON UPDATE` actions, as written (`CASCADE`, `SET NULL`…). */
  onDelete?: string;
  onUpdate?: string;
}

export interface PendingComment {
  table: string[];
  column?: string;
  text: string;
  origin: Origin;
}

export interface PendingKey {
  table: string[];
  kind: 'pk' | 'unique';
  columns: string[];
  origin: Origin;
  /** The constraint's or unique index's name, as written (`DROP CONSTRAINT` / `DROP INDEX` replay it). */
  name?: string;
}

/** A ref resolved to the tables and columns it joins, ready to write. */
export interface ResolvedRef {
  from: ModelTable;
  fromColumns: string[];
  to: ModelTable;
  toColumns: string[];
  /** The pending ref it came from (its name and actions). */
  pending?: PendingRef;
  /**
   * One-to-one: the FK columns are the FK table's whole primary key, or
   * exactly one of its unique keys. Written `Ref: pk_end - fk_end`, which
   * Import DBML stores from the FK side.
   */
  oneToOne?: boolean;
}

/** Statement kinds that are skipped, with the phrase a summary line uses. */
export const SKIP_LABELS = {
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
  existing: ['CREATE TABLE IF NOT EXISTS of a table already defined', 'CREATE TABLE IF NOT EXISTS statements of tables already defined'],
  temporary: ['SQL Server temporary table (#name: a session\'s scratch table, not design)', 'SQL Server temporary tables (#name: a session\'s scratch tables, not design)'],
  alter: ['ALTER TABLE action ERD Studio does not read', 'ALTER TABLE actions ERD Studio does not read'],
  alterOwner: ['ALTER TABLE … OWNER TO (ownership, not design)', 'ALTER TABLE … OWNER TO statements (ownership, not design)'],
  alterSetting: ['ALTER TABLE setting (storage, triggers, tags, masks, row security…)', 'ALTER TABLE settings (storage, triggers, tags, masks, row security…)'],
  alterPartition: ['ATTACH / DETACH PARTITION', 'ATTACH / DETACH PARTITION statements'],
  tableOption: ['table option (ENGINE, CHARSET, ON [filegroup], USING, CLUSTER BY…: physical, not design)', 'table options (ENGINE, CHARSET, ON [filegroup], USING, CLUSTER BY…: physical, not design)'],
  columnSetting: ['column setting (COLLATE, CHARACTER SET, ROWGUIDCOL, IDENTITY seed…: physical, not design)', 'column settings (COLLATE, CHARACTER SET, ROWGUIDCOL, IDENTITY seed…: physical, not design)'],
  block: ['procedural block (DO, IF … BEGIN) with no schema change in it', 'procedural blocks (DO, IF … BEGIN) with no schema change in them'],
  dynamic: ['dynamic SQL statement (EXECUTE \'…\', not run)', 'dynamic SQL statements (EXECUTE \'…\', not run)'],
  comment: ['comment on something other than a table or column', 'comments on something other than a table or column'],
  type: ['type other than an enum', 'types other than enums'],
  other: ['other statement', 'other statements'],
} as const;
export type SkipKind = keyof typeof SKIP_LABELS;

/** One skipped statement, when the reader knows where it is or what it names (for the log). */
export interface SkippedItem {
  file: string;
  kind: SkipKind;
  line?: number;
  name?: string;
}

/** A statement as the grammar is given it, and what was taken out to make it read. */
export interface PreparedSql {
  sql: string;
  /** Placeholder type name → the type as written. */
  types: Map<string, string>;
  /** Lower-cased column name → its `COMMENT`. */
  comments: Map<string, string>;
  /** Lower-cased names of identity columns whose clause was removed. */
  identity: Set<string>;
}

/** Where a column's definition is in the file, and what the tokenizer read in it. */
export interface ColumnSource {
  /** Where the column's type starts in the file. */
  typeOffset: number;
  /** Where its type ends (the first constraint word at depth 0): `[typeOffset, typeEnd)` is the type as written. */
  typeEnd?: number;
  /** A generated column's expression (`GENERATED ALWAYS AS (…) [STORED | VIRTUAL]`, MySQL's `AS (…)`): its span in the file. */
  generated?: { start: number; end: number; kind?: 'stored' | 'virtual' };
  /** A SQL Server computed column (`name AS <expr> [PERSISTED]`, no type of its own): its expression's span in the file. */
  computed?: { start: number; end: number; persisted: boolean };
  /** Column modifiers DBML has no field for, as fixed phrases (`ON UPDATE`, `COLLATE`, `IDENTITY seed`…). */
  modifiers?: string[];
  /** Inline named constraints (`col int CONSTRAINT pk_x PRIMARY KEY`). */
  constraints?: Array<{ name: string; kind: 'pk' | 'unique' | 'fk' | 'check' }>;
  /** Its `COMMENT [=] '…'`, as the tokenizer reads the string. */
  comment?: string;
  /** Its `DEFAULT '…'`, likewise. */
  stringDefault?: string;
}

// ---------------------------------------------------------------------------
// The converter, as the statement readers see it
// ---------------------------------------------------------------------------

/**
 * The converter's state and the operations the statement readers share.
 * `Converter` (sqlDdlImport.ts) implements it; the readers in
 * `sqlDdlStatements.ts` are functions over it, so a package can add a reader
 * without touching the converter.
 */
export interface ConverterContext {
  readonly dialect: SqlDialect;
  readonly engine: SqlParseEngine;
  /** What a partition or inheritance child with no columns of its own becomes ({@link SqlPartitionMode}). */
  readonly partitionMode: SqlPartitionMode;
  /** Everything not brought across as written: renders the draft's notes, its Not imported lines and the log. */
  readonly ledger: ImportLedger;
  readonly tables: ModelTable[];
  readonly enums: ModelEnum[];
  readonly refs: PendingRef[];
  readonly keys: PendingKey[];
  readonly comments: PendingComment[];
  readonly problems: SqlDdlProblem[];
  /** Said, one line each, in Not imported (`a.sql line 3: a key on x, which is not in the files`). */
  readonly skippedLines: string[];
  /** Kept, but changed on the way (a renamed table or schema). */
  readonly notes: string[];
  /** Skipped statements the reader could place (a line, a name): for the log. */
  readonly skippedItems: SkippedItem[];
  /** Schema changes applied in file order (ALTER TABLE column changes, renames, DROP TABLE). */
  appliedChanges: number;
  /** Whether the file being read applies its DROP TABLEs (a migration, not a teardown script). */
  dropsApply: boolean;
  /** The schema unqualified names are in (`USE`, `SET search_path`, `USE SCHEMA`); null: the dialect's default. */
  currentSchema: string | null;
  /** `parts` with {@link currentSchema} added when it is set and the name is unqualified. */
  qualify(parts: readonly string[]): string[];
  /** Counts a skipped statement by kind; `item` (a line, a name) also goes to the log. */
  skip(file: string, kind: SkipKind, count?: number, item?: { line?: number; name?: string }): void;
  findTable(parts: readonly string[]): ModelTable | undefined;
  readCreateTable(file: string, text: string, st: Statement, at: number): void;
  readCreateType(file: string, st: Statement, at: number): void;
  /** Column definitions `tokens[from, to)`, read by this dialect's grammar as a table of their own; undefined when they do not read. */
  readColumnDefinitions(text: string, tokens: Token[], from: number, to: number, file: string): { table: ModelTable; refs: PendingRef[] } | undefined;
  /** A change the files make to something they do not define (yet): said, with its file and line. */
  notApplied(where: Origin, what: string): void;
  setPrimaryKey(table: ModelTable, columns: string[]): void;
  addUnique(table: ModelTable, columns: string[]): void;
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** The schema an unqualified name is in, per dialect (two names match when only one says it). */
export const DEFAULT_SCHEMA: Readonly<Record<SqlDialect, string | null>> = {
  postgres: 'public',
  mysql: null,
  sqlserver: 'dbo',
  snowflake: 'public',
  databricks: 'default',
};

export const sameIdent = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export function sameSchema(a: string | null, b: string | null, dialect: SqlDialect): boolean {
  const fallback = DEFAULT_SCHEMA[dialect];
  const norm = (s: string | null): string => (s ?? fallback ?? '').toLowerCase();
  return norm(a) === norm(b);
}

export function tableKey(table: ModelTable, dialect: SqlDialect): string {
  return `${(table.schema ?? DEFAULT_SCHEMA[dialect] ?? '').toLowerCase()}.${table.name.toLowerCase()}`;
}

export function tableLabel(table: ModelTable): string {
  return table.schema ? `${table.schema}.${table.name}` : table.name;
}

export function primaryKeyOf(table: ModelTable): string[] {
  if (table.primaryKey) return table.primaryKey;
  return table.fields.filter((f) => f.pk).map((f) => f.name);
}

/** Removes, in place, every item `drop` accepts. */
export function removeWhere<T>(items: T[], drop: (item: T) => boolean): void {
  let kept = 0;
  for (const item of items) if (!drop(item)) items[kept++] = item;
  items.length = kept;
}

// ---------------------------------------------------------------------------
// What the statement readers remember between statements
// ---------------------------------------------------------------------------

/** A `CREATE DOMAIN` or SQL Server alias type (`CREATE TYPE x FROM base`): columns keep its name; the ledger names its base. */
export interface ReaderDomain {
  name: string;
  schema: string | null;
  kind: 'domain' | 'alias type';
  /** Its base type, as written (`integer`, `nvarchar(50)`). */
  base: string;
  /** It has a CHECK (a domain's constraint), which no column carries. */
  check: boolean;
  origin: Origin;
}

/** A partition and its parent (`PARTITION OF`, `ATTACH PARTITION`, `INHERITS`). */
export interface ReaderPartition {
  child: string[];
  parent: string[];
  how: 'PARTITION OF' | 'ATTACH PARTITION' | 'INHERITS';
  origin: Origin;
  /** The child has no column list of its own (`PARTITION OF`, `INHERITS` with `()`): no table was read for it. */
  noColumns?: boolean;
  /** `DETACH PARTITION` later in the files: a table of its own from then on. */
  detached?: boolean;
  /** Column options in a `PARTITION OF parent (…)` list (`col WITH OPTIONS NOT NULL`): what each says beyond its parent's column. */
  columnOptions?: Array<{ column: string; notNull: boolean; other: string[]; origin: Origin }>;
}

/**
 * The statement readers' memory across statements of one conversion, kept
 * beside the converter (a `WeakMap`), so `ConverterContext` needs no field
 * for it: the file being read (the schema context resets with each file),
 * the views (a unique index on one is not a key), domains and alias types,
 * partitions, and checks still to join their tables.
 */
export interface ReaderState {
  file?: string;
  views: Set<string>;
  domains: ReaderDomain[];
  partitions: ReaderPartition[];
  /** Checks added by ALTER TABLE, joined to their tables once every file is read (a constraints file may come first). */
  checks: Array<{ table: string[]; expression: string; name?: string; origin: Origin }>;
  /** Inside `CREATE SCHEMA s CREATE TABLE …` (no `;` yet): the schema its elements are created in. */
  schemaElements?: string;
  /** Once partitions are resolved (`sqlDdlPartitions.ts`): how many children were folded into a parent, and how many kept as tables. */
  partitionsResolved?: { folded: number; kept: number };
  /**
   * ALTER TABLE changes to a child with no columns of its own (no table yet:
   * a column added, altered, renamed or dropped), in file order: replayed on
   * its table once partitions are resolved, or reported at their line when
   * it folds into its parent. Never applied to the parent.
   */
  childChanges: ChildChange[];
  /** Where each column and table constraint of a CREATE TABLE was written: a folded partition's losses are said at their own line. */
  itemLines: WeakMap<ModelField | ModelTable, ItemLines>;
}

/** One deferred ALTER TABLE change to a partition or inheritance child with no table yet ({@link ReaderState.childChanges}). */
export interface ChildChange {
  child: string[];
  origin: Origin;
  /** Applies the change to the table named `parts`. */
  run: (parts: readonly string[]) => void;
}

/** A field's line ({@link ReaderState.itemLines}), or a table's constraint items with theirs. */
export type ItemLines = number | Array<{ kind: 'pk' | 'unique' | 'fk' | 'check'; columns: string[]; line: number }>;

const READER_STATE = new WeakMap<object, ReaderState>();

/** `cx`'s reader state (created on first use). */
export function readerState(cx: object): ReaderState {
  let state = READER_STATE.get(cx);
  if (!state) {
    state = { views: new Set(), domains: [], partitions: [], checks: [], childChanges: [], itemLines: new WeakMap() };
    READER_STATE.set(cx, state);
  }
  return state;
}
