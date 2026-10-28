/**
 * ERD Studio: Convert Project to DBML (native DBML storage, §6.2 and D22 of
 * docs/plans/native-dbml-storage.md).
 *
 * Stores a YAML/JSON (or mixed, or half-converted) project as DBML, as
 * `planDbmlConversion` plans it: prompted, with the whole plan (or what stops
 * it) as a scrollable list in the Convert to DBML panel (`ConvertToDbmlPanel`);
 * one WorkspaceEdit applied by `applyFileWrites` (creates, then replaces,
 * then deletes, D23), which puts back whatever landed when VS Code refuses
 * part of it. Edit > Undo straight after (while VS Code stays open) puts
 * every file back; a replaced file's undo is saved too, so the disk follows.
 * VS Code undoes a WorkspaceEdit only from an editor showing one of its
 * files (from the Explorer, or with no editor, Undo does nothing), so
 * Convert always leaves one in front: the converted canvases it reopens,
 * else the first converted diagram, else the first new `.dbml` file.
 *
 * It copies `migrateNaming.ts` step by step, and like it never shows the raw
 * exception (#219): a failure the user can act on offers the next step; any
 * other is ERD Studio's, with Send Feedback.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { LOGICAL_MODELS_DIR } from '@erd-studio/core';

import { applyFileWrites } from '../providers/applyFileWrites';
import { ConvertToDbmlPanel, type ConvertPanelChoice } from '../providers/ConvertToDbmlPanel';
import { dirtyFiles } from '../providers/dirtyDocuments';
import { saveDocumentByUri } from '../providers/documentSave';
import {
  SAVE_AND_TRY_AGAIN_BUTTON,
  SEND_FEEDBACK_BUTTON,
  SHOW_FILE_BUTTON,
  TRY_AGAIN_BUTTON,
  feedbackPrefill,
  oursMessage,
  projectRelative,
  showErrorWithActions as showErrorWith,
  type ErrorActions,
} from '../services/commandErrors';
import { dbmlConversionIsEmpty, describeDbmlConversion, planDbmlConversion } from '../services/dbmlConversion';
import type { DbmlConversionPlan } from '../services/dbmlConversion';
import { buildConvertReview } from '../services/dbmlConversionReview';
import { readDbmlConversionInput } from '../services/dbmlConversionFiles';
import type { FileWrite } from '../services/fileWrites';
import type { TableLibraryService } from '../services/logicalModelService';
import { ownWrites } from '../services/ownWriteTracker';
import { telemetry } from '../services/telemetryService';

export const CONVERT_TO_DBML_TITLE = 'Convert Project to DBML';

/** The custom editor's view type, for reopening converted diagrams. */
const CANVAS_VIEW_TYPE = 'erdStudio.domainEditor';

/** The panel's fixed lines (§6.2 step 6). */
export const CONVERT_WHAT_LINE =
  'Convert writes the tables, relationships and diagrams below as DBML files and removes the YAML and JSON files they came from, in one edit.';
export const CONVERT_TEAMMATES_LINE =
  'Everyone who opens this project needs ERD Studio 2.0 or later. Older versions show no diagrams, and AI helper files from before 2.0 ' +
  'write YAML: update them afterwards (ERD Studio: Set Up My AI Helper).';
export const CONVERT_GIT_LINE =
  'Git will show the converted files as new files, because their content changes completely, so their history does not follow them. Commit your work first.';
export const CONVERT_RESUME_LINE = 'An earlier conversion stopped part way; this finishes it.';
export const CONVERT_UNDO_LINE =
  'Undo: Edit > Undo straight after, with the diagram or file Convert opens (or any converted file) in front, while VS Code stays open; or restore from source control.';

export interface ConvertProjectDeps {
  workspaceRoot: string;
  semanticDir: string;
  tableLibraryService: Pick<TableLibraryService, 'invalidateCache' | 'projectStorage'>;
  /** Runs "Migrate Subject Areas to the Central Table Library" for v4 files; true when it converted them. */
  migrateToV5?: () => Promise<boolean>;
  /** Every file the conversion wrote or deleted: refresh the views, context keys and open canvases. */
  onConverted: (paths: string[]) => Promise<void>;
  /** Hold open canvases' refreshes while the edit applies; returns the release. */
  holdRefreshes?: () => () => void;
}

