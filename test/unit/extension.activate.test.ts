/**
 * extension.activate() — command surface and activation ordering.
 *
 * Runs the real activate() against the vscode mock twice: with no workspace
 * (the "no dbt project" early return) and against a temp copy of the fixture
 * dbt project (full activation). Asserts the contracts CLAUDE.md calls
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
  GETTING_STARTED_PENDING_KEY,
  GETTING_STARTED_SHOWN_KEY,
  NO_LEGACY_ALIAS,
  PRE_REGISTERED_COMMANDS,
  _resetFirstRunGuardForTests,
} from '../../src/extension';
import { GETTING_STARTED_VIEW_TYPE, GettingStartedPanel } from '../../src/providers/GettingStartedPanel';
import { DOMAIN_EDITOR_VIEW_TYPE } from '../../src/services/recoveryService';
import type { SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';

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
  // Pretend the harness-install QuickPick was already offered for this workspace.
  const workspaceState = opts.workspaceState ?? new Map<string, unknown>([['erdStudio.harnessInstallPrompted', true]]);
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
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('activate() without a dbt project', () => {
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
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('No dbt project found'), 'Open Settings');
  });

  it('registers a stub domain editor and no tree views (early return)', async () => {
    const registerEditor = vi.spyOn(vscode.window, 'registerCustomEditorProvider');
    const createTreeView = vi.spyOn(vscode.window, 'createTreeView');

    await activate(context);

    expect(registerEditor).toHaveBeenCalledTimes(1);
    expect(registerEditor.mock.calls[0][0]).toBe(DOMAIN_EDITOR_VIEW_TYPE);
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
    expect(warn.mock.calls.at(-1)?.[0]).toContain('No dbt project found');
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
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('No dbt project found'), expect.anything());
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

  it('wires the domain editor (retaining webview context), both tree views and the decoration providers', async () => {
    const registerEditor = vi.spyOn(vscode.window, 'registerCustomEditorProvider');
    const createTreeView = vi.spyOn(vscode.window, 'createTreeView');
    const registerDecorations = vi.spyOn(vscode.window, 'registerFileDecorationProvider');

    await activate(context);

    expect(registerEditor).toHaveBeenCalledTimes(1);
    const [viewType, provider, options] = registerEditor.mock.calls[0] as unknown as [string, SemanticEditorProvider, unknown];
    expect(viewType).toBe(DOMAIN_EDITOR_VIEW_TYPE);
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
      _onDidWriteDomain: { fire: (e: { uri: unknown; modelLibraryChanged: boolean }) => void };
    };
    const libraryCall = createTreeView.mock.calls.find((c) => c[0] === 'erdStudio.modelLibrary');
    const libraryProvider = (libraryCall![1] as { treeDataProvider: { onDidChangeTreeData: (cb: () => void) => void } }).treeDataProvider;

    let refreshes = 0;
    libraryProvider.onDidChangeTreeData(() => { refreshes++; });

    const uri = vscode.Uri.file(path.join(root, '.erd-studio', 'silver', 'showcase.json'));
    provider._onDidWriteDomain.fire({ uri, modelLibraryChanged: false });

    expect(refreshes).toBeGreaterThan(0);
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
      input: new vscode.TabInputCustom(doc.uri, DOMAIN_EDITOR_VIEW_TYPE),
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

describe('activate() project-root resolution', () => {
  it('reads projectPath through getErdStudioSetting, so a legacy dbtSemantic.projectPath still wins over auto-detection', async () => {
    // Two candidate projects: auto-detection would pick "a" (shallowest, sorted first);
    // the pre-rename setting points at "b".
    fs.cpSync(FIXTURE_ROOT, path.join(root, 'a'), { recursive: true });
    fs.cpSync(FIXTURE_ROOT, path.join(root, 'b'), { recursive: true });
    openWorkspace(root);
    vscode._setMockConfiguration('dbtSemantic', 'projectPath', { workspaceValue: 'b' });

    await activate(context);

    expect(console.log).toHaveBeenCalledWith(`ERD Studio: Found dbt project at ${path.join(root, 'b')}`);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('No dbt project found'), expect.anything());
  });

  it('an explicit erdStudio.projectPath beats the legacy one', async () => {
    fs.cpSync(FIXTURE_ROOT, path.join(root, 'a'), { recursive: true });
    fs.cpSync(FIXTURE_ROOT, path.join(root, 'b'), { recursive: true });
    openWorkspace(root);
    vscode._setMockConfiguration('dbtSemantic', 'projectPath', { workspaceValue: 'b' });
    vscode._setMockConfiguration('erdStudio', 'projectPath', { globalValue: 'a' });

    await activate(context);

    expect(console.log).toHaveBeenCalledWith(`ERD Studio: Found dbt project at ${path.join(root, 'a')}`);
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
      new Set(['erdStudio.reportBug', 'erdStudio.showGettingStarted', 'erdStudio.trySampleProject']),
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
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('No dbt project found'), expect.anything());
  });

  it('is registered exactly once with a project too', async () => {
    fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
    openWorkspace(root);
    await activate(context);
    expect(count(SAMPLE)).toBe(1);
    expect(count(legacyAlias(SAMPLE))).toBe(0);
  });
});

describe('Welcome panel: first run', () => {
  it('a fresh install opens the panel once, writes the flag first and skips the harness QuickPick', async () => {
    fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
    fs.rmSync(path.join(root, '.claude'), { recursive: true, force: true }); // no harness → the QuickPick would be offered
    openWorkspace(root);
    const globalState = new Map<string, unknown>();
    const workspaceState = new Map<string, unknown>();
    context = makeContext(root, { globalState, workspaceState });
    const realCreate = vscode.window.createWebviewPanel;
    let shownWhenCreated: unknown = 'not created';
    vi.spyOn(vscode.window, 'createWebviewPanel').mockImplementation((...args: Parameters<typeof realCreate>) => {
      shownWhenCreated = globalState.get(GETTING_STARTED_SHOWN_KEY);
      return realCreate(...args);
    });
    const pick = vi.spyOn(vscode.window, 'showQuickPick');

    await activate(context);

    expect(panelsOfType()).toHaveLength(1);
    expect(shownWhenCreated).toBe(true);
    expect(globalState.get(GETTING_STARTED_PENDING_KEY)).toBeUndefined();
    // Skipped for this run only: the once-per-workspace offer is still owed.
    expect(workspaceState.get('erdStudio.harnessInstallPrompted')).toBeUndefined();
    expect(pick).not.toHaveBeenCalled();

    // The next window on this machine does not open it again.
    tearDownActivation();
    await activate(context);
    expect(panelsOfType()).toHaveLength(1);
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

  it('no-project activation first, then a project activation, still opens the panel', async () => {
    const globalState = new Map<string, unknown>();
    context = makeContext(root, { globalState });

    await activate(context); // no workspace folder: early return
    expect(globalState.get(GETTING_STARTED_PENDING_KEY)).toBe(true);
    expect(globalState.get(GETTING_STARTED_SHOWN_KEY)).toBeUndefined();
    expect(panelsOfType()).toHaveLength(0);

    tearDownActivation();
    fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
    openWorkspace(root);

    // lastActivatedVersion is stored now, so without the pending flag this would look like an upgrade.
    await activate(context);

    expect(panelsOfType()).toHaveLength(1);
    expect(globalState.get(GETTING_STARTED_SHOWN_KEY)).toBe(true);
    expect(globalState.get(GETTING_STARTED_PENDING_KEY)).toBeUndefined();
  });

  it('never opens the panel on a no-project activation', async () => {
    context = makeContext(root, { globalState: new Map() });
    await activate(context);
    expect(panelsOfType()).toHaveLength(0);
    expect(GettingStartedPanel.currentPanel).toBeUndefined();
  });
});
