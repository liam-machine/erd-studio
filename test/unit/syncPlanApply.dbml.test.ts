/**
 * The sync plan, applied as SYNC.md tells the assistant, on the DBML twin of
 * the dbt fixture (and on the YAML/JSON fixture for parity): Compare with dbt
 * through the real provider, Sync writes `.sync-plan.json`, the test-only
 * applier (`syncPlanApply.harness.ts`, one branch per SYNC.md row) applies it,
 * and the project re-opened through the provider must
 *
 * - compare clean for every applied entry (or for the few that only a dbt
 *   rebuild can settle: `requiresCompile`, SYNC.md's step 3),
 * - compile (doctor reports no DBML error),
 * - hold each new Ref in the relationships file SYNC.md names
 *   (`relationshipsPath`, or the layer's default file for a table with no file
 *   yet) and each changed Ref in place in `storedIn`,
 * - and hold exactly the expected dbt tests in the schema yml, comments and
 *   other keys kept.
 *
 * Three selections: dbt is right everywhere ("all physical"), the logical
 * model is right everywhere ("all logical"), and a mix that writes both sides.
 *
 * `ERD_SYNC_APPLY_EXPORT=<dir>` keeps the mixed DBML case's project before
 * (`<dir>/ai`, plan included) and after (`<dir>/det`) the apply, for running
 * a real assistant on the same plan and diffing. One such run is recorded in
 * `test/fixtures/sync-apply-assistant` (what an assistant wrote, following
 * the installed SYNC.md and DBML.md), and the last test checks it still
 * lands where the applier does.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';

import { _resetMockWorkspace } from '../__mocks__/vscode';
import { HarnessService, HARNESS_TARGETS } from '../../src/services/harnessService';
import { allSelections } from '../../src/services/syncPlanBuilder';
import { columnKey, relationshipKey, type GroundTruth, type SyncPlan } from '../../src/types/syncPlan';
import type { DiscrepancyReport } from '../../src/types/discrepancy';
import {
  SHOWCASE, applyScenario, applySyncPlan, compare, copyFixture, errorsOf, generatePlan, type ApplyLog, type Storage,
} from './syncPlanApply.harness';

const roots: string[] = [];
afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });
beforeEach(() => { _resetMockWorkspace(); });

type Selection = 'all-physical' | 'all-logical' | 'mixed';

const rel = (from: string, fromCol: string, to: string, toCol: string): string => relationshipKey(from, fromCol, to, toCol);

/** The mixed selection: the logical side gets the new table, Refs and types; dbt gets the tests and the keys it lacks. */
function mixed(report: DiscrepancyReport): Record<string, GroundTruth> {
  const physical: string[] = [
    columnKey('dim_customer', 'segment'), columnKey('dim_customer', 'created_at'),
    columnKey('fct_task_event', 'event_date'), columnKey('fct_task_event', 'loaded_at'),
    ...report.models.find((m) => m.name === 'stg_raw_payments')!.columns.filter((c) => c.status !== 'matched').map((c) => columnKey('stg_raw_payments', c.name)),
    rel('fct_order', 'customer_key', 'dim_customer', 'customer_key'),
    rel('fct_order', 'project_key', 'dim_project', 'project_key'),
    rel('stg_raw_payments', 'order_id', 'fct_order', 'order_id'),
  ];
  const logical: string[] = [
    columnKey('dim_date', 'fiscal_year'), columnKey('dim_date', 'fiscal_quarter'),
    columnKey('fct_task_event', 'customer_key'), columnKey('fct_task_event', 'project_key'), columnKey('dim_project', 'parent_project_key'),
    rel('fct_task_event', 'customer_key', 'dim_customer', 'customer_key'),
    rel('fct_task_event', 'project_key', 'dim_project', 'project_key'),
    rel('dim_project', 'parent_project_key', 'dim_project', 'project_key'),
  ];
  const offered = allSelections(report, 'physical');
  for (const key of [...physical, ...logical]) expect(offered, key).toHaveProperty([key]);
  return { ...Object.fromEntries(physical.map((k) => [k, 'physical' as const])), ...Object.fromEntries(logical.map((k) => [k, 'logical' as const])) };
}

