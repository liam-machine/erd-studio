/**
 * ERD Studio: Migrate to the New File Naming (#182, part 4 of #162).
 *
 * Moves a v5 project's files to the v6 table naming — `logical-models/` →
 * `tables/`, and in each file only the keys the naming renames — as
 * `planNamingMigration` plans it. Prompted, with the whole plan in the
 * dialog; one `WorkspaceEdit`, so Edit > Undo straight after (while an
 * editor is still open; VS Code drops the step once none is) puts every
 * file back, and
 * nothing is written unless VS Code applies it.
 *
 * A table file is moved by file operations only — a rename, or a delete and
 * a create holding its new text — so undoing it restores the old bytes
 * without leaving an unsaved buffer behind. A subject area file is rewritten
 * in place and saved; an undo or redo of it (Edit > Undo) is saved too
 * (`saveMigratedOnUndo`), so the files on disk follow the undo.
 *
 * Its failures never show the raw exception (#219): one the user can act on
 * (an unsaved file, a project that changed under the dialog, a file that
 * would not save) offers the next step as a button, and anything else is
 * ERD Studio's, with Send Feedback.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { LOGICAL_MODELS_DIR, TABLES_DIR } from '@erd-studio/core';

import { dirtyFiles } from '../providers/dirtyDocuments';
import { saveDocumentByUri } from '../providers/documentSave';
import {
  RELOAD_WINDOW_BUTTON,
  SAVE_ALL_BUTTON,
  SAVE_AND_TRY_AGAIN_BUTTON,
  SEND_FEEDBACK_BUTTON,
  SHOW_FILE_BUTTON,
  TRY_AGAIN_BUTTON,
  classifyWriteFailure,
  feedbackPrefill,
  oursMessage,
  showErrorWithActions as showErrorWith,
  type ErrorActions,
} from '../services/commandErrors';
import type { SubjectAreaService } from '../services/domainService';
import type { TableLibraryService } from '../services/logicalModelService';
import { describeNamingMigration, namingMigrationIsEmpty, planNamingMigration } from '../services/namingMigration';
import type { NamingMigrationPlan } from '../services/namingMigration';
import { readNamingMigrationInput } from '../services/namingMigrationFiles';
import { ownWrites } from '../services/ownWriteTracker';
import { telemetry } from '../services/telemetryService';

export const MIGRATE_NAMING_TITLE = 'Migrate to the New File Naming';

/** The one migrate button, on the prompt and in the dialog. */
export const MIGRATE_NAMING_BUTTON = 'Migrate';

export interface MigrateNamingDeps {
  workspaceRoot: string;
  semanticDir: string;
  subjectAreaService: Pick<SubjectAreaService, 'listSubjectAreas'>;
  tableLibraryService: Pick<TableLibraryService, 'listTableFiles' | 'invalidateCache'>;
  /** This extension's version, for "teammates need ERD Studio X or later". */
  version: string;
  /** Runs "Migrate Subject Areas to the Central Table Library" for v4 files; true when it converted them. */
  migrateToV5?: () => Promise<boolean>;
  /** Every file the migration wrote (old and new paths): refresh the views and open canvases. */
  onMigrated: (paths: string[]) => Promise<void>;
  /** Hold open canvases' refreshes while the edit applies; returns the release. */
  holdRefreshes?: () => () => void;
}

/** Subject area files a migration rewrote this session: an undo or redo of one is saved (#182). */
const migratedSubjectAreas = new Set<string>();
/** Folders a migration created (`tables/`, `tables/{layer}/`): removed again when an undo leaves them empty. */
const createdFolders = new Set<string>();
let undoListeners: vscode.Disposable[] = [];

/** Remove each folder a migration created that is empty again (an undo moved its files back). */
function removeEmptiedFolders(): void {
  for (const folder of [...createdFolders].sort((a, b) => b.length - a.length)) {
    try { if (fs.readdirSync(folder).length === 0) fs.rmdirSync(folder); } catch { /* gone, or in use again */ }
  }
}

/**
 * Save a migrated subject area file whenever VS Code undoes or redoes it,
 * wherever the undo was typed: the table files move back by file
 * operations, and without this the subject areas would be reverted in
 * memory only, leaving the project half v5 and half v6 on disk. One
 * listener for the session, covering every migration made in it.
 */
