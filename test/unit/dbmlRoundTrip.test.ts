/**
 * The DBML round trip, end to end: a subject area exported as rich DBML and
 * its `.dbdiagram` layout (`toDbmlRich`, `serializeDbdiagramLayout` in
 * `@erd-studio/core`), read back (`readDbml`, `readDbdiagramLayout`),
 * planned as a new subject area in an empty project (`planDbmlImport`),
 * written the way Import DBML… writes it (`TableLibraryService.saveTable`,
 * `serializeDbmlImportDocument`), and loaded again through core's pipeline
 * (`loadDisplaySubjectArea`) — must give back the same diagram on every field
 * the export carries. Run over every core fixture (the set the golden tests
 * load, and their v6 / mixed-naming copies), every subject area of
 * test/fixtures/dbt-project, and two projects of this file's own that use
 * every mapping row at its awkward edges; each into a v5 and a v6 project,
 * with relationships in the subject area file and in the Table Library. The
 * export of what comes back is the first export again, and from then on a
 * fixed point. Also: each core fixture imported back into its own project
 * (every table reused), and every DBML file under test/fixtures/dbml (other
 * tools' and a real `dbdiagram pull`) imported, exported as rich DBML that
 * the three parsers read with no diagnostic of ERD Studio's making, and
 * round-tripped again.
 *
 * Compared: the subject area's name, layer and description; each table's
 * name, schema, alias, role, grain, description, rationale and meta (exactly);
 * each column's name, type, description, PK, NK, SCD type, additivity, FK
 * flag (the file's own and the badge) and meta (exactly); the relationships
 * as links (ends, cardinality, role, composite grouping); the canvas
 * positions; the sticky notes' text, colour and linked table.
 *
 * What does not come back, and why — the only differences allowed:
 *
 * - **Not in the export at all**: YAML comments and key order (the files are
 *   written fresh); `schemaVersion` (the new project's naming decides it);
 *   the subject area's `modelFolder` and `stubColumns` (dbt-side settings of
 *   the physical stage), `viewConfig.showFkEdges` and `layoutOptions` (canvas
 *   settings), and sticky-note positions, sizes and ids (the `.dbdiagram`
 *   shape for sticky notes is not documented, so the export writes none and
 *   the import places notes in a row above the tables).
 * - **The compositeKey label**: a composite foreign key keeps its column
 *   pairs, but its label is made again (`fk_<to table>`), as a new link's is,
 *   and its role is written on each pair (core reads it from the first). A
 *   group core does not draw as one composite (a many-to-many, say) is
 *   separate links already, and comes back as them, without the label.
 * - **One-to-many**: stored the other way round, as the equivalent
 *   many-to-one (the export writes every Ref from its foreign-key end).
 * - **What the first export already left out**, each with a comment in the
 *   DBML: a model listed twice (exported once), a column with no name, a
 *   relationship whose end column is not in the diagram (its table's file is
 *   missing or broken, or the column has no name), and a model file that
 *   could not be read (exported, and so imported, as a table without columns;
 *   its `loadError` / `loadWarning` describe the old file, not the diagram).
 * - **Spelling**: a relationship end spelled in another case than its table
 *   or column comes back in the table's spelling; a column named by a number
 *   comes back as that text; a missing type or description as `''`.
 * - **Text DBML trims**: a note (description, column note, Project note,
 *   sticky note) loses white space at its start; a rationale or grain that is
 *   only white space is not exported. Covered by its own test below.
 * - **Meta key order**: every entry comes back, exactly, but the text values
 *   under lower-case keys (`meta_<key>` properties, readable in dbdiagram)
 *   come before the rest (`meta_json`'s).
 * - **Positions** are written to two decimals.
 * - A **zero-column table** travels with a placeholder column, which the
 *   import drops: it comes back with no columns, as it was (its own test).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as v9 from 'dbml-parse-v9';
import * as v10 from 'dbml-parse-v10';
import { afterAll, describe, expect, it } from 'vitest';

import {
  DBML_RICH_PLACEHOLDER_COLUMN,
  canonicalRelationship,
  loadDisplaySubjectArea,
  readDbdiagramLayout,
  serializeDbdiagramLayout,
  toDbmlRich,
} from '@erd-studio/core';
import type { DisplayRelationship, DisplaySubjectArea, DisplayTable } from '@erd-studio/core';
import { planDbmlImport, serializeDbmlImportDocument, type DbmlImportPlan } from '../../src/services/dbmlImport';
import { readDbml, type DbmlParserModule } from '../../src/services/dbmlImportParse';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { MODEL_LINT_INFOS, parseDbmlRich, readDbmlRich } from '../../packages/core/test/exportParsers';

const CORE_FIXTURES = path.resolve(__dirname, '../../packages/core/test/fixtures');
const DBT_PROJECT = path.resolve(__dirname, '../fixtures/dbt-project');
const FOREIGN = path.resolve(__dirname, '../fixtures/dbml/foreign');

/** Every core fixture that loads: the set exportDiagram.golden.test.ts exports. */
const CORE_CASES: Record<string, string> = {
  showcase: '.erd-studio/silver/showcase.json',
  'v4-inline': '.erd-studio/bronze/orders.json',
  'missing-model': '.erd-studio/silver/partial.json',
  'no-layers': '.erd-studio/gold/accounts.json',
  'missing-positions': '.erd-studio/silver/showcase.json',
  'library-relationships': '.erd-studio/gold/sales.json',
  'v4-nameless-column': '.erd-studio/silver/orders.json',
  'composite-and-self': '.erd-studio/gold/vault.json',
  'data-type-alias': '.erd-studio/silver/orders.json',
  'domain-one-to-many': '.erd-studio/gold/sales.json',
  'duplicate-key': '.erd-studio/silver/orders.json',
};

/** The v6 and mixed-naming copies of core fixtures (read through the v6 naming, #181). */
const NAMING_CASES: Record<string, string> = {
  'naming-v6/showcase': '.erd-studio/silver/showcase.json',
  'naming-v6/library-relationships': '.erd-studio/gold/sales.json',
  'naming-mixed/library-relationships': '.erd-studio/gold/sales.json',
  'naming-mixed/library-relationships (v5 file)': '.erd-studio/gold/sales_v5.json',
};