const SELECT: Record<Selection, (report: DiscrepancyReport) => Record<string, GroundTruth>> = {
  'all-physical': (report) => allSelections(report, 'physical'),
  'all-logical': (report) => allSelections(report, 'logical'),
  mixed,
};

/** Each plan entry the re-opened Compare still reports, as `action model.column` / `action from.col->to.col`. */
function unresolved(plan: SyncPlan, after: DiscrepancyReport): string[] {
  const out: string[] = [];
  const lc = (s: string): string => s.toLowerCase();
  for (const c of plan.columns) {
    const col = after.models.find((m) => lc(m.name) === lc(c.modelName))?.columns.find((x) => lc(x.name) === lc(c.columnName));
    if (col && col.status !== 'matched') out.push(`${c.action} ${c.modelName}.${c.columnName} (${col.status})`);
  }
  for (const r of plan.relationships) {
    const found = after.relationships.find((x) => lc(x.fromModel) === lc(r.fromModel) && lc(x.fromColumn) === lc(r.fromColumn)
      && lc(x.toModel) === lc(r.toModel) && lc(x.toColumn) === lc(r.toColumn));
    if (found && found.status !== 'matched') out.push(`${r.action} ${r.fromModel}.${r.fromColumn}->${r.toModel}.${r.toColumn} (${found.status})`);
  }
  return out.sort();
}

/**
 * Entries only a dbt rebuild settles: the physical stage reads columns and
 * types observed in `catalog.json` (`dbt docs generate`) before the schema
 * yml, and a manifest test stays until `dbt compile` (relationships are the
 * union of yml and manifest tests). SYNC.md says to run dbt compile after a
 * physical-side change (`requiresCompile`); there is no dbt here.
 */
const NEEDS_DBT_REBUILD: Record<Selection, string[]> = {
  'all-physical': [],
  mixed: [],
  'all-logical': [
    // Observed in catalog.json: removing it from the yml / SQL shows only after the next docs generate.
    'remove-column-from-physical fct_task_event.loaded_at (missing)',
    'remove-column-from-physical stg_raw_payments.LOADED_AT (missing)',
    'remove-column-from-physical stg_raw_payments.amount (missing)',
    'remove-column-from-physical stg_raw_payments.order_id (missing)',
    'remove-column-from-physical stg_raw_payments.payment_id (missing)',
    'remove-column-from-physical stg_raw_payments.payment_method (missing)',
    // The catalog's observed type wins over the yml's data_type until the table is rebuilt.
    'update-type-in-physical fct_task_event.event_date (type-mismatch)',
  ],
};

/** Every test on every column of a schema yml: `model.column` → the tests as compact JSON. */
function testsByColumn(file: string): Record<string, string[]> {
  const doc = parseYaml(fs.readFileSync(file, 'utf-8')) as { models?: Array<{ name: string; columns?: Array<Record<string, unknown>> }> };
  const out: Record<string, string[]> = {};
  for (const m of doc.models ?? []) {
    for (const c of m.columns ?? []) {
      out[`${m.name}.${String(c.name)}`] = [...((c.tests ?? c.data_tests ?? []) as unknown[])].map((t) => JSON.stringify(t)).sort();
    }
  }
  return out;
}

/** Every schema yml of the dbt project: project-relative path → its tests by column. */
function dbtTests(root: string): Record<string, Record<string, string[]>> {
  const out: Record<string, Record<string, string[]>> = {};
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.yml')) out[path.relative(root, p).split(path.sep).join('/')] = testsByColumn(p);
    }
  };
  walk(path.join(root, 'models'));
  return out;
}

/** What tests the apply added and removed, per `file model.column`. */
function testChanges(before: ReturnType<typeof dbtTests>, after: ReturnType<typeof dbtTests>): { added: string[]; removed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  for (const file of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const b = before[file] ?? {};
    const a = after[file] ?? {};
    for (const col of new Set([...Object.keys(b), ...Object.keys(a)])) {
      for (const t of a[col] ?? []) if (!(b[col] ?? []).includes(t)) added.push(`${file} ${col} ${t}`);
      for (const t of b[col] ?? []) if (!(a[col] ?? []).includes(t)) removed.push(`${file} ${col} ${t}`);
    }
  }
  return { added: added.sort(), removed: removed.sort() };
}

