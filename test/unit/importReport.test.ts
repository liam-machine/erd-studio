/**
 * Show Import Report (`src/services/importReport.ts`, the store and the
 * panel): the last import's ledger grouped by outcome and cause with counts,
 * file:line links the host resolves from its own table, the page's one
 * message, the command, and the guarantee that showing the report and
 * following its links writes nothing.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { _resetMockWebviewPanels } from 'vscode';

import { ImportReportPanel } from '../../src/providers/ImportReportPanel';
import { SHOW_IMPORT_REPORT_COMMAND, importReportAction, showImportReport } from '../../src/commands/showImportReport';
import { NO_LEGACY_ALIAS, PRE_REGISTERED_COMMANDS } from '../../src/extension';
import { createLedger, type LedgerEntry } from '../../src/services/importLedger';
import {
  IMPORT_REPORT_VIEW_TYPE,
  MAX_ITEMS_PER_GROUP,
  NO_IMPORT_REPORT_MESSAGE,
  SHOW_IMPORT_REPORT_LABEL,
  buildImportReportCsp,
  buildImportReportHtml,
  buildImportReportView,
  importReportCounts,
  parseImportReportToHost,
  partialImportMessage,
  problemLedger,
  type ImportReportRecord,
} from '../../src/services/importReport';
import {
  _resetImportReports,
  latestImportReport,
  onImportReportChanged,
  recordImportReport,
  updateImportReport,
} from '../../src/services/importReportStore';
import packageJson from '../../package.json';

const ROOT = path.resolve(__dirname, '../..');

/** A SQL import's ledger: one of every outcome, two causes in Not imported, a repeated place. */
function sqlLedger(): LedgerEntry[] {
  const l = createLedger();
  l.problem('table', 'parseError', 'CREATE TABLE', { file: 'sql/01_tables.sql', line: 40, table: 'public.broken' }, 'could not be read: a syntax error');
  l.problem('table', 'grammarGap', 'CREATE TABLE', { file: 'sql/01_tables.sql', line: 90, table: 'public.odd' });
  l.lost('column', 'noField', 'ON UPDATE', { file: 'sql/01_tables.sql', line: 12, table: 'film', column: 'last_update' }, 'not kept: ERD Studio has no field for it');
  l.lost('column', 'noField', 'ON UPDATE', { file: 'sql/01_tables.sql', line: 30, table: 'actor', column: 'last_update' }, 'not kept: ERD Studio has no field for it');
  l.lost('column', 'noField', 'ON UPDATE', { file: 'sql/01_tables.sql', line: 30, table: 'actor', column: 'last_update' }, 'not kept: ERD Studio has no field for it');
  l.repaired('statement', 'trailingOption', 'ENGINE=InnoDB', { file: 'sql/02_more.sql', line: 3, table: 'store' }, 'option removed so the table reads');
  l.changed('type', 'normalised', 'WITH TIME ZONE', { file: 'sql/01_tables.sql', line: 14, table: 'rental', column: 'rental_date' });
  l.skipped('statement', 'notDesign', 'view', { file: 'sql/02_more.sql' }, undefined, 4);
  l.skipped('statement', 'notDesign', 'index', { file: 'elsewhere.sql', line: 7 });
  return [...l.entries];
}

function record(patch: Partial<ImportReportRecord> = {}): ImportReportRecord {
  return {
    source: 'sql',
    title: 'Import SQL DDL',
    from: 'from 2 SQL files (PostgreSQL)',
    status: 'draft',
    imported: { tables: 24, relationships: 31 },
    ledger: sqlLedger(),
    files: { 'sql/01_tables.sql': '/proj/sql/01_tables.sql', 'sql/02_more.sql': '/proj/sql/02_more.sql' },
    at: 1,
    ...patch,
  };
}

