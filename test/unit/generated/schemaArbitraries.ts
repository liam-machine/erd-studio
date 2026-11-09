/**
 * Generated tests (fast-check): one format-neutral schema arbitrary, and the
 * run settings every generated test shares.
 *
 * A {@link GSchema} is what a source holds — tables, columns, primary keys
 * (single or composite), foreign keys to a table's whole key, comments — with
 * names drawn from the shapes real files use: plain, reserved words, accented
 * and CJK letters, spaces, mixed case, an embedded quote, huge ones. Each
 * importer's writer (`sqlWriter.ts`, `semanticModelWriter.ts`,
 * `dbmlWriter.ts`) writes it in its own format, so the truth is known
 * without a second parser; `breaks.ts` then damages the text in the ways real
 * files are damaged.
 *
 * Runs are seeded and few per PR (`FC_RUNS` for more, `FC_SEED` for another
 * seed): see docs/dev/generated-tests.md.
 */
import * as fc from 'fast-check';

// ---------------------------------------------------------------------------
// Run settings
// ---------------------------------------------------------------------------

/** The seed every property uses unless `FC_SEED` names another (`random`: a new one each run, printed on failure). */
export const SEED = ((): number | undefined => {
  const raw = process.env.FC_SEED;
  if (raw === 'random') return undefined;
  const n = Number(raw);
  return raw && Number.isFinite(n) ? n : 20261109;
})();

/**
 * How many inputs a property tries: `perPr` on a normal run, `FC_RUNS` when
 * set (the big run: `FC_RUNS=2000 npx vitest run test/unit/generated`). A
 * property that is slow per input scales it down with `weight` (0.1: a tenth).
 */
export function runs(perPr: number, weight = 1): number {
  const big = Number(process.env.FC_RUNS);
  return Number.isFinite(big) && big > 0 ? Math.max(1, Math.round(big * weight)) : perPr;
}

/** True on the big run: tests then allow more time. */
export const BIG_RUN = Number(process.env.FC_RUNS) > 0;

/** fast-check parameters: seeded, `numRuns` as given, no time-based shrinking cut-off. */
export function params(numRuns: number): fc.Parameters<unknown> {
  return { numRuns, ...(SEED !== undefined ? { seed: SEED } : {}), endOnFailure: false };
}

