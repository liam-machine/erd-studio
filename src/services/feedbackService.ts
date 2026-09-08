/**
 * FeedbackService — bug reports and feature requests.
 *
 * Builds a prefilled GitHub *issue form* URL (`.github/ISSUE_TEMPLATE/bug_report.yml`
 * or `feature_request.yml`, chosen by {@link FeedbackKind}) from the user's
 * description plus automatically collected diagnostics, and opens it in the
 * browser. The user reviews everything on GitHub before anything is submitted —
 * nothing is sent from the extension itself, so no GitHub token or scope is
 * needed. There is deliberately no "file it from here" path.
 *
 * Images: the report carries none, and the extension captures none. GitHub has
 * no API for attaching an image to a prefilled issue form, so anything the
 * extension grabbed could only be handed back to the user to paste on
 * github.com themselves — the job they already have, done twice, plus a
 * clipboard that is allowed to refuse and a file left on disk to explain. The
 * issue form keeps its Screenshot box and the dialog says once where images go
 * (`FEEDBACK_IMAGE_NOTE` in `src/types/feedback.ts`); that is the whole of it.
 *
 * The pure helpers (`formatDiagnostics`, `buildIssueUrl`, `composeFeedbackFields`,
 * `composeMarkdownReport`, `ErrorLog`) have no VS Code dependency so they are
 * unit-testable; the VS Code-facing functions live at the bottom of the file.
 */

import * as vscode from 'vscode';

import {
  applyRegressionPrefix,
  type FeedbackDiagnosticsChip,
  type FeedbackDiagnosticsView,
  type FeedbackDraft,
  type FeedbackKind,
} from '../types/feedback';

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
  /**
   * Present when a domain canvas was active when the report was opened.
   *
   * The domain's **name and layer are deliberately absent**. "gold/commercial"
   * is the user's own business vocabulary, it identifies a project the
   * maintainer has no access to and cannot act on, and it bought nothing a bug
   * report needs. What is left is the shape of the thing that broke — which
   * stage was on screen, how big the graph was — and that is diagnostic.
   */
  domain?: {
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
      `Canvas:     stage=${d.domain.stage}` +
        `${d.domain.schemaVersion != null ? `, schemaVersion=${d.domain.schemaVersion}` : ''}`,
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
  return fields;
}

/** Issue form template file name for feature requests. */
export const FEATURE_REQUEST_TEMPLATE = 'feature_request.yml';

/** Issue-form template file for a kind. */
export function templateForKind(kind: FeedbackKind): string {
  return kind === 'feature' ? FEATURE_REQUEST_TEMPLATE : BUG_REPORT_TEMPLATE;
}

/** Default issue title when the user left it blank. */
export function defaultTitleForKind(kind: FeedbackKind): string {
  return kind === 'feature' ? 'Feature request' : 'Bug report';
}

/** Issue-form field id the context field maps to. */
export function contextFieldForKind(kind: FeedbackKind): 'steps' | 'rationale' {
  return kind === 'feature' ? 'rationale' : 'steps';
}

/** Truncation order for buildIssueUrl, most expendable first. */
export function truncationOrderForKind(kind: FeedbackKind): string[] {
  return ['diagnostics', contextFieldForKind(kind), 'description'];
}

/** Heading the description sits under, matching the issue form's label. */
const DESCRIPTION_HEADING: Readonly<Record<FeedbackKind, string>> = {
  bug: 'What happened?',
  feature: 'What would you like to be able to do?',
};

/** Heading the context field sits under, matching the issue form's label. */
const CONTEXT_HEADING: Readonly<Record<FeedbackKind, string>> = {
  bug: 'Steps to reproduce',
  feature: 'Why do you want it?',
};

/** The title as it will be filed: trimmed, defaulted, and regression-prefixed. */
function resolveFeedbackTitle(draft: FeedbackDraft): string {
  const title = draft.title.trim() || defaultTitleForKind(draft.kind);
  return draft.regressionOf != null ? applyRegressionPrefix(title) : title;
}

/**
 * Compose the issue-form fields for a feedback draft. Delegates the shared part
 * to {@link composeIssueFields} (a `FeedbackDraft` is a structural superset of a
 * `BugReportDraft`), then applies what is kind-specific: the default title, the
 * regression prefix, and `steps` → `rationale` for a feature request.
 *
 * The bug form's `screenshot` field is left **empty** rather than prefilled.
 * Nothing is attached from the extension, so any text there would be an
 * instruction sitting in a box the user has to clear before they can drop an
 * image into it. The dialog says where images go before the browser opens.
 */
export function composeFeedbackFields(
  draft: FeedbackDraft,
  diagnostics: Diagnostics | null,
): Record<string, string> {
  const base = composeIssueFields(draft, diagnostics);

  const fields: Record<string, string> = {
    title: resolveFeedbackTitle(draft),
    description: base.description,
  };
  if (base.steps) fields[contextFieldForKind(draft.kind)] = base.steps;
  if (base.diagnostics) fields.diagnostics = base.diagnostics;
  return fields;
}

/**
 * The whole report as Markdown, for the "Copy report" button and for the
 * comment posted on an existing thread. Sections with no content are omitted.
 */
