/**
 * Open a `logical-models` file in a text editor, with the cursor on the line
 * its YAML error was reported on. Shared by the canvas's `openModelFile`
 * message and the one-per-broken-file warning notification. Writes nothing.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import type { ModelFileError, ModelFileErrorKind } from '../services/logicalModelService';

/** Open `filePath`, placing the cursor at the 1-based `line` / `column` when given. */
export async function openModelFileAt(filePath: string, line?: number, column?: number): Promise<void> {
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
export function modelFileErrorTip(kind: ModelFileErrorKind, mergeConflict?: boolean): string {
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
    case 'yamlScalar':
    case 'yamlOther':
    default:
      return 'Tip: put double quotes around text that contains ": ".';
  }
}

/** The notification text for a model file that exists but cannot be read. */
export function modelFileErrorNotice(error: Pick<ModelFileError, 'filePath' | 'kind' | 'line' | 'mergeConflict'>): string {
  const base = path.basename(error.filePath);
  const tip = modelFileErrorTip(error.kind, error.mergeConflict);
  if (error.kind === 'read') {
    return `${base} couldn't be read and can't be shown on the diagram. ${tip}`;
  }
  const where = error.line !== undefined ? ` on line ${error.line}` : '';
  if (error.mergeConflict) {
    return `${base} has an unresolved git merge conflict${where} and can't be shown on the diagram. ${tip}`;
  }
  return `${base} has a YAML error${where} and can't be shown on the diagram. ${tip}`;
}

/**
 * Show one non-blocking warning for a broken model file, whose **Open file**
 * opens it at the error. Never throws; the returned promise is not meant to be
 * awaited by the caller.
 */
export function notifyModelFileError(error: ModelFileError): void {
  void Promise.resolve(vscode.window.showWarningMessage(modelFileErrorNotice(error), 'Open file'))
    .then((choice) => {
      if (choice === 'Open file') {
        return openModelFileAt(error.filePath, error.line, error.column);
      }
      return undefined;
    })
    .catch((err: unknown) => {
      console.error('[ERD Studio] Could not open model file:', err);
    });
}
