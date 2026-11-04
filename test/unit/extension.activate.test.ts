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
import { START_COMMAND, parseStartArgs, startCommandLink } from '../../src/types/startActions';
import { CONVERT_NOTICE_BUTTON, convertNoticeMessage } from '../../src/services/convertOffer';
import { DBML_CONVERSION_DECLINED_KEY } from '../../src/providers/SemanticEditorProvider';

import { parseSubjectAreaDbml } from '@erd-studio/core/dbml';
import { answerDraft, closeDraft, flush, nextDraft } from './helpers/draftDriver';

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

/** The start suggestion was answered in this folder: it no longer takes the window's one prompt. */
const SUGGESTIONS_ANSWERED: [string, unknown] = ['erdStudio.startSuggestion', { shown: 1, answered: true }];

function makeContext(
  root: string,
  opts: { globalState?: Map<string, unknown>; workspaceState?: Map<string, unknown> } = {},
): Context {
  // The Welcome panel was already shown on this "machine", so the first-run
  // trigger stays out of the way of the tests that are not about it.
  const globalState = opts.globalState ?? new Map<string, unknown>([['erdStudio.gettingStartedShown', true]]);
  // Pretend the harness-install QuickPick, the existing-diagrams notice and
  // the start suggestion were already offered for this workspace.
  const workspaceState = opts.workspaceState ?? new Map<string, unknown>([
    ['erdStudio.harnessInstallPrompted', true],
    ['erdStudio.diagramsNudgeShown', true],
    SUGGESTIONS_ANSWERED,
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
/** The mock's own executeCommand, for spies that pass some commands through. */
const realExecute = vscode.commands.executeCommand;
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

  it('registers Format Document for .dbml files once (all four DBML language ids), before the no-project early return', async () => {
    const before = vscode._formattingProviders.length;
    await activate(context);
    const added = vscode._formattingProviders.slice(before);
    expect(added.map((p) => p.selector)).toEqual([
      [{ language: 'dbml' }, { language: 'dbml-table' }, { language: 'dbml-relationships' }, { language: 'dbml-diagram' }],
    ]);
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
    // An empty window is not a dbt project: the sentence says nothing about dbt.
    expect(warn).toHaveBeenCalledWith('ERD Studio: Open a folder first. Any folder works.', 'Open Folder…', 'Open Settings');
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

  it('wires the domain editor (retaining webview context), the tree views and the Explorer decoration provider', async () => {
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
      'erdStudio.relationships',
      'erdStudio.help',
    ]);
    // Diagrams, Table Library and Relationships each fold to their layers with Collapse All.
    const collapsible = createTreeView.mock.calls
      .filter((c) => (c[1] as { showCollapseAll?: boolean }).showCollapseAll === true).map((c) => c[0]);
    expect(collapsible).toEqual(['erdStudio.domainTree', 'erdStudio.modelLibrary', 'erdStudio.relationships']);
    // The Explorer's tooltips only: the sidebar draws layer colours with its own icons.
    expect(registerDecorations).toHaveBeenCalledTimes(1);
    // Every contributed command once, plus a dbtSemantic.* alias for each pre-rename one, plus the rest.
    expect(context.subscriptions.length).toBeGreaterThan(CONTRIBUTED.length + CONTRIBUTED.filter((c) => !NO_LEGACY_ALIAS.has(c)).length);
  });

  it('groups the Relationships view by table by default, or by file from its title toggle, remembered for the workspace', async () => {
    const createTreeView = vi.spyOn(vscode.window, 'createTreeView');
    const exec = vi.spyOn(vscode.commands, 'executeCommand');
    await activate(context);
    const view = createTreeView.mock.calls.find((c) => c[0] === 'erdStudio.relationships')!;
    const provider = (view[1] as { treeDataProvider: { getGrouping(): string } }).treeDataProvider;
    expect(provider.getGrouping()).toBe('table');
    expect(exec).toHaveBeenCalledWith('setContext', 'erdStudio.relationshipsGrouping', 'table');

    await vscode.commands.executeCommand('erdStudio.groupRelationshipsByFile');
    expect(provider.getGrouping()).toBe('file');
    expect(context.workspaceState.get('erdStudio.relationshipsGrouping')).toBe('file');
    expect(exec).toHaveBeenCalledWith('setContext', 'erdStudio.relationshipsGrouping', 'file');

    await vscode.commands.executeCommand('erdStudio.groupRelationshipsByTable');
    expect(provider.getGrouping()).toBe('table');
    expect(context.workspaceState.get('erdStudio.relationshipsGrouping')).toBe('table');
  });

  it('starts the Relationships view grouped by file when the workspace last chose it', async () => {
    const createTreeView = vi.spyOn(vscode.window, 'createTreeView');
    const remembered = makeContext(root, { workspaceState: new Map<string, unknown>([
      ['erdStudio.harnessInstallPrompted', true],
      ['erdStudio.diagramsNudgeShown', true],
      ['erdStudio.relationshipsGrouping', 'file'],
    ]) });
    // Disposed with the rest after the test.
    context = remembered;
    await activate(remembered);
    const view = createTreeView.mock.calls.find((c) => c[0] === 'erdStudio.relationships')!;
    expect((view[1] as { treeDataProvider: { getGrouping(): string } }).treeDataProvider.getGrouping()).toBe('file');
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

  it('the ERD Studio view has a provider from where hasProject is set and shows "Loading diagrams…" (no rows) until the real listing, so neither "no data provider" nor "No diagrams yet" shows', async () => {
    const order: string[] = [];
    const exec = vi.spyOn(vscode.commands, 'executeCommand');
    exec.mockImplementation((async (command: string, ...args: unknown[]) => {
      if (command === 'setContext') order.push(`${String(args[0])}=${String(args[1])}`);
      return undefined;
    }) as never);
    const createTreeView = vi.spyOn(vscode.window, 'createTreeView').mockImplementation(((id: string) => {
      order.push(`createTreeView:${id}`);
      return { dispose: () => {} };
    }) as never);
    const registerEditor = vi.spyOn(vscode.window, 'registerCustomEditorProvider');
    await activate(context);
    // Registered once, right where hasProject is set: before any service,
    // the canvas's editor provider or any other view.
    expect(createTreeView.mock.calls.filter((c) => c[0] === 'erdStudio.domainTree')).toHaveLength(1);
    const at = (entry: string): number => order.indexOf(entry);
    expect(at('erdStudio.diagramsLoading=true')).toBeLessThan(at('createTreeView:erdStudio.domainTree'));
    expect(at('erdStudio.hasProject=true')).toBeLessThan(at('createTreeView:erdStudio.domainTree'));
    expect(at('createTreeView:erdStudio.domainTree')).toBeLessThan(at('erdStudio.hasMultipleDbtProjects=false'));
    // Both views' loading keys are set before hasProject, so neither empty state can show first.
    expect(at('erdStudio.tablesLoading=true')).toBeLessThan(at('erdStudio.hasProject=true'));
    expect(at('erdStudio.tablesLoading=true')).toBeLessThan(at('createTreeView:erdStudio.modelLibrary'));
    expect(createTreeView.mock.invocationCallOrder[0]).toBeLessThan(registerEditor.mock.invocationCallOrder[0]);

    const tree = (createTreeView.mock.calls.find((c) => c[0] === 'erdStudio.domainTree')![1] as {
      treeDataProvider: { getChildren(element?: unknown): unknown[] | undefined; onDidChangeTreeData(cb: () => void): void };
    }).treeDataProvider;
    let changes = 0;
    tree.onDidChangeTreeData(() => { changes++; });
    const loadingKeys = (): string[] => order.filter((o) => o.startsWith('erdStudio.diagramsLoading'));
    // VS Code's first request, once activation yields: no rows, so the
    // "Loading diagrams…" welcome shows; the key stays set.
    expect(tree.getChildren()).toEqual([]);
    expect(loadingKeys()).toEqual(['erdStudio.diagramsLoading=true']);
    expect(changes).toBe(0);
    // A turn later the view is told to list again, and lists the diagrams.
    await vi.advanceTimersByTimeAsync(0);
    expect(changes).toBe(1);
    expect((tree.getChildren() ?? []).length).toBeGreaterThan(0);
    // A listing with rows never clears the key: VS Code applies it at once
    // but draws the rows a little later, so "No diagrams yet" flashed.
    expect(loadingKeys()).toEqual(['erdStudio.diagramsLoading=true']);
    tree.getChildren();
    expect(loadingKeys()).toEqual(['erdStudio.diagramsLoading=true']);
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
    expect(patterns).toEqual(['.erd-studio/**/*.{json,dbml}', '.erd-studio/{logical-models,tables}/**/*.yml', '.erd-studio/*/tables/*/*.dbml']);
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

  it('New Diagram works in a folder with no .erd-studio: one Main layer, layers.json first, then the diagram, then it opens', async () => {
    await activate(context);
    // The name as people write it; it is saved as `orders`. No description or dbt folder is asked for.
    const input = vi.spyOn(vscode.window, 'showInputBox').mockResolvedValueOnce('Orders');
    const real = vscode.commands.executeCommand;
    const exec = vi.spyOn(vscode.commands, 'executeCommand').mockImplementation((async (command: string, ...args: unknown[]) =>
      real(command, ...args)) as never);

    await vscode.commands.executeCommand('erdStudio.createDomain');

    // A new project without dbt starts with one neutral layer, so only the name is asked.
    expect(pick).not.toHaveBeenCalled();
    expect(input).toHaveBeenCalledTimes(1);
    expect((input.mock.calls[0][0] as { prompt: string }).prompt).toBe('Name the diagram. It is saved in the Main layer.');
    const layers = JSON.parse(fs.readFileSync(path.join(ws, '.erd-studio', 'layers.json'), 'utf-8')) as { layers: Array<{ id: string; label: string }> };
    expect(layers.layers.map((l) => [l.id, l.label])).toEqual([['main', 'Main']]);
    // A new project stores its diagrams as DBML (native DBML storage, §3.2) in <layer>/diagrams/, with the README that says what the folder is.
    const domainPath = path.join(ws, '.erd-studio', 'main', 'diagrams', 'orders.dbml');
    const domain = parseSubjectAreaDbml(fs.readFileSync(domainPath, 'utf-8'), 'main/diagrams/orders.dbml').obj;
    expect(domain).toMatchObject({ domain: 'orders', layer: 'main' });
    expect(listTree(ws)).toEqual([
      '.erd-studio/', '.erd-studio/README.md', '.erd-studio/layers.json', '.erd-studio/main/', '.erd-studio/main/diagrams/', '.erd-studio/main/diagrams/orders.dbml',
    ]);
    const opened = exec.mock.calls.filter((c) => c[0] === 'vscode.openWith');
    expect((opened[0][1] as { fsPath: string }).fsPath).toBe(domainPath);
    expect(exec).toHaveBeenCalledWith('setContext', 'erdStudio.hasSemanticDir', true);
  });

  it('activation writes no README (and nothing else) in an empty folder: only a create does (§1.7)', async () => {
    await activate(context);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(listTree(ws)).toEqual([]);
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
    // The launcher copies the extension's built dist/cli.js. Give it one, so the
    // test does not depend on `npm run build` having run (it failed without it).
    const extensionRoot = path.join(root, 'extension');
    fs.mkdirSync(path.join(extensionRoot, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(extensionRoot, 'dist', 'cli.js'), '// stub\n');
    (context as { extensionUri: unknown }).extensionUri = vscode.Uri.file(extensionRoot);
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

  it('Open an Example… (and the hidden Open Example Diagram): the coffee-shop draft, nothing asked; Keep This Example writes it into the plain folder', async () => {
    const feature = vi.spyOn(telemetry, 'feature');
    await activate(context);
    const input = vi.spyOn(vscode.window, 'showInputBox').mockImplementation((async (o: { value?: string }) => o.value) as never);
    const real = vscode.commands.executeCommand;
    const exec = vi.spyOn(vscode.commands, 'executeCommand').mockImplementation((async (command: string, ...args: unknown[]) =>
      real(command, ...args)) as never);

    for (const command of ['erdStudio.openExampleProject', 'erdStudio.openExampleDiagram']) {
      const run = vscode.commands.executeCommand(command);
      const draft = await nextDraft();
      expect(draft.source).toBe('example');
      expect(draft.trigger).toBe('example');
      expect(draft.banner.keepLabel).toBe('Keep This Example');
      expect(draft.banner.primary).toBe('blank');
      expect(draft.scopes?.label).toBe('Example');
      expect(draft.scopes?.current).toBe('example:coffee-shop');
      expect(draft.keep).toMatchObject({ writer: 'importDbml', importSource: 'example', target: { layer: 'main', name: 'coffee-shop' } });
      // Nothing written, nothing asked, before Keep.
      expect(listTree(ws)).toEqual([]);
      if (command === 'erdStudio.openExampleProject') {
        answerDraft({ type: 'discard' });
        await run;
        continue;
      }
      answerDraft({ type: 'keep' });
      await run;
    }

    expect(input).not.toHaveBeenCalled();
    expect(pick).not.toHaveBeenCalled(); // a new project without dbt has one layer, Main
    // No modal: the draft was the dry run.
    expect(info.mock.calls.some((c) => c.includes('Import'))).toBe(false);
    // A new project stores the example as DBML (native DBML storage, §3.2).
    const domainPath = path.join(ws, '.erd-studio', 'main', 'diagrams', 'coffee-shop.dbml');
    expect(fs.existsSync(domainPath)).toBe(true);
    expect(fs.existsSync(path.join(ws, '.erd-studio', 'main', 'tables', 'main', 'fct_orders.dbml'))).toBe(true);
    expect(fs.existsSync(path.join(ws, '.erd-studio', 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(ws, '.erd-studio', 'layers.json'))).toBe(true);
    expect(fs.existsSync(path.join(ws, 'coffee-shop.dbml'))).toBe(false); // nothing but the diagram's own files
    const opened = exec.mock.calls.filter((c) => c[0] === 'vscode.openWith');
    expect((opened[0][1] as { fsPath: string }).fsPath).toBe(domainPath);
    expect(feature).toHaveBeenCalledWith('exampleDiagram');
    expect(feature).toHaveBeenCalledWith('draftKept');
    expect(feature).toHaveBeenCalledWith('draftExampleShown');
    expect(feature).toHaveBeenCalledWith('draftDiscarded');
    // Keep marks the folder as started: no diagrams nudge about the example just made, the suggestion answered.
    expect(context.workspaceState.get(DIAGRAMS_NUDGE_SHOWN_KEY)).toBe(true);
    expect(context.workspaceState.get('erdStudio.startSuggestion')).toMatchObject({ answered: true });
  });

  it('Open an Example… closed without a choice writes nothing', async () => {
    await activate(context);
    const run = vscode.commands.executeCommand('erdStudio.openExampleDiagram');
    await nextDraft();
    closeDraft();
    await run;
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
    const file = path.join(ws, '.erd-studio', 'gold', 'diagrams', 'sales.dbml');
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
  const semanticWatcher = () => vscode._mockFileWatchers.find((w) => JSON.stringify(w._pattern ?? '').includes('{json,dbml}'))!;
  const foreignToasts = () => warn.mock.calls.filter((c) => String(c[0]).includes('was just added to this DBML project'));

  it('activation writes no README into an existing DBML project that has none (§1.7: only a create writes it)', async () => {
    fs.rmSync(path.join(ws, '.erd-studio', 'README.md'));
    const before = listTree(ws);
    await activate(context);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(listTree(ws)).toEqual(before);
    expect(fs.existsSync(path.join(ws, '.erd-studio', 'README.md'))).toBe(false);
  });

  it('the foreign-format toast is never raised by ERD Studio\'s own New Diagram (§5.4)', async () => {
    const featureOnce = vi.spyOn(telemetry, 'featureOnce');
    await activate(context);
    // New Diagram writes a .dbml in a DBML project (S6), never a foreign format.
    vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (items: Array<{ value: string }>) =>
      items.find((i) => i.value === 'gold')) as never);
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValueOnce('orders').mockResolvedValueOnce('');
    await vscode.commands.executeCommand('erdStudio.createDomain');
    const created = path.join(ws, '.erd-studio', 'gold', 'diagrams', 'orders.dbml');
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
    fs.mkdirSync(path.dirname(yml), { recursive: true });
    fs.writeFileSync(yml, 'name: dim_new\ncolumns: []\n');
    for (const w of vscode._mockFileWatchers) w._simulateCreate(vscode.Uri.file(yml));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(foreignToasts()).toHaveLength(1);
    expect(featureOnce.mock.calls.filter((c) => c[0] === 'dbmlForeignFormatWarned')).toHaveLength(1);
  });

  it('"Subject area file deleted": not for a diagram whose name is back as .json (Undo of Convert), still for one really deleted', async () => {
    // The selectors.yml prompt is for a dbt project only (below for a plain folder).
    fs.writeFileSync(path.join(ws, 'dbt_project.yml'), "name: 'dbml_native'\nversion: '1.0.0'\nprofile: 'x'\n");
    await activate(context);
    await vi.advanceTimersByTimeAsync(5_000);
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    const deletedToasts = () => info.mock.calls.filter((c) => /diagram files? deleted/i.test(String(c[0])));

    // Undo of Convert Project to DBML: the .json comes back and the .dbml goes.
    const salesDbml = path.join(ws, '.erd-studio', 'gold', 'diagrams', 'sales.dbml');
    fs.writeFileSync(path.join(ws, '.erd-studio', 'gold', 'sales.json'), '{"schemaVersion": 5, "domain": "sales", "layer": "gold", "logical": {"models": []}}\n');
    fs.rmSync(salesDbml);
    semanticWatcher()._simulateDelete(vscode.Uri.file(salesDbml));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(deletedToasts()).toHaveLength(0);

    // A diagram the user deletes: the toast, as before.
    const staging = path.join(ws, '.erd-studio', 'silver', 'diagrams', 'staging.dbml');
    fs.rmSync(staging);
    semanticWatcher()._simulateDelete(vscode.Uri.file(staging));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(deletedToasts()).toHaveLength(1);
    expect(deletedToasts()[0][0]).toBe('Diagram file deleted. Regenerate dbt selectors.yml to drop the removed diagram from the selector set.');
  });

  it('a diagram deleted outside ERD Studio in a folder without dbt: no selectors.yml prompt', async () => {
    const registerEditor = vi.spyOn(vscode.window, 'registerCustomEditorProvider');
    await activate(context);
    await vi.advanceTimersByTimeAsync(5_000);
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    const provider = registerEditor.mock.calls[0][1] as unknown as SemanticEditorProvider;
    const presence = vi.spyOn(provider, 'syncSubjectAreaFilePresence');

    const staging = path.join(ws, '.erd-studio', 'silver', 'diagrams', 'staging.dbml');
    fs.rmSync(staging);
    semanticWatcher()._simulateDelete(vscode.Uri.file(staging));
    await vi.advanceTimersByTimeAsync(1_000);

    // The delete was handled (open canvases told), only the dbt prompt is gone.
    expect(presence).toHaveBeenCalled();
    expect(info.mock.calls.filter((c) => /deleted|selectors|dbt/i.test(String(c[0])))).toEqual([]);
  });

  it('a burst of outside table-file changes (Edit > Undo of Convert) builds the library index and refreshes each view and canvas O(1) times', async () => {
    const registerEditor = vi.spyOn(vscode.window, 'registerCustomEditorProvider');
    const createTreeView = vi.spyOn(vscode.window, 'createTreeView');
    await activate(context);
    await vi.advanceTimersByTimeAsync(5_000);
    const provider = registerEditor.mock.calls[0][1] as unknown as SemanticEditorProvider;
    const tables = (provider as unknown as { tableLibraryService: { indexBuilds: number } }).tableLibraryService;
    const file = path.join(ws, '.erd-studio', 'gold', 'diagrams', 'sales.dbml');
    const doc = vscode.createMockTextDocument(file, fs.readFileSync(file, 'utf-8'));
    const panel = vscode.createMockWebviewPanel();
    await provider.resolveCustomTextEditor(
      doc as unknown as import('vscode').TextDocument,
      panel as unknown as import('vscode').WebviewPanel,
      {} as import('vscode').CancellationToken,
    );
    await panel._simulateMessage({ type: 'ready' });
    await vi.advanceTimersByTimeAsync(5_000);
    const treeOf = (id: string) => (createTreeView.mock.calls.find((c) => c[0] === id)![1] as {
      treeDataProvider: { onDidChangeTreeData: (cb: () => void) => void };
    }).treeDataProvider;
    let treeRefreshes = 0;
    treeOf('erdStudio.domainTree').onDidChangeTreeData(() => { treeRefreshes++; });
    treeOf('erdStudio.modelLibrary').onDidChangeTreeData(() => { treeRefreshes++; });
    const sends = (): number => panel._postedMessages.filter((m) => (m as { type: string }).type === 'domainLoaded').length;
    const sendsBefore = sends();
    const buildsBefore = tables.indexBuilds;
    const tableWatcher = vscode._mockFileWatchers.find((w) => JSON.stringify(w._pattern ?? '').includes('/tables/*/*.dbml'))!;

    // 300 table files appear over ~2.5 s, a few at a time, as VS Code's Undo writes them.
    const N = 300;
    for (let i = 0; i < N; i++) {
      const tableFile = path.join(ws, '.erd-studio', 'gold', 'tables', 'gold', `t_${i}.dbml`);
      fs.writeFileSync(tableFile, `Table gold.t_${i} {\n  id int [pk]\n}\n`);
      tableWatcher._simulateCreate(vscode.Uri.file(tableFile));
      if (i % 10 === 9) await vi.advanceTimersByTimeAsync(80);
    }
    await vi.advanceTimersByTimeAsync(5_000);

    expect(tables.indexBuilds - buildsBefore).toBeLessThanOrEqual(2);
    // Once each, when the burst settles: the ERD Studio view and the Table Library, and the open canvas.
    expect(treeRefreshes).toBe(2);
    expect(sends() - sendsBefore).toBe(1);
  });

  it('a burst of outside table-file deletions (Edit > Undo of Convert) whose folder changed just now builds the library index O(1) times, not once per table', async () => {
    const registerEditor = vi.spyOn(vscode.window, 'registerCustomEditorProvider');
    // 120 tables of the library, written before the window opened.
    const gold = path.join(ws, '.erd-studio', 'gold', 'tables', 'gold');
    const N = 120;
    const tableFiles = Array.from({ length: N }, (_, i) => path.join(gold, `t_${i}.dbml`));
    for (const [i, tableFile] of tableFiles.entries()) fs.writeFileSync(tableFile, `Table gold.t_${i} {\n  id int [pk]\n}\n`);
    await activate(context);
    await vi.advanceTimersByTimeAsync(5_000);
    const provider = registerEditor.mock.calls[0][1] as unknown as SemanticEditorProvider;
    const tables = (provider as unknown as { tableLibraryService: { indexBuilds: number } }).tableLibraryService;
    const tableWatcher = vscode._mockFileWatchers.find((w) => JSON.stringify(w._pattern ?? '').includes('/tables/*/*.dbml'))!;

    // VS Code's Undo deletes them; the folder's mtime is a whole second (a
    // coarse file system clock), so every index built in the next 2 s is
    // racy: listed again on its next use, as when the Undo is still
    // deleting while the batch runs.
    for (const tableFile of tableFiles) {
      fs.rmSync(tableFile);
      tableWatcher._simulateDelete(vscode.Uri.file(tableFile));
    }
    const wholeSecond = Math.floor(Date.now() / 1000) + 1;
    fs.utimesSync(gold, wholeSecond, wholeSecond);
    const buildsBefore = tables.indexBuilds;
    await vi.advanceTimersByTimeAsync(5_000);

    // One look at the library for the batch, one for the context keys when
    // the burst settles, and the background warm-up's few while the folder is
    // still racy — never one (or four) per table, as before (489 here).
    expect(tables.indexBuilds - buildsBefore).toBeLessThanOrEqual(10);
  });

  it('a canvas redraw asked for during a burst of ERD Studio\'s own writes (Convert) is made once the burst settles', async () => {
    const registerEditor = vi.spyOn(vscode.window, 'registerCustomEditorProvider');
    await activate(context);
    await vi.advanceTimersByTimeAsync(5_000);
    const provider = registerEditor.mock.calls[0][1] as unknown as SemanticEditorProvider;
    const file = path.join(ws, '.erd-studio', 'gold', 'diagrams', 'sales.dbml');
    const doc = vscode.createMockTextDocument(file, fs.readFileSync(file, 'utf-8'));
    const panel = vscode.createMockWebviewPanel();
    await provider.resolveCustomTextEditor(
      doc as unknown as import('vscode').TextDocument,
      panel as unknown as import('vscode').WebviewPanel,
      {} as import('vscode').CancellationToken,
    );
    await panel._simulateMessage({ type: 'ready' });
    await vi.advanceTimersByTimeAsync(5_000);
    const sends = (): number => panel._postedMessages.filter((m) => (m as { type: string }).type === 'domainLoaded').length;
    const sendsBefore = sends();
    const tableWatcher = vscode._mockFileWatchers.find((w) => JSON.stringify(w._pattern ?? '').includes('/tables/*/*.dbml'))!;

    const { ownWrites } = await import('../../src/services/ownWriteTracker');
    const ownBurst = (from: number): void => {
      for (let i = from; i < from + 40; i++) {
        const tableFile = path.join(ws, '.erd-studio', 'gold', 'tables', 'gold', `t_${i}.dbml`);
        fs.writeFileSync(tableFile, `Table gold.t_${i} {\n  id int [pk]\n}\n`);
        ownWrites.recordWrite(tableFile);
        tableWatcher._simulateCreate(vscode.Uri.file(tableFile));
      }
    };

    // Our own writes alone, nothing asked for meanwhile: no redraw.
    ownBurst(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sends() - sendsBefore).toBe(0);

    // Convert's files: their events arrive while it is still saving, so the
    // bulk change outlasts Convert's own hold, and the redraw Convert asks for
    // after its write (onConverted) is held. It is made when the burst settles.
    ownBurst(100);
    await provider.refreshAllOpenSubjectAreas();
    expect(sends() - sendsBefore).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sends() - sendsBefore).toBe(1);
  });

  it('a Cmd+Z on a canvas during a bulk change is flushed when it settles, never dropped; an undo in another file\'s own tab stays the user\'s', async () => {
    const registerEditor = vi.spyOn(vscode.window, 'registerCustomEditorProvider');
    await activate(context);
    await vi.advanceTimersByTimeAsync(5_000);
    const provider = registerEditor.mock.calls[0][1] as unknown as SemanticEditorProvider;
    const file = path.join(ws, '.erd-studio', 'gold', 'diagrams', 'sales.dbml');
    const otherFile = path.join(ws, '.erd-studio', 'silver', 'diagrams', 'staging.dbml');
    const doc = vscode.createMockTextDocument(file, fs.readFileSync(file, 'utf-8'));
    const otherDoc = vscode.createMockTextDocument(otherFile, fs.readFileSync(otherFile, 'utf-8'));
    vscode.workspace.textDocuments.push(otherDoc);
    const panel = vscode.createMockWebviewPanel();
    await provider.resolveCustomTextEditor(
      doc as unknown as import('vscode').TextDocument,
      panel as unknown as import('vscode').WebviewPanel,
      {} as import('vscode').CancellationToken,
    );
    await panel._simulateMessage({ type: 'ready' });
    await vi.advanceTimersByTimeAsync(5_000);
    const sends = (): number => panel._postedMessages.filter((m) => (m as { type: string }).type === 'domainLoaded').length;
    const sendsBefore = sends();
    const tableWatcher = vscode._mockFileWatchers.find((w) => JSON.stringify(w._pattern ?? '').includes('/tables/*/*.dbml'))!;
    const { ownWrites } = await import('../../src/services/ownWriteTracker');

    // A big edit's own writes (a rename across many tables): a bulk change, which holds the canvas.
    for (let i = 0; i < 40; i++) {
      const tableFile = path.join(ws, '.erd-studio', 'gold', 'tables', 'gold', `t_${i}.dbml`);
      fs.writeFileSync(tableFile, `Table gold.t_${i} {\n  id int [pk]\n}\n`);
      ownWrites.recordWrite(tableFile);
      tableWatcher._simulateCreate(vscode.Uri.file(tableFile));
    }
    // Meanwhile: an undo typed in another diagram's own tab (the canvas is not
    // in front), then Cmd+Z on the canvas.
    panel.active = false;
    (otherDoc as unknown as { _setText(t: string): void })._setText(`${otherDoc.getText()}\n`);
    await vscode._fireDidChangeTextDocument(otherDoc, vscode.TextDocumentChangeReason.Undo);
    panel.active = true;
    (doc as unknown as { _setText(t: string): void })._setText(`${doc.getText()}\n`);
    await vscode._fireDidChangeTextDocument(doc, vscode.TextDocumentChangeReason.Undo);
    expect(doc.isDirty).toBe(true);

    await vi.advanceTimersByTimeAsync(5_000);
    // The canvas's undo is saved and drawn; the other tab's is left for the user.
    expect(doc.isDirty).toBe(false);
    expect(sends() - sendsBefore).toBe(1);
    expect(otherDoc.isDirty).toBe(true);
  });

  it('the foreign-format toast is not raised outside a DBML project', async () => {
    for (const layer of ['gold', 'silver']) {
      for (const dir of ['tables', 'relationships', 'diagrams']) fs.rmSync(path.join(ws, '.erd-studio', layer, dir), { recursive: true, force: true });
    }
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

  it('a change to a diagram (its erd_layout included) reaches its canvas through its document: the watcher redraws nothing; a .dbdiagram is not watched', async () => {
    const registerEditor = vi.spyOn(vscode.window, 'registerCustomEditorProvider');
    await activate(context);
    await vi.advanceTimersByTimeAsync(5_000);
    const provider = registerEditor.mock.calls[0][1] as unknown as SemanticEditorProvider;
    const refresh = vi.spyOn(provider, 'refreshSubjectAreaPanel').mockResolvedValue(undefined as never);
    const diagram = path.join(ws, '.erd-studio', 'gold', 'diagrams', 'sales.dbml');
    semanticWatcher()._simulateChange(vscode.Uri.file(diagram));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(refresh).not.toHaveBeenCalled();
    semanticWatcher()._simulateChange(vscode.Uri.file(path.join(ws, '.erd-studio', 'gold', 'sales.dbdiagram')));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('a .dbdiagram changed outside ERD Studio refreshes neither sidebar tree (it is no file of the project)', async () => {
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
    semanticWatcher()._simulateChange(vscode.Uri.file(path.join(ws, '.erd-studio', 'gold', 'diagrams', 'sales.dbml')));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(refreshes).toBeGreaterThan(0);
  });

  it('a tables layer in layers.json is no conflict any more: no toast (the DBML tree lives under the layers)', async () => {
    const layersFile = path.join(ws, '.erd-studio', 'layers.json');
    const layers = JSON.parse(fs.readFileSync(layersFile, 'utf-8'));
    layers.layers.push({ id: 'tables', label: 'Tables', abbreviation: 'TBL', color: '#888888', creatable: true, order: 3 });
    fs.writeFileSync(layersFile, JSON.stringify(layers, null, 2));
    await activate(context);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('tables/'))).toEqual([]);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('1.9 pre-release'))).toEqual([]);
  });
});

describe('activate() in a 1.9 pre-release DBML tree (§1.8)', () => {
  let ws: string;
  beforeEach(() => {
    ws = path.join(root, 'old');
    fs.cpSync(path.join(REPO_ROOT, 'test', 'fixtures', 'dbml-1.9-tree'), ws, { recursive: true });
    openWorkspace(ws);
  });

  const legacyToasts = () => warn.mock.calls.filter((c) => String(c[0]).includes('written by an ERD Studio 1.9 pre-release'));

  it('warns once per session, with the steps, however often the context keys refresh; reads no 1.9 file as a table', async () => {
    const registerEditor = vi.spyOn(vscode.window, 'registerCustomEditorProvider');
    const before = listTree(ws);
    await activate(context);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(legacyToasts()).toHaveLength(1);
    const message = String(legacyToasts()[0][0]);
    expect(message.startsWith("ERD Studio: This project's DBML files were written by an ERD Studio 1.9 pre-release")).toBe(true);
    expect(message).toContain('gold/sales.dbdiagram');
    expect(message).toContain('Then run ERD Studio: Convert Project to DBML again.');
    // More refreshes (a layer added, a file changed) never repeat it.
    const layersJson = vscode.Uri.file(path.join(ws, '.erd-studio', 'layers.json'));
    for (let i = 0; i < 3; i++) {
      for (const w of vscode._mockFileWatchers) w._simulateChange(layersJson);
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(legacyToasts()).toHaveLength(1);
    const provider = registerEditor.mock.calls[0][1] as unknown as SemanticEditorProvider;
    const library = (provider as unknown as { tableLibraryService: { listTableFiles(): unknown[]; listRelationshipsFiles(): unknown[] } }).tableLibraryService;
    expect(library.listTableFiles()).toEqual([]);
    expect(library.listRelationshipsFiles()).toEqual([]);
    expect(listTree(ws)).toEqual(before);
  });

  it('a project in the layer-first tree gets no 1.9 toast', async () => {
    fs.rmSync(ws, { recursive: true, force: true });
    fs.cpSync(path.join(REPO_ROOT, 'test', 'fixtures', 'dbml-native'), ws, { recursive: true });
    await activate(context);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(legacyToasts()).toHaveLength(0);
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

  const duplicateTexts = async (): Promise<{ prompt: string; detail: string }> => {
    const input = vi.spyOn(vscode.window, 'showInputBox').mockImplementation((async (opts?: { value?: string }) => opts?.value) as never);
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    await activate(context);
    await vscode.commands.executeCommand('erdStudio.resolveDuplicateModel', ignored());
    const modal = info.mock.calls.find((c) => String(c[0]).startsWith('Rename the duplicate'))!;
    return { prompt: String((input.mock.calls[0][0] as { prompt: string }).prompt), detail: (modal[1] as { detail: string }).detail };
  };

  it('in a dbt project its prompt and modal say how dbt sees the name', async () => {
    const { prompt, detail } = await duplicateTexts();
    expect(prompt).toBe('Table names are unique, as dbt model names are. The warehouse table name stays "date" (set as the table\'s alias).');
    expect(detail).toContain('so dbt still builds a table called date');
  });

  it('in a folder without dbt its prompt and modal say nothing about dbt', async () => {
    fs.rmSync(path.join(root, 'dbt_project.yml'));
    const { prompt, detail } = await duplicateTexts();
    expect(prompt).toBe('Table names are unique across the library. The warehouse name stays "date" (set as the table\'s alias).');
    expect(detail).toContain('The table becomes "silver_date" with alias: date, so the warehouse name stays date.');
    expect(`${prompt}\n${detail}`).not.toMatch(/dbt/i);
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
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/"silver_date" \(warehouse table: date\)\. Updated 1 diagram\.$/));
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
    // #229's words: VS Code refused it, with Try Again and Send Feedback.
    expect(error).toHaveBeenCalledWith(
      'VS Code didn\'t accept renaming "bob" to "robert", usually because another program has the file open ' +
        "or ERD Studio isn't allowed to write to that folder. Nothing was changed.",
      'Try Again', 'Send Feedback',
    );
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

  it('reveals Select dbt Project in a dbt project, and not in a plain folder named by erdStudio.projectPath', async () => {
    const contextKey = async (): Promise<unknown> => {
      const exec = vi.spyOn(vscode.commands, 'executeCommand');
      await activate(context);
      const call = exec.mock.calls.filter((c) => c[0] === 'setContext' && c[1] === 'erdStudio.hasMultipleDbtProjects').at(-1);
      exec.mockRestore();
      return call?.[2];
    };
    expect(await contextKey()).toBe(true);

    // The same workspace, with projectPath naming a plain folder (no dbt_project.yml) beside the two
    // dbt projects: still two dbt candidates, but a plain folder shows no dbt control (#dbt-as-addon).
    tearDownActivation();
    const plain = path.join(root, 'plain');
    fs.cpSync(path.join(FIXTURE_ROOT, '.erd-studio'), path.join(plain, '.erd-studio'), { recursive: true });
    vscode._setMockConfiguration('erdStudio', 'projectPath', { workspaceValue: plain });
    expect(await contextKey()).toBe(false);
    expect(recentLogLines().some((l) => l.includes(`Opened ${plain} (no dbt_project.yml: logical-only)`))).toBe(true);
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

describe('dbt discovery at activation (never missed silently)', () => {
  const dbtAt = (rel: string): string => {
    const dir = path.join(root, rel);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'dbt_project.yml'), "name: 'x'\nversion: '1.0.0'\nconfig-version: 2\nprofile: 'x'\n");
    fs.mkdirSync(path.join(dir, 'models'), { recursive: true });
    return dir;
  };
  const hasDbtKey = (exec: ReturnType<typeof vi.spyOn>): unknown =>
    exec.mock.calls.filter((c) => c[0] === 'setContext' && c[1] === 'erdStudio.hasDbtProject').at(-1)?.[2];

  it('a dbt project\'s models/ opened on its own opens the project it sits in', async () => {
    const project = dbtAt('repo/analytics');
    openWorkspace(path.join(project, 'models'));
    const exec = vi.spyOn(vscode.commands, 'executeCommand');
    const feature = vi.spyOn(telemetry, 'feature');
    await activate(context);
    expect(hasDbtKey(exec)).toBe(true);
    expect(lastFoundProjectLine()).toBe(`ERD Studio: Found dbt project at ${project}`);
    expect(feature.mock.calls.map((c) => c[0])).toContain('activatedDbt');
  });

  it('a project deeper than the walk goes is found by the host\'s own search (workspace.findFiles)', async () => {
    const deep = dbtAt('a/b/c/d/e/f/g/transform');
    openWorkspace(root);
    vi.spyOn(vscode.workspace, 'findFiles').mockImplementation((async (include: unknown) =>
      (include === '**/dbt_project.yml' ? [vscode.Uri.file(path.join(deep, 'dbt_project.yml'))] : [])) as never);
    const exec = vi.spyOn(vscode.commands, 'executeCommand');
    await activate(context);
    expect(hasDbtKey(exec)).toBe(true);
    expect(lastFoundProjectLine()).toBe(`ERD Studio: Found dbt project at ${deep}`);
  });

  it('a dbt project the window does not use (erdStudio.projectPath names a plain folder) gets one log line and the dbtProjectUnused flag, no prompt', async () => {
    const project = dbtAt('analytics');
    const plain = path.join(root, 'design');
    fs.mkdirSync(plain, { recursive: true });
    openWorkspace(root);
    vscode._setMockConfiguration('erdStudio', 'projectPath', { workspaceValue: plain });
    const feature = vi.spyOn(telemetry, 'feature');
    const once = vi.spyOn(telemetry, 'featureOnce');
    const info = vi.spyOn(vscode.window, 'showInformationMessage');
    clearLogBuffer();
    await activate(context);
    expect(feature.mock.calls.map((c) => c[0])).toContain('activatedLogical');
    expect(once.mock.calls.map((c) => c[0])).toContain('dbtProjectUnused');
    const lines = recentLogLines().filter((l) => l.includes('is not used by this window'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(project);
    expect(lines[0]).toContain('erdStudio.projectPath');
    expect(info.mock.calls.filter((c) => /dbt/.test(String(c[0])))).toEqual([]);
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
      new Set([
        'erdStudio.reportBug', 'erdStudio.showGettingStarted', 'erdStudio.trySampleProject', 'erdStudio.showLogs', 'erdStudio.start',
        'erdStudio.openExampleProject', 'erdStudio.openExampleDiagram', 'erdStudio.showImportGuide',
      ]),
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
  it('a fresh install in a folder: no walkthrough (Draft-first: the draft takes its place), the first run spent, no other prompt (the harness QuickPick waits)', async () => {
    fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
    fs.rmSync(path.join(root, '.claude'), { recursive: true, force: true }); // no harness → the QuickPick would be offered
    fs.rmSync(path.join(root, '.erd-studio'), { recursive: true, force: true }); // no diagrams yet
    openWorkspace(root);
    const globalState = new Map<string, unknown>();
    // The start suggestion already answered here (it would be this window's prompt: see "the start suggestion").
    const workspaceState = new Map<string, unknown>([SUGGESTIONS_ANSWERED]);
    context = makeContext(root, { globalState, workspaceState });
    const exec = vi.spyOn(vscode.commands, 'executeCommand');
    const pick = vi.spyOn(vscode.window, 'showQuickPick');
    const info = vi.spyOn(vscode.window, 'showInformationMessage');

    await activate(context);

    expect(exec.mock.calls.filter((c) => c[0] === 'workbench.action.openWalkthrough')).toEqual([]);
    const { publisher, name } = packageJson as unknown as { publisher: string; name: string };
    expect(WALKTHROUGH_ID).toBe(`${publisher}.${name}#erdStudio.getStarted`);
    expect(panelsOfType()).toHaveLength(0);
    // The first run is spent in this folder: no walkthrough later either (it stays reachable from the palette).
    expect(globalState.get(GETTING_STARTED_SHOWN_KEY)).toBe(true);
    expect(globalState.get(GETTING_STARTED_PENDING_KEY)).toBeUndefined();
    // Skipped for this run only: the once-per-workspace offer is still owed.
    expect(workspaceState.get('erdStudio.harnessInstallPrompted')).toBeUndefined();
    expect(pick).not.toHaveBeenCalled();
    // One prompt per window, and here none: the window is left for the draft.
    expect(info).not.toHaveBeenCalled();
    // Nothing written on activation.
    expect(fs.existsSync(path.join(root, '.erd-studio'))).toBe(false);

    // The next window on this machine does not open the walkthrough either.
    tearDownActivation();
    exec.mockClear();
    await activate(context);
    expect(exec.mock.calls.filter((c) => c[0] === 'workbench.action.openWalkthrough')).toHaveLength(0);
  });

  it('falls back to the Welcome panel when the host has no walkthrough command (an empty window, where it opens)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    context = makeContext(root, { globalState: new Map<string, unknown>() });
    const opens = spyWalkthrough({ fail: true });

    await activate(context);

    expect(opens()).toHaveLength(1);
    expect(panelsOfType()).toHaveLength(1);
  });

  it('the walkthrough is contributed with the logical-first steps and media that ship', () => {
    const pkg = packageJson as unknown as {
      contributes: { walkthroughs: Array<{ id: string; description: string; steps: Array<{ id: string; title: string; when?: string; description: string; media: { svg: string }; completionEvents: string[] }> }> };
    };
    const walkthrough = pkg.contributes.walkthroughs.find((w) => WALKTHROUGH_ID.endsWith(`#${w.id}`))!;
    // The start step comes first (openProject, convert, newDiagram, one of the three direct imports
    // the folder suggests, or draw, by window), then the project's diagrams, the tour and the AI
    // helper. Import… is a start, not a step of its own; the dbt-only "sample" step is gone: dbt
    // shows up only in dbt projects.
    expect(walkthrough.steps.map((s) => s.id)).toEqual([
      'openProject', 'convert', 'convertDbt', 'newDiagram', 'importSemanticModel', 'importSqlDdl', 'importDbmlFile', 'draw',
      'openDiagram', 'watch', 'watchLogical', 'enrich',
    ]);
    const step = (id: string) => walkthrough.steps.find((s) => s.id === id)!;
    // Which window each step shows in: dbt, no folder, a folder without dbt, a project with or without diagrams, or always.
    expect(Object.fromEntries(walkthrough.steps.map((s) => [s.id, s.when ?? null]))).toEqual({
      openProject: 'workspaceFolderCount == 0',
      convert: 'erdStudio.hasProject && !erdStudio.hasDbtProject && (erdStudio.storage == yaml || erdStudio.storage == mixed)',
      convertDbt: 'erdStudio.hasDbtProject && (erdStudio.storage == yaml || erdStudio.storage == mixed)',
      newDiagram: 'erdStudio.hasProject && !erdStudio.hasDbtProject && !erdStudio.hasDiagrams && erdStudio.storage != yaml && erdStudio.storage != mixed && erdStudio.startIntent != importSemanticModel && erdStudio.startIntent != importSqlDdl && erdStudio.startIntent != importDbmlFile',
      importSemanticModel: 'erdStudio.hasProject && !erdStudio.hasDbtProject && !erdStudio.hasDiagrams && erdStudio.storage != yaml && erdStudio.storage != mixed && erdStudio.startIntent == importSemanticModel',
      importSqlDdl: 'erdStudio.hasProject && !erdStudio.hasDbtProject && !erdStudio.hasDiagrams && erdStudio.storage != yaml && erdStudio.storage != mixed && erdStudio.startIntent == importSqlDdl',
      importDbmlFile: 'erdStudio.hasProject && !erdStudio.hasDbtProject && !erdStudio.hasDiagrams && erdStudio.storage != yaml && erdStudio.storage != mixed && erdStudio.startIntent == importDbmlFile',
      draw: 'erdStudio.hasDbtProject && !erdStudio.hasDiagrams && erdStudio.storage != yaml && erdStudio.storage != mixed',
      openDiagram: 'erdStudio.hasDiagrams',
      watch: 'erdStudio.hasDbtProject',
      watchLogical: '!erdStudio.hasDbtProject',
      enrich: null,
    });
    expect(walkthrough.description).toBe('Design your data model in Git: from scratch, from an import (DBML, SQL DDL or a Power BI semantic model) or from an example, then let your AI assistant fill in the detail.');
    // The dbt tour is unchanged in a dbt project; a folder without dbt gets the same video under neutral words.
    expect(step('watch').description).toContain('draw your dbt project with Draw from dbt');
    expect(step('watchLogical').title).toBe('Watch the one-minute tour');
    expect(step('watchLogical').description).toBe('A one-minute video: start a diagram in any folder, add tables and relationships, and let your AI assistant fill in the detail.\n[Watch the video](command:erdStudio.showGettingStarted)');
    expect(step('watchLogical').media.svg).toBe('media/walkthrough/watch.svg');
    expect(step('watchLogical').completionEvents).toEqual(['onCommand:erdStudio.showGettingStarted']);
    // Every start is one click through erdStudio.start, which counts where it came from: one button, the rest quiet links.
    expect(step('newDiagram').title).toBe('Start your data model');
    expect(step('newDiagram').description).toContain(`[New Diagram](${startCommandLink('blank', 'walkthrough')})`);
    // Import… offers DBML, SQL DDL and a Power BI semantic model; DBML stays "an open format".
    expect(step('newDiagram').description).toContain(`[import a data model](${startCommandLink('import', 'walkthrough')}): DBML from dbdiagram.io or any DBML tool (an open format, no lock-in), SQL DDL scripts or a Power BI semantic model.`);
    expect(step('draw').description).toContain(`[from an import](${startCommandLink('import', 'walkthrough')}) (DBML, an open format, no lock-in; SQL DDL scripts; or a Power BI semantic model)`);
    expect(step('newDiagram').description).toContain(`[Open an example](${startCommandLink('example', 'walkthrough')})`);
    // The direct imports reuse the import picture: no new file in the VSIX.
    for (const id of ['importSemanticModel', 'importSqlDdl', 'importDbmlFile']) expect(step(id).media.svg).toBe('media/walkthrough/import-dbml.svg');
    expect(step('draw').description).toContain(`[Draw from dbt](${startCommandLink('drawFromDbt', 'walkthrough')})`);
    expect(step('draw').description).toContain(`[blank](${startCommandLink('blank', 'walkthrough')})`);
    expect(step('convert').description).toContain(`[Convert to DBML](${startCommandLink('convert', 'walkthrough')})`);
    // An empty window can open an example: it lands in a folder of its own.
    expect(step('openProject').description).toBe(`Any folder works: ERD Studio keeps your design in .erd-studio/ next to your code.\n[Open Folder](command:workbench.action.files.openFolder)\nNew to data modelling? [Open an example](${startCommandLink('example', 'walkthrough')}) to see a finished one first. It opens in a folder of its own.`);
    // No step offers the dbt sample project any more (the Getting Started panel still does, in a dbt project).
    expect(walkthrough.steps.filter((s) => s.description.includes('erdStudio.trySampleProject')).map((s) => s.id)).toEqual([]);
    expect(step('openProject').completionEvents).toEqual(['onContext:erdStudio.hasProject', 'onCommand:erdStudio.openExampleProject', 'onCommand:erdStudio.start']);
    // A cloned project's own diagrams: one click to open one (the diagram picker).
    expect(step('openDiagram').title).toBe('Open a diagram from this project');
    expect(step('openDiagram').description).toContain('[Open Diagram](command:erdStudio.openDomain)');
    expect(step('openDiagram').completionEvents).toEqual(['onCommand:erdStudio.openDomain']);
    expect(step('newDiagram').completionEvents).toEqual(['onCommand:erdStudio.createDomain', 'onCommand:erdStudio.importDbml', 'onCommand:erdStudio.importModel', 'onCommand:erdStudio.openExampleProject', 'onCommand:erdStudio.start']);
    expect(step('draw').completionEvents).toEqual(['onCommand:erdStudio.drawFromDbt', 'onCommand:erdStudio.createDomain', 'onCommand:erdStudio.importDbml', 'onCommand:erdStudio.importModel', 'onCommand:erdStudio.start']);
    // Native DBML storage (2.0): format-neutral, because the step also shows in a YAML project from before 2.0;
    // its picture shows a new project, which is DBML.
    expect(step('newDiagram').description).toContain('Each table is a file in .erd-studio/');
    expect(step('newDiagram').description).not.toMatch(/YAML|JSON/);
    expect(step('convert').description).not.toMatch(/YAML|JSON/);
    expect((step('newDiagram').media as { altText?: string }).altText).toContain('the DBML files a new project keeps it in');
    const svg = fs.readFileSync(path.join(REPO_ROOT, step('newDiagram').media.svg), 'utf-8');
    // The layer-first tree: <layer>/diagrams/, <layer>/tables/<schema>/, <layer>/relationships/.
    for (const file of ['gold/', 'diagrams/', 'sales.dbml', 'tables/', 'customer.dbml', 'relationships/', 'gold.dbml']) expect(svg).toContain(`>${file}</text>`);
    expect(svg).not.toMatch(/\.yml<|sales\.json<|\.dbdiagram<|_relationships\.dbml</);
    for (const s of walkthrough.steps) {
      expect(fs.existsSync(path.join(REPO_ROOT, s.media.svg)), s.media.svg).toBe(true);
      expect(s.completionEvents.length, s.id).toBeGreaterThan(0);
      // Every command a step's button runs is one of ours (contributed) or a built-in;
      // a start link's argument is a valid { action, from: 'walkthrough' }.
      for (const [, command, query] of s.description.matchAll(/\(command:([\w.]+)(?:\?([^)]*))?\)/g)) {
        expect(command.startsWith('erdStudio.') ? CONTRIBUTED.includes(command) : true, command).toBe(true);
        if (command === START_COMMAND) {
          const [arg] = JSON.parse(decodeURIComponent(query)) as unknown[];
          expect(parseStartArgs(arg)?.from, query).toBe('walkthrough');
        }
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

  it('no-project activation first opens the walkthrough; the first project activation does not open it again (the draft takes its place)', async () => {
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
    fs.rmSync(path.join(root, '.erd-studio'), { recursive: true, force: true }); // a project with no diagrams yet
    openWorkspace(root);

    // lastActivatedVersion is stored now, so without the pending flag this would look like an upgrade.
    await activate(context);

    expect(opens()).toHaveLength(1);
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

  /** Run Draw from dbt from the palette to its draft (the top-ranked folder, nothing asked). */
  async function drawToDraft() {
    const run = vscode.commands.executeCommand('erdStudio.drawFromDbt');
    const draft = await nextDraft();
    return { run, draft };
  }
  /** The draft's Folder switcher option for `folder`. */
  const folderScope = (draft: { scopes?: { options: Array<{ id: string; label: string }> } }, folder: string) =>
    draft.scopes!.options.find((o) => o.label === folder)!.id;

  it('in a project with no ERD folder: the draft of the top-ranked folder (nothing asked, nothing written); the switcher draws silver; Keep writes layers.json, the models into the layer folder and a fresh domain, then opens it', async () => {
    fs.rmSync(erd(), { recursive: true, force: true });
    await activate(context);
    const { quickPick, input, opened } = answer('silver');

    const { run, draft } = await drawToDraft();
    // No picker, no layer pick, no name box: gold ranks first (a presentation folder).
    expect(quickPick).not.toHaveBeenCalled();
    expect(input).not.toHaveBeenCalled();
    expect(draft.source).toBe('dbt');
    expect(draft.trigger).toBe('palette');
    expect(draft.scopes?.label).toBe('Folder');
    expect(draft.scopes?.options.map((o) => o.label)).toEqual(['gold', 'silver', 'staging']); // staging last
    expect(draft.keep).toMatchObject({ writer: 'drawFromDbt', target: { layer: 'gold', name: 'gold' } });
    expect(fs.existsSync(erd())).toBe(false);

    // The switcher: silver, the same preview, its own layer and name.
    answerDraft({ type: 'scope', scopeId: folderScope(draft, 'silver') });
    await run;
    const silver = await nextDraft(draft);
    expect(silver.scopes?.current).toBe(folderScope(draft, 'silver'));
    expect(silver.keep).toMatchObject({ writer: 'drawFromDbt', target: { layer: 'silver', name: 'silver', diagramFile: '.erd-studio/silver/diagrams/silver.dbml' } });
    expect(fs.existsSync(erd())).toBe(false);
    answerDraft({ type: 'keep' });
    await vi.waitFor(() => expect(opened()).toHaveLength(1));

    expect(input).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(erd(), 'layers.json'))).toBe(true);
    // A new project is written as DBML (native DBML storage, §3.2).
    const domainPath = path.join(erd(), 'silver', 'diagrams', 'silver.dbml');
    const domain = parseSubjectAreaDbml(fs.readFileSync(domainPath, 'utf-8'), 'silver/diagrams/silver.dbml').obj as {
      domain: string; layer: string; logical: { models: string[]; relationships: unknown[] };
    };
    expect(domain.domain).toBe('silver');
    expect(domain.layer).toBe('silver');
    expect(fs.readFileSync(domainPath, 'utf-8')).not.toContain('erd_layout'); // fresh: the canvas lays it out on first open
    expect(domain.logical.models.length).toBeGreaterThan(1);
    expect(domain.logical.models).not.toContain('dim_region'); // a .sql with no columns to copy
    // The draft drew exactly what Keep wrote.
    expect(silver.display.models.map((m) => m.name).sort()).toEqual([...domain.logical.models].sort());
    // Each table in the layer's own tables, its schema the layer (the models set no custom schema), and the README.
    for (const model of domain.logical.models) {
      expect(fs.existsSync(path.join(erd(), 'silver', 'tables', 'silver', `${model}.dbml`)), model).toBe(true);
    }
    expect(fs.existsSync(path.join(erd(), 'README.md'))).toBe(true);
    expect(fs.existsSync(lib())).toBe(false);
    expect(String((opened()[0][1] as { fsPath: string }).fsPath)).toBe(domainPath);
    expect(opened()[0][2]).toBe(SUBJECT_AREA_EDITOR_VIEW_TYPE);
    // A diagram the user just made opens in a tab that stays (#167).
    expect(opened()[0][3]).toBeUndefined();
  });

  it('Change options… runs the picker and the name box as before, ending in a draft; a flat library stays flat and only references models the library already has', async () => {
    const customerBefore = fs.readFileSync(path.join(lib(), 'dim_customer.yml'), 'utf-8');
    fs.rmSync(path.join(lib(), 'dim_project.yml'));
    await activate(context);
    const { quickPick, input } = answer('silver', 'drawn');

    const { run, draft } = await drawToDraft();
    answerDraft({ type: 'changeOptions' });
    await run;
    const chosen = await nextDraft(draft);
    expect(quickPick).toHaveBeenCalledTimes(1);
    expect(input).toHaveBeenCalledTimes(1);
    expect(chosen.trigger).toBe('changeOptions');
    expect(chosen.keep).toMatchObject({ writer: 'drawFromDbt', target: { layer: 'silver', name: 'drawn' } });
    answerDraft({ type: 'keep' });
    await vi.waitFor(() => expect(fs.existsSync(path.join(erd(), 'silver', 'drawn.json'))).toBe(true));

    const domain = JSON.parse(fs.readFileSync(path.join(erd(), 'silver', 'drawn.json'), 'utf-8')) as { logical: { models: string[] } };
    expect(domain.logical.models).toContain('dim_project');
    expect(fs.existsSync(path.join(lib(), 'dim_project.yml'))).toBe(true);
    expect(fs.existsSync(path.join(lib(), 'silver'))).toBe(false);
    expect(fs.readFileSync(path.join(lib(), 'dim_customer.yml'), 'utf-8')).toBe(customerBefore);
  });

  it('writes nothing when the draft is discarded, or Change options…\'s name box is cancelled', async () => {
    const before = fs.readdirSync(path.join(erd(), 'silver')).sort();
    fs.rmSync(path.join(lib(), 'dim_project.yml'));
    await activate(context);
    const { input, opened } = answer('silver');
    input.mockResolvedValue(undefined);

    const first = await drawToDraft();
    answerDraft({ type: 'discard' });
    await first.run;
    const second = await drawToDraft();
    answerDraft({ type: 'changeOptions' });
    await second.run;
    await vi.waitFor(() => expect(input).toHaveBeenCalledTimes(1));
    await flush();

    expect(fs.readdirSync(path.join(erd(), 'silver')).sort()).toEqual(before);
    expect(fs.existsSync(path.join(lib(), 'dim_project.yml'))).toBe(false);
    expect(opened()).toHaveLength(0);
  });

  it('refuses a name that is already a diagram in that layer (Change options…\'s name box)', async () => {
    await activate(context);
    const { input } = answer('silver');
    input.mockResolvedValue(undefined);

    const { run } = await drawToDraft();
    answerDraft({ type: 'changeOptions' });
    await run;
    await vi.waitFor(() => expect(input).toHaveBeenCalledTimes(1));

    const validate = (input.mock.calls[0][0] as { validateInput: (v: string) => string | undefined }).validateInput;
    expect(validate('showcase')).toBe('There is already a diagram named "showcase" in this layer');
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

    const run = vscode.commands.executeCommand('erdStudio.drawFromDbt');
    await nextDraft();
    expect(items[0].visible).toBe(false);
    answerDraft({ type: 'keep' });
    await run;

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

    // A DBML project's notice (here: Convert turned down for good, so this one is not offered it).
    workspaceState.set(DBML_CONVERSION_DECLINED_KEY, true);

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

  it('in a project from before 2.0, leads with Convert to DBML…, its newest diagram second (onboarding story 08)', async () => {
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(root, '.erd-studio', 'gold', 'finance.json'), future, future);
    const workspaceState = new Map<string, unknown>([['erdStudio.harnessInstallPrompted', true]]);
    context = makeContext(root, { workspaceState });
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async (message: string) =>
      (message.startsWith('This project has') ? CONVERT_NOTICE_BUTTON : undefined)) as never);
    const feature = vi.spyOn(telemetry, 'feature');
    const run = vscode.commands.executeCommand.bind(vscode.commands);
    const exec = vi.spyOn(vscode.commands, 'executeCommand').mockImplementation(((command: string, ...args: unknown[]) =>
      (command === 'erdStudio.convertProjectToDbml' ? Promise.resolve(undefined) : run(command, ...args))) as never);

    await activate(context);

    const calls = nudgeCalls(info);
    expect(calls).toHaveLength(1);
    const diagrams = Number(/has (\d+)/.exec(String(calls[0][0]))![1]);
    expect(String(calls[0][0])).toBe(convertNoticeMessage(diagrams));
    expect(String(calls[0][0])).toContain('DBML, an open format');
    expect(calls[0].slice(1)).toEqual([CONVERT_NOTICE_BUTTON, 'Open finance']);
    await vi.waitFor(() => expect(exec).toHaveBeenCalledWith('erdStudio.convertProjectToDbml'));
    const counted = feature.mock.calls.map((c) => c[0]);
    expect(counted).toContain('diagramsNudgeShown');
    expect(counted).toContain('convertToDbmlOffered');
  });

  it('with the Convert offer turned off (erdStudio.dbml.offerConvert), is the plain notice', async () => {
    const workspaceState = new Map<string, unknown>([['erdStudio.harnessInstallPrompted', true]]);
    context = makeContext(root, { workspaceState });
    vscode._setMockConfiguration('erdStudio', 'dbml.offerConvert', { globalValue: false });
    try {
      const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);

      await activate(context);

      const calls = nudgeCalls(info);
      expect(calls).toHaveLength(1);
      expect(String(calls[0][0])).toMatch(/^This project has \d+ ERD Studio diagrams\.$/);
    } finally {
      vscode._resetMockConfiguration();
    }
  });

  it('comes before the AI helper offer, which waits for the next window and is a notification, not a picker', async () => {
    // No AI helper files yet, and neither prompt offered in this workspace.
    fs.rmSync(path.join(root, '.claude'), { recursive: true, force: true });
    const workspaceState = new Map<string, unknown>();
    context = makeContext(root, { workspaceState });
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    const pick = vi.spyOn(vscode.window, 'showQuickPick');
    const offers = () => info.mock.calls.filter((c) => String(c[0]).startsWith('Let your AI assistant'));

    await activate(context);
    expect(nudgeCalls(info)).toHaveLength(1);
    expect(offers()).toEqual([]);
    expect(workspaceState.get('erdStudio.harnessInstallPrompted')).toBeUndefined();

    tearDownActivation();
    info.mockClear();
    const exec = vi.spyOn(vscode.commands, 'executeCommand');
    info.mockImplementation((async (message: string) =>
      (message.startsWith('Let your AI assistant') ? 'Set Up My AI Helper' : undefined)) as never);
    await activate(context);
    expect(nudgeCalls(info)).toEqual([]);
    expect(offers()).toEqual([[
      'Let your AI assistant read and write these diagrams? ERD Studio can add a guide for it to this project.',
      'Set Up My AI Helper', 'Not now',
    ]]);
    expect(workspaceState.get('erdStudio.harnessInstallPrompted')).toBe(true);
    expect(pick).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(exec).toHaveBeenCalledWith('erdStudio.setupAiHelper'));
    exec.mockRestore();
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

describe('a cloned project opens its own diagrams (onboarding)', () => {
  const nudges = (info: ReturnType<typeof vi.spyOn>) => info.mock.calls.filter((c) => String(c[0]).startsWith('This project has'));

  beforeEach(() => {
    fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
    openWorkspace(root);
  });

  it('a fresh install in a project with diagrams offers one of them, not the walkthrough, which stays owed', async () => {
    const globalState = new Map<string, unknown>();
    const workspaceState = new Map<string, unknown>();
    context = makeContext(root, { globalState, workspaceState });
    const opens = spyWalkthrough();
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);

    await activate(context);

    expect(opens()).toHaveLength(0);
    expect(nudges(info)).toHaveLength(1);
    expect(workspaceState.get(DIAGRAMS_NUDGE_SHOWN_KEY)).toBe(true);
    // Still owed: it opens in a later window whose project has no diagrams.
    expect(globalState.get(GETTING_STARTED_PENDING_KEY)).toBe(true);
    expect(globalState.get(GETTING_STARTED_SHOWN_KEY)).toBeUndefined();
    // The one prompt of this window: the AI helper offer waits too.
    expect(info).toHaveBeenCalledTimes(1);
    expect(workspaceState.get('erdStudio.harnessInstallPrompted')).toBeUndefined();
  });

  it('keeps erdStudio.hasDiagrams in step with the diagram count', async () => {
    const exec = vi.spyOn(vscode.commands, 'executeCommand');
    const hasDiagrams = () => exec.mock.calls.filter((c) => c[0] === 'setContext' && c[1] === 'erdStudio.hasDiagrams').map((c) => c[2]);
    await activate(context);
    expect(hasDiagrams()).toEqual([true]);

    tearDownActivation();
    exec.mockClear();
    fs.rmSync(path.join(root, '.erd-studio'), { recursive: true, force: true });
    await activate(context);
    expect(hasDiagrams()).toEqual([false]);

    // The first diagram flips it (New Diagram refreshes the context keys).
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValueOnce('Orders' as never);
    await vscode.commands.executeCommand('erdStudio.createDomain');
    expect(hasDiagrams()).toEqual([false, true]);
  });

  it('funnel: a first run here counts firstRun and firstRunHasDiagrams, the notice counts as shown, and Open counts', async () => {
    const globalState = new Map<string, unknown>();
    const workspaceState = new Map<string, unknown>();
    context = makeContext(root, { globalState, workspaceState });
    const feature = vi.spyOn(telemetry, 'feature');
    const featureOnce = vi.spyOn(telemetry, 'featureOnce');
    // The fixture is a project from before 2.0: its notice leads with Convert, Open <diagram> second.
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async (message: string, ...items: string[]) =>
      (message.startsWith('This project has') ? items.find((i) => i.startsWith('Open ')) : undefined)) as never);
    const exec = vi.spyOn(vscode.commands, 'executeCommand');

    await activate(context);

    expect(nudges(info)).toHaveLength(1);
    const once = featureOnce.mock.calls.map((c) => c[0]);
    expect(once).toContain('firstRun');
    expect(once).toContain('firstRunHasDiagrams');
    // The walkthrough was not offered here (the project has diagrams), so it did not "wait".
    expect(once).not.toContain('walkthroughWaited');
    await vi.waitFor(() => expect(exec.mock.calls.some((c) => c[0] === 'erdStudio.openDomain')).toBe(true));
    const counted = feature.mock.calls.map((c) => c[0]);
    expect(counted.filter((k) => k === 'diagramsNudgeShown')).toHaveLength(1);
    expect(counted.filter((k) => k === 'diagramsNudgeOpened')).toHaveLength(1);
    expect(counted).not.toContain('walkthroughOpened');
  });

  it('funnel: the first run owed in a later project of the same window waits for the next one, and says so', async () => {
    const globalState = new Map<string, unknown>();
    const workspaceState = new Map<string, unknown>();
    context = makeContext(root, { globalState, workspaceState });
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    const opens = spyWalkthrough();
    const featureOnce = vi.spyOn(telemetry, 'featureOnce');
    await activate(context); // the diagrams notice has this window

    // Same extension host (the session gate is not reset), now a folder with no diagrams.
    for (const sub of [...context.subscriptions].reverse()) { (sub as { dispose(): void }).dispose(); }
    context.subscriptions.length = 0;
    vscode._resetRegisteredCommands();
    fs.rmSync(path.join(root, '.erd-studio'), { recursive: true, force: true });
    featureOnce.mockClear();
    await activate(context);

    expect(opens()).toHaveLength(0);
    expect(featureOnce.mock.calls.map((c) => c[0])).toContain('walkthroughWaited');
    // Not the machine's first run any more.
    expect(featureOnce.mock.calls.map((c) => c[0])).not.toContain('firstRun');
    expect(globalState.get(GETTING_STARTED_PENDING_KEY)).toBe(true);
  });
});

describe('first run, measured (onboarding funnel)', () => {
  it('a fresh install counts firstRun once (in a folder, no walkthrough: the draft has the window); an upgrade or a machine that saw it counts nothing', async () => {
    fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
    fs.rmSync(path.join(root, '.erd-studio'), { recursive: true, force: true });
    openWorkspace(root);
    const featureOnce = vi.spyOn(telemetry, 'featureOnce');
    const once = () => featureOnce.mock.calls.map((c) => c[0]);
    const opens = spyWalkthrough();
    context = makeContext(root, { globalState: new Map<string, unknown>(), workspaceState: new Map<string, unknown>([SUGGESTIONS_ANSWERED]) });

    await activate(context);
    expect(once().filter((k) => k === 'firstRun')).toHaveLength(1);
    expect(once()).not.toContain('firstRunHasDiagrams');
    expect(once()).not.toContain('walkthroughWaited');
    // Draft-first: in a folder the draft takes the walkthrough's place.
    expect(opens()).toHaveLength(0);

    // The next window: lastActivatedVersion is stored, so it is not a first run.
    tearDownActivation();
    featureOnce.mockClear();
    await activate(context);
    expect(once()).not.toContain('firstRun');

    // An upgrader, and an install that already saw the Welcome panel.
    for (const globalState of [new Map<string, unknown>([['lastActivatedVersion', '1.6.2']]), new Map<string, unknown>([[GETTING_STARTED_SHOWN_KEY, true]])]) {
      tearDownActivation();
      featureOnce.mockClear();
      context = makeContext(root, { globalState });
      await activate(context);
      expect(once()).not.toContain('firstRun');
    }
  });

  it('counts firstRun in an empty window too (before the no-project early return)', async () => {
    const featureOnce = vi.spyOn(telemetry, 'featureOnce');
    context = makeContext(root, { globalState: new Map<string, unknown>() });
    spyWalkthrough();
    await activate(context);
    expect(featureOnce.mock.calls.map((c) => c[0])).toContain('firstRun');
  });
});

describe('Import…, Import SQL DDL… and Import Semantic Model…', () => {
  it('are registered once with a project (no legacy alias), and are open-a-folder stubs in an empty window', async () => {
    const ids = ['erdStudio.importModel', 'erdStudio.importSqlDdl', 'erdStudio.importSemanticModel'];
    await activate(context); // empty window
    for (const id of ids) {
      expect(count(id), id).toBe(1);
      expect(count(legacyAlias(id)), id).toBe(0);
    }
    tearDownActivation();
    fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
    openWorkspace(root);
    await activate(context);
    for (const id of ids) {
      expect(count(id), id).toBe(1);
      expect(count(legacyAlias(id)), id).toBe(0);
    }
  });

  it('the start screen\'s Import runs Import…, which offers the three sources and runs the one picked', async () => {
    fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
    openWorkspace(root);
    await activate(context);
    const feature = vi.spyOn(telemetry, 'feature');
    const pick = vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (items: Array<{ source?: string }>) =>
      items.find((i) => i.source === 'sqlDdl')) as never);
    const ran: string[] = [];
    const real = vscode.commands.executeCommand;
    vi.spyOn(vscode.commands, 'executeCommand').mockImplementation((async (command: string, ...args: unknown[]) => {
      ran.push(command);
      if (command === 'erdStudio.importSqlDdl') return undefined; // the SQL flow has its own tests
      return real(command, ...args);
    }) as never);

    await vscode.commands.executeCommand(START_COMMAND, { action: 'import', from: 'sidebar' });

    expect(ran).toContain('erdStudio.importModel');
    expect(ran).toContain('erdStudio.importSqlDdl');
    const items = pick.mock.calls[0][0] as Array<{ source?: string; guide?: boolean; label: string }>;
    const sources = items.filter((i) => i.source !== undefined).map((i) => i.source);
    expect([...sources].sort()).toEqual(['dbml', 'semanticModel', 'sqlDdl']);
    // The three sources, then the import guide, last.
    expect(items).toHaveLength(4);
    expect(items[3]).toMatchObject({ guide: true, label: '$(question) How do I export from Databricks, Snowflake, Power BI…?' });
    expect(feature.mock.calls.map((c) => c[0])).toEqual(['sidebarImport', 'importPickSqlDdl']);
  });
});

describe('one activation prompt per window', () => {
  beforeEach(() => {
    fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
    openWorkspace(root);
  });

  const UPGRADE = 'getting-started video';
  const NUDGE = 'This project has';
  const OFFER = 'Let your AI assistant';
  const shown = (info: ReturnType<typeof vi.spyOn>) => info.mock.calls.map((c) => String(c[0]))
    .map((m) => [UPGRADE, NUDGE, OFFER].find((p) => m.includes(p)) ?? m);

  it('shows the most useful one and leaves the rest, flags untouched, for the next windows', async () => {
    // An upgrader, a project with diagrams and no AI helper files: three prompts are owed.
    fs.rmSync(path.join(root, '.claude'), { recursive: true, force: true });
    const globalState = new Map<string, unknown>([['lastActivatedVersion', '1.0.0']]);
    const workspaceState = new Map<string, unknown>();
    context = makeContext(root, { globalState, workspaceState });
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);

    await activate(context);
    expect(shown(info)).toEqual([NUDGE]);
    expect(globalState.get(GETTING_STARTED_SHOWN_KEY)).toBeUndefined();
    expect(workspaceState.get('erdStudio.harnessInstallPrompted')).toBeUndefined();

    tearDownActivation();
    info.mockClear();
    await activate(context);
    expect(shown(info)).toEqual([UPGRADE]);
    expect(globalState.get(GETTING_STARTED_SHOWN_KEY)).toBe(true);

    tearDownActivation();
    info.mockClear();
    await activate(context);
    expect(shown(info)).toEqual([OFFER]);

    tearDownActivation();
    info.mockClear();
    await activate(context);
    expect(info).not.toHaveBeenCalled();
  });

  it('old AI helper files come before the upgrade notice', async () => {
    const skill = path.join(root, '.claude', 'skills', 'erd-studio', 'SKILL.md');
    fs.writeFileSync(skill, fs.readFileSync(skill, 'utf-8').replace(/erd-studio-harness: \d+/, 'erd-studio-harness: 1'));
    const globalState = new Map<string, unknown>([['lastActivatedVersion', '1.0.0']]);
    context = makeContext(root, { globalState });
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);

    await activate(context);

    expect(warn.mock.calls.filter((c) => String(c[0]).includes('come from an older ERD Studio'))).toHaveLength(1);
    expect(info).not.toHaveBeenCalled();
    expect(globalState.get(GETTING_STARTED_SHOWN_KEY)).toBeUndefined();
  });

  it('a second activation in the same window shows none', async () => {
    const workspaceState = new Map<string, unknown>();
    context = makeContext(root, { workspaceState });
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    await activate(context);
    expect(shown(info)).toEqual([NUDGE]);

    // Same extension host: the session's prompt is spent (no _resetFirstRunGuardForTests).
    for (const sub of [...context.subscriptions].reverse()) { (sub as { dispose(): void }).dispose(); }
    context.subscriptions.length = 0;
    vscode._resetRegisteredCommands();
    workspaceState.delete(DIAGRAMS_NUDGE_SHOWN_KEY);
    info.mockClear();
    await activate(context);
    expect(info).not.toHaveBeenCalled();
    expect(workspaceState.get(DIAGRAMS_NUDGE_SHOWN_KEY)).toBeUndefined();
  });
});

describe('New Diagram in a project with no diagrams yet', () => {
  beforeEach(() => {
    fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
    fs.rmSync(path.join(root, '.erd-studio'), { recursive: true, force: true });
    openWorkspace(root);
  });

  it('asks no layer question: the last creatable layer (Gold), named in the name prompt', async () => {
    await activate(context);
    const pick = vi.spyOn(vscode.window, 'showQuickPick');
    const input = vi.spyOn(vscode.window, 'showInputBox').mockResolvedValueOnce('Orders' as never);

    await vscode.commands.executeCommand('erdStudio.createDomain');

    expect(pick).not.toHaveBeenCalled();
    expect((input.mock.calls[0][0] as { prompt: string }).prompt)
      .toBe('Name the diagram. Saved in the Gold layer — Move Diagram to Layer… changes it later.');
    expect(fs.existsSync(path.join(root, '.erd-studio', 'gold', 'diagrams', 'orders.dbml'))).toBe(true);
    // The move it names is a real command.
    expect(CONTRIBUTED).toContain('erdStudio.moveDiagram');
  });

  it('asks which layer once there is a diagram', async () => {
    await activate(context);
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValueOnce('Orders' as never).mockResolvedValueOnce('Returns' as never);
    await vscode.commands.executeCommand('erdStudio.createDomain');

    const pick = vi.spyOn(vscode.window, 'showQuickPick').mockImplementation((async (items: Array<{ value?: string }>) =>
      items.find((i) => i.value === 'silver')) as never);
    await vscode.commands.executeCommand('erdStudio.createDomain');

    expect(pick).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(root, '.erd-studio', 'silver', 'diagrams', 'returns.dbml'))).toBe(true);
  });
});

describe('the start screen (first five minutes)', () => {
  it('in an empty window, a start link runs through erdStudio.start: counted, then Open an Example… (the example draft, no "open a folder" stub)', async () => {
    const feature = vi.spyOn(telemetry, 'feature');
    await activate(context);
    expect(count(START_COMMAND)).toBe(1);
    expect(count('erdStudio.openExampleProject')).toBe(1);
    expect(count('erdStudio.openExampleDiagram')).toBe(1);

    const run = vscode.commands.executeCommand(START_COMMAND, { action: 'example', from: 'sidebar' });
    const draft = await nextDraft();

    expect(feature).toHaveBeenCalledWith('sidebarExample');
    // The real command: the coffee shop planned in memory, nothing to keep into (no folder), Open a Folder… first.
    expect(draft.source).toBe('example');
    expect(draft.keep).toEqual({ writer: 'none' });
    expect(draft.banner.primary).toBe('openFolder');
    expect(draft.banner.keepLabel).toBeUndefined();
    expect(draft.scopes?.options.length).toBeGreaterThan(1);
    answerDraft({ type: 'discard' });
    await run;
    expect(feature).toHaveBeenCalledWith('draftDiscarded');
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('Open a folder first'), expect.anything(), expect.anything());
  });

  it('in an empty window the Example switcher draws a bundled project, whose Save This Example… runs the folder dialog', async () => {
    await activate(context);
    const dialog = vi.spyOn(vscode.window, 'showOpenDialog').mockResolvedValue(undefined);
    const run = vscode.commands.executeCommand('erdStudio.openExampleProject');
    const first = await nextDraft();
    const project = first.scopes!.options.find((o) => o.id.startsWith('exampleProject:'))!;
    answerDraft({ type: 'scope', scopeId: project.id });
    await run;
    const second = await nextDraft(first);
    expect(second.source).toBe('exampleProject');
    expect(second.keep).toEqual({ writer: 'exampleProject', exampleId: project.id.slice('exampleProject:'.length) });
    expect(second.banner.keepLabel).toBe('Save This Example…');
    answerDraft({ type: 'keep' });
    // The folder dialog onward, unchanged (cancelled here: nothing written).
    await vi.waitFor(() => expect(dialog).toHaveBeenCalledTimes(1));
  });

  // The empty Diagrams view's, the walkthrough's and the Welcome tab's primary import is
  // a start link: erdStudio.start must hand the import its { quick: true } (and the draft's
  // trigger), or the user gets the step-by-step flow (folder dialog, dialect, name) instead
  // of the draft.
  it('a direct import\'s start link runs the import on its quick path ({ quick: true, draft: \'start\' } reaches the command)', async () => {
    await activate(context);
    const real = vscode.commands.executeCommand;
    const exec = vi.spyOn(vscode.commands, 'executeCommand').mockImplementation((async (command: string, ...args: unknown[]) =>
      (command.startsWith('erdStudio.import') ? undefined : real(command, ...args))) as never);

    for (const [action, command] of [['importSqlDdl', 'erdStudio.importSqlDdl'], ['importSemanticModel', 'erdStudio.importSemanticModel'], ['importDbmlFile', 'erdStudio.importDbml']] as const) {
      await vscode.commands.executeCommand(START_COMMAND, { action, from: 'sidebar' });
      expect(exec).toHaveBeenCalledWith(command, { quick: true, draft: 'start' });
    }
  });

  it('an example project\'s new window opens its first diagram on activation, once, with no diagrams toast', async () => {
    const ws = path.join(root, 'medallion');
    fs.mkdirSync(path.join(ws, '.erd-studio'), { recursive: true });
    openWorkspace(ws);
    const globalState = new Map<string, unknown>([
      ['erdStudio.gettingStartedShown', true],
      ['erdStudio.pendingExampleOpen', { folder: ws, diagram: '.erd-studio/gold/diagrams/sales.dbml', at: Date.now() }],
    ]);
    const workspaceState = new Map<string, unknown>([['erdStudio.harnessInstallPrompted', true]]);
    context = makeContext(root, { globalState, workspaceState });
    const feature = vi.spyOn(telemetry, 'feature');
    const real = vscode.commands.executeCommand;
    const exec = vi.spyOn(vscode.commands, 'executeCommand').mockImplementation((async (command: string, ...args: unknown[]) =>
      (command === 'vscode.openWith' ? undefined : real(command, ...args))) as never);

    await activate(context);
    await vi.advanceTimersByTimeAsync(0);

    const opened = exec.mock.calls.filter((c) => c[0] === 'vscode.openWith');
    expect(opened.map((c) => (c[1] as { fsPath: string }).fsPath)).toEqual([path.join(ws, '.erd-studio', 'gold', 'diagrams', 'sales.dbml')]);
    expect(globalState.get('erdStudio.pendingExampleOpen')).toBeUndefined();
    expect(workspaceState.get('erdStudio.diagramsNudgeShown')).toBe(true);
    expect(feature).toHaveBeenCalledWith('exampleDiagramShown');
  });

  it('a pending example for another folder is left for its own window', async () => {
    const ws = path.join(root, 'mine');
    fs.mkdirSync(ws);
    openWorkspace(ws);
    const pending = { folder: path.join(root, 'medallion'), diagram: '.erd-studio/gold/diagrams/sales.dbml', at: Date.now() };
    const globalState = new Map<string, unknown>([['erdStudio.gettingStartedShown', true], ['erdStudio.pendingExampleOpen', pending]]);
    context = makeContext(root, { globalState });
    const exec = vi.spyOn(vscode.commands, 'executeCommand');

    await activate(context);

    expect(exec.mock.calls.filter((c) => c[0] === 'vscode.openWith')).toEqual([]);
    expect(globalState.get('erdStudio.pendingExampleOpen')).toEqual(pending);
  });
});

describe('the start suggestion (a folder with no diagram whose start is obvious)', () => {
  const STATE_KEY = 'erdStudio.startSuggestion';
  const SQL = 'CREATE TABLE sales.customers (\n  id INT PRIMARY KEY,\n  name TEXT\n);\n\nCREATE TABLE sales.orders (\n  id INT PRIMARY KEY,\n  customer_id INT REFERENCES sales.customers (id)\n);\n';
  let ws: string;
  let info: ReturnType<typeof vi.spyOn>;
  let answer: string | undefined;
  /** The notification's calls (the message has "found" or "older ERD Studio" in it). */
  const shown = () => info.mock.calls.filter((c) => /^ERD Studio found|from an older ERD Studio/.test(String(c[0])));

  /** A plain folder holding `files`; the mock's findFiles answers the look's globs from them. */
  function folderWith(files: Record<string, string>): void {
    ws = path.join(root, 'repo');
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
      fs.writeFileSync(path.join(ws, rel), text);
    }
    fs.mkdirSync(ws, { recursive: true });
    openWorkspace(ws);
    vi.spyOn(vscode.workspace, 'findFiles').mockImplementation((async (include: { pattern?: string } | string) => {
      const glob = typeof include === 'string' ? include : include.pattern ?? '';
      // `**/*.[dD][bB][mM][lL]` (any letter case) is read as `**/*.dbml`.
      const plain = glob.replace(/\[(.)(.)\]/g, '$1').toLowerCase();
      const ext = plain === '**/*.sql' ? '.sql' : plain === '**/*.dbml' ? '.dbml' : undefined;
      return Object.keys(files).filter((f) => ext !== undefined && f.endsWith(ext)).map((f) => vscode.Uri.file(path.join(ws, f)));
    }) as never);
    // The look lists the folder itself (workspace.fs.readDirectory): the real one.
    vi.spyOn(vscode.workspace.fs, 'readDirectory').mockImplementation((async (uri: { fsPath: string }) =>
      fs.readdirSync(uri.fsPath, { withFileTypes: true }).map((e) => [e.name, e.isDirectory() ? vscode.FileType.Directory : vscode.FileType.File])) as never);
  }

  /** Activation, then past the deferred look and the notification's answer (the look reads real files: real time). */
  async function activateAndLook(): Promise<void> {
    await activate(context);
    await settle();
  }
  /** Until the deferred look and whatever it showed have run. */
  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  /** A spy on executeCommand that still runs every command. */
  function passThroughExec() {
    const real = vscode.commands.executeCommand;
    return vi.spyOn(vscode.commands, 'executeCommand').mockImplementation((async (command: string, ...args: unknown[]) => real(command, ...args)) as never);
  }

  beforeEach(() => {
    // The look reads files with real I/O, which fake timers would time out before it answers.
    vi.useRealTimers();
    answer = undefined;
    info = vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async () => answer) as never);
  });

  it('activates on the sources it can start from: dbt, the ERD Studio folder, .sql, .dbml and a semantic model\'s files (extensions in any letter case)', () => {
    expect((packageJson as unknown as { activationEvents: string[] }).activationEvents).toEqual([
      'workspaceContains:**/dbt_project.yml',
      'workspaceContains:.erd-studio',
      'workspaceContains:**/*.[sS][qQ][lL]',
      'workspaceContains:**/*.[dD][bB][mM][lL]',
      'workspaceContains:**/*.[bB][iI][mM]',
      'workspaceContains:**/definition.pbism',
      'workspaceContains:**/model.tmdl',
      'workspaceContains:**/database.tmdl',
    ]);
  });

  it('a fresh SQL repo: after the look, one notification with the table count; Show Me opens the draft of the quick SQL import (nothing written)', async () => {
    folderWith({ 'db/schema.sql': SQL });
    const globalState = new Map<string, unknown>();
    const workspaceState = new Map<string, unknown>();
    context = makeContext(root, { globalState, workspaceState });
    const opens = spyWalkthrough();
    const feature = vi.spyOn(telemetry, 'feature');
    const exec = vscode.commands.executeCommand as unknown as ReturnType<typeof vi.spyOn>;
    answer = 'Show Me';

    await activate(context);
    // Never on activation's own path: nothing shown until the deferred look has run.
    expect(shown()).toEqual([]);
    await settle();

    expect(shown()).toEqual([[
      'ERD Studio found CREATE TABLE scripts in this folder (2 tables). Show them as a diagram? Nothing is saved until you keep it.',
      'Show Me', "Don't Ask Again for This Folder",
    ]]);
    // The quick SQL import, its draft opened by the prompt (the draft itself: "the draft-first" block below).
    expect(exec).toHaveBeenCalledWith('erdStudio.importSqlDdl', { quick: true, draft: 'prompt' });
    // No walkthrough in a folder (the draft has its place), and the window had one prompt.
    expect(opens()).toEqual([]);
    expect(globalState.get(GETTING_STARTED_PENDING_KEY)).toBeUndefined();
    expect(workspaceState.get(STATE_KEY)).toEqual({ shown: 1, answered: true });
    const keys = feature.mock.calls.map((c) => c[0]);
    expect(keys).toEqual(expect.arrayContaining(['suggestPromptShown', 'suggestPromptShowMe']));
    expect(keys).not.toContain('suggestPromptAccepted');
    // Nothing was written into the folder by activation or the notification.
    expect(fs.existsSync(path.join(ws, '.erd-studio'))).toBe(false);
  });

  it("Don't Ask Again: off for this folder (workspace state only), says how to turn it back on; Turn On brings it back", async () => {
    folderWith({ 'schema.sql': SQL });
    const workspaceState = new Map<string, unknown>([['erdStudio.harnessInstallPrompted', true]]);
    context = makeContext(root, { workspaceState });
    const exec = passThroughExec();
    const before = listTree(ws);
    answer = "Don't Ask Again for This Folder";

    await activateAndLook();
    expect(shown()).toHaveLength(1);
    expect(workspaceState.get(STATE_KEY)).toEqual({ shown: 1, off: true });
    expect(info).toHaveBeenCalledWith(
      "ERD Studio won't suggest a start for this folder again. To turn suggestions back on, run ERD Studio: Turn On Start Suggestions for This Folder.",
    );
    expect(exec).toHaveBeenCalledWith('setContext', 'erdStudio.startSuggestionsOff', true);
    expect(listTree(ws)).toEqual(before);

    // The next window: no suggestion.
    tearDownActivation();
    info.mockClear();
    await activateAndLook();
    expect(shown()).toEqual([]);

    // Turn On…: the count and the answer forgotten, the key cleared; the next window asks again.
    exec.mockClear();
    await vscode.commands.executeCommand('erdStudio.turnOnStartSuggestions');
    expect(workspaceState.get(STATE_KEY)).toEqual({ shown: 0 });
    expect(exec).toHaveBeenCalledWith('setContext', 'erdStudio.startSuggestionsOff', false);
    tearDownActivation();
    info.mockClear();
    answer = undefined;
    await activateAndLook();
    expect(shown()).toHaveLength(1);

    // Turn Off… from the palette does what the button does.
    await vscode.commands.executeCommand('erdStudio.turnOffStartSuggestions');
    expect(workspaceState.get(STATE_KEY)).toMatchObject({ off: true });
  });

  it('closed without a choice: asked again in a later window, at most three times in all, never twice in one window', async () => {
    folderWith({ 'model.dbml': 'Table a {\n  id int [pk]\n}\n' });
    const workspaceState = new Map<string, unknown>([['erdStudio.harnessInstallPrompted', true]]);
    context = makeContext(root, { workspaceState });
    for (let window = 0; window < 4; window++) {
      if (window > 0) tearDownActivation();
      await activateAndLook();
    }
    expect(shown().map((c) => c[0])).toEqual(Array(3).fill('ERD Studio found a DBML file in this folder. Show it as a diagram? Nothing is saved until you keep it.'));
    expect(workspaceState.get(STATE_KEY)).toEqual({ shown: 3 });
  });

  it('erdStudio.startSuggestions false (a team can commit it): no notification, the palette offers Turn On', async () => {
    folderWith({ 'schema.sql': SQL });
    vscode._setMockConfiguration('erdStudio', 'startSuggestions', { workspaceValue: false });
    context = makeContext(root, { workspaceState: new Map<string, unknown>([['erdStudio.harnessInstallPrompted', true]]) });
    const exec = passThroughExec();
    await activateAndLook();
    expect(shown()).toEqual([]);
    expect(exec).toHaveBeenCalledWith('setContext', 'erdStudio.startSuggestionsOff', true);
    // Turn On cannot override the setting: it says so.
    answer = undefined;
    await vscode.commands.executeCommand('erdStudio.turnOnStartSuggestions');
    expect(info).toHaveBeenCalledWith(expect.stringContaining('erdStudio.startSuggestions setting'), 'Open Settings');
  });

  it('nothing concrete in the folder: no notification, and on a first run no walkthrough either (the example draft waits for the ERD Studio icon)', async () => {
    folderWith({ 'README.md': '# notes\n', 'query.sql': 'SELECT 1;\n' });
    const globalState = new Map<string, unknown>();
    context = makeContext(root, { globalState, workspaceState: new Map<string, unknown>() });
    const opens = spyWalkthrough();
    await activateAndLook();
    expect(shown()).toEqual([]);
    expect(opens()).toHaveLength(0);
    expect(globalState.get(GETTING_STARTED_SHOWN_KEY)).toBe(true);
    // Nothing on activation's path: no draft until the Diagrams view is opened.
    expect(vscode.window._webviewPanels.filter((p) => p.viewType === 'erdStudio.draftPreview')).toEqual([]);
  });

  it('a folder that already has a diagram gets its own notice, never the suggestion', async () => {
    fs.cpSync(LOGICAL_ONLY_FIXTURE, path.join(root, 'repo'), { recursive: true });
    folderWith({ 'schema.sql': SQL });
    context = makeContext(root, { workspaceState: new Map<string, unknown>([['erdStudio.harnessInstallPrompted', true]]) });
    await activateAndLook();
    expect(shown().filter((c) => String(c[0]).startsWith('ERD Studio found'))).toEqual([]);
  });

  it('the commands: contributed with their real titles, palette by the context key, no legacy alias', () => {
    const pkg = packageJson as unknown as {
      contributes: {
        commands: Array<{ command: string; title: string; category?: string }>;
        menus: { commandPalette: Array<{ command: string; when?: string }> };
        configuration: { properties: Record<string, { type: string; default: unknown; scope?: string }> } | Array<{ properties: Record<string, { type: string; default: unknown; scope?: string }> }>;
      };
    };
    for (const [id, title, when] of [
      ['erdStudio.turnOffStartSuggestions', 'Turn Off Start Suggestions for This Folder', 'erdStudio.hasProject && !erdStudio.startSuggestionsOff'],
      ['erdStudio.turnOnStartSuggestions', 'Turn On Start Suggestions for This Folder', 'erdStudio.hasProject && erdStudio.startSuggestionsOff'],
    ]) {
      expect(pkg.contributes.commands.find((c) => c.command === id)).toEqual({ command: id, title, category: 'ERD Studio' });
      expect(pkg.contributes.menus.commandPalette.filter((m) => m.command === id)).toEqual([{ command: id, when }]);
      expect(NO_LEGACY_ALIAS.has(id)).toBe(true);
      expect(PRE_REGISTERED_COMMANDS.has(id)).toBe(false);
    }
    const blocks = Array.isArray(pkg.contributes.configuration) ? pkg.contributes.configuration : [pkg.contributes.configuration];
    const setting = blocks.map((b) => b.properties['erdStudio.startSuggestions']).find(Boolean)!;
    // Resource scope: a checked-in .vscode/settings.json may turn it off.
    expect(setting).toMatchObject({ type: 'boolean', default: true, scope: 'resource' });
  });
});

describe('the import guide', () => {
  const guidePanels = () => vscode.window._webviewPanels.filter((p) => p.viewType === 'erdStudio.importGuide');

  beforeEach(() => {
    vi.useRealTimers();
    vscode._resetMockWebviewPanels();
  });

  it('erdStudio.showImportGuide opens the guide in an empty window too, counted with where it came from (a draft\'s Bring In My Model… included)', async () => {
    const feature = vi.spyOn(telemetry, 'feature');
    await activate(context);
    expect(count('erdStudio.showImportGuide')).toBe(1);
    expect(NO_LEGACY_ALIAS.has('erdStudio.showImportGuide')).toBe(true);
    await vscode.commands.executeCommand('erdStudio.showImportGuide', { from: 'walkthrough' });
    await vscode.commands.executeCommand('erdStudio.showImportGuide');
    await vscode.commands.executeCommand('erdStudio.showImportGuide', { from: 'draft' });
    expect(guidePanels()).toHaveLength(1);
    expect(guidePanels()[0].webview.html).toContain('Open the folder you keep your data model in first');
    // Activation's own key (each window's outcome) first.
    expect(feature.mock.calls.map((c) => c[0])).toEqual([
      'activatedNoFolder', 'importGuideOpened', 'importGuideFromWalkthrough', 'importGuideOpened', 'importGuideOpened', 'importGuideFromDraft',
    ]);
    guidePanels()[0].dispose();
  });

  it('a start link runs a direct import on its quick path ({ quick: true, draft: \'start\' } reaches the import)', async () => {
    const ws = path.join(root, 'repo');
    fs.mkdirSync(ws);
    openWorkspace(ws);
    await activate(context);
    const real = vscode.commands.executeCommand;
    const exec = vi.spyOn(vscode.commands, 'executeCommand').mockImplementation((async (command: string, ...args: unknown[]) =>
      (command === 'erdStudio.importSqlDdl' ? undefined : real(command, ...args))) as never);
    await vscode.commands.executeCommand(START_COMMAND, { action: 'importSqlDdl', from: 'sidebar' });
    expect(exec).toHaveBeenCalledWith('erdStudio.importSqlDdl', { quick: true, draft: 'start' });
  });
});

describe('draft-first (docs/dev/draft-first.md)', () => {
  const STATE_KEY = 'erdStudio.startSuggestion';
  const DBML = 'Table customers {\n  id int [pk]\n  name varchar\n}\n\nTable orders {\n  id int [pk]\n  customer_id int [ref: > customers.id]\n}\n';
  /** The start suggestion has had its three shows here (not due at activation), unanswered: the folder's draft is due. */
  const SUGGESTION_USED: [string, unknown] = [STATE_KEY, { shown: 3 }];
  const LAYERS_JSON = '{\n  "schemaVersion": 1,\n  "layers": [\n    { "id": "main", "label": "Main", "creatable": true, "order": 0 }\n  ]\n}\n';
  let info: ReturnType<typeof vi.spyOn>;
  let answer: string | undefined;
  let tree: { getChildren(element?: unknown): unknown } | undefined;
  let feature: ReturnType<typeof vi.spyOn>;
  const keys = () => feature.mock.calls.map((c) => c[0] as string);
  const draftPanels = () => vscode.window._webviewPanels.filter((p) => p.viewType === 'erdStudio.draftPreview');

  /** A plain folder holding `files`; the mock's findFiles and workspace.fs answer from disk. */
  function folderWith(files: Record<string, string>, name = 'repo'): string {
    const ws = path.join(root, name);
    fs.mkdirSync(ws, { recursive: true });
    for (const [rel, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
      fs.writeFileSync(path.join(ws, rel), text);
    }
    openWorkspace(ws);
    vi.spyOn(vscode.workspace, 'findFiles').mockImplementation((async (include: { pattern?: string } | string) => {
      const glob = typeof include === 'string' ? include : include.pattern ?? '';
      // `**/*.[dD][bB][mM][lL]` (any letter case) is read as `**/*.dbml`.
      const plain = glob.replace(/\[(.)(.)\]/g, '$1').toLowerCase();
      const ext = plain === '**/*.sql' ? '.sql' : plain === '**/*.dbml' ? '.dbml' : undefined;
      return Object.keys(files).filter((f) => ext !== undefined && f.endsWith(ext) && !f.startsWith('.erd-studio/'))
        .map((f) => vscode.Uri.file(path.join(ws, f)));
    }) as never);
    vi.spyOn(vscode.workspace.fs, 'readFile').mockImplementation((async (uri: vscode.Uri) => fs.readFileSync(uri.fsPath)) as never);
    vi.spyOn(vscode.workspace.fs, 'stat').mockImplementation((async (uri: vscode.Uri) => {
      if (!fs.existsSync(uri.fsPath)) throw new Error('FileNotFound');
      return { type: fs.statSync(uri.fsPath).isDirectory() ? 2 : 1, ctime: 0, mtime: 0, size: 0 };
    }) as never);
    // The look lists the folder itself (workspace.fs.readDirectory): the real one.
    vi.spyOn(vscode.workspace.fs, 'readDirectory').mockImplementation((async (uri: { fsPath: string }) =>
      fs.readdirSync(uri.fsPath, { withFileTypes: true }).map((e) => [e.name, e.isDirectory() ? vscode.FileType.Directory : vscode.FileType.File])) as never);
    return ws;
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
  /** VS Code draws the Diagrams view: the ERD Studio icon (it lists the root; the deferred provider answers a turn later). */
  async function openDiagramsView(): Promise<void> {
    expect(tree).toBeDefined();
    tree!.getChildren();
    await new Promise((resolve) => setTimeout(resolve, 5));
    tree!.getChildren();
    await settle();
  }
  /** The files under the folder's ERD Studio folder, project-relative, with their bytes. */
  function erdFiles(ws: string): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (dir: string): void => {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else out[path.relative(ws, full).split(path.sep).join('/')] = fs.readFileSync(full, 'utf-8');
      }
    };
    walk(path.join(ws, '.erd-studio'));
    return out;
  }

  beforeEach(() => {
    vi.useRealTimers();
    answer = undefined;
    tree = undefined;
    vscode._resetMockWebviewPanels();
    feature = vi.spyOn(telemetry, 'feature');
    info = vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async () => answer) as never);
    const real = vscode.window.createTreeView;
    vi.spyOn(vscode.window, 'createTreeView').mockImplementation(((id: string, options: { treeDataProvider: typeof tree }) => {
      if (id === 'erdStudio.domainTree') tree = options.treeDataProvider;
      return real(id, options);
    }) as never);
  });

  it('an empty folder: nothing on activation; the ERD Studio icon opens exactly one example draft, its flag written first, focus left in the view, a progress bar there, the gate claimed — and only once per machine', async () => {
    const ws = folderWith({ 'notes.md': '# notes\n' });
    const globalState = new Map<string, unknown>([['erdStudio.gettingStartedShown', true]]);
    const workspaceState = new Map<string, unknown>([['erdStudio.harnessInstallPrompted', true]]);
    context = makeContext(root, { globalState, workspaceState });
    let flagWhenShown: unknown = 'not shown';
    const createPanel = vscode.window.createWebviewPanel;
    vi.spyOn(vscode.window, 'createWebviewPanel').mockImplementation(((...args: Parameters<typeof createPanel>) => {
      if (args[0] === 'erdStudio.draftPreview') flagWhenShown = globalState.get('erdStudio.exampleDraftShown');
      return createPanel(...args);
    }) as never);
    const progress = vi.spyOn(vscode.window, 'withProgress');

    await activate(context);
    await settle();
    // Never on activation's path.
    expect(draftPanels()).toEqual([]);

    await openDiagramsView();
    expect(draftPanels()).toHaveLength(1);
    const draft = await nextDraft();
    expect(draft.source).toBe('example');
    expect(draft.trigger).toBe('sidebar');
    expect(draft.banner.primary).toBe('blank');
    expect(draft.banner.keepLabel).toBe('Keep This Example');
    expect(flagWhenShown).toBe(true);
    expect(draftPanels()[0]._column).toMatchObject({ preserveFocus: true });
    expect(progress).toHaveBeenCalledWith({ location: { viewId: 'erdStudio.domainTree' } }, expect.any(Function));
    expect(keys()).toEqual(expect.arrayContaining(['draftShown', 'draftShownAuto', 'draftExampleShown']));
    expect(keys()).not.toContain('draftUnavailable');
    // The gate is the draft's: an Add Layer's "save layers.json?" or any other prompt cannot pop over it; the view drawn again opens no second one.
    await openDiagramsView();
    expect(draftPanels()).toHaveLength(1);
    // Nothing written before Keep.
    expect(fs.existsSync(path.join(ws, '.erd-studio'))).toBe(false);

    // Discard; a later window (another folder) on this machine: no automatic example again.
    answerDraft({ type: 'discard' });
    await settle();
    expect(keys()).toContain('draftDiscarded');
    tearDownActivation();
    vscode._resetMockWebviewPanels();
    folderWith({ 'other.md': '# other\n' }, 'repo2');
    context = makeContext(root, { globalState, workspaceState: new Map<string, unknown>([['erdStudio.harnessInstallPrompted', true]]) });
    await activate(context);
    await openDiagramsView();
    expect(draftPanels()).toEqual([]);
  });

  it('a folder with a DBML file: the icon opens its draft (once per folder, state written first); Keep writes the same files as the quick import\'s Import, byte for byte, and marks the folder as started', async () => {
    const ws = folderWith({ 'design/shop.dbml': DBML });
    const workspaceState = new Map<string, unknown>([['erdStudio.harnessInstallPrompted', true], SUGGESTION_USED]);
    context = makeContext(root, { workspaceState });
    let stateWhenShown: unknown;
    const createPanel = vscode.window.createWebviewPanel;
    vi.spyOn(vscode.window, 'createWebviewPanel').mockImplementation(((...args: Parameters<typeof createPanel>) => {
      if (args[0] === 'erdStudio.draftPreview') stateWhenShown = workspaceState.get(STATE_KEY);
      return createPanel(...args);
    }) as never);
    const real = vscode.commands.executeCommand;
    const exec = vi.spyOn(vscode.commands, 'executeCommand').mockImplementation((async (command: string, ...args: unknown[]) =>
      (command === 'vscode.openWith' ? undefined : real(command, ...args))) as never);

    await activate(context);
    await settle();
    await openDiagramsView();
    const draft = await nextDraft();
    expect(draft.source).toBe('dbml');
    expect(draft.trigger).toBe('sidebar');
    expect(draft.banner.headline).toBe('Draft from shop.dbml · 2 tables, 1 relationship · not saved');
    expect(draft.keep).toMatchObject({ writer: 'importDbml', importSource: 'file', target: { layer: 'main', name: 'shop' } });
    expect(stateWhenShown).toMatchObject({ draftShown: true });
    expect(keys()).toEqual(expect.arrayContaining(['draftShown', 'draftShownAuto', 'draftSourceDbml']));
    expect(fs.existsSync(path.join(ws, '.erd-studio'))).toBe(false);

    answerDraft({ type: 'keep' });
    await vi.waitFor(() => expect(exec.mock.calls.some((c) => c[0] === 'vscode.openWith')).toBe(true));
    const kept = erdFiles(ws);
    expect(Object.keys(kept)).toEqual(expect.arrayContaining(['.erd-studio/main/diagrams/shop.dbml', '.erd-studio/layers.json', '.erd-studio/README.md']));
    expect(keys()).toEqual(expect.arrayContaining(['importDbml', 'quickImport', 'draftKept']));
    // Keep marks the folder as started.
    expect(workspaceState.get(DIAGRAMS_NUDGE_SHOWN_KEY)).toBe(true);
    expect(workspaceState.get(STATE_KEY)).toMatchObject({ answered: true, draftShown: true });

    // Today's quick import, through the fallback modal (no preview), in a copy of the folder: the same files.
    const { quickImportDbml: quick } = await import('../../src/commands/importDbml');
    const { LayerService, NEW_PROJECT_LAYERS_WITHOUT_DBT } = await import('../../src/services/layerService');
    const { SubjectAreaService } = await import('../../src/services/domainService');
    const { TableLibraryService } = await import('../../src/services/logicalModelService');
    const twin = path.join(root, 'twin');
    fs.mkdirSync(path.join(twin, 'design'), { recursive: true });
    fs.writeFileSync(path.join(twin, 'design', 'shop.dbml'), DBML);
    const layerService = new LayerService(twin, '.erd-studio');
    layerService.useDefaultLayers(NEW_PROJECT_LAYERS_WITHOUT_DBT);
    const subjectAreaService = new SubjectAreaService(layerService);
    const tableLibraryService = new TableLibraryService(twin, '.erd-studio');
    subjectAreaService.setTableLibraryService(tableLibraryService);
    await quick({
      workspaceRoot: twin, semanticDir: '.erd-studio', layerService, subjectAreaService, tableLibraryService,
      validateDomainName: () => undefined, onWritten: () => {},
      findDefaultFile: async () => path.join(twin, 'design', 'shop.dbml'),
      ui: {
        pickFile: async () => undefined, readFile: async (p) => fs.readFileSync(p, 'utf-8'),
        showQuickPick: async () => undefined, showInputBox: async (o) => o.value,
        confirm: async () => true, choose: async () => 'Import',
        showInformationMessage: async () => undefined, showErrorMessage: async () => undefined,
        openFileAt: async () => {}, showFile: async () => {}, openDiagram: async () => {}, addLayer: async () => {}, sendFeedback: async () => {},
      },
    });
    expect(kept).toEqual(erdFiles(twin));
  });

  it('never with a diagram, a table or an open canvas; never when the suggestion was answered or turned off', async () => {
    const cases: Array<{ name: string; files: Record<string, string>; state?: [string, unknown]; canvas?: boolean }> = [
      { name: 'diagram', files: { 'design/shop.dbml': DBML, '.erd-studio/layers.json': LAYERS_JSON, '.erd-studio/main/diagrams/a.dbml': "Project a {\n}\n\nuse { table main.x } from '../tables/main/x.dbml'\n", '.erd-studio/main/tables/main/x.dbml': 'Table main.x {\n  id int [pk]\n}\n' } },
      { name: 'table', files: { 'design/shop.dbml': DBML, '.erd-studio/layers.json': LAYERS_JSON, '.erd-studio/main/tables/main/x.dbml': 'Table main.x {\n  id int [pk]\n}\n' } },
      { name: 'canvas', files: { 'design/shop.dbml': DBML }, canvas: true },
      { name: 'answered', files: { 'design/shop.dbml': DBML }, state: [STATE_KEY, { shown: 1, answered: true }] },
      { name: 'off', files: { 'design/shop.dbml': DBML }, state: [STATE_KEY, { shown: 1, off: true }] },
    ];
    for (const c of cases) {
      tearDownActivation();
      vscode._resetMockWebviewPanels();
      vscode.window.tabGroups.all = [];
      const ws = folderWith(c.files, `case-${c.name}`);
      if (c.canvas) {
        vscode.window.tabGroups.all = [{ tabs: [{ input: new vscode.TabInputCustom(vscode.Uri.file(path.join(ws, 'x.dbml')), SUBJECT_AREA_EDITOR_VIEW_TYPE) }] }];
      }
      // A machine that already had its example: the example cannot stand in for the find either.
      context = makeContext(root, {
        globalState: new Map<string, unknown>([['erdStudio.gettingStartedShown', true], ['erdStudio.exampleDraftShown', true]]),
        workspaceState: new Map<string, unknown>([['erdStudio.harnessInstallPrompted', true], ['erdStudio.diagramsNudgeShown', true], c.state ?? SUGGESTION_USED]),
      });
      await activate(context);
      await settle();
      if (tree) await openDiagramsView();
      expect(draftPanels(), c.name).toEqual([]);
    }
    vscode.window.tabGroups.all = [];
  });

  it('a quiet failure (a DBML file that does not read) shows nothing and counts only draftUnavailable', async () => {
    const ws = folderWith({ 'broken.dbml': 'Table x {\n  id int [pk\n' });
    const errors = vi.spyOn(vscode.window, 'showErrorMessage');
    context = makeContext(root, { workspaceState: new Map<string, unknown>([['erdStudio.harnessInstallPrompted', true], SUGGESTION_USED]) });
    await activate(context);
    await settle();
    await openDiagramsView();
    await settle();
    expect(draftPanels()).toEqual([]);
    expect(errors).not.toHaveBeenCalled();
    expect(keys()).toContain('draftUnavailable');
    expect(keys().filter((k) => /Invalid|Cancelled|FellBack|^draftShown/.test(k))).toEqual([]);
    expect(fs.existsSync(path.join(ws, '.erd-studio'))).toBe(false);
  });

  it('Show Me opens the draft (trigger prompt); Keep writes it', async () => {
    const ws = folderWith({ 'shop.dbml': DBML });
    const workspaceState = new Map<string, unknown>([['erdStudio.harnessInstallPrompted', true]]);
    context = makeContext(root, { workspaceState });
    vi.spyOn(vscode.commands, 'executeCommand').mockImplementation((async (command: string, ...args: unknown[]) =>
      (command === 'vscode.openWith' ? undefined : realExecute(command, ...args))) as never);
    answer = 'Show Me';
    await activate(context);
    await settle();
    const draft = await nextDraft();
    expect(draft.trigger).toBe('prompt');
    expect(draft.source).toBe('dbml');
    expect(keys()).toEqual(expect.arrayContaining(['suggestPromptShown', 'suggestPromptShowMe', 'draftShown', 'draftSourceDbml']));
    expect(keys()).not.toContain('draftShownAuto');
    expect(fs.existsSync(path.join(ws, '.erd-studio'))).toBe(false);
    // The icon in the same window opens no second draft.
    await openDiagramsView();
    expect(draftPanels()).toHaveLength(1);
    answerDraft({ type: 'keep' });
    await vi.waitFor(() => expect(fs.existsSync(path.join(ws, '.erd-studio', 'main', 'diagrams', 'shop.dbml'))).toBe(true));
  });

  it("Don't Ask Again: no draft and no walkthrough, in this window or a later one", async () => {
    const ws = folderWith({ 'shop.dbml': DBML });
    const globalState = new Map<string, unknown>();
    const workspaceState = new Map<string, unknown>();
    context = makeContext(root, { globalState, workspaceState });
    const opens = spyWalkthrough();
    answer = "Don't Ask Again for This Folder";
    await activate(context);
    await settle();
    expect(workspaceState.get(STATE_KEY)).toMatchObject({ off: true });
    await openDiagramsView();
    expect(draftPanels()).toEqual([]);
    expect(opens()).toEqual([]);

    tearDownActivation();
    await activate(context);
    await settle();
    await openDiagramsView();
    expect(draftPanels()).toEqual([]);
    expect(opens()).toEqual([]);
    expect(fs.existsSync(path.join(ws, '.erd-studio'))).toBe(false);
  });

  it('Change options… runs the preselected step-by-step flow (the dialog on the file, the name box), ending in a draft of its own', async () => {
    const ws = folderWith({ 'design/shop.dbml': DBML });
    context = makeContext(root, { workspaceState: new Map<string, unknown>([['erdStudio.harnessInstallPrompted', true], SUGGESTION_USED]) });
    const dialog = vi.spyOn(vscode.window, 'showOpenDialog').mockImplementation((async (o?: { defaultUri?: vscode.Uri }) => [o!.defaultUri!]) as never);
    const input = vi.spyOn(vscode.window, 'showInputBox').mockImplementation((async () => 'orders-model') as never);
    await activate(context);
    await settle();
    await openDiagramsView();
    const auto = await nextDraft();
    expect(auto.banner.changeOptions).toBe(true);
    answerDraft({ type: 'changeOptions' });
    const chosen = await nextDraft(auto);
    expect(dialog).toHaveBeenCalledTimes(1);
    expect((dialog.mock.calls[0][0] as { defaultUri: vscode.Uri }).defaultUri.fsPath).toBe(path.join(ws, 'design', 'shop.dbml'));
    expect((input.mock.calls[0][0] as { value: string }).value).toBe('shop');
    expect(chosen.trigger).toBe('changeOptions');
    expect(chosen.keep).toMatchObject({ target: { name: 'orders-model' } });
    expect(chosen.banner.changeOptions).toBe(false);
    expect(keys()).toEqual(expect.arrayContaining(['draftChangeOptions', 'quickImportChangeOptions']));
    expect(fs.existsSync(path.join(ws, '.erd-studio'))).toBe(false);
  });

  it('staleness: the project changed outside ERD Studio between the draft and Keep → planned again; another plan → redrawn with the notice, nothing written', async () => {
    const ws = folderWith({ 'design/shop.dbml': DBML });
    context = makeContext(root, { workspaceState: new Map<string, unknown>([['erdStudio.harnessInstallPrompted', true], SUGGESTION_USED]) });
    await activate(context);
    await settle();
    await openDiagramsView();
    const first = await nextDraft();
    expect(first.summary.newTables).toBe(2);
    // An assistant writes a library table of the same name, and the watchers see it (not an own write).
    const table = path.join(ws, '.erd-studio', 'main', 'tables', 'main', 'customers.dbml');
    fs.mkdirSync(path.dirname(table), { recursive: true });
    fs.writeFileSync(path.join(ws, '.erd-studio', 'layers.json'), LAYERS_JSON);
    fs.writeFileSync(table, 'Table main.customers {\n  id int [pk]\n  name varchar\n}\n');
    for (const w of vscode._mockFileWatchers) w._simulateCreate(vscode.Uri.file(table));
    // The watchers debounce (300 ms) before they report a change.
    await new Promise((resolve) => setTimeout(resolve, 450));

    answerDraft({ type: 'keep' });
    const redrawn = await nextDraft(first);
    expect(redrawn.banner.notice).toBe('Your files changed, so the draft was redrawn. Check it and keep it again.');
    expect(redrawn.summary.reusedTables).toBe(1);
    expect(keys()).toContain('draftRefreshed');
    expect(keys().filter((k) => k === 'draftShown')).toHaveLength(1);
    expect(fs.existsSync(path.join(ws, '.erd-studio', 'main', 'diagrams', 'shop.dbml'))).toBe(false);
  });

  it('dbt: the icon opens the top-ranked models folder\'s draft; the Folder switcher redraws it on another folder', async () => {
    fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
    fs.rmSync(path.join(root, '.erd-studio'), { recursive: true, force: true });
    openWorkspace(root);
    context = makeContext(root, { workspaceState: new Map<string, unknown>([['erdStudio.harnessInstallPrompted', true], SUGGESTION_USED]) });
    const quickPick = vi.spyOn(vscode.window, 'showQuickPick');
    await activate(context);
    await settle();
    await openDiagramsView();
    const gold = await nextDraft();
    expect(gold.source).toBe('dbt');
    expect(gold.trigger).toBe('sidebar');
    expect(gold.scopes?.current).toBe(gold.scopes?.options[0].id);
    expect(gold.keep).toMatchObject({ writer: 'drawFromDbt', target: { layer: 'gold', name: 'gold' } });
    const silverId = gold.scopes!.options.find((o) => o.label === 'silver')!.id;
    answerDraft({ type: 'scope', scopeId: silverId });
    const silver = await nextDraft(gold);
    expect(silver.scopes?.current).toBe(silverId);
    expect(silver.keep).toMatchObject({ writer: 'drawFromDbt', scopeId: silverId, target: { layer: 'silver', name: 'silver' } });
    expect(quickPick).not.toHaveBeenCalled();
    expect(keys()).toEqual(expect.arrayContaining(['draftShownAuto', 'draftSourceDbt', 'draftScopeChanged']));
    expect(keys().filter((k) => k === 'draftShown')).toHaveLength(1);
    expect(fs.existsSync(path.join(root, '.erd-studio'))).toBe(false);
  });

  it('every Other Way to Start runs its fixed host command (never one from the page)', async () => {
    const { DRAFT_OTHER_START_COMMANDS } = await import('../../src/providers/draftWiring');
    folderWith({ 'notes.md': '# notes\n' });
    context = makeContext(root, { workspaceState: new Map<string, unknown>([['erdStudio.harnessInstallPrompted', true]]) });
    const exec = vi.spyOn(vscode.commands, 'executeCommand').mockImplementation((async (command: string, ...args: unknown[]) =>
      (command.startsWith('erdStudio.openExample') ? realExecute(command, ...args) : undefined)) as never);
    await activate(context);
    await settle();
    // The example draft in a folder offers blank, guide (Bring In My Model…) and import; See an Example and Open a Folder… are unit-tested in draftWiring.test.ts.
    for (const start of ['blank', 'guide', 'import'] as const) {
      exec.mockClear();
      const run = vscode.commands.executeCommand('erdStudio.openExampleProject');
      const shown = await nextDraft();
      expect(shown.otherStarts.map((o) => o.id)).toContain(start);
      // A command from the page is never run: only the id is read.
      answerDraft({ type: 'otherStart', start, command: 'workbench.action.terminal.new' } as never);
      await run;
      const { command, args } = DRAFT_OTHER_START_COMMANDS[start];
      await vi.waitFor(() => expect(exec).toHaveBeenCalledWith(command, ...args));
      expect(exec.mock.calls.some((c) => c[0] === 'workbench.action.terminal.new')).toBe(false);
    }
    expect(keys().filter((k) => k === 'draftOtherStart')).toHaveLength(3);
  });

  it('an example project\'s new window claims the window for its first canvas (kind exampleOpen): no other prompt over it', async () => {
    const ws = folderWith({ '.erd-studio/layers.json': LAYERS_JSON, '.erd-studio/gold/diagrams/sales.dbml': 'Project sales {\n}\n' }, 'medallion');
    const globalState = new Map<string, unknown>([
      ['erdStudio.gettingStartedShown', true],
      ['erdStudio.pendingExampleOpen', { folder: ws, diagram: '.erd-studio/gold/diagrams/sales.dbml', at: Date.now() }],
    ]);
    // The AI helper offer is owed here (no harness, never prompted): it waits.
    context = makeContext(root, { globalState, workspaceState: new Map<string, unknown>() });
    const pick = vi.spyOn(vscode.window, 'showQuickPick');
    vi.spyOn(vscode.commands, 'executeCommand').mockImplementation((async (command: string, ...args: unknown[]) =>
      (command === 'vscode.openWith' ? undefined : realExecute(command, ...args))) as never);
    await activate(context);
    await settle();
    expect(pick).not.toHaveBeenCalled();
    expect(recentLogLines().some((l) => l.includes('exampleOpen already shown'))).toBe(true);
  });
});
