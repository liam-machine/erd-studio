/**
 * extension.activate() — command surface and activation ordering.
 *
 * Runs the real activate() against the vscode mock three ways: with no
 * workspace folder (the "open a folder first" early return), against a temp
 * copy of the fixture dbt project (full activation), and against plain
 * folders with no dbt_project.yml (full activation, logical-only). Asserts the contracts CLAUDE.md calls
 * load-bearing: every contributed erdStudio.* command is registered exactly
 * once, each has a code-only dbtSemantic.* alias that delegates to it,
 * erdStudio.reportBug is registered before any early return, and settings
 * flow through getErdStudioSetting (a legacy dbtSemantic.projectPath still
 * resolves the project root).
 *
 * The mock's registerCommand throws on a duplicate id, like VS Code does, so
 * a double registration fails activation here rather than in production.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  activate,
  DIAGRAMS_NUDGE_SHOWN_KEY,
  DIAGRAMS_STATUS_ID,
  GETTING_STARTED_NO_PROJECT_SHOWN_KEY,
  GETTING_STARTED_PENDING_KEY,
  GETTING_STARTED_SHOWN_KEY,
  NO_LEGACY_ALIAS,
  PRE_REGISTERED_COMMANDS,
  WALKTHROUGH_ID,
  _resetFirstRunGuardForTests,
} from '../../src/extension';
import { GETTING_STARTED_VIEW_TYPE, GettingStartedPanel } from '../../src/providers/GettingStartedPanel';
import { SUBJECT_AREA_EDITOR_VIEW_TYPE } from '../../src/services/recoveryService';
import type { SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import { telemetry } from '../../src/services/telemetryService';
import { clearLogBuffer, hasLogSink, recentLogLines } from '../../src/services/logger';

import { parseSubjectAreaDbml } from '@erd-studio/core/dbml';

/** The message of the last "Found dbt project" line in the ERD Studio log (it no longer goes to console.log). */
const lastFoundProjectLine = (): string | undefined =>
  recentLogLines().filter((l) => l.includes('Found dbt project at')).at(-1)?.replace(/^\S+ \[info\] /, '');

const REPO_ROOT = path.resolve(__dirname, '../..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'test', 'fixtures', 'dbt-project');
const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8')) as {
  version: string;
  contributes: { commands: Array<{ command: string }> };
};
const CONTRIBUTED = packageJson.contributes.commands.map((c) => c.command);
const legacyAlias = (command: string) => command.replace(/^erdStudio\./, 'dbtSemantic.');

type Context = import('vscode').ExtensionContext;

function makeContext(
  root: string,
  opts: { globalState?: Map<string, unknown>; workspaceState?: Map<string, unknown> } = {},
): Context {
  // The Welcome panel was already shown on this "machine", so the first-run
  // trigger stays out of the way of the tests that are not about it.
  const globalState = opts.globalState ?? new Map<string, unknown>([['erdStudio.gettingStartedShown', true]]);
  // Pretend the harness-install QuickPick and the existing-diagrams notice
  // were already offered for this workspace.
  const workspaceState = opts.workspaceState ?? new Map<string, unknown>([
    ['erdStudio.harnessInstallPrompted', true],
    ['erdStudio.diagramsNudgeShown', true],
  ]);
  return {
    subscriptions: [],
    extension: { packageJSON: packageJson },
    extensionUri: vscode.Uri.file(REPO_ROOT),
    globalStorageUri: vscode.Uri.file(path.join(root, '.global-storage')),
    globalState: {
      get: (key: string) => globalState.get(key),
      update: async (key: string, value: unknown) => { globalState.set(key, value); },
    },
    workspaceState: {
      get: (key: string) => workspaceState.get(key),
      update: async (key: string, value: unknown) => { workspaceState.set(key, value); },
    },
    secrets: vscode.createMockSecretStorage(),
  } as unknown as Context;
}

const registered = () => vscode._registeredCommands.map((c) => c.command);
const count = (command: string) => registered().filter((c) => c === command).length;

function openWorkspace(dir: string): void {
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(dir), name: path.basename(dir), index: 0 }];
}

let root: string;
let context: Context;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-activate-'));
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
  // os.homedir() follows HOME: keep the launcher refresh away from the real ~/.erd-studio-cli.
  vi.stubEnv('HOME', root);
  vi.stubEnv('USERPROFILE', root);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  warn = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
  // Activation schedules debounced work (selectors.yml regeneration); keep it
  // from firing against a temp dir that afterEach removes.
  vi.useFakeTimers();
});

afterEach(async () => {
  for (const sub of [...context.subscriptions].reverse()) {
    try {
      await sub.dispose();
    } catch {
      // best effort
    }
  }
  for (const panel of [...vscode.window._webviewPanels]) { panel.dispose(); }
  vscode._resetMockWebviewPanels();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('activate() with no folder open (empty window)', () => {
  it('registers erdStudio.reportBug first, then a fallback for every other command and its legacy alias', async () => {
    await activate(context);

    expect(registered()[0]).toBe('erdStudio.reportBug');
    for (const command of CONTRIBUTED) {
      expect(count(command), command).toBe(1);
      // Post-rename ids never gained a dbtSemantic.* alias — but the stub for
      // the erdStudio.* id is still registered, so nothing reports "command
      // not found".
      expect(count(legacyAlias(command)), legacyAlias(command)).toBe(
        NO_LEGACY_ALIAS.has(command) ? 0 : 1,
      );
    }
    // No toast on activation: the sidebar's welcome view explains a missing project.
    expect(warn).not.toHaveBeenCalled();
  });

  it('still reports an erdStudio.projectPath that points at no dbt project', async () => {
    vscode._setMockConfiguration('erdStudio', 'projectPath', { workspaceValue: '/nowhere/analytics' });
    await activate(context);
    expect(warn).toHaveBeenCalledWith(
      'ERD Studio: erdStudio.projectPath "/nowhere/analytics" is not a folder.',
      'Open Settings',
    );
  });

  it('Draw from dbt gets the no-project stub and no legacy alias', async () => {
    expect(CONTRIBUTED).toContain('erdStudio.drawFromDbt');
    expect(NO_LEGACY_ALIAS.has('erdStudio.drawFromDbt')).toBe(true);
    await activate(context);
    expect(count('erdStudio.drawFromDbt')).toBe(1);
    expect(count('dbtSemantic.drawFromDbt')).toBe(0);

    await vscode.commands.executeCommand('erdStudio.drawFromDbt');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Open a folder first'), 'Open Folder…', 'Open Settings');
  });

  it('Export Diagram gets the no-project stub and no legacy alias', async () => {
    expect(CONTRIBUTED).toContain('erdStudio.exportDiagram');
    expect(NO_LEGACY_ALIAS.has('erdStudio.exportDiagram')).toBe(true);
    await activate(context);
    expect(count('erdStudio.exportDiagram')).toBe(1);
    expect(count('dbtSemantic.exportDiagram')).toBe(0);

    await vscode.commands.executeCommand('erdStudio.exportDiagram');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Open a folder first'), 'Open Folder…', 'Open Settings');
  });

  it('registers a stub domain editor and no tree views (early return)', async () => {
    const registerEditor = vi.spyOn(vscode.window, 'registerCustomEditorProvider');
    const createTreeView = vi.spyOn(vscode.window, 'createTreeView');

    await activate(context);

    expect(registerEditor).toHaveBeenCalledTimes(1);
    expect(registerEditor.mock.calls[0][0]).toBe(SUBJECT_AREA_EDITOR_VIEW_TYPE);
    expect(createTreeView).not.toHaveBeenCalled();

    // The stub editor explains why nothing renders instead of showing a blank webview.
    const stub = registerEditor.mock.calls[0][1] as unknown as {
      resolveCustomTextEditor(doc: unknown, panel: unknown): void;
    };
    const panel = vscode.createMockWebviewPanel();
    stub.resolveCustomTextEditor({}, panel);
    expect(panel.webview.html).toContain('ERD Studio is inactive');
    expect(panel.webview.options).toEqual({ enableScripts: false });
  });

  it('fallback commands (and their aliases) explain the problem instead of "command not found"', async () => {
    await activate(context);
    const before = warn.mock.calls.length;

    await vscode.commands.executeCommand('erdStudio.createDomain');
    await vscode.commands.executeCommand('dbtSemantic.addLayer');

    expect(warn).toHaveBeenCalledTimes(before + 2);
    expect(warn.mock.calls.at(-1)?.[0]).toContain('Open a folder first');
  });

  it('erdStudio.reportBug is live before the early return: cancelling the title opens nothing', async () => {
    await activate(context);
    const pick = vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue('Report a bug');
    const input = vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue(undefined);
    const open = vi.spyOn(vscode.env, 'openExternal');

    await vscode.commands.executeCommand('erdStudio.reportBug');

    expect(pick).toHaveBeenCalledTimes(1);
    expect(pick.mock.calls[0][0]).toEqual(['Report a bug', 'Request a feature']);
    expect(input).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
  });

  it('cancelling the kind QuickPick abandons the report before any input box', async () => {
    await activate(context);
    const pick = vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue(undefined);
    const input = vi.spyOn(vscode.window, 'showInputBox');
    const open = vi.spyOn(vscode.env, 'openExternal');

    await vscode.commands.executeCommand('erdStudio.reportBug');

    expect(pick).toHaveBeenCalledTimes(1);
    expect(input).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('picking "Request a feature" opens the feature-request template', async () => {
    await activate(context);
    vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue('Request a feature');
    vi.spyOn(vscode.window, 'showInputBox')
      .mockResolvedValueOnce('Multi-domain search')
      .mockResolvedValueOnce('So I can find a model anywhere');
    const open = vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(true);

    await vscode.commands.executeCommand('erdStudio.reportBug');

    const url = decodeURIComponent(String(open.mock.calls[0][0]).replace(/\+/g, ' '));
    expect(url).toContain('template=feature_request.yml');
    expect(url).toContain('title=Multi-domain search');
  });

  it('erdStudio.reportBug without a canvas gathers title + description and opens the prefilled issue', async () => {
    await activate(context);
    vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue('Report a bug');
    const input = vi.spyOn(vscode.window, 'showInputBox')
      .mockResolvedValueOnce('Palette crash')
      .mockResolvedValueOnce('It exploded');
    const open = vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(true);

    await vscode.commands.executeCommand('erdStudio.reportBug', { title: 'Seeded title' });

    expect(input).toHaveBeenCalledTimes(2);
    expect((input.mock.calls[0][0] as { value?: string }).value).toBe('Seeded title');
    expect(open).toHaveBeenCalledTimes(1);
    const url = decodeURIComponent(String(open.mock.calls[0][0]).replace(/\+/g, ' '));
    expect(url).toContain('https://github.com/liam-machine/erd-studio/issues/new?template=bug_report.yml');
    expect(url).toContain('title=Palette crash');
    expect(url).toContain('description=It exploded');
    expect(url).toContain(`ERD Studio: ${packageJson.version}`);
  });
});

describe('activate() with a dbt project', () => {
  beforeEach(() => {
    fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
    openWorkspace(root);
  });

  it('usage telemetry: a dbt project is not a logical-only one, and New Diagram there is no blank start', async () => {
    const featureOnce = vi.spyOn(telemetry, 'featureOnce');
    const feature = vi.spyOn(telemetry, 'feature');
    await activate(context);
    expect(featureOnce).not.toHaveBeenCalledWith('logicalOnlyProject');
    vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (items: Array<{ value?: string }>) =>
      items.find((i) => i.value === 'gold') ?? items[0]) as never);
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValueOnce('telemetry-check').mockResolvedValueOnce('');
    await vscode.commands.executeCommand('erdStudio.createDomain');
    expect(feature).toHaveBeenCalledWith('domainCreated');
    expect(feature).not.toHaveBeenCalledWith('blankDiagram');
  });

  it('selectors.yml regeneration finds its unsaved tab when VS Code spells the path in another case', async () => {
    const { SelectorsService } = await import('../../src/services/selectorsService');
    let service: { hooks?: { isFileDirtyInEditor?: (filePath: string) => boolean } } | undefined;
    vi.spyOn(SelectorsService.prototype, 'scheduleRegenerate').mockImplementation(function (this: never) { service = this; });
    await activate(context);

    const selectorsPath = path.join(root, 'selectors.yml');
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      // e.g. a Windows drive letter `c:` against `C:`, or a folder typed in another case on macOS
      const tab = vscode.createMockTextDocument(selectorsPath.toUpperCase(), 'selectors: []\n');
      (vscode.workspace.textDocuments as unknown[]).push(tab);
      expect(service!.hooks!.isFileDirtyInEditor!(selectorsPath)).toBe(false);
      tab._setText('selectors: [] # unsaved\n');
      expect(service!.hooks!.isFileDirtyInEditor!(selectorsPath)).toBe(true);
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });

  it('registers every contributed command once, plus a code-only dbtSemantic.* alias for each', async () => {
    await activate(context);

    expect(registered()[0]).toBe('erdStudio.reportBug');
    for (const command of CONTRIBUTED) {
      expect(count(command), command).toBe(1);
    }
    // Every command that existed under the old prefix keeps working from old keybindings.
    for (const command of CONTRIBUTED.filter((c) => !NO_LEGACY_ALIAS.has(c))) {
      expect(count(legacyAlias(command)), legacyAlias(command)).toBe(1);
    }
    // …and the ones added after the rename never gained one.
    for (const command of CONTRIBUTED.filter((c) => NO_LEGACY_ALIAS.has(c))) {
      expect(count(legacyAlias(command)), legacyAlias(command)).toBe(0);
    }
    // Aliases are registered in code only — never contributed in package.json.
    expect(CONTRIBUTED.some((c) => c.startsWith('dbtSemantic.'))).toBe(false);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('Open a folder first'), expect.anything());
  });

  it('legacy aliases delegate to the erdStudio.* handler with the same arguments', async () => {
    await activate(context);
    const target = vscode._registeredCommands.find((c) => c.command === 'erdStudio.openDomain')!;
    const handler = vi.fn(async () => 'opened');
    target.callback = handler;

    const result = await vscode.commands.executeCommand('dbtSemantic.openDomain', '/x/orders.json', 'physical');

    expect(handler).toHaveBeenCalledWith('/x/orders.json', 'physical');
    expect(result).toBe('opened');
  });

  // #167: a click in the Domains tree (and the picker, the status bar, the
  // Welcome panel) opens a preview tab, so browsing diagrams reuses one tab
  // until an edit pins it, as a single click in the Explorer does.
  it('erdStudio.openDomain opens the diagram in a preview tab', async () => {
    await activate(context);
    const real = vscode.commands.executeCommand;
    const exec = vi.spyOn(vscode.commands, 'executeCommand').mockImplementation((async (command: string, ...args: unknown[]) =>
      real(command, ...args)) as never);

    await vscode.commands.executeCommand('erdStudio.openDomain', '/x/orders.json');

    const opened = exec.mock.calls.filter((c) => c[0] === 'vscode.openWith');
    expect(opened).toHaveLength(1);
    expect((opened[0][1] as { fsPath: string }).fsPath).toBe(vscode.Uri.file('/x/orders.json').fsPath);
    expect(opened[0][2]).toBe(SUBJECT_AREA_EDITOR_VIEW_TYPE);
    expect(opened[0][3]).toEqual({ preview: true });
  });

  it('wires the domain editor (retaining webview context), both tree views and the decoration providers', async () => {
    const registerEditor = vi.spyOn(vscode.window, 'registerCustomEditorProvider');
    const createTreeView = vi.spyOn(vscode.window, 'createTreeView');
    const registerDecorations = vi.spyOn(vscode.window, 'registerFileDecorationProvider');

    await activate(context);

    expect(registerEditor).toHaveBeenCalledTimes(1);
    const [viewType, provider, options] = registerEditor.mock.calls[0] as unknown as [string, SemanticEditorProvider, unknown];
    expect(viewType).toBe(SUBJECT_AREA_EDITOR_VIEW_TYPE);
    expect(typeof provider.resolveCustomTextEditor).toBe('function');
    expect(options).toEqual({ webviewOptions: { retainContextWhenHidden: true } });
    expect(createTreeView.mock.calls.map((c) => c[0])).toEqual([
      'erdStudio.domainTree',
      'erdStudio.modelLibrary',
      'erdStudio.myReports',
    ]);
    expect(registerDecorations).toHaveBeenCalledTimes(2);
    expect(context.subscriptions.length).toBeGreaterThan(CONTRIBUTED.length * 2);
  });

  it('refreshes the Model Library on any domain write, not just when a yml file appears or disappears', async () => {
    // The Model Library shows a per-model "N domains" count and lists the
    // referencing domains. Adding or removing a model reference changes that
    // count without creating or deleting a logical-models/*.yml, so gating the
    // refresh on modelLibraryChanged left the sidebar stale.
    const registerEditor = vi.spyOn(vscode.window, 'registerCustomEditorProvider');
    const createTreeView = vi.spyOn(vscode.window, 'createTreeView');
    await activate(context);

    const provider = registerEditor.mock.calls[0][1] as unknown as SemanticEditorProvider & {
      _onDidWriteSubjectArea: { fire: (e: { uri: unknown; modelLibraryChanged: boolean }) => void };
    };
    const libraryCall = createTreeView.mock.calls.find((c) => c[0] === 'erdStudio.modelLibrary');
    const libraryProvider = (libraryCall![1] as { treeDataProvider: { onDidChangeTreeData: (cb: () => void) => void } }).treeDataProvider;

    let refreshes = 0;
    libraryProvider.onDidChangeTreeData(() => { refreshes++; });

    const uri = vscode.Uri.file(path.join(root, '.erd-studio', 'silver', 'showcase.json'));
    provider._onDidWriteSubjectArea.fire({ uri, modelLibraryChanged: false });

    expect(refreshes).toBeGreaterThan(0);
  });

  it('refreshes neither tree for a layout-only write (a drag, a layout, a note moved)', async () => {
    const registerEditor = vi.spyOn(vscode.window, 'registerCustomEditorProvider');
    const createTreeView = vi.spyOn(vscode.window, 'createTreeView');
    await activate(context);

    const provider = registerEditor.mock.calls[0][1] as unknown as SemanticEditorProvider & {
      _onDidWriteSubjectArea: { fire: (e: { uri: unknown; modelLibraryChanged: boolean; layoutOnly?: boolean }) => void };
    };
    const treeOf = (id: string) => (createTreeView.mock.calls.find((c) => c[0] === id)![1] as {
      treeDataProvider: { onDidChangeTreeData: (cb: () => void) => void };
    }).treeDataProvider;
    let refreshes = 0;
    treeOf('erdStudio.modelLibrary').onDidChangeTreeData(() => { refreshes++; });
    treeOf('erdStudio.domainTree').onDidChangeTreeData(() => { refreshes++; });

    const uri = vscode.Uri.file(path.join(root, '.erd-studio', 'silver', 'showcase.json'));
    provider._onDidWriteSubjectArea.fire({ uri, modelLibraryChanged: false, layoutOnly: true });
    expect(refreshes).toBe(0);

    // Anything else still refreshes both.
    provider._onDidWriteSubjectArea.fire({ uri, modelLibraryChanged: false });
    expect(refreshes).toBeGreaterThanOrEqual(2);
  });

  it('routes erdStudio.reportBug through the focused canvas instead of input boxes', async () => {
    const registerEditor = vi.spyOn(vscode.window, 'registerCustomEditorProvider');
    await activate(context);
    const provider = registerEditor.mock.calls[0][1] as unknown as SemanticEditorProvider;

    const file = path.join(root, '.erd-studio', 'silver', 'showcase.json');
    const doc = vscode.createMockTextDocument(file, fs.readFileSync(file, 'utf-8'));
    const panel = vscode.createMockWebviewPanel();
    await provider.resolveCustomTextEditor(
      doc as unknown as import('vscode').TextDocument,
      panel as unknown as import('vscode').WebviewPanel,
      {} as import('vscode').CancellationToken,
    );
    vscode.window.tabGroups.activeTabGroup.activeTab = {
      input: new vscode.TabInputCustom(doc.uri, SUBJECT_AREA_EDITOR_VIEW_TYPE),
    };
    const input = vi.spyOn(vscode.window, 'showInputBox');

    await vscode.commands.executeCommand('erdStudio.reportBug', { title: 'From palette' });

    expect(panel._postedMessages).toContainEqual({ type: 'openFeedback', payload: { title: 'From palette' } });
    expect(input).not.toHaveBeenCalled();
  });

  it('erdStudio.openTrackedReport opens the row\'s issue URL and ignores a missing node', async () => {
    await activate(context);
    const open = vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(true);

    await vscode.commands.executeCommand('erdStudio.openTrackedReport');
    expect(open).not.toHaveBeenCalled();

    await vscode.commands.executeCommand('erdStudio.openTrackedReport', {
      type: 'report',
      report: { number: 42, url: 'https://github.com/liam-machine/erd-studio/issues/42' },
    });
    expect(String(open.mock.calls[0][0])).toBe('https://github.com/liam-machine/erd-studio/issues/42');
  });
});

const LOGICAL_ONLY_FIXTURE = path.join(REPO_ROOT, 'test', 'fixtures', 'logical-only');

/** Every file and folder under `dir`, relative and sorted: what a "nothing written" check compares. */
function listTree(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const child = rel ? path.join(rel, entry.name) : entry.name;
      out.push(entry.isDirectory() ? `${child}/` : child);
      if (entry.isDirectory()) { walk(child); }
    }
  };
  walk('');
  return out.sort();
}

