import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { allSelections, buildSyncPlan, countSyncPlanActions, syncPlanLibraryLookups } from '../../src/services/syncPlanBuilder';
import { computeSubjectAreaDiff } from '../../src/services/stageDiff';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { ManifestService } from '../../src/services/manifestService';
import { YmlParserService } from '../../src/services/ymlParserService';
import { TemplateService } from '../../src/services/templateService';
import { SelectorsService } from '../../src/services/selectorsService';
import { SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import type { DiscrepancyReport } from '../../src/types/discrepancy';
import type { ManifestData } from '../../src/types/manifest';
import type { YmlData } from '../../src/types/ymlData';
import { DBT_FIXTURES, copyDbtFixture, diagramPath, tableFilePath } from './helpers/dbtFixtures';

const REPO_ROOT = path.resolve(__dirname, '../..');

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

  it('leaves out every column and relationship entry of a table whose file does not read, either way round', () => {
    // fct_order's file failed to read: every difference about it is an artefact of that.
    const tableUnreadable = (name: string) => name === 'fct_order';
    for (const truth of ['physical', 'logical'] as const) {
      const plan = buildSyncPlan(report(), allSelections(report(), truth), { ...ctx, tableUnreadable });
      expect(plan.columns.filter((c) => c.modelName === 'fct_order'), truth).toEqual([]);
      expect(plan.relationships.filter((r) => r.fromModel === 'fct_order' || r.toModel === 'fct_order'), truth).toEqual([]);
      expect(plan.unreadableTables, truth).toEqual(['fct_order']);
      // Entries about other tables stay.
      const whole = buildSyncPlan(report(), allSelections(report(), truth), ctx);
      expect(plan.models, truth).toEqual(whole.models);
      expect(plan.columns, truth).toEqual(whole.columns.filter((c) => c.modelName !== 'fct_order'));
      expect(whole.columns.some((c) => c.modelName === 'fct_order'), truth).toBe(true);
    }
    // A relationship whose other end does not read is left out too, and that end is listed.
    const dimUnreadable = buildSyncPlan(report(), allSelections(report(), 'physical'), { ...ctx, tableUnreadable: (n: string) => n === 'dim_store' });
    expect(dimUnreadable.relationships.map((r) => r.toModel)).toEqual(['dim_customer']);
    expect(dimUnreadable.unreadableTables).toEqual(['dim_store']);
    // Every table read: no field.
    expect(buildSyncPlan(report(), allSelections(report(), 'physical'), { ...ctx, tableUnreadable: () => false })).not.toHaveProperty('unreadableTables');
    expect(buildSyncPlan(report(), allSelections(report(), 'physical'), ctx)).not.toHaveProperty('unreadableTables');
  });

  it('a composite resolution carries its pairs and is selected by a joined key (#133 L2)', () => {
    const pairs = [{ fromColumn: 'hk', toColumn: 'hk' }, { fromColumn: 'as_of', toColumn: 'load_date' }];
    const composite: DiscrepancyReport = {
      ...report(), models: [],
      relationships: [
        { fromModel: 'pit', fromColumn: 'hk', toModel: 'sat', toColumn: 'hk', pairs, compositeKey: 'fk_sat', status: 'missing', targetCardinality: 'many-to-one' },
        { fromModel: 'pit2', fromColumn: 'hk', toModel: 'sat', toColumn: 'hk', pairs, compositeKey: 'fk_sat', status: 'extra', sourceCardinality: 'many-to-one', composite: true, undeclaredPairs: pairs },
      ],
    };
    const selections = allSelections(composite, 'physical');
    expect(Object.keys(selections)).toEqual(['rel:pit:hk+as_of:sat:hk+load_date', 'rel:pit2:hk+as_of:sat:hk+load_date']);
    const plan = buildSyncPlan(composite, selections, ctx);
    expect(plan.relationships).toEqual([
      expect.objectContaining({ fromModel: 'pit', action: 'add-relationship-to-logical', pairs, compositeKey: 'fk_sat' }),
      // An undeclared composite is not wrong in the logical model: dbt is asked to declare it.
      expect.objectContaining({ fromModel: 'pit2', action: 'add-relationship-test-to-physical', pairs, composite: true }),
    ]);
    // A selector that only knows single links selects a composite by its first pair.
    expect(buildSyncPlan(composite, { 'rel:pit:hk:sat:hk': 'physical' }, ctx).relationships).toHaveLength(1);
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

  it('prefers the yml path, then the manifest path, for the schema yml; the SQL file only when it is on disk', () => {
    const manifest = { ...emptyManifest, models: new Map([['dim_missing', { originalFilePath: 'models/dims/dim_missing.sql' }]]) } as unknown as ManifestData;
    const ymlData = {
      models: new Map([['dim_extra', { filePath: '/proj/models/schema.yaml' }]]),
      sourceFiles: new Map([['dim_missing', 'models/dims/dim_missing.sql']]),
    } as unknown as YmlData;
    const plan = buildSyncPlan(report(), allSelections(report(), 'physical'), { ...ctx, manifest, ymlData });
    // dim_extra has only a yml: no SQL file is guessed next to it.
    expect(plan.modelContext.dim_extra).toMatchObject({ dbtSchemaPath: 'models/schema.yaml', dbtSqlPath: null });
    expect(plan.modelContext.dim_missing).toMatchObject({ dbtSqlPath: 'models/dims/dim_missing.sql', dbtSchemaPath: 'models/dims/dim_missing.yml' });
  });

  it('names a SQL file only when the yml walker found it (the dev-host dim_customer had only a yml)', () => {
    const manifest = { ...emptyManifest, models: new Map([
      // Compiled from a file that is gone (deleted or renamed, or a stale manifest).
      ['dim_missing', { originalFilePath: 'models/dims/dim_missing.sql' }],
      // A versioned model: the manifest names the real file, which is not `<name>.sql`.
      ['dim_extra', { originalFilePath: 'models/marts/dim_extra_v2.sql' }],
      // A Python model: there is no SQL file to edit.
      ['fct_order', { originalFilePath: 'models/marts/fct_order.py' }],
    ]) } as unknown as ManifestData;
    const ymlData = {
      models: new Map([['dim_customer', { filePath: '/proj/models/silver/dim_customer.yml' }]]),
      sourceFiles: new Map([
        ['dim_extra_v2', 'models/marts/dim_extra_v2.sql'],
        ['fct_order', 'models/marts/fct_order.py'],
        // Found by name in another folder than its yml.
        ['dim_store', 'models/sql/dim_store.sql'],
      ]),
    } as unknown as YmlData;
    const plan = buildSyncPlan(report(), allSelections(report(), 'physical'), { ...ctx, manifest, ymlData });
    expect(plan.modelContext.dim_customer).toMatchObject({ dbtSqlPath: null, dbtSchemaPath: 'models/silver/dim_customer.yml' });
    expect(plan.modelContext.dim_missing).toMatchObject({ dbtSqlPath: null, dbtSchemaPath: 'models/dims/dim_missing.yml' });
    expect(plan.modelContext.dim_extra).toMatchObject({ dbtSqlPath: 'models/marts/dim_extra_v2.sql' });
    expect(plan.modelContext.fct_order).toMatchObject({ dbtSqlPath: null, dbtSchemaPath: 'models/marts/fct_order.yml' });
    expect(plan.modelContext.dim_store).toMatchObject({ dbtSqlPath: 'models/sql/dim_store.sql', dbtSchemaPath: null });
    // Without a source-file listing nothing proves a SQL file exists.
    expect(buildSyncPlan(report(), allSelections(report(), 'physical'), { ...ctx, manifest }).modelContext.dim_missing.dbtSqlPath).toBeNull();
  });

  it('writes a column only the warehouse reports as Draw from dbt seeds it: ALL-CAPS lowercased', () => {
    const r: DiscrepancyReport = { ...report(), models: [{ name: 'fct_order', status: 'matched', columns: [
      { name: 'LOADED_AT', status: 'missing', targetDataType: 'TIMESTAMP_NTZ' },
      { name: 'REGION', status: 'missing', targetDataType: 'TEXT' },
      { name: 'LoadedBy', status: 'missing', targetDataType: 'TEXT' },
      { name: 'OLD_COL', status: 'extra', sourceDataType: 'int' },
    ] }], relationships: [] };
    // REGION is declared in the schema yml in capitals: kept as declared.
    const ymlData = { models: new Map([['fct_order', { columns: [{ name: 'REGION' }] }]]) } as unknown as YmlData;
    const plan = buildSyncPlan(r, allSelections(r, 'physical'), { ...ctx, ymlData });
    expect(plan.columns.map((c) => `${c.action} ${c.columnName}`)).toEqual([
      'add-column-to-logical loaded_at',
      'add-column-to-logical REGION',
      'add-column-to-logical LoadedBy',
      // Not a logical-side add: the name is the one on the logical side.
      'remove-column-from-logical OLD_COL',
    ]);
  });

  it('emits forward-slash paths even from Windows-style inputs', () => {
    const manifest = { ...emptyManifest, models: new Map([['dim_missing', { originalFilePath: 'models\\dims\\dim_missing.sql' }]]) } as unknown as ManifestData;
    const ymlData = { models: new Map(), sourceFiles: new Map([['dim_missing', 'models\\dims\\dim_missing.sql']]) } as unknown as YmlData;
    const plan = buildSyncPlan(report(), allSelections(report(), 'physical'), { ...ctx, manifest, ymlData, semanticDir: 'my erd\\data' });
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

  it('names a table file in v6\'s tables/ library where it is (#181)', () => {
    const files: Record<string, string | null> = { fct_order: 'tables/gold/fct_order.yml', dim_customer: 'logical-models/dim_customer.yml', dim_missing: null };
    const plan = buildSyncPlan(report(), allSelections(report(), 'physical'), {
      ...ctx, modelFolder: () => 'gold', tableLibraryFile: (n) => files[n] ?? null,
    });
    expect(plan.modelContext.fct_order.logicalModelPath).toBe('.erd-studio/tables/gold/fct_order.yml');
    expect(plan.modelContext.dim_customer.logicalModelPath).toBe('.erd-studio/logical-models/dim_customer.yml');
    // No file: where a new one goes, still logical-models/ (nothing writes tables/ yet).
    expect(plan.modelContext.dim_missing.logicalModelPath).toBe('.erd-studio/logical-models/gold/dim_missing.yml');
  });

  it('resolves types stage-absolutely when compared from physical', () => {
    const r = report('physical');
    const plan = buildSyncPlan(r, { 'col:fct_order:amount': 'physical' }, ctx);
    // From physical, the source side is physical, so physical truth takes sourceDataType.
    expect(plan.columns[0]).toMatchObject({ action: 'update-type-in-logical', resolvedDataType: 'float' });
  });
});

describe.each(DBT_FIXTURES)('SemanticEditorProvider.handleGenerateSyncPlan parity (%s storage)', (storage, fixture) => {
  it('writes exactly the plan buildSyncPlan builds for the same selections', async () => {
    const tmp = copyDbtFixture(fixture, 'sync-plan-builder');
    try {
      const layerService = new LayerService(tmp, '.erd-studio');
      const subjectAreaService = new SubjectAreaService(layerService);
      const tableLibraryService = new TableLibraryService(tmp, '.erd-studio');
      subjectAreaService.setTableLibraryService(tableLibraryService);
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
        context, subjectAreaService, manifestService, ymlParserService, new TemplateService(),
        layerService, tmp, new SelectorsService(subjectAreaService, tmp, '.erd-studio'), tableLibraryService,
      );

      const file = diagramPath(tmp, storage, 'silver', 'showcase');
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
        // The same library lookups the canvas and the CLI pass (where each table's file is, or goes).
        ...syncPlanLibraryLookups(tableLibraryService, {
          diagramFile: file, layerIds: new Set(layerService.getAllLayers().map((l) => l.id)), manifest, ymlData,
        }),
      });
      expect(written).toEqual(JSON.parse(JSON.stringify(expected)));
      // Each existing table's path is its own storage's file (yml on YAML, tables/<schema>/x.dbml on DBML).
      const held = Object.entries(written.modelContext as Record<string, { logicalModelPath?: string }>)
        .map(([name, c]) => [name, c.logicalModelPath, tableFilePath(tmp, storage, name)] as const)
        .filter(([, , onDisk]) => onDisk !== undefined);
      expect(held.length).toBeGreaterThan(0);
      for (const [, planned, onDisk] of held) expect(planned).toBe(path.relative(tmp, onDisk!).split(path.sep).join('/'));
      expect(posted().find((m) => m.type === 'syncPlanGenerated')!.payload.totalActions).toBe(countSyncPlanActions(expected));
      // dbtSqlPath names a SQL file that is there, or is null: dim_customer has only a yml.
      const contexts = written.modelContext as Record<string, { dbtSqlPath: string | null }>;
      for (const [name, c] of Object.entries(contexts)) {
        if (c.dbtSqlPath !== null) expect(fs.existsSync(path.join(tmp, c.dbtSqlPath)), `${name}: ${c.dbtSqlPath}`).toBe(true);
      }
      expect(contexts.dim_customer?.dbtSqlPath).toBeNull();
      expect(contexts.dim_project?.dbtSqlPath).toBe('models/silver/dim_project.sql');

      // And the CLI route — computeSubjectAreaDiff + allSelections — sees the same report.
      const cli = computeSubjectAreaDiff({ subjectAreaService, ymlData, manifest }, file, 'logical');
      expect(cli.report).toEqual(shown);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