const read = (root: string, rel: string): string => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf-8');

async function doctorDbmlErrors(root: string): Promise<unknown[]> {
  const { runDoctor } = await import('../../src/cli/doctor');
  const result = await runDoctor({ project: root, semanticDir: '.erd-studio', noDbt: true, env: { PATH: '' }, homeDir: path.join(root, '.home') });
  return result.erd.dbmlProblems.filter((p) => p.severity === 'error');
}

interface Run { plan: SyncPlan; log: ApplyLog; after: DiscrepancyReport; tests: { added: string[]; removed: string[] }; root: string }
const runs: Partial<Record<`${Storage}:${Selection}`, Run>> = {};

async function run(storage: Storage, selection: Selection): Promise<Run> {
  const root = copyFixture(storage);
  roots.push(root);
  applyScenario(root, storage);
  const { plan } = await generatePlan(root, SHOWCASE[storage], SELECT[selection]);
  const exportDir = process.env.ERD_SYNC_APPLY_EXPORT;
  if (exportDir && storage === 'dbml' && selection === 'mixed') {
    fs.rmSync(path.join(exportDir, 'ai'), { recursive: true, force: true });
    fs.cpSync(root, path.join(exportDir, 'ai'), { recursive: true, preserveTimestamps: true });
  }
  const before = dbtTests(root);
  const log = applySyncPlan(root, plan);
  if (exportDir && storage === 'dbml' && selection === 'mixed') {
    fs.rmSync(path.join(exportDir, 'det'), { recursive: true, force: true });
    fs.cpSync(root, path.join(exportDir, 'det'), { recursive: true, preserveTimestamps: true });
  }
  const { panel, report: after } = await compare(root, SHOWCASE[storage]);
  expect(errorsOf(panel)).toEqual([]);
  const result: Run = { plan, log, after, tests: testChanges(before, dbtTests(root)), root };
  runs[`${storage}:${selection}`] = result;
  return result;
}

describe('SYNC.md describes every action the plan holds', () => {
  it('each action the applier follows has its row in the installed SYNC.md', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-sync-md-'));
    roots.push(tmp);
    // SYNC.md installs only in a dbt project.
    fs.writeFileSync(path.join(tmp, 'dbt_project.yml'), "name: 'p'\nversion: '1.0.0'\nconfig-version: 2\n");
    new HarnessService().install(tmp, HARNESS_TARGETS.find((t) => t.id === 'claude')!);
    const sync = fs.readFileSync(path.join(tmp, '.claude', 'skills', 'erd-studio', 'SYNC.md'), 'utf-8');
    for (const action of [
      'add-column-to-logical', 'remove-column-from-logical', 'update-type-in-logical',
      'add-relationship-to-logical', 'remove-relationship-from-logical', 'update-cardinality-in-logical',
      'add-column-to-physical', 'remove-column-from-physical', 'update-type-in-physical',
      'add-relationship-test-to-physical', 'remove-relationship-test-from-physical', 'update-cardinality-in-physical',
    ]) expect(sync, action).toMatch(new RegExp(`^\\| \`${action}\` \\|`, 'm'));
    // The three rules the applier needed beyond the action rows (see the harness's comments).
    expect(sync).toMatch(/no file at `logicalModelPath` yet/);
    expect(sync).toMatch(/no `relationshipsPath`/);
    expect(sync).toMatch(/When `resolvedDataType` is empty,[^.]*nothing to write/);
    // The applier's add-column-to-physical writes `data_type:` because the row says to.
    expect(sync).toMatch(/^\| `add-column-to-physical` \|[^\n]*`data_type: <resolvedDataType>`/m);
    expect(sync).toMatch(/`sourceCardinality`\s+when the entry's `groundTruth` is the plan's `sourceStage`/);
  });
});

