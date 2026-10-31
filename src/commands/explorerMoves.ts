/**
 * Moves and renames done in the Explorer (ERD Studio 2.0, §2.8; spec M2):
 * drag a `.dbml` file (or a folder of them) somewhere else, or rename it with
 * F2, and the references follow, as VS Code's TypeScript "Update imports on
 * file move" does. `onDidRenameFiles` fires for the Explorer's drag and drop
 * and F2, and for other extensions' WorkspaceEdit renames; never for a git
 * checkout. ERD Studio's own edits (Convert, Organise, Move Table…, Move
 * Diagram to Layer…, rename cascades, Give Duplicate…) are left alone: they
 * update their references themselves (`ownFileOperations`, matched by the
 * exact rename, once).
 *
 * `erdStudio.dbml.updateReferencesOnMove` decides: `prompt` (default) asks
 * once per move with Update / Always / Never, `always` updates without
 * asking, `never` neither asks nor updates. Whatever it says, a file that
 * landed where ERD Studio does not read it gets a warning (with a button
 * that puts it back), and a renamed layer folder that `layers.json` still
 * lists under its old id is pointed out: both change nothing. Nothing is
 * said when nothing points at the moved files and nothing in them changes
 * (an undone move, or a file put back, included). The update is planned by
 * `planDbmlExplorerMoves` (the planners the commands use, never a second
 * one) and applied as ONE WorkspaceEdit (saved, own writes recorded): one
 * undo step after the user's own move, as with TypeScript. A YAML/JSON
 * project is never touched.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { isReservedLayerName, type ProjectStorage } from '@erd-studio/core';

import { getErdStudioSetting } from '../services/configService';
import { projectRelative } from '../services/commandErrors';
import type { FileWrite } from '../services/fileWrites';
import type { TableLibraryService } from '../services/logicalModelService';
import { isRefusedWrite } from '../services/newSubjectAreaWriter';
import { log } from '../services/logger';
import { TABLE_NAME_RULE } from '../types/naming';
import { planDbmlExplorerMoves, type DbmlExplorerMovesPlan, type MovedDbmlFile } from './dbmlLifecycle';

/** The setting (under `erdStudio.`): `prompt`, `always` or `never`. */
export const UPDATE_REFERENCES_ON_MOVE_SETTING = 'dbml.updateReferencesOnMove';
export type UpdateReferencesOnMove = 'prompt' | 'always' | 'never';

export const UPDATE_BUTTON = 'Update';
export const ALWAYS_BUTTON = 'Always';
export const NEVER_BUTTON = 'Never';
export const MOVE_IT_BACK_BUTTON = 'Move It Back';
export const RENAME_FILE_BACK_BUTTON = 'Rename File Back';
export const RENAME_FOLDER_BACK_BUTTON = 'Rename Folder Back';
export const TRY_AGAIN_BUTTON = 'Try Again';

/** What the listener needs from the host; `activate()` passes the real services. */
export interface ExplorerMoveDeps {
  workspaceRoot: string;
  /** The semantic dir, absolute. */
  semanticRoot: string;
  tableLibraryService: Pick<TableLibraryService,
    'planDbmlLibraryOps' | 'dbmlSnapshot' | 'getTablesDir' | 'listDbmlDiagrams' | 'listRelationshipsFiles' | 'listTableFiles' | 'invalidateCache'>;
  /** The layers `layers.json` lists. */
  layers(): ReadonlyArray<{ id: string; label: string }>;
  /** How the project stores its model, read now. */
  storage(): ProjectStorage;
  /** A file's text: an open document's, else the disk's. */
  readText(filePath: string): string | null;
  /** Those of `filePaths` open with unsaved edits. */
  dirtyFiles(filePaths: readonly string[]): string[];
  /** Whether the rename `from` → `to` is ERD Studio's own edit's (each is reported once). */
  takeOwnRename(from: string, to: string): boolean;
  /** Apply the writes (and renames) as one WorkspaceEdit, save and record own writes. */
  applyWrites(writes: readonly FileWrite[], renames?: ReadonlyArray<{ from: string; to: string }>): Promise<{ ok: boolean; unsaved: string[]; unrestored: string[] }>;
  /** After an update or a move back landed (own writes, which the watchers skip): the views and open canvases refresh. */
  afterUpdated(files: ReadonlyArray<{ path: string }>): Promise<void>;
}