export function composeMarkdownReport(
  draft: FeedbackDraft,
  diagnostics: Diagnostics | null,
): string {
  const sections: string[] = [`# ${resolveFeedbackTitle(draft)}`];

  if (diagnostics) {
    sections.push(
      `_${defaultTitleForKind(draft.kind)} · ERD Studio ${diagnostics.extensionVersion}_`,
    );
  }

  const description = draft.description.trim();
  if (description) {
    sections.push(`## ${DESCRIPTION_HEADING[draft.kind]}`, description);
  }

  const context = draft.steps?.trim();
  if (context) {
    sections.push(`## ${CONTEXT_HEADING[draft.kind]}`, context);
  }

  if (diagnostics && draft.includeDiagnostics) {
    sections.push('## Diagnostics', ['```', formatDiagnostics(diagnostics), '```'].join('\n'));
  }

  return sections.join('\n\n');
}

/**
 * Diagnostics chips for the dialog. Deliberately coarser than
 * {@link formatDiagnostics}: no file paths, and nothing that names the user's
 * project — the canvas contributes its stage and its size, never its
 * identity.
 */
export function buildDiagnosticsChips(d: Diagnostics): FeedbackDiagnosticsChip[] {
  const chips: FeedbackDiagnosticsChip[] = [
    { label: `ERD Studio ${d.extensionVersion}`, tone: 'normal' },
    { label: `VS Code ${d.vscodeVersion}`, tone: 'normal' },
    { label: `${d.platform} ${d.arch}`, tone: 'normal' },
  ];
  if (d.domain) {
    chips.push({
      label:
        `${d.domain.stage} · ${d.domain.modelCount} model${d.domain.modelCount === 1 ? '' : 's'}` +
        ` · ${d.domain.relationshipCount} relationship${d.domain.relationshipCount === 1 ? '' : 's'}`,
      tone: 'normal',
    });
  }
  const errors = d.hostErrors.length + d.webviewErrors.length;
  if (errors > 0) {
    chips.push({ label: `${errors} recent error${errors === 1 ? '' : 's'}`, tone: 'error' });
  }
  return chips;
}

/** The dialog-facing view of diagnostics: chips plus the verbatim text. */
export function buildDiagnosticsView(d: Diagnostics): FeedbackDiagnosticsView {
  return { chips: buildDiagnosticsChips(d), text: formatDiagnostics(d) };
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
 * The whole submit path: open the prefilled GitHub issue form, or — when
 * `draft.commentOnIssue` is set — put the Markdown report on the clipboard and
 * open that thread's comment box. Nothing is filed from here; the user presses
 * Submit on GitHub.
 *
 * No images are involved in either branch. The extension attaches none, so
 * there is no clipboard write to succeed or fail, no folder to reveal and no
 * notification whose whole job was to explain which of those happened.
 *
 * Never throws: failures are recorded on `hostErrorLog` and returned so the
 * dialog can un-stick its primary button.
 */
export async function submitFeedback(
  context: vscode.ExtensionContext,
  draft: FeedbackDraft,
  domain?: Diagnostics['domain'],
): Promise<{ ok: boolean; commentedOn?: number; error?: string }> {
  try {
    const diagnostics = draft.includeDiagnostics
      ? collectDiagnostics(context, domain, draft.webviewErrors ?? [])
      : null;
    const commentOn = draft.commentOnIssue;

    if (commentOn != null) {
      await vscode.env.clipboard.writeText(composeMarkdownReport(draft, diagnostics));
      const url = `https://github.com/${GITHUB_REPO}/issues/${commentOn}#issuecomment-new`;
      const opened = await vscode.env.openExternal(vscode.Uri.parse(url));
      if (!opened) {
        void vscode.window.showErrorMessage(
          'ERD Studio: could not open the browser. Copy this link to file the issue: ' + url,
        );
        return { ok: false, error: 'Could not open the browser.' };
      }
      // Deliberately not awaited: a notification carrying an action button is
      // sticky, and the dialog stays disabled until this function returns.
      void vscode.window.showInformationMessage(
        `ERD Studio: your report is on the clipboard — paste it as a comment on #${commentOn}.`,
      );
      return { ok: true, commentedOn: commentOn };
    }

    const url = buildIssueUrl(composeFeedbackFields(draft, diagnostics), {
      template: templateForKind(draft.kind),
      truncationOrder: truncationOrderForKind(draft.kind),
    });
    const opened = await vscode.env.openExternal(vscode.Uri.parse(url));
    if (!opened) {
      void vscode.window.showErrorMessage(
        'ERD Studio: could not open the browser. Copy this link to file the issue: ' + url,
      );
      return { ok: false, error: 'Could not open the browser.' };
    }
    return { ok: true };
  } catch (err) {
    hostErrorLog.record('submitFeedback', err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Write the whole report to the clipboard as Markdown. The escape hatch for
 * anyone who would rather paste it into an email, a chat or their own tracker —
 * it needs no network, no GitHub account and no model.
 */
export async function copyFeedbackReport(
  context: vscode.ExtensionContext,
  draft: FeedbackDraft,
  domain?: Diagnostics['domain'],
): Promise<void> {
  const diagnostics = draft.includeDiagnostics
    ? collectDiagnostics(context, domain, draft.webviewErrors ?? [])
    : null;
  await vscode.env.clipboard.writeText(composeMarkdownReport(draft, diagnostics));
  void vscode.window.showInformationMessage('ERD Studio: the report is on your clipboard.');
}

/** Collect diagnostics and package them for the dialog (chips + exact text). */
export function buildFeedbackContext(
  context: vscode.ExtensionContext,
  domain?: Diagnostics['domain'],
  webviewErrors?: string[],
): FeedbackDiagnosticsView {
  return buildDiagnosticsView(collectDiagnostics(context, domain, webviewErrors ?? []));
}
