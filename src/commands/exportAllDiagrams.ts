/**
 * **Export All Diagrams…** (`erdStudio.exportAllDiagrams`) — every subject
 * area's logical (design) stage, one file each, into a folder the user picks:
 * format → folder → write. With DBML for dbdiagram.io (`dbml-rich`) each
 * `.dbml` gets its `.dbdiagram` layout file beside it, so the folder is
 * ready for `dbdiagram push`.
 *
 * The files come from `exportSubjectAreaFiles` (`src/services/diagramExport.ts`),
 * the same read and the same names `erd-studio export --all` prints: one
 * file per domain named after it, `<layer>-<name>` when two layers hold a
 * domain of the same name. A domain that cannot be read is skipped and named
 * at the end; it never stops the rest.
 *
 * Writes no ERD Studio file — only the export files, through `workspace.fs`,
 * into the folder the user chose. It asks once before replacing any file
 * already there, before writing anything.
 *
 * Every vscode call goes through `ExportAllDiagramsUi`, so the flow is
 * unit-tested with plain fakes; `vscodeExportAllUi()` is the real one
 * `activate()` uses.
 */

import * as path from 'path';
import * as vscode from 'vscode';

import type { DiagramExportFormat } from '@erd-studio/core';

import {
  SEND_FEEDBACK_BUTTON,
  classifyWriteFailure,
  describeDiagramFileProblem,
  feedbackPrefill,
  oursMessage,
  projectRelative,
  showErrorWithActions,
  type ErrorActions,
  type FeedbackPrefill,
} from '../services/commandErrors';
import type { ExportedFile, SubjectAreaFilesExport } from '../services/diagramExport';
import { telemetry } from '../services/telemetryService';
import type { SubjectAreaSummary } from '../types/semantic';
import { FORMAT_ITEMS, FORMAT_LABELS, NO_DIAGRAMS_MESSAGE, exportInsideSemanticDirMessage, isInsideFolder } from './exportDiagram';

export const EXPORT_ALL_DIAGRAMS_COMMAND = 'erdStudio.exportAllDiagrams';

/** Every title says which stage is exported, as Export Diagram's does. */
export const EXPORT_ALL_TITLE = 'Export All Diagrams (logical design)';

export const EXPORT_HERE_LABEL = 'Export Here';
export const REPLACE_FILES_BUTTON = 'Replace';
export const CHOOSE_ANOTHER_FOLDER_BUTTON = 'Choose Another Folder';

/** The name the "ours" message gives the command. */
const COMMAND_NAME = 'Export All Diagrams';

/** How many file names a message lists before "and N more". */
const LISTED = 10;

/** Every vscode call the flow makes, injectable for tests. */
export interface ExportAllDiagramsUi {
  showQuickPick<T extends vscode.QuickPickItem>(items: readonly T[], options: vscode.QuickPickOptions): Promise<T | undefined>;
  showOpenDialog(options: vscode.OpenDialogOptions): Promise<vscode.Uri[] | undefined>;
  /** Whether a file (or anything) is at `uri`. */
  fileExists(uri: vscode.Uri): Promise<boolean>;
  writeFile(uri: vscode.Uri, content: string): Promise<void>;
  /** A modal warning (VS Code adds Cancel): the button picked, undefined when cancelled. */
  showModalWarning(message: string, detail: string, ...items: string[]): Promise<string | undefined>;
  showInformationMessage(message: string, ...items: string[]): Promise<string | undefined>;
  showWarningMessage(message: string, ...items: string[]): Promise<string | undefined>;
  /** Resolves the button picked; the flow never awaits it. */
  showErrorMessage(message: string, ...items: string[]): Promise<string | undefined>;
  /** Open Send Feedback (`erdStudio.reportBug`) with this prefill. */
  sendFeedback(prefill: FeedbackPrefill): Promise<void>;
}

export interface ExportAllDiagramsDeps {
  /** Every subject area in the project (`SubjectAreaService.listSubjectAreas`). */
  listSubjectAreas: () => SubjectAreaSummary[];
  /** `exportSubjectAreaFiles` bound to this window's services. Skips what it cannot read. */
  exportAll: (domainPaths: readonly string[], format: DiagramExportFormat) => Promise<SubjectAreaFilesExport>;
  /** Where the folder picker starts (the project root). */
  defaultFolder?: string;
  /** The semantic dir, absolute: a folder inside it is refused (§5.7), since files there are the diagrams' own storage. */
  semanticRoot?: string;
  /** The dbt project root, which messages name files and folders relative to. */
  projectRoot?: string;
  ui?: ExportAllDiagramsUi;
}

