/**
 * The manifest watcher's "dbt manifest updated" notification steps aside for
 * a Run dbt parse / compile run, which says it finished itself (S1, S2, S3 or
 * the compile notice). Decided when the change arrives, before the refresh:
 * on a big project the refresh can outlast the run's grace period. Without a
 * run, the watcher's notification shows as before. Real `activate()`.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { _resetDbtRunsForTests, runDbtInTerminal } from '../../src/commands/dbtTerminal';
import { getDbtRunHost } from '../../src/commands/dbtRunHost';
import { activate, _resetFirstRunGuardForTests } from '../../src/extension';
import type { SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import type { DbtSpawnPlan } from '../../src/services/dbtLaunch';
import type { DbtProcessHandle, DbtProcessResult } from '../../src/services/dbtProcess';

const REPO_ROOT = path.resolve(__dirname, '../..');
const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
const UPDATED = 'dbt manifest updated. Graphs refreshed with latest dbt model data.';
const PLAN: DbtSpawnPlan = { file: 'dbt', args: ['parse'], shell: false, env: {}, cwd: '/', display: 'dbt parse' };

function makeContext(root: string): vscode.ExtensionContext {
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
  } as unknown as vscode.ExtensionContext;
}

/** A dbt run that never spawns anything: `end()` finishes it. */
function activeRun(root: string): { end: () => Promise<void> } {
  let resolve!: (r: DbtProcessResult) => void;
  const done = new Promise<DbtProcessResult>((r) => { resolve = r; });
  const start = (): DbtProcessHandle => ({ done, stop: () => {}, kill: () => {}, running: true });
  const s = runDbtInTerminal(root, 'parse', 'normal', PLAN, { start });
  if (s.kind !== 'started') throw new Error('busy');
  vscode._openPty(s.run.terminal);
  return {
    end: async () => {
      resolve({ outcome: 'exited', exitCode: 0, tail: '', durationMs: 1 });
      await s.run.result;
    },
  };
}

describe('manifest watcher notification and Run dbt parse', () => {
  let ws: string;
  let context: vscode.ExtensionContext;
  let provider: SemanticEditorProvider;
  let info: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'erd-dbt-toast-')));
    fs.cpSync(path.join(REPO_ROOT, 'test', 'fixtures', 'dbt-project'), ws, { recursive: true, preserveTimestamps: true });
    context = makeContext(ws);
    vscode._resetRegisteredCommands();
    vscode._resetMockConfiguration();
    vscode._resetMockWorkspace();
    vscode._clearMockFileWatchers();
    vscode._resetMockWebviewPanels();
    _resetFirstRunGuardForTests();
    _resetDbtRunsForTests();
    vscode.window.terminals.length = 0;
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(ws), name: path.basename(ws), index: 0 }];
    vi.stubEnv('HOME', ws);
    vi.stubEnv('USERPROFILE', ws);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
    info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    const registerEditor = vi.spyOn(vscode.window, 'registerCustomEditorProvider');
    await activate(context);
    provider = registerEditor.mock.calls[0][1] as unknown as SemanticEditorProvider;
  });

  afterEach(async () => {
    for (const sub of [...context.subscriptions].reverse()) {
      try { await (sub as { dispose(): unknown }).dispose(); } catch { /* best effort */ }
    }
    _resetDbtRunsForTests();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(ws, { recursive: true, force: true });
  });

  const manifestWatcher = () => vscode._mockFileWatchers.find((w) => JSON.stringify(w._pattern ?? '').includes('manifest.json'))!;
  const change = () => manifestWatcher()._simulateChange(vscode.Uri.file(path.join(ws, 'target', 'manifest.json')));

  it('activation sets the Run dbt parse host with ERD Studio\'s own storage', () => {
    expect(getDbtRunHost()?.storageDir).toBe(path.join(ws, '.global-storage'));
  });

  it('shows the notification when no dbt run is going', async () => {
    change();
    await vi.waitFor(() => expect(info).toHaveBeenCalledWith(UPDATED), { timeout: 4000, interval: 10 });
  });

  it('skips it while a Run dbt parse run is going, even when the refresh outlasts the grace', async () => {
    const run = activeRun(ws);
    let refreshed = false;
    const real = provider.refreshAllOpenSubjectAreas.bind(provider);
    vi.spyOn(provider, 'refreshAllOpenSubjectAreas').mockImplementation(async () => {
      // The run ends and its grace passes while the refresh is still going.
      await run.end();
      _resetDbtRunsForTests();
      await real();
      refreshed = true;
    });
    change();
    await vi.waitFor(() => expect(refreshed).toBe(true), { timeout: 4000, interval: 10 });
    await new Promise((r) => setTimeout(r, 50));
    expect(info).not.toHaveBeenCalledWith(UPDATED);
  });
});
