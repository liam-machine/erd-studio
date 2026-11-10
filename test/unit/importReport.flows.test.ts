/**
 * Show Import Report, from the imports' side: each import records its
 * ledger for the report (SQL DDL, a DBML file, Import from dbt), moves it on
 * as its draft is kept or left, and links to it from the draft's banner (the
 * draft page's `importReport` message, validated like every other), the
 * toast after a Keep that left tables out, and its failure messages.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { _resetMockWebviewPanels, _resetMockWorkspace } from 'vscode';

import { importDbml, type ImportDbmlDeps, type ImportDbmlUi } from '../../src/commands/importDbml';
import { importSqlDdl, type ImportSqlDdlDeps, type ImportSqlDdlUi } from '../../src/commands/importSqlDdl';
import { importSemanticModel, type ImportSemanticModelUi } from '../../src/commands/importSemanticModel';
import { dbtReportLedger } from '../../src/commands/drawFromDbt';
import { DraftPreviewPanel } from '../../src/providers/DraftPreviewPanel';
import { draftPreviewEvents } from '../../src/providers/draftWiring';
import { SubjectAreaService } from '../../src/services/domainService';
import { createLedger } from '../../src/services/importLedger';
import { SHOW_IMPORT_REPORT_LABEL, buildImportReportView } from '../../src/services/importReport';
import { _resetImportReports, latestImportReport } from '../../src/services/importReportStore';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import * as engine from '../../src/services/sqlImportEngine';
import { telemetry } from '../../src/services/telemetryService';
import {
  DRAFT_PASSIVE_TYPES,
  DRAFT_TO_HOST_TYPES,
  draftAllowance,
  parseDraftToHost,
  toDraftView,
  type Draft,
  type DraftAnswer,
} from '../../src/types/draft';
import { fakeDraftPreview, type ScriptedAnswer } from './helpers/draftDriver';

let tmp: string;

/** One table that reads and one that does not (two commas): a partial import. */
const PARTIAL_SQL = 'CREATE TABLE customer (\n  id int PRIMARY KEY,\n  name text\n);\n\nCREATE TABLE broken (\n  id int,,\n  x int\n);\n';
/** No table reads, in any dialect. */
const UNREADABLE_SQL = '-- broken\n\nCREATE TABLE t (\n  id int,,\n  x int\n);\n';

interface Recorder {
  infos: Array<{ message: string; items: string[] }>;
  errors: Array<{ message: string; items: string[] }>;
  reportsShown: number;
}

function importUi(rec: Recorder, answerInfo?: string): ImportDbmlUi {
  return {
    pickFile: async (p) => p,
    readFile: async (p) => fs.readFileSync(p, 'utf-8'),
    showQuickPick: async <T extends vscode.QuickPickItem>(items: readonly T[]) => items[0],
    showInputBox: async (options) => options.value,
    confirm: async () => true,
    showInformationMessage: async (message, ...items) => { rec.infos.push({ message, items }); return answerInfo; },
    showErrorMessage: async (message, ...items) => { rec.errors.push({ message, items }); return undefined; },
    openFileAt: async () => {},
    showFile: async () => {},
    openDiagram: async () => {},
    addLayer: async () => {},
    sendFeedback: async () => {},
    showImportReport: async () => { rec.reportsShown++; },
  };
}

function sqlUi(rec: Recorder, button?: string): ImportSqlDdlUi {
  return {
    pickSources: async () => undefined,
    readDirectory: async () => [],
    readFile: async (p) => fs.readFileSync(p, 'utf-8'),
    pickDialect: async (items) => items.find((i) => i.dialect === 'postgres'),
    showInformationMessage: async () => undefined,
    showErrorMessage: async (message, ...items) => { rec.errors.push({ message, items }); return button && items.includes(button) ? button : undefined; },
    openFileAt: async () => {},
    sendFeedback: async () => {},
    showImportReport: async () => { rec.reportsShown++; },
  };
}

function baseDeps(answers: ScriptedAnswer[] | undefined): Omit<ImportDbmlDeps, 'ui'> & { preview?: ReturnType<typeof fakeDraftPreview> } {
  const layerService = new LayerService(tmp, '.erd-studio');
  const subjectAreaService = new SubjectAreaService(layerService);
  const tableLibraryService = new TableLibraryService(tmp, '.erd-studio');
  subjectAreaService.setTableLibraryService(tableLibraryService);
  const preview = answers ? fakeDraftPreview(answers) : undefined;
  return {
    workspaceRoot: tmp,
    semanticDir: '.erd-studio',
    layerService,
    subjectAreaService,
    tableLibraryService,
    validateDomainName: () => undefined,
    onWritten: () => tableLibraryService.invalidateCache?.(),
    ...(preview ? { draft: { preview, trigger: 'palette' as const }, preview } : {}),
  };
}

