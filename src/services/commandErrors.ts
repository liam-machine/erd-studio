/**
 * The words for a command that failed (#189): whose problem it is, and what
 * to do next. A failure the user can act on (a folder they may not write, a
 * full disk, a diagram file with a mistake in it) is said in plain words; any
 * other failure is ERD Studio's, so the user is told so, never shown the raw
 * exception, and offered Send Feedback with that exception in the report,
 * redacted.
 *
 * vscode-free, so the commands' choices are unit-tested without a host and
 * the canvas's #186 wording is shared rather than copied.
 */

import * as path from 'path';

import { SubjectAreaFileError, SubjectAreaValidationError, type JsonSyntaxProblem } from '@erd-studio/core';

import { redactPaths, type FeedbackKind } from '../types/feedback';
import { cutCrashDetail, type WebviewErrorArea } from '../types/webviewError';
import type { EditStage } from './editFailureStage';

/** The button that opens Send Feedback prefilled with the failure. */
export const SEND_FEEDBACK_BUTTON = 'Send Feedback';

/** The button that opens the user's file at the problem. */
export const OPEN_FILE_BUTTON = 'Open File';

/** The buttons the commands' errors share (#204, #219), so each says the same thing. */
export const TRY_AGAIN_BUTTON = 'Try Again';
export const SHOW_FILE_BUTTON = 'Show File';
export const SAVE_AND_TRY_AGAIN_BUTTON = 'Save and Try Again';
export const SAVE_ALL_BUTTON = 'Save All';
export const RELOAD_WINDOW_BUTTON = 'Reload Window';

/** Send Feedback's own failures (#285): the report must never vanish silently. */
export const OPEN_GITHUB_ISSUES_BUTTON = 'Open GitHub Issues';
export const COPY_LINK_BUTTON = 'Copy Link';
export const COPY_REPORT_BUTTON = 'Copy Report';
/** The comment path's report is already on the clipboard; the link replaces it. */
export const COPY_LINK_INSTEAD_BUTTON = 'Copy Link Instead';
export const LEARN_MORE_BUTTON = 'Learn More';
export const SHOW_FILES_BUTTON = 'Show Files';
export const RELOAD_ANYWAY_BUTTON = 'Reload Anyway';

/** Building or opening the report hit a bug of ours (never the raw exception). */
export function reportNotOpenedMessage(copied: boolean): string {
  return "ERD Studio couldn't open your report on GitHub. This is a problem in ERD Studio, not something you did."
    + (copied ? ' Your text has been copied to the clipboard.' : '');
}

/** VS Code could not open the browser for a new issue. */
export const BROWSER_NOT_OPENED_MESSAGE = "ERD Studio couldn't open your browser.";

/** A button's fixed page did not open: its address, to open by hand (never a prefilled link, which is too long to print). */
export function linkNotOpenedMessage(url: string): string {
  return `${BROWSER_NOT_OPENED_MESSAGE} The page is ${url}`;
}

/** VS Code could not open the browser for a comment; the report is already on the clipboard. */
export function commentBrowserNotOpenedMessage(issue: number): string {
  return `${BROWSER_NOT_OPENED_MESSAGE} Your report is on the clipboard: paste it as a comment on #${issue}.`;
}

/** The feedback API key could not be stored or cleared: usually the machine's keyring, not ERD Studio. */
export function secretStorageFailedMessage(action: 'save' | 'clear'): string {
  return `ERD Studio couldn't ${action} the API key: VS Code's secret storage isn't available on this machine.`
    + (action === 'save' ? ' Feedback still works without a key.' : '');
}

/**
 * Save All left files unsaved before a reload: name up to three of them, so
 * the user can tell what reloading would lose. `names` are as shown (base
 * names, or relative paths where base names collide).
 */
export function unsavedFilesMessage(names: readonly string[]): string {
  const shown = names.slice(0, 3);
  const more = names.length - shown.length;
  const list = more > 0
    ? `${shown.join(', ')} and ${more} more`
    : shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}` : shown[0] ?? 'Some files';
  return `${list} couldn't be saved. Reload anyway? Unsaved changes will be lost.`;
}

