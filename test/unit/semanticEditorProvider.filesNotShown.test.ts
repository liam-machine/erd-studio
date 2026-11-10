/**
 * The canvas follows the files: what a file holds that the canvas is not
 * drawing is said on the canvas (`filesNotShown`), for as long as it is
 * true, and never only in the log or once per session.
 *
 * - a relationships file the diagram does not import: a note with Add the
 *   import, which writes the `use *` line through the edit pipeline;
 * - a `Ref` or inline `[ref: …]` written in a table file: a note at its line;
 * - a relationships file that does not read: a note at the error's line;
 * - a `.dbml` saved where no file is read: a note, until it is moved;
 * - a diagram file that stops reading over a live canvas: a note that stays,
 *   and the toast again on every save of the still-broken file;
 * - a failed redraw: a note with Reload from disk, until a redraw succeeds;
 * - a canvas whose files changed with no event: redrawn when it is checked
 *   against the disk, without writing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  _appliedEdits,
  _fireDidChangeTextDocument,
  _resetMockWorkspace,
  createMockTextDocument,
  createMockWebviewPanel,
} from '../__mocks__/vscode';
import { RELOAD_FROM_DISK_COMMAND, SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { SelectorsService } from '../../src/services/selectorsService';
import { OwnWriteTracker } from '../../src/services/ownWriteTracker';
import type { ManifestService } from '../../src/services/manifestService';
import type { YmlParserService } from '../../src/services/ymlParserService';
import type { TemplateService } from '../../src/services/templateService';
import type { FileNote } from '../../src/types/filesNotShown';

const REPO_ROOT = path.resolve(__dirname, '../..');
const NATIVE = path.join(REPO_ROOT, 'test', 'fixtures', 'dbml-native');
const SALES = 'gold/diagrams/sales.dbml';
const CUSTOMERS_IMPORT = "use * from '../relationships/customers.dbml'\n";

let root: string;
let warnings: string[];

function buildProvider(projectRoot: string): SemanticEditorProvider {
  const layerService = new LayerService(projectRoot, '.erd-studio');
  const subjectAreaService = new SubjectAreaService(layerService);
  const tableLibraryService = new TableLibraryService(projectRoot, '.erd-studio');
  subjectAreaService.setTableLibraryService(tableLibraryService);
  const context = {
    extensionUri: vscode.Uri.file(path.join(projectRoot, 'no-extension')),
    globalStorageUri: vscode.Uri.file(path.join(projectRoot, '.global-storage')),
    extension: { packageJSON: { version: '0.0.0-test' } },
    globalState: { get: () => true, update: async () => {} },
    subscriptions: [],
  } as unknown as import('vscode').ExtensionContext;
  const empty = { models: new Map(), relationshipTests: [], uniqueColumns: new Map(), compositeUniqueGroups: new Map(), disabledModels: new Set() };
  return new SemanticEditorProvider(
    context,
    subjectAreaService,
    { loadManifest: async () => empty } as unknown as ManifestService,
    {
      loadYmlData: async () => ({ models: new Map(), relationshipTests: [], uniqueColumns: new Map(), compositeUniqueGroups: new Map() }),
      invalidate: () => {},
    } as unknown as YmlParserService,
    { loadTemplates: () => [] } as unknown as TemplateService,
    layerService,
    projectRoot,
    new SelectorsService(subjectAreaService, projectRoot, '.erd-studio'),
    tableLibraryService,
    new OwnWriteTracker(),
  );
}

const at = (rel: string): string => path.join(root, '.erd-studio', rel);
const read = (rel: string): string => fs.readFileSync(at(rel), 'utf-8');
const write = (rel: string, text: string): void => {
  fs.mkdirSync(path.dirname(at(rel)), { recursive: true });
  fs.writeFileSync(at(rel), text, 'utf-8');
  // A second write within the same millisecond and of the same size must still read as a change.
  const later = new Date(Date.now() + 5000 + Math.floor(Math.random() * 100000));
  fs.utimesSync(at(rel), later, later);
};

type Panel = ReturnType<typeof createMockWebviewPanel>;

async function open(provider: SemanticEditorProvider, rel = SALES) {
  const doc = createMockTextDocument(at(rel), read(rel), { persist: true });
  const panel = createMockWebviewPanel();
  await provider.resolveCustomTextEditor(
    doc as unknown as import('vscode').TextDocument,
    panel as unknown as import('vscode').WebviewPanel,
    {} as import('vscode').CancellationToken,
  );
  await panel._simulateMessage({ type: 'ready' });
  await settle();
  return { doc, panel };
}

/** The notes are worked out after the diagram has gone out: let that run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

const posted = (panel: Panel, type: string): Array<Record<string, any>> =>
  panel._postedMessages.filter((m) => (m as { type: string }).type === type) as Array<Record<string, any>>;

/** The canvas's current notes: the last `filesNotShown` list posted. */
function notes(panel: Panel): FileNote[] {
  const all = posted(panel, 'filesNotShown');
  return all.length === 0 ? [] : all[all.length - 1].payload.items;
}

