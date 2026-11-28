/**
 * #370: a relative erdStudio.projectPath saved in User settings for one
 * project warned in every other folder 2.x activates in, on every start, and
 * the message did not say why.
 *
 * The rule: the warning names the key and the settings scope that hold the
 * value. A relative value in User settings is said once per workspace (it
 * applies to every folder, so it misses in every folder it was not written
 * for) and comes back when the key, the scope or the value changes; a value in
 * the workspace's settings, or an absolute path, is a fault in this window
 * and warns on every start; an empty window says nothing about a relative
 * path. `projectPathInvalid` is counted on every start, whatever the gate
 * decides, and nothing ever writes the setting.
 *
 * Started from the Reproducer's test (projectPath370.repro.test.ts on
 * origin/develop 535270c8), which runs the real activate() in a plain folder
 * that holds one .sql file and no dbt_project.yml.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { activate, _resetFirstRunGuardForTests } from '../../src/extension';
import {
  OPEN_USER_SETTINGS_BUTTON,
  OPEN_WORKSPACE_SETTINGS_BUTTON,
  projectPathInvalidMessage,
} from '../../src/services/commandErrors';
import { erdStudioSettingSource, getErdStudioSetting } from '../../src/services/configService';
import { projectPathInvalidDetailCodes } from '../../src/services/runtimeTelemetry';
import { telemetry } from '../../src/services/telemetryService';

const REPO_ROOT = path.resolve(__dirname, '../..');
const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
type Context = import('vscode').ExtensionContext;

// ---------------------------------------------------------------------------
// (a) erdStudioSettingSource gives getErdStudioSetting's value, and where it is
// ---------------------------------------------------------------------------

describe('erdStudioSettingSource', () => {
  beforeEach(() => vscode._resetMockConfiguration());

  type Slot = 'workspaceFolderValue' | 'workspaceValue' | 'globalValue';
  const SLOTS: ReadonlyArray<readonly ['erdStudio' | 'dbtSemantic', Slot]> = [
    ['erdStudio', 'workspaceFolderValue'], ['erdStudio', 'workspaceValue'], ['erdStudio', 'globalValue'],
    ['dbtSemantic', 'workspaceFolderValue'], ['dbtSemantic', 'workspaceValue'], ['dbtSemantic', 'globalValue'],
  ];
  const SCOPE: Record<Slot, string> = { workspaceFolderValue: 'folder', workspaceValue: 'workspace', globalValue: 'user' };

  it('returns exactly the value getErdStudioSetting does, for every combination of the six scopes (an explicit "" included)', () => {
    // Each slot is unset, an explicit "", or its own value: 3^6 combinations.
    for (let n = 0; n < 3 ** SLOTS.length; n++) {
      vscode._resetMockConfiguration();
      const values: Record<string, Partial<Record<Slot, string>>> = { erdStudio: {}, dbtSemantic: {} };
      let rest = n;
      SLOTS.forEach(([section, slot], i) => {
        const pick = rest % 3;
        rest = Math.floor(rest / 3);
        if (pick === 1) values[section][slot] = '';
        if (pick === 2) values[section][slot] = `${section}-${slot}-${i}`;
      });
      vscode._setMockConfiguration('erdStudio', 'projectPath', values.erdStudio);
      vscode._setMockConfiguration('dbtSemantic', 'projectPath', values.dbtSemantic);

      const source = erdStudioSettingSource<string>('projectPath');
      expect(source?.value ?? '<default>', `combination ${n}`).toBe(getErdStudioSetting('projectPath', '<default>'));
      // And it says where that value is.
      if (source) {
        const [section] = source.settingKey.split('.');
        const slot = (Object.keys(SCOPE) as Slot[]).find((s) => SCOPE[s] === source.scope)!;
        expect(values[section][slot], `combination ${n}`).toBe(source.value);
      }
    }
  });

  it('names the deprecated dbtSemantic key when only it holds the value', () => {
    vscode._setMockConfiguration('dbtSemantic', 'projectPath', { globalValue: 'transform' });
    expect(erdStudioSettingSource('projectPath')).toEqual({
      value: 'transform', settingKey: 'dbtSemantic.projectPath', scope: 'user',
    });
  });

  it('reads only User settings for a user-scoped key, as getErdStudioSetting does', () => {
    vscode._setMockConfiguration('erdStudio', 'telemetry.enabled', { workspaceValue: false });
    expect(erdStudioSettingSource('telemetry.enabled')).toBeUndefined();
    vscode._setMockConfiguration('erdStudio', 'telemetry.enabled', { workspaceValue: false, globalValue: true });
    expect(erdStudioSettingSource('telemetry.enabled')).toEqual({
      value: true, settingKey: 'erdStudio.telemetry.enabled', scope: 'user',
    });
    expect(getErdStudioSetting('telemetry.enabled', false)).toBe(true);
  });

  it('is undefined when nothing is set', () => {
    expect(erdStudioSettingSource('projectPath')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (b) the words and the button, by scope, key, form and window
// ---------------------------------------------------------------------------

describe('projectPathInvalidMessage', () => {
  const KEYS = ['erdStudio.projectPath', 'dbtSemantic.projectPath'];
  const SCOPES = ['user', 'workspace', 'folder'] as const;

  it.each(KEYS.flatMap((settingKey) => SCOPES.flatMap((scope) =>
    [false, true].flatMap((absolute) => [undefined, 'my-folder'].map((opened) => ({ settingKey, scope, absolute, opened }))))))(
    '$settingKey in $scope scope, absolute $absolute, opened $opened',
    ({ settingKey, scope, absolute, opened }) => {
      const value = absolute ? '/Users/someone-else/transform' : 'transform';
      const w = projectPathInvalidMessage({ value, settingKey, scope, absolute, opened });
      expect(w.message).toMatch(/^ERD Studio: /);
      expect(w.message).toContain(`${settingKey} ("${value}")`);
      // Only a User-settings value is said to apply everywhere.
      expect(/every folder/.test(w.message)).toBe(scope === 'user');
      expect(/User settings/.test(w.message)).toBe(scope === 'user');
      // An absolute path is not "in" any folder.
      if (absolute) expect(w.message).not.toMatch(/isn't in/);
      // The opened folder is named only when there is one.
      expect(w.message.includes('so ERD Studio opened my-folder instead')).toBe(opened !== undefined);
      // The button opens the settings that hold the value, at that key.
      if (scope === 'user') {
        expect(w.button).toBe(OPEN_USER_SETTINGS_BUTTON);
        expect([w.command, ...w.args]).toEqual(['workbench.action.openSettings', settingKey]);
      } else {
        expect(w.button).toBe(OPEN_WORKSPACE_SETTINGS_BUTTON);
        expect([w.command, ...w.args]).toEqual(['workbench.action.openWorkspaceSettings', { query: settingKey }]);
      }
      // No dbt words: the warning shows in folders without dbt.
      expect(w.message).not.toMatch(/\bdbt\b|dbt_project/);
    },
  );

  it('says a relative User-settings value names a folder that is not in the opened one, and how to keep it to its project', () => {
    expect(projectPathInvalidMessage({
      value: 'transform', settingKey: 'erdStudio.projectPath', scope: 'user', absolute: false, opened: 'my-folder',
    }).message).toBe(
      'ERD Studio: your setting erdStudio.projectPath ("transform") names a folder that isn\'t in my-folder, ' +
        'so ERD Studio opened my-folder instead. It is in your User settings, so it applies to every folder you open. ' +
        "If it is meant for one project, move it to that project's Workspace settings.",
    );
  });

  it('when where it is set is unknown, says it plainly and opens the merged Settings view', () => {
    const w = projectPathInvalidMessage({
      value: 'transform', settingKey: 'erdStudio.projectPath', scope: undefined, absolute: false, opened: 'my-folder',
    });
    expect(w.message).toBe('ERD Studio: erdStudio.projectPath ("transform") is not a folder, so ERD Studio opened my-folder instead.');
    expect([w.button, w.command, ...w.args]).toEqual(['Open Settings', 'workbench.action.openSettings', 'erdStudio.projectPath']);
  });
});

describe('projectPathInvalidDetailCodes', () => {
  it('counts one scope (a folder counts as the workspace) and one form, never the path', () => {
    expect(projectPathInvalidDetailCodes('user', false)).toEqual(['projectPathInvalidUser', 'projectPathInvalidRelative']);
    expect(projectPathInvalidDetailCodes('workspace', true)).toEqual(['projectPathInvalidWorkspace', 'projectPathInvalidAbsolute']);
    expect(projectPathInvalidDetailCodes('folder', false)).toEqual(['projectPathInvalidWorkspace', 'projectPathInvalidRelative']);
    expect(projectPathInvalidDetailCodes(undefined, true)).toEqual(['projectPathInvalidAbsolute']);
  });
});

// ---------------------------------------------------------------------------
// (c)-(e) the real activate()
// ---------------------------------------------------------------------------

function makeContext(root: string, workspaceState: Map<string, unknown>): Context {
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
      keys: () => [...workspaceState.keys()],
    },
    secrets: vscode.createMockSecretStorage(),
  } as unknown as Context;
}

let root: string;
let ws: string;
let wsState: Map<string, unknown>;
let context: Context;
let warn: ReturnType<typeof vi.spyOn>;
let settingWrites: unknown[][];

/** The projectPath warning(s) shown in this test, as [message, ...buttons]. */
const projectPathWarnings = () =>
  warn.mock.calls.filter((c) => String(c[0]).includes('projectPath'));

