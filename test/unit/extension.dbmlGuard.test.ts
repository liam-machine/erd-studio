/**
 * The stable DBML guard, end to end through the real activate(): opened on a
 * project a newer ERD Studio stored as DBML, this version says so once,
 * shows the update message in both views, opens no canvas and refuses every
 * command that writes into the ERD Studio folder — and writes nothing, not
 * even selectors.yml. A YAML / JSON project behaves exactly as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { activate, DBML_GUARDED_COMMANDS, NO_LEGACY_ALIAS, _resetFirstRunGuardForTests } from '../../src/extension';
import {
  DBML_STORAGE_CONTEXT_KEY,
  DBML_STORAGE_MESSAGE,
  OPEN_EXTENSION_PAGE_COMMAND,
  OPEN_EXTENSION_PAGE_BUTTON,
  STORAGE_CHECKED_CONTEXT_KEY,
  _resetDbmlStorageNoticeForTests,
} from '../../src/providers/dbmlStorageGuardUi';
import { SUBJECT_AREA_EDITOR_VIEW_TYPE } from '../../src/services/recoveryService';
import { FIXTURE_ROOT, makeDbmlProject, snapshot } from './dbmlStorageGuard.fixture';

const REPO_ROOT = path.resolve(__dirname, '../..');
const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8')) as {
  version: string;
  contributes: { commands: Array<{ command: string }> };
};
const CONTRIBUTED = packageJson.contributes.commands.map((c) => c.command);

type Context = import('vscode').ExtensionContext;

const SELECTORS = `selectors:
  - name: domain_silver_showcase
    description: Models in the showcase subject area. Managed by ERD Studio.
    definition:
      union:
        - method: fqn
          value: dim_customer
`;

function makeContext(root: string, workspaceState = new Map<string, unknown>([
  ['erdStudio.harnessInstallPrompted', true],
  ['erdStudio.diagramsNudgeShown', true],
])): Context {
  const globalState = new Map<string, unknown>([['erdStudio.gettingStartedShown', true]]);
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

let tmp: string;
let project: string;
let context: Context;
let warn: ReturnType<typeof vi.spyOn>;
let exec: ReturnType<typeof vi.spyOn>;
let registerEditor: ReturnType<typeof vi.spyOn>;
let createTreeView: ReturnType<typeof vi.spyOn>;

const dbmlWarnings = () => warn.mock.calls.filter((c) => c[0] === DBML_STORAGE_MESSAGE);
/** The sidebar welcome keys in the order activation set them. */
const welcomeKeys = () => exec.mock.calls
  .filter((c) => c[0] === 'setContext' && [DBML_STORAGE_CONTEXT_KEY, 'erdStudio.hasDbtProject', STORAGE_CHECKED_CONTEXT_KEY].includes(c[1] as string))
  .map((c) => `${c[1]}=${c[2]}`);
const contextKey = () => exec.mock.calls.filter((c) => c[0] === 'setContext' && c[1] === DBML_STORAGE_CONTEXT_KEY).map((c) => c[2]);

function treeProvider(viewId: string): { getChildren(): unknown[] | undefined } {
  const call = createTreeView.mock.calls.find((c) => c[0] === viewId)!;
  return (call[1] as { treeDataProvider: { getChildren(): unknown[] | undefined } }).treeDataProvider;
}

