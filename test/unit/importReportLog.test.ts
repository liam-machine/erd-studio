/**
 * The import report promises "ERD Studio: Show Logs has the same lines" (and,
 * for a capped group, "Show Logs lists every one"): every entry a report
 * holds is in the output log, for every importer that records one. Import
 * from dbt (its drawn draft's ledger and each model it left out, the cap's
 * included) and Import DBML (the plan's own ledger, and every problem of a
 * file that does not read) log theirs as they record the report.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

const state = vi.hoisted(() => ({ models: [] as { name: string }[], pick: undefined as unknown, drawn: undefined as unknown }));

vi.mock('../../src/services/dbtDraft', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/dbtDraft')>();
  return {
    ...actual,
    listDraftModels: () => state.models,
    listDraftScopes: () => [],
    buildDbtDraft: (...args: Parameters<typeof actual.buildDbtDraft>) => (state.drawn ?? actual.buildDbtDraft(...args)) as ReturnType<typeof actual.buildDbtDraft>,
  };
});
vi.mock('../../src/services/draftModel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/draftModel')>();
  return { ...actual, draftFromDbt: () => ({ id: 'draft' }), dbtDraftFingerprint: () => 'plan' };
});
vi.mock('../../src/providers/dbtDraftPicker', () => ({ pickDraftScope: async () => state.pick }));

import { drawFromDbt, type DrawFromDbtDeps } from '../../src/commands/drawFromDbt';
import { importDbml, type ImportDbmlDeps, type ImportDbmlUi } from '../../src/commands/importDbml';
import { SubjectAreaService } from '../../src/services/domainService';
import { createLedger, ledgerLogLines } from '../../src/services/importLedger';
import { _resetImportReports, latestImportReport } from '../../src/services/importReportStore';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { setLogSink, type LogSink } from '../../src/services/logger';
import { telemetry } from '../../src/services/telemetryService';
import { fakeDraftPreview } from './helpers/draftDriver';

let tmp: string;
let logged: string[];
let previousSink: LogSink | undefined;

beforeEach(() => {
  _resetImportReports();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-import-report-log-'));
  logged = [];
  const keep = (message: unknown): void => { logged.push(String(message)); };
  previousSink = setLogSink({ trace: keep, debug: keep, info: keep, warn: keep, error: keep });
  vi.spyOn(telemetry, 'feature');
  vi.spyOn(telemetry, 'featureQuiet');
  vi.spyOn(telemetry, 'error');
  vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('sales');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  setLogSink(previousSink);
  vi.restoreAllMocks();
  _resetImportReports();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Every entry of the latest report has its log line. */
function expectEveryReportLineLogged(): void {
  const report = latestImportReport()!;
  expect(report.ledger.length).toBeGreaterThan(0);
  const lines = ledgerLogLines(report.ledger, report.title, { everySkipped: true });
  expect(lines).toHaveLength(report.ledger.length);
  const text = logged.join('\n');
  for (const line of lines) expect(text, line).toContain(line);
}

function dbtDeps(overrides: Partial<DrawFromDbtDeps> = {}): DrawFromDbtDeps {
  return {
    workspaceRoot: tmp,
    semanticDir: '.erd-studio',
    modelPaths: ['models'],
    layerService: {
      getValidLayerIds: () => ['silver', 'gold'],
      getCreatableLayers: () => [{ id: 'silver', label: 'Silver' }, { id: 'gold', label: 'Gold' }],
      getAllLayers: () => [],
      saveConfig: async () => undefined,
    } as unknown as DrawFromDbtDeps['layerService'],
    subjectAreaService: { listSubjectAreas: () => [], countSubjectAreaFileRelationships: () => 0 } as unknown as DrawFromDbtDeps['subjectAreaService'],
    tableLibraryService: {
      tableExists: () => false,
      saveTable: () => undefined,
      groupsByFolder: () => false,
      deleteTable: () => undefined,
      listTables: () => [],
      hasUnreadableRelationships: () => false,
      tablePath: (name: string) => path.join(tmp, '.erd-studio', 'logical-models', `${name}.yml`),
      getTablesDir: () => path.join(tmp, '.erd-studio', 'logical-models'),
      getTable: () => undefined,
      serializeTable: () => '',
    } as unknown as DrawFromDbtDeps['tableLibraryService'],
    loadDbt: async () => ({}),
    validateDomainName: () => undefined,
    onWritten: () => undefined,
    ...overrides,
  };
}

