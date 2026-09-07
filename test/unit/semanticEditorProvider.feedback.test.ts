/**
 * SemanticEditorProvider — the six feedback messages at the message boundary.
 *
 * Three contracts are asserted here that nothing else can see:
 *
 *  - **A14's split.** A bad `submitFeedback` payload comes back as
 *    `feedbackSubmitted { ok: false, error }`, never a bare `error`: the dialog
 *    sits above the toast and only clears its busy flag on that reply, so a
 *    generic error would leave its primary button stuck forever. Every other
 *    feedback message takes the generic error path.
 *  - **The physical-stage guard.** None of the six writes a domain file, so all
 *    six survive the read-only guard while a schema mutation still does not.
 *  - **Silence about GitHub.** `requestFeedbackContext` reads the session
 *    silently — no feedback message ever prompts for a GitHub sign-in.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { SemanticEditorProvider, PHYSICAL_READ_ONLY_MESSAGE } from '../../src/providers/SemanticEditorProvider';
import { DomainService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { LogicalModelService } from '../../src/services/logicalModelService';
import { ManifestService } from '../../src/services/manifestService';
import { YmlParserService } from '../../src/services/ymlParserService';
import { TemplateService } from '../../src/services/templateService';
import { SelectorsService } from '../../src/services/selectorsService';
import type { ReportTrackingService } from '../../src/services/reportTrackingService';
import { FEEDBACK_AI_ASSIST_SETTING } from '../../src/services/feedbackAnalysisService';
import { hostErrorLog } from '../../src/services/feedbackService';

const REPO_ROOT = path.resolve(__dirname, '../..');
const FIXTURE_ROOT = path.join(REPO_ROOT, 'test', 'fixtures', 'dbt-project');

type MockPanel = ReturnType<typeof vscode.createMockWebviewPanel>;
type Posted = { type: string; payload?: any };

const posted = (panel: MockPanel) => panel._postedMessages as Posted[];
const types = (panel: MockPanel) => posted(panel).map((m) => m.type);
const lastOf = (panel: MockPanel, type: string) =>
  posted(panel).filter((m) => m.type === type).at(-1)?.payload;
const lastError = (panel: MockPanel) => lastOf(panel, 'error')?.message as string | undefined;

/** Pending submissions the provider recorded through the injected tracker. */
const recordPending = vi.fn(async () => {});

/** A minimal document the provider can read without touching the edit pipeline. */
function makeDoc(fsPath: string) {
  const text = fs.readFileSync(fsPath, 'utf-8');
  return {
    uri: vscode.Uri.file(fsPath),
    isDirty: false,
    isClosed: false,
    getText: () => text,
    positionAt: (offset: number) => ({ offset }),
    save: vi.fn(async () => true),
  };
}

/** Open the showcase canvas and wait for its first `domainLoaded`. */
async function openShowcase(root: string) {
  const layerService = new LayerService(root, '.erd-studio');
  const domainService = new DomainService(layerService);
  const logicalModelService = new LogicalModelService(root, '.erd-studio');
  domainService.setLogicalModelService(logicalModelService);
  const selectorsService = new SelectorsService(domainService, root, '.erd-studio');

  const context = {
    extensionUri: vscode.Uri.file(REPO_ROOT),
    globalStorageUri: vscode.Uri.file(path.join(root, '.global-storage')),
    extension: { packageJSON: { version: '0.0.0-test' } },
    globalState: vscode.createMockMemento(),
    secrets: vscode.createMockSecretStorage(),
    subscriptions: [],
  } as unknown as import('vscode').ExtensionContext;

  const provider = new SemanticEditorProvider(
    context,
    domainService,
    new ManifestService(),
    new YmlParserService(),
    new TemplateService(),
    layerService,
    root,
    selectorsService,
    logicalModelService,
  );
  provider.setReportTracking({ recordPending } as unknown as ReportTrackingService);

  const file = path.join(root, '.erd-studio', 'silver', 'showcase.json');
  const doc = makeDoc(file);
  const panel = vscode.createMockWebviewPanel();
  await provider.resolveCustomTextEditor(
    doc as unknown as import('vscode').TextDocument,
    panel as unknown as import('vscode').WebviewPanel,
    {} as import('vscode').CancellationToken,
  );
  panel._simulateMessage({ type: 'ready' });
  await vi.waitFor(() => expect(types(panel)).toContain('domainLoaded'), { timeout: 4000, interval: 10 });
  return { provider, panel, doc, context };
}