async function openDiagram(file: string) {
  const provider = registerEditor.mock.calls.at(-1)![1] as unknown as {
    resolveCustomTextEditor(doc: unknown, panel: unknown, token: unknown): Promise<void>;
  };
  const doc = {
    uri: vscode.Uri.file(file), isDirty: false, isClosed: false,
    getText: () => fs.readFileSync(file, 'utf-8'), positionAt: (o: number) => ({ o }), save: async () => true,
  };
  const panel = vscode.createMockWebviewPanel();
  await provider.resolveCustomTextEditor(doc, panel, {});
  return panel;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-dbml-activate-'));
  project = path.join(tmp, 'analytics');
  vscode._resetRegisteredCommands();
  vscode._resetMockConfiguration();
  vscode._resetMockWorkspace();
  vscode._clearMockFileWatchers();
  vscode._resetMockWebviewPanels();
  vscode.window.tabGroups.all = [];
  vscode.window.tabGroups.activeTabGroup.activeTab = undefined;
  _resetFirstRunGuardForTests();
  _resetDbmlStorageNoticeForTests();
  vi.stubEnv('HOME', tmp);
  vi.stubEnv('USERPROFILE', tmp);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  warn = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
  vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
  vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined);
  exec = vi.spyOn(vscode.commands, 'executeCommand');
  registerEditor = vi.spyOn(vscode.window, 'registerCustomEditorProvider');
  createTreeView = vi.spyOn(vscode.window, 'createTreeView');
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
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('a project a newer ERD Studio stored as DBML', () => {
  beforeEach(() => {
    makeDbmlProject(project);
    fs.writeFileSync(path.join(project, 'selectors.yml'), SELECTORS);
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(project), name: 'analytics', index: 0 }];
  });

  it('says so once, sets the context key and writes nothing on activation (selectors.yml included)', async () => {
    context = makeContext(project);
    const before = snapshot(project);
    await activate(context);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(contextKey()).toEqual([true]);
    expect(dbmlWarnings()).toEqual([[DBML_STORAGE_MESSAGE, OPEN_EXTENSION_PAGE_BUTTON]]);
    expect(snapshot(project)).toEqual(before);
  });

  it('decides erdStudio.dbmlStorage before the welcome keys, so "No diagrams yet" never shows first', async () => {
    context = makeContext(project);
    await activate(context);
    expect(welcomeKeys().slice(0, 3)).toEqual([
      'erdStudio.dbmlStorage=true', 'erdStudio.hasDbtProject=true', 'erdStudio.storageChecked=true',
    ]);
  });

  it('offers no harness install or update: those skill files describe YAML / JSON', async () => {
    context = makeContext(project, new Map([['erdStudio.diagramsNudgeShown', true]]));
    const pick = vi.spyOn(vscode.window, 'showQuickPick');
    await activate(context);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pick).not.toHaveBeenCalled();
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('harness'))).toEqual([]);
  });

  it("does not offer to 'update' (downgrade) the newer version's skill files", async () => {
    const skill = path.join(project, '.claude', 'skills', 'erd-studio', 'SKILL.md');
    fs.mkdirSync(path.dirname(skill), { recursive: true });
    fs.writeFileSync(skill, '<!-- erd-studio-harness: 36 -->\n# ERD Studio (DBML)\n');
    context = makeContext(project);
    const before = snapshot(project);
    await activate(context);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('outdated'))).toEqual([]);
    expect(snapshot(project)).toEqual(before);
  });

  it('refuses every command that writes into the ERD Studio folder, and its legacy alias', async () => {
    context = makeContext(project);
    await activate(context);
    const before = snapshot(project);
    const pick = vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue({ label: 'Silver', value: 'silver' } as never);
    const input = vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('showcase');

    for (const command of DBML_GUARDED_COMMANDS) {
      expect(CONTRIBUTED, command).toContain(command);
      const shown = dbmlWarnings().length;
      await vscode.commands.executeCommand(command);
      expect(dbmlWarnings().length, command).toBe(shown + 1);
      if (!NO_LEGACY_ALIAS.has(command)) {
        await vscode.commands.executeCommand(command.replace(/^erdStudio\./, 'dbtSemantic.'));
        expect(dbmlWarnings().length, `${command} alias`).toBe(shown + 2);
      }
    }
    await vi.advanceTimersByTimeAsync(10_000);

    expect(pick).not.toHaveBeenCalled();
    expect(input).not.toHaveBeenCalled();
    expect(snapshot(project)).toEqual(before);
  });

  it('the refusal button and the views link open the extension page', async () => {
    context = makeContext(project);
    await activate(context);
    exec.mockClear();
    await vscode.commands.executeCommand(OPEN_EXTENSION_PAGE_COMMAND);
    expect(exec).toHaveBeenCalledWith('extension.open', 'liamwynne.erd-studio');
  });

  it('both views are empty, so their update message shows', async () => {
    context = makeContext(project);
    await activate(context);
    expect(treeProvider('erdStudio.domainTree').getChildren()).toEqual([]);
    expect(treeProvider('erdStudio.modelLibrary').getChildren()).toEqual([]);
  });

  it('a JSON diagram left in the project opens the update page, not the canvas', async () => {
    fs.copyFileSync(path.join(FIXTURE_ROOT, '.erd-studio', 'silver', 'bob.json'), path.join(project, '.erd-studio', 'silver', 'bob.json'));
    context = makeContext(project);
    await activate(context);
    expect(registerEditor.mock.calls.at(-1)![0]).toBe(SUBJECT_AREA_EDITOR_VIEW_TYPE);
    const before = snapshot(project);

    const panel = await openDiagram(path.join(project, '.erd-studio', 'silver', 'bob.json'));

    expect(panel.webview.html).toContain('This project needs a newer ERD Studio');
    expect(panel.webview.html).toContain(DBML_STORAGE_MESSAGE);
    expect(panel.webview.html).not.toContain('webview.js');
    exec.mockClear();
    await panel._simulateMessage({ type: 'openExtensionPage' });
    await vi.waitFor(() => expect(exec).toHaveBeenCalledWith('extension.open', 'liamwynne.erd-studio'));
    expect(snapshot(project)).toEqual(before);
  });
});

