/**
 * The dry run of a large import (C): the modal stays within its line budget
 * whatever the size — counts by schema, never a list of tables — and Review
 * All… lists everything: every table by schema with its columns and keys,
 * every relationship, what is left out and why. The page is the Convert
 * review's pattern (nonce-only CSP, its own validated protocol), with the
 * import's Import / Cancel (/ Change Options…) on it.
 *
 * The large fixture (`test/fixtures/sql-ddl/large/`, 257 PostgreSQL tables
 * in eight schemas with a view, an index, a grant and an insert) is written
 * by its `generate.mjs`.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { _resetMockWebviewPanels, _resetMockWorkspace } from '../__mocks__/vscode';
import {
  CHANGE_OPTIONS_BUTTON,
  IMPORT_BUTTON,
  REVIEW_ALL_BUTTON,
  type ImportDbmlUi,
} from '../../src/commands/importDbml';
import { openExampleDiagram } from '../../src/commands/openExampleDiagram';
import { gatherSqlFiles, importSqlDdl, quickImportSqlDdl, type ImportSqlDdlUi } from '../../src/commands/importSqlDdl';
import { ImportReviewPanel } from '../../src/providers/ImportReviewPanel';
import {
  IMPORT_MODAL_MAX_DETAIL_LINES,
  IMPORT_MODAL_NOTES_SHOWN,
  IMPORT_MODAL_SCHEMAS_SHOWN,
} from '../../src/services/dbmlImport';
import { SubjectAreaService } from '../../src/services/domainService';
import {
  IMPORT_REVIEW_VIEW_TYPE,
  buildImportReviewCsp,
  buildImportReviewHtml,
  isImportReviewToHost,
  type ImportReviewView,
} from '../../src/services/importReview';
import { LayerService, NEW_PROJECT_LAYERS_WITHOUT_DBT } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import * as engine from '../../src/services/sqlImportEngine';
import { telemetry } from '../../src/services/telemetryService';

const LARGE = path.join(__dirname, '../fixtures/sql-ddl/large');
/** What `generate.mjs` writes: [schema, tables]. */
const SCHEMAS: Array<[string, number]> = [
  ['sales', 80], ['finance', 50], ['hr', 40], ['ops', 40], ['marketing', 25], ['staging', 15], ['audit', 4], ['ref', 3],
];
const TOTAL = SCHEMAS.reduce((n, [, t]) => n + t, 0);

let tmp: string;
let feature: ReturnType<typeof vi.spyOn>;

interface Recorder extends ImportDbmlUi {
  chooses: Array<{ message: string; detail: string; buttons: readonly string[] }>;
  reviews: ImportReviewView[];
  opened: string[];
}

/** The dry run answered by `choices` in turn; the review page by `reviewAnswers` in turn. */
function ui(choices: Array<string | undefined>, reviewAnswers: Array<'import' | 'cancel' | 'changeOptions' | 'closed'> = []): Recorder {
  const r: Recorder = {
    chooses: [], reviews: [], opened: [],
    pickFile: async () => { throw new Error('no dialog'); },
    readFile: async () => { throw new Error('converted DBML is never read'); },
    showQuickPick: async <T extends vscode.QuickPickItem>(items: readonly T[]) => items[0],
    showInputBox: async (options) => options.value,
    confirm: async () => { throw new Error('choose is used'); },
    choose: async (message, detail, buttons) => { r.chooses.push({ message, detail, buttons }); return choices.shift(); },
    review: async (view) => { r.reviews.push(view); return reviewAnswers.shift() ?? 'closed'; },
    showInformationMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    openFileAt: async () => {},
    showFile: async () => {},
    openDiagram: async (p) => { r.opened.push(p); },
    addLayer: async () => {},
    sendFeedback: async () => {},
  };
  return r;
}

