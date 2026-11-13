/**
 * #304: the host's dbt_project.yml search (`findHostDbtProjects`) fails for
 * three different reasons, and telemetry must be able to tell them apart:
 * `findFiles` rejects, the fulfilment handler (`sortDbtCandidates`) throws,
 * or `findFiles` throws synchronously. Plus one feature,
 * `dbtSearchFailedWalkFound`: the search failed and the walk still found
 * the dbt project. Keys are appended (`HEARTBEAT_VERSION` stays 1).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { activate, findHostDbtProjects, _resetFirstRunGuardForTests } from '../../src/extension';
import { telemetry } from '../../src/services/telemetryService';
import { ERROR_CODES, FEATURES } from '../../src/services/telemetryPayload';

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
const calls = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => String(c[0]));
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-304-'));
  context = makeContext(root);
  vscode._resetRegisteredCommands();
  vscode._resetMockConfiguration();
  vscode._resetMockWorkspace();
  vscode._clearMockFileWatchers();
  vscode._resetMockWebviewPanels();
  vscode._setMockExtensions([]);
  _resetFirstRunGuardForTests();
  vi.stubEnv('HOME', root);
  vi.stubEnv('USERPROFILE', root);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root), name: 'p', index: 0 }];
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

describe('#304: findHostDbtProjects says why it failed', () => {
  it('findFiles rejects → error, reason rejected', async () => {
    vi.spyOn(vscode.workspace, 'findFiles').mockRejectedValue(new Error('search refused') as never);
    expect(await findHostDbtProjects(1000)).toEqual({ outcome: 'error', reason: 'rejected' });
  });

  it('the fulfilment handler (sortDbtCandidates) throws → error, reason sort', async () => {
    // A URI whose fsPath is not a string: path.basename throws inside sortDbtCandidates.
    vi.spyOn(vscode.workspace, 'findFiles').mockResolvedValue([{ fsPath: undefined }] as never);
    expect(await findHostDbtProjects(1000)).toEqual({ outcome: 'error', reason: 'sort' });
  });

  it('findFiles throws synchronously → error, reason threw', async () => {
    vi.spyOn(vscode.workspace, 'findFiles').mockImplementation((() => { throw new Error('no search provider'); }) as never);
    expect(await findHostDbtProjects(1000)).toEqual({ outcome: 'error', reason: 'threw' });
  });

  it('a search that rejects only once the timeout cancels it stays a timeout (no reason, nothing recorded)', async () => {
    const error = vi.spyOn(telemetry, 'error');
    vi.spyOn(vscode.workspace, 'findFiles').mockImplementation(((_g: unknown, _e: unknown, _m: unknown, token: vscode.CancellationToken) =>
      new Promise((_resolve, reject) => { token.onCancellationRequested(() => reject(new Error('Canceled'))); })) as never);
    expect(await findHostDbtProjects(5)).toEqual({ outcome: 'timeout' });
    await flush();
    expect(calls(error)).toEqual([]);
  });

  it('ok and timeout carry no reason', async () => {
    vi.spyOn(vscode.workspace, 'findFiles').mockResolvedValue([vscode.Uri.file(path.join(root, 'dbt_project.yml'))] as never);
    expect(await findHostDbtProjects(1000)).toEqual({ paths: [root], outcome: 'ok' });
    vi.spyOn(vscode.workspace, 'findFiles').mockImplementation((() => new Promise(() => {})) as never);
    expect(await findHostDbtProjects(5)).toEqual({ outcome: 'timeout' });
  });
});

describe('#304: the keys are appended', () => {
  const SPLIT = ['dbtSearchFailedRejected', 'dbtSearchFailedSort', 'dbtSearchFailedThrew'];

  it('ERROR_CODES ends with the three reasons, in order; dbtSearchFailed stays', () => {
    const codes = [...ERROR_CODES] as string[];
    expect(codes).toContain('dbtSearchFailed');
    expect(codes.slice(-3)).toEqual(SPLIT);
  });

  it('FEATURES ends with dbtSearchFailedWalkFound', () => {
    expect(([...FEATURES] as string[]).at(-1)).toBe('dbtSearchFailedWalkFound');
  });

  it("the Worker's lists end the same way", () => {
    const worker = fs.readFileSync(path.join(REPO_ROOT, 'telemetry/src/index.js'), 'utf8');
    const list = (name: string) => {
      const start = worker.indexOf(`const ${name} = [`);
      const end = worker.indexOf('];', start);
      return [...worker.slice(start, end).matchAll(/^\s*'([^']+)',/gm)].map((m) => m[1]);
    };
    expect(list('ERROR_CODES').slice(-3)).toEqual(SPLIT);
    expect(list('FEATURES').at(-1)).toBe('dbtSearchFailedWalkFound');
  });
});

/** Makes `findFiles` fail the way `reason` names. */
function failSearch(reason: 'rejected' | 'sort' | 'threw'): void {
  const spy = vi.spyOn(vscode.workspace, 'findFiles');
  if (reason === 'rejected') spy.mockRejectedValue(new Error(`search refused under ${root}`) as never);
  // A URI whose fsPath is not a string: path.basename throws inside sortDbtCandidates.
  else if (reason === 'sort') spy.mockResolvedValue([{ fsPath: undefined }] as never);
  else spy.mockImplementation((() => { throw new Error(`no search provider for ${root}`); }) as never);
}

