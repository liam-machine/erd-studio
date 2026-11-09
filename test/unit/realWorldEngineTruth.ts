/**
 * Database truth for the real-world import samples: what the real engine holds
 * after loading each SQL sample (test/real-world-truth/engine/<sample>.json, written
 * by test/real-world-truth/readback.py), compared item by item with the
 * hand-counted truth in expected.json.
 *
 * Every difference must be listed, with its resolution, in
 * test/real-world-truth/differences.json (realWorldEngineTruth.test.ts holds the two
 * in step). docs/dev/real-world-truth.md says how to rerun the engines.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { TruthSample } from './realWorldScorecard';

export const TRUTH_DIR = path.join(__dirname, '../real-world-truth');

export type Dialect = 'postgres' | 'mysql' | 'sqlserver' | 'snowflake' | 'databricks';

export interface EngineColumn {
  name: string;
  type: string;
  notNull: boolean;
  comment?: string | null;
  srid?: number | null;
  generated?: string | null;
  computed?: string | null;
}
export interface EngineTable {
  schema: string | null;
  name: string;
  comment?: string | null;
  pk: string[] | null;
  columns: EngineColumn[];
  partitionOf?: string | null;
}
export interface EngineKey {
  schema: string | null;
  table: string;
  name: string | null;
  kind?: string;
  partial?: boolean;
  columns: string[];
  on?: string;
}
export interface EngineForeignKey extends EngineKey {
  refSchema: string | null;
  refTable: string;
  refColumns: string[];
  inherited?: boolean;
}
export interface EngineReadback {
  sample: string;
  engine: string;
  errors: Array<Record<string, unknown>>;
  tables: EngineTable[];
  uniqueKeys: EngineKey[];
  foreignKeys: EngineForeignKey[];
}

/** Each truth sample an engine read-back checks. Pagila is read once and checked both ways. */
export const ENGINE_PAIRS: ReadonlyArray<{ truth: string; engine: string; dialect: Dialect; foldPartitions?: boolean }> = [
  { truth: 'postgres-pagila', engine: 'postgres-pagila', dialect: 'postgres', foldPartitions: true },
  { truth: 'postgres-pagila-partitions-kept', engine: 'postgres-pagila', dialect: 'postgres' },
  { truth: 'mysql-sakila', engine: 'mysql-sakila', dialect: 'mysql' },
  { truth: 'sqlserver-adventureworks', engine: 'sqlserver-adventureworks', dialect: 'sqlserver' },
  { truth: 'snowflake-grid-reliability', engine: 'snowflake-grid-reliability', dialect: 'snowflake' },
  { truth: 'databricks-open-retail-data-model', engine: 'databricks-open-retail-data-model', dialect: 'databricks' },
  { truth: 'migrations-harbor', engine: 'migrations-harbor', dialect: 'postgres' },
];

export function loadReadback(sample: string): EngineReadback | null {
  const file = path.join(TRUTH_DIR, 'engine', `${sample}.json`);
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf-8')) as EngineReadback) : null;
}

