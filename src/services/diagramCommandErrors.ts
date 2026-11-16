/**
 * The words for the diagram and layer commands' failures (#229): New
 * Diagram, Delete / Rename Diagram, Set Up ERD Studio Folder, Regenerate dbt
 * selectors.yml and the layer commands. Each builder says whose problem it
 * is and which buttons to offer; `extension.ts` gives each button its action.
 * A failure that is ERD Studio's never shows the raw exception: it offers
 * Send Feedback, with the exception in the report, redacted.
 *
 * vscode-free, so every message and its buttons are unit-tested without a
 * host, and built from `commandErrors.ts` rather than copied from it.
 */

import * as path from 'path';

import {
  OPEN_FILE_BUTTON,
  SEND_FEEDBACK_BUTTON,
  SHOW_FILE_BUTTON,
  TRY_AGAIN_BUTTON,
  classifyWriteFailure,
  describeDiagramFileProblem,
  failedPath,
  oursMessage,
  projectRelative,
} from './commandErrors';
import { LayersFileUnreadableError } from './layerService';
import type { TelemetryErrorCode, TelemetryFeature } from './telemetryPayload';

/** Reveals the folder a write was refused in. */
export const SHOW_FOLDER_BUTTON = 'Show Folder';

/** A failure in words, and the buttons it offers, in order. */
export interface CommandFailure {
  /** The command, for Send Feedback's title. */
  title: string;
  message: string;
  buttons: string[];
  /** What was happening, for Send Feedback's report; set when the failure is ours. */
  doing?: string;
  /**
   * What was happening, for Send Feedback's report alone, on a failure that is
   * not counted as ours (VS Code did not apply an edit: usually the user's
   * environment). `doing` wins when both are set.
   */
  reportDoing?: string;
  /** The folder Show Folder reveals, the file Show File reveals or Open File opens. */
  target?: string;
  /** Where Open File puts the cursor. */
  line?: number;
  column?: number;
  /**
   * Internal, never shown: the usage-telemetry key `showCommandFailure`
   * records for this failure (B10), an error code or a feature. Fixed keys only.
   * An error code is set only on a failure that is ours (`doing` set): the
   * user's environment or file (a locked file, permissions, a full disk, a
   * diagram with a mistake in it) carries none, so the operation's code
   * always means an ERD Studio failure (`recordCommandFailure` counts the
   * write class beside it instead).
   */
  code?: TelemetryErrorCode | TelemetryFeature;
}

/** The commands' titles, as the sidebar and palette say them. */
export const NEW_DIAGRAM_TITLE = 'New Diagram';
export const DELETE_DIAGRAM_TITLE = 'Delete Diagram';
export const RENAME_DIAGRAM_TITLE = 'Rename Diagram';
export const SET_UP_TITLE = 'Set up ERD Studio';
export const SELECTORS_TITLE = 'Regenerate dbt selectors.yml';

/** The usage-telemetry code of a write failure, by the command it stopped (B10). */
const WRITE_FAILURE_CODES: Readonly<Record<string, TelemetryErrorCode>> = {
  [NEW_DIAGRAM_TITLE]: 'newDiagramWriteFailed',
};

/** `failure` with its usage-telemetry error code, when the failure is ours (`doing` set) and has none yet. */
function withCode(failure: CommandFailure, code: TelemetryErrorCode | undefined): CommandFailure {
  return code === undefined || failure.code !== undefined || !failure.doing ? failure : { ...failure, code };
}

/**
 * A write the environment refused (a folder the user may not write, a full
 * disk), else ERD Studio's own failure. `target` is the folder or file that
 * was being written, named when the error does not name one; `outcome` is the
 * sentence that says what was left behind ("Nothing was created.").
 */
