/**
 * The writers' laws (§4.5 of the native DBML storage spec), over every
 * table, relationships file and diagram in the DBML fixtures and over a
 * seeded generator of random tables, relationship lists and diagrams with
 * random edits:
 *
 * 1. no-op: `edit(t, read(t)) === t` for every writable `t`;
 * 2. idempotent: `edit(edit(t, x), x) === edit(t, x)`;
 * 3. round trip: what the output reads as equals `x`, through
 *    `normaliseForStorageEquivalence` (D24) on top of the reader's own
 *    normalisations;
 * 4. preservation: every comment (whole-line, trailing and block comments) and
 *    every construct ERD Studio does not model survives, apart from those
 *    inside the cut span of a node the edit removes;
 * 5. parses: when the input compiled clean (or is a new file), the output
 *    compiles clean with its `use` targets in 9.1.1, 10.3.1 and 11.0.0.
 *
 * The generator is a small mulberry32 PRNG (no dependency). Set
 * `DBML_LAW_SEED` to run another seed; the seed is printed on failure.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

import { parseTableDbml } from '../../src/dbml/readTable';
import { parseSubjectAreaDbml } from '../../src/dbml/readDiagram';
import { editTableDbml, renderNewTableDbml } from '../../src/dbml/writeTable';
import { editRelationshipsDbml } from '../../src/dbml/writeRelationships';
import { editSubjectAreaDbml, renderNewSubjectAreaDbml } from '../../src/dbml/writeDiagram';
import { normaliseForStorageEquivalence } from '../../src/storageEquivalence';
import { dbmlName, dbmlNoteText } from '../../src/dbmlText';
import { readMeta } from '../../src/meta';
import { relationshipsFilePathOf } from '../../src/storage';
import { readRelationshipsDbml } from '../../src/dbml/readRelationships';
import { compileOne, elementType, isUseDeclaration, plainNames, topLevel, type AstNode } from '../../src/dbml/parser';
import { cutSpan } from '../../src/dbml/splice';
import { DbmlEditRefused } from '../../src/dbml/errors';
import { DBML_RICH_PLACEHOLDER_COLUMN } from '../../src/dbmlRichProperties';
import { parseTableText } from '../../src/logicalModel';
import type { Annotation, AnnotationColor, ColumnDef, SemanticTable, TableRelationship } from '../../src/types/semantic';
import {
  DIAGNOSTIC_PARSERS,
  clone,
  comparableRelationships,
  diagramResolver,
  libraryOf,
  mulberry32,
  ownersOf,
  ownersOfFile,
  projectDiagnostics,
  relationshipsFilesOf,
  relationshipsResolver,
  stemOf,
  tableFilesOf,
} from '../dbmlWriterSupport';

const SEED = Number(process.env.DBML_LAW_SEED ?? '1');
const ALL = DIAGNOSTIC_PARSERS.map(([v]) => v);

// ---------------------------------------------------------------------------
// What a file means, normalised
// ---------------------------------------------------------------------------

const present = (v: string | undefined): string | undefined => (v === undefined || v === '' ? undefined : v);

/** A table as the reader reads it back: empty values dropped, notes trimmed, meta normalised; then the D24 comparator. */
function normTable(t: SemanticTable): unknown {
  const out: Record<string, unknown> = { name: t.name };
  if (present(t.schema)) out.schema = t.schema;
  if (present(t.alias?.trim())) out.alias = t.alias!.trim();
  if (present(dbmlNoteText(t.description ?? ''))) out.description = dbmlNoteText(t.description!);
  if (present(t.grain)) out.grain = t.grain;
  if (present(t.modelRole)) out.modelRole = t.modelRole;
  const rationale = Object.fromEntries(Object.entries(t.rationale ?? {}).filter(([, v]) => present(v as string)));
  if (Object.keys(rationale).length > 0) out.rationale = rationale;
  const meta = readMeta(t.meta);
  if (meta) out.meta = meta;
  out.columns = (t.columns ?? []).map((c: ColumnDef) => {
    const col: Record<string, unknown> = { name: c.name, dataType: c.dataType ?? '', description: dbmlNoteText(c.description ?? '') };
    if (c.isPrimaryKey) col.isPrimaryKey = true;
    if (c.isForeignKey) col.isForeignKey = true;
    if (c.isNaturalKey) col.isNaturalKey = true;
    if (c.scdType === 0 || c.scdType === 1 || c.scdType === 2) col.scdType = c.scdType;
    if (c.additiveType) col.additiveType = c.additiveType;
    const m = readMeta(c.meta);
    if (m) col.meta = m;
    return col;
  });
  return normaliseForStorageEquivalence({ models: [out] });
}

function readOk(text: string, stem: string): SemanticTable {
  const r = parseTableDbml(text, stem);
  if (!r.ok) throw new Error(`does not read: ${r.error.message}\n${text}`);
  return r.table;
}

/** A diagram object as the diagram writer stores it (positions and sticky-note boxes are the layout file's). */
function normDiagram(obj: Record<string, any>): unknown { // eslint-disable-line @typescript-eslint/no-explicit-any
  const view = obj.viewConfig ?? {};
  return normaliseForStorageEquivalence({
    domain: obj.domain,
    layer: obj.layer,
    description: dbmlNoteText(obj.description ?? ''),
    ...(obj.modelFolder !== undefined ? { modelFolder: obj.modelFolder } : {}),
    ...(obj.stubColumns !== undefined ? { stubColumns: obj.stubColumns } : {}),
    models: (obj.logical?.models ?? []).map((m: string) => m.toLowerCase()),
    showFkEdges: view.showFkEdges,
    layoutOptions: view.layoutOptions,
    annotations: (view.annotations ?? []).map((a: Annotation) => ({ id: a.id, text: dbmlNoteText(a.text ?? ''), color: a.color ?? null, linkedModel: a.linkedModel ?? null })),
  });
}

// ---------------------------------------------------------------------------
// Law 4: comments and unknown constructs outside removed nodes survive
// ---------------------------------------------------------------------------

type Span = { start: number; end: number };

