/**
 * Move Table… and Move Diagram to Layer… (ERD Studio 2.0, §2.8), through
 * `activate()` on a copy of `test/fixtures/dbml-native`: a table to another
 * schema folder in any layer (a new one too), several at once, from the
 * Table Library, the Explorer and the palette; a diagram to another layer;
 * every use line and Ref end following in ONE edit; and the refusals, which
 * change nothing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { activate, NO_LEGACY_ALIAS, _resetFirstRunGuardForTests } from '../../src/extension';
import { describeMoveTouches, moveDbmlTables, tableDestinationItems, validateNewSchemaName } from '../../src/commands/moveDbml';
import { compileDbmlProject, type DbmlParserModule } from '@erd-studio/core/dbml';
import * as v9 from 'dbml-parse-v9';
import * as v10 from 'dbml-parse-v10';

const REPO_ROOT = path.resolve(__dirname, '../..');
const DBML_NATIVE = path.join(REPO_ROOT, 'test', 'fixtures', 'dbml-native');
const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8')) as {
  version: string;
  contributes: { commands: Array<{ command: string; title: string }>; menus: Record<string, Array<{ command: string; when?: string }>> };
};

type Context = import('vscode').ExtensionContext;

function makeContext(root: string): Context {
  const globalState = new Map<string, unknown>([['erdStudio.gettingStartedShown', true]]);
  const workspaceState = new Map<string, unknown>([['erdStudio.harnessInstallPrompted', true], ['erdStudio.diagramsNudgeShown', true]]);
  return {
    subscriptions: [],
    extension: { packageJSON: packageJson },
    extensionUri: vscode.Uri.file(REPO_ROOT),
    globalStorageUri: vscode.Uri.file(path.join(root, '.global-storage')),
    globalState: { get: (k: string) => globalState.get(k), update: async (k: string, v: unknown) => { globalState.set(k, v); } },
    workspaceState: { get: (k: string) => workspaceState.get(k), update: async (k: string, v: unknown) => { workspaceState.set(k, v); } },
    secrets: vscode.createMockSecretStorage(),
  } as unknown as Context;
}

let root: string;
let ws: string;
let context: Context;
let errors: ReturnType<typeof vi.spyOn>;
let info: ReturnType<typeof vi.spyOn>;

const erd = (...p: string[]): string => path.join(ws, '.erd-studio', ...p);
const read = (...p: string[]): string => fs.readFileSync(erd(...p), 'utf-8');

/** Every file under the semantic dir, posix, sorted. */
function files(): string[] {
  if (!fs.existsSync(erd())) return [];
  return (fs.readdirSync(erd(), { recursive: true }) as string[])
    .filter((f) => fs.statSync(erd(f)).isFile())
    .map((f) => f.split(path.sep).join('/'))
    .sort();
}

/** Every file under the semantic dir, with its bytes. */
function bytes(): Map<string, string> {
  return new Map(files().map((f) => [f, fs.readFileSync(erd(f)).toString('base64')]));
}

/** Every `.dbml` under the semantic dir compiles from each diagram, with no diagnostic, in 9.1.1, 10.3.1 and 11.0.0. */
function compilesClean(): void {
  const texts = Object.fromEntries(files().filter((f) => f.endsWith('.dbml')).map((f) => [f, fs.readFileSync(erd(f), 'utf-8')]));
  const diagrams = Object.keys(texts).filter((f) => f.split('/')[1] === 'diagrams' && f.split('/').length === 3);
  const parsers: Array<[string, DbmlParserModule | undefined]> = [
    ['9.1.1', v9 as unknown as DbmlParserModule], ['10.3.1', v10 as unknown as DbmlParserModule], ['11.0.0', undefined],
  ];
  for (const [label, parser] of parsers) {
    expect({ parser: label, diagnostics: Object.values(compileDbmlProject(texts, diagrams, parser)).flat() }).toEqual({ parser: label, diagnostics: [] });
  }
}

/** A Table Library row for the table file at `p` (semantic-relative). */
function row(p: string): { type: 'model'; name: string; filePath: string; referencingDomains: string[] } {
  return { type: 'model', name: path.basename(p, '.dbml'), filePath: erd(...p.split('/')), referencingDomains: [] };
}

/** Answer the destination pick with the item labelled `label` (and the table pick, when asked first, with `table`). */
function pickDestination(label: string, table?: string): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (items: Array<{ label: string }>) =>
    items.find((i) => i.label === label) ?? (table !== undefined ? items.find((i) => i.label === table) : undefined)) as never);
}

/** Answer the modal question with Move. */
function answerMove(): void {
  info.mockImplementation((async (...args: unknown[]) => (args.includes('Move') ? 'Move' : undefined)) as never);
}

