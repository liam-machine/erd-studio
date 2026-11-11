/**
 * The naming helpers relationship suggestions read (`relationshipSuggestions.ts`):
 * a name's words, a table's entity, a column's reference parts and a type's
 * family. Pure, no `vscode`, no Node built-ins, so it can move to
 * `@erd-studio/core` unchanged.
 */

/**
 * A name's words, lowercased: split at anything not a letter or digit and at
 * camelCase boundaries (`CustomerKey` → customer, key; `dimensionSetID` →
 * dimension, set, id; `Vendor No.` → vendor, no). Digits stay with the word
 * they follow (`sha1_hub` → sha1, hub).
 */
export function nameWords(name: string): string[] {
  const out: string[] = [];
  for (const piece of name.split(/[^A-Za-z0-9]+/)) {
    if (!piece) continue;
    const spaced = piece
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
    for (const w of spaced.split(' ')) if (w) out.push(w.toLowerCase());
  }
  return out;
}

/** Words joined with nothing between them: `Customer Key` = `customer_key` = `CustomerKey`. */
export const joinWords = (words: readonly string[]): string => words.join('');

/** One word in its singular form (`categories` → category, `addresses` → address, `status` stays). */
export function singular(word: string): string {
  if (word.length <= 3) return word;
  if (/ies$/.test(word)) return word.slice(0, -3) + 'y';
  if (/(sses|shes|ches|xes|zes)$/.test(word)) return word.slice(0, -2);
  if (/(ss|us|is|os)$/.test(word)) return word;
  if (/s$/.test(word)) return word.slice(0, -1);
  return word;
}

/** The words with the last one singular. */
export function singularWords(words: readonly string[]): string[] {
  if (words.length === 0) return [];
  return [...words.slice(0, -1), singular(words[words.length - 1])];
}

/** Leading words of a table name that say what kind of table it is, not what it holds. */
const TABLE_PREFIXES = new Set([
  'dim', 'fct', 'fact', 'stg', 'tbl', 'tb', 'vw', 'view', 'ref', 'lkp', 'lku', 'lu', 'lookup', 'int', 'base',
  'bridge', 'brg', 'mart', 'silver', 'gold', 'staging', 'curated', 'dw', 'edw', 'ods',
]);
/** Single letters that are prefixes only when more words follow (`d_customer`, `f_sales`, `t_order`, `v_orders`). */
const LETTER_PREFIXES = new Set(['d', 'f', 't', 'v']);
/** Leading words that mark a landing copy of a table (`raw_orders`, `bronze_orders`). */
const COPY_PREFIXES = new Set(['raw', 'src', 'bronze', 'landing', 'tmp', 'temp']);
/** Trailing words that say what kind of table it is (not a copy). */
const KIND_SUFFIXES = new Set(['dim', 'fact', 'tbl', 'table', 'master', 'lookup', 'lkp', 'ref']);
/** Trailing words that mark a copy or a version of another table (`customer_hist`, `orders_bak_20240101`, `orders_enriched`). */
const COPY_SUFFIXES = new Set([
  'v', 'vw', 'view', 'hist', 'snapshot', 'snap', 'snapshots', 'current', 'curr', 'latest', 'bak', 'backup', 'old', 'new', 'copy', 'tmp',
  'temp', 'stg', 'staging', 'raw', 'clean', 'cleaned', 'enriched', 'scd', 'scd2', 'archive', 'cdc', 'dedup', 'dedupe', 'deduped', 'test',
]);
/** A partition or date token: `p2022`, `2024`, `20240101`, `y2020m01`, `2024q1`, `01`. */
const PARTITION_TOKEN = /^([a-z]{0,2}\d{2,}[a-z0-9]*|\d+)$/;

/**
 * A table's entity: its words with schema qualification, kind prefixes (dim_, fct_, stg_, …), copy markers
 * (raw_, _hist, _bak, _20240101, _p2022_01, …) and a plural taken off. `dim_customer`, `customers`, `stg_customers`,
 * `customer_hist` and `silver_customers` are all the entity `customer`. `copy` says a copy marker was taken off.
 */
export function tableEntity(tableName: string, schema?: string): { words: string[]; copy: boolean } {
  let words = nameWords(tableName);
  if (schema) {
    const s = nameWords(schema);
    if (s.length > 0 && s.length < words.length && s.every((w, i) => words[i] === w)) words = words.slice(s.length);
  }
  let copy = false;
  let changed = true;
  while (changed && words.length > 1) {
    changed = false;
    const first = words[0];
    if (COPY_PREFIXES.has(first)) { words = words.slice(1); copy = true; changed = true; continue; }
    if (TABLE_PREFIXES.has(first) || LETTER_PREFIXES.has(first)) { words = words.slice(1); changed = true; continue; }
    const last = words[words.length - 1];
    if (KIND_SUFFIXES.has(last)) { words = words.slice(0, -1); changed = true; continue; }
    if (COPY_SUFFIXES.has(last) || PARTITION_TOKEN.test(last)) { words = words.slice(0, -1); copy = true; changed = true; }
  }
  return { words: singularWords(words), copy };
}