/** Every comment token of a DBML text (`// …` to the end of its line, `/* … *\/`), skipping strings. */
function commentTokens(text: string): Array<Span & { text: string }> {
  const out: Array<Span & { text: string }> = [];
  let i = 0;
  const skipQuoted = (quote: string): void => {
    i += quote.length;
    while (i < text.length && !text.startsWith(quote, i)) i += text[i] === '\\' ? 2 : 1;
    i += quote.length;
  };
  while (i < text.length) {
    if (text.startsWith("'''", i)) skipQuoted("'''");
    else if (text[i] === "'" || text[i] === '"' || text[i] === '`') skipQuoted(text[i]);
    else if (text.startsWith('//', i)) {
      let end = text.indexOf('\n', i);
      if (end < 0) end = text.length;
      out.push({ start: i, end, text: text.slice(i, end).replace(/\r$/, '').trimEnd() });
      i = end;
    } else if (text.startsWith('/*', i)) {
      const close = text.indexOf('*/', i + 2);
      const end = close < 0 ? text.length : close + 2;
      out.push({ start: i, end, text: text.slice(i, end) });
      i = end;
    } else i++;
  }
  return out;
}

const within = (spans: readonly Span[], at: number): boolean => spans.some((r) => at >= r.start && at < r.end);

/**
 * Law 4: every comment token of `before` that lies outside the `removed`
 * spans (the cut spans of the nodes the edit deletes) is still in `after`,
 * as often as it was; and so is every `kept` construct ERD Studio does not
 * model, wherever it lies outside them.
 */
function expectPreserved(before: string, after: string, removed: readonly Span[] = [], kept: readonly string[] = KEPT_CONSTRUCTS): void {
  const remaining = commentTokens(after).map((t) => t.text);
  for (const token of commentTokens(before)) {
    if (within(removed, token.start)) continue;
    const at = remaining.indexOf(token.text);
    expect(at, `comment lost: ${token.text}\n--- before:\n${before}\n--- after:\n${after}`).toBeGreaterThanOrEqual(0);
    remaining.splice(at, 1);
  }
  for (const construct of kept) {
    const at = before.indexOf(construct);
    if (at < 0 || within(removed, at)) continue;
    expect(after, `construct lost: ${construct}`).toContain(construct);
  }
}

/** The cut span of a Table body's column nodes, by name (lower-case). */
function columnSpans(text: string): Map<string, Span[]> {
  const out = new Map<string, Span[]>();
  const table = topLevel(compileOne(text).ast).find((n) => elementType(n)?.toLowerCase() === 'table');
  const body: AstNode[] = Array.isArray(table?.body?.body) ? table!.body.body : [];
  for (const node of body) {
    if (node?.kind !== '<function-application>') continue;
    const name = plainNames(node.callee)?.[0];
    if (name !== undefined) out.set(name.toLowerCase(), [...(out.get(name.toLowerCase()) ?? []), cutSpan(text, node)]);
  }
  return out;
}

/**
 * What a table edit removes: the columns not in `desired` (the one-for-one
 * swap at the same index is a rename, which keeps its line), their
 * `Metadata Column` blocks, and the placeholder line once columns exist.
 */
function tableRemovedSpans(text: string, current: SemanticTable, desired: SemanticTable): Span[] {
  const want = new Set((desired.columns ?? []).map((c) => c.name.toLowerCase()));
  const have = (current.columns ?? []).map((c) => c.name.toLowerCase());
  let gone = have.filter((n) => !want.has(n));
  const added = (desired.columns ?? []).map((c) => c.name.toLowerCase()).filter((n) => !have.includes(n));
  if (gone.length === 1 && added.length === 1 && have.indexOf(gone[0]) === (desired.columns ?? []).findIndex((c) => c.name.toLowerCase() === added[0])) gone = [];
  const spans = columnSpans(text);
  const out: Span[] = gone.flatMap((n) => spans.get(n) ?? []);
  if ((desired.columns ?? []).length > 0) out.push(...(spans.get(DBML_RICH_PLACEHOLDER_COLUMN) ?? []));
  for (const node of topLevel(compileOne(text).ast)) {
    if (elementType(node)?.toLowerCase() !== 'metadata') continue;
    const names = (plainNames(node.name) ?? []).map((n) => n.toLowerCase());
    if (String(node.targetKind?.value ?? '').toLowerCase() === 'column' && gone.includes(names[names.length - 1])) out.push(cutSpan(text, node));
  }
  return out;
}

/** The two column sets a Ref joins, either way round (lower-case). */
function refEndpoints(rels: readonly { fromModel: string; fromColumn: string; toModel: string; toColumn: string }[]): string {
  const end = (t: string, cols: string[]): string => `${t.toLowerCase()}.${cols.map((c) => c.toLowerCase()).sort().join(',')}`;
  return [end(rels[0].fromModel, rels.map((r) => r.fromColumn)), end(rels[0].toModel, rels.map((r) => r.toColumn))].sort().join('|');
}

/** What a relationships edit removes: the Refs whose link is gone, and the use lines whose path is gone. */
function relationshipsRemovedSpans(text: string, out: string): Span[] {
  const kept = new Set(readRelationshipsDbml(out).refs.map((r) => refEndpoints(r.relationships)));
  const nodes = new Map(topLevel(compileOne(text).ast).map((n) => [n.start as number, n]));
  const spans: Span[] = [];
  for (const ref of readRelationshipsDbml(text).refs) {
    const node = nodes.get(ref.start);
    if (node && !kept.has(refEndpoints(ref.relationships))) spans.push(cutSpan(text, node));
  }
  for (const node of topLevel(compileOne(text).ast)) {
    if (isUseDeclaration(node) && !out.includes(`'${String(node.importPath?.value ?? '')}'`)) spans.push(cutSpan(text, node));
  }
  return spans;
}