beforeEach(() => {
  _resetMockWorkspace();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'erd-not-shown-')));
  fs.cpSync(NATIVE, root, { recursive: true });
  warnings = [];
  vi.spyOn(vscode.window, 'showWarningMessage').mockImplementation(async (message: string) => {
    warnings.push(message);
    return undefined;
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('a clean project', () => {
  it('posts an empty list, so the strip shows nothing', async () => {
    const { panel } = await open(buildProvider(root));
    expect(posted(panel, 'filesNotShown').length).toBeGreaterThan(0);
    expect(notes(panel)).toEqual([]);
  });
});

describe('a relationships file the diagram does not import', () => {
  beforeEach(() => {
    write(SALES, read(SALES).replace(CUSTOMERS_IMPORT, ''));
  });

  it('is a note on the canvas with Add the import, on every load, and no toast', async () => {
    const { panel } = await open(buildProvider(root));
    const loaded = posted(panel, 'domainLoaded')[0];
    const edges = (loaded.payload.relationships as Array<{ fromModel: string; toModel: string }>).map((r) => `${r.fromModel}>${r.toModel}`);
    // Still not drawn: the canvas draws what core and the Confluence viewer draw.
    expect(edges).not.toContain('customer_profile>dim_region');
    expect(notes(panel)).toEqual([{
      code: 'relationshipsNotImported',
      message: 'This diagram does not import gold/relationships/customers.dbml, so a relationship in it is not drawn.',
      file: '.erd-studio/gold/relationships/customers.dbml',
      action: 'addRelationshipsImports',
    }]);
    expect(warnings.filter((w) => w.includes('customers.dbml'))).toEqual([]);
    // Not once per session: a second load says it again.
    await panel._simulateMessage({ type: 'ready' });
    await settle();
    expect(notes(panel)).toHaveLength(1);
  });

  it('Add the import writes the use line in one edit, and the note goes with the line drawn', async () => {
    const { panel } = await open(buildProvider(root));
    const before = _appliedEdits.length;
    await panel._simulateMessage({ type: 'addRelationshipsImports' });
    await settle();
    expect(_appliedEdits.length).toBe(before + 1);
    expect(read(SALES)).toContain(CUSTOMERS_IMPORT);
    // Only the import changed: the diagram is the fixture's again, byte for byte.
    expect(read(SALES)).toBe(fs.readFileSync(path.join(NATIVE, '.erd-studio', SALES), 'utf-8'));
    expect(notes(panel)).toEqual([]);
    const loaded = posted(panel, 'domainLoaded');
    const edges = (loaded[loaded.length - 1].payload.relationships as Array<{ fromModel: string; toModel: string }>).map((r) => `${r.fromModel}>${r.toModel}`);
    expect(edges).toContain('customer_profile>dim_region');
    expect(posted(panel, 'error')).toEqual([]);
  });

  it('a refresh never adds the import by itself', async () => {
    const provider = buildProvider(root);
    await open(provider);
    const before = _appliedEdits.length;
    await provider.refreshAllOpenSubjectAreas();
    await provider.reloadFromDisk();
    await settle();
    expect(_appliedEdits.length).toBe(before);
    expect(read(SALES)).not.toContain(CUSTOMERS_IMPORT);
  });

  it('refuses a payload', async () => {
    const { panel } = await open(buildProvider(root));
    await panel._simulateMessage({ type: 'addRelationshipsImports', payload: { file: 'x' } });
    expect(posted(panel, 'error').map((m) => m.payload.message)).toEqual(['Adding the import takes no payload.']);
    expect(read(SALES)).not.toContain(CUSTOMERS_IMPORT);
  });
});

describe('a relationship written in a table file', () => {
  it('is a note at its line, in short words of the canvas\'s own, and goes when the line is moved', async () => {
    const table = 'gold/tables/gold/fct_order.dbml';
    const original = read(table);
    write(table, `${original}\nRef: gold.fct_order.customer_key > gold.dim_customer.customer_key\n`);
    const provider = buildProvider(root);
    const { panel } = await open(provider);
    const line = read(table).split('\n').findIndex((l) => l.startsWith('Ref:')) + 1;
    const found = notes(panel).filter((n) => n.code === 'notDrawnInTableFile');
    expect(found).toHaveLength(1);
    expect(found[0].file).toBe('.erd-studio/gold/tables/gold/fct_order.dbml');
    expect(found[0].line).toBe(line);
    expect(found[0].message).toBe('A Ref in gold/tables/gold/fct_order.dbml is not drawn: relationships go in a relationships file. '
      + 'ERD Studio cannot edit this table until it is moved.');
    expect(found[0].action).toBeUndefined();

    write(table, original);
    await provider.refreshSubjectAreasReferencingTables(['fct_order']);
    await settle();
    expect(notes(panel)).toEqual([]);
  });

  it('says nothing about a table that is not on the diagram', async () => {
    write('gold/tables/gold/elsewhere.dbml', 'Table gold.elsewhere {\n  id INT [pk]\n  other_id INT [ref: > gold.dim_region.region_code]\n}\n');
    const { panel } = await open(buildProvider(root));
    expect(notes(panel)).toEqual([]);
  });
});

describe('a relationships file that does not read', () => {
  it('is a note at the error\'s line, and goes when the file is fixed', async () => {
    const file = 'gold/relationships/gold.dbml';
    const original = read(file);
    write(file, `${original}\nRef: gold.fct_order.customer_key >\n`);
    const provider = buildProvider(root);
    const { panel } = await open(provider);
    const found = notes(panel).filter((n) => n.code === 'relationshipsFileNotRead');
    expect(found).toHaveLength(1);
    expect(found[0].file).toBe('.erd-studio/gold/relationships/gold.dbml');
    expect(found[0].line).toBeGreaterThan(1);
    expect(found[0].message.startsWith('gold/relationships/gold.dbml has a mistake, so none of its relationships are drawn. Line ')).toBe(true);
    // The reader's own tail repeats the lead: said once.
    expect(found[0].message).not.toContain('No relationship is read');

    write(file, original);
    provider['tableLibraryService'].invalidateRelationships();
    await provider.refreshAllOpenSubjectAreas();
    await settle();
    expect(notes(panel)).toEqual([]);
  });
});

describe('a .dbml saved where ERD Studio reads no file', () => {
  it('is a note on every open canvas until it is moved, with where it belongs', async () => {
    const provider = buildProvider(root);
    const { panel } = await open(provider);
    write('gold/tables/dim_store.dbml', 'Table gold.dim_store {\n  id INT [pk]\n}\n');
    provider.noteUnreadFile(at('gold/tables/dim_store.dbml'));
    await settle();
    expect(notes(panel)).toEqual([{
      code: 'fileNotRead',
      message: 'ERD Studio does not read gold/tables/dim_store.dbml where it is. A table belongs in a schema folder: gold/tables/<schema>/dim_store.dbml.',
      file: '.erd-studio/gold/tables/dim_store.dbml',
    }]);
    // No diagram was sent again for it: the file is part of none.
    expect(posted(panel, 'domainLoaded')).toHaveLength(1);

    fs.renameSync(at('gold/tables/dim_store.dbml'), at('gold/tables/gold/dim_store.dbml'));
    provider.refreshFilesNotShown();
    await settle();
    expect(notes(panel)).toEqual([]);
  });

  it('ignores a file that is read, and one outside the ERD Studio folder', async () => {
    const provider = buildProvider(root);
    const { panel } = await open(provider);
    provider.noteUnreadFile(at('gold/tables/gold/fct_order.dbml'));
    provider.noteUnreadFile(path.join(root, 'export.dbml'));
    await settle();
    expect(notes(panel)).toEqual([]);
  });
});

describe('a diagram file that stops reading over a live canvas', () => {
  it('keeps a note for as long as it is broken, and shows the toast again on each save', async () => {
    const provider = buildProvider(root);
    const { doc, panel } = await open(provider);
    const good = doc.getText();
    const broken = good.replace("Project sales {", "Project sales {{");

    doc._setText(broken);
    await _fireDidChangeTextDocument(doc);
    await settle();
    const firstErrors = posted(panel, 'error');
    expect(firstErrors).toHaveLength(1);
    const stale = notes(panel).filter((n) => n.code === 'diagramNotRead');
    expect(stale).toHaveLength(1);
    expect(stale[0].file).toBe('.erd-studio/gold/diagrams/sales.dbml');
    expect(stale[0].message).toContain('The canvas shows the last version that read, until the file is fixed.');
    expect(stale[0].line).toBe(firstErrors[0].payload.line);

    // Saved again, still broken in the same way: the toast (which may have been dismissed) comes back.
    doc._setText(broken);
    await _fireDidChangeTextDocument(doc);
    await settle();
    expect(posted(panel, 'error')).toHaveLength(2);
    expect(posted(panel, 'error')[1].payload.message).toBe(firstErrors[0].payload.message);
    expect(notes(panel).filter((n) => n.code === 'diagramNotRead')).toHaveLength(1);

    // A refresh for another file's change does not repeat the toast (#64), and the note stays.
    await provider.refreshAllOpenSubjectAreas();
    await settle();
    expect(posted(panel, 'error')).toHaveLength(2);
    expect(notes(panel).filter((n) => n.code === 'diagramNotRead')).toHaveLength(1);

    doc._setText(good);
    await _fireDidChangeTextDocument(doc);
    await settle();
    expect(notes(panel)).toEqual([]);
    expect(posted(panel, 'domainLoaded').length).toBeGreaterThanOrEqual(2);
  });
});

describe('a redraw that failed inside ERD Studio', () => {
  it('is a note with Reload from disk until every canvas is redrawn', async () => {
    const provider = buildProvider(root);
    const { panel } = await open(provider);
    provider.noteRefreshFailed('Table');
    expect(notes(panel)).toEqual([{
      code: 'refreshFailed',
      message: 'ERD Studio could not redraw after a change to a table or relationships file. This diagram may be out of date. '
        + 'The problem is in ERD Studio, not in your files.',
      action: 'reloadFromDisk',
    }]);
    await provider.refreshAllOpenSubjectAreas();
    await settle();
    expect(notes(panel)).toEqual([]);
  });

  it('Reload from disk runs the command, which writes nothing', async () => {
    const provider = buildProvider(root);
    const { panel } = await open(provider);
    const registration = vscode.commands.registerCommand(RELOAD_FROM_DISK_COMMAND, () => provider.reloadFromDisk());
    try {
      provider.noteRefreshFailed('Layers');
      const before = _appliedEdits.length;
      await panel._simulateMessage({ type: 'reloadFromDisk' });
      await settle();
      expect(posted(panel, 'domainLoaded')).toHaveLength(2);
      expect(notes(panel)).toEqual([]);
      expect(_appliedEdits.length).toBe(before);
    } finally {
      registration.dispose();
    }
  });
});

describe('the check against the disk (a canvas that gets the focus)', () => {
  it('does nothing while the canvas shows its files', async () => {
    const provider = buildProvider(root);
    const { doc, panel } = await open(provider);
    expect(await provider.revalidateAgainstDisk(doc.uri.toString())).toBe(false);
    expect(posted(panel, 'domainLoaded')).toHaveLength(1);
  });

  it('redraws when a table file changed with no event, without writing', async () => {
    const provider = buildProvider(root);
    const { doc, panel } = await open(provider);
    const table = 'gold/tables/gold/dim_region.dbml';
    write(table, read(table).replace('  region_code VARCHAR\n', '  region_code VARCHAR\n  added_by_hand INT\n'));
    const before = _appliedEdits.length;
    expect(await provider.revalidateAgainstDisk(doc.uri.toString())).toBe(true);
    const loaded = posted(panel, 'domainLoaded');
    expect(loaded).toHaveLength(2);
    const region = (loaded[1].payload.models as Array<{ name: string; columns: Array<{ name: string }> }>).find((m) => m.name === 'dim_region')!;
    expect(region.columns.map((c) => c.name)).toContain('added_by_hand');
    expect(_appliedEdits.length).toBe(before);
    // Drawn from the new file: nothing more to do.
    expect(await provider.revalidateAgainstDisk(doc.uri.toString())).toBe(false);
  });

  it('redraws when a relationships file changed with no event', async () => {
    const provider = buildProvider(root);
    const { doc, panel } = await open(provider);
    const file = 'gold/relationships/gold.dbml';
    write(file, `${read(file)}\n// a hand edit\n`);
    expect(await provider.revalidateAgainstDisk(doc.uri.toString())).toBe(true);
    expect(posted(panel, 'domainLoaded')).toHaveLength(2);
  });

  it('redraws from the file, once, when the diagram\'s document is not following it', async () => {
    const provider = buildProvider(root);
    const { doc, panel } = await open(provider);
    // The file changed on disk and the document never heard (it was left unsaved, or the event was lost).
    write(SALES, read(SALES).replace("use { table gold.bridge_empty } from '../tables/gold/bridge_empty.dbml'\n", ''));
    const onDisk = read(SALES);
    const before = _appliedEdits.length;
    expect(await provider.revalidateAgainstDisk(doc.uri.toString())).toBe(true);
    const loaded = posted(panel, 'domainLoaded');
    expect((loaded[loaded.length - 1].payload.models as Array<{ name: string }>).map((m) => m.name)).not.toContain('bridge_empty');
    // The document is not saved over the file, and the same version is not drawn twice.
    expect(_appliedEdits.length).toBe(before);
    expect(read(SALES)).toBe(onDisk);
    expect(await provider.revalidateAgainstDisk(doc.uri.toString())).toBe(false);
    await provider.syncSubjectAreaWithDisk(at(SALES));
    expect(posted(panel, 'domainLoaded')).toHaveLength(loaded.length);
  });
});

describe('a save of the diagram\'s document that fails', () => {
  it('says the canvas shows the file on disk, until the document is saved', async () => {
    const { _failMockSave, _unfailMockSave } = await import('../__mocks__/vscode');
    const provider = buildProvider(root);
    const { doc, panel } = await open(provider);
    _failMockSave(at(SALES));
    try {
      doc._setText(`${doc.getText()}\n// typed in the text editor\n`);
      await _fireDidChangeTextDocument(doc);
      await settle();
      const unsaved = notes(panel).filter((n) => n.code === 'diagramUnsaved');
      expect(unsaved).toHaveLength(1);
      expect(unsaved[0].message).toContain('has changes that could not be saved. The canvas shows the file on disk');
    } finally {
      _unfailMockSave(at(SALES));
    }
    await _fireDidChangeTextDocument(doc);
    await settle();
    expect(notes(panel)).toEqual([]);
  });
});

describe('opening a file a note names', () => {
  it('opens a file of the project as text at its line, beside the canvas', async () => {
    const opened: unknown[][] = [];
    const registration = vscode.commands.registerCommand('vscode.openWith', (...args: unknown[]) => { opened.push(args); });
    try {
      const { panel } = await open(buildProvider(root));
      await panel._simulateMessage({ type: 'openNotedFile', payload: { file: '.erd-studio/gold/relationships/gold.dbml', line: 4 } });
      expect(opened).toHaveLength(1);
      expect((opened[0][0] as { fsPath: string }).fsPath).toBe(at('gold/relationships/gold.dbml'));
      expect(opened[0][1]).toBe('default');
      expect((opened[0][2] as { selection: { start: { line: number } } }).selection.start.line).toBe(3);
    } finally {
      registration.dispose();
    }
  });

  it('opens beside the canvas, not beside the text editor last typed in; a file already showing stays in its group', async () => {
    // Real VS Code: the click reaches the host while the text editor's group is still the active one,
    // so ViewColumn.Beside opened a new group right of it on every click.
    const opened: unknown[][] = [];
    const registration = vscode.commands.registerCommand('vscode.openWith', (...args: unknown[]) => { opened.push(args); });
    const win = vscode.window as unknown as { visibleTextEditors?: unknown[] };
    const before = win.visibleTextEditors;
    try {
      const { panel } = await open(buildProvider(root));
      (panel as unknown as { viewColumn: number }).viewColumn = 1;
      win.visibleTextEditors = [{ document: { uri: { fsPath: at('gold/relationships/customers.dbml') } }, viewColumn: 3 }];
      await panel._simulateMessage({ type: 'openNotedFile', payload: { file: '.erd-studio/gold/relationships/gold.dbml', line: 2 } });
      await panel._simulateMessage({ type: 'openNotedFile', payload: { file: '.erd-studio/gold/relationships/customers.dbml', line: 2 } });
      expect(opened.map((args) => (args[2] as { viewColumn: number }).viewColumn)).toEqual([2, 3]);
    } finally {
      win.visibleTextEditors = before;
      registration.dispose();
    }
  });

  it('opens nothing outside the ERD Studio folder, whatever the webview sends', async () => {
    const opened: unknown[][] = [];
    const registration = vscode.commands.registerCommand('vscode.openWith', (...args: unknown[]) => { opened.push(args); });
    fs.writeFileSync(path.join(root, 'secrets.env'), 'x');
    try {
      const { panel } = await open(buildProvider(root));
      await panel._simulateMessage({ type: 'openNotedFile', payload: { file: 'secrets.env' } });
      await panel._simulateMessage({ type: 'openNotedFile', payload: { file: '.erd-studio/../secrets.env' } });
      await panel._simulateMessage({ type: 'openNotedFile', payload: { file: '/etc/hosts' } });
      await panel._simulateMessage({ type: 'openNotedFile', payload: { file: '.erd-studio/gold/gone.dbml' } });
      expect(opened).toEqual([]);
      expect(posted(panel, 'error').map((m) => m.payload.message)).toEqual([
        'That file is not inside this project.',
        'That file is not inside this project.',
        'That file is not inside this project.',
        '.erd-studio/gold/gone.dbml is no longer there.',
      ]);
    } finally {
      registration.dispose();
    }
  });
});