/** The buttons and words every way of making a diagram shares (#204, #229). */
export const ADD_LAYER_BUTTON = 'Add Layer';
export const OPEN_IT_BUTTON = 'Open It';
/** A diagram was written, but opening it failed (#236): open it again. */
export const OPEN_DIAGRAM_BUTTON = 'Open Diagram';
export const CHOOSE_ANOTHER_NAME_BUTTON = 'Choose Another Name';
export const NO_LAYERS_MESSAGE = 'No layers are configured for new diagrams. Add a layer first.';

/** A diagram with this name appeared since the name box checked it (another window, git). */
export function diagramNameTakenMessage(name: string, layerLabel: string): string {
  return `A diagram named "${name}" already exists in the ${layerLabel} layer.`;
}

/** A failure's buttons, by label, and what each one does. */
export type ErrorActions = Readonly<Record<string, () => unknown>>;

/**
 * Show an error with its buttons (`show` is `window.showErrorMessage` or a
 * test's fake), and run the one the user picks. Never awaited: the command
 * resolves while the toast is still up. A button that fails goes to
 * `onActionFailed`, so it says so rather than seeming to do nothing.
 */
export function showErrorWithActions(
  show: (message: string, ...items: string[]) => PromiseLike<string | undefined>,
  message: string,
  actions: ErrorActions,
  onActionFailed: (choice: string, err: unknown) => void,
): void {
  void Promise.resolve(show(message, ...Object.keys(actions))).then((choice) => {
    const action = choice ? actions[choice] : undefined;
    if (!choice || !action) return;
    void Promise.resolve()
      .then(action)
      .catch((err: unknown) => onActionFailed(choice, err));
  });
}

/** What `erdStudio.reportBug` accepts as its prefill. */
export interface FeedbackPrefill {
  kind: FeedbackKind;
  title: string;
  description: string;
}

/**
 * The sentence for a failure that is ERD Studio's, not the user's: what was
 * happening (`while …`) and what it left behind (`so nothing was …`).
 */
export function oursMessage(title: string, doing: string, outcome: string): string {
  return `${title} hit a problem in ERD Studio ${doing}, so ${outcome}. This isn't something you did. Please send us a report.`;
}

/**
 * Send Feedback's prefill for a failure that is ours: the raw exception, which
 * the toast never shows, with every local path reduced to its shape.
 */
export function feedbackPrefill(title: string, doing: string, err: unknown): FeedbackPrefill {
  const raw = err instanceof Error ? err.message : String(err);
  return {
    kind: 'bug',
    title: `${title} failed`,
    description: redactPaths(`${title} hit a problem ${doing}.\n\nError: ${raw}`),
  };
}

/** What a canvas handler was doing, for the toast of one that failed (#319). */
export interface HandlerFailureWords {
  /** The start of the toast when the failure's own words are for the user: `Failed to add column`. Absent: those words alone. */
  label?: string;
  /** The action as a noun phrase, for a failure that is ours: `Adding the column`. */
  title: string;
  /** What was not done, when the failure came before the change was made. Default `nothing was changed`. */
  notDone?: string;
  /** For a throw outside the edit pipeline (how far it got is unknown): `while …`. Default `while making the change`. */
  doing?: string;
  /** For the same throw: what may have been left behind. Default `the change may not have been made`. */
  outcome?: string;
  /** A line for the report alone (never the toast), such as the canvas message that failed. */
  reportNote?: string;
}

/** What is known about a handler failure when its toast is written. */
export interface HandlerFailureContext {
  /** The failure's own words were written for the user (a refusal, a mistake in one of their files). */
  explained: boolean;
  /** The edit's stage at the throw (`editFailureTag`); undefined for a throw outside the edit pipeline. */
  stage?: EditStage;
  /** VS Code had applied the edit before the throw. */
  applied?: boolean;
  /** The project folder, to name a folder that may not be written. */
  workspaceRoot?: string;
}

/** A handler failure's toast: its words and, when the failure is ours, Send Feedback's prefill. */
export interface HandlerFailureToast {
  message: string;
  feedback?: FeedbackPrefill;
}

