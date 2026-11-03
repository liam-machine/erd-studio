/**
 * A test-only applier for `.sync-plan.json` that does what SYNC.md (the
 * `SYNC_CONTENT` an assistant reads, `src/services/harnessService.ts`) tells
 * the assistant to do, row by row, and nothing else. Every branch below names
 * the SYNC.md row it follows. The extension never applies a plan itself (the
 * assistant does), so this is the only check that SYNC.md's instructions,
 * followed literally, leave files that read, compile and compare clean.
 *
 * DBML is written as SYNC.md and DBML.md spell it (column lines, Ref lines,
 * `use` lines) by text edits, as an assistant would (a new table file is
 * the `Table <schema>.<name> { }` block SYNC.md names, columns added). The
 * dbt schema yml is edited in place with the yaml Document API, so comments,
 * key order and unknown keys survive ("Match existing patterns").
 *
 * Also: the scenario (a copy of `dbt-project-dbml`, or `dbt-project` for
 * parity, with a few changes so the plan holds every kind of entry), and the
 * provider round trip (Compare, then Sync) that writes the plan.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { vi, expect } from 'vitest';
import { isMap, isScalar, isSeq, parseDocument, type Document, type YAMLMap, type YAMLSeq } from 'yaml';

import { createMockTextDocument, createMockWebviewPanel } from '../__mocks__/vscode';
import { SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { ManifestService } from '../../src/services/manifestService';
import { YmlParserService } from '../../src/services/ymlParserService';
import { CatalogService } from '../../src/services/catalogService';
import { TemplateService } from '../../src/services/templateService';
import { SelectorsService } from '../../src/services/selectorsService';
import type { DiscrepancyReport } from '../../src/types/discrepancy';
import type { Cardinality } from '../../src/types/semantic';
import type { ColumnResolution, GroundTruth, RelationshipResolution, SyncPlan, TableContext } from '../../src/types/syncPlan';

export const FIXTURES = path.resolve(__dirname, '../fixtures');
const REPO_ROOT = path.resolve(__dirname, '../..');

export type Storage = 'yaml' | 'dbml';
export const FIXTURE_OF: Record<Storage, string> = { yaml: 'dbt-project', dbml: 'dbt-project-dbml' };
/** The showcase diagram, relative to the semantic dir. */
export const SHOWCASE: Record<Storage, string> = { yaml: 'silver/showcase.json', dbml: 'silver/diagrams/showcase.dbml' };

// ---------------------------------------------------------------------------
// The scenario
// ---------------------------------------------------------------------------

/** A temp copy of `storage`'s fixture, timestamps kept (manifest staleness reads them). */
export function copyFixture(storage: Storage, parent: string = os.tmpdir()): string {
  const root = fs.mkdtempSync(path.join(parent, `erd-sync-apply-${storage}-`));
  fs.cpSync(path.join(FIXTURES, FIXTURE_OF[storage]), root, { recursive: true, preserveTimestamps: true });
  fs.rmSync(path.join(root, '.erd-studio', '.sync-plan.json'), { force: true });
  return root;
}

/** The dbt yml of the one model the scenario adds to dbt (a staged payments model). */
export const STG_RAW_PAYMENTS_YML = [
  'version: 2',
  'models:',
  '  - name: stg_raw_payments',
  '    description: Raw payments, staged',
  '    columns:',
  '      - name: payment_id',
  '        data_type: integer',
  '        tests: [unique, not_null]',
  '      - name: order_id',
  '        data_type: integer',
  '        tests:',
  '          - relationships:',
  "              to: ref('fct_order')",
  '              field: order_id',
  '      - name: amount',
  '        data_type: numeric(15,2)',
  '      - name: payment_method',
  '        data_type: varchar',
  '',
].join('\n');

/**
 * The showcase diagram changed so the plan holds every kind of entry:
 *
 * - fct_order's two Refs moved to their own relationships file
 *   (`orders.dbml`, imported by the diagram), its customer_key Ref deleted
 *   (dbt tests it: a new Ref, whose `relationshipsPath` must be `orders.dbml`,
 *   the file holding most of fct_order's Refs) and its project_key Ref made
 *   one-to-one (dbt says many-to-one: a cardinality change in `storedIn`);
 * - `stg_raw_payments`, a dbt model with no table file yet, put on the
 *   diagram, with a dbt relationships test to fct_order: a new table file and
 *   a new Ref whose table has no file;
 * - a comment and an unknown key in two schema yml files, which every edit
 *   must keep.
 *
 * The YAML/JSON twin gets the same changes in its own format.
 */
