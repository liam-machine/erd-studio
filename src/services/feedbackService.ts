/**
 * FeedbackService — "Report a Bug" support.
 *
 * Builds a prefilled GitHub *issue form* URL (`.github/ISSUE_TEMPLATE/bug_report.yml`)
 * from the user's description plus automatically collected diagnostics, and
 * opens it in the browser. The user reviews everything on GitHub before
 * anything is submitted — nothing is sent from the extension itself, so no
 * GitHub token or scope is needed.
 *
 * Screenshots: GitHub has no API for attaching images to issues, so the
 * webview copies the captured canvas PNG to the clipboard (and we save a copy
 * under globalStorage as a fallback). The user pastes it into the issue with
 * one keystroke.
 *
 * The pure helpers (`formatDiagnostics`, `buildIssueUrl`, `ErrorLog`) have no
 * VS Code dependency so they are unit-testable; the VS Code-facing functions
 * live at the bottom of the file.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** GitHub `owner/repo` that receives bug reports. */
export const GITHUB_REPO = 'liam-machine/erd-studio';

/** Issue form template file name under `.github/ISSUE_TEMPLATE/`. */
export const BUG_REPORT_TEMPLATE = 'bug_report.yml';

/**
 * Conservative ceiling for the prefilled URL. GitHub rejects very long query
 * strings (observed ~8 KB → HTTP 414), so we truncate the most verbose fields
 * to stay well below that.
 */
export const MAX_ISSUE_URL_LENGTH = 7000;

/** How many recent errors the ring buffer keeps. */
export const ERROR_LOG_CAPACITY = 20;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Snapshot of the environment captured when a report is created. */
export interface Diagnostics {
  extensionVersion: string;
  vscodeVersion: string;
  platform: string;
  arch: string;
  /** Present when a domain canvas was active when the report was opened. */
  domain?: {
    name: string;
    layer: string;
    stage: string;
    modelCount: number;
    relationshipCount: number;
    schemaVersion?: number;
  };
  /** Recent errors from the extension host, newest last. */
  hostErrors: string[];
  /** Recent errors observed by the webview (posted with the report), newest last. */
  webviewErrors: string[];
}

/** What the user typed into the dialog (or the command palette flow). */
export interface BugReportDraft {
  title: string;
  description: string;
  steps?: string;
  includeDiagnostics: boolean;
  /** PNG data URL of the canvas, if the user chose to include a screenshot. */
  screenshotDataUrl?: string;
  /** Whether the webview managed to place the PNG on the clipboard. */
  screenshotOnClipboard?: boolean;
  /** Why capture failed, when the user asked for a screenshot but none arrived. */
  screenshotError?: string;
  /** Errors the webview collected (from `error` messages and window errors). */
  webviewErrors?: string[];
}

// ---------------------------------------------------------------------------
// Error ring buffer
// ---------------------------------------------------------------------------

/**
 * Fixed-capacity log of recent error messages. One instance is shared across
 * the extension host (see `hostErrorLog`) so bug reports can include what
 * went wrong shortly before the user hit "Report".
 */
export class ErrorLog {
  private readonly entries: string[] = [];

  constructor(private readonly capacity = ERROR_LOG_CAPACITY) {}

  /** Record an error. Accepts anything `catch` can hand us. */
  record(source: string, error: unknown, now: Date = new Date()): void {
    const message = error instanceof Error ? error.message : String(error);
    const line = `${now.toISOString()} [${source}] ${message}`.replace(/\s+/g, ' ').trim();
    this.entries.push(line);
    while (this.entries.length > this.capacity) {
      this.entries.shift();
    }
  }

  /** Oldest → newest. */
  recent(): string[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries.length = 0;
  }
}

/** Shared host-side error log. */
export const hostErrorLog = new ErrorLog();

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Render diagnostics as plain text suitable for a `render: shell` form field. */
export function formatDiagnostics(d: Diagnostics): string {
  const lines: string[] = [
    `ERD Studio: ${d.extensionVersion}`,
    `VS Code:    ${d.vscodeVersion}`,
    `OS:         ${d.platform} ${d.arch}`,
  ];
  if (d.domain) {
    lines.push(
      `Domain:     ${d.domain.layer}/${d.domain.name} (stage=${d.domain.stage}` +
        `${d.domain.schemaVersion != null ? `, schemaVersion=${d.domain.schemaVersion}` : ''})`,
      `Models:     ${d.domain.modelCount}   Relationships: ${d.domain.relationshipCount}`,
    );
  }
  if (d.hostErrors.length > 0) {
    lines.push('', 'Recent extension errors:', ...d.hostErrors.map((e) => `  ${e}`));
  }
  if (d.webviewErrors.length > 0) {
    lines.push('', 'Recent canvas errors:', ...d.webviewErrors.map((e) => `  ${e}`));
  }
  return lines.join('\n');
}

/** Truncate `text` to `max` characters, appending a marker when cut. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = '\n…(truncated)';
  return text.slice(0, Math.max(0, max - marker.length)) + marker;
}

/**
 * Build the `issues/new` URL with issue-form fields prefilled via query
 * parameters (GitHub matches them to form field `id`s).
 *
 * Fields are added in the order given; if the result exceeds
 * `maxLength`, the fields listed in `truncationOrder` are shortened
 * one at a time (first entry first) until it fits.
 */