function sqlDeps(sql: ImportSqlDdlUi, ui: ImportDbmlUi, answers?: ScriptedAnswer[]): ImportSqlDdlDeps & { preview?: ReturnType<typeof fakeDraftPreview> } {
  return { ...baseDeps(answers), extensionPath: '/nowhere', sqlUi: sql, ui, loadSqlImport: () => engine };
}

const newRecorder = (): Recorder => ({ infos: [], errors: [], reportsShown: 0 });

beforeEach(() => {
  _resetMockWorkspace();
  _resetImportReports();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-import-report-flows-'));
  vi.spyOn(telemetry, 'feature');
  vi.spyOn(telemetry, 'error');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Import SQL DDL records its report', () => {
  it('a partial import: the draft offers the report, Keep marks it kept, and the toast after Keep links to it', async () => {
    const file = path.join(tmp, 'schema.sql');
    fs.writeFileSync(file, PARTIAL_SQL);
    const rec = newRecorder();
    const deps = sqlDeps(sqlUi(rec), importUi(rec, SHOW_IMPORT_REPORT_LABEL), ['keep']);

    const result = await importSqlDdl(deps, { files: [{ name: 'schema.sql', text: PARTIAL_SQL }], fullPaths: new Map([['schema.sql', file]]), fileName: 'schema.sql', sourceLabel: 'schema.sql' }, { dialect: 'postgres', dialectChosen: true });
    expect(result).toBeDefined();

    // The draft's banner offers the report.
    const draft = deps.preview!.drafts[0];
    expect(draft.banner.importReport).toBe(true);
    expect(draftAllowance(toDraftView(draft)).importReport).toBe(true);

    const report = latestImportReport()!;
    expect(report).toMatchObject({ source: 'sql', title: 'Import SQL DDL', status: 'kept', imported: { tables: 1 } });
    expect(report.diagram).toMatch(/^gold\/schema/);
    expect(report.files).toEqual({ 'schema.sql': file });
    const view = buildImportReportView(report);
    const broken = view.sections.find((s) => s.id === 'notImported')!.groups.flatMap((g) => g.items).find((i) => i.name === 'broken')!;
    expect(broken.place).toBe('schema.sql line 7');
    expect(view.links[broken.link!]).toEqual({ file, line: 7 });

    // After Keep: the toast says what was left out, and its button runs the report.
    await new Promise((r) => setTimeout(r, 0));
    expect(rec.infos).toEqual([{
      message: 'Import SQL DDL: 1 table could not be read, so the diagram leaves it out. Show Import Report lists it with its file and line.',
      items: [SHOW_IMPORT_REPORT_LABEL],
    }]);
    expect(rec.reportsShown).toBe(1);
  });

  it('a draft that is discarded is reported as not kept, and a clean import has no toast', async () => {
    const file = path.join(tmp, 'clean.sql');
    const sql = 'CREATE TABLE a (id int PRIMARY KEY);\n';
    fs.writeFileSync(file, sql);
    const rec = newRecorder();
    await importSqlDdl(sqlDeps(sqlUi(rec), importUi(rec), ['discard']), { files: [{ name: 'clean.sql', text: sql }], fullPaths: new Map([['clean.sql', file]]), fileName: 'clean.sql', sourceLabel: 'clean.sql' }, { dialect: 'postgres', dialectChosen: true });
    expect(latestImportReport()).toMatchObject({ status: 'notKept' });
    const rec2 = newRecorder();
    await importSqlDdl(sqlDeps(sqlUi(rec2), importUi(rec2), ['keep']), { files: [{ name: 'clean.sql', text: sql }], fullPaths: new Map([['clean.sql', file]]), fileName: 'clean.sql', sourceLabel: 'clean.sql' }, { dialect: 'postgres', dialectChosen: true });
    expect(latestImportReport()).toMatchObject({ status: 'kept' });
    expect(rec2.infos).toEqual([]);
  });

  it('nothing reads: the failure message offers the report, which lists the problem at its file and line', async () => {
    const file = path.join(tmp, 'broken.sql');
    fs.writeFileSync(file, UNREADABLE_SQL);
    const rec = newRecorder();
    const result = await importSqlDdl(sqlDeps(sqlUi(rec, SHOW_IMPORT_REPORT_LABEL), importUi(rec)), { files: [{ name: 'broken.sql', text: UNREADABLE_SQL }], fullPaths: new Map([['broken.sql', file]]), fileName: 'broken.sql', sourceLabel: 'broken.sql' }, { dialect: 'postgres', dialectChosen: true });
    expect(result).toBeUndefined();
    expect(rec.errors).toHaveLength(1);
    expect(rec.errors[0].items).toContain(SHOW_IMPORT_REPORT_LABEL);
    await new Promise((r) => setTimeout(r, 0));
    expect(rec.reportsShown).toBe(1);
    const report = latestImportReport()!;
    expect(report).toMatchObject({ source: 'sql', status: 'failed' });
    expect(report.imported).toBeUndefined();
    const view = buildImportReportView(report);
    expect(view.sections.map((s) => s.id)).toContain('notImported');
    expect(view.links.some((l) => l.file === file)).toBe(true);
  });
});