describe('Import report: grouping and counts', () => {
  it('reports each outcome in its section (changed → Imported, problem and lost → Not imported), in a fixed order', () => {
    const view = buildImportReportView(record());
    expect(view.sections.map((s) => s.id)).toEqual(['imported', 'repaired', 'notImported', 'skipped']);
    expect(view.sections.map((s) => s.title)).toEqual(['Imported', 'Repaired', 'Not imported', 'Skipped']);
    const notImported = view.sections.find((s) => s.id === 'notImported')!;
    expect(new Set(notImported.groups.flatMap((g) => g.items.map((i) => i.outcome)))).toEqual(new Set(['problem', 'lost']));
    expect(view.sections.find((s) => s.id === 'imported')!.groups.flatMap((g) => g.items.map((i) => i.outcome))).toEqual(['changed']);
  });

  it('groups by cause with summed counts, biggest first, and a section counts its groups', () => {
    const view = buildImportReportView(record());
    const notImported = view.sections.find((s) => s.id === 'notImported')!;
    // noField: 1 + 2 (the repeated place counted together) = 3; parseError 1; grammarGap 1.
    expect(notImported.groups.map((g) => [g.cause, g.heading, g.count])).toEqual([
      ['noField', 'ERD Studio has no field for it', 3],
      ['parseError', 'Could not be read', 1],
      ['grammarGap', 'Not in the SQL grammar', 1],
    ]);
    expect(notImported.count).toBe(5);
    // The repeated place is one item counted twice, not two items.
    expect(notImported.groups[0].items.map((i) => [i.name, i.units])).toEqual([['film.last_update', '1 column'], ['actor.last_update', '2 columns']]);
    expect(importReportCounts(view)).toEqual({ imported: 1, repaired: 1, notImported: 5, skipped: 5 });
  });

  it('says what the draft drew in Imported, and where the import got to', () => {
    const view = buildImportReportView(record());
    expect(view.headline).toBe('Import SQL DDL from 2 SQL files (PostgreSQL)');
    expect(view.status).toBe('The draft is open: nothing is saved until you keep it.');
    expect(view.sections[0].summary).toBe('24 tables and 31 relationships in the draft.');
    const kept = buildImportReportView(record({ status: 'kept', diagram: 'main/sales', imported: { tables: 1, relationships: 1 } }));
    expect(kept.status).toBe('Kept as the diagram main/sales.');
    expect(kept.sections[0].summary).toBe('1 table and 1 relationship in the diagram.');
    expect(buildImportReportView(record({ status: 'timedOut' })).status).toMatch(/time limit/);
    expect(buildImportReportView(record({ status: 'cancelled' })).status).toMatch(/stopped before it finished/);
  });

  it('a failure with nothing drawn has no Imported section; an empty complete ledger says everything came across', () => {
    const failed = buildImportReportView(record({ status: 'failed', imported: undefined, ledger: problemLedger([{ file: 'sql/01_tables.sql', line: 3 }], 'table', 'CREATE TABLE') }));
    expect(failed.sections.map((s) => s.id)).toEqual(['notImported']);
    expect(failed.complete).toBe(false);
    const clean = buildImportReportView(record({ ledger: [], imported: undefined }));
    expect(clean.sections).toEqual([]);
    expect(buildImportReportHtml(clean, 'n')).toContain('Nothing to report: everything was brought across as written.');
    expect(buildImportReportHtml(buildImportReportView(record({ status: 'failed', ledger: [], imported: undefined })), 'n')).not.toContain('Nothing to report');
  });

  it('lists at most MAX_ITEMS_PER_GROUP entries a cause and counts the rest', () => {
    const l = createLedger();
    for (let i = 1; i <= MAX_ITEMS_PER_GROUP + 5; i++) l.lost('column', 'noField', 'UNSIGNED', { file: 'a.sql', line: i, table: 't', column: `c${i}` });
    const view = buildImportReportView(record({ ledger: [...l.entries] }));
    const group = view.sections.find((s) => s.id === 'notImported')!.groups[0];
    expect(group.items).toHaveLength(MAX_ITEMS_PER_GROUP);
    expect(group.more).toBe(5);
    expect(group.count).toBe(MAX_ITEMS_PER_GROUP + 5);
    expect(buildImportReportHtml(view, 'n')).toContain('And 5 more: ERD Studio: Show Logs lists every one.');
  });
});

