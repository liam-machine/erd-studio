/**
 * The dry run of a large import (C), now the draft (Draft-first,
 * `docs/dev/draft-first.md` §2.4, §10): the fallback modal (no preview) stays
 * within its line budget whatever the size — counts by schema, never a list
 * of tables — and the draft's details drawer lists everything Review All…
 * did: every table by schema with its columns and keys, every relationship,
 * what is left out and why, as data (`buildImportReview`'s sections). The
 * Review All… page (`ImportReviewPanel`, its HTML and protocol) is gone.
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
  type ImportDbmlUi,
} from '../../src/commands/importDbml';
import * as importDbmlModule from '../../src/commands/importDbml';
import { openExampleDiagram } from '../../src/commands/openExampleDiagram';
import { gatherSqlFiles, importSqlDdl, quickImportSqlDdl, type ImportSqlDdlUi } from '../../src/commands/importSqlDdl';
import {
  IMPORT_MODAL_MAX_DETAIL_LINES,
  IMPORT_MODAL_NOTES_SHOWN,
  IMPORT_MODAL_SCHEMAS_SHOWN,
} from '../../src/services/dbmlImport';
import { SubjectAreaService } from '../../src/services/domainService';
import * as importReview from '../../src/services/importReview';
import { buildImportReview } from '../../src/services/importReview';
import { LayerService, NEW_PROJECT_LAYERS_WITHOUT_DBT } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import * as engine from '../../src/services/sqlImportEngine';
import { telemetry } from '../../src/services/telemetryService';
import { fakeDraftPreview } from './helpers/draftDriver';

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
  opened: string[];
}

/** The fallback dry run (no preview) answered by `choices` in turn. */
function ui(choices: Array<string | undefined>): Recorder {
  const r: Recorder = {
    chooses: [], opened: [],
    pickFile: async () => { throw new Error('no dialog'); },
    readFile: async () => { throw new Error('converted DBML is never read'); },
    showQuickPick: async <T extends vscode.QuickPickItem>(items: readonly T[]) => items[0],
    showInputBox: async (options) => options.value,
    confirm: async () => { throw new Error('choose is used'); },
    choose: async (message, detail, buttons) => { r.chooses.push({ message, detail, buttons }); return choices.shift(); },
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
  it('the fallback modal (no preview): a headline with the counts, at most ten short lines, the schemas counted, never a table listed', async () => {
    const r = ui([undefined]);
    expect(await quickImportSqlDdl(deps(r))).toBeUndefined();
    expect(r.chooses).toHaveLength(1);
    const { message, detail, buttons } = r.chooses[0];
    expect(message).toMatch(new RegExp(`^Import ${TOTAL} tables and \\d+ relationships from 8 SQL files \\(PostgreSQL\\) into a new diagram "sales" in the Main layer\\.$`));
    // Review All… is gone: the draft's details drawer replaces it.
    expect(buttons).toEqual([IMPORT_BUTTON, CHANGE_OPTIONS_BUTTON]);
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

  it('the draft\'s details list every table by schema with its columns and keys, every relationship, what is left out; Keep writes it', async () => {
    const preview = fakeDraftPreview(['keep']);
    const r = ui([]);
    const result = await quickImportSqlDdl({ ...deps(r), draft: { preview, trigger: 'start' } });
    // No modal: the draft is the one question.
    expect(r.chooses).toHaveLength(0);
    expect(preview.drafts).toHaveLength(1);
    const draft = preview.drafts[0];
    expect(draft.source).toBe('sqlDdl');
    expect(draft.banner.changeOptions).toBe(true);
    const schemaSections = draft.details.filter((s) => s.id.startsWith('tables:'));
    expect(schemaSections.map((s) => [s.title, s.items.length])).toEqual(SCHEMAS.map(([schema, n]) => [`Schema ${schema}`, n]));
    const tables = schemaSections.flatMap((s) => s.items);
    expect(tables).toHaveLength(TOTAL);
    expect(new Set(tables.map((t) => t.path)).size).toBe(TOTAL);
    expect(tables.find((t) => t.path === 'finance_t002')?.text).toBe('5 columns · primary key id · 1 foreign key');
    expect(tables.find((t) => t.path === 'sales_t001')?.text).toBe('3 columns · primary key id');
    const rels = draft.details.find((s) => s.id === 'relationships')!;
    expect(rels.items).toHaveLength(result!.plan.report.relationships);
    expect(rels.items.map((i) => i.path)).toContain('finance_t002.parent_id → finance_t001.id');
    const left = draft.details.find((s) => s.id === 'leftOut')!.items.map((i) => i.text);
    expect(left).toEqual(expect.arrayContaining([
      expect.stringMatching(/^warehouse\/01_sales\.sql: skipped .*view.*index/),
      expect.stringMatching(/^warehouse\/02_finance\.sql: skipped .*permission statement/),
      expect.stringMatching(/^warehouse\/03_hr\.sql: skipped .*data statement/),
    ]));
    expect(draft.summary.tables).toBe(TOTAL);
    expect(draft.summary.schemas).toHaveLength(8);
    // Keep: written and opened, the Keep settled kept.
    expect(result?.plan.modelNames).toHaveLength(TOTAL);
    expect(r.opened).toEqual([result!.domainPath]);
    expect(preview.settled).toEqual([{ kept: true }]);
    expect(feature.mock.calls.map((c: unknown[]) => c[0])).toEqual(['importSqlDialectPostgres', 'importSqlDdl', 'quickImport']);
  });

  it('Discard on the draft writes nothing and counts the import\'s cancel', async () => {
    const preview = fakeDraftPreview(['discard']);
    expect(await quickImportSqlDdl({ ...deps(ui([])), draft: { preview, trigger: 'start' } })).toBeUndefined();
    expect(fs.existsSync(path.join(tmp, '.erd-studio'))).toBe(false);
    expect(feature.mock.calls.map((c: unknown[]) => c[0])).toEqual(['importSqlDialectPostgres', 'importSqlDdlCancelled']);
  });

  it('the step-by-step import has the same modal, without Change Options…', async () => {
    const r = ui([undefined]);
    const read = await gatherSqlFiles({ folder: path.join(tmp, 'warehouse') }, sqlUi);
    if ('message' in read) throw new Error(read.message);
    await importSqlDdl(deps(r), read);
    expect(r.chooses[0].buttons).toEqual([IMPORT_BUTTON]);
    expect(visibleLines(r.chooses[0].detail).length).toBeLessThanOrEqual(IMPORT_MODAL_MAX_DETAIL_LINES);
  });

  it('buildImportReview stays (the draft\'s drawer is built from it): every table, every relationship, what is left out', async () => {
    const preview = fakeDraftPreview(['discard']);
    let plan: Parameters<typeof buildImportReview>[0] | undefined;
    const spy = vi.spyOn(importReview, 'buildImportReview');
    await quickImportSqlDdl({ ...deps(ui([])), draft: { preview, trigger: 'start' } });
    plan = spy.mock.calls[0]?.[0];
    expect(plan).toBeDefined();
    const view = buildImportReview(plan!, { layerLabel: 'Main' });
    expect(view.sections.filter((s) => s.id.startsWith('schema:')).flatMap((s) => s.items)).toHaveLength(TOTAL);
    expect(view.counts).toContainEqual({ label: 'tables', value: TOTAL });
    expect(view.counts).toContainEqual({ label: 'schemas', value: 8 });
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
      // No caveat about the references' `?` on the bundled example (as with no folder open).
      '• Layout: The diagram is laid out automatically when it opens, and that layout is saved in the diagram file.',
    ]);
    expect(IMPORT_MODAL_NOTES_SHOWN).toBe(2);
  });
});

describe('Review All… is removed (Draft-first §10)', () => {
  it('no review page: the panel is deleted, the HTML and protocol are gone, the builders stay', () => {
    expect(fs.existsSync(path.join(__dirname, '../../src/providers/ImportReviewPanel.ts'))).toBe(false);
    const exported = Object.keys(importReview);
    for (const gone of ['buildImportReviewHtml', 'buildImportReviewCsp', 'isImportReviewToHost', 'IMPORT_REVIEW_VIEW_TYPE', 'REVIEW_ALL_BUTTON']) {
      expect(exported).not.toContain(gone);
    }
    expect(exported).toEqual(expect.arrayContaining(['buildImportReview', 'describeImportTable', 'relationshipLines']));
    expect(Object.keys(importDbmlModule)).not.toContain('REVIEW_ALL_BUTTON');
  });
});