export function writeFailure(
  title: string,
  err: unknown,
  ctx: { workspaceRoot: string; target: string; doing: string; outcome: string; retry: boolean },
): CommandFailure {
  const failure = classifyWriteFailure(err);
  const retry = ctx.retry ? [TRY_AGAIN_BUTTON] : [];
  const code = Object.prototype.hasOwnProperty.call(WRITE_FAILURE_CODES, title) ? WRITE_FAILURE_CODES[title] : undefined;
  if (failure === 'other') {
    return withCode({ title, message: oursMessage(title, ctx.doing, clause(ctx.outcome)), buttons: [SEND_FEEDBACK_BUTTON, ...retry], doing: ctx.doing }, code);
  }
  if (failure === 'disk-full') {
    return withCode({ title, message: `${title}: the disk is full. Free up some space, then try again. ${ctx.outcome}`, buttons: retry }, code);
  }
  // The folder the write was refused in: the parent of what the error names
  // (mkdir names the folder it could not make, a write the file).
  const at = failedPath(err);
  const folder = at ? path.dirname(at) : path.dirname(ctx.target);
  return withCode({
    title,
    message: `${title}: ERD Studio isn't allowed to write to ${shownFolder(ctx.workspaceRoot, folder)}. ` +
      `Check the folder's permissions, then try again. ${ctx.outcome}`,
    buttons: [SHOW_FOLDER_BUTTON, ...retry],
    target: folder,
  }, code);
}

/** `layers.json` could not be read or written, for the layer commands. */
export function layersFailure(
  title: string,
  err: unknown,
  ctx: { workspaceRoot: string; layersPath: string; doing: string; outcome: string },
): CommandFailure {
  if (err instanceof LayersFileUnreadableError) {
    // The user's own mistake in the file: said in words, not counted as a failure.
    if (!err.cannotRead) return layersFileMistake(title, ctx);
    const shown = projectRelative(ctx.workspaceRoot, ctx.layersPath);
    return {
      title,
      message: `${title}: ERD Studio can't read ${shown}, so ${clause(ctx.outcome)}. Check the file's permissions, then try again.`,
      buttons: [SHOW_FILE_BUTTON],
      target: ctx.layersPath,
    };
  }
  return withCode(
    writeFailure(title, err, { workspaceRoot: ctx.workspaceRoot, target: ctx.layersPath, doing: ctx.doing, outcome: ctx.outcome, retry: false }),
    'layersFileFailed',
  );
}

/** `layers.json` has a mistake in it, so ERD Studio won't overwrite it with its default layers. */
export function layersFileMistake(title: string, ctx: { workspaceRoot: string; layersPath: string; outcome: string }): CommandFailure {
  return {
    title,
    message: `${title}: ${projectRelative(ctx.workspaceRoot, ctx.layersPath)} has a mistake in it, so ${clause(ctx.outcome)}. Fix the file, then try again.`,
    buttons: [OPEN_FILE_BUTTON],
    target: ctx.layersPath,
  };
}

/** A layer the sidebar still showed that `layers.json` no longer has: the sidebar was stale. */
export function layerGone(title: string, layerId: string): CommandFailure {
  return { title, message: `The layer "${layerId}" isn't in layers.json any more. The sidebar has been refreshed.`, buttons: [] };
}

/**
 * The diagram file could not be deleted. A file another program holds open
 * (EBUSY, on Windows) is the user's to close, as is a folder they may not
 * write; anything else is ours.
 */
export function deleteFailure(name: string, filePath: string, err: unknown): CommandFailure {
  const message = err instanceof Error ? err.message : '';
  const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '';
  if (classifyWriteFailure(err) !== 'other' || code === 'EBUSY' || /\bEBUSY\b/.test(message)) {
    return {
      title: DELETE_DIAGRAM_TITLE,
      message: `"${name}" couldn't be deleted: another program may have it open, or ERD Studio isn't allowed to change that folder. Nothing was deleted.`,
      buttons: [SHOW_FILE_BUTTON, TRY_AGAIN_BUTTON],
      target: filePath,
    };
  }
  const doing = 'while deleting the file';
  return {
    title: DELETE_DIAGRAM_TITLE,
    message: oursMessage(DELETE_DIAGRAM_TITLE, doing, 'nothing was deleted'),
    buttons: [SEND_FEEDBACK_BUTTON, TRY_AGAIN_BUTTON],
    doing,
    code: 'deleteDiagramFailed',
  };
}

