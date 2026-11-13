/**
 * The 2.0 runtime telemetry wired in extension.ts (plan B4, B12, B16):
 * activation that throws records its phase and rethrows; the host's dbt
 * search reports how it ended; a watcher refresh that throws is counted by
 * kind; a failed AI helper install names its target and write class; a
 * hook left out of a JSONC settings file is reported by reason and tool.
 * Fixed keys only: never a path or a message.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { activate, findHostDbtProjects, guardRefresh, recordHarnessInstalls, setRefreshFailureSink, _resetFirstRunGuardForTests } from '../../src/extension';
import { telemetry } from '../../src/services/telemetryService';
import { ownWrites } from '../../src/services/ownWriteTracker';
import { HARNESS_TARGETS, HarnessService } from '../../src/services/harnessService';
import { hookSkippedFeatures } from '../../src/services/runtimeTelemetry';

const REPO_ROOT = path.resolve(__dirname, '../..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'test', 'fixtures', 'dbt-project');
const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8')) as { version: string };

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

let root: string;
let context: Context;
const errors = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => c[0]);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-act-tel-'));
  context = makeContext(root);
  vscode._resetRegisteredCommands();
  vscode._resetMockConfiguration();
  vscode._resetMockWorkspace();
  vscode._clearMockFileWatchers();
  vscode.workspace.workspaceFolders = [];
  vscode._resetMockWebviewPanels();
  vscode._setMockExtensions([]);
  _resetFirstRunGuardForTests();
  vi.stubEnv('HOME', root);
  vi.stubEnv('USERPROFILE', root);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
});

afterEach(async () => {
  for (const sub of [...context.subscriptions].reverse()) {
    try { await sub.dispose(); } catch { /* best effort */ }
  }
  for (const panel of [...vscode.window._webviewPanels]) panel.dispose();
  vscode._resetMockWebviewPanels();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('B4: activation that throws', () => {
  it('records activationFailed and the Services phase, then rethrows the same error', async () => {
    fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root), name: 'p', index: 0 }];
    const boom = new Error('services broke at /home/someone/secret');
    vi.spyOn(ownWrites, 'onRecorded').mockImplementation(() => { throw boom; });
    const error = vi.spyOn(telemetry, 'error');

    await expect(activate(context)).rejects.toBe(boom);
    const codes = errors(error);
    expect(codes).toContain('activationFailed');
    expect(codes).toContain('activationFailedServices');
    expect(codes.filter((c) => String(c).startsWith('activationFailed'))).toEqual(['activationFailed', 'activationFailedServices']);
  });

  it('a clean activation records no activation failure', async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(telemetry, 'error');
    await activate(context);
    expect(errors(error).filter((c) => String(c).startsWith('activationFailed'))).toEqual([]);
  });
});

describe('B4: the host search for dbt_project.yml', () => {
  beforeEach(() => {
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root), name: 'p', index: 0 }];
  });

  it('ok with the paths it found', async () => {
    vi.spyOn(vscode.workspace, 'findFiles').mockResolvedValue([vscode.Uri.file(path.join(root, 'dbt_project.yml'))] as never);
    expect(await findHostDbtProjects(1000)).toEqual({ paths: [root], outcome: 'ok' });
  });

  it('timeout when it does not answer in time', async () => {
    vi.spyOn(vscode.workspace, 'findFiles').mockImplementation((() => new Promise(() => {})) as never);
    expect(await findHostDbtProjects(5)).toEqual({ outcome: 'timeout' });
  });

  it('error when it rejects, and says so (#304)', async () => {
    vi.spyOn(vscode.workspace, 'findFiles').mockRejectedValue(new Error('search broke') as never);
    expect(await findHostDbtProjects(1000)).toEqual({ outcome: 'error', reason: 'rejected' });
  });
});

