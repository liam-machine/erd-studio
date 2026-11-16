/**
 * #335, wired by `activate()` on a copy of `test/fixtures/dbml-native`:
 * Table Library rows dropped on a diagram's row whose add then fails offer
 * Try Again, which adds the same tables again. The drop that named no table
 * itself (its names were lost on the way) found them in the remembered
 * Table Library drag, which the first attempt used up: Try Again still adds
 * them, rather than saying the drop named no table.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { activate, _resetFirstRunGuardForTests } from '../../src/extension';

const REPO_ROOT = path.resolve(__dirname, '../..');
const DBML_NATIVE = path.join(REPO_ROOT, 'test', 'fixtures', 'dbml-native');
const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
const LIBRARY_TREE_MIME = 'application/vnd.code.tree.erdstudio.modellibrary';

type Context = import('vscode').ExtensionContext;
type Controller = { handleDrag(source: unknown[], dt: vscode.DataTransfer): unknown; handleDrop(target: unknown, dt: vscode.DataTransfer, token: unknown): Promise<void> };

let root: string;
let ws: string;
let context: Context;
let views: Array<{ id: string; options: { dragAndDropController?: Controller } }>;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-tree-drop-retry-'));
  ws = path.join(root, 'project');
  // The glass sidebar off: the native Diagrams view takes the drop.
  const globalState = new Map<string, unknown>([['erdStudio.gettingStartedShown', true], ['erdStudio.glassSidebar.enabled', false]]);
  const workspaceState = new Map<string, unknown>([['erdStudio.harnessInstallPrompted', true], ['erdStudio.diagramsNudgeShown', true]]);
  context = {
    subscriptions: [],
    extension: { packageJSON: packageJson },
    extensionUri: vscode.Uri.file(REPO_ROOT),
    globalStorageUri: vscode.Uri.file(path.join(root, '.global-storage')),
    globalState: { get: (k: string) => globalState.get(k), update: async (k: string, v: unknown) => { globalState.set(k, v); } },
    workspaceState: { get: (k: string) => workspaceState.get(k), update: async (k: string, v: unknown) => { workspaceState.set(k, v); } },
    secrets: vscode.createMockSecretStorage(),
  } as unknown as Context;
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
  fs.cpSync(DBML_NATIVE, ws, { recursive: true });
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(ws), name: path.basename(ws), index: 0 }];
  views = [];
  vi.spyOn(vscode.window, 'createTreeView').mockImplementation(((id: string, options: { dragAndDropController?: Controller }) => {
    const view = { id, options, reveal: async () => undefined, dispose() {} };
    views.push(view);
    return view;
  }) as never);
});

afterEach(async () => {
  for (const sub of [...context.subscriptions].reverse()) {
    try { await sub.dispose(); } catch { /* best effort */ }
  }
  vscode._resetMockWebviewPanels();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('#335: Try Again after tables dropped on a diagram row failed to be added', () => {
  it('adds the same tables again, from the drag the first attempt used up', async () => {
    await activate(context);
    const library = views.find((v) => v.id === 'erdStudio.modelLibrary')!.options.dragAndDropController!;
    const diagrams = views.find((v) => v.id === 'erdStudio.domainTree')!.options.dragAndDropController!;
    const diagram = path.join(ws, '.erd-studio', 'gold', 'diagrams', 'sales.dbml');
    const table = path.join(ws, '.erd-studio', 'gold', 'tables', 'gold', 'fct_order.dbml');

    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    const errors = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValueOnce('Try Again' as never).mockResolvedValue(undefined);
    const realExec = vscode.commands.executeCommand.bind(vscode.commands);
    const opened: string[] = [];
    vi.spyOn(vscode.commands, 'executeCommand').mockImplementation((async (command: string, ...args: unknown[]) => {
      if (command === 'erdStudio.openDomain') {
        opened.push(String(args[0]));
        if (opened.length === 1) throw new Error('boom');
        return undefined;
      }
      return realExec(command, ...args);
    }) as never);

    // The Table Library drag is remembered; the drop on the row lost its names (only VS Code's own entry).
    library.handleDrag([{ type: 'model', name: 'fct_order', filePath: table, layer: 'gold', folder: 'gold', referencingDomains: [] }], new vscode.DataTransfer());
    const drop = new vscode.DataTransfer();
    drop.set(LIBRARY_TREE_MIME, new vscode.DataTransferItem('{"id":"erdStudio.modelLibrary","itemHandles":["0/0:x"]}'));
    await diagrams.handleDrop({ type: 'domain', summary: { domain: 'sales', layer: 'gold', filePath: diagram }, modelCount: 1 }, drop, {});

    await vi.waitFor(() => expect(opened).toHaveLength(2));
    expect(opened).toEqual([diagram, diagram]);
    const first = errors.mock.calls[0] as unknown[];
    expect(String(first[0])).toBe("Add to Diagram hit a problem in ERD Studio while adding the tables, so nothing was added to sales. This isn't something you did. Please send us a report.");
    expect(first.slice(1)).toEqual(['Send Feedback', 'Try Again']);
    // The retry found the tables: never "the drop named no table".
    expect(info.mock.calls.map((c) => String(c[0])).filter((m) => /named no table/.test(m))).toEqual([]);
    expect(errors).toHaveBeenCalledTimes(1);
  });

  it("Try Again on an older failed drop adds that drop's tables, never a later drop's, and never times a drag again", async () => {
    await activate(context);
    const library = views.find((v) => v.id === 'erdStudio.modelLibrary')!.options.dragAndDropController!;
    const diagrams = views.find((v) => v.id === 'erdStudio.domainTree')!.options.dragAndDropController!;
    const diagram = path.join(ws, '.erd-studio', 'gold', 'diagrams', 'sales.dbml');
    const table = path.join(ws, '.erd-studio', 'gold', 'tables', 'gold', 'fct_order.dbml');

    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    // The first drop's toast stays up until the second drop has failed too; then Try Again is chosen on it.
    let chooseOnFirst: (choice: string | undefined) => void = () => undefined;
    const errors = vi.spyOn(vscode.window, 'showErrorMessage')
      .mockImplementationOnce((() => new Promise((resolve) => { chooseOnFirst = resolve; })) as never)
      .mockResolvedValue(undefined);
    const realExec = vscode.commands.executeCommand.bind(vscode.commands);
    const opened: string[] = [];
    vi.spyOn(vscode.commands, 'executeCommand').mockImplementation((async (command: string, ...args: unknown[]) => {
      if (command === 'erdStudio.openDomain') {
        opened.push(String(args[0]));
        if (opened.length <= 2) throw new Error('boom');
        return undefined;
      }
      return realExec(command, ...args);
    }) as never);
    const { SemanticEditorProvider } = await import('../../src/providers/SemanticEditorProvider');
    const added = vi.spyOn(SemanticEditorProvider.prototype, 'addTablesToDiagram').mockResolvedValue([]);
    const seen = vi.spyOn(SemanticEditorProvider.prototype, 'noteDropSeen');

    // Drop 1: fct_order, its names lost on the way (found in the remembered drag).
    library.handleDrag([{ type: 'model', name: 'fct_order', filePath: table, layer: 'gold', folder: 'gold', referencingDomains: [] }], new vscode.DataTransfer());
    const first = new vscode.DataTransfer();
    first.set(LIBRARY_TREE_MIME, new vscode.DataTransferItem('{"id":"erdStudio.modelLibrary","itemHandles":["0/0:x"]}'));
    await diagrams.handleDrop({ type: 'domain', summary: { domain: 'sales', layer: 'gold', filePath: diagram }, modelCount: 1 }, first, {});
    // Drop 2, on the same diagram: dim_region, named by the drop.
    const second = new vscode.DataTransfer();
    second.set(LIBRARY_TREE_MIME, new vscode.DataTransferItem(['dim_region']));
    await diagrams.handleDrop({ type: 'domain', summary: { domain: 'sales', layer: 'gold', filePath: diagram }, modelCount: 1 }, second, {});
    await vi.waitFor(() => expect(errors).toHaveBeenCalledTimes(2));
    expect(seen).toHaveBeenCalledTimes(2);

    chooseOnFirst('Try Again');
    await vi.waitFor(() => expect(added).toHaveBeenCalledTimes(1));
    expect(added.mock.calls[0][1]).toEqual(['fct_order']);
    // A retry is the same drop: it never starts the drop timer again.
    expect(seen).toHaveBeenCalledTimes(2);
  });
});