const SPLIT_CODE = { rejected: 'dbtSearchFailedRejected', sort: 'dbtSearchFailedSort', threw: 'dbtSearchFailedThrew' } as const;
const searchCodes = (spy: { mock: { calls: unknown[][] } }) => calls(spy).filter((c) => c.startsWith('dbtSearchFailed'));

describe('#304: activation records the reason, and whether the walk saved the day', () => {
  for (const reason of ['rejected', 'sort', 'threw'] as const) {
    it(`a dbt project the walk finds, while the search fails (${reason}): the total and ${SPLIT_CODE[reason]} once, and dbtSearchFailedWalkFound`, async () => {
      fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
      failSearch(reason);
      const error = vi.spyOn(telemetry, 'error');
      const feature = vi.spyOn(telemetry, 'feature');
      await activate(context);
      await flush();
      expect(searchCodes(error)).toEqual(['dbtSearchFailed', SPLIT_CODE[reason]]);
      expect(calls(feature)).toContain('activatedDbt');
      expect(calls(feature).filter((c) => c === 'dbtSearchFailedWalkFound')).toEqual(['dbtSearchFailedWalkFound']);
      // Fixed keys only: never the folder or the error's message.
      for (const args of [...error.mock.calls, ...feature.mock.calls]) {
        for (const arg of args) expect(String(arg)).not.toContain(root);
      }
    });
  }

  it('a folder without dbt, while findFiles rejects: the failure counts once per window (the late retry adds none), no WalkFound', async () => {
    vi.spyOn(vscode.workspace, 'findFiles').mockRejectedValue(new Error('search refused') as never);
    const error = vi.spyOn(telemetry, 'error');
    const feature = vi.spyOn(telemetry, 'feature');
    await activate(context);
    await flush(); await flush();
    expect(calls(feature)).toContain('activatedLogical');
    expect(calls(feature)).not.toContain('dbtSearchFailedWalkFound');
    expect(searchCodes(error)).toEqual(['dbtSearchFailed', 'dbtSearchFailedRejected']);
  });

  it('a search that timed out at activation and then failed late counts that failure once, with its reason', async () => {
    // The first search never answers (activation's 1 s bound wins); the late one rejects.
    vi.spyOn(vscode.workspace, 'findFiles')
      .mockImplementationOnce((() => new Promise(() => {})) as never)
      .mockRejectedValue(new Error('search refused') as never);
    const error = vi.spyOn(telemetry, 'error');
    const feature = vi.spyOn(telemetry, 'feature');
    await activate(context);
    await vi.waitFor(() => expect(searchCodes(error)).toEqual(['dbtSearchFailed', 'dbtSearchFailedRejected']));
    expect(calls(feature)).toContain('dbtSearchTimedOut');
    expect(calls(feature)).not.toContain('dbtSearchFailedWalkFound');
  });

  it('a dbt project chosen by erdStudio.projectPath, which the walk does not reach: no WalkFound (the walk found nothing)', async () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-304-setting-'));
    try {
      fs.cpSync(FIXTURE_ROOT, elsewhere, { recursive: true });
      vscode._setMockConfiguration('erdStudio', 'projectPath', { workspaceValue: elsewhere });
      vi.spyOn(vscode.workspace, 'findFiles').mockRejectedValue(new Error('search refused') as never);
      const error = vi.spyOn(telemetry, 'error');
      const feature = vi.spyOn(telemetry, 'feature');
      await activate(context);
      await flush();
      expect(calls(feature)).toContain('activatedDbt');
      expect(searchCodes(error)).toEqual(['dbtSearchFailed', 'dbtSearchFailedRejected']);
      expect(calls(feature)).not.toContain('dbtSearchFailedWalkFound');
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('Select dbt Project… records the total and why too, and never WalkFound', async () => {
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    vi.spyOn(vscode.workspace, 'findFiles').mockResolvedValue([] as never);
    await activate(context);
    await flush();
    failSearch('threw');
    const error = vi.spyOn(telemetry, 'error');
    const feature = vi.spyOn(telemetry, 'feature');
    await vscode.commands.executeCommand('erdStudio.selectDbtProject');
    expect(searchCodes(error)).toEqual(['dbtSearchFailed', 'dbtSearchFailedThrew']);
    expect(calls(feature)).not.toContain('dbtSearchFailedWalkFound');
  });
});
