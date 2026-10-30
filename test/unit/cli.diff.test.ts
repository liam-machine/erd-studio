import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { linkKey } from '@erd-studio/core';

import { buildCliContext } from '../../src/cli/context';
import { fixesFromPlan, runDiff, type DiffResult } from '../../src/cli/diff';
import { canonicalRelationship } from '@erd-studio/core';
import { main } from '../../src/cli/index';
import type { InventoryResult } from '../../src/cli/inventory';
import { computeSubjectAreaDiff } from '../../src/services/stageDiff';
import { allSelections, buildSyncPlan } from '../../src/services/syncPlanBuilder';
import type { SyncPlan } from '../../src/types/syncPlan';
import type { Relationship, SemanticTable, TableRelationship } from '../../src/types/semantic';
import { editRelationshipsDbml, renderNewSubjectAreaDbml, renderNewTableDbml } from '@erd-studio/core/dbml';
import { planDbmlConversion, type DbmlConversionPlan } from '../../src/services/dbmlConversion';
import { readDbmlConversionInput } from '../../src/services/dbmlConversionFiles';

const FIXTURES = path.resolve(__dirname, '../fixtures');
const PROJECT = path.join(FIXTURES, 'dbt-project');

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-cli-diff-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

async function run(argv: string[], cwd: string = PROJECT): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const code = await main(argv, {
    stdout: { write: (s: string) => { out += s; } },
    stderr: { write: (s: string) => { err += s; } },
    cwd,
    env: {},
  });
  return { code, out, err };
}

function copyProject(name = 'dbt-project'): string {
  const root = path.join(tmp, name);
  fs.cpSync(path.join(FIXTURES, name), root, { recursive: true });
  return root;
}