const validSubmit = (overrides: Record<string, unknown> = {}) => ({
  kind: 'bug' as const,
  title: 'Edge vanished after rename',
  description: 'Renamed dim_task and the FK edge disappeared.',
  includeDiagnostics: true,
  ...overrides,
});

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-feedback-'));
  fs.cpSync(FIXTURE_ROOT, root, { recursive: true });
  vscode._resetMockWorkspace();
  vscode._resetMockConfiguration();
  vscode._resetMockGithubSession();
  vscode._resetMockLanguageModels();
  recordPending.mockClear();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('requestFeedbackContext', () => {
  it('answers with the diagnostics view and a capability snapshot', async () => {
    const { panel } = await openShowcase(root);

    panel._simulateMessage({
      type: 'requestFeedbackContext',
      payload: {
        webviewErrors: ['2026-09-07T00:00:00.000Z [webview] boom'],
        domain: {
          name: 'showcase', layer: 'silver', stage: 'logical',
          modelCount: 4, relationshipCount: 3, schemaVersion: 5,
        },
      },
    });

    await vi.waitFor(() => expect(types(panel)).toContain('feedbackContext'));
    const payload = lastOf(panel, 'feedbackContext');
    expect(payload.diagnostics.text.startsWith('ERD Studio: ')).toBe(true);
    expect(payload.diagnostics.text).toContain('silver/showcase');
    expect(payload.diagnostics.chips[0]).toEqual({ label: 'ERD Studio 0.0.0-test', tone: 'normal' });
    expect(payload.diagnostics.chips.some((c: { tone: string }) => c.tone === 'error')).toBe(true);
    expect(payload.capabilities).toEqual({
      extensionVersion: '0.0.0-test',
      aiAvailable: false,
      aiProviderLabel: null,
      githubHandle: null,
      canCaptureCanvas: true,
    });
  });

  it('reads the GitHub session silently — nobody is nagged to sign in', async () => {
    const getSession = vi.spyOn(vscode.authentication, 'getSession');
    const { panel } = await openShowcase(root);

    panel._simulateMessage({ type: 'requestFeedbackContext', payload: {} });

    await vi.waitFor(() => expect(types(panel)).toContain('feedbackContext'));
    for (const call of getSession.mock.calls) {
      expect(call[2]).toEqual({ silent: true });
    }
  });

  it('reports the AI provider when one is configured', async () => {
    vscode._setMockConfiguration('erdStudio', FEEDBACK_AI_ASSIST_SETTING, { globalValue: true });
    vscode._setMockLanguageModels([{ id: 'gpt-4o', name: 'GPT-4o', reply: '{}' }]);
    const { panel } = await openShowcase(root);

    panel._simulateMessage({ type: 'requestFeedbackContext', payload: {} });

    await vi.waitFor(() => expect(types(panel)).toContain('feedbackContext'));
    expect(lastOf(panel, 'feedbackContext').capabilities).toMatchObject({
      aiAvailable: true,
      aiProviderLabel: 'Copilot',
    });
  });

  it('still answers when the host has no GitHub authentication provider', async () => {
    // Losing the diagnostics disclosure and the screenshot checkbox because a
    // decorative handle could not be read would be absurd.
    vscode._setMockAuthError(new Error('No authentication provider "github" registered.'));
    const { panel } = await openShowcase(root);

    panel._simulateMessage({ type: 'requestFeedbackContext', payload: {} });

    await vi.waitFor(() => expect(types(panel)).toContain('feedbackContext'));
    expect(lastOf(panel, 'feedbackContext').capabilities).toMatchObject({
      githubHandle: null,
      canCaptureCanvas: true,
    });
    expect(types(panel)).not.toContain('error');
    expect(hostErrorLog.recent().at(-1)).toMatch(/sendFeedbackContext\.getSession/);
  });

  it('rejects a malformed payload with a generic error', async () => {
    const { panel } = await openShowcase(root);

    panel._simulateMessage({ type: 'requestFeedbackContext', payload: { webviewErrors: 'boom' } });

    await vi.waitFor(() => expect(lastError(panel)).toBeDefined());
    expect(lastError(panel)).toMatch(/^Failed to load feedback context: /);
    expect(types(panel)).not.toContain('feedbackContext');
  });
});