function saveMigratedOnUndo(paths: readonly string[], folders: Iterable<string>): void {
  for (const p of paths) migratedSubjectAreas.add(path.resolve(p));
  for (const f of folders) createdFolders.add(path.resolve(f));
  for (const listener of undoListeners) listener.dispose();
  // An undo of the file operations alone (no canvas was open) fires these, not a text change.
  const later = (): void => { setTimeout(removeEmptiedFolders, 50); };
  undoListeners = [
    vscode.workspace.onDidDeleteFiles?.(later),
    vscode.workspace.onDidRenameFiles?.(later),
  ].filter((d): d is vscode.Disposable => !!d);
  undoListeners.push(vscode.workspace.onDidChangeTextDocument((e) => {
    const undoRedo = e.reason === vscode.TextDocumentChangeReason.Undo || e.reason === vscode.TextDocumentChangeReason.Redo;
    if (!undoRedo || !migratedSubjectAreas.has(path.resolve(e.document.uri.fsPath))) return;
    // After the rest of the step has landed, as the canvas's own undo flush waits.
    setTimeout(() => {
      // An empty `tables/` left by an undo would read as a layer folder.
      removeEmptiedFolders();
      if (!e.document.isDirty) return;
      void e.document.save().then((saved) => { if (saved) ownWrites.recordWrite(e.document.uri.fsPath); });
    }, 50);
  }));
}

export type MigrateNamingOutcome = 'migrated' | 'nothing' | 'refused' | 'cancelled' | 'failed';

/**
 * Show an error with its buttons, and run the one the user picks. Never
 * awaited: the command resolves while the toast is still up. A button that
 * fails says so, rather than seeming to do nothing.
 */
function showErrorWithActions(message: string, actions: ErrorActions): void {
  showErrorWith((m, ...items) => vscode.window.showErrorMessage(m, ...items), message, actions, (choice, err) => {
    console.error(`[ERD Studio] ${MIGRATE_NAMING_TITLE}: "${choice}" failed:`, err);
    const doing = `while running ${choice}`;
    showErrorWithActions(oursMessage(MIGRATE_NAMING_TITLE, doing, 'nothing more was changed'), { [SEND_FEEDBACK_BUTTON]: sendFeedback(doing, err) });
  });
}

/** Send Feedback, prefilled with the redacted failure: for a failure that is ours. */
function sendFeedback(doing: string, err: unknown): () => unknown {
  return () => vscode.commands.executeCommand('erdStudio.reportBug', feedbackPrefill(MIGRATE_NAMING_TITLE, doing, err));
}

const showFile = (filePath: string) => () => vscode.window.showTextDocument(vscode.Uri.file(filePath));

/** "a.yml, b.json and 3 more": at most five names. */
function listFiles(names: readonly string[]): string {
  return `${names.slice(0, 5).join(', ')}${names.length > 5 ? ` and ${names.length - 5} more` : ''}`;
}

/** Remove the folders this run made, deepest first. */
function removeFolders(folders: Iterable<string>): void {
  for (const folder of [...folders].sort((a, b) => b.length - a.length)) {
    try { fs.rmdirSync(folder); } catch { /* not empty, or already gone */ }
  }
}

/** The target folders could not be made: a permission or a full disk is the user's to fix. */
class FolderNotCreated extends Error {
  constructor(readonly cause: unknown) {
    super('a target folder could not be created');
    this.name = 'FolderNotCreated';
  }
}

/** The v4 → v5 step threw: it has counted and logged its own failure. */
class V5StepFailed extends Error {
  constructor(readonly cause: unknown) {
    super('the v4 migration failed');
    this.name = 'V5StepFailed';
  }
}

/** Why the new naming, for the prompt and the dialog. */
export function namingMigrationReason(version: string): string {
  return 'ERD Studio now says "table" and "subject area", and its files can say so too: the Table Library moves from ' +
    `.erd-studio/${LOGICAL_MODELS_DIR}/ to .erd-studio/${TABLES_DIR}/, and keys such as "domain" and "logical.models" become ` +
    `"subjectArea" and "logical.tables". Teammates need ERD Studio ${version} or later to open the migrated files.`;
}

/** The plan as the user reads it in the dialog. */
function confirmDetail(plan: NamingMigrationPlan, version: string): string {
  return `${namingMigrationReason(version)}\n\n${describeNamingMigration(plan)}\n\n` +
    'Only those keys change; every comment, relationship and other value stays as written. Edit > Undo, straight after, puts every file back; after that, use source control.';
}

/**
 * The command. Never throws: anything unexpected is counted and shown as
 * ERD Studio's problem, with Send Feedback, never as the raw exception (#219).
 */