describe('diff', () => {
  it('the showcase report is exactly computeSubjectAreaDiff from logical, and the plan is buildSyncPlan(all physical)', async () => {
    const ctx = await buildCliContext({ project: PROJECT, semanticDir: '.erd-studio' });
    const { result, exitCode } = runDiff(ctx, { domains: ['.erd-studio/silver/showcase.json'] });
    expect(exitCode).toBe(1);
    const d = result.domains[0];
    const file = path.join(PROJECT, '.erd-studio/silver/showcase.json');
    const expected = computeSubjectAreaDiff(
      { subjectAreaService: ctx.subjectAreaService, ymlData: ctx.ymlData, manifest: ctx.manifest, catalog: ctx.catalog }, file, 'logical');
    expect(d.report).toEqual(expected.report);
    const plan = buildSyncPlan(expected.report, allSelections(expected.report, 'physical'), {
      manifest: ctx.manifest, ymlData: ctx.ymlData, projectRoot: PROJECT, semanticDir: '.erd-studio', domain: 'showcase', layer: 'silver',
    });
    expect({ ...d.plan, generatedAt: '' }).toEqual({ ...plan, generatedAt: '' });

    expect(d).toMatchObject({ file: '.erd-studio/silver/showcase.json', domain: 'showcase', layer: 'silver', clean: false });
    expect(d.counts.blocking).toBe(d.fixes.filter((f) => f.severity === 'blocking').length);
    expect(d.counts.advisory).toBeGreaterThan(0);
    // Every non-phantom plan resolution is exactly one fix.
    expect(d.fixes.length).toBe(d.plan!.columns.length + d.plan!.relationships.length);
    // Sorted: blocking first, then model, then column.
    const order = d.fixes.map((f) => `${f.severity === 'blocking' ? 0 : 1}|${f.model}|${f.column ?? ''}`);
    expect(order).toEqual([...order].sort());

    const setType = d.fixes.find((f) => f.kind === 'set-type' && f.severity === 'blocking')!;
    expect(setType).toMatchObject({ model: 'fct_task_event', column: 'event_date', from: 'DATE', file: '.erd-studio/logical-models/fct_task_event.yml' });
    const advisory = d.fixes.filter((f) => f.severity === 'advisory');
    expect(advisory.every((f) => f.kind === 'set-type' && f.to === '')).toBe(true);
    const removeRel = d.fixes.find((f) => f.kind === 'remove-relationship')!;
    expect(removeRel.file).toBe('.erd-studio/silver/showcase.json');
    expect(removeRel.relationship).toBeDefined();
    for (const f of d.fixes) {
      expect(f.explain.length).toBeGreaterThan(10);
      expect(f.kind).not.toBe('remove-model');
    }
  });

  it('collapses a phantom into one resolve-phantom question', async () => {
    const ctx = await buildCliContext({ project: PROJECT, semanticDir: '.erd-studio' });
    const d = runDiff(ctx, { domains: ['.erd-studio/silver/scroll-test.json'] }).result.domains[0];
    expect(d.phantoms).toEqual([{ name: 'fct_large_table', reason: 'absent' }]);
    expect(d.fixes).toEqual([expect.objectContaining({ kind: 'resolve-phantom', model: 'fct_large_table', severity: 'blocking' })]);
    expect(d.clean).toBe(false);
  });

  it('--all marks v4 domains needsMigration with no fixes, and records per-domain errors', async () => {
    const ctx = await buildCliContext({ project: PROJECT, semanticDir: '.erd-studio' });
    const { result, exitCode } = runDiff(ctx, { all: true });
    expect(exitCode).toBe(1);
    const files = result.domains.map((d) => d.file);
    expect(files).not.toContain(expect.stringContaining('templates'));
    const finance = result.domains.find((d) => d.domain === 'finance')!;
    expect(finance).toMatchObject({ needsMigration: true, fixes: [], clean: false });
    expect(finance.report).toBeUndefined();

    const sparseCtx = await buildCliContext({ project: path.join(FIXTURES, 'dbt-project-sparse'), semanticDir: '.erd-studio' });
    const sparse = runDiff(sparseCtx, { all: true }).result;
    const future = sparse.domains.find((d) => d.domain === 'future-version')!;
    expect(future.error).toMatchObject({ code: 'unsupported-format' });
    expect(future.error!.message).toContain('.erd-studio/silver/future-version.json');
    expect(future.error!.message).not.toContain(FIXTURES);
    expect(sparse.domains.find((d) => d.domain === 'no-schema-version')!.error).toBeDefined();
  });

  it('a single --domain that cannot be read exits 3 with a redacted JSON error', async () => {
    const r = await run(['diff', '--json', '--domain', '.erd-studio/silver/future-version.json'], path.join(FIXTURES, 'dbt-project-sparse'));
    expect(r.code).toBe(3);
    const body = JSON.parse(r.out);
    expect(body.error.code).toBe('unsupported-format');
    expect(body.error.message).not.toContain(FIXTURES);

    const missing = await run(['diff', '--json', '--domain', 'nope.json']);
    expect(missing.code).toBe(3);
    expect(JSON.parse(missing.out).error.code).toBe('domain-missing');
  });

  it('a diagram holding git merge conflicts is merge-conflict: its own error under --all, exit 3 for --domain and export (#145)', async () => {
    const root = copyProject();
    const file = path.join(root, '.erd-studio/silver/showcase.json');
    const lines = fs.readFileSync(file, 'utf-8').split('\n');
    const at = lines.findIndex((l) => l.includes('"viewConfig"'));
    lines.splice(at + 1, 0, '<<<<<<< HEAD', '    "zoom": 1,', '=======', '    "zoom": 2,', '>>>>>>> feature');
    fs.writeFileSync(file, lines.join('\n'));
    const line = at + 2;

    const ctx = await buildCliContext({ project: root, semanticDir: '.erd-studio' });
    const { result, exitCode } = runDiff(ctx, { all: true });
    expect(exitCode).toBe(1);
    const showcase = result.domains.find((d) => d.file === '.erd-studio/silver/showcase.json')!;
    expect(showcase.error).toEqual({
      code: 'merge-conflict',
      message: `.erd-studio/silver/showcase.json has unresolved git merge conflicts (first at line ${line}): `
        + 'git left two versions there. Show the user the file and line; if only positions differ either side is safe to keep, '
        + "otherwise ask the user which side to keep. Don't pick a side or run git commands yourself.",
    });

    for (const argv of [
      ['diff', '--json', '--domain', '.erd-studio/silver/showcase.json'],
      ['export', '--json', '--domain', '.erd-studio/silver/showcase.json', '--format', 'mermaid'],
    ]) {
      const r = await run(argv, root);
      expect(r.code, argv[0]).toBe(3);
      expect(JSON.parse(r.out).error, argv[0]).toEqual(showcase.error);
      expect(r.out).not.toContain(root);
    }

    // The terminal line carries the same advice: it never tells anyone to resolve it themselves.
    const human = await run(['diff', '--all'], root);
    expect(human.out).toContain(`showcase (silver) — could not be compared: ${showcase.error!.message}`);
    expect(human.out).not.toMatch(/Resolve them in the file/);
  });

  it('reports a model file holding git merge conflicts as a flagged fix-model-yaml at its first marker (#145)', async () => {
    const root = copyProject();
    fs.writeFileSync(path.join(root, '.erd-studio/logical-models/fct_task_event.yml'),
      'name: fct_task_event\n<<<<<<< HEAD\ndescription: a\n=======\ndescription: b\n>>>>>>> feature\ncolumns: []\n');
    const r = await run(['diff', '--domain', '.erd-studio/silver/showcase.json', '--json'], root);
    expect(r.code).toBe(1);
    const d = (JSON.parse(r.out) as DiffResult).domains[0];
    expect(d.unreadableModelFiles).toEqual([expect.objectContaining({ name: 'fct_task_event', kind: 'yamlOther', line: 2, mergeConflict: true })]);
    const fixes = d.fixes.filter((f) => f.kind === 'fix-model-yaml');
    expect(fixes).toEqual([expect.objectContaining({ line: 2 })]);
    // An assistant reads the fix: it shows the conflict and asks, never picks a side.
    expect(fixes[0].explain).toContain('.erd-studio/logical-models/fct_task_event.yml line 2: unresolved git merge conflict');
    expect(fixes[0].explain).toContain("ask which side to keep (don't pick a side or run git commands yourself)");
    expect(fixes[0].explain).not.toContain('git add');

    const human = await run(['diff', '--domain', '.erd-studio/silver/showcase.json'], root);
    expect(human.out).toContain('✗ fct_task_event.yml line 2: unresolved git merge conflict — resolve it (keep one side), save, then re-run diff');
  });

  it('a domain in a layer layers.json does not define: skipped by --all, unknown-layer for --domain', async () => {
    const root = copyProject();
    fs.mkdirSync(path.join(root, '.erd-studio', 'platinum'));
    fs.copyFileSync(path.join(root, '.erd-studio/silver/showcase.json'), path.join(root, '.erd-studio/platinum/odd.json'));
    // listSubjectAreas walks only the configured layers, so --all never sees it…
    const ctx = await buildCliContext({ project: root, semanticDir: '.erd-studio' });
    expect(runDiff(ctx, { all: true }).result.domains.map((d) => d.domain)).not.toContain('odd');
    // …and naming it directly fails on the layer, not with a crash.
    const raw = JSON.parse(fs.readFileSync(path.join(root, '.erd-studio/silver/showcase.json'), 'utf-8'));
    fs.writeFileSync(path.join(root, '.erd-studio/platinum/odd.json'), JSON.stringify({ ...raw, layer: 'platinum' }));
    const r = await run(['diff', '--json', '--domain', '.erd-studio/platinum/odd.json'], root);
    expect(r.code).toBe(3);
    expect(JSON.parse(r.out).error.code).toBe('unknown-layer');
  });

  it('--all over no domains is an environment error, never a clean result', async () => {
    const root = copyProject();
    // A custom data folder the CLI was not told about (it cannot read VS Code settings).
    fs.renameSync(path.join(root, '.erd-studio'), path.join(root, 'my erd'));
    const r = await run(['diff', '--all', '--json'], root);
    expect(r.code).toBe(3);
    expect(JSON.parse(r.out).error.code).toBe('no-semantic-dir');
    expect(r.out).not.toContain('"clean": true');

    // The folder exists but holds no domain files.
    fs.mkdirSync(path.join(root, '.erd-studio'));
    const empty = await run(['diff', '--all', '--json'], root);
    expect(empty.code).toBe(3);
    expect(JSON.parse(empty.out).error.code).toBe('no-domains');

    // With the right --semantic-dir it compares again.
    const right = await run(['diff', '--all', '--json', '--semantic-dir', 'my erd'], root);
    expect([0, 1]).toContain(right.code);
    expect(JSON.parse(right.out).domains.length).toBeGreaterThan(0);
  });

  it('a v4 domain gets the migration answer even when the v5 load would fail for another reason', async () => {
    const root = copyProject();
    const v4 = JSON.parse(fs.readFileSync(path.join(root, '.erd-studio/gold/finance.json'), 'utf-8'));
    fs.mkdirSync(path.join(root, '.erd-studio', 'platinum'));
    fs.writeFileSync(path.join(root, '.erd-studio/platinum/odd.json'), JSON.stringify({ ...v4, domain: 'odd', layer: 'platinum' }));
    const r = await run(['diff', '--json', '--domain', '.erd-studio/platinum/odd.json'], root);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).domains[0]).toMatchObject({ domain: 'odd', layer: 'platinum', needsMigration: true, fixes: [] });
  });

  it('human output matches the spec shape', async () => {
    const r = await run(['diff', '--domain', '.erd-studio/silver/showcase.json']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^showcase \(silver\) — \d+ differences to fix, \d+ advisory/);
    expect(r.out).toContain('✗ fct_task_event.event_date  type: DATE (logical) vs');
    expect(r.out).toContain('! dim_date.fiscal_year  dbt has no type for this column yet');
    expect(r.out).not.toContain('\u001b['); // not a TTY: no colour
  });

  it('--quiet prints nothing but keeps the exit code', async () => {
    const r = await run(['diff', '--quiet', '--domain', '.erd-studio/silver/showcase.json']);
    expect(r.code).toBe(1);
    expect(r.out).toBe('');
  });
});