export function buildIssueUrl(
  fields: Record<string, string>,
  options: {
    repo?: string;
    template?: string;
    maxLength?: number;
    /** Field ids to truncate, most expendable first. */
    truncationOrder?: string[];
  } = {},
): string {
  const repo = options.repo ?? GITHUB_REPO;
  const template = options.template ?? BUG_REPORT_TEMPLATE;
  const maxLength = options.maxLength ?? MAX_ISSUE_URL_LENGTH;
  const truncationOrder = options.truncationOrder ?? ['diagnostics', 'steps', 'description'];

  const working: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value != null && value !== '') working[key] = value;
  }

  const render = (): string => {
    const params = new URLSearchParams({ template, ...working });
    return `https://github.com/${repo}/issues/new?${params.toString()}`;
  };

  let url = render();
  for (const key of truncationOrder) {
    if (url.length <= maxLength) break;
    if (!working[key]) continue;
    // Shrink this field by the overshoot (measured in encoded chars, so be
    // generous: encoded text is ~1–3× the raw length) and re-check.
    let attempts = 0;
    while (url.length > maxLength && working[key].length > 40 && attempts < 20) {
      const overshoot = url.length - maxLength;
      const cut = Math.max(40, Math.ceil(overshoot / 3) + 20);
      working[key] = truncate(working[key], Math.max(40, working[key].length - cut));
      url = render();
      attempts++;
    }
    if (url.length > maxLength) {
      delete working[key];
      url = render();
    }
  }
  return url;
}

/** Compose the form field values for a draft + diagnostics. */
export function composeIssueFields(
  draft: BugReportDraft,
  diagnostics: Diagnostics | null,
): Record<string, string> {
  const fields: Record<string, string> = {
    title: draft.title.trim() || 'Bug report',
    description: draft.description.trim(),
  };
  if (draft.steps?.trim()) fields.steps = draft.steps.trim();
  if (diagnostics && draft.includeDiagnostics) fields.diagnostics = formatDiagnostics(diagnostics);
  if (draft.screenshotDataUrl) {
    fields.screenshot = draft.screenshotOnClipboard
      ? 'A screenshot is on your clipboard — click here and press Ctrl+V / ⌘V to attach it.'
      : 'Drag the saved screenshot file here to attach it.';
  }
  return fields;
}

/** Decode a `data:image/png;base64,...` URL into bytes. Returns null if malformed. */
export function decodePngDataUrl(dataUrl: string): Buffer | null {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) return null;
  try {
    return Buffer.from(match[1], 'base64');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// VS Code-facing helpers
// ---------------------------------------------------------------------------

/** Collect environment diagnostics. `domain` is optional context from the active canvas. */
export function collectDiagnostics(
  context: vscode.ExtensionContext,
  domain?: Diagnostics['domain'],
  webviewErrors: string[] = [],
): Diagnostics {
  return {
    extensionVersion: String(context.extension.packageJSON.version ?? 'unknown'),
    vscodeVersion: vscode.version,
    platform: process.platform,
    arch: process.arch,
    domain,
    hostErrors: hostErrorLog.recent(),
    webviewErrors: webviewErrors.slice(-ERROR_LOG_CAPACITY),
  };
}

/**
 * Persist a screenshot PNG under global storage so the user can drag it into
 * the issue if the clipboard route failed. Returns the file URI, or null on
 * malformed input / write failure.
 */
export async function saveScreenshot(
  context: vscode.ExtensionContext,
  dataUrl: string,
): Promise<vscode.Uri | null> {
  const bytes = decodePngDataUrl(dataUrl);
  if (!bytes) return null;
  try {
    const dir = path.join(context.globalStorageUri.fsPath, 'bug-reports');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `erd-studio-${stamp}.png`);
    fs.writeFileSync(file, bytes);
    return vscode.Uri.file(file);
  } catch (err) {
    hostErrorLog.record('saveScreenshot', err);
    return null;
  }
}

/**
 * Open the prefilled GitHub issue in the browser and tell the user what to do
 * about the screenshot (if any).
 */
export async function submitBugReport(
  context: vscode.ExtensionContext,
  draft: BugReportDraft,
  domain?: Diagnostics['domain'],
): Promise<void> {
  const diagnostics = draft.includeDiagnostics
    ? collectDiagnostics(context, domain, draft.webviewErrors ?? [])
    : null;

  let screenshotUri: vscode.Uri | null = null;
  if (draft.screenshotDataUrl) {
    screenshotUri = await saveScreenshot(context, draft.screenshotDataUrl);
  }

  const url = buildIssueUrl(composeIssueFields(draft, diagnostics));
  const opened = await vscode.env.openExternal(vscode.Uri.parse(url));
  if (!opened) {
    void vscode.window.showErrorMessage(
      'ERD Studio: could not open the browser. Copy this link to file the issue: ' + url,
    );
    return;
  }

  // The user asked for a screenshot but capture failed — say so rather than
  // filing the report with a silently missing image.
  if (!draft.screenshotDataUrl) {
    if (draft.screenshotError) {
      void vscode.window.showWarningMessage(
        `ERD Studio: the screenshot could not be captured. ${draft.screenshotError}`,
      );
    }
    return;
  }

  const actions = screenshotUri ? ['Reveal Screenshot'] : [];
  const message = draft.screenshotOnClipboard
    ? 'ERD Studio: your screenshot is on the clipboard — paste it into the "Screenshot" box on GitHub.'
    : screenshotUri
      ? 'ERD Studio: the screenshot could not be copied to the clipboard. Drag the saved file into the GitHub issue.'
      : 'ERD Studio: the screenshot could not be captured. Take one with your OS screenshot tool and paste it into the issue.';
  const choice = await vscode.window.showInformationMessage(message, ...actions);
  if (choice === 'Reveal Screenshot' && screenshotUri) {
    await vscode.commands.executeCommand('revealFileInOS', screenshotUri);
  }
}