describe('B12: a watcher refresh that throws', () => {
  it('a rejection counts refreshFailed and its kind, once, and is not rethrown', async () => {
    const error = vi.spyOn(telemetry, 'error');
    const listener = guardRefresh('Manifest', async () => { throw new Error('manifest broke'); });
    expect(() => listener()).not.toThrow();
    await vi.waitFor(() => expect(errors(error)).toEqual(['refreshFailed', 'refreshFailedManifest']));
  });

  it('a synchronous throw too; a listener that works records nothing and gets its arguments', async () => {
    const error = vi.spyOn(telemetry, 'error');
    guardRefresh('Layers', () => { throw new Error('layers broke'); })();
    expect(errors(error)).toEqual(['refreshFailed', 'refreshFailedLayers']);
    error.mockClear();
    const seen: unknown[] = [];
    guardRefresh('Table', (e: { tables: string[] }) => { seen.push(e); })({ tables: ['dim_customer'] });
    await Promise.resolve();
    expect(seen).toEqual([{ tables: ['dim_customer'] }]);
    expect(error).not.toHaveBeenCalled();
  });
});

describe('a watcher refresh that throws is said on the canvas, not only in the log', () => {
  afterEach(() => setRefreshFailureSink(undefined));

  it('tells the sink which kind failed, for a throw and for a rejection; a listener that works tells it nothing', async () => {
    const told: string[] = [];
    setRefreshFailureSink((kind) => told.push(kind));
    guardRefresh('Layers', () => { throw new Error('layers broke'); })();
    expect(told).toEqual(['Layers']);
    guardRefresh('Table', async () => { throw new Error('tables broke'); })();
    await vi.waitFor(() => expect(told).toEqual(['Layers', 'Table']));
    guardRefresh('Diagram', () => undefined)();
    await Promise.resolve();
    expect(told).toEqual(['Layers', 'Table']);
  });

  it('a sink that throws is contained: the watcher never sees it', () => {
    setRefreshFailureSink(() => { throw new Error('sink broke'); });
    expect(() => guardRefresh('Table', () => { throw new Error('tables broke'); })()).not.toThrow();
  });
});

describe('B16: AI helper installs', () => {
  // A read-only folder refuses the write only for a non-root user on a POSIX file system.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('an EACCES install of the Copilot file records its target, the write class and harnessUpdateFailed', () => {
    const service = new HarnessService();
    const copilot = HARNESS_TARGETS.find((t) => t.id === 'copilot')!;
    // A folder the user may not write (as on a read-only checkout).
    fs.mkdirSync(path.join(root, '.github'));
    fs.chmodSync(path.join(root, '.github'), 0o555);
    let result: ReturnType<HarnessService['install']>;
    try {
      result = service.install(root, copilot, true);
    } finally {
      fs.chmodSync(path.join(root, '.github'), 0o755);
    }
    expect(result.success).toBe(false);
    expect(result.errno).toBe('EACCES');

    const error = vi.spyOn(telemetry, 'error');
    const feature = vi.spyOn(telemetry, 'feature');
    recordHarnessInstalls([result]);
    expect(errors(error)).toEqual(['harnessInstallFailed', 'harnessInstallFailedCopilot', 'harnessUpdateFailed']);
    expect(errors(feature)).toEqual(['writeFailedPermission']);
  });

  it('a successful install records only its feature', () => {
    const service = new HarnessService();
    const copilot = HARNESS_TARGETS.find((t) => t.id === 'copilot')!;
    const error = vi.spyOn(telemetry, 'error');
    const feature = vi.spyOn(telemetry, 'feature');
    recordHarnessInstalls([service.install(root, copilot, true)]);
    expect(error).not.toHaveBeenCalled();
    expect(errors(feature)).toEqual(['harnessInstallCopilot']);
  });

  it('a Copilot settings file with comments leaves its hook out: hookSkippedJsonc and hookSkippedCopilot', () => {
    fs.mkdirSync(path.join(root, '.github', 'copilot'), { recursive: true });
    fs.writeFileSync(path.join(root, '.github', 'copilot', 'settings.local.json'), '{\n  // mine\n  "hooks": {}\n}\n');
    const result = new HarnessService().installRecommended(root, { replaceUnmanaged: false, assistants: ['copilot'] });
    expect(result.skippedHooks).toEqual([{ id: 'copilot', reason: 'jsonc' }]);
    expect(hookSkippedFeatures(result.skippedHooks)).toEqual(['hookSkippedJsonc', 'hookSkippedCopilot']);
  });
});