describe('diff over a model file that does not parse', () => {
  const BROKEN = 'name: fct_task_event\ndescription: Status: one of a, b\ncolumns: []\n';

  it('reports it once, as a blocking fix-model-yaml, instead of add-column fixes', async () => {
    const root = copyProject();
    const yml = path.join(root, '.erd-studio/logical-models/fct_task_event.yml');
    fs.writeFileSync(yml, BROKEN);

    const r = await run(['diff', '--domain', '.erd-studio/silver/showcase.json', '--json'], root);
    expect(r.code).toBe(1);
    const d = (JSON.parse(r.out) as DiffResult).domains[0];
    expect(d.clean).toBe(false);
    expect(d.unreadableModelFiles).toEqual([expect.objectContaining({
      name: 'fct_task_event',
      file: '.erd-studio/logical-models/fct_task_event.yml',
      line: 2,
      code: 'BLOCK_AS_IMPLICIT_KEY',
      kind: 'yamlScalar',
    })]);
    const forModel = d.fixes.filter((f) => f.model === 'fct_task_event');
    expect(forModel.filter((f) => ['add-column', 'remove-column', 'set-type'].includes(f.kind))).toEqual([]);
    const yamlFixes = d.fixes.filter((f) => f.kind === 'fix-model-yaml');
    expect(yamlFixes).toEqual([expect.objectContaining({
      severity: 'blocking', model: 'fct_task_event', file: '.erd-studio/logical-models/fct_task_event.yml', line: 2,
    })]);
    expect(d.counts.blocking).toBe(d.fixes.filter((f) => f.severity === 'blocking').length);
    expect(JSON.stringify([d.unreadableModelFiles, d.fixes])).not.toContain(root);

    const human = await run(['diff', '--domain', '.erd-studio/silver/showcase.json'], root);
    expect(human.out).toContain('✗ fct_task_event.yml line 2: YAML error (BLOCK_AS_IMPLICIT_KEY) — wrap the value in double quotes');
  });

  it('a readable library reports no unreadable files', async () => {
    const ctx = await buildCliContext({ project: PROJECT, semanticDir: '.erd-studio' });
    const d = runDiff(ctx, { domains: ['.erd-studio/silver/showcase.json'] }).result.domains[0];
    expect(d.unreadableModelFiles).toEqual([]);
    expect(d.fixes.some((f) => f.kind === 'fix-model-yaml')).toBe(false);
  });
});