/** What the export ended in; undefined when the user cancelled or it failed (each already said so). */
export interface ExportAllDiagramsResult {
  format: DiagramExportFormat;
  folder: string;
  /** Every file written, as absolute paths, in write order. */
  written: string[];
  /** The domain files skipped because they could not be read. */
  skipped: string[];
}

/** `1 diagram`, `3 diagrams`. */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** Up to {@link LISTED} names, then "and N more". */
export function listNames(names: readonly string[]): string {
  const shown = names.slice(0, LISTED).join(', ');
  return names.length > LISTED ? `${shown} and ${names.length - LISTED} more` : shown;
}

/** A failure already put in words: the message and its buttons. */
interface ShownFailure {
  message: string;
  actions: ErrorActions;
}

/** Thrown inside the flow for a failure that is already in words, so the one catch shows them. */
class ExportAllFailure extends Error {
  constructor(readonly shown: ShownFailure) {
    super(shown.message);
  }
}

function oursFailure(err: unknown, ui: ExportAllDiagramsUi, doing = 'while exporting the diagrams', outcome = 'nothing was exported'): ShownFailure {
  return {
    message: oursMessage(COMMAND_NAME, doing, outcome),
    actions: { [SEND_FEEDBACK_BUTTON]: () => ui.sendFeedback(feedbackPrefill(COMMAND_NAME, doing, err)) },
  };
}

function showFailure(ui: ExportAllDiagramsUi, failure: ShownFailure): void {
  showErrorWithActions((m, ...items) => ui.showErrorMessage(m, ...items), failure.message, failure.actions, (choice, err) => {
    console.error(`[ERD Studio] ${COMMAND_NAME}: "${choice}" failed:`, err);
    showFailure(ui, oursFailure(err, ui, `while running ${choice}`));
  });
}

/** Run the flow. Never throws: a failure is shown and counted. */
export async function exportAllDiagramsCommand(deps: ExportAllDiagramsDeps): Promise<ExportAllDiagramsResult | undefined> {
  const ui = deps.ui ?? vscodeExportAllUi();
  try {
    return await runExportAll(deps, ui);
  } catch (err) {
    telemetry.error('exportFailed');
    showFailure(ui, err instanceof ExportAllFailure ? err.shown : oursFailure(err, ui));
    return undefined;
  }
}

async function runExportAll(deps: ExportAllDiagramsDeps, ui: ExportAllDiagramsUi): Promise<ExportAllDiagramsResult | undefined> {
  const subjectAreas = deps.listSubjectAreas();
  if (subjectAreas.length === 0) {
    telemetry.feature('exportNoDiagrams');
    void ui.showInformationMessage(NO_DIAGRAMS_MESSAGE);
    return undefined;
  }

  const formatPick = await ui.showQuickPick(FORMAT_ITEMS, {
    title: EXPORT_ALL_TITLE,
    placeHolder: subjectAreas.length === 1 ? 'Export the 1 diagram as…' : `Export all ${subjectAreas.length} diagrams as…`,
    ignoreFocusOut: true,
  });
  if (!formatPick) { return cancelled(); }
  const format = formatPick.format;

  // Read before asking where, so a project where nothing can be read says
  // so before another question.
  const exported = await deps.exportAll(subjectAreas.map((s) => s.filePath), format);
  const skipped = describeSkipped(deps, exported);
  if (exported.files.length === 0) {
    throw new ExportAllFailure(nothingReadable(ui, subjectAreas.length, skipped));
  }
  return chooseFolderAndWrite(deps, ui, format, exported, skipped, deps.defaultFolder);
}

/** A skipped domain, in words. */
interface SkippedInWords {
  domainPath: string;
  /** `silver/broken.json (there is a mistake at line 4, column 1: …)`. */
  text: string;
  /** Not the file's fault: ERD Studio's, offered as a report. */
  ours?: unknown;
}

