/**
 * Send Feedback's own failures and the save-and-reload prompt (#285): no
 * failure ends silently, none shows a raw exception, and each says what to
 * do next. Rows follow the issue's numbering.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { activate, _resetFirstRunGuardForTests } from '../../src/extension';
import { submitFeedback } from '../../src/services/feedbackService';
import { clearFeedbackApiKey, setFeedbackApiKey } from '../../src/services/feedbackAnalysisService';
import { saveAllAndReload } from '../../src/services/recoveryService';
import { unsavedFilesMessage } from '../../src/services/commandErrors';
import type { FeedbackDraft } from '../../src/types/feedback';

const REPO_ROOT = path.resolve(__dirname, '../..');
const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf-8'));
const GH_FAIL = "ERD Studio couldn't open your report on GitHub. This is a problem in ERD Studio, not something you did.";

let root: string;
let clipboard: string;

function ctx(): vscode.ExtensionContext {
  return vscode.createMockExtensionContext({ storageRoot: root, extensionRoot: REPO_ROOT, packageJSON: packageJson }) as unknown as vscode.ExtensionContext;
}
const draft = (o: Partial<FeedbackDraft> = {}): FeedbackDraft =>
  ({ kind: 'bug', title: 'Edge vanished', description: 'Renamed dim_task and the edge went', includeDiagnostics: false, ...o });
const errorCalls = () => vi.mocked(vscode.window.showErrorMessage).mock.calls;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'erd-285-'));
  clipboard = '';
  vi.restoreAllMocks();
  vi.spyOn(vscode.env.clipboard, 'writeText').mockImplementation(async (t: string) => { clipboard = t; });
  vi.spyOn(vscode.window, 'showErrorMessage').mockResolvedValue(undefined as never);
  vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined as never);
  vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as never);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('row 1: palette Send Feedback, submit fails', () => {
  let context: vscode.ExtensionContext;
  beforeEach(() => {
    context = ctx();
    vscode._resetRegisteredCommands();
    vscode._resetMockConfiguration();
    vscode._resetMockWorkspace();
    vscode.workspace.workspaceFolders = [];
    vscode.window.tabGroups.all = [];
    _resetFirstRunGuardForTests();
    vi.stubEnv('HOME', root);
    vi.stubEnv('USERPROFILE', root);
  });
  afterEach(async () => {
    for (const s of [...context.subscriptions].reverse()) { try { await s.dispose(); } catch { /* */ } }
    vi.unstubAllEnvs();
  });

  it('shows an error with Open GitHub Issues / Try Again and keeps the text on the clipboard', async () => {
    await activate(context);
    vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue('Report a bug' as never);
    vi.spyOn(vscode.window, 'showInputBox')
      .mockResolvedValueOnce('Palette title typed by user')
      .mockResolvedValueOnce('Palette description typed by user');
    // openExternal throwing (e.g. no xdg-open) lands in submitFeedback's catch.
    vi.spyOn(vscode.env, 'openExternal').mockRejectedValue(new Error('spawn xdg-open ENOENT'));
    errorCalls().length = 0;

    await vscode.commands.executeCommand('erdStudio.reportBug');

    const shown = errorCalls().find(([m]) => String(m).includes(GH_FAIL));
    expect(shown, `error toasts: ${JSON.stringify(errorCalls())}`).toBeDefined();
    expect(shown).toEqual(expect.arrayContaining(['Open GitHub Issues', 'Try Again']));
    expect(clipboard).toContain('Palette title typed by user');
    expect(clipboard).toContain('Palette description typed by user');
    expect(String(shown?.[0])).toContain('Your text has been copied to the clipboard.');
    expect(errorCalls().flat().join(' ')).not.toContain('ENOENT');
  });

  it('never claims the text was copied when the clipboard refused it', async () => {
    await activate(context);
    vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue('Report a bug' as never);
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValueOnce('T').mockResolvedValueOnce('D');
    vi.spyOn(vscode.env, 'openExternal').mockRejectedValue(new Error('boom'));
    vi.spyOn(vscode.env.clipboard, 'writeText').mockRejectedValue(new Error('no clipboard'));
    errorCalls().length = 0;

    await vscode.commands.executeCommand('erdStudio.reportBug');

    const shown = errorCalls().find(([m]) => String(m).includes(GH_FAIL));
    expect(shown).toBeDefined();
    expect(String(shown?.[0])).not.toContain('copied');
  });

  it('a browser that will not open shows one error, its own, and leaves the clipboard alone', async () => {
    await activate(context);
    vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue('Report a bug' as never);
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValueOnce('T').mockResolvedValueOnce('D');
    vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(false);
    errorCalls().length = 0;

    await vscode.commands.executeCommand('erdStudio.reportBug');

    expect(errorCalls()).toHaveLength(1);
    expect(String(errorCalls()[0][0])).toBe("ERD Studio couldn't open your browser.");
    expect(clipboard).toBe('');
  });

  it('Try Again asks again, with what the user typed already filled in', async () => {
    await activate(context);
    vi.spyOn(vscode.window, 'showQuickPick').mockResolvedValue('Report a bug' as never);
    const input = vi.spyOn(vscode.window, 'showInputBox')
      .mockResolvedValueOnce('Typed title').mockResolvedValueOnce('Typed text')
      .mockResolvedValue(undefined);
    vi.spyOn(vscode.env, 'openExternal').mockRejectedValue(new Error('boom'));
    vi.mocked(vscode.window.showErrorMessage).mockResolvedValueOnce('Try Again' as never);

    await vscode.commands.executeCommand('erdStudio.reportBug');

    await vi.waitFor(() => expect(input).toHaveBeenCalledTimes(3));
    expect(input.mock.calls[2][0]).toEqual(expect.objectContaining({ value: 'Typed title' }));
  });
});