describe('fixesFromPlan — a new relationship is written on its many side (#133)', () => {
  it('turns a one-to-many round, naming the fact\'s file', () => {
    const plan: SyncPlan = {
      generatedAt: '', domain: 'd', layer: 'silver', sourceStage: 'logical', targetStage: 'physical',
      modelContext: {}, models: [], columns: [], requiresCompile: false,
      relationships: [
        { fromModel: 'dim_customer', fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key', discrepancyStatus: 'missing', groundTruth: 'physical', action: 'add-relationship-to-logical', targetCardinality: 'one-to-many' },
      ],
    };
    const [fix] = fixesFromPlan(plan, '.erd-studio/silver/d.json', '.erd-studio', [], [], { inLibrary: new Map(), addToLibrary: true });
    expect(fix).toMatchObject({
      kind: 'add-relationship', model: 'fct_order', column: 'customer_key', file: '.erd-studio/logical-models/fct_order.yml',
      relationship: { fromModel: 'fct_order', fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' },
    });
  });
});

describe('fixesFromPlan — a self-reference (#133 L3)', () => {
  it('add-relationship names the model\'s own file, on its many column', () => {
    const plan: SyncPlan = {
      generatedAt: '', domain: 'd', layer: 'silver', sourceStage: 'logical', targetStage: 'physical',
      modelContext: {}, models: [], columns: [], requiresCompile: false,
      relationships: [
        { fromModel: 'employee', fromColumn: 'employee_id', toModel: 'employee', toColumn: 'manager_id', discrepancyStatus: 'missing', groundTruth: 'physical', action: 'add-relationship-to-logical', targetCardinality: 'one-to-many' },
      ],
    };
    const [fix] = fixesFromPlan(plan, '.erd-studio/silver/d.json', '.erd-studio', [], [], { inLibrary: new Map(), addToLibrary: true });
    expect(fix).toMatchObject({
      kind: 'add-relationship', model: 'employee', file: '.erd-studio/logical-models/employee.yml',
      relationship: { fromModel: 'employee', fromColumn: 'manager_id', toModel: 'employee', toColumn: 'employee_id', cardinality: 'many-to-one' },
    });
  });
});

describe('fixesFromPlan — composite foreign keys (#133 L2)', () => {
  const PAIRS = [{ fromColumn: 'customer_hk', toColumn: 'customer_hk' }, { fromColumn: 'as_of_date', toColumn: 'load_date' }];
  const planOf = (relationships: SyncPlan['relationships']): SyncPlan => ({
    generatedAt: '', domain: 'd', layer: 'silver', sourceStage: 'logical', targetStage: 'physical',
    modelContext: {}, models: [], columns: [], requiresCompile: false, relationships,
  });

  it('a composite dbt does not declare is one advisory declare-composite-foreign-key fix, on the many side\'s yml', () => {
    const [fix] = fixesFromPlan(planOf([{
      fromModel: 'pit_customer', fromColumn: 'customer_hk', toModel: 'sat_customer', toColumn: 'customer_hk', pairs: PAIRS, compositeKey: 'fk_sat_customer',
      composite: true, discrepancyStatus: 'extra', groundTruth: 'physical', action: 'add-relationship-test-to-physical', sourceCardinality: 'many-to-one',
    }]), '.erd-studio/silver/d.json', '.erd-studio', []);
    expect(fix).toMatchObject({
      severity: 'advisory', kind: 'declare-composite-foreign-key', model: 'pit_customer', file: '.erd-studio/logical-models/pit_customer.yml',
      relationship: { fromModel: 'pit_customer', toModel: 'sat_customer', cardinality: 'many-to-one', pairs: PAIRS, compositeKey: 'fk_sat_customer' },
    });
    expect(fix.explain).toMatch(/^The logical stage draws the composite foreign key pit_customer \(customer_hk, as_of_date\) → sat_customer \(customer_hk, load_date\), and dbt declares none\. Nothing to change in the logical stage\./);
    expect(fix.explain).toContain('`foreign_key` constraint to pit_customer');
  });

  it('a dbt composite the logical model lacks is a blocking add-relationship with its pairs, in the canonical file', () => {
    const reversed = PAIRS.map((p) => ({ fromColumn: p.toColumn, toColumn: p.fromColumn }));
    const [fix] = fixesFromPlan(planOf([{
      fromModel: 'sat_customer', fromColumn: 'customer_hk', toModel: 'pit_customer', toColumn: 'customer_hk', pairs: reversed, compositeKey: 'fk_dbt',
      discrepancyStatus: 'missing', groundTruth: 'physical', action: 'add-relationship-to-logical', targetCardinality: 'one-to-many',
    }]), '.erd-studio/silver/d.json', '.erd-studio', [], [], { inLibrary: new Map(), addToLibrary: true });
    expect(fix).toMatchObject({
      severity: 'blocking', kind: 'add-relationship', model: 'pit_customer', file: '.erd-studio/logical-models/pit_customer.yml',
      relationship: { fromModel: 'pit_customer', fromColumn: 'customer_hk', toModel: 'sat_customer', toColumn: 'customer_hk', cardinality: 'many-to-one', pairs: PAIRS, compositeKey: 'fk_dbt' },
    });
    expect(fix.explain).toContain('add it to the logical stage as 2 entries sharing `compositeKey: fk_dbt`');
  });

  it('a cardinality difference names every entry of the composite', () => {
    const [fix] = fixesFromPlan(planOf([{
      fromModel: 'pit_customer', fromColumn: 'customer_hk', toModel: 'sat_customer', toColumn: 'customer_hk', pairs: PAIRS, compositeKey: 'fk_sat',
      discrepancyStatus: 'cardinality-mismatch', groundTruth: 'physical', action: 'update-cardinality-in-logical', sourceCardinality: 'many-to-one', targetCardinality: 'one-to-one',
    }]), '.erd-studio/silver/d.json', '.erd-studio', []);
    expect(fix).toMatchObject({ kind: 'set-cardinality', relationship: { pairs: PAIRS, compositeKey: 'fk_sat' } });
    expect(fix.explain).toContain('set `cardinality` on every entry of compositeKey fk_sat');
  });
});

describe('diff — an undeclared composite is advisory, blocking only under --strict (#133 L2)', () => {
  it('dbt-project', async () => {
    const root = copyProject('dbt-project');
    fs.rmSync(path.join(root, '.erd-studio'), { recursive: true, force: true });
    const models = ['fct_order', 'dim_customer'];
    const inventory = JSON.parse((await run(['inventory', '--models', models.join(','), '--json'], root)).out) as InventoryResult;
    const file = writeTableFromInventory(root, inventory, 'silver', 'orders', 'library');
    const ymlPath = path.join(root, '.erd-studio', 'logical-models', 'fct_order.yml');
    const yml = parseYaml(fs.readFileSync(ymlPath, 'utf-8')) as { relationships: Array<Record<string, unknown>> };
    yml.relationships = [
      { fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one', compositeKey: 'fk_dim_customer' },
      { fromColumn: 'order_date', toModel: 'dim_customer', toColumn: 'email', cardinality: 'many-to-one', compositeKey: 'fk_dim_customer' },
    ];
    fs.writeFileSync(ymlPath, toYaml(yml));

    const plain = await run(['diff', '--domain', path.relative(root, file), '--json'], root);
    const d = (JSON.parse(plain.out) as DiffResult).domains[0];
    expect(d.fixes.filter((f) => f.kind === 'declare-composite-foreign-key')).toEqual([
      expect.objectContaining({ severity: 'advisory', model: 'fct_order', file: '.erd-studio/logical-models/fct_order.yml' }),
    ]);
    expect(d.fixes.filter((f) => f.severity === 'blocking')).toEqual([]);
    expect(plain.code).toBe(0);

    const strict = await run(['diff', '--domain', path.relative(root, file), '--json', '--strict'], root);
    expect(strict.code).toBe(1);
  });
});

describe('fixesFromPlan', () => {
  const plan: SyncPlan = {
    generatedAt: '', domain: 'd', layer: 'silver', sourceStage: 'logical', targetStage: 'physical',
    modelContext: {}, models: [], requiresCompile: false,
    columns: [
      { modelName: 'm', columnName: 'a', discrepancyStatus: 'undeclared', groundTruth: 'physical', action: 'update-type-in-logical', sourceDataType: 'INT', targetDataType: '', resolvedDataType: '' },
      { modelName: 'm', columnName: 'b', discrepancyStatus: 'undeclared', groundTruth: 'physical', action: 'update-type-in-logical', sourceDataType: '', targetDataType: 'INT', resolvedDataType: 'INT' },
      { modelName: 'm', columnName: 'c', discrepancyStatus: 'missing', groundTruth: 'physical', action: 'add-column-to-logical', targetDataType: 'DATE', resolvedDataType: 'DATE' },
      { modelName: 'ghost', columnName: 'x', discrepancyStatus: 'extra', groundTruth: 'physical', action: 'remove-column-from-logical' },
    ],
    relationships: [
      { fromModel: 'f', fromColumn: 'k', toModel: 'm', toColumn: 'k', discrepancyStatus: 'cardinality-mismatch', groundTruth: 'physical', action: 'update-cardinality-in-logical', sourceCardinality: 'one-to-one', targetCardinality: 'many-to-one' },
    ],
  };

  it('advisory only for undeclared with an empty physical type; phantoms collapse', () => {
    const fixes = fixesFromPlan(plan, '.erd-studio/silver/d.json', '.erd-studio', [{ name: 'ghost', reason: 'absent' }]);
    const byCol = Object.fromEntries(fixes.filter((f) => f.column).map((f) => [`${f.model}.${f.column}`, f]));
    expect(byCol['m.a']).toMatchObject({ severity: 'advisory', kind: 'set-type', from: 'INT', to: '' });
    expect(byCol['m.b']).toMatchObject({ severity: 'blocking', kind: 'set-type', to: 'INT' });
    expect(byCol['m.c']).toMatchObject({ severity: 'blocking', kind: 'add-column', to: 'DATE', file: '.erd-studio/logical-models/m.yml' });
    expect(byCol['ghost.x']).toBeUndefined();
    expect(byCol['f.k']).toMatchObject({ kind: 'set-cardinality', from: 'one-to-one', to: 'many-to-one', file: '.erd-studio/silver/d.json' });
    expect(fixes.filter((f) => f.kind === 'resolve-phantom')).toHaveLength(1);
    expect(fixes[fixes.length - 1].severity).toBe('advisory');
  });

  const F_TO_M = { fromModel: 'f', fromColumn: 'k', toModel: 'm', toColumn: 'k' };
  const stored = (rel: Relationship) => ({ inLibrary: new Map([[linkKey(rel), rel]]), addToLibrary: true });

  it('names the from-model yml for a relationship stored in the model library (#126)', () => {
    const fixes = fixesFromPlan(plan, '.erd-studio/silver/d.json', '.erd-studio', [], [], stored({ ...F_TO_M, cardinality: 'one-to-one' }));
    expect(fixes.find((f) => f.kind === 'set-cardinality')).toMatchObject({ file: '.erd-studio/logical-models/f.yml' });
    expect(fixes.find((f) => f.kind === 'set-cardinality')).not.toHaveProperty('movesFrom');
  });

  it('never asks for a one-to-many in a yml: it names the canonical entry, its file and the file it moves from (D5)', () => {
    const toOneToMany: SyncPlan = { ...plan, columns: [], relationships: [{ ...plan.relationships[0], sourceCardinality: 'many-to-one', targetCardinality: 'one-to-many' }] };
    const [fix] = fixesFromPlan(toOneToMany, '.erd-studio/silver/d.json', '.erd-studio', [], [], stored({ ...F_TO_M, cardinality: 'many-to-one' }));
    expect(fix).toMatchObject({
      kind: 'set-cardinality', model: 'm', file: '.erd-studio/logical-models/m.yml', movesFrom: '.erd-studio/logical-models/f.yml',
      relationship: { fromModel: 'm', fromColumn: 'k', toModel: 'f', toColumn: 'k', cardinality: 'many-to-one' },
    });
  });

  it('names a backwards copy\'s file as the one to move from, and keeps a one-to-one where it is stored (D5)', () => {
    const backwards = { fromModel: 'm', fromColumn: 'k', toModel: 'f', toColumn: 'k', cardinality: 'many-to-one' as const };
    const toManyToOne: SyncPlan = { ...plan, columns: [], relationships: [{ ...plan.relationships[0], sourceCardinality: 'one-to-many', targetCardinality: 'many-to-one' }] };
    expect(fixesFromPlan(toManyToOne, 'd.json', '.erd-studio', [], [], stored(backwards))[0]).toMatchObject({
      file: '.erd-studio/logical-models/f.yml', movesFrom: '.erd-studio/logical-models/m.yml', relationship: { ...F_TO_M, cardinality: 'many-to-one' },
    });
    const toOneToOne: SyncPlan = { ...plan, columns: [], relationships: [{ ...plan.relationships[0], sourceCardinality: 'one-to-many', targetCardinality: 'one-to-one' }] };
    const [fix] = fixesFromPlan(toOneToOne, 'd.json', '.erd-studio', [], [], stored(backwards));
    expect(fix).toMatchObject({ file: '.erd-studio/logical-models/m.yml', relationship: { ...backwards, cardinality: 'one-to-one' } });
    expect(fix).not.toHaveProperty('movesFrom');
  });

  it('names the stored entry and its file for a remove (D5)', () => {
    const removing: SyncPlan = { ...plan, columns: [], relationships: [{ ...plan.relationships[0], discrepancyStatus: 'extra', action: 'remove-relationship-from-logical' }] };
    const backwards = { fromModel: 'm', fromColumn: 'k', toModel: 'f', toColumn: 'k', cardinality: 'many-to-one' as const };
    expect(fixesFromPlan(removing, 'd.json', '.erd-studio', [], [], stored(backwards))[0]).toMatchObject({
      kind: 'remove-relationship', model: 'm', file: '.erd-studio/logical-models/m.yml', relationship: backwards,
    });
  });
});

// ---------------------------------------------------------------------------
// The skill's core promise, end to end without an LLM: a logical model built
// ONLY from `inventory --models … --json` output diffs clean.
// ---------------------------------------------------------------------------

/** What the skill's "building-the-model" recipe writes, done mechanically. */
function writeTableFromInventory(
  root: string,
  inventory: InventoryResult,
  layer: string,
  domain: string,
  /** Where the relationships go: the domain file, or each from-model's yml (#126, the default for a first diagram). */
  home: 'domain' | 'library' = 'domain',
): string {
  const semantic = path.join(root, '.erd-studio');
  fs.mkdirSync(path.join(semantic, 'logical-models'), { recursive: true });
  for (const m of inventory.models) {
    const pk = new Set(m.keyCandidates.unique.length > 0 ? m.keyCandidates.unique : (m.keyCandidates.compositeUnique[0] ?? []));
    const fk = new Set(m.foreignKeys);
    const doc = {
      name: m.name,
      description: m.description || `${m.name} (draft)`,
      columns: m.columns!.map((c) => ({
        name: c.name,
        dataType: c.dataType || 'STRING', // unknown in dbt → STRING, confirmed later (advisory)
        description: c.description || '(draft)',
        ...(pk.has(c.name) ? { isPrimaryKey: true } : {}),
        ...(fk.has(c.name) ? { isForeignKey: true } : {}),
      })),
      // As the setup skill writes them: each on its many side (#133).
      ...(home === 'library' && inventory.relationships.map(canonicalRelationship).some((r) => r.fromModel === m.name)
        ? {
            relationships: inventory.relationships
              .map(canonicalRelationship)
              .filter((r) => r.fromModel === m.name)
              .map(({ fromModel: _from, ...rest }) => rest),
          }
        : {}),
    };
    fs.writeFileSync(path.join(semantic, 'logical-models', `${m.name}.yml`), toYaml(doc));
  }
  fs.mkdirSync(path.join(semantic, layer), { recursive: true });
  const file = path.join(semantic, layer, `${domain}.json`);
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 5,
    domain,
    layer,
    description: 'Built from inventory',
    logical: { models: inventory.models.map((m) => m.name), relationships: home === 'domain' ? inventory.relationships : [] },
    viewConfig: {},
  }, null, 2));
  return file;
}

