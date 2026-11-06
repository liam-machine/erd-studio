/**
 * Customise Fields… (`erdStudio.customiseFields`): open the project's field
 * list, `<semanticDir>/fields.yml`, in a text editor. The palette runs it,
 * and so does the Detail panel's "Customise fields" link (`openFieldsFile`).
 *
 * Writes nothing. With no file it opens an UNSAVED document at that path
 * holding the starting set (core's `renderFieldsText(STARTING_FIELD_LIST)`),
 * so Save puts it where ERD Studio reads it, and closing it unsaved leaves
 * the project as it was. ERD Studio never writes fields.yml itself.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { FIELDS_FILE_NAME, STARTING_FIELD_LIST, renderFieldsText } from '@erd-studio/core';

import { log } from '../services/logger';

export const CUSTOMISE_FIELDS_COMMAND = 'erdStudio.customiseFields';

/** What the command needs from VS Code, injectable for tests. */
export interface CustomiseFieldsDeps {
  openTextDocument(uri: vscode.Uri): Thenable<vscode.TextDocument>;
  showTextDocument(document: vscode.TextDocument, options?: vscode.TextDocumentShowOptions): Thenable<vscode.TextEditor>;
  showErrorMessage(message: string): Thenable<unknown>;
  /** The untitled-document Uri that saves to `filePath`. */
  untitledUri(filePath: string): vscode.Uri;
}

const DEFAULT_DEPS: CustomiseFieldsDeps = {
  openTextDocument: (uri) => vscode.workspace.openTextDocument(uri),
  showTextDocument: (document, options) => vscode.window.showTextDocument(document, options),
  showErrorMessage: (message) => vscode.window.showErrorMessage(message),
  untitledUri: (filePath) => vscode.Uri.file(filePath).with({ scheme: 'untitled' }),
};

/** The starting set as a fields.yml, the text an unsaved fields.yml opens with. */
export function startingFieldsText(): string {
  return renderFieldsText(STARTING_FIELD_LIST);
}

/**
 * Open `<semanticRoot>/fields.yml`, or an unsaved document at that path
 * holding the starting set. Resolves to what was opened (`'file'`,
 * `'untitled'`) or `'failed'` (already reported to the user).
 */
export async function customiseFields(
  semanticRoot: string,
  deps: CustomiseFieldsDeps = DEFAULT_DEPS,
): Promise<'file' | 'untitled' | 'failed'> {
  const filePath = path.join(semanticRoot, FIELDS_FILE_NAME);
  let kind: 'file' | 'missing' | 'other';
  try {
    kind = fs.statSync(filePath).isFile() ? 'file' : 'other';
  } catch {
    kind = 'missing';
  }
  try {
    if (kind === 'other') {
      await deps.showErrorMessage(`Customise Fields: ${FIELDS_FILE_NAME} in ${path.basename(semanticRoot)} is not a file. Remove it or rename it, then try again.`);
      return 'failed';
    }
    if (kind === 'file') {
      const document = await deps.openTextDocument(vscode.Uri.file(filePath));
      await deps.showTextDocument(document, { preview: false });
      return 'file';
    }
    // An untitled document with the file's path: Save writes it there, without asking where.
    const document = await deps.openTextDocument(deps.untitledUri(filePath));
    const editor = await deps.showTextDocument(document, { preview: false });
    // Run twice before saving: the same unsaved document comes back; fill it once.
    if (document.getText() === '') {
      await editor.edit((builder) => builder.insert(new vscode.Position(0, 0), startingFieldsText()));
    }
    return 'untitled';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`[ERD Studio] Customise Fields failed: ${message}`);
    await deps.showErrorMessage(`Customise Fields: could not open ${FIELDS_FILE_NAME} (${message}).`);
    return 'failed';
  }
}