describe.each(['dbml', 'yaml'] as Storage[])('a sync plan applied as SYNC.md says, on %s storage', (storage) => {
  it('dbt is right everywhere: the logical side is written, and compares clean', async () => {
    const { plan, log, after, tests, root } = await run(storage, 'all-physical');
    expect(plan.requiresCompile).toBe(false);
    expect(plan.columns.length + plan.relationships.length).toBeGreaterThan(15);
    // dim_date's two types are undeclared in dbt: nothing to write, so they stay advisory.
    expect(unresolved(plan, after)).toEqual([
      'update-type-in-logical dim_date.fiscal_quarter (undeclared)',
      'update-type-in-logical dim_date.fiscal_year (undeclared)',
    ]);
    expect(log.skipped.filter((s) => s.startsWith('update-type'))).toEqual([
      'update-type-in-logical dim_date.fiscal_year: resolvedDataType is empty',
      'update-type-in-logical dim_date.fiscal_quarter: resolvedDataType is empty',
    ]);
    // Nothing on the dbt side.
    expect(tests).toEqual({ added: [], removed: [] });
    expect([...log.touched].filter((f) => !f.startsWith('.erd-studio/'))).toEqual([]);
    if (storage === 'dbml') {
      // The new table: a table file in the diagram's layer, where the diagram's use line points.
      expect(plan.modelContext.stg_raw_payments.logicalModelPath).toBe('.erd-studio/silver/tables/silver/stg_raw_payments.dbml');
      // It has no file yet: its new Refs go where the plan says, its layer's default file.
      expect(plan.modelContext.stg_raw_payments.relationshipsPath).toBe('.erd-studio/silver/relationships/silver.dbml');
      expect(read(root, '.erd-studio/silver/tables/silver/stg_raw_payments.dbml')).toBe([
        // The types dbt observed (catalog.json wins over the yml's data_type), quoted where they are no identifier.
        'Table silver.stg_raw_payments {', '  payment_id "NUMBER(38,0)"', '  order_id "NUMBER(38,0)"', '  amount FLOAT',
        '  payment_method TEXT', '  LOADED_AT TIMESTAMP_NTZ', '}', '',
      ].join('\n'));
      // fct_order's new Ref: in orders.dbml, the file holding most of its Refs (relationshipsPath), not the layer's.
      expect(plan.modelContext.fct_order.relationshipsPath).toBe('.erd-studio/silver/relationships/orders.dbml');
      const orders = read(root, '.erd-studio/silver/relationships/orders.dbml');
      expect(orders).toMatch(/^Ref: public\.fct_order\.customer_key >\? silver\.dim_customer\.customer_key$/m);
      expect(orders).toMatch(/^use \{ table silver\.dim_customer \} from '\.\.\/tables\/silver\/dim_customer\.dbml'$/m);
      // The changed Ref, in place in storedIn.
      expect(orders).toMatch(/^Ref: public\.fct_order\.project_key >\? silver\.dim_project\.project_key$/m);
      expect(orders).not.toMatch(/ - silver\.dim_project/);
      // stg_raw_payments's new Ref: its layer's default file, with a use line for each end.
      const silver = read(root, '.erd-studio/silver/relationships/silver.dbml');
      expect(silver).toMatch(/^Ref: silver\.stg_raw_payments\.order_id >\? public\.fct_order\.order_id$/m);
      expect(silver).toMatch(/^use \{ table silver\.stg_raw_payments \} from '\.\.\/tables\/silver\/stg_raw_payments\.dbml'$/m);
      expect(silver).toMatch(/^use \{ table public\.fct_order \} from '\.\.\/tables\/public\/fct_order\.dbml'$/m);
      // Removed: the Refs dbt does not test, and those naming a removed column.
      expect(silver).not.toMatch(/fct_task_event\.(customer_key|project_key)|parent_project_key/);
      expect(await doctorDbmlErrors(root)).toEqual([]);
    }
  });

  it('the logical model is right everywhere: the schema yml is written, comments kept, and compares clean but for what dbt must rebuild', async () => {
    const { plan, after, tests, root, log } = await run(storage, 'all-logical');
    expect(plan.requiresCompile).toBe(true);
    expect(unresolved(plan, after)).toEqual(NEEDS_DBT_REBUILD['all-logical']);
    // Nothing on the logical side.
    expect([...log.touched].filter((f) => f.startsWith('.erd-studio/'))).toEqual([]);
    const relTest = (to: string, field: string): string => JSON.stringify({ relationships: { to: `ref('${to}')`, field } });
    expect(tests.added).toEqual([
      `models/gold/fct_task_event.yml fct_task_event.customer_key ${relTest('dim_customer', 'customer_key')}`,
      `models/gold/fct_task_event.yml fct_task_event.project_key ${relTest('dim_project', 'project_key')}`,
      `models/silver/dim_project.yml dim_project.parent_project_key ${relTest('dim_project', 'project_key')}`,
      'models/silver/fct_order.yml fct_order.project_key "unique"',
    ]);
    expect(tests.removed).toEqual([
      `models/silver/fct_order.yml fct_order.customer_key ${relTest('dim_customer', 'customer_key')}`,
      `models/staging/stg_raw_payments.yml stg_raw_payments.order_id ${relTest('fct_order', 'order_id')}`,
      'models/staging/stg_raw_payments.yml stg_raw_payments.payment_id "not_null"',
      'models/staging/stg_raw_payments.yml stg_raw_payments.payment_id "unique"',
    ]);
    const dimCustomer = read(root, 'models/silver/dim_customer.yml');
    expect(dimCustomer).toContain('# Owned by the CRM squad — keep the tests in step with the source system\n');
    expect(dimCustomer).toContain('    meta:\n      owner: crm-squad # who to ask\n');
    expect(dimCustomer).toMatch(/- name: customer_id\n\s+data_type: VARCHAR/);
    expect(dimCustomer).not.toMatch(/name: (segment|created_at)/);
    expect(read(root, 'models/silver/fct_order.yml')).toContain('      # project_key is checked against the project dimension\n      - name: project_key\n');
    // The SQL SELECT lists gain and lose the same columns.
    expect(read(root, 'models/gold/fct_task_event.sql')).toMatch(/amount,\n {4}project_key,\n {4}customer_key,\n {4}event_type,\n {4}duration_hours\nfrom/);
  });

  it('a mixed selection writes both sides, and compares clean', async () => {
    const { plan, after, tests, root, log } = await run(storage, 'mixed');
    expect(plan.requiresCompile).toBe(true);
    expect(unresolved(plan, after)).toEqual(NEEDS_DBT_REBUILD.mixed);
    expect(log.skipped).toEqual([]);
    const relTest = (to: string, field: string): string => JSON.stringify({ relationships: { to: `ref('${to}')`, field } });
    expect(tests).toEqual({
      added: [
        `models/gold/fct_task_event.yml fct_task_event.customer_key ${relTest('dim_customer', 'customer_key')}`,
        `models/gold/fct_task_event.yml fct_task_event.project_key ${relTest('dim_project', 'project_key')}`,
        `models/silver/dim_project.yml dim_project.parent_project_key ${relTest('dim_project', 'project_key')}`,
      ],
      removed: [],
    });
    expect(parseYaml(read(root, 'models/gold/dim_date.yml')).models[0].columns.filter((c: { name: string }) => c.name.startsWith('fiscal_')))
      .toEqual([
        { name: 'fiscal_year', description: 'Fiscal year', data_type: 'INT' },
        { name: 'fiscal_quarter', description: 'Fiscal quarter (Q1-Q4)', data_type: 'VARCHAR' },
      ]);
    if (storage === 'dbml') {
      expect(read(root, '.erd-studio/silver/relationships/orders.dbml')).toMatch(/^Ref: public\.fct_order\.customer_key >\? silver\.dim_customer\.customer_key$/m);
      expect(read(root, '.erd-studio/silver/relationships/silver.dbml')).toMatch(/^Ref: silver\.stg_raw_payments\.order_id >\? public\.fct_order\.order_id$/m);
      expect(read(root, '.erd-studio/silver/tables/silver/fct_task_event.dbml')).toMatch(/^ {2}event_date +"timestamp without time zone" +\[note: 'Date the event occurred'\]$/m);
      expect(await doctorDbmlErrors(root)).toEqual([]);
    }
  });
});