const sqlUi: ImportSqlDdlUi = {
  pickSources: async () => undefined,
  readDirectory: async (folder) => fs.readdirSync(folder, { withFileTypes: true }).map((d) => [d.name, d.isDirectory()] as const),
  readFile: async (filePath) => fs.readFileSync(filePath, 'utf-8'),
  pickDialect: async (items) => items[0],
  showInformationMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  openFileAt: async () => {},
  sendFeedback: async () => {},
};

function deps(importUi: ImportDbmlUi) {
  const layerService = new LayerService(tmp, '.erd-studio');
  layerService.useDefaultLayers(NEW_PROJECT_LAYERS_WITHOUT_DBT);
  const subjectAreaService = new SubjectAreaService(layerService);
  const tableLibraryService = new TableLibraryService(tmp, '.erd-studio');
  subjectAreaService.setTableLibraryService(tableLibraryService);
  return {
    workspaceRoot: tmp, semanticDir: '.erd-studio', layerService, subjectAreaService, tableLibraryService,
    validateDomainName: () => undefined, onWritten: () => {},
    extensionPath: '/nowhere', sqlUi, ui: importUi, loadSqlImport: () => engine,
  };
}

const visibleLines = (detail: string): string[] => detail.split('\n').filter((l) => l.trim() !== '');

beforeEach(() => {
  _resetMockWorkspace();
  _resetMockWebviewPanels();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-review-'));
  fs.cpSync(LARGE, path.join(tmp, 'warehouse'), { recursive: true });
  fs.rmSync(path.join(tmp, 'warehouse', 'generate.mjs'));
  feature = vi.spyOn(telemetry, 'feature');
  vi.spyOn(telemetry, 'error');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the large fixture', () => {
  it('is what generate.mjs writes (re-run it after changing the generator)', () => {
    const files = fs.readdirSync(LARGE).filter((f) => f.endsWith('.sql')).sort();
    expect(files).toEqual(SCHEMAS.map(([schema], i) => `${String(i + 1).padStart(2, '0')}_${schema}.sql`));
    const tables = files.map((f) => (fs.readFileSync(path.join(LARGE, f), 'utf-8').match(/^CREATE TABLE /gm) ?? []).length);
    expect(tables).toEqual(SCHEMAS.map(([, n]) => n));
    // Small in bytes, though 257 tables.
    expect(files.reduce((n, f) => n + fs.statSync(path.join(LARGE, f)).size, 0)).toBeLessThan(100_000);
  });
});