/** `while …` / `after …` for each stage of an edit that had not been applied. */
const STAGE_DOING: Readonly<Record<EditStage, string>> = {
  read: 'while reading the diagram',
  mutate: 'while working out the change',
  layoutWrite: 'while writing the positions',
  storageWrite: 'while writing the change',
  jsonWrite: 'while writing the change',
  save: 'while saving the change',
  other: 'while making the change',
};

/**
 * The toast for a canvas handler that failed (#319), one rule for every
 * handler's catch and for the message boundary:
 *
 * - words written for the user (`explained`) are shown as they are, behind
 *   the handler's label;
 * - a folder ERD Studio may not use or a full disk, met before the edit was
 *   applied, is said in plain words;
 * - anything else is ERD Studio's: never the exception's text, which goes in
 *   Send Feedback's prefill with its paths redacted. What it says was left
 *   behind follows what is known: nothing changed (the throw came before the
 *   edit was applied), the change was made (after), or unknown (outside the
 *   edit pipeline).
 */
export function handlerFailureMessage(err: unknown, words: HandlerFailureWords, ctx: HandlerFailureContext): HandlerFailureToast {
  const raw = err instanceof Error ? err.message : String(err);
  const labelled = (text: string): string => (words.label ? `${words.label}: ${text}` : text);
  if (ctx.explained) return { message: labelled(raw) };
  // Only while nothing had been applied: after that, what matters is that the change was made.
  const write = ctx.applied === true ? 'other' : classifyWriteFailure(err);
  if (write === 'disk-full') return { message: labelled('the disk is full. Free up some space, then try again.') };
  if (write === 'permission') {
    const at = failedPath(err);
    const folder = at && ctx.workspaceRoot ? projectRelative(ctx.workspaceRoot, path.dirname(at)) : undefined;
    return {
      message: labelled(`ERD Studio isn't allowed to read or write in ${folder ? folder : 'this project'}. Check the folder's permissions, then try again.`),
    };
  }
  let doing: string;
  let outcome: string;
  if (ctx.applied === true) {
    // `save`: VS Code applied the edit and saving it threw, so the files may be open and unsaved.
    doing = ctx.stage === 'save' ? 'while saving the change' : 'after making the change';
    outcome = ctx.stage === 'save'
      ? 'the change was made but may not be saved'
      : 'the change was made, but the diagram may not show it yet';
  } else if (ctx.stage !== undefined) {
    doing = STAGE_DOING[ctx.stage];
    outcome = words.notDone ?? 'nothing was changed';
  } else {
    doing = words.doing ?? 'while making the change';
    outcome = words.outcome ?? 'the change may not have been made';
  }
  const feedback = feedbackPrefill(words.title, doing, err);
  return {
    message: oursMessage(words.title, doing, outcome),
    feedback: words.reportNote ? { ...feedback, description: `${feedback.description}

${redactPaths(words.reportNote)}` } : feedback,
  };
}

/** Where a canvas crash started, in the words of the report (`other`: not said). */
const CRASH_AREA_WORDS: Readonly<Record<WebviewErrorArea, string | undefined>> = {
  canvas: 'the canvas',
  detailPanel: 'the Detail panel',
  toolbar: 'the toolbar',
  dialogs: 'a dialog',
  compare: 'the compare view',
  guide: 'the Show Me Around guide',
  other: undefined,
};

/**
 * Send Feedback's prefill for the crash screen's **Send Feedback** (the
 * canvas's or the draft page's): which page crashed, where on the canvas it
 * started, and the crash's first line as the page sent it, through
 * `redactPaths()` again here (the page already did) and cut to
 * `CRASH_DETAIL_MAX`. The user reads it in Send Feedback before anything is
 * sent, and nothing analyses it: the canvas-less flow has no model.
 */
export function crashFeedbackPrefill(
  surface: 'canvas' | 'draft',
  crash: { area?: WebviewErrorArea; detail?: string } = {},
): FeedbackPrefill {
  const page = surface === 'draft' ? 'The draft preview' : 'The diagram canvas';
  const where = crash.area ? CRASH_AREA_WORDS[crash.area] : undefined;
  const detail = cutCrashDetail(redactPaths(crash.detail ?? '')).trim();
  return {
    kind: 'bug',
    title: `${surface === 'draft' ? 'The draft preview' : 'The canvas'} stopped working`,
    description: redactPaths(
      `${page} crashed and showed the "stopped working" screen${where ? `; it started in ${where}` : ''}.`
      + `\n\nError: ${detail || '(no message)'}`,
    ),
  };
}

