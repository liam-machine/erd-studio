/**
 * A page that says `ready` after the 30 s no-ready timeout was slow, not
 * broken (#320). The rule, for a canvas, the draft preview and the Welcome
 * panel:
 *
 *  - the late ready is told apart (`ReadyWatch`'s `lateReady`) and counted as
 *    `readyAfterNoReady` with how late beside it, timed from the timeout;
 *  - the ready of a page the user reloaded from the notification is the new
 *    page's, never a late one;
 *  - the notification that is still up cannot hurt the page that opened:
 *    Reload does nothing, Send Feedback is an ordinary report.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { _resetMockWebviewPanels } from 'vscode';

import { SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import { DraftPreviewPanel } from '../../src/providers/DraftPreviewPanel';
import { GettingStartedPanel, type GettingStartedDeps } from '../../src/providers/GettingStartedPanel';
import { NO_READY_RELOAD_BUTTON } from '../../src/providers/noReadyRecovery';
import { lateReadyFeatures, READY_LATE_LONG_MS, READY_SLOW_MS, READY_TIMEOUT_MS, ReadyWatch } from '../../src/services/readyWatch';
import { draftPreviewEvents } from '../../src/providers/draftWiring';
import { FEATURES } from '../../src/services/telemetryPayload';
import { SubjectAreaService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { TableLibraryService } from '../../src/services/logicalModelService';
import { ManifestService } from '../../src/services/manifestService';
import { YmlParserService } from '../../src/services/ymlParserService';
import { TemplateService } from '../../src/services/templateService';
import { SelectorsService } from '../../src/services/selectorsService';
import { SUBJECT_AREA_EDITOR_VIEW_TYPE } from '../../src/services/recoveryService';
import { telemetry } from '../../src/services/telemetryService';
import type { Draft, DraftView } from '../../src/types/draft';
import { dbtFixtureRoot, diagramPath } from './helpers/dbtFixtures';

const REPO_ROOT = path.resolve(__dirname, '../..');
type MockPanel = ReturnType<typeof vscode.createMockWebviewPanel>;
type Posted = { type: string; payload?: any };

let root: string;
let extensionRoot: string;
let feature: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
let executeCommand: ReturnType<typeof vi.spyOn>;
const featureKeys = () => feature.mock.calls.map(([k]) => k as string);
const errorKeys = () => error.mock.calls.map(([k]) => k as string);

/** A notification that stays up until the test presses a button. */
function pendingNotification() {
  let press!: (button: string | undefined) => void;
  const shown = new Promise<string | undefined>((resolve) => { press = resolve; });
  const warn = vi.spyOn(vscode.window, 'showWarningMessage').mockReturnValue(shown as never);
  return { warn, press: async (button: string | undefined) => { press(button); await vi.advanceTimersByTimeAsync(0); } };
}

function buildProvider() {
  const layerService = new LayerService(root, '.erd-studio');
  const subjectAreaService = new SubjectAreaService(layerService);
  const tableLibraryService = new TableLibraryService(root, '.erd-studio');
  subjectAreaService.setTableLibraryService(tableLibraryService);
  const context = {
    extensionUri: vscode.Uri.file(extensionRoot),
    globalStorageUri: vscode.Uri.file(path.join(root, '.global-storage')),
    extension: { packageJSON: { version: '0.0.0-test' } },
    globalState: { get: () => true, update: async () => {} },
    workspaceState: vscode.createMockMemento(),
    secrets: vscode.createMockSecretStorage(),
    subscriptions: [],
  } as unknown as import('vscode').ExtensionContext;
  return new SemanticEditorProvider(
    context, subjectAreaService, new ManifestService(), new YmlParserService(), new TemplateService(),
    layerService, root, new SelectorsService(subjectAreaService, root, '.erd-studio'), tableLibraryService,
  );
}