/** What a diagram edit removes: the use lines of members (and relationships files) it drops, and its Notes that are gone. */
function diagramRemovedSpans(text: string, out: string, after: Record<string, any>): Span[] { // eslint-disable-line @typescript-eslint/no-explicit-any
  const members = new Set((after.logical?.models ?? []).map((m: string) => m.toLowerCase()));
  const notes = new Set((after.viewConfig?.annotations ?? []).map((a: Annotation) => a.id));
  const spans: Span[] = [];
  for (const node of topLevel(compileOne(text).ast)) {
    if (isUseDeclaration(node)) {
      const path = String(node.importPath?.value ?? '');
      const stem = (path.split('/').pop() ?? '').replace(/\.dbml$/i, '').toLowerCase();
      if (stem === '_relationships' ? !out.includes(`'${path}'`) : !members.has(stem)) spans.push(cutSpan(text, node));
    } else if (elementType(node)?.toLowerCase() === 'note' && !notes.has(String(node.name?.expression?.literal?.value ?? node.name?.expression?.variable?.value ?? ''))) {
      spans.push(cutSpan(text, node));
    }
  }
  return spans;
}

/** Constructs ERD Studio does not model, in the law fixtures: an edit that does not remove their node keeps them. */
const KEPT_CONSTRUCTS: readonly string[] = [
  'Enum order_status {\n  new\n  shipped\n}',
  "[not null, default: 'new'",
  "(customer_key, status) [unique, name: 'cust_status']",
  "Metadata Column fct_order.status {\n  note: 'Set by a Metadata block'\n}",
  "database_type: 'Snowflake'",
  "use * from './nothing_here_but_harmless.dbml'",
  "[delete: cascade] // shipping",
  'scd_type: 2',
  'meta_count: 3',
  'headercolor: #3498db',
];

function cleanIn(files: Record<string, string>, entry: string): string[] {
  return ALL.filter((v) => projectDiagnostics(files, [entry], [v]).length === 0);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FIXTURE_ROOTS = [
  path.resolve(__dirname, '../fixtures/dbml'),
  path.resolve(__dirname, '../../../../test/fixtures/dbml-native'),
];

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}

/** Each fixture project: its `.dbml` files keyed relative to its `.erd-studio`. */
function fixtureProjects(): Array<{ name: string; files: Record<string, string> }> {
  const projects: Array<{ name: string; files: Record<string, string> }> = [];
  for (const root of FIXTURE_ROOTS) {
    const semanticDirs = walk(root).filter((f) => f.includes(`${path.sep}.erd-studio${path.sep}`))
      .map((f) => f.slice(0, f.indexOf(`${path.sep}.erd-studio${path.sep}`) + `${path.sep}.erd-studio`.length));
    for (const dir of [...new Set(semanticDirs)]) {
      const files: Record<string, string> = {};
      for (const f of walk(dir)) if (f.endsWith('.dbml')) files[path.relative(dir, f).split(path.sep).join('/')] = fs.readFileSync(f, 'utf8');
      projects.push({ name: path.relative(path.resolve(__dirname, '../../../..'), dir), files });
    }
  }
  return projects;
}

/**
 * Hand-written shapes the laws must hold for too (§4.5 Law 1): extra and
 * missing `use` lines, unsorted Refs, `indexes { id [pk] }`, `primary key`
 * flags, `erd_` names, a `meta_<key>` overriding a key in `meta_json`, a
 * qualified name with a DBML alias, Ref settings and marks, comments
 * everywhere, an Enum and a Metadata block.
 */
const HAND_WRITTEN_PROJECT: Record<string, string> = {
  'tables/gold/fct_order.dbml': `// Order lines, by hand.
Table fct_order [erd_role: 'transaction-fact', meta_owner: 'wins', meta_json: '{"owner":"loses","pii":false}'] {
  // the line id
  order_line_id bigint
  customer_key int [erd_foreign_key: 'true'] // FK
  status order_status [not null, default: 'new']
  ship_date_key int
  indexes {
    order_line_id [pk]
    (customer_key, status) [unique, name: 'cust_status']
  }
  Note: 'Order lines'
}

Enum order_status {
  new
  shipped
}

Metadata Column fct_order.status {
  note: 'Set by a Metadata block'
}
`,
  'tables/gold/dim_customer.dbml': `Table gold.dim_customer as DC {
  customer_key int [primary key, note: 'Surrogate']
  parent_key int
}
`,
  'tables/dim_date.dbml': '// Calendar.\n\nTable dim_date {\n  date_key int [pk]\n}\n',
  // 11.0-only typed values (§2.2): this file compiles in 11.0.0 alone, so Law 5 holds it to 11.0.0.
  'tables/typed.dbml': `// Typed values, as 11.0 allows them.
Table typed [erd_role: 'reference', meta_count: 3, headercolor: #3498db] {
  id int [pk, natural_key: true] /* the key */
  v int [scd_type: 2] // typed
  w varchar
}
`,
  'tables/gold/_relationships.dbml': `// Written by hand: unsorted, with an extra use line.
use { table fct_order } from './fct_order.dbml'
use { table gold.dim_customer } from './dim_customer.dbml'
use { table dim_date } from '../dim_date.dbml'
use * from './nothing_here_but_harmless.dbml'

Ref "ship date": fct_order.ship_date_key > dim_date.date_key [delete: cascade] // shipping
// the customer
Ref: fct_order.customer_key >? gold.dim_customer.customer_key
Ref parent: gold.dim_customer.parent_key > gold.dim_customer.customer_key
`,
  'tables/gold/nothing_here_but_harmless.dbml': '// An extra file a use line imports.\n',
  'gold/sales.dbml': `// The sales star, by hand.

Project sales {
  Note: 'Sales'
  erd_schema_version: '7'
  database_type: 'Snowflake'
}

use { table fct_order } from '../tables/gold/fct_order.dbml'
use * from '../tables/gold/dim_customer.dbml'
use { table dim_date } from '../tables/dim_date.dbml'

Note "n-1" [color: #f59e0b] {
  'Remember the grain'
}
`,
};