describe('row 2: canvas dialog never sees a raw err.message', () => {
  it('returns the plain sentence, not the exception text', async () => {
    vi.spyOn(vscode.env, 'openExternal').mockRejectedValue(new Error('spawn xdg-open ENOENT'));
    const r = await submitFeedback(ctx(), draft());
    expect(r.ok).toBe(false);
    expect(r.error).not.toContain('ENOENT');
    expect(r.error).toContain(GH_FAIL);
  });
});

describe('row 3: openExternal false, new issue', () => {
  it('says the browser could not open, no URL in the text, Copy Link + Copy Report', async () => {
    vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(false);
    await submitFeedback(ctx(), draft());
    const [msg, ...buttons] = errorCalls()[0] ?? [];
    expect(String(msg)).toContain("ERD Studio couldn't open your browser.");
    expect(String(msg)).not.toContain('https://github.com');
    expect(buttons).toEqual(['Copy Link', 'Copy Report']);
  });

  it('Copy Report puts the Markdown report on the clipboard; the dialog gets the same sentence', async () => {
    vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(false);
    vi.mocked(vscode.window.showErrorMessage).mockResolvedValueOnce('Copy Report' as never);
    const r = await submitFeedback(ctx(), draft());
    expect(r).toEqual({ ok: false, error: "ERD Studio couldn't open your browser.", failure: 'browser' });
    await vi.waitFor(() => expect(clipboard).toContain('Renamed dim_task and the edge went'));
    expect(clipboard).not.toContain('https://github.com');
  });

  it('returns while the toast is still up (the dialog waits on it)', async () => {
    vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(false);
    vi.mocked(vscode.window.showErrorMessage).mockReturnValue(new Promise(() => {}) as never);
    await expect(submitFeedback(ctx(), draft())).resolves.toMatchObject({ ok: false });
  });
});

describe('row 4: openExternal false, comment on #N', () => {
  it('points at the clipboard and #N, never says "file the issue"', async () => {
    vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(false);
    await submitFeedback(ctx(), draft({ commentOnIssue: 42 }));
    const [msg, ...buttons] = errorCalls()[0] ?? [];
    expect(String(msg)).not.toContain('file the issue');
    expect(String(msg)).toContain("ERD Studio couldn't open your browser. Your report is on the clipboard: paste it as a comment on #42.");
    expect(buttons).toEqual(['Copy Link Instead']);
  });

  it('Copy Link Instead replaces the report with the link, and says so', async () => {
    vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(false);
    vi.mocked(vscode.window.showErrorMessage).mockResolvedValueOnce('Copy Link Instead' as never);
    await submitFeedback(ctx(), draft({ commentOnIssue: 42 }));
    await vi.waitFor(() => expect(clipboard).toBe('https://github.com/liam-machine/erd-studio/issues/42#issuecomment-new'));
    expect(vi.mocked(vscode.window.showInformationMessage)).toHaveBeenCalledWith(expect.stringContaining('in place of the report'));
  });
});