export async function migrateToTableNaming(deps: MigrateNamingDeps): Promise<MigrateNamingOutcome> {
  const progress = { applied: false, unsaved: false };
  const retry = (): Promise<MigrateNamingOutcome> => migrateToTableNaming(deps);
  try {
    return await runMigration(deps, progress, retry);
  } catch (err) {
    console.error('[migrateNaming] failed:', err);
    if (err instanceof V5StepFailed) {
      // The v4 step counted its own failure, and writes its files one by one.
      const doing = 'while converting the v4 subject areas';
      showErrorWithActions(oursMessage(MIGRATE_NAMING_TITLE, doing, 'some files may already be converted (source control shows which)'), {
        [SEND_FEEDBACK_BUTTON]: sendFeedback(doing, err.cause),
        [TRY_AGAIN_BUTTON]: retry,
      });
      return 'failed';
    }
    const failure = err instanceof FolderNotCreated ? classifyWriteFailure(err.cause) : 'other';
    if (failure !== 'other') {
      // The user's folder or disk, not ERD Studio: not counted as a failure of ours.
      showErrorWithActions(
        `${MIGRATE_NAMING_TITLE}: ${failure === 'permission'
          ? `ERD Studio isn't allowed to create the ${TABLES_DIR}/ folder in ${deps.semanticDir}/. Check the folder's permissions, then try again.`
          : `the disk is full, so ERD Studio couldn't create the ${TABLES_DIR}/ folder. Free some space, then try again.`} Nothing was changed.`,
        { [TRY_AGAIN_BUTTON]: retry },
      );
      return 'failed';
    }
    telemetry.error('migrationFailed');
    const cause = err instanceof FolderNotCreated ? err.cause : err;
    if (progress.applied) {
      // Every file has moved; only the refresh that follows failed. A reload
      // would drop the undo step, and any unsaved subject area with it.
      const doing = 'after moving the files';
      showErrorWithActions(oursMessage(MIGRATE_NAMING_TITLE, doing, 'open diagrams may not show the new naming until you reload the window'), {
        [SEND_FEEDBACK_BUTTON]: sendFeedback(doing, cause),
        ...(progress.unsaved ? {} : { [RELOAD_WINDOW_BUTTON]: () => vscode.commands.executeCommand('workbench.action.reloadWindow') }),
      });
      return 'migrated';
    }
    const doing = 'while planning the migration';
    showErrorWithActions(oursMessage(MIGRATE_NAMING_TITLE, doing, 'nothing was changed'), {
      [SEND_FEEDBACK_BUTTON]: sendFeedback(doing, cause),
      [TRY_AGAIN_BUTTON]: retry,
    });
    return 'failed';
  }
}

/** The plan for the project as it is on disk now. */
export function planProjectNamingMigration(deps: Pick<MigrateNamingDeps, 'workspaceRoot' | 'semanticDir' | 'subjectAreaService' | 'tableLibraryService'>): NamingMigrationPlan {
  deps.tableLibraryService.invalidateCache();
  return planNamingMigration(readNamingMigrationInput(deps.workspaceRoot, deps.semanticDir, deps.subjectAreaService, deps.tableLibraryService));
}