describe('activate() in a folder without dbt_project.yml (logical-only)', () => {
  // The workspace is a folder of its own, so the test's HOME and the global
  // storage (both under `root`) never count as writes to it.
  let ws: string;
  let info: ReturnType<typeof vi.spyOn>;
  let pick: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    ws = path.join(root, 'plain');
    fs.mkdirSync(ws);
    openWorkspace(ws);
    info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    pick = vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue(undefined);
  });

  it('activates fully: no fallback stubs, every command and alias registered once, the real editor and tree views', async () => {
    const registerEditor = vi.spyOn(vscode.window, 'registerCustomEditorProvider');
    const createTreeView = vi.spyOn(vscode.window, 'createTreeView');
    await activate(context);

    for (const command of CONTRIBUTED) {
      expect(count(command), command).toBe(1);
      expect(count(legacyAlias(command)), legacyAlias(command)).toBe(NO_LEGACY_ALIAS.has(command) ? 0 : 1);
    }
    expect(registerEditor).toHaveBeenCalledTimes(1);
    expect(registerEditor.mock.calls[0][2]).toEqual({ webviewOptions: { retainContextWhenHidden: true } });
    expect(createTreeView.mock.calls.map((c) => c[0])).toContain('erdStudio.domainTree');
    // A command that works without dbt runs its real handler, not the "open a folder" stub.
    await vscode.commands.executeCommand('erdStudio.openDomain', path.join(ws, '.erd-studio', 'gold', 'x.json'));
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('Open a folder first'), expect.anything(), expect.anything());
  });

  it('writes nothing, shows no QuickPick and no toast — even on a first workspace visit and after an upgrade', async () => {
    // No harness offer recorded for this workspace, and an upgrader who has
    // not seen the getting-started notice: both would prompt in a dbt project.
    context = makeContext(root, {
      globalState: new Map<string, unknown>([['lastActivatedVersion', '1.0.0']]),
      workspaceState: new Map<string, unknown>(),
    });
    const before = listTree(ws);

    await activate(context);
    // Past the selectors.yml debounce and every other scheduled activation task.
    await vi.advanceTimersByTimeAsync(5_000);

    expect(listTree(ws)).toEqual(before);
    expect(pick).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    // Deferred, not spent: they still come once this folder has something to work on.
    expect(context.workspaceState.get('erdStudio.harnessInstallPrompted')).toBeUndefined();
    expect(context.globalState.get(GETTING_STARTED_SHOWN_KEY)).toBeUndefined();
  });

  it('with ERD data and a decoy models/: writes nothing (no selectors.yml) and watches no dbt files', async () => {
    fs.cpSync(LOGICAL_ONLY_FIXTURE, ws, { recursive: true });
    const before = listTree(ws);

    await activate(context);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(listTree(ws)).toEqual(before);
    expect(fs.existsSync(path.join(ws, 'selectors.yml'))).toBe(false);
    const patterns = vscode._mockFileWatchers.map((w) => (w._pattern as vscode.RelativePattern).pattern);
    expect(patterns).toEqual(['.erd-studio/**/*.{json,dbml,dbdiagram}', '.erd-studio/{logical-models,tables}/**/*.{yml,dbml}']);
  });

  /** Activate in `ws` (holding the logical-only fixture) and open its diagram in the real editor provider. */
  async function openFixtureDiagram() {
    fs.cpSync(LOGICAL_ONLY_FIXTURE, ws, { recursive: true });
    const registerEditor = vi.spyOn(vscode.window, 'registerCustomEditorProvider');
    await activate(context);
    const provider = registerEditor.mock.calls[0][1] as unknown as SemanticEditorProvider;

    const file = path.join(ws, '.erd-studio', 'gold', 'sales.json');
    const doc = vscode.createMockTextDocument(file, fs.readFileSync(file, 'utf-8'));
    const panel = vscode.createMockWebviewPanel();
    await provider.resolveCustomTextEditor(
      doc as unknown as import('vscode').TextDocument,
      panel as unknown as import('vscode').WebviewPanel,
      {} as import('vscode').CancellationToken,
    );
    await panel._simulateMessage({ type: 'ready' });
    return { provider, panel };
  }

  it('tells the editor it is logical-only: its first payload carries the flag', async () => {
    const { panel } = await openFixtureDiagram();
    const loaded = panel._postedMessages.find((m) => (m as { type: string }).type === 'domainLoaded') as {
      logicalOnly?: true; payload: { models: Array<{ name: string }> };
    };
    expect(loaded.logicalOnly).toBe(true);
    expect(loaded.payload.models.map((m) => m.name)).toEqual(['customer']);
  });

  it('hands the editor disabled dbt readers: the decoy models/ is never read and no manifest counts as missing', async () => {
    // Sanity: an enabled reader does find the decoy schema yml in this folder,
    // so the empty answers below come from the wiring in activate().
    fs.cpSync(LOGICAL_ONLY_FIXTURE, ws, { recursive: true });
    const { YmlParserService } = await import('../../src/services/ymlParserService');
    expect((await new YmlParserService().loadYmlData(ws)).models.size).toBeGreaterThan(0);
    fs.rmSync(ws, { recursive: true, force: true });
    fs.mkdirSync(ws);

    const { provider } = await openFixtureDiagram();
    const services = provider as unknown as {
      ymlParserService: { loadYmlData(p: string): Promise<{ models: Map<string, unknown> }> };
      manifestService: { loadManifest(p: string): Promise<{ models: Map<string, unknown> }>; isMissing: boolean };
    };
    expect((await services.ymlParserService.loadYmlData(ws)).models.size).toBe(0);
    expect((await services.manifestService.loadManifest(ws)).models.size).toBe(0);
    // An enabled manifest reader with no target/manifest.json reports it missing.
    expect(services.manifestService.isMissing).toBe(false);
  });

  it('a canvas table edit saves the table but writes no selectors.yml', async () => {
    const { SelectorsService } = await import('../../src/services/selectorsService');
    const regenerate = vi.spyOn(SelectorsService.prototype, 'regenerate');
    const { panel } = await openFixtureDiagram();
    regenerate.mockClear();

    await panel._simulateMessage({ type: 'addModel', payload: { name: 'orders', schema: '', description: '', columns: [] } });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(fs.readdirSync(path.join(ws, '.erd-studio', 'tables')).sort()).toEqual(['customer.yml', 'orders.yml']);
    // The post-edit regenerate ran and declined: this folder is not a dbt project.
    expect(regenerate).toHaveBeenCalled();
    expect(regenerate.mock.results.map((r) => (r.value as { status: string }).status)).toEqual(
      regenerate.mock.results.map(() => 'not-dbt-project'),
    );
    expect(fs.existsSync(path.join(ws, 'selectors.yml'))).toBe(false);
  });

  it('Draw from dbt explains that it needs a dbt project and writes nothing', async () => {
    await activate(context);
    await vscode.commands.executeCommand('erdStudio.drawFromDbt');
    expect(info).toHaveBeenCalledWith(
      'Draw from dbt needs a dbt project. Open the folder that holds dbt_project.yml, or start with New Diagram / Import DBML.',
    );
    expect(pick).not.toHaveBeenCalled();
    expect(listTree(ws)).toEqual([]);
  });

  it('New Diagram works in a folder with no .erd-studio: layers.json first, then the diagram, then it opens', async () => {
    await activate(context);
    pick.mockImplementation((async (items: Array<{ label: string; value: string }>) =>
      items.find((i) => i.value === 'gold')) as never);
    vi.spyOn(vscode.window, 'showInputBox')
      .mockResolvedValueOnce('orders')
      .mockResolvedValueOnce('Orders and customers');
    const real = vscode.commands.executeCommand;
    const exec = vi.spyOn(vscode.commands, 'executeCommand').mockImplementation((async (command: string, ...args: unknown[]) =>
      real(command, ...args)) as never);

    await vscode.commands.executeCommand('erdStudio.createDomain');

    // Only the layer QuickPick: no "filter dbt models by folder" in a plain folder.
    expect(pick).toHaveBeenCalledTimes(1);
    const layers = JSON.parse(fs.readFileSync(path.join(ws, '.erd-studio', 'layers.json'), 'utf-8')) as { layers: Array<{ id: string }> };
    expect(layers.layers.map((l) => l.id)).toContain('gold');
    // A new project stores its diagrams as DBML (native DBML storage, §3.2): no layout file until something is placed.
    const domainPath = path.join(ws, '.erd-studio', 'gold', 'orders.dbml');
    const domain = parseSubjectAreaDbml(fs.readFileSync(domainPath, 'utf-8'), 'gold/orders.dbml', null).obj;
    expect(domain).toMatchObject({ domain: 'orders', layer: 'gold', description: 'Orders and customers' });
    expect(listTree(ws)).toEqual(['.erd-studio/', '.erd-studio/gold/', '.erd-studio/gold/orders.dbml', '.erd-studio/layers.json']);
    const opened = exec.mock.calls.filter((c) => c[0] === 'vscode.openWith');
    expect((opened[0][1] as { fsPath: string }).fsPath).toBe(domainPath);
    expect(exec).toHaveBeenCalledWith('setContext', 'erdStudio.hasSemanticDir', true);
  });

  it('New Diagram cancelled at the name box leaves the folder untouched', async () => {
    await activate(context);
    pick.mockImplementation((async (items: Array<{ value: string }>) => items[0]) as never);
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue(undefined);
    await vscode.commands.executeCommand('erdStudio.createDomain');
    expect(listTree(ws)).toEqual([]);
  });

  it('the dbt-only commands explain instead of acting', async () => {
    await activate(context);
    for (const command of ['erdStudio.refreshManifest', 'erdStudio.stripLegacyDomainTags', 'erdStudio.selectDbtProject']) {
      info.mockClear();
      await vscode.commands.executeCommand(command);
      expect(info, command).toHaveBeenCalledWith(expect.stringContaining('this folder is not a dbt project'));
    }
    expect(listTree(ws)).toEqual([]);
  });

  it('Set Up My AI Helper works in a plain folder: installs the guide and offers to start its no-dbt route', async () => {
    await activate(context);
    await vscode.commands.executeCommand('erdStudio.setupAiHelper');
    const calls = info.mock.calls.filter((c) => String(c[0]).startsWith('AI helper ready'));
    expect(calls).toHaveLength(1);
    // The guided setup has a no-dbt route now, so the toast points at it, with the Copy button.
    expect(String(calls[0][0])).toContain('to design your data model with you');
    expect(String(calls[0][0])).toContain('Guide not showing? Start your assistant from plain.');
    expect(calls[0]).toContain('Copy prompt');
    expect(fs.existsSync(path.join(ws, '.claude', 'skills', 'erd-studio-setup', 'SKILL.md'))).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('Open Example Diagram: the coffee-shop example through Import DBML\'s confirm, into a plain folder', async () => {
    const feature = vi.spyOn(telemetry, 'feature');
    await activate(context);
    const input = vi.spyOn(vscode.window, 'showInputBox').mockImplementation((async (o: { value?: string }) => o.value) as never);
    info.mockImplementation((async (_message: string, ...items: unknown[]) =>
      (items.includes('Import') ? 'Import' : undefined)) as never);
    const real = vscode.commands.executeCommand;
    const exec = vi.spyOn(vscode.commands, 'executeCommand').mockImplementation((async (command: string, ...args: unknown[]) =>
      real(command, ...args)) as never);

    await vscode.commands.executeCommand('erdStudio.openExampleDiagram');

    expect(input).toHaveBeenCalledTimes(1);
    expect(pick).not.toHaveBeenCalled(); // the default layers have gold
    const confirm = info.mock.calls.find((c) => c.includes('Import'))!;
    expect(confirm[0]).toBe('Import 6 tables into a new diagram "coffee-shop" in the Gold layer.');
    // A new project stores the example as DBML (native DBML storage, §3.2).
    const domainPath = path.join(ws, '.erd-studio', 'gold', 'coffee-shop.dbml');
    expect(fs.existsSync(domainPath)).toBe(true);
    expect(fs.existsSync(path.join(ws, '.erd-studio', 'tables', 'gold', 'fct_orders.dbml'))).toBe(true);
    expect(fs.existsSync(path.join(ws, '.erd-studio', 'layers.json'))).toBe(true);
    expect(fs.existsSync(path.join(ws, 'coffee-shop.dbml'))).toBe(false); // nothing but the diagram's own files
    const opened = exec.mock.calls.filter((c) => c[0] === 'vscode.openWith');
    expect((opened[0][1] as { fsPath: string }).fsPath).toBe(domainPath);
    expect(feature).toHaveBeenCalledWith('exampleDiagram');
  });

  it('Open Example Diagram cancelled at the dry run writes nothing', async () => {
    await activate(context);
    vi.spyOn(vscode.window, 'showInputBox').mockImplementation((async (o: { value?: string }) => o.value) as never);
    await vscode.commands.executeCommand('erdStudio.openExampleDiagram');
    expect(listTree(ws)).toEqual([]);
  });

  it('usage telemetry: a non-dbt root once a day, and a New Diagram there counts as a blank start', async () => {
    const featureOnce = vi.spyOn(telemetry, 'featureOnce');
    const feature = vi.spyOn(telemetry, 'feature');
    await activate(context);
    expect(featureOnce).toHaveBeenCalledWith('logicalOnlyProject');
    pick.mockImplementation((async (items: Array<{ value: string }>) => items.find((i) => i.value === 'gold')) as never);
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValueOnce('orders').mockResolvedValueOnce('');
    await vscode.commands.executeCommand('erdStudio.createDomain');
    expect(feature).toHaveBeenCalledWith('domainCreated');
    expect(feature).toHaveBeenCalledWith('blankDiagram');
  });

  it('the Welcome panel shows its logical-only page', async () => {
    await activate(context);
    await vscode.commands.executeCommand('erdStudio.showGettingStarted');
    const panel = panelsOfType()[0];
    await panel._simulateMessage({ type: 'ready' });
    expect(panel._postedMessages).toContainEqual(expect.objectContaining({
      type: 'status',
      payload: expect.objectContaining({ hasProject: true, logicalOnly: true, project: { name: 'plain', relativePath: null } }),
    }));
  });

  it('a workspace folder with .erd-studio opens rather than the first folder', async () => {
    const withData = path.join(root, 'diagrams');
    fs.cpSync(LOGICAL_ONLY_FIXTURE, withData, { recursive: true });
    vscode.workspace.workspaceFolders = [
      { uri: vscode.Uri.file(ws), name: 'plain', index: 0 },
      { uri: vscode.Uri.file(withData), name: 'diagrams', index: 1 },
    ];
    await activate(context);
    await vscode.commands.executeCommand('erdStudio.showGettingStarted');
    const panel = panelsOfType()[0];
    await panel._simulateMessage({ type: 'ready' });
    expect(panel._postedMessages).toContainEqual(expect.objectContaining({
      type: 'status',
      payload: expect.objectContaining({ logicalOnly: true, project: expect.objectContaining({ name: 'diagrams' }), domainCount: 1 }),
    }));
  });
});

