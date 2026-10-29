/**
 * Native DBML storage, S6 (§5.7, §9.6 "Lifecycle"): the lifecycle commands
 * through `activate()` on a copy of `test/fixtures/dbml-native` — New
 * Diagram, Rename and Delete Subject Area, Set Up, Delete Table (the D16
 * cascade), Organise Table Library and Give Duplicate Its Own Name — and in
 * a new, empty folder.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { activate, _resetFirstRunGuardForTests } from '../../src/extension';
import { compileDbmlProject, parseSubjectAreaDbml, type DbmlParserModule } from '@erd-studio/core/dbml';
import * as v9 from 'dbml-parse-v9';
import * as v10 from 'dbml-parse-v10';
import { formatWrittenDbml } from '../../src/services/dbmlWriters';

/** The expected text in the canonical layout ERD Studio writes every .dbml in (every write is formatted). */
function canonical(text: string): string {
  return formatWrittenDbml(text, 'expected.dbml');
}

const REPO_ROOT = path.resolve(__dirname, '../..');
const DBML_NATIVE = path.join(REPO_ROOT, 'test', 'fixtures', 'dbml-native');
const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8')) as { version: string };

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
let warn: ReturnType<typeof vi.spyOn>;

const erd = (...p: string[]): string => path.join(ws, '.erd-studio', ...p);

/** Every file under the semantic dir, posix, sorted. */
function files(): string[] {
  if (!fs.existsSync(erd())) return [];
  return (fs.readdirSync(erd(), { recursive: true }) as string[])
    .filter((f) => fs.statSync(erd(f)).isFile())
    .map((f) => f.split(path.sep).join('/'))
    .sort();
}

/** Every `.dbml` under the semantic dir compiles from each diagram, with no diagnostic, in 9.1.1, 10.3.1 and 11.0.0. */
function compilesClean(): void {
  const texts = Object.fromEntries(files().filter((f) => f.endsWith('.dbml')).map((f) => [f, fs.readFileSync(erd(f), 'utf-8')]));
  const diagrams = Object.keys(texts).filter((f) => !f.startsWith('tables/'));
  const parsers: Array<[string, DbmlParserModule | undefined]> = [
    ['9.1.1', v9 as unknown as DbmlParserModule], ['10.3.1', v10 as unknown as DbmlParserModule], ['11.0.0', undefined],
  ];
  for (const [label, parser] of parsers) {
    expect({ parser: label, diagnostics: Object.values(compileDbmlProject(texts, diagrams, parser)).flat() }).toEqual({ parser: label, diagnostics: [] });
  }
}

/** Every file under the semantic dir, with its bytes. */
function bytes(): Map<string, string> {
  return new Map(files().map((f) => [f, fs.readFileSync(erd(f)).toString('base64')]));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-lifecycle-activate-'));
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
  warn = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
  errors = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined);
  vi.useFakeTimers();
});

afterEach(async () => {
  for (const sub of [...context.subscriptions].reverse()) {
    try { await sub.dispose(); } catch { /* best effort */ }
  }
  for (const panel of [...vscode.window._webviewPanels]) panel.dispose();
  vscode._resetMockWebviewPanels();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

function openWorkspace(): void {
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(ws), name: path.basename(ws), index: 0 }];
}

