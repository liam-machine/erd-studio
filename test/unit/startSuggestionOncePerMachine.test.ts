/**
 * Issue #305: the start suggestion is asked once per FOLDER, so an install
 * that upgraded (no `firstRun`) is asked again in every folder it opens.
 * Wanted (the smallest option): an upgrader is asked once per MACHINE
 * (globalState), a new install keeps once per folder, the rule never depends
 * on the telemetry setting, "Don't Ask Again for This Folder" / Turn On keep
 * their meaning, and a showing on an install already shown it in another
 * folder records `suggestPromptShownAgain`.
 *
 * Runs the real activate() against the vscode mock, one folder per "window",
 * with one globalState Map shared across windows (the machine) and a fresh
 * workspaceState per folder.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { activate, _resetFirstRunGuardForTests } from '../../src/extension';
import { telemetry } from '../../src/services/telemetryService';
import { FEATURES } from '../../src/services/telemetryPayload';
import { MAJOR_NOTICE_SHOWN_KEY, majorOf } from '../../src/services/majorUpdateNotice';

const REPO_ROOT = path.resolve(__dirname, '../..');
const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8')) as { version: string };
const RUNNING_MAJOR = majorOf(packageJson.version)!;
const STATE_KEY = 'erdStudio.startSuggestion';
const SQL = 'CREATE TABLE sales.customers (\n  id INT PRIMARY KEY\n);\n\nCREATE TABLE sales.orders (\n  id INT PRIMARY KEY,\n  customer_id INT REFERENCES sales.customers (id)\n);\n';

type Context = import('vscode').ExtensionContext;

let root: string;
let context: Context;
let info: ReturnType<typeof vi.spyOn>;
let answer: string | undefined;

function makeContext(globalState: Map<string, unknown>, workspaceState: Map<string, unknown>): Context {
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

/** A plain folder holding `files`, opened as the window's one folder; findFiles answers the look from them. */
function openFolder(name: string, files: Record<string, string>): string {
  const ws = path.join(root, name);
  fs.mkdirSync(ws, { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
    fs.writeFileSync(path.join(ws, rel), text);
  }
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(ws), name, index: 0 }];
  vi.spyOn(vscode.workspace, 'findFiles').mockImplementation((async (include: { pattern?: string } | string) => {
    const glob = typeof include === 'string' ? include : include.pattern ?? '';
    const plain = glob.replace(/\[(.)(.)\]/g, '$1').toLowerCase();
    const ext = plain === '**/*.sql' ? '.sql' : plain === '**/*.dbml' ? '.dbml' : undefined;
    return Object.keys(files).filter((f) => ext !== undefined && f.endsWith(ext)).map((f) => vscode.Uri.file(path.join(ws, f)));
  }) as never);
  vi.spyOn(vscode.workspace.fs, 'readDirectory').mockImplementation((async (uri: { fsPath: string }) =>
    fs.readdirSync(uri.fsPath, { withFileTypes: true }).map((e) => [e.name, e.isDirectory() ? vscode.FileType.Directory : vscode.FileType.File])) as never);
  return ws;
}

function tearDownWindow(): void {
  for (const sub of [...context.subscriptions].reverse()) { try { (sub as { dispose(): void }).dispose(); } catch { /* best effort */ } }
  context.subscriptions.length = 0;
  vscode._resetRegisteredCommands();
  _resetFirstRunGuardForTests();
}

/** One window on `folder` (its own workspaceState) on the machine `globalState`: activate, then past the deferred look. */
async function windowOn(folder: string, globalState: Map<string, unknown>, workspaceState = new Map<string, unknown>([['erdStudio.harnessInstallPrompted', true]])) {
  if (context?.subscriptions.length) tearDownWindow();
  openFolder(folder, { 'db/schema.sql': SQL });
  context = makeContext(globalState, workspaceState);
  info.mockClear();
  await activate(context);
  await new Promise((resolve) => setTimeout(resolve, 150));
  return { workspaceState, shown: shown().length };
}
const shown = () => info.mock.calls.filter((c) => /^ERD Studio found|from an older ERD Studio/.test(String(c[0])));

