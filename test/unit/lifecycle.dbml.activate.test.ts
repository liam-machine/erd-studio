/**
 * The lifecycle commands in the layer-first DBML tree (ERD Studio 2.0, §2.8),
 * through `activate()` on a copy of `test/fixtures/dbml-native` — New
 * Diagram, Rename and Delete Subject Area, Set Up, Delete Table (the D16
 * cascade), Remove Layer, Organise Table Library and Give Duplicate Its Own
 * Name — and in a new, empty folder (the README on create).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import { createRequire, syncBuiltinESMExports } from 'module';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { activate, _resetFirstRunGuardForTests } from '../../src/extension';
import { compileDbmlProject, parseSubjectAreaDbml, type DbmlParserModule } from '@erd-studio/core/dbml';
import * as v9 from 'dbml-parse-v9';
import * as v10 from 'dbml-parse-v10';
import { formatWrittenDbml } from '../../src/services/dbmlWriters';
import { semanticReadmeText } from '../../src/services/semanticReadme';

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
  const diagrams = Object.keys(texts).filter((f) => f.split('/')[1] === 'diagrams' && f.split('/').length === 3);
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

  it('New Diagram writes <layer>/diagrams/x.dbml, layers.json and the README, and nothing else', async () => {
    await activate(context);
    vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (items: Array<{ value: string }>) => items.find((i) => i.value === 'gold')) as never);
    // One question after the layer: the name, as people write it.
    const input = vi.spyOn(vscode.window, 'showInputBox').mockResolvedValueOnce('Orders');
    await vscode.commands.executeCommand('erdStudio.createDomain');
    expect(input).toHaveBeenCalledTimes(1);
    expect(files()).toEqual(['README.md', 'gold/diagrams/orders.dbml', 'layers.json']);
    expect(fs.readFileSync(erd('README.md'), 'utf-8')).toBe(semanticReadmeText());
    const text = fs.readFileSync(erd('gold', 'diagrams', 'orders.dbml'), 'utf-8');
    expect(parseSubjectAreaDbml(text, 'gold/diagrams/orders.dbml').obj).toMatchObject({ domain: 'orders', logical: { models: [] } });
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

  const IMPORTED = ['README.md', 'gold/diagrams/shop.dbml', 'gold/relationships/gold.dbml', 'gold/tables/gold/customers.dbml', 'gold/tables/gold/orders.dbml', 'layers.json'];

  it('Import DBML writes the tables in <layer>/tables/<layer>/, the Ref in the layer\'s relationships file, and the source erd_layout into the new diagram\'s own', async () => {
    const inbox = path.join(root, 'inbox');
    fs.mkdirSync(inbox);
    fs.writeFileSync(path.join(inbox, 'shop.dbml'), 'Table customers {\n  id int [pk]\n}\nTable orders {\n  id int [pk]\n  customer_id int [ref: > customers.id]\n}\n'
      + "Project shop {\n  erd_layout: '''\n    customers 40 60\n    orders 400 60\n  '''\n}\n");
    await activate(context);
    importFrom(path.join(inbox, 'shop.dbml'));
    await vscode.commands.executeCommand('erdStudio.importDbml');
    expect(files()).toEqual(IMPORTED);
    const shopText = fs.readFileSync(erd('gold', 'diagrams', 'shop.dbml'), 'utf-8');
    const shop = parseSubjectAreaDbml(shopText, 'gold/diagrams/shop.dbml').obj as { viewConfig: { positions: unknown } };
    expect(shop.viewConfig.positions).toEqual({ customers: { x: 40, y: 60 }, orders: { x: 400, y: 60 } });
    expect(shopText).toMatch(/Project shop \{[^]*erd_layout: '''\n    customers 40 60\n    orders 400 60\n  '''\n\}\n$/);
    expect(shopText).toContain("use * from '../relationships/gold.dbml'");
    expect(fs.readFileSync(erd('gold', 'tables', 'gold', 'orders.dbml'), 'utf-8')).toMatch(/^Table gold\.orders \{/);
    compilesClean();
  });

  it('Import DBML\'s preview names the relationships file and says the layout is saved in the diagram file; with no source layout the import writes no erd_layout', async () => {
    const inbox = path.join(root, 'inbox');
    fs.mkdirSync(inbox);
    fs.writeFileSync(path.join(inbox, 'shop.dbml'), 'Table customers {\n  id int [pk]\n}\nTable orders {\n  id int [pk]\n  customer_id int [ref: > customers.id]\n}\n');
    await activate(context);
    importFrom(path.join(inbox, 'shop.dbml'));
    await vscode.commands.executeCommand('erdStudio.importDbml');
    const modal = (vscode.window.showInformationMessage as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .find((c) => typeof c[1] === 'object' && (c[1] as { modal?: boolean }).modal)!;
    const detail = (modal[1] as { detail: string }).detail;
    expect(detail).toContain('• 1 relationship saved in gold/relationships/gold.dbml.');
    expect(detail).not.toContain('the tables\' files');
    expect(detail).toContain('• No erd_layout in the file: the diagram is laid out automatically when it opens, and that layout is saved in the diagram file.');
    // The import itself writes no positions: the first open's auto layout does, as a JSON diagram's first open writes its positions.
    expect(fs.readFileSync(erd('gold', 'diagrams', 'shop.dbml'), 'utf-8')).not.toContain('erd_layout');
    expect(files()).toEqual(IMPORTED);
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

  it('a dbdiagram single-file .dbml dropped into a layer\'s diagrams folder is imported from its own URI (the banner\'s Import, §9.7 check 7)', async () => {
    fs.mkdirSync(erd('gold', 'diagrams'), { recursive: true });
    const dropped = erd('gold', 'diagrams', 'pulled.dbml');
    fs.writeFileSync(dropped, 'Project pulled {\n  database_type: \'PostgreSQL\'\n}\nTable customers {\n  id int [pk]\n}\nTable orders {\n  id int [pk]\n  customer_id int [ref: > customers.id]\n}\n');
    await activate(context);
    importFrom(dropped);
    await vscode.commands.executeCommand('erdStudio.importDbml', vscode.Uri.file(dropped));
    expect(errors).not.toHaveBeenCalled();
    // The dropped file is left as it is; the import is a new DBML diagram beside it, with its tables in the library.
    const created = files().filter((f) => f.startsWith('gold/diagrams/') && f !== 'gold/diagrams/pulled.dbml');
    expect(created).toHaveLength(1);
    expect(files()).toEqual(expect.arrayContaining(['gold/tables/gold/customers.dbml', 'gold/tables/gold/orders.dbml', 'gold/relationships/gold.dbml']));
    const text = fs.readFileSync(erd(created[0]), 'utf-8');
    expect(parseSubjectAreaDbml(text, created[0]).obj).toMatchObject({ logical: { models: ['customers', 'orders'] } });
  });

  it('Set Up writes layers.json, the layer folders and the README, and makes no table library folder', async () => {
    await activate(context);
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue(undefined);
    const run = vscode.commands.executeCommand('erdStudio.setupSemanticDirectory');
    await vi.advanceTimersByTimeAsync(200);
    await run;
    expect(files()).toEqual(['README.md', 'layers.json']);
    expect(fs.readFileSync(erd('README.md'), 'utf-8')).toBe(semanticReadmeText());
    for (const layer of (JSON.parse(fs.readFileSync(erd('layers.json'), 'utf-8')) as { layers: Array<{ id: string }> }).layers) {
      expect(fs.statSync(erd(layer.id)).isDirectory(), layer.id).toBe(true);
    }
    expect(fs.existsSync(erd('logical-models'))).toBe(false);
    expect(fs.existsSync(erd('tables'))).toBe(false);
  });

  it('Set Up in a folder whose ERD folder exists already writes no README', async () => {
    fs.mkdirSync(erd(), { recursive: true });
    await activate(context);
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue(undefined);
    const run = vscode.commands.executeCommand('erdStudio.setupSemanticDirectory');
    await vi.advanceTimersByTimeAsync(200);
    await run;
    expect(files()).toEqual(['layers.json']);
  });
});

describe('in a native DBML project', () => {
  beforeEach(() => {
    fs.cpSync(DBML_NATIVE, ws, { recursive: true });
    openWorkspace();
  });

  const salesPath = (): string => erd('gold', 'diagrams', 'sales.dbml');
  const stagingPath = (): string => erd('silver', 'diagrams', 'staging.dbml');

  it('New Diagram writes <layer>/diagrams/x.dbml and a missing layers.json, no README in a project that has one folder already; a name taken in either format is refused', async () => {
    fs.rmSync(erd('layers.json'));
    fs.rmSync(erd('README.md'));
    await activate(context);
    vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (items: Array<{ value: string }>) => items.find((i) => i.value === 'gold')) as never);
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValueOnce('returns').mockResolvedValueOnce('');
    await vscode.commands.executeCommand('erdStudio.createDomain');
    expect(fs.existsSync(erd('gold', 'diagrams', 'returns.dbml'))).toBe(true);
    expect(fs.existsSync(erd('gold', 'returns.dbml'))).toBe(false);
    expect(fs.existsSync(erd('layers.json'))).toBe(true);
    expect(fs.existsSync(erd('README.md'))).toBe(false);
    expect(fs.existsSync(erd('gold', 'returns.json'))).toBe(false);

    // A JSON file of the same name (an older teammate's) blocks the name.
    fs.writeFileSync(erd('gold', 'refunds.json'), '{"schemaVersion":5,"domain":"refunds","layer":"gold","logical":{"models":[]}}\n');
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValueOnce('refunds').mockResolvedValueOnce('');
    await vscode.commands.executeCommand('erdStudio.createDomain');
    expect(fs.existsSync(erd('gold', 'diagrams', 'refunds.dbml'))).toBe(false);
  });

  it('New Diagram in a layer with no diagrams folder yet makes it, and removes it again when the diagram cannot be written', async () => {
    await activate(context);
    vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (items: Array<{ value: string }>) => items.find((i) => i.value === 'silver')) as never);
    fs.rmSync(erd('silver', 'diagrams'), { recursive: true });
    // The disk refuses the diagram itself (the services use the ESM namespace of `fs`, whose bindings follow the CommonJS module once synced).
    const cjsFs = createRequire(import.meta.url)('fs') as { writeFileSync: (...a: unknown[]) => unknown };
    const real = cjsFs.writeFileSync;
    cjsFs.writeFileSync = (...args: unknown[]) => {
      if (String(args[0]).endsWith('lost.dbml')) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES', path: String(args[0]) });
      return real(...args);
    };
    syncBuiltinESMExports();
    try {
      vi.spyOn(vscode.window, 'showInputBox').mockResolvedValueOnce('lost').mockResolvedValueOnce('');
      await vscode.commands.executeCommand('erdStudio.createDomain');
    } finally {
      cjsFs.writeFileSync = real;
      syncBuiltinESMExports();
    }
    expect(errors).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(erd('silver', 'diagrams'))).toBe(false);
    expect(fs.existsSync(erd('silver'))).toBe(true);
  });

  it('Rename Subject Area renames the .dbml in one edit, splicing only the Project name (its erd_layout goes with it)', async () => {
    await activate(context);
    const before = fs.readFileSync(salesPath(), 'utf-8');
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValueOnce('revenue');
    const exec = vi.spyOn(vscode.commands, 'executeCommand');
    await vscode.commands.executeCommand('erdStudio.renameDomain', {
      type: 'domain', summary: { domain: 'sales', layer: 'gold', filePath: salesPath(), storage: 'dbml' },
    });
    expect(errors).not.toHaveBeenCalled();
    expect(fs.existsSync(salesPath())).toBe(false);
    const revenue = erd('gold', 'diagrams', 'revenue.dbml');
    // The Project name spliced, then the file in the canonical layout (every DBML write is formatted).
    expect(fs.readFileSync(revenue, 'utf-8')).toBe(canonical(before.replace('Project sales {', 'Project revenue {')));
    expect(fs.readFileSync(revenue, 'utf-8')).toContain('    fct_order 400 200\n');
    expect(exec).toHaveBeenCalledWith('vscode.openWith', expect.objectContaining({ fsPath: revenue }), expect.any(String));
    compilesClean();
  });

  it('Rename Subject Area: when VS Code rejects the edit and the reconcile cannot put a file back, only the modal speaks', async () => {
    await activate(context);
    // The first edit lands its first step (the new diagram) and fails; the reconcile is rejected too.
    vscode._mockWorkspaceState.applyEditPrefixes.push(1, 0);
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValueOnce('revenue');
    await vscode.commands.executeCommand('erdStudio.renameDomain', {
      type: 'domain', summary: { domain: 'sales', layer: 'gold', filePath: salesPath(), storage: 'dbml' },
    });
    expect(errors).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalledWith(expect.stringMatching(/could not put back .*Restore these from source control\.$/), { modal: true });
  });

  it('Delete Subject Area deletes the one .dbml (its positions are in it), recorded as an own delete', async () => {
    await activate(context);
    warn.mockResolvedValue('Delete' as never);
    const del = vi.spyOn(vscode.workspace.fs, 'delete').mockResolvedValue(undefined as never);
    const { ownWrites } = await import('../../src/services/ownWriteTracker');
    const recorded = vi.spyOn(ownWrites, 'recordDelete');
    await vscode.commands.executeCommand('erdStudio.deleteDomain', {
      type: 'domain', summary: { domain: 'sales', layer: 'gold', filePath: salesPath(), storage: 'dbml' },
    });
    expect(del.mock.calls.map((c) => (c[0] as { fsPath: string }).fsPath)).toEqual([salesPath()]);
    expect(recorded.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining([salesPath()]));
  });

  describe('the diagram commands\' failures (#229) on a .dbml diagram', () => {
    const sales = () => ({ type: 'domain', summary: { domain: 'sales', layer: 'gold', filePath: salesPath(), storage: 'dbml' } });
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
      expect(fs.existsSync(erd('gold', 'diagrams', 'refunds.dbml'))).toBe(false);
      expect(exec.mock.calls.some((c) => c[0] === 'vscode.openWith' && (c[1] as vscode.Uri).fsPath === erd('gold', 'refunds.json'))).toBe(true);
    });

    it('Delete: a .dbml that cannot be deleted says so, with Show File and Try Again', async () => {
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

    it('Rename: a 1.9 diagram of the new name in the layer folder (gold/revenue.dbml) is not in the way, and is left as it is', async () => {
      fs.writeFileSync(erd('gold', 'revenue.dbml'), 'Project revenue {\n}\n');
      await activate(context);
      vi.spyOn(vscode.window, 'showInputBox').mockResolvedValueOnce('revenue');
      await vscode.commands.executeCommand('erdStudio.renameDomain', sales());
      expect(toasts()).toEqual([]);
      expect(fs.existsSync(erd('gold', 'diagrams', 'revenue.dbml'))).toBe(true);
      expect(fs.readFileSync(erd('gold', 'revenue.dbml'), 'utf-8')).toBe('Project revenue {\n}\n');
    });

    it('Rename: a .dbml with a DBML mistake says where, with Open File', async () => {
      fs.appendFileSync(salesPath(), '\nTable broken {\n');
      await activate(context);
      vi.spyOn(vscode.window, 'showInputBox').mockResolvedValueOnce('revenue');
      await vscode.commands.executeCommand('erdStudio.renameDomain', sales());
      expect(toasts()).toEqual([{
        message: expect.stringMatching(/^\.erd-studio\/gold\/diagrams\/sales\.dbml can't be renamed because the diagram file has a problem: there is a DBML mistake at line \d+/),
        buttons: ['Open File'],
      }]);
      expect(fs.existsSync(erd('gold', 'diagrams', 'revenue.dbml'))).toBe(false);
    });

    it('Rename: VS Code refusing the edit offers Try Again, which moves the .dbml without asking again', async () => {
      await activate(context);
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
      expect(fs.existsSync(salesPath())).toBe(false);
      expect(fs.existsSync(erd('gold', 'diagrams', 'revenue.dbml'))).toBe(true);
      compilesClean();
    });
  });

  it('Delete Table runs the D16 cascade: the file, its Refs and every use line, as one edit, with the cascade in the prompt', async () => {
    await activate(context);
    warn.mockResolvedValue('Delete' as never);
    await vscode.commands.executeCommand('erdStudio.deleteLogicalModel', {
      type: 'model', name: 'dim_region', filePath: erd('gold', 'tables', 'gold', 'dim_region.dbml'),
    });
    const prompt = String(warn.mock.calls.find((c) => String(c[0]).startsWith('Delete table "dim_region"'))?.[0]);
    expect(prompt).toMatch(/This removes the table's file, its \d+ relationships? and its place in 1 diagram\./);
    expect(fs.existsSync(erd('gold', 'tables', 'gold', 'dim_region.dbml'))).toBe(false);
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
      'Delete table "dim_old"? This removes the table\'s file — diagrams that show it are not updated.', { modal: true }, 'Delete',
    );
  });

  it('Remove Layer refuses while the layer holds tables or relationships files, and deletes nothing', async () => {
    const layers = JSON.parse(fs.readFileSync(erd('layers.json'), 'utf-8')) as { layers: Array<Record<string, unknown>> };
    layers.layers.unshift({ id: 'bronze', label: 'Bronze', abbreviation: 'BRZ', color: '#cd7f32', creatable: true, order: 0 });
    fs.writeFileSync(erd('layers.json'), `${JSON.stringify(layers, null, 2)}\n`);
    fs.mkdirSync(erd('bronze', 'tables', 'raw'), { recursive: true });
    fs.writeFileSync(erd('bronze', 'tables', 'raw', 'orders_raw.dbml'), 'Table raw.orders_raw {\n  id INT [pk]\n}\n');
    fs.mkdirSync(erd('bronze', 'relationships'), { recursive: true });
    fs.writeFileSync(erd('bronze', 'relationships', 'bronze.dbml'), '// nothing yet\n');
    const before = bytes();
    await activate(context);
    const del = vi.spyOn(vscode.workspace.fs, 'delete');
    await vscode.commands.executeCommand('erdStudio.removeLayer', { type: 'layer', layer: 'bronze' });
    expect(errors).toHaveBeenCalledWith('Cannot remove layer "Bronze": it holds 1 table(s) and 1 relationships file(s). Move or delete them first.');
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('Remove layer'), expect.anything(), expect.anything());
    expect(del).not.toHaveBeenCalled();
    expect(bytes()).toEqual(before);

    // With its .dbml files gone, the layer can go: a .DS_Store or .gitkeep left behind is not a table.
    fs.rmSync(erd('bronze', 'tables', 'raw', 'orders_raw.dbml'));
    fs.writeFileSync(erd('bronze', 'tables', 'raw', '.DS_Store'), '');
    fs.rmSync(erd('bronze', 'relationships', 'bronze.dbml'));
    fs.writeFileSync(erd('bronze', 'relationships', '.gitkeep'), '');
    warn.mockResolvedValue('Remove' as never);
    await vscode.commands.executeCommand('erdStudio.removeLayer', { type: 'layer', layer: 'bronze' });
    expect(errors).toHaveBeenCalledTimes(1);
    expect((JSON.parse(fs.readFileSync(erd('layers.json'), 'utf-8')) as { layers: Array<{ id: string }> }).layers.map((l) => l.id)).toEqual(['silver', 'gold']);
  });

  /** gold/tables/gold/dim_rate.dbml: only the silver diagram shows it, and gold's relationships file holds its Ref. */
  function seedRate(): void {
    fs.writeFileSync(erd('gold', 'tables', 'gold', 'dim_rate.dbml'), 'Table gold.dim_rate {\n  rate_key INT [pk]\n  date_key INT\n}\n');
    const goldRels = erd('gold', 'relationships', 'gold.dbml');
    fs.writeFileSync(goldRels, fs.readFileSync(goldRels, 'utf-8')
      .replace("use { table gold.dim_region }", "use { table gold.dim_rate } from '../tables/gold/dim_rate.dbml'\nuse { table gold.dim_region }")
      .concat('\nRef: gold.dim_rate.date_key >? calendar.dim_date.date_key\n'));
    fs.writeFileSync(stagingPath(), fs.readFileSync(stagingPath(), 'utf-8').replace("use * from '../../gold/relationships/gold.dbml'", "use { table gold.dim_rate } from '../../gold/tables/gold/dim_rate.dbml'\nuse * from '../../gold/relationships/gold.dbml'"));
  }

  it('Organise Table Library moves a .dbml table to the layer whose diagrams show it, in one edit: no Ref moves, every use line follows', async () => {
    seedRate();
    const goldRelsRefs = fs.readFileSync(erd('gold', 'relationships', 'gold.dbml'), 'utf-8').split('\n').filter((l) => l.startsWith('Ref'));
    await activate(context);
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async (...args: unknown[]) =>
      (args.includes('Move Files') ? 'Move Files' : undefined)) as never);
    const applyEdit = vi.spyOn(vscode.workspace, 'applyEdit');
    await vscode.commands.executeCommand('erdStudio.organizeModelLibrary');
    expect(errors).not.toHaveBeenCalled();
    expect(applyEdit).toHaveBeenCalledTimes(1);
    const modal = info.mock.calls.find((c) => c[0] === 'Organise Table Library by Layer?')!;
    expect((modal[1] as { detail: string }).detail).toContain('Move 1 table into layer folders (1 → silver/).');
    expect((modal[1] as { detail: string }).detail).not.toContain('re-spelled');
    expect(fs.existsSync(erd('gold', 'tables', 'gold', 'dim_rate.dbml'))).toBe(false);
    expect(fs.readFileSync(erd('silver', 'tables', 'gold', 'dim_rate.dbml'), 'utf-8')).toMatch(/^Table gold\.dim_rate \{/);
    // No Ref moved: gold's file holds the same Refs, and silver has no relationships file of its own for it.
    const goldRels = fs.readFileSync(erd('gold', 'relationships', 'gold.dbml'), 'utf-8');
    expect(goldRels.split('\n').filter((l) => l.startsWith('Ref'))).toEqual(goldRelsRefs);
    expect(goldRels).toMatch(/^use \{ table gold\.dim_rate \} +from '\.\.\/\.\.\/silver\/tables\/gold\/dim_rate\.dbml'$/m);
    expect(fs.existsSync(erd('silver', 'relationships', 'silver.dbml'))).toBe(false);
    expect(fs.readFileSync(stagingPath(), 'utf-8')).toMatch(/^use \{ table gold\.dim_rate \} +from '\.\.\/tables\/gold\/dim_rate\.dbml'$/m);
    expect(info).toHaveBeenCalledWith('Moved 1 table file into layer folders.');
    compilesClean();
  });

  it('Organise moves the use line of a diagram in a folder layers.json does not list, too', async () => {
    seedRate();
    fs.mkdirSync(erd('archive', 'diagrams'), { recursive: true });
    fs.writeFileSync(erd('archive', 'diagrams', 'old.dbml'), "use { table gold.dim_rate } from '../../gold/tables/gold/dim_rate.dbml'\n\nProject old {\n  erd_schema_version: '7'\n}\n");
    await activate(context);
    vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async (...args: unknown[]) =>
      (args.includes('Move Files') ? 'Move Files' : undefined)) as never);
    await vscode.commands.executeCommand('erdStudio.organizeModelLibrary');
    expect(errors).not.toHaveBeenCalled();
    expect(fs.existsSync(erd('silver', 'tables', 'gold', 'dim_rate.dbml'))).toBe(true);
    expect(fs.readFileSync(erd('archive', 'diagrams', 'old.dbml'), 'utf-8')).toMatch(/^use \{ table gold\.dim_rate \} +from '\.\.\/\.\.\/silver\/tables\/gold\/dim_rate\.dbml'$/m);
  });

  it('Organise lists a table it re-qualifies (its schema spelled as the new layer\'s folder spells it)', async () => {
    fs.mkdirSync(erd('gold', 'tables', 'Calendar'), { recursive: true });
    fs.writeFileSync(erd('gold', 'tables', 'Calendar', 'dim_holiday.dbml'), 'Table Calendar.dim_holiday {\n  holiday_key INT [pk]\n}\n');
    fs.writeFileSync(stagingPath(), fs.readFileSync(stagingPath(), 'utf-8').replace("use * from '../../gold/relationships/gold.dbml'", "use { table Calendar.dim_holiday } from '../../gold/tables/Calendar/dim_holiday.dbml'\nuse * from '../../gold/relationships/gold.dbml'"));
    await activate(context);
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async (...args: unknown[]) =>
      (args.includes('Move Files') ? 'Move Files' : undefined)) as never);
    await vscode.commands.executeCommand('erdStudio.organizeModelLibrary');
    expect(errors).not.toHaveBeenCalled();
    const modal = info.mock.calls.find((c) => c[0] === 'Organise Table Library by Layer?')!;
    expect((modal[1] as { detail: string }).detail).toContain("Its schema is spelled as the new layer's folder spells it, so every Ref naming it is re-spelled too: dim_holiday.");
    expect(fs.readFileSync(erd('silver', 'tables', 'calendar', 'dim_holiday.dbml'), 'utf-8')).toMatch(/^Table calendar\.dim_holiday \{/);
    expect(fs.existsSync(erd('gold', 'tables', 'Calendar'))).toBe(false);
    compilesClean();
  });

  /** A DBML table in silver and a flat YAML table, both shown only by a gold JSON diagram. */
  function seedMixed(yamlText: string | Buffer = 'name: dim_yaml_gold\ncolumns: []\n'): void {
    fs.mkdirSync(erd('silver', 'tables', 'silver'), { recursive: true });
    fs.writeFileSync(erd('silver', 'tables', 'silver', 'dim_only_gold.dbml'), 'Table silver.dim_only_gold {\n  id INT [pk]\n}\n');
    fs.mkdirSync(erd('logical-models'), { recursive: true });
    fs.writeFileSync(erd('logical-models', 'dim_yaml_gold.yml'), yamlText);
    fs.writeFileSync(erd('gold', 'mixed.json'), JSON.stringify({ schemaVersion: 5, domain: 'mixed', layer: 'gold', logical: { models: ['dim_yaml_gold', 'dim_only_gold'], relationships: [] } }));
  }

  it('Organise in a mixed project moves .dbml and YAML tables in ONE edit, the YAML file renamed byte for byte', async () => {
    // A BOM, CRLF and a Latin-1 byte (0xE9) that is not UTF-8: a text round trip would change it.
    const yamlBytes = Buffer.concat([Buffer.from('﻿name: dim_yaml_gold\r\ndescription: caf', 'utf-8'), Buffer.from([0xe9]), Buffer.from('\r\ncolumns: []\r\n', 'utf-8')]);
    seedMixed(yamlBytes);
    await activate(context);
    vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async (...args: unknown[]) =>
      (args.includes('Move Files') ? 'Move Files' : undefined)) as never);
    const applyEdit = vi.spyOn(vscode.workspace, 'applyEdit');
    await vscode.commands.executeCommand('erdStudio.organizeModelLibrary');
    expect(errors).not.toHaveBeenCalled();
    expect(applyEdit).toHaveBeenCalledTimes(1);
    const ops = (applyEdit.mock.calls[0][0] as unknown as { _ops: Array<{ kind: string }> })._ops.map((o) => o.kind);
    expect(ops).toContain('renameFile');
    expect(fs.readFileSync(erd('gold', 'tables', 'silver', 'dim_only_gold.dbml'), 'utf-8')).toMatch(/^Table silver\.dim_only_gold \{/);
    expect(fs.existsSync(erd('silver', 'tables', 'silver'))).toBe(false);
    expect(fs.existsSync(erd('logical-models', 'dim_yaml_gold.yml'))).toBe(false);
    expect(fs.readFileSync(erd('logical-models', 'gold', 'dim_yaml_gold.yml')).equals(yamlBytes)).toBe(true);
    compilesClean();
  });

  it('Organise announces every write and both ends of each rename before the edit, and records the moves before saving', async () => {
    seedMixed();
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
    for (const p of [erd('silver', 'tables', 'silver', 'dim_only_gold.dbml'), erd('gold', 'tables', 'silver', 'dim_only_gold.dbml'), erd('logical-models', 'dim_yaml_gold.yml'), erd('logical-models', 'gold', 'dim_yaml_gold.yml')]) {
      expect(announced).toContain(p);
    }
    expect(events.indexOf('applyEdit')).toBe(0);
    expect(events).toContain('delete:dim_yaml_gold.yml');
    for (const p of announced) expect(ownWrites.isPending(p)).toBe(false);
  });

  it('Organise: when VS Code rejects the edit part way, every file is put back and it says nothing was changed', async () => {
    seedRate();
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

  /**
   * A second dim_customer in silver/tables/silver/ (`silver.dim_customer`): gold's comes first in
   * the listing and wins, so the silver one is the copy. silver's relationships file and the
   * staging diagram use the copy.
   */
  function seedDuplicate(): void {
    fs.mkdirSync(erd('silver', 'tables', 'silver'), { recursive: true });
    fs.writeFileSync(erd('silver', 'tables', 'silver', 'dim_customer.dbml'), 'Table silver.dim_customer {\n  customer_key INT [pk]\n}\n');
    fs.writeFileSync(erd('silver', 'tables', 'silver', 'fct_visit.dbml'), 'Table silver.fct_visit {\n  visit_key INT [pk]\n  customer_key INT\n}\n');
    fs.writeFileSync(erd('silver', 'relationships', 'silver.dbml'), [
      "use { table silver.dim_customer } from '../tables/silver/dim_customer.dbml'",
      "use { table silver.fct_visit } from '../tables/silver/fct_visit.dbml'",
      '',
      'Ref: silver.fct_visit.customer_key >? silver.dim_customer.customer_key',
      '',
    ].join('\n'));
    fs.writeFileSync(stagingPath(), fs.readFileSync(stagingPath(), 'utf-8').replace("use * from '../../gold/relationships/gold.dbml'", "use { table silver.dim_customer } from '../tables/silver/dim_customer.dbml'\nuse * from '../../gold/relationships/gold.dbml'"));
  }
  const COPY = (): string => erd('silver', 'tables', 'silver', 'dim_customer.dbml');

  it('Give Duplicate Its Own Name: when VS Code rejects the edit, every file is put back and it says nothing was changed', async () => {
    seedDuplicate();
    const before = bytes();
    await activate(context);
    vi.spyOn(vscode.window, 'showInputBox').mockImplementation((async (o: { value?: string }) => o.value) as never);
    vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async (...args: unknown[]) =>
      (args.includes('Rename') ? 'Rename' : undefined)) as never);
    vscode._mockWorkspaceState.applyEditPrefixes.push(1);
    await vscode.commands.executeCommand('erdStudio.resolveDuplicateModel', COPY());
    expect(errors).toHaveBeenCalledWith('Could not rename silver/tables/silver/dim_customer.dbml; nothing was changed.');
    for (const doc of vscode.workspace.textDocuments) if (doc.isDirty) await doc.save();
    expect(bytes()).toEqual(before);
  });

  it('Give Duplicate Its Own Name renames a .dbml copy (named after its layer), re-spells its own Ref ends and repoints only the diagram that uses it', async () => {
    seedDuplicate();
    const salesBefore = fs.readFileSync(salesPath(), 'utf-8');
    const goldRelsBefore = fs.readFileSync(erd('gold', 'relationships', 'gold.dbml'), 'utf-8');
    await activate(context);
    const input = vi.spyOn(vscode.window, 'showInputBox').mockImplementation((async (o: { value?: string }) => o.value) as never);
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async (...args: unknown[]) =>
      (args.includes('Rename') ? 'Rename' : undefined)) as never);
    await vscode.commands.executeCommand('erdStudio.resolveDuplicateModel', COPY());
    expect(errors).not.toHaveBeenCalled();
    expect((input.mock.calls[0][0] as { value?: string }).value).toBe('silver_dim_customer');
    expect(fs.existsSync(COPY())).toBe(false);
    expect(fs.readFileSync(erd('silver', 'tables', 'silver', 'silver_dim_customer.dbml'), 'utf-8')).toMatch(/^Table silver\.silver_dim_customer \[alias: 'dim_customer'\]/m);
    expect(fs.readFileSync(erd('silver', 'relationships', 'silver.dbml'), 'utf-8')).toContain('Ref: silver.fct_visit.customer_key >? silver.silver_dim_customer.customer_key');
    expect(fs.readFileSync(stagingPath(), 'utf-8')).toMatch(/^use \{ table silver\.silver_dim_customer \} +from '\.\.\/tables\/silver\/silver_dim_customer\.dbml'$/m);
    expect(fs.readFileSync(salesPath(), 'utf-8')).toBe(salesBefore);
    expect(fs.readFileSync(erd('gold', 'relationships', 'gold.dbml'), 'utf-8')).toBe(goldRelsBefore);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('is now its own table, "silver_dim_customer"'));
    compilesClean();
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
      seedRate();
      // The relationships file that names the moving table does not read: its use line cannot follow.
      fs.appendFileSync(erd('gold', 'relationships', 'gold.dbml'), 'Ref: gold.fct_order.customer_key >\n');
      const before = bytes();
      await activate(context);
      vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async (...args: unknown[]) =>
        (args.includes('Move Files') ? 'Move Files' : undefined)) as never);
      const open = vi.spyOn(vscode.workspace, 'openTextDocument');
      errors.mockResolvedValueOnce('Open File' as never);
      await vscode.commands.executeCommand('erdStudio.organizeModelLibrary');
      const modal = refusalModal();
      expect(modal.message).toMatch(/^Organise Table Library: .*gold\/relationships\/gold\.dbml.* Nothing was changed\.$/);
      expect(modal.detail).toMatch(/^File: \.erd-studio\/gold\/relationships\/gold\.dbml/);
      expect(modal.buttons).toEqual(['Open File']);
      await vi.waitFor(() => expect(open).toHaveBeenCalledWith(expect.objectContaining({ fsPath: erd('gold', 'relationships', 'gold.dbml') })));
      expect(bytes()).toEqual(before);
    });

    it('Give Duplicate Its Own Name', async () => {
      seedDuplicate();
      fs.writeFileSync(COPY(), "use { table gold.dim_region } from '../../../gold/tables/gold/dim_region.dbml'\nTable silver.dim_customer {\n  customer_key INT [pk]\n}\n");
      const before = bytes();
      await activate(context);
      vi.spyOn(vscode.window, 'showInputBox').mockImplementation((async (o: { value?: string }) => o.value) as never);
      vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async (...args: unknown[]) =>
        (args.includes('Rename') ? 'Rename' : undefined)) as never);
      await vscode.commands.executeCommand('erdStudio.resolveDuplicateModel', COPY());
      const modal = refusalModal();
      expect(modal.message).toMatch(/^Give Duplicate Its Own Name: silver\/tables\/silver\/dim_customer\.dbml: .* Nothing was changed\.$/);
      expect(modal.detail).toBe('File: .erd-studio/silver/tables/silver/dim_customer.dbml, line 1');
      expect(modal.buttons).toEqual(['Open File']);
      expect(bytes()).toEqual(before);
    });

    it('Rename Subject Area', async () => {
      fs.appendFileSync(salesPath(), '\nProject second {\n  Note: \'again\'\n}\n');
      const before = bytes();
      await activate(context);
      vi.spyOn(vscode.window, 'showInputBox').mockResolvedValueOnce('revenue');
      await vscode.commands.executeCommand('erdStudio.renameDomain', {
        type: 'domain', summary: { domain: 'sales', layer: 'gold', filePath: salesPath(), storage: 'dbml' },
      });
      const modal = refusalModal();
      expect(modal.message).toMatch(/^Rename Diagram: gold\/diagrams\/sales\.dbml: .* Nothing was changed\.$/);
      expect(modal.detail).toBe('File: .erd-studio/gold/diagrams/sales.dbml');
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