export function entityWords(tableName: string, schema?: string): string[] {
  return tableEntity(tableName, schema).words;
}

/** Last words of a column name that say it identifies something. */
export type KeySuffixFamily = 'id' | 'code' | 'number';
const KEY_SUFFIXES: ReadonlyMap<string, KeySuffixFamily> = new Map([
  ['id', 'id'], ['key', 'id'], ['sk', 'id'], ['fk', 'id'], ['pk', 'id'], ['hk', 'id'], ['uuid', 'id'], ['guid', 'id'], ['bk', 'id'],
  ['code', 'code'], ['cd', 'code'],
  ['no', 'number'], ['num', 'number'], ['nbr', 'number'], ['number', 'number'],
]);

export function keySuffixFamily(word: string | undefined): KeySuffixFamily | undefined {
  return word === undefined ? undefined : KEY_SUFFIXES.get(word);
}

/** A column read as a reference: the words naming what it points at, and the identifying suffix if any. */
export interface ColumnReference {
  stem: string[];
  suffix?: string;
  family?: KeySuffixFamily;
}

/** `customer_id` → stem customer, suffix id; `fk_customer` / `id_customer` → stem customer; `currency` → stem currency, no suffix. */
export function columnReference(words: readonly string[]): ColumnReference {
  let w = [...words];
  // customer_id_fk, customer_key_sk: the last suffix only marks it; read the one before.
  if (w.length > 2 && keySuffixFamily(w[w.length - 1]) && keySuffixFamily(w[w.length - 2])) w = w.slice(0, -1);
  const last = w[w.length - 1];
  const fam = keySuffixFamily(last);
  if (fam && w.length > 1) return { stem: w.slice(0, -1), suffix: last, family: fam };
  if (w.length > 1 && (w[0] === 'fk' || w[0] === 'id')) return { stem: w.slice(1), suffix: w[0], family: 'id' };
  if (fam) return { stem: [], suffix: last, family: fam };
  return { stem: w };
}

/** Words that name no entity of their own: a column made only of these is generic. */
export const GENERIC_WORDS = new Set([
  'id', 'key', 'code', 'name', 'type', 'status', 'state', 'date', 'time', 'value', 'amount', 'number', 'no', 'num', 'description', 'desc',
  'note', 'notes', 'comment', 'comments', 'flag', 'uuid', 'guid', 'hash', 'pk', 'fk', 'sk', 'label', 'title', 'text', 'kind', 'category',
  'level', 'version', 'seq', 'sequence', 'line', 'row', 'index', 'idx', 'order', 'rank', 'count', 'total', 'year', 'month', 'day', 'source',
]);

/** Columns that are bookkeeping, not facts about the entity: never the foreign key end of a suggestion. */
const AUDIT_NAMES = new Set([
  'createdat', 'updatedat', 'modifiedat', 'deletedat', 'insertedat', 'loadedat', 'ingestedat', 'processedat', 'syncedat',
  'createddate', 'updateddate', 'modifieddate', 'deleteddate', 'createdon', 'updatedon', 'modifiedon', 'lastupdate', 'lastupdated',
  'lastmodified', 'lastmodifieddate', 'modifieddatetime', 'createddatetime', 'loaddate', 'loaddts', 'loadts', 'loaddatetime',
  'etlloaddate', 'etlupdatedate', 'recordsource', 'ldts', 'rsrc', 'loadenddts', 'rowhash', 'hashdiff', 'batchid', 'runid', 'etlbatchid', 'loadid',
  'pipelineid', 'ingestionid', 'sourcesystem', 'sourcesystemid', 'sourcesystemcode', 'rowversion', 'rowguid', 'isdeleted', 'iscurrent',
  'validfrom', 'validto', 'effectivefrom', 'effectiveto', 'effectivedate', 'expirydate', 'startdate', 'enddate', 'filename', 'sourcefile',
  'tenantid', 'partitionid', 'partitiondate', 'snapshotdate', 'asofdate', 'extractdate', 'insertdate', 'updatedate', 'createdate',
]);
const AUDIT_FIRST_WORDS = new Set(['dbt', 'etl', 'audit', 'is', 'has', 'meta', 'sys', 'fivetran', 'airbyte', 'stitch', 'sdc', 'dlt', 'ingest', 'ingestion']);