/** The modal Move question asked, if any. */
function moveQuestion(): { message: string; detail: string } | undefined {
  const call = info.mock.calls.find((c) => typeof c[1] === 'object' && (c[1] as { modal?: boolean })?.modal);
  return call ? { message: call[0] as string, detail: (call[1] as { detail: string }).detail } : undefined;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-move-dbml-'));
  ws = path.join(root, 'project');
  context = makeContext(root);
  vscode._resetRegisteredCommands();
  vscode._resetMockConfiguration();
  vscode._resetMockWorkspace();
  vscode._clearMockFileWatchers();
  vscode._resetMockWebviewPanels();
  vscode.workspace.workspaceFolders = [];
  vscode.window.tabGroups.all = [];
  _resetFirstRunGuardForTests();
  vi.stubEnv('HOME', root);
  vi.stubEnv('USERPROFILE', root);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
  errors = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined);
  info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
  vi.useFakeTimers();
  fs.cpSync(DBML_NATIVE, ws, { recursive: true });
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(ws), name: path.basename(ws), index: 0 }];
});

afterEach(async () => {
  for (const sub of [...context.subscriptions].reverse()) {
    try { await sub.dispose(); } catch { /* best effort */ }
  }
  for (const panel of [...vscode.window._webviewPanels]) panel.dispose();
  vscode._resetMockWebviewPanels();
  vscode.workspace.textDocuments.length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the commands are contributed', () => {
  const contributed = (id: string) => packageJson.contributes.commands.find((c) => c.command === id);
  const menu = (where: string, id: string) => (packageJson.contributes.menus[where] ?? []).filter((m) => m.command === id).map((m) => m.when);

  it('Move Table… and Move Diagram to Layer… are post-rename commands with DBML-only menus', () => {
    expect(contributed('erdStudio.moveTable')?.title).toBe('Move Table…');
    expect(contributed('erdStudio.moveDiagram')?.title).toBe('Move Diagram to Layer…');
    expect(NO_LEGACY_ALIAS.has('erdStudio.moveTable')).toBe(true);
    expect(NO_LEGACY_ALIAS.has('erdStudio.moveDiagram')).toBe(true);
    expect(menu('view/item/context', 'erdStudio.moveTable')).toEqual(['view == erdStudio.modelLibrary && viewItem == logicalModel && erdStudio.storage =~ /^(dbml|mixed)$/']);
    expect(menu('view/item/context', 'erdStudio.moveDiagram')).toEqual(['view == erdStudio.domainTree && viewItem == domain && erdStudio.storage =~ /^(dbml|mixed)$/']);
    expect(menu('explorer/context', 'erdStudio.moveTable')).toEqual(['resourceLangId == dbml-table && erdStudio.storage =~ /^(dbml|mixed)$/']);
    expect(menu('explorer/context', 'erdStudio.moveDiagram')).toEqual(['resourceLangId == dbml-diagram && erdStudio.storage =~ /^(dbml|mixed)$/']);
    expect(menu('commandPalette', 'erdStudio.moveTable')).toEqual(['erdStudio.storage =~ /^(dbml|mixed)$/']);
    expect(menu('commandPalette', 'erdStudio.moveDiagram')).toEqual(['erdStudio.storage =~ /^(dbml|mixed)$/']);
  });
});

describe('the destination pick and the new schema box', () => {
  const deps = (layers: Array<{ id: string; label: string }>, folders: Array<{ layer: string; schemas: string[] }>) => ({
    layers: () => layers,
    tableLibraryService: { listDbmlLayerFolders: () => folders } as never,
  });

  it('groups schema folders by layer, in layers.json order then other layer folders, leaves out the current folder and offers a new schema per layer', () => {
    const items = tableDestinationItems(
      deps([{ id: 'silver', label: 'Silver' }, { id: 'gold', label: 'Gold' }], [
        { layer: 'archive', schemas: ['old'] },
        { layer: 'gold', schemas: ['gold', 'sales'] },
        { layer: 'silver', schemas: ['calendar'] },
      ]),
      [{ layer: 'gold', folder: 'gold' }],
    );
    expect(items.map((i) => (i.kind === vscode.QuickPickItemKind.Separator ? `-- ${i.label}` : i.label))).toEqual([
      '-- Silver', 'Silver › calendar', '$(add) New schema in Silver…',
      '-- Gold', 'Gold › sales', '$(add) New schema in Gold…',
      '-- archive', 'archive › old', '$(add) New schema in archive…',
    ]);
    expect(items.find((i) => i.label === 'Gold › sales')?.description).toBe('gold/tables/sales/');
  });

  it('keeps a folder only some of the selected tables are in', () => {
    const items = tableDestinationItems(deps([{ id: 'gold', label: 'Gold' }], [{ layer: 'gold', schemas: ['gold', 'sales'] }]),
      [{ layer: 'gold', folder: 'gold' }, { layer: 'gold', folder: 'sales' }]);
    expect(items.map((i) => i.label)).toEqual(['Gold', 'Gold › gold', 'Gold › sales', '$(add) New schema in Gold…']);
  });

  it('leaves out an existing folder whose name cannot be a schema (a quote, {{ }}, a trailing space)', () => {
    const items = tableDestinationItems(deps([{ id: 'silver', label: 'Silver' }], [{ layer: 'silver', schemas: ["o'neil", '{{ target }}', 'trail ', 'crm'] }]),
      [{ layer: 'gold', folder: 'gold' }]);
    expect(items.map((i) => i.label)).toEqual(['Silver', 'Silver › crm', '$(add) New schema in Silver…']);
  });

  it('refuses a name that is not a folder name, or differs only in case from a folder the layer has (naming it)', () => {
    expect(validateNewSchemaName('crm', 'Silver', ['calendar'])).toBeNull();
    expect(validateNewSchemaName('calendar', 'Silver', ['calendar'])).toBeNull();
    expect(validateNewSchemaName('  ', 'Silver', [])).toBe('Enter a schema name.');
    expect(validateNewSchemaName('{{ target.schema }}', 'Silver', [])).toMatch(/cannot be a schema folder name/);
    expect(validateNewSchemaName("o'neil", 'Silver', [])).toMatch(/cannot be a schema folder name/);
    expect(validateNewSchemaName('Calendar', 'Silver', ['calendar'])).toBe('Silver already has the schema folder "calendar". Type "calendar", or pick Silver › calendar from the list.');
  });

  it('says what else changes', () => {
    expect(describeMoveTouches({ diagrams: ['a', 'b'], relationships: ['c'] }, 1)).toBe('2 diagrams and 1 relationships file that use it are updated too.');
    expect(describeMoveTouches({ diagrams: ['a'], relationships: [] }, 2)).toBe('1 diagram that uses them is updated too.');
  });
});