/**
 * Send Feedback's prefill when a canvas or the draft preview never finished
 * opening (no `ready` 30 s after it was shown; `askNoReadyRecovery`): which
 * page, and nothing else. There was no crash screen and no error text.
 */
export function noReadyFeedbackPrefill(surface: 'canvas' | 'draft'): FeedbackPrefill {
  const page = surface === 'draft' ? 'The draft preview' : 'The diagram canvas';
  return {
    kind: 'bug',
    title: `${surface === 'draft' ? 'The draft preview' : 'The canvas'} did not open`,
    description: `${page} stayed blank and never finished opening.\n\nError: (no message)`,
  };
}

/** Why a write failed, as far as the user can do something about it. */
export type WriteFailure = 'permission' | 'disk-full' | 'other';

/**
 * Node's errno codes (`fs`) and VS Code's `FileSystemError` codes
 * (`workspace.fs`, which reports EACCES as `NoPermissions`). A
 * `FileSystemError` for a full disk carries no code of its own, only the
 * errno in its message.
 */
const PERMISSION_CODES = new Set(['EACCES', 'EPERM', 'EROFS', 'NoPermissions']);
const DISK_FULL_CODES = new Set(['ENOSPC', 'EDQUOT']);

export function classifyWriteFailure(err: unknown): WriteFailure {
  // A DBML write that could not be put back (`FileWriteRollbackFailed`) carries the fs error as its cause.
  const cause = causeOf(err);
  if (cause !== undefined) {
    const inner = classifyWriteFailure(cause);
    if (inner !== 'other') return inner;
  }
  const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '';
  if (PERMISSION_CODES.has(code)) return 'permission';
  if (DISK_FULL_CODES.has(code)) return 'disk-full';
  const message = err instanceof Error ? err.message : '';
  if (/\b(?:ENOSPC|EDQUOT)\b/.test(message)) return 'disk-full';
  if (/\b(?:EACCES|EPERM|EROFS)\b/.test(message)) return 'permission';
  return 'other';
}

/** The file a Node `fs` error names (`err.path`), when it names one. */
export function failedPath(err: unknown): string | undefined {
  const p = err && typeof err === 'object' && 'path' in err ? (err as { path: unknown }).path : undefined;
  if (typeof p === 'string' && p.length > 0) return p;
  const cause = causeOf(err);
  return cause === undefined ? undefined : failedPath(cause);
}

/** The error a wrapper names as its `cause` (one level), when it is an object. */
function causeOf(err: unknown): object | undefined {
  const cause = err && typeof err === 'object' && 'cause' in err ? (err as { cause: unknown }).cause : undefined;
  return cause && typeof cause === 'object' && cause !== err ? cause : undefined;
}

/** `filePath` relative to `root` with `/` separators; the base name when it is outside `root`. */
export function projectRelative(root: string, filePath: string): string {
  const rel = path.relative(root, filePath);
  // `..` alone or as the first segment only: `..data/` is a folder inside the project.
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return path.basename(filePath);
  return rel.split(path.sep).join('/');
}

/** What a located JSON mistake looks like, in words (#186). */
const JSON_MISTAKE_HINTS: Record<JsonSyntaxProblem, string> = {
  'trailing-comma': 'there is a comma after the last item, before a closing } or ]',
  'missing-comma': 'a comma is missing after this value',
  truncated: 'the file stops before the JSON is complete, so a closing } or ] may be missing',
  unexpected: 'the text there is not valid JSON',
};

/**
 * The plain sentence for a domain file that is not valid JSON (#186): where
 * the mistake is, by line and column, rather than the parser's wording and
 * character offset. `shown` is the project-relative path.
 */
export function describeJsonMistake(shown: string, err: Pick<SubjectAreaFileError, 'line' | 'column' | 'syntaxProblem'>): string {
  const at = jsonMistakeAt(err);
  return at ? `${shown} has a mistake ${at}.` : `${shown} is not valid JSON.`;
}