describe('in a new, empty folder (§9.7 check 5, automated)', () => {
  beforeEach(() => {
    fs.mkdirSync(ws, { recursive: true });
    openWorkspace();
  });

  it('New Diagram writes .dbml and layers.json, and the first table goes to tables/<layer>/x.dbml', async () => {
    await activate(context);
    vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (items: Array<{ value: string }>) => items.find((i) => i.value === 'gold')) as never);
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValueOnce('orders').mockResolvedValueOnce('Orders');
    await vscode.commands.executeCommand('erdStudio.createDomain');
    expect(files()).toEqual(['gold/orders.dbml', 'layers.json']);
    const text = fs.readFileSync(erd('gold', 'orders.dbml'), 'utf-8');
    expect(parseSubjectAreaDbml(text, 'gold/orders.dbml', null).obj).toMatchObject({ domain: 'orders', description: 'Orders', logical: { models: [] } });
  });

  /** Import DBML's file dialog and reads, from disk. */
  function importFrom(dbml: string): void {
    vi.spyOn(vscode.window, 'showOpenDialog').mockResolvedValue([vscode.Uri.file(dbml)] as never);
    vi.spyOn(vscode.workspace.fs, 'readFile').mockImplementation((async (uri: vscode.Uri) => fs.readFileSync(uri.fsPath)) as never);
    vi.spyOn(vscode.workspace.fs, 'stat').mockImplementation((async (uri: vscode.Uri) => {
      if (!fs.existsSync(uri.fsPath)) throw new Error('FileNotFound');
      return { type: 1, ctime: 0, mtime: 0, size: 0 };
    }) as never);
    vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (items: Array<{ id?: string }>) => items.find((i) => i.id === 'gold')) as never);
    vi.spyOn(vscode.window, 'showInputBox').mockImplementation((async (o?: { value?: string }) => o?.value) as never);
    vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async (...args: unknown[]) =>
      (typeof args[1] === 'object' && (args[1] as { modal?: boolean }).modal ? 'Import' : undefined)) as never);
  }

  it('Import DBML writes the source .dbdiagram positions into the new diagram\'s layout file', async () => {
    const inbox = path.join(root, 'inbox');
    fs.mkdirSync(inbox);
    fs.writeFileSync(path.join(inbox, 'shop.dbml'), 'Table customers {\n  id int [pk]\n}\nTable orders {\n  id int [pk]\n  customer_id int [ref: > customers.id]\n}\n');
    fs.writeFileSync(path.join(inbox, 'shop.dbdiagram'), JSON.stringify({
      version: 1, defaultView: { tablePositions: [{ name: 'customers', schemaName: 'public', x: 40, y: 60 }, { name: 'orders', schemaName: 'public', x: 400, y: 60 }] },
    }));
    await activate(context);
    importFrom(path.join(inbox, 'shop.dbml'));
    await vscode.commands.executeCommand('erdStudio.importDbml');
    expect(files()).toEqual([
      'gold/shop.dbdiagram', 'gold/shop.dbml', 'layers.json',
      'tables/gold/_relationships.dbml', 'tables/gold/customers.dbml', 'tables/gold/orders.dbml',
    ]);
    const layout = JSON.parse(fs.readFileSync(erd('gold', 'shop.dbdiagram'), 'utf-8')) as { defaultView: { tablePositions: Array<{ name: string; x: number; y: number }> } };
    expect(layout.defaultView.tablePositions.map((p) => [p.name, p.x, p.y])).toEqual([['customers', 40, 60], ['orders', 400, 60]]);
    compilesClean();
  });

  it('Import DBML\'s preview names the relationships file and the layout file; with no source layout the import writes no .dbdiagram', async () => {
    const inbox = path.join(root, 'inbox');
    fs.mkdirSync(inbox);
    fs.writeFileSync(path.join(inbox, 'shop.dbml'), 'Table customers {\n  id int [pk]\n}\nTable orders {\n  id int [pk]\n  customer_id int [ref: > customers.id]\n}\n');
    await activate(context);
    importFrom(path.join(inbox, 'shop.dbml'));
    await vscode.commands.executeCommand('erdStudio.importDbml');
    const modal = (vscode.window.showInformationMessage as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .find((c) => typeof c[1] === 'object' && (c[1] as { modal?: boolean }).modal)!;
    const detail = (modal[1] as { detail: string }).detail;
    expect(detail).toContain('• 1 relationship saved in tables/gold/_relationships.dbml.');
    expect(detail).not.toContain('the tables\' files');
    expect(detail).toContain('• No layout file: the diagram is laid out automatically when it opens, and that layout is saved in shop.dbdiagram.');
    // The import itself writes no layout file: the first open's auto layout does, as a JSON diagram's first open writes its positions.
    expect(files()).toEqual([
      'gold/shop.dbml', 'layers.json',
      'tables/gold/_relationships.dbml', 'tables/gold/customers.dbml', 'tables/gold/orders.dbml',
    ]);
  });

  it('Import DBML refuses a file with use lines, naming the export route, and writes nothing', async () => {
    const inbox = path.join(root, 'inbox');
    fs.mkdirSync(inbox);
    fs.writeFileSync(path.join(inbox, 'part.dbml'), "use { table a } from './a.dbml'\nTable b {\n  id int\n}\n");
    await activate(context);
    importFrom(path.join(inbox, 'part.dbml'));
    await vscode.commands.executeCommand('erdStudio.importDbml');
    expect(errors).toHaveBeenCalledWith(expect.stringMatching(/^Import DBML: This DBML file imports other files \(use lines\)/), expect.anything());
    expect(files()).toEqual([]);
  });

  it('a dbdiagram single-file .dbml dropped into a layer folder is imported from its own URI (the banner\'s Import, §9.7 check 7)', async () => {
    fs.mkdirSync(erd('gold'), { recursive: true });
    const dropped = erd('gold', 'pulled.dbml');
    fs.writeFileSync(dropped, 'Project pulled {\n  database_type: \'PostgreSQL\'\n}\nTable customers {\n  id int [pk]\n}\nTable orders {\n  id int [pk]\n  customer_id int [ref: > customers.id]\n}\n');
    await activate(context);
    importFrom(dropped);
    await vscode.commands.executeCommand('erdStudio.importDbml', vscode.Uri.file(dropped));
    expect(errors).not.toHaveBeenCalled();
    // The dropped file is left as it is; the import is a new DBML diagram beside it, with its tables in the library.
    const created = files().filter((f) => f.startsWith('gold/') && f.endsWith('.dbml') && f !== 'gold/pulled.dbml');
    expect(created).toHaveLength(1);
    expect(files()).toEqual(expect.arrayContaining(['tables/gold/customers.dbml', 'tables/gold/orders.dbml', 'tables/gold/_relationships.dbml']));
    const text = fs.readFileSync(erd(created[0]), 'utf-8');
    expect(parseSubjectAreaDbml(text, created[0], null).obj).toMatchObject({ logical: { models: ['customers', 'orders'] } });
  });

  it('Set Up writes layers.json and makes no table library folder', async () => {
    await activate(context);
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue(undefined);
    const run = vscode.commands.executeCommand('erdStudio.setupSemanticDirectory');
    await vi.advanceTimersByTimeAsync(200);
    await run;
    expect(fs.existsSync(erd('layers.json'))).toBe(true);
    expect(fs.existsSync(erd('logical-models'))).toBe(false);
    expect(fs.existsSync(erd('tables'))).toBe(false);
  });
});