async function runMigration(
  deps: MigrateNamingDeps,
  progress: { applied: boolean; unsaved: boolean },
  retry: () => Promise<MigrateNamingOutcome>,
): Promise<MigrateNamingOutcome> {
  const semanticRoot = path.join(deps.workspaceRoot, deps.semanticDir);
  const abs = (rel: string): string => path.join(semanticRoot, ...rel.split('/'));
  let plan = planProjectNamingMigration(deps);

  // v4 files go through the v5 migration first (its own prompt), and then straight on here (#182).
  if (plan.v4SubjectAreas.length > 0 && plan.refusals.length === 1 && deps.migrateToV5) {
    const migrateToV5 = deps.migrateToV5;
    if (!(await migrateToV5().catch((err: unknown) => { throw new V5StepFailed(err); }))) return 'cancelled';
    plan = planProjectNamingMigration(deps);
  }
  if (plan.refusals.length > 0) {
    void vscode.window.showWarningMessage(`${MIGRATE_NAMING_TITLE}: nothing was changed.`, { modal: true, detail: describeNamingMigration(plan) });
    return 'refused';
  }
  if (namingMigrationIsEmpty(plan)) {
    void vscode.window.showInformationMessage(`${MIGRATE_NAMING_TITLE}: this project already uses the new file naming.`);
    return 'nothing';
  }

  const touched = [...plan.moves.flatMap((m) => [abs(m.from), abs(m.to)]), ...plan.rewrites.map((r) => abs(r.path))];
  const relPath = (p: string): string => path.relative(deps.workspaceRoot, p).split(path.sep).join('/');
  const dirtyPaths = dirtyFiles(touched);
  if (dirtyPaths.length > 0) {
    const dirty = dirtyPaths.map(relPath);
    const saveAndRetry = async (): Promise<void> => {
      for (const [i, filePath] of dirtyPaths.entries()) {
        if (!(await saveDocumentByUri(vscode.Uri.file(filePath)))) {
          // Nothing to retry: the migration would stop on the same file.
          showErrorWithActions(
            `${MIGRATE_NAMING_TITLE}: ERD Studio couldn't save ${dirty[i]}. Save or revert it yourself, then migrate. Nothing was changed.`,
            { [SHOW_FILE_BUTTON]: showFile(filePath) },
          );
          return;
        }
      }
      await retry();
    };
    showErrorWithActions(
      `${MIGRATE_NAMING_TITLE}: ${listFiles(dirty)} ` +
        `${dirty.length === 1 ? 'has' : 'have'} unsaved edits. Save or revert ${dirty.length === 1 ? 'it' : 'them'}, then migrate. Nothing was changed.`,
      { [SHOW_FILE_BUTTON]: showFile(dirtyPaths[0]), [SAVE_AND_TRY_AGAIN_BUTTON]: saveAndRetry },
    );
    return 'refused';
  }

  const choice = await vscode.window.showInformationMessage(
    'Move this project to the new file naming?',
    { modal: true, detail: confirmDetail(plan, deps.version) },
    MIGRATE_NAMING_BUTTON,
  );
  if (choice !== MIGRATE_NAMING_BUTTON) {
    return 'cancelled';
  }
  // The dialog may have waited: plan again from the files as they are now.
  const again = planProjectNamingMigration(deps);
  if (again.refusals.length > 0 || describeNamingMigration(again) !== describeNamingMigration(plan)
    || dirtyFiles(touched).length > 0) {
    showErrorWith(
      (m, ...items) => vscode.window.showWarningMessage(m, ...items),
      `${MIGRATE_NAMING_TITLE}: the project changed while the dialog was open. Nothing was changed; run it again.`,
      { [TRY_AGAIN_BUTTON]: retry },
      (choice, err) => {
        console.error(`[ERD Studio] ${MIGRATE_NAMING_TITLE}: "${choice}" failed:`, err);
      },
    );
    return 'cancelled';
  }
  plan = again;

  const edit = new vscode.WorkspaceEdit();
  for (const move of plan.moves) {
    const to = abs(move.to);
    if (move.text === undefined) {
      edit.renameFile(vscode.Uri.file(abs(move.from)), vscode.Uri.file(to), { overwrite: false });
    } else {
      edit.createFile(vscode.Uri.file(to), { overwrite: false, contents: Buffer.from(move.text, 'utf-8') });
      edit.deleteFile(vscode.Uri.file(abs(move.from)), { ignoreIfNotExists: false });
    }
  }
  const docs: vscode.TextDocument[] = [];
  for (const rewrite of plan.rewrites) {
    // A text edit, never a delete and a create of the same path: VS Code
    // cannot undo that pair (it re-creates the file before deleting it).
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs(rewrite.path)));
    // VS Code keeps a BOM out of the document's text (and writes it back on save).
    edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), rewrite.text.replace(/^\uFEFF/, ''));
    docs.push(doc);
  }

  // The target folders are made only now, once nothing above can throw, so a
  // failure while building the edit leaves no empty `tables/` behind.
  const newFolders = new Set<string>();
  try {
    for (const move of plan.moves) {
      const to = abs(move.to);
      for (let dir = path.dirname(to); dir.length > semanticRoot.length && !fs.existsSync(dir); dir = path.dirname(dir)) newFolders.add(dir);
      fs.mkdirSync(path.dirname(to), { recursive: true });
    }
  } catch (err) {
    removeFolders(newFolders);
    throw new FolderNotCreated(err);
  }

  // Released (once) before the canvases redraw, or if anything throws first.
  const held = deps.holdRefreshes?.();
  let released = false;
  const release = (): void => { if (!released) { released = true; held?.(); } };
  try {
    return await applyMigration(deps, plan, edit, docs, newFolders, semanticRoot, abs, release, progress, retry);
  } finally {
    release();
  }
}

