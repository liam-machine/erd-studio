/**
 * `erdStudio.importDbml` as `activate()` wires it: registered once with no
 * `dbtSemantic.*` alias, the no-project stub without a project, and — with
 * the real services over a temp copy of the fixture project — a DBML file
 * picked in the Open dialog, read through `workspace.fs`, written as a new
 * subject area and opened on the canvas, through the real `vscodeImportDbmlUi`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { activate, _resetFirstRunGuardForTests } from '../../src/extension';
import { SUBJECT_AREA_EDITOR_VIEW_TYPE } from '../../src/services/recoveryService';
import { subjectAreaTableNames } from '../../src/services/domainService';

const REPO_ROOT = path.resolve(__dirname, '../..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'test', 'fixtures', 'dbt-project');
const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));

type Context = import('vscode').ExtensionContext;

function makeContext(root: string): Context {
  const globalState = new Map<string, unknown>([['erdStudio.gettingStartedShown', true]]);
  const workspaceState = new Map<string, unknown>([
    ['erdStudio.harnessInstallPrompted', true],
    ['erdStudio.diagramsNudgeShown', true],
  ]);
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

const count = (command: string) => vscode._registeredCommands.filter((c) => c.command === command).length;

let root: string;
let inbox: string;
let context: Context;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-import-activate-'));
  inbox = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-import-activate-in-'));
  context = makeContext(root);
  vscode._resetRegisteredCommands();
  vscode._resetMockConfiguration();
  vscode._resetMockWorkspace();
  vscode._clearMockFileWatchers();
  vscode._resetMockGithubSession();
  vscode._resetMockLanguageModels();
  vscode.workspace.workspaceFolders = [];
  vscode.window.tabGroups.all = [];
  vscode.window.tabGroups.activeTabGroup.activeTab = undefined;
  vscode._resetMockWebviewPanels();
  vscode._setMockExtensions([]);
  _resetFirstRunGuardForTests();
  vi.stubEnv('HOME', root);
  vi.stubEnv('USERPROFILE', root);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
  vi.useFakeTimers();
});

afterEach(async () => {
  for (const sub of [...context.subscriptions].reverse()) {
    try { await sub.dispose(); } catch { /* best effort */ }
  }
  for (const panel of [...vscode.window._webviewPanels]) { panel.dispose(); }
  vscode._resetMockWebviewPanels();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(inbox, { recursive: true, force: true });
});

