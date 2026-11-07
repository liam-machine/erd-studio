/**
 * knownFixesService — the VS Code wiring: the telemetry facade's error path
 * reaches the checker whether or not telemetry is on, the user-scoped setting
 * turns it off, the buttons run the right commands, and the installed-version
 * scan reads the extensions folder.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  EXTENSION_ID,
  installedVersions,
  setKnownFixesEndpointForTests,
  startKnownFixes,
} from '../../src/services/knownFixesService';
import { telemetry } from '../../src/services/telemetryService';

const mock = vscode as unknown as {
  _setMockConfiguration: (section: string, key: string, values: { globalValue?: unknown; workspaceValue?: unknown }) => void;
  _resetMockConfiguration: () => void;
  _setMockTelemetryEnabled: (enabled: boolean) => void;
  createMockExtensionContext: (options: { storageRoot: string; extensionRoot: string; packageJSON?: unknown }) => vscode.ExtensionContext;
};

const REGISTRY = [{ code: 'domainLoadJson', fixedIn: '1.7.0', summary: 'Diagrams with a merge conflict now explain the conflict.' }];

let fetchMock: ReturnType<typeof vi.fn>;
let contexts: vscode.ExtensionContext[] = [];
let disposables: vscode.Disposable[] = [];

function start(version = '1.6.9', extensionRoot = path.join(os.tmpdir(), 'erd-known-fixes-none', 'ext')): vscode.ExtensionContext {
  const context = mock.createMockExtensionContext({
    storageRoot: path.join(os.tmpdir(), 'erd-known-fixes-test'),
    extensionRoot,
    packageJSON: { version },
  });
  contexts.push(context);
  startKnownFixes(context);
  return context;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise(resolve => setTimeout(resolve, 0));
}

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify(REGISTRY), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  mock._resetMockConfiguration();
  setKnownFixesEndpointForTests('https://telemetry.example/known-fixes');
});

afterEach(() => {
  for (const c of contexts) for (const s of c.subscriptions) s.dispose();
  contexts = [];
  for (const d of disposables) d.dispose();
  disposables = [];
  setKnownFixesEndpointForTests(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  mock._setMockTelemetryEnabled(true);
});

describe('startKnownFixes', () => {
  it('prompts from telemetry.error() even with telemetry off, and sends nothing in the request', async () => {
    mock._setMockTelemetryEnabled(false);
    const shown = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
    start();
    telemetry.error('domainLoadJson');
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://telemetry.example/known-fixes');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.headers).toBeUndefined();
    expect(shown).toHaveBeenCalledWith(
      "ERD Studio 1.7.0 fixes this: Diagrams with a merge conflict now explain the conflict. You're on 1.6.9.",
      'Update',
      'Not now',
    );
  });

  it('ignores codes the registry does not name', async () => {
    const shown = vi.spyOn(vscode.window, 'showInformationMessage');
    start();
    telemetry.error('saveFailed');
    await settle();
    expect(shown).not.toHaveBeenCalled();
  });

  it('never fetches the registry for the loggedError catch-all codes', async () => {
    start();
    telemetry.error('loggedError');
    telemetry.error('loggedErrorOther');
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is off when the user turns erdStudio.checkKnownFixes off — and a workspace cannot turn it back on', async () => {
    mock._setMockConfiguration('erdStudio', 'checkKnownFixes', { globalValue: false, workspaceValue: true });
    const shown = vi.spyOn(vscode.window, 'showInformationMessage');
    start();
    telemetry.error('domainLoadJson');
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(shown).not.toHaveBeenCalled();
  });

  it('a workspace value cannot turn it off either', async () => {
    mock._setMockConfiguration('erdStudio', 'checkKnownFixes', { workspaceValue: false });
    start();
    telemetry.error('domainLoadJson');
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['Update', 'knownFixUpdate'],
    [undefined, 'knownFixDismissed'],
  ] as const)('records the prompt and its answer (%s) as features (B18)', async (picked, answer) => {
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(picked as never);
    vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
    const feature = vi.spyOn(telemetry, 'feature');
    start();
    telemetry.error('domainLoadJson');
    await settle();
    expect(feature.mock.calls.map((c) => c[0])).toEqual(['knownFixOffered', answer]);
  });

  it('Update opens ERD Studio in the Extensions view', async () => {
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue('Update' as never);
    const run = vi.spyOn(vscode.commands, 'executeCommand');
    start();
    telemetry.error('domainLoadJson');
    await settle();
    expect(run).toHaveBeenCalledWith('workbench.extensions.action.showExtensionsWithIds', [EXTENSION_ID]);
  });

  it('falls back to the extension page when the Extensions view command fails', async () => {
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue('Update' as never);
    const run = vi.spyOn(vscode.commands, 'executeCommand').mockImplementation(async (command: string) => {
      if (command === 'workbench.extensions.action.showExtensionsWithIds') throw new Error('not found');
      return undefined;
    });
    start();
    telemetry.error('domainLoadJson');
    await settle();
    expect(run).toHaveBeenCalledWith('extension.open', EXTENSION_ID);
  });

  it('offers Reload Window when the fixed version is already installed', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-ext-'));
    fs.mkdirSync(path.join(root, `${EXTENSION_ID}-1.6.9`));
    fs.mkdirSync(path.join(root, `${EXTENSION_ID}-1.7.0`));
    const shown = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue('Reload Window' as never);
    const run = vi.spyOn(vscode.commands, 'executeCommand');
    const feature = vi.spyOn(telemetry, 'feature');
    start('1.6.9', path.join(root, `${EXTENSION_ID}-1.6.9`));
    telemetry.error('domainLoadJson');
    await settle();
    expect(shown).toHaveBeenCalledWith(expect.any(String), 'Reload Window', 'Not now');
    expect(run).toHaveBeenCalledWith('workbench.action.reloadWindow');
    expect(feature.mock.calls.map((c) => c[0])).toEqual(['knownFixOffered', 'knownFixReload']);
  });

  it('stops listening once the extension is disposed', async () => {
    start();
    for (const s of contexts[0].subscriptions) s.dispose();
    telemetry.error('domainLoadJson');
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('installedVersions', () => {
  it('lists sibling versions, platform builds included, minus obsolete ones', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-ext-'));
    for (const name of [
      `${EXTENSION_ID}-1.6.9`,
      `${EXTENSION_ID}-1.7.0-darwin-arm64`,
      `${EXTENSION_ID}-1.8.0`,
      'liamwynne.erd-studio-pro-9.9.9',
      'someone.else-2.0.0',
    ]) fs.mkdirSync(path.join(root, name));
    fs.writeFileSync(path.join(root, '.obsolete'), JSON.stringify({ [`${EXTENSION_ID}-1.8.0`]: true }));
    expect(installedVersions(path.join(root, `${EXTENSION_ID}-1.6.9`)).sort()).toEqual(['1.6.9', '1.7.0']);
  });

  it('is empty without a path', () => {
    expect(installedVersions(undefined)).toEqual([]);
  });
});