async function openCanvasNotReady() {
  const file = diagramPath(root, 'yaml', 'silver', 'showcase');
  const doc = {
    uri: vscode.Uri.file(file), isDirty: false, isClosed: false,
    getText: () => fs.readFileSync(file, 'utf-8'), positionAt: (offset: number) => ({ offset }), save: vi.fn(async () => true),
  };
  const provider = buildProvider();
  const panel = vscode.createMockWebviewPanel();
  await provider.resolveCustomTextEditor(
    doc as unknown as import('vscode').TextDocument,
    panel as unknown as import('vscode').WebviewPanel,
    {} as import('vscode').CancellationToken,
  );
  vscode.window.tabGroups.activeTabGroup.activeTab = { input: new vscode.TabInputCustom(doc.uri, SUBJECT_AREA_EDITOR_VIEW_TYPE) };
  return { provider, panel };
}

beforeEach(() => {
  vscode._resetMockWorkspace();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  feature = vi.spyOn(telemetry, 'feature');
  error = vi.spyOn(telemetry, 'error');
  executeCommand = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-320-'));
  fs.cpSync(dbtFixtureRoot('dbt-project'), root, { recursive: true });
  extensionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-320-ext-'));
  fs.mkdirSync(path.join(extensionRoot, 'dist'));
  fs.writeFileSync(path.join(extensionRoot, 'dist', 'webview.js'), '');
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vscode.window.tabGroups.activeTabGroup.activeTab = undefined;
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(extensionRoot, { recursive: true, force: true });
});


/** A watch on a visible panel, with a clock the test steps. */
function watched() {
  let now = 0;
  const hooks = { ready: vi.fn(), noReady: vi.fn(), lateReady: vi.fn() };
  const watch = new ReadyWatch(true, hooks, () => now);
  const step = (ms: number) => { now += ms; vi.advanceTimersByTime(ms); };
  return { watch, step, ...hooks };
}

function showDraft(events: Parameters<typeof DraftPreviewPanel.show>[2]) {
  DraftPreviewPanel.close();
  _resetMockWebviewPanels();
  const draft = {
    ...(JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'test/fixtures/draft/large.json'), 'utf8')) as DraftView),
    keep: { writer: 'none' }, trigger: 'start',
  } as Draft;
  void DraftPreviewPanel.show(vscode.Uri.file('/ext'), draft, events);
  const all = (vscode.window as unknown as { _webviewPanels: MockPanel[] })._webviewPanels;
  return all[all.length - 1];
}