describe('a folder a newer ERD Studio stored as DBML, with no dbt_project.yml', () => {
  beforeEach(() => {
    makeDbmlProject(project);
    fs.rmSync(path.join(project, 'dbt_project.yml'));
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(project), name: 'analytics', index: 0 }];
  });

  it('shows the DBML message (key, notice, working link) instead of only "No dbt project", and writes nothing', async () => {
    context = makeContext(project);
    const before = snapshot(project);
    await activate(context);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(contextKey()).toEqual([true]);
    expect(dbmlWarnings()).toEqual([[DBML_STORAGE_MESSAGE, OPEN_EXTENSION_PAGE_BUTTON]]);
    exec.mockClear();
    await vscode.commands.executeCommand(OPEN_EXTENSION_PAGE_COMMAND);
    expect(exec).toHaveBeenCalledWith('extension.open', 'liamwynne.erd-studio');
    expect(snapshot(project)).toEqual(before);
  });

  it('decides erdStudio.dbmlStorage before the welcome keys, so "No dbt project" never shows first', async () => {
    context = makeContext(project);
    await activate(context);
    expect(welcomeKeys()).toEqual([
      'erdStudio.dbmlStorage=true', 'erdStudio.hasDbtProject=false', 'erdStudio.storageChecked=true',
    ]);
  });

  it('a diagram tab restored from a session with the newer version opens the DBML page, not "No dbt project found"', async () => {
    context = makeContext(project);
    await activate(context);
    const before = snapshot(project);

    const panel = await openDiagram(path.join(project, '.erd-studio', 'silver', 'showcase.dbml'));

    expect(panel.webview.html).toContain('This project needs a newer ERD Studio');
    expect(panel.webview.html).toContain(DBML_STORAGE_MESSAGE);
    expect(panel.webview.html).not.toContain('ERD Studio is inactive');
    exec.mockClear();
    await panel._simulateMessage({ type: 'openExtensionPage' });
    await vi.waitFor(() => expect(exec).toHaveBeenCalledWith('extension.open', 'liamwynne.erd-studio'));
    expect(dbmlWarnings()).toHaveLength(1);
    expect(snapshot(project)).toEqual(before);
  });

  it('a restored diagram from a DBML folder the workspace folders did not show starts the guard, so the views say so too', async () => {
    // The workspace folder is the parent: its own .erd-studio does not exist.
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(tmp), name: 'parent', index: 0 }];
    context = makeContext(project);
    await activate(context);
    expect(contextKey()).toEqual([]);

    const panel = await openDiagram(path.join(project, '.erd-studio', 'silver', 'showcase.dbml'));

    expect(panel.webview.html).toContain(DBML_STORAGE_MESSAGE);
    expect(contextKey()).toEqual([true]);
    expect(dbmlWarnings()).toEqual([[DBML_STORAGE_MESSAGE, OPEN_EXTENSION_PAGE_BUTTON]]);
    exec.mockClear();
    await vscode.commands.executeCommand(OPEN_EXTENSION_PAGE_COMMAND);
    expect(exec).toHaveBeenCalledWith('extension.open', 'liamwynne.erd-studio');
    // A second restored tab neither starts a second guard nor repeats the notice.
    await openDiagram(path.join(project, '.erd-studio', 'silver', 'showcase.dbml'));
    expect(dbmlWarnings()).toHaveLength(1);
  });

  it('a plain folder with no dbt project and no DBML gets the no-project welcome as before', async () => {
    fs.rmSync(path.join(project, '.erd-studio'), { recursive: true, force: true });
    context = makeContext(project);
    await activate(context);
    expect(contextKey()).toEqual([]);
    expect(dbmlWarnings()).toEqual([]);
    expect(welcomeKeys()).toEqual(['erdStudio.hasDbtProject=false', 'erdStudio.storageChecked=true']);
    const json = path.join(project, '.erd-studio', 'silver', 'bob.json');
    fs.mkdirSync(path.dirname(json), { recursive: true });
    fs.copyFileSync(path.join(FIXTURE_ROOT, '.erd-studio', 'silver', 'bob.json'), json);
    const panel = await openDiagram(json);
    expect(panel.webview.html).toContain('ERD Studio is inactive');
    expect(panel.webview.html).not.toContain(DBML_STORAGE_MESSAGE);
  });
});