/** The setting's value, `prompt` for anything else. */
function settingNow(): UpdateReferencesOnMove {
  const value = getErdStudioSetting<string>(UPDATE_REFERENCES_ON_MOVE_SETTING, 'prompt');
  return value === 'always' || value === 'never' ? value : 'prompt';
}

/** Whether `p` is inside `root` (not `root` itself). */
function isInside(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Every `.dbml` file under `dir` (any depth), absolute. */
function dbmlFilesUnder(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...dbmlFilesUnder(p));
    else if (e.isFile() && /\.dbml$/i.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * The `.dbml` files the renames moved (a folder's expanded to the files
 * inside it, now at their new paths; the extension in any case), leaving
 * out any with neither end in the semantic dir.
 */
export function movedDbmlFiles(
  deps: Pick<ExplorerMoveDeps, 'semanticRoot'>,
  renames: ReadonlyArray<{ from: string; to: string }>,
): MovedDbmlFile[] {
  const out: MovedDbmlFile[] = [];
  for (const { from, to } of renames) {
    if (!isInside(deps.semanticRoot, from) && !isInside(deps.semanticRoot, to)) continue;
    let isDir = false;
    try {
      isDir = fs.statSync(to).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      for (const file of dbmlFilesUnder(to)) out.push({ from: path.join(from, path.relative(to, file)), to: file });
    } else if (/\.dbml$/i.test(from) || /\.dbml$/i.test(to)) {
      out.push({ from, to });
    }
  }
  return out;
}

/** "fct_order.dbml", or "the 4 moved files". */
function subjectOf(plan: Extract<DbmlExplorerMovesPlan, { kind: 'update' }>): string {
  return plan.moved.length === 1 ? path.basename(plan.moved[0].to) : `the ${plan.moved.length} moved files`;
}

/** The question asked before an update (`prompt`), and the status line after one. */
export function describeExplorerUpdate(plan: Extract<DbmlExplorerMovesPlan, { kind: 'update' }>): { question: string; done: string } {
  const files = (n: number): string => `${n} file${n === 1 ? '' : 's'}`;
  if (plan.tableRenames.length === 1 && plan.moved.length === 1) {
    const { from, to } = plan.tableRenames[0];
    return {
      question: `Rename table ${from} to ${to} everywhere (${files(plan.writes.length)})? Its file's name is the table's name.`,
      done: `Renamed table ${from} to ${to} in ${files(plan.writes.length)}.`,
    };
  }
  const subject = subjectOf(plan);
  const others = plan.others.length;
  if (others === 0) {
    const own = plan.moved.length === 1 ? 'its' : 'their';
    const renamedOnly = plan.moved.every((m) => path.dirname(m.from) === path.dirname(m.to));
    return {
      question: `Update ${subject} for ${own} new ${renamedOnly ? 'name' : 'place'}?`,
      done: `Updated ${subject} for ${own} new ${renamedOnly ? 'name' : 'place'}.`,
    };
  }
  return {
    question: `Update the ${others} ERD Studio file${others === 1 ? '' : 's'} that point${others === 1 ? 's' : ''} at ${subject}?`,
    done: `Updated ${files(others)} that point${others === 1 ? 's' : ''} at ${subject}.`,
  };
}

/** Whether `p` is a folder now. */
function isFolder(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** The button that undoes the renames: Rename Folder Back / Rename File Back for one renamed in place, else Move It Back. */
export function backButtonFor(renames: ReadonlyArray<{ from: string; to: string }>): string {
  if (renames.length !== 1 || path.dirname(renames[0].from) !== path.dirname(renames[0].to)) return MOVE_IT_BACK_BUTTON;
  return isFolder(renames[0].to) ? RENAME_FOLDER_BACK_BUTTON : RENAME_FILE_BACK_BUTTON;
}

/** The rule a layer folder's name breaks, for a message. */
function layerRule(name: string): string {
  return isReservedLayerName(name)
    ? `"${name}" is a folder ERD Studio keeps for itself, not a layer.`
    : 'A layer folder\'s name is lower-case letters, digits, - and _, starting with a letter.';
}

/**
 * The warning for a move ERD Studio will not follow (`badName`,
 * `misplaced`, `badRename`), and its button, which undoes the event's
 * renames (`renames`, all of them).
 */
export function describeExplorerRefusal(
  deps: Pick<ExplorerMoveDeps, 'semanticRoot'>,
  plan: Extract<DbmlExplorerMovesPlan, { kind: 'misplaced' | 'badRename' | 'badName' }>,
  renames: ReadonlyArray<{ from: string; to: string }>,
): { message: string; button: string } {
  const button = backButtonFor(renames);
  const back = button === MOVE_IT_BACK_BUTTON ? 'move it back' : button === RENAME_FOLDER_BACK_BUTTON ? 'rename the folder back' : 'rename the file back';
  // A folder renamed in place may take another name; a moved file may go back or on to its place.
  const backOr = (place: string): string => (button === RENAME_FOLDER_BACK_BUTTON ? `${back}, or give it a name that fits` : button === MOVE_IT_BACK_BUTTON ? `${back}, or ${place}` : back);
  if (plan.kind === 'badName') {
    const file = path.basename(plan.move.to);
    if (plan.what === 'extension') {
      return {
        message: `ERD Studio reads only files whose names end in .dbml, in lower case, so it no longer reads ${file}. The files that point at it were left as they are; ${/\.dbml$/i.test(file) ? `${back} to ${file.replace(/\.dbml$/i, '.dbml')}` : `${back}, or add .dbml to its name`}, and they follow.`,
        button,
      };
    }
    if (plan.what === 'layer') {
      return {
        message: `"${plan.name}" cannot be a layer folder name, so ERD Studio does not read the files in ${plan.folder}/. ${layerRule(plan.name)} The files that point at them were left as they are; ${backOr('into a folder whose name fits')}, and they follow.`,
        button,
      };
    }
    return {
      message: `"${plan.name}" cannot be a schema folder name, so ERD Studio did not follow ${file} into ${plan.folder}/: no DBML tool reads a use line to it. Leave out quotes, slashes, \\ : * ? < > |, {{ }} and a trailing dot or space. The files that point at it were left as they are; ${backOr('into a folder whose name fits')}, and they follow.`,
      button,
    };
  }
  if (plan.kind === 'misplaced') {
    const what = plan.fileKind === 'table' ? 'table file' : plan.fileKind === 'relationships' ? 'relationships file' : 'diagram';
    const folder = path.relative(deps.semanticRoot, path.dirname(plan.move.to)).split(path.sep).join('/');
    const where = isInside(deps.semanticRoot, plan.move.to)
      ? `in ${folder === '' ? `the ${path.basename(deps.semanticRoot)} folder` : `${folder}/`}, where ERD Studio does not read a ${what}`
      : `outside the ${path.basename(deps.semanticRoot)} folder`;
    const file = path.basename(plan.move.to);
    if (plan.count > 1) {
      const also = plan.more.length === 0
        ? ''
        : `${plan.more.length === 1 ? `${path.basename(plan.more[0].to)} also landed` : `${plan.more.length} more of them also landed`} where ERD Studio does not read ${plan.more.length === 1 ? 'it' : 'them'}. `;
      return {
        message: `${file} is now ${where}: ${what}s live in ${plan.expected}. ${also}None of the ${plan.count} moved files was followed, and the files that point at them were left as they are; ${button} puts every moved file back.`,
        button,
      };
    }
    const follow = plan.fileKind === 'diagram'
      ? `It was left as it is; ${backOr(`into a ${plan.expected} folder`)}.`
      : `The files that point at it were left as they are; ${backOr(`into a ${plan.expected} folder`)}, and they follow.`;
    return { message: `${file} is now ${where}: ${what}s live in ${plan.expected}. ${follow}`, button };
  }
  const why = plan.reason === 'caseOnly'
    ? `"${plan.to}" differs from "${plan.from}" only in upper/lower case, which cannot be renamed in place. Rename the file back, rename it to a different name first, then to the one you want.`
    : plan.reason === 'taken'
      ? `the table "${plan.taken}" already has that name (names are compared without case). Rename the file back, or give it another name.`
      : plan.reason === 'renameAndMove'
        ? 'it was renamed and moved in one step. Rename the file back, then rename it and move it in two steps.'
        : `"${plan.to}" is not a table name. ${TABLE_NAME_RULE} Rename the file back, or give it another name.`;
  return {
    message: `A table file's name is its table's name, so ${path.basename(plan.move.to)} would rename the table ${plan.from} to ${plan.to}; ERD Studio did not, because ${why} Until then, the files that point at ${plan.from} are left as they are.`,
    button: RENAME_FILE_BACK_BUTTON,
  };
}

/**
 * The note for a layer folder renamed to a name `layers.json` does not list
 * while it still lists the old one (it is not edited here), or undefined.
 */
export function layerRenameNote(
  deps: Pick<ExplorerMoveDeps, 'semanticRoot' | 'layers'>,
  renames: ReadonlyArray<{ from: string; to: string }>,
): string | undefined {
  const listed = new Set(deps.layers().map((l) => l.id));
  const root = path.resolve(deps.semanticRoot);
  const r = renames
    .filter((x) => path.resolve(path.dirname(x.from)) === root && path.resolve(path.dirname(x.to)) === root)
    .map((x) => ({ from: path.basename(x.from), to: path.basename(x.to) }))
    .find((x) => listed.has(x.from) && !listed.has(x.to));
  return r ? `layers.json still lists the layer "${r.from}", not "${r.to}": change its id there so the diagrams in ${r.to}/ open.` : undefined;
}

/** Put the renames back (one WorkspaceEdit of ERD Studio's own, so it is not taken for another move), then refresh the views. */
async function undoRenames(deps: ExplorerMoveDeps, renames: ReadonlyArray<{ from: string; to: string }>): Promise<void> {
  const back = renames.map((r) => ({ from: r.to, to: r.from }));
  const result = await deps.applyWrites([], back);
  if (!result.ok) {
    if (result.unrestored.length === 0) {
      void vscode.window.showErrorMessage(`VS Code could not move ${renames.map((r) => path.basename(r.to)).join(', ')} back; move ${renames.length === 1 ? 'it' : 'them'} back in the Explorer.`);
    }
    return;
  }
  // Own writes, so the watchers skip them: the Explorer's move was seen, its undo must be too.
  await deps.afterUpdated(back.flatMap((r) => [{ path: r.from }, { path: r.to }]));
}

/** Plan, turning a failure into a warning (with Move It Back) unless `quiet`. Undefined when it failed. */
function planOrWarn(deps: ExplorerMoveDeps, moves: readonly MovedDbmlFile[], renames: ReadonlyArray<{ from: string; to: string }>, quiet = false): DbmlExplorerMovesPlan | undefined {
  try {
    return planDbmlExplorerMoves({ semanticRoot: deps.semanticRoot, tableLibraryService: deps.tableLibraryService, moves, readText: deps.readText });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!isRefusedWrite(err)) log.error('[ERD Studio] Updating the files that point at a moved file failed:', err);
    if (quiet) return undefined;
    const subject = moves.length === 1 ? path.basename(moves[0].to) : `the ${moves.length} moved files`;
    const button = backButtonFor(renames);
    void vscode.window.showWarningMessage(
      `ERD Studio could not update the files that point at ${subject}: ${message.replace(/\.?$/, '.')} Nothing else was changed.`,
      button,
    ).then((choice) => (choice === button ? undoRenames(deps, renames) : undefined));
    return undefined;
  }
}

/**
 * The `onDidRenameFiles` listener's work: what moved, what it takes, the
 * question (by the setting), then one edit. Resolves when it is done
 * (the question answered, or not asked).
 */
export async function onDbmlFilesRenamed(deps: ExplorerMoveDeps, files: ReadonlyArray<{ oldUri: vscode.Uri; newUri: vscode.Uri }>): Promise<void> {
  const renames = files
    .filter((f) => f.oldUri.scheme === 'file' && f.newUri.scheme === 'file')
    .map((f) => ({ from: f.oldUri.fsPath, to: f.newUri.fsPath }))
    // Every rename is offered to the marks, so each of ERD Studio's own is used up by its event.
    .filter((r) => !deps.takeOwnRename(r.from, r.to));
  if (renames.length === 0) return;
  const moves = movedDbmlFiles(deps, renames);
  if (moves.length === 0) return;
  // A YAML/JSON project is never touched (a .dbml there is not ERD Studio's).
  deps.tableLibraryService.invalidateCache();
  if (deps.storage() === 'yaml') return;

  // "never" leaves every file as it is: no question, no update, no failure to report.
  const mode = settingNow();
  const first = planOrWarn(deps, moves, renames, mode === 'never');
  if (!first) return;
  if (first.kind === 'misplaced' || first.kind === 'badRename' || first.kind === 'badName') {
    const { message, button } = describeExplorerRefusal(deps, first, renames);
    const choice = await vscode.window.showWarningMessage(message, button);
    if (choice === button) await undoRenames(deps, renames);
    return;
  }
  const note = layerRenameNote(deps, renames);
  const sayNote = (): void => {
    if (note) void vscode.window.showInformationMessage(note);
  };
  if (first.kind === 'none' || mode === 'never') {
    sayNote();
    return;
  }

  let plan = first;
  const asked = mode === 'prompt';
  if (asked) {
    const choice = await vscode.window.showInformationMessage(describeExplorerUpdate(first).question, UPDATE_BUTTON, ALWAYS_BUTTON, NEVER_BUTTON);
    if (choice === NEVER_BUTTON || choice === ALWAYS_BUTTON) {
      const value: UpdateReferencesOnMove = choice === NEVER_BUTTON ? 'never' : 'always';
      await vscode.workspace.getConfiguration('erdStudio').update(UPDATE_REFERENCES_ON_MOVE_SETTING, value, vscode.ConfigurationTarget.Global);
    }
    if (choice !== UPDATE_BUTTON && choice !== ALWAYS_BUTTON) {
      sayNote();
      return;
    }
  }

  for (let attempt = 0; ; attempt++) {
    // The files may have changed while a question was open: plan again from what is there now.
    if (asked || attempt > 0) {
      deps.tableLibraryService.invalidateCache();
      const again = planOrWarn(deps, moves, renames);
      if (!again || again.kind !== 'update') return;
      plan = again;
    }
    const dirty = deps.dirtyFiles(plan.writes.map((w) => w.path));
    if (dirty.length === 0) break;
    const choice = await vscode.window.showErrorMessage(
      `ERD Studio could not update the files that point at ${subjectOf(plan)}: ${projectRelative(deps.workspaceRoot, dirty[0])} has unsaved changes. Save or revert it, then choose ${TRY_AGAIN_BUTTON}.`,
      TRY_AGAIN_BUTTON,
    );
    if (choice !== TRY_AGAIN_BUTTON) return;
  }
  const result = await deps.applyWrites(plan.writes);
  if (!result.ok) {
    if (result.unrestored.length === 0) void vscode.window.showErrorMessage(`ERD Studio: VS Code rejected the update of the files that point at ${subjectOf(plan)}; nothing else was changed.`);
    return;
  }
  await deps.afterUpdated(plan.writes);
  if (result.unsaved.length > 0) {
    void vscode.window.showErrorMessage(`Could not save ${result.unsaved.map((p) => projectRelative(deps.workspaceRoot, p)).join(', ')}. Save the file from its tab, or revert it.`);
  }
  const done = describeExplorerUpdate(plan).done;
  // A layer folder renamed: layers.json still lists the old layer (it is not edited here).
  if (note) void vscode.window.showInformationMessage(`${done} ${note}`);
  else vscode.window.setStatusBarMessage(`ERD Studio: ${done}`, 5000);
  log.info(`[ERD Studio] ${done}`);
}
