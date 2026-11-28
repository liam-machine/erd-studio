/**
 * #357: in a folder new to ERD Studio (no dbt project, no .erd-studio,
 * outside a git repository), activation waits for the whole look for dbt
 * projects below the open folder, which on a slow disk is many seconds. The
 * ERD Studio side panel used to be blank for all of it: the Diagrams view and
 * the context keys its "Loading diagrams…" welcome needs came only after the
 * look.
 *
 * The look is held open by a stub, so "during the walk" is a fixed point.
 * The rule: as soon as a folder is open, the Diagrams view exists and its
 * welcome is exactly "Loading diagrams…", in the native tree and in the
 * glass sidebar, whatever the walk is still doing; and nothing that names a
 * command activation has not registered yet (the `+` New… menu, Help &
 * Feedback, everything `erdStudio.hasProject` gates) shows before the walk
 * answers. The walk itself, and the project that opens, are unchanged.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { activate, _resetFirstRunGuardForTests } from '../../src/extension';
import { FolderLooks } from '../../src/services/folderLook';
import { firstOpenFolder, resolveDbtProject } from '../../src/services/projectDiscovery';
import { ContributionIndex, type Contributions, type MenuAction } from '../../src/providers/glassSidebar/contributions';
import { evaluateWhen, type ContextLookup } from '../../src/providers/glassSidebar/whenClause';
import { _resetContextKeys, contextKeyValue } from '../../src/providers/glassSidebar/contextKeys';
import type { GlassSidebarProvider } from '../../src/providers/glassSidebar/GlassSidebarProvider';

const REPO_ROOT = path.resolve(__dirname, '../..');
const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8')) as {
  version: string;
  contributes: Contributions & { commands: Array<{ command: string }> };
};
const index = new ContributionIndex(packageJson.contributes);
type Context = import('vscode').ExtensionContext;

const DIAGRAMS = 'erdStudio.domainTree';
const SIDEBAR_VIEWS = ['erdStudio.domainTree', 'erdStudio.modelLibrary', 'erdStudio.relationships', 'erdStudio.help'];

function makeContext(root: string): Context {
  const globalState = new Map<string, unknown>([['erdStudio.gettingStartedShown', true]]);
  const workspaceState = new Map<string, unknown>([
    ['erdStudio.harnessInstallPrompted', true],
    ['erdStudio.diagramsNudgeShown', true],
    ['erdStudio.startSuggestion', { shown: 1, answered: true }],
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

let root: string;
let context: Context;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-357-'));
  context = makeContext(root);
  vscode._resetRegisteredCommands();
  vscode._resetMockConfiguration();
  vscode._resetMockWorkspace();
  vscode._clearMockFileWatchers();
  vscode._resetMockWebviewPanels();
  vscode._setMockExtensions([]);
  _resetFirstRunGuardForTests();
  _resetContextKeys();
  vi.stubEnv('HOME', root);
  vi.stubEnv('USERPROFILE', root);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
  vi.spyOn(vscode.workspace, 'findFiles').mockResolvedValue([] as never);
  // A folder ERD Studio has never been used in: no dbt_project.yml, no .erd-studio.
  fs.writeFileSync(path.join(root, 'notes.txt'), 'hello\n');
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root), name: 'p', index: 0 }];
});

afterEach(async () => {
  for (const sub of [...context.subscriptions].reverse()) {
    try { await sub.dispose(); } catch { /* best effort */ }
  }
  for (const panel of [...vscode.window._webviewPanels]) panel.dispose();
  vscode._resetMockWebviewPanels();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

/** Holds FolderLooks.dbtProjectsBelow open until `finish()` (a slow walk on a slow disk). */
function holdTheWalk() {
  let finish: (found: string[]) => void = () => {};
  let started!: () => void;
  const startedP = new Promise<void>((r) => { started = r; });
  const held = new Promise<string[]>((r) => { finish = r; });
  vi.spyOn(FolderLooks.prototype, 'dbtProjectsBelow').mockImplementation(() => { started(); return held; });
  return { started: startedP, finish: (found: string[] = []) => finish(found) };
}

const lastContext = (exec: { mock: { calls: unknown[][] } }, key: string): unknown =>
  exec.mock.calls.filter((c) => c[0] === 'setContext' && c[1] === key).at(-1)?.[2];
const diagramViews = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.filter((c) => c[0] === DIAGRAMS).length;

