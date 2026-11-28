/**
 * #357: activation wires the look's status into the glass sidebar. While it
 * waits on the look through the open folder, the Diagrams section says what
 * it is doing (folders checked, time left); when the look is over the status
 * goes; and a look that stopped early, with no answer from the host's own
 * search either, leaves a notice with Look for Longer, unless the user
 * dismissed it in this workspace before.
 *
 * VS Code draws no webview view, so no glass sidebar, until `activate()`
 * resolves. So a look that runs long lets `activate()` resolve while
 * activation carries on, and until it is over every contributed command it
 * has not registered yet is held: invoked meanwhile, it waits and then runs.
 *
 * The look is a stub (held open, or answering with the stats a slow disk
 * would give): the looks themselves are `dbtLookLonger357.test.ts`, the
 * wording `dbtLookStatus.test.ts`, the buttons `dbtLookNotice.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { DBT_LOOK_NOTICE_DISMISSED_KEY, activate, _activationOverForTests, _resetFirstRunGuardForTests } from '../../src/extension';
import { heldCommandIds } from '../../src/commands/heldCommands';
import { LOOK_DISMISS_BUTTON, LOOK_LONGER_BUTTON, LOOK_STATUS_DELAY_MS } from '../../src/services/dbtLookStatus';
import { FolderLooks, type DbtSearchStats } from '../../src/services/folderLook';
import { _resetContextKeys } from '../../src/providers/glassSidebar/contextKeys';
import type { Contributions } from '../../src/providers/glassSidebar/contributions';
import type { GlassSidebarProvider } from '../../src/providers/glassSidebar/GlassSidebarProvider';
import type { GlassSectionStatus } from '../../src/providers/glassSidebar/protocol';

const REPO_ROOT = path.resolve(__dirname, '../..');
const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8')) as { version: string; contributes: Contributions };
type Context = import('vscode').ExtensionContext;

let root: string;
let context: Context;
let workspaceState: Map<string, unknown>;

function makeContext(): Context {
  const globalState = new Map<string, unknown>([['erdStudio.gettingStartedShown', true]]);
  workspaceState = new Map<string, unknown>([
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

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-357s-'));
  context = makeContext();
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

/** The glass sidebar's provider, as activation registers it. */
function captureGlass(): () => GlassSidebarProvider {
  let glass: GlassSidebarProvider | undefined;
  const original = vscode.window.registerWebviewViewProvider;
  vi.spyOn(vscode.window, 'registerWebviewViewProvider').mockImplementation(((id: string, provider: unknown, options: unknown) => {
    glass = provider as GlassSidebarProvider;
    return original(id, provider, options);
  }) as never);
  return () => glass!;
}

/** The look answers with `stats`, whatever the folder holds. `hold`: not until `finish()`. */
function stubLook(stats: () => DbtSearchStats, hold = false) {
  let finish: () => void = () => {};
  let started!: () => void;
  const startedP = new Promise<void>((r) => { started = r; });
  const held = hold ? new Promise<string[]>((r) => { finish = () => r([]); }) : Promise.resolve([] as string[]);
  vi.spyOn(FolderLooks.prototype, 'dbtProjectsBelow').mockImplementation(() => { started(); return held; });
  vi.spyOn(FolderLooks.prototype, 'peek').mockImplementation(() => ({ dbtSearchStats: stats }) as never);
  return { started: startedP, finish: () => finish() };
}

const diagramsStatus = (glass: GlassSidebarProvider): GlassSectionStatus | undefined =>
  glass.snapshot().sections.find((s) => s.key === 'diagrams')!.status;

const complete: DbtSearchStats = { folders: 40, msLeft: 59_000, complete: true, stopped: undefined, maxMs: 60_000, maxFolders: 5000 };
const outOfTime: DbtSearchStats = { folders: 3200, msLeft: 0, complete: false, stopped: 'time', maxMs: 60_000, maxFolders: 5000 };
/** The host's own search never answers, so activation gives up on it (`timeout`). */
const hostSearchSilent = (): void => { vi.spyOn(vscode.workspace, 'findFiles').mockImplementation((() => new Promise(() => {})) as never); };

