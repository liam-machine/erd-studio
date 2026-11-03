/**
 * The sidebar filters wired by `activate()` on a copy of
 * `test/fixtures/dbml-native`: Filter Table Library… opens the box and
 * filters the view (its message, description and context key follow), Clear
 * Filter restores it, and Reveal in Table Library on a table the filter hides
 * clears the filter first instead of saying the table is not there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { activate, _resetFirstRunGuardForTests } from '../../src/extension';
import type { TableLibraryNode, TableLibraryTreeProvider } from '../../src/providers/ModelLibraryTreeProvider';
import type { RelationshipsTreeProvider } from '../../src/providers/RelationshipsTreeProvider';

const REPO_ROOT = path.resolve(__dirname, '../..');
const DBML_NATIVE = path.join(REPO_ROOT, 'test', 'fixtures', 'dbml-native');
const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));

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

/** A tree view stand-in that keeps what the extension sets on it. */
type FakeView = { id: string; options: { treeDataProvider: unknown }; message?: string; description?: string; reveal: ReturnType<typeof vi.fn>; dispose(): void };

let root: string;
let ws: string;
let context: Context;
let views: FakeView[];
let box: { value: string; type(v: string): void; enter(): void } | undefined;
const windowWithBox = vscode.window as unknown as { createInputBox?: () => unknown };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-filter-activate-'));
  ws = path.join(root, 'project');
  context = makeContext(root);
  vscode._resetRegisteredCommands();
  vscode._resetMockConfiguration();
  vscode._resetMockWorkspace();
  vscode._clearMockFileWatchers();
  vscode._resetMockWebviewPanels();
  vscode.window.tabGroups.all = [];
  _resetFirstRunGuardForTests();
  vi.stubEnv('HOME', root);
  vi.stubEnv('USERPROFILE', root);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
  vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
  vi.useFakeTimers();
  fs.cpSync(DBML_NATIVE, ws, { recursive: true });
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(ws), name: path.basename(ws), index: 0 }];
  views = [];
  vi.spyOn(vscode.window, 'createTreeView').mockImplementation(((id: string, options: { treeDataProvider: unknown }) => {
    const view: FakeView = { id, options, reveal: vi.fn(async () => undefined), dispose() {} };
    views.push(view);
    return view;
  }) as never);
  // The mock has no createInputBox: a box a test can type into.
  windowWithBox.createInputBox = () => {
    const listeners: Record<string, (v?: unknown) => void> = {};
    const b = {
      value: '', title: '', placeholder: '', prompt: '',
      show() {}, hide() { listeners.hide?.(); }, dispose() {},
      onDidChangeValue(fn: (v: string) => void) { listeners.value = fn as (v?: unknown) => void; return { dispose() {} }; },
      onDidAccept(fn: () => void) { listeners.accept = fn; return { dispose() {} }; },
      onDidHide(fn: () => void) { listeners.hide = fn; return { dispose() {} }; },
      type(v: string) { b.value = v; listeners.value?.(v); },
      enter() { listeners.accept?.(); },
    };
    box = b;
    return b;
  };
});