/** Every subject area file of test/fixtures/dbt-project. */
function dbtProjectCases(): Record<string, string> {
  const root = path.join(DBT_PROJECT, '.erd-studio');
  const cases: Record<string, string> = {};
  for (const layer of fs.readdirSync(root, { withFileTypes: true })) {
    if (!layer.isDirectory() || ['logical-models', 'tables', 'templates'].includes(layer.name)) continue;
    for (const file of fs.readdirSync(path.join(root, layer.name))) {
      if (file.endsWith('.json')) cases[`${layer.name}/${file}`] = `.erd-studio/${layer.name}/${file}`;
    }
  }
  return cases;
}

const PARSERS: Array<[string, DbmlParserModule | undefined]> = [
  ['@dbml/parse 9.1.1', v9 as unknown as DbmlParserModule],
  ['@dbml/parse 10.3.1', v10 as unknown as DbmlParserModule],
  ['@dbml/parse 11.0.0', undefined],
];

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

function fsReadFile(root: string) {
  return async (p: string): Promise<string | null> => {
    try {
      return fs.readFileSync(path.join(root, p), 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  };
}

const workspaces: string[] = [];
afterAll(() => {
  for (const ws of workspaces) fs.rmSync(ws, { recursive: true, force: true });
});

function tempWorkspace(): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'dbml-round-trip-'));
  workspaces.push(ws);
  return ws;
}

async function loadArea(root: string, domainPath: string): Promise<DisplaySubjectArea> {
  return loadDisplaySubjectArea({ domainPath, readFile: fsReadFile(root), readOnly: false, warn: () => {} });
}

function layersOf(root: string): string | null {
  const file = path.join(root, '.erd-studio', 'layers.json');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null;
}

type Naming = 'v5' | 'v6';

interface RoundTrip {
  dbml: string;
  layout: string;
  plan: DbmlImportPlan;
  back: DisplaySubjectArea;
  workspace: string;
}

/**
 * Export `area`, import it into an empty project (v5: its `logical-models/`
 * folder exists; v6: no library yet, so it writes `tables/`), write what
 * the import planned as Import DBML… does, and load it back.
 */
async function roundTrip(
  area: DisplaySubjectArea,
  options: { layers: string | null; naming: Naming; libraryRelationships: boolean; parser?: DbmlParserModule },
): Promise<RoundTrip> {
  const dbml = toDbmlRich(area);
  const layout = serializeDbdiagramLayout(area);
  const read = readDbml(dbml, options.parser);
  if (!read.ok) throw new Error(`the export does not read back: ${JSON.stringify(read.diagnostics)}`);

  const workspace = tempWorkspace();
  const semanticRoot = path.join(workspace, '.erd-studio');
  fs.mkdirSync(semanticRoot, { recursive: true });
  if (options.layers !== null) fs.writeFileSync(path.join(semanticRoot, 'layers.json'), options.layers);
  if (options.naming === 'v5') fs.mkdirSync(path.join(semanticRoot, 'logical-models'));
  const library = new TableLibraryService(workspace);

  const plan = planDbmlImport({
    model: read.model,
    layout: readDbdiagramLayout(layout),
    layer: area.layer,
    subjectAreaName: area.domain,
    fileName: `${area.domain}.dbml`,
    library: { findTableName: (n) => library.findTableNameIgnoringCase(n), getTable: (n) => library.getTable(n) },
    libraryRelationships: options.libraryRelationships,
  });
  expect(library.writesTableNaming()).toBe(options.naming === 'v6');
  // As the command writes: the new table files, then the subject area file.
  for (const table of plan.newTables) library.saveTable(table);
  const domainPath = `.erd-studio/${area.layer}/${area.domain}.json`;
  fs.mkdirSync(path.dirname(path.join(workspace, domainPath)), { recursive: true });
  fs.writeFileSync(path.join(workspace, domainPath), serializeDbmlImportDocument(plan.document, library.writesTableNaming()), { flag: 'wx' });
  for (const table of plan.changedLibraryTables) library.saveTable(table);

  const back = await loadArea(workspace, domainPath);
  return { dbml, layout, plan, back, workspace };
}

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

const lower = (s: string): string => s.toLowerCase();