export type ConvertProjectOutcome = 'converted' | 'nothing' | 'refused' | 'cancelled' | 'failed';

/** Files a conversion replaced this session: an undo or redo of one is saved, so the disk follows. */
const convertedReplaces = new Set<string>();
let undoListener: vscode.Disposable | undefined;

function saveReplacedOnUndo(paths: readonly string[]): void {
  for (const p of paths) convertedReplaces.add(path.resolve(p));
  if (undoListener || paths.length === 0) return;
  undoListener = vscode.workspace.onDidChangeTextDocument((e) => {
    const undoRedo = e.reason === vscode.TextDocumentChangeReason?.Undo || e.reason === vscode.TextDocumentChangeReason?.Redo;
    if (!undoRedo || !convertedReplaces.has(path.resolve(e.document.uri.fsPath))) return;
    setTimeout(() => {
      if (!e.document.isDirty) return;
      void e.document.save().then((saved) => { if (saved) ownWrites.recordWrite(e.document.uri.fsPath); });
    }, 50);
  });
}

function showErrorWithActions(
  message: string,
  actions: ErrorActions,
  show: (message: string, ...items: string[]) => PromiseLike<string | undefined> = (m, ...items) => vscode.window.showErrorMessage(m, ...items),
): void {
  showErrorWith(show, message, actions, (choice, err) => {
    console.error(`[ERD Studio] ${CONVERT_TO_DBML_TITLE}: "${choice}" failed:`, err);
    const doing = `while running ${choice}`;
    showErrorWithActions(oursMessage(CONVERT_TO_DBML_TITLE, doing, 'nothing more was changed'), { [SEND_FEEDBACK_BUTTON]: sendFeedback(doing, err) });
  });
}

function sendFeedback(doing: string, err: unknown): () => unknown {
  return () => vscode.commands.executeCommand('erdStudio.reportBug', feedbackPrefill(CONVERT_TO_DBML_TITLE, doing, err));
}

function listFiles(names: readonly string[]): string {
  return `${names.slice(0, 5).join(', ')}${names.length > 5 ? ` and ${names.length - 5} more` : ''}`;
}

/** The plan for the project as it is on disk now. */
export async function planProjectDbmlConversion(deps: Pick<ConvertProjectDeps, 'workspaceRoot' | 'semanticDir' | 'tableLibraryService'>): Promise<DbmlConversionPlan> {
  deps.tableLibraryService.invalidateCache();
  return planDbmlConversion(readDbmlConversionInput(deps.workspaceRoot, deps.semanticDir));
}

/** The review's header lines (§6.2 step 6). */
export function convertIntroLines(plan: DbmlConversionPlan): string[] {
  return [
    CONVERT_WHAT_LINE,
    CONVERT_TEAMMATES_LINE,
    CONVERT_GIT_LINE,
    ...(plan.resumed.length > 0 ? [CONVERT_RESUME_LINE] : []),
    CONVERT_UNDO_LINE,
  ];
}

/**
 * Show the plan, or its refusals, in the Convert to DBML panel and wait for
 * the user's choice. Paths are shown project-relative; a refusal opens only a
 * file that is on disk under the semantic dir.
 */
function showConvertPanel(deps: Pick<ConvertProjectDeps, 'workspaceRoot' | 'semanticDir'>, plan: DbmlConversionPlan, nothingChanged: string): Promise<ConvertPanelChoice> {
  const semanticRoot = path.join(deps.workspaceRoot, deps.semanticDir);
  const abs = (rel: string): string => path.join(semanticRoot, ...rel.split('/'));
  const { view, locations } = buildConvertReview(plan, {
    display: (rel) => projectRelative(deps.workspaceRoot, abs(rel)),
    exists: (rel) => fs.existsSync(abs(rel)),
    introLines: convertIntroLines(plan),
    nothingChanged,
  });
  return ConvertToDbmlPanel.show({ view, locations, semanticRoot });
}

