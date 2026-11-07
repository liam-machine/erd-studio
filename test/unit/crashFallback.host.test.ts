/**
 * The crash screen, host side: the canvas's `crashFallback` (Reload re-sets
 * the page and the next `ready` loads it again; Send Feedback opens the
 * canvas-less Send Feedback with a redacted prefill, because a crashed canvas
 * is skipped by `requestFeedbackDialog`), its payload validation and its two
 * telemetry keys; and the draft page's passive `crashFallback` (the preview
 * reloads its own page, the wiring counts the button and opens Send Feedback).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { _resetMockWebviewPanels } from 'vscode';

import { SemanticEditorProvider } from '../../src/providers/SemanticEditorProvider';
import { validateCrashFallbackPayload } from '../../src/providers/payloadValidation';
import { DraftPreviewPanel } from '../../src/providers/DraftPreviewPanel';
import { draftPreviewEvents } from '../../src/providers/draftWiring';
import { crashFeedbackPrefill } from '../../src/services/commandErrors';
import { handlerGroupOf } from '../../src/services/runtimeTelemetry';
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
import { CRASH_DETAIL_MAX, crashDetailOf } from '../../src/types/webviewError';
import { parseDraftToHost, type Draft, type DraftMessageAllowance, type DraftView } from '../../src/types/draft';
import { dbtFixtureRoot, diagramPath } from './helpers/dbtFixtures';


const DRAFT_FIXTURES = path.resolve(__dirname, '../fixtures/draft');
const draftOf = (name: string): Draft => ({
  ...(JSON.parse(fs.readFileSync(path.join(DRAFT_FIXTURES, `${name}.json`), 'utf8')) as DraftView),
  keep: { writer: 'none' },
  trigger: 'start',
} as Draft);
type MockPanel = ReturnType<typeof vscode.createMockWebviewPanel>;
const lastPanel = (): MockPanel => {
  const all = (vscode.window as unknown as { _webviewPanels: MockPanel[] })._webviewPanels;
  return all[all.length - 1];
};

type Posted = { type: string; payload?: any };

let root: string;
let extensionRoot: string;
let feature: ReturnType<typeof vi.spyOn>;
let executeCommand: ReturnType<typeof vi.spyOn>;

function makeDoc(fsPath: string) {
  return {
    uri: vscode.Uri.file(fsPath),
    isDirty: false,
    isClosed: false,
    getText: () => fs.readFileSync(fsPath, 'utf-8'),
    positionAt: (offset: number) => ({ offset }),
    save: vi.fn(async () => true),
  };
}

function buildProvider() {
  const layerService = new LayerService(root, '.erd-studio');
  const subjectAreaService = new SubjectAreaService(layerService);
  const tableLibraryService = new TableLibraryService(root, '.erd-studio');
  subjectAreaService.setTableLibraryService(tableLibraryService);
  const context = {
    // An install with its built page (dist/webview.js), so the canvas HTML carries a fresh nonce each time.
    extensionUri: vscode.Uri.file(extensionRoot),
    globalStorageUri: vscode.Uri.file(path.join(root, '.global-storage')),
    extension: { packageJSON: { version: '0.0.0-test' } },
    globalState: { get: () => true, update: async () => {} },
    workspaceState: vscode.createMockMemento(),
    secrets: vscode.createMockSecretStorage(),
    subscriptions: [],
  } as unknown as import('vscode').ExtensionContext;
  return new SemanticEditorProvider(
    context,
    subjectAreaService,
    new ManifestService(),
    new YmlParserService(),
    new TemplateService(),
    layerService,
    root,
    new SelectorsService(subjectAreaService, root, '.erd-studio'),
    tableLibraryService,
  );
}

async function openCanvas() {
  const file = diagramPath(root, 'yaml', 'silver', 'showcase');
  const doc = makeDoc(file);
  const provider = buildProvider();
  const panel = vscode.createMockWebviewPanel();
  await provider.resolveCustomTextEditor(
    doc as unknown as import('vscode').TextDocument,
    panel as unknown as import('vscode').WebviewPanel,
    {} as import('vscode').CancellationToken,
  );
  await panel._simulateMessage({ type: 'ready' });
  // The canvas is the focused tab.
  vscode.window.tabGroups.activeTabGroup.activeTab = { input: new vscode.TabInputCustom(doc.uri, SUBJECT_AREA_EDITOR_VIEW_TYPE) };
  return { provider, panel };
}

const posted = (panel: ReturnType<typeof vscode.createMockWebviewPanel>) => panel._postedMessages as Posted[];
const featureKeys = () => feature.mock.calls.map(([k]) => k);
const reportBugCalls = () => executeCommand.mock.calls.filter(([c]) => c === 'erdStudio.reportBug');

beforeEach(() => {
  vscode._resetMockWorkspace();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  feature = vi.spyOn(telemetry, 'feature');
  executeCommand = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
});

afterEach(() => {
  vscode.window.tabGroups.activeTabGroup.activeTab = undefined;
  vi.restoreAllMocks();
});

describe('the canvas crash screen (crashFallback)', () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-crash-fallback-'));
    fs.cpSync(dbtFixtureRoot('dbt-project'), root, { recursive: true });
    extensionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-crash-fallback-ext-'));
    fs.mkdirSync(path.join(extensionRoot, 'dist'));
    fs.writeFileSync(path.join(extensionRoot, 'dist', 'webview.js'), '');
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(extensionRoot, { recursive: true, force: true });
  });

  it('Reload gives the panel a new page, which loads the diagram again on its ready', async () => {
    const { panel } = await openCanvas();
    const before = panel.webview.html;
    expect(before).toContain('webview.js');
    await panel._simulateMessage({ type: 'crashFallback', payload: { action: 'reload' } });
    expect(panel.webview.html).not.toBe(before);
    expect(panel.webview.html).toContain('webview.js');
    expect(featureKeys()).toContain('crashFallbackReload');
    expect(reportBugCalls()).toHaveLength(0);

    const loads = posted(panel).filter((m) => m.type === 'domainLoaded').length;
    await panel._simulateMessage({ type: 'ready' });
    expect(posted(panel).filter((m) => m.type === 'domainLoaded').length).toBe(loads + 1);
  });

  it('Send Feedback opens the canvas-less Send Feedback, prefilled and redacted, and never routes to the dead dialog', async () => {
    const { provider, panel } = await openCanvas();
    // Before the crash, the focused canvas takes Send Feedback in its own dialog.
    expect(provider.requestFeedbackDialog()).toBe(true);

    await panel._simulateMessage({
      type: 'crashFallback',
      payload: { action: 'feedback', area: 'detailPanel', detail: 'TypeError: x is undefined at /Users/someone/acme/.erd-studio/gold/sales.dbml' },
    });
    expect(featureKeys()).toContain('crashFallbackFeedback');
    const [call] = reportBugCalls();
    expect(call).toBeDefined();
    const prefill = call[1] as { kind: string; title: string; description: string };
    expect(prefill.kind).toBe('bug');
    expect(prefill.title).toBe('The canvas stopped working');
    expect(prefill.description).toContain('the Detail panel');
    expect(prefill.description).toContain('TypeError: x is undefined');
    expect(prefill.description).not.toContain('someone');
    expect(prefill.description).not.toContain('acme');
    // The crashed canvas no longer claims Send Feedback: the caller falls back to the QuickPick flow.
    const openFeedbackBefore = posted(panel).filter((m) => m.type === 'openFeedback').length;
    expect(provider.requestFeedbackDialog()).toBe(false);
    expect(posted(panel).filter((m) => m.type === 'openFeedback').length).toBe(openFeedbackBefore);

    // A fresh page (Reload, then ready) takes it back.
    await panel._simulateMessage({ type: 'crashFallback', payload: { action: 'reload' } });
    await panel._simulateMessage({ type: 'ready' });
    expect(provider.requestFeedbackDialog()).toBe(true);
  });

  it('a render crash report alone marks the canvas crashed (Send Feedback from the palette skips it)', async () => {
    const { provider, panel } = await openCanvas();
    await panel._simulateMessage({ type: 'webviewError', payload: { kind: 'window', area: 'other' } });
    expect(provider.requestFeedbackDialog()).toBe(true);
    await panel._simulateMessage({ type: 'webviewError', payload: { kind: 'render', area: 'toolbar' } });
    expect(provider.requestFeedbackDialog()).toBe(false);
  });

  it('is allowed on the read-only physical stage, and ignores a malformed payload', async () => {
    const { panel } = await openCanvas();
    await panel._simulateMessage({ type: 'switchStage', payload: { stage: 'physical' } });
    const errorsBefore = posted(panel).filter((m) => m.type === 'error').length;
    await panel._simulateMessage({ type: 'crashFallback', payload: { action: 'feedback' } });
    expect(reportBugCalls()).toHaveLength(1);
    expect(posted(panel).filter((m) => m.type === 'error').length).toBe(errorsBefore);

    feature.mockClear();
    await panel._simulateMessage({ type: 'crashFallback', payload: { action: 'rm -rf' } });
    await panel._simulateMessage({ type: 'crashFallback' });
    expect(featureKeys()).not.toContain('crashFallbackReload');
    expect(featureKeys()).not.toContain('crashFallbackFeedback');
    expect(reportBugCalls()).toHaveLength(1);
  });
});

describe('crashFallback payload and prefill', () => {
  it('accepts only the fixed actions, a fixed area and a short detail', () => {
    expect(validateCrashFallbackPayload({ action: 'reload' })).toBe(true);
    expect(validateCrashFallbackPayload({ action: 'feedback', area: 'toolbar', detail: 'boom' })).toBe(true);
    expect(validateCrashFallbackPayload({ action: 'feedback', area: 'draft' })).toBe(false);
    expect(validateCrashFallbackPayload({ action: 'feedback', area: '/Users/x' })).toBe(false);
    expect(validateCrashFallbackPayload({ action: 'feedback', detail: 42 })).toBe(false);
    expect(validateCrashFallbackPayload({ action: 'feedback', detail: 'x'.repeat(CRASH_DETAIL_MAX + 1) })).toBe(false);
    expect(validateCrashFallbackPayload({ action: 'delete' })).toBe(false);
    expect(validateCrashFallbackPayload(null)).toBe(false);
    expect(validateCrashFallbackPayload(['reload'])).toBe(false);
  });

  it('is an "other" handler group, and its two keys are appended at the end of FEATURES', () => {
    expect(handlerGroupOf('crashFallback')).toBe('other');
    expect(FEATURES.slice(-2)).toEqual(['crashFallbackReload', 'crashFallbackFeedback']);
  });

  it('a crash detail is the first line only, with the error kind, and cut short', () => {
    expect(crashDetailOf(new TypeError('a is undefined\n    at foo (file:///x.js:1:2)'))).toBe('TypeError: a is undefined');
    expect(crashDetailOf(new Error('plain'))).toBe('plain');
    expect(crashDetailOf('a string')).toBe('a string');
    expect(crashDetailOf({ not: 'an error' })).toBe('');
    expect(crashDetailOf(new Error('y'.repeat(1000))).length).toBe(CRASH_DETAIL_MAX);
  });

  it('the prefill names the page, redacts paths again, and says when there was no message', () => {
    const draft = crashFeedbackPrefill('draft', { detail: 'failed reading C:\\Users\\someone\\models\\orders.sql' });
    expect(draft.title).toBe('The draft preview stopped working');
    expect(draft.description).toMatch(/^The draft preview crashed/);
    expect(draft.description).not.toContain('someone');
    const bare = crashFeedbackPrefill('canvas');
    expect(bare.description).toContain('(no message)');
    expect(crashFeedbackPrefill('canvas', { area: 'other', detail: 'x' }).description).not.toContain('started in');
  });
});

describe('the draft page crash screen', () => {
  const allowance: DraftMessageAllowance = { keepable: true, changeOptions: true, scopeIds: new Set(), otherStarts: new Set() };

  it('parses the passive crashFallback, dropping a detail on Reload and refusing a bad one', () => {
    expect(parseDraftToHost({ type: 'crashFallback', action: 'reload', detail: 'x' }, allowance)).toEqual({ type: 'crashFallback', action: 'reload' });
    expect(parseDraftToHost({ type: 'crashFallback', action: 'feedback', detail: 'boom', extra: 1 }, allowance))
      .toEqual({ type: 'crashFallback', action: 'feedback', detail: 'boom' });
    expect(parseDraftToHost({ type: 'crashFallback', action: 'feedback', detail: 'x'.repeat(CRASH_DETAIL_MAX + 1) }, allowance)).toBeUndefined();
    expect(parseDraftToHost({ type: 'crashFallback', action: 'keep' }, allowance)).toBeUndefined();
  });

  it('the wiring counts the button and opens Send Feedback with the draft prefill', () => {
    const features: string[] = [];
    const openFeedback = vi.fn();
    const events = draftPreviewEvents((k) => features.push(k), () => {}, undefined, undefined, openFeedback);
    events.crashFallback?.('sqlDdl', 'reload');
    expect(features).toEqual(['crashFallbackReload']);
    expect(openFeedback).not.toHaveBeenCalled();
    events.crashFallback?.('sqlDdl', 'feedback', 'TypeError: nope');
    expect(features).toEqual(['crashFallbackReload', 'crashFallbackFeedback']);
    expect(openFeedback).toHaveBeenCalledWith(crashFeedbackPrefill('draft', { detail: 'TypeError: nope' }));
  });

  it('Reload gives the preview a new page; the waiting flow keeps waiting and the new page gets the draft again', async () => {
    DraftPreviewPanel.close();
    _resetMockWebviewPanels();
    const crashFallback = vi.fn();
    let answered = false;
    void DraftPreviewPanel.show(vscode.Uri.file('/ext'), draftOf('large'), { crashFallback }).then(() => { answered = true; });
    const panel = lastPanel();
    await panel._simulateMessage({ type: 'ready' });
    const drafts = () => posted(panel).filter((m) => m.type === 'draft').length;
    expect(drafts()).toBe(1);

    const before = panel.webview.html;
    await panel._simulateMessage({ type: 'crashFallback', action: 'reload' });
    expect(panel.webview.html).not.toBe(before);
    expect(panel.webview.html).toContain('draft.js');
    expect(crashFallback).toHaveBeenCalledWith('sqlDdl', 'reload', undefined);
    // Nothing reaches the old page until the new one says ready.
    expect(drafts()).toBe(1);
    await panel._simulateMessage({ type: 'ready' });
    expect(drafts()).toBe(2);

    await panel._simulateMessage({ type: 'crashFallback', action: 'feedback', detail: 'boom' });
    expect(crashFallback).toHaveBeenLastCalledWith('sqlDdl', 'feedback', 'boom');
    await Promise.resolve();
    expect(answered).toBe(false);
    expect(panel._disposed).toBe(false);
    DraftPreviewPanel.close();
  });
});