describe('a 257-table import', () => {
  it('the modal: a headline with the counts, at most ten short lines, the schemas counted, never a table listed', async () => {
    const r = ui([undefined]);
    expect(await quickImportSqlDdl(deps(r))).toBeUndefined();
    expect(r.chooses).toHaveLength(1);
    const { message, detail, buttons } = r.chooses[0];
    expect(message).toMatch(new RegExp(`^Import ${TOTAL} tables and \\d+ relationships from 8 SQL files \\(PostgreSQL\\) into a new diagram "sales" in the Main layer\\.$`));
    expect(buttons).toEqual([IMPORT_BUTTON, REVIEW_ALL_BUTTON, CHANGE_OPTIONS_BUTTON]);
    const lines = visibleLines(detail);
    expect(lines.length).toBeLessThanOrEqual(IMPORT_MODAL_MAX_DETAIL_LINES);
    for (const line of lines) expect(line.length, line).toBeLessThanOrEqual(200);
    // Top five schemas by count, the rest summed.
    expect(IMPORT_MODAL_SCHEMAS_SHOWN).toBe(5);
    expect(lines[0]).toBe(`• ${TOTAL} new tables by schema: sales 80, finance 50, hr 40, ops 40, marketing 25, and 3 more schemas (22 tables).`);
    expect(detail).toMatch(/^• Not imported: .+; and \d+ more\.$/m);
    // Never a per-table list.
    expect(detail).not.toMatch(/_t\d{3}/);
    // Cancel writes nothing.
    expect(fs.existsSync(path.join(tmp, '.erd-studio'))).toBe(false);
  });

  it('Review All… lists every table by schema with its columns and keys, every relationship, what is left out; Import on the page writes it', async () => {
    const r = ui([REVIEW_ALL_BUTTON], ['import']);
    const result = await quickImportSqlDdl(deps(r));
    expect(r.reviews).toHaveLength(1);
    const view = r.reviews[0];
    expect(view.heading).toBe(r.chooses[0].message);
    expect(view.changeOptions).toBe(true);
    const schemaSections = view.sections.filter((s) => s.id.startsWith('schema:'));
    expect(schemaSections.map((s) => [s.title, s.items.length])).toEqual(SCHEMAS.map(([schema, n]) => [`Schema ${schema}`, n]));
    const tables = schemaSections.flatMap((s) => s.items);
    expect(tables).toHaveLength(TOTAL);
    expect(new Set(tables.map((t) => t.path)).size).toBe(TOTAL);
    expect(tables.find((t) => t.path === 'finance_t002')).toEqual({
      path: 'finance_t002', tag: 'new', text: '5 columns · primary key id · 1 foreign key',
    });
    expect(tables.find((t) => t.path === 'sales_t001')?.text).toBe('3 columns · primary key id');
    const rels = view.sections.find((s) => s.id === 'relationships')!;
    expect(rels.items).toHaveLength(result!.plan.report.relationships);
    expect(rels.items).toContainEqual({ path: 'finance_t002.parent_id → finance_t001.id', tag: 'many-to-one' });
    const left = view.sections.find((s) => s.id === 'left')!.items.map((i) => i.text);
    expect(left).toEqual(expect.arrayContaining([
      expect.stringMatching(/^warehouse\/01_sales\.sql: skipped .*view.*index/),
      expect.stringMatching(/^warehouse\/02_finance\.sql: skipped .*permission statement/),
      expect.stringMatching(/^warehouse\/03_hr\.sql: skipped .*data statement/),
    ]));
    expect(view.counts).toContainEqual({ label: 'tables', value: TOTAL });
    expect(view.counts).toContainEqual({ label: 'schemas', value: 8 });
    // Import on the page: written and opened, with no second modal.
    expect(r.chooses).toHaveLength(1);
    expect(result?.plan.modelNames).toHaveLength(TOTAL);
    expect(r.opened).toEqual([result!.domainPath]);
    expect(feature.mock.calls.map((c: unknown[]) => c[0])).toEqual(['importSqlDialectPostgres', 'importReviewOpened', 'importSqlDdl', 'quickImport']);
  });

  it('closing the review page shows the modal again; Cancel on the page writes nothing', async () => {
    const again = ui([REVIEW_ALL_BUTTON, IMPORT_BUTTON], ['closed']);
    expect(await quickImportSqlDdl(deps(again))).toBeDefined();
    expect(again.chooses).toHaveLength(2);

    fs.rmSync(path.join(tmp, '.erd-studio'), { recursive: true });
    const cancel = ui([REVIEW_ALL_BUTTON], ['cancel']);
    expect(await quickImportSqlDdl(deps(cancel))).toBeUndefined();
    expect(cancel.chooses).toHaveLength(1);
    expect(fs.existsSync(path.join(tmp, '.erd-studio'))).toBe(false);
  });

  it('the step-by-step import has the same modal and review, without Change Options…', async () => {
    const r = ui([REVIEW_ALL_BUTTON], ['cancel']);
    const read = await gatherSqlFiles({ folder: path.join(tmp, 'warehouse') }, sqlUi);
    if ('message' in read) throw new Error(read.message);
    await importSqlDdl(deps(r), read);
    expect(r.chooses[0].buttons).toEqual([IMPORT_BUTTON, REVIEW_ALL_BUTTON]);
    expect(visibleLines(r.chooses[0].detail).length).toBeLessThanOrEqual(IMPORT_MODAL_MAX_DETAIL_LINES);
    expect(r.reviews[0].changeOptions).toBe(false);
  });
});

