/**
 * The 2.0 B6 / B11 host wiring as `activate()` makes it, on a temp copy of the
 * fixture project: the project's storage once a day off the onboarding trail,
 * the 1.9 pre-release tree's warning, and a deleted diagram. Fixed keys only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { activate, _resetFirstRunGuardForTests } from '../../src/extension';
import { clearLegacyDbmlTreeVerdicts } from '../../src/services/legacyDbmlTree';
import { telemetry } from '../../src/services/telemetryService';

const REPO_ROOT = path.resolve(__dirname, '../..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'test', 'fixtures', 'dbt-project');
const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));

type Context = import('vscode').ExtensionContext;

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
let project: string;
let context: Context;

async function openProject(dir: string): Promise<void> {
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(dir), name: path.basename(dir), index: 0 }];
  await activate(context);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-t20-imports-'));
  project = path.join(root, 'project');
  context = makeContext(root);
  vscode._resetRegisteredCommands();
  vscode._resetMockConfiguration();
  vscode._resetMockWorkspace();
  vscode._clearMockFileWatchers();
  vscode.workspace.workspaceFolders = [];
  vscode.window.tabGroups.all = [];
  vscode._resetMockWebviewPanels();
  vscode._setMockExtensions([]);
  _resetFirstRunGuardForTests();
  clearLegacyDbmlTreeVerdicts();
  vi.stubEnv('HOME', root);
  vi.stubEnv('USERPROFILE', root);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
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
  fs.rmSync(root, { recursive: true, force: true });
});

describe('telemetry 2.0 host wiring: storage, the 1.9 tree, a deleted diagram', () => {
  it('records the project\'s storage once a day, off the onboarding trail (featureQuiet with once)', async () => {
    fs.cpSync(FIXTURE_ROOT, project, { recursive: true });
    const quiet = vi.spyOn(telemetry, 'featureQuiet');
    const feature = vi.spyOn(telemetry, 'feature');
    await openProject(project);
    const storage = quiet.mock.calls.filter((c) => /^storage(Yaml|Dbml|Mixed)$/.test(String(c[0])));
    expect(storage.length).toBeGreaterThan(0);
    for (const call of storage) expect(call[1]).toBe(true);
    expect(feature.mock.calls.some((c) => String(c[0]).startsWith('storage'))).toBe(false);
  });

  it('the 1.9 pre-release tree\'s warning counts legacyDbmlTreeWarned', async () => {
    fs.cpSync(FIXTURE_ROOT, project, { recursive: true });
    // A .dbml under tables/: the 1.9 layout.
    fs.mkdirSync(path.join(project, '.erd-studio', 'tables'), { recursive: true });
    fs.writeFileSync(path.join(project, '.erd-studio', 'tables', 'old.dbml'), 'Table old {\n  id int\n}\n');
    const warn = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined as never);
    const feature = vi.spyOn(telemetry, 'feature');
    await openProject(project);
    expect(warn.mock.calls.some((c) => /1\.9 pre-release/.test(String(c[0])))).toBe(true);
    expect(feature).toHaveBeenCalledWith('legacyDbmlTreeWarned');
  });

  it('Delete Diagram counts diagramDeleted once the file is gone, and not when it is cancelled', async () => {
    fs.cpSync(FIXTURE_ROOT, project, { recursive: true });
    await openProject(project);
    const file = path.join(project, '.erd-studio', 'gold', 'finance.json');
    const element = { type: 'domain', summary: { domain: 'finance', filePath: file, layer: 'gold' } };
    const feature = vi.spyOn(telemetry, 'feature');
    const confirm = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined as never);

    await vscode.commands.executeCommand('erdStudio.deleteDomain', element);
    expect(feature).not.toHaveBeenCalledWith('diagramDeleted');

    confirm.mockResolvedValue('Delete' as never);
    vi.spyOn(vscode.workspace.fs, 'delete').mockImplementation((async (uri: vscode.Uri) => { fs.rmSync(uri.fsPath); }) as never);
    await vscode.commands.executeCommand('erdStudio.deleteDomain', element);
    await settle();
    expect(fs.existsSync(file)).toBe(false);
    expect(feature.mock.calls.filter((c) => c[0] === 'diagramDeleted')).toHaveLength(1);
  });
});
