/**
 * **Import SQL DDL…**'s second input: a catalog query's result saved as CSV
 * (or TSV), one row per column. The query reads the database's own catalog
 * (`information_schema`, `pg_catalog`, `duckdb_columns()`…) and the import
 * guide gives one for each platform it was run on; any file that follows
 * {@link CATALOG_CSV_COLUMNS} reads, whichever database wrote it. The
 * importer never claims to know which one did: it reads the headers.
 *
 * What a file carries is what comes in, and what it does not carry is said
 * as that (the notes and the draft's banner), never as a fact about the
 * model: a file with no key columns says it had none, not that the tables
 * have no keys.
 *
 * A row repeats a column once per constraint it is in (a LEFT JOIN to the
 * key tables gives that): repeated rows are merged. Tables come out in the
 * SQL importer's own model (`ModelTable`, `ResolvedRef`) and are written by
 * its writer (`writeDbmlMapped`), so Import DBML reads the result exactly as
 * it reads a converted SQL script, with `source: 'sql'`.
 *
 * Pure: no `vscode`, no Node built-ins, no parser (the DBML check that leaves
 * out what does not read back is passed in, as `convertSqlDdl` takes it).
 * Bundled into `dist/extension.js` (it needs no SQL grammar, so never into
 * `dist/sqlImport.js`).
 */

import { createLedger, ledgerText, type ImportLedger, type LedgerEntry } from './importLedger';
import type { DbmlCheck } from './sqlDdlImport';
import { primaryKeyOf, sameIdent, tableLabel, type ModelField, type ModelTable, type ResolvedRef } from './sqlDdlModel';
import { cardinalityOf, ownerOfLine, writeDbmlMapped } from './sqlDdlWriter';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** At most this many rows (columns) in one import: a larger catalog is imported a schema at a time. */
export const MAX_CATALOG_ROWS = 100_000;
/** At most this many characters of CSV in one import (checked before the rows are read). */
export const MAX_CATALOG_CHARS = 64 * 1024 * 1024;
/**
 * A table or column name longer than this is not a name (a broken export): that table or column is left out, and said.
 * 255 is the longest Snowflake and Databricks (Unity Catalog) allow.
 */
export const MAX_CATALOG_NAME_CHARS = 255;

/** Whether a file is a catalog export by its name: `.csv` or `.tsv`, any case. */
export function isCatalogCsvName(name: string): boolean {
  return /\.(csv|tsv)$/i.test(name);
}

/** `from a catalog export (catalog.csv)`, `from 2 catalog exports`: what the draft's headline says the tables came from. */
export function catalogOriginPhrase(names: readonly string[]): string {
  return names.length === 1 ? `from a catalog export (${names[0]})` : `from ${names.length.toLocaleString('en-US')} catalog exports`;
}

/** File names a download is given that say nothing about the model (`export.csv`, `columns.csv`). */
const GENERIC_CATALOG_STEMS = /^(catalog|catalog_export|columns|information_schema|query|query_result|results?|export|download|data|untitled|sheet\d*)$/i;

/**
 * The name Import DBML suggests for the diagram, before `sqlImportFileName`
 * looks for a better one (the tables' common schema, else the folder):
 * a generic download name counts as none.
 */
export function catalogImportStem(fileName: string): string {
  const stem = fileName.replace(/\.dbml$/i, '').replace(/[ _-]*\(\d+\)$/, '');
  return GENERIC_CATALOG_STEMS.test(stem) ? 'import.dbml' : fileName;
}

// ---------------------------------------------------------------------------
// The delimited reader (RFC 4180, and what exports really write)
// ---------------------------------------------------------------------------

export interface DelimitedFile {
  delimiter: string;
  header: string[];
  rows: string[][];
  /** 1-based line each row starts on. */
  lines: number[];
  /** Rows whose cell count differs from the header's. */
  ragged: number;
  /** A quoted field that never closed (the rest of the file was read as that field). */
  unterminatedQuote: boolean;
}

const DELIMITERS = [',', '\t', ';', '|'];

/** The delimiter of the first record: the candidate most frequent outside quotes (comma on a tie). */
function sniffDelimiter(text: string, from: number): string {
  const counts = new Map<string, number>(DELIMITERS.map((d) => [d, 0]));
  let quoted = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    if (ch === '\n' || ch === '\r') break;
    if (counts.has(ch)) counts.set(ch, (counts.get(ch) as number) + 1);
  }
  let best = ',';
  for (const d of DELIMITERS) if ((counts.get(d) as number) > (counts.get(best) as number)) best = d;
  return best;
}

/**
 * A tab-separated file's unquoted cell, with the backslash escapes MySQL's
 * `--batch` output and PostgreSQL's `COPY` text format write: `\n`, `\r`,
 * `\t`, `\\` (`\N`, their NULL, is read as no value before this).
 */
function unescapeTsv(value: string): string {
  if (!value.includes('\\')) return value;
  return value.replace(/\\([\\ntr0])/g, (_m, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c === '0' ? '' : '\\'));
}

/**
 * Reads delimited text: a UTF-8 byte-order mark, CRLF / LF / CR line ends,
 * quoted fields holding the delimiter, line breaks and doubled quotes, comma /
 * tab / semicolon / pipe (sniffed from the header), Excel's `sep=;` first
 * line, blank lines, and a SQL client's table decoration (`---+---` rules,
 * a `(12 rows)` footer). Unquoted cells are trimmed; in a tab-separated file
 * their backslash escapes are read. Never throws.
 */