describe('end to end: inventory → logical model → diff exits 0', () => {
  it.each([
    ['dbt-project', ['fct_order', 'dim_customer', 'dim_project', 'dim_task', 'fct_task_event', 'fct_sale', 'dim_region', 'dim_date']],
    ['dbt-project-modern-tests', ['fct_orders', 'fct_shipments', 'dim_customer', 'dim_product']],
  ])('%s', async (fixture, models) => {
    const root = copyProject(fixture);
    fs.rmSync(path.join(root, '.erd-studio'), { recursive: true, force: true });

    const inv = await run(['inventory', '--models', models.join(','), '--json'], root);
    expect(inv.code).toBe(0);
    const inventory = JSON.parse(inv.out) as InventoryResult;
    expect(inventory.models.map((m) => m.name).sort()).toEqual([...models].sort());
    expect(inventory.relationships.length).toBeGreaterThan(0);

    const file = writeTableFromInventory(root, inventory, 'silver', 'orders');

    const diff = await run(['diff', '--domain', path.relative(root, file), '--json'], root);
    const result = JSON.parse(diff.out) as DiffResult;
    const d = result.domains[0];
    expect(d.fixes.filter((f) => f.severity === 'blocking')).toEqual([]);
    expect(diff.code).toBe(0);
    expect(result.clean).toBe(true);
    expect(d.phantoms).toEqual([]);
    expect(d.missingModelFiles).toEqual([]);
    expect(d.counts.matchedRelationships).toBe(inventory.relationships.length);
    // Only STRING stand-ins for columns dbt has no type for may remain, and only as advisories.
    for (const f of d.fixes) { expect(f).toMatchObject({ severity: 'advisory', kind: 'set-type', from: 'STRING', to: '' }); }

    // --all agrees, and --strict turns advisories into blockers.
    expect((await run(['diff', '--all', '--json'], root)).code).toBe(0);
    const strict = await run(['diff', '--all', '--strict', '--json'], root);
    expect(strict.code).toBe(d.counts.advisory > 0 ? 1 : 0);

    // And a real drift is caught: drop one relationship from the domain file.
    const doc = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const [dropped] = doc.logical.relationships.splice(0, 1);
    fs.writeFileSync(file, JSON.stringify(doc, null, 2));
    const drift = await run(['diff', '--domain', path.relative(root, file), '--json'], root);
    expect(drift.code).toBe(1);
    // The fix names it on its many side (#133), whichever end dbt tests it from.
    expect(JSON.parse(drift.out).domains[0].fixes).toContainEqual(expect.objectContaining({
      kind: 'add-relationship',
      severity: 'blocking',
      relationship: canonicalRelationship(dropped),
    }));
  });
});

describe('end to end, relationships in the model library (#126): inventory → logical model → diff exits 0', () => {
  it('dbt-project', async () => {
    const root = copyProject('dbt-project');
    fs.rmSync(path.join(root, '.erd-studio'), { recursive: true, force: true });
    const models = ['fct_order', 'dim_customer', 'dim_project', 'dim_task', 'fct_task_event', 'fct_sale', 'dim_region', 'dim_date'];
    const inventory = JSON.parse((await run(['inventory', '--models', models.join(','), '--json'], root)).out) as InventoryResult;

    const file = writeTableFromInventory(root, inventory, 'silver', 'orders', 'library');
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).logical.relationships).toEqual([]);

    const diff = await run(['diff', '--domain', path.relative(root, file), '--json'], root);
    const d = (JSON.parse(diff.out) as DiffResult).domains[0];
    expect(d.fixes.filter((f) => f.severity === 'blocking')).toEqual([]);
    expect(diff.code).toBe(0);
    expect(d.counts.matchedRelationships).toBe(inventory.relationships.length);

    // Drift in the library is caught, and the fix names the model file, not the domain.
    const dropped = canonicalRelationship(inventory.relationships[0]);
    const ymlPath = path.join(root, '.erd-studio', 'logical-models', `${dropped.fromModel}.yml`);
    const yml = parseYaml(fs.readFileSync(ymlPath, 'utf-8')) as { relationships: unknown[] };
    yml.relationships = yml.relationships.filter((r) => (r as { toModel: string }).toModel !== dropped.toModel
      || (r as { fromColumn: string }).fromColumn !== dropped.fromColumn);
    fs.writeFileSync(ymlPath, toYaml(yml));
    const drift = await run(['diff', '--domain', path.relative(root, file), '--json'], root);
    expect(drift.code).toBe(1);
    expect(JSON.parse(drift.out).domains[0].fixes).toContainEqual(expect.objectContaining({
      kind: 'add-relationship',
      file: `.erd-studio/logical-models/${dropped.fromModel}.yml`,
    }));
  });
});