function describeSkipped(deps: ExportAllDiagramsDeps, exported: SubjectAreaFilesExport): SkippedInWords[] {
  return exported.skipped.map(({ domainPath, error }) => {
    const shown = deps.projectRoot ? projectRelative(deps.projectRoot, domainPath) : path.basename(domainPath);
    const problem = describeDiagramFileProblem(error, domainPath, shown);
    return problem
      ? { domainPath, text: `${shown} (${problem.reason})` }
      : { domainPath, text: `${shown} (ERD Studio hit a problem reading it)`, ours: error };
  });
}

/** Every domain was skipped: say why each, with a report when any failure was ours. */
function nothingReadable(ui: ExportAllDiagramsUi, total: number, skipped: readonly SkippedInWords[]): ShownFailure {
  const ours = skipped.find((s) => s.ours !== undefined);
  const doing = 'while reading the diagrams';
  return {
    message: `None of the ${count(total, 'diagram')} could be exported, so nothing was written: ${listNames(skipped.map((s) => s.text))}.`,
    actions: ours ? { [SEND_FEEDBACK_BUTTON]: () => ui.sendFeedback(feedbackPrefill(COMMAND_NAME, doing, ours.ours)) } : {},
  };
}

/** The folder as messages name it: project-relative inside the project, else its own name. */
function folderShown(deps: ExportAllDiagramsDeps, folder: string): string {
  return deps.projectRoot ? projectRelative(deps.projectRoot, folder) : path.basename(folder);
}

/**
 * Ask for the folder, ask once before replacing anything there, then write
 * every file. Choose Another Folder after a failed write comes back here.
 */
async function chooseFolderAndWrite(
  deps: ExportAllDiagramsDeps,
  ui: ExportAllDiagramsUi,
  format: DiagramExportFormat,
  exported: SubjectAreaFilesExport,
  skipped: readonly SkippedInWords[],
  startAt: string | undefined,
): Promise<ExportAllDiagramsResult | undefined> {
  const picked = await ui.showOpenDialog({
    title: `${EXPORT_ALL_TITLE}: Choose a Folder for the ${FORMAT_LABELS[format]} Files`,
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: EXPORT_HERE_LABEL,
    ...(startAt ? { defaultUri: vscode.Uri.file(startAt) } : {}),
  });
  const folderUri = picked?.[0];
  if (!folderUri) { return cancelled(); }
  const folder = folderUri.fsPath;
  if (deps.semanticRoot !== undefined && isInsideFolder(deps.semanticRoot, folder)) {
    const outside = path.dirname(deps.semanticRoot);
    showFailure(ui, {
      message: exportInsideSemanticDirMessage(deps.semanticRoot),
      actions: { [CHOOSE_ANOTHER_FOLDER_BUTTON]: () => retryFolder(deps, ui, format, exported, skipped, outside) },
    });
    return cancelled();
  }
  const shownFolder = folderShown(deps, folder);
  const targets = exported.files.map((file) => ({ file, uri: vscode.Uri.file(path.join(folder, file.fileName)) }));

  // Independent checks, run together (one round trip each on a remote workspace).
  const found = await Promise.all(targets.map(({ uri }) => ui.fileExists(uri).catch(() => false)));
  const existing = targets.filter((_, i) => found[i]).map(({ file }) => file.fileName);
  if (existing.length > 0) {
    const choice = await ui.showModalWarning(
      existing.length === 1
        ? `1 of the ${count(targets.length, 'file')} already exists in ${shownFolder}. Replace it?`
        : `${existing.length} of the ${count(targets.length, 'file')} already exist in ${shownFolder}. Replace them?`,
      `Already there: ${listNames(existing)}.`,
      REPLACE_FILES_BUTTON,
    );
    if (choice !== REPLACE_FILES_BUTTON) { return cancelled(); }
  }

  const written: string[] = [];
  for (const { file, uri } of targets) {
    try {
      await ui.writeFile(uri, file.content);
    } catch (err) {
      throw new ExportAllFailure(writeFailure(deps, ui, format, exported, skipped, folder, file, written.length, targets.length, err));
    }
    written.push(uri.fsPath);
  }

  telemetry.feature('exportAll');
  reportDone(ui, format, exported.files, skipped, shownFolder);
  return { format, folder, written, skipped: skipped.map((s) => s.domainPath) };
}