describe('activate() in a native DBML project (S4)', () => {
  let ws: string;
  beforeEach(() => {
    ws = path.join(root, 'dbml');
    fs.cpSync(path.join(REPO_ROOT, 'test', 'fixtures', 'dbml-native'), ws, { recursive: true });
    openWorkspace(ws);
  });

  it('sets erdStudio.storage to dbml and shows the Table Library, writes nothing, and opens a .dbml diagram', async () => {
    const setContext = vi.spyOn(vscode.commands, 'executeCommand');
    const registerEditor = vi.spyOn(vscode.window, 'registerCustomEditorProvider');
    const before = listTree(ws);
    await activate(context);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(setContext).toHaveBeenCalledWith('setContext', 'erdStudio.storage', 'dbml');
    expect(setContext).toHaveBeenCalledWith('setContext', 'erdStudio.hasLogicalModelsDir', true);
    expect(listTree(ws)).toEqual(before);

    const provider = registerEditor.mock.calls[0][1] as unknown as SemanticEditorProvider;
    const file = path.join(ws, '.erd-studio', 'gold', 'sales.dbml');
    const doc = vscode.createMockTextDocument(file, fs.readFileSync(file, 'utf-8'));
    const panel = vscode.createMockWebviewPanel();
    await provider.resolveCustomTextEditor(
      doc as unknown as import('vscode').TextDocument,
      panel as unknown as import('vscode').WebviewPanel,
      {} as import('vscode').CancellationToken,
    );
    await panel._simulateMessage({ type: 'ready' });
    const loaded = panel._postedMessages.find((m) => (m as { type: string }).type === 'domainLoaded') as { payload: { schemaVersion: number } };
    expect(loaded.payload.schemaVersion).toBe(7);
    expect(listTree(ws)).toEqual(before);
  });

  /** The watcher over the semantic dir's diagrams and layouts. */
  const semanticWatcher = () => vscode._mockFileWatchers.find((w) => JSON.stringify(w._pattern ?? '').includes('dbdiagram'))!;
  const foreignToasts = () => warn.mock.calls.filter((c) => String(c[0]).includes('was just added to this DBML project'));

  it('the foreign-format toast is never raised by ERD Studio\'s own New Diagram (§5.4)', async () => {
    const featureOnce = vi.spyOn(telemetry, 'featureOnce');
    await activate(context);
    // New Diagram writes a .dbml in a DBML project (S6), never a foreign format.
    vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (items: Array<{ value: string }>) =>
      items.find((i) => i.value === 'gold')) as never);
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValueOnce('orders').mockResolvedValueOnce('');
    await vscode.commands.executeCommand('erdStudio.createDomain');
    const created = path.join(ws, '.erd-studio', 'gold', 'orders.dbml');
    expect(fs.existsSync(created)).toBe(true);
    semanticWatcher()._simulateCreate(vscode.Uri.file(created));
    await vi.advanceTimersByTimeAsync(400);
    expect(foreignToasts()).toHaveLength(0);
    expect(featureOnce).not.toHaveBeenCalledWith('dbmlForeignFormatWarned');
  });

  it('the foreign-format toast: once per session for a .json or .yml someone else adds, with the Update action, counted once', async () => {
    const featureOnce = vi.spyOn(telemetry, 'featureOnce');
    await activate(context);
    await vi.advanceTimersByTimeAsync(5_000);
    const external = path.join(ws, '.erd-studio', 'gold', 'from_helper.json');
    fs.writeFileSync(external, '{"schemaVersion": 5, "domain": "from_helper", "layer": "gold", "logical": {"models": []}}\n');
    semanticWatcher()._simulateCreate(vscode.Uri.file(external));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(foreignToasts()).toHaveLength(1);
    expect(foreignToasts()[0][0]).toContain('(.erd-studio/gold/from_helper.json)');
    // A teammate or another window on an older ERD Studio is as likely as a helper,
    // and no release number is named (a 1.9 pre-release user reads this too).
    expect(foreignToasts()[0][0]).toContain('or by a teammate or another window on an older ERD Studio');
    expect(foreignToasts()[0][0]).not.toMatch(/\b2\.0\b/);
    expect(foreignToasts()[0].slice(1)).toEqual(['Update AI Helper Files', 'Not Now']);
    expect(featureOnce).toHaveBeenCalledWith('dbmlForeignFormatWarned');

    const yml = path.join(ws, '.erd-studio', 'tables', 'gold', 'dim_new.yml');
    fs.writeFileSync(yml, 'name: dim_new\ncolumns: []\n');
    for (const w of vscode._mockFileWatchers) w._simulateCreate(vscode.Uri.file(yml));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(foreignToasts()).toHaveLength(1);
    expect(featureOnce.mock.calls.filter((c) => c[0] === 'dbmlForeignFormatWarned')).toHaveLength(1);
  });

  it('"Subject area file deleted": not for a diagram whose name is back as .json (Undo of Convert), still for one really deleted', async () => {
    await activate(context);
    await vi.advanceTimersByTimeAsync(5_000);
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    const deletedToasts = () => info.mock.calls.filter((c) => /subject area files? deleted/i.test(String(c[0])));

    // Undo of Convert Project to DBML: the .json comes back and the .dbml goes.
    const salesDbml = path.join(ws, '.erd-studio', 'gold', 'sales.dbml');
    fs.writeFileSync(path.join(ws, '.erd-studio', 'gold', 'sales.json'), '{"schemaVersion": 5, "domain": "sales", "layer": "gold", "logical": {"models": []}}\n');
    fs.rmSync(salesDbml);
    semanticWatcher()._simulateDelete(vscode.Uri.file(salesDbml));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(deletedToasts()).toHaveLength(0);

    // A diagram the user deletes: the toast, as before.
    const staging = path.join(ws, '.erd-studio', 'silver', 'staging.dbml');
    fs.rmSync(staging);
    semanticWatcher()._simulateDelete(vscode.Uri.file(staging));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(deletedToasts()).toHaveLength(1);
    expect(deletedToasts()[0][0]).toBe('Subject area file deleted. Regenerate dbt selectors.yml to drop the removed subject area from the selector set.');
  });

  it('the foreign-format toast is not raised outside a DBML project', async () => {
    fs.rmSync(path.join(ws, '.erd-studio', 'tables'), { recursive: true, force: true });
    fs.rmSync(path.join(ws, '.erd-studio', 'gold', 'sales.dbml'));
    fs.rmSync(path.join(ws, '.erd-studio', 'silver', 'staging.dbml'));
    fs.mkdirSync(path.join(ws, '.erd-studio', 'logical-models'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.erd-studio', 'logical-models', 'dim_a.yml'), 'name: dim_a\ncolumns: []\n');
    await activate(context);
    await vi.advanceTimersByTimeAsync(5_000);
    const external = path.join(ws, '.erd-studio', 'gold', 'from_helper.json');
    fs.writeFileSync(external, '{"schemaVersion": 5, "domain": "from_helper", "layer": "gold", "logical": {"models": []}}\n');
    semanticWatcher()._simulateCreate(vscode.Uri.file(external));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(foreignToasts()).toHaveLength(0);
  });

  it('a layout change redraws its diagram\'s canvas; a change to the diagram file itself does not (its document does)', async () => {
    const registerEditor = vi.spyOn(vscode.window, 'registerCustomEditorProvider');
    await activate(context);
    await vi.advanceTimersByTimeAsync(5_000);
    const provider = registerEditor.mock.calls[0][1] as unknown as SemanticEditorProvider;
    const refresh = vi.spyOn(provider, 'refreshSubjectAreaPanel').mockResolvedValue(undefined as never);
    const diagram = path.join(ws, '.erd-studio', 'gold', 'sales.dbml');
    semanticWatcher()._simulateChange(vscode.Uri.file(diagram));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(refresh).not.toHaveBeenCalled();
    semanticWatcher()._simulateChange(vscode.Uri.file(path.join(ws, '.erd-studio', 'gold', 'sales.dbdiagram')));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith(diagram);
  });

  it('a layout change outside ERD Studio refreshes neither sidebar tree (positions are not shown there)', async () => {
    const createTreeView = vi.spyOn(vscode.window, 'createTreeView');
    const registerEditor = vi.spyOn(vscode.window, 'registerCustomEditorProvider');
    await activate(context);
    await vi.advanceTimersByTimeAsync(5_000);
    const provider = registerEditor.mock.calls[0][1] as unknown as SemanticEditorProvider;
    vi.spyOn(provider, 'refreshSubjectAreaPanel').mockResolvedValue(undefined as never);
    const treeOf = (id: string) => (createTreeView.mock.calls.find((c) => c[0] === id)![1] as {
      treeDataProvider: { onDidChangeTreeData: (cb: () => void) => void };
    }).treeDataProvider;
    let refreshes = 0;
    treeOf('erdStudio.modelLibrary').onDidChangeTreeData(() => { refreshes++; });
    treeOf('erdStudio.domainTree').onDidChangeTreeData(() => { refreshes++; });
    semanticWatcher()._simulateChange(vscode.Uri.file(path.join(ws, '.erd-studio', 'gold', 'sales.dbdiagram')));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(refreshes).toBe(0);
    semanticWatcher()._simulateChange(vscode.Uri.file(path.join(ws, '.erd-studio', 'gold', 'sales.dbml')));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(refreshes).toBeGreaterThan(0);
  });

  it('warns once about tablesLayerConflict when layers.json also lists tables', async () => {
    const layersFile = path.join(ws, '.erd-studio', 'layers.json');
    const layers = JSON.parse(fs.readFileSync(layersFile, 'utf-8'));
    layers.layers.push({ id: 'tables', label: 'Tables', abbreviation: 'TBL', color: '#888888', creatable: true, order: 3 });
    fs.writeFileSync(layersFile, JSON.stringify(layers, null, 2));
    await activate(context);
    const conflicts = warn.mock.calls.filter((c) => String(c[0]).includes('tables/ is the DBML table library'));
    expect(conflicts).toHaveLength(1);
  });
});