/** A column's name as the export reads it: text, a number as its digits, else none. */
function columnName(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() ? value : null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/** Plain JSON of a value, with own `__proto__` keys kept (JSON.stringify keeps them). */
const plain = (value: unknown): unknown => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

function canonicalTable(model: DisplayTable): Record<string, unknown> {
  const rationale = Object.fromEntries(
    Object.entries(model.rationale ?? {}).filter(([, v]) => typeof v === 'string' && v.trim() !== ''),
  );
  const seen = new Set<string>();
  const columns = [];
  for (const column of model.columns ?? []) {
    const name = columnName(column.name);
    if (name === null || seen.has(lower(name))) continue; // No name, or listed twice: not exported.
    seen.add(lower(name));
    columns.push({
      name,
      dataType: column.dataType ?? '',
      description: column.description ?? '',
      isPrimaryKey: column.isPrimaryKey === true,
      isNaturalKey: column.isNaturalKey === true,
      scdType: column.scdType ?? null,
      additiveType: column.additiveType ?? null,
      isForeignKey: column.isForeignKey === true,
      isForeignKeyDeclared: column.isForeignKeyDeclared === true,
      meta: plain(column.meta) ?? {},
    });
  }
  return {
    name: model.name,
    schema: model.schema ?? '',
    alias: model.alias ?? null,
    modelRole: model.modelRole ?? null,
    grain: model.grain?.trim() ? model.grain : null,
    description: model.description ?? '',
    rationale,
    meta: plain(model.meta) ?? {},
    columns,
  };
}

/**
 * The relationships as links: each end in its table's spelling, a one-to-many
 * turned into its many-to-one, a composite as one link of column pairs (its
 * label left out), and only links whose columns are all in the diagram.
 */
function canonicalLinks(area: DisplaySubjectArea): string[] {
  const models = area.models ?? [];
  const tableOf = (name: string) => models.find((m) => m.name === name) ?? models.find((m) => lower(m.name) === lower(name));
  const columnOf = (model: DisplayTable, name: string) => {
    const names = (model.columns ?? []).map((c) => columnName(c.name)).filter((n): n is string => n !== null);
    return names.find((n) => n === name) ?? names.find((n) => lower(n) === lower(name));
  };
  const groups = new Map<string, DisplayRelationship[]>();
  const order: string[] = [];
  (area.relationships ?? []).forEach((rel, i) => {
    const key = rel.compositeKey ? `${lower(rel.fromModel)}\u0000${lower(rel.toModel)}\u0000${rel.compositeKey}` : `#${i}`;
    if (!groups.has(key)) order.push(key);
    groups.set(key, [...(groups.get(key) ?? []), rel]);
  });
  const out = new Set<string>();
  for (const key of order) {
    const members = groups.get(key)!.map((r) => canonicalRelationship(r));
    const from = tableOf(members[0].fromModel);
    const to = tableOf(members[0].toModel);
    if (!from || !to) continue;
    const pairs: string[] = [];
    let complete = true;
    for (const m of members) {
      const fc = columnOf(from, m.fromColumn);
      const tc = columnOf(to, m.toColumn);
      if (!fc || !tc || (from === to && lower(fc) === lower(tc))) complete = false;
      else pairs.push(`${fc}=${tc}`);
    }
    if (!complete) continue; // Not exported: a column of it is not in the diagram.
    const role = members.map((m) => m.role).find((r) => r) ?? '';
    const contradict = members.some((m) => m.keysContradict) ? ' (drawn backwards)' : '';
    out.add(`${from.name} -> ${to.name} [${pairs.sort().join(', ')}] ${members[0].cardinality} "${role}"${contradict}`);
  }
  return [...out].sort();
}

function canonicalPositions(area: DisplaySubjectArea): Record<string, { x: number; y: number }> {
  const positions = (area.viewConfig?.positions ?? {}) as Record<string, { x: number; y: number }>;
  const out: Record<string, { x: number; y: number }> = {};
  for (const model of area.models ?? []) {
    const at = positions[model.name] ?? Object.entries(positions).find(([k]) => lower(k) === lower(model.name))?.[1];
    if (at && Number.isFinite(at.x) && Number.isFinite(at.y)) out[model.name] = { x: Math.round(at.x * 100) / 100, y: Math.round(at.y * 100) / 100 };
  }
  return out;
}

function canonicalStickies(area: DisplaySubjectArea): Array<Record<string, unknown>> {
  return (area.viewConfig?.annotations ?? [])
    .filter((a) => typeof a.text === 'string' && a.text.trim() !== '')
    .map((a) => ({ text: a.text, color: a.color ?? null, linkedModel: a.linkedModel ?? null }));
}

/** Everything the export carries, in a shape two loads of the same diagram agree on. */
function canonical(area: DisplaySubjectArea): Record<string, unknown> {
  const seen = new Set<string>();
  const models = (area.models ?? []).filter((m) => {
    if (typeof m.name !== 'string' || !m.name.trim() || seen.has(lower(m.name))) return false; // Listed twice: exported once.
    seen.add(lower(m.name));
    return true;
  });
  return {
    domain: area.domain,
    layer: area.layer,
    description: area.description ?? '',
    models: models.map(canonicalTable),
    relationships: canonicalLinks(area),
    positions: canonicalPositions(area),
    stickies: canonicalStickies(area),
  };
}

/** The DBML without the comment lines that say what the first export left out. */
function withoutLeftOut(dbml: string): string {
  return dbml
    .split('\n')
    // (The header's own "Not exported: sticky-note positions …" line stays.)
    .filter((line) => !/^\/\/ (Not exported: (?!sticky-note positions)|.*: column \d+ has no name; not exported$|.*: its table file could not be read )/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\n+$/, '\n');
}

/** The Refs of a DBML text as a sorted list, and the text without them. */
function splitRefs(dbml: string): { refs: string[]; rest: string } {
  const lines = dbml.split('\n');
  return {
    refs: lines.filter((l) => l.startsWith('Ref')).sort(),
    rest: lines.filter((l) => !l.startsWith('Ref')).join('\n'),
  };
}

// ---------------------------------------------------------------------------
// The torture project: every mapping row at its awkward edges
// ---------------------------------------------------------------------------

/** A v5 project written from text, so its loaded DisplaySubjectArea is what a real one gives. */
function writeProject(files: Record<string, string>): string {
  const root = tempWorkspace();
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

const TORTURE_FILES: Record<string, string> = {
  '.erd-studio/layers.json': JSON.stringify({
    schemaVersion: 1,
    layers: [{ id: 'gold', label: 'Gold layer', abbreviation: 'GLD', color: '#D4A800', creatable: true, order: 0 }],
  }),
  '.erd-studio/logical-models/fct_order.yml': [
    'name: fct_order',
    'schema: sales_mart',
    'alias: orders_v2',
    'description: "The team\'s orders — a \\"quoted\\" word, a back\\\\slash and ünïcödé\\nSecond line\\n\\n  indented third"',
    'modelRole: transaction-fact',
    'grain: |-',
    '  One row per order line',
    '  (multi-line grain)',
    'rationale:',
    '  purpose: Revenue reporting',
    '  design: "Star, with \'quotes\'"',
    '  grainChoice: Order line, not order',
    '  roleChoice: Transaction fact',
    '  scdStrategy: n/a',
    '  measures: |-',
    '    amount is additive',
    '    balance is semi-additive',
    'meta:',
    '  owner: sales-eng',
    '  Owner: someone else',
    '  json: a key that would clash with meta_json',
    '  __proto__: not a prototype',
    '  tier: 1',
    '  pii: false',
    '  nothing: null',
    '  tags: [finance, daily]',
    '  lineage: { source: erp, refresh: { cron: "0 3 * * *" } }',
    '  "has space": yes it does',
    '  multi: "line one\\nline two"',
    '  empty: ""',
    'columns:',
    '  - name: order_id',
    '    dataType: BIGINT',
    '    description: Order id',
    '    isPrimaryKey: true',
    '    isNaturalKey: true',
    '  - name: customer_key',
    '    dataType: INT',
    '    description: FK to dim_customer',
    '    isForeignKey: true',
    '  - name: legacy_ref',
    '    dataType: VARCHAR',
    '    description: Declared FK with no relationship',
    '    isForeignKey: true',
    '  - name: ship_date_key',
    '    dataType: INT',
    '    description: ""',
    '  - name: amount',
    '    dataType: DECIMAL(18,2)',
    '    description: "Line \'amount\'"',
    '    additiveType: additive',
    '    meta:',
    '      unit: EUR',
    '      precision: { scale: 2 }',
    '      __proto__: column proto',
    '  - name: balance',
    '    dataType: "double precision"',
    '    description: Running balance',
    '    additiveType: semi-additive',
    '  - name: ratio',
    '    dataType: "struct<a: int, b: string>"',
    '    additiveType: non-additive',
    '  - name: promo_code',
    '    dataType: ""',
    '  - name: "1st_flag"',
    '    dataType: "ARRAY<STRING>"',
    '  - name: note',
    '    dataType: "timestamp with time zone"',
    '  - name: pk',
    '    dataType: "varchar(255)"',
    '  - name: line_no',
    '    dataType: INT',
    '  - name: store_id',
    '    dataType: INT',
    '  - name: store_region',
    '    dataType: INT',
    '',
  ].join('\n'),
  '.erd-studio/logical-models/dim_customer.yml': [
    'name: dim_customer',
    'schema: sales_mart',
    'modelRole: conformed-dim',
    'grain: One row per customer version',
    'columns:',
    '  - name: customer_key',
    '    dataType: INT',
    '    isPrimaryKey: true',
    '    scdType: 0',
    '  - name: customer_id',
    '    dataType: VARCHAR',
    '    isNaturalKey: true',
    '    scdType: 1',
    '  - name: segment',
    '    dataType: VARCHAR',
    '    scdType: 2',
    '  - name: parent_customer_key',
    '    dataType: INT',
    '',
  ].join('\n'),
  '.erd-studio/logical-models/dim_date.yml': [
    'name: dim_date',
    'modelRole: my own role text',
    'columns:',
    '  - name: date_key',
    '    dataType: INT',
    '    isPrimaryKey: true',
    '',
  ].join('\n'),
  '.erd-studio/logical-models/customer_profile.yml': [
    'name: customer_profile',
    'schema: sales_mart',
    'columns:',
    '  - name: customer_key',
    '    dataType: INT',
    '    isPrimaryKey: true',
    '  - name: profile_ref',
    '    dataType: INT',
    '',
  ].join('\n'),
  '.erd-studio/logical-models/dim_store.yml': [
    'name: dim_store',
    'columns:',
    '  - name: store_id',
    '    dataType: INT',
    '    isPrimaryKey: true',
    '  - name: region_id',
    '    dataType: INT',
    '    isPrimaryKey: true',
    '  - name: manager_ref',
    '    dataType: INT',
    '  - name: manager_region',
    '    dataType: INT',
    '',
  ].join('\n'),
  '.erd-studio/logical-models/store_manager.yml': [
    'name: store_manager',
    'columns:',
    '  - name: manager_id',
    '    dataType: INT',
    '    isPrimaryKey: true',
    '  - name: region_id',
    '    dataType: INT',
    '    isPrimaryKey: true',
    '',
  ].join('\n'),
  '.erd-studio/logical-models/bridge_tag.yml': [
    'name: bridge_tag',
    'modelRole: factless-fact',
    'columns:',
    '  - name: tag_key',
    '    dataType: INT',
    '    isPrimaryKey: true',
    '  - name: order_id',
    '    dataType: BIGINT',
    '    isPrimaryKey: true',
    '',
  ].join('\n'),
  '.erd-studio/logical-models/dim_tag.yml': [
    'name: dim_tag',
    'columns:',
    '  - name: tag_key',
    '    dataType: INT',
    '    isPrimaryKey: true',
    '  - name: tag_name',
    '    dataType: VARCHAR',
    '',
  ].join('\n'),
  '.erd-studio/logical-models/Ref.yml': ['name: Ref', 'description: A table named like a DBML keyword', 'columns:', '  - name: Table', '    dataType: int', ''].join('\n'),
  '.erd-studio/logical-models/planned.yml': ['name: planned', 'description: Designed later — no columns yet', ''].join('\n'),
  '.erd-studio/gold/sales.json': JSON.stringify({
    schemaVersion: 5,
    domain: 'sales',
    layer: 'gold',
    description: 'Sales — orders and customers.\nSecond line with a \'quote\' and a \\ backslash',
    logical: {
      models: ['fct_order', 'dim_customer', 'dim_date', 'customer_profile', 'dim_store', 'store_manager', 'bridge_tag', 'dim_tag', 'Ref', 'planned'],
      relationships: [
        { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' },
        { fromModel: 'fct_order', fromColumn: 'ship_date_key', toModel: 'dim_date', toColumn: 'date_key', cardinality: 'many-to-one', role: 'ship date' },
        { fromModel: 'dim_date', fromColumn: 'date_key', toModel: 'fct_order', toColumn: 'line_no', cardinality: 'one-to-many', role: 'a "quoted" \\ role' },
        { fromModel: 'customer_profile', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'one-to-one' },
        { fromModel: 'customer_profile', fromColumn: 'profile_ref', toModel: 'fct_order', toColumn: 'order_id', cardinality: 'one-to-one' },
        { fromModel: 'dim_customer', fromColumn: 'parent_customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one', role: 'parent' },
        { fromModel: 'fct_order', fromColumn: 'store_id', toModel: 'dim_store', toColumn: 'store_id', cardinality: 'many-to-one', compositeKey: 'my_store_fk', role: 'sold at' },
        { fromModel: 'fct_order', fromColumn: 'store_region', toModel: 'dim_store', toColumn: 'region_id', cardinality: 'many-to-one', compositeKey: 'my_store_fk' },
        { fromModel: 'dim_store', fromColumn: 'manager_ref', toModel: 'store_manager', toColumn: 'manager_id', cardinality: 'one-to-one', compositeKey: 'mgr' },
        { fromModel: 'dim_store', fromColumn: 'manager_region', toModel: 'store_manager', toColumn: 'region_id', cardinality: 'one-to-one', compositeKey: 'mgr' },
        { fromModel: 'bridge_tag', fromColumn: 'tag_key', toModel: 'dim_tag', toColumn: 'tag_key', cardinality: 'many-to-one' },
        { fromModel: 'dim_customer', fromColumn: 'segment', toModel: 'dim_tag', toColumn: 'tag_name', cardinality: 'many-to-many', role: 'segment tags' },
        { fromModel: 'Ref', fromColumn: 'Table', toModel: 'fct_order', toColumn: 'order_id', cardinality: 'many-to-one' },
      ],
    },
    viewConfig: {
      positions: {
        fct_order: { x: 400.5, y: 200.25 },
        dim_customer: { x: -40, y: 40 },
        dim_date: { x: 40, y: 360 },
        customer_profile: { x: 0, y: 0 },
        dim_store: { x: 760, y: 200 },
        bridge_tag: { x: 760, y: 600 },
        Ref: { x: 12, y: 900 },
      },
      annotations: [
        { id: 'n1', text: 'Check the grain with finance', x: 10, y: 10, color: 'yellow', linkedModel: 'fct_order' },
        { id: 'n2', text: "Open questions:\n- promo codes?\n- the team's 'quote' \\ here", x: 300, y: 10, color: 'blue', width: 240, height: 120 },
        { id: 'n3', text: 'Green', x: 0, y: 0, color: 'green' },
        { id: 'n4', text: 'Pink', x: 0, y: 0, color: 'pink', linkedModel: 'planned' },
        { id: 'n5', text: 'Orange', x: 0, y: 0, color: 'orange' },
        { id: 'n6', text: 'No colour', x: 0, y: 0 },
      ],
    },
  }, null, 2),
};

/**
 * Edges of the text and key rules: a model in schema `public` (DBML's default
 * schema) and in a schema that needs quoting, types DBML must quote, notes
 * whose later lines are indented or that hold three quotes and a trailing
 * line break, a composite one-to-one on the whole key, a composite
 * many-to-many, a composite self-reference, two links between the same
 * columns (DBML takes one), positions with more than two decimals, a layer
 * colour that is not a hex, an empty description, two composite keys
 * between the same two tables, a one-to-one stored from a key to a column
 * that is not one, and a sticky note linked to a table that is not in the
 * diagram.
 */
const EDGE_FILES: Record<string, string> = {
  '.erd-studio/layers.json': JSON.stringify({
    schemaVersion: 1,
    layers: [{ id: 'silver', label: 'Silver', abbreviation: 'SLV', color: 'silver', creatable: true, order: 0 }],
  }),
  '.erd-studio/logical-models/in_public.yml': [
    'name: in_public',
    'schema: public',
    'description: "Line one\\n  indented two\\n  indented three\\n"',
    "grain: \"has ''' three quotes\"",
    'columns:',
    '  - name: id',
    '    dataType: "enum(\\"a\\", \\"b\\")"',
    '    isPrimaryKey: true',
    '  - name: kind',
    '    dataType: public.my_enum',
    '    description: "trailing space "',
    '  - name: back',
    '    dataType: "a\\\\b"',
    '',
  ].join('\n'),
  '.erd-studio/logical-models/odd_schema.yml': [
    'name: odd_schema',
    'schema: "sales mart.v2"',
    'columns:',
    '  - name: id',
    '    dataType: int',
    '    isPrimaryKey: true',
    '  - name: region',
    '    dataType: int',
    '    isPrimaryKey: true',
    '  - name: parent_id',
    '    dataType: int',
    '  - name: parent_region',
    '    dataType: int',
    '',
  ].join('\n'),
  '.erd-studio/logical-models/twin.yml': [
    'name: twin',
    'columns:',
    '  - name: id',
    '    dataType: int',
    '    isPrimaryKey: true',
    '  - name: region',
    '    dataType: int',
    '    isPrimaryKey: true',
    '',
  ].join('\n'),
  '.erd-studio/logical-models/tag_link.yml': [
    'name: tag_link',
    'columns:',
    ...['a', 'b', 'c', 'd', 'e', 'f'].flatMap((c) => [`  - name: ${c}`, '    dataType: int']),
    '',
  ].join('\n'),
  '.erd-studio/logical-models/person.yml': [
    'name: person',
    'columns:',
    '  - name: person_id',
    '    dataType: int',
    '    isPrimaryKey: true',
    '  - name: email',
    '    dataType: varchar',
    '',
  ].join('\n'),
  '.erd-studio/silver/edges.json': JSON.stringify({
    schemaVersion: 5,
    domain: 'edges',
    layer: 'silver',
    description: '',
    logical: {
      models: ['in_public', 'odd_schema', 'twin', 'tag_link', 'person'],
      relationships: [
        { fromModel: 'twin', fromColumn: 'id', toModel: 'odd_schema', toColumn: 'id', cardinality: 'one-to-one', compositeKey: 'k' },
        { fromModel: 'twin', fromColumn: 'region', toModel: 'odd_schema', toColumn: 'region', cardinality: 'one-to-one', compositeKey: 'k' },
        { fromModel: 'odd_schema', fromColumn: 'parent_id', toModel: 'odd_schema', toColumn: 'id', cardinality: 'many-to-one', compositeKey: 'parent' },
        { fromModel: 'odd_schema', fromColumn: 'parent_region', toModel: 'odd_schema', toColumn: 'region', cardinality: 'many-to-one', compositeKey: 'parent' },
        { fromModel: 'tag_link', fromColumn: 'a', toModel: 'twin', toColumn: 'id', cardinality: 'many-to-many', compositeKey: 'mm', role: 'tags' },
        { fromModel: 'tag_link', fromColumn: 'b', toModel: 'twin', toColumn: 'region', cardinality: 'many-to-many', compositeKey: 'mm' },
        { fromModel: 'in_public', fromColumn: 'kind', toModel: 'in_public', toColumn: 'id', cardinality: 'many-to-one' },
        { fromModel: 'in_public', fromColumn: 'id', toModel: 'in_public', toColumn: 'kind', cardinality: 'one-to-many' },
        // Two composite keys from one table to another: two labels.
        { fromModel: 'tag_link', fromColumn: 'c', toModel: 'odd_schema', toColumn: 'id', cardinality: 'many-to-one', compositeKey: 'first' },
        { fromModel: 'tag_link', fromColumn: 'd', toModel: 'odd_schema', toColumn: 'region', cardinality: 'many-to-one', compositeKey: 'first' },
        { fromModel: 'tag_link', fromColumn: 'e', toModel: 'odd_schema', toColumn: 'id', cardinality: 'many-to-one', compositeKey: 'second', role: 'second' },
        { fromModel: 'tag_link', fromColumn: 'f', toModel: 'odd_schema', toColumn: 'region', cardinality: 'many-to-one', compositeKey: 'second' },
        // A one-to-one stored from a key to a column that is not one: its FK end is still `from`.
        { fromModel: 'person', fromColumn: 'person_id', toModel: 'tag_link', toColumn: 'a', cardinality: 'one-to-one' },
      ],
    },
    viewConfig: {
      positions: { in_public: { x: 1.005, y: -2.499 }, odd_schema: { x: 1e6, y: 0.1 }, twin: { x: 3, y: 4 } },
      annotations: [{ id: 'x', text: 'Linked away', x: 0, y: 0, linkedModel: 'not_in_diagram' }],
    },
  }, null, 2),
};

// ---------------------------------------------------------------------------
// The tests
// ---------------------------------------------------------------------------

const MODES: Array<[string, { naming: Naming; libraryRelationships: boolean }]> = [
  ['v5 project, relationships in the subject area file', { naming: 'v5', libraryRelationships: false }],
  ['v6 project, relationships in the Table Library', { naming: 'v6', libraryRelationships: true }],
  ['v5 project, relationships in the Table Library', { naming: 'v5', libraryRelationships: true }],
  ['v6 project, relationships in the subject area file', { naming: 'v6', libraryRelationships: false }],
];

/** The round trip of one subject area in every mode: what came back, and its second export. */
async function checkRoundTrip(root: string, domainPath: string): Promise<void> {
  const area = await loadArea(root, domainPath);
  const layers = layersOf(root);
  for (const [label, mode] of MODES) {
    const trip = await roundTrip(area, { layers, ...mode });
    expect(canonical(trip.back), label).toEqual(canonical(area));

    // Second round: exporting what came back gives the first export again —
    // bar what the first one left out, and (in the Table Library, where they
    // are read table by table) the order of the Refs.
    const again = toDbmlRich(trip.back);
    if (mode.libraryRelationships) {
      const first = splitRefs(withoutLeftOut(trip.dbml));
      const second = splitRefs(again);
      expect(second.rest, label).toBe(first.rest);
      expect(second.refs, label).toEqual(first.refs);
    } else {
      expect(again, label).toBe(withoutLeftOut(trip.dbml));
    }
    expect(serializeDbdiagramLayout(trip.back), label).toBe(trip.layout);

    // From the second round on, the export is a fixed point, byte for byte.
    const third = await roundTrip(trip.back, { layers, ...mode });
    expect(toDbmlRich(third.back), label).toBe(again);
    expect(canonical(third.back), label).toEqual(canonical(trip.back));
  }
}

describe('DBML round trip: rich export → import → the same diagram', () => {
  describe.each(Object.entries(CORE_CASES))('core fixture %s', (name, domainPath) => {
    it('comes back the same on every exported field, and exports the same DBML again', async () => {
      await checkRoundTrip(path.join(CORE_FIXTURES, name), domainPath);
    });
  });

  describe.each(Object.entries(NAMING_CASES))('core fixture %s', (name, domainPath) => {
    it('comes back the same on every exported field, and exports the same DBML again', async () => {
      await checkRoundTrip(path.join(CORE_FIXTURES, name.replace(/ \(.*\)$/, '')), domainPath);
    });
  });

  describe.each(Object.entries(dbtProjectCases()))('dbt-project %s', (_name, domainPath) => {
    it('comes back the same on every exported field, and exports the same DBML again', async () => {
      await checkRoundTrip(DBT_PROJECT, domainPath);
    });
  });

  it('covers every core fixture project that loads', () => {
    const projects = fs
      .readdirSync(CORE_FIXTURES, { withFileTypes: true })
      // dbml/: the native DBML twins of these projects, held to their goldens through the storage comparator.
      .filter((d) => d.isDirectory() && d.name !== 'golden' && d.name !== 'errors' && d.name !== 'dbml' && !d.name.startsWith('naming-'))
      .map((d) => d.name)
      .sort();
    expect(Object.keys(CORE_CASES).sort()).toEqual(projects);
  });

  describe('the edges of the text and key rules', () => {
    it('comes back the same on every exported field, and exports the same DBML again', async () => {
      await checkRoundTrip(writeProject(EDGE_FILES), '.erd-studio/silver/edges.json');
    });

    it('keeps the schema public, quoted types, and a sticky note linked to a table not in the diagram', async () => {
      const root = writeProject(EDGE_FILES);
      const area = await loadArea(root, '.erd-studio/silver/edges.json');
      const { back } = await roundTrip(area, { layers: layersOf(root), naming: 'v5', libraryRelationships: false });
      const model = (name: string) => back.models.find((m) => m.name === name)!;
      expect(model('in_public').schema).toBe('public');
      expect(model('odd_schema').schema).toBe('sales mart.v2');
      expect(model('in_public').columns.map((c) => c.dataType)).toEqual(['enum("a", "b")', 'public.my_enum', 'a\\b']);
      expect(model('in_public').description).toBe('Line one\n  indented two\n  indented three\n');
      expect(back.viewConfig.annotations?.[0].linkedModel).toBe('not_in_diagram');
    });
  });

  describe('a project using every mapping row at its awkward edges', () => {
    it('comes back the same on every exported field, and exports the same DBML again', async () => {
      await checkRoundTrip(writeProject(TORTURE_FILES), '.erd-studio/gold/sales.json');
    });

    it.each(PARSERS)('reads back the same with %s', async (_label, parser) => {
      const root = writeProject(TORTURE_FILES);
      const area = await loadArea(root, '.erd-studio/gold/sales.json');
      const trip = await roundTrip(area, { layers: layersOf(root), naming: 'v5', libraryRelationships: false, parser });
      expect(canonical(trip.back)).toEqual(canonical(area));
    });

    it('keeps a meta key named __proto__ as an own entry, on a table and a column', async () => {
      const root = writeProject(TORTURE_FILES);
      const area = await loadArea(root, '.erd-studio/gold/sales.json');
      const { back } = await roundTrip(area, { layers: layersOf(root), naming: 'v6', libraryRelationships: true });
      const fact = back.models.find((m) => m.name === 'fct_order')!;
      expect(Object.getOwnPropertyDescriptor(fact.meta, '__proto__')?.value).toBe('not a prototype');
      expect(Object.getOwnPropertyDescriptor(fact.columns.find((c) => c.name === 'amount')!.meta, '__proto__')?.value).toBe('column proto');
    });

    it('keeps every meta entry, the text ones under lower-case keys first (the documented order change)', async () => {
      const root = writeProject(TORTURE_FILES);
      const area = await loadArea(root, '.erd-studio/gold/sales.json');
      const { back } = await roundTrip(area, { layers: layersOf(root), naming: 'v5', libraryRelationships: false });
      const keys = (a: DisplaySubjectArea) => Object.getOwnPropertyNames(a.models.find((m) => m.name === 'fct_order')!.meta);
      // `meta_<key>` properties are read before `meta_json`'s entries.
      expect(keys(back)).toEqual(['owner', '__proto__', 'tier', 'multi', 'empty', 'Owner', 'json', 'pii', 'nothing', 'tags', 'lineage', 'has space']);
      expect([...keys(back)].sort()).toEqual([...keys(area)].sort());
    });
  });
});

describe('DBML round trip: a table without columns', () => {
  const FILES: Record<string, string> = {
    '.erd-studio/logical-models/planned.yml': 'name: planned\ndescription: Designed later\n',
    '.erd-studio/logical-models/real.yml': ['name: real', 'columns:', `  - name: ${DBML_RICH_PLACEHOLDER_COLUMN}`, '    dataType: int', ''].join('\n'),
    '.erd-studio/silver/plan.json': JSON.stringify({
      schemaVersion: 5, domain: 'plan', layer: 'silver', description: 'Planned', logical: { models: ['planned', 'real'], relationships: [] }, viewConfig: {},
    }),
  };

  it.each(['v5', 'v6'] as const)('travels with a placeholder column that the import drops, end to end (%s project)', async (naming) => {
    const area = await loadArea(writeProject(FILES), '.erd-studio/silver/plan.json');
    expect(area.models.find((m) => m.name === 'planned')!.columns).toEqual([]);

    const trip = await roundTrip(area, { layers: null, naming, libraryRelationships: true });
    // DBML refuses a table without columns: the export gives it the placeholder.
    expect(trip.dbml).toContain(`Table planned {\n  ${DBML_RICH_PLACEHOLDER_COLUMN} unknown [erd_placeholder: 'true'`);
    const read = readDbml(trip.dbml);
    expect(read.ok && read.model.tables.find((t) => t.name === 'planned')!.fields.map((f) => f.name)).toEqual([DBML_RICH_PLACEHOLDER_COLUMN]);

    // The import drops it: the table file has no columns, and loads with none.
    const planned = trip.plan.newTables.find((t) => t.name === 'planned')!;
    expect(planned).toEqual({ name: 'planned', description: 'Designed later' });
    const dir = naming === 'v5' ? 'logical-models' : 'tables';
    expect(fs.readFileSync(path.join(trip.workspace, '.erd-studio', dir, 'planned.yml'), 'utf-8')).not.toContain('columns');
    expect(trip.back.models.find((m) => m.name === 'planned')!.columns).toEqual([]);

    // A real column that happens to have the placeholder's name is not the placeholder.
    expect(trip.back.models.find((m) => m.name === 'real')!.columns.map((c) => c.name)).toEqual([DBML_RICH_PLACEHOLDER_COLUMN]);
    expect(trip.plan.report.dropped).toEqual([]);

    // And it exports the same way again.
    expect(toDbmlRich(trip.back)).toBe(trip.dbml);
  });
});

describe('DBML round trip: what DBML trims (documented exceptions)', () => {
  const FILES = (extra: { description?: string; grain?: string; column?: string; sticky?: string }): Record<string, string> => ({
    '.erd-studio/logical-models/t.yml': [
      'name: t',
      `description: ${JSON.stringify(extra.description ?? '')}`,
      ...(extra.grain !== undefined ? [`grain: ${JSON.stringify(extra.grain)}`] : []),
      'columns:',
      '  - name: id',
      '    dataType: int',
      `    description: ${JSON.stringify(extra.column ?? '')}`,
      '',
    ].join('\n'),
    '.erd-studio/silver/s.json': JSON.stringify({
      schemaVersion: 5, domain: 's', layer: 'silver', description: '  Leading space in the Project note',
      logical: { models: ['t'], relationships: [] },
      viewConfig: {
        positions: { t: { x: 10.126, y: -0.004 } },
        annotations: extra.sticky ? [{ id: 'n', text: extra.sticky, x: 0, y: 0 }] : [],
      },
    }),
  });

  it('drops the white space a note starts with, and nothing else', async () => {
    const area = await loadArea(
      writeProject(FILES({ description: '\n  Starts with a line break\n  then indented', column: '   indented', sticky: '  spaced note' })),
      '.erd-studio/silver/s.json',
    );
    const { back } = await roundTrip(area, { layers: null, naming: 'v5', libraryRelationships: false });
    expect(back.description).toBe('Leading space in the Project note');
    expect(back.models[0].description).toBe('Starts with a line break\n  then indented');
    expect(back.models[0].columns[0].description).toBe('indented');
    expect(back.viewConfig.annotations?.map((a) => a.text)).toEqual(['spaced note']);
  });

  it('does not export a grain that is only white space', async () => {
    const area = await loadArea(writeProject(FILES({ grain: '   ' })), '.erd-studio/silver/s.json');
    const { back } = await roundTrip(area, { layers: null, naming: 'v5', libraryRelationships: false });
    expect(back.models[0].grain).toBeUndefined();
  });

  it('writes positions to two decimals', async () => {
    const area = await loadArea(writeProject(FILES({})), '.erd-studio/silver/s.json');
    const { back } = await roundTrip(area, { layers: null, naming: 'v5', libraryRelationships: false });
    expect(back.viewConfig.positions).toEqual({ t: { x: 10.13, y: 0 } });
  });
});

describe('foreign DBML → ERD Studio → rich DBML', () => {
  /** Every DBML file under test/fixtures/dbml, with the `.dbdiagram` beside it when there is one. */
  const files = (fs.readdirSync(path.resolve(FOREIGN, '..'), { recursive: true }) as string[])
    .filter((f) => f.endsWith('.dbml'))
    .sort();

  it('has files to read', () => {
    expect(files).toEqual(expect.arrayContaining(['foreign/ecommerce.dbml', 'foreign/odd-names.dbml', 'foreign/sticky-groups.dbml']));
  });

  it.each(files)('%s: imports, exports as rich DBML every parser reads with no diagnostic, and imports the same again', async (file) => {
    const full = path.resolve(FOREIGN, '..', file);
    const layoutFile = full.replace(/\.dbml$/, '.dbdiagram');
    const read = readDbml(fs.readFileSync(full, 'utf-8'));
    if (!read.ok) throw new Error(JSON.stringify(read.diagnostics));

    const workspace = tempWorkspace();
    fs.mkdirSync(path.join(workspace, '.erd-studio'), { recursive: true });
    const library = new TableLibraryService(workspace);
    const lib = { findTableName: (n: string) => library.findTableNameIgnoringCase(n), getTable: (n: string) => library.getTable(n) };
    const plan = planDbmlImport({
      model: read.model,
      ...(fs.existsSync(layoutFile) ? { layout: readDbdiagramLayout(fs.readFileSync(layoutFile, 'utf-8')) } : {}),
      layer: 'silver',
      subjectAreaName: 'imported',
      fileName: path.basename(file),
      library: lib,
      libraryRelationships: true,
    });
    for (const table of plan.newTables) library.saveTable(table);
    const domainPath = '.erd-studio/silver/imported.json';
    fs.mkdirSync(path.join(workspace, '.erd-studio', 'silver'));
    fs.writeFileSync(path.join(workspace, domainPath), serializeDbmlImportDocument(plan.document, library.writesTableNaming()));
    const area = await loadArea(workspace, domainPath);
    expect(area.models.map((m) => m.name)).toEqual(plan.modelNames);

    // No error, no warning, and no lint info — bar one the foreign file's own
    // model draws in the same parser: a many-to-many on a key column, say, is
    // what that file says, and the export keeps saying it (MODEL_LINT_INFOS).
    const rich = toDbmlRich(area);
    const source = parseDbmlRich(fs.readFileSync(full, 'utf-8'));
    parseDbmlRich(rich).forEach((parse, i) => {
      const own = MODEL_LINT_INFOS.filter((pattern) => source[i].diagnostics.some((d) => d.type === 'info' && pattern.test(d.text)));
      const refused = parse.diagnostics.filter((d) => d.type !== 'info' || !own.some((pattern) => pattern.test(d.text)));
      expect(refused, `${parse.parser}\n${rich}`).toEqual([]);
    });
    readDbmlRich(rich, { infos: 'model' }); // The three parsers read it the same.

    // What ERD Studio made of the foreign file survives its own round trip.
    for (const [label, mode] of MODES) {
      const trip = await roundTrip(area, { layers: null, ...mode });
      expect(canonical(trip.back), label).toEqual(canonical(area));
    }
  });
});

describe('DBML round trip: back into its own project', () => {
  it.each(Object.entries(CORE_CASES))('%s: reuses every table it has, as it is, and draws the same diagram', async (name, domainPath) => {
    for (const libraryRelationships of [false, true]) {
      const label = libraryRelationships ? 'relationships in the Table Library' : 'relationships in the subject area file';
      const ws = tempWorkspace();
      fs.cpSync(path.join(CORE_FIXTURES, name), ws, { recursive: true });
      const area = await loadArea(ws, domainPath);
      const read = readDbml(toDbmlRich(area));
      if (!read.ok) throw new Error(JSON.stringify(read.diagnostics));
      const library = new TableLibraryService(ws);
      const absent = area.models.map((m) => m.name).filter((n) => library.findTableNameIgnoringCase(n) === null);
      const plan = planDbmlImport({
        model: read.model,
        layout: readDbdiagramLayout(serializeDbdiagramLayout(area)),
        layer: area.layer,
        subjectAreaName: 'copy',
        library: { findTableName: (n) => library.findTableNameIgnoringCase(n), getTable: (n) => library.getTable(n) },
        libraryRelationships,
      });
      // Only a table whose file is missing is made; the rest are the library's.
      expect(plan.newTables.map((t) => t.name), label).toEqual([...new Set(absent)]);
      expect(plan.report.renamed, label).toEqual([]);

      for (const t of plan.newTables) library.saveTable(t);
      const copyPath = `.erd-studio/${area.layer}/copy.json`;
      fs.writeFileSync(path.join(ws, copyPath), serializeDbmlImportDocument(plan.document, library.writesTableNaming()), { flag: 'wx' });
      for (const t of plan.changedLibraryTables) library.saveTable(t);

      expect({ ...canonical(await loadArea(ws, copyPath)), domain: area.domain }, label).toEqual(canonical(area));
      // And the subject area it came from still draws as it did.
      expect(canonical(await loadArea(ws, domainPath)), label).toEqual(canonical(area));
    }
  });
});