/** Saving the diagram's unsaved changes failed, so the delete or rename stopped. */
export function unsavedSaveFailure(name: string, operation: 'deleting' | 'renaming'): CommandFailure {
  return {
    title: operation === 'deleting' ? DELETE_DIAGRAM_TITLE : RENAME_DIAGRAM_TITLE,
    message: `"${name}" couldn't be saved, so it wasn't ${operation === 'deleting' ? 'deleted' : 'renamed'}. Your changes are still in its tab.`,
    buttons: [SHOW_FILE_BUTTON],
  };
}

/** Rename could not read the diagram: the file's problem in words (#186), else ours. */
export function renameReadFailure(filePath: string, err: unknown, workspaceRoot: string): CommandFailure {
  const shown = projectRelative(workspaceRoot, filePath);
  const problem = describeDiagramFileProblem(err, filePath, shown);
  if (!problem) {
    const doing = 'while reading the diagram file';
    return {
      title: RENAME_DIAGRAM_TITLE, message: oursMessage(RENAME_DIAGRAM_TITLE, doing, 'nothing was changed'), buttons: [SEND_FEEDBACK_BUTTON], doing,
      code: 'renameDiagramFailed',
    };
  }
  return {
    title: RENAME_DIAGRAM_TITLE,
    message: `${shown} can't be renamed because the diagram file has a problem: ${problem.reason}.`,
    buttons: problem.openable ? [OPEN_FILE_BUTTON] : [],
    target: filePath,
    ...(problem.line !== undefined ? { line: problem.line } : {}),
    ...(problem.column !== undefined ? { column: problem.column } : {}),
  };
}

/** VS Code did not accept the rename's file edit (#219's wording for a refused file move). */
export function renameRefused(oldName: string, newName: string): CommandFailure {
  return {
    title: RENAME_DIAGRAM_TITLE,
    message: `VS Code didn't accept renaming "${oldName}" to "${newName}", usually because another program has the file open ` +
      "or ERD Studio isn't allowed to write to that folder. Nothing was changed.",
    buttons: [TRY_AGAIN_BUTTON, SEND_FEEDBACK_BUTTON],
    doing: 'while renaming the file',
    code: 'renameDiagramFailed',
  };
}

/**
 * A failure of ERD Studio's own while a command worked out or made its
 * change (#335): never the exception's text, which goes in Send Feedback's
 * report. `outcome` follows "so" ("nothing was created").
 */
export function oursFailure(title: string, doing: string, outcome: string, retry: boolean): CommandFailure {
  return { title, message: oursMessage(title, doing, outcome), buttons: [SEND_FEEDBACK_BUTTON, ...(retry ? [TRY_AGAIN_BUTTON] : [])], doing };
}

/**
 * A command's unexpected failure, by its cause (#335): a file or folder
 * ERD Studio may not open, or a full disk, is the user's to fix, so the
 * toast says that and offers no Send Feedback and counts nothing as ours;
 * only a failure with no known cause is ERD Studio's (`oursFailure`).
 * `prefix` starts the toast (the title by default, `''` for none), and
 * `extra` buttons follow Try Again.
 */