describe('erdStudio.organizeModelLibrary (issue #76)', () => {
  const lib = () => path.join(root, '.erd-studio', 'logical-models');

  beforeEach(() => {
    fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
    openWorkspace(root);
  });

  it('is a post-rename command: contributed, registered once, with no dbtSemantic alias', async () => {
    expect(NO_LEGACY_ALIAS.has('erdStudio.organizeModelLibrary')).toBe(true);
    expect(CONTRIBUTED).toContain('erdStudio.organizeModelLibrary');
    await activate(context);
    expect(count('erdStudio.organizeModelLibrary')).toBe(1);
    expect(count('dbtSemantic.organizeModelLibrary')).toBe(0);
  });

  it('moves single-layer models into their layer folder after confirmation, leaving shared and unused ones', async () => {
    // A v5 gold domain that shares dim_date with showcase (silver) and alone uses fct_sale.
    fs.writeFileSync(path.join(root, '.erd-studio', 'gold', 'reporting.json'), JSON.stringify({
      schemaVersion: 5,
      domain: 'reporting',
      layer: 'gold',
      description: '',
      logical: { models: ['dim_date', 'fct_sale'], relationships: [] },
      viewConfig: { positions: {} },
    }));
    const showcaseBefore = fs.readFileSync(path.join(root, '.erd-studio', 'silver', 'showcase.json'), 'utf-8');
    await activate(context);
    const info = vi.spyOn(vscode.window, 'showInformationMessage')
      .mockImplementation((async (message: string) => (message === 'Organise Table Library by Layer?' ? 'Move Files' : undefined)) as never);

    await vscode.commands.executeCommand('erdStudio.organizeModelLibrary');

    // The modal lists the plan.
    const confirm = info.mock.calls.find((c) => c[0] === 'Organise Table Library by Layer?')!;
    expect(confirm[1]).toMatchObject({ modal: true });
    const detail = (confirm[1] as { detail: string }).detail;
    expect(detail).toContain('Move 7 tables into layer folders (1 → gold/, 6 → silver/).');
    expect(detail).toContain('1 table used by more than one layer');
    expect(detail).toContain('1 unused table');

    const silver = fs.readdirSync(path.join(lib(), 'silver')).sort();
    expect(silver).toEqual([
      'dim_customer.yml', 'dim_project.yml', 'dim_task.yml', 'fct_large_table.yml', 'fct_order.yml', 'fct_task_event.yml',
    ]);
    expect(fs.readdirSync(path.join(lib(), 'gold'))).toEqual(['fct_sale.yml']);
    const topLevel = fs.readdirSync(lib()).filter((f) => f.endsWith('.yml')).sort();
    expect(topLevel).toEqual(['dim_date.yml', 'dim_location.yml']);
    // Domain files are untouched — they reference models by name.
    expect(fs.readFileSync(path.join(root, '.erd-studio', 'silver', 'showcase.json'), 'utf-8')).toBe(showcaseBefore);
    expect(info).toHaveBeenCalledWith('Moved 7 table files into layer folders.');
  });

  /** Answer "Move Files" to the confirmation modal; resolve everything else to undefined. */
  const acceptMoves = () => vi.spyOn(vscode.window, 'showInformationMessage')
    .mockImplementation((async (message: string) => (message === 'Organise Table Library by Layer?' ? 'Move Files' : undefined)) as never);
  const confirmDetail = (info: ReturnType<typeof acceptMoves>) =>
    (info.mock.calls.find((c) => c[0] === 'Organise Table Library by Layer?')![1] as { detail: string }).detail;

  it('moves a file out of the wrong layer folder into the one layer whose domains use it', async () => {
    // dim_customer is used only by silver domains, but its file sits in gold/.
    fs.mkdirSync(path.join(lib(), 'gold'));
    fs.renameSync(path.join(lib(), 'dim_customer.yml'), path.join(lib(), 'gold', 'dim_customer.yml'));
    await activate(context);
    const info = acceptMoves();

    await vscode.commands.executeCommand('erdStudio.organizeModelLibrary');

    const detail = confirmDetail(info);
    expect(detail).toContain("One is in another layer's folder");
    expect(detail).toContain('dim_customer: gold/ → silver/');
    expect(fs.existsSync(path.join(lib(), 'silver', 'dim_customer.yml'))).toBe(true);
    expect(fs.existsSync(path.join(lib(), 'gold', 'dim_customer.yml'))).toBe(false);
    expect(fs.existsSync(path.join(lib(), 'dim_customer.yml'))).toBe(false);
    // gold/ held only dim_customer (the fixture has no gold-only model), so the emptied folder is removed.
    expect(fs.existsSync(path.join(lib(), 'gold'))).toBe(false);
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/^Moved \d+ table files into layer folders\.$/));
  });

  it('reports nothing to move when re-run after a successful organise that relocated a file', async () => {
    fs.mkdirSync(path.join(lib(), 'gold'));
    fs.renameSync(path.join(lib(), 'dim_customer.yml'), path.join(lib(), 'gold', 'dim_customer.yml'));
    await activate(context);
    const info = acceptMoves();
    await vscode.commands.executeCommand('erdStudio.organizeModelLibrary');
    expect(fs.existsSync(path.join(lib(), 'silver', 'dim_customer.yml'))).toBe(true);
    const after = fs.readdirSync(path.join(lib(), 'silver')).sort();
    info.mockClear();

    await vscode.commands.executeCommand('erdStudio.organizeModelLibrary');

    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0][0])).toMatch(/^Organise Table Library: nothing to move\. /);
    expect(info.mock.calls.some((c) => c[0] === 'Organise Table Library by Layer?')).toBe(false);
    expect(fs.readdirSync(path.join(lib(), 'silver')).sort()).toEqual(after);
  });

  it('leaves a non-layer folder untouched and names it in the dialog detail', async () => {
    // Staging/ is not a layer in layers.json: fct_order stays there even though only silver uses it.
    fs.mkdirSync(path.join(lib(), 'Staging'));
    fs.renameSync(path.join(lib(), 'fct_order.yml'), path.join(lib(), 'Staging', 'fct_order.yml'));
    const stagedBefore = fs.readFileSync(path.join(lib(), 'Staging', 'fct_order.yml'), 'utf-8');
    await activate(context);
    const info = acceptMoves();

    await vscode.commands.executeCommand('erdStudio.organizeModelLibrary');

    const detail = confirmDetail(info);
    expect(detail).toContain('Left alone: folders that are not a layer in layers.json — Staging/ (1).');
    expect(fs.readdirSync(path.join(lib(), 'Staging'))).toEqual(['fct_order.yml']);
    expect(fs.readFileSync(path.join(lib(), 'Staging', 'fct_order.yml'), 'utf-8')).toBe(stagedBefore);
    expect(fs.existsSync(path.join(lib(), 'silver', 'fct_order.yml'))).toBe(false);
    // The other silver-only models still moved.
    expect(fs.existsSync(path.join(lib(), 'silver', 'dim_customer.yml'))).toBe(true);
  });

  it('moves nothing when the confirmation is dismissed', async () => {
    await activate(context);
    const before = fs.readdirSync(lib()).sort();
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);

    await vscode.commands.executeCommand('erdStudio.organizeModelLibrary');

    expect(fs.readdirSync(lib()).sort()).toEqual(before);
    expect(fs.existsSync(path.join(lib(), 'silver'))).toBe(false);
  });

  it('says there is nothing to move, without a modal, when every model is shared, unused or already filed', async () => {
    await activate(context);
    const info = vi.spyOn(vscode.window, 'showInformationMessage')
      .mockImplementation((async (message: string) => (message === 'Organise Table Library by Layer?' ? 'Move Files' : undefined)) as never);
    await vscode.commands.executeCommand('erdStudio.organizeModelLibrary');
    info.mockClear();

    await vscode.commands.executeCommand('erdStudio.organizeModelLibrary');

    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0][0])).toMatch(/^Organise Table Library: nothing to move\. /);
    expect(String(info.mock.calls[0][0])).not.toContain('\n');
  });

  it('reports a rejected WorkspaceEdit and leaves the files where they were', async () => {
    await activate(context);
    const before = fs.readdirSync(lib()).sort();
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue('Move Files' as never);
    vi.spyOn(vscode.workspace, 'applyEdit').mockResolvedValue(false);
    const error = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined as never);

    await vscode.commands.executeCommand('erdStudio.organizeModelLibrary');

    expect(error).toHaveBeenCalledWith(expect.stringContaining('rejected the file moves'));
    expect(fs.readdirSync(lib()).filter((f) => f.endsWith('.yml')).sort())
      .toEqual(before.filter((f) => f.endsWith('.yml')));
    // No empty layer folders are left behind for the move that did not happen.
    expect(fs.readdirSync(lib()).sort()).toEqual(before);
  });

  it('explains when there is no Table Library folder yet', async () => {
    fs.rmSync(lib(), { recursive: true, force: true });
    await activate(context);
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);

    await vscode.commands.executeCommand('erdStudio.organizeModelLibrary');

    expect(info).toHaveBeenCalledWith('Organise Table Library: there is no Table Library folder yet.');
  });
});