export function readDelimited(input: string): DelimitedFile {
  let text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  // NUL is never data here: a UTF-16 file read as UTF-8 has one between every two characters.
  if (text.includes('\u0000')) text = text.replace(/\u0000/g, '');
  let line = 1;
  const sep = /^sep=(.)\r?\n/i.exec(text);
  if (sep) { text = text.slice(sep[0].length); line = 2; }
  // A client's table output starts with a rule line (+----+----+): the header is the line after it.
  const rule = /^[-+=\s]*\r?\n/.exec(text);
  const delimiter = sep ? sep[1] : sniffDelimiter(text, rule ? rule[0].length : 0);
  const d = delimiter.charCodeAt(0);
  const tsv = delimiter === '\t';
  const records: string[][] = [];
  const lines: number[] = [];
  let unterminatedQuote = false;
  const n = text.length;
  let i = 0;
  let row: string[] = [];
  let rowLine = line;
  const endRow = (): void => {
    // A blank line, a client's rule line (+----+, ----+----) or its row-count footer is not a row.
    const blank = row.length === 1 && row[0] === '';
    const ruleRow = row.every((c) => /^[-+=\s]*$/.test(c)) && row.some((c) => c.includes('-'));
    const footer = row.length === 1 && /^\(\d+ rows?\)$/i.test(row[0]);
    if (!blank && !ruleRow && !footer) { records.push(row); lines.push(rowLine); }
    row = [];
  };
  while (i <= n) {
    if (i === n) { if (row.length > 0) endRow(); break; }
    let value: string;
    // Leading spaces before a quote (`a, "b"`) are not part of the field.
    let s = i;
    while (s < n && text.charCodeAt(s) === 32 && d !== 32) s++;
    if (text.charCodeAt(s) === 34) {
      let j = s + 1;
      let out = '';
      for (;;) {
        const q = text.indexOf('"', j);
        if (q < 0) { out += text.slice(j); j = n; unterminatedQuote = true; break; }
        if (text.charCodeAt(q + 1) === 34) { out += text.slice(j, q + 1); j = q + 2; continue; }
        out += text.slice(j, q);
        j = q + 1;
        break;
      }
      for (let k = s; k < j; k++) if (text.charCodeAt(k) === 10) line++;
      // Anything between the closing quote and the delimiter is kept (lenient), then trimmed.
      let e = j;
      while (e < n) { const c = text.charCodeAt(e); if (c === d || c === 10 || c === 13) break; e++; }
      value = e > j ? out + text.slice(j, e).trimEnd() : out;
      i = e;
    } else {
      let e = i;
      while (e < n) { const c = text.charCodeAt(e); if (c === d || c === 10 || c === 13) break; e++; }
      value = text.slice(i, e).trim();
      if (tsv && !/^\\N$/.test(value)) value = unescapeTsv(value);
      i = e;
    }
    row.push(value);
    if (i >= n) { endRow(); break; }
    const c = text.charCodeAt(i);
    if (c === d) { i++; if (i === n) { row.push(''); endRow(); break; } continue; }
    if (c === 13 && text.charCodeAt(i + 1) === 10) i++;
    i++;
    line++;
    endRow();
    rowLine = line;
  }
  // A pipe-framed client table (`| a | b |`) has an empty first and last cell on every row.
  if (delimiter === '|' && records.length > 0 && records.every((r) => r.length > 2 && r[0] === '' && r[r.length - 1] === '')) {
    for (const r of records) { r.shift(); r.pop(); }
  }
  const header = records.shift() ?? [];
  lines.shift();
  let ragged = 0;
  for (const r of records) if (r.length !== header.length) ragged++;
  return { delimiter, header, rows: records, lines, ragged, unterminatedQuote };
}

// ---------------------------------------------------------------------------
// The column contract
// ---------------------------------------------------------------------------

/**
 * Every column a catalog export may have, with the headers read as it (case,
 * spaces and punctuation ignored: `TABLE_NAME`, `Table Name` and `table_name`
 * are one header; the first spelling listed that the file has wins, and a
 * header is read as one column only). Only `table`, `column` and a type
 * (`fullType` or `dataType`) are required; every other column is optional
 * and adds what it carries. `docs/import-existing-models.md` → "The column
 * contract" lists the same table for users.
 */
export const CATALOG_CSV_COLUMNS = {
  catalog: ['table_catalog', 'table_cat', 'catalog_name', 'catalog', 'database_name'],
  schema: ['table_schema', 'table_schem', 'schema_name', 'schema', 'owner', 'table_owner', 'dataset_name'],
  table: ['table_name', 'table', 'tab_name', 'relname'],
  column: ['column_name', 'column', 'col_name', 'attname', 'field_name', 'name'],
  /** The whole type as the database writes it (`varchar(50)`, `decimal(18,4)`, `struct<…>`). */
  fullType: ['full_data_type', 'column_type', 'full_type', 'formatted_type', 'ddl_type'],
  /** The type; a value with its size or element types (`varchar(50)`) is read as a whole type, whatever the header. */
  dataType: ['data_type', 'type_name', 'type', 'col_type'],
  udt: ['udt_name'],
  domainSchema: ['domain_schema'],
  domain: ['domain_name'],
  /** Only the order matters: 0-based (Databricks) and 1-based alike. Without it, columns keep the file's row order. */
  ordinal: ['ordinal_position', 'column_id', 'ordinal', 'column_index', 'position', 'cid', 'attnum'],
  /** `YES` / `NO` (also `Y` / `N`, `true` / `false`): `NO` is NOT NULL. */
  nullable: ['is_nullable', 'nullable'],
  /** The other way round: true is NOT NULL (SQLite's `notnull`). */
  notNull: ['not_null', 'is_not_null', 'attnotnull'],
  charLength: ['character_maximum_length', 'char_length', 'max_length', 'character_length'],
  /** Oracle's byte length: read for character types only, and only with no character length. */
  dataLength: ['data_length'],
  precision: ['numeric_precision', 'data_precision', 'precision'],
  scale: ['numeric_scale', 'data_scale', 'scale'],
  default: ['column_default', 'data_default', 'dflt_value', 'default_value', 'default'],
  comment: ['column_comment', 'comment', 'comments', 'description', 'remarks', 'column_description'],
  tableComment: ['table_comment', 'table_comments', 'table_description', 'table_remarks'],
  /** `VIEW`, `MATERIALIZED VIEW`, `SYSTEM VIEW` and temporary tables are skipped; anything else is a table. */
  tableType: ['table_type', 'object_type'],
  isPk: ['is_primary_key', 'primary_key', 'is_pk', 'pk'],
  /** The column's place in a composite primary key (1-based or 0-based: only the order matters). */
  pkOrdinal: ['pk_ordinal', 'pk_position', 'key_ordinal'],
  /** MySQL's `COLUMN_KEY`: `PRI` is the primary key, `UNI` a unique key. */
  columnKey: ['column_key'],
  isUnique: ['is_unique', 'unique'],
  /** Groups a composite unique key's columns (one row per column per key). */
  uniqueName: ['unique_constraint_name', 'unique_key_name', 'unique_name', 'unique_index_name'],
  /** The constraint-join shape: one row per column per constraint, `PRIMARY KEY` / `UNIQUE` / `FOREIGN KEY` (Oracle's `P` / `U` / `R`). */
  constraintName: ['constraint_name'],
  constraintType: ['constraint_type'],
  fkName: ['fk_constraint_name', 'fk_name', 'foreign_key_name'],
  /** The column's place in a composite foreign key: pairs each column with its referenced column in order. */
  fkOrdinal: ['fk_ordinal', 'fk_position'],
  fkCatalog: ['fk_table_catalog', 'referenced_table_catalog', 'fk_catalog'],
  fkSchema: ['fk_table_schema', 'referenced_table_schema', 'fk_schema', 'ref_schema', 'referenced_schema', 'r_owner'],
  fkTable: ['fk_table_name', 'fk_table', 'referenced_table_name', 'referenced_table', 'ref_table', 'r_table_name'],
  fkColumn: ['fk_column_name', 'fk_column', 'referenced_column_name', 'referenced_column', 'ref_column', 'r_column_name'],
  identity: ['is_identity', 'is_autoincrement', 'autoincrement', 'identity_column'],
  /** MySQL's `EXTRA`: `auto_increment` marks an identity column. */
  extra: ['extra'],
  /** The query's own row count (`count(*) OVER ()`): a file with fewer rows was cut short, and is refused. */
  totalRows: ['total_rows'],
} as const satisfies Record<string, readonly string[]>;