const SEMANTIC = path.join(__dirname, '../fixtures/semantic-model');

function modelUi(rec: Recorder, folder: string, button?: string): ImportSemanticModelUi {
  return {
    pickFolder: async () => folder,
    readDirectory: async (f) => fs.readdirSync(f, { withFileTypes: true }).map((d) => [d.name, d.isDirectory()] as const),
    readFile: async (filePath) => fs.readFileSync(filePath, 'utf-8'),
    pickModel: async (items) => items[0],
    showErrorMessage: async (message, ...items) => { rec.errors.push({ message, items }); return button && items.includes(button) ? button : undefined; },
    openFileAt: async () => {},
    sendFeedback: async () => {},
    showImportReport: async () => { rec.reportsShown++; },
  };
}

describe('Import Semantic Model records its report', () => {
  it.each(['Broken', 'BrokenTmdl'])('a model that does not read (%s): the failure offers the report, with each problem at its file', async (name) => {
    const folder = path.join(SEMANTIC, 'broken', `${name}.SemanticModel`);
    const rec = newRecorder();
    await importSemanticModel({ ...baseDeps(undefined), modelUi: modelUi(rec, folder, SHOW_IMPORT_REPORT_LABEL), ui: importUi(rec) });
    expect(rec.errors[0].items).toEqual(['Open File', SHOW_IMPORT_REPORT_LABEL]);
    await new Promise((r) => setTimeout(r, 0));
    expect(rec.reportsShown).toBe(1);
    const report = latestImportReport()!;
    expect(report).toMatchObject({ source: 'semanticModel', status: 'failed' });
    const view = buildImportReportView(report);
    expect(view.links.length).toBeGreaterThan(0);
    for (const link of view.links) expect(link.file.startsWith(folder)).toBe(true);
  });

  it('a model that reads: the draft offers the report, whose entries link into the model\'s own files', async () => {
    const folder = path.join(SEMANTIC, 'pbip-tmdl');
    const rec = newRecorder();
    const deps = { ...baseDeps(['closed']), modelUi: modelUi(rec, folder), ui: importUi(rec) };
    await importSemanticModel(deps);
    expect(deps.preview!.drafts[0].banner.importReport).toBe(true);
    const report = latestImportReport()!;
    expect(report).toMatchObject({ source: 'semanticModel', status: 'notKept' });
    expect(Object.values(report.files ?? {}).length).toBeGreaterThan(0);
    for (const full of Object.values(report.files ?? {})) expect(full.startsWith(folder) && fs.existsSync(full)).toBe(true);
  });
});

describe('Import DBML records its report', () => {
  it('a file that is not valid DBML: every problem line in the report, offered from the failure message', async () => {
    const file = path.join(tmp, 'bad.dbml');
    fs.writeFileSync(file, 'Table a {\n  id int [pk]\n}\n\nTable b {\n  id int [\n}\n');
    const rec = newRecorder();
    await importDbml({ ...baseDeps(undefined), ui: importUi(rec) }, { filePath: file });
    expect(rec.errors).toHaveLength(1);
    expect(rec.errors[0].items).toEqual(['Open File', SHOW_IMPORT_REPORT_LABEL]);
    const report = latestImportReport()!;
    expect(report).toMatchObject({ source: 'dbml', status: 'failed', from: 'from bad.dbml', files: { 'bad.dbml': file } });
    expect(report.ledger.every((e) => e.outcome === 'problem' && e.where?.file === 'bad.dbml' && typeof e.where.line === 'number')).toBe(true);
  });

  it('a good file: the draft offers the report; the bundled example records none', async () => {
    const file = path.join(tmp, 'shop.dbml');
    fs.writeFileSync(file, 'Table customer {\n  id int [pk]\n}\n\nTable sale {\n  id int [pk]\n  customer_id int [ref: > customer.id]\n}\n');
    const rec = newRecorder();
    const deps = { ...baseDeps(['closed']), ui: importUi(rec) };
    await importDbml(deps, { filePath: file });
    expect(deps.preview!.drafts[0].banner.importReport).toBe(true);
    expect(latestImportReport()).toMatchObject({ source: 'dbml', status: 'notKept', imported: { tables: 2, relationships: 1 } });

    _resetImportReports();
    const example = { ...baseDeps(['closed']), ui: importUi(rec), source: 'example' as const };
    await importDbml(example, { filePath: file });
    expect(example.preview!.drafts[0].banner.importReport).toBeUndefined();
    expect(latestImportReport()).toBeUndefined();
  });
});