describe('erdStudio.resolveDuplicateModel (issue #76: same table name in two layers)', () => {
  const erd = () => path.join(root, '.erd-studio');
  const lib = () => path.join(erd(), 'logical-models');
  const writeJson = (p: string, v: unknown) => fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
  const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, any>;
  const ignored = () => path.join(lib(), 'silver', 'date.yml');

  beforeEach(() => {
    fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
    fs.mkdirSync(path.join(lib(), 'silver'));
    fs.mkdirSync(path.join(lib(), 'gold'));
    // Two files called date. Folders are looked up alphabetically, so gold/
    // wins and the silver domain silently rendered the gold table's columns.
    fs.writeFileSync(path.join(lib(), 'gold', 'date.yml'), 'name: date\nschema: gold\ncolumns:\n  - name: date_key\n    dataType: int\n  - name: fiscal_year\n    dataType: int\n');
    fs.writeFileSync(ignored(), '# silver calendar\nname: date\nschema: silver\ncolumns:\n  - name: date_key\n    dataType: int\n');
    writeJson(path.join(erd(), 'silver', 'calendar.json'), {
      schemaVersion: 5, domain: 'calendar', layer: 'silver', description: '',
      logical: { models: ['fct_order', 'date'], relationships: [{ fromModel: 'fct_order', fromColumn: 'order_date_key', toModel: 'date', toColumn: 'date_key', cardinality: 'many-to-one' }] },
      viewConfig: { positions: { date: { x: 10, y: 20 } } },
    });
    writeJson(path.join(erd(), 'gold', 'reporting.json'), {
      schemaVersion: 5, domain: 'reporting', layer: 'gold', description: '',
      logical: { models: ['date'], relationships: [] }, viewConfig: {},
    });
    openWorkspace(root);
  });

  const answer = (modalChoice: string | undefined) => {
    vi.spyOn(vscode.window, 'showInputBox').mockImplementation((async (opts?: { value?: string }) => opts?.value) as never);
    return vi.spyOn(vscode.window, 'showInformationMessage')
      .mockImplementation((async (message: string) => (message.startsWith('Rename the duplicate') ? modalChoice : undefined)) as never);
  };

  it('is a post-rename command: contributed, registered once, with no dbtSemantic alias', async () => {
    expect(NO_LEGACY_ALIAS.has('erdStudio.resolveDuplicateModel')).toBe(true);
    expect(CONTRIBUTED).toContain('erdStudio.resolveDuplicateModel');
    await activate(context);
    expect(count('erdStudio.resolveDuplicateModel')).toBe(1);
    expect(count('dbtSemantic.resolveDuplicateModel')).toBe(0);
  });

  it('renames the ignored silver copy to silver_date with alias date, and repoints only the silver domain', async () => {
    const goldDomainBefore = fs.readFileSync(path.join(erd(), 'gold', 'reporting.json'), 'utf-8');
    await activate(context);
    const info = answer('Rename');

    await vscode.commands.executeCommand('erdStudio.resolveDuplicateModel', ignored());

    const modal = info.mock.calls.find((c) => String(c[0]).startsWith('Rename the duplicate'))!;
    const detail = (modal[1] as { detail: string }).detail;
    expect(detail).toContain('logical-models/silver/date.yml → logical-models/silver/silver_date.yml');
    expect(detail).toContain('silver/calendar');
    expect(detail).toContain('gold/reporting');

    expect(fs.existsSync(ignored())).toBe(false);
    // The hand-written document is carried over: comment, columns, and the new keys.
    expect(fs.readFileSync(path.join(lib(), 'silver', 'silver_date.yml'), 'utf-8')).toBe(
      '# silver calendar\nname: silver_date\nschema: silver\ncolumns:\n  - name: date_key\n    dataType: int\nalias: date\n',
    );
    const silver = readJson(path.join(erd(), 'silver', 'calendar.json'));
    expect(silver.logical.models).toEqual(['fct_order', 'silver_date']);
    expect(silver.logical.relationships[0].toModel).toBe('silver_date');
    expect(silver.viewConfig.positions).toEqual({ silver_date: { x: 10, y: 20 } });
    // The gold domain keeps the gold file, byte for byte.
    expect(fs.readFileSync(path.join(erd(), 'gold', 'reporting.json'), 'utf-8')).toBe(goldDomainBefore);
    expect(fs.existsSync(path.join(lib(), 'gold', 'date.yml'))).toBe(true);
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/"silver_date" \(warehouse table: date\)\. Repointed 1 subject area\.$/));
  });

  it('changes nothing when the confirmation is dismissed', async () => {
    const silverBefore = fs.readFileSync(path.join(erd(), 'silver', 'calendar.json'), 'utf-8');
    await activate(context);
    answer(undefined);

    await vscode.commands.executeCommand('erdStudio.resolveDuplicateModel', ignored());

    expect(fs.existsSync(ignored())).toBe(true);
    expect(fs.existsSync(path.join(lib(), 'silver', 'silver_date.yml'))).toBe(false);
    expect(fs.readFileSync(path.join(erd(), 'silver', 'calendar.json'), 'utf-8')).toBe(silverBefore);
  });

  it('changes nothing when VS Code rejects the edit', async () => {
    await activate(context);
    answer('Rename');
    vscode._mockWorkspaceState.applyEditResult = false;
    const error = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined as never);

    await vscode.commands.executeCommand('erdStudio.resolveDuplicateModel', ignored());

    expect(error).toHaveBeenCalledWith('VS Code rejected the rename; nothing was changed.');
    expect(fs.existsSync(ignored())).toBe(true);
    expect(readJson(path.join(erd(), 'silver', 'calendar.json')).logical.models).toContain('date');
  });

  it('a rename VS Code applies only part of is put back before it says nothing was changed (D23)', async () => {
    const silverBefore = fs.readFileSync(path.join(erd(), 'silver', 'calendar.json'), 'utf-8');
    const ignoredBefore = fs.readFileSync(ignored(), 'utf-8');
    await activate(context);
    answer('Rename');
    const error = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined as never);
    // The new file lands, then the edit fails; the reconcile applies.
    vscode._mockWorkspaceState.applyEditPrefixes.push(1);

    await vscode.commands.executeCommand('erdStudio.resolveDuplicateModel', ignored());

    expect(error).toHaveBeenCalledWith('VS Code rejected the rename; nothing was changed.');
    expect(fs.existsSync(path.join(lib(), 'silver', 'silver_date.yml'))).toBe(false);
    expect(fs.readFileSync(ignored(), 'utf-8')).toBe(ignoredBefore);
    expect(fs.readFileSync(path.join(erd(), 'silver', 'calendar.json'), 'utf-8')).toBe(silverBefore);
  });

  it('when the reconcile cannot put a file back either, only its modal speaks', async () => {
    await activate(context);
    answer('Rename');
    const error = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined as never);
    vscode._mockWorkspaceState.applyEditPrefixes.push(1, 0);

    await vscode.commands.executeCommand('erdStudio.resolveDuplicateModel', ignored());

    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/could not put back .*silver_date\.yml.*Restore these from source control\.$/), { modal: true });
  });

  it('reports and counts a repointed diagram it could not save as a rename save failure', async () => {
    await activate(context);
    answer('Rename');
    const error = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined as never);
    vscode._failMockSave(path.join(erd(), 'silver', 'calendar.json'));
    const telemetryError = vi.spyOn(telemetry, 'error');

    await vscode.commands.executeCommand('erdStudio.resolveDuplicateModel', ignored());

    expect(error).toHaveBeenCalledWith(expect.stringContaining('Could not save .erd-studio/silver/calendar.json'));
    expect(telemetryError).toHaveBeenCalledWith('saveFailed');
    expect(telemetryError).toHaveBeenCalledWith('saveFailedRefused');
    expect(telemetryError).toHaveBeenCalledWith('saveFailedRename');
    expect(telemetryError).not.toHaveBeenCalledWith('saveFailedModelFile');
  });

  it('records no save failure when the rename saves cleanly', async () => {
    await activate(context);
    answer('Rename');
    const telemetryError = vi.spyOn(telemetry, 'error');

    await vscode.commands.executeCommand('erdStudio.resolveDuplicateModel', ignored());

    expect(telemetryError).not.toHaveBeenCalledWith('saveFailed');
    expect(telemetryError).not.toHaveBeenCalledWith('saveFailedRename');
  });

  it('says so when there is no duplicate to fix', async () => {
    fs.rmSync(ignored());
    await activate(context);
    const info = answer('Rename');

    await vscode.commands.executeCommand('erdStudio.resolveDuplicateModel');

    expect(info).toHaveBeenCalledWith('Every table file in the library has its own name.');
  });
});

describe('erdStudio.renameDomain on a JSON diagram (D23: one edit through applyFileWrites)', () => {
  const erd = (...p: string[]) => path.join(root, '.erd-studio', ...p);
  const element = () => ({ type: 'domain', summary: { domain: 'bob', layer: 'silver', filePath: erd('silver', 'bob.json'), storage: 'json' } });

  beforeEach(() => {
    fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
    openWorkspace(root);
  });

  it('renames the file, recording both halves as its own writes', async () => {
    await activate(context);
    const { ownWrites } = await import('../../src/services/ownWriteTracker');
    const written = vi.spyOn(ownWrites, 'recordWrite');
    const deleted = vi.spyOn(ownWrites, 'recordDelete');
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValueOnce('robert');
    await vscode.commands.executeCommand('erdStudio.renameDomain', element());
    expect(fs.existsSync(erd('silver', 'bob.json'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(erd('silver', 'robert.json'), 'utf-8')).domain).toBe('robert');
    expect(written).toHaveBeenCalledWith(erd('silver', 'robert.json'));
    expect(deleted).toHaveBeenCalledWith(erd('silver', 'bob.json'));
  });

  it('refreshes the table library and open canvases itself, since the watcher skips its own writes', async () => {
    await activate(context);
    const { TableLibraryTreeProvider } = await import('../../src/providers/ModelLibraryTreeProvider');
    const { SemanticEditorProvider } = await import('../../src/providers/SemanticEditorProvider');
    const library = vi.spyOn(TableLibraryTreeProvider.prototype, 'refresh');
    const presence = vi.spyOn(SemanticEditorProvider.prototype, 'syncSubjectAreaFilePresence');
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValueOnce('robert');
    await vscode.commands.executeCommand('erdStudio.renameDomain', element());
    expect(fs.existsSync(erd('silver', 'robert.json'))).toBe(true);
    expect(library).toHaveBeenCalled();
    expect(presence).toHaveBeenCalled();
  });

  it('an edit VS Code applies only part of is put back before it says nothing was changed', async () => {
    const before = fs.readFileSync(erd('silver', 'bob.json'), 'utf-8');
    await activate(context);
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValueOnce('robert');
    const error = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined as never);
    // The new file lands, then the delete fails; the reconcile applies.
    vscode._mockWorkspaceState.applyEditPrefixes.push(1);
    await vscode.commands.executeCommand('erdStudio.renameDomain', element());
    expect(error).toHaveBeenCalledWith('Failed to rename subject area "bob" to "robert". Nothing was changed.');
    expect(fs.existsSync(erd('silver', 'robert.json'))).toBe(false);
    expect(fs.readFileSync(erd('silver', 'bob.json'), 'utf-8')).toBe(before);
  });

  it('when the reconcile cannot put a file back either, only its modal speaks', async () => {
    await activate(context);
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValueOnce('robert');
    const error = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined as never);
    vscode._mockWorkspaceState.applyEditPrefixes.push(1, 0);
    await vscode.commands.executeCommand('erdStudio.renameDomain', element());
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/could not put back .*robert\.json.*Restore these from source control\.$/), { modal: true });
  });
});

