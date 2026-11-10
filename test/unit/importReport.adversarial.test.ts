/**
 * Show Import Report, attacked: what breaks the report when imports overlap,
 * when the page and the host disagree about which report is on show, when a
 * ledger holds something this build does not know (a worker's result, a
 * stale bundle) or a name built to break out of the HTML, when a file was
 * read from outside the open folder, and when a ledger is huge or empty.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { _resetMockWebviewPanels, _resetMockWorkspace } from 'vscode';

import { importDbml, type ImportDbmlDeps, type ImportDbmlUi } from '../../src/commands/importDbml';
import { importSqlDdl, type ImportSqlDdlUi } from '../../src/commands/importSqlDdl';
import { SHOW_IMPORT_REPORT_COMMAND, showImportReport } from '../../src/commands/showImportReport';
import { DraftPreviewPanel } from '../../src/providers/DraftPreviewPanel';
import { ImportReportPanel } from '../../src/providers/ImportReportPanel';
import { draftPreviewEvents } from '../../src/providers/draftWiring';
import { SubjectAreaService } from '../../src/services/domainService';
import { createLedger, type LedgerEntry } from '../../src/services/importLedger';
import {
  IMPORT_REPORT_VIEW_TYPE,
  MAX_ITEMS_PER_GROUP,
  MAX_ITEMS_LISTED,
  SHOW_IMPORT_REPORT_LABEL,
  buildImportReportHtml,
  buildImportReportView,
  parseImportReportToHost,
  partialImportMessage,
  type ImportReportRecord,
} from '../../src/services/importReport';
import {
  MAX_IMPORT_REPORTS_HELD,
  _resetImportReports,
  importReportById,
  latestImportReport,
  latestImportReportId,
  recordImportReport,
  updateImportReport,
} from '../../src/services/importReportStore';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import * as engine from '../../src/services/sqlImportEngine';
import { telemetry } from '../../src/services/telemetryService';
import { toDraftView, type Draft, type DraftAnswer, type DraftKeepOutcome, type DraftPreview } from '../../src/types/draft';

const PARTIAL_SQL = 'CREATE TABLE customer (\n  id int PRIMARY KEY,\n  name text\n);\n\nCREATE TABLE broken (\n  id int,,\n  x int\n);\n';
const UNREADABLE_SQL = '-- broken\n\nCREATE TABLE t (\n  id int,,\n  x int\n);\n';

function record(patch: Partial<ImportReportRecord> = {}): ImportReportRecord {
  const l = createLedger();
  l.problem('table', 'parseError', 'CREATE TABLE', { file: 'a.sql', line: 4, table: 'broken' });
  return {
    source: 'sql', title: 'Import SQL DDL', from: 'from a.sql (PostgreSQL)', status: 'draft',
    imported: { tables: 1, relationships: 0 }, ledger: [...l.entries], files: { 'a.sql': '/proj/a.sql' }, at: 1, ...patch,
  };
}

type MockPanel = ReturnType<typeof import('../__mocks__/vscode').createMockWebviewPanel>;
const reportPanels = (): MockPanel[] => (vscode.window as unknown as { _webviewPanels: MockPanel[] })._webviewPanels
  .filter((p) => (p as unknown as { viewType: string }).viewType === IMPORT_REPORT_VIEW_TYPE);
/** The page's view token, as its script would send it back. */
const viewToken = (html: string): string => /data-view="([^"]+)"/.exec(html)![1];