afterEach(async () => {
  for (const sub of [...context.subscriptions].reverse()) {
    try { await sub.dispose(); } catch { /* best effort */ }
  }
  delete windowWithBox.createInputBox;
  box = undefined;
  vscode._resetMockWebviewPanels();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

const viewOf = (id: string): FakeView => views.find((v) => v.id === id)!;

describe('the sidebar filters, wired', () => {
  it('Filter Table Library… filters the view and says so; Clear Filter restores it', async () => {
    const exec = vi.spyOn(vscode.commands, 'executeCommand');
    await activate(context);
    const view = viewOf('erdStudio.modelLibrary');
    const provider = view.options.treeDataProvider as TableLibraryTreeProvider;
    // Not filtered, the view's title shows its total.
    provider.getChildren();
    expect(view.description).toBe('6 tables');

    const opened = vscode.commands.executeCommand('erdStudio.filterTableLibrary');
    box!.type('customer');
    box!.enter();
    await opened;
    expect(provider.getFilter()).toBe('customer');
    expect(exec).toHaveBeenCalledWith('setContext', 'erdStudio.tableLibraryFiltered', true);
    provider.getChildren();
    expect(view.message).toBe('Filtered: "customer" — 2 of 6 tables');
    expect(view.description).toBe('customer');

    await vscode.commands.executeCommand('erdStudio.clearTableLibraryFilter');
    expect(provider.getFilter()).toBe('');
    expect(view.message).toBeUndefined();
    // Clearing puts the total back.
    expect(view.description).toBe('6 tables');
    expect(exec).toHaveBeenCalledWith('setContext', 'erdStudio.tableLibraryFiltered', false);
  });

  it('Reveal in Table Library clears a filter that hides the table, then reveals it', async () => {
    await activate(context);
    const view = viewOf('erdStudio.modelLibrary');
    const provider = view.options.treeDataProvider as TableLibraryTreeProvider;
    const opened = vscode.commands.executeCommand('erdStudio.filterTableLibrary');
    box!.type('layer:silver');
    box!.enter();
    await opened;
    provider.getChildren();

    await vscode.commands.executeCommand('erdStudio.revealInTableLibrary', 'fct_order');
    expect(provider.getFilter()).toBe('');
    expect(view.reveal).toHaveBeenCalledTimes(1);
    expect((view.reveal.mock.calls[0][0] as TableLibraryNode)).toMatchObject({ type: 'model', name: 'fct_order' });
  });

  it('Reveal in Table Library leaves a filter that shows the table', async () => {
    await activate(context);
    const view = viewOf('erdStudio.modelLibrary');
    const provider = view.options.treeDataProvider as TableLibraryTreeProvider;
    provider.setFilter('fct');
    await vscode.commands.executeCommand('erdStudio.revealInTableLibrary', 'fct_order');
    expect(provider.getFilter()).toBe('fct');
    expect((view.reveal.mock.calls[0][0] as TableLibraryNode)).toMatchObject({ type: 'model', name: 'fct_order' });
  });

  it('Filter Diagrams… filters the Diagrams view through its real provider', async () => {
    await activate(context);
    const view = viewOf('erdStudio.domainTree');
    const opened = vscode.commands.executeCommand('erdStudio.filterDiagrams');
    box!.type('staging');
    box!.enter();
    await opened;
    // The view's provider is the deferred one (its first answer is empty, the welcome shows meanwhile);
    // the filter is on the real provider behind it.
    const deferred = view.options.treeDataProvider as { getChildren(): unknown };
    await deferred.getChildren();
    await vi.advanceTimersByTimeAsync(10);
    const rows = (await deferred.getChildren()) as Array<{ type: string; layer?: string }>;
    expect(rows.map((r) => r.layer ?? r.type)).toEqual(['silver']);
    expect(view.message).toBe('Filtered: "staging" — 1 of 2 diagrams');
    expect(view.description).toBe('staging');
    await vscode.commands.executeCommand('erdStudio.clearDiagramsFilter');
    expect(view.description).toBe('2 diagrams');
  });
});

describe('the sidebar views, wired: header totals and Show / Hide Row Details', () => {
  it('shows each view\'s total beside its title once listed', async () => {
    await activate(context);
    const diagrams = viewOf('erdStudio.domainTree');
    const deferred = diagrams.options.treeDataProvider as { getChildren(): unknown };
    await deferred.getChildren();
    await vi.advanceTimersByTimeAsync(10);
    await deferred.getChildren();
    expect(diagrams.description).toBe('2 diagrams');

    const library = viewOf('erdStudio.modelLibrary');
    (library.options.treeDataProvider as TableLibraryTreeProvider).getChildren();
    expect(library.description).toBe('6 tables');

    const relationships = viewOf('erdStudio.relationships');
    const relProvider = relationships.options.treeDataProvider as RelationshipsTreeProvider;
    const listing = relProvider.getChildren();
    await vi.advanceTimersByTimeAsync(10);
    await listing;
    const total = relProvider.lastOverview()!.entries.length;
    expect(total).toBeGreaterThan(1);
    // The header names the grouping too: by file is the default.
    expect(relationships.description).toBe(`${total} relationships · by file`);
  });

  it('Show Row Details writes the setting at user scope, sets the context key and redraws every tree; Hide Row Details undoes it', async () => {
    const exec = vi.spyOn(vscode.commands, 'executeCommand');
    await activate(context);
    const trees = ['erdStudio.domainTree', 'erdStudio.modelLibrary', 'erdStudio.relationships']
      .map((id) => viewOf(id).options.treeDataProvider);
    const library = trees[1] as TableLibraryTreeProvider;
    const relationships = trees[2] as RelationshipsTreeProvider;
    // Compact by default.
    expect(exec).toHaveBeenCalledWith('setContext', 'erdStudio.sidebarRowDetails', 'compact');
    expect([library.getRowDetails(), relationships.getRowDetails()]).toEqual(['compact', 'compact']);
    const redrawn = vi.fn();
    library.onDidChangeTreeData(redrawn);

    await vscode.commands.executeCommand('erdStudio.showRowDetails');
    expect(vscode.workspace.getConfiguration('erdStudio').inspect('sidebar.rowDetails')).toMatchObject({ globalValue: 'full' });
    expect(exec).toHaveBeenCalledWith('setContext', 'erdStudio.sidebarRowDetails', 'full');
    expect([library.getRowDetails(), relationships.getRowDetails()]).toEqual(['full', 'full']);
    expect(redrawn).toHaveBeenCalled();

    await vscode.commands.executeCommand('erdStudio.hideRowDetails');
    expect(vscode.workspace.getConfiguration('erdStudio').inspect('sidebar.rowDetails')).toMatchObject({ globalValue: 'compact' });
    expect(exec).toHaveBeenLastCalledWith('setContext', 'erdStudio.sidebarRowDetails', 'compact');
    expect(library.getRowDetails()).toBe('compact');
  });

  it('starts in full mode when the setting says so', async () => {
    vscode._setMockConfiguration('erdStudio', 'sidebar.rowDetails', { globalValue: 'full' });
    await activate(context);
    const library = viewOf('erdStudio.modelLibrary').options.treeDataProvider as TableLibraryTreeProvider;
    expect(library.getRowDetails()).toBe('full');
  });
});