/**
 * The context VS Code evaluates `when` clauses against, from the keys
 * activation has set so far, as the native tree sees it (the glass sidebar
 * off; the glass case reads the provider's own snapshot).
 */
function contextNow(view?: string): ContextLookup {
  return (key) => {
    if (key === 'view') return view;
    if (key === 'erdStudio.glassSidebar') return false;
    if (key === 'workspaceFolderCount') return vscode.workspace.workspaceFolders?.length ?? 0;
    return contextKeyValue(key) as never;
  };
}

/** The native Diagrams view's welcome text, as VS Code picks it from package.json. */
const nativeWelcome = (): string[] =>
  (packageJson.contributes.viewsWelcome ?? [])
    .filter((w) => w.view === DIAGRAMS && evaluateWhen(w.when, contextNow()))
    .map((w) => w.contents.split('\n')[0]);

/** Every command or submenu a menu action names, through submenus. */
function namedBy(actions: readonly MenuAction[]): string[] {
  return actions.flatMap((a) => {
    const entry = index.menu(a.menu)[a.index] as { command?: string; submenu?: string } | undefined;
    const own = entry?.command ?? entry?.submenu;
    return [...(own ? [own] : []), ...(a.submenu ? namedBy(a.submenu.flat()) : [])];
  });
}

/** What the sidebar shows while the walk runs: native views, their title buttons, and their welcome. */
function sidebarDuringWalk() {
  const ctx = contextNow();
  const visibleViews = SIDEBAR_VIEWS.filter((id) => evaluateWhen(index.views().find((v) => v.id === id)?.when, ctx));
  const titleActions = visibleViews.flatMap((id) => {
    const { navigation, groups } = index.resolve('view/title', contextNow(id));
    return namedBy([...navigation, ...groups.flat()]);
  });
  return { visibleViews, titleActions };
}

async function activateDuringWalk(found: string[] = []) {
  const walk = holdTheWalk();
  const exec = vi.spyOn(vscode.commands, 'executeCommand');
  const createTreeView = vi.spyOn(vscode.window, 'createTreeView');
  let glass: GlassSidebarProvider | undefined;
  const original = vscode.window.registerWebviewViewProvider;
  vi.spyOn(vscode.window, 'registerWebviewViewProvider').mockImplementation(((id: string, provider: unknown, options: unknown) => {
    glass = provider as GlassSidebarProvider;
    return original(id, provider, options);
  }) as never);
  const activating = activate(context);
  await walk.started;
  // Give activation every chance to run ahead of the walk (it has nothing else to wait on).
  await new Promise((r) => setTimeout(r, 200));
  const registered = new Set(vscode._registeredCommands.map((e) => e.command));
  const sidebar = sidebarDuringWalk();
  const during = {
    activated: lastContext(exec, 'erdStudio.activated'),
    hasProject: lastContext(exec, 'erdStudio.hasProject'),
    hasDbtProject: lastContext(exec, 'erdStudio.hasDbtProject'),
    diagramsLoading: lastContext(exec, 'erdStudio.diagramsLoading'),
    tablesLoading: lastContext(exec, 'erdStudio.tablesLoading'),
    diagramsViews: diagramViews(createTreeView),
    welcome: nativeWelcome(),
  };
  const glassSnapshot = glass?.snapshot();
  return {
    during, sidebar, registered, glassSnapshot, exec, createTreeView,
    finish: async () => { walk.finish(found); await activating; },
  };
}