describe('in a native DBML project', () => {
  beforeEach(() => {
    fs.cpSync(DBML_NATIVE, ws, { recursive: true });
    openWorkspace();
  });

  it('New Diagram writes a .dbml (no layout file) and writes a missing layers.json; a name taken in either format is refused', async () => {
    fs.rmSync(erd('layers.json'));
    await activate(context);
    vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (items: Array<{ value: string }>) => items.find((i) => i.value === 'gold')) as never);
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValueOnce('returns').mockResolvedValueOnce('');
    await vscode.commands.executeCommand('erdStudio.createDomain');
    expect(fs.existsSync(erd('gold', 'returns.dbml'))).toBe(true);
    expect(fs.existsSync(erd('gold', 'returns.dbdiagram'))).toBe(false);
    expect(fs.existsSync(erd('layers.json'))).toBe(true);
    expect(fs.existsSync(erd('gold', 'returns.json'))).toBe(false);

    // A JSON file of the same name (an older teammate's) blocks the name.
    fs.writeFileSync(erd('gold', 'refunds.json'), '{"schemaVersion":5,"domain":"refunds","layer":"gold","logical":{"models":[]}}\n');
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValueOnce('refunds').mockResolvedValueOnce('');
    await vscode.commands.executeCommand('erdStudio.createDomain');
    expect(fs.existsSync(erd('gold', 'refunds.dbml'))).toBe(false);
  });

  it('Rename Subject Area renames the .dbml and its .dbdiagram in one edit, splicing only the Project name', async () => {
    await activate(context);
    const before = fs.readFileSync(erd('gold', 'sales.dbml'), 'utf-8');
    const layout = fs.readFileSync(erd('gold', 'sales.dbdiagram'), 'utf-8');
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValueOnce('revenue');
    const exec = vi.spyOn(vscode.commands, 'executeCommand');
    await vscode.commands.executeCommand('erdStudio.renameDomain', {
      type: 'domain', summary: { domain: 'sales', layer: 'gold', filePath: erd('gold', 'sales.dbml'), storage: 'dbml' },
    });
    expect(errors).not.toHaveBeenCalled();
    expect(fs.existsSync(erd('gold', 'sales.dbml'))).toBe(false);
    expect(fs.existsSync(erd('gold', 'sales.dbdiagram'))).toBe(false);
    // The Project name spliced, then the file in the canonical layout (every DBML write is formatted).
    expect(fs.readFileSync(erd('gold', 'revenue.dbml'), 'utf-8')).toBe(canonical(before.replace('Project sales {', 'Project revenue {')));
    expect(fs.readFileSync(erd('gold', 'revenue.dbdiagram'), 'utf-8')).toBe(layout);
    expect(exec).toHaveBeenCalledWith('vscode.openWith', expect.objectContaining({ fsPath: erd('gold', 'revenue.dbml') }), expect.any(String));
    compilesClean();
  });

  it('Rename Subject Area refuses, by name, when the layout file has unsaved edits, and writes nothing', async () => {
    await activate(context);
    const before = bytes();
    const layoutDoc = await vscode.workspace.openTextDocument(vscode.Uri.file(erd('gold', 'sales.dbdiagram')));
    (layoutDoc as unknown as { _setText(t: string): void })._setText(`${layoutDoc.getText()} `);
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValueOnce('revenue');
    await vscode.commands.executeCommand('erdStudio.renameDomain', {
      type: 'domain', summary: { domain: 'sales', layer: 'gold', filePath: erd('gold', 'sales.dbml'), storage: 'dbml' },
    });
    // #229's words and title (Rename Diagram), with Show File.
    expect(errors).toHaveBeenCalledWith('Rename Diagram: .erd-studio/gold/sales.dbdiagram has unsaved changes. Save or revert it, then try again. Nothing was changed.', 'Show File');
    expect(bytes()).toEqual(before);
  });

  it('Rename Subject Area: when VS Code rejects the edit and the reconcile cannot put a file back, only the modal speaks', async () => {
    await activate(context);
    // The first edit lands its first step (the new diagram) and fails; the reconcile is rejected too.
    vscode._mockWorkspaceState.applyEditPrefixes.push(1, 0);
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValueOnce('revenue');
    await vscode.commands.executeCommand('erdStudio.renameDomain', {
      type: 'domain', summary: { domain: 'sales', layer: 'gold', filePath: erd('gold', 'sales.dbml'), storage: 'dbml' },
    });
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalledWith(expect.stringMatching(/could not put back .*Restore these from source control\.$/), { modal: true });
  });

  it('Delete Subject Area deletes the .dbml and its .dbdiagram, each recorded as an own delete', async () => {
    await activate(context);
    warn.mockResolvedValue('Delete' as never);
    const del = vi.spyOn(vscode.workspace.fs, 'delete').mockResolvedValue(undefined as never);
    const { ownWrites } = await import('../../src/services/ownWriteTracker');
    const recorded = vi.spyOn(ownWrites, 'recordDelete');
    await vscode.commands.executeCommand('erdStudio.deleteDomain', {
      type: 'domain', summary: { domain: 'sales', layer: 'gold', filePath: erd('gold', 'sales.dbml'), storage: 'dbml' },
    });
    expect(del.mock.calls.map((c) => (c[0] as { fsPath: string }).fsPath)).toEqual([erd('gold', 'sales.dbml'), erd('gold', 'sales.dbdiagram')]);
    expect(recorded.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining([erd('gold', 'sales.dbml'), erd('gold', 'sales.dbdiagram')]));
  });

  describe('the diagram commands\' failures (#229) on a .dbml diagram and its .dbdiagram', () => {
    const sales = () => ({ type: 'domain', summary: { domain: 'sales', layer: 'gold', filePath: erd('gold', 'sales.dbml'), storage: 'dbml' } });
    const toasts = () => errors.mock.calls.map((call: unknown[]) => ({
      message: String(call[0]), buttons: call.slice(1).filter((a): a is string => typeof a === 'string'),
    }));
    const settle = async (): Promise<void> => { for (let i = 0; i < 50; i++) await Promise.resolve(); };

    it('New Diagram: a JSON diagram of that name says the name is taken, with Open It on that file', async () => {
      fs.writeFileSync(erd('gold', 'refunds.json'), '{"schemaVersion":5,"domain":"refunds","layer":"gold","logical":{"models":[]}}\n');
      await activate(context);
      vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (items: Array<{ value: string }>) => items.find((i) => i.value === 'gold')) as never);
      vi.spyOn(vscode.window, 'showInputBox').mockResolvedValueOnce('refunds').mockResolvedValueOnce('');
      const exec = vi.spyOn(vscode.commands, 'executeCommand');
      errors.mockResolvedValueOnce('Open It' as never);
      await vscode.commands.executeCommand('erdStudio.createDomain');
      await settle();
      expect(toasts()).toEqual([{ message: 'A diagram named "refunds" already exists in the Gold layer.', buttons: ['Open It', 'Choose Another Name'] }]);
      expect(fs.existsSync(erd('gold', 'refunds.dbml'))).toBe(false);
      expect(exec.mock.calls.some((c) => c[0] === 'vscode.openWith' && (c[1] as vscode.Uri).fsPath === erd('gold', 'refunds.json'))).toBe(true);
    });

    it('Delete: a .dbml that cannot be deleted keeps its layout file, with Show File and Try Again', async () => {
      await activate(context);
      warn.mockResolvedValue('Delete' as never);
      const before = bytes();
      vi.spyOn(vscode.workspace.fs, 'delete').mockRejectedValue(Object.assign(new Error('EACCES: permission denied'), { code: 'NoPermissions' }));
      await vscode.commands.executeCommand('erdStudio.deleteDomain', sales());
      expect(toasts()).toEqual([{
        message: "\"sales\" couldn't be deleted: another program may have it open, or ERD Studio isn't allowed to change that folder. Nothing was deleted.",
        buttons: ['Show File', 'Try Again'],
      }]);
      expect(bytes()).toEqual(before);
    });

    it('Delete: a layout file that cannot be deleted is said, and Try Again deletes only it', async () => {
      await activate(context);
      warn.mockResolvedValue('Delete' as never);
      let refuseLayout = true;
      const del = vi.spyOn(vscode.workspace.fs, 'delete').mockImplementation((async (uri: vscode.Uri) => {
        if (uri.fsPath.endsWith('.dbdiagram') && refuseLayout) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
        fs.rmSync(uri.fsPath);
      }) as never);
      errors.mockImplementationOnce((async () => { refuseLayout = false; return 'Try Again'; }) as never);
      await vscode.commands.executeCommand('erdStudio.deleteDomain', sales());
      await settle();
      expect(toasts()).toEqual([{
        message: '"sales" was deleted, but its layout file .erd-studio/gold/sales.dbdiagram couldn\'t be: another program may have it open, ' +
          "or ERD Studio isn't allowed to change that folder. Delete it yourself, or try again.",
        buttons: ['Show File', 'Try Again'],
      }]);
      expect(fs.existsSync(erd('gold', 'sales.dbml'))).toBe(false);
      expect(fs.existsSync(erd('gold', 'sales.dbdiagram'))).toBe(false);
      // The diagram once, the layout twice (refused, then Try Again): the confirmation asked once.
      expect(del.mock.calls.map((c) => path.basename((c[0] as vscode.Uri).fsPath))).toEqual(['sales.dbml', 'sales.dbdiagram', 'sales.dbdiagram']);
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it('Rename: a JSON diagram with the new name says the name is taken, before anything changes', async () => {
      fs.writeFileSync(erd('gold', 'revenue.json'), 'not json');
      await activate(context);
      const before = bytes();
      vi.spyOn(vscode.window, 'showInputBox').mockResolvedValueOnce('revenue');
      const apply = vi.spyOn(vscode.workspace, 'applyEdit');
      await vscode.commands.executeCommand('erdStudio.renameDomain', sales());
      expect(toasts()).toEqual([{ message: 'A diagram named "revenue" already exists in the Gold layer.', buttons: ['Open It'] }]);
      expect(apply).not.toHaveBeenCalled();
      expect(bytes()).toEqual(before);
    });

    it('Rename: a layout file left behind under the new name is said before anything changes, not a refusal to Try Again', async () => {
      // As a Delete whose layout file couldn't be removed leaves it.
      fs.writeFileSync(erd('gold', 'revenue.dbdiagram'), '{}\n');
      await activate(context);
      const before = bytes();
      vi.spyOn(vscode.window, 'showInputBox').mockResolvedValueOnce('revenue');
      const apply = vi.spyOn(vscode.workspace, 'applyEdit');
      await vscode.commands.executeCommand('erdStudio.renameDomain', sales());
      expect(toasts()).toEqual([{
        message: '"sales" can\'t be renamed to "revenue": its layout file would replace .erd-studio/gold/revenue.dbdiagram, ' +
          'which is already there. Delete or move that file, then try again. Nothing was changed.',
        buttons: ['Show File'],
      }]);
      expect(apply).not.toHaveBeenCalled();
      expect(bytes()).toEqual(before);
    });

    it('Rename: a .dbml with a DBML mistake says where, with Open File', async () => {
      fs.appendFileSync(erd('gold', 'sales.dbml'), '\nTable broken {\n');
      await activate(context);
      vi.spyOn(vscode.window, 'showInputBox').mockResolvedValueOnce('revenue');
      await vscode.commands.executeCommand('erdStudio.renameDomain', sales());
      expect(toasts()).toEqual([{
        message: expect.stringMatching(/^\.erd-studio\/gold\/sales\.dbml can't be renamed because the diagram file has a problem: there is a DBML mistake at line \d+/),
        buttons: ['Open File'],
      }]);
      expect(fs.existsSync(erd('gold', 'revenue.dbml'))).toBe(false);
    });

    it('Rename: VS Code refusing the edit offers Try Again, which moves the .dbml and its .dbdiagram without asking again', async () => {
      await activate(context);
      const layout = fs.readFileSync(erd('gold', 'sales.dbdiagram'), 'utf-8');
      const input = vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('revenue' as never);
      // Nothing lands the first time: the edit is refused whole.
      vscode._mockWorkspaceState.applyEditPrefixes.push(0);
      errors.mockResolvedValueOnce('Try Again' as never);
      await vscode.commands.executeCommand('erdStudio.renameDomain', sales());
      await settle();
      expect(toasts()).toEqual([{
        message: "VS Code didn't accept renaming \"sales\" to \"revenue\", usually because another program has the file open or ERD Studio isn't allowed to write to that folder. Nothing was changed.",
        buttons: ['Try Again', 'Send Feedback'],
      }]);
      expect(input).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(erd('gold', 'sales.dbml'))).toBe(false);
      expect(fs.existsSync(erd('gold', 'revenue.dbml'))).toBe(true);
      expect(fs.readFileSync(erd('gold', 'revenue.dbdiagram'), 'utf-8')).toBe(layout);
      compilesClean();
    });
  });

  it('Delete Table runs the D16 cascade: the file, its Refs and every use line, as one edit, with the cascade in the prompt', async () => {
    await activate(context);
    warn.mockResolvedValue('Delete' as never);
    await vscode.commands.executeCommand('erdStudio.deleteLogicalModel', {
      type: 'model', name: 'dim_region', filePath: erd('tables', 'gold', 'dim_region.dbml'),
    });
    const prompt = String(warn.mock.calls.find((c) => String(c[0]).startsWith('Delete table "dim_region"'))?.[0]);
    expect(prompt).toMatch(/This removes the table's file, its \d+ relationships? and its place in 1 diagram\./);
    expect(fs.existsSync(erd('tables', 'gold', 'dim_region.dbml'))).toBe(false);
    for (const f of files().filter((p) => p.endsWith('.dbml'))) {
      expect(fs.readFileSync(erd(f), 'utf-8'), f).not.toMatch(/\bdim_region\b/);
    }
    compilesClean();
  });

  it('Delete Table of a YAML table keeps its format-neutral wording', async () => {
    fs.mkdirSync(erd('logical-models'), { recursive: true });
    fs.writeFileSync(erd('logical-models', 'dim_old.yml'), 'name: dim_old\ncolumns: []\n');
    await activate(context);
    warn.mockResolvedValue(undefined);
    await vscode.commands.executeCommand('erdStudio.deleteLogicalModel', { type: 'model', name: 'dim_old', filePath: erd('logical-models', 'dim_old.yml') });
    expect(warn).toHaveBeenCalledWith(
      'Delete table "dim_old"? This removes the table\'s file — subject area references are not cleaned up.', { modal: true }, 'Delete',
    );
  });

  it('Organise Table Library moves a .dbml table into its layer folder with its Refs and use lines, in one edit', async () => {
    fs.writeFileSync(erd('tables', 'dim_only_gold.dbml'), 'Table dim_only_gold {\n  id INT [pk]\n  date_key INT\n}\n');
    fs.appendFileSync(erd('tables', '_relationships.dbml'), "use { table dim_only_gold } from './dim_only_gold.dbml'\nRef: dim_only_gold.date_key >? dim_date.date_key\n");
    const sales = erd('gold', 'sales.dbml');
    fs.writeFileSync(sales, fs.readFileSync(sales, 'utf-8').replace("use * from '../tables/_relationships.dbml'", "use { table dim_only_gold } from '../tables/dim_only_gold.dbml'\nuse * from '../tables/_relationships.dbml'"));
    await activate(context);
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async (...args: unknown[]) =>
      (args.includes('Move Files') ? 'Move Files' : undefined)) as never);
    const applyEdit = vi.spyOn(vscode.workspace, 'applyEdit');
    await vscode.commands.executeCommand('erdStudio.organizeModelLibrary');
    expect(errors).not.toHaveBeenCalled();
    expect(applyEdit).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(erd('tables', 'dim_only_gold.dbml'))).toBe(false);
    expect(fs.existsSync(erd('tables', 'gold', 'dim_only_gold.dbml'))).toBe(true);
    expect(fs.readFileSync(erd('tables', 'gold', '_relationships.dbml'), 'utf-8')).toContain('dim_only_gold.date_key');
    expect(fs.readFileSync(sales, 'utf-8')).toMatch(/^use \{ table dim_only_gold \} +from '\.\.\/tables\/gold\/dim_only_gold\.dbml'$/m);
    expect(info).toHaveBeenCalledWith('Moved 1 table file into layer folders.');
    compilesClean();
  });

  it('Organise in a mixed project moves .dbml and YAML tables in ONE edit, the YAML file renamed byte for byte', async () => {
    fs.writeFileSync(erd('tables', 'dim_only_gold.dbml'), 'Table dim_only_gold {\n  id INT [pk]\n}\n');
    fs.mkdirSync(erd('logical-models'), { recursive: true });
    // A BOM, CRLF and a Latin-1 byte (0xE9) that is not UTF-8: a text round trip would change it.
    const yamlBytes = Buffer.concat([Buffer.from('\uFEFFname: dim_yaml_gold\r\ndescription: caf', 'utf-8'), Buffer.from([0xe9]), Buffer.from('\r\ncolumns: []\r\n', 'utf-8')]);
    fs.writeFileSync(erd('logical-models', 'dim_yaml_gold.yml'), yamlBytes);
    fs.writeFileSync(erd('gold', 'mixed.json'), JSON.stringify({ schemaVersion: 5, domain: 'mixed', layer: 'gold', logical: { models: ['dim_yaml_gold', 'dim_only_gold'], relationships: [] } }));
    await activate(context);
    vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async (...args: unknown[]) =>
      (args.includes('Move Files') ? 'Move Files' : undefined)) as never);
    const applyEdit = vi.spyOn(vscode.workspace, 'applyEdit');
    await vscode.commands.executeCommand('erdStudio.organizeModelLibrary');
    expect(errors).not.toHaveBeenCalled();
    expect(applyEdit).toHaveBeenCalledTimes(1);
    const ops = (applyEdit.mock.calls[0][0] as unknown as { _ops: Array<{ kind: string }> })._ops.map((o) => o.kind);
    expect(ops).toContain('renameFile');
    expect(fs.existsSync(erd('tables', 'gold', 'dim_only_gold.dbml'))).toBe(true);
    expect(fs.existsSync(erd('logical-models', 'dim_yaml_gold.yml'))).toBe(false);
    expect(fs.readFileSync(erd('logical-models', 'gold', 'dim_yaml_gold.yml')).equals(yamlBytes)).toBe(true);
    compilesClean();
  });

  it('Organise announces every write and both ends of each rename before the edit, and records the moves before saving', async () => {
    fs.writeFileSync(erd('tables', 'dim_only_gold.dbml'), 'Table dim_only_gold {\n  id INT [pk]\n}\n');
    fs.mkdirSync(erd('logical-models'), { recursive: true });
    fs.writeFileSync(erd('logical-models', 'dim_yaml_gold.yml'), 'name: dim_yaml_gold\ncolumns: []\n');
    fs.writeFileSync(erd('gold', 'mixed.json'), JSON.stringify({ schemaVersion: 5, domain: 'mixed', layer: 'gold', logical: { models: ['dim_yaml_gold', 'dim_only_gold'], relationships: [] } }));
    await activate(context);
    vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async (...args: unknown[]) =>
      (args.includes('Move Files') ? 'Move Files' : undefined)) as never);
    const { ownWrites } = await import('../../src/services/ownWriteTracker');
    const events: string[] = [];
    const expectWrite = vi.spyOn(ownWrites, 'expectWrite');
    const applyEdit = vscode.workspace.applyEdit.bind(vscode.workspace);
    vi.spyOn(vscode.workspace, 'applyEdit').mockImplementation(async (edit) => { events.push('applyEdit'); return applyEdit(edit); });
    const recordDelete = ownWrites.recordDelete.bind(ownWrites);
    vi.spyOn(ownWrites, 'recordDelete').mockImplementation((p) => { events.push(`delete:${path.basename(p)}`); recordDelete(p); });
    await vscode.commands.executeCommand('erdStudio.organizeModelLibrary');
    expect(errors).not.toHaveBeenCalled();
    const announced = expectWrite.mock.calls.flatMap((c) => [...c[0]]);
    for (const p of [erd('tables', 'dim_only_gold.dbml'), erd('logical-models', 'dim_yaml_gold.yml'), erd('logical-models', 'gold', 'dim_yaml_gold.yml')]) {
      expect(announced).toContain(p);
    }
    expect(events.indexOf('applyEdit')).toBe(0);
    expect(events).toContain('delete:dim_yaml_gold.yml');
    for (const p of announced) expect(ownWrites.isPending(p)).toBe(false);
  });

  it('Organise: when VS Code rejects the edit part way, every file is put back and it says nothing was changed', async () => {
    fs.writeFileSync(erd('tables', 'dim_only_gold.dbml'), 'Table dim_only_gold {\n  id INT [pk]\n  date_key INT\n}\n');
    fs.appendFileSync(erd('tables', '_relationships.dbml'), "use { table dim_only_gold } from './dim_only_gold.dbml'\nRef: dim_only_gold.date_key >? dim_date.date_key\n");
    const sales = erd('gold', 'sales.dbml');
    fs.writeFileSync(sales, fs.readFileSync(sales, 'utf-8').replace("use * from '../tables/_relationships.dbml'", "use { table dim_only_gold } from '../tables/dim_only_gold.dbml'\nuse * from '../tables/_relationships.dbml'"));
    const before = bytes();
    await activate(context);
    vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async (...args: unknown[]) =>
      (args.includes('Move Files') ? 'Move Files' : undefined)) as never);
    vscode._mockWorkspaceState.applyEditPrefixes.push(1);
    await vscode.commands.executeCommand('erdStudio.organizeModelLibrary');
    expect(errors).toHaveBeenCalledWith('Organise Table Library: VS Code rejected the file moves; nothing was changed.');
    // Replaced documents are put back in memory and saved: disk matches the start.
    for (const doc of vscode.workspace.textDocuments) if (doc.isDirty) await doc.save();
    expect(bytes()).toEqual(before);
  });

  it('Give Duplicate Its Own Name: when VS Code rejects the edit, every file is put back and it says nothing was changed', async () => {
    fs.writeFileSync(erd('tables', 'gold', 'dim_date.dbml'), 'Table dim_date {\n  date_key INT [pk]\n}\n');
    const staging = erd('silver', 'staging.dbml');
    fs.writeFileSync(staging, fs.readFileSync(staging, 'utf-8').replace("from '../tables/dim_date.dbml'", "from '../tables/gold/dim_date.dbml'"));
    const before = bytes();
    await activate(context);
    vi.spyOn(vscode.window, 'showInputBox').mockImplementation((async (o: { value?: string }) => o.value) as never);
    vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async (...args: unknown[]) =>
      (args.includes('Rename') ? 'Rename' : undefined)) as never);
    vscode._mockWorkspaceState.applyEditPrefixes.push(1);
    await vscode.commands.executeCommand('erdStudio.resolveDuplicateModel', erd('tables', 'gold', 'dim_date.dbml'));
    expect(errors).toHaveBeenCalledWith('Could not rename tables/gold/dim_date.dbml; nothing was changed.');
    for (const doc of vscode.workspace.textDocuments) if (doc.isDirty) await doc.save();
    expect(bytes()).toEqual(before);
  });

  it('Give Duplicate Its Own Name renames a .dbml copy and repoints only the diagram that uses it', async () => {
    fs.writeFileSync(erd('tables', 'gold', 'dim_date.dbml'), 'Table dim_date {\n  date_key INT [pk]\n}\n');
    const staging = erd('silver', 'staging.dbml');
    fs.writeFileSync(staging, fs.readFileSync(staging, 'utf-8').replace("from '../tables/dim_date.dbml'", "from '../tables/gold/dim_date.dbml'"));
    const salesBefore = fs.readFileSync(erd('gold', 'sales.dbml'), 'utf-8');
    await activate(context);
    vi.spyOn(vscode.window, 'showInputBox').mockImplementation((async (o: { value?: string }) => o.value) as never);
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async (...args: unknown[]) =>
      (args.includes('Rename') ? 'Rename' : undefined)) as never);
    await vscode.commands.executeCommand('erdStudio.resolveDuplicateModel', erd('tables', 'gold', 'dim_date.dbml'));
    expect(errors).not.toHaveBeenCalled();
    expect(fs.existsSync(erd('tables', 'gold', 'dim_date.dbml'))).toBe(false);
    expect(fs.readFileSync(erd('tables', 'gold', 'gold_dim_date.dbml'), 'utf-8')).toMatch(/^Table gold_dim_date \[alias: 'dim_date'\]/m);
    expect(fs.readFileSync(staging, 'utf-8')).toContain("use { table gold_dim_date } from '../tables/gold/gold_dim_date.dbml'");
    expect(fs.readFileSync(erd('gold', 'sales.dbml'), 'utf-8')).toBe(salesBefore);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('is now its own table, "gold_dim_date"'));
  });

  describe('a refused write shows a modal naming the file, with Open File at the line (§4.7)', () => {
    /** The one modal error shown, with its options and buttons. */
    function refusalModal(): { message: string; detail?: string; buttons: string[] } {
      const modal = errors.mock.calls.find((c) => typeof c[1] === 'object' && (c[1] as { modal?: boolean }).modal);
      expect(modal).toBeDefined();
      const [message, options, ...buttons] = modal as [string, { detail?: string }, ...string[]];
      return { message, detail: options.detail, buttons };
    }

    it('Organise Table Library', async () => {
      fs.writeFileSync(erd('tables', 'dim_only_gold.dbml'), 'Table dim_only_gold {\n  id INT [pk]\n  date_key INT\n}\n');
      fs.appendFileSync(erd('tables', '_relationships.dbml'), "use { table dim_only_gold } from './dim_only_gold.dbml'\nRef: dim_only_gold.date_key >? dim_date.date_key\n");
      // The folder the table moves to has a relationships file that does not read: its Ref cannot be written there.
      fs.appendFileSync(erd('tables', 'gold', '_relationships.dbml'), 'Ref: fct_order.customer_key >\n');
      const sales = erd('gold', 'sales.dbml');
      fs.writeFileSync(sales, fs.readFileSync(sales, 'utf-8').replace("use * from '../tables/_relationships.dbml'", "use { table dim_only_gold } from '../tables/dim_only_gold.dbml'\nuse * from '../tables/_relationships.dbml'"));
      const before = bytes();
      await activate(context);
      vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async (...args: unknown[]) =>
        (args.includes('Move Files') ? 'Move Files' : undefined)) as never);
      const open = vi.spyOn(vscode.workspace, 'openTextDocument');
      errors.mockResolvedValueOnce('Open File' as never);
      await vscode.commands.executeCommand('erdStudio.organizeModelLibrary');
      const modal = refusalModal();
      expect(modal.message).toMatch(/^Organise Table Library: Fix the DBML in tables\/gold\/_relationships\.dbml first .* Nothing was changed\.$/);
      expect(modal.detail).toMatch(/^File: \.erd-studio\/tables\/gold\/_relationships\.dbml, line \d+$/);
      expect(modal.buttons).toEqual(['Open File']);
      await vi.waitFor(() => expect(open).toHaveBeenCalledWith(expect.objectContaining({ fsPath: erd('tables', 'gold', '_relationships.dbml') })));
      expect(bytes()).toEqual(before);
    });

    it('Give Duplicate Its Own Name', async () => {
      fs.writeFileSync(erd('tables', 'gold', 'dim_date.dbml'), "use { table dim_customer } from './dim_customer.dbml'\nTable dim_date {\n  date_key INT [pk]\n}\n");
      const before = bytes();
      await activate(context);
      vi.spyOn(vscode.window, 'showInputBox').mockImplementation((async (o: { value?: string }) => o.value) as never);
      vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async (...args: unknown[]) =>
        (args.includes('Rename') ? 'Rename' : undefined)) as never);
      await vscode.commands.executeCommand('erdStudio.resolveDuplicateModel', erd('tables', 'gold', 'dim_date.dbml'));
      const modal = refusalModal();
      expect(modal.message).toMatch(/^Give Duplicate Its Own Name: tables\/gold\/dim_date\.dbml: .* Nothing was changed\.$/);
      expect(modal.detail).toBe('File: .erd-studio/tables/gold/dim_date.dbml, line 1');
      expect(modal.buttons).toEqual(['Open File']);
      expect(bytes()).toEqual(before);
    });

    it('Rename Subject Area', async () => {
      const sales = erd('gold', 'sales.dbml');
      fs.appendFileSync(sales, '\nProject second {\n  Note: \'again\'\n}\n');
      const before = bytes();
      await activate(context);
      vi.spyOn(vscode.window, 'showInputBox').mockResolvedValueOnce('revenue');
      await vscode.commands.executeCommand('erdStudio.renameDomain', {
        type: 'domain', summary: { domain: 'sales', layer: 'gold', filePath: sales, storage: 'dbml' },
      });
      const modal = refusalModal();
      expect(modal.message).toMatch(/^Rename Diagram: gold\/sales\.dbml: .* Nothing was changed\.$/);
      expect(modal.detail).toBe('File: .erd-studio/gold/sales.dbml');
      expect(modal.buttons).toEqual(['Open File']);
      expect(bytes()).toEqual(before);
    });
  });

  it('Move Relationships to Table Library has nothing to move in a DBML project', async () => {
    await activate(context);
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    const before = files().map((f) => fs.readFileSync(erd(f), 'utf-8'));
    await vscode.commands.executeCommand('erdStudio.moveRelationshipsToLibrary');
    expect(info).toHaveBeenCalledWith('Nothing to move: relationships in a DBML project are already in the table library.');
    expect(files().map((f) => fs.readFileSync(erd(f), 'utf-8'))).toEqual(before);
  });
});
