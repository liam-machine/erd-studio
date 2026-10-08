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
import { computeDomainDiff } from '../../src/services/stageDiff';
import { allSelections, buildSyncPlan } from '../../src/services/syncPlanBuilder';
import type { SyncPlan } from '../../src/types/syncPlan';
import type { Relationship } from '../../src/types/semantic';

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
  it('the showcase report is exactly computeDomainDiff from logical, and the plan is buildSyncPlan(all physical)', async () => {
    const ctx = await buildCliContext({ project: PROJECT, semanticDir: '.erd-studio' });
    const { result, exitCode } = runDiff(ctx, { domains: ['.erd-studio/silver/showcase.json'] });
    expect(exitCode).toBe(1);
    const d = result.domains[0];
    const file = path.join(PROJECT, '.erd-studio/silver/showcase.json');
    const expected = computeDomainDiff(
      { domainService: ctx.domainService, ymlData: ctx.ymlData, manifest: ctx.manifest, catalog: ctx.catalog }, file, 'logical');
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

  it('a domain in a layer layers.json does not define: skipped by --all, unknown-layer for --domain', async () => {
    const root = copyProject();
    fs.mkdirSync(path.join(root, '.erd-studio', 'platinum'));
    fs.copyFileSync(path.join(root, '.erd-studio/silver/showcase.json'), path.join(root, '.erd-studio/platinum/odd.json'));
    // listDomains walks only the configured layers, so --all never sees it…
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
function writeModelFromInventory(
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

    const file = writeModelFromInventory(root, inventory, 'silver', 'orders');

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

    const file = writeModelFromInventory(root, inventory, 'silver', 'orders', 'library');
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
    expect(ctx.domainService.getDomain(file).logical.relationships[0].fromModel).toBe('dim_customer');
    const canvas = computeDomainDiff({ domainService: ctx.domainService, ymlData: ctx.ymlData, manifest: ctx.manifest, catalog: ctx.catalog }, file, 'logical');
    expect(canvas.source.relationships).toEqual([expect.objectContaining({ fromModel: 'fct_order', toModel: 'dim_customer', cardinality: 'many-to-one' })]);
    expect(canvas.report.relationships.map((r) => r.status)).toEqual(['matched']);

    const { result } = runDiff(ctx, { domains: ['.erd-studio/silver/orders.json'] });
    expect(result.domains[0].report).toEqual(canvas.report);
    expect(result.domains[0].fixes.filter((f) => f.relationship)).toEqual([]);
  });
});
