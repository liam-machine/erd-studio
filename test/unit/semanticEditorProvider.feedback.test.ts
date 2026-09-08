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
import { setHostedAnalysisTargetForTests } from '../../src/services/feedbackAnalysisService';
import { DomainService } from '../../src/services/domainService';
import { LayerService } from '../../src/services/layerService';
import { LogicalModelService } from '../../src/services/logicalModelService';
import { ManifestService } from '../../src/services/manifestService';
import { YmlParserService } from '../../src/services/ymlParserService';
import { TemplateService } from '../../src/services/templateService';
import { SelectorsService } from '../../src/services/selectorsService';
import type { ReportTrackingService } from '../../src/services/reportTrackingService';
import {
  FEEDBACK_AI_ASSIST_SETTING,
  FEEDBACK_LM_PRIMED_KEY,
  FEEDBACK_PROVIDER_SETTING,
  PROVIDER_SETTING_UNREGISTERED,
  clearKnownIssueCache,
} from '../../src/services/feedbackAnalysisService';
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
  // No hosted tier unless a test asks for one, whatever endpoint this build
  // ships. These assertions are about the payload the provider sends, not about
  // whether a proxy happens to be deployed.
  setHostedAnalysisTargetForTests({ endpoint: '', model: '', provider: '' });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  setHostedAnalysisTargetForTests(null);
  // One test stubs the global fetch so the duplicate check never reaches the
  // network; unstub here so a failure inside it cannot leak into the next file.
  vi.unstubAllGlobals();
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
          stage: 'logical',
          modelCount: 4, relationshipCount: 3, schemaVersion: 5,
        },
      },
    });

    await vi.waitFor(() => expect(types(panel)).toContain('feedbackContext'));
    const payload = lastOf(panel, 'feedbackContext');
    expect(payload.diagnostics.text.startsWith('ERD Studio: ')).toBe(true);
    expect(payload.diagnostics.text).toContain('Canvas:     stage=logical');
    // The canvas contributes its shape, never its name.
    expect(payload.diagnostics.text).not.toContain('showcase');
    expect(payload.diagnostics.chips[0]).toEqual({ label: 'ERD Studio 0.0.0-test', tone: 'normal' });
    expect(payload.diagnostics.chips.some((c: { tone: string }) => c.tone === 'error')).toBe(true);
    expect(payload.capabilities).toMatchObject({
      extensionVersion: '0.0.0-test',
      aiAvailable: false,
      aiProviderLabel: null,
      aiProvider: 'vscode',
      aiNeedsPriming: false,
      githubHandle: null,
    });
    // The picker is always listed, whatever resolves — a pinned destination
    // that is unavailable here has to leave a visible way back.
    expect(payload.capabilities.aiOptions.map((o: { id: string }) => o.id)).toEqual([
      'vscode',
      'hosted',
    ]);
    expect(payload.capabilities.aiOptions.every((o: { available: boolean }) => !o.available)).toBe(
      true,
    );
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

  it('reports the AI provider when one is configured, and that it needs priming', async () => {
    vscode._setMockConfiguration('erdStudio', FEEDBACK_AI_ASSIST_SETTING, { globalValue: true });
    vscode._setMockLanguageModels([{ id: 'gpt-4o', name: 'GPT-4o', reply: '{}' }]);
    const { panel } = await openShowcase(root);

    panel._simulateMessage({ type: 'requestFeedbackContext', payload: {} });

    await vi.waitFor(() => expect(types(panel)).toContain('feedbackContext'));
    expect(lastOf(panel, 'feedbackContext').capabilities).toMatchObject({
      aiAvailable: true,
      aiProviderLabel: 'Copilot',
      // Nothing has been asked for on this machine yet, so the dialog offers
      // its button rather than firing on the debounce.
      aiNeedsPriming: true,
    });
  });

  it('stops asking for a click once a language-model request has succeeded', async () => {
    vscode._setMockConfiguration('erdStudio', FEEDBACK_AI_ASSIST_SETTING, { globalValue: true });
    vscode._setMockLanguageModels([{ id: 'gpt-4o', name: 'GPT-4o', reply: '{}' }]);
    const { panel, context } = await openShowcase(root);
    await context.globalState.update(FEEDBACK_LM_PRIMED_KEY, true);

    panel._simulateMessage({ type: 'requestFeedbackContext', payload: {} });

    await vi.waitFor(() => expect(types(panel)).toContain('feedbackContext'));
    expect(lastOf(panel, 'feedbackContext').capabilities).toMatchObject({
      aiAvailable: true,
      aiNeedsPriming: false,
    });
  });

  it('still answers when the host has no GitHub authentication provider', async () => {
    // Losing the diagnostics disclosure and the whole dialog because a
    // decorative handle could not be read would be absurd.
    vscode._setMockAuthError(new Error('No authentication provider "github" registered.'));
    const { panel } = await openShowcase(root);

    panel._simulateMessage({ type: 'requestFeedbackContext', payload: {} });

    await vi.waitFor(() => expect(types(panel)).toContain('feedbackContext'));
    expect(lastOf(panel, 'feedbackContext').capabilities).toMatchObject({
      githubHandle: null,
      aiProvider: 'vscode',
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

  it('replies without waiting for the comment notification to be dismissed', async () => {
    // The dialog disables Cancel, Escape and the backdrop until this reply
    // lands, and a notification is free to sit there until the user deals with
    // it — so the reply must not be behind one.
    const { panel } = await openShowcase(root);
    vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(true);
    vi.spyOn(vscode.env.clipboard, 'writeText').mockResolvedValue(undefined);
    const info = vi
      .spyOn(vscode.window, 'showInformationMessage')
      .mockReturnValue(new Promise(() => {}) as Promise<undefined>);

    panel._simulateMessage({
      type: 'submitFeedback',
      payload: validSubmit({ commentOnIssue: 42 }),
    });

    await vi.waitFor(() =>
      expect(lastOf(panel, 'feedbackSubmitted')).toEqual({ ok: true, commentedOn: 42 }),
    );
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

  it('writes nothing to disk and raises no image notification — nothing is attached', async () => {
    // The old flow saved the capture under global storage as the fallback for
    // a refused clipboard. With no capture there is no folder, no file and no
    // notification explaining which of the two hand-offs the user got.
    const { panel } = await openShowcase(root);
    vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(true);
    const info = vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);

    panel._simulateMessage({ type: 'submitFeedback', payload: validSubmit() });

    await vi.waitFor(() => expect(lastOf(panel, 'feedbackSubmitted')).toEqual({ ok: true }));
    expect(fs.existsSync(path.join(root, '.global-storage', 'feedback'))).toBe(false);
    expect(info).not.toHaveBeenCalled();
  });

  it('ignores an attachments array a stale webview still sends', async () => {
    // An older bundle against a newer host must still be able to file: the
    // field is simply not read any more, not a validation failure.
    const { panel } = await openShowcase(root);
    const open = vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(true);

    panel._simulateMessage({
      type: 'submitFeedback',
      payload: validSubmit({
        attachments: [{ id: 'canvas', name: 'canvas.png', mime: 'image/png' }],
      }),
    });

    await vi.waitFor(() => expect(lastOf(panel, 'feedbackSubmitted')).toEqual({ ok: true }));
    expect(String(open.mock.calls[0][0])).not.toContain('screenshot');
    expect(fs.existsSync(path.join(root, '.global-storage', 'feedback'))).toBe(false);
  });
});

describe('setFeedbackProvider', () => {
  /**
   * What a window that has scanned this version's manifest looks like: the
   * setting is contributed with `"default": "auto"`, so it inspects to a
   * defined default. The mock starts blank, which is the *other* state — see
   * the stale-manifest test at the end of this block.
   */
  function registerProviderSetting(): void {
    vscode._setMockConfiguration('erdStudio', FEEDBACK_PROVIDER_SETTING, {
      defaultValue: 'auto',
    });
  }

  it('pins the destination globally and answers with a fresh context', async () => {
    registerProviderSetting();
    // Someone with Copilot could not previously reach any other destination —
    // the resolver tried theirs first and stopped.
    vscode._setMockConfiguration('erdStudio', FEEDBACK_AI_ASSIST_SETTING, { globalValue: true });
    vscode._setMockLanguageModels([{ id: 'gpt-4o', name: 'GPT-4o', reply: '{}' }]);
    setHostedAnalysisTargetForTests({
      endpoint: 'https://relay.example',
      model: 'm',
      provider: 'ExampleAI',
    });
    const { panel } = await openShowcase(root);

    panel._simulateMessage({ type: 'requestFeedbackContext', payload: {} });
    await vi.waitFor(() => expect(types(panel)).toContain('feedbackContext'));
    expect(lastOf(panel, 'feedbackContext').capabilities.aiProviderLabel).toBe('Copilot');

    panel._simulateMessage({ type: 'setFeedbackProvider', payload: { provider: 'hosted' } });

    await vi.waitFor(() =>
      expect(lastOf(panel, 'feedbackContext').capabilities.aiProvider).toBe('hosted'),
    );
    const capabilities = lastOf(panel, 'feedbackContext').capabilities;
    expect(capabilities.aiAvailable).toBe(true);
    expect(capabilities.aiProviderLabel).toBe('relay.example \u2192 ExampleAI');
    // The pin is a user decision, so it is written to the global target — a
    // workspace value would be read by nothing (the key is user-scoped).
    expect(
      vscode.workspace.getConfiguration('erdStudio').inspect('feedback.provider')?.globalValue,
    ).toBe('hosted');
  });

  it('resolves to no tier rather than falling back when the pin is unavailable', async () => {
    // Falling through would send the text to a destination the user pinned
    // away from, which is the whole thing the pin exists to prevent.
    registerProviderSetting();
    vscode._setMockConfiguration('erdStudio', FEEDBACK_AI_ASSIST_SETTING, { globalValue: true });
    vscode._setMockLanguageModels([{ id: 'gpt-4o', name: 'GPT-4o', reply: '{}' }]);
    const { panel } = await openShowcase(root);

    panel._simulateMessage({ type: 'setFeedbackProvider', payload: { provider: 'endpoint' } });

    await vi.waitFor(() =>
      expect(lastOf(panel, 'feedbackContext').capabilities.aiProvider).toBe('endpoint'),
    );
    const capabilities = lastOf(panel, 'feedbackContext').capabilities;
    expect(capabilities.aiAvailable).toBe(false);
    expect(capabilities.aiProviderLabel).toBeNull();
    // …but the picker still lists the model that IS here, so there is a way back.
    expect(capabilities.aiOptions.find((o: { id: string }) => o.id === 'vscode').available).toBe(
      true,
    );
  });

  it('refuses an unknown destination rather than coercing it to auto', async () => {
    registerProviderSetting();
    const { panel } = await openShowcase(root);

    panel._simulateMessage({ type: 'setFeedbackProvider', payload: { provider: 'copilot' } });

    await vi.waitFor(() => expect(lastError(panel)).toBeDefined());
    expect(lastError(panel)).toMatch(/^Failed to switch the analysis provider: /);
    expect(
      vscode.workspace.getConfiguration('erdStudio').inspect('feedback.provider')?.globalValue,
    ).toBeUndefined();
  });

  it('asks for a window reload when the update left this window on the old manifest', async () => {
    // No `registerProviderSetting()`: the extension host is running the new
    // code — which is the only reason the picker exists — while the window
    // still holds the previous version's manifest, so VS Code would reject the
    // write with "is not a registered configuration". That text names neither
    // the cause nor the fix, and the user did not cause it.
    const { panel } = await openShowcase(root);

    panel._simulateMessage({ type: 'setFeedbackProvider', payload: { provider: 'vscode' } });

    await vi.waitFor(() => expect(lastError(panel)).toBeDefined());
    expect(lastError(panel)).toBe(PROVIDER_SETTING_UNREGISTERED);
    expect(lastError(panel)).toMatch(/Reload the window/);
    // Nothing is written, so the picker still reflects what is actually stored.
    expect(
      vscode.workspace.getConfiguration('erdStudio').inspect('feedback.provider')?.globalValue,
    ).toBeUndefined();
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

  it('rejects an unrecognised trigger rather than reading it as a user action', async () => {
    const { panel } = await openShowcase(root);

    panel._simulateMessage({
      type: 'analyzeFeedback',
      payload: { requestId: 3, kind: 'bug', description: 'It vanished.', trigger: 'yes' },
    });

    await vi.waitFor(() => expect(lastError(panel)).toBeDefined());
    expect(lastError(panel)).toMatch(/trigger must be/);
    expect(types(panel)).not.toContain('feedbackAnalysis');
  });

  it('carries the trigger through: a debounce is declined before priming, a click is not', async () => {
    vscode._setMockConfiguration('erdStudio', FEEDBACK_AI_ASSIST_SETTING, { globalValue: true });
    vscode._setMockLanguageModels([
      {
        id: 'gpt-4o',
        name: 'GPT-4o',
        reply: JSON.stringify({
          kind: 'bug',
          confidence: 0.8,
          title: 'Edge vanished',
          context: '',
          reasons: {},
          duplicates: [],
        }),
      },
    ]);
    // The provider injects no fetch, so the duplicate check would reach the
    // real GitHub. Answer it with an empty list instead of touching the network.
    clearKnownIssueCache();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, text: async () => '[]' })),
    );
    const { panel, context } = await openShowcase(root);
    const description = 'Renamed a model and the edge vanished from the canvas.';

    panel._simulateMessage({
      type: 'analyzeFeedback',
      payload: { requestId: 1, kind: 'bug', description, trigger: 'debounce' },
    });
    await vi.waitFor(() => expect(lastOf(panel, 'feedbackAnalysis')?.requestId).toBe(1));
    expect(lastOf(panel, 'feedbackAnalysis').analysis).toBeNull();
    expect(context.globalState.get(FEEDBACK_LM_PRIMED_KEY)).toBeUndefined();

    panel._simulateMessage({
      type: 'analyzeFeedback',
      payload: { requestId: 2, kind: 'bug', description, trigger: 'user' },
    });
    await vi.waitFor(() => expect(lastOf(panel, 'feedbackAnalysis')?.requestId).toBe(2));
    expect(lastOf(panel, 'feedbackAnalysis').analysis?.title).toBe('Edge vanished');
    expect(context.globalState.get(FEEDBACK_LM_PRIMED_KEY)).toBe(true);
  });
});

describe('copyFeedbackReport', () => {
  it('writes the Markdown report to the clipboard', async () => {
    const { panel } = await openShowcase(root);
    const write = vi.spyOn(vscode.env.clipboard, 'writeText').mockResolvedValue(undefined);
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined);

    panel._simulateMessage({ type: 'copyFeedbackReport', payload: validSubmit() });

    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    const report = String(write.mock.calls[0][0]);
    expect(report).toContain('# Edge vanished after rename');
    expect(report).toContain('## What happened?');
    expect(report).toContain('## Diagnostics');
    expect(report).not.toContain('## Attachments');
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