describe('submitFeedback', () => {
  it('opens the bug template for a bug', async () => {
    const { panel } = await openShowcase(root);
    const open = vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(true);

    panel._simulateMessage({ type: 'submitFeedback', payload: validSubmit() });

    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    expect(String(open.mock.calls[0][0])).toContain('template=bug_report.yml');
    await vi.waitFor(() => expect(lastOf(panel, 'feedbackSubmitted')).toEqual({ ok: true }));
  });

  it('opens the feature template for a feature request', async () => {
    const { panel } = await openShowcase(root);
    const open = vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(true);

    panel._simulateMessage({
      type: 'submitFeedback',
      payload: validSubmit({ kind: 'feature', steps: 'Two windows today.' }),
    });

    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    const url = decodeURIComponent(String(open.mock.calls[0][0]).replace(/\+/g, ' '));
    expect(url).toContain('template=feature_request.yml');
    expect(url).toContain('rationale=Two windows today.');
    expect(url).not.toContain('steps=');
  });

  it('records a pending report so the tracker can reconcile it later', async () => {
    const { panel } = await openShowcase(root);
    vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(true);

    panel._simulateMessage({ type: 'submitFeedback', payload: validSubmit() });

    await vi.waitFor(() => expect(recordPending).toHaveBeenCalledWith('Edge vanished after rename', 'bug'));
  });

  it('still reports success when the tracker cannot record the report', async () => {
    const { panel } = await openShowcase(root);
    vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(true);
    // The browser form has already opened by this point — a failed globalState
    // write must not be reported back to the user as a failed report.
    recordPending.mockRejectedValueOnce(new Error('globalState is full'));

    panel._simulateMessage({ type: 'submitFeedback', payload: validSubmit() });

    await vi.waitFor(() => expect(lastOf(panel, 'feedbackSubmitted')).toEqual({ ok: true }));
    expect(types(panel)).not.toContain('error');
  });

  it('does not track a comment on somebody else\'s thread — nothing new was filed', async () => {
    const { panel } = await openShowcase(root);
    vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(true);
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);

    panel._simulateMessage({ type: 'submitFeedback', payload: validSubmit({ commentOnIssue: 42 }) });

    await vi.waitFor(() =>
      expect(lastOf(panel, 'feedbackSubmitted')).toEqual({ ok: true, commentedOn: 42 }),
    );
    expect(recordPending).not.toHaveBeenCalled();
  });

  it('replies without waiting for the sticky notification to be dismissed', async () => {
    // A notification carrying a "Reveal Folder" button never auto-hides, and
    // the dialog disables Cancel, Escape and the backdrop until this reply
    // lands — so the reply must not be behind the user dismissing a toast.
    const { panel } = await openShowcase(root);
    vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(true);
    const info = vi
      .spyOn(vscode.window, 'showInformationMessage')
      .mockReturnValue(new Promise(() => {}) as Promise<undefined>);

    panel._simulateMessage({
      type: 'submitFeedback',
      payload: validSubmit({
        attachments: [
          {
            id: 'canvas',
            name: 'canvas.png',
            mime: 'image/png',
            bytes: 4,
            dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
            source: 'canvas',
            onClipboard: true,
          },
        ],
      }),
    });

    await vi.waitFor(() => expect(lastOf(panel, 'feedbackSubmitted')).toEqual({ ok: true }));
    expect(info).toHaveBeenCalled();
  });

  it('answers a bad payload with feedbackSubmitted, never a bare error (A14)', async () => {
    const { panel } = await openShowcase(root);
    const open = vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(true);
    const errorsBefore = types(panel).filter((t) => t === 'error').length;

    panel._simulateMessage({ type: 'submitFeedback', payload: validSubmit({ kind: 'question' }) });

    await vi.waitFor(() => expect(lastOf(panel, 'feedbackSubmitted')).toBeDefined());
    expect(lastOf(panel, 'feedbackSubmitted')).toEqual({
      ok: false,
      error: 'Feedback kind must be "bug" or "feature".',
    });
    // The dialog shows the sentence as written, so it is not prefixed…
    expect(types(panel).filter((t) => t === 'error')).toHaveLength(errorsBefore);
    expect(open).not.toHaveBeenCalled();
  });

  it('refuses an oversize attachment before anything is written to disk', async () => {
    const { panel } = await openShowcase(root);
    vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(true);

    panel._simulateMessage({
      type: 'submitFeedback',
      payload: validSubmit({
        attachments: [
          {
            id: 'canvas',
            name: 'huge.png',
            mime: 'image/png',
            bytes: 20 * 1024 * 1024,
            dataUrl: 'data:image/png;base64,AAAA',
            source: 'canvas',
          },
        ],
      }),
    });

    await vi.waitFor(() => expect(lastOf(panel, 'feedbackSubmitted')?.ok).toBe(false));
    expect(lastOf(panel, 'feedbackSubmitted').error).toBe(
      'Attachment "huge.png" is larger than the 10 MB limit.',
    );
    expect(fs.existsSync(path.join(root, '.global-storage', 'feedback'))).toBe(false);
  });
});