describe('a YAML / JSON project is unaffected', () => {
  beforeEach(() => {
    fs.cpSync(FIXTURE_ROOT, project, { recursive: true });
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(project), name: 'analytics', index: 0 }];
  });

  it('no message, the key stays false, and the views list the project', async () => {
    context = makeContext(project);
    await activate(context);
    expect(contextKey().every((v) => v === false)).toBe(true);
    expect(welcomeKeys().slice(0, 3)).toEqual([
      'erdStudio.dbmlStorage=false', 'erdStudio.hasDbtProject=true', 'erdStudio.storageChecked=true',
    ]);
    expect(dbmlWarnings()).toEqual([]);
    expect(treeProvider('erdStudio.domainTree').getChildren()!.length).toBeGreaterThan(0);
    expect(treeProvider('erdStudio.modelLibrary').getChildren()!.length).toBeGreaterThan(0);
  });

  it('guarded commands run as before (New Subject Area asks for a layer)', async () => {
    context = makeContext(project);
    await activate(context);
    const pick = vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue(undefined);
    await vscode.commands.executeCommand('erdStudio.createDomain');
    expect(pick).toHaveBeenCalledTimes(1);
    expect(dbmlWarnings()).toEqual([]);
  });

  it('a diagram opens the canvas', async () => {
    context = makeContext(project);
    await activate(context);
    const panel = await openDiagram(path.join(project, '.erd-studio', 'silver', 'showcase.json'));
    expect(panel.webview.html).not.toContain('needs a newer ERD Studio');
    expect(panel.webview.options).toMatchObject({ enableScripts: true });
  });

  it('a DBML export saved into a layer folder does not trip the guard', async () => {
    fs.writeFileSync(path.join(project, '.erd-studio', 'silver', 'showcase.dbml'), '// erd-studio dbml-export v1\nTable a {\n  id int\n}\n');
    context = makeContext(project);
    await activate(context);
    expect(dbmlWarnings()).toEqual([]);
    expect(contextKey().every((v) => v === false)).toBe(true);
  });

  it("activation prompts check again when clicked: a pull while they waited can bring DBML (and the newer version's skills)", async () => {
    // A YAML project that gets all three prompts: v4 diagrams (Migrate Now),
    // no layers.json (Save Config) and an outdated skill (Update All).
    fs.rmSync(path.join(project, '.erd-studio', 'layers.json'));
    fs.writeFileSync(path.join(project, '.erd-studio', 'silver', 'legacy.json'), JSON.stringify({
      schemaVersion: 4, domain: 'legacy', layer: 'silver',
      logical: { models: [{ name: 'stg_legacy', columns: [{ name: 'id', dataType: 'INT' }] }], relationships: [], viewConfig: {} },
    }, null, 2));
    const skill = path.join(project, '.claude', 'skills', 'erd-studio', 'SKILL.md');
    fs.writeFileSync(skill, '<!-- erd-studio-harness: 20 -->\n# old\n');
    const answers = new Map<string, (choice: string) => void>();
    const waitFor = (button: string) => () => new Promise<string | undefined>((resolve) => { answers.set(button, resolve); });
    const info = vscode.window.showInformationMessage as unknown as ReturnType<typeof vi.spyOn>;
    info.mockImplementation(((message: string) => {
      if (message.includes('Migrate subject area files now?')) return waitFor('Migrate Now')();
      if (message.startsWith('Detected layers:')) return waitFor('Save Config')();
      return Promise.resolve(undefined);
    }) as never);
    warn.mockImplementation(((message: string) => {
      if (message.includes('outdated')) return waitFor('Update All')();
      return Promise.resolve(undefined);
    }) as never);

    context = makeContext(project);
    await activate(context);
    expect([...answers.keys()].sort()).toEqual(['Migrate Now', 'Save Config', 'Update All']);
    expect(dbmlWarnings()).toEqual([]);

    // A teammate's Convert arrives by git pull, with the 1.9 skills.
    fs.mkdirSync(path.join(project, '.erd-studio', 'tables'), { recursive: true });
    fs.writeFileSync(path.join(project, '.erd-studio', 'tables', '_relationships.dbml'), '// ERD Studio relationships.\n');
    fs.writeFileSync(skill, '<!-- erd-studio-harness: 37 -->\n# ERD Studio (DBML)\n');
    const before = snapshot(project);

    for (const [button, answer] of answers) { answer(button); }
    await vi.advanceTimersByTimeAsync(10_000);

    expect(dbmlWarnings().length).toBeGreaterThanOrEqual(3);
    expect(fs.readFileSync(skill, 'utf-8')).toContain('erd-studio-harness: 37');
    expect(fs.existsSync(path.join(project, '.erd-studio', 'layers.json'))).toBe(false);
    expect(snapshot(project)).toEqual(before);
  });

  it('becoming DBML mid-session (a checkout) flips the key, tells the user and refuses from then on', async () => {
    context = makeContext(project);
    await activate(context);
    const domainTree = treeProvider('erdStudio.domainTree');
    expect(domainTree.getChildren()!.length).toBeGreaterThan(0);

    fs.mkdirSync(path.join(project, '.erd-studio', 'tables'), { recursive: true });
    fs.writeFileSync(path.join(project, '.erd-studio', 'tables', '_relationships.dbml'), '// ERD Studio relationships.\n');
    const watcher = vscode._mockFileWatchers.find((w) => (w._pattern as { pattern?: string } | undefined)?.pattern === '**/*.dbml')!;
    watcher._simulateCreate(vscode.Uri.file(path.join(project, '.erd-studio', 'tables', '_relationships.dbml')));
    await vi.advanceTimersByTimeAsync(400);

    expect(contextKey().at(-1)).toBe(true);
    expect(dbmlWarnings().length).toBe(1);
    expect(domainTree.getChildren()).toEqual([]);
    const pick = vi.spyOn(vscode.window, 'showQuickPick');
    await vscode.commands.executeCommand('erdStudio.createDomain');
    expect(pick).not.toHaveBeenCalled();
    expect(dbmlWarnings().length).toBe(2);
  });
});