export type CatalogCsvRole = keyof typeof CATALOG_CSV_COLUMNS;

const canonHeader = (h: string): string => h.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Each role's column index, by the first of its spellings the header has. A header is one role only. */
export function mapCatalogHeaders(header: readonly string[]): Partial<Record<CatalogCsvRole, number>> {
  const at = new Map<string, number>();
  header.forEach((h, i) => { const k = canonHeader(h); if (k && !at.has(k)) at.set(k, i); });
  const out: Partial<Record<CatalogCsvRole, number>> = {};
  const taken = new Set<number>();
  for (const role of Object.keys(CATALOG_CSV_COLUMNS) as CatalogCsvRole[]) {
    for (const alias of CATALOG_CSV_COLUMNS[role]) {
      const i = at.get(canonHeader(alias));
      if (i === undefined || taken.has(i)) continue;
      out[role] = i;
      taken.add(i);
      break;
    }
  }
  return out;
}

/** Whether a header row is a catalog export's: it names a table, a column and a type. */
export function isCatalogHeader(header: readonly string[]): boolean {
  const roles = mapCatalogHeaders(header);
  return roles.table !== undefined && roles.column !== undefined && (roles.dataType !== undefined || roles.fullType !== undefined);
}

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

/** Exports write SQL NULL as nothing, `NULL` (MySQL, SSMS), `null` (Databricks), `\N` (mysql --batch, COPY) or `(null)`. */
const isNullText = (v: string): boolean => v === '' || /^(null|\\N|\(null\)|<null>|\[null\])$/i.test(v);
const truthy = (v: string): boolean => /^(yes|y|true|t|pri|pk|p|primary key|x)$/i.test(v) || (/^\d+$/.test(v) && Number(v) > 0);
const falsy = (v: string): boolean => /^(no|n|false|f|0|not null)$/i.test(v);

/** Catalogs' own schemas: never the design. */
const SYSTEM_SCHEMA = /^(information_schema|pg_catalog|pg_toast|pg_temp_\d+|pg_toast_temp_\d+|sys|mysql|performance_schema)$/i;
/** What `table_type` calls a view, a temporary table or the catalog's own. */
const NOT_A_TABLE = /view|temporary|^system\b/i;

/** Lengths that mean "no limit" (Snowflake's VARCHAR default, PostgreSQL's text octets). */
const NO_LIMIT = 16_777_216;

const FREE_TEXT: ReadonlySet<CatalogCsvRole> = new Set<CatalogCsvRole>(['comment', 'tableComment', 'default']);

/** Type families whose size the length, precision and scale columns give: no other type is ever given one. */
const SIZED_CHAR = /^(n?varchar2?|n?char|character|character varying|char varying|national char(acter)?( varying)?|varbinary|binary|bit varying|varbit|raw|text|string)$/i;
const SIZED_NUMBER = /^(numeric|decimal|dec|number)$/i;

interface TypeParts { full: string; dataType: string; udt: string; domain: string; domainSchema: string; charLength: string; dataLength: string; precision: string; scale: string; oracle: boolean }

/**
 * A column's type: the full type when the file has one, or a `data_type`
 * that already holds one (by its content: `varchar(50)`, `struct<…>`), else
 * rebuilt from `data_type` and its length / precision / scale, only for the
 * types that take one ({@link SIZED_CHAR}, {@link SIZED_NUMBER}).
 */
export function catalogColumnType(p: TypeParts): { type: string; how: 'full' | 'asWritten' | 'rebuilt' | 'named' | 'unknown' } {
  if (p.full) return { type: p.full, how: 'full' };
  const dt = p.dataType;
  if (!dt) return { type: 'unknown', how: 'unknown' };
  // A domain or alias type keeps its name (PostgreSQL and SQL Server put the base type in data_type).
  if (p.domain) return { type: p.domainSchema && !/^(public|dbo)$/i.test(p.domainSchema) ? `${p.domainSchema}.${p.domain}` : p.domain, how: 'named' };
  if (/^ARRAY$/i.test(dt) && p.udt) return { type: `${p.udt.replace(/^_/, '')}[]`, how: 'named' };
  if (/^USER-DEFINED$/i.test(dt) && p.udt) return { type: p.udt, how: 'named' };
  if (/[(<]/.test(dt)) return { type: dt, how: 'asWritten' };
  if (SIZED_CHAR.test(dt)) {
    const len = p.charLength || (/char|^raw$/i.test(dt) ? p.dataLength : '');
    if (len === '-1' && /char|binary/i.test(dt)) return { type: `${dt}(max)`, how: 'rebuilt' };
    // text / string: only Snowflake gives one a declared length (TEXT, 50); MySQL's 65,535 and up are the type's own limit.
    const limit = /^(text|string)$/i.test(dt) ? 65_535 : NO_LIMIT;
    if (/^\d+$/.test(len) && Number(len) > 0 && Number(len) < limit) return { type: `${dt}(${len})`, how: 'rebuilt' };
    return { type: dt, how: 'asWritten' };
  }
  if (SIZED_NUMBER.test(dt)) {
    if (/^\d+$/.test(p.precision)) {
      // Oracle writes NUMBER(6) for scale 0; the others write the scale.
      if (/^-?\d+$/.test(p.scale) && !(p.oracle && p.scale === '0')) return { type: `${dt}(${p.precision},${p.scale})`, how: 'rebuilt' };
      return { type: `${dt}(${p.precision})`, how: 'rebuilt' };
    }
    if (p.oracle && p.scale === '0') return { type: `${dt}(*,0)`, how: 'rebuilt' };
  }
  return { type: dt, how: 'asWritten' };
}

/**
 * A column's default as the catalog writes it: a number; a quoted literal
 * (`'AU'`) as a string; an expression (`now()`, `'AU'::bpchar`) as written.
 * `extra` is MySQL's `EXTRA` column, when the file has one: MySQL writes a
 * literal default bare (`AU`) and marks an expression `DEFAULT_GENERATED`, so
 * there a bare default is a string. `NULL` is no default.
 */
export function catalogDefault(raw: string, extra?: string): ModelField['default'] | undefined {
  const def = raw.replace(/\s+/g, ' ').trim();
  if (!def || isNullText(def)) return undefined;
  if (/^-?\d+(\.\d+)?$/.test(def)) return { type: 'number', value: def };
  const quoted = /^'((?:[^']|'')*)'$/.exec(def);
  if (quoted) return { type: 'string', value: quoted[1].replace(/''/g, "'") };
  const expression = /^(current_(timestamp|date|time)|localtime(stamp)?|now)\b/i.test(def) || /\(/.test(def);
  if (extra !== undefined && !/DEFAULT_GENERATED/i.test(extra) && !expression) return { type: 'string', value: def };
  return { type: 'expression', value: def };
}