describe('analyzeFeedback', () => {
  it('replies with the echoed request id and no analysis when no tier is configured', async () => {
    const { panel } = await openShowcase(root);

    panel._simulateMessage({
      type: 'analyzeFeedback',
      payload: { requestId: 7, kind: 'bug', description: 'Renamed a model and the edge vanished.' },
    });

    await vi.waitFor(() => expect(types(panel)).toContain('feedbackAnalysis'));
    const payload = lastOf(panel, 'feedbackAnalysis');
    expect(payload).toEqual({ requestId: 7, analysis: null });
    // No `error` key: "no model configured" is benign, not a failure.
    expect('error' in payload).toBe(false);
  });

  it('rejects a malformed payload with a generic error and no reply', async () => {
    const { panel } = await openShowcase(root);

    panel._simulateMessage({
      type: 'analyzeFeedback',
      payload: { requestId: 1.5, kind: 'bug', description: 'x' },
    });

    await vi.waitFor(() => expect(lastError(panel)).toBeDefined());
    expect(lastError(panel)).toMatch(/^Failed to analyse feedback: /);
    expect(types(panel)).not.toContain('feedbackAnalysis');
  });
});

describe('copyFeedbackReport', () => {
  it('writes the Markdown report to the clipboard', async () => {
    const { panel } = await openShowcase(root);
    const write = vi.spyOn(vscode.env.clipboard, 'writeText').mockResolvedValue(undefined);
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);

    panel._simulateMessage({
      type: 'copyFeedbackReport',
      payload: { ...validSubmit(), attachmentNames: ['canvas.png'] },
    });

    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    const report = String(write.mock.calls[0][0]);
    expect(report).toContain('# Edge vanished after rename');
    expect(report).toContain('## What happened?');
    expect(report).toContain('- canvas.png');
    expect(report).toContain('## Diagnostics');
  });

  it('rejects a malformed payload with a generic error', async () => {
    const { panel } = await openShowcase(root);
    const write = vi.spyOn(vscode.env.clipboard, 'writeText').mockResolvedValue(undefined);

    panel._simulateMessage({ type: 'copyFeedbackReport', payload: { kind: 'bug' } });

    await vi.waitFor(() => expect(lastError(panel)).toBeDefined());
    expect(lastError(panel)).toMatch(/^Failed to copy the report: /);
    expect(write).not.toHaveBeenCalled();
  });
});