/**
 * The sentence for a `.dbml` diagram that does not parse (`invalid-dbml`):
 * "<shown> has a mistake at line L, column C: <the parser's words> [code]."
 * when core located it, else "<shown> is not valid DBML.". The parser's
 * words are taken from core's message, after its "column C: ".
 */
export function describeDbmlMistake(shown: string, err: Pick<SubjectAreaFileError, 'line' | 'column' | 'message'>): string {
  if (err.line === undefined || err.column === undefined) return `${shown} is not valid DBML.`;
  const marker = `line ${err.line}, column ${err.column}: `;
  const at = err.message.indexOf(marker);
  const detail = at === -1 ? '' : err.message.slice(at + marker.length).trim();
  const ended = detail === '' ? '' : `: ${detail}${/[.!?]$/.test(detail) ? '' : '.'}`;
  return `${shown} has a mistake at line ${err.line}, column ${err.column}${ended || '.'}`;
}

/** "at line L, column C: <hint>" for a located JSON mistake, else undefined. */
export function jsonMistakeAt(err: Pick<SubjectAreaFileError, 'line' | 'column' | 'syntaxProblem'>): string | undefined {
  if (err.line === undefined || err.column === undefined || err.syntaxProblem === undefined) return undefined;
  return `at line ${err.line}, column ${err.column}: ${JSON_MISTAKE_HINTS[err.syntaxProblem]}`;
}

/** A diagram file the user has to fix, in words, and whether opening it helps. */
export interface DiagramFileProblem {
  /** Ends without a full stop: it follows "the diagram file has a problem: ". */
  reason: string;
  /** Open File is offered: the file is there to open. */
  openable: boolean;
  line?: number;
  column?: number;
}

/**
 * Why a diagram file could not be read, for a failure that is the file's
 * (core's `SubjectAreaFileError` / `SubjectAreaValidationError`), else
 * undefined. A message that names the file names it as `shown`.
 */
export function describeDiagramFileProblem(err: unknown, filePath: string, shown: string): DiagramFileProblem | undefined {
  if (err instanceof SubjectAreaFileError) {
    switch (err.reason) {
      case 'missing':
        return { reason: 'it was deleted or renamed', openable: false };
      case 'unreadable':
        return { reason: 'ERD Studio could not read it. Check that the file is not locked or blocked by permissions', openable: false };
      case 'empty':
        return { reason: 'it has no content', openable: true };
      case 'invalid-json':
      case 'invalid-dbml': {
        if (err.mergeConflict) {
          return {
            reason: `it has unresolved git merge conflicts${err.line !== undefined ? `, first at line ${err.line}` : ''}. Keep one side of each conflict, then try again`,
            openable: true,
            ...(err.line !== undefined ? { line: err.line } : {}),
          };
        }
        if (err.reason === 'invalid-dbml') {
          const where = err.line !== undefined
            ? ` at line ${err.line}${err.column !== undefined ? `, column ${err.column}` : ''}`
            : '';
          return {
            reason: where ? `there is a DBML mistake${where}` : 'it is not valid DBML',
            openable: true,
            ...(err.line !== undefined ? { line: err.line } : {}),
            ...(err.column !== undefined ? { column: err.column } : {}),
          };
        }
        const at = jsonMistakeAt(err);
        return {
          reason: at ? `there is a mistake ${at}` : 'it is not valid JSON',
          openable: true,
          ...(err.line !== undefined ? { line: err.line } : {}),
          ...(err.column !== undefined ? { column: err.column } : {}),
        };
      }
    }
  }
  if (err instanceof SubjectAreaValidationError) {
    // Core wraps a TypeError thrown while building the diagram ("… is not a
    // loadable subject area: Cannot read properties of …"): the raw exception
    // is no sentence for the user, and the gap is ERD Studio's, so it is ours.
    if ((err as { cause?: unknown }).cause instanceof TypeError) return undefined;
    // Core's sentence names the file by its absolute path.
    const reason = redactPaths(err.message.split(filePath).join(shown)).replace(/\.\s*$/, '');
    // A file from a newer ERD Studio is fine; editing it is not the fix.
    return { reason, openable: !/update the extension/i.test(err.message) };
  }
  return undefined;
}