describe('the read winner sees dbt\'s key evidence in the CLI as on the canvas (#133 L1)', () => {
  it('CLI diff and canvas diff agree when dbt decides which of two copies is drawn', async () => {
    const root = copyProject('dbt-project');
    const semantic = path.join(root, '.erd-studio');
    for (const entry of fs.readdirSync(semantic)) if (entry !== 'layers.json') fs.rmSync(path.join(semantic, entry), { recursive: true, force: true });
    fs.mkdirSync(path.join(semantic, 'logical-models'));
    fs.mkdirSync(path.join(semantic, 'silver'));
    // No key flagged; the link stored at both ends, both many-to-one (a 1.6.7 leftover).
    const col = (name: string) => ({ name, dataType: 'INT', description: 'x' });
    fs.writeFileSync(path.join(semantic, 'logical-models', 'dim_customer.yml'), toYaml({
      name: 'dim_customer', description: 'x', columns: [col('customer_key')],
      relationships: [{ fromColumn: 'customer_key', toModel: 'fct_order', toColumn: 'customer_key', cardinality: 'many-to-one' }],
    }));
    fs.writeFileSync(path.join(semantic, 'logical-models', 'fct_order.yml'), toYaml({
      name: 'fct_order', description: 'x', columns: [col('order_id'), col('customer_key')],
      relationships: [{ fromColumn: 'customer_key', toModel: 'dim_customer', toColumn: 'customer_key', cardinality: 'many-to-one' }],
    }));
    const file = path.join(semantic, 'silver', 'orders.json');
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 5, domain: 'orders', layer: 'silver', description: '', logical: { models: ['dim_customer', 'fct_order'], relationships: [] }, viewConfig: {} }));

    const ctx = await buildCliContext({ project: root, semanticDir: '.erd-studio' });
    // Flags alone draw the dimension's backwards copy; dbt's unique test on dim_customer.customer_key draws the fact's.
    expect(ctx.subjectAreaService.getSubjectArea(file).logical.relationships[0].fromModel).toBe('dim_customer');
    const canvas = computeSubjectAreaDiff({ subjectAreaService: ctx.subjectAreaService, ymlData: ctx.ymlData, manifest: ctx.manifest, catalog: ctx.catalog }, file, 'logical');
    expect(canvas.source.relationships).toEqual([expect.objectContaining({ fromModel: 'fct_order', toModel: 'dim_customer', cardinality: 'many-to-one' })]);
    expect(canvas.report.relationships.map((r) => r.status)).toEqual(['matched']);

    const { result } = runDiff(ctx, { domains: ['.erd-studio/silver/orders.json'] });
    expect(result.domains[0].report).toEqual(canvas.report);
    expect(result.domains[0].fixes.filter((f) => f.relationship)).toEqual([]);
  });
});

// Native DBML storage (S4): the same promise, with the logical model stored as
// DBML — tables in tables/, relationships in tables/_relationships.dbml, the
// diagram a .dbml naming them through `use` lines — and `--domain` a `.dbml`.
describe('end to end on native DBML storage: inventory → DBML logical model → diff --domain x.dbml exits 0', () => {
  it('dbt-project', async () => {
    const root = copyProject('dbt-project');
    fs.rmSync(path.join(root, '.erd-studio'), { recursive: true, force: true });
    const models = ['fct_order', 'dim_customer', 'dim_project', 'dim_task', 'fct_task_event', 'fct_sale', 'dim_region', 'dim_date'];
    const inventory = JSON.parse((await run(['inventory', '--models', models.join(','), '--json'], root)).out) as InventoryResult;
    const semantic = path.join(root, '.erd-studio');
    // The layer-first tree: silver/tables/silver/<name>.dbml, silver/relationships/silver.dbml, silver/diagrams/orders.dbml.
    fs.mkdirSync(path.join(semantic, 'silver', 'tables', 'silver'), { recursive: true });
    fs.mkdirSync(path.join(semantic, 'silver', 'relationships'), { recursive: true });
    fs.mkdirSync(path.join(semantic, 'silver', 'diagrams'), { recursive: true });
    const tablePath = (name: string): string => `silver/tables/silver/${name}.dbml`;

    const tables = new Map<string, SemanticTable>();
    for (const m of inventory.models) {
      const pk = new Set(m.keyCandidates.unique.length > 0 ? m.keyCandidates.unique : (m.keyCandidates.compositeUnique[0] ?? []));
      const fk = new Set(m.foreignKeys);
      const table: SemanticTable = {
        name: m.name,
        schema: 'silver',
        description: m.description || `${m.name} (draft)`,
        columns: m.columns!.map((c) => ({
          name: c.name,
          dataType: c.dataType || 'STRING',
          description: c.description || '(draft)',
          ...(pk.has(c.name) ? { isPrimaryKey: true } : {}),
          ...(fk.has(c.name) ? { isForeignKey: true } : {}),
        })),
      };
      tables.set(m.name.toLowerCase(), table);
      fs.writeFileSync(path.join(semantic, ...tablePath(m.name).split('/')), renderNewTableDbml(table));
    }
    const owners = new Map<string, { name: string; relationships: TableRelationship[] }>();
    for (const rel of inventory.relationships.map(canonicalRelationship)) {
      const { fromModel, ...rest } = rel;
      const entry = owners.get(fromModel.toLowerCase()) ?? { name: fromModel, relationships: [] };
      entry.relationships.push(rest);
      owners.set(fromModel.toLowerCase(), entry);
    }
    fs.writeFileSync(path.join(semantic, 'silver', 'relationships', 'silver.dbml'), editRelationshipsDbml(null, {
      filePath: 'silver/relationships/silver.dbml',
      owners,
      resolve: (name) => {
        const table = tables.get(name.toLowerCase());
        return table && {
          name: table.name,
          reference: `silver.${table.name}`,
          columns: (c: string) => table.columns.find((col) => col.name.toLowerCase() === c.toLowerCase())?.name,
          path: tablePath(table.name),
          storage: 'dbml' as const,
          primaryKey: table.columns.filter((c) => c.isPrimaryKey).map((c) => c.name),
        };
      },
    }));
    const diagram = path.join(semantic, 'silver', 'diagrams', 'orders.dbml');
    fs.writeFileSync(diagram, renderNewSubjectAreaDbml({
      filePath: 'silver/diagrams/orders.dbml',
      domain: 'orders',
      description: 'Built from inventory',
      members: inventory.models.map((m) => ({ name: m.name, reference: `silver.${m.name}`, path: tablePath(m.name) })),
      relationshipsFiles: ['silver/relationships/silver.dbml'],
    }));

    const diff = await run(['diff', '--domain', path.relative(root, diagram), '--json'], root);
    const result = JSON.parse(diff.out) as DiffResult;
    const d = result.domains[0];
    expect(d).toMatchObject({ file: '.erd-studio/silver/diagrams/orders.dbml', domain: 'orders', layer: 'silver' });
    expect(d.fixes.filter((f) => f.severity === 'blocking')).toEqual([]);
    expect(diff.code).toBe(0);
    expect(result.clean).toBe(true);
    expect(d.missingModelFiles).toEqual([]);
    expect(d.counts.matchedRelationships).toBe(inventory.relationships.length);
    expect((await run(['diff', '--all', '--json'], root)).code).toBe(0);

    // The diagram stops importing the relationships file: every Ref is still there, only not drawn.
    // The fix is the import, never a second copy of each Ref (a duplicate, error 5001).
    const importLine = "use * from '../relationships/silver.dbml'";
    const text = fs.readFileSync(diagram, 'utf-8');
    expect(text).toContain(importLine);
    fs.writeFileSync(diagram, text.replace(`${importLine}\n`, ''));
    const unimported = JSON.parse((await run(['diff', '--domain', path.relative(root, diagram), '--json'], root)).out) as DiffResult;
    const fixes = unimported.domains[0].fixes.filter((f) => f.severity === 'blocking');
    expect(fixes.length).toBe(inventory.relationships.length);
    for (const f of fixes) {
      expect(f).toMatchObject({
        kind: 'import-relationships-file', file: '.erd-studio/silver/diagrams/orders.dbml',
        storedIn: '.erd-studio/silver/relationships/silver.dbml', useLine: importLine,
      });
    }
    // Following the fix makes the diagram clean again.
    fs.writeFileSync(diagram, text);
    expect((await run(['diff', '--domain', path.relative(root, diagram), '--json'], root)).code).toBe(0);
  });
});