/** Use lines missing on purpose (the file does not compile for other tools; ERD Studio still reads and edits it). */
const MISSING_USE_PROJECT: Record<string, string> = {
  'tables/dim_date.dbml': 'Table dim_date {\n  date_key int [pk]\n}\n',
  'tables/fct_order.dbml': 'Table fct_order {\n  id int [pk]\n  date_key int\n  other_key int\n}\n',
  'tables/_relationships.dbml': '// No use lines.\nRef: dim_date.date_key - fct_order.date_key\nRef: fct_order.other_key > dim_date.date_key\n',
};

const PROJECTS = [
  ...fixtureProjects(),
  { name: 'hand-written', files: HAND_WRITTEN_PROJECT },
  { name: 'missing-use', files: MISSING_USE_PROJECT },
];

describe('the laws over every DBML fixture', () => {
  it('finds the fixture projects', () => {
    expect(PROJECTS.length).toBeGreaterThanOrEqual(7);
  });

  for (const project of PROJECTS) {
    const library = libraryOf(project.files);

    for (const [file, text] of tableFilesOf(project.files)) {
      const stem = stemOf(file);
      const reading = parseTableDbml(text, stem);
      if (!reading.ok || !reading.writable) continue;
      it(`${project.name}/${file}: Laws 1–5 for its table`, () => {
        // Law 1.
        expect(editTableDbml(text, reading.table)).toBe(text);
        const baseline = cleanIn({ [file]: text }, file);
        const mutations: Array<(t: SemanticTable) => void> = [
          (t) => { t.grain = 'Changed grain'; t.columns = [...(t.columns ?? []), { name: 'law_added', dataType: 'VARCHAR(10)', description: 'Added' }]; },
          (t) => { t.columns = (t.columns ?? []).slice(0, -1); t.meta = { ...(t.meta ?? {}), law: 'x', nested: { a: ['b'] } }; },
          (t) => { const cols = t.columns ?? []; if (cols.length > 0) cols[0] = { ...cols[0], name: `${cols[0].name}_renamed`, isNaturalKey: !cols[0].isNaturalKey }; t.description = 'New\n  description'; },
          (t) => { for (const c of t.columns ?? []) c.isPrimaryKey = !c.isPrimaryKey; t.columns?.reverse(); },
        ];
        for (const mutate of mutations) {
          const desired = clone(reading.table);
          mutate(desired);
          const out = editTableDbml(text, desired);
          expect(normTable(readOk(out, desired.name))).toEqual(normTable(desired)); // Law 3
          expect(editTableDbml(out, desired)).toBe(out); // Law 2
          expectPreserved(text, out, tableRemovedSpans(text, reading.table, desired)); // Law 4
          expect(projectDiagnostics({ [file]: out }, [file], baseline)).toEqual([]); // Law 5
        }
      });
    }

    for (const file of relationshipsFilesOf(project.files)) {
      const text = project.files[file];
      it(`${project.name}/${file}: Laws 1–5 for its relationships`, () => {
        // Every owner with a Ref in this file, listed with what this file holds for it.
        const owners = ownersOfFile(project.files, file, library);
        const resolve = relationshipsResolver(library);
        const mine = new Map([...owners].map(([k, list]) => [k, { name: resolve(k)?.name ?? k, relationships: list }]));
        // Law 1: every owner of the folder listed with what it holds.
        expect(editRelationshipsDbml(text, { filePath: file, owners: mine, resolve })).toBe(text);
        const baseline = cleanIn(project.files, file);
        const owner = [...mine.values()].find((o) => o.relationships.length > 0);
        if (!owner) return;
        const variants: TableRelationship[][] = [
          owner.relationships.slice(1),
          owner.relationships.map((r, i) => (i === 0 ? { ...r, role: 'law role' } : r)),
          owner.relationships.map((r) => (r.compositeKey ? r : { ...r, cardinality: r.cardinality === 'one-to-one' ? 'many-to-one' : 'one-to-one' })),
        ];
        for (const relationships of variants) {
          const desired = new Map(mine);
          desired.set(owner.name.toLowerCase(), { name: owner.name, relationships });
          const out = editRelationshipsDbml(text, { filePath: file, owners: desired, resolve });
          const read = ownersOfFile({ ...project.files, [file]: out }, file, library);
          expect(comparableRelationships(read.get(owner.name.toLowerCase()))).toEqual(comparableRelationships(relationships)); // Law 3
          expect(editRelationshipsDbml(out, { filePath: file, owners: desired, resolve })).toBe(out); // Law 2
          expectPreserved(text, out, relationshipsRemovedSpans(text, out)); // Law 4
          expect(projectDiagnostics({ ...project.files, [file]: out }, [file], baseline)).toEqual([]); // Law 5
        }
      });
    }

    for (const [file, text] of Object.entries(project.files)) {
      if (file.startsWith('tables/') || !file.endsWith('.dbml')) continue;
      it(`${project.name}/${file}: Laws 1–5 for its diagram`, () => {
        const before = parseSubjectAreaDbml(text, file, null).obj as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
        const resolveTable = diagramResolver(library);
        const lookups = {
          resolveTable,
          relationshipsFilesFor: (names: readonly string[]) => names.map((n) => resolveTable(n)).filter((t) => t?.storage === 'dbml').map((t) => relationshipsFilePathOf(t!.path)),
          fileExists: (p: string) => p in project.files,
        };
        expect(editSubjectAreaDbml(text, { filePath: file, before, after: before, ...lookups })).toBe(text); // Law 1
        const baseline = cleanIn(project.files, file);
        const after = clone(before);
        after.description = 'Law description';
        after.viewConfig.annotations = [...(after.viewConfig.annotations ?? []), { id: 'law-note-1', text: "it's a note", x: 0, y: 0, color: 'green' }];
        after.logical.models = after.logical.models.filter((m: string) => resolveTable(m)?.storage === 'dbml').slice(1);
        const out = editSubjectAreaDbml(text, { filePath: file, before, after, ...lookups });
        expect(normDiagram(parseSubjectAreaDbml(out, file, null).obj)).toEqual(normDiagram(after)); // Law 3
        expect(editSubjectAreaDbml(out, { filePath: file, before: parseSubjectAreaDbml(out, file, null).obj, after, ...lookups })).toBe(out); // Law 2
        expectPreserved(text, out, diagramRemovedSpans(text, out, after)); // Law 4
        expect(projectDiagnostics({ ...project.files, [file]: out }, [file], baseline)).toEqual([]); // Law 5
      });
    }
  }
});