/** A type with no size that its family usually has (`varchar`, `decimal`): what a `data_type`-only export gives. */
function bareSized(type: string): boolean {
  return !/[(<]/.test(type) && (SIZED_CHAR.test(type) || SIZED_NUMBER.test(type)) && !/^(text|string)$/i.test(type);
}

// ---------------------------------------------------------------------------
// The conversion
// ---------------------------------------------------------------------------

export interface CatalogCsvFile { name: string; text: string }

export interface CatalogCsvProblem { file: string; line?: number; message: string }

/** Why nothing could be imported. */
export type CatalogCsvFailure =
  /** No header, or only blank lines. */
  | 'empty'
  /** The header names no table, column or type: not a catalog export (a dbt seed, data). */
  | 'notCatalog'
  /** A header and no rows. */
  | 'noRows'
  /** `total_rows` says the query returned more rows than the file holds. */
  | 'truncated'
  /** More than {@link MAX_CATALOG_ROWS} rows or {@link MAX_CATALOG_CHARS} characters. */
  | 'tooBig'
  /** Every row is a view, a system table or nameless. */
  | 'nothingToImport'
  /** No table could be written as DBML (ours). */
  | 'unwritable';

/** What the files carried (each true when at least one file had the column), so the draft can say what they did not. */
export interface CatalogCsvCoverage {
  delimiter: string;
  /** Role → the header read as it (the first file's). */
  headers: Partial<Record<CatalogCsvRole, string>>;
  rows: number;
  /** Whether a key column of each kind was in the file (not whether it marked any). */
  primaryKeyColumn: boolean;
  foreignKeyColumns: boolean;
  uniqueColumn: boolean;
  nullability: boolean;
  tableType: boolean;
  totalRows: boolean;
  /** A column or table comment column. */
  comments: boolean;
  /** Types: whole (a full type, or sizes given), or bare `data_type` values with no size to read. */
  types: 'whole' | 'bare';
}

export type CatalogCsvResult =
  | {
    ok: true;
    dbml: string;
    tableCount: number;
    columnCount: number;
    refCount: number;
    /** Kept, but worth saying (what the file did not carry, renamed tables…), one point each. */
    notes: string[];
    /** The draft banner's line: the file had no key columns at all. */
    notice?: string;
    /** What was left out, counted by kind. */
    skipped: string[];
    problems: CatalogCsvProblem[];
    ledger: LedgerEntry[];
    coverage: CatalogCsvCoverage;
  }
  | { ok: false; reason: CatalogCsvFailure; problems: CatalogCsvProblem[]; ledger: LedgerEntry[] };

/** Where the import guide's queries are, for a note about a file that lacks keys. */
const GUIDE_POINTER = 'The catalog queries in ERD Studio: Bring In Your Data Model… include them.';

interface FkGroup { name?: string; toCatalog: string; toSchema: string; toTable: string; pairs: Array<{ from: string; to: string; ordinal: number }>; line: number; file: string }

interface Building {
  table: ModelTable;
  catalog: string;
  file: string;
  byName: Map<string, { field: ModelField; ordinal: number }>;
  /** Unique key name → its columns. */
  uniques: Map<string, string[]>;
  pk: Array<{ column: string; ordinal: number }>;
  /** FK group (a constraint name, or a column of its own) → its column pairs and target. */
  fks: Map<string, FkGroup>;
}

const MAX_DBML_CHECKS = 8;
const fmt = (n: number): string => n.toLocaleString('en-US');
const plural = (n: number, one: string, many = `${one}s`): string => `${fmt(n)} ${n === 1 ? one : many}`;

/** One file's rows, read and checked: its header roles, or why it cannot be read. */
interface ReadFile {
  file: CatalogCsvFile;
  read: DelimitedFile;
  roles: Partial<Record<CatalogCsvRole, number>>;
}

function headersFound(header: readonly string[]): string {
  return header.slice(0, 8).map((h) => ledgerText(h, 40) || '(blank)').join(', ') + (header.length > 8 ? `, … (${header.length} in all)` : '');
}

/**
 * Catalog exports → one DBML text for Import DBML's flow. Every file must
 * read as a catalog export (else nothing is imported, and the message says
 * which header is missing); their tables are merged. `check` is the DBML
 * reader Import DBML runs: what it rejects is left out at its table or
 * reference, never the whole import.
 */
export function catalogCsvToDbml(files: readonly CatalogCsvFile[], check?: DbmlCheck): CatalogCsvResult {
  const ledger = createLedger();
  const fail = (reason: CatalogCsvFailure, file: string, message: string, line?: number): CatalogCsvResult =>
    ({ ok: false, reason, problems: [{ file, ...(line ? { line } : {}), message }], ledger: [...ledger.entries] });

  const chars = files.reduce((n, f) => n + f.text.length, 0);
  if (chars > MAX_CATALOG_CHARS) {
    return fail('tooBig', files[0]?.name ?? '', `The ${files.length === 1 ? 'file holds' : 'files hold'} more than ${Math.round(MAX_CATALOG_CHARS / 1024 / 1024)} MB. Export one schema at a time (add a schema filter to the query's WHERE clause).`);
  }
  // 1. Read every file, and check each is a whole catalog export before anything is built.
  const readFiles: ReadFile[] = [];
  let totalRows = 0;
  for (const file of files) {
    const read = readDelimited(file.text);
    if (read.header.length === 0 || read.header.every((h) => h === '')) return fail('empty', file.name, `${file.name} is empty.`);
    const roles = mapCatalogHeaders(read.header);
    const missing = [
      roles.table === undefined ? 'table_name' : '',
      roles.column === undefined ? 'column_name' : '',
      roles.dataType === undefined && roles.fullType === undefined ? 'data_type' : '',
    ].filter(Boolean);
    if (missing.length) {
      return fail('notCatalog', file.name,
        `${file.name} is not a catalog export ERD Studio can read: it has no ${missing.join(', no ')} column. Its first line is read as the column names: ${headersFound(read.header)}.`, 1);
    }
    if (read.rows.length === 0) return fail('noRows', file.name, `${file.name} has column names but no rows.`, 1);
    if (roles.totalRows !== undefined) {
      const said = read.rows.map((r) => r[roles.totalRows as number] ?? '').find((v) => /^\d+$/.test(v.trim()));
      const expected = said === undefined ? undefined : Number(said.trim());
      if (expected !== undefined && expected !== read.rows.length) {
        return fail('truncated', file.name, expected > read.rows.length
          ? `${file.name} holds ${fmt(read.rows.length)} of the query's ${fmt(expected)} rows (its total_rows column), so it was cut short: a results grid's download often holds only the rows it shows (Databricks' "first 1,000 rows" is one). Download all the rows and import that file.`
          : `${file.name} holds ${fmt(read.rows.length)} rows, but the query returned ${fmt(expected)} (its total_rows column): the file was changed or joined with another after it was exported. Export it again and import that file.`);
      }
    }
    totalRows += read.rows.length;
    if (totalRows > MAX_CATALOG_ROWS) {
      return fail('tooBig', file.name, `The ${files.length === 1 ? 'file lists' : 'files list'} more than ${fmt(MAX_CATALOG_ROWS)} columns, more than one import brings in. Export one schema at a time (add a schema filter to the query's WHERE clause).`);
    }
    readFiles.push({ file, read, roles });
  }

  // 2. Rows → tables.
  const notes: string[] = [];
  const skippedLines: string[] = [];
  const tables = new Map<string, Building>();
  const order: Building[] = [];
  const viewNames = new Set<string>();
  let systemRows = 0; let noName = 0; let disagree = 0; let ragged = 0; let unterminated = 0;
  let rebuilt = 0; let unknownTypes = 0;
  const longNames: Array<{ file: string; line: number; what: 'table' | 'column'; table: string; name: string }> = [];
  const coverage = { primaryKeyColumn: false, foreignKeyColumns: false, uniqueColumn: false, nullability: false, tableType: false, totalRows: false, comments: false, sizeColumns: false, fullType: false };

  for (const { file, read, roles } of readFiles) {
    if (read.ragged) ragged += read.ragged;
    if (read.unterminatedQuote) unterminated++;
    coverage.primaryKeyColumn ||= roles.isPk !== undefined || roles.columnKey !== undefined || roles.constraintType !== undefined;
    coverage.foreignKeyColumns ||= roles.fkTable !== undefined;
    coverage.uniqueColumn ||= roles.isUnique !== undefined || roles.uniqueName !== undefined || roles.columnKey !== undefined || roles.constraintType !== undefined;
    coverage.nullability ||= roles.nullable !== undefined || roles.notNull !== undefined;
    coverage.tableType ||= roles.tableType !== undefined;
    coverage.totalRows ||= roles.totalRows !== undefined;
    coverage.comments ||= roles.comment !== undefined || roles.tableComment !== undefined;
    coverage.sizeColumns ||= roles.charLength !== undefined || roles.precision !== undefined || roles.dataLength !== undefined;
    coverage.fullType ||= roles.fullType !== undefined;
    const cell = (row: readonly string[], role: CatalogCsvRole): string => {
      const i = roles[role];
      if (i === undefined) return '';
      const v = row[i] ?? '';
      // A table or column always has a name, so `null` there is the name (a column called null), never SQL NULL.
      if (role === 'table' || role === 'column' ? v === '' : isNullText(v)) return '';
      // A name or a type is one line: a line break or control character in one would stop DBML reading its table.
      // eslint-disable-next-line no-control-regex
      return FREE_TEXT.has(role) ? v : v.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim();
    };
    const oracle = roles.precision !== undefined && canonHeader(read.header[roles.precision]) === 'dataprecision';

    for (let r = 0; r < read.rows.length; r++) {
      const row = read.rows[r];
      const line = read.lines[r];
      const tableName = cell(row, 'table');
      const columnName = cell(row, 'column');
      if (!tableName || !columnName) { noName++; continue; }
      const schema = cell(row, 'schema');
      if (schema && SYSTEM_SCHEMA.test(schema)) { systemRows++; continue; }
      const tableType = cell(row, 'tableType');
      if (tableType && NOT_A_TABLE.test(tableType)) { viewNames.add(`${schema}.${tableName}`.toLowerCase()); continue; }
      const catalog = cell(row, 'catalog');
      if (tableName.length > MAX_CATALOG_NAME_CHARS) {
        if (!longNames.some((l) => l.what === 'table' && l.name === tableName)) longNames.push({ file: file.name, line, what: 'table', table: tableName, name: tableName });
        continue;
      }
      const key = `${catalog}\u0000${schema}\u0000${tableName}`;
      let b = tables.get(key);
      if (!b) {
        b = {
          table: { name: tableName, schema: schema || null, fields: [], uniques: [], checks: [], origin: { file: file.name, line } },
          catalog, file: file.name, byName: new Map(), uniques: new Map(), pk: [], fks: new Map(),
        };
        tables.set(key, b);
        order.push(b);
      }
      if (columnName.length > MAX_CATALOG_NAME_CHARS) {
        // One entry per column left out (a column repeated on several rows is one).
        const label = tableLabel(b.table);
        if (!longNames.some((l) => l.what === 'column' && l.table === label && l.name === columnName)) longNames.push({ file: file.name, line, what: 'column', table: label, name: columnName });
        continue;
      }
      const tableComment = cell(row, 'tableComment');
      if (tableComment && !b.table.note) b.table.note = tableComment;

      const built = catalogColumnType({
        full: cell(row, 'fullType'), dataType: cell(row, 'dataType'), udt: cell(row, 'udt'), domain: cell(row, 'domain'), domainSchema: cell(row, 'domainSchema'),
        charLength: cell(row, 'charLength'), dataLength: cell(row, 'dataLength'), precision: cell(row, 'precision'), scale: cell(row, 'scale'), oracle,
      });
      let entry = b.byName.get(columnName);
      if (!entry) {
        const field: ModelField = { name: columnName, type: built.type, pk: false, unique: false, notNull: false, increment: false, checks: [] };
        const ord = cell(row, 'ordinal');
        entry = { field, ordinal: /^-?\d+$/.test(ord) ? Number(ord) : Number.NaN };
        b.byName.set(columnName, entry);
        b.table.fields.push(field);
        if (built.how === 'rebuilt') rebuilt++;
        if (built.how === 'unknown') unknownTypes++;
        const nullable = cell(row, 'nullable');
        if (nullable && falsy(nullable)) field.notNull = true;
        const notNull = cell(row, 'notNull');
        if (notNull && truthy(notNull)) field.notNull = true;
        const comment = cell(row, 'comment');
        if (comment) field.note = comment;
        const def = catalogDefault(cell(row, 'default'), roles.extra !== undefined ? cell(row, 'extra') : undefined);
        if (def) field.default = def;
        if (truthy(cell(row, 'identity')) || /auto_increment/i.test(cell(row, 'extra'))) field.increment = true;
      } else if (built.type !== entry.field.type) {
        disagree++;
      }

      // Keys: a flag of its own, MySQL's COLUMN_KEY, or the constraint this row is joined to.
      const ctype = cell(row, 'constraintType').toUpperCase().replace(/\s+/g, ' ');
      const cname = cell(row, 'constraintName');
      const pkFlag = cell(row, 'isPk');
      const isPk = truthy(pkFlag) || /^PRI$/i.test(cell(row, 'columnKey')) || ctype === 'PRIMARY KEY' || ctype === 'P';
      if (isPk && !b.pk.some((p) => p.column === columnName)) {
        const pkOrd = cell(row, 'pkOrdinal') || (/^\d+$/.test(pkFlag) ? pkFlag : '');
        b.pk.push({ column: columnName, ordinal: /^-?\d+$/.test(pkOrd) ? Number(pkOrd) : Number.NaN });
      }
      const uniqueName = cell(row, 'uniqueName') || (ctype === 'UNIQUE' || ctype === 'U' ? cname : '');
      const isUnique = truthy(cell(row, 'isUnique')) || /^UNI$/i.test(cell(row, 'columnKey')) || ctype === 'UNIQUE' || ctype === 'U' || !!uniqueName;
      if (isUnique) {
        if (uniqueName) {
          const cols = b.uniques.get(uniqueName) ?? [];
          if (!cols.includes(columnName)) cols.push(columnName);
          b.uniques.set(uniqueName, cols);
        } else entry.field.unique = true;
      }
      // In the constraint-join shape only a FOREIGN KEY row's referenced columns are a foreign key.
      const fkTable = ctype && !/^(FOREIGN KEY|R)$/.test(ctype) ? '' : cell(row, 'fkTable');
      if (fkTable) {
        const fkName = cell(row, 'fkName') || (roles.fkName === undefined ? cname : '');
        const toColumn = cell(row, 'fkColumn');
        const group = fkName ? `n:${fkName}` : `c:${columnName}\u0000${cell(row, 'fkSchema')}\u0000${fkTable}\u0000${toColumn}`;
        let fk = b.fks.get(group);
        if (!fk) {
          fk = { ...(fkName ? { name: fkName } : {}), toCatalog: cell(row, 'fkCatalog'), toSchema: cell(row, 'fkSchema'), toTable: fkTable, pairs: [], line, file: file.name };
          b.fks.set(group, fk);
        }
        const ord = cell(row, 'fkOrdinal');
        if (!fk.pairs.some((p) => p.from === columnName && p.to === toColumn)) fk.pairs.push({ from: columnName, to: toColumn, ordinal: /^-?\d+$/.test(ord) ? Number(ord) : Number.NaN });
      }
    }
  }

  for (const l of longNames) {
    ledger.problem(l.what, 'other', `${l.what} name`, { file: l.file, line: l.line, table: ledgerText(l.table, 40) },
      `left out: its name is longer than ${MAX_CATALOG_NAME_CHARS} characters`);
  }
  // A table every column of which was left out has nothing to draw (DBML refuses a table with no columns).
  const empty = order.filter((b) => b.table.fields.length === 0);
  for (const b of empty) {
    order.splice(order.indexOf(b), 1);
    tables.delete([...tables].find(([, v]) => v === b)![0]);
    ledger.problem('table', 'other', 'table', { file: b.file, line: b.table.origin.line, table: tableLabel(b.table) }, 'left out: none of its columns could be read');
  }
  const views = viewNames.size;
  if (order.length === 0) {
    const name = files[0]?.name ?? '';
    if (views + systemRows > 0) return fail('nothingToImport', name, `No tables to import: every row is a view or a system table (${plural(views + systemRows, 'row')}).`);
    if (longNames.length) return fail('nothingToImport', name, `No tables to import: every table, or every column of it, has a name longer than ${MAX_CATALOG_NAME_CHARS} characters.`);
    return fail('nothingToImport', name, 'No rows name both a table and a column.');
  }

  // 3. Column order, keys.
  for (const b of order) {
    const entries = [...b.byName.values()];
    if (entries.every((e) => Number.isFinite(e.ordinal))) {
      const at = new Map(entries.map((e) => [e.field, e.ordinal]));
      b.table.fields.sort((x, y) => (at.get(x) as number) - (at.get(y) as number));
    }
    const position = (c: string): number => b.table.fields.findIndex((f) => f.name === c);
    const pk = b.pk.every((p) => Number.isFinite(p.ordinal))
      ? [...b.pk].sort((x, y) => x.ordinal - y.ordinal).map((p) => p.column)
      : b.pk.map((p) => p.column).sort((x, y) => position(x) - position(y));
    if (pk.length === 1) { const f = b.byName.get(pk[0])?.field; if (f) { f.pk = true; f.notNull = true; } }
    else if (pk.length > 1) {
      b.table.primaryKey = pk;
      for (const c of pk) { const f = b.byName.get(c)?.field; if (f) f.notNull = true; }
    }
    for (const cols of b.uniques.values()) {
      if (cols.length === 1) { const f = b.byName.get(cols[0])?.field; if (f) f.unique = true; }
      else b.table.uniques.push([...cols].sort((x, y) => position(x) - position(y)));
    }
  }

  // Two tables whose names differ only by case (a case-sensitive database), or in two catalogs, cannot both keep the name.
  {
    const used = new Map<string, number>();
    for (const b of order) {
      const k = `${(b.table.schema ?? '').toLowerCase()}.${b.table.name.toLowerCase()}`;
      const n = (used.get(k) ?? 0) + 1;
      used.set(k, n);
      if (n === 1) continue;
      const original = b.table.name;
      let name = `${original}_${n}`;
      while (order.some((o) => o !== b && sameIdent(o.table.name, name) && (o.table.schema ?? '').toLowerCase() === (b.table.schema ?? '').toLowerCase())) name = `${name}_${n}`;
      b.table.alias = original;
      b.table.name = name;
      ledger.changed('table', 'renamed', 'same name', { file: b.file, line: b.table.origin.line, table: tableLabel(b.table) },
        `imported as ${name}: the file has another table ${original} in this schema${b.catalog ? ' (another catalog, or another case)' : ' in another case'}`);
    }
  }
  // Likewise two columns of one table.
  for (const b of order) {
    const seen = new Set<string>();
    b.table.fields = b.table.fields.filter((f) => {
      const k = f.name.toLowerCase();
      if (!seen.has(k)) { seen.add(k); return true; }
      ledger.lost('column', 'duplicate', 'same name in another case', { file: b.file, line: b.table.origin.line, table: tableLabel(b.table), column: f.name },
        'not kept: the table already has this column in another case');
      b.byName.delete(f.name);
      return false;
    });
  }

  // 4. Foreign keys, resolved against the tables read.
  const byLowerName = new Map<string, Building[]>();
  for (const b of order) {
    const k = (b.table.alias ?? b.table.name).toLowerCase();
    byLowerName.set(k, [...(byLowerName.get(k) ?? []), b]);
  }
  const find = (from: Building, catalog: string, schema: string, name: string): Building | undefined => {
    const named = byLowerName.get(name.toLowerCase()) ?? [];
    const exact = named.filter((b) => (b.table.alias ?? b.table.name) === name);
    let pool = exact.length ? exact : named;
    if (catalog) { const inCatalog = pool.filter((b) => sameIdent(b.catalog, catalog)); if (inCatalog.length) pool = inCatalog; }
    if (schema) return pool.find((b) => sameIdent(b.table.schema ?? '', schema));
    return pool.find((b) => b.table.schema === from.table.schema && b.catalog === from.catalog) ?? (pool.length === 1 ? pool[0] : undefined);
  };
  const refs: ResolvedRef[] = [];
  const linked = new Map<string, ResolvedRef>();
  const fkLost = (b: Building, fk: FkGroup, why: string): void => {
    const target = [fk.toSchema, fk.toTable].filter(Boolean).join('.');
    skippedLines.push(`${fk.file} line ${fk.line}: foreign key ${tableLabel(b.table)}(${fk.pairs.map((p) => p.from).join(', ')}) → ${target}: ${why}`);
    ledger.lost('relationship', why.includes('not in the file') ? 'notInFiles' : 'other', 'foreign key',
      { file: fk.file, line: fk.line, table: tableLabel(b.table), column: fk.pairs.map((p) => p.from).join('+') }, `not kept: ${why}`);
  };
  const hasNames = readFiles.some((f) => f.roles.fkName !== undefined || f.roles.constraintName !== undefined);
  for (const b of order) {
    let fks = [...b.fks.values()];
    // With no constraint name to group by, columns that together reference a table's whole composite key are one foreign key.
    if (!hasNames) {
      const byTarget = new Map<string, FkGroup[]>();
      for (const fk of fks) {
        const k = `${fk.toSchema.toLowerCase()}\u0000${fk.toTable.toLowerCase()}`;
        byTarget.set(k, [...(byTarget.get(k) ?? []), fk]);
      }
      for (const group of byTarget.values()) {
        if (group.length < 2) continue;
        const key = find(b, group[0].toCatalog, group[0].toSchema, group[0].toTable)?.table.primaryKey;
        if (!key || key.length !== group.length) continue;
        const targets = group.map((g) => g.pairs[0].to.toLowerCase());
        if (new Set(targets).size !== key.length || !key.every((c) => targets.includes(c.toLowerCase()))) continue;
        const merged: FkGroup = { ...group[0], pairs: group.flatMap((g) => g.pairs) };
        fks = [...fks.filter((f) => !group.includes(f)), merged];
        ledger.changed('relationship', 'inferred', 'composite foreign key', { file: merged.file, line: merged.line, table: tableLabel(b.table), column: merged.pairs.map((p) => p.from).join('+') },
          `read as one foreign key: its columns reference the whole key of ${merged.toTable} (the file names no constraint to group them by)`);
      }
    }
    for (const fk of fks) {
      if (fk.pairs.every((p) => Number.isFinite(p.ordinal))) fk.pairs.sort((x, y) => x.ordinal - y.ordinal);
      const target = find(b, fk.toCatalog, fk.toSchema, fk.toTable);
      if (!target) { fkLost(b, fk, `${[fk.toSchema, fk.toTable].filter(Boolean).join('.')} is not in the file`); continue; }
      const fromColumns = fk.pairs.map((p) => b.table.fields.find((f) => sameIdent(f.name, p.from))?.name);
      const named = fk.pairs.map((p) => p.to);
      const toNames = named.every((c) => !c) ? primaryKeyOf(target.table) : named;
      if (named.some((c) => !c) && named.some(Boolean)) { fkLost(b, fk, 'some of its rows name no referenced column'); continue; }
      const toColumns = toNames.map((c) => target.table.fields.find((f) => sameIdent(f.name, c))?.name);
      if (fromColumns.some((c) => !c) || toColumns.some((c) => !c)) { fkLost(b, fk, `a column it names is not in ${tableLabel(target.table)}`); continue; }
      if (fromColumns.length !== toColumns.length) {
        fkLost(b, fk, toColumns.length === 0 ? `${tableLabel(target.table)} has no primary key for it to reference` : `${fromColumns.length} column(s) reference ${toColumns.length}`);
        continue;
      }
      const resolved: ResolvedRef = { from: b.table, fromColumns: fromColumns as string[], to: target.table, toColumns: toColumns as string[] };
      const end = (t: ModelTable, cols: readonly string[]): string => `${tableLabel(t).toLowerCase()}(${cols.map((c) => c.toLowerCase()).join(',')})`;
      const exact = `${end(b.table, resolved.fromColumns)}>${end(target.table, resolved.toColumns)}`;
      if (linked.has(exact)) continue;
      // DBML refuses a second reference between the same columns, whichever way round it points.
      const sameEnds = [end(b.table, resolved.fromColumns), end(target.table, resolved.toColumns)].sort().join('|');
      if (linked.has(sameEnds)) {
        const kept = linked.get(sameEnds) as ResolvedRef;
        fkLost(b, fk, `${tableLabel(kept.from)}(${kept.fromColumns.join(', ')}) and ${tableLabel(kept.to)}(${kept.toColumns.join(', ')}) are already joined the other way round`);
        continue;
      }
      linked.set(exact, resolved);
      linked.set(sameEnds, resolved);
      const cardinality = cardinalityOf(resolved);
      const where = { file: fk.file, line: fk.line, table: tableLabel(b.table), column: resolved.fromColumns.join('+') };
      if (cardinality === 'one-to-one') resolved.oneToOne = true;
      else if (cardinality === 'unwritable' && resolved.fromColumns.length === 1) { resolved.oneToOne = true; resolved.inline = true; }
      else if (cardinality === 'unwritable') {
        ledger.changed('relationship', 'other', 'one-to-one link', where, 'written as many-to-one: its FK columns are their table\'s key, but it references columns that are not');
      }
      refs.push(resolved);
    }
  }

  // 5. Write, and leave out at its table or reference what DBML does not read back.
  const modelTables = order.map((b) => b.table);
  const problems: CatalogCsvProblem[] = [];
  let kept = refs;
  let written = writeDbmlMapped([], modelTables, kept);
  for (let pass = 0; check && pass < MAX_DBML_CHECKS; pass++) {
    const diagnostics = check(written.dbml);
    if (diagnostics.length === 0) break;
    const badTables = new Map<ModelTable, string>();
    const badRefs = new Map<ResolvedRef, string>();
    for (const d of diagnostics) {
      const owner = ownerOfLine(written.owners, d.line);
      if (owner?.ref && !badRefs.has(owner.ref)) badRefs.set(owner.ref, d.message);
      else if (owner?.table && !owner.ref && !badTables.has(owner.table)) badTables.set(owner.table, d.message);
    }
    if (badTables.size === 0 && badRefs.size === 0) break;
    for (const [table, message] of badTables) {
      modelTables.splice(modelTables.indexOf(table), 1);
      problems.push({ file: table.origin.file, line: table.origin.line, message: `Table ${tableLabel(table)} could not be written as DBML (${ledgerText(message, 120, true)}), so it is left out.` });
      ledger.problem('table', 'parseError', 'table', { file: table.origin.file, line: table.origin.line, table: tableLabel(table) }, 'left out: it could not be written as DBML');
    }
    kept = kept.filter((r) => {
      const dropped = badTables.has(r.from) || badTables.has(r.to);
      if (!dropped && !badRefs.has(r)) return true;
      ledger.lost('relationship', 'parseError', 'foreign key', { file: r.from.origin.file, table: tableLabel(r.from), column: r.fromColumns.join('+') },
        dropped ? 'not kept: its table is left out' : `not kept: it could not be written as DBML (${ledgerText(badRefs.get(r) ?? '', 80, true)})`);
      return false;
    });
    if (modelTables.length === 0) {
      return { ok: false, reason: 'unwritable', problems, ledger: [...ledger.entries] };
    }
    written = writeDbmlMapped([], modelTables, kept);
  }

  // 6. What the files carried, and what they did not: said as the file's, never as the model's.
  const hasPk = order.some((b) => b.pk.length > 0);
  const columnCount = modelTables.reduce((n, t) => n + t.fields.length, 0);
  const anyWhole = modelTables.some((t) => t.fields.some((f) => /[(<]/.test(f.type)));
  const bare = modelTables.reduce((n, t) => n + t.fields.filter((f) => bareSized(f.type)).length, 0);
  let notice: string | undefined;
  if (!coverage.primaryKeyColumn && !coverage.foreignKeyColumns) {
    notice = `This file has no key columns, so its tables came in without primary keys${coverage.uniqueColumn ? '' : ', unique keys'} or relationships. ${GUIDE_POINTER}`;
  } else {
    if (!coverage.primaryKeyColumn) notes.push(`The file has no primary key column, so its tables came in without primary keys. ${GUIDE_POINTER}`);
    else if (!hasPk) notes.push('No table in the file has a primary key: its key column marks none.');
    if (!coverage.foreignKeyColumns) notes.push(`The file has no foreign key columns, so no relationships came in. ${GUIDE_POINTER}`);
  }
  if (!coverage.tableType) notes.push('The file has no table_type column, so views cannot be told from tables: any views in it came in as tables.');
  if (!coverage.nullability) notes.push('The file has no is_nullable column, so no column came in as NOT NULL.');
  if (!coverage.comments) notes.push('The file has no comment columns, so no descriptions came in.');
  if (!anyWhole && bare > 0) {
    notes.push(`${plural(bare, 'column has a type', 'columns have a type')} that usually carries a size (varchar, decimal…), but the file gives no full type and no length, precision or scale column, so ${bare === 1 ? 'its size' : 'their sizes'} did not come in.`);
  }
  if (rebuilt) ledger.changed('type', 'inferred', '', { file: files[0]?.name }, 'sized from the length, precision and scale columns', rebuilt);
  if (unknownTypes) ledger.changed('type', 'other', '', { file: files[0]?.name }, 'typed unknown: the row gives no type', unknownTypes);
  if (disagree) ledger.changed('column', 'duplicate', 'repeated row', { file: files[0]?.name }, 'gave the column another type; the first row\'s type is kept', disagree);
  if (views) ledger.skipped('table', 'notDesign', 'view', { file: files[0]?.name }, undefined, views);
  if (systemRows) ledger.skipped('column', 'notDesign', 'system schema row', { file: files[0]?.name }, undefined, systemRows);
  if (noName) ledger.skipped('column', 'other', 'row with no table or column name', { file: files[0]?.name }, undefined, noName);
  const skipped = [
    ...(views ? [`${plural(views, 'view')} (table_type says so)`] : []),
    ...(systemRows ? [`${plural(systemRows, 'row')} of system schemas (information_schema, pg_catalog, sys…)`] : []),
    ...(noName ? [`${plural(noName, 'row')} with no table or column name`] : []),
    ...(ragged ? [`${plural(ragged, 'row')} with more or fewer cells than the column names (read by position)`] : []),
    ...(unterminated ? [`a quoted cell that never closes: the ${unterminated === 1 ? 'file was' : 'files were'} read to the end as that cell`] : []),
    ...skippedLines,
  ];

  const first = readFiles[0];
  const headers: Partial<Record<CatalogCsvRole, string>> = {};
  for (const role of Object.keys(first.roles) as CatalogCsvRole[]) headers[role] = first.read.header[first.roles[role] as number];
  return {
    ok: true,
    dbml: written.dbml,
    tableCount: modelTables.length,
    columnCount,
    refCount: kept.length,
    notes,
    ...(notice ? { notice } : {}),
    skipped,
    problems: [
      ...problems,
      ...longNames.map((l) => ({ file: l.file, line: l.line, message: `${l.what === 'table' ? 'A table' : `A column of ${ledgerText(l.table, 40)}`} has a name longer than ${MAX_CATALOG_NAME_CHARS} characters, so it is left out.` })),
      ...empty.map((b) => ({ file: b.file, line: b.table.origin.line, message: `Table ${ledgerText(tableLabel(b.table), 60)} is left out: none of its columns could be read.` })),
    ],
    ledger: [...ledger.entries],
    coverage: {
      delimiter: first.read.delimiter,
      headers,
      rows: totalRows,
      primaryKeyColumn: coverage.primaryKeyColumn,
      foreignKeyColumns: coverage.foreignKeyColumns,
      uniqueColumn: coverage.uniqueColumn,
      nullability: coverage.nullability,
      tableType: coverage.tableType,
      totalRows: coverage.totalRows,
      comments: coverage.comments,
      types: anyWhole || coverage.fullType || coverage.sizeColumns || bare === 0 ? 'whole' : 'bare',
    },
  };
}

/** The ledger a conversion that failed leaves (empty but for what it had recorded): for the import report. */
export function catalogFailureLedger(result: Extract<CatalogCsvResult, { ok: false }>): LedgerEntry[] {
  const ledger: ImportLedger = createLedger(result.ledger);
  for (const p of result.problems) ledger.problem('file', 'parseError', 'catalog export', { file: p.file, ...(p.line ? { line: p.line } : {}) }, ledgerText(p.message, 90));
  return [...ledger.entries];
}