describe('openFeedbackLink', () => {
  it('opens an issue, and its comment box when asked', async () => {
    const { panel } = await openShowcase(root);
    const open = vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(true);

    panel._simulateMessage({ type: 'openFeedbackLink', payload: { target: 'issue', issue: 42 } });
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    expect(String(open.mock.calls[0][0])).toBe('https://github.com/liam-machine/erd-studio/issues/42');

    panel._simulateMessage({
      type: 'openFeedbackLink',
      payload: { target: 'issue', issue: 42, comment: true },
    });
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    expect(String(open.mock.calls[1][0])).toBe(
      'https://github.com/liam-machine/erd-studio/issues/42#issuecomment-new',
    );
  });

  it('opens the Extensions view for the update route, without touching the browser', async () => {
    const { panel } = await openShowcase(root);
    const open = vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(true);
    const run = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);

    panel._simulateMessage({ type: 'openFeedbackLink', payload: { target: 'extension' } });

    await vi.waitFor(() =>
      expect(run).toHaveBeenCalledWith('workbench.extensions.search', '@id:liamwynne.erd-studio'),
    );
    expect(open).not.toHaveBeenCalled();
  });

  it('rejects an unknown target with a generic error', async () => {
    const { panel } = await openShowcase(root);
    const open = vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(true);

    panel._simulateMessage({ type: 'openFeedbackLink', payload: { target: 'settings' } });

    await vi.waitFor(() => expect(lastError(panel)).toBeDefined());
    expect(lastError(panel)).toMatch(/^Failed to open the link: /);
    expect(open).not.toHaveBeenCalled();
  });
});

describe('the physical-stage guard', () => {
  it('lets every feedback message through while still refusing a schema mutation', async () => {
    const { panel } = await openShowcase(root);
    panel._simulateMessage({ type: 'switchStage', payload: { stage: 'physical', requestId: 1 } });
    await vi.waitFor(() => expect(types(panel)).toContain('stageData'), { timeout: 4000, interval: 10 });

    vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(true);
    vi.spyOn(vscode.env.clipboard, 'writeText').mockResolvedValue(undefined);
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);
    vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);

    const messages = [
      { type: 'requestFeedbackContext', payload: {} },
      { type: 'analyzeFeedback', payload: { requestId: 1, kind: 'bug', description: 'It vanished after a rename.' } },
      { type: 'submitFeedback', payload: validSubmit() },
      { type: 'copyFeedbackReport', payload: validSubmit() },
      { type: 'openFeedbackLink', payload: { target: 'extension' } },
    ];
    for (const message of messages) {
      await panel._simulateMessage(message);
    }
    await new Promise((r) => setTimeout(r, 30));

    const rejections = posted(panel).filter(
      (m) => m.type === 'error' && m.payload?.message === PHYSICAL_READ_ONLY_MESSAGE,
    );
    expect(rejections).toEqual([]);

    // …and a real mutation is still refused.
    await panel._simulateMessage({
      type: 'addColumn',
      payload: { modelName: 'dim_task', column: { name: 'x', dataType: 'string' } },
    });
    await vi.waitFor(() => expect(lastError(panel)).toBe(PHYSICAL_READ_ONLY_MESSAGE));
  });
});
