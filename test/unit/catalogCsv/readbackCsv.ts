/**
 * SYNTHESISED catalog exports, for the catalog-CSV corpus score
 * (`catalogCsvImport.corpus.test.ts`): an engine read-back
 * (`test/real-world-truth/engine/*.json`) written as the CSV that engine's own
 * catalog would export. These files were never exported by the engines: they
 * are written from the engines' documentation (see {@link GUESSES}), so the
 * score measures the importer's reading of each shape, not a real export.
 * The real exports are in `test/fixtures/catalog-csv/` and are scored in
 * `catalogCsvImport.fixtures.test.ts`.
 *
 * Three variants per engine:
 * - `raw`:     `SELECT * FROM information_schema.columns` (Oracle: ALL_TAB_COLUMNS;
 *              SQLite: sqlite_master joined to pragma_table_info), every column the view has.
 * - `keyed`:   raw LEFT JOINed to the key views information_schema itself has
 *              (key_column_usage + table_constraints + the referenced end): one row per
 *              column per constraint. Constraints only (a unique INDEX is not in
 *              information_schema); comments only where information_schema has them.
 * - `catalog`: the best single query the engine's own catalog allows: full type
 *              (format_type, DESCRIBE), unique indexes, comments (pg_description,
 *              sys.extended_properties), in the contract's own column names.
 */
import type { Dialect, EngineColumn, EngineForeignKey, EngineKey, EngineReadback, EngineTable } from '../realWorldEngineTruth';

export type CsvVariant = 'raw' | 'keyed' | 'catalog';

interface Flavour {
  /** How headers are cased. */
  upper: boolean;
  delimiter: string;
  eol: string;
  bom: boolean;
  /** How SQL NULL is written. */
  nullText: string;
  yes: string;
  no: string;
}

const FLAVOURS: Record<Dialect, Flavour> = {
  // psql \copy … CSV HEADER
  postgres: { upper: false, delimiter: ',', eol: '\n', bom: false, nullText: '', yes: 't', no: 'f' },
  // mysql --batch: tab-separated, NULL written out
  mysql: { upper: true, delimiter: '\t', eol: '\n', bom: false, nullText: 'NULL', yes: '1', no: '0' },
  // SSMS "Save Results As… CSV": BOM, CRLF, NULL written out
  sqlserver: { upper: true, delimiter: ',', eol: '\r\n', bom: true, nullText: 'NULL', yes: '1', no: '0' },
  // Snowsight download
  snowflake: { upper: true, delimiter: ',', eol: '\n', bom: false, nullText: '', yes: 'true', no: 'false' },
  // Databricks SQL editor download: NULL is `null`
  databricks: { upper: false, delimiter: ',', eol: '\n', bom: false, nullText: 'null', yes: 'true', no: 'false' },
  // SQL Developer export, semicolon as a European locale writes it
  oracle: { upper: true, delimiter: ';', eol: '\r\n', bom: false, nullText: '', yes: 'Y', no: 'N' },
  // sqlite3 -header -csv
  sqlite: { upper: false, delimiter: ',', eol: '\r\n', bom: false, nullText: '', yes: '1', no: '0' },
};

type Row = Record<string, string | null>;