describe('Import from dbt', () => {
  it('logs every line of its report: the draft\'s ledger and each model it left out, the cap\'s included', async () => {
    const ledger = createLedger();
    ledger.skipped('relationship', 'notInFiles', 'link to a source', { table: 'fct_order', column: 'customer_id' });
    ledger.changed('relationship', 'savedOptional', 'NOT NULL foreign key', undefined, 'saved as optional (>?)', 3);
    const over = Array.from({ length: 30 }, (_, i) => ({ name: `model_${i}`, reason: 'over-limit' as const }));
    state.models = [{ name: 'dim_customer' }];
    state.pick = { scope: { label: 'All models', suggestedLayer: 'silver', kind: 'all' }, modelNames: ['dim_customer'] };
    state.drawn = {
      modelNames: ['dim_customer'], newModels: [], reusedModels: ['dim_customer'], relationships: [],
      skipped: [...over, { name: 'stg_x', reason: 'disabled' }], truncated: true, ledger: ledger.entries,
    };
    await drawFromDbt(dbtDeps({ draft: { preview: fakeDraftPreview(['discard']), trigger: 'palette' } }));
    expect(latestImportReport()?.source).toBe('dbt');
    expectEveryReportLineLogged();
  });
});

describe('Import from dbt when none of the chosen models can be drawn', () => {
  it('records a failed report of why, offers it from the warning, and logs its lines', async () => {
    state.models = [{ name: 'stg_x' }];
    state.pick = { scope: { label: 'All models', suggestedLayer: 'silver', kind: 'all' }, modelNames: ['stg_x', 'bad name'] };
    state.drawn = {
      modelNames: [], newModels: [], reusedModels: [], relationships: [], truncated: false, ledger: [],
      skipped: [{ name: 'stg_x', reason: 'disabled' }, { name: 'bad name', reason: 'invalid-name', message: 'spaces' }],
    };
    const warned: Array<{ message: string; items: string[] }> = [];
    vi.spyOn(vscode.window, 'showWarningMessage').mockImplementation(((message: string, ...items: string[]) => { warned.push({ message, items }); return Promise.resolve(undefined); }) as never);
    await drawFromDbt(dbtDeps({ draft: { preview: fakeDraftPreview(['discard']), trigger: 'palette' } }));
    const report = latestImportReport()!;
    expect(report).toMatchObject({ source: 'dbt', status: 'failed', from: 'from All models' });
    expect(report.ledger.map((e) => e.where?.table)).toEqual(['stg_x', 'bad name']);
    expect(warned).toHaveLength(1);
    expect(warned[0].message).toContain('none of the chosen models could be drawn');
    expect(warned[0].items).toEqual(['Show Import Report']);
    expectEveryReportLineLogged();
  });
});

function dbmlUi(): ImportDbmlUi {
  return {
    pickFile: async (p) => p,
    readFile: async (p) => fs.readFileSync(p, 'utf-8'),
    showQuickPick: async <T extends vscode.QuickPickItem>(items: readonly T[]) => items[0],
    showInputBox: async (options) => options.value,
    confirm: async () => true,
    showInformationMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    openFileAt: async () => {},
    showFile: async () => {},
    openDiagram: async () => {},
    addLayer: async () => {},
    sendFeedback: async () => {},
    showImportReport: async () => {},
  };
}

function dbmlDeps(answers: Array<'discard' | 'closed'> | undefined): ImportDbmlDeps {
  const layerService = new LayerService(tmp, '.erd-studio');
  const subjectAreaService = new SubjectAreaService(layerService);
  const tableLibraryService = new TableLibraryService(tmp, '.erd-studio');
  subjectAreaService.setTableLibraryService(tableLibraryService);
  return {
    workspaceRoot: tmp, semanticDir: '.erd-studio', layerService, subjectAreaService, tableLibraryService,
    validateDomainName: () => undefined, onWritten: () => undefined, ui: dbmlUi(),
    ...(answers ? { draft: { preview: fakeDraftPreview(answers), trigger: 'palette' as const } } : {}),
  };
}

describe('Import DBML', () => {
  it('logs every line of its report: the plan\'s own ledger, skipped blocks included', async () => {
    const file = path.join(tmp, 'shop.dbml');
    fs.writeFileSync(file, [
      'Enum status { active\n  closed }',
      'TableGroup sales { customer\n  sale }',
      'Table customer {\n  id int [pk]\n  status status\n}',
      'Table sale {\n  id int [pk]\n  customer_id int [not null, ref: > customer.id]\n}',
      '',
    ].join('\n\n'));
    await importDbml(dbmlDeps(['closed']), { filePath: file });
    expect(latestImportReport()?.source).toBe('dbml');
    expectEveryReportLineLogged();
  });

  it('a file that is not valid DBML logs every problem the report lists', async () => {
    const file = path.join(tmp, 'bad.dbml');
    fs.writeFileSync(file, 'Table a {\n  id int [pk]\n}\n\nTable b {\n  id int [\n}\n');
    await importDbml(dbmlDeps(undefined), { filePath: file });
    expect(latestImportReport()?.status).toBe('failed');
    expectEveryReportLineLogged();
  });
});