describe('activate() project-root resolution', () => {
  it('reads projectPath through getErdStudioSetting, so a legacy dbtSemantic.projectPath still wins over auto-detection', async () => {
    // Two candidate projects: auto-detection would pick "a" (shallowest, sorted first);
    // the pre-rename setting points at "b".
    fs.cpSync(FIXTURE_ROOT, path.join(root, 'a'), { recursive: true });
    fs.cpSync(FIXTURE_ROOT, path.join(root, 'b'), { recursive: true });
    openWorkspace(root);
    vscode._setMockConfiguration('dbtSemantic', 'projectPath', { workspaceValue: 'b' });

    await activate(context);

    expect(lastFoundProjectLine()).toBe(`ERD Studio: Found dbt project at ${path.join(root, 'b')}`);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('Open a folder first'), expect.anything());
  });

  it('an explicit erdStudio.projectPath beats the legacy one', async () => {
    fs.cpSync(FIXTURE_ROOT, path.join(root, 'a'), { recursive: true });
    fs.cpSync(FIXTURE_ROOT, path.join(root, 'b'), { recursive: true });
    openWorkspace(root);
    vscode._setMockConfiguration('dbtSemantic', 'projectPath', { workspaceValue: 'b' });
    vscode._setMockConfiguration('erdStudio', 'projectPath', { globalValue: 'a' });

    await activate(context);

    expect(lastFoundProjectLine()).toBe(`ERD Studio: Found dbt project at ${path.join(root, 'a')}`);
  });
});

describe('selectors.yml is a dbt file (#111)', () => {
  // The fixture's diagrams (subject areas with tables), in a folder with or without dbt_project.yml.
  function project(dir: string, withDbt: boolean): void {
    fs.cpSync(path.join(FIXTURE_ROOT, '.erd-studio'), path.join(dir, '.erd-studio'), { recursive: true });
    if (withDbt) { fs.copyFileSync(path.join(FIXTURE_ROOT, 'dbt_project.yml'), path.join(dir, 'dbt_project.yml')); }
  }

  it('activation in a plain folder named by erdStudio.projectPath writes no selectors.yml', async () => {
    const plain = path.join(root, 'plain');
    project(plain, false);
    openWorkspace(root);
    vscode._setMockConfiguration('erdStudio', 'projectPath', { workspaceValue: 'plain' });

    await activate(context);
    vi.advanceTimersByTime(1000); // past the 250 ms regenerate debounce

    expect(fs.existsSync(path.join(plain, 'selectors.yml'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'selectors.yml'))).toBe(false);
  });

  it('Regenerate dbt selectors.yml explains instead of writing in a plain folder', async () => {
    const plain = path.join(root, 'plain');
    project(plain, false);
    openWorkspace(root);
    vscode._setMockConfiguration('erdStudio', 'projectPath', { workspaceValue: 'plain' });
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);

    await activate(context);
    await vscode.commands.executeCommand('erdStudio.syncDomainTags');

    expect(info).toHaveBeenCalledWith('This folder is not a dbt project, so there is no selectors.yml to generate.');
    expect(fs.existsSync(path.join(plain, 'selectors.yml'))).toBe(false);
  });

  it('activation in a dbt project still writes selectors.yml for its diagrams', async () => {
    const dbt = path.join(root, 'dbt');
    project(dbt, true);
    openWorkspace(dbt);

    await activate(context);
    vi.advanceTimersByTime(1000); // past the 250 ms regenerate debounce

    const written = fs.readFileSync(path.join(dbt, 'selectors.yml'), 'utf-8');
    expect(written).toContain('Managed by ERD Studio.');
  });
});

describe('Select dbt Project… (#82)', () => {
  type Pick = { label: string; projectRoot?: string };
  let a: string;
  let b: string;

  beforeEach(() => {
    // Two root folders, both dbt projects with ERD data: auto-detection opens "a".
    a = path.join(root, 'a');
    b = path.join(root, 'b');
    fs.cpSync(FIXTURE_ROOT, a, { recursive: true });
    fs.cpSync(FIXTURE_ROOT, b, { recursive: true });
    vscode.workspace.workspaceFolders = [
      { uri: vscode.Uri.file(a), name: 'a', index: 0 },
      { uri: vscode.Uri.file(b), name: 'b', index: 1 },
    ];
  });

  it('a pick stored per machine opens that project, and nothing is written to settings', async () => {
    const ws = new Map<string, unknown>([['erdStudio.harnessInstallPrompted', true]]);
    context = makeContext(root, { workspaceState: ws });
    await activate(context);
    expect(lastFoundProjectLine()).toBe(`ERD Studio: Found dbt project at ${a}`);

    const quickPick = vi.spyOn(vscode.window, 'showQuickPick').mockImplementation(
      (async (items: Pick[]) => items.find((i) => i.projectRoot === b)) as never,
    );
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue('Switch and Reload' as never);
    const exec = vi.spyOn(vscode.commands, 'executeCommand');
    const update = vi.fn();
    vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({ get: () => undefined, inspect: () => undefined, update } as never);

    await vscode.commands.executeCommand('erdStudio.selectDbtProject');

    const items = quickPick.mock.calls[0][0] as unknown as Pick[];
    expect(items[0].label).toContain('Auto-detect');
    expect(items.filter((i) => i.projectRoot).map((i) => i.projectRoot)).toEqual([a, b]);
    expect(ws.get('erdStudio.selectedProjectRoot')).toBe(b);
    expect(exec).toHaveBeenCalledWith('workbench.action.reloadWindow');
    expect(update).not.toHaveBeenCalled();

    // "After the reload": the stored pick is honoured.
    tearDownActivation();
    (console.log as unknown as ReturnType<typeof vi.fn>).mockClear();
    vi.restoreAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
    await activate(context);
    expect(lastFoundProjectLine()).toBe(`ERD Studio: Found dbt project at ${b}`);
  });

  it('Auto-detect clears the pick and reloads back to the auto-detected project', async () => {
    const ws = new Map<string, unknown>([['erdStudio.harnessInstallPrompted', true], ['erdStudio.selectedProjectRoot', b]]);
    context = makeContext(root, { workspaceState: ws });
    await activate(context);
    expect(lastFoundProjectLine()).toBe(`ERD Studio: Found dbt project at ${b}`);

    vi.spyOn(vscode.window, 'showQuickPick').mockImplementation(
      (async (items: Pick[]) => items.find((i) => i.label.includes('Auto-detect'))) as never,
    );
    const confirm = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue('Switch and Reload' as never);
    const exec = vi.spyOn(vscode.commands, 'executeCommand');

    await vscode.commands.executeCommand('erdStudio.selectDbtProject');

    expect(confirm).toHaveBeenCalledWith('Switch ERD Studio to “a”?', expect.objectContaining({ modal: true }), 'Switch and Reload');
    expect(ws.has('erdStudio.selectedProjectRoot') ? ws.get('erdStudio.selectedProjectRoot') : undefined).toBeUndefined();
    expect(exec).toHaveBeenCalledWith('workbench.action.reloadWindow');
  });

  it('cancelling the confirmation changes nothing', async () => {
    const ws = new Map<string, unknown>([['erdStudio.harnessInstallPrompted', true]]);
    context = makeContext(root, { workspaceState: ws });
    await activate(context);
    vi.spyOn(vscode.window, 'showQuickPick').mockImplementation(
      (async (items: Pick[]) => items.find((i) => i.projectRoot === b)) as never,
    );
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    const exec = vi.spyOn(vscode.commands, 'executeCommand');

    await vscode.commands.executeCommand('erdStudio.selectDbtProject');

    expect(ws.get('erdStudio.selectedProjectRoot')).toBeUndefined();
    expect(exec).not.toHaveBeenCalledWith('workbench.action.reloadWindow');
  });

  it('while erdStudio.projectPath decides, it points at the setting instead of offering a list', async () => {
    vscode._setMockConfiguration('erdStudio', 'projectPath', { workspaceValue: b });
    await activate(context);
    const quickPick = vi.spyOn(vscode.window, 'showQuickPick');

    await vscode.commands.executeCommand('erdStudio.selectDbtProject');

    expect(quickPick).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('the erdStudio.projectPath setting chooses'), 'Open Settings');
  });

  it('a projectPath that is not a dbt project is reported, not just logged', async () => {
    vscode._setMockConfiguration('erdStudio', 'projectPath', { workspaceValue: '/Users/someone-else/datamodels' });
    await activate(context);

    expect(warn).toHaveBeenCalledWith(
      'ERD Studio: erdStudio.projectPath "/Users/someone-else/datamodels" is not a folder, so ERD Studio opened a instead.',
      'Open Settings',
    );
  });
});

/** Dispose everything the last activate() registered, as a window reload would. */
function tearDownActivation(): void {
  for (const sub of [...context.subscriptions].reverse()) { (sub as { dispose(): void }).dispose(); }
  context.subscriptions.length = 0;
  vscode._resetRegisteredCommands();
  _resetFirstRunGuardForTests();
}

const panelsOfType = () => vscode.window._webviewPanels.filter((p) => p.viewType === GETTING_STARTED_VIEW_TYPE);

describe('Welcome panel: commands', () => {
  it('erdStudio.showGettingStarted works without a project, is registered once and pre-registered', async () => {
    await activate(context);

    expect(count('erdStudio.showGettingStarted')).toBe(1);
    expect(registered().indexOf('erdStudio.showGettingStarted')).toBe(1);
    expect(PRE_REGISTERED_COMMANDS).toEqual(
      new Set(['erdStudio.reportBug', 'erdStudio.showGettingStarted', 'erdStudio.trySampleProject', 'erdStudio.showLogs']),
    );
    // setupAiHelper needs a project: it gets the standard no-project stub instead.
    expect(count('erdStudio.setupAiHelper')).toBe(1);

    await vscode.commands.executeCommand('erdStudio.showGettingStarted');

    expect(panelsOfType()).toHaveLength(1);
    const panel = panelsOfType()[0];
    expect(panel.title).toBe('Welcome to ERD Studio');
    await panel._simulateMessage({ type: 'ready' });
    expect(panel._postedMessages).toContainEqual(
      expect.objectContaining({ type: 'status', payload: expect.objectContaining({ hasProject: false, project: null }) }),
    );

    // A second run reveals the same panel instead of opening another.
    await vscode.commands.executeCommand('erdStudio.showGettingStarted');
    expect(panelsOfType()).toHaveLength(1);
    expect(panel._reveals).toHaveLength(1);
  });

  it('with a project, the panel reports the dbt project and the helper state', async () => {
    fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
    openWorkspace(root);
    await activate(context);

    await vscode.commands.executeCommand('erdStudio.showGettingStarted');
    const panel = panelsOfType()[0];
    await panel._simulateMessage({ type: 'ready' });

    const status = panel._postedMessages.find((m) => (m as { type: string }).type === 'status') as {
      payload: { hasProject: boolean; project: unknown; helper: string; cli: string; domainCount: number };
    };
    expect(status.payload.hasProject).toBe(true);
    expect(status.payload.project).toEqual({ name: path.basename(root), relativePath: null });
    expect(status.payload.cli).toBe('missing');
    expect(status.payload.helper).toBe('missing');
    expect(status.payload.domainCount).toBeGreaterThan(0);
  });
});

describe('erdStudio.trySampleProject', () => {
  const SAMPLE = 'erdStudio.trySampleProject';

  it('is pre-registered once without a project, gets no legacy alias, and runs the real flow (not the stub)', async () => {
    await activate(context);

    expect(count(SAMPLE)).toBe(1);
    expect(registered().indexOf(SAMPLE)).toBe(2); // right after reportBug and showGettingStarted
    expect(count(legacyAlias(SAMPLE))).toBe(0);
    expect(NO_LEGACY_ALIAS.has(SAMPLE)).toBe(true);
    expect(PRE_REGISTERED_COMMANDS.has(SAMPLE)).toBe(true);
    expect(CONTRIBUTED).toContain(SAMPLE);

    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    warn.mockClear();
    await vscode.commands.executeCommand(SAMPLE);
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('Download the ERD Studio sample project?'),
      { modal: true },
      'Download',
    );
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('Open a folder first'), expect.anything());
  });

  it('is registered exactly once with a project too', async () => {
    fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
    openWorkspace(root);
    await activate(context);
    expect(count(SAMPLE)).toBe(1);
    expect(count(legacyAlias(SAMPLE))).toBe(0);
  });
});

/** Spy on executeCommand and return the walkthrough opens it saw. */
function spyWalkthrough(opts: { fail?: boolean } = {}) {
  const real = vscode.commands.executeCommand;
  const spy = vi.spyOn(vscode.commands, 'executeCommand').mockImplementation((async (command: string, ...args: unknown[]) => {
    if (command === 'workbench.action.openWalkthrough' && opts.fail) { throw new Error("command 'workbench.action.openWalkthrough' not found"); }
    return real(command, ...args);
  }) as never);
  return () => spy.mock.calls.filter((c) => c[0] === 'workbench.action.openWalkthrough');
}