describe('Import report: file:line links', () => {
  it('links an entry only to a file the import read, one link per file and line, absolute paths kept on the host', () => {
    const view = buildImportReportView(record());
    // Every file and line once, in the order the page lists them; elsewhere.sql (not read) has none.
    expect(view.links).toHaveLength(7);
    expect(view.links).toEqual(expect.arrayContaining([
      { file: '/proj/sql/01_tables.sql', line: 12 },
      { file: '/proj/sql/01_tables.sql', line: 14 },
      { file: '/proj/sql/01_tables.sql', line: 30 },
      { file: '/proj/sql/01_tables.sql', line: 40 },
      { file: '/proj/sql/01_tables.sql', line: 90 },
      { file: '/proj/sql/02_more.sql', line: 3 },
      { file: '/proj/sql/02_more.sql' },
    ]));
    const items = view.sections.flatMap((s) => s.groups.flatMap((g) => g.items));
    const broken = items.find((i) => i.name === 'public.broken')!;
    expect(broken.place).toBe('sql/01_tables.sql line 40');
    expect(view.links[broken.link!]).toEqual({ file: '/proj/sql/01_tables.sql', line: 40 });
    // elsewhere.sql was not read by this import: its place is shown, never linked.
    const elsewhere = items.find((i) => i.place?.startsWith('elsewhere.sql'))!;
    expect(elsewhere.link).toBeUndefined();
    // The page holds indexes only.
    const html = buildImportReportHtml(view, 'n');
    expect(html).not.toContain('/proj/');
    expect(html).toContain(`data-link="${broken.link}"`);
    expect(html).toContain('<span class="ir-item__place">(elsewhere.sql line 7)</span>');
  });

  it('never treats an inherited key as a file (a ledger file named like an Object property)', () => {
    const l = createLedger();
    l.lost('column', 'noField', 'x', { file: 'constructor', line: 1 });
    l.lost('column', 'noField', 'x', { file: '__proto__', line: 1 });
    const view = buildImportReportView(record({ ledger: [...l.entries], files: {} }));
    expect(view.links).toEqual([]);
  });

  it('accepts only an open message for a link the report has', () => {
    expect(parseImportReportToHost({ type: 'open', link: 2 }, 3)).toEqual({ type: 'open', link: 2 });
    for (const bad of [
      { type: 'open', link: 3 }, { type: 'open', link: -1 }, { type: 'open', link: 1.5 }, { type: 'open', link: '1' },
      { type: 'open', file: '/etc/passwd', line: 1 }, { type: 'run', command: 'x' }, null, [], 'open',
    ]) {
      expect(parseImportReportToHost(bad, 3)).toBeUndefined();
    }
    // Extra fields are dropped: what comes back is rebuilt from the index alone.
    expect(parseImportReportToHost({ type: 'open', link: 0, file: '/etc/passwd' }, 1)).toEqual({ type: 'open', link: 0 });
  });
});