async function disposeAll(ctx: Context): Promise<void> {
  for (const sub of [...ctx.subscriptions].reverse()) {
    try { await sub.dispose(); } catch { /* best effort */ }
  }
  ctx.subscriptions.length = 0;
}

/** A window start in the same folder (Developer: Reload Window): same workspaceState, fresh activation. */
async function reload(): Promise<void> {
  await disposeAll(context);
  vscode._resetRegisteredCommands();
  _resetFirstRunGuardForTests();
  context = makeContext(root, wsState);
  await activate(context);
}

/** Click the projectPath warning's first button, and return the settings commands that ran. */
function clickFirstButton(): { settingsCommands: () => unknown[][] } {
  warn.mockImplementation((async (m: string, ...items: string[]) =>
    m.includes('projectPath') ? items[0] : undefined) as never);
  const exec = vi.spyOn(vscode.commands, 'executeCommand');
  return {
    settingsCommands: () => exec.mock.calls.filter((c) => /^workbench\.action\.open.*Settings/.test(String(c[0]))),
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-370-'));
  ws = path.join(root, 'my-folder');
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, 'report.sql'), 'select 1 as one;\n');
  wsState = new Map<string, unknown>([
    ['erdStudio.harnessInstallPrompted', true],
    ['erdStudio.diagramsNudgeShown', true],
    ['erdStudio.startSuggestion', { shown: 1, answered: true }],
  ]);
  context = makeContext(root, wsState);
  vscode._resetRegisteredCommands();
  vscode._resetMockConfiguration();
  vscode._resetMockWorkspace();
  vscode._clearMockFileWatchers();
  vscode._resetMockGithubSession();
  vscode._resetMockLanguageModels();
  vscode._resetMockWebviewPanels();
  vscode._setMockExtensions([]);
  vscode.window.tabGroups.all = [];
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(ws), name: 'my-folder', index: 0 }];
  _resetFirstRunGuardForTests();
  vi.stubEnv('HOME', root);
  vi.stubEnv('USERPROFILE', root);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
  vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue(undefined);
  warn = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined);
  // Every write to a projectPath setting, from any scope: there must be none.
  settingWrites = [];
  const realGetConfiguration = vscode.workspace.getConfiguration;
  vi.spyOn(vscode.workspace, 'getConfiguration').mockImplementation(((section?: string) => {
    const config = realGetConfiguration(section);
    return {
      ...config,
      update: async (key: string, ...rest: unknown[]) => {
        if (key === 'projectPath') settingWrites.push([section, key, ...rest]);
        return (config.update as (...a: unknown[]) => Promise<void>)(key, ...rest);
      },
    };
  }) as never);
  vi.useFakeTimers();
});

