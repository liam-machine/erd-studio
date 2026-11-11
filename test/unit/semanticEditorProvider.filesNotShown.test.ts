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

  it('a change that reaches only the disk never adds the import: the watcher\'s redraw, the focus check, Reload Diagrams from Disk', async () => {
    const provider = buildProvider(root);
    const { doc } = await open(provider);
    const before = _appliedEdits.length;
    // The relationships file changed on disk (git, another program, an assistant): no save event in this window.
    write('gold/relationships/customers.dbml', `${read('gold/relationships/customers.dbml')}\n`);
    await provider.refreshAllOpenSubjectAreas();
    await provider.revalidateAgainstDisk(doc.uri.toString());
    await provider.reloadFromDisk();
    await provider.importsSettled();
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

/**
 * The import settle after a save in this window: the one exception to
 * "a refresh never writes". A relationships file SAVED IN THIS WINDOW that an
 * open logical canvas's diagram now needs to import gets the import added by
 * itself, through Add the import's edit; a change that reaches only the disk
 * keeps the strip's button.
 */
describe('a relationships file saved in this window', () => {
  const CUSTOMERS = 'gold/relationships/customers.dbml';
  const ADDED = 'Added gold/relationships/customers.dbml to this diagram so its relationships are drawn.';
  let fullCustomers: string;
  /** The customers file with no Ref yet: what is there before the first one is written. */
  let emptyCustomers: string;

  beforeEach(() => {
    fullCustomers = read(CUSTOMERS);
    emptyCustomers = fullCustomers.split('\n').filter((l) => !/^Ref\b/.test(l)).join('\n');
    write(SALES, read(SALES).replace(CUSTOMERS_IMPORT, ''));
    write(CUSTOMERS, emptyCustomers);
  });

  /** A provider with VS Code's save event wired to it, as `extension.ts` does. */
  function wired(): SemanticEditorProvider {
    const provider = buildProvider(root);
    vscode.workspace.onDidSaveTextDocument((d) => provider.noteDocumentSaved(d));
    return provider;
  }

  /** Type `text` into the open document of `rel` (opened if it is not) and save it in this window. */
  async function typeAndSave(provider: SemanticEditorProvider, rel: string, text: string): Promise<void> {
    const doc = createMockTextDocument(at(rel), fs.existsSync(at(rel)) ? read(rel) : '', { persist: true });
    doc._setText(text);
    fs.mkdirSync(path.dirname(at(rel)), { recursive: true });
    expect(await doc.save()).toBe(true);
    // A later mtime, so the library sees the change even in the same millisecond.
    const later = new Date(Date.now() + 5000 + Math.floor(Math.random() * 100000));
    fs.utimesSync(at(rel), later, later);
    await provider.importsSettled();
    await settle();
  }

  const edgesOf = (panel: Panel): string[] => {
    const loaded = posted(panel, 'domainLoaded');
    return (loaded[loaded.length - 1].payload.relationships as Array<{ fromModel: string; toModel: string }>).map((r) => `${r.fromModel}>${r.toModel}`);
  };
  const noticesOf = (panel: Panel): string[] => posted(panel, 'canvasNotice').map((m) => m.payload.message);

  it('the first Ref on the diagram: the import is added by itself in one edit, the line is drawn, and a short note names the file', async () => {
    const provider = wired();
    const { panel } = await open(provider);
    expect(notes(panel)).toEqual([]);
    expect(edgesOf(panel)).not.toContain('customer_profile>dim_region');
    const before = _appliedEdits.length;

    await typeAndSave(provider, CUSTOMERS, fullCustomers);

    expect(_appliedEdits.length).toBe(before + 1);
    expect(_appliedEdits[_appliedEdits.length - 1]._ops.every((op) => op.kind !== 'renameFile' && op.uri.fsPath === at(SALES))).toBe(true);
    // Only the import changed: the diagram is the fixture's again, byte for byte.
    expect(read(SALES)).toBe(fs.readFileSync(path.join(NATIVE, '.erd-studio', SALES), 'utf-8'));
    expect(edgesOf(panel)).toContain('customer_profile>dim_region');
    expect(notes(panel)).toEqual([]);
    expect(noticesOf(panel)).toEqual([ADDED]);
    expect(posted(panel, 'error')).toEqual([]);
  });

  it('a Ref in a brand-new relationships file: the same', async () => {
    fs.rmSync(at(CUSTOMERS));
    const provider = wired();
    const { panel } = await open(provider);
    await typeAndSave(provider, 'gold/relationships/stores.dbml', fullCustomers);
    expect(read(SALES)).toContain("use * from '../relationships/stores.dbml'");
    expect(edgesOf(panel)).toContain('customer_profile>dim_region');
    expect(noticesOf(panel)).toEqual(['Added gold/relationships/stores.dbml to this diagram so its relationships are drawn.']);
  });

  it('Cmd+Z on the canvas undoes the import as one step, the strip offers the button again, and it is not added again', async () => {
    const provider = wired();
    const { doc, panel } = await open(provider);
    const withoutImport = doc.getText();
    await typeAndSave(provider, CUSTOMERS, fullCustomers);
    expect(read(SALES)).toContain(CUSTOMERS_IMPORT);
    const afterAdd = _appliedEdits.length;

    // VS Code's own undo rewinds the diagram's document; the canvas saves it (that save is a diagram's, not a relationships file's).
    doc._setText(withoutImport);
    await _fireDidChangeTextDocument(doc, vscode.TextDocumentChangeReason.Undo);
    await vi.waitFor(() => expect(read(SALES)).not.toContain(CUSTOMERS_IMPORT), { timeout: 2000, interval: 10 });
    await provider.importsSettled();
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 250));
    await provider.importsSettled();
    await settle();

    expect(read(SALES)).not.toContain(CUSTOMERS_IMPORT);
    expect(_appliedEdits.length).toBe(afterAdd);
    expect(edgesOf(panel)).not.toContain('customer_profile>dim_region');
    expect(notes(panel).map((n) => [n.code, n.action])).toEqual([['relationshipsNotImported', 'addRelationshipsImports']]);
    // The watcher's redraw of the same files writes nothing either.
    await provider.refreshAllOpenSubjectAreas();
    await settle();
    expect(read(SALES)).not.toContain(CUSTOMERS_IMPORT);
    expect(_appliedEdits.length).toBe(afterAdd);
  });

  it('two open diagrams that need it each get their own edit; a closed one is not touched', async () => {
    const OTHER = 'gold/diagrams/customers.dbml';
    const CLOSED = 'gold/diagrams/profiles.dbml';
    const diagram = (name: string): string => [
      `Project ${name} {`,
      "  erd_schema_version: '7'",
      '}',
      '',
      "use { table gold.dim_customer } from '../tables/gold/dim_customer.dbml'",
      "use { table gold.customer_profile } from '../tables/gold/customer_profile.dbml'",
      "use { table gold.dim_region } from '../tables/gold/dim_region.dbml'",
      '',
    ].join('\n');
    write(OTHER, diagram('customers'));
    write(CLOSED, diagram('profiles'));
    const provider = wired();
    const sales = await open(provider);
    const other = await open(provider, OTHER);
    const before = _appliedEdits.length;

    await typeAndSave(provider, CUSTOMERS, fullCustomers);

    expect(_appliedEdits.length).toBe(before + 2);
    expect(read(SALES)).toContain(CUSTOMERS_IMPORT);
    expect(read(OTHER)).toContain(CUSTOMERS_IMPORT);
    expect(read(CLOSED)).toBe(diagram('profiles'));
    expect(noticesOf(sales.panel)).toEqual([ADDED]);
    expect(noticesOf(other.panel)).toEqual([ADDED]);
  });

  it('Save All of several relationships files settles each canvas once', async () => {
    const provider = wired();
    const { panel } = await open(provider);
    const before = _appliedEdits.length;
    const first = createMockTextDocument(at(CUSTOMERS), read(CUSTOMERS), { persist: true });
    const second = createMockTextDocument(at('gold/relationships/stores.dbml'), '', { persist: true });
    first._setText(fullCustomers.split('\n').filter((l) => !l.startsWith('Ref region')).join('\n'));
    second._setText([
      "use { table gold.customer_profile } from '../tables/gold/customer_profile.dbml'",
      "use { table gold.dim_region }       from '../tables/gold/dim_region.dbml'",
      '',
      'Ref region: gold.customer_profile.preferred_region_code <>? gold.dim_region.region_code',
      '',
    ].join('\n'));
    await Promise.all([first.save(), second.save()]);
    await provider.importsSettled();
    await settle();
    expect(_appliedEdits.length).toBe(before + 1);
    expect(read(SALES)).toContain(CUSTOMERS_IMPORT);
    expect(read(SALES)).toContain("use * from '../relationships/stores.dbml'");
    expect(noticesOf(panel)).toEqual(['Added gold/relationships/customers.dbml and gold/relationships/stores.dbml to this diagram so their relationships are drawn.']);
  });

  describe('never', () => {
    async function expectNoWrite(provider: SemanticEditorProvider, panel: Panel, text = fullCustomers): Promise<void> {
      const before = _appliedEdits.length;
      await typeAndSave(provider, CUSTOMERS, text);
      expect(_appliedEdits.length).toBe(before);
      expect(read(SALES)).not.toContain(CUSTOMERS_IMPORT);
      expect(noticesOf(panel)).toEqual([]);
      // No error toast for a convenience that did not happen.
      expect(posted(panel, 'error')).toEqual([]);
    }

    it('for a change that reaches only the disk: the strip offers the button', async () => {
      const provider = wired();
      const { panel } = await open(provider);
      write(CUSTOMERS, fullCustomers);
      await provider.refreshAllOpenSubjectAreas();
      await provider.importsSettled();
      await settle();
      expect(read(SALES)).not.toContain(CUSTOMERS_IMPORT);
      expect(notes(panel).map((n) => n.action)).toEqual(['addRelationshipsImports']);
    });

    it('when the saved relationships file does not read', async () => {
      const provider = wired();
      const { panel } = await open(provider);
      await expectNoWrite(provider, panel, `${fullCustomers}\nRef: gold.dim_customer.customer_key >`);
    });

    it('on the physical stage', async () => {
      const provider = wired();
      const { doc, panel } = await open(provider);
      (provider as unknown as { openPanels: Map<string, { activeStage: string }> }).openPanels.get(doc.uri.toString())!.activeStage = 'physical';
      await expectNoWrite(provider, panel);
    });

    it('while the diagram\'s document is unsaved or its save failed', async () => {
      const provider = wired();
      const { doc, panel } = await open(provider);
      const entry = (provider as unknown as { openPanels: Map<string, { saveFailed?: boolean }> }).openPanels.get(doc.uri.toString())!;
      entry.saveFailed = true;
      await expectNoWrite(provider, panel);
      entry.saveFailed = false;
      doc.isDirty = true;
      await expectNoWrite(provider, panel);
    });

    it('while the diagram\'s file does not read', async () => {
      const provider = wired();
      const { doc, panel } = await open(provider);
      doc._setText(doc.getText().replace('Project sales {', 'Project sales {{'));
      await _fireDidChangeTextDocument(doc);
      await settle();
      const errors = posted(panel, 'error').length;
      const before = _appliedEdits.length;
      await typeAndSave(provider, CUSTOMERS, fullCustomers);
      expect(_appliedEdits.length).toBe(before);
      expect(posted(panel, 'error')).toHaveLength(errors);
      expect(noticesOf(panel)).toEqual([]);
    });

    it('when ERD Studio must not edit the diagram (a second Project, which the button refuses too)', async () => {
      write(SALES, `${read(SALES)}\nProject again {\n  Note: 'x'\n}\n`);
      const provider = wired();
      const { panel } = await open(provider);
      await expectNoWrite(provider, panel);
    });

    it('while an edit holds the canvas: never interleaved', async () => {
      const provider = wired();
      const { doc, panel } = await open(provider);
      (provider as unknown as { pendingUpdates: Map<string, boolean> }).pendingUpdates.set(doc.uri.toString(), true);
      await expectNoWrite(provider, panel);
    });

    it('for ERD Studio\'s own save of a relationships file', async () => {
      const provider = wired();
      const { panel } = await open(provider);
      const tracker = (provider as unknown as { ownWriteTracker: OwnWriteTracker }).ownWriteTracker;
      const expectation = tracker.expectWrite([at(CUSTOMERS)]);
      try {
        await expectNoWrite(provider, panel);
      } finally {
        tracker.settleWrites(expectation);
      }
    });

    it('to remove an import: taking the Ref out and saving leaves the import (doctor reports it; the next edit of the diagram drops it)', async () => {
      const provider = wired();
      const { panel } = await open(provider);
      await typeAndSave(provider, CUSTOMERS, fullCustomers);
      expect(read(SALES)).toContain(CUSTOMERS_IMPORT);
      const before = _appliedEdits.length;
      await typeAndSave(provider, CUSTOMERS, emptyCustomers);
      expect(_appliedEdits.length).toBe(before);
      expect(read(SALES)).toContain(CUSTOMERS_IMPORT);
      expect(noticesOf(panel)).toEqual([ADDED]);
    });

    it('when the edit is refused: silently, the strip keeps the button', async () => {
      const provider = wired();
      const { panel } = await open(provider);
      vscode._mockWorkspaceState.applyEditResult = false;
      try {
        const before = _appliedEdits.length;
        await typeAndSave(provider, CUSTOMERS, fullCustomers);
        expect(_appliedEdits.length).toBe(before + 1);
      } finally {
        vscode._mockWorkspaceState.applyEditResult = true;
      }
      expect(read(SALES)).not.toContain(CUSTOMERS_IMPORT);
      expect(posted(panel, 'error')).toEqual([]);
      expect(noticesOf(panel)).toEqual([]);
      await provider.refreshAllOpenSubjectAreas();
      await settle();
      expect(notes(panel).map((n) => n.action)).toEqual(['addRelationshipsImports']);
    });
  });
});