describe('row 5: secret storage unavailable', () => {
  const KEY_FAIL = "ERD Studio couldn't save the API key: VS Code's secret storage isn't available on this machine. Feedback still works without a key.";
  it('store rejects', async () => {
    const c = ctx();
    vi.spyOn(c.secrets, 'store').mockRejectedValue(new Error('No keyring'));
    vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('sk-test');
    await setFeedbackApiKey(c);
    const [msg, ...buttons] = errorCalls()[0] ?? [];
    expect(msg).toBe(KEY_FAIL);
    expect(buttons).toEqual(['Learn More']);
  });
  it('delete rejects', async () => {
    const c = ctx();
    vi.spyOn(c.secrets, 'delete').mockRejectedValue(new Error('No keyring'));
    await clearFeedbackApiKey(c);
    const [msg, ...buttons] = errorCalls()[0] ?? [];
    expect(msg).toBe("ERD Studio couldn't clear the API key: VS Code's secret storage isn't available on this machine.");
    expect(buttons).toEqual(['Learn More']);
  });
  it('Learn More opens the fixed troubleshooting page', async () => {
    const c = ctx();
    vi.spyOn(c.secrets, 'delete').mockRejectedValue(new Error('No keyring'));
    vi.mocked(vscode.window.showErrorMessage).mockResolvedValueOnce('Learn More' as never);
    const open = vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(true);
    await clearFeedbackApiKey(c);
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    expect(String(open.mock.calls[0][0])).toMatch(/^https:\/\/code\.visualstudio\.com\/docs\//);
  });
});

describe('row 6: reload with unsaveable files', () => {
  it('modal names the files, offers Show Files, Cancel returns false without reloading', async () => {
    const doc = (p: string) => ({ isDirty: true, isUntitled: false, uri: vscode.Uri.file(p), fileName: p });
    (vscode.workspace as unknown as { textDocuments: unknown[] }).textDocuments =
      [doc('/p/models/orders.sql'), doc('/p/models/schema.yml')];
    const exec = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
    const warn = vi.mocked(vscode.window.showWarningMessage);

    await expect(saveAllAndReload('test')).resolves.toBe(false);
    expect(exec).not.toHaveBeenCalledWith('workbench.action.reloadWindow');
    const [msg, opts, ...buttons] = warn.mock.calls[0] ?? [];
    expect(String(msg)).toContain('orders.sql');
    expect(String(msg)).toContain('schema.yml');
    expect(opts).toEqual(expect.objectContaining({ modal: true }));
    expect(buttons).toEqual(['Show Files', 'Reload Anyway']);
    expect(String(msg)).toBe("orders.sql and schema.yml couldn't be saved. Reload anyway? Unsaved changes will be lost.");
  });

  it('Show Files opens the first unsaved file and does not reload', async () => {
    const first = { isDirty: true, isUntitled: false, uri: vscode.Uri.file('/p/a.sql') };
    (vscode.workspace as unknown as { textDocuments: unknown[] }).textDocuments = [first];
    const exec = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
    vi.mocked(vscode.window.showWarningMessage).mockResolvedValueOnce('Show Files' as never);
    const show = vi.spyOn(vscode.window, 'showTextDocument');

    await expect(saveAllAndReload('test')).resolves.toBe(false);
    expect(show).toHaveBeenCalledWith(first, expect.anything());
    expect(exec).not.toHaveBeenCalledWith('workbench.action.reloadWindow');
  });

  it('two files with the same name are told apart by their folder', async () => {
    vscode.workspace.workspaceFolders = [{ uri: { fsPath: '/p' } }];
    const doc = (p: string) => ({ isDirty: true, isUntitled: false, uri: vscode.Uri.file(p) });
    (vscode.workspace as unknown as { textDocuments: unknown[] }).textDocuments =
      [doc('/p/staging/schema.yml'), doc('/p/marts/schema.yml')];
    vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);
    await saveAllAndReload('test');
    expect(String(vi.mocked(vscode.window.showWarningMessage).mock.calls[0][0]))
      .toMatch(/^staging\/schema\.yml and marts\/schema\.yml couldn't be saved/);
    vscode.workspace.workspaceFolders = [];
  });

  it('names up to three files, then counts the rest', () => {
    expect(unsavedFilesMessage(['a'])).toMatch(/^a couldn't be saved/);
    expect(unsavedFilesMessage(['a', 'b', 'c'])).toMatch(/^a, b and c couldn't/);
    expect(unsavedFilesMessage(['a', 'b', 'c', 'd', 'e'])).toMatch(/^a, b, c and 2 more couldn't/);
  });
});