/** Whether a column is bookkeeping (audit, load, flag or tool columns): `created_at`, `_loaded_at`, `dbt_valid_from`, `is_active`. */
export function isAuditColumn(rawName: string, words: readonly string[]): boolean {
  if (/^_/.test(rawName)) return true;
  if (words.length === 0) return true;
  if (AUDIT_NAMES.has(joinWords(words))) return true;
  if (words.length > 1 && AUDIT_FIRST_WORDS.has(words[0])) return true;
  // created_at, updated_ts, …: a verb in the past with a time word.
  if (words.length === 2 && /ed$/.test(words[0]) && ['at', 'on', 'ts', 'dt', 'dts', 'date', 'time', 'datetime', 'timestamp'].includes(words[1])) return true;
  return false;
}

/** Roles a person plays: a column `creator_id` or `manager_id` points at the people table. */
export const PERSON_ROLES = new Set([
  'creator', 'updater', 'deleter', 'uploader', 'flagger', 'owner', 'author', 'editor', 'manager', 'supervisor', 'approver', 'reviewer',
  'assignee', 'reporter', 'requester', 'requestor', 'createdby', 'updatedby', 'modifiedby', 'deletedby', 'lastmodifiedby', 'reportsto',
  'approvedby', 'assignedto', 'boss', 'mentor', 'sponsor', 'submitter', 'handler', 'agent', 'lead', 'leader', 'parentuser',
]);
/** Roles in an organisation: they point at the staff table, and inside it back at the same table. */
export const SELF_PERSON_ROLES = new Set(['manager', 'supervisor', 'reportsto', 'boss', 'mentor', 'lead', 'leader']);
/** Entities that are people. */
export const PERSON_ENTITIES = new Set(['user', 'person', 'people', 'employee', 'staff', 'member', 'worker', 'appuser', 'useraccount']);
/** People who work there (an organisation's roles point here first). */
export const STAFF_ENTITIES = new Set(['employee', 'staff', 'worker']);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A type's family, for the compatibility filter. `loose` is a type that says nothing (empty, `variant`, an
 * unknown or user-defined type, a Power BI calculated column): compatible with anything. `never` cannot be a
 * key (boolean, arrays, maps, structs, JSON, XML, geometry, vectors).
 */
export type TypeFamily = 'number' | 'string' | 'temporal' | 'binary' | 'never' | 'loose';

export function typeFamily(dataType: string | undefined): TypeFamily {
  const t = (dataType ?? '').trim().toLowerCase();
  if (!t) return 'loose';
  if (/^(array|map|struct|object|json|jsonb|xml|geography|geometry|vector|hierarchyid|tsvector|tsrange|set\(|enum\()/.test(t) || /\[\]$/.test(t) || /^public\.vector/.test(t)) return 'never';
  if (/^(bool|boolean|bit|flag)\b/.test(t)) return 'never';
  if (/^(variant|any|computed|sql_variant)\b/.test(t)) return 'loose';
  if (/^(tinyint|smallint|mediumint|int|integer|bigint|int2|int4|int8|int16|int32|int64|serial|bigserial|smallserial|long|short|byte|number|numeric|decimal|dec|bignumeric|float|float4|float8|float64|double|real|money|smallmoney|currency|whole number|year)\b/.test(t)) return 'number';
  if (/^(char|varchar|varchar2|nvarchar|nvarchar2|nchar|text|ntext|string|character|citext|clob|nclob|tinytext|mediumtext|longtext|uuid|uniqueidentifier|guid|sysname|name)\b/.test(t)) return 'string';
  if (/^(date|datetime|datetime2|datetimeoffset|smalldatetime|timestamp|timestamptz|timestamp_ntz|timestamp_ltz|timestamp_tz|time|timetz)\b/.test(t)) return 'temporal';
  if (/^(binary|varbinary|bytea|blob|bytes|raw|longblob)\b/.test(t)) return 'binary';
  return 'loose';
}

/** A type as compared for "the same type": case, spacing and the length of a string aside. */
export function typeShape(dataType: string | undefined): string {
  const t = (dataType ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (typeFamily(t) === 'string') return t.replace(/\(.*\)$/, '').replace(/^(nvarchar|varchar2|nvarchar2|character varying|nchar|char|character|text|string)$/, 'varchar');
  return t;
}

/**
 * Whether a foreign key of type `a` can point at a key of type `b`. Families must match, except that a loose
 * type matches anything, a string matches a binary (hash keys), and a type that cannot be a key matches nothing.
 */
export function typesCompatible(a: TypeFamily, b: TypeFamily): boolean {
  if (a === 'never' || b === 'never') return false;
  if (a === 'loose' || b === 'loose') return true;
  if (a === b) return true;
  return (a === 'string' && b === 'binary') || (a === 'binary' && b === 'string');
}
