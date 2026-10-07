import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { allSelections, buildSyncPlan, countSyncPlanActions } from '../../src/services/syncPlanBuilder';
import { computeDomainDiff } from '../../src/services/stageDiff';
import { DomainService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { LogicalModelService } from '../../src/services/logicalModelService';
import { ManifestService } from '../../src/services/manifestService';
import { YmlParserService } from '../../src/services/ymlParserService';
import { TemplateService } from '../../src/services/templateService';
import { SelectorsService } from '../../src/services/selectorsService';
import { SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import type { DiscrepancyReport } from '../../src/types/discrepancy';
import type { ManifestData } from '../../src/types/manifest';
import type { YmlData } from '../../src/types/ymlData';

const REPO_ROOT = path.resolve(__dirname, '../..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'test', 'fixtures', 'dbt-project');

function report(sourceStage: 'logical' | 'physical' = 'logical'): DiscrepancyReport {
  return {
    domain: 'orders',
    layer: 'gold',
    sourceStage,
    targetStage: sourceStage === 'logical' ? 'physical' : 'logical',
    models: [
      { name: 'fct_order', status: 'matched', columns: [
        { name: 'order_id', status: 'matched' },
        { name: 'amount', status: 'type-mismatch', sourceDataType: 'float', targetDataType: 'decimal(18,2)' },
        { name: 'segment', status: 'undeclared', sourceDataType: 'string', targetDataType: '' },
        { name: 'odd:name', status: 'missing', targetDataType: 'int' },
      ] },
      { name: 'dim_extra', status: 'extra', columns: [{ name: 'x', status: 'extra', sourceDataType: 'int' }] },
      { name: 'dim_missing', status: 'missing', columns: [] },
    ],
    relationships: [
      { fromModel: 'fct_order', fromColumn: 'customer_id', toModel: 'dim_customer', toColumn: 'customer_id', status: 'missing', targetCardinality: 'many-to-one' },
      { fromModel: 'fct_order', fromColumn: 'date_id', toModel: 'dim_date', toColumn: 'date_id', status: 'matched' },
      { fromModel: 'fct_order', fromColumn: 'store_id', toModel: 'dim_store', toColumn: 'store_id', status: 'cardinality-mismatch', sourceCardinality: 'one-to-one', targetCardinality: 'many-to-one' },
    ],
    summary: {
      totalModels: 3, matchedModels: 1, extraModels: 1, missingModels: 1, totalColumns: 5, matchedColumns: 1,
      extraColumns: 1, missingColumns: 1, dataTypeMismatches: 1, undeclaredColumns: 1,
    },
  };
}

const emptyManifest: ManifestData = {
  models: new Map(), relationshipTests: [], uniqueColumns: new Map(), compositeUniqueGroups: new Map(), disabledModels: new Set(),
};
const emptyYml = { models: new Map() } as unknown as YmlData;

describe('allSelections', () => {
  it('keys every non-matched model, column and relationship', () => {
    expect(allSelections(report(), 'physical')).toEqual({
      'col:fct_order:amount': 'physical',
      'col:fct_order:segment': 'physical',
      'col:fct_order:odd:name': 'physical',
      'model:dim_extra': 'physical',
      'col:dim_extra:x': 'physical',
      'model:dim_missing': 'physical',
      'rel:fct_order:customer_id:dim_customer:customer_id': 'physical',
      'rel:fct_order:store_id:dim_store:store_id': 'physical',
    });
  });

  it('is empty for a clean report', () => {
    const clean = { ...report(), models: [], relationships: [] };
    expect(allSelections(clean, 'logical')).toEqual({});
  });
});

describe('buildSyncPlan', () => {
  const ctx = {
    manifest: emptyManifest, ymlData: emptyYml, projectRoot: '/proj', semanticDir: '.erd-studio',
    domain: 'orders', layer: 'gold', now: new Date('2026-01-02T03:04:05.000Z'),
  };

  it('resolves physical-as-truth into logical edits, with no compile needed', () => {
    const plan = buildSyncPlan(report(), allSelections(report(), 'physical'), ctx);
    expect(plan.generatedAt).toBe('2026-01-02T03:04:05.000Z');
    expect(plan).toMatchObject({ domain: 'orders', layer: 'gold', sourceStage: 'logical', targetStage: 'physical', requiresCompile: false });
    expect(plan.models.map((m) => [m.modelName, m.action])).toEqual([
      ['dim_extra', 'remove-from-logical'],
      ['dim_missing', 'add-to-logical'],
    ]);
    const amount = plan.columns.find((c) => c.columnName === 'amount')!;
    expect(amount).toMatchObject({ action: 'update-type-in-logical', resolvedDataType: 'decimal(18,2)' });
    expect(plan.columns.find((c) => c.columnName === 'odd:name')).toMatchObject({ modelName: 'fct_order', action: 'add-column-to-logical' });
    expect(plan.relationships.map((r) => r.action)).toEqual(['add-relationship-to-logical', 'update-cardinality-in-logical']);
    expect(countSyncPlanActions(plan)).toBe(plan.models.length + plan.columns.length + plan.relationships.length);
    expect(plan.modelContext.fct_order).toEqual({
      modelName: 'fct_order',
      logicalModelPath: '.erd-studio/logical-models/fct_order.yml',
      dbtSqlPath: null,
      dbtSchemaPath: null,
    });
    expect(Object.keys(plan.modelContext).sort()).toEqual(['dim_customer', 'dim_extra', 'dim_missing', 'dim_store', 'fct_order']);
  });

  it('marks requiresCompile when logical is truth', () => {
    const plan = buildSyncPlan(report(), allSelections(report(), 'logical'), ctx);
    expect(plan.requiresCompile).toBe(true);
    // extra + logical truth viewed from logical is a no-op.
    expect(plan.models.map((m) => m.modelName)).toEqual(['dim_missing']);
  });

  it('skips matched, unknown and malformed keys', () => {
    const plan = buildSyncPlan(report(), {
      'col:fct_order:order_id': 'physical',
      'model:nope': 'physical',
      'rel:fct_order:date_id:dim_date:date_id': 'physical',
      'weird': 'physical',
    }, ctx);
    expect(countSyncPlanActions(plan)).toBe(0);
    expect(plan.modelContext).toEqual({});
  });

  it('finds a relationship row from a key naming the link the other way round or in another case (#133)', () => {
    const plan = buildSyncPlan(report(), { 'rel:DIM_CUSTOMER:Customer_Id:fct_order:customer_id': 'physical' }, ctx);
    // The row's own ends are carried: its cardinalities are read in its direction.
    expect(plan.relationships).toEqual([{
      fromModel: 'fct_order', fromColumn: 'customer_id', toModel: 'dim_customer', toColumn: 'customer_id',
      discrepancyStatus: 'missing', groundTruth: 'physical', action: 'add-relationship-to-logical',
      sourceCardinality: undefined, targetCardinality: 'many-to-one',
      resolvedCardinality: 'many-to-one',
      resolvedRelationship: { fromModel: 'fct_order', fromColumn: 'customer_id', toModel: 'dim_customer', toColumn: 'customer_id', cardinality: 'many-to-one' },
    }]);
    expect(Object.keys(plan.modelContext).sort()).toEqual(['dim_customer', 'fct_order']);
  });

  it('plans both rows of a one-to-one the other stage stores the other way round (#133)', () => {
    const flipped: DiscrepancyReport = {
      ...report(),
      models: [],
      relationships: [
        { fromModel: 'person', fromColumn: 'person_id', toModel: 'employee', toColumn: 'person_id', status: 'extra', sourceCardinality: 'one-to-one' },
        { fromModel: 'employee', fromColumn: 'person_id', toModel: 'person', toColumn: 'person_id', status: 'missing', targetCardinality: 'one-to-one' },
      ],
    };
    const plan = buildSyncPlan(flipped, allSelections(flipped, 'physical'), ctx);
    expect(plan.relationships.map((r) => [r.fromModel, r.toModel, r.action])).toEqual([
      ['person', 'employee', 'remove-relationship-from-logical'],
      ['employee', 'person', 'add-relationship-to-logical'],
    ]);
  });

  it('prefers the yml path, then the manifest path, for dbt file context', () => {
    const manifest = { ...emptyManifest, models: new Map([['dim_missing', { originalFilePath: 'models/dims/dim_missing.sql' }]]) } as unknown as ManifestData;
    const ymlData = { models: new Map([['dim_extra', { filePath: '/proj/models/schema.yaml' }]]) } as unknown as YmlData;
    const plan = buildSyncPlan(report(), allSelections(report(), 'physical'), { ...ctx, manifest, ymlData });
    expect(plan.modelContext.dim_extra).toMatchObject({ dbtSchemaPath: 'models/schema.yaml', dbtSqlPath: 'models/schema.sql' });
    expect(plan.modelContext.dim_missing).toMatchObject({ dbtSqlPath: 'models/dims/dim_missing.sql', dbtSchemaPath: 'models/dims/dim_missing.yml' });
  });

  it('emits forward-slash paths even from Windows-style inputs', () => {
    const manifest = { ...emptyManifest, models: new Map([['dim_missing', { originalFilePath: 'models\\dims\\dim_missing.sql' }]]) } as unknown as ManifestData;
    const plan = buildSyncPlan(report(), allSelections(report(), 'physical'), { ...ctx, manifest, semanticDir: 'my erd\\data' });
    expect(plan.modelContext.dim_missing).toMatchObject({
      dbtSqlPath: 'models/dims/dim_missing.sql',
      dbtSchemaPath: 'models/dims/dim_missing.yml',
      logicalModelPath: 'my erd/data/logical-models/dim_missing.yml',
    });
    for (const c of Object.values(plan.modelContext)) {
      for (const p of [c.logicalModelPath, c.dbtSqlPath, c.dbtSchemaPath]) { expect(p ?? '').not.toContain('\\'); }
    }
  });

  it('points logicalModelPath at the model\'s real layer folder when a lookup is given (issue #76)', () => {
    const folders: Record<string, string | null> = { fct_order: 'gold', dim_customer: '', dim_missing: null };
    const plan = buildSyncPlan(report(), allSelections(report(), 'physical'), { ...ctx, modelFolder: (n) => folders[n] ?? null });
    expect(plan.modelContext.fct_order.logicalModelPath).toBe('.erd-studio/logical-models/gold/fct_order.yml');
    expect(plan.modelContext.dim_customer.logicalModelPath).toBe('.erd-studio/logical-models/dim_customer.yml');
    // No file yet (a model to add): the top-level path, as before.
    expect(plan.modelContext.dim_missing.logicalModelPath).toBe('.erd-studio/logical-models/dim_missing.yml');
  });

  it('resolves types stage-absolutely when compared from physical', () => {
    const r = report('physical');
    const plan = buildSyncPlan(r, { 'col:fct_order:amount': 'physical' }, ctx);
    // From physical, the source side is physical, so physical truth takes sourceDataType.
    expect(plan.columns[0]).toMatchObject({ action: 'update-type-in-logical', resolvedDataType: 'float' });
  });
});

describe('SemanticEditorProvider.handleGenerateSyncPlan parity', () => {
  it('writes exactly the plan buildSyncPlan builds for the same selections', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-plan-builder-'));
    try {
      fs.cpSync(FIXTURE_ROOT, tmp, { recursive: true });
      const layerService = new LayerService(tmp, '.erd-studio');
      const domainService = new DomainService(layerService);
      const logicalModelService = new LogicalModelService(tmp, '.erd-studio');
      domainService.setLogicalModelService(logicalModelService);
      const manifestService = new ManifestService();
      const ymlParserService = new YmlParserService();
      const context = {
        extensionUri: vscode.Uri.file(REPO_ROOT),
        globalStorageUri: vscode.Uri.file(path.join(tmp, '.global-storage')),
        extension: { packageJSON: { version: '0.0.0-test' } },
        globalState: { get: () => true, update: async () => {} },
        secrets: vscode.createMockSecretStorage(),
        subscriptions: [],
      } as unknown as import('vscode').ExtensionContext;
      const provider = new SemanticEditorProvider(
        context, domainService, manifestService, ymlParserService, new TemplateService(),
        layerService, tmp, new SelectorsService(domainService, tmp, '.erd-studio'), logicalModelService,
      );

      const file = path.join(tmp, '.erd-studio', 'silver', 'showcase.json');
      const text = fs.readFileSync(file, 'utf-8');
      const doc = {
        uri: vscode.Uri.file(file), isDirty: false, isClosed: false,
        getText: () => text, positionAt: (offset: number) => ({ offset }), save: vi.fn(async () => true),
      };
      const panel = vscode.createMockWebviewPanel();
      await provider.resolveCustomTextEditor(
        doc as unknown as import('vscode').TextDocument,
        panel as unknown as import('vscode').WebviewPanel,
        {} as import('vscode').CancellationToken,
      );
      const posted = () => panel._postedMessages as Array<{ type: string; payload?: any }>;
      panel._simulateMessage({ type: 'ready' });
      await vi.waitFor(() => expect(posted().some((m) => m.type === 'domainLoaded')).toBe(true), { timeout: 4000 });
      panel._simulateMessage({ type: 'toggleDiscrepancy', payload: { enabled: true, compareAgainst: 'physical' } });
      await vi.waitFor(() => expect(posted().some((m) => m.type === 'discrepancyReport' && m.payload)).toBe(true), { timeout: 4000 });
      const shown: DiscrepancyReport = posted().find((m) => m.type === 'discrepancyReport' && m.payload)!.payload;

      const selections = allSelections(shown, 'physical');
      expect(Object.keys(selections).length).toBeGreaterThan(0);
      panel._simulateMessage({ type: 'generateSyncPlan', payload: { selections } });
      await vi.waitFor(() => expect(posted().some((m) => m.type === 'syncPlanGenerated')).toBe(true), { timeout: 4000 });

      const written = JSON.parse(fs.readFileSync(path.join(tmp, '.erd-studio', '.sync-plan.json'), 'utf-8'));
      const manifest = await manifestService.loadManifest(tmp);
      const ymlData = await ymlParserService.loadYmlData(tmp, undefined);
      const expected = buildSyncPlan(shown, selections, {
        manifest, ymlData, projectRoot: tmp, semanticDir: '.erd-studio', domain: 'showcase', layer: 'silver',
        now: new Date(written.generatedAt),
      });
      expect(written).toEqual(JSON.parse(JSON.stringify(expected)));
      expect(posted().find((m) => m.type === 'syncPlanGenerated')!.payload.totalActions).toBe(countSyncPlanActions(expected));

      // And the CLI route — computeDomainDiff + allSelections — sees the same report.
      const cli = computeDomainDiff({ domainService, ymlData, manifest }, file, 'logical');
      expect(cli.report).toEqual(shown);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('buildSyncPlan — the cardinality to write is stage-absolute (#133 review 6)', () => {
  const ctx = {
    manifest: emptyManifest, ymlData: emptyYml, projectRoot: '/proj', semanticDir: '.erd-studio',
    domain: 'tasks', layer: 'gold', now: new Date('2026-01-02T03:04:05.000Z'),
  };
  // dbt tests dim_task.task_key → fct_task_event.task_key as one-to-many (declared on the
  // dimension); logical stores fct → dim one-to-one. Compared from the physical stage, the
  // row is physical's: source = dbt's one-to-many, target = logical's one-to-one.
  const physicalSource = (): DiscrepancyReport => ({
    domain: 'tasks', layer: 'gold', sourceStage: 'physical', targetStage: 'logical', models: [],
    relationships: [{
      fromModel: 'dim_task', fromColumn: 'task_key', toModel: 'fct_task_event', toColumn: 'task_key',
      status: 'cardinality-mismatch', sourceCardinality: 'one-to-many', targetCardinality: 'one-to-one',
    }],
    summary: { totalModels: 0, matchedModels: 0, extraModels: 0, missingModels: 0, totalColumns: 0, matchedColumns: 0, extraColumns: 0, missingColumns: 0, dataTypeMismatches: 0, undeclaredColumns: 0 },
  } as DiscrepancyReport);

  it('physical as ground truth on a physical-stage plan: dbt\'s value, stored on the fact as many-to-one', () => {
    const plan = buildSyncPlan(physicalSource(), { 'rel:dim_task:task_key:fct_task_event:task_key': 'physical' }, ctx);
    expect(plan.relationships[0]).toMatchObject({
      action: 'update-cardinality-in-logical',
      resolvedCardinality: 'one-to-many',
      resolvedRelationship: { fromModel: 'fct_task_event', fromColumn: 'task_key', toModel: 'dim_task', toColumn: 'task_key', cardinality: 'many-to-one' },
    });
  });

  it('logical as ground truth on a physical-stage plan: the logical value', () => {
    const plan = buildSyncPlan(physicalSource(), { 'rel:dim_task:task_key:fct_task_event:task_key': 'logical' }, ctx);
    expect(plan.relationships[0]).toMatchObject({ action: 'update-cardinality-in-physical', resolvedCardinality: 'one-to-one' });
  });

  it('a logical-stage plan resolves to the same stored relationship', () => {
    const fromLogical: DiscrepancyReport = {
      ...physicalSource(), sourceStage: 'logical', targetStage: 'physical',
      relationships: [{
        fromModel: 'fct_task_event', fromColumn: 'task_key', toModel: 'dim_task', toColumn: 'task_key',
        status: 'cardinality-mismatch', sourceCardinality: 'one-to-one', targetCardinality: 'many-to-one',
      }],
    };
    const plan = buildSyncPlan(fromLogical, { 'rel:fct_task_event:task_key:dim_task:task_key': 'physical' }, ctx);
    expect(plan.relationships[0].resolvedRelationship).toEqual(
      { fromModel: 'fct_task_event', fromColumn: 'task_key', toModel: 'dim_task', toColumn: 'task_key', cardinality: 'many-to-one' },
    );
  });
});
