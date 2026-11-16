/**
 * #329, wired through the real activate(): the watcher's outside changes
 * (ERD Studio's own writes already dropped) are told apart by where they
 * came from and recorded as presence keys, off the onboarding trail. A
 * diagram file that appears still counts the `domainCreatedExternal` total.
 * Templates, dbt schema files and telemetry that is off record nothing.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { activate, _resetFirstRunGuardForTests } from '../../src/extension';
import { telemetry } from '../../src/services/telemetryService';
import type { SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import { LOOK_DELAY_MS } from '../../src/services/outsideChange';
import { OUTSIDE_CHANGE_SOURCE_FEATURES } from '../../src/services/telemetryPayload';

const REPO_ROOT = path.resolve(__dirname, '../..');
const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
const HOUR = 60 * 60_000;

function makeContext(root: string): vscode.ExtensionContext {
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
  } as unknown as vscode.ExtensionContext;
}

/** A hand-made repository at `dir` whose HEAD last moved an hour ago. */
function oldRepo(dir: string): string {
  const git = path.join(dir, '.git');
  const old = (Date.now() - HOUR) / 1000;
  for (const [rel, text] of [['HEAD', 'ref: refs/heads/main\n'], ['logs/HEAD', ''], ['refs/heads/main', `${'a'.repeat(40)}\n`]] as const) {
    fs.mkdirSync(path.dirname(path.join(git, rel)), { recursive: true });
    fs.writeFileSync(path.join(git, rel), text);
    fs.utimesSync(path.join(git, rel), old, old);
  }
  return git;
}