describe('#357 the Diagrams section says what activation is doing', () => {
  it('a slow look: activate() resolves so the sidebar can draw, with folders checked and the time left; gone when the look is over', async () => {
    let stats: DbtSearchStats = { folders: 1240, msLeft: 48_000, complete: false, stopped: undefined, maxMs: 60_000, maxFolders: 5000 };
    const look = stubLook(() => stats, true);
    const glass = captureGlass();
    const began = Date.now();
    let resolved = false;
    const activating = activate(context).then(() => { resolved = true; });
    await look.started;
    // Nothing for a look that has only just begun, and activation is still what VS Code waits on.
    expect(diagramsStatus(glass())).toBeUndefined();
    await new Promise((r) => setTimeout(r, 200));
    expect(resolved).toBe(false);
    expect(heldCommandIds()).toEqual([]);
    // The look runs long: activate() resolves by itself, with the look still held open.
    await activating;
    expect(Date.now() - began).toBeGreaterThanOrEqual(LOOK_STATUS_DELAY_MS - 50);
    const registered = new Set(vscode._registeredCommands.map((e) => e.command));
    // Every contributed command answers from now on: the ones activation has not reached yet are held.
    const contributed = (packageJson.contributes as unknown as { commands: Array<{ command: string }> }).commands.map((c) => c.command);
    for (const command of contributed) expect(registered.has(command), command).toBe(true);
    expect(heldCommandIds()).toContain('erdStudio.importDbml');
    expect(heldCommandIds()).not.toContain('erdStudio.toggleGlassSidebar');
    let ran = false;
    expect(heldCommandIds()).toContain('erdStudio.reloadFromDisk');
    const waiting = Promise.resolve(vscode.commands.executeCommand('erdStudio.reloadFromDisk')).then(() => { ran = true; });
    await new Promise((r) => setTimeout(r, 50));
    expect(ran).toBe(false);
    const status = diagramsStatus(glass());
    expect(status).toEqual({
      title: `Looking through ${path.basename(root)}…`,
      detail: '1,240 folders checked so far, of 5,000 at most.',
      working: true,
      countdown: { msLeft: 48_000, text: 'Stops in {time} if it has not finished.' },
    });
    expect(JSON.stringify(status)).not.toMatch(/dbt/i);
    // The loading rows are still what the section shows under it.
    const diagrams = glass().snapshot().sections.find((s) => s.key === 'diagrams')!;
    expect(diagrams.welcome.map((w) => (w.paragraphs[0]?.parts[0] as { text?: string } | undefined)?.text)).toEqual(['Loading diagrams…']);
    stats = complete;
    look.finish();
    await _activationOverForTests();
    expect(diagramsStatus(glass())).toBeUndefined();
    // Activation is over: nothing is held, each command is registered once, and the one that waited has run.
    expect(heldCommandIds()).toEqual([]);
    const ids = vscode._registeredCommands.map((e) => e.command);
    expect(new Set(ids).size).toBe(ids.length);
    for (const command of contributed) expect(ids, command).toContain(command);
    await waiting;
    expect(ran).toBe(true);
  }, 20_000);

  it('a look that answers in time: activate() resolves only when activation is over, and nothing is ever held', async () => {
    stubLook(() => complete);
    let over = false;
    void _activationOverForTests().then(() => { over = true; });
    const activating = activate(context);
    void _activationOverForTests().then(() => { over = true; });
    await activating;
    await Promise.resolve();
    expect(heldCommandIds()).toEqual([]);
    await _activationOverForTests();
    expect(over).toBe(true);
    expect(vscode._registeredCommands.some((e) => e.command === 'erdStudio.importDbml')).toBe(true);
  }, 20_000);

  it('a look that stopped early with no answer from the host search: a notice with Look for Longer, and Dismiss is remembered', async () => {
    hostSearchSilent();
    stubLook(() => outOfTime);
    const glass = captureGlass();
    await activate(context);
    // The host search's wait is as long as the status's delay: activate() may resolve a moment before activation is over.
    await _activationOverForTests();
    expect(diagramsStatus(glass())).toEqual({
      title: 'Stopped looking after 1 minute.',
      detail: `ERD Studio checked 3,200 folders in ${path.basename(root)}, not all of them. It opened ${path.basename(root)}. A project deeper down may have been missed.`,
      actions: [LOOK_LONGER_BUTTON, LOOK_DISMISS_BUTTON],
    });
    // Dismiss, as the page sends it: the button's index only.
    let handler: ((m: unknown) => void) | undefined;
    glass().resolveWebviewView({
      visible: true,
      show: () => {},
      onDidChangeVisibility: () => ({ dispose() {} }),
      onDidDispose: () => ({ dispose() {} }),
      webview: {
        options: {}, html: '', cspSource: 'https://webview.test',
        asWebviewUri: (u: { path: string }) => ({ toString: () => `https://webview.test${u.path}` }),
        postMessage: async () => true,
        onDidReceiveMessage: (fn: (m: unknown) => void) => { handler = fn; return { dispose() {} }; },
      },
    } as unknown as vscode.WebviewView);
    handler!({ type: 'ready' });
    handler!({ type: 'statusAction', section: 'diagrams', index: 1 });
    await new Promise((r) => setTimeout(r, 20));
    expect(diagramsStatus(glass())).toBeUndefined();
    expect(workspaceState.get(DBT_LOOK_NOTICE_DISMISSED_KEY)).toBe(true);
  }, 20_000);

  it('dismissed in this workspace before: no notice', async () => {
    hostSearchSilent();
    stubLook(() => outOfTime);
    workspaceState.set(DBT_LOOK_NOTICE_DISMISSED_KEY, true);
    const glass = captureGlass();
    await activate(context);
    // The host search's wait is as long as the status's delay: activate() may resolve a moment before activation is over.
    await _activationOverForTests();
    expect(diagramsStatus(glass())).toBeUndefined();
  }, 20_000);

  it('the host search answered: nothing was missed, so nothing is said', async () => {
    stubLook(() => outOfTime);
    const glass = captureGlass();
    await activate(context);
    // The host search's wait is as long as the status's delay: activate() may resolve a moment before activation is over.
    await _activationOverForTests();
    expect(diagramsStatus(glass())).toBeUndefined();
  }, 20_000);

  it('a look that went everywhere says nothing afterwards, even when the host search never answered', async () => {
    hostSearchSilent();
    stubLook(() => complete);
    const glass = captureGlass();
    await activate(context);
    // The host search's wait is as long as the status's delay: activate() may resolve a moment before activation is over.
    await _activationOverForTests();
    expect(diagramsStatus(glass())).toBeUndefined();
  }, 20_000);
});