export function applyScenario(root: string, storage: Storage): void {
  const erd = path.join(root, '.erd-studio');
  if (storage === 'dbml') {
    const silverRefs = path.join(erd, 'silver', 'relationships', 'silver.dbml');
    let text = fs.readFileSync(silverRefs, 'utf-8');
    const moved = 'Ref: public.fct_order.customer_key >? silver.dim_customer.customer_key\nRef: public.fct_order.project_key >? silver.dim_project.project_key\n\n';
    const fctOrderUse = "use { table public.fct_order }      from '../tables/public/fct_order.dbml'\n";
    expect(text).toContain(moved);
    expect(text).toContain(fctOrderUse);
    text = text.replace(moved, '').replace(fctOrderUse, '');
    fs.writeFileSync(silverRefs, text);
    fs.writeFileSync(path.join(erd, 'silver', 'relationships', 'orders.dbml'), [
      '// ERD Studio relationships: Refs only, split across relationships/ files however you like. Every table a Ref names has a use line here.',
      "use { table public.fct_order }   from '../tables/public/fct_order.dbml'",
      "use { table silver.dim_project } from '../tables/silver/dim_project.dbml'",
      '',
      'Ref: public.fct_order.project_key - silver.dim_project.project_key',
      '',
    ].join('\n'));
    const showcase = path.join(erd, ...SHOWCASE.dbml.split('/'));
    let diagram = fs.readFileSync(showcase, 'utf-8');
    const lastUse = "use { table public.fct_order }      from '../tables/public/fct_order.dbml'\n";
    const silverImport = "use * from '../relationships/silver.dbml'\n";
    expect(diagram).toContain(lastUse);
    expect(diagram).toContain(silverImport);
    diagram = diagram
      .replace(lastUse, `${lastUse}use { table silver.stg_raw_payments } from '../tables/silver/stg_raw_payments.dbml'\n`)
      .replace(silverImport, `use * from '../relationships/orders.dbml'\n${silverImport}`);
    fs.writeFileSync(showcase, diagram);
  } else {
    const showcase = path.join(erd, ...SHOWCASE.yaml.split('/'));
    const doc = JSON.parse(fs.readFileSync(showcase, 'utf-8')) as { logical: { models: string[]; relationships: Array<Record<string, string>> } };
    const isOrderRef = (r: Record<string, string>, col: string): boolean => r.fromModel === 'fct_order' && r.fromColumn === col;
    expect(doc.logical.relationships.some((r) => isOrderRef(r, 'customer_key'))).toBe(true);
    doc.logical.relationships = doc.logical.relationships.filter((r) => !isOrderRef(r, 'customer_key'));
    const projectRef = doc.logical.relationships.find((r) => isOrderRef(r, 'project_key'))!;
    projectRef.cardinality = 'one-to-one';
    doc.logical.models.push('stg_raw_payments');
    fs.writeFileSync(showcase, `${JSON.stringify(doc, null, 2)}\n`);
  }
  // The dbt side is the same files in both fixtures.
  fs.mkdirSync(path.join(root, 'models', 'staging'), { recursive: true });
  fs.writeFileSync(path.join(root, 'models', 'staging', 'stg_raw_payments.yml'), STG_RAW_PAYMENTS_YML);
  const dimCustomer = path.join(root, 'models', 'silver', 'dim_customer.yml');
  fs.writeFileSync(dimCustomer, fs.readFileSync(dimCustomer, 'utf-8')
    .replace('version: 2\n', '# Owned by the CRM squad — keep the tests in step with the source system\nversion: 2\n')
    .replace('    config:\n', '    meta:\n      owner: crm-squad # who to ask\n    config:\n'));
  const fctOrder = path.join(root, 'models', 'silver', 'fct_order.yml');
  fs.writeFileSync(fctOrder, fs.readFileSync(fctOrder, 'utf-8')
    .replace('      - name: project_key\n', '      # project_key is checked against the project dimension\n      - name: project_key\n'));
}

// ---------------------------------------------------------------------------
// The provider round trip
// ---------------------------------------------------------------------------

type Posted = { type: string; payload?: any; requestId?: number };
type Panel = ReturnType<typeof createMockWebviewPanel>;