describe('Move Table…', () => {
  it('moves a table to a new schema folder in another layer in ONE edit, after a question naming what else changes: every use line and Ref end follows', async () => {
    await activate(context);
    pickDestination('$(add) New schema in Silver…');
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('crm');
    answerMove();
    const applyEdit = vi.spyOn(vscode.workspace, 'applyEdit');
    await vscode.commands.executeCommand('erdStudio.moveTable', row('gold/tables/gold/fct_order.dbml'));

    expect(errors).not.toHaveBeenCalled();
    expect(applyEdit).toHaveBeenCalledTimes(1);
    expect(moveQuestion()).toEqual({
      message: 'Move fct_order to Silver › crm?',
      detail: '2 diagrams and 1 relationships file that use it are updated too.\nIts file declares it as crm.fct_order from now on, and every Ref naming it is re-spelled.',
    });
    expect(fs.existsSync(erd('gold', 'tables', 'gold', 'fct_order.dbml'))).toBe(false);
    expect(read('silver', 'tables', 'crm', 'fct_order.dbml')).toMatch(/^Table crm\.fct_order \[/m);
    // Its hand-written comment travels with it.
    expect(read('silver', 'tables', 'crm', 'fct_order.dbml')).toContain('// Order lines from the shop.');
    const goldRels = read('gold', 'relationships', 'gold.dbml');
    expect(goldRels).toMatch(/^use \{ table crm\.fct_order \} +from '\.\.\/\.\.\/silver\/tables\/crm\/fct_order\.dbml'$/m);
    expect(goldRels).toContain('Ref: crm.fct_order.customer_key >? gold.dim_customer.customer_key');
    expect(goldRels).not.toMatch(/gold\.fct_order/);
    expect(read('gold', 'diagrams', 'sales.dbml')).toMatch(/^use \{ table crm\.fct_order \} +from '\.\.\/\.\.\/silver\/tables\/crm\/fct_order\.dbml'$/m);
    expect(read('silver', 'diagrams', 'staging.dbml')).toMatch(/^use \{ table crm\.fct_order \} +from '\.\.\/tables\/crm\/fct_order\.dbml'$/m);
    // The table keeps its name, and its position in the diagram.
    expect(read('gold', 'diagrams', 'sales.dbml')).toContain('    fct_order 400 200\n');
    expect(info).toHaveBeenCalledWith('Moved fct_order to silver/tables/crm.');
    compilesClean();
  });

  it('an open canvas showing the table still draws it, and its relationships, after the move', async () => {
    const register = vi.spyOn(vscode.window, 'registerCustomEditorProvider');
    await activate(context);
    const provider = register.mock.calls[0][1] as unknown as vscode.CustomTextEditorProvider;
    const sales = erd('gold', 'diagrams', 'sales.dbml');
    const document = vscode.createMockTextDocument(sales, fs.readFileSync(sales, 'utf-8'), { persist: true });
    (vscode.workspace.textDocuments as unknown[]).push(document);
    const panel = vscode.createMockWebviewPanel();
    await provider.resolveCustomTextEditor(document as never, panel as never, {} as vscode.CancellationToken);
    await panel._simulateMessage({ type: 'ready' });
    const loads = (): Array<{ models: Array<{ name: string }>; relationships: Array<{ fromModel: string; toModel: string }> }> =>
      (panel._postedMessages as Array<{ type: string; payload: never }>).filter((m) => m.type === 'domainLoaded').map((m) => m.payload);
    const edges = (load: ReturnType<typeof loads>[number]): string[] => load.relationships.map((r) => `${r.fromModel}>${r.toModel}`).sort();
    const before = loads().at(-1)!;
    expect(before.models.map((m) => m.name)).toContain('fct_order');

    pickDestination('$(add) New schema in Silver…');
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('crm');
    answerMove();
    await vscode.commands.executeCommand('erdStudio.moveTable', row('gold/tables/gold/fct_order.dbml'));
    expect(errors).not.toHaveBeenCalled();
    const after = loads().at(-1)!;
    expect(loads().length).toBeGreaterThan(1);
    expect(after.models.map((m) => m.name).sort()).toEqual(before.models.map((m) => m.name).sort());
    expect(edges(after)).toEqual(edges(before));
    expect(edges(after)).toContain('fct_order>dim_customer');
  });

  it('an open canvas redrawn half-way through the edit does not warn that the moved table is defined twice', async () => {
    const register = vi.spyOn(vscode.window, 'registerCustomEditorProvider');
    await activate(context);
    const provider = register.mock.calls[0][1] as unknown as vscode.CustomTextEditorProvider;
    const sales = erd('gold', 'diagrams', 'sales.dbml');
    const document = vscode.createMockTextDocument(sales, fs.readFileSync(sales, 'utf-8'), { persist: true });
    (vscode.workspace.textDocuments as unknown[]).push(document);
    const panel = vscode.createMockWebviewPanel();
    await provider.resolveCustomTextEditor(document as never, panel as never, {} as vscode.CancellationToken);
    await panel._simulateMessage({ type: 'ready' });
    const warn = vscode.window.showWarningMessage as unknown as ReturnType<typeof vi.spyOn>;
    warn.mockClear();

    // VS Code applies the edit in steps: the new file lands before the old one
    // is deleted, and the open diagram the edit changes redraws in between.
    const applyEdit = vscode.workspace.applyEdit.bind(vscode.workspace);
    vi.spyOn(vscode.workspace, 'applyEdit').mockImplementation(async (edit) => {
      const halfWay = erd('silver', 'tables', 'crm', 'fct_order.dbml');
      fs.mkdirSync(path.dirname(halfWay), { recursive: true });
      fs.copyFileSync(erd('gold', 'tables', 'gold', 'fct_order.dbml'), halfWay);
      await panel._simulateMessage({ type: 'ready' });
      fs.rmSync(halfWay);
      return applyEdit(edit);
    });
    pickDestination('$(add) New schema in Silver…');
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('crm');
    answerMove();
    await vscode.commands.executeCommand('erdStudio.moveTable', row('gold/tables/gold/fct_order.dbml'));

    expect(errors).not.toHaveBeenCalled();
    expect(fs.existsSync(erd('silver', 'tables', 'crm', 'fct_order.dbml'))).toBe(true);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('is defined twice'))).toEqual([]);
  });

  it('moves a table no other file uses without asking, and removes the schema folder it empties', async () => {
    fs.mkdirSync(erd('gold', 'tables', 'scratch'), { recursive: true });
    fs.writeFileSync(erd('gold', 'tables', 'scratch', 'dim_unused.dbml'), 'Table scratch.dim_unused {\n  id INT [pk]\n}\n');
    await activate(context);
    pickDestination('Silver › calendar');
    await vscode.commands.executeCommand('erdStudio.moveTable', row('gold/tables/scratch/dim_unused.dbml'));
    expect(errors).not.toHaveBeenCalled();
    expect(moveQuestion()).toBeUndefined();
    expect(read('silver', 'tables', 'calendar', 'dim_unused.dbml')).toMatch(/^Table calendar\.dim_unused \{/);
    expect(fs.existsSync(erd('gold', 'tables', 'scratch'))).toBe(false);
    expect(info).toHaveBeenCalledWith('Moved dim_unused to silver/tables/calendar.');
    compilesClean();
  });

  it('moves every selected Table Library row to the one folder, in one edit', async () => {
    await activate(context);
    pickDestination('$(add) New schema in Gold…');
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('crm');
    answerMove();
    const applyEdit = vi.spyOn(vscode.workspace, 'applyEdit');
    const customer = row('gold/tables/gold/dim_customer.dbml');
    const profile = row('gold/tables/gold/customer_profile.dbml');
    await vscode.commands.executeCommand('erdStudio.moveTable', customer, [customer, profile]);
    expect(errors).not.toHaveBeenCalled();
    expect(applyEdit).toHaveBeenCalledTimes(1);
    expect(moveQuestion()?.message).toBe('Move 2 tables to Gold › crm?');
    expect(moveQuestion()?.detail).toMatch(/that use them are updated too\.\nTheir files declare them in schema crm from now on, and every Ref naming them is re-spelled: dim_customer, customer_profile\.$/);
    expect(fs.existsSync(erd('gold', 'tables', 'crm', 'dim_customer.dbml'))).toBe(true);
    expect(fs.existsSync(erd('gold', 'tables', 'crm', 'customer_profile.dbml'))).toBe(true);
    expect(read('gold', 'relationships', 'customers.dbml')).toContain('Ref: crm.dim_customer.customer_key ?- crm.customer_profile.customer_key');
    expect(info).toHaveBeenCalledWith('Moved 2 tables to gold/tables/crm.');
    compilesClean();
  });

  it('moves the .dbml table file right-clicked in the Explorer', async () => {
    await activate(context);
    pickDestination('Gold › gold');
    answerMove();
    const uri = vscode.Uri.file(erd('silver', 'tables', 'calendar', 'dim_date.dbml'));
    await vscode.commands.executeCommand('erdStudio.moveTable', uri, [uri]);
    expect(errors).not.toHaveBeenCalled();
    expect(read('gold', 'tables', 'gold', 'dim_date.dbml')).toMatch(/^Table gold\.dim_date \[/m);
    expect(read('silver', 'relationships', 'calendar.dbml')).toContain('Ref "previous day": gold.dim_date.previous_date_key > gold.dim_date.date_key');
    compilesClean();
  });

  it('reopens a tab showing the moved table file on its new file, in the same group', async () => {
    await activate(context);
    pickDestination('$(add) New schema in Silver…');
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('crm');
    answerMove();
    const old = erd('gold', 'tables', 'gold', 'fct_order.dbml');
    const tab = { input: { uri: vscode.Uri.file(old) }, isActive: true };
    vscode.window.tabGroups.all = [{ tabs: [tab], viewColumn: 3, isActive: true } as never];
    const close = vi.fn(async () => true);
    (vscode.window.tabGroups as unknown as { close: typeof close }).close = close;
    const exec = vi.spyOn(vscode.commands, 'executeCommand');
    await vscode.commands.executeCommand('erdStudio.moveTable', vscode.Uri.file(old));
    expect(errors).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledWith([tab], true);
    expect(exec).toHaveBeenCalledWith('vscode.openWith', expect.objectContaining({ fsPath: erd('silver', 'tables', 'crm', 'fct_order.dbml') }), 'default',
      { viewColumn: 3, preserveFocus: false });
    delete (vscode.window.tabGroups as unknown as { close?: unknown }).close;
  });

  it('acts on the right-clicked row alone when the selection does not hold it', async () => {
    await activate(context);
    pickDestination('Silver › calendar');
    answerMove();
    const order = row('gold/tables/gold/fct_order.dbml');
    await vscode.commands.executeCommand('erdStudio.moveTable', order, [row('gold/tables/gold/dim_customer.dbml')]);
    expect(errors).not.toHaveBeenCalled();
    expect(fs.existsSync(erd('silver', 'tables', 'calendar', 'fct_order.dbml'))).toBe(true);
    expect(fs.existsSync(erd('gold', 'tables', 'gold', 'dim_customer.dbml'))).toBe(true);
  });

  it('Delete Table deletes every selected Table Library row, after one question naming them, in one edit', async () => {
    await activate(context);
    const warn = vi.mocked(vscode.window.showWarningMessage).mockResolvedValue('Delete' as never);
    const applyEdit = vi.spyOn(vscode.workspace, 'applyEdit');
    const region = row('gold/tables/gold/dim_region.dbml');
    const empty = row('gold/tables/gold/bridge_empty.dbml');
    await vscode.commands.executeCommand('erdStudio.deleteLogicalModel', region, [region, empty]);
    expect(errors).not.toHaveBeenCalled();
    expect(applyEdit).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/^Delete 2 tables \(dim_region, bridge_empty\)\? This removes their files, their \d+ relationships? and their places in \d+ diagrams?\.$/);
    expect(fs.existsSync(erd('gold', 'tables', 'gold', 'dim_region.dbml'))).toBe(false);
    expect(fs.existsSync(erd('gold', 'tables', 'gold', 'bridge_empty.dbml'))).toBe(false);
    compilesClean();
  });

  it('from the Command Palette asks which table first', async () => {
    await activate(context);
    const pick = pickDestination('Silver › calendar', 'bridge_empty');
    answerMove();
    await vscode.commands.executeCommand('erdStudio.moveTable');
    expect(errors).not.toHaveBeenCalled();
    expect(pick).toHaveBeenCalledTimes(2);
    const tables = (pick.mock.calls[0][0] as Array<{ label: string; description: string }>);
    expect(tables.find((t) => t.label === 'dim_date')?.description).toBe('Silver › calendar');
    expect(fs.existsSync(erd('silver', 'tables', 'calendar', 'bridge_empty.dbml'))).toBe(true);
    compilesClean();
  });

  describe('refuses, and changes nothing', () => {
    it('when the destination folder already has a file of that name, in any case', async () => {
      fs.writeFileSync(erd('silver', 'tables', 'calendar', 'FCT_ORDER.dbml'), 'Table calendar.FCT_ORDER {\n  id INT [pk]\n}\n');
      const before = bytes();
      await activate(context);
      pickDestination('Silver › calendar');
      await vscode.commands.executeCommand('erdStudio.moveTable', row('gold/tables/gold/fct_order.dbml'));
      expect(errors).toHaveBeenCalledWith('Move Table: silver/tables/calendar/ already has a file named FCT_ORDER.dbml, so "fct_order" cannot move there. Nothing was moved.');
      expect(bytes()).toEqual(before);
    });

    it('when a file it would change does not read, naming it (with Open File)', async () => {
      fs.appendFileSync(erd('gold', 'relationships', 'gold.dbml'), 'Ref: gold.fct_order.customer_key >\n');
      const before = bytes();
      await activate(context);
      pickDestination('Silver › calendar');
      answerMove();
      await vscode.commands.executeCommand('erdStudio.moveTable', row('gold/tables/gold/fct_order.dbml'));
      const modal = errors.mock.calls.find((c) => typeof c[1] === 'object')!;
      expect(modal[0]).toMatch(/^Move Table: .*gold\/relationships\/gold\.dbml.* Nothing was moved\.$/);
      expect(modal).toContain('Open File');
      expect(bytes()).toEqual(before);
    });

    it('when a file it would change has unsaved edits', async () => {
      const before = bytes();
      const staging = erd('silver', 'diagrams', 'staging.dbml');
      vscode.workspace.textDocuments.push({ uri: vscode.Uri.file(staging), isDirty: true, getText: () => fs.readFileSync(staging, 'utf-8') });
      await activate(context);
      pickDestination('Silver › calendar');
      answerMove();
      await vscode.commands.executeCommand('erdStudio.moveTable', row('gold/tables/gold/fct_order.dbml'));
      expect(errors).toHaveBeenCalledWith('Move Table: .erd-studio/silver/diagrams/staging.dbml has unsaved changes. Save or revert it, then try again. Nothing was moved.');
      expect(moveQuestion()).toBeUndefined();
      expect(bytes()).toEqual(before);
    });

    it('when VS Code rejects the edit, leaving no new schema folder behind', async () => {
      const before = bytes();
      await activate(context);
      pickDestination('$(add) New schema in Silver…');
      vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('crm');
      answerMove();
      vi.spyOn(vscode.workspace, 'applyEdit').mockResolvedValue(false);
      await vscode.commands.executeCommand('erdStudio.moveTable', row('gold/tables/gold/fct_order.dbml'));
      expect(errors).toHaveBeenCalledWith('Move Table: VS Code rejected the file moves; nothing was changed.');
      expect(fs.existsSync(erd('silver', 'tables', 'crm'))).toBe(false);
      expect(bytes()).toEqual(before);
    });

    it("to an existing folder whose name cannot be a schema (o'neil): not offered, and refused when asked for", async () => {
      fs.mkdirSync(erd('silver', 'tables', "o'neil"), { recursive: true });
      const before = bytes();
      await activate(context);
      const pick = vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue(undefined);
      await vscode.commands.executeCommand('erdStudio.moveTable', row('gold/tables/gold/fct_order.dbml'));
      expect((pick.mock.calls[0][0] as Array<{ label: string }>).map((i) => i.label)).not.toContain("Silver › o'neil");
      const moved = await moveDbmlTables({} as never, [{ name: 'fct_order', layer: 'gold', folder: 'gold', filePath: erd('gold', 'tables', 'gold', 'fct_order.dbml') } as never], { layer: 'silver', schema: "o'neil" });
      expect(moved).toBe(false);
      expect(errors).toHaveBeenCalledWith(expect.stringMatching(/^Move Table: "o'neil" cannot be a schema folder name, so no table can move to silver\/tables\/o'neil\/\. .* Nothing was moved\.$/));
      expect(bytes()).toEqual(before);
    });

    it('for a YAML table, and for an ignored duplicate', async () => {
      fs.mkdirSync(erd('logical-models'), { recursive: true });
      fs.writeFileSync(erd('logical-models', 'dim_yaml.yml'), 'name: dim_yaml\ncolumns: []\n');
      fs.mkdirSync(erd('silver', 'tables', 'silver'), { recursive: true });
      fs.writeFileSync(erd('silver', 'tables', 'silver', 'dim_customer.dbml'), 'Table silver.dim_customer {\n  customer_key INT [pk]\n}\n');
      const before = bytes();
      await activate(context);
      const pick = pickDestination('Silver › calendar');
      await vscode.commands.executeCommand('erdStudio.moveTable', { type: 'model', name: 'dim_yaml', filePath: erd('logical-models', 'dim_yaml.yml'), referencingDomains: [] });
      expect(errors).toHaveBeenLastCalledWith('Move Table: "dim_yaml" is a YAML table: Move Table moves DBML tables. Organise Table Library by Layer moves YAML table files. Nothing was moved.');
      await vscode.commands.executeCommand('erdStudio.moveTable', vscode.Uri.file(erd('silver', 'tables', 'silver', 'dim_customer.dbml')));
      expect(errors).toHaveBeenLastCalledWith(expect.stringMatching(/^Move Table: \.erd-studio\/silver\/tables\/silver\/dim_customer\.dbml is a duplicate of "dim_customer" that diagrams ignore\./));
      expect(pick).not.toHaveBeenCalled();
      expect(bytes()).toEqual(before);
    });
  });
});

describe('Move Diagram to Layer…', () => {
  const salesPath = (): string => erd('gold', 'diagrams', 'sales.dbml');

  it('moves a diagram to another layer, re-deriving every use line from its new folder, in one edit', async () => {
    const before = read('gold', 'diagrams', 'sales.dbml');
    await activate(context);
    const pick = vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (items: Array<{ label: string }>) => items.find((i) => i.label === 'Silver')) as never);
    const applyEdit = vi.spyOn(vscode.workspace, 'applyEdit');
    await vscode.commands.executeCommand('erdStudio.moveDiagram', {
      type: 'domain', summary: { domain: 'sales', layer: 'gold', filePath: salesPath(), storage: 'dbml' },
    });
    expect(errors).not.toHaveBeenCalled();
    expect(applyEdit).toHaveBeenCalledTimes(1);
    // The current layer is not offered.
    expect((pick.mock.calls[0][0] as Array<{ label: string }>).map((i) => i.label)).toEqual(['Silver']);
    expect(fs.existsSync(salesPath())).toBe(false);
    const moved = read('silver', 'diagrams', 'sales.dbml');
    expect(moved).toMatch(/^use \{ table gold\.fct_order \} +from '\.\.\/\.\.\/gold\/tables\/gold\/fct_order\.dbml'$/m);
    expect(moved).toMatch(/^use \{ table calendar\.dim_date \} +from '\.\.\/tables\/calendar\/dim_date\.dbml'$/m);
    expect(moved).toMatch(/^use \* from '\.\.\/relationships\/calendar\.dbml'$/m);
    // Its name, positions and notes go with it.
    expect(moved).toContain('Project sales {');
    expect(moved).toContain('    fct_order 400 200\n');
    expect(moved.split('\n').filter((l) => !l.startsWith('use ')).join('\n').replace(/\s+/g, ' '))
      .toBe(before.split('\n').filter((l) => !l.startsWith('use ')).join('\n').replace(/\s+/g, ' '));
    expect(info).toHaveBeenCalledWith('Moved sales to silver/diagrams.');
    compilesClean();
  });

  it('closes the canvas showing it and reopens the moved file in the same editor and group', async () => {
    await activate(context);
    vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (items: Array<{ label: string }>) => items.find((i) => i.label === 'Silver')) as never);
    const tab = { input: new vscode.TabInputCustom(vscode.Uri.file(salesPath()), 'erdStudio.domainEditor'), isActive: true };
    vscode.window.tabGroups.all = [{ tabs: [tab], viewColumn: 2, isActive: true } as never];
    const close = vi.fn(async () => true);
    (vscode.window.tabGroups as unknown as { close: typeof close }).close = close;
    const exec = vi.spyOn(vscode.commands, 'executeCommand');
    await vscode.commands.executeCommand('erdStudio.moveDiagram', vscode.Uri.file(salesPath()));
    expect(errors).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledWith([tab], true);
    // In the group (side column) it was in, with the focus it had.
    expect(exec).toHaveBeenCalledWith('vscode.openWith', expect.objectContaining({ fsPath: erd('silver', 'diagrams', 'sales.dbml') }), 'erdStudio.domainEditor',
      { viewColumn: 2, preserveFocus: false });
    delete (vscode.window.tabGroups as unknown as { close?: unknown }).close;
  });

  it('makes <layer>/diagrams/ for a layers.json layer with no folder yet; from the palette it asks which diagram first', async () => {
    const config = JSON.parse(read('layers.json')) as { layers: unknown[] };
    config.layers.push({ id: 'platinum', label: 'Platinum', abbreviation: 'PLT', color: '#e5e4e2', creatable: true, order: 3 });
    fs.writeFileSync(erd('layers.json'), JSON.stringify(config, null, 2));
    await activate(context);
    const pick = vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (items: Array<{ label: string }>) =>
      items.find((i) => i.label === 'staging') ?? items.find((i) => i.label === 'Platinum')) as never);
    await vscode.commands.executeCommand('erdStudio.moveDiagram');
    expect(errors).not.toHaveBeenCalled();
    expect(pick).toHaveBeenCalledTimes(2);
    expect((pick.mock.calls[1][0] as Array<{ label: string }>).map((i) => i.label)).toEqual(['Gold', 'Platinum']);
    expect((pick.mock.calls[1][0] as Array<{ detail?: string }>).every((i) => i.detail === undefined)).toBe(true);
    expect(read('platinum', 'diagrams', 'staging.dbml')).toMatch(/^use \* from '\.\.\/\.\.\/silver\/relationships\/calendar\.dbml'$/m);
    expect(fs.existsSync(erd('silver', 'diagrams', 'staging.dbml'))).toBe(false);
    compilesClean();
  });

  it('leaves no folder behind when VS Code rejects the edit, and reopens the diagram where it was', async () => {
    const config = JSON.parse(read('layers.json')) as { layers: unknown[] };
    config.layers.push({ id: 'platinum', label: 'Platinum', abbreviation: 'PLT', color: '#e5e4e2', creatable: true, order: 3 });
    fs.writeFileSync(erd('layers.json'), JSON.stringify(config, null, 2));
    const before = bytes();
    await activate(context);
    vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (items: Array<{ label: string }>) => items.find((i) => i.label === 'Platinum')) as never);
    vi.spyOn(vscode.workspace, 'applyEdit').mockResolvedValue(false);
    const tab = { input: { uri: vscode.Uri.file(salesPath()) } };
    vscode.window.tabGroups.all = [{ tabs: [tab], viewColumn: 1 } as never];
    (vscode.window.tabGroups as unknown as { close: unknown }).close = vi.fn(async () => true);
    const exec = vi.spyOn(vscode.commands, 'executeCommand');
    await vscode.commands.executeCommand('erdStudio.moveDiagram', vscode.Uri.file(salesPath()));
    expect(errors).toHaveBeenCalledWith('Move Diagram to Layer: VS Code rejected the move; nothing was changed.');
    expect(fs.existsSync(erd('platinum'))).toBe(false);
    expect(bytes()).toEqual(before);
    expect(exec).toHaveBeenCalledWith('vscode.openWith', expect.objectContaining({ fsPath: salesPath() }), 'default', { viewColumn: 1, preserveFocus: true });
    delete (vscode.window.tabGroups as unknown as { close?: unknown }).close;
  });

  it('offers a layer folder layers.json does not list, saying its diagrams do not open until it is added', async () => {
    fs.mkdirSync(erd('archive', 'tables', 'old'), { recursive: true });
    await activate(context);
    const pick = vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue(undefined);
    await vscode.commands.executeCommand('erdStudio.moveDiagram', vscode.Uri.file(salesPath()));
    expect(pick.mock.calls[0][0]).toEqual([
      { label: 'Silver', description: 'silver/diagrams/', layer: 'silver' },
      { label: 'archive', description: 'archive/diagrams/', detail: 'Not in layers.json: add this layer to open its diagrams.', layer: 'archive' },
    ]);
    expect(fs.existsSync(salesPath())).toBe(true);
  });

  it('refuses a name the destination layer has, in any case and either format, and changes nothing', async () => {
    fs.writeFileSync(erd('silver', 'diagrams', 'SALES.dbml'), 'Project SALES {\n  erd_schema_version: \'7\'\n}\n');
    const before = bytes();
    await activate(context);
    vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (items: Array<{ label: string }>) => items.find((i) => i.label === 'Silver')) as never);
    await vscode.commands.executeCommand('erdStudio.moveDiagram', vscode.Uri.file(salesPath()));
    expect(errors).toHaveBeenCalledWith('Move Diagram to Layer: A diagram named "sales" already exists in the Silver layer. Rename one of them first. Nothing was moved.', 'Open It');
    expect(bytes()).toEqual(before);

    fs.rmSync(erd('silver', 'diagrams', 'SALES.dbml'));
    fs.writeFileSync(erd('silver', 'Sales.json'), '{"schemaVersion":5,"domain":"Sales","layer":"silver","logical":{"models":[]}}\n');
    const again = bytes();
    await vscode.commands.executeCommand('erdStudio.moveDiagram', vscode.Uri.file(salesPath()));
    expect(errors).toHaveBeenCalledTimes(2);
    expect(bytes()).toEqual(again);
  });

  it('refuses a JSON diagram, saying it moves DBML diagrams', async () => {
    fs.writeFileSync(erd('gold', 'old.json'), '{"schemaVersion":5,"domain":"old","layer":"gold","logical":{"models":[]}}\n');
    await activate(context);
    await vscode.commands.executeCommand('erdStudio.moveDiagram', {
      type: 'domain', summary: { domain: 'old', layer: 'gold', filePath: erd('gold', 'old.json'), storage: 'json' },
    });
    expect(errors).toHaveBeenCalledWith(expect.stringMatching(/^Move Diagram to Layer: "old\.json" is a JSON diagram: Move Diagram to Layer moves DBML diagrams/));
    expect(fs.existsSync(erd('gold', 'old.json'))).toBe(true);
  });
});

describe('in a YAML/JSON project', () => {
  it('neither command finds anything to move, and nothing is written', async () => {
    fs.rmSync(erd(), { recursive: true });
    fs.mkdirSync(erd('logical-models'), { recursive: true });
    fs.mkdirSync(erd('gold'), { recursive: true });
    fs.writeFileSync(erd('logical-models', 'dim_a.yml'), 'name: dim_a\ncolumns: []\n');
    fs.writeFileSync(erd('gold', 'a.json'), '{"schemaVersion":5,"domain":"a","layer":"gold","logical":{"models":["dim_a"]}}\n');
    const before = bytes();
    await activate(context);
    const pick = vi.spyOn(vscode.window, 'showQuickPick');
    await vscode.commands.executeCommand('erdStudio.moveTable');
    await vscode.commands.executeCommand('erdStudio.moveDiagram');
    expect(info).toHaveBeenCalledWith('There are no DBML tables to move.');
    expect(info).toHaveBeenCalledWith('There are no DBML diagrams to move.');
    expect(pick).not.toHaveBeenCalled();
    expect(bytes()).toEqual(before);
  });
});