describe('renderNewTableDbml over every fixture table', () => {
  // §4.5: read(renderNewTableDbml(t)) ≅ t for every fixture table (the YAML libraries, as Convert will meet them).
  const root = path.resolve(__dirname, '../fixtures');
  const tables = walk(root)
    .filter((f) => /\.ya?ml$/.test(f) && /[\\/]\.erd-studio[\\/](logical-models|tables)[\\/]/.test(f))
    .flatMap((f) => {
      let table: SemanticTable | null = null;
      try {
        table = parseTableText(fs.readFileSync(f, 'utf8'), path.basename(f).replace(/\.ya?ml$/, ''));
      } catch {
        return []; // a fixture that is broken on purpose
      }
      return table && table.name ? [[path.relative(root, f), table] as const] : [];
    });

  it('finds the fixture tables', () => {
    expect(tables.length).toBeGreaterThanOrEqual(30);
  });

  for (const [file, table] of tables) {
    it(`${file} reads back as itself and compiles in every parser`, () => {
      const out = renderNewTableDbml(table);
      expect(normTable(readOk(out, table.name))).toEqual(normTable(table));
      expect(projectDiagnostics({ [`tables/${table.name}.dbml`]: out })).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// The seeded generator
// ---------------------------------------------------------------------------

type Rng = () => number;
const pick = <T,>(rng: Rng, list: readonly T[]): T => list[Math.floor(rng() * list.length)];
const chance = (rng: Rng, p: number): boolean => rng() < p;

const TABLE_NAMES = ['fct_order', 'dim_customer', 'Table', 'note', 'DIM_DATE', '1st_table', 'my table', 'ref', 'Order Lines (v2)', 'x'];
const COLUMN_NAMES = ['id', 'customer_key', 'note', 'Table', 'pk', '1st', 'UPPER_CASE', 'amount', 'region_code', 'country_code', 'date_key', 'status', 'with space', 'enum', 'indexes'];
const TYPES = ['int', 'BIGINT', 'varchar', 'DECIMAL(18,2)', 'timestamp', 'double precision', '', 'varchar[]', 'STRING'];
const TEXTS = ['plain', "it's quoted", 'back\\slash', 'two\nlines', '  leading space', 'trailing  ', '“unicode” ✓', 'a\n  - bullet\n  - bullet', "''", '\\', 'x'.repeat(300)];

function randomText(rng: Rng): string {
  return pick(rng, TEXTS) + (chance(rng, 0.3) ? ` ${Math.floor(rng() * 1000)}` : '');
}

function randomMeta(rng: Rng): SemanticTable['meta'] {
  if (!chance(rng, 0.4)) return undefined;
  const meta: Record<string, unknown> = {};
  for (let i = 0; i < 1 + Math.floor(rng() * 3); i++) {
    const key = pick(rng, ['owner', 'tags', 'pii', 'Odd Key', 'json', 'count', 'nested']);
    meta[key] = pick(rng, [randomText(rng), true, null, ['a', 'b'], { k: 'v' }, '42']);
  }
  return meta as SemanticTable['meta'];
}

function randomColumn(rng: Rng, name: string): ColumnDef {
  const c: ColumnDef = { name, dataType: pick(rng, TYPES), description: chance(rng, 0.5) ? randomText(rng) : '' };
  if (chance(rng, 0.2)) c.isForeignKey = true;
  if (chance(rng, 0.2)) c.isNaturalKey = true;
  if (chance(rng, 0.3)) c.scdType = pick(rng, [0, 1, 2] as const);
  if (chance(rng, 0.2)) c.additiveType = pick(rng, ['additive', 'semi-additive', 'non-additive'] as const);
  const meta = randomMeta(rng);
  if (meta) c.meta = meta;
  return c;
}

function randomTable(rng: Rng, name: string): SemanticTable {
  const names = [...COLUMN_NAMES].sort(() => rng() - 0.5).slice(0, Math.floor(rng() * 7));
  const columns = names.map((n) => randomColumn(rng, n));
  const pkCount = pick(rng, [0, 1, 1, 2, 3]);
  for (const c of columns.slice(0, pkCount)) c.isPrimaryKey = true;
  const t: SemanticTable = { name, columns };
  if (chance(rng, 0.4)) t.schema = pick(rng, ['gold', 'silver', 'public']);
  if (chance(rng, 0.5)) t.modelRole = pick(rng, ['transaction-fact', 'conformed-dim', 'reference'] as const);
  if (chance(rng, 0.5)) t.grain = randomText(rng);
  if (chance(rng, 0.3)) t.alias = pick(rng, ['orders', 'cust']);
  if (chance(rng, 0.5)) t.description = randomText(rng);
  if (chance(rng, 0.4)) t.rationale = { purpose: randomText(rng), ...(chance(rng, 0.5) ? { scdStrategy: randomText(rng) } : {}) };
  const meta = randomMeta(rng);
  if (meta) t.meta = meta;
  return t;
}

/**
 * Hand-written touches on a table file: a header comment, comment lines
 * above columns, trailing `//` and block comments, the body Note moved among
 * the columns, and Metadata blocks (with a comment inside) for the table and
 * a column.
 */
function decorate(rng: Rng, text: string, table: SemanticTable): string {
  const lines = text.split('\n');
  const out: string[] = [];
  if (chance(rng, 0.5)) out.push('// A header comment', '');
  let inString = false;
  const columnLines: number[] = [];
  lines.forEach((line, i) => {
    const wasInString = inString;
    if ((line.match(/'''/g) ?? []).length % 2 === 1) inString = !inString;
    const isColumn = !wasInString && /^ {2}[^ /}]/.test(line) && !/^ {2}(indexes|Note:)/.test(line) && i > 0 && !lines.slice(0, i).every((l) => !l.endsWith('{'));
    if (isColumn && chance(rng, 0.3)) out.push(`  // about line ${i}`);
    const r = rng();
    out.push(isColumn && !inString && r < 0.15 ? `${line} // tail ${i}` : isColumn && !inString && r < 0.25 ? `${line} /* block ${i} */` : line);
    if (isColumn && !inString) columnLines.push(out.length - 1);
  });
  // A body Note among the columns (after the first), where hand-written files often have it.
  const noteAt = out.findIndex((l) => /^ {2}Note: /.test(l) && (l.match(/'''/g) ?? []).length !== 1);
  if (noteAt >= 0 && columnLines.length >= 2 && chance(rng, 0.5)) {
    const [line] = out.splice(noteAt, 1);
    out.splice(columnLines[0] + 1, 0, line);
  }
  let result = out.join('\n');
  const columns = table.columns ?? [];
  if (columns.length > 0 && chance(rng, 0.3)) {
    const column = pick(rng, columns);
    result += `\nMetadata Column ${dbmlName(table.name)}.${dbmlName(column.name)} {\n  // set by a block\n  meta_from_block: 'column'\n}\n`;
  }
  if (chance(rng, 0.2)) result += `\nMetadata Table ${dbmlName(table.name)} {\n  // a block entry\n  meta_from_block: 'table'\n}\n`;
  return result;
}

function mutateTable(rng: Rng, t: SemanticTable): SemanticTable {
  const d = clone(t);
  const cols = d.columns ?? [];
  const ops = Math.max(1, Math.floor(rng() * 4));
  for (let i = 0; i < ops; i++) {
    switch (Math.floor(rng() * 12)) {
      case 0: d.grain = chance(rng, 0.3) ? undefined : randomText(rng); break;
      case 1: d.description = chance(rng, 0.3) ? undefined : randomText(rng); break;
      case 2: d.meta = randomMeta(rng); break;
      case 3: { const unused = COLUMN_NAMES.filter((n) => !cols.some((c) => c.name.toLowerCase() === n.toLowerCase())); if (unused.length) cols.splice(Math.floor(rng() * (cols.length + 1)), 0, randomColumn(rng, pick(rng, unused))); break; }
      case 4: if (cols.length) cols.splice(Math.floor(rng() * cols.length), 1); break;
      case 5: if (cols.length) { const c = pick(rng, cols); c.isPrimaryKey = !c.isPrimaryKey; } break;
      case 6: if (cols.length > 1) cols.sort(() => rng() - 0.5); break;
      case 7: if (cols.length) { const c = pick(rng, cols); Object.assign(c, randomColumn(rng, c.name), { isPrimaryKey: c.isPrimaryKey }); } break;
      case 8: if (cols.length) { const c = pick(rng, cols); const unused = COLUMN_NAMES.filter((n) => !cols.some((x) => x.name.toLowerCase() === n.toLowerCase())); if (unused.length) c.name = `${pick(rng, unused)}`; } break;
      case 9: d.modelRole = chance(rng, 0.3) ? undefined : pick(rng, ['transaction-fact', 'conformed-dim'] as const); d.alias = chance(rng, 0.5) ? undefined : 'renamed_alias'; break;
      case 10: d.name = pick(rng, TABLE_NAMES.filter((n) => n.toLowerCase() !== d.name.toLowerCase())); break; // a table rename
      default: d.rationale = chance(rng, 0.3) ? undefined : { design: randomText(rng) }; break;
    }
  }
  d.columns = cols;
  return d;
}

/** A small library: four tables in two folders, as their files. */
function randomLibrary(rng: Rng): Record<string, string> {
  const files: Record<string, string> = {};
  const names = ['fct_order', 'dim_customer', 'dim_date', 'bridge'];
  names.forEach((name, i) => {
    const folder = i === 2 ? '' : 'gold/';
    const columns: ColumnDef[] = ['id', 'a_key', 'b_key', 'c_key'].map((n) => ({ name: chance(rng, 0.2) ? n.toUpperCase() : n, dataType: 'int', description: '' }));
    columns[0].isPrimaryKey = true;
    files[`tables/${folder}${name}.dbml`] = renderNewTableDbml({ name, columns });
  });
  return files;
}

function randomRelationships(rng: Rng, owner: string, others: readonly string[]): TableRelationship[] {
  const out: TableRelationship[] = [];
  const used = new Set<string>();
  const n = Math.floor(rng() * 4);
  for (let i = 0; i < n; i++) {
    const to = pick(rng, others);
    const composite = chance(rng, 0.25);
    const fromCols = composite ? ['a_key', 'b_key'] : [pick(rng, ['a_key', 'b_key', 'c_key'])];
    const toCols = composite ? ['b_key', 'c_key'] : ['id'];
    const key = [to, ...fromCols].join('.');
    const reverseKey = `${owner}.${to}`;
    if (used.has(key) || (to === owner && fromCols.join() === toCols.join()) || used.has(reverseKey)) continue;
    used.add(key);
    const cardinality = composite ? 'many-to-one' : pick(rng, ['many-to-one', 'one-to-one', 'many-to-many'] as const);
    const role = chance(rng, 0.3) ? pick(rng, ['order date', 'ship', 'Parent']) : undefined;
    fromCols.forEach((fc, j) => out.push({ fromColumn: fc, toModel: to, toColumn: toCols[j], cardinality, ...(role ? { role } : {}), ...(composite ? { compositeKey: `fk_${to}` } : {}) }));
  }
  return out;
}

/**
 * Hand-written touches on a relationships file: comment lines above Refs,
 * trailing comments on Refs and use lines, and block-form Refs with a
 * comment inside.
 */
function decorateRelationships(rng: Rng, text: string): string {
  return text.split('\n').flatMap((line, i) => {
    if (/^Ref/.test(line)) {
      const out: string[] = [];
      if (chance(rng, 0.3)) out.push(`// about Ref ${i}`);
      const m = /^(Ref(?: [^:{]+?)?): (.*)$/.exec(line);
      if (m && chance(rng, 0.25)) {
        out.push(`${m[1]} {`, `  // inside ${i}`, `  ${m[2]}${chance(rng, 0.5) ? ` // inner tail ${i}` : ''}`, '}');
        return out;
      }
      out.push(chance(rng, 0.3) ? `${line} // tail ${i}` : line);
      return out;
    }
    if (/^use /.test(line) && chance(rng, 0.2)) return [`${line} // use ${i}`];
    return [line];
  }).join('\n');
}

/** A composite's entries in reverse order (the same link, listed another way). */
function reverseComposites(list: TableRelationship[]): TableRelationship[] {
  const groups = new Map<string, TableRelationship[]>();
  for (const r of list) if (r.compositeKey) groups.set(r.compositeKey, [...(groups.get(r.compositeKey) ?? []), r]);
  const next = new Map([...groups].map(([k, members]) => [k, [...members].reverse()]));
  return list.map((r) => (r.compositeKey ? next.get(r.compositeKey)!.shift()! : r));
}

/** Hand-written touches on a diagram: comment lines above and trailing comments on use lines and Notes. */
function decorateDiagram(rng: Rng, text: string): string {
  return text.split('\n').flatMap((line, i) => {
    if (!/^(use |Note )/.test(line)) return [line];
    const out: string[] = [];
    if (chance(rng, 0.3)) out.push(`// about line ${i}`);
    out.push(chance(rng, 0.3) ? `${line} // tail ${i}` : line);
    return out;
  }).join('\n');
}

describe(`the laws over a seeded generator (DBML_LAW_SEED=${SEED})`, () => {
  /** The texts of the case being run, shown when it fails. */
  let trail: string[] = [];
  const note = (label: string, value: unknown): void => { trail.push(`--- ${label}:\n${typeof value === 'string' ? value : JSON.stringify(value, null, 1)}`); };
  const fail = (label: string, i: number, err: unknown): never => {
    throw new Error(`DBML_LAW_SEED=${SEED}, ${label} case ${i}: ${err instanceof Error ? err.message : String(err)}\n${trail.join('\n')}`);
  };

  it('tables: create, decorate, edit (Laws 1–5)', () => {
    const rng = mulberry32(SEED);
    for (let i = 0; i < 120; i++) {
      try {
        const name = pick(rng, TABLE_NAMES);
        const table = randomTable(rng, name);
        const created = renderNewTableDbml(table);
        expect(normTable(readOk(created, name))).toEqual(normTable(table));
        trail = [];
        const t = decorate(rng, created, table);
        note('input', t);
        const file = `tables/${name}.dbml`;
        expect(projectDiagnostics({ [file]: t }, [file])).toEqual([]);
        const read = readOk(t, name);
        expect(editTableDbml(t, read)).toBe(t); // Law 1
        const desired = mutateTable(rng, read);
        note('desired', desired);
        const out = editTableDbml(t, desired, { rename: true });
        note('output', out);
        expect(normTable(readOk(out, desired.name))).toEqual(normTable(desired)); // Law 3
        expect(editTableDbml(out, desired, { rename: true })).toBe(out); // Law 2
        expect(editTableDbml(out, readOk(out, desired.name))).toBe(out); // Law 1 on the output
        expectPreserved(t, out, tableRemovedSpans(t, read, desired)); // Law 4
        expect(projectDiagnostics({ [file]: out }, [file])).toEqual([]); // Law 5
      } catch (err) {
        fail('table', i, err);
      }
    }
  });

  it('relationships: create, decorate, edit (Laws 1–5)', () => {
    const rng = mulberry32(SEED + 1000);
    const CASES = 90;
    let ran = 0;
    let refused = 0;
    for (let i = 0; i < CASES; i++) {
      try {
        const library = randomLibrary(rng);
        const lib = libraryOf(library);
        const resolve = relationshipsResolver(lib);
        const file = 'tables/gold/_relationships.dbml';
        const owners = ['fct_order', 'dim_customer', 'bridge'];
        const others = ['fct_order', 'dim_customer', 'dim_date', 'bridge'];
        const first = new Map(owners.map((o) => [o, { name: o, relationships: randomRelationships(rng, o, others) }]));
        let written: string;
        try {
          written = editRelationshipsDbml(null, { filePath: file, owners: first, resolve });
        } catch (err) {
          if (!(err instanceof DbmlEditRefused)) throw err;
          refused++;
          continue; // a random draw two owners joining the same columns is refused, as it should be
        }
        trail = [];
        note('written', written);
        const created = decorateRelationships(rng, written);
        note('decorated', created);
        const files = { ...library, [file]: created };
        expect(projectDiagnostics(files, [file])).toEqual([]);
        const read = ownersOf(files, lib);
        for (const o of owners) {
          note(`read back ${o}`, read.get(o));
          note(`given ${o}`, first.get(o)!.relationships);
          expect(comparableRelationships(read.get(o))).toEqual(comparableRelationships(first.get(o)!.relationships));
        }
        const current = new Map(owners.map((o) => [o, { name: o, relationships: read.get(o) ?? [] }]));
        expect(editRelationshipsDbml(created, { filePath: file, owners: current, resolve })).toBe(created); // Law 1
        const target = pick(rng, owners);
        const next = new Map(current);
        const list = (read.get(target) ?? []).map((r) => ({ ...r }));
        const changed = chance(rng, 0.5) ? randomRelationships(rng, target, others)
          : (() => {
            // Whole units (a composite's members together) are kept or dropped, and re-roled.
            const unitOf = (r: TableRelationship): string => r.compositeKey ?? `${r.fromColumn}>${r.toModel}.${r.toColumn}`;
            const decisions = new Map<string, { keep: boolean; role: boolean }>();
            for (const r of list) if (!decisions.has(unitOf(r))) decisions.set(unitOf(r), { keep: chance(rng, 0.7), role: chance(rng, 0.4) });
            const kept = list.filter((r) => decisions.get(unitOf(r))!.keep).map((r) => (decisions.get(unitOf(r))!.role ? { ...r, role: 'changed role' } : r));
            return chance(rng, 0.4) ? reverseComposites(kept) : kept; // the same composites, listed another way
          })();
        next.set(target, { name: target, relationships: changed });
        let out: string;
        note('desired', [...next.values()]);
        try {
          out = editRelationshipsDbml(created, { filePath: file, owners: next, resolve });
        } catch (err) {
          if (!(err instanceof DbmlEditRefused)) throw err;
          refused++;
          continue;
        }
        note('output', out);
        const back = ownersOf({ ...library, [file]: out }, lib);
        for (const o of owners) expect(comparableRelationships(back.get(o))).toEqual(comparableRelationships(next.get(o)!.relationships)); // Law 3
        expect(editRelationshipsDbml(out, { filePath: file, owners: next, resolve })).toBe(out); // Law 2
        expectPreserved(created, out, relationshipsRemovedSpans(created, out)); // Law 4
        expect(projectDiagnostics({ ...library, [file]: out }, [file])).toEqual([]); // Law 5
        ran++;
      } catch (err) {
        fail('relationships', i, err);
      }
    }
    // Only the refusals the generator can draw on purpose are skipped; nearly every case runs.
    expect(refused + ran).toBe(CASES);
    expect(ran).toBeGreaterThanOrEqual(70);
  });

  it('diagrams: create, decorate, edit (Laws 1–5)', () => {
    const rng = mulberry32(SEED + 2000);
    const COLOURS: AnnotationColor[] = ['yellow', 'blue', 'green', 'pink', 'orange'];
    for (let i = 0; i < 90; i++) {
      try {
        const library = {
          ...randomLibrary(rng),
          'tables/gold/_relationships.dbml': '// relationships\n',
          'tables/_relationships.dbml': '// relationships\n',
        };
        const lib = libraryOf(library);
        const resolveTable = diagramResolver(lib);
        const lookups = {
          resolveTable,
          relationshipsFilesFor: (names: readonly string[]) => names.map((n) => resolveTable(n)).filter((t) => t?.storage === 'dbml').map((t) => relationshipsFilePathOf(t!.path)),
          fileExists: (p: string) => p in library,
        };
        const file = pick(rng, ['gold/sales.dbml', 'silver/My Diagram.dbml']);
        const all = ['fct_order', 'dim_customer', 'dim_date', 'bridge'];
        const members = all.filter(() => chance(rng, 0.6)).sort(() => rng() - 0.5);
        let noteCount = 0;
        const makeNote = (_k: number): Annotation => {
          const k = noteCount++; // ids are unique, as the canvas makes them
          return {
          id: chance(rng, 0.5) ? `0c0ffee0-${k}-4f7e-9c1b-2d5e6f7a8b9c` : `note_${k}`,
          text: randomText(rng),
          x: 0,
          y: 0,
          ...(chance(rng, 0.6) ? { color: pick(rng, COLOURS) } : {}),
          ...(chance(rng, 0.4) && members.length ? { linkedModel: pick(rng, members) } : {}),
          };
        };
        const written = renderNewSubjectAreaDbml({
          filePath: file,
          domain: pick(rng, ['sales', 'My Sales', 'note']),
          description: chance(rng, 0.6) ? randomText(rng) : '',
          ...(chance(rng, 0.3) ? { modelFolder: 'models/gold' } : {}),
          ...(chance(rng, 0.3) ? { showFkEdges: chance(rng, 0.5) } : {}),
          ...(chance(rng, 0.3) ? { layoutOptions: { 'elk.direction': 'RIGHT' } } : {}),
          ...(chance(rng, 0.2) ? { stubColumns: ['a_key'] } : {}),
          members: members.map((m) => ({ name: m, path: resolveTable(m)!.path })),
          relationshipsFiles: lookups.relationshipsFilesFor(members),
          annotations: Array.from({ length: Math.floor(rng() * 3) }, (_, k) => makeNote(k)),
        });
        trail = [];
        note('written', written);
        const created = decorateDiagram(rng, written);
        note('decorated', created);
        const files = { ...library, [file]: created };
        expect(projectDiagnostics(files, [file])).toEqual([]);
        const before = parseSubjectAreaDbml(created, file, null).obj as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
        expect(editSubjectAreaDbml(created, { filePath: file, before, after: before, ...lookups })).toBe(created); // Law 1
        const after = clone(before);
        for (let k = 0; k < 1 + Math.floor(rng() * 3); k++) {
          switch (Math.floor(rng() * 6)) {
            case 0: after.description = chance(rng, 0.3) ? '' : randomText(rng); break;
            case 1: after.domain = pick(rng, ['sales_v2', 'Other Name', 'table']); break;
            case 2: after.logical.models = all.filter(() => chance(rng, 0.5)).sort(() => rng() - 0.5); break;
            case 3: after.viewConfig.showFkEdges = chance(rng, 0.5); break;
            case 4: after.viewConfig.annotations = [...(after.viewConfig.annotations ?? []).filter(() => chance(rng, 0.6)).map((a: Annotation) => ({ ...a, text: chance(rng, 0.5) ? randomText(rng) : a.text })), ...(chance(rng, 0.5) ? [makeNote(9)] : [])]; break;
            default: if (chance(rng, 0.5)) delete after.modelFolder; else after.modelFolder = 'models/x'; break;
          }
        }
        note('after', after);
        const out = editSubjectAreaDbml(created, { filePath: file, before, after, ...lookups });
        note('output', out);
        const readBack = parseSubjectAreaDbml(out, file, null).obj;
        expect(normDiagram(readBack)).toEqual(normDiagram(after)); // Law 3
        expect(editSubjectAreaDbml(out, { filePath: file, before: readBack, after, ...lookups })).toBe(out); // Law 2
        expect(editSubjectAreaDbml(out, { filePath: file, before: readBack, after: readBack, ...lookups })).toBe(out); // Law 1 on the output
        expectPreserved(created, out, diagramRemovedSpans(created, out, after)); // Law 4
        expect(projectDiagnostics({ ...library, [file]: out }, [file])).toEqual([]); // Law 5
      } catch (err) {
        fail('diagram', i, err);
      }
    }
  });
});