describe('Welcome panel: first run', () => {
  it('a fresh install opens the walkthrough once, writes the flag first and skips the harness QuickPick', async () => {
    fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
    fs.rmSync(path.join(root, '.claude'), { recursive: true, force: true }); // no harness → the QuickPick would be offered
    openWorkspace(root);
    const globalState = new Map<string, unknown>();
    const workspaceState = new Map<string, unknown>();
    context = makeContext(root, { globalState, workspaceState });
    let shownWhenOpened: unknown = 'not opened';
    const real = vscode.commands.executeCommand;
    const exec = vi.spyOn(vscode.commands, 'executeCommand').mockImplementation((async (command: string, ...args: unknown[]) => {
      if (command === 'workbench.action.openWalkthrough') { shownWhenOpened = globalState.get(GETTING_STARTED_SHOWN_KEY); }
      return real(command, ...args);
    }) as never);
    const pick = vi.spyOn(vscode.window, 'showQuickPick');
    const info = vi.spyOn(vscode.window, 'showInformationMessage');

    await activate(context);

    expect(exec).toHaveBeenCalledWith('workbench.action.openWalkthrough', WALKTHROUGH_ID, false);
    const { publisher, name } = packageJson as unknown as { publisher: string; name: string };
    expect(WALKTHROUGH_ID).toBe(`${publisher}.${name}#erdStudio.getStarted`);
    expect(panelsOfType()).toHaveLength(0); // the walkthrough replaces the Welcome panel
    expect(shownWhenOpened).toBe(true);
    expect(globalState.get(GETTING_STARTED_PENDING_KEY)).toBeUndefined();
    // Skipped for this run only: the once-per-workspace offer is still owed.
    expect(workspaceState.get('erdStudio.harnessInstallPrompted')).toBeUndefined();
    expect(pick).not.toHaveBeenCalled();
    // …and so is the existing-diagrams notice: one prompt at a time.
    expect(info.mock.calls.some((c) => String(c[0]).startsWith('This project has'))).toBe(false);
    expect(workspaceState.get(DIAGRAMS_NUDGE_SHOWN_KEY)).toBeUndefined();

    // The next window on this machine does not open it again.
    tearDownActivation();
    exec.mockClear();
    await activate(context);
    expect(exec.mock.calls.filter((c) => c[0] === 'workbench.action.openWalkthrough')).toHaveLength(0);
  });

  it('falls back to the Welcome panel when the host has no walkthrough command', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
    openWorkspace(root);
    context = makeContext(root, { globalState: new Map<string, unknown>() });
    const opens = spyWalkthrough({ fail: true });

    await activate(context);

    expect(opens()).toHaveLength(1);
    expect(panelsOfType()).toHaveLength(1);
  });

  it('the walkthrough is contributed with the logical-first steps and media that ship', () => {
    const pkg = packageJson as unknown as {
      contributes: { walkthroughs: Array<{ id: string; description: string; steps: Array<{ id: string; when?: string; description: string; media: { svg: string }; completionEvents: string[] }> }> };
    };
    const walkthrough = pkg.contributes.walkthroughs.find((w) => WALKTHROUGH_ID.endsWith(`#${w.id}`))!;
    // Existing ids kept (completion state survives an update); newDiagram and importDbml are new.
    expect(walkthrough.steps.map((s) => s.id)).toEqual(['watch', 'openProject', 'newDiagram', 'draw', 'importDbml', 'enrich', 'sample']);
    const step = (id: string) => walkthrough.steps.find((s) => s.id === id)!;
    // Which window each step shows in: dbt, no folder, a folder without dbt, or always.
    expect(Object.fromEntries(walkthrough.steps.map((s) => [s.id, s.when ?? null]))).toEqual({
      watch: 'erdStudio.hasDbtProject',
      openProject: 'workspaceFolderCount == 0',
      newDiagram: '!erdStudio.hasDbtProject',
      draw: 'erdStudio.hasDbtProject',
      importDbml: null,
      enrich: null,
      sample: '!erdStudio.hasDbtProject',
    });
    expect(step('openProject').completionEvents).toEqual(['onContext:erdStudio.hasProject']);
    expect(step('newDiagram').completionEvents).toEqual(['onCommand:erdStudio.createDomain', 'onCommand:erdStudio.openExampleDiagram']);
    expect(step('importDbml').completionEvents).toEqual(['onCommand:erdStudio.importDbml']);
    expect(step('sample').completionEvents).toEqual(['onCommand:erdStudio.trySampleProject']);
    expect(step('newDiagram').description).toContain('(command:erdStudio.createDomain)');
    // The example is a second button in the same step, not a step of its own.
    expect(step('newDiagram').description).toContain('[Open Example Diagram](command:erdStudio.openExampleDiagram)');
    // Native DBML storage (2.0): format-neutral, because the step also shows in a YAML project from before 2.0;
    // its picture shows a new project, which is DBML.
    expect(step('newDiagram').description).toContain('Each table is a file in .erd-studio/');
    expect(step('newDiagram').description).not.toMatch(/YAML|JSON/);
    expect((step('newDiagram').media as { altText?: string }).altText).toContain('the DBML files a new project keeps it in');
    const svg = fs.readFileSync(path.join(REPO_ROOT, step('newDiagram').media.svg), 'utf-8');
    for (const file of ['sales.dbml', 'sales.dbdiagram', 'customer.dbml', '_relationships.dbml']) expect(svg).toContain(`>${file}</text>`);
    expect(svg).not.toMatch(/\.yml<|sales\.json</);
    expect(step('importDbml').description).toContain('(command:erdStudio.importDbml)');
    expect(step('draw').description).toContain('(command:erdStudio.drawFromDbt)');
    expect(step('sample').description).toContain('(command:erdStudio.trySampleProject)');
    for (const s of walkthrough.steps) {
      expect(fs.existsSync(path.join(REPO_ROOT, s.media.svg)), s.media.svg).toBe(true);
      expect(s.completionEvents.length, s.id).toBeGreaterThan(0);
      // Every command a step's button runs is one of ours (contributed) or a built-in.
      for (const [, command] of s.description.matchAll(/\(command:([\w.]+)\)/g)) {
        expect(command.startsWith('erdStudio.') ? CONTRIBUTED.includes(command) : true, command).toBe(true);
      }
    }
    // media/ ships in the VSIX: .vscodeignore excludes only the README-only images there.
    const ignore = fs.readFileSync(path.join(REPO_ROOT, '.vscodeignore'), 'utf-8').split('\n').map((l) => l.trim());
    expect(ignore.some((l) => /^media\/(\*\*|walkthrough)/.test(l))).toBe(false);
  });

  it('an upgrader gets one non-modal notice and no panel', async () => {
    fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
    openWorkspace(root);
    const globalState = new Map<string, unknown>([['lastActivatedVersion', '1.0.0']]);
    context = makeContext(root, { globalState });
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);

    await activate(context);

    expect(panelsOfType()).toHaveLength(0);
    expect(globalState.get(GETTING_STARTED_SHOWN_KEY)).toBe(true);
    const notices = info.mock.calls.filter((c) => String(c[0]).includes('getting-started video'));
    expect(notices).toHaveLength(1);
    expect(notices[0].slice(1)).toEqual(['Watch', 'Not now']);
  });

  it('"Watch" on the upgrade notice opens the panel', async () => {
    fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
    openWorkspace(root);
    context = makeContext(root, { globalState: new Map<string, unknown>([['lastActivatedVersion', '1.0.0']]) });
    vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async (message: string) =>
      (message.includes('getting-started video') ? 'Watch' : undefined)) as never);

    await activate(context);
    await vi.waitFor(() => expect(panelsOfType()).toHaveLength(1));
  });

  it('no-project activation first opens the walkthrough, and the first project activation opens it once more', async () => {
    const globalState = new Map<string, unknown>();
    context = makeContext(root, { globalState });
    const warn = vi.spyOn(vscode.window, 'showWarningMessage');
    const opens = spyWalkthrough();

    await activate(context); // no workspace folder: early return
    expect(opens()).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
    expect(globalState.get(GETTING_STARTED_NO_PROJECT_SHOWN_KEY)).toBe(true);
    // Still owed in a project, where the setup steps can run.
    expect(globalState.get(GETTING_STARTED_PENDING_KEY)).toBe(true);
    expect(globalState.get(GETTING_STARTED_SHOWN_KEY)).toBeUndefined();

    tearDownActivation();
    for (const p of panelsOfType()) { p.dispose(); }
    vscode._resetMockWebviewPanels();
    fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
    openWorkspace(root);

    // lastActivatedVersion is stored now, so without the pending flag this would look like an upgrade.
    await activate(context);

    expect(opens()).toHaveLength(2);
    expect(globalState.get(GETTING_STARTED_SHOWN_KEY)).toBe(true);
    expect(globalState.get(GETTING_STARTED_PENDING_KEY)).toBeUndefined();
  });

  it('opens the walkthrough in a no-project window only once, then stays quiet', async () => {
    const globalState = new Map<string, unknown>();
    context = makeContext(root, { globalState });
    const opens = spyWalkthrough();
    await activate(context);
    expect(opens()).toHaveLength(1);

    tearDownActivation();
    await activate(context);
    expect(opens()).toHaveLength(1);
    expect(panelsOfType()).toHaveLength(0);
    expect(GettingStartedPanel.currentPanel).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('never opens the panel on a no-project activation after the Welcome was already shown', async () => {
    context = makeContext(root); // default globalState: the Welcome was already shown on this machine
    await activate(context);
    expect(panelsOfType()).toHaveLength(0);
    expect(GettingStartedPanel.currentPanel).toBeUndefined();
  });

  it('sets erdStudio.hasProject and erdStudio.hasDbtProject for the sidebar welcome text', async () => {
    const exec = vi.spyOn(vscode.commands, 'executeCommand');
    const keys = () => Object.fromEntries(exec.mock.calls
      .filter((c) => c[0] === 'setContext' && /^erdStudio\.has(Project|DbtProject)$/.test(String(c[1])))
      .map((c) => [c[1], c[2]]));
    context = makeContext(root);
    await activate(context); // empty window
    expect(keys()).toEqual({ 'erdStudio.hasProject': false, 'erdStudio.hasDbtProject': false });

    tearDownActivation();
    exec.mockClear();
    openWorkspace(root); // a plain folder: a project, but not a dbt one
    await activate(context);
    expect(keys()).toEqual({ 'erdStudio.hasProject': true, 'erdStudio.hasDbtProject': false });

    tearDownActivation();
    exec.mockClear();
    fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
    await activate(context);
    expect(keys()).toEqual({ 'erdStudio.hasProject': true, 'erdStudio.hasDbtProject': true });
  });
});

describe('erdStudio.drawFromDbt', () => {
  const erd = () => path.join(root, '.erd-studio');
  const lib = () => path.join(erd(), 'logical-models');
  type ScopeItem = { label: string; scope?: { folder?: string; modelNames: string[] } };

  beforeEach(() => {
    fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
    openWorkspace(root);
  });

  /** Pick the dbt folder scope `folder`, accept the suggested name; returns the spies. */
  function answer(folder: string, name?: string) {
    const quickPick = vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (items: ScopeItem[]) =>
      items.find((i) => i.scope?.folder === folder)) as never);
    const input = vi.spyOn(vscode.window, 'showInputBox').mockImplementation((async (opts?: { value?: string }) =>
      name ?? opts?.value) as never);
    const real = vscode.commands.executeCommand;
    const exec = vi.spyOn(vscode.commands, 'executeCommand').mockImplementation((async (command: string, ...args: unknown[]) =>
      real(command, ...args)) as never);
    const opened = () => exec.mock.calls.filter((c) => c[0] === 'vscode.openWith');
    return { quickPick, input, opened };
  }

  it('is registered once with a project, with no legacy alias', async () => {
    await activate(context);
    expect(count('erdStudio.drawFromDbt')).toBe(1);
    expect(count('dbtSemantic.drawFromDbt')).toBe(0);
  });

  it('in a project with no ERD folder: writes layers.json, the models into the layer folder and a fresh domain, then opens it', async () => {
    fs.rmSync(erd(), { recursive: true, force: true });
    await activate(context);
    const { input, opened } = answer('silver');

    await vscode.commands.executeCommand('erdStudio.drawFromDbt');

    // The dbt folder "silver" is a layer here, so the layer is not asked for.
    expect((input.mock.calls[0][0] as { value: string; prompt: string }).value).toBe('silver');
    expect((input.mock.calls[0][0] as { prompt: string }).prompt).toContain('Silver layer');
    expect(fs.existsSync(path.join(erd(), 'layers.json'))).toBe(true);
    // A new project is written as DBML (native DBML storage, §3.2).
    const domainPath = path.join(erd(), 'silver', 'silver.dbml');
    const domain = parseSubjectAreaDbml(fs.readFileSync(domainPath, 'utf-8'), 'silver/silver.dbml', null).obj as {
      domain: string; layer: string; logical: { models: string[]; relationships: unknown[] };
    };
    expect(domain.domain).toBe('silver');
    expect(domain.layer).toBe('silver');
    expect(fs.existsSync(path.join(erd(), 'silver', 'silver.dbdiagram'))).toBe(false); // fresh: the canvas lays it out on first open
    expect(domain.logical.models.length).toBeGreaterThan(1);
    expect(domain.logical.models).not.toContain('dim_region'); // a .sql with no columns to copy
    // An empty library is grouped by layer from the start, in tables/.
    for (const model of domain.logical.models) {
      expect(fs.existsSync(path.join(erd(), 'tables', 'silver', `${model}.dbml`)), model).toBe(true);
    }
    expect(fs.existsSync(lib())).toBe(false);
    expect(opened()).toHaveLength(1);
    expect(String((opened()[0][1] as { fsPath: string }).fsPath)).toBe(domainPath);
    expect(opened()[0][2]).toBe(SUBJECT_AREA_EDITOR_VIEW_TYPE);
    // A diagram the user just made opens in a tab that stays (#167).
    expect(opened()[0][3]).toBeUndefined();
  });

  it('keeps a flat library flat and only references models the library already has', async () => {
    const customerBefore = fs.readFileSync(path.join(lib(), 'dim_customer.yml'), 'utf-8');
    fs.rmSync(path.join(lib(), 'dim_project.yml'));
    await activate(context);
    answer('silver', 'drawn');

    await vscode.commands.executeCommand('erdStudio.drawFromDbt');

    const domain = JSON.parse(fs.readFileSync(path.join(erd(), 'silver', 'drawn.json'), 'utf-8')) as { logical: { models: string[] } };
    expect(domain.logical.models).toContain('dim_project');
    expect(fs.existsSync(path.join(lib(), 'dim_project.yml'))).toBe(true);
    expect(fs.existsSync(path.join(lib(), 'silver'))).toBe(false);
    expect(fs.readFileSync(path.join(lib(), 'dim_customer.yml'), 'utf-8')).toBe(customerBefore);
  });

  it('writes nothing when the name box is cancelled', async () => {
    const before = fs.readdirSync(path.join(erd(), 'silver')).sort();
    fs.rmSync(path.join(lib(), 'dim_project.yml'));
    await activate(context);
    const { input, opened } = answer('silver');
    input.mockResolvedValue(undefined);

    await vscode.commands.executeCommand('erdStudio.drawFromDbt');

    expect(fs.readdirSync(path.join(erd(), 'silver')).sort()).toEqual(before);
    expect(fs.existsSync(path.join(lib(), 'dim_project.yml'))).toBe(false);
    expect(opened()).toHaveLength(0);
  });

  it('refuses a name that is already a diagram in that layer', async () => {
    await activate(context);
    const { input } = answer('silver');
    input.mockResolvedValue(undefined);

    await vscode.commands.executeCommand('erdStudio.drawFromDbt');

    const validate = (input.mock.calls[0][0] as { validateInput: (v: string) => string | undefined }).validateInput;
    expect(validate('showcase')).toContain('already exists in the silver layer');
    expect(validate('Bad Name')).toBeDefined();
    expect(validate('brand-new')).toBeUndefined();
  });

  it('says how to get models when dbt has none to draw', async () => {
    fs.rmSync(path.join(root, 'models'), { recursive: true, force: true });
    fs.rmSync(path.join(root, 'target'), { recursive: true, force: true });
    await activate(context);
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    const quickPick = vi.spyOn(vscode.window, 'showQuickPick');

    await vscode.commands.executeCommand('erdStudio.drawFromDbt');

    expect(quickPick).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.stringContaining('columns:'));
  });
});