const PG_COLUMNS = ['table_catalog', 'table_schema', 'table_name', 'column_name', 'ordinal_position', 'column_default', 'is_nullable', 'data_type', 'character_maximum_length', 'character_octet_length', 'numeric_precision', 'numeric_precision_radix', 'numeric_scale', 'datetime_precision', 'interval_type', 'interval_precision', 'character_set_catalog', 'character_set_schema', 'character_set_name', 'collation_catalog', 'collation_schema', 'collation_name', 'domain_catalog', 'domain_schema', 'domain_name', 'udt_catalog', 'udt_schema', 'udt_name', 'scope_catalog', 'scope_schema', 'scope_name', 'maximum_cardinality', 'dtd_identifier', 'is_self_referencing', 'is_identity', 'identity_generation', 'identity_start', 'identity_increment', 'identity_maximum', 'identity_minimum', 'identity_cycle', 'is_generated', 'generation_expression', 'is_updatable'];
const MYSQL_COLUMNS = ['table_catalog', 'table_schema', 'table_name', 'column_name', 'ordinal_position', 'column_default', 'is_nullable', 'data_type', 'character_maximum_length', 'character_octet_length', 'numeric_precision', 'numeric_scale', 'datetime_precision', 'character_set_name', 'collation_name', 'column_type', 'column_key', 'extra', 'privileges', 'column_comment', 'generation_expression', 'srs_id'];
const MSSQL_COLUMNS = ['table_catalog', 'table_schema', 'table_name', 'column_name', 'ordinal_position', 'column_default', 'is_nullable', 'data_type', 'character_maximum_length', 'character_octet_length', 'numeric_precision', 'numeric_precision_radix', 'numeric_scale', 'datetime_precision', 'character_set_catalog', 'character_set_schema', 'character_set_name', 'collation_catalog', 'collation_schema', 'collation_name', 'domain_catalog', 'domain_schema', 'domain_name'];
const SNOWFLAKE_COLUMNS = [...PG_COLUMNS.slice(0, 41), 'identity_ordered', 'schema_evolution_record', 'comment'];
const DATABRICKS_COLUMNS = ['table_catalog', 'table_schema', 'table_name', 'column_name', 'ordinal_position', 'column_default', 'is_nullable', 'full_data_type', 'data_type', 'character_maximum_length', 'character_octet_length', 'numeric_precision', 'numeric_precision_radix', 'numeric_scale', 'datetime_precision', 'interval_type', 'interval_precision', 'maximum_cardinality', 'is_identity', 'identity_generation', 'identity_start', 'identity_increment', 'identity_maximum', 'identity_minimum', 'identity_cycle', 'is_generated', 'generation_expression', 'is_system_time_period_start', 'is_system_time_period_end', 'system_time_period_timestamp_generation', 'is_updatable', 'partition_index', 'comment'];
const ORACLE_COLUMNS = ['owner', 'table_name', 'column_name', 'data_type', 'data_type_mod', 'data_type_owner', 'data_length', 'data_precision', 'data_scale', 'nullable', 'column_id', 'default_length', 'data_default', 'num_distinct', 'low_value', 'high_value', 'density', 'num_nulls', 'num_buckets', 'last_analyzed', 'sample_size', 'character_set_name', 'char_col_decl_length', 'global_stats', 'user_stats', 'avg_col_len', 'char_length', 'char_used', 'v80_fmt_image', 'data_upgraded', 'histogram', 'default_on_null', 'identity_column', 'evaluation_edition', 'unusable_before', 'unusable_beginning', 'collation'];
const SQLITE_COLUMNS = ['table_name', 'cid', 'name', 'type', 'notnull', 'dflt_value', 'pk'];

const RAW_COLUMNS: Record<Dialect, string[]> = { postgres: PG_COLUMNS, mysql: MYSQL_COLUMNS, sqlserver: MSSQL_COLUMNS, snowflake: SNOWFLAKE_COLUMNS, databricks: DATABRICKS_COLUMNS, oracle: ORACLE_COLUMNS, sqlite: SQLITE_COLUMNS };

/** AdventureWorks' alias types (CREATE TYPE … FROM), which INFORMATION_SCHEMA shows as their base type with DOMAIN_NAME. */
const MSSQL_ALIAS: Record<string, string> = { name: 'nvarchar(50)', flag: 'bit', namestyle: 'bit', phone: 'nvarchar(25)', accountnumber: 'nvarchar(15)', ordernumber: 'nvarchar(25)' };
const MSSQL_NUMERIC: Record<string, [number, number]> = { int: [10, 0], smallint: [5, 0], tinyint: [3, 0], bigint: [19, 0], money: [19, 4], smallmoney: [10, 4], bit: [1, 0] };
const PG_NUMERIC: Record<string, [number, number, string]> = { integer: [32, 0, 'int4'], bigint: [64, 0, 'int8'], smallint: [16, 0, 'int2'] };