/** The v4 step threw: it has counted and logged its own failure. */
class V5StepFailed extends Error {
  constructor(readonly cause: unknown) {
    super('the v4 migration failed');
    this.name = 'V5StepFailed';
  }
}

/** The command. Never throws: anything unexpected is counted and shown as ERD Studio's, with Send Feedback (#219). */
export async function convertProjectToDbml(deps: ConvertProjectDeps): Promise<ConvertProjectOutcome> {
  const progress = { v5Converted: false, applied: false, counted: false };
  const retry = (): Promise<ConvertProjectOutcome> => convertProjectToDbml(deps);
  try {
    return await runConversion(deps, progress, retry);
  } catch (err) {
    ConvertToDbmlPanel.closeIfIdle();
    console.error('[convertProjectToDbml] failed:', err);
    // A conversion that landed counts as one, even when a later step (the refresh) threw.
    if (progress.applied) { if (!progress.counted) telemetry.feature('convertToDbml'); }
    else telemetry.error('convertToDbmlFailed');
    if (err instanceof V5StepFailed) {
      const doing = 'while converting the v4 subject areas';
      showErrorWithActions(oursMessage(CONVERT_TO_DBML_TITLE, doing, 'some files may already be converted (source control shows which)'), {
        [SEND_FEEDBACK_BUTTON]: sendFeedback(doing, err.cause),
        [TRY_AGAIN_BUTTON]: retry,
      });
      return 'failed';
    }
    const doing = progress.applied ? 'after writing the DBML files' : 'while planning the conversion';
    const outcome = progress.applied
      ? 'open diagrams may not show the DBML files until you reopen them'
      : progress.v5Converted ? 'the v4 subject areas were converted to the Table Library, but nothing else was changed' : 'nothing was changed';
    showErrorWithActions(oursMessage(CONVERT_TO_DBML_TITLE, doing, outcome), {
      [SEND_FEEDBACK_BUTTON]: sendFeedback(doing, err),
      ...(progress.applied ? {} : { [TRY_AGAIN_BUTTON]: retry }),
    });
    return progress.applied ? 'converted' : 'failed';
  } finally {
    // Whatever ended the run (a toast, a refusal by name, nothing to do), a
    // panel no run is waiting on closes.
    ConvertToDbmlPanel.closeIfIdle();
  }
}