function buildProvider(root: string): SemanticEditorProvider {
  const layerService = new LayerService(root, '.erd-studio');
  const subjectAreaService = new SubjectAreaService(layerService);
  const tableLibraryService = new TableLibraryService(root, '.erd-studio');
  subjectAreaService.setTableLibraryService(tableLibraryService);
  const selectorsService = new SelectorsService(subjectAreaService, root, '.erd-studio');
  vi.spyOn(selectorsService, 'scheduleRegenerate').mockImplementation(() => undefined);
  const context = {
    extensionUri: vscode.Uri.file(REPO_ROOT),
    globalStorageUri: vscode.Uri.file(path.join(root, '.global-storage')),
    extension: { packageJSON: { version: '0.0.0-test' } },
    globalState: { get: () => true, update: async () => {} },
    workspaceState: vscode.createMockMemento(),
    secrets: vscode.createMockSecretStorage(),
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
  const provider = new SemanticEditorProvider(
    context, subjectAreaService, new ManifestService({ parseInProcess: true }), new YmlParserService(), new TemplateService(),
    layerService, root, selectorsService, tableLibraryService,
  );
  provider.setCatalogService(new CatalogService());
  return provider;
}

const posted = (panel: Panel): Posted[] => panel._postedMessages as Posted[];
export const errorsOf = (panel: Panel): string[] => posted(panel).filter((m) => m.type === 'error').map((m) => String(m.payload?.message));

async function waitFor(panel: Panel, type: string, test: (m: Posted) => boolean = () => true): Promise<Posted> {
  await vi.waitFor(() => expect(posted(panel).some((m) => m.type === type && test(m))).toBe(true), { timeout: 8000, interval: 10 });
  return posted(panel).filter((m) => m.type === type && test(m)).at(-1)!;
}

/** Open `diagram` (relative to the semantic dir) on a fresh canvas and run Compare with dbt. */
export async function compare(root: string, diagram: string): Promise<{ panel: Panel; report: DiscrepancyReport }> {
  const provider = buildProvider(root);
  const file = path.join(root, '.erd-studio', ...diagram.split('/'));
  const document = createMockTextDocument(file, fs.readFileSync(file, 'utf-8'), { persist: true });
  (vscode.workspace.textDocuments as unknown[]).push(document);
  const panel = createMockWebviewPanel();
  await provider.resolveCustomTextEditor(document as unknown as vscode.TextDocument, panel as unknown as vscode.WebviewPanel, {} as vscode.CancellationToken);
  await panel._simulateMessage({ type: 'ready' });
  await waitFor(panel, 'domainLoaded');
  await panel._simulateMessage({ type: 'toggleDiscrepancy', payload: { enabled: true, compareAgainst: 'physical' } });
  const report = (await waitFor(panel, 'discrepancyReport', (m) => !!m.payload)).payload as DiscrepancyReport;
  return { panel, report };
}

/** Compare, then Sync with `selections` (keys as `allSelections` builds them): the plan the canvas writes. */
export async function generatePlan(
  root: string,
  diagram: string,
  choose: (report: DiscrepancyReport) => Record<string, GroundTruth>,
): Promise<{ plan: SyncPlan; report: DiscrepancyReport }> {
  const { panel, report } = await compare(root, diagram);
  await panel._simulateMessage({ type: 'generateSyncPlan', payload: { selections: choose(report) } });
  await waitFor(panel, 'syncPlanGenerated');
  expect(errorsOf(panel)).toEqual([]);
  const plan = JSON.parse(fs.readFileSync(path.join(root, '.erd-studio', '.sync-plan.json'), 'utf-8')) as SyncPlan;
  return { plan, report };
}

// ---------------------------------------------------------------------------
// The applier
// ---------------------------------------------------------------------------

/** What the applier did, for the assertions (project-relative paths). */
export interface ApplyLog {
  /** Entries skipped, with the reason (SYNC.md tells the assistant to skip them). */
  skipped: string[];
  /** Files written or created. */
  touched: Set<string>;
}

const abs = (root: string, rel: string): string => path.join(root, ...rel.split('/'));
const projectRel = (root: string, file: string): string => path.relative(root, file).split(path.sep).join('/');
const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

function write(root: string, log: ApplyLog, file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  log.touched.add(projectRel(root, file));
}

function contextOf(plan: SyncPlan, model: string): TableContext {
  const ctx = plan.modelContext[model];
  if (!ctx) throw new Error(`the plan has no modelContext for ${model}`);
  return ctx;
}

/**
 * The cardinality to write: the ground truth's. SYNC.md: "`sourceCardinality`
 * when the entry's `groundTruth` is the plan's `sourceStage`, else
 * `targetCardinality`" (both `update-cardinality-*` rows).
 */
function resolvedCardinality(plan: SyncPlan, r: RelationshipResolution): Cardinality {
  const c = r.groundTruth === plan.sourceStage ? r.sourceCardinality : r.targetCardinality;
  if (!c) throw new Error(`no cardinality to write for ${r.fromModel}.${r.fromColumn}`);
  return c;
}

/**
 * Apply `plan` to the project at `root` as SYNC.md's "Execution Steps" say:
 * every entry in order (models, columns, relationships), each in the format of
 * the file it touches. Destructive entries are applied too (a test has no user
 * to confirm with). `dbt compile` is not run (no dbt here); the plan file is
 * deleted at the end ("Clean up").
 */
export function applySyncPlan(root: string, plan: SyncPlan): ApplyLog {
  const log: ApplyLog = { skipped: [], touched: new Set() };
  // Table-level entries: the scenarios here produce none (a diagram member dbt
  // lacks is a phantom, one dbt has and the diagram lacks never reaches the
  // physical stage), so the four table rows are not exercised.
  for (const m of plan.models) throw new Error(`table entry ${m.action} for ${m.modelName}: not exercised by this applier`);
  for (const c of plan.columns) applyColumn(root, plan, c, log);
  for (const r of plan.relationships) applyRelationship(root, plan, r, log);
  // Execution Steps 5: "Delete .erd-studio/.sync-plan.json on success".
  fs.rmSync(path.join(root, '.erd-studio', '.sync-plan.json'), { force: true });
  return log;
}

function applyColumn(root: string, plan: SyncPlan, c: ColumnResolution, log: ApplyLog): void {
  const ctx = contextOf(plan, c.modelName);
  switch (c.action) {
    case 'add-column-to-logical':
    case 'remove-column-from-logical':
    case 'update-type-in-logical':
      if (c.action === 'update-type-in-logical' && !c.resolvedDataType) {
        // SYNC.md, Action Reference: "When `resolvedDataType` is empty, the
        // ground truth declares no type: skip the entry".
        log.skipped.push(`${c.action} ${c.modelName}.${c.columnName}: resolvedDataType is empty`);
        return;
      }
      if (ctx.logicalModelPath.endsWith('.dbml')) dbmlColumn(root, c, ctx, log);
      else legacyColumn(root, plan, c, ctx, log);
      return;
    case 'add-column-to-physical':
    case 'remove-column-from-physical':
    case 'update-type-in-physical':
      if (c.action === 'update-type-in-physical' && !c.resolvedDataType) {
        log.skipped.push(`${c.action} ${c.modelName}.${c.columnName}: resolvedDataType is empty`);
        return;
      }
      physicalColumn(root, c, ctx, log);
      return;
  }
}

function applyRelationship(root: string, plan: SyncPlan, r: RelationshipResolution, log: ApplyLog): void {
  const from = contextOf(plan, r.fromModel);
  switch (r.action) {
    case 'add-relationship-to-logical':
    case 'remove-relationship-from-logical':
    case 'update-cardinality-in-logical':
      if (from.logicalModelPath.endsWith('.dbml')) dbmlRelationship(root, plan, r, from, log);
      else legacyRelationship(root, plan, r, log);
      return;
    case 'add-relationship-test-to-physical':
    case 'remove-relationship-test-from-physical':
    case 'update-cardinality-in-physical':
      physicalRelationship(root, plan, r, from, log);
      return;
  }
}

// ---------------------------------------------------------------------------
// Logical side, DBML (SYNC.md "Logical-side actions", the DBML table)
// ---------------------------------------------------------------------------

/** A DBML type as SYNC.md says to write it: "double-quoted when it is not a plain identifier". */
function dbmlType(type: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(type) ? type : `"${type.replace(/"/g, '\\"')}"`;
}

/** `<layer>/tables/<schema>/<name>.dbml` → { layer, schema }. */
function tablePathParts(rel: string): { layer: string; schema: string } {
  const m = /^\.erd-studio\/([^/]+)\/tables\/([^/]+)\/[^/]+\.dbml$/.exec(rel);
  if (!m) throw new Error(`not a DBML table path: ${rel}`);
  return { layer: m[1], schema: m[2] };
}

/** The [start, end) line range of column `name` in a Table block (a multi-line `[ … ]` setting list included). */
function columnLines(lines: string[], name: string): [number, number] | undefined {
  const head = new RegExp(`^\\s+"?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"?\\s`, 'i');
  const start = lines.findIndex((l) => head.test(l) && !/^\s*(Note|indexes)\b/i.test(l));
  if (start < 0) return undefined;
  let end = start + 1;
  if (/\[\s*$/.test(lines[start])) {
    while (end < lines.length && !/^\s*\]\s*$/.test(lines[end])) end++;
    end++;
  }
  return [start, end];
}

function dbmlColumn(root: string, c: ColumnResolution, ctx: TableContext, log: ApplyLog): void {
  const file = abs(root, ctx.logicalModelPath);
  if (c.action === 'add-column-to-logical') {
    // add-column-to-logical: "Add a column line to the Table block in
    // `logicalModelPath` (`name TYPE [note: '…']`)" — "when there is no file
    // at `logicalModelPath` yet (a diagram member with no table file), create
    // it first: `Table <schema>.<name> { }`, the schema its folder".
    if (!fs.existsSync(file)) {
      const { schema } = tablePathParts(ctx.logicalModelPath);
      write(root, log, file, `Table ${schema}.${c.modelName} {\n}\n`);
    }
    const lines = fs.readFileSync(file, 'utf-8').split('\n');
    // "Column ordering": after the table's last column, before its `indexes` block.
    let close = lines.findIndex((l) => /^\s*indexes\s*\{/.test(l));
    if (close < 0) close = lines.findIndex((l) => /^\}\s*$/.test(l));
    if (close < 0) {
      // A table rendered with no columns: `Table s.x {}` on one line.
      const one = lines.findIndex((l) => /^Table\b.*\{\s*\}\s*$/.test(l));
      lines.splice(one, 1, lines[one].replace(/\{\s*\}\s*$/, '{'), '}');
      close = one + 1;
    }
    lines.splice(close, 0, `  ${c.columnName} ${dbmlType(c.resolvedDataType ?? '')}`);
    write(root, log, file, lines.join('\n'));
    return;
  }
  const lines = fs.readFileSync(file, 'utf-8').split('\n');
  const span = columnLines(lines, c.columnName);
  if (!span) throw new Error(`${c.columnName} is not a column of ${ctx.logicalModelPath}`);
  if (c.action === 'remove-column-from-logical') {
    // remove-column-from-logical: "Delete the column's line from
    // `logicalModelPath`, and every Ref in a relationships file that names it".
    lines.splice(span[0], span[1] - span[0]);
    write(root, log, file, lines.join('\n'));
    const { schema } = tablePathParts(ctx.logicalModelPath);
    const end = new RegExp(`(^|[\\s(,])${schema}\\.${c.modelName}\\.${c.columnName}(?=[\\s),]|$)`, 'i');
    for (const refsFile of relationshipsFiles(root)) {
      const text = fs.readFileSync(refsFile, 'utf-8');
      const kept = text.split('\n').filter((l) => !(/^Ref\b/.test(l) && end.test(l.replace(/^Ref[^:]*:/, ' '))));
      if (kept.join('\n') !== text) write(root, log, refsFile, kept.join('\n'));
    }
    return;
  }
  // update-type-in-logical: "Change the column's type in `logicalModelPath` to
  // `resolvedDataType` (double-quoted when it is not a plain identifier)".
  const line = lines[span[0]];
  const m = /^(\s+"?[^\s"]+"?\s+)("[^"]*"|\S+)(.*)$/.exec(line);
  if (!m) throw new Error(`cannot read the type on: ${line}`);
  lines[span[0]] = `${m[1]}${dbmlType(c.resolvedDataType!)}${m[3]}`;
  write(root, log, file, lines.join('\n'));
}

/** Every relationships file of the project (absolute). */
function relationshipsFiles(root: string): string[] {
  const erd = path.join(root, '.erd-studio');
  return fs.readdirSync(erd, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => {
      const dir = path.join(erd, d.name, 'relationships');
      return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.dbml')).map((f) => path.join(dir, f)) : [];
    });
}

/** Every DBML diagram of the project (absolute). */
function diagramFiles(root: string): string[] {
  const erd = path.join(root, '.erd-studio');
  return fs.readdirSync(erd, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => {
      const dir = path.join(erd, d.name, 'diagrams');
      return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.dbml')).map((f) => path.join(dir, f)) : [];
    });
}

/** "each end spelled as its table declares itself": `<schema>.<name>` from the table file's `Table` line. */
function declaredName(root: string, plan: SyncPlan, model: string): { qualified: string; file: string } {
  const file = abs(root, contextOf(plan, model).logicalModelPath);
  const header = /^Table\s+("?[^\s".]+"?)\.("?[^\s"[{]+"?)/m.exec(fs.readFileSync(file, 'utf-8'));
  if (!header) throw new Error(`no Table line in ${file}`);
  return { qualified: `${header[1]}.${header[2]}`, file };
}

/** A `use` path from `fromFile` to `toFile`, as DBML.md spells them (`../tables/…`, `../../<layer>/…`). */
function usePath(fromFile: string, toFile: string): string {
  const rel = path.relative(path.dirname(fromFile), toFile).split(path.sep).join('/');
  return rel.startsWith('.') ? rel : `./${rel}`;
}

/** Insert `line` after the last `use` line of `lines` (or after a leading header comment). */
function insertUse(lines: string[], line: string): void {
  let at = -1;
  lines.forEach((l, i) => { if (/^use\b/.test(l)) at = i; });
  if (at < 0) at = /^\/\//.test(lines[0] ?? '') ? 0 : -1;
  lines.splice(at + 1, 0, line);
}

/** The diagrams that draw both tables (`use { table … }` of each) and lack `use * from '<refsFile>'`: add it. */
function importInDiagrams(root: string, refsFile: string, ends: Array<{ qualified: string }>, log: ApplyLog): void {
  for (const diagram of diagramFiles(root)) {
    const lines = fs.readFileSync(diagram, 'utf-8').split('\n');
    const uses = (q: string): boolean => lines.some((l) => new RegExp(`^use\\s*\\{\\s*table\\s+${q.replace(/\./g, '\\.')}\\s*\\}`, 'i').test(l));
    if (!ends.every((e) => uses(e.qualified))) continue;
    const wanted = usePath(diagram, refsFile);
    if (lines.some((l) => new RegExp(`^use\\s*\\*\\s*from\\s*'${wanted.replace(/[.]/g, '\\.')}'`).test(l))) continue;
    insertUse(lines, `use * from '${wanted}'`);
    write(root, log, diagram, lines.join('\n'));
  }
}

/** A Ref's two ends as `{ table, column }` (lower-case), from a `Ref…: a.b.c OP d.e.f` line. */
function refEnds(line: string): { op: string; left: string; right: string; prefix: string; tail: string } | undefined {
  const m = /^(Ref[^:]*:\s*)(\S+)\s+(<>\?|<>|>\?|\?-|-\?|>|<|-)\s+(\S+?)(\s*\[.*\])?\s*$/.exec(line);
  if (!m) return undefined;
  return { prefix: m[1], left: m[2], op: m[3], right: m[4], tail: m[5] ?? '' };
}

const endIs = (end: string, model: string, column: string): boolean => {
  const parts = end.replace(/"/g, '').split('.');
  return sameName(parts.at(-2) ?? '', model) && sameName(parts.at(-1) ?? '', column);
};

function refLine(prefix: string, fk: string, pk: string, cardinality: Cardinality, tail = ''): string {
  // "`Ref: s.fk_table.fk_col >? s.pk_table.pk_col` for many-to-one,
  // `Ref: s.pk_table.pk_col ?- s.fk_table.fk_col` for one-to-one, `<>?` for
  // many-to-many … A `one-to-many` is written from the other end as `>?`".
  switch (cardinality) {
    case 'many-to-one': return `${prefix}${fk} >? ${pk}${tail}`;
    case 'one-to-many': return `${prefix}${pk} >? ${fk}${tail}`;
    case 'one-to-one': return `${prefix}${pk} ?- ${fk}${tail}`;
    case 'many-to-many': return `${prefix}${fk} <>? ${pk}${tail}`;
    default: throw new Error(`unknown cardinality ${String(cardinality)}`);
  }
}

function dbmlRelationship(root: string, plan: SyncPlan, r: RelationshipResolution, from: TableContext, log: ApplyLog): void {
  const fk = declaredName(root, plan, r.fromModel);
  const pk = declaredName(root, plan, r.toModel);
  const matches = (l: string): boolean => {
    const e = refEnds(l);
    if (!e) return false;
    return (endIs(e.left, r.fromModel, r.fromColumn) && endIs(e.right, r.toModel, r.toColumn))
      || (endIs(e.right, r.fromModel, r.fromColumn) && endIs(e.left, r.toModel, r.toColumn));
  };
  if (r.action === 'add-relationship-to-logical') {
    if (r.storedIn) {
      // "When the entry has `storedIn`, the Ref is already there: leave it, and
      // add a `use * from '…'` line for `storedIn` to the diagram".
      importInDiagrams(root, abs(root, r.storedIn), [fk, pk], log);
      return;
    }
    // "Otherwise add one Ref line to `relationshipsPath` of the many-side (FK)
    // table" — the plan gives one for a table with no file too; "for a DBML
    // table with no `relationshipsPath` (a plan written by an older ERD
    // Studio)", its layer's default file, `<layer>/relationships/<layer>.dbml`,
    // the layer of `logicalModelPath`.
    let rel = from.relationshipsPath;
    if (!rel) {
      const { layer } = tablePathParts(from.logicalModelPath);
      rel = `.erd-studio/${layer}/relationships/${layer}.dbml`;
    }
    const refsFile = abs(root, rel);
    const existed = fs.existsSync(refsFile);
    const lines = existed
      ? fs.readFileSync(refsFile, 'utf-8').split('\n')
      : ['// ERD Studio relationships: Refs only, split across relationships/ files however you like. Every table a Ref names has a use line here.', ''];
    // "plus a `use { table s.x }` line there for each table it names that the file does not import".
    for (const end of [fk, pk]) {
      const want = `use { table ${end.qualified} } from '${usePath(refsFile, end.file)}'`;
      if (!lines.some((l) => new RegExp(`^use\\s*\\{\\s*table\\s+${end.qualified.replace(/\./g, '\\.')}\\s*\\}`, 'i').test(l))) insertUse(lines, want);
    }
    while (lines.length && lines.at(-1) === '') lines.pop();
    // "one blank line between the Refs of each foreign-key table" (DBML.md).
    lines.push('', refLine('Ref: ', `${fk.qualified}.${r.fromColumn}`, `${pk.qualified}.${r.toColumn}`, resolvedCardinality(plan, r)), '');
    write(root, log, refsFile, lines.join('\n'));
    // "and a `use * from '…'` line for that file in every diagram that shows both tables and lacks it".
    importInDiagrams(root, refsFile, [fk, pk], log);
    return;
  }
  if (!r.storedIn) throw new Error(`${r.action} for ${r.fromModel}.${r.fromColumn} has no storedIn`);
  const refsFile = abs(root, r.storedIn);
  const lines = fs.readFileSync(refsFile, 'utf-8').split('\n');
  const at = lines.findIndex(matches);
  if (at < 0 && r.action === 'remove-relationship-from-logical') {
    // An earlier entry's cascade ("remove-column-from-logical: … and every Ref
    // in a relationships file that names it") already deleted it.
    log.skipped.push(`${r.action} ${r.fromModel}.${r.fromColumn}: already removed with its column`);
    return;
  }
  if (at < 0) throw new Error(`no Ref for ${r.fromModel}.${r.fromColumn} in ${r.storedIn}`);
  if (r.action === 'remove-relationship-from-logical') {
    // "Delete the matching Ref line from the relationships file that holds it (`storedIn`). Leave the `use` lines".
    lines.splice(at, 1);
  } else {
    // update-cardinality-in-logical: "Rewrite the matching Ref's operator to
    // the cardinality to write, in place in `storedIn`".
    const e = refEnds(lines[at])!;
    const fkEnd = endIs(e.left, r.fromModel, r.fromColumn) ? e.left : e.right;
    const pkEnd = fkEnd === e.left ? e.right : e.left;
    lines[at] = refLine(e.prefix, fkEnd, pkEnd, resolvedCardinality(plan, r), e.tail);
  }
  write(root, log, refsFile, lines.join('\n'));
}

// ---------------------------------------------------------------------------
// Logical side, YAML/JSON (SYNC.md "Legacy" table)
// ---------------------------------------------------------------------------

function editYaml(root: string, log: ApplyLog, file: string, edit: (doc: Document) => void, create?: () => string): void {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : create?.();
  if (text === undefined) throw new Error(`no file ${file}`);
  const doc = parseDocument(text);
  edit(doc);
  write(root, log, file, doc.toString());
}

function seqItemByName(seq: unknown, name: string): YAMLMap | undefined {
  if (!isSeq(seq)) return undefined;
  return (seq as YAMLSeq).items.find((i): i is YAMLMap => isMap(i) && sameName(String((i as YAMLMap).get('name')), name));
}

function legacyColumn(root: string, plan: SyncPlan, c: ColumnResolution, ctx: TableContext, log: ApplyLog): void {
  const file = abs(root, ctx.logicalModelPath);
  editYaml(root, log, file, (doc) => {
    if (!isSeq(doc.get('columns'))) doc.set('columns', doc.createNode([]));
    const columns = doc.get('columns') as YAMLSeq;
    if (c.action === 'add-column-to-logical') {
      // "Add column to the model's yml (`logicalModelPath`) columns array".
      columns.add(doc.createNode({ name: c.columnName, dataType: c.resolvedDataType }));
    } else if (c.action === 'remove-column-from-logical') {
      // "Remove column from the model's yml (`logicalModelPath`)".
      columns.items = columns.items.filter((i) => !(isMap(i) && sameName(String(i.get('name')), c.columnName)));
    } else {
      // "Update column `dataType` … to the value in `resolvedDataType`".
      seqItemByName(columns, c.columnName)!.set('dataType', c.resolvedDataType);
    }
  }, () => `name: ${c.modelName}\ncolumns: []\n`);
  if (c.action === 'remove-column-from-logical') {
    // Important Notes, "Cascade deletions": "When renaming or deleting a table
    // or column, update every … relationships entry that points at it".
    editDomainJson(root, plan, log, (rels) => rels.filter((r) => !(
      (sameName(r.fromModel, c.modelName) && sameName(r.fromColumn, c.columnName))
      || (sameName(r.toModel, c.modelName) && sameName(r.toColumn, c.columnName)))));
  }
}

type JsonRel = { fromModel: string; fromColumn: string; toModel: string; toColumn: string; cardinality: string };

function domainJsonPath(root: string, plan: SyncPlan): string {
  return path.join(root, '.erd-studio', plan.layer, `${plan.domain}.json`);
}

function editDomainJson(root: string, plan: SyncPlan, log: ApplyLog, edit: (rels: JsonRel[]) => JsonRel[]): void {
  const file = domainJsonPath(root, plan);
  const doc = JSON.parse(fs.readFileSync(file, 'utf-8')) as { logical: { relationships?: JsonRel[] } };
  const before = JSON.stringify(doc.logical.relationships ?? []);
  doc.logical.relationships = edit(doc.logical.relationships ?? []);
  if (JSON.stringify(doc.logical.relationships) !== before) write(root, log, file, `${JSON.stringify(doc, null, 2)}\n`);
}

function legacyRelationship(root: string, plan: SyncPlan, r: RelationshipResolution, log: ApplyLog): void {
  const same = (x: JsonRel): boolean => sameName(x.fromModel, r.fromModel) && sameName(x.fromColumn, r.fromColumn)
    && sameName(x.toModel, r.toModel) && sameName(x.toColumn, r.toColumn);
  // "where the project keeps relationships — … domain JSON `logical.relationships[]`"
  // (the dbt-project fixture keeps them in the domain file).
  editDomainJson(root, plan, log, (rels) => {
    if (r.action === 'add-relationship-to-logical') {
      return [...rels, { fromModel: r.fromModel, fromColumn: r.fromColumn, toModel: r.toModel, toColumn: r.toColumn, cardinality: resolvedCardinality(plan, r) }];
    }
    if (r.action === 'remove-relationship-from-logical') return rels.filter((x) => !same(x));
    // "Update `cardinality` on the matching relationship … to" the cardinality to write.
    return rels.map((x) => (same(x) ? { ...x, cardinality: resolvedCardinality(plan, r) } : x));
  });
}

// ---------------------------------------------------------------------------
// Physical side (SYNC.md "Physical-side actions" and "dbt Relationship Test Format")
// ---------------------------------------------------------------------------

function dbtModel(doc: Document, model: string): YAMLMap {
  const m = seqItemByName(doc.get('models'), model);
  if (!m) throw new Error(`no model ${model} in the schema yml`);
  return m;
}

function dbtColumn(doc: Document, model: YAMLMap, column: string, create: boolean): YAMLMap | undefined {
  if (!isSeq(model.get('columns'))) {
    if (!create) return undefined;
    model.set('columns', doc.createNode([]));
  }
  const columns = model.get('columns') as YAMLSeq;
  let col = seqItemByName(columns, column);
  if (!col && create) {
    col = doc.createNode({ name: column }) as YAMLMap;
    columns.add(col);
  }
  return col;
}

/** The column's test list: `data_tests:` when the column or file already uses it, else `tests:` ("Match existing patterns"). */
function testsOf(doc: Document, col: YAMLMap): YAMLSeq {
  const key = col.has('data_tests') || (!col.has('tests') && doc.toString().includes('data_tests:')) ? 'data_tests' : 'tests';
  if (!isSeq(col.get(key))) col.set(key, doc.createNode([]));
  return col.get(key) as YAMLSeq;
}

/** A SELECT list edit on the dbt SQL file, when there is one (`dbtSqlPath`). */
function editSelect(root: string, ctx: TableContext, column: string, add: boolean, log: ApplyLog): void {
  if (!ctx.dbtSqlPath || !fs.existsSync(abs(root, ctx.dbtSqlPath))) return;
  const file = abs(root, ctx.dbtSqlPath);
  const lines = fs.readFileSync(file, 'utf-8').split('\n');
  const from = lines.findIndex((l) => /^\s*from\b/i.test(l));
  if (from < 1) return;
  if (add) {
    lines[from - 1] = `${lines[from - 1].replace(/\s*$/, '')},`;
    lines.splice(from, 0, `    ${column}`);
  } else {
    const at = lines.findIndex((l, i) => i < from && new RegExp(`^\\s*${column},?\\s*$`, 'i').test(l));
    if (at < 0) return;
    lines.splice(at, 1);
    const last = lines.findIndex((l) => /^\s*from\b/i.test(l)) - 1;
    lines[last] = lines[last].replace(/,\s*$/, '');
  }
  write(root, log, file, lines.join('\n'));
}

function physicalColumn(root: string, c: ColumnResolution, ctx: TableContext, log: ApplyLog): void {
  if (!ctx.dbtSchemaPath) throw new Error(`no dbtSchemaPath for ${c.modelName}`);
  editYaml(root, log, abs(root, ctx.dbtSchemaPath), (doc) => {
    const model = dbtModel(doc, c.modelName);
    if (c.action === 'add-column-to-physical') {
      // "Add column to the dbt SQL SELECT statement + add column entry to schema YAML".
      const col = dbtColumn(doc, model, c.columnName, true)!;
      if (c.resolvedDataType) col.set('data_type', c.resolvedDataType);
    } else if (c.action === 'remove-column-from-physical') {
      // "Remove column from dbt SQL SELECT + schema YAML".
      const columns = model.get('columns');
      if (isSeq(columns)) columns.items = columns.items.filter((i) => !(isMap(i) && sameName(String(i.get('name')), c.columnName)));
    } else {
      // update-type-in-physical: "Update column casting in dbt SQL or `data_type` in schema YAML to `resolvedDataType`".
      dbtColumn(doc, model, c.columnName, true)!.set('data_type', c.resolvedDataType);
    }
  });
  if (c.action !== 'update-type-in-physical') editSelect(root, ctx, c.columnName, c.action === 'add-column-to-physical', log);
}

function isRelationshipsTest(item: unknown, toModel: string, toColumn: string): boolean {
  if (!isMap(item)) return false;
  const rel = (item as YAMLMap).get('relationships');
  if (!isMap(rel)) return false;
  const args = isMap(rel.get('arguments')) ? (rel.get('arguments') as YAMLMap) : rel;
  const to = String(args.get('to') ?? '');
  return new RegExp(`ref\\(\\s*['"]${toModel}['"]`, 'i').test(to) && sameName(String(args.get('field') ?? ''), toColumn);
}

const isUniqueTest = (item: unknown): boolean => (isScalar(item) && item.value === 'unique') || (isMap(item) && (item as YAMLMap).has('unique'));

function physicalRelationship(root: string, plan: SyncPlan, r: RelationshipResolution, from: TableContext, log: ApplyLog): void {
  if (!from.dbtSchemaPath) throw new Error(`no dbtSchemaPath for ${r.fromModel}`);
  editYaml(root, log, abs(root, from.dbtSchemaPath), (doc) => {
    const model = dbtModel(doc, r.fromModel);
    if (r.action === 'add-relationship-test-to-physical') {
      // "Add `relationships` test to dbt schema YAML (see format below)":
      // `- relationships: { to: ref('dim_customer'), field: customer_id }` on the FK column.
      const col = dbtColumn(doc, model, r.fromColumn, true)!;
      testsOf(doc, col).add(doc.createNode({ relationships: { to: `ref('${r.toModel}')`, field: r.toColumn } }));
      return;
    }
    const col = dbtColumn(doc, model, r.fromColumn, r.action === 'update-cardinality-in-physical');
    // A column an earlier entry of the plan removed took its tests with it.
    if (!col) return;
    const tests = testsOf(doc, col);
    if (r.action === 'remove-relationship-test-from-physical') {
      // "Remove the `relationships` test from dbt schema YAML".
      tests.items = tests.items.filter((i) => !isRelationshipsTest(i, r.toModel, r.toColumn));
      return;
    }
    // update-cardinality-in-physical: "Add/remove `unique` test on FK column … to match" the cardinality to write.
    const one = resolvedCardinality(plan, r) === 'one-to-one';
    const has = tests.items.some(isUniqueTest);
    if (one && !has) tests.add(doc.createNode('unique'));
    if (!one && has) tests.items = tests.items.filter((i) => !isUniqueTest(i));
  });
}