/** An identifier as the engine folds it for comparison: quotes and brackets off, case ignored. */
export const ident = (s: string | null | undefined): string => (s ?? '').replace(/[[\]"`]/g, '').trim().toLowerCase();

const ws = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------
// Types: each dialect's spellings of one type brought to one form
// ---------------------------------------------------------------------------

function baseForm(t: string): string {
  return t.toLowerCase().replace(/[[\]"`]/g, '').replace(/\s+/g, ' ').replace(/\s*([(),<>:])\s*/g, '$1').trim();
}

const PG_ALIASES: Array<[RegExp, string]> = [
  [/^serial4?$/, 'integer'], [/^bigserial$|^serial8$/, 'bigint'], [/^smallserial$|^serial2$/, 'smallint'],
  [/^int4?$/, 'integer'], [/^int8$/, 'bigint'], [/^int2$/, 'smallint'], [/^bool$/, 'boolean'],
  [/^varchar\b/, 'character varying'], [/^bpchar\b/, 'character'], [/^char\b/, 'character'],
  [/^timestamptz\b/, 'timestamp with time zone'], [/^timetz\b/, 'time with time zone'],
  [/^decimal\b/, 'numeric'], [/^float8$|^float$/, 'double precision'], [/^float4$/, 'real'],
];

export function canonType(dialect: Dialect, raw: string): string {
  let t = baseForm(raw);
  switch (dialect) {
    case 'postgres': {
      t = t.replace(/^public\./, '').replace(/^pg_catalog\./, '');
      const arr = t.endsWith('[]') ? '[]' : '';
      if (arr) t = t.slice(0, -2);
      for (const [re, to] of PG_ALIASES) t = t.replace(re, to);
      t = t.replace(/^character varying\(/, 'character varying(');
      if (t === 'character') t = 'character(1)';
      if (/^timestamp(\(\d+\))?$/.test(t)) t = `${t} without time zone`;
      if (/^time(\(\d+\))?$/.test(t)) t = `${t} without time zone`;
      return t + arr;
    }
    case 'mysql': {
      t = t.replace(/\b(character set|charset|collate) \w+/g, '').replace(/\s+/g, ' ').trim();
      t = t.replace(/^(tinyint|smallint|mediumint|int|integer|bigint)\(\d+\)/, (m, k: string) => (m === 'tinyint(1)' ? m : k));
      t = t.replace(/^integer\b/, 'int').replace(/^bool(ean)?$/, 'tinyint(1)').replace(/^(dec|numeric|fixed)\b/, 'decimal');
      if (t === 'decimal') t = 'decimal(10,0)';
      return t;
    }
    case 'sqlserver': {
      if (/^as\b/.test(t) || t === '(computed)') return '(computed)';
      // An unqualified alias type ([Name]) is dbo's: the engine names it dbo.Name.
      t = t.replace(/^(sys|dbo)\./, '');
      if (t === 'decimal' || t === 'numeric') t += '(18,0)';
      if (/^(datetime2|time|datetimeoffset)$/.test(t)) t += '(7)';
      if (/^n?(var)?char$|^(var)?binary$/.test(t)) t += '(1)';
      if (t === 'float(53)') t = 'float';
      return t.replace(/^(xml)\((?!content |document )/, '$1(content ');
    }
    case 'snowflake': {
      t = t.replace(/^(int|integer|bigint|smallint|tinyint|byteint)$/, 'number(38,0)').replace(/^(decimal|numeric)\b/, 'number');
      if (t === 'number') t = 'number(38,0)';
      t = t.replace(/^number\((\d+)\)$/, 'number($1,0)');
      t = t.replace(/^(text|string|varchar|character varying|char varying|nvarchar|nvarchar2|char|character)(?=\(|$)/, 'varchar');
      if (t === 'varchar') t = 'varchar(16777216)';
      t = t.replace(/^(double|double precision|real|float4|float8)$/, 'float').replace(/^(timestamp|datetime)$/, 'timestamp_ntz');
      return t.replace(/^vector\((float|double)/, 'vector(float');
    }
    case 'databricks': {
      t = t.replace(/^long$/, 'bigint').replace(/^integer$/, 'int').replace(/^short$/, 'smallint').replace(/^byte$/, 'tinyint')
        .replace(/^real$/, 'float').replace(/^dec\b|^numeric\b/, 'decimal').replace(/^timestamp_ltz$/, 'timestamp').replace(/^bool$/, 'boolean');
      if (t === 'decimal') t = 'decimal(10,0)';
      return t;
    }
  }
}

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

export type DiffKind =
  | 'table' | 'schema' | 'column' | 'type' | 'not-null' | 'primary-key' | 'unique-key' | 'foreign-key' | 'description';

export interface EngineDiff {
  sample: string;
  kind: DiffKind;
  item: string;
  truth: string;
  engine: string;
}

export const diffKey = (d: Pick<EngineDiff, 'sample' | 'kind' | 'item'>): string => `${d.sample} | ${d.kind} | ${d.item}`;

/** Pagila with payment's partitions folded into payment: the logical model the default import draws. */
export function foldPartitions(rb: EngineReadback): EngineReadback {
  const parentOf = new Map<string, string>();
  for (const t of rb.tables) if (t.partitionOf) parentOf.set(ident(t.name), ident(t.partitionOf.split('.').pop()));
  const up = (name: string): string => parentOf.get(ident(name)) ?? name;
  const seen = new Set<string>();
  const foreignKeys: EngineForeignKey[] = [];
  for (const fk of rb.foreignKeys) {
    const moved = { ...fk, table: up(fk.table), refTable: up(fk.refTable) };
    const k = `${ident(moved.table)}(${moved.columns.map(ident)})>${ident(moved.refTable)}(${moved.refColumns.map(ident)})`;
    if (seen.has(k)) continue;
    seen.add(k);
    foreignKeys.push(moved);
  }
  return {
    ...rb,
    tables: rb.tables.filter((t) => !t.partitionOf),
    uniqueKeys: rb.uniqueKeys.filter((u) => !parentOf.has(ident(u.table))),
    foreignKeys,
  };
}

const keyText = (cols: readonly string[]): string => cols.map(ident).join(', ');
const setOf = (cols: readonly string[]): string => [...cols].map(ident).sort().join(',');
/** A unique key's item: a column, or an expression without casts and brackets (`lower((name)::text)` = `lower(name)`). */
const keyItem = (c: string): string => ident(c).replace(/::[a-z_]+( [a-z_]+)*/g, '').replace(/[()\s]/g, '');
const keySet = (cols: readonly string[]): string => [...cols].map(keyItem).sort().join(',');

export function compareWithEngine(sample: string, truth: TruthSample, rb: EngineReadback, dialect: Dialect): EngineDiff[] {
  const out: EngineDiff[] = [];
  const push = (kind: DiffKind, item: string, t: string, e: string): void => { out.push({ sample, kind, item, truth: t, engine: e }); };
  const engineTables = new Map(rb.tables.map((t) => [ident(t.name), t]));
  const truthTables = new Map(truth.tables.map((t) => [ident(t.name), t]));

  for (const t of truth.tables) {
    const e = engineTables.get(ident(t.name));
    if (!e) { push('table', t.name, 'table', '(none)'); continue; }
    const schema = truth.schemas && truth.schemas.length === 1 && !t.schema ? truth.schemas[0] : t.schema;
    if (schema !== undefined && ident(schema) !== ident(e.schema)) push('schema', t.name, schema ?? '(none)', e.schema ?? '(none)');
    if (ws(t.description) !== ws(e.comment)) push('description', t.name, ws(t.description) || '(none)', ws(e.comment) || '(none)');
    const truthPk = setOf(t.pk);
    const enginePk = setOf(e.pk ?? []);
    if (truthPk !== enginePk) push('primary-key', t.name, keyText(t.pk) || '(none)', keyText(e.pk ?? []) || '(none)');
    const ecols = new Map(e.columns.map((c) => [ident(c.name), c]));
    for (const c of t.columns) {
      const ec = ecols.get(ident(c[0]));
      const at = `${t.name}.${c[0]}`;
      if (!ec) { push('column', at, 'column', '(none)'); continue; }
      const engineType = ec.srid !== undefined && ec.srid !== null ? `${ec.type} srid ${ec.srid}` : ec.type;
      const computed = !!ec.computed || dialect === 'sqlserver' && ec.type === '(computed)';
      if (!computed && canonType(dialect, c[1]) !== canonType(dialect, engineType)) push('type', at, c[1], engineType);
      if (computed && canonType(dialect, c[1]) !== '(computed)') push('type', at, c[1], '(computed)');
      if (c[2].includes('N') !== ec.notNull) push('not-null', at, c[2].includes('N') ? 'NOT NULL' : 'nullable', ec.notNull ? 'NOT NULL' : 'nullable');
      if (ws(c[3]) !== ws(ec.comment)) push('description', at, ws(c[3]) || '(none)', ws(ec.comment) || '(none)');
    }
    for (const ec of e.columns) if (!t.columns.some((c) => ident(c[0]) === ident(ec.name))) push('column', `${t.name}.${ec.name}`, '(none)', `column ${ec.type}`);
  }
  for (const e of rb.tables) if (!truthTables.has(ident(e.name))) push('table', e.schema ? `${e.schema}.${e.name}` : e.name, '(none)', `table, ${e.columns.length} columns`);

  // Unique keys: expected.json's uniqueKeys plus the U flag on a column; the engine's unique constraints and indexes on tables.
  const truthUnique = new Map<string, string>();
  for (const u of truth.uniqueKeys) truthUnique.set(`${ident(u.table)}(${keySet(u.columns)})`, `${u.table} (${keyText(u.columns)})`);
  for (const t of truth.tables) for (const c of t.columns) if (c[2].includes('U')) truthUnique.set(`${ident(t.name)}(${keySet([c[0]])})`, `${t.name} (${ident(c[0])})`);
  const engineUnique = new Map<string, EngineKey>();
  for (const u of rb.uniqueKeys) {
    if (u.on && u.on !== 'USER_TABLE') continue; // an index on a view is not a table key
    engineUnique.set(`${ident(u.table)}(${keySet(u.columns)})`, u);
  }
  for (const [k, label] of truthUnique) if (!engineUnique.has(k)) push('unique-key', label, 'unique', '(none)');
  for (const [k, u] of engineUnique) {
    if (truthUnique.has(k)) continue;
    // A unique key on exactly the primary key adds nothing.
    const t = engineTables.get(ident(u.table));
    if (t && setOf(t.pk ?? []) === setOf(u.columns)) continue;
    push('unique-key', `${u.table} (${keyText(u.columns)})`, '(none)', `${u.partial ? 'partial ' : ''}unique ${u.kind ?? ''} ${u.name ?? ''}`.replace(/\s+/g, ' ').trim());
  }

  // Foreign keys: one per constraint, as column lists.
  const truthFks = new Map<string, string>();
  const groups = new Map<string, typeof truth.relationships>();
  for (const r of truth.relationships) {
    const k = r.composite ? `${ident(r.from)}:${r.composite}` : `${ident(r.from)}.${ident(r.fromColumn)}>${ident(r.to)}.${ident(r.toColumn)}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const fkKey = (from: string, cols: readonly string[], to: string, refCols: readonly string[]): string =>
    `${ident(from)}(${cols.map(ident).join(',')})>${ident(to)}(${refCols.map(ident).join(',')})`;
  for (const rs of groups.values()) {
    truthFks.set(fkKey(rs[0].from, rs.map((r) => r.fromColumn), rs[0].to, rs.map((r) => r.toColumn)),
      `${rs[0].from} (${rs.map((r) => r.fromColumn).join(', ')}) → ${rs[0].to} (${rs.map((r) => r.toColumn).join(', ')})`);
  }
  const engineFks = new Map<string, EngineForeignKey>();
  for (const fk of rb.foreignKeys) engineFks.set(fkKey(fk.table, fk.columns, fk.refTable, fk.refColumns), fk);
  for (const [k, label] of truthFks) if (!engineFks.has(k)) push('foreign-key', label, 'foreign key', '(none)');
  for (const [k, fk] of engineFks) {
    if (truthFks.has(k)) continue;
    push('foreign-key', `${fk.table} (${fk.columns.join(', ')}) → ${fk.refTable} (${fk.refColumns.join(', ')})`, '(none)', `foreign key ${fk.name ?? ''}`.trim());
  }
  return out.sort((a, b) => diffKey(a).localeCompare(diffKey(b)));
}

export interface DocumentedDifference extends EngineDiff {
  /** What ERD Studio's import gives for the item. */
  importer: string;
  resolution: 'engine-limit';
  reason: string;
}

/** A difference fixed in the truth or the importer: none of its items may differ again. */
export interface ResolvedDifference {
  sample: string;
  kind: DiffKind;
  items: string[];
  oldTruth: string;
  engine: string;
  importerBefore: string;
  importer: string;
  resolution: string;
  reason: string;
}

/** Statements an engine refused, by sample and a pattern on `statement error`. */
export interface DocumentedLoadError {
  sample: string;
  match: string;
  count: number;
  reason: string;
}

export interface Documented {
  differences: DocumentedDifference[];
  resolved: ResolvedDifference[];
  equivalences: Array<Record<string, string>>;
  modellingChoices: Array<Record<string, string>>;
  loadErrors: DocumentedLoadError[];
}

export function loadDocumented(): Documented {
  return JSON.parse(fs.readFileSync(path.join(TRUTH_DIR, 'differences.json'), 'utf-8')) as Documented;
}

/** The text a load error is matched on: the statement's first words, then the engine's message. */
export const loadErrorText = (e: Record<string, unknown>): string => `${String(e.statement ?? '')} ${String(e.error ?? '')}`.trim();

export function allEngineDiffs(truthSamples: Record<string, TruthSample>): EngineDiff[] {
  const out: EngineDiff[] = [];
  for (const p of ENGINE_PAIRS) {
    const rb = loadReadback(p.engine);
    const truth = truthSamples[p.truth];
    if (!rb || !truth) continue;
    out.push(...compareWithEngine(p.truth, truth, p.foldPartitions ? foldPartitions(rb) : rb, p.dialect));
  }
  return out;
}