describe('outside changes, by where they came from (#329)', () => {
  let root: string;
  let ws: string;
  let context: vscode.ExtensionContext;
  let quiet: ReturnType<typeof vi.spyOn>;
  let counted: ReturnType<typeof vi.spyOn>;
  let enabled: ReturnType<typeof vi.spyOn>;
  let registerEditor: ReturnType<typeof vi.spyOn>;

  async function start(opts: { git?: boolean } = {}): Promise<void> {
    ws = path.join(root, 'project');
    fs.cpSync(path.join(REPO_ROOT, 'test', 'fixtures', 'logical-only'), ws, { recursive: true });
    if (opts.git) oldRepo(ws);
    registerEditor = vi.spyOn(vscode.window, 'registerCustomEditorProvider');
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(ws), name: 'project', index: 0 }];
    await activate(context);
    await vi.advanceTimersByTimeAsync(5_000);
    quiet.mockClear();
    counted.mockClear();
  }

  const watcher = (needle: string) => vscode._mockFileWatchers.find((w) => JSON.stringify(w._pattern ?? '').includes(needle))!;
  const semantic = () => watcher('**/*.{json,dbml}');
  const tables = () => watcher('{logical-models,tables}/**/*.yml');
  const file = (...rel: string[]) => vscode.Uri.file(path.join(ws, '.erd-studio', ...rel));
  /** Past the watcher's debounce and the look's wait. */
  const settle = () => vi.advanceTimersByTimeAsync(300 + LOOK_DELAY_MS + 100);
  /** The #329 keys recorded (other quiet flags, such as the storage kind a refresh notes, are not this test's). */
  const recorded = () => quiet.mock.calls
    .map((c) => c as unknown[])
    .filter((c) => (OUTSIDE_CHANGE_SOURCE_FEATURES as readonly unknown[]).includes(c[0]));

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'erd-outside-act-')));
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
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    enabled = vi.spyOn(telemetry, 'enabled').mockReturnValue(true);
    quiet = vi.spyOn(telemetry, 'featureQuiet');
    counted = vi.spyOn(telemetry, 'feature');
    // Timers only: the rule compares real file times with the clock.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  });

  afterEach(async () => {
    for (const sub of [...context.subscriptions].reverse()) {
      try { await (sub as { dispose(): unknown }).dispose(); } catch { /* best effort */ }
    }
    vscode._resetMockWebviewPanels();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('a table edited on disk in a repository whose HEAD stood still: modelChangedExternalDisk, once a day, off the trail', async () => {
    await start({ git: true });
    fs.appendFileSync(path.join(ws, '.erd-studio', 'tables', 'customer.yml'), '# edited\n');
    tables()._simulateChange(file('tables', 'customer.yml'));
    await settle();
    expect(recorded()).toEqual([['modelChangedExternalDisk', true]]);
  });

  it('the same edit saved from a document in this window: modelChangedExternalEditor', async () => {
    await start({ git: true });
    const target = path.join(ws, '.erd-studio', 'tables', 'customer.yml');
    fs.appendFileSync(target, '# edited\n');
    await vscode._fireDidSaveTextDocument(vscode.createMockTextDocument(target, fs.readFileSync(target, 'utf-8')));
    tables()._simulateChange(file('tables', 'customer.yml'));
    await settle();
    expect(recorded()).toEqual([['modelChangedExternalEditor', true]]);
  });

  it('a diagram file deleted in this window (the Explorer) is Editor too', async () => {
    await start({ git: true });
    const target = path.join(ws, '.erd-studio', 'gold', 'sales.json');
    fs.rmSync(target);
    await vscode._fireDidDeleteFiles([vscode.Uri.file(target)]);
    semantic()._simulateDelete(vscode.Uri.file(target));
    await settle();
    expect(recorded()).toEqual([['modelChangedExternalEditor', true]]);
  });

  it('a pull: HEAD moves as the files land: Git for the new diagram and the changed table; the total still counts', async () => {
    const t = Date.now();
    await start({ git: true });
    fs.writeFileSync(path.join(ws, '.erd-studio', 'gold', 'team.json'), fs.readFileSync(path.join(ws, '.erd-studio', 'gold', 'sales.json')));
    fs.appendFileSync(path.join(ws, '.erd-studio', 'tables', 'customer.yml'), '# pulled\n');
    semantic()._simulateCreate(file('gold', 'team.json'));
    tables()._simulateChange(file('tables', 'customer.yml'));
    // git writes the ref after the files.
    fs.utimesSync(path.join(ws, '.git', 'refs', 'heads', 'main'), Date.now() / 1000, Date.now() / 1000);
    expect(fs.statSync(path.join(ws, '.git', 'refs', 'heads', 'main')).mtimeMs).toBeGreaterThanOrEqual(t - 1000);
    await settle();
    expect(recorded().sort()).toEqual([['domainCreatedExternalGit', true], ['modelChangedExternalGit', true]]);
    expect(counted).toHaveBeenCalledWith('domainCreatedExternal');
  });

  it('no repository: NoGit for a new diagram and for a changed file', async () => {
    await start();
    fs.writeFileSync(path.join(ws, '.erd-studio', 'gold', 'new.json'), fs.readFileSync(path.join(ws, '.erd-studio', 'gold', 'sales.json')));
    semantic()._simulateCreate(file('gold', 'new.json'));
    semantic()._simulateChange(file('gold', 'sales.json'));
    await settle();
    // Unless this temp folder sits inside a repository on this machine, which the look would rightly find.
    const keys = recorded().map((c) => c[0]).sort();
    expect(keys).toEqual(['domainCreatedExternalNoGit', 'modelChangedExternalNoGit']);
    expect(counted).toHaveBeenCalledWith('domainCreatedExternal');
  });

  it('a template or other non-diagram JSON under the folder records nothing', async () => {
    await start({ git: true });
    fs.mkdirSync(path.join(ws, '.erd-studio', 'templates'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.erd-studio', 'templates', 'x.json'), '{}');
    semantic()._simulateChange(file('templates', 'x.json'));
    semantic()._simulateChange(file('.sync-plan.json'));
    await settle();
    expect(recorded()).toEqual([]);
  });

  it('a canvas undo bringing back a table file it deleted is ERD Studio\'s own: nothing recorded', async () => {
    await start({ git: true });
    const provider = registerEditor.mock.calls[0][1] as unknown as SemanticEditorProvider;
    vi.spyOn(provider, 'lastUndoRedoAt').mockReturnValue(Date.now());
    tables()._simulateCreate(file('tables', 'customer.yml'));
    await settle();
    expect(recorded()).toEqual([]);
  });

  it('records nothing while telemetry is off', async () => {
    await start({ git: true });
    enabled.mockReturnValue(false);
    tables()._simulateChange(file('tables', 'customer.yml'));
    semantic()._simulateChange(file('gold', 'sales.json'));
    await settle();
    expect(recorded()).toEqual([]);
  });
});