describe('diff names a DBML diagram\'s errors', () => {
  it('a .dbml that does not parse is dbml-invalid with its file and line; a table file is not-a-diagram', async () => {
    const root = copyProject('dbt-project');
    const semantic = path.join(root, '.erd-studio');
    fs.mkdirSync(path.join(semantic, 'silver', 'tables', 'silver'), { recursive: true });
    fs.mkdirSync(path.join(semantic, 'silver', 'diagrams'), { recursive: true });
    fs.writeFileSync(path.join(semantic, 'silver', 'tables', 'silver', 'dim_x.dbml'), 'Table silver.dim_x {\n  id INT\n}\n');
    fs.writeFileSync(path.join(semantic, 'silver', 'diagrams', 'broken.dbml'), "Project broken {\n  erd_schema_version: '7'\n");

    const broken = await run(['diff', '--domain', '.erd-studio/silver/diagrams/broken.dbml', '--json'], root);
    expect(broken.code).toBe(3);
    const error = JSON.parse(broken.out).error;
    expect(error.code).toBe('dbml-invalid');
    expect(error.message).toMatch(/^\.erd-studio\/silver\/diagrams\/broken\.dbml:\d+: /);

    const table = await run(['diff', '--domain', '.erd-studio/silver/tables/silver/dim_x.dbml', '--json'], root);
    expect(table.code).toBe(3);
    expect(JSON.parse(table.out).error.code).toBe('not-a-diagram');
  });
});

