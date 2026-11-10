/**
 * The Welcome panel's ready watch (2.0 B13): `welcomePanelReady` when the
 * page says ready, `webviewNoReadyWelcome` when a visible panel never does
 * within 30 s, nothing for a panel closed first.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { GettingStartedPanel, type GettingStartedDeps } from '../../src/providers/GettingStartedPanel';
import type { GettingStartedStatus } from '../../src/types/gettingStarted';
import { telemetry } from '../../src/services/telemetryService';
import { READY_TIMEOUT_MS } from '../../src/services/readyWatch';

const REPO_ROOT = path.resolve(__dirname, '../..');

const STATUS: GettingStartedStatus = {
  hasProject: true,
  harness: { claude: { schemaSkill: 'current', setupSkill: 'missing' }, agents: { schemaSkill: 'missing', setupSkill: 'missing' } },
  cli: 'missing',
  helper: 'missing',
  claude: 'missing',
  assistants: [],
  domainCount: 0,
  project: { name: 'jaffle_shop', relativePath: null },
};

let tmp: string;
const deps = (): GettingStartedDeps => ({
  workspaceRoot: '/w',
  semanticDir: '.erd-studio',
  runSetup: vi.fn(async () => ({ ok: true, filesWritten: [], message: 'ok' })),
  getStatus: vi.fn(async () => STATUS),
  clipboardText: () => 'x',
});
const context = () => vscode.createMockExtensionContext({ storageRoot: tmp, extensionRoot: REPO_ROOT }) as unknown as import('vscode').ExtensionContext;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-gs-ready-'));
  vscode._resetMockWebviewPanels();
});

afterEach(() => {
  for (const panel of [...vscode.window._webviewPanels]) panel.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the Welcome panel ready watch', () => {
  it('counts the page saying ready', async () => {
    const feature = vi.spyOn(telemetry, 'feature');
    GettingStartedPanel.createOrShow(context(), deps());
    await vscode.window._webviewPanels[0]._simulateMessage({ type: 'ready' });
    expect(feature).toHaveBeenCalledWith('welcomePanelReady');
    expect(feature).not.toHaveBeenCalledWith('readySlowOver10s');
  });

  it('reports a visible panel that never says ready, and not one closed first', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const error = vi.spyOn(telemetry, 'error');
    GettingStartedPanel.createOrShow(context(), deps());
    vi.advanceTimersByTime(READY_TIMEOUT_MS);
    expect(error).toHaveBeenCalledWith('webviewNoReadyWelcome');

    error.mockClear();
    vscode.window._webviewPanels[0].dispose();
    GettingStartedPanel.createOrShow(context(), deps());
    vscode.window._webviewPanels[1].dispose();
    vi.advanceTimersByTime(READY_TIMEOUT_MS * 2);
    expect(error).not.toHaveBeenCalledWith('webviewNoReadyWelcome');
  });
});
