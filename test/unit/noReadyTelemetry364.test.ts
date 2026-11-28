/**
 * #364: a canvas (or draft / Welcome page) that never said `ready`. Beside its
 * `webviewNoReady*` code the heartbeat now tells apart
 *  - H1 a host held busy (the 30 s timer ran 5 s or more late, on the
 *    monotonic clock) from H2 an idle host whose page never mounted:
 *    `noReadyHostHeld`;
 *  - H3 the tab went away still blank, and when:
 *    `noReadyClosed30to60s` / `noReadyClosedOver60s`.
 * Against the real panels: the canvas (SemanticEditorProvider, with an empty
 * dist/webview.js so its page never mounts), the draft preview and Welcome.
 * The rule itself is pinned in readyWatch.test.ts.
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
import { READY_TIMEOUT_MS } from '../../src/services/readyWatch';
import { draftPreviewEvents } from '../../src/providers/draftWiring';
import {
  FEATURES,
  HEARTBEAT_SOFT_LIMIT,
  NO_READY_FEATURES,
  buildHeartbeat,
  emptyCounters,
  heartbeatBytes,
  provisionalBody,
  trimHeartbeat,
} from '../../src/services/telemetryPayload';
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
const NEW_KEYS = ['noReadyHostHeld', 'noReadyClosed30to60s', 'noReadyClosedOver60s'];
type MockPanel = ReturnType<typeof vscode.createMockWebviewPanel>;

let root: string;
let extensionRoot: string;
let feature: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
let canvasClosed: ReturnType<typeof vi.spyOn>;
/** The monotonic clock `ReadyWatch` times lateness on (`performance.now()`), moved by hand. */
let mono = 0;
const featureKeys = () => feature.mock.calls.map(([k]) => k as string);
const errorKeys = () => error.mock.calls.map(([k]) => k as string);

/**
 * The host was blocked for `ms`: both clocks moved while no timer could run,
 * then the overdue 30 s timer runs (fake timers keep its relative due time).
 */
async function holdHostThenDrain(ms: number): Promise<void> {
  vi.setSystemTime(Date.now() + ms);
  mono += ms;
  mono += READY_TIMEOUT_MS;
  await vi.advanceTimersByTimeAsync(READY_TIMEOUT_MS);
}