/** The Welcome panel, open and not yet ready. */
async function withWelcome(run: (panel: MockPanel) => Promise<void>) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-320-gs-'));
  try {
    vscode._resetMockWebviewPanels();
    const deps: GettingStartedDeps = {
      workspaceRoot: '/w', semanticDir: '.erd-studio',
      runSetup: vi.fn(async () => ({ ok: true, filesWritten: [], message: 'ok' })),
      getStatus: vi.fn(async () => ({
        hasProject: true,
        harness: { claude: { schemaSkill: 'current', setupSkill: 'missing' }, agents: { schemaSkill: 'missing', setupSkill: 'missing' } },
        cli: 'missing', helper: 'missing', claude: 'missing', assistants: [], domainCount: 0,
        project: { name: 'jaffle_shop', relativePath: null },
      })) as never,
      clipboardText: () => 'x',
    };
    GettingStartedPanel.createOrShow(
      vscode.createMockExtensionContext({ storageRoot: tmp, extensionRoot: REPO_ROOT }) as unknown as import('vscode').ExtensionContext, deps);
    await run(vscode.window._webviewPanels[0] as MockPanel);
    for (const p of [...vscode.window._webviewPanels]) p.dispose();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe('#320 ReadyWatch: a ready after the timeout is told apart', () => {
  it('reports lateReady once, after ready, with the range since the panel was shown', () => {
    const w = watched();
    w.step(READY_TIMEOUT_MS + 5_000);
    expect(w.noReady).toHaveBeenCalledTimes(1);
    w.watch.ready();
    w.watch.ready();
    expect(w.ready).toHaveBeenCalledTimes(1);
    expect(w.ready).toHaveBeenCalledWith(true);
    expect(w.lateReady.mock.calls).toEqual([['30to60s']]);
  });

  it('a ready inside the 30 s, however slow, is not late', () => {
    const w = watched();
    w.step(READY_TIMEOUT_MS - 1);
    w.watch.ready();
    expect(w.ready).toHaveBeenCalledWith(true);
    expect(w.lateReady).not.toHaveBeenCalled();
    w.step(READY_TIMEOUT_MS);
    expect(w.noReady).not.toHaveBeenCalled();
  });

  it('the range turns at 60 s after the panel was shown', () => {
    const under = watched();
    under.step(READY_TIMEOUT_MS);
    under.step(READY_LATE_LONG_MS - READY_TIMEOUT_MS - 1);
    under.watch.ready();
    expect(under.lateReady.mock.calls).toEqual([['30to60s']]);
    const at = watched();
    at.step(READY_TIMEOUT_MS);
    at.step(READY_LATE_LONG_MS - READY_TIMEOUT_MS);
    at.watch.ready();
    expect(at.lateReady.mock.calls).toEqual([['over60s']]);
  });

  it('times the range from the timeout by the clock, not from the last time the panel was shown', () => {
    // Hidden after the timeout, shown a minute later, ready 2 s after that: "not slow" by
    // visibleSince, and still a late ready, more than a minute after the panel was shown.
    const w = watched();
    w.step(READY_TIMEOUT_MS);
    w.watch.visibility(false);
    w.step(60_000);
    w.watch.visibility(true);
    w.step(2_000);
    w.watch.ready();
    expect(w.ready).toHaveBeenCalledWith(false);
    expect(w.lateReady.mock.calls).toEqual([['over60s']]);
    expect(w.noReady).toHaveBeenCalledTimes(1);
  });

  it('times the range from the show, not from when a busy host got round to the timer', () => {
    // The host was stuck for 70 s: the 30 s timer runs late, and the queued ready right after it.
    let now = 0;
    const lateReady = vi.fn();
    const watch = new ReadyWatch(true, { noReady: vi.fn(), lateReady }, () => now);
    now = 70_000;
    vi.advanceTimersByTime(READY_TIMEOUT_MS);
    watch.ready();
    expect(lateReady.mock.calls).toEqual([['over60s']]);
  });

  it('a late ready that arrives while the panel is hidden still counts', () => {
    const w = watched();
    w.step(READY_TIMEOUT_MS);
    w.watch.visibility(false);
    w.watch.ready();
    expect(w.lateReady.mock.calls).toEqual([['30to60s']]);
  });

  it('the ready of a page reloaded after the timeout is not a late ready', () => {
    const w = watched();
    w.step(READY_TIMEOUT_MS);
    w.watch.reloaded();
    w.step(2_000);
    w.watch.ready();
    expect(w.ready).toHaveBeenCalledTimes(1);
    expect(w.lateReady).not.toHaveBeenCalled();
  });

  it('reloaded() before the timeout changes nothing', () => {
    const early = watched();
    early.watch.reloaded();
    early.step(READY_TIMEOUT_MS + 1_000);
    early.watch.ready();
    expect(early.lateReady.mock.calls).toEqual([['30to60s']]);
  });

  it('a lateReady hook that throws is swallowed, and a watch without one is fine', () => {
    let now = 0;
    const watch = new ReadyWatch(true, { noReady: vi.fn(), lateReady: () => { throw new Error('x'); } }, () => now);
    now += READY_TIMEOUT_MS; vi.advanceTimersByTime(READY_TIMEOUT_MS);
    expect(() => watch.ready()).not.toThrow();
    const bare = new ReadyWatch(true, { noReady: vi.fn() }, () => now);
    vi.advanceTimersByTime(READY_TIMEOUT_MS);
    expect(() => bare.ready()).not.toThrow();
  });

  it('each range has its own key beside the total, and all three are known feature keys', () => {
    expect(lateReadyFeatures('30to60s')).toEqual(['readyAfterNoReady', 'readyLate30to60s']);
    expect(lateReadyFeatures('over60s')).toEqual(['readyAfterNoReady', 'readyLateOver60s']);
    for (const key of ['readyAfterNoReady', 'readyLate30to60s', 'readyLateOver60s']) expect(FEATURES).toContain(key);
  });
});

describe('#320 every panel counts its late ready', () => {
  it('canvas: readyAfterNoReady and its range beside readySlowOver10s', async () => {
    pendingNotification();
    const { panel } = await openCanvasNotReady();
    await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS + 5_000);
    expect(errorKeys()).toContain('webviewNoReadyCanvas');
    feature.mockClear();
    await panel._simulateMessage({ type: 'ready' });
    expect(featureKeys().filter((k) => k.startsWith('ready'))).toEqual(['readySlowOver10s', 'readyAfterNoReady', 'readyLate30to60s']);
  });

  it('canvas: a ready in time counts neither', async () => {
    pendingNotification();
    const { panel } = await openCanvasNotReady();
    await vi.advanceTimersByTimeAsync(READY_SLOW_MS + 1_000);
    await panel._simulateMessage({ type: 'ready' });
    expect(featureKeys().filter((k) => k.startsWith('ready'))).toEqual(['readySlowOver10s']);
  });

  it('canvas: the ready of a page reloaded from the notification is not counted as late', async () => {
    const note = pendingNotification();
    const { panel } = await openCanvasNotReady();
    await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS);
    const blank = panel.webview.html;
    await note.press(NO_READY_RELOAD_BUTTON);
    // A page that really never opened still reloads, and the button is still counted.
    expect(panel.webview.html).not.toBe(blank);
    expect(featureKeys()).toContain('crashFallbackReload');
    feature.mockClear();
    await vi.advanceTimersByTimeAsync(2_000);
    await panel._simulateMessage({ type: 'ready' });
    expect(featureKeys()).not.toContain('readyAfterNoReady');
    expect(featureKeys().some((k) => k.startsWith('readyLate'))).toBe(false);
  });

  it('draft: the preview reports lateReady, and the wiring counts it', async () => {
    pendingNotification();
    const lateReady = vi.fn();
    const panel = showDraft({ noReady: vi.fn(), lateReady });
    try {
      await vi.advanceTimersByTimeAsync(READY_LATE_LONG_MS + 1_000);
      await panel._simulateMessage({ type: 'ready' });
      expect(lateReady.mock.calls.map(([, range]) => range)).toEqual(['over60s']);
    } finally {
      DraftPreviewPanel.close();
    }
    const counted: string[] = [];
    draftPreviewEvents((key) => counted.push(key), vi.fn()).lateReady?.('dbml', 'over60s');
    expect(counted).toEqual(['readyAfterNoReady', 'readyLateOver60s']);
  });

  it('Welcome: readyAfterNoReady after webviewNoReadyWelcome', async () => {
    await withWelcome(async (panel) => {
      await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS + 1_000);
      expect(errorKeys()).toContain('webviewNoReadyWelcome');
      await panel._simulateMessage({ type: 'ready' });
      expect(featureKeys()).toEqual(expect.arrayContaining(['welcomePanelReady', 'readySlowOver10s', 'readyAfterNoReady', 'readyLate30to60s']));
    });
  });
});