async function runConversion(
  deps: ConvertProjectDeps,
  progress: { v5Converted: boolean; applied: boolean; counted: boolean },
  retry: () => Promise<ConvertProjectOutcome>,
): Promise<ConvertProjectOutcome> {
  const semanticRoot = path.join(deps.workspaceRoot, deps.semanticDir);
  const abs = (rel: string): string => path.join(semanticRoot, ...rel.split('/'));
  const nothingChanged = (): string => (progress.v5Converted
    ? 'The v4 subject areas were converted to the Table Library, but nothing else was changed.'
    : 'Nothing was changed.');

  // 1. Read and plan.
  let plan = await planProjectDbmlConversion(deps);

  // What stops it, in the panel: Check Again plans again; Close (or closing the tab) ends the run.
  const refused = async (): Promise<ConvertProjectOutcome> => {
    telemetry.feature('convertToDbmlRefused');
    const choice = await showConvertPanel(deps, plan, nothingChanged());
    return choice === 'checkAgain' ? retry() : 'refused';
  };

  // 2. v4 diagrams go through the v5 migration first (its own prompt), then straight on here.
  if (plan.v4SubjectAreas.length > 0) {
    if (!deps.migrateToV5) return refused();
    const migrateToV5 = deps.migrateToV5;
    if (!(await migrateToV5().catch((err: unknown) => { throw new V5StepFailed(err); }))) {
      telemetry.feature('convertToDbmlCancelled');
      return 'cancelled';
    }
    progress.v5Converted = true;
    plan = await planProjectDbmlConversion(deps);
    if (plan.v4SubjectAreas.length > 0) return refused();
  }

  // 3. Refusals: the panel lists them, each with Open at its file and line.
  if (plan.refusals.length > 0) return refused();

  // 4. Nothing to convert.
  if (dbmlConversionIsEmpty(plan)) {
    void vscode.window.showInformationMessage(deps.tableLibraryService.projectStorage() === 'dbml'
      ? 'This project is already stored as DBML.'
      : `${CONVERT_TO_DBML_TITLE}: there is nothing to convert (no YAML tables and no JSON diagrams).`);
    return 'nothing';
  }

  // 5. Unsaved edits to any file it touches: refused, by name.
  const touched = (p: DbmlConversionPlan): string[] => [
    ...p.creates.map((c) => abs(c.path)),
    ...p.replaces.map((r) => abs(r.path)),
    ...p.deletes.map(abs),
  ];
  const dirtyPaths = dirtyFiles(touched(plan));
  if (dirtyPaths.length > 0) {
    const dirty = dirtyPaths.map((p) => projectRelative(deps.workspaceRoot, p));
    const saveAndRetry = async (): Promise<void> => {
      for (const [i, filePath] of dirtyPaths.entries()) {
        if (!(await saveDocumentByUri(vscode.Uri.file(filePath)))) {
          showErrorWithActions(
            `${CONVERT_TO_DBML_TITLE}: ERD Studio couldn't save ${dirty[i]}. Save or revert it yourself, then convert. ${nothingChanged()}`,
            { [SHOW_FILE_BUTTON]: () => vscode.window.showTextDocument(vscode.Uri.file(filePath)) },
          );
          return;
        }
      }
      await retry();
    };
    showErrorWithActions(
      `${CONVERT_TO_DBML_TITLE}: ${listFiles(dirty)} ${dirty.length === 1 ? 'has' : 'have'} unsaved edits. ` +
        `Save or revert ${dirty.length === 1 ? 'it' : 'them'}, then convert. ${nothingChanged()}`,
      { [SHOW_FILE_BUTTON]: () => vscode.window.showTextDocument(vscode.Uri.file(dirtyPaths[0])), [SAVE_AND_TRY_AGAIN_BUTTON]: saveAndRetry },
    );
    return 'refused';
  }

  // 6. The panel, with the whole plan as a scrollable list. A newer run that
  // took the panel over (the command run again) ends this one uncounted.
  const choice = await showConvertPanel(deps, plan, nothingChanged());
  if (choice === 'superseded') return 'cancelled';
  if (choice !== 'convert') {
    telemetry.feature('convertToDbmlCancelled');
    return 'cancelled';
  }

  // 7. The panel may have waited: plan again from the files as they are now (#219).
  const again = await planProjectDbmlConversion(deps);
  if (again.refusals.length > 0 || describeDbmlConversion(again) !== describeDbmlConversion(plan) || dirtyFiles(touched(again)).length > 0) {
    showErrorWithActions(
      `${CONVERT_TO_DBML_TITLE}: the project changed while the preview was open. ${nothingChanged()} Run it again.`,
      { [TRY_AGAIN_BUTTON]: retry },
      (m, ...items) => vscode.window.showWarningMessage(m, ...items),
    );
    return 'cancelled';
  }
  plan = again;

  // 8. The writes (D23: creates, relationships files first, then replaces, then deletes).
  const writes: FileWrite[] = [
    ...plan.creates.map((c): FileWrite => ({ kind: 'create', path: abs(c.path), text: c.text })),
    ...plan.replaces.map((r): FileWrite => ({ kind: 'replace', path: abs(r.path), text: r.text })),
    ...plan.deletes.map((d): FileWrite => ({ kind: 'delete', path: abs(d) })),
  ];
  // Folders are made only while the edit is built, and go again if it does not land.
  const newFolders = new Set<string>();
  const ensureDir = (filePath: string): void => {
    for (let dir = path.dirname(filePath); dir.length > semanticRoot.length && !fs.existsSync(dir); dir = path.dirname(dir)) newFolders.add(dir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  };
  const removeNewFolders = (): void => {
    for (const folder of [...newFolders].sort((a, b) => b.length - a.length)) {
      try { if (fs.readdirSync(folder).length === 0) fs.rmdirSync(folder); } catch { /* gone, or not empty */ }
    }
  };

  // 9. One WorkspaceEdit, reconciled by applyFileWrites when VS Code refuses part of it.
  const held = deps.holdRefreshes?.();
  let released = false;
  const release = (): void => { if (!released) { released = true; held?.(); } };
  // The canvases to reopen, read before VS Code may close a deleted file's tab itself.
  const canvasTabs = convertedCanvasTabs(plan, abs);
  try {
    const applied = await applyFileWrites(writes, { ensureDir });
    // Convert has finished with the panel: close it before anything opens, so
    // the editor Convert leaves in front is the one Undo works from.
    ConvertToDbmlPanel.closeIfIdle();
    if (!applied.ok) {
      removeNewFolders();
      telemetry.error('convertToDbmlFailed');
      if (applied.unrestored.length === 0) {
        showErrorWithActions(
          `${CONVERT_TO_DBML_TITLE}: VS Code didn't accept the conversion, so nothing was changed. ` +
            "This is usually a file another program has open or a folder you can't write to.",
          {
            [TRY_AGAIN_BUTTON]: retry,
            [SEND_FEEDBACK_BUTTON]: sendFeedback('applying the conversion', new Error('VS Code did not apply the edit (applyEdit returned false).')),
          },
        );
      }
      // Otherwise applyFileWrites' modal named the files it could not put back;
      // running Convert again finishes the job (doctor: finish-dbml-conversion).
      return 'failed';
    }
    progress.applied = true;
    const unsaved: string[] = [];
    for (const uri of applied.replaced) {
      if (await saveDocumentByUri(uri)) ownWrites.recordWrite(uri.fsPath);
      else unsaved.push(uri.fsPath);
    }
    for (const filePath of applied.created) ownWrites.recordWrite(filePath);
    for (const filePath of applied.deleted) ownWrites.recordDelete(filePath);
    saveReplacedOnUndo(applied.replaced.map((u) => u.fsPath));

    // 10. The emptied logical-models/ (and its folders) go; tables/ stays.
    const v5Root = path.join(semanticRoot, LOGICAL_MODELS_DIR);
    const emptied = new Set(plan.deletes.map((d) => path.dirname(abs(d))).filter((d) => d.startsWith(v5Root)));
    for (const folder of [...emptied, v5Root].sort((a, b) => b.length - a.length)) {
      try { if (fs.readdirSync(folder).length === 0) fs.rmdirSync(folder); } catch { /* already gone, or not empty */ }
    }

    // 11. Canvases of converted diagrams: closed, and their .dbml reopened in the
    // canvas; with none open, a converted diagram that opens without writing
    // (or else a new file, as text) is opened, so Edit > Undo has an editor of
    // the edit to undo from and nothing lands on top of it.
    const placed = new Set(plan.placedDiagrams.map((d) => path.resolve(abs(d))));
    const reopened = await reopenConvertedCanvases(canvasTabs);
    const undoFrom: UndoFrom = reopened.length > 0
      ? (reopened.every((target) => placed.has(path.resolve(target))) ? 'diagram' : 'unplacedDiagram')
      : await openUndoTarget(plan, abs);

    // 12. Refresh.
    deps.tableLibraryService.invalidateCache();
    release();
    await deps.onConverted([...writes.map((w) => w.path)]);
    telemetry.feature('convertToDbml');
    progress.counted = true;
    if (unsaved.length > 0) {
      telemetry.error('saveFailed');
      showErrorWithActions(
        `${CONVERT_TO_DBML_TITLE}: could not save ${listFiles(unsaved.map((p) => projectRelative(deps.workspaceRoot, p)))}; ` +
          'the change is open in the editor but not on disk. Save it from its tab.',
        { [SHOW_FILE_BUTTON]: () => vscode.window.showTextDocument(vscode.Uri.file(unsaved[0])) },
      );
    } else {
      const s = plan.summary;
      void vscode.window.showInformationMessage(
        `Converted to DBML: ${s.tables} table${s.tables === 1 ? '' : 's'}, ${s.diagrams} diagram${s.diagrams === 1 ? '' : 's'}. ` +
          convertedUndoSentence(undoFrom),
      );
    }
    return 'converted';
  } finally {
    release();
  }
}

/**
 * The tabs showing a converted `.json` diagram, and the `.dbml` each becomes.
 * Read before the edit applies: VS Code may close a deleted file's tab itself.
 */
function convertedCanvasTabs(plan: DbmlConversionPlan, abs: (rel: string) => string): Array<{ tab: vscode.Tab; target: string }> {
  const converted = new Map<string, string>();
  for (const d of plan.deletes) {
    if (!d.endsWith('.json')) continue;
    converted.set(path.resolve(abs(d)), abs(`${d.slice(0, -'.json'.length)}.dbml`));
  }
  const out: Array<{ tab: vscode.Tab; target: string }> = [];
  if (converted.size === 0) return out;
  for (const group of vscode.window.tabGroups?.all ?? []) {
    for (const tab of group.tabs) {
      const input = tab.input as { uri?: vscode.Uri } | undefined;
      const fsPath = input?.uri?.fsPath;
      const target = fsPath ? converted.get(path.resolve(fsPath)) : undefined;
      if (target !== undefined) out.push({ tab: tab as vscode.Tab, target });
    }
  }
  return out;
}

/** What Convert left in front for Undo: a diagram that opened without writing, one that saves its layout on open, a file as text, or nothing. */
export type UndoFrom = 'diagram' | 'unplacedDiagram' | 'file' | undefined;

/** The toast's undo sentence: undo works from an editor of the edit's files, so it names the one Convert left in front. */
export function convertedUndoSentence(undoFrom: UndoFrom): string {
  if (undoFrom === 'unplacedDiagram') {
    // The reopened canvas lays out tables with no place and saves that layout, an edit on top of the conversion.
    return 'To undo, use Edit > Undo with this diagram in front until every file is back, or restore from source control.';
  }
  return undoFrom
    ? `Edit > Undo, straight away, with this ${undoFrom} in front, puts every file back.`
    : 'Edit > Undo, straight away, with a converted file open in front, puts every file back.';
}

/**
 * With no converted canvas reopened: open the first converted diagram whose
 * layout places every table (in the canvas, which then writes nothing), else
 * the first converted diagram's `.dbml` (else any new `.dbml`) as text, so
 * the editor in front is one Edit > Undo can undo the conversion from and
 * no layout write lands on top of it. Which it opened, or undefined when it
 * opened nothing. Never throws.
 */
async function openUndoTarget(plan: DbmlConversionPlan, abs: (rel: string) => string): Promise<UndoFrom> {
  const created = new Set(plan.creates.map((c) => c.path));
  const diagrams = plan.deletes
    .filter((d) => d.endsWith('.json'))
    .map((d) => `${d.slice(0, -'.json'.length)}.dbml`)
    .filter((d) => created.has(d));
  const placed = new Set(plan.placedDiagrams);
  try {
    const diagram = diagrams.find((d) => placed.has(d));
    if (diagram) {
      await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(abs(diagram)), CANVAS_VIEW_TYPE);
      return 'diagram';
    }
    const file = diagrams[0] ?? plan.creates.find((c) => c.path.endsWith('.dbml'))?.path;
    if (file) {
      await vscode.window.showTextDocument(vscode.Uri.file(abs(file)));
      return 'file';
    }
  } catch (err) {
    console.warn('[convertProjectToDbml] could not open a converted file:', err);
  }
  return undefined;
}

/**
 * Close each converted diagram's tab that is still open, and open its `.dbml`
 * with the canvas instead. The targets it opened.
 */
async function reopenConvertedCanvases(tabs: ReadonlyArray<{ tab: vscode.Tab; target: string }>): Promise<string[]> {
  const reopen: string[] = [];
  for (const { tab, target } of tabs) {
    const stillOpen = (vscode.window.tabGroups?.all ?? []).some((g) => g.tabs.includes(tab));
    if (stillOpen) {
      try {
        await vscode.window.tabGroups.close(tab);
      } catch { /* already closed */ }
    }
    if (!reopen.includes(target)) reopen.push(target);
  }
  const opened: string[] = [];
  for (const target of reopen) {
    try {
      await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(target), CANVAS_VIEW_TYPE);
      opened.push(target);
    } catch (err) {
      console.warn(`[convertProjectToDbml] could not reopen ${target}:`, err);
    }
  }
  return opened;
}