describe('Import from dbt\'s report ledger', () => {
  it('is the draft\'s ledger, then each model it left out with why (a repeat is not worth a line)', () => {
    const ledger = createLedger();
    ledger.skipped('relationship', 'notInFiles', 'link to a source', { table: 'fct_sale', column: 'store_id' }, 'to raw.store');
    const entries = dbtReportLedger({
      ledger: [...ledger.entries],
      skipped: [
        { name: 'stg_x', reason: 'disabled' },
        { name: 'big_one', reason: 'over-limit' },
        { name: 'dim_customer', reason: 'duplicate' },
        { name: 'bad name', reason: 'invalid-name', message: 'spaces' },
      ],
    });
    expect(entries.map((e) => [e.outcome, e.cause, e.where?.table])).toEqual([
      ['skipped', 'notInFiles', 'fct_sale'],
      ['lost', 'notDesign', 'stg_x'],
      ['skipped', 'capped', 'big_one'],
      ['lost', 'other', 'bad name'],
    ]);
  });
});

describe('the draft page\'s Show Import Report link', () => {
  const view = (importReport: boolean) => {
    const v = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/draft/small.json'), 'utf8'));
    return { ...v, banner: { ...v.banner, ...(importReport ? { importReport: true } : {}) } };
  };

  it('is a passive message, accepted only when the banner offers it', () => {
    expect(DRAFT_TO_HOST_TYPES).toContain('importReport');
    expect(DRAFT_PASSIVE_TYPES.has('importReport')).toBe(true);
    expect(parseDraftToHost({ type: 'importReport' }, draftAllowance(view(true)))).toEqual({ type: 'importReport' });
    expect(parseDraftToHost({ type: 'importReport' }, draftAllowance(view(false)))).toBeUndefined();
    expect(parseDraftToHost({ type: 'importReport', command: 'workbench.action.terminal.new' }, draftAllowance(view(true)))).toEqual({ type: 'importReport' });
  });

  it('runs the wiring\'s command without answering the draft or closing the tab', async () => {
    _resetMockWebviewPanels();
    DraftPreviewPanel.close();
    const shown: string[] = [];
    const events = draftPreviewEvents(() => {}, () => {}, undefined, undefined, undefined, () => { shown.push('report'); });
    const draft: Draft = { ...view(true), keep: { writer: 'none' }, trigger: 'start' };
    let answer: DraftAnswer | undefined;
    void DraftPreviewPanel.show(vscode.Uri.file('/ext'), draft, events).then((a) => { answer = a; });
    const panel = DraftPreviewPanel.currentPanel!;
    panel.handleMessage({ type: 'ready' });
    panel.handleMessage({ type: 'importReport' });
    await new Promise((r) => setTimeout(r, 0));
    expect(shown).toEqual(['report']);
    expect(answer).toBeUndefined();
    expect(DraftPreviewPanel.currentPanel).toBe(panel);
    DraftPreviewPanel.close();
    await new Promise((r) => setTimeout(r, 0));
    expect(answer).toEqual({ kind: 'closed' });
  });

  it('a draft whose banner does not offer it drops the message', async () => {
    _resetMockWebviewPanels();
    DraftPreviewPanel.close();
    const shown: string[] = [];
    const events = draftPreviewEvents(() => {}, () => {}, undefined, undefined, undefined, () => { shown.push('report'); });
    void DraftPreviewPanel.show(vscode.Uri.file('/ext'), { ...view(false), keep: { writer: 'none' }, trigger: 'start' }, events);
    DraftPreviewPanel.currentPanel!.handleMessage({ type: 'importReport' });
    await new Promise((r) => setTimeout(r, 0));
    expect(shown).toEqual([]);
    DraftPreviewPanel.close();
  });
});