/** A free host: both clocks move `ms`, timers on time. */
async function step(ms: number): Promise<void> {
  mono += ms;
  await vi.advanceTimersByTimeAsync(ms);
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

/** A canvas whose page never mounts (dist/webview.js is empty): it never says ready. */
async function openBlankCanvas() {
  const file = diagramPath(root, 'yaml', 'silver', 'showcase');
  const doc = {
    uri: vscode.Uri.file(file), isDirty: false, isClosed: false,
    getText: () => fs.readFileSync(file, 'utf-8'), positionAt: (offset: number) => ({ offset }), save: vi.fn(async () => true),
  };
  const panel = vscode.createMockWebviewPanel();
  await buildProvider().resolveCustomTextEditor(
    doc as unknown as import('vscode').TextDocument,
    panel as unknown as import('vscode').WebviewPanel,
    {} as import('vscode').CancellationToken,
  );
  vscode.window.tabGroups.activeTabGroup.activeTab = { input: new vscode.TabInputCustom(doc.uri, SUBJECT_AREA_EDITOR_VIEW_TYPE) };
  return panel;
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

async function withWelcome(run: (panel: MockPanel) => Promise<void>) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-364-gs-'));
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
  } finally {
    // A row that failed before its close leaves no panel behind for the next one.
    GettingStartedPanel.currentPanel?.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

beforeEach(() => {
  vscode._resetMockWorkspace();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(vscode.window, 'showWarningMessage').mockReturnValue(new Promise(() => {}) as never);
  feature = vi.spyOn(telemetry, 'feature');
  error = vi.spyOn(telemetry, 'error');
  canvasClosed = vi.spyOn(telemetry, 'canvasClosed');
  vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
  mono = 1_000;
  vi.spyOn(performance, 'now').mockImplementation(() => mono);
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-364-'));
  fs.cpSync(dbtFixtureRoot('dbt-project'), root, { recursive: true });
  extensionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-364-ext-'));
  fs.mkdirSync(path.join(extensionRoot, 'dist'));
  fs.writeFileSync(path.join(extensionRoot, 'dist', 'webview.js'), '');
  vi.useFakeTimers();
});

afterEach(() => {
  DraftPreviewPanel.close();
  vi.useRealTimers();
  vscode.window.tabGroups.activeTabGroup.activeTab = undefined;
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(extensionRoot, { recursive: true, force: true });
});

describe('#364 the three keys exist on both sides of the contract', () => {
  it('FEATURES (extension) and the Worker list carry noReadyHostHeld and the two closed keys, at the end, in order', () => {
    const worker = fs.readFileSync(path.join(REPO_ROOT, 'telemetry/src/index.js'), 'utf8');
    const missing = NEW_KEYS.filter((k) => !(FEATURES as readonly string[]).includes(k) || !worker.includes(`'${k}'`));
    expect(missing).toEqual([]);
    expect(FEATURES.slice(FEATURES.indexOf('noReadyHostHeld'), FEATURES.indexOf('noReadyHostHeld') + 3)).toEqual(NEW_KEYS);
  });
});

describe('#364 the keys survive an oversized day', () => {
  it('trimHeartbeat keeps the three keys beside the webviewNoReady* code, which is what an H1/H2 reading needs', () => {
    expect([...NO_READY_FEATURES]).toEqual(NEW_KEYS);
    const all = Object.fromEntries(FEATURES.map((f) => [f, 1]));
    const s = { ...emptyCounters('2026-11-28'), features: all, errors: { webviewNoReadyCanvas: 1 } };
    const env = { installId: '3b241101-e2bb-4255-8caf-4136c566a962', extVersion: '2.0.12', vscodeVersion: '1.104.2', platform: 'darwin', firstSeenDay: '2026-09-01' };
    const body = provisionalBody(buildHeartbeat(s, env));
    expect(heartbeatBytes(body)).toBeGreaterThan(HEARTBEAT_SOFT_LIMIT);
    const trimmed = trimHeartbeat(body);
    expect(heartbeatBytes(trimmed)).toBeLessThanOrEqual(HEARTBEAT_SOFT_LIMIT);
    expect(trimmed.features.heartbeatTrimmed).toBe(1);
    for (const key of NEW_KEYS) expect(trimmed.features[key as keyof typeof trimmed.features], key).toBe(1);
    expect(trimmed.errors.webviewNoReadyCanvas).toBe(1);
  });
});

describe('#364 the canvas records the keys', () => {
  it('a blank canvas on a held host, closed 45 s after it was shown', async () => {
    const panel = await openBlankCanvas();
    const shownAt = Date.now();
    // The host is blocked 12 s (reading a 500+ table library): the 30 s timer runs 42 s after the show.
    await holdHostThenDrain(12_000);
    expect(Date.now() - shownAt).toBe(READY_TIMEOUT_MS + 12_000);
    expect(errorKeys()).toContain('webviewNoReadyCanvas');
    expect(featureKeys()).toContain('noReadyHostHeld');
    await step(3_000);
    panel._simulateDispose();
    expect(featureKeys().filter((k) => k.startsWith('noReadyClosed'))).toEqual(['noReadyClosed30to60s']);
    // The closed key lands before the trail's canvasClosed marker.
    const closedAt = feature.mock.invocationCallOrder[featureKeys().indexOf('noReadyClosed30to60s')];
    expect(canvasClosed).toHaveBeenCalledTimes(1);
    expect(closedAt).toBeLessThan(canvasClosed.mock.invocationCallOrder[0]);
  });

  it('a blank canvas on an idle host, closed 90 s after it was shown: no noReadyHostHeld, noReadyClosedOver60s', async () => {
    const panel = await openBlankCanvas();
    await step(READY_TIMEOUT_MS);
    expect(errorKeys()).toContain('webviewNoReadyCanvas');
    expect(featureKeys()).not.toContain('noReadyHostHeld');
    await step(60_000);
    panel._simulateDispose();
    expect(featureKeys().filter((k) => k.startsWith('noReadyClosed'))).toEqual(['noReadyClosedOver60s']);
  });

  it('a canvas closed before its 30 s records none of the keys', async () => {
    const panel = await openBlankCanvas();
    await step(10_000);
    panel._simulateDispose();
    await step(READY_TIMEOUT_MS * 2);
    expect(errorKeys()).not.toContain('webviewNoReadyCanvas');
    expect(featureKeys().filter((k) => NEW_KEYS.includes(k))).toEqual([]);
  });
});

describe('#364 the draft preview records the keys', () => {
  it('the preview passes a held host and the closed range on', async () => {
    const noReadyHostHeld = vi.fn();
    const closedBlank = vi.fn();
    const panel = showDraft({ noReady: vi.fn(), noReadyHostHeld, closedBlank } as never);
    await holdHostThenDrain(8_000);
    expect(noReadyHostHeld).toHaveBeenCalledWith('sqlDdl');
    await step(60_000);
    panel._simulateDispose();
    expect(closedBlank.mock.calls).toEqual([['sqlDdl', 'over60s']]);
  });

  it('a preview closed by ERD Studio after its ready (Keep, discard, another way to start) is never closed blank', async () => {
    const closedBlank = vi.fn();
    const panel = showDraft({ noReady: vi.fn(), closedBlank } as never);
    await step(READY_TIMEOUT_MS + 5_000);
    await panel._simulateMessage({ type: 'ready' });
    DraftPreviewPanel.close();
    expect(closedBlank).not.toHaveBeenCalled();
  });

  it('the wiring counts both through feature', () => {
    const counted: string[] = [];
    const events = draftPreviewEvents((key) => counted.push(key), (key) => counted.push(`!${key}`));
    events.noReady?.('sqlDdl');
    events.noReadyHostHeld?.('sqlDdl');
    events.closedBlank?.('sqlDdl', '30to60s');
    events.closedBlank?.('sqlDdl', 'over60s');
    expect(counted).toEqual(['!webviewNoReadyDraft', 'noReadyHostHeld', 'noReadyClosed30to60s', 'noReadyClosedOver60s']);
  });
});

describe('#364 the Welcome panel records the keys', () => {
  it('closed while blank 40 s after it was shown, on a held host: one closed key', async () => {
    await withWelcome(async (panel) => {
      await holdHostThenDrain(6_000);
      expect(errorKeys()).toContain('webviewNoReadyWelcome');
      expect(featureKeys()).toContain('noReadyHostHeld');
      await step(4_000);
      panel._simulateDispose();
      // GettingStartedPanel.dispose can run twice (its own close, then the panel's): one key.
      expect(featureKeys().filter((k) => k.startsWith('noReadyClosed'))).toEqual(['noReadyClosed30to60s']);
    });
  });

  it('hidden after its 30 s and closed while hidden: one closed key (VS Code may hide a tab as it closes it)', async () => {
    await withWelcome(async (panel) => {
      await step(READY_TIMEOUT_MS);
      expect(errorKeys()).toContain('webviewNoReadyWelcome');
      panel._simulateViewStateChange(false);
      await step(10_000);
      panel._simulateDispose();
      expect(featureKeys().filter((k) => k.startsWith('noReadyClosed'))).toEqual(['noReadyClosed30to60s']);
    });
  });

  it('hidden after its 30 s and shown again (a new page), then closed: no closed key', async () => {
    await withWelcome(async (panel) => {
      await step(READY_TIMEOUT_MS);
      expect(errorKeys()).toContain('webviewNoReadyWelcome');
      panel._simulateViewStateChange(false);
      await step(5_000);
      panel._simulateViewStateChange(true);
      await step(5_000);
      panel._simulateDispose();
      expect(featureKeys().filter((k) => k.startsWith('noReadyClosed'))).toEqual([]);
    });
  });
});