/** The type columns of one catalog row, from the read-back's type string. */
function typeCells(dialect: Dialect, col: EngineColumn): Row {
  const type = col.type;
  const args = /^(.*?)\s*\(([^()]*)\)\s*(.*)$/.exec(type);
  const base = (args ? `${args[1]}${args[3] ? ` ${args[3]}` : ''}` : type).trim();
  const nums = args ? args[2].split(',').map((s) => s.trim()) : [];
  switch (dialect) {
    case 'postgres': {
      if (type.endsWith('[]')) return { data_type: 'ARRAY', udt_name: `_${type.slice(0, -2)}` };
      // pagila: CREATE DOMAIN year AS integer; CREATE TYPE mpaa_rating AS ENUM; the vector extension's type.
      if (type === 'year') return { data_type: 'integer', numeric_precision: '32', numeric_precision_radix: '2', numeric_scale: '0', domain_schema: 'public', domain_name: 'year', udt_name: 'int4' };
      if (type === 'mpaa_rating' || /^vector\b/.test(type)) return { data_type: 'USER-DEFINED', udt_name: base };
      if (PG_NUMERIC[type]) return { data_type: type, numeric_precision: String(PG_NUMERIC[type][0]), numeric_precision_radix: '2', numeric_scale: '0', udt_name: PG_NUMERIC[type][2] };
      if (base === 'character varying' || base === 'character') return { data_type: base, character_maximum_length: nums[0] ?? null, character_octet_length: nums[0] ? String(Number(nums[0]) * 4) : '1073741824', udt_name: base === 'character' ? 'bpchar' : 'varchar' };
      if (base === 'numeric') return { data_type: 'numeric', numeric_precision: nums[0] ?? null, numeric_precision_radix: '10', numeric_scale: nums[1] ?? (nums[0] ? '0' : null), udt_name: 'numeric' };
      if (base === 'double precision') return { data_type: base, numeric_precision: '53', numeric_precision_radix: '2', udt_name: 'float8' };
      if (/^timestamp/.test(base)) return { data_type: base, datetime_precision: '6', udt_name: /with time zone/.test(base) ? 'timestamptz' : 'timestamp' };
      if (base === 'date') return { data_type: 'date', datetime_precision: '0', udt_name: 'date' };
      if (base === 'text') return { data_type: 'text', character_octet_length: '1073741824', udt_name: 'text' };
      return { data_type: base, udt_name: base === 'boolean' ? 'bool' : base };
    }
    case 'mysql': {
      const word = type.split(/[ (]/)[0];
      const out: Row = { data_type: word, column_type: type };
      if (/char$/.test(word)) { out.character_maximum_length = nums[0]; out.character_octet_length = String(Number(nums[0]) * 4); }
      if (/text$/.test(word)) { out.character_maximum_length = '65535'; out.character_octet_length = '65535'; }
      if (word === 'blob') { out.character_maximum_length = '65535'; out.character_octet_length = '65535'; }
      if (word === 'decimal') { out.numeric_precision = nums[0]; out.numeric_scale = nums[1]; }
      const ints: Record<string, number> = { tinyint: 3, smallint: 5, mediumint: 7, int: 10, bigint: 19 };
      if (ints[word]) { out.numeric_precision = String(ints[word]); out.numeric_scale = '0'; }
      if (/^(timestamp|datetime)$/.test(word)) out.datetime_precision = '0';
      if (col.srid !== undefined && col.srid !== null) out.srs_id = String(col.srid);
      return out;
    }
    case 'sqlserver': {
      let t = type;
      const out: Row = {};
      const alias = /^dbo\.(\w+)$/.exec(t);
      if (alias) { out.domain_schema = 'dbo'; out.domain_name = alias[1]; t = MSSQL_ALIAS[alias[1].toLowerCase()] ?? 'nvarchar(50)'; }
      // A computed column's own type is not in the read-back: INFORMATION_SCHEMA would give the expression's type.
      if (t === '(computed)') return { data_type: 'int', numeric_precision: '10', numeric_precision_radix: '10', numeric_scale: '0' };
      const m = /^(\w+)\s*(?:\(([^()]*)\))?/.exec(t) as RegExpExecArray;
      const word = m[1];
      const a = (m[2] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      out.data_type = word;
      if (/char$|binary$/.test(word)) { out.character_maximum_length = a[0] === 'max' ? '-1' : a[0] ?? '1'; out.character_octet_length = a[0] === 'max' ? '-1' : String(Number(a[0] ?? 1) * (/^n/.test(word) ? 2 : 1)); }
      else if (word === 'xml') { out.character_maximum_length = '-1'; out.character_octet_length = '-1'; }
      else if (word === 'decimal' || word === 'numeric') { out.numeric_precision = a[0] ?? '18'; out.numeric_precision_radix = '10'; out.numeric_scale = a[1] ?? '0'; }
      else if (MSSQL_NUMERIC[word]) { out.numeric_precision = String(MSSQL_NUMERIC[word][0]); out.numeric_precision_radix = '10'; out.numeric_scale = String(MSSQL_NUMERIC[word][1]); }
      else if (word === 'datetime') out.datetime_precision = '3';
      else if (word === 'date') out.datetime_precision = '0';
      else if (word === 'time' || word === 'datetime2') out.datetime_precision = a[0] ?? '7';
      return out;
    }
    case 'snowflake': {
      // Snowflake's information_schema names every string type TEXT, and a vector only VECTOR.
      if (/^(VARCHAR|TEXT|STRING|CHAR)$/i.test(base)) return { data_type: 'TEXT', character_maximum_length: nums[0] ?? '16777216', character_octet_length: String(Math.min(Number(nums[0] ?? 16777216) * 4, 16777216)) };
      if (/^NUMBER$/i.test(base)) return { data_type: 'NUMBER', numeric_precision: nums[0] ?? '38', numeric_precision_radix: '10', numeric_scale: nums[1] ?? '0' };
      if (/^BINARY$/i.test(base)) return { data_type: 'BINARY', character_maximum_length: '8388608', character_octet_length: '8388608' };
      if (/^TIMESTAMP_/i.test(base)) return { data_type: base, datetime_precision: '9' };
      if (/^VECTOR$/i.test(base)) return { data_type: 'VECTOR' };
      return { data_type: base };
    }
    case 'databricks': {
      // Spark's parser names them long / integer; Unity Catalog's information_schema says bigint / int.
      const spark: Record<string, string> = { long: 'bigint', integer: 'int' };
      const full = (spark[base] ?? base) + (args ? `(${nums.join(',')})` : '');
      const out: Row = { full_data_type: full, data_type: (spark[base] ?? base).toUpperCase() };
      if (base === 'decimal') { out.numeric_precision = nums[0]; out.numeric_precision_radix = '10'; out.numeric_scale = nums[1]; }
      return out;
    }
    case 'oracle': {
      const out: Row = { data_type: base };
      if (/CHAR/.test(base)) { out.data_length = nums[0]; out.char_length = nums[0]; out.char_used = 'B'; out.char_col_decl_length = nums[0]; }
      else if (base === 'NUMBER') { out.data_length = '22'; out.data_precision = nums[0] === '*' ? null : nums[0] ?? null; out.data_scale = nums[1] ?? (nums[0] ? '0' : null); out.char_length = '0'; }
      else if (base === 'DATE') { out.data_length = '7'; out.char_length = '0'; }
      return out;
    }
    case 'sqlite':
      return { type };
  }
}

const sameName = (a: string | null | undefined, b: string | null | undefined): boolean => (a ?? '') === (b ?? '');

/** Unique keys an export can carry: whole-column ones (an expression or partial index is not a column key). */
function uniquesOf(rb: EngineReadback, t: EngineTable, withIndexes: boolean): EngineKey[] {
  return rb.uniqueKeys.filter((u) => sameName(u.schema, t.schema) && u.table === t.name && !u.partial && !u.columns.some((c) => /[()]/.test(c)) && (withIndexes || (u.kind ?? 'constraint') === 'constraint'));
}

function quote(value: string, delimiter: string): string {
  return value.includes(delimiter) || /["\r\n]/.test(value) || /^\s|\s$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export interface GeneratedCsv { text: string; headers: string[]; rows: number }

export function readbackToCsv(rb: EngineReadback, dialect: Dialect, variant: CsvVariant): GeneratedCsv {
  const fl = FLAVOURS[dialect];
  const raw = RAW_COLUMNS[dialect];
  // Which key columns this variant adds, and under which names.
  const snowflakeNoKeys = dialect === 'snowflake' && variant === 'keyed';
  const joinShape = variant === 'keyed' && !snowflakeNoKeys && dialect !== 'sqlite';
  const extra: string[] = [];
  if (joinShape) extra.push('constraint_name', 'constraint_type', 'referenced_table_schema', 'referenced_table_name', 'referenced_column_name');
  if (variant === 'keyed' && dialect === 'sqlite') extra.push('fk_table', 'fk_column');
  if (variant === 'keyed' && (dialect === 'mysql' || dialect === 'databricks')) extra.push('table_comment');
  if (variant === 'keyed' && dialect === 'oracle') extra.push('comments', 'table_comments');
  if (variant === 'catalog') {
    if (dialect !== 'databricks' && dialect !== 'mysql') extra.push('full_data_type');
    extra.push('is_primary_key', 'unique_constraint_name', 'fk_constraint_name', 'fk_table_schema', 'fk_table_name', 'fk_column_name', 'table_comment');
    if (!raw.includes('comment') && !raw.includes('column_comment')) extra.push('column_comment');
  }
  const headers = [...raw, ...extra];
  const rows: Row[] = [];
  for (const t of rb.tables) {
    const pk = t.pk ?? [];
    const uniques = variant === 'raw' ? [] : uniquesOf(rb, t, variant === 'catalog');
    const fks: EngineForeignKey[] = variant === 'raw' || snowflakeNoKeys ? [] : rb.foreignKeys.filter((f) => sameName(f.schema, t.schema) && f.table === t.name);
    t.columns.forEach((col, index) => {
      const base: Row = { ...typeCells(dialect, col) };
      const catalog = (t as EngineTable & { catalog?: string }).catalog;
      if (dialect === 'oracle') Object.assign(base, { owner: t.schema, table_name: t.name, column_name: col.name, nullable: col.notNull ? 'N' : 'Y', column_id: String(index + 1) });
      else if (dialect === 'sqlite') Object.assign(base, { table_name: t.name, cid: String(index), name: col.name, notnull: col.notNull ? '1' : '0', pk: String(pk.indexOf(col.name) + 1) });
      else Object.assign(base, { table_catalog: catalog ?? (dialect === 'mysql' ? 'def' : dialect === 'postgres' ? 'postgres' : 'DB'), table_schema: t.schema, table_name: t.name, column_name: col.name, ordinal_position: String(index + 1), is_nullable: col.notNull ? 'NO' : 'YES' });
      if (dialect === 'postgres' || dialect === 'snowflake') base.is_updatable = 'YES';
      if (dialect === 'mysql') {
        const single = uniques.some((u) => u.columns.length === 1 && u.columns[0] === col.name) || rb.uniqueKeys.some((u) => u.table === t.name && u.columns.length === 1 && u.columns[0] === col.name);
        const multi = rb.uniqueKeys.some((u) => u.table === t.name && u.columns.length > 1 && u.columns[0] === col.name) || rb.foreignKeys.some((f) => f.table === t.name && f.columns[0] === col.name);
        base.column_key = pk.includes(col.name) ? 'PRI' : single ? 'UNI' : multi ? 'MUL' : '';
        base.column_comment = col.comment ?? '';
        base.privileges = 'select,insert,update,references';
        base.extra = '';
      }
      if ((dialect === 'snowflake' || dialect === 'databricks') && col.comment) base.comment = col.comment;
      if (variant === 'keyed' && (dialect === 'mysql' || dialect === 'databricks')) base.table_comment = t.comment ?? null;
      if (variant === 'keyed' && dialect === 'oracle') { base.comments = col.comment ?? null; base.table_comments = t.comment ?? null; }

      const myUniques = uniques.filter((u) => u.columns.includes(col.name));
      const myFks = fks.filter((f) => f.columns.includes(col.name));
      const refOf = (f: EngineForeignKey): string => f.refColumns[f.columns.indexOf(col.name)];
      if (variant === 'catalog') {
        Object.assign(base, { is_primary_key: pk.includes(col.name) ? fl.yes : fl.no, table_comment: t.comment ?? null });
        if (headers.includes('full_data_type') && dialect !== 'databricks') base.full_data_type = col.type === '(computed)' ? null : col.type;
        if (headers.includes('column_comment') && dialect !== 'mysql') base.column_comment = col.comment ?? null;
        // A LEFT JOIN to both key lists: one row per (unique key, foreign key) the column is in.
        const us: Array<EngineKey | null> = myUniques.length ? myUniques : [null];
        const fs: Array<EngineForeignKey | null> = myFks.length ? myFks : [null];
        for (const u of us) for (const f of fs) {
          rows.push({ ...base, unique_constraint_name: u ? u.name ?? `uq_${t.name}_${u.columns.join('_')}` : null, fk_constraint_name: f?.name ?? null, fk_table_schema: f?.refSchema ?? null, fk_table_name: f?.refTable ?? null, fk_column_name: f ? refOf(f) : null });
        }
        return;
      }
      if (joinShape) {
        const oracle = dialect === 'oracle';
        const joined: Row[] = [];
        if (pk.includes(col.name)) joined.push({ constraint_name: dialect === 'mysql' ? 'PRIMARY' : `${t.name}_pkey`, constraint_type: oracle ? 'P' : 'PRIMARY KEY' });
        for (const u of myUniques) joined.push({ constraint_name: u.name ?? `uq_${t.name}`, constraint_type: oracle ? 'U' : 'UNIQUE' });
        for (const f of myFks) joined.push({ constraint_name: f.name ?? `fk_${t.name}_${f.columns.join('_')}`, constraint_type: oracle ? 'R' : 'FOREIGN KEY', referenced_table_schema: f.refSchema, referenced_table_name: f.refTable, referenced_column_name: refOf(f) });
        if (joined.length === 0) joined.push({});
        for (const j of joined) rows.push({ ...base, ...j });
        return;
      }
      if (variant === 'keyed' && dialect === 'sqlite') {
        if (myFks.length === 0) rows.push(base);
        for (const f of myFks) rows.push({ ...base, fk_table: f.refTable, fk_column: refOf(f) });
        return;
      }
      rows.push(base);
    });
  }
  const head = headers.map((h) => (fl.upper ? h.toUpperCase() : h));
  const lines = [head.map((h) => quote(h, fl.delimiter)).join(fl.delimiter)];
  for (const r of rows) {
    lines.push(headers.map((h) => {
      const v = r[h];
      return v === null || v === undefined ? fl.nullText : quote(v, fl.delimiter);
    }).join(fl.delimiter));
  }
  // A trailing blank line, as most exports leave.
  return { text: (fl.bom ? '﻿' : '') + lines.join(fl.eol) + fl.eol + fl.eol, headers: head, rows: rows.length };
}

/** Where this generator is a guess (nothing here was run against an engine). */
export const GUESSES: readonly string[] = [
  'Every header list (information_schema.columns per engine, ALL_TAB_COLUMNS) is from the engines\' documentation as remembered; none was read from a live catalog.',
  'PostgreSQL: numeric_precision 32/64/16 for integers, udt_name spellings, ARRAY / USER-DEFINED for arrays, enums and extension types (vector(20) loses its size), pagila\'s year as a domain over integer.',
  'SQL Server: alias types shown as their base type plus DOMAIN_NAME (the six AdventureWorks alias bases are from memory); a computed column\'s result type is unknown to the read-back (written int).',
  'Snowflake: DATA_TYPE is TEXT for every string type and VECTOR for a vector; information_schema has no column-level key view, so `keyed` carries no keys at all.',
  'Databricks: the read-back is Spark\'s parser (long, integer); full_data_type is written bigint / int, data_type upper case, NULL as null.',
  'Oracle: ALL_TAB_COLUMNS (DATA_LENGTH 22 for NUMBER, 7 for DATE); the constraint join spelled with P / U / R and the referenced end already resolved.',
  'SQLite: sqlite_master joined to pragma_table_info, the foreign keys from pragma_foreign_key_list aliased to fk_table / fk_column.',
  'MySQL: COLUMN_KEY PRI / UNI / MUL; EXTRA is left empty (the read-back has no auto_increment flag).',
  'Views are absent: the read-backs hold tables only. A real `SELECT * FROM information_schema.columns` also returns every view\'s columns (and, on PostgreSQL, pg_catalog and information_schema themselves).',
  'File dressing per engine (tab + NULL for MySQL, BOM + CRLF + NULL for SQL Server, null for Databricks, semicolons for Oracle) is one plausible client each, chosen to cover the survive-list.',
];