describe('#357: the side panel while activation waits for the dbt walk', () => {
  it('the Diagrams view exists and says "Loading diagrams…" while the walk is still running', async () => {
    const run = await activateDuringWalk();
    expect(run.during).toEqual({
      activated: true,
      // Still unset: the project is decided by the walk, and what hasProject gates is not registered yet.
      hasProject: undefined,
      hasDbtProject: undefined,
      diagramsLoading: true,
      tablesLoading: true,
      diagramsViews: 1,
      welcome: ['Loading diagrams…'],
    });

    await run.finish();
    // The folder opens (logical-only) once the walk answers, through the same view.
    expect(lastContext(run.exec, 'erdStudio.hasProject')).toBe(true);
    expect(lastContext(run.exec, 'erdStudio.hasDbtProject')).toBe(false);
    expect(diagramViews(run.createTreeView)).toBe(1);
  });

  it('a root dbt project with no ERD data yet shows the same, and still opens as the dbt project', async () => {
    fs.writeFileSync(path.join(root, 'dbt_project.yml'), 'name: p\n');
    const run = await activateDuringWalk();
    expect(run.during).toMatchObject({ hasProject: undefined, diagramsLoading: true, diagramsViews: 1, welcome: ['Loading diagrams…'] });

    await run.finish();
    expect(lastContext(run.exec, 'erdStudio.hasProject')).toBe(true);
    expect(lastContext(run.exec, 'erdStudio.hasDbtProject')).toBe(true);
    expect(diagramViews(run.createTreeView)).toBe(1);
    // The same root as resolving without any early step: the walk still decides it.
    expect(resolveDbtProject([root], { below: [] }).root).toBe(root);
  });

  it('nothing that names an unregistered command shows during the walk: no + New… menu, no Help & Feedback', async () => {
    const run = await activateDuringWalk();
    expect(run.sidebar.visibleViews).toEqual([DIAGRAMS]);
    expect(run.sidebar.titleActions).not.toContain('erdStudio.newMenu');
    for (const command of run.sidebar.titleActions) expect(run.registered.has(command), command).toBe(true);
    // Recorded for the PR, not pinned: most palette commands still wait for activation (pre-existing).
    const missing = packageJson.contributes.commands.filter((c) => !run.registered.has(c.command)).length;
    console.info(`#357 contributed=${packageJson.contributes.commands.length} unregisteredDuringWalk=${missing}`);
    await run.finish();
  });

  it('the glass sidebar (the default) draws the same: Loading diagrams…, no Help section, no + button', async () => {
    const run = await activateDuringWalk();
    expect(run.glassSnapshot).toBeDefined();
    const sections = run.glassSnapshot!.sections;
    const diagrams = sections.find((s) => s.key === 'diagrams')!;
    expect(diagrams.visible).toBe(true);
    expect(diagrams.welcome.map((w) => (w.paragraphs[0]?.parts[0] as { text?: string } | undefined)?.text)).toEqual(['Loading diagrams…']);
    expect(sections.find((s) => s.key === 'help')!.visible).toBe(false);
    const named = namedBy([...diagrams.actions.navigation, ...diagrams.actions.groups.flat()]);
    expect(named).not.toContain('erdStudio.newMenu');
    for (const command of named) expect(run.registered.has(command), command).toBe(true);
    await run.finish();
  });

  it('the only folder stops being a directory during the walk: the early view goes and its loading text with it', async () => {
    const folder = path.join(root, 'project');
    fs.mkdirSync(folder);
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(folder), name: 'p', index: 0 }];
    const disposed: string[] = [];
    const original = vscode.window.createTreeView;
    const run = await (async () => {
      vi.spyOn(vscode.window, 'createTreeView').mockImplementation(((id: string, options: unknown) => {
        const view = original(id, options);
        return { ...view, dispose: () => { disposed.push(id); view.dispose(); } };
      }) as never);
      return activateDuringWalk();
    })();
    expect(run.during.diagramsLoading).toBe(true);
    fs.rmSync(folder, { recursive: true, force: true });

    await run.finish();
    expect(lastContext(run.exec, 'erdStudio.hasProject')).toBe(false);
    expect(lastContext(run.exec, 'erdStudio.diagramsLoading')).toBe(false);
    expect(lastContext(run.exec, 'erdStudio.tablesLoading')).toBe(false);
    expect(disposed).toEqual([DIAGRAMS]);
    // The empty window's welcome, not a stuck "Loading diagrams…".
    expect(nativeWelcome()).not.toContain('Loading diagrams…');
  });
});

describe('#357: the early step and the resolver read one rule', () => {
  it('firstOpenFolder is defined exactly when a resolution with nothing found still has a root', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-357-rule-'));
    try {
      const gone = path.join(folder, 'gone');
      const file = path.join(folder, 'notes.txt');
      fs.writeFileSync(file, 'x');
      for (const folders of [[folder], [gone, folder], [gone], [file], [], [gone, file]]) {
        // An invalid projectPath falls through to the same last step.
        for (const projectPath of [undefined, path.join(folder, 'nowhere')]) {
          const resolved = resolveDbtProject(folders, { below: [], projectPath });
          expect(firstOpenFolder(folders) !== undefined, JSON.stringify({ folders, projectPath })).toBe(resolved.root !== undefined);
        }
      }
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});