/** A per-test timeout that grows with the big run. */
export function timeout(perPrMs: number): number {
  return BIG_RUN ? Math.max(perPrMs * 50, 600_000) : perPrMs;
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

export type NameKind = 'plain' | 'reserved' | 'unicode' | 'spaced' | 'mixedCase' | 'huge' | 'embeddedQuote';

/** Words some dialect reserves (or a format treats as a keyword): real tables and columns are called these. */
export const RESERVED_WORDS = [
  'order', 'user', 'group', 'select', 'table', 'key', 'date', 'value', 'from', 'check', 'default', 'index',
  'primary', 'references', 'column', 'end', 'limit', 'window', 'role', 'type', 'comment', 'file', 'location',
  'partition', 'range', 'rows', 'time', 'year', 'level', 'name', 'status', 'position', 'note', 'ref', 'enum',
  'project', 'indexes', 'as', 'not', 'null', 'unique', 'constraint', 'foreign', 'create', 'measure', 'relationship',
] as const;

const RESERVED = new Set<string>(RESERVED_WORDS);

/** Other common keywords a plain name must not be (so a plain name never needs quotes in any format). */
const KEYWORDS = new Set([
  ...RESERVED_WORDS, 'all', 'and', 'or', 'in', 'is', 'on', 'to', 'by', 'do', 'if', 'of', 'at', 'go', 'add', 'asc', 'desc',
  'set', 'use', 'for', 'int', 'bit', 'any', 'top', 'into', 'drop', 'into', 'with', 'like', 'case', 'when', 'then', 'else',
  'true', 'false', 'view', 'join', 'left', 'right', 'full', 'cross', 'inner', 'outer', 'union', 'where', 'having', 'grant',
  'alter', 'begin', 'commit', 'delete', 'insert', 'update', 'values', 'between', 'exists', 'distinct', 'current', 'collate',
  'pk', 'increment', 'model', 'expression', 'annotation', 'partition', 'hierarchy', 'perspective', 'culture', 'database',
  'schema', 'temporary', 'temp', 'local', 'global', 'cascade', 'restrict', 'action', 'match', 'zone', 'array', 'map', 'struct',
  'interval', 'cluster', 'clustered', 'identity', 'auto_increment', 'unsigned', 'serial', 'over', 'row', 'only', 'some',
]);

const SPACED_WORDS = ['order line', 'Customer Name', 'Unit Price', 'Ship Date', 'net amount', 'Sales Territory', 'line no'];
const UNICODE_NAMES = ['café', 'Straße', 'naïve_ñ', 'Kunde_Größe', 'zoë', 'ÉTÉ', '顧客', '注文明細', 'клиент', 'αριθμός', 'Ångström'];

export interface GName {
  text: string;
  kind: NameKind;
}

const plainName = fc.stringMatching(/^[a-z][a-z0-9]{1,9}(_[a-z0-9]{1,6})?$/).filter((s) => !KEYWORDS.has(s) && !/^fk\d/.test(s));

/** A huge identifier: 100 to 300 plain characters (generated code, an ORM's long names). */
const hugeName = fc.tuple(plainName, fc.integer({ min: 100, max: 300 })).map(([seed, len]) => {
  let out = seed;
  while (out.length < len) out += `_${seed}`;
  return out.slice(0, len).replace(/_+$/, 'x');
});

export interface NameOptions {
  /** Kinds besides plain, with their weights (plain is always weight 70). Default: all but embeddedQuote. */
  kinds?: Partial<Record<Exclude<NameKind, 'plain'>, number>>;
}

const DEFAULT_KINDS: Record<Exclude<NameKind, 'plain'>, number> = { reserved: 6, unicode: 5, spaced: 5, mixedCase: 5, huge: 2, embeddedQuote: 2 };

/** One name of a kind drawn by the weights. */
export function nameArb(options: NameOptions = {}): fc.Arbitrary<GName> {
  const kinds = { ...DEFAULT_KINDS, ...(options.kinds ?? {}) };
  const of = (kind: NameKind, arb: fc.Arbitrary<string>): fc.Arbitrary<GName> => arb.map((text) => ({ text, kind }));
  const pool: Array<{ arbitrary: fc.Arbitrary<GName>; weight: number }> = [{ arbitrary: of('plain', plainName), weight: 70 }];
  const add = (kind: Exclude<NameKind, 'plain'>, arb: fc.Arbitrary<string>): void => {
    if (kinds[kind] > 0) pool.push({ arbitrary: of(kind, arb), weight: kinds[kind] });
  };
  add('reserved', fc.constantFrom(...RESERVED_WORDS));
  add('unicode', fc.constantFrom(...UNICODE_NAMES));
  add('spaced', fc.constantFrom(...SPACED_WORDS));
  add('mixedCase', plainName.map((s) => s.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join('')));
  add('huge', hugeName);
  add('embeddedQuote', plainName.map((s) => `${s}"s'x`));
  return fc.oneof(...pool);
}

/** Two names clash when an importer could read them as one: case, accents and punctuation aside. */
export function nameKey(name: string): string {
  return name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Whether `name` reads unquoted in every format the tests write. */
export const isPlain = (name: string): boolean => /^[a-z][a-z0-9_]*$/.test(name) && !KEYWORDS.has(name) && !RESERVED.has(name);

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export type GType = 'int' | 'bigint' | 'text' | 'varchar' | 'decimal' | 'timestamp' | 'date' | 'boolean';
export const G_TYPES: readonly GType[] = ['int', 'bigint', 'text', 'varchar', 'decimal', 'timestamp', 'date', 'boolean'];

export interface GColumn {
  name: string;
  kind: NameKind;
  type: GType;
  notNull: boolean;
  /** A single-column unique key on the column (never on a key column). */
  unique?: boolean;
  comment?: string;
}

export interface GForeignKey {
  /** The columns in this table, in the order of the target's key. */
  columns: string[];
  table: string;
  references: string[];
  /** One-to-one: the foreign key columns are unique (a column's own `unique`, or a unique key over a composite's). */
  oneToOne?: boolean;
}

export interface GTable {
  name: string;
  kind: NameKind;
  columns: GColumn[];
  /** Primary key columns ([] for none; 2 for a composite). */
  pk: string[];
  fks: GForeignKey[];
  comment?: string;
}

export interface GSchema {
  tables: GTable[];
}

export interface SchemaOptions extends NameOptions {
  minTables?: number;
  maxTables?: number;
  maxColumns?: number;
  /** Composite (2-column) primary keys and the foreign keys to them. Default true. */
  composite?: boolean;
  /** Table and column comments. Default true. */
  comments?: boolean;
  /** Foreign keys from a table to itself. Default true. */
  selfReferences?: boolean;
  /** Unique columns and one-to-one foreign keys. Default true. */
  uniques?: boolean;
}

const COMMENTS = ['People who buy.', "Customer's login", 'Montant TTC (€)', '顧客の名前', 'Net of tax; see the "rates" table', 'Line 1 of 2'];

interface RawTable { name: GName; columns: Array<{ name: GName; type: GType; notNull: boolean; unique: boolean; comment?: string }>; pkSize: 0 | 1 | 2; comment?: string; fkTargets: Array<{ pick: number; oneToOne: boolean }> }

/**
 * A schema: 1–`maxTables` tables (names distinct by {@link nameKey}), each
 * with 1–`maxColumns` columns (distinct the same way), a key of 0–2 columns,
 * and foreign keys (each to a whole key, a composite one with two columns).
 * Foreign key columns are added to the table as plain `fk<n>_<i>` columns.
 */
export function schemaArb(options: SchemaOptions = {}): fc.Arbitrary<GSchema> {
  const maxTables = options.maxTables ?? 5;
  const maxColumns = options.maxColumns ?? 5;
  const names = nameArb(options);
  const column = fc.record({
    name: names,
    type: fc.constantFrom(...G_TYPES),
    notNull: fc.boolean(),
    unique: options.uniques === false ? fc.constant(false) : fc.constantFrom(false, false, false, false, false, true),
    comment: options.comments === false ? fc.constant(undefined) : fc.option(fc.constantFrom(...COMMENTS), { freq: 4, nil: undefined }),
  });
  const table = fc.record({
    name: names,
    columns: fc.uniqueArray(column, { minLength: 1, maxLength: maxColumns, selector: (c) => nameKey(c.name.text) }),
    pkSize: (options.composite === false ? fc.constantFrom<0 | 1>(0, 1, 1, 1) : fc.constantFrom<0 | 1 | 2>(0, 1, 1, 1, 2)),
    comment: options.comments === false ? fc.constant(undefined) : fc.option(fc.constantFrom(...COMMENTS), { freq: 3, nil: undefined }),
    fkTargets: fc.array(fc.record({ pick: fc.nat({ max: 99 }), oneToOne: options.uniques === false ? fc.constant(false) : fc.constantFrom(false, false, false, true) }), { maxLength: 2 }),
  });
  return fc
    .uniqueArray(table, { minLength: options.minTables ?? 1, maxLength: maxTables, selector: (t) => nameKey(t.name.text) })
    .filter((ts) => ts.every((t) => nameKey(t.name.text) !== ''))
    .filter((ts) => ts.every((t) => t.columns.every((c) => nameKey(c.name.text) !== '')))
    .map((raw) => buildSchema(raw as RawTable[], options));
}

function buildSchema(raw: readonly RawTable[], options: SchemaOptions): GSchema {
  const tables: GTable[] = raw.map((t) => {
    const columns: GColumn[] = t.columns.map((c) => ({ name: c.name.text, kind: c.name.kind, type: c.type, notNull: c.notNull, ...(c.unique ? { unique: true } : {}), ...(c.comment ? { comment: c.comment } : {}) }));
    const pk = columns.slice(0, Math.min(t.pkSize, columns.length)).map((c) => c.name);
    for (const c of columns) if (pk.includes(c.name)) { c.notNull = true; delete c.unique; }
    return { name: t.name.text, kind: t.name.kind, columns, pk, fks: [], ...(t.comment ? { comment: t.comment } : {}) };
  });
  const keyed = tables.filter((t) => t.pk.length > 0);
  raw.forEach((r, i) => {
    const from = tables[i];
    const seen = new Set<string>();
    r.fkTargets.forEach(({ pick, oneToOne }, n) => {
      if (keyed.length === 0) return;
      const to = keyed[pick % keyed.length];
      if (to === from && options.selfReferences === false) return;
      if (seen.has(to.name)) return;
      seen.add(to.name);
      const cols = to.pk.map((_k, k) => `fk${n}_${k}`);
      for (const [k, c] of cols.entries()) {
        const target = to.columns.find((x) => x.name === to.pk[k])!;
        from.columns.push({ name: c, kind: 'plain', type: target.type, notNull: n === 0, ...(oneToOne && cols.length === 1 ? { unique: true } : {}) });
      }
      from.fks.push({ columns: cols, table: to.name, references: [...to.pk], ...(oneToOne ? { oneToOne: true } : {}) });
    });
  });
  return { tables };
}

/** What a schema holds, counted. */
export function schemaTruth(schema: GSchema): { tables: number; columns: number; primaryKeys: number; relationships: number } {
  return {
    tables: schema.tables.length,
    columns: schema.tables.reduce((n, t) => n + t.columns.length, 0),
    primaryKeys: schema.tables.filter((t) => t.pk.length > 0).length,
    relationships: schema.tables.reduce((n, t) => n + t.fks.length, 0),
  };
}

/** Whether every table and column name in the schema is plain (so imported names compare exactly). */
export const allPlain = (schema: GSchema): boolean => schema.tables.every((t) => t.kind === 'plain' && t.columns.every((c) => c.kind === 'plain'));

/** The schema's tables `copies` times over (names suffixed `_c<n>`), foreign keys within each copy: a big input of the same shape. */
export function copies(schema: GSchema, count: number): GSchema {
  if (count <= 1) return schema;
  const tables: GTable[] = [];
  for (let n = 1; n <= count; n++) {
    const suffix = n === 1 ? '' : `_c${n}`;
    for (const t of schema.tables) tables.push({ ...t, name: `${t.name}${suffix}`, fks: t.fks.map((fk) => ({ ...fk, table: `${fk.table}${suffix}` })) });
  }
  return { tables };
}