describe('diff on native DBML storage (§7.1, S8): fix paths and kinds', () => {
  const plan: SyncPlan = {
    generatedAt: '', domain: 'd', layer: 'gold', sourceStage: 'logical', targetStage: 'physical',
    models: [], requiresCompile: false,
    modelContext: {
      f: { modelName: 'f', logicalModelPath: '.erd-studio/gold/tables/gold/f.dbml', relationshipsPath: '.erd-studio/gold/relationships/gold.dbml', dbtSqlPath: null, dbtSchemaPath: null },
      m: { modelName: 'm', logicalModelPath: '.erd-studio/silver/tables/silver/m.dbml', relationshipsPath: '.erd-studio/silver/relationships/silver.dbml', dbtSqlPath: null, dbtSchemaPath: null },
    },
    columns: [
      { modelName: 'm', columnName: 'c', discrepancyStatus: 'missing', groundTruth: 'physical', action: 'add-column-to-logical', targetDataType: 'DATE', resolvedDataType: 'DATE' },
    ],
    relationships: [
      { fromModel: 'f', fromColumn: 'k', toModel: 'm', toColumn: 'k', discrepancyStatus: 'missing', groundTruth: 'physical', action: 'add-relationship-to-logical', targetCardinality: 'many-to-one' },
    ],
  };
  const library = { inLibrary: new Map<string, Relationship>(), addToLibrary: true };

  it('a column fix names the .dbml table file and a new relationship the file the project places it in (relationshipsPath)', () => {
    const fixes = fixesFromPlan(plan, '.erd-studio/gold/diagrams/d.dbml', '.erd-studio', [], [], library);
    expect(fixes.find((f) => f.kind === 'add-column')).toMatchObject({ file: '.erd-studio/silver/tables/silver/m.dbml' });
    expect(fixes.find((f) => f.kind === 'add-relationship')).toMatchObject({ file: '.erd-studio/gold/relationships/gold.dbml', model: 'f' });
  });

  it('a relationship to add whose Ref is already stored (storedIn) is an import of that file into the diagram, not a second Ref', () => {
    const storedIn = '.erd-studio/silver/relationships/orders.dbml';
    const unimported: SyncPlan = { ...plan, columns: [], relationships: [{ ...plan.relationships[0], storedIn }] };
    const fixes = fixesFromPlan(unimported, '.erd-studio/gold/diagrams/d.dbml', '.erd-studio', [], [], library);
    expect(fixes).toHaveLength(1);
    expect(fixes[0]).toMatchObject({
      severity: 'blocking', kind: 'import-relationships-file', file: '.erd-studio/gold/diagrams/d.dbml', storedIn,
      useLine: "use * from '../../silver/relationships/orders.dbml'",
      relationship: { fromModel: 'f', fromColumn: 'k', toModel: 'm', toColumn: 'k', cardinality: 'many-to-one' },
    });
    expect(fixes[0].explain).toContain('Do not add the Ref again');
  });

  it('a stored Ref is fixed where it is held (storedIn): a cardinality change turns it round in place, with no movesFrom', () => {
    const rel = { fromModel: 'f', fromColumn: 'k', toModel: 'm', toColumn: 'k', cardinality: 'many-to-one' as const };
    const storedIn = '.erd-studio/gold/relationships/by-hand.dbml';
    const toOneToMany: SyncPlan = { ...plan, columns: [], relationships: [{ ...plan.relationships[0], discrepancyStatus: 'cardinality-mismatch', action: 'update-cardinality-in-logical', sourceCardinality: 'many-to-one', targetCardinality: 'one-to-many', storedIn }] };
    const [fix] = fixesFromPlan(toOneToMany, 'd.dbml', '.erd-studio', [], [], { inLibrary: new Map([[linkKey(rel), rel]]), addToLibrary: true });
    expect(fix).toMatchObject({ kind: 'set-cardinality', file: storedIn, relationship: { fromModel: 'm', toModel: 'f' } });
    expect(fix.movesFrom).toBeUndefined();
    const removal: SyncPlan = { ...plan, columns: [], relationships: [{ ...plan.relationships[0], discrepancyStatus: 'extra', action: 'remove-relationship-from-logical', sourceCardinality: 'many-to-one', storedIn }] };
    expect(fixesFromPlan(removal, 'd.dbml', '.erd-studio', [], [], { inLibrary: new Map([[linkKey(rel), rel]]), addToLibrary: true })[0])
      .toMatchObject({ kind: 'remove-relationship', file: storedIn });
  });

  it('a YAML entry a cardinality fix turns round still moves to its many side\'s file (movesFrom)', () => {
    const yamlPlan: SyncPlan = {
      ...plan, columns: [],
      modelContext: {
        f: { modelName: 'f', logicalModelPath: '.erd-studio/logical-models/f.yml', dbtSqlPath: null, dbtSchemaPath: null },
        m: { modelName: 'm', logicalModelPath: '.erd-studio/logical-models/m.yml', dbtSqlPath: null, dbtSchemaPath: null },
      },
      relationships: [{ ...plan.relationships[0], discrepancyStatus: 'cardinality-mismatch', action: 'update-cardinality-in-logical', sourceCardinality: 'many-to-one', targetCardinality: 'one-to-many' }],
    };
    const rel = { fromModel: 'f', fromColumn: 'k', toModel: 'm', toColumn: 'k', cardinality: 'many-to-one' as const };
    const [fix] = fixesFromPlan(yamlPlan, 'd.json', '.erd-studio', [], [], { inLibrary: new Map([[linkKey(rel), rel]]), addToLibrary: true });
    expect(fix).toMatchObject({ kind: 'set-cardinality', file: '.erd-studio/logical-models/m.yml', movesFrom: '.erd-studio/logical-models/f.yml' });
  });

  it('an unreadable .dbml table is fix-dbml-file, a .yml one fix-model-yaml', () => {
    const unreadable = [
      { name: 'm', file: '.erd-studio/silver/tables/silver/m.dbml', kind: 'dbmlInvalid' as const, line: 2, code: '3075', message: 'x' },
      { name: 'y', file: '.erd-studio/logical-models/y.yml', kind: 'yamlScalar' as const, line: 3, message: 'y' },
    ];
    const fixes = fixesFromPlan({ ...plan, columns: [], relationships: [] }, 'd.dbml', '.erd-studio', [], unreadable);
    expect(fixes.map((f) => [f.model, f.kind, f.line])).toEqual([['m', 'fix-dbml-file', 2], ['y', 'fix-model-yaml', 3]]);
    expect(fixes[0].explain).toContain("quote the value, as in grain: 'One row per order line'");
  });

  it('a DBML table file that does not read gets one fix-dbml-file in a real diff', async () => {
    const root = copyProject('dbt-project');
    fs.rmSync(path.join(root, '.erd-studio', 'gold', 'finance.json'));
    const plan = await planDbmlConversion(readDbmlConversionInput(root, '.erd-studio'));
    writeConversion(root, plan);
    const target = plan.targets.find((t) => t.target.endsWith('/dim_customer.dbml'))!.target;
    expect(target).toMatch(/^[^/]+\/tables\/[^/]+\/dim_customer\.dbml$/);
    const file = path.join(root, '.erd-studio', ...target.split('/'));
    fs.writeFileSync(file, fs.readFileSync(file, 'utf-8').replace(/\[([^\]]*)role: '([^']*)'/, '[$1role: $2 x'));
    const r = JSON.parse((await run(['diff', '--all', '--json'], root)).out) as DiffResult;
    const fixes = r.domains.flatMap((d) => d.fixes).filter((f) => f.model === 'dim_customer');
    expect(fixes.length).toBeGreaterThan(0);
    expect(fixes.every((f) => f.kind === 'fix-dbml-file' && f.file === `.erd-studio/${target}`)).toBe(true);
  });
});

/** Apply a Convert plan to disk, as the command's one edit would. */
function writeConversion(root: string, plan: DbmlConversionPlan): void {
  const erd = path.join(root, '.erd-studio');
  for (const c of plan.creates) {
    fs.mkdirSync(path.dirname(path.join(erd, c.path)), { recursive: true });
    fs.writeFileSync(path.join(erd, c.path), c.text);
  }
  for (const r of plan.replaces) fs.writeFileSync(path.join(erd, r.path), r.text);
  for (const d of plan.deletes) fs.rmSync(path.join(erd, d));
  fs.rmSync(path.join(erd, 'logical-models'), { recursive: true, force: true });
}

describe('YAML/DBML twin parity: diff on the converted dbt-project copy (§9.6)', () => {
  it('diff --all agrees before and after Convert Project to DBML, apart from file paths and the moved relationships', async () => {
    const yaml = copyProject('dbt-project');
    fs.rmSync(path.join(yaml, '.erd-studio', 'gold', 'finance.json'));
    const dbml = path.join(tmp, 'converted');
    fs.cpSync(yaml, dbml, { recursive: true });
    const plan = await planDbmlConversion(readDbmlConversionInput(dbml, '.erd-studio'));
    expect(plan.refusals).toEqual([]);
    writeConversion(dbml, plan);

    const before = JSON.parse((await run(['diff', '--all', '--json'], yaml)).out) as DiffResult;
    const after = JSON.parse((await run(['diff', '--all', '--json'], dbml)).out) as DiffResult;
    // A diagram is `<layer>/<name>` on both sides: `gold/sales.json` before, `gold/diagrams/sales.dbml` after.
    const key = (file: string): string => file.replace(/^\.erd-studio\//, '').replace(/^([^/]+)\/diagrams\/([^/]+)$/, '$1/$2').replace(/\.(json|dbml)$/, '');
    const moved = new Set(plan.movedRelationships.flatMap((m) => m.diagrams.map(key)));
    const shape = (d: DiffResult['domains'][number]) => ({
      domain: d.domain, layer: d.layer, clean: d.clean, error: d.error?.code,
      phantoms: d.phantoms, missingModelFiles: d.missingModelFiles, modelsWithoutColumns: d.modelsWithoutColumns,
      unreadable: d.unreadableModelFiles.map((u) => u.name),
      fixes: d.fixes.map(({ file: _file, movesFrom: _movesFrom, explain: _explain, ...rest }) => rest),
      counts: d.counts,
    });
    expect(after.domains.map((d) => key(d.file)).sort()).toEqual(before.domains.map((d) => key(d.file)).sort());
    let compared = 0;
    for (const b of before.domains) {
      const a = after.domains.find((d) => key(d.file) === key(b.file))!;
      expect(a.file).toBe(b.file.replace(/^(\.erd-studio\/[^/]+)\/([^/]+)\.json$/, '$1/diagrams/$2.dbml'));
      // Every DBML fix names a .dbml file: a table file, or a relationships file for a relationship.
      for (const f of a.fixes) {
        if (f.kind === 'resolve-phantom') continue;
        expect(f.file, `${a.file} ${f.kind}`).toMatch(/\.dbml$/);
        if (/relationship|cardinality/.test(f.kind) && f.kind !== 'declare-composite-foreign-key') expect(f.file).toMatch(/^\.erd-studio\/[^/]+\/relationships\/[^/]+\.dbml$/);
        else expect(f.file).toMatch(/^\.erd-studio\/[^/]+\/(tables\/[^/]+|diagrams)\/[^/]+\.dbml$/);
      }
      if (moved.has(key(b.file))) continue; // these gain the relationships Convert moved into the library
      // An older (v4) file with no inline table converts straight to a DBML diagram: no migration left to ask for.
      if (b.needsMigration) { expect(a.needsMigration, a.file).toBeUndefined(); continue; }
      compared++;
      expect(shape(a), b.file).toEqual(shape(b));
    }
    expect(compared).toBeGreaterThan(0);
    expect(after.clean).toBe(before.clean);
  }, 60_000);
});
