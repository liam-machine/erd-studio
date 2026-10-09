/**
 * The real parsers the export tests hold every output to (devDependencies
 * only, exact versions — core's runtime dependencies stay `yaml`):
 *
 * - DBML: `@dbml/parse` (current — what dbdiagram.io runs) **and** the old
 *   PEG parser most DBML tools still embed, `@dbml/core` 3.13.4, 2.6.1 and
 *   2.4.2 (aliased as `dbml-core-v3` / `dbml-core-v2` / `dbml-core-v24`).
 *   2.4.2 (June 2022) is the floor the export promises: 2.3 and older reject
 *   a schema-qualified table name, which nearly every model has, and 2.4.0
 *   and 2.4.1 a many-to-many `<>` Ref. `parseDbml` reads with the current
 *   one; `readDbmlEverywhere` reads with all four into one shape, so a test
 *   can assert that every parser reads the same thing. They are imported
 *   statically, so they load while vitest collects the file, outside any
 *   test's timeout; the first read then costs only ~15 ms.
 * - Mermaid: `mermaid-current` (the current release) reads the diagram;
 *   `mermaid` is pinned to 10.0.0, the oldest 10.x, and must accept it too
 *   (`parseMermaidOldest`). Mermaid needs a DOM, so a test file that calls
 *   either runs under `// @vitest-environment jsdom`, and loads both first
 *   with `beforeAll(loadMermaidParsers, MERMAID_LOAD_TIMEOUT_MS)` — see
 *   {@link loadMermaidParsers}. Mermaid 12.0.0 declares
 *   `engines.node >= 22.12`, but CI runs these tests on Node 20, where it
 *   parses correctly (npm only warns, EBADENGINE). If a later
 *   `mermaid-current` bump really needs Node 22, move CI's test jobs to 22
 *   rather than chasing the failure here.
 *
 * Their `npm audit` advisories (mermaid's DOMPurify, lodash-es, chevrotain…)
 * are accepted: test-only parsers, never bundled into anything that ships
 * (`npm audit --omit=dev`, the CI gate, is unaffected), and 10.0.0 is pinned
 * on purpose as the strictest 10.x grammar.
 *
 * Shared helpers, not a test file.
 */

import { Compiler, DEFAULT_ENTRY, MemoryProjectLayout } from '@dbml/parse';
import { Parser as ParserV2 } from 'dbml-core-v2';
import { Parser as ParserV24 } from 'dbml-core-v24';
import { Parser as ParserV3 } from 'dbml-core-v3';
import type { DisplayColumn, DisplayDomain, DisplayModel, DisplayRelationship } from '../src/types/display';

/** The parser versions the tests run, for messages and docs. */
export const DBML_PARSERS = ['@dbml/parse 10.2.0', '@dbml/core 3.13.4', '@dbml/core 2.6.1', '@dbml/core 2.4.2'] as const;
export const MERMAID_PARSERS = ['mermaid 10.0.0', 'mermaid 12.0.0'] as const;

// ---------------------------------------------------------------------------
// DBML
// ---------------------------------------------------------------------------

export interface DbmlResult {
  errors: string[];
  // The parser's own Database shape; tests read it loosely.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any;
}

/** Parse with the current `@dbml/parse`. */
export function parseDbml(text: string): DbmlResult {
  const layout = new MemoryProjectLayout();
  layout.setSource(DEFAULT_ENTRY, text);
  const compiler = new Compiler(layout);
  const errors = compiler.parse.errors(DEFAULT_ENTRY).map((e) => {
    const pos = (e.nodeOrToken as { startPos?: { line: number } }).startPos;
    return `${pos ? pos.line + 1 : '?'}: ${e.diagnostic}`;
  });
  return { errors, db: compiler.parse.rawDb(DEFAULT_ENTRY) };
}