/** A write failed part way: what is on disk now, and (for a folder or disk problem) another try elsewhere. */
function writeFailure(
  deps: ExportAllDiagramsDeps,
  ui: ExportAllDiagramsUi,
  format: DiagramExportFormat,
  exported: SubjectAreaFilesExport,
  skipped: readonly SkippedInWords[],
  folder: string,
  file: ExportedFile,
  writtenCount: number,
  total: number,
  err: unknown,
): ShownFailure {
  const before = writtenCount === 0 ? 'nothing was exported' : `${writtenCount} of the ${count(total, 'file')} were saved before it`;
  const failure = classifyWriteFailure(err);
  if (failure === 'other') {
    return oursFailure(err, ui, `while saving ${file.fileName}`, before);
  }
  const why = failure === 'permission' ? "ERD Studio isn't allowed to write to that folder" : 'the disk is full';
  const already = writtenCount === 0 ? 'Nothing was saved.' : `${writtenCount} of the ${count(total, 'file')} were saved before it.`;
  return {
    message: `Couldn't save ${file.fileName} in ${folderShown(deps, folder)}: ${why}. ${already}`,
    actions: { [CHOOSE_ANOTHER_FOLDER_BUTTON]: () => retryFolder(deps, ui, format, exported, skipped, folder) },
  };
}

/** Choose Another Folder: the folder step again, counted and shown as the first one was. */
async function retryFolder(
  deps: ExportAllDiagramsDeps,
  ui: ExportAllDiagramsUi,
  format: DiagramExportFormat,
  exported: SubjectAreaFilesExport,
  skipped: readonly SkippedInWords[],
  previous: string,
): Promise<void> {
  try {
    await chooseFolderAndWrite(deps, ui, format, exported, skipped, previous);
  } catch (err) {
    telemetry.error('exportFailed');
    showFailure(ui, err instanceof ExportAllFailure ? err.shown : oursFailure(err, ui));
  }
}

/** The closing message: how many diagrams went where, and any that were skipped (with a report if one was ours). */
function reportDone(
  ui: ExportAllDiagramsUi,
  format: DiagramExportFormat,
  files: readonly ExportedFile[],
  skipped: readonly SkippedInWords[],
  shownFolder: string,
): void {
  const diagrams = files.filter((f) => f.kind === 'diagram').length;
  const withLayout = files.some((f) => f.kind === 'layout') ? ', each with its table positions in a .dbdiagram file' : '';
  const done = `Exported ${count(diagrams, 'diagram')} as ${FORMAT_LABELS[format]} to ${shownFolder}${withLayout}.`;
  if (skipped.length === 0) {
    void ui.showInformationMessage(done);
    return;
  }
  const ours = skipped.find((s) => s.ours !== undefined);
  // A skip that was ours is a failure of ours, though the rest was exported.
  if (ours) { telemetry.error('exportFailed'); }
  const message = `${done} Skipped ${count(skipped.length, 'diagram')} that couldn't be read: ${listNames(skipped.map((s) => s.text))}.`;
  if (!ours) {
    void ui.showWarningMessage(message);
    return;
  }
  const doing = 'while reading a diagram';
  void Promise.resolve(ui.showWarningMessage(message, SEND_FEEDBACK_BUTTON)).then((choice) => {
    if (choice === SEND_FEEDBACK_BUTTON) { void ui.sendFeedback(feedbackPrefill(COMMAND_NAME, doing, ours.ours)); }
  });
}

function cancelled(): undefined {
  telemetry.feature('exportCancelled');
  return undefined;
}

/** The real `ExportAllDiagramsUi`. */
export function vscodeExportAllUi(): ExportAllDiagramsUi {
  return {
    showQuickPick: async (items, options) => vscode.window.showQuickPick([...items], options),
    showOpenDialog: async (options) => vscode.window.showOpenDialog(options),
    fileExists: async (uri) => vscode.workspace.fs.stat(uri).then(() => true, () => false),
    writeFile: async (uri, content) => { await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content)); },
    showModalWarning: async (message, detail, ...items) => vscode.window.showWarningMessage(message, { modal: true, detail }, ...items),
    showInformationMessage: async (message, ...items) => vscode.window.showInformationMessage(message, ...items),
    showWarningMessage: async (message, ...items) => vscode.window.showWarningMessage(message, ...items),
    showErrorMessage: async (message, ...items) => vscode.window.showErrorMessage(message, ...items),
    sendFeedback: async (prefill) => { await vscode.commands.executeCommand('erdStudio.reportBug', prefill); },
  };
}