afterEach(async () => {
  await disposeAll(context);
  for (const panel of [...vscode.window._webviewPanels]) panel.dispose();
  vscode._resetMockWebviewPanels();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('#370: a User-level relative projectPath in a folder it was not written for', () => {
  beforeEach(() => {
    vscode._setMockConfiguration('erdStudio', 'projectPath', { globalValue: 'transform' });
  });

  it('says the value is in User settings and so applies to every folder, with Open User Settings', async () => {
    await activate(context);
    expect(projectPathWarnings()).toEqual([[
      'ERD Studio: your setting erdStudio.projectPath ("transform") names a folder that isn\'t in my-folder, ' +
        'so ERD Studio opened my-folder instead. It is in your User settings, so it applies to every folder you open. ' +
        "If it is meant for one project, move it to that project's Workspace settings.",
      OPEN_USER_SETTINGS_BUTTON,
    ]]);
  });

  it('is shown once per workspace: reloads with the same value stay quiet, and telemetry still counts every start', async () => {
    const error = vi.spyOn(telemetry, 'error');
    await activate(context);
    await reload();
    await reload();
    expect(projectPathWarnings()).toHaveLength(1);
    // The measurement does not change with the gate: counted on every start, with its scope and form.
    const codes = error.mock.calls.map((c) => c[0]);
    expect(codes.filter((c) => c === 'projectPathInvalid')).toHaveLength(3);
    expect(codes.filter((c) => c === 'projectPathInvalidUser')).toHaveLength(3);
    expect(codes.filter((c) => c === 'projectPathInvalidRelative')).toHaveLength(3);
    expect(codes).not.toContain('projectPathInvalidWorkspace');
    expect(codes).not.toContain('projectPathInvalidAbsolute');
    expect(settingWrites).toEqual([]);
  });

  it('comes back when the value changes', async () => {
    await activate(context);
    await reload();
    expect(projectPathWarnings()).toHaveLength(1);
    vscode._setMockConfiguration('erdStudio', 'projectPath', { globalValue: 'models' });
    await reload();
    expect(projectPathWarnings()).toHaveLength(2);
    expect(projectPathWarnings()[1][0]).toContain('("models")');
  });

  it('comes back when the value moves to the workspace settings, and then warns on every start', async () => {
    await activate(context);
    vscode._setMockConfiguration('erdStudio', 'projectPath', { workspaceValue: 'transform' });
    await reload();
    await reload();
    expect(projectPathWarnings().map((c) => c[1])).toEqual([
      OPEN_USER_SETTINGS_BUTTON, OPEN_WORKSPACE_SETTINGS_BUTTON, OPEN_WORKSPACE_SETTINGS_BUTTON,
    ]);
  });

  it('Open User Settings opens the User tab at the setting, and writes nothing', async () => {
    const { settingsCommands } = clickFirstButton();
    await activate(context);
    await vi.waitFor(() => expect(settingsCommands()).toHaveLength(1));
    expect(settingsCommands()).toEqual([['workbench.action.openSettings', 'erdStudio.projectPath']]);
    expect(settingWrites).toEqual([]);
  });
});

describe('#370: a value from the deprecated dbtSemantic.projectPath', () => {
  beforeEach(() => {
    vscode._setMockConfiguration('dbtSemantic', 'projectPath', { globalValue: 'transform' });
  });

  it('the message names the key that actually holds the value', async () => {
    await activate(context);
    const [message] = projectPathWarnings()[0] ?? [''];
    expect(message).toContain('dbtSemantic.projectPath ("transform")');
    expect(message).not.toContain('erdStudio.projectPath');
  });

  it('the button opens the setting that holds the value, not an empty erdStudio.projectPath', async () => {
    const { settingsCommands } = clickFirstButton();
    await activate(context);
    await vi.waitFor(() => expect(settingsCommands()).toHaveLength(1));
    expect(settingsCommands()).toEqual([['workbench.action.openSettings', 'dbtSemantic.projectPath']]);
  });
});

describe('#370 boundary: a bad path in the workspace settings is still reported on every start', () => {
  it('a Workspace-scoped value gets the workspace wording and Open Workspace Settings, every time', async () => {
    vscode._setMockConfiguration('erdStudio', 'projectPath', { workspaceValue: 'nope' });
    await activate(context);
    await reload();
    const expected = [
      'ERD Studio: erdStudio.projectPath ("nope") in this workspace\'s settings is not a folder, so ERD Studio opened my-folder instead. ' +
        'Correct the path, or clear it to let ERD Studio find the project.',
      OPEN_WORKSPACE_SETTINGS_BUTTON,
    ];
    expect(projectPathWarnings()).toEqual([expected, expected]);
    expect(wsState.has('erdStudio.projectPathInvalidShown')).toBe(false);
  });

  it('Open Workspace Settings opens the workspace tab searched for the key', async () => {
    vscode._setMockConfiguration('erdStudio', 'projectPath', { workspaceValue: 'nope' });
    const { settingsCommands } = clickFirstButton();
    await activate(context);
    await vi.waitFor(() => expect(settingsCommands()).toHaveLength(1));
    expect(settingsCommands()).toEqual([['workbench.action.openWorkspaceSettings', { query: 'erdStudio.projectPath' }]]);
  });

  it('an absolute path in User settings warns on every start: it names no folder on this computer', async () => {
    vscode._setMockConfiguration('erdStudio', 'projectPath', { globalValue: '/Users/someone-else/transform' });
    await activate(context);
    await reload();
    expect(projectPathWarnings()).toHaveLength(2);
    expect(projectPathWarnings()[0][0]).toContain('("/Users/someone-else/transform") isn\'t a folder on this computer');
    expect(projectPathWarnings()[0][0]).not.toMatch(/isn't in/);
  });
});

describe('#370: an empty window', () => {
  beforeEach(() => {
    vscode.workspace.workspaceFolders = [];
  });

  it('says nothing about a relative User projectPath: no relative path can resolve with no folder open', async () => {
    const error = vi.spyOn(telemetry, 'error');
    vscode._setMockConfiguration('erdStudio', 'projectPath', { globalValue: 'transform' });
    await activate(context);
    expect(projectPathWarnings()).toEqual([]);
    // Still counted: the setting did not resolve.
    expect(error.mock.calls.map((c) => c[0])).toContain('projectPathInvalid');
  });

  it('still reports an absolute path, without naming a folder it opened', async () => {
    vscode._setMockConfiguration('erdStudio', 'projectPath', { globalValue: '/nowhere/analytics' });
    await activate(context);
    expect(projectPathWarnings()).toEqual([[
      'ERD Studio: your setting erdStudio.projectPath ("/nowhere/analytics") isn\'t a folder on this computer. ' +
        'It is in your User settings, so it applies to every folder you open. ' +
        "If it is meant for one project, move it to that project's Workspace settings.",
      OPEN_USER_SETTINGS_BUTTON,
    ]]);
  });
});