describe('#320 the notification that is still up cannot hurt a page that has opened', () => {
  it('canvas: Reload leaves the canvas alone and counts nothing', async () => {
    const note = pendingNotification();
    const { panel } = await openCanvasNotReady();
    await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS);
    expect(note.warn).toHaveBeenCalledTimes(1);

    // The page was slow, not broken: it says ready and gets its diagram.
    await panel._simulateMessage({ type: 'ready' });
    expect((panel._postedMessages as Posted[]).some((m) => m.type === 'domainLoaded')).toBe(true);
    const working = panel.webview.html;

    // The notification is still up (VS Code cannot take it down). The user presses Reload.
    await note.press(NO_READY_RELOAD_BUTTON);
    expect(panel.webview.html).toBe(working);
    expect(featureKeys()).not.toContain('crashFallbackReload');
  });

  it('canvas: Send Feedback opens an ordinary report, and the canvas is not marked crashed', async () => {
    const note = pendingNotification();
    const { provider, panel } = await openCanvasNotReady();
    await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS);
    await panel._simulateMessage({ type: 'ready' });

    await note.press('Send Feedback');
    // The canvas is up, so Send Feedback still opens its own dialog...
    expect(provider.requestFeedbackDialog()).toBe(true);
    // ...through the plain command: no "the canvas did not open" prefill, no crash-screen count.
    expect(executeCommand.mock.calls.filter(([c]) => c === 'erdStudio.reportBug')).toEqual([['erdStudio.reportBug']]);
    expect(featureKeys()).not.toContain('crashFallbackFeedback');
  });

  it('canvas: a page that opened and then crashed keeps the notification\'s Reload', async () => {
    const note = pendingNotification();
    const { panel } = await openCanvasNotReady();
    await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS);
    await panel._simulateMessage({ type: 'ready' });
    await panel._simulateMessage({ type: 'webviewError', payload: { kind: 'render', area: 'canvas' } });
    const crashed = panel.webview.html;
    await note.press(NO_READY_RELOAD_BUTTON);
    expect(panel.webview.html).not.toBe(crashed);
    expect(featureKeys()).toContain('crashFallbackReload');
  });

  it('canvas: a page that never opened keeps both buttons as they were', async () => {
    const note = pendingNotification();
    const { provider } = await openCanvasNotReady();
    await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS);
    await note.press('Send Feedback');
    expect(featureKeys()).toContain('crashFallbackFeedback');
    expect(provider.requestFeedbackDialog()).toBe(false);
    const calls = executeCommand.mock.calls.filter(([c]) => c === 'erdStudio.reportBug');
    expect(calls).toHaveLength(1);
    expect((calls[0][1] as { title: string }).title).toBe('The canvas did not open');
  });

  it('draft: Reload leaves the preview alone and is not reported', async () => {
    const note = pendingNotification();
    const noReadyChoice = vi.fn();
    const panel = showDraft({ noReady: vi.fn(), noReadyChoice });
    try {
      await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS);
      expect(note.warn).toHaveBeenCalledTimes(1);
      await panel._simulateMessage({ type: 'ready' });
      const drafts = () => (panel._postedMessages as Posted[]).filter((m) => m.type === 'draft').length;
      expect(drafts()).toBe(1);
      const working = panel.webview.html;

      await note.press(NO_READY_RELOAD_BUTTON);
      expect(panel.webview.html).toBe(working);
      expect(drafts()).toBe(1);
      expect(noReadyChoice).not.toHaveBeenCalled();
    } finally {
      DraftPreviewPanel.close();
    }
  });

  it('draft: Send Feedback is passed on as "the page has opened", which the wiring neither counts nor prefills', async () => {
    const note = pendingNotification();
    const noReadyChoice = vi.fn();
    const panel = showDraft({ noReady: vi.fn(), noReadyChoice });
    try {
      await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS);
      await panel._simulateMessage({ type: 'ready' });
      await note.press('Send Feedback');
      expect(noReadyChoice.mock.calls.map(([, action, opened]) => [action, opened])).toEqual([['feedback', true]]);
    } finally {
      DraftPreviewPanel.close();
    }
    const counted: string[] = [];
    const openFeedback = vi.fn();
    const events = draftPreviewEvents((key) => counted.push(key), vi.fn(), undefined, undefined, openFeedback);
    events.noReadyChoice?.('dbml', 'feedback', true);
    await vi.advanceTimersByTimeAsync(0);
    expect(counted).toEqual([]);
    expect(openFeedback.mock.calls).toEqual([[]]);
    // A page that never opened: counted and prefilled, as before.
    events.noReadyChoice?.('dbml', 'feedback', false);
    await vi.advanceTimersByTimeAsync(0);
    expect(counted).toEqual(['crashFallbackFeedback']);
    expect((openFeedback.mock.calls[1][0] as { title: string }).title).toBe('The draft preview did not open');
  });

  it('draft: a page that never opened still reloads from the notification, and its ready is not a late one', async () => {
    const note = pendingNotification();
    const noReadyChoice = vi.fn();
    const lateReady = vi.fn();
    const panel = showDraft({ noReady: vi.fn(), noReadyChoice, lateReady });
    try {
      await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS);
      const blank = panel.webview.html;
      await note.press(NO_READY_RELOAD_BUTTON);
      expect(panel.webview.html).not.toBe(blank);
      expect(noReadyChoice.mock.calls.map(([, action, opened]) => [action, opened])).toEqual([['reload', undefined]]);
      await panel._simulateMessage({ type: 'ready' });
      expect(lateReady).not.toHaveBeenCalled();
    } finally {
      DraftPreviewPanel.close();
    }
  });
});