export function knownCauseOrOurs(
  title: string,
  err: unknown,
  ctx: { doing: string; outcome: string; retry: boolean; workspaceRoot?: string; prefix?: string; extra?: readonly string[] },
): CommandFailure {
  const cause = classifyWriteFailure(err);
  if (cause === 'other') return oursFailure(title, ctx.doing, ctx.outcome, ctx.retry);
  const lead = ctx.prefix === '' ? '' : `${ctx.prefix ?? title}: `;
  const after = [...(ctx.retry ? [TRY_AGAIN_BUTTON] : []), ...(ctx.extra ?? [])];
  if (cause === 'disk-full') {
    return { title, message: sentence(`${lead}the disk is full, so ${ctx.outcome}. Free up some space, then try again.`), buttons: after };
  }
  const at = failedPath(err);
  const where = at === undefined
    ? 'a file or folder it needs'
    : ctx.workspaceRoot !== undefined ? projectRelative(ctx.workspaceRoot, at) : path.basename(at);
  return {
    title,
    message: sentence(`${lead}ERD Studio isn't allowed to open ${where}, so ${ctx.outcome}. Check its permissions, then try again.`),
    buttons: [...(at !== undefined ? [SHOW_FILE_BUTTON] : []), ...after],
    ...(at !== undefined ? { target: at } : {}),
  };
}

/**
 * The error Send Feedback's report names when VS Code did not apply an edit
 * (`applyEdit` resolved false, nothing to put back): there is no exception.
 */
export function editNotAppliedError(): Error {
  return new Error('VS Code did not apply the edit (applyEdit returned false).');
}

/**
 * VS Code did not apply a command's edit, and nothing was left to put back
 * (#335; Convert to DBML's words for the same event). Usually a file another
 * program has open or a folder the user may not write, so it is not counted
 * as ours (no `doing`); Send Feedback is still offered, unless `unwritable`
 * names the file or folder that is the cause. `what` names the edit
 * ("the move"), `outcome` follows "so", `prefix` starts the toast (the
 * title, by default), and `extra` buttons go between Try Again and Send
 * Feedback.
 */
export function editNotAccepted(
  title: string,
  what: string,
  outcome: string,
  options: { prefix?: string; extra?: readonly string[]; unwritable?: { path: string; workspaceRoot: string } } = {},
): CommandFailure {
  // A file or folder of the edit that this account may not write (checked on
  // disk by the caller): the cause is known and the user's to fix, so the
  // toast says so and offers no Send Feedback.
  if (options.unwritable) {
    const { path: at, workspaceRoot } = options.unwritable;
    const rel = path.relative(workspaceRoot, at);
    return {
      title,
      // "ERD Studio: ERD Studio isn't…" would say the name twice.
      message: `${options.prefix === 'ERD Studio' ? '' : `${options.prefix ?? title}: `}ERD Studio isn't allowed to write to ${rel ? projectRelative(workspaceRoot, at) : 'the project folder'}, so ${outcome}. ` +
        'Check its permissions, then try again.',
      buttons: [SHOW_FOLDER_BUTTON, TRY_AGAIN_BUTTON, ...(options.extra ?? [])],
      target: at,
    };
  }
  return {
    title,
    message: `${options.prefix ?? title}: VS Code didn't accept ${what}, so ${outcome}. ` +
      "This is usually a file another program has open or a folder you can't write to.",
    buttons: [TRY_AGAIN_BUTTON, ...(options.extra ?? []), SEND_FEEDBACK_BUTTON],
    reportDoing: `while applying ${what}`,
  };
}

/** A file the command needs could not be read (#335): Show File reveals it, Try Again runs the command again. */
export function fileUnreadable(title: string, shown: string, filePath: string, outcome: string): CommandFailure {
  return {
    title,
    message: `${title}: ${shown} could not be read, so ${outcome}. Check the file still exists and that VS Code can open it.`,
    buttons: [SHOW_FILE_BUTTON, TRY_AGAIN_BUTTON],
    target: filePath,
  };
}

/** A project-relative folder with a trailing `/`; the project itself is `the project folder`. */
function shownFolder(workspaceRoot: string, folder: string): string {
  const rel = path.relative(workspaceRoot, folder);
  if (!rel) return 'the project folder';
  return `${projectRelative(workspaceRoot, folder)}/`;
}

/** `text` with its first letter in upper case. */
function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "Nothing was created." as the clause "nothing was created", to follow "so". */
function clause(sentence: string): string {
  return (sentence.charAt(0).toLowerCase() + sentence.slice(1)).replace(/\.$/, '');
}