describe('both storages end in the same place', () => {
  it.each(['all-physical', 'all-logical', 'mixed'] as Selection[])('%s: the same Compare after the apply', (selection) => {
    const dbml = runs[`dbml:${selection}`];
    const yaml = runs[`yaml:${selection}`];
    expect(dbml && yaml, 'both runs above').toBeTruthy();
    const key = (r: { fromModel: string; fromColumn: string; toModel: string; toColumn: string }): string => `${r.fromModel}.${r.fromColumn}>${r.toModel}.${r.toColumn}`.toLowerCase();
    const shape = (report: DiscrepancyReport): unknown => ({
      models: report.models.map((m) => ({ name: m.name, status: m.status, columns: m.columns.map((c) => `${c.name}:${c.status}`).sort() })).sort((a, b) => a.name.localeCompare(b.name)),
      relationships: report.relationships.map((r) => `${key(r)}:${r.status}`).sort(),
    });
    expect(shape(dbml!.after)).toEqual(shape(yaml!.after));
    expect(dbml!.tests).toEqual(yaml!.tests);
  });
});

describe('an assistant following SYNC.md lands where the applier does', () => {
  // test/fixtures/sync-apply-assistant: the mixed DBML plan, applied by a real
  // assistant from the installed SYNC.md and DBML.md (its README says how).
  const RECORDED = path.join(__dirname, '..', 'fixtures', 'sync-apply-assistant');
  const recordedFiles = (dir: string, base = dir): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (
    e.isDirectory() ? recordedFiles(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name)).split(path.sep).join('/')]
  ));

  it('the same plan, the same Compare, the same dbt tests, and no DBML error', async () => {
    const root = copyFixture('dbml');
    roots.push(root);
    applyScenario(root, 'dbml');
    const { plan } = await generatePlan(root, SHOWCASE.dbml, SELECT.mixed);
    // A different plan needs a new assistant run (the fixture's README says how).
    expect({ ...plan, generatedAt: '' }, 'the plan the assistant applied').toEqual(JSON.parse(read(RECORDED, 'plan.json')));
    fs.rmSync(path.join(root, '.erd-studio', '.sync-plan.json'));

    const before = dbtTests(root);
    const files = recordedFiles(path.join(RECORDED, 'files'));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      fs.copyFileSync(path.join(RECORDED, 'files', ...f.split('/')), path.join(root, ...f.split('/')));
    }
    _resetMockWorkspace();
    const { panel, report: after } = await compare(root, SHOWCASE.dbml);
    expect(errorsOf(panel)).toEqual([]);
    expect(unresolved(plan, after)).toEqual(NEEDS_DBT_REBUILD.mixed);
    expect(await doctorDbmlErrors(root)).toEqual([]);

    // Where the applier ended, on the same plan (the run above).
    const det = runs['dbml:mixed'];
    expect(det, 'the applier\'s mixed DBML run above').toBeTruthy();
    const key = (r: { fromModel: string; fromColumn: string; toModel: string; toColumn: string }): string => `${r.fromModel}.${r.fromColumn}>${r.toModel}.${r.toColumn}`.toLowerCase();
    const shape = (report: DiscrepancyReport): unknown => ({
      models: report.models.map((m) => ({ name: m.name, status: m.status, columns: m.columns.map((c) => `${c.name}:${c.status}`).sort() })).sort((a, b) => a.name.localeCompare(b.name)),
      relationships: report.relationships.map((r) => `${key(r)}:${r.status}:${r.sourceCardinality ?? ''}/${r.targetCardinality ?? ''}`).sort(),
    });
    expect(shape(after)).toEqual(shape(det!.after));
    expect(testChanges(before, dbtTests(root))).toEqual(det!.tests);
    // Each Ref in the file the plan names.
    expect(read(root, '.erd-studio/silver/relationships/orders.dbml')).toMatch(/^Ref: public\.fct_order\.customer_key >\? silver\.dim_customer\.customer_key$/m);
    expect(read(root, '.erd-studio/silver/relationships/orders.dbml')).toMatch(/^Ref: public\.fct_order\.project_key >\? silver\.dim_project\.project_key$/m);
    expect(read(root, '.erd-studio/silver/relationships/silver.dbml')).toMatch(/^Ref: silver\.stg_raw_payments\.order_id >\? public\.fct_order\.order_id$/m);
  });
});