describe('Import report: the page', () => {
  it('is nonce-only, loads nothing remote, uses theme colours and BEM classes', () => {
    const html = buildImportReportHtml(buildImportReportView(record()), 'abc123');
    expect(buildImportReportCsp('abc123')).toBe("default-src 'none'; style-src 'nonce-abc123'; script-src 'nonce-abc123';");
    expect(html).toContain('<style nonce="abc123">');
    expect(html).toContain('<script nonce="abc123">');
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
    expect(html).not.toMatch(/\son[a-z]+="/);
    const classes = [...html.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(' '));
    for (const c of classes) expect(c).toMatch(/^ir(-[a-z]+)?(__[a-z-]+)?(--[a-zA-Z]+)?$/);
  });

  it('escapes every string from the ledger and cuts it to one line', () => {
    const l = createLedger();
    l.lost('table', 'noField', '<img src=x onerror=alert(1)>', { file: 'a"b.sql', line: 1, table: '<script>alert(1)</script>' }, 'two\nlines');
    const html = buildImportReportHtml(buildImportReportView(record({ ledger: [...l.entries], files: { 'a"b.sql': '/p/a"b.sql' } })), 'n');
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('a&quot;b.sql line 1');
    expect(html).toContain('two lines');
  });

  it('the no-import page says how to get one', () => {
    expect(buildImportReportHtml(undefined, 'n')).toContain('No import has run in this window yet.');
  });
});

describe('Import report: what the imports say with it', () => {
  it('the partial toast counts what could not be read, by unit, and not a table defined twice', () => {
    expect(partialImportMessage('Import SQL DDL', sqlLedger())).toBe(
      'Import SQL DDL: 2 tables could not be read, so the diagram leaves them out. Show Import Report lists each one with its file and line.',
    );
    const one = createLedger();
    one.problem('statement', 'parseError', 'statement', { file: 'a.sql', line: 1 });
    one.problem('table', 'duplicate', 'table defined twice', { file: 'a.sql', line: 9, table: 't' });
    expect(partialImportMessage('Import SQL DDL', [...one.entries])).toBe(
      'Import SQL DDL: 1 statement could not be read, so the diagram leaves it out. Show Import Report lists it with its file and line.',
    );
    const mixed = createLedger();
    mixed.problem('table', 'parseError', 'CREATE TABLE', { file: 'a.sql', line: 1, table: 'a' });
    mixed.problem('statement', 'parseError', 'statement', { file: 'a.sql', line: 5 });
    mixed.problem('statement', 'parseError', 'statement', { file: 'a.sql', line: 8 });
    expect(partialImportMessage('Import SQL DDL', [...mixed.entries])).toMatch(/^Import SQL DDL: 1 table and 2 statements could not be read/);
    const noProblems = createLedger();
    noProblems.lost('column', 'noField', 'x');
    expect(partialImportMessage('Import SQL DDL', [...noProblems.entries])).toBeUndefined();
  });

  it('a failure ledger is one problem per place, with no parser text', () => {
    expect(problemLedger([{ file: 'model.bim', line: 3 }, { file: 'model.bim', line: 3 }, { file: 'x.tmdl' }], 'file', 'model file')).toEqual([
      { outcome: 'problem', unit: 'file', cause: 'parseError', what: 'model file', where: { file: 'model.bim', line: 3 }, count: 2 },
      { outcome: 'problem', unit: 'file', cause: 'parseError', what: 'model file', where: { file: 'x.tmdl' }, count: 1 },
    ]);
  });
});

describe('Import report: the store', () => {
  beforeEach(() => _resetImportReports());

  it('keeps the last import only, moves it on by id, and ignores an update for a replaced one', () => {
    expect(latestImportReport()).toBeUndefined();
    const first = recordImportReport({ ...record(), at: 5 });
    expect(latestImportReport()?.at).toBe(5);
    expect(updateImportReport(first, { status: 'kept', diagram: 'main/a' })).toBe(true);
    expect(latestImportReport()).toMatchObject({ status: 'kept', diagram: 'main/a' });
    const second = recordImportReport({ ...record(), source: 'dbt', title: 'Import from dbt' });
    expect(updateImportReport(first, { status: 'notKept' })).toBe(false);
    expect(latestImportReport()).toMatchObject({ source: 'dbt', status: 'draft' });
    expect(updateImportReport(undefined, { status: 'notKept' })).toBe(false);
    expect(second).toBeGreaterThan(first);
  });

  it('copies the ledger, so the import changing its own afterwards does not change the report', () => {
    const l = createLedger();
    l.lost('column', 'noField', 'x', { file: 'a.sql', line: 1 });
    recordImportReport({ ...record(), ledger: l.entries });
    l.lost('column', 'noField', 'x', { file: 'a.sql', line: 1 });
    l.lost('table', 'noField', 'y');
    expect(latestImportReport()!.ledger).toEqual([{ outcome: 'lost', unit: 'column', cause: 'noField', what: 'x', count: 1, where: { file: 'a.sql', line: 1 } }]);
  });

  it('tells its listeners, and a failing listener stops nothing', () => {
    const seen: string[] = [];
    onImportReportChanged(() => { throw new Error('boom'); });
    const sub = onImportReportChanged(() => seen.push(latestImportReport()!.status));
    const id = recordImportReport(record());
    updateImportReport(id, { status: 'notKept' });
    sub.dispose();
    updateImportReport(id, { status: 'kept' });
    expect(seen).toEqual(['draft', 'notKept']);
  });
});

type MockPanel = ReturnType<typeof import('../__mocks__/vscode').createMockWebviewPanel>;
const panels = (): MockPanel[] => (vscode.window as unknown as { _webviewPanels: MockPanel[] })._webviewPanels
  .filter((p) => (p as unknown as { viewType: string }).viewType === IMPORT_REPORT_VIEW_TYPE);

describe('Import report: the panel and the command', () => {
  beforeEach(() => {
    _resetImportReports();
    _resetMockWebviewPanels();
  });
  afterEach(() => {
    ImportReportPanel.currentPanel?.dispose();
    vi.restoreAllMocks();
  });

  it('is contributed (category ERD Studio, in a folder), has no legacy alias and is not pre-registered', () => {
    const pkg = packageJson as unknown as {
      contributes: { commands: Array<{ command: string; title: string; category?: string }>; menus: Record<string, Array<{ command?: string; when?: string }>> };
    };
    expect(pkg.contributes.commands.find((c) => c.command === SHOW_IMPORT_REPORT_COMMAND)).toEqual({
      command: SHOW_IMPORT_REPORT_COMMAND, title: SHOW_IMPORT_REPORT_LABEL, category: 'ERD Studio',
    });
    expect(pkg.contributes.menus.commandPalette.filter((m) => m.command === SHOW_IMPORT_REPORT_COMMAND)).toEqual([
      { command: SHOW_IMPORT_REPORT_COMMAND, when: 'erdStudio.hasProject' },
    ]);
    expect(NO_LEGACY_ALIAS.has(SHOW_IMPORT_REPORT_COMMAND)).toBe(true);
    expect(PRE_REGISTERED_COMMANDS.has(SHOW_IMPORT_REPORT_COMMAND)).toBe(false);
  });

  it('with no import yet, says so and opens nothing', () => {
    const info = vi.spyOn(vscode.window, 'showInformationMessage');
    showImportReport();
    expect(info).toHaveBeenCalledWith(NO_IMPORT_REPORT_MESSAGE);
    expect(panels()).toHaveLength(0);
  });

  it('shows the last import in one read-only tab, follows a new import, and opens a link at its line', async () => {
    recordImportReport(record());
    const opened: Array<[string, number | undefined]> = [];
    ImportReportPanel.createOrShow({ openFileAt: async (file, line) => { opened.push([file, line]); } });
    expect(panels()).toHaveLength(1);
    const panel = panels()[0];
    expect(panel.webview.options).toMatchObject({ enableScripts: true, localResourceRoots: [] });
    expect(panel.webview.html).toContain('Import SQL DDL from 2 SQL files (PostgreSQL)');

    const view = buildImportReportView(latestImportReport()!);
    const target = view.links.findIndex((l) => l.line === 40);
    await panel._simulateMessage({ type: 'open', link: target });
    expect(opened).toEqual([['/proj/sql/01_tables.sql', 40]]);
    // Anything else is dropped: a path from the page is never opened.
    await panel._simulateMessage({ type: 'open', link: 999 });
    await panel._simulateMessage({ type: 'open', file: '/etc/passwd' });
    expect(opened).toHaveLength(1);

    // A new import replaces it in the open tab; a second command reuses the tab.
    recordImportReport({ ...record(), source: 'dbt', title: 'Import from dbt', from: 'from models/marts', files: {} });
    expect(panel.webview.html).toContain('Import from dbt from models/marts');
    ImportReportPanel.createOrShow({ openFileAt: async () => {} });
    expect(panels()).toHaveLength(1);
  });

  it('a link to a file that has gone says so instead of failing silently', async () => {
    recordImportReport(record());
    const missing: string[] = [];
    ImportReportPanel.createOrShow({ openFileAt: async () => { throw new Error('ENOENT'); }, couldNotOpen: (f) => missing.push(f) });
    await panels()[0]._simulateMessage({ type: 'open', link: 0 });
    expect(missing).toEqual(['/proj/sql/01_tables.sql']);
  });

  it('writes nothing: showing the report and following its links touch no file, edit or setting', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-import-report-'));
    const script = path.join(tmp, 'a.sql');
    fs.writeFileSync(script, 'CREATE TABLE a (id int);\n');
    const before = fs.readFileSync(script, 'utf8');
    const l = createLedger();
    l.lost('column', 'noField', 'x', { file: 'a.sql', line: 1, table: 'a', column: 'id' });
    recordImportReport({ ...record(), ledger: [...l.entries], files: { 'a.sql': script } });

    const mtime = fs.statSync(script).mtimeMs;
    // Node's own fs cannot be spied in ESM: the folder's state below and the source scan in the next test cover it.
    const writes = [
      vi.spyOn(vscode.workspace, 'applyEdit'), vi.spyOn(vscode.workspace.fs, 'writeFile'),
      vi.spyOn(vscode.workspace.fs, 'delete'), vi.spyOn(vscode.workspace.fs, 'createDirectory'),
    ];
    const show = vi.spyOn(vscode.window, 'showTextDocument');
    vi.spyOn(vscode.workspace, 'openTextDocument').mockResolvedValue({ lineCount: 1 } as unknown as vscode.TextDocument);

    showImportReport();
    await panels()[0]._simulateMessage({ type: 'open', link: 0 });

    expect(show).toHaveBeenCalledTimes(1);
    for (const w of writes) expect(w).not.toHaveBeenCalled();
    expect(fs.readFileSync(script, 'utf8')).toBe(before);
    expect(fs.statSync(script).mtimeMs).toBe(mtime);
    expect(fs.readdirSync(tmp)).toEqual(['a.sql']);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('writes nothing, by construction: no report module reaches a writer', () => {
    for (const file of ['src/services/importReport.ts', 'src/services/importReportStore.ts', 'src/providers/ImportReportPanel.ts', 'src/commands/showImportReport.ts']) {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
      expect(text, file).not.toMatch(/from 'fs'|require\('fs'\)|from 'fs\/promises'/);
      expect(text, file).not.toMatch(/writeFile|applyEdit|WorkspaceEdit|globalState|workspaceState|getConfiguration|\.update\(/);
    }
    // The pure halves stay vscode-free.
    for (const file of ['src/services/importReport.ts', 'src/services/importReportStore.ts']) {
      expect(fs.readFileSync(path.join(ROOT, file), 'utf8'), file).not.toMatch(/from 'vscode'/);
    }
  });

  it('the toasts\' and failures\' button runs the command', async () => {
    const run = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
    const actions = importReportAction();
    expect(Object.keys(actions)).toEqual([SHOW_IMPORT_REPORT_LABEL]);
    await actions[SHOW_IMPORT_REPORT_LABEL]();
    expect(run).toHaveBeenCalledWith(SHOW_IMPORT_REPORT_COMMAND);
  });
});
