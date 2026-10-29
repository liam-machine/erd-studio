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
  /** The folder Show Folder reveals, the file Show File reveals or Open File opens. */
  target?: string;
  /** Where Open File puts the cursor. */
  line?: number;
  column?: number;
}

/** The commands' titles, as the sidebar and palette say them. */
export const NEW_DIAGRAM_TITLE = 'New Diagram';
export const DELETE_DIAGRAM_TITLE = 'Delete Diagram';
export const RENAME_DIAGRAM_TITLE = 'Rename Diagram';
export const SET_UP_TITLE = 'Set up ERD Studio';
export const SELECTORS_TITLE = 'Regenerate dbt selectors.yml';

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
  if (failure === 'other') {
    return { title, message: oursMessage(title, ctx.doing, clause(ctx.outcome)), buttons: [SEND_FEEDBACK_BUTTON, ...retry], doing: ctx.doing };
  }
  if (failure === 'disk-full') {
    return { title, message: `${title}: the disk is full. Free up some space, then try again. ${ctx.outcome}`, buttons: retry };
  }
  // The folder the write was refused in: the parent of what the error names
  // (mkdir names the folder it could not make, a write the file).
  const at = failedPath(err);
  const folder = at ? path.dirname(at) : path.dirname(ctx.target);
  return {
    title,
    message: `${title}: ERD Studio isn't allowed to write to ${shownFolder(ctx.workspaceRoot, folder)}. ` +
      `Check the folder's permissions, then try again. ${ctx.outcome}`,
    buttons: [SHOW_FOLDER_BUTTON, ...retry],
    target: folder,
  };
}

/** `layers.json` could not be read or written, for the layer commands. */
export function layersFailure(
  title: string,
  err: unknown,
  ctx: { workspaceRoot: string; layersPath: string; doing: string; outcome: string },
): CommandFailure {
  if (err instanceof LayersFileUnreadableError) return layersFileMistake(title, ctx);
  return writeFailure(title, err, { workspaceRoot: ctx.workspaceRoot, target: ctx.layersPath, doing: ctx.doing, outcome: ctx.outcome, retry: false });
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
    return { title: RENAME_DIAGRAM_TITLE, message: oursMessage(RENAME_DIAGRAM_TITLE, doing, 'nothing was changed'), buttons: [SEND_FEEDBACK_BUTTON], doing };
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
  };
}

/** A project-relative folder with a trailing `/`; the project itself is `the project folder`. */
function shownFolder(workspaceRoot: string, folder: string): string {
  const rel = path.relative(workspaceRoot, folder);
  if (!rel) return 'the project folder';
  return `${projectRelative(workspaceRoot, folder)}/`;
}

/** "Nothing was created." as the clause "nothing was created", to follow "so". */
function clause(sentence: string): string {
  return (sentence.charAt(0).toLowerCase() + sentence.slice(1)).replace(/\.$/, '');
}