describe('erdStudio.importDbml in activate()', () => {
  it('in an empty window: the no-project stub, and no legacy alias', async () => {
    const warn = vi.mocked(vscode.window.showWarningMessage);
    await activate(context);

    expect(count('erdStudio.importDbml')).toBe(1);
    expect(count('dbtSemantic.importDbml')).toBe(0);
    await vscode.commands.executeCommand('erdStudio.importDbml');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Open a folder first'), 'Open Folder…', 'Open Settings');
  });

  it('in a plain folder (no dbt_project.yml, no .erd-studio): makes layers.json (one Main layer), the README, the diagram in main/diagrams/ and its table in main/tables/main/', async () => {
    const plain = path.join(root, 'plain');
    fs.mkdirSync(plain);
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(plain), name: 'plain', index: 0 }];
    await activate(context);

    const dbml = path.join(inbox, 'shop.dbml');
    fs.writeFileSync(dbml, 'Table shop_customer {\n  id int [pk]\n}\n');
    vi.spyOn(vscode.window, 'showOpenDialog').mockResolvedValue([vscode.Uri.file(dbml)] as never);
    vi.spyOn(vscode.workspace.fs, 'readFile').mockImplementation((async (uri: vscode.Uri) => fs.readFileSync(uri.fsPath)) as never);
    vi.spyOn(vscode.workspace.fs, 'stat').mockImplementation((async (uri: vscode.Uri) => {
      if (!fs.existsSync(uri.fsPath)) throw new Error('FileNotFound');
      return { type: 1, ctime: 0, mtime: 0, size: 0 };
    }) as never);
    // One layer: no layer question.
    const pick = vi.spyOn(vscode.window, 'showQuickPick');
    vi.spyOn(vscode.window, 'showInputBox').mockImplementation((async (o?: { value?: string }) => o?.value) as never);
    vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async (...args: unknown[]) =>
      (typeof args[1] === 'object' && (args[1] as { modal?: boolean }).modal ? 'Import' : undefined)) as never);

    await vscode.commands.executeCommand('erdStudio.importDbml');

    expect(pick).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(path.join(plain, '.erd-studio', 'layers.json'), 'utf-8')).layers.map((l: { id: string }) => l.id)).toEqual(['main']);
    // A new project stores its model as DBML (native DBML storage, §3.2).
    expect(fs.existsSync(path.join(plain, '.erd-studio', 'README.md'))).toBe(true);
    const diagram = path.join(plain, '.erd-studio', 'main', 'diagrams', 'shop.dbml');
    expect(subjectAreaTableNames(fs.readFileSync(diagram, 'utf-8'), diagram)).toEqual(['shop_customer']);
    expect(fs.readFileSync(path.join(plain, '.erd-studio', 'main', 'tables', 'main', 'shop_customer.dbml'), 'utf-8')).toMatch(/^Table main\.shop_customer \{/);
  });

  it('with a project: picks the file, reads it (positions in its erd_layout) through workspace.fs, writes the diagram and opens it', async () => {
    fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root), name: path.basename(root), index: 0 }];
    await activate(context);
    expect(count('erdStudio.importDbml')).toBe(1);
    expect(count('dbtSemantic.importDbml')).toBe(0);

    const dbml = path.join(inbox, 'shop.dbml');
    fs.writeFileSync(dbml, 'Table shop_customer {\n  id int [pk]\n}\n\nTable shop_order {\n  id int [pk]\n  customer_id int [ref: > shop_customer.id]\n}\n\n'
      + "Project shop {\n  erd_layout: '''\n    shop_customer 1 2\n  '''\n}\n");
    const dialog = vi.spyOn(vscode.window, 'showOpenDialog').mockResolvedValue([vscode.Uri.file(dbml)] as never);
    vi.spyOn(vscode.workspace.fs, 'readFile').mockImplementation((async (uri: vscode.Uri) => fs.readFileSync(uri.fsPath)) as never);
    vi.spyOn(vscode.workspace.fs, 'stat').mockImplementation((async (uri: vscode.Uri) => {
      if (!fs.existsSync(uri.fsPath)) throw new Error('FileNotFound');
      return { type: 1, ctime: 0, mtime: 0, size: 0 };
    }) as never);
    vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (items: Array<{ id?: string }>) =>
      items.find((i) => i.id === 'gold')) as never);
    vi.spyOn(vscode.window, 'showInputBox').mockImplementation((async (o?: { value?: string }) => o?.value) as never);
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async (...args: unknown[]) =>
      (typeof args[1] === 'object' && (args[1] as { modal?: boolean }).modal ? 'Import' : undefined)) as never);
    const real = vscode.commands.executeCommand;
    const exec = vi.spyOn(vscode.commands, 'executeCommand').mockImplementation((async (command: string, ...args: unknown[]) =>
      real(command, ...args)) as never);

    await vscode.commands.executeCommand('erdStudio.importDbml');

    expect(dialog.mock.calls[0][0]).toMatchObject({ filters: { DBML: ['dbml'] }, canSelectMany: false, openLabel: 'Import' });
    const domainPath = path.join(root, '.erd-studio', 'gold', 'shop.json');
    const doc = JSON.parse(fs.readFileSync(domainPath, 'utf-8'));
    expect(doc.logical.models).toEqual(['shop_customer', 'shop_order']);
    expect(doc.viewConfig.positions).toEqual({ shop_customer: { x: 1, y: 2 } });
    // The fixture library is flat: the new tables go at its top level.
    expect(fs.existsSync(path.join(root, '.erd-studio', 'logical-models', 'shop_customer.yml'))).toBe(true);
    // The dry run was a modal whose detail lists the layout.
    const modal = info.mock.calls.find((c) => typeof c[1] === 'object')!;
    expect(String(modal[0])).toBe('Import 2 tables into a new diagram "shop" in the Gold layer.');
    expect((modal[1] as { detail: string }).detail).toContain("1 of 2 tables placed from the file's erd_layout");
    expect(exec).toHaveBeenCalledWith('vscode.openWith', expect.objectContaining({ fsPath: domainPath }), SUBJECT_AREA_EDITOR_VIEW_TYPE);
  });
});