describe('#320 a page replaced before it ever said ready is not a late one', () => {
  it('canvas: the crash screen\'s Reload after the timeout, then ready', async () => {
    pendingNotification();
    const { panel } = await openCanvasNotReady();
    await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS);
    // The page crashed on its first render: no ready, and its crash screen's Reload is pressed.
    await panel._simulateMessage({ type: 'crashFallback', payload: { action: 'reload' } });
    feature.mockClear();
    await panel._simulateMessage({ type: 'ready' });
    expect(featureKeys()).not.toContain('readyAfterNoReady');
  });

  it('draft: the crash screen\'s Reload after the timeout, then ready', async () => {
    pendingNotification();
    const lateReady = vi.fn();
    const panel = showDraft({ noReady: vi.fn(), lateReady });
    try {
      await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS);
      await panel._simulateMessage({ type: 'crashFallback', action: 'reload' });
      await panel._simulateMessage({ type: 'ready' });
      expect(lateReady).not.toHaveBeenCalled();
    } finally {
      DraftPreviewPanel.close();
    }
  });

  it('draft: a page that opened late and then crashed keeps the notification\'s Reload', async () => {
    const note = pendingNotification();
    const noReadyChoice = vi.fn();
    const panel = showDraft({ noReady: vi.fn(), noReadyChoice });
    try {
      await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS);
      await panel._simulateMessage({ type: 'ready' });
      await panel._simulateMessage({ type: 'pageError', kind: 'render', area: 'draft' });
      const crashed = panel.webview.html;
      await note.press(NO_READY_RELOAD_BUTTON);
      expect(panel.webview.html).not.toBe(crashed);
      expect(noReadyChoice.mock.calls.map(([, action, opened]) => [action, opened])).toEqual([['reload', undefined]]);
    } finally {
      DraftPreviewPanel.close();
    }
  });

  it('draft: a crashed page that says ready again is a fresh page, and the notification\'s Reload leaves it alone', async () => {
    const note = pendingNotification();
    const noReadyChoice = vi.fn();
    const panel = showDraft({ noReady: vi.fn(), noReadyChoice });
    try {
      await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS);
      await panel._simulateMessage({ type: 'ready' });
      await panel._simulateMessage({ type: 'pageError', kind: 'render', area: 'draft' });
      // VS Code loaded the page again (not the preview's own Reload): it says ready once more.
      await panel._simulateMessage({ type: 'ready' });
      const working = panel.webview.html;
      await note.press(NO_READY_RELOAD_BUTTON);
      expect(panel.webview.html).toBe(working);
      expect(noReadyChoice).not.toHaveBeenCalled();
    } finally {
      DraftPreviewPanel.close();
    }
  });

  it('Welcome: hidden after the timeout (its page is not kept), shown again, then ready', async () => {
    await withWelcome(async (panel) => {
      await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS);
      expect(errorKeys()).toContain('webviewNoReadyWelcome');
      panel._simulateViewStateChange(false);
      panel._simulateViewStateChange(true);
      await panel._simulateMessage({ type: 'ready' });
      expect(featureKeys()).toContain('welcomePanelReady');
      expect(featureKeys()).not.toContain('readyAfterNoReady');
    });
  });
});