describe('a 6-table import (the coffee-shop example)', () => {
  it('the same short modal: the count, the relationships, the layout', async () => {
    fs.rmSync(path.join(tmp, 'warehouse'), { recursive: true });
    const r = ui([undefined]);
    await openExampleDiagram(deps(r));
    expect(r.chooses[0].message).toBe('Import 6 tables and 8 relationships into a new diagram "coffee-shop" in the Main layer.');
    expect(visibleLines(r.chooses[0].detail)).toEqual([
      '• 6 new tables.',
      '• 8 relationships saved in main/relationships/main.dbml.',
      '• Every relationship is saved as optional (?: its foreign key may be empty), as ERD Studio saves them all. In the file, 8 references were not optional.',
      '• Layout: The diagram is laid out automatically when it opens, and that layout is saved in the diagram file.',
    ]);
    expect(IMPORT_MODAL_NOTES_SHOWN).toBe(2);
  });
});

describe('the review page', () => {
  const view: ImportReviewView = {
    heading: 'Import 2 tables into a new diagram "x" in the Main layer.',
    intro: ['Nothing is written until you choose Import.'],
    counts: [{ label: 'tables', value: 2 }],
    sections: [{ id: 'schema:', title: 'New tables', items: [{ path: '<script>a</script>', tag: 'new', text: '1 column · no primary key' }] }],
    changeOptions: true,
    importLabel: 'Import',
  };

  it('is nonce-only (no inline handlers, no remote resource) and escapes every value', () => {
    const html = buildImportReviewHtml(view, 'abc123');
    expect(html).toContain('content="default-src &#39;none&#39;; style-src &#39;nonce-abc123&#39;; script-src &#39;nonce-abc123&#39;;"');
    expect(buildImportReviewCsp('abc123')).toBe("default-src 'none'; style-src 'nonce-abc123'; script-src 'nonce-abc123';");
    expect(html).not.toMatch(/\son\w+=|style="|https?:\/\//);
    expect(html).not.toContain('<script>a</script>');
    expect(html).toContain('&lt;script&gt;a&lt;/script&gt;');
    expect(html).toContain('data-action="import"');
    expect(html).toContain('data-action="cancel"');
    expect(html).toContain('data-action="changeOptions"');
    expect(buildImportReviewHtml({ ...view, changeOptions: false }, 'n')).not.toContain('data-action="changeOptions"');
  });

  it('accepts only its three answers', () => {
    for (const type of ['import', 'cancel', 'changeOptions']) expect(isImportReviewToHost({ type })).toBe(true);
    for (const bad of [undefined, null, 'import', [], { type: 'open' }, { type: 'convert' }, {}]) expect(isImportReviewToHost(bad)).toBe(false);
  });

  it('the host: a panel per review, an answer closes it, closing it answers closed, a stray message is ignored', async () => {
    const first = ImportReviewPanel.show(view);
    const panel = vscode.window._webviewPanels.at(-1)!;
    expect(panel.viewType).toBe(IMPORT_REVIEW_VIEW_TYPE);
    ImportReviewPanel.currentPanel!.handleMessage({ type: 'open', index: 0 });
    expect(ImportReviewPanel.currentPanel).toBeDefined();
    ImportReviewPanel.currentPanel!.handleMessage({ type: 'import' });
    expect(await first).toBe('import');
    expect(ImportReviewPanel.currentPanel).toBeUndefined();

    const second = ImportReviewPanel.show(view);
    // A newer review takes the page over: the older import sees it closed.
    const third = ImportReviewPanel.show(view);
    expect(await second).toBe('closed');
    vscode.window._webviewPanels.at(-1)!.dispose();
    expect(await third).toBe('closed');
  });
});