/** Apply the built edit, save, record own writes and tidy up; refreshes are held by the caller. */
async function applyMigration(
  deps: MigrateNamingDeps,
  plan: NamingMigrationPlan,
  edit: vscode.WorkspaceEdit,
  docs: vscode.TextDocument[],
  newFolders: Set<string>,
  semanticRoot: string,
  abs: (rel: string) => string,
  release: () => void,
  progress: { applied: boolean; unsaved: boolean },
  retry: () => Promise<MigrateNamingOutcome>,
): Promise<MigrateNamingOutcome> {
  const touched = [...plan.moves.flatMap((m) => [abs(m.from), abs(m.to)]), ...plan.rewrites.map((r) => abs(r.path))];
  if (!(await vscode.workspace.applyEdit(edit))) {
    removeFolders(newFolders);
    telemetry.error('editRejected');
    showErrorWithActions(
      `${MIGRATE_NAMING_TITLE}: VS Code didn't accept the file moves, so nothing was changed. ` +
        "This is usually a file another program has open or a folder you can't write to.",
      {
        [TRY_AGAIN_BUTTON]: retry,
        [SEND_FEEDBACK_BUTTON]: sendFeedback('applying the file moves', new Error('VS Code did not apply the edit (applyEdit returned false).')),
      },
    );
    return 'failed';
  }
  progress.applied = true;
  // Own writes only once the bytes are on disk, so the watchers skip them.
  const unsaved: vscode.Uri[] = [];
  for (const doc of docs) {
    if (await saveDocumentByUri(doc.uri)) ownWrites.recordWrite(doc.uri.fsPath);
    else unsaved.push(doc.uri);
  }
  for (const move of plan.moves) {
    ownWrites.recordWrite(abs(move.to));
    ownWrites.recordDelete(abs(move.from));
  }
  // The folders the moves emptied go, so the project reads as v6 alone.
  const emptied = new Set(plan.moves.map((m) => path.dirname(abs(m.from))));
  for (const folder of [...emptied].sort((a, b) => b.length - a.length)) {
    try { if (fs.readdirSync(folder).length === 0) fs.rmdirSync(folder); } catch { /* already gone */ }
  }
  const v5Root = path.join(semanticRoot, LOGICAL_MODELS_DIR);
  try { if (fs.readdirSync(v5Root).length === 0) fs.rmdirSync(v5Root); } catch { /* already gone */ }

  saveMigratedOnUndo(docs.map((d) => d.uri.fsPath), newFolders);
  deps.tableLibraryService.invalidateCache();
  // Said before the refresh, so a refresh that throws cannot hide it.
  if (unsaved.length > 0) {
    progress.unsaved = true;
    telemetry.error('saveFailed');
    showUnsaved(deps, unsaved);
  }
  release();
  await deps.onMigrated(touched);
  if (unsaved.length === 0) {
    const parts = [
      plan.moves.length > 0 ? `${plan.moves.length} table file${plan.moves.length === 1 ? '' : 's'} moved to ${TABLES_DIR}/` : '',
      plan.rewrites.length > 0 ? `${plan.rewrites.length} subject area${plan.rewrites.length === 1 ? '' : 's'} updated` : '',
    ].filter(Boolean);
    void vscode.window.showInformationMessage(`Migrated to the new file naming: ${parts.join(', ')}. Edit > Undo, straight away, puts every file back.`);
  }
  return 'migrated';
}

/**
 * Some migrated subject areas did not save: the change is in their open
 * documents only. Save All tries again (and says which still won't);
 * Show File opens the first. Edit > Undo is still the way back.
 */
function showUnsaved(deps: Pick<MigrateNamingDeps, 'workspaceRoot'>, unsaved: readonly vscode.Uri[]): void {
  const shown = (uris: readonly vscode.Uri[]): string => listFiles(uris.map((u) => path.relative(deps.workspaceRoot, u.fsPath).split(path.sep).join('/')));
  const saveAll = async (): Promise<void> => {
    const still: vscode.Uri[] = [];
    for (const uri of unsaved) {
      if (await saveDocumentByUri(uri)) ownWrites.recordWrite(uri.fsPath);
      else still.push(uri);
    }
    if (still.length > 0) {
      showErrorWithActions(
        `${MIGRATE_NAMING_TITLE}: still could not save ${shown(still)}. Save it from its tab, or use Edit > Undo to put every file back.`,
        { [SHOW_FILE_BUTTON]: showFile(still[0].fsPath) },
      );
    }
  };
  showErrorWithActions(
    `${MIGRATE_NAMING_TITLE}: could not save ${shown(unsaved)}; the change is open in the editor but not on disk. Save it from its tab.`,
    { [SAVE_ALL_BUTTON]: saveAll, [SHOW_FILE_BUTTON]: showFile(unsaved[0].fsPath) },
  );
}