let tmp: string;
beforeEach(() => {
  _resetMockWorkspace();
  _resetMockWebviewPanels();
  _resetImportReports();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-import-report-adv-'));
  vi.spyOn(telemetry, 'feature');
  vi.spyOn(telemetry, 'error');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  ImportReportPanel.currentPanel?.dispose();
  DraftPreviewPanel.close();
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('overlapping imports: each import keeps its own report', () => {
  it('an update moves its own import on even after a newer import, without changing what the latest is', () => {
    const first = recordImportReport(record({ title: 'First' }));
    const second = recordImportReport(record({ title: 'Second' }));
    expect(updateImportReport(first, { status: 'kept', diagram: 'main/first' })).toBe(true);
    expect(importReportById(first)).toMatchObject({ title: 'First', status: 'kept', diagram: 'main/first' });
    expect(latestImportReport()).toMatchObject({ title: 'Second', status: 'draft' });
    expect(latestImportReportId()).toBe(second);
  });

  it('holds a bounded number of reports: a long session does not grow without end', () => {
    const ids = Array.from({ length: MAX_IMPORT_REPORTS_HELD + 25 }, (_, i) => recordImportReport(record({ title: `n${i}` })));
    expect(importReportById(ids[0])).toBeUndefined();
    expect(updateImportReport(ids[0], { status: 'kept' })).toBe(false);
    expect(importReportById(ids.at(-1)!)).toMatchObject({ title: `n${ids.length - 1}` });
    expect(importReportById(ids.at(-MAX_IMPORT_REPORTS_HELD)!)).toBeDefined();
  });

  it('the command shows the import it was asked for, not whichever ran last; a bad argument shows the latest', () => {
    const first = recordImportReport(record({ title: 'First import' }));
    recordImportReport(record({ title: 'Second import' }));
    showImportReport(first);
    expect(reportPanels()[0].webview.html).toContain('First import');
    // A new import while an older report is on show leaves it there.
    recordImportReport(record({ title: 'Third import' }));
    expect(reportPanels()[0].webview.html).toContain('First import');
    ImportReportPanel.currentPanel?.dispose();
    for (const arg of ['/etc/passwd', { id: first }, -1, 1.5, Number.NaN]) {
      showImportReport(arg);
      expect(reportPanels().at(-1)!.webview.html, String(arg)).toContain('Third import');
      ImportReportPanel.currentPanel?.dispose();
    }
  });

  it('a tab on an older report that a long session then drops moves to the latest, never to the no-import page', () => {
    const first = recordImportReport(record({ title: 'First import' }));
    recordImportReport(record({ title: 'Second import' }));
    showImportReport(first);
    for (let i = 0; i < MAX_IMPORT_REPORTS_HELD; i++) recordImportReport(record({ title: `later ${i}` }));
    const html = reportPanels()[0].webview.html;
    expect(html).toContain(`later ${MAX_IMPORT_REPORTS_HELD - 1}`);
    expect(html).not.toContain('No import has run');
  });

  it('a report a long session has dropped says so instead of showing another import', () => {
    const info = vi.spyOn(vscode.window, 'showInformationMessage');
    const first = recordImportReport(record({ title: 'First import' }));
    for (let i = 0; i < MAX_IMPORT_REPORTS_HELD; i++) recordImportReport(record({ title: `later ${i}` }));
    showImportReport(first);
    expect(reportPanels()).toHaveLength(0);
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0][0])).toMatch(/no longer/);
  });

  it('the draft carries its report id on the host only, and its banner link shows that report', async () => {
    const id = recordImportReport(record({ title: 'The draft\'s import' }));
    recordImportReport(record({ title: 'A later failed import', status: 'failed' }));
    const v = JSON.parse(fs.readFileSync(path.join(__dirname, '../fixtures/draft/small.json'), 'utf8'));
    const draft: Draft = { ...v, banner: { ...v.banner, importReport: true }, keep: { writer: 'none' }, trigger: 'start', importReportId: id };
    expect('importReportId' in toDraftView(draft)).toBe(false);
    const asked: Array<number | undefined> = [];
    const events = draftPreviewEvents(() => {}, () => {}, undefined, undefined, undefined, (reportId?: number) => { asked.push(reportId); });
    void DraftPreviewPanel.show(vscode.Uri.file('/ext'), draft, events);
    const panel = DraftPreviewPanel.currentPanel!;
    panel.handleMessage({ type: 'ready' });
    panel.handleMessage({ type: 'importReport', reportId: 999 });
    await new Promise((r) => setTimeout(r, 0));
    expect(asked).toEqual([id]);
  });
});

/** A draft preview that holds its answer until the test gives it. */
function heldPreview() {
  const drafts: Draft[] = [];
  const settled: DraftKeepOutcome[] = [];
  let release: ((a: DraftAnswer) => void) | undefined;
  const preview: DraftPreview = {
    ask: (draft) => { drafts.push(draft); return new Promise((r) => { release = r; }); },
    isOpen: () => drafts.length > 0,
    showing: () => drafts.at(-1)?.id,
    close: () => {},
  };
  return { preview, drafts, settled, keep: () => release!({ kind: 'keep', settle: (o) => { settled.push(o); } }) };
}