/** An install whose first run was long ago (no firstRun now): this major already running, notice spent. */
const upgrader = () => new Map<string, unknown>([
  ['lastActivatedVersion', packageJson.version],
  ['erdStudio.gettingStartedShown', true],
  [MAJOR_NOTICE_SHOWN_KEY, RUNNING_MAJOR],
]);
/** Straight from a 1.x version: the update itself is this window. */
const fromOlderMajor = () => new Map<string, unknown>([
  ['lastActivatedVersion', `${RUNNING_MAJOR - 1}.7.4`],
  ['erdStudio.gettingStartedShown', true],
  [MAJOR_NOTICE_SHOWN_KEY, RUNNING_MAJOR],
]);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-305-'));
  vscode._resetRegisteredCommands();
  vscode._resetMockConfiguration();
  vscode._resetMockWorkspace();
  vscode._clearMockFileWatchers();
  vscode._resetMockWebviewPanels();
  vscode._setMockExtensions([]);
  vscode.window.tabGroups.all = [];
  _resetFirstRunGuardForTests();
  vi.stubEnv('HOME', root);
  vi.stubEnv('USERPROFILE', root);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
  answer = undefined;
  info = vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((async () => answer) as never);
});

afterEach(() => {
  if (context) tearDownWindow();
  for (const panel of [...vscode.window._webviewPanels]) panel.dispose();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('#305: an upgrader is asked once per machine, not once per folder', () => {
  it('closed in folder A: folder B (same machine) is not asked again', async () => {
    const machine = upgrader();
    expect((await windowOn('repo-a', machine)).shown).toBe(1);
    expect((await windowOn('repo-b', machine)).shown).toBe(0);
  });

  it('straight from 1.x: closed in folder A, folder B is not asked again', async () => {
    const machine = fromOlderMajor();
    expect((await windowOn('repo-a', machine)).shown).toBe(1);
    expect((await windowOn('repo-b', machine)).shown).toBe(0);
  });

  it('five folders on one upgrader machine: one showing in all', async () => {
    const machine = upgrader();
    let total = 0;
    for (const f of ['a', 'b', 'c', 'd', 'e']) total += (await windowOn(`repo-${f}`, machine)).shown;
    expect(total).toBe(1);
  });

  it("Don't Ask Again for This Folder still means this folder: folder A is off in workspace state only", async () => {
    const machine = upgrader();
    answer = "Don't Ask Again for This Folder";
    const a = await windowOn('repo-a', machine);
    expect(a.workspaceState.get(STATE_KEY)).toMatchObject({ off: true });
    answer = undefined;
    expect((await windowOn('repo-b', machine)).shown).toBe(0);
  });
});

describe('#305: a new install keeps once per folder (guards the fix)', () => {
  it('first run in folder A, then folder B in a later window: asked in both', async () => {
    const machine = new Map<string, unknown>();
    expect((await windowOn('repo-a', machine)).shown).toBe(1);
    // The second window is no longer a fresh install by activation's own test
    // (lastActivatedVersion is stored now): the rule must have been remembered.
    expect(machine.get('lastActivatedVersion')).toBe(packageJson.version);
    expect((await windowOn('repo-b', machine)).shown).toBe(1);
  });

  it('records suggestPromptShownAgain on a showing after one in another folder, not on the first', async () => {
    const machine = new Map<string, unknown>();
    const feature = vi.spyOn(telemetry, 'feature');
    await windowOn('repo-a', machine);
    expect(feature.mock.calls.map((c) => c[0])).not.toContain('suggestPromptShownAgain');
    feature.mockClear();
    await windowOn('repo-b', machine);
    expect(feature.mock.calls.map((c) => c[0])).toContain('suggestPromptShownAgain');
  });

  it('first activation in an empty window (no folder), then folders A and B: still a new install, asked in both', async () => {
    const machine = new Map<string, unknown>();
    // The window right after installing: no folder open, so activation returns early.
    vscode.workspace.workspaceFolders = undefined as never;
    context = makeContext(machine, new Map());
    await activate(context);
    expect(machine.get('erdStudio.startSuggestion.machine')).toEqual({ shown: 0, newInstall: true });
    tearDownWindow();
    expect((await windowOn('repo-a', machine)).shown).toBe(1);
    expect((await windowOn('repo-b', machine)).shown).toBe(1);
    expect(machine.get('erdStudio.startSuggestion.machine')).toEqual({ shown: 2, newInstall: true });
  });

  it('the record says new only for the fresh install: an upgrader gets no newInstall, whatever happens next', async () => {
    const machine = upgrader();
    await windowOn('repo-a', machine);
    expect(machine.get('erdStudio.startSuggestion.machine')).toEqual({ shown: 1 });
  });

  it('suggestPromptShownAgain is a known feature key (extension side)', () => {
    expect(FEATURES as readonly string[]).toContain('suggestPromptShownAgain');
  });
});

describe('#305: Turn On for This Folder still brings it back (guards the fix)', () => {
  it('upgrader: Turn On in folder B, the next window on B asks', async () => {
    const machine = upgrader();
    await windowOn('repo-a', machine);
    const b = await windowOn('repo-b', machine);
    await vscode.commands.executeCommand('erdStudio.turnOnStartSuggestions');
    expect((await windowOn('repo-b', machine, b.workspaceState)).shown).toBe(1);
  });
});

describe('#305: Undo takes the off back and nothing more', () => {
  const ON_MESSAGE = /^Start suggestions are on for this folder/;
  /** Answers the start suggestion with `suggestion` and the "off" line with Undo. */
  const answering = (suggestion: string | undefined) => {
    info.mockImplementation((async (message: string) => {
      if (/^ERD Studio found/.test(String(message))) return suggestion;
      if (String(message) === 'Start suggestions are off for this folder.') return 'Undo';
      return undefined;
    }) as never);
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  it('upgrader: Turn Off then Undo in folder B (held back by the machine limit) leaves B not asked', async () => {
    const machine = upgrader();
    await windowOn('repo-a', machine);
    const b = await windowOn('repo-b', machine);
    expect(b.shown).toBe(0);
    answering(undefined);
    await vscode.commands.executeCommand('erdStudio.turnOffStartSuggestions');
    await settle();
    expect(b.workspaceState.get(STATE_KEY)).toEqual({ shown: 0 });
    // No promise of a suggestion the next time: the machine limit still holds B back.
    expect(info.mock.calls.some((c) => ON_MESSAGE.test(String(c[0])))).toBe(false);
    const feature = vi.spyOn(telemetry, 'feature');
    expect((await windowOn('repo-b', machine, b.workspaceState)).shown).toBe(0);
    expect(feature.mock.calls.map((c) => c[0])).not.toContain('suggestPromptShownAgain');
  });

  it("upgrader: Don't Ask Again then Undo on its one showing does not ask again or count a repeat", async () => {
    const machine = upgrader();
    answering("Don't Ask Again for This Folder");
    const a = await windowOn('repo-a', machine);
    expect(a.shown).toBe(1);
    await settle();
    expect(a.workspaceState.get(STATE_KEY)).toEqual({ shown: 0 });
    answering(undefined);
    const feature = vi.spyOn(telemetry, 'feature');
    expect((await windowOn('repo-a', machine, a.workspaceState)).shown).toBe(0);
    expect(feature.mock.calls.map((c) => c[0])).not.toContain('suggestPromptShownAgain');
  });

  it("new install: Don't Ask Again then Undo still brings it back in that folder, as before (guard)", async () => {
    const machine = new Map<string, unknown>();
    answering("Don't Ask Again for This Folder");
    const a = await windowOn('repo-a', machine);
    await settle();
    expect(info.mock.calls.some((c) => ON_MESSAGE.test(String(c[0])))).toBe(true);
    answering(undefined);
    expect((await windowOn('repo-a', machine, a.workspaceState)).shown).toBe(1);
  });

  it('upgrader: the palette\'s Turn On, then Turn Off and Undo, keeps the folder\'s Turn On', async () => {
    const machine = upgrader();
    await windowOn('repo-a', machine);
    const b = await windowOn('repo-b', machine);
    await vscode.commands.executeCommand('erdStudio.turnOnStartSuggestions');
    answering(undefined);
    await vscode.commands.executeCommand('erdStudio.turnOffStartSuggestions');
    await settle();
    expect(b.workspaceState.get(STATE_KEY)).toEqual({ shown: 0, on: true });
    expect((await windowOn('repo-b', machine, b.workspaceState)).shown).toBe(1);
  });
});

describe('#305: the rule never depends on telemetry', () => {
  it('telemetry off in VS Code: an upgrader is still asked once per machine', async () => {
    (vscode.env as { isTelemetryEnabled?: boolean }).isTelemetryEnabled = false;
    vscode._setMockConfiguration('erdStudio', 'telemetry.enabled', { globalValue: false });
    try {
      const machine = upgrader();
      expect((await windowOn('repo-a', machine)).shown).toBe(1);
      expect((await windowOn('repo-b', machine)).shown).toBe(0);
    } finally {
      (vscode.env as { isTelemetryEnabled?: boolean }).isTelemetryEnabled = true;
    }
  });

  it('telemetry off in VS Code: a new install is still a new install, asked in every folder', async () => {
    (vscode.env as { isTelemetryEnabled?: boolean }).isTelemetryEnabled = false;
    vscode._setMockConfiguration('erdStudio', 'telemetry.enabled', { globalValue: false });
    try {
      const machine = new Map<string, unknown>();
      expect((await windowOn('repo-a', machine)).shown).toBe(1);
      // Telemetry's own first-run record was never written, and is not needed.
      expect(machine.get('erdStudio.telemetry.firstRunAt')).toBeUndefined();
      expect((await windowOn('repo-b', machine)).shown).toBe(1);
    } finally {
      (vscode.env as { isTelemetryEnabled?: boolean }).isTelemetryEnabled = true;
    }
  });
});