/** What a DBML file means, in one shape whichever parser read it. */
export interface DbmlReading {
  project: { name: string | null; note: string | null } | null;
  tables: Array<{
    schema: string;
    name: string;
    note: string | null;
    fields: Array<{ name: string; type: string; pk: boolean; note: string | null }>;
    indexes: Array<{ pk: boolean; columns: string[] }>;
  }>;
  refs: Array<{ name: string | null; ends: Array<[string, string, string[], string]> }>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const noteOf = (note: Loose): string | null => {
  const value = note && typeof note === 'object' ? note.value : note;
  return typeof value === 'string' && value !== '' ? value : null;
};
const schemaOf = (name: Loose): string => (typeof name === 'string' && name !== '' ? name : 'public');
const endsOf = (endpoints: Loose[]): Array<[string, string, string[], string]> =>
  endpoints.map((e) => [schemaOf(e.schemaName), e.tableName, [...e.fieldNames], e.relation]);
const fieldOf = (f: Loose) => ({ name: f.name, type: f.type.type_name, pk: f.pk === true, note: noteOf(f.note) });
const indexOf = (i: Loose) => ({ pk: i.pk === true, columns: i.columns.map((c: Loose) => c.value) });

function readCurrent(text: string): DbmlReading {
  const { errors, db } = parseDbml(text);
  if (errors.length > 0) throw new Error(`@dbml/parse: ${errors.join('; ')}`);
  const hasProject = db.project && (db.project.name != null || db.project.note != null);
  return {
    project: hasProject ? { name: db.project.name ?? null, note: noteOf(db.project.note) } : null,
    tables: db.tables.map((t: Loose) => ({
      schema: schemaOf(t.schemaName),
      name: t.name,
      note: noteOf(t.note),
      fields: t.fields.map(fieldOf),
      indexes: (t.indexes ?? []).map(indexOf),
    })),
    refs: db.refs.map((r: Loose) => ({ name: r.name ?? null, ends: endsOf(r.endpoints) })),
  };
}

function readOld(parser: { parse: (text: string, format: 'dbml') => Loose }, label: string, text: string): DbmlReading {
  let db: Loose;
  try {
    db = parser.parse(text, 'dbml');
  } catch (err) {
    const e = err as Loose;
    const diags = Array.isArray(e?.diags) ? e.diags.map((d: Loose) => `${d.location?.start?.line ?? '?'}: ${d.message}`).join('; ') : String(e?.message ?? e);
    throw new Error(`${label}: ${diags}`);
  }
  const hasProject = db.name != null || noteOf(db.note) !== null;
  return {
    project: hasProject ? { name: db.name ?? null, note: noteOf(db.note) } : null,
    tables: db.schemas.flatMap((s: Loose) =>
      s.tables.map((t: Loose) => ({
        schema: schemaOf(s.name),
        name: t.name,
        note: noteOf(t.note),
        fields: t.fields.map(fieldOf),
        indexes: (t.indexes ?? []).map(indexOf),
      })),
    ),
    refs: db.schemas.flatMap((s: Loose) => s.refs.map((r: Loose) => ({ name: r.name ?? null, ends: endsOf(r.endpoints) }))),
  };
}

/**
 * `text` read by the current parser and by the three old ones. Throws, naming the
 * parser, when any of them refuses it, and when the old ones read it
 * differently from the current one; returns the shared reading.
 */
export function readDbmlEverywhere(text: string): DbmlReading {
  const current = readCurrent(text);
  // Old parsers list tables and Refs schema by schema, so compare in a fixed order.
  const sorted = <T>(items: T[]): T[] => items.map((i) => JSON.stringify(i)).sort().map((i) => JSON.parse(i) as T);
  const order = (r: DbmlReading): string => JSON.stringify({ ...r, tables: sorted(r.tables), refs: sorted(r.refs) });
  for (const [label, parser] of [
    ['@dbml/core 3.13.4', ParserV3],
    ['@dbml/core 2.6.1', ParserV2],
    ['@dbml/core 2.4.2', ParserV24],
  ] as const) {
    const old = readOld(parser as Loose, label, text);
    if (order(old) !== order(current)) {
      throw new Error(`${label} reads this DBML differently from @dbml/parse:\n${order(old)}\n${order(current)}`);
    }
  }
  return current;
}

// ---------------------------------------------------------------------------
// Mermaid
// ---------------------------------------------------------------------------

export interface MermaidAttribute {
  type: string;
  name: string;
  keys: string[];
  comment: string;
}

export interface MermaidResult {
  entities: Array<{ name: string; attributes: MermaidAttribute[] }>;
  relationships: Array<{ from: string; to: string; label: string; cardA: string; cardB: string }>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MermaidApi = any;

let mermaidParsers: Promise<{ oldest: MermaidApi; current: MermaidApi }> | undefined;

/**
 * Load both Mermaid releases once per test file and warm them up. A cold load
 * takes about 1–1.5 s on an idle machine (importing each release ~0.3–0.6 s,
 * plus 10.0.0's first parse ~0.3–0.6 s, which is when it lazily loads its ER
 * grammar) and 9–18 s during a full `npm test`, which is longer than vitest's
 * 5 s test timeout (#152). So every file that parses Mermaid calls this in a
 * `beforeAll` with a timeout of its own ({@link MERMAID_LOAD_TIMEOUT_MS}), and
 * no single test pays for the load. Memoised: later calls, including the
 * ones inside {@link parseMermaid}, cost nothing. A load that fails is
 * forgotten, so the next call tries again.
 */
export function loadMermaidParsers(): Promise<{ oldest: MermaidApi; current: MermaidApi }> {
  mermaidParsers ??= (async () => {
    const [{ default: oldest }, { default: current }] = await Promise.all([import('mermaid'), import('mermaid-current')]);
    const warmUp = 'erDiagram\n  "a" {\n    int id\n  }\n';
    await oldest.parse(warmUp);
    await current.parse(warmUp);
    return { oldest, current };
  })().catch((err: unknown) => {
    mermaidParsers = undefined;
    throw err;
  });
  return mermaidParsers;
}

/** The `beforeAll` timeout for {@link loadMermaidParsers}: generous, because it only bounds a load that is stuck. */
export const MERMAID_LOAD_TIMEOUT_MS = 60_000;

/** Parse with Mermaid 10.0.0, the oldest 10.x; throws Mermaid's own error when it refuses the text. */
export async function parseMermaidOldest(text: string): Promise<void> {
  const { oldest } = await loadMermaidParsers();
  await oldest.parse(text);
}

/**
 * Parse with the current Mermaid and read its model; throws Mermaid's own
 * error when it refuses the text. Every caller's text must also pass
 * {@link parseMermaidOldest}, which this runs first.
 */
export async function parseMermaid(text: string): Promise<MermaidResult> {
  await parseMermaidOldest(text);
  const { current: mermaid } = await loadMermaidParsers();
  await mermaid.parse(text);
  const diagram = await mermaid.mermaidAPI.getDiagramFromText(text);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = diagram.db as any;
  const raw = db.getEntities();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const entries: Array<[string, any]> = raw instanceof Map ? [...raw.entries()] : Object.entries(raw);
  const nameOfId = new Map<string, string>();
  for (const [name, e] of entries) nameOfId.set(e.id ?? name, name);
  return {
    entities: entries.map(([name, e]) => ({
      name,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      attributes: (e.attributes ?? []).map((a: any) => ({
        type: a.type ?? a.attributeType,
        name: a.name ?? a.attributeName,
        keys: a.keys ?? a.attributeKeyTypeList ?? [],
        comment: a.comment ?? a.attributeComment ?? '',
      })),
    })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    relationships: db.getRelationships().map((r: any) => ({
      from: nameOfId.get(r.entityA) ?? r.entityA,
      to: nameOfId.get(r.entityB) ?? r.entityB,
      label: r.roleA,
      cardA: r.relSpec.cardA,
      cardB: r.relSpec.cardB,
    })),
  };
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export function col(name: string, dataType = 'int', extra: Partial<DisplayColumn> = {}): DisplayColumn {
  return { name, dataType, description: '', isPrimaryKey: false, isForeignKey: false, isNaturalKey: false, ...extra };
}

export function model(name: string, columns: DisplayColumn[], extra: Partial<DisplayModel> = {}): DisplayModel {
  return { name, schema: '', description: '', columns, ...extra };
}

export function rel(
  from: string,
  to: string,
  cardinality: DisplayRelationship['cardinality'] = 'many-to-one',
  extra: Partial<DisplayRelationship> = {},
): DisplayRelationship {
  const [fromModel, fromColumn] = from.split('.');
  const [toModel, toColumn] = to.split('.');
  return { fromModel, fromColumn, toModel, toColumn, cardinality, ...extra };
}

export function domain(models: DisplayModel[], relationships: DisplayRelationship[] = [], extra: Partial<DisplayDomain> = {}): DisplayDomain {
  return {
    schemaVersion: 5,
    domain: 'test',
    layer: 'silver',
    stage: 'logical',
    description: '',
    models,
    relationships,
    viewConfig: {},
    readOnly: false,
    positionDraggable: true,
    ...extra,
  };
}

/** Freeze `value` and everything in it, so a test fails if an exporter mutates its input. */
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}
