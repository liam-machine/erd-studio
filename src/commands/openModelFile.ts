/**
 * Open a table file (`.yml` or `.dbml`) in a text editor, with the cursor on
 * the line its YAML or DBML error was reported on. Shared by the canvas's `openModelFile`
 * message and the one-per-broken-file warning notification. Writes nothing.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { TableFileError, TableFileErrorKind } from '../services/logicalModelService';

/** Open `filePath`, placing the cursor at the 1-based `line` / `column` when given. */
export async function openTableFileAt(filePath: string, line?: number, column?: number): Promise<void> {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  const options: vscode.TextDocumentShowOptions = { preview: false };
  if (line !== undefined && line >= 1) {
    const lineIndex = Math.min(line - 1, Math.max(document.lineCount - 1, 0));
    const character = column !== undefined && column >= 1 ? column - 1 : 0;
    const position = new vscode.Position(lineIndex, character);
    options.selection = new vscode.Range(position, position);
  }
  await vscode.window.showTextDocument(document, options);
}

/** The one tip the notification gives, tailored to what went wrong. */
export function tableFileErrorTip(kind: TableFileErrorKind, mergeConflict?: boolean): string {
  if (mergeConflict) {
    return 'Tip: keep one side of each conflict, save, then git add the file.';
  }
  switch (kind) {
    case 'yamlIndent':
      return 'Tip: indent with spaces, not tabs, and line up keys at the same level.';
    case 'yamlDuplicateKey':
      return 'Tip: a key appears twice in the same block — keep one.';
    case 'yamlStructure':
      return 'Tip: the file must be one YAML document — no --- separators or ``` code fences.';
    case 'read':
      return 'Tip: check the file still exists and that VS Code can read it.';
    case 'dbmlSyntax':
      return 'Tip: check the DBML syntax on that line (a missing bracket, quote or brace).';
    case 'dbmlInvalid':
      return "Tip: quote every custom value, as in grain: 'One row per order line'.";
    case 'dbmlStructure':
      return 'Tip: a table file holds one Table and nothing else: move Ref and use lines to the folder\'s _relationships.dbml.';
    case 'yamlScalar':
    case 'yamlOther':
    default:
      return 'Tip: put double quotes around text that contains ": ".';
  }
}

/** The notification text for a model file that exists but cannot be read. */
export function tableFileErrorNotice(
  error: Pick<TableFileError, 'filePath' | 'kind' | 'line' | 'mergeConflict' | 'readable' | 'key'>,
): string {
  const base = path.basename(error.filePath);
  if (error.readable) {
    // The model IS on the diagram (#164); only writing to it is held back.
    const what = error.key ? `"${error.key}" is written twice` : 'A key is written twice';
    const where = error.line !== undefined ? ` (line ${error.line})` : '';
    return `${base}: ${what} in the same block${where}. ERD Studio uses the last one, ` +
      "but can't change this table until you remove the other copy.";
  }
  const tip = tableFileErrorTip(error.kind, error.mergeConflict);
  if (error.kind === 'read') {
    return `${base} couldn't be read and can't be shown on the diagram. ${tip}`;
  }
  const where = error.line !== undefined ? ` on line ${error.line}` : '';
  if (error.mergeConflict) {
    return `${base} has an unresolved git merge conflict${where} and can't be shown on the diagram. ${tip}`;
  }
  const format = error.kind.startsWith('dbml') ? 'DBML' : 'YAML';
  return `${base} has a ${format} error${where} and can't be shown on the diagram. ${tip}`;
}

/**
 * Show one non-blocking warning for a broken model file, whose **Open file**
 * opens it at the error. Never throws; the returned promise is not meant to be
 * awaited by the caller.
 */
export function notifyTableFileError(error: TableFileError): void {
  void Promise.resolve(vscode.window.showWarningMessage(tableFileErrorNotice(error), 'Open file'))
    .then((choice) => {
      if (choice === 'Open file') {
        return openTableFileAt(error.filePath, error.line, error.column);
      }
      return undefined;
    })
    .catch((err: unknown) => {
      console.error('[ERD Studio] Could not open model file:', err);
    });
}

/** workspaceState key: file path → the `mtime:size` it had when it was last warned about. */
export const TABLE_FILE_WARNED_KEY = 'erdStudio.modelFileErrorsWarned';

/** Most files remembered; the oldest are forgotten first. */
const MAX_WARNED_FILES = 200;

/**
 * Whether to warn about a broken model file now (#164): yes unless it was
 * warned about in an earlier session and has not changed since — a user who
 * did not write the file, or never opens a diagram, would otherwise dismiss
 * the same warning on every window. Records the file as warned about.
 * Usage telemetry is not gated by this: the file is still wrong.
 */
export function shouldWarnAboutTableFile(state: vscode.Memento, filePath: string): boolean {
  let signature: string;
  try {
    const stat = fs.statSync(filePath);
    signature = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return true;
  }
  const warned = { ...(state.get<Record<string, string>>(TABLE_FILE_WARNED_KEY) ?? {}) };
  if (warned[filePath] === signature) {
    return false;
  }
  delete warned[filePath];
  warned[filePath] = signature;
  const paths = Object.keys(warned);
  for (const old of paths.slice(0, Math.max(0, paths.length - MAX_WARNED_FILES))) {
    delete warned[old];
  }
  void Promise.resolve(state.update(TABLE_FILE_WARNED_KEY, warned)).catch((err: unknown) => {
    console.error('[ERD Studio] Could not remember a model file warning:', err);
  });
  return true;
}