describe('ERD Studio diagrams status bar item', () => {
  type Item = { text: string; name?: string; command?: string; visible: boolean };
  function spyStatusBar(): Item[] {
    const items: Item[] = [];
    vi.spyOn(vscode.window, 'createStatusBarItem').mockImplementation(((id: unknown) => {
      const item: Item & { show(): void; hide(): void; dispose(): void; tooltip?: string } = {
        text: '', visible: false,
        show() { item.visible = true; }, hide() { item.visible = false; }, dispose() { item.visible = false; },
      };
      if (id === DIAGRAMS_STATUS_ID) { items.push(item); }
      return item;
    }) as never);
    return items;
  }

  beforeEach(() => {
    fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
    openWorkspace(root);
  });

  it('shows "ERD N" and opens a diagram picker when the project has diagrams', async () => {
    const items = spyStatusBar();
    await activate(context);

    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item.visible).toBe(true);
    expect(item.text).toMatch(/^\$\(type-hierarchy\) ERD \d+$/);
    expect(item.name).toBe('ERD Studio diagrams');
    expect(item.command).toBe('erdStudio.openDomain');

    // With no file argument, openDomain asks which diagram.
    const quickPick = vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue(undefined);
    await vscode.commands.executeCommand(item.command!);
    expect(quickPick).toHaveBeenCalledTimes(1);
  });

  it('is hidden with no diagrams and appears once Draw from dbt creates one', async () => {
    fs.rmSync(path.join(root, '.erd-studio'), { recursive: true, force: true });
    const items = spyStatusBar();
    await activate(context);
    expect(items[0].visible).toBe(false);

    vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (entries: Array<{ scope?: { folder?: string } }>) =>
      entries.find((e) => e.scope?.folder === 'silver')) as never);
    vi.spyOn(vscode.window, 'showInputBox').mockImplementation((async (opts?: { value?: string }) => opts?.value) as never);
    await vscode.commands.executeCommand('erdStudio.drawFromDbt');

    expect(items[0].visible).toBe(true);
    expect(items[0].text).toBe('$(type-hierarchy) ERD 1');
  });
});

describe('existing-diagrams notice', () => {
  const nudgeCalls = (info: ReturnType<typeof vi.spyOn>) =>
    info.mock.calls.filter((c) => String(c[0]).startsWith('This project has'));

  beforeEach(() => {
    fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
    openWorkspace(root);
  });

  it('is shown once per workspace, offering the most recently changed diagram', async () => {
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(root, '.erd-studio', 'gold', 'finance.json'), future, future);
    const workspaceState = new Map<string, unknown>([['erdStudio.harnessInstallPrompted', true]]);
    context = makeContext(root, { workspaceState });
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async (message: string) =>
      (message.startsWith('This project has') ? 'Open finance' : undefined)) as never);
    const snapshot = () => fs.readdirSync(path.join(root, '.erd-studio'), { recursive: true, encoding: 'utf-8' }).sort()
      .map((f) => {
        const full = path.join(root, '.erd-studio', f);
        return fs.statSync(full).isFile() ? `${f}:${fs.readFileSync(full, 'utf-8')}` : f;
      });
    const before = snapshot();
    const exec = vi.spyOn(vscode.commands, 'executeCommand');

    await activate(context);

    const calls = nudgeCalls(info);
    expect(calls).toHaveLength(1);
    expect(String(calls[0][0])).toMatch(/^This project has \d+ ERD Studio diagrams\.$/);
    expect(calls[0].slice(1)).toEqual(['Open finance', 'Not now']);
    expect(workspaceState.get(DIAGRAMS_NUDGE_SHOWN_KEY)).toBe(true);
    // Choosing it opens that domain in the canvas.
    await vi.waitFor(() => expect(exec).toHaveBeenCalledWith('erdStudio.openDomain', path.join(root, '.erd-studio', 'gold', 'finance.json')));
    // Nothing in the ERD folder is written for it.
    expect(snapshot()).toEqual(before);

    tearDownActivation();
    info.mockClear();
    await activate(context);
    expect(nudgeCalls(info)).toHaveLength(0);
  });

  it('is not shown while a diagram is already open', async () => {
    const workspaceState = new Map<string, unknown>([['erdStudio.harnessInstallPrompted', true]]);
    context = makeContext(root, { workspaceState });
    vscode.window.tabGroups.all = [{
      tabs: [{ input: new vscode.TabInputCustom(vscode.Uri.file(path.join(root, '.erd-studio', 'silver', 'showcase.json')), SUBJECT_AREA_EDITOR_VIEW_TYPE) }],
    }];
    const info = vi.spyOn(vscode.window, 'showInformationMessage');

    await activate(context);

    expect(nudgeCalls(info)).toHaveLength(0);
    expect(workspaceState.get(DIAGRAMS_NUDGE_SHOWN_KEY)).toBeUndefined();
  });

  it('is not shown in a project with no diagrams', async () => {
    fs.rmSync(path.join(root, '.erd-studio'), { recursive: true, force: true });
    const workspaceState = new Map<string, unknown>([['erdStudio.harnessInstallPrompted', true]]);
    context = makeContext(root, { workspaceState });
    const info = vi.spyOn(vscode.window, 'showInformationMessage');

    await activate(context);

    expect(nudgeCalls(info)).toHaveLength(0);
    expect(workspaceState.get(DIAGRAMS_NUDGE_SHOWN_KEY)).toBeUndefined();
  });
});

describe('erdStudio.exportDiagram', () => {
  type Pick = { label: string; format?: string; action?: string; summary?: { filePath: string } };
  const showcase = () => path.join(root, '.erd-studio', 'silver', 'showcase.json');

  beforeEach(() => {
    fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
    openWorkspace(root);
  });

  /** Answer the format and action QuickPicks (and a domain pick by name); returns the spies. */
  function answer(format: 'mermaid' | 'dbml', action: 'copy' | 'open' | 'save', domain?: string) {
    const quickPick = vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (items: Pick[]) =>
      items.find((i) => i.format === format || i.action === action || (domain !== undefined && i.label === domain))) as never);
    const clipboard = vi.spyOn(vscode.env.clipboard, 'writeText').mockResolvedValue(undefined);
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    return { quickPick, clipboard, info };
  }

  it('is contributed for the palette and the domain tree\'s context menu, and registered once with no legacy alias', async () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8')) as {
      contributes: { commands: Array<{ command: string; title: string; category: string; icon?: string }>;
        menus: Record<string, Array<{ command: string; when?: string }>> };
    };
    expect(pkg.contributes.commands.find((c) => c.command === 'erdStudio.exportDiagram'))
      .toEqual({ command: 'erdStudio.exportDiagram', title: 'Export Diagram…', category: 'ERD Studio', icon: '$(export)' });
    expect(pkg.contributes.menus['view/item/context'].find((m) => m.command === 'erdStudio.exportDiagram')?.when)
      .toBe('view == erdStudio.domainTree && viewItem == domain');
    // Nothing hides it from the command palette.
    expect(pkg.contributes.menus.commandPalette?.find((m) => m.command === 'erdStudio.exportDiagram')).toBeUndefined();

    await activate(context);
    expect(count('erdStudio.exportDiagram')).toBe(1);
    expect(count('dbtSemantic.exportDiagram')).toBe(0);
  });

  it('exports the domain the tree node names, as the canvas reads it', async () => {
    await activate(context);
    const { clipboard } = answer('mermaid', 'copy');

    await vscode.commands.executeCommand('erdStudio.exportDiagram', {
      type: 'domain', summary: { filePath: showcase(), domain: 'showcase', layer: 'silver' },
    });

    expect(clipboard).toHaveBeenCalledTimes(1);
    const text = clipboard.mock.calls[0][0] as string;
    expect(text.startsWith('erDiagram\n%% erd-studio mermaid-export v1\n')).toBe(true);
  });

  it('without an argument or a focused canvas, asks which diagram with the domain picker', async () => {
    await activate(context);
    const { quickPick, clipboard } = answer('dbml', 'copy', 'showcase');

    await vscode.commands.executeCommand('erdStudio.exportDiagram');

    expect((quickPick.mock.calls[0][1] as { placeHolder: string }).placeHolder).toBe('Export which diagram?');
    expect(clipboard).toHaveBeenCalledTimes(1);
    expect((clipboard.mock.calls[0][0] as string).startsWith('// erd-studio dbml-export v1')).toBe(true);
  });

  it('a domain that cannot be read shows its error', async () => {
    await activate(context);
    answer('dbml', 'copy');
    const shown = vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined as never);

    await vscode.commands.executeCommand('erdStudio.exportDiagram', vscode.Uri.file(path.join(root, '.erd-studio', 'silver', 'missing.json')));

    expect(shown).toHaveBeenCalledWith(
      ".erd-studio/silver/missing.json can't be exported because the diagram file has a problem: it was deleted or renamed.",
    );
  });
});

describe('ERD Studio output channel and Show Logs', () => {
  const logChannels = () => vscode._outputChannels.filter((c) => c.name === 'ERD Studio');

  it('works in an empty window: the channel is the log sink and Show Logs opens it', async () => {
    clearLogBuffer();
    const before = logChannels().length;
    await activate(context);

    expect(logChannels()).toHaveLength(before + 1);
    expect(hasLogSink()).toBe(true);
    expect(count('erdStudio.showLogs')).toBe(1);
    // Registered after the three that must come first; reportBug stays registered()[0].
    expect(registered()[0]).toBe('erdStudio.reportBug');
    const channel = logChannels().at(-1)!;
    expect(channel._lines.some((l) => /\[info\] ERD Studio .* activating \(VS Code /.test(l))).toBe(true);

    await vscode.commands.executeCommand('erdStudio.showLogs');
    expect(channel._shown).toBe(1);
  });

  it('logs what kind of project opened: storage, table and diagram counts, dbt or not', async () => {
    clearLogBuffer();
    openWorkspace(FIXTURE_ROOT);
    await activate(context);
    const summary = recentLogLines().find((l) => l.includes('Project: '));
    expect(summary).toMatch(/Project: (DBML|YAML|mixed \(DBML and YAML\)) storage, \d+ table file\(s\), \d+ diagram\(s\), dbt project; project read \d+ ms into activation/);
  });

  it('logs the whole activation time at the end of activate(), after the project summary', async () => {
    clearLogBuffer();
    openWorkspace(FIXTURE_ROOT);
    await activate(context);
    const lines = recentLogLines();
    const total = lines.findIndex((l) => /\[info\] Activated in \d+ ms$/.test(l));
    expect(total).toBeGreaterThan(lines.findIndex((l) => l.includes('Project: ')));
  });

  it('disposing the extension unplugs the sink', async () => {
    await activate(context);
    expect(hasLogSink()).toBe(true);
    for (const sub of [...context.subscriptions].reverse()) await sub.dispose();
    context.subscriptions.length = 0;
    expect(hasLogSink()).toBe(false);
  });
});