describe('overlapping imports, end to end', () => {
  it('a draft kept after another import failed is reported kept, and its toast shows its own report', async () => {
    const layerService = new LayerService(tmp, '.erd-studio');
    const subjectAreaService = new SubjectAreaService(layerService);
    const tableLibraryService = new TableLibraryService(tmp, '.erd-studio');
    subjectAreaService.setTableLibraryService(tableLibraryService);
    const base: Omit<ImportDbmlDeps, 'ui'> = {
      workspaceRoot: tmp, semanticDir: '.erd-studio', layerService, subjectAreaService, tableLibraryService,
      validateDomainName: () => undefined, onWritten: () => tableLibraryService.invalidateCache?.(),
    };
    const shown: Array<number | undefined> = [];
    const infos: string[] = [];
    const ui: ImportDbmlUi = {
      pickFile: async (p) => p,
      readFile: async (p) => fs.readFileSync(p, 'utf-8'),
      showQuickPick: async <T extends vscode.QuickPickItem>(items: readonly T[]) => items[0],
      showInputBox: async (options) => options.value,
      confirm: async () => true,
      showInformationMessage: async (message) => { infos.push(message); return SHOW_IMPORT_REPORT_LABEL; },
      showErrorMessage: async () => undefined,
      openFileAt: async () => {}, showFile: async () => {}, openDiagram: async () => {}, addLayer: async () => {}, sendFeedback: async () => {},
      showImportReport: async (reportId?: number) => { shown.push(reportId); },
    };
    const sqlUi = (button?: string): ImportSqlDdlUi => ({
      pickSources: async () => undefined, readDirectory: async () => [], readFile: async (p) => fs.readFileSync(p, 'utf-8'),
      pickDialect: async (items) => items.find((i) => i.dialect === 'postgres'),
      showInformationMessage: async () => undefined,
      showErrorMessage: async (_m, ...items) => (button && items.includes(button) ? button : undefined),
      openFileAt: async () => {}, sendFeedback: async () => {},
      showImportReport: async (reportId?: number) => { shown.push(reportId); },
    });

    const partial = path.join(tmp, 'partial.sql');
    fs.writeFileSync(partial, PARTIAL_SQL);
    const held = heldPreview();
    const first = importSqlDdl(
      { ...base, ui, extensionPath: '/nowhere', sqlUi: sqlUi(), loadSqlImport: () => engine, draft: { preview: held.preview, trigger: 'palette' } },
      { files: [{ name: 'partial.sql', text: PARTIAL_SQL }], fullPaths: new Map([['partial.sql', partial]]), fileName: 'partial.sql', sourceLabel: 'partial.sql' },
      { dialect: 'postgres', dialectChosen: true },
    );
    for (let i = 0; i < 200 && held.drafts.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    const firstId = latestImportReportId();
    expect(firstId).toBeDefined();
    expect(held.drafts[0].importReportId).toBe(firstId);

    // While the draft is open, another import fails, and its failure's button is used.
    const bad = path.join(tmp, 'bad.sql');
    fs.writeFileSync(bad, UNREADABLE_SQL);
    await importSqlDdl(
      { ...base, ui, extensionPath: '/nowhere', sqlUi: sqlUi(SHOW_IMPORT_REPORT_LABEL), loadSqlImport: () => engine },
      { files: [{ name: 'bad.sql', text: UNREADABLE_SQL }], fullPaths: new Map([['bad.sql', bad]]), fileName: 'bad.sql', sourceLabel: 'bad.sql' },
      { dialect: 'postgres', dialectChosen: true },
    );
    await new Promise((r) => setTimeout(r, 0));
    const secondId = latestImportReportId();
    expect(secondId).not.toBe(firstId);
    expect(shown).toEqual([secondId]);

    // Now the first draft is kept.
    held.keep();
    await first;
    await new Promise((r) => setTimeout(r, 0));
    expect(importReportById(firstId!)).toMatchObject({ status: 'kept', title: 'Import SQL DDL' });
    expect(latestImportReport()).toMatchObject({ status: 'failed' });
    expect(infos.some((m) => m.includes('could not be read'))).toBe(true);
    expect(shown).toEqual([secondId, firstId]);
  });
});

describe('the page and the host agree on which report a link belongs to', () => {
  it('a click from the page on show before a new import replaced it opens nothing', async () => {
    const opened: string[] = [];
    recordImportReport(record({ files: { 'a.sql': '/proj/a.sql' } }));
    ImportReportPanel.createOrShow({ openFileAt: async (file) => { opened.push(file); } });
    const panel = reportPanels()[0];
    const oldView = viewToken(panel.webview.html);
    // A new import replaces the report while the old page's click is in flight.
    const l = createLedger();
    l.problem('table', 'parseError', 'CREATE TABLE', { file: 'other.sql', line: 9 });
    recordImportReport(record({ ledger: [...l.entries], files: { 'other.sql': '/proj/other.sql' } }));
    await panel._simulateMessage({ type: 'open', link: 0, view: oldView });
    await panel._simulateMessage({ type: 'open', link: 0 });
    expect(opened).toEqual([]);
    // The new page's own click opens its own file.
    await panel._simulateMessage({ type: 'open', link: 0, view: viewToken(panel.webview.html) });
    expect(opened).toEqual(['/proj/other.sql']);
  });

  it('a change to another import (a new import, or another draft kept) leaves the page on show as it is: its state and its clicks', async () => {
    const opened: string[] = [];
    const a = recordImportReport(record({ title: 'Report A', files: { 'a.sql': '/proj/a.sql' } }));
    const b = recordImportReport(record({ title: 'Report B' }));
    ImportReportPanel.createOrShow({ openFileAt: async (file) => { opened.push(file); } }, a);
    const panel = reportPanels()[0];
    const html = panel.webview.html;
    let drawn = 0;
    const set = Object.getOwnPropertyDescriptor(panel.webview, 'html');
    let value = html;
    Object.defineProperty(panel.webview, 'html', { configurable: true, get: () => value, set: (v: string) => { drawn++; value = v; } });
    // Draft B is kept, then a new import runs: neither is the report on show.
    expect(updateImportReport(b, { status: 'kept', diagram: 'main/b' })).toBe(true);
    recordImportReport(record({ title: 'Report C' }));
    expect(drawn).toBe(0);
    expect(panel.webview.html).toBe(html);
    // A click the page sent before those changes still opens.
    await panel._simulateMessage({ type: 'open', link: 0, view: viewToken(html) });
    expect(opened).toEqual(['/proj/a.sql']);
    // A change to the report on show redraws it.
    updateImportReport(a, { status: 'kept', diagram: 'main/a' });
    expect(drawn).toBe(1);
    if (set) Object.defineProperty(panel.webview, 'html', set);
  });

  it('parses only a message for the page on show', () => {
    expect(parseImportReportToHost({ type: 'open', link: 0, view: 'v1' }, 1, 'v1')).toEqual({ type: 'open', link: 0 });
    expect(parseImportReportToHost({ type: 'open', link: 0, view: 'v0' }, 1, 'v1')).toBeUndefined();
    expect(parseImportReportToHost({ type: 'open', link: 0 }, 1, 'v1')).toBeUndefined();
  });
});

describe('a ledger this build does not fully know, or built to break the page', () => {
  const strange = (): LedgerEntry[] => [
    { outcome: 'lost', unit: 'constructor' as never, cause: 'toString' as never, what: 'x', count: 2 },
    { outcome: 'lost', unit: 'widget' as never, cause: 'x" onmouseover="alert(1)' as never, what: 'y', count: 1, where: { table: 't' } },
    { outcome: 'hasOwnProperty' as never, unit: 'table', cause: 'other', what: 'z', count: 3 },
    { outcome: 'evil" data-x="1' as never, unit: 'table', cause: 'other', what: 'w', count: 1 },
    { outcome: 'problem', unit: '__proto__' as never, cause: 'parseError', what: 'CREATE TABLE', count: 1 },
  ];

  it('renders every entry without throwing, counting each one somewhere', () => {
    const view = buildImportReportView(record({ ledger: strange() }));
    const listed = view.sections.flatMap((s) => s.groups).reduce((n, g) => n + g.count, 0);
    expect(listed).toBe(2 + 1 + 3 + 1 + 1);
    expect(() => buildImportReportHtml(view, 'n')).not.toThrow();
  });

  it('escapes the unknown values that reach an attribute', () => {
    const html = buildImportReportHtml(buildImportReportView(record({ ledger: strange() })), 'n');
    expect(html).not.toContain('onmouseover="');
    expect(html).not.toContain('data-x="1');
  });

  it('the partial toast copes with a unit it does not know', () => {
    expect(() => partialImportMessage('Import SQL DDL', strange())).not.toThrow();
    expect(partialImportMessage('Import SQL DDL', strange())).toMatch(/could not be read/);
    expect(partialImportMessage('Import SQL DDL', strange())).not.toMatch(/undefined|\[object/);
  });

  it('script injection through a table, file, diagram or title is escaped everywhere', () => {
    const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>"\'';
    const l = createLedger();
    l.problem('table', 'parseError', evil, { file: `${evil}.sql`, line: 1, table: evil, column: evil }, evil);
    const html = buildImportReportHtml(buildImportReportView(record({
      title: evil, from: evil, status: 'kept', diagram: evil, ledger: [...l.entries], files: { [`${evil}.sql`]: '/proj/x.sql' },
    })), 'n');
    expect(html).not.toMatch(/<img|<script>alert|onerror=alert\(1\)>/);
    expect((html.match(/<script /g) ?? []).length).toBe(1);
  });
});

describe('a file read from outside the open folder', () => {
  it('is shown by its last folders, never by its absolute path, and still links', () => {
    const l = createLedger();
    l.problem('table', 'parseError', 'CREATE TABLE', { file: '/Users/someone/private/clientA/schema.sql', line: 3 });
    l.problem('table', 'parseError', 'CREATE TABLE', { file: 'C:/Users/someone/clientB/schema.sql', line: 5 });
    const view = buildImportReportView(record({
      ledger: [...l.entries],
      files: { '/Users/someone/private/clientA/schema.sql': '/Users/someone/private/clientA/schema.sql', 'C:/Users/someone/clientB/schema.sql': 'C:\\Users\\someone\\clientB\\schema.sql' },
    }));
    const items = view.sections.flatMap((s) => s.groups).flatMap((g) => g.items);
    expect(items.map((i) => i.place)).toEqual(['…/clientA/schema.sql line 3', '…/clientB/schema.sql line 5']);
    expect(items.every((i) => i.link !== undefined)).toBe(true);
    const html = buildImportReportHtml(view, 'n');
    expect(html).not.toContain('/Users/someone');
    expect(html).not.toContain('C:/Users');
  });
});

describe('huge and empty ledgers', () => {
  it('a ledger spread over every cause and outcome lists a bounded page, and counts the rest exactly', () => {
    const causes = ['parseError', 'grammarGap', 'templatePlaceholder', 'unknownType', 'reservedWord', 'trailingOption', 'unsupportedModifier',
      'proceduralBlock', 'notInFiles', 'droppedLater', 'noField', 'notDesign', 'renamed', 'normalised', 'inferred', 'capped', 'savedOptional', 'duplicate', 'other'] as const;
    const l = createLedger();
    let entries = 0;
    for (const outcome of ['lost', 'changed', 'repaired', 'skipped', 'problem'] as const) {
      for (const cause of causes) {
        for (let i = 0; i < 300; i++) {
          l[outcome]('column', cause, 'X', { file: 'a.sql', line: i + 1, table: `t${i}`, column: 'c' });
          entries++;
        }
      }
    }
    const started = Date.now();
    const view = buildImportReportView(record({ ledger: [...l.entries] }));
    const html = buildImportReportHtml(view, 'n');
    expect(Date.now() - started).toBeLessThan(3000);
    const groups = view.sections.flatMap((s) => s.groups);
    const listed = groups.reduce((n, g) => n + g.items.length, 0);
    expect(listed).toBeLessThanOrEqual(MAX_ITEMS_LISTED);
    expect(groups.every((g) => g.items.length > 0 && g.items.length <= MAX_ITEMS_PER_GROUP)).toBe(true);
    expect(listed + groups.reduce((n, g) => n + g.more, 0)).toBe(entries);
    expect(view.links.length).toBeLessThanOrEqual(MAX_ITEMS_LISTED);
    expect(html.length).toBeLessThan(2_000_000);
  });

  it('a stopped or failed import that recorded nothing says so, not just zeros', () => {
    for (const status of ['failed', 'cancelled', 'timedOut'] as const) {
      const html = buildImportReportHtml(buildImportReportView(record({ status, ledger: [], imported: undefined })), 'n');
      expect(html, status).toContain('<p class="ir__empty">');
    }
  });

  it('a report with a zero or negative count entry ignores it rather than counting it', () => {
    const view = buildImportReportView(record({ ledger: [{ outcome: 'lost', unit: 'table', cause: 'other', what: 'x', count: -5 }, { outcome: 'lost', unit: 'table', cause: 'other', what: 'y', count: Number.NaN }] }));
    expect(view.sections.filter((s) => s.id !== 'imported')).toEqual([]);
  });
});

describe('the command is reachable with its id from the imports', () => {
  it('runs with the import\'s id', async () => {
    const run = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
    const { importReportAction } = await import('../../src/commands/showImportReport');
    await importReportAction(7)[SHOW_IMPORT_REPORT_LABEL]();
    expect(run).toHaveBeenCalledWith(SHOW_IMPORT_REPORT_COMMAND, 7);
  });
});
