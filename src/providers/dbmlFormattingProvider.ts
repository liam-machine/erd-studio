/**
 * Format Document (⇧⌥F) for `.dbml` files: core's `formatDbml`, the same
 * formatter every ERD Studio DBML write ends with (`src/services/dbmlWriters.ts`),
 * so a file tidied by hand reads exactly as one ERD Studio wrote.
 *
 * The formatter changes white space only (it re-checks its own output and
 * gives the text back unchanged when anything else would change). The
 * provider answers with the smallest set of whole-line edits that turns the
 * document into the formatted text, never one replace of the whole file, so
 * the cursor, the selection and Undo stay where they belong.
 *
 * A file with syntax errors is left as it is: no edits, a status-bar message
 * saying how many errors to fix, and an `info` line in the ERD Studio log.
 *
 * It answers with no edits while ERD Studio itself is saving the document
 * (`isErdStudioSaving`): with `editor.formatOnSave` on, VS Code would run it
 * on ERD Studio's own saves too, and a layout-only move's undo anchor or a
 * flushed Undo must leave a `.dbml`'s bytes as they are. ERD Studio's writes
 * keep the file's own layout (`dbmlWriters.ts`); the user's own saves still format.
 *
 * Registered in `activate()` before the no-project early return: a `.dbml`
 * file opened anywhere (a single file, a folder with no ERD Studio project)
 * formats the same.
 */

import * as vscode from 'vscode';
import { formatDbml } from '@erd-studio/core/dbml';

import { createLogger } from '../services/logger';
import { minimalLineEdits } from '../services/lineDiff';
import { isErdStudioSaving } from './documentSave';
import { DBML_LANGUAGE_IDS } from './dbmlFileKinds';

export { minimalLineEdits, type LineEdit } from '../services/lineDiff';

const log = createLogger('dbml');

/** How long the "fix the errors first" message stays in the status bar. */
export const DBML_FORMAT_STATUS_MS = 5000;

/** The status-bar line for a file the formatter would not touch because of syntax errors. */
export function parseErrorsMessage(count: number): string {
  return count === 1
    ? 'ERD Studio: this DBML file has 1 error — fix it, then format again'
    : `ERD Studio: this DBML file has ${count} errors — fix them, then format again`;
}

/** Format Document for `.dbml` files. */
export class DbmlFormattingProvider implements vscode.DocumentFormattingEditProvider {
  provideDocumentFormattingEdits(
    document: vscode.TextDocument,
    _options: vscode.FormattingOptions,
    token?: vscode.CancellationToken,
  ): vscode.TextEdit[] {
    // Format on save during ERD Studio's own save: its writes are formatted already, and a move or an Undo keeps the bytes.
    if (isErdStudioSaving(document.uri)) return [];
    const text = document.getText();
    const result = formatDbml(text);
    const name = document.uri.scheme === 'file' ? vscode.workspace.asRelativePath?.(document.uri, false) ?? document.uri.fsPath : document.uri.toString();
    if (result.skipped === 'parse-errors') {
      const count = result.errors?.length ?? 0;
      const first = result.errors?.[0];
      log.info(`Format Document left ${name} as it is: ${count} syntax error${count === 1 ? '' : 's'}${first ? ` (first: line ${first.line}: ${first.message})` : ''}.`);
      vscode.window.setStatusBarMessage(parseErrorsMessage(count), DBML_FORMAT_STATUS_MS);
      return [];
    }
    if (result.skipped) {
      log.info(`Format Document left ${name} as it is: the formatter's self-check failed${result.detail ? ` (${result.detail})` : ''}.`);
      vscode.window.setStatusBarMessage('ERD Studio: this DBML file could not be formatted safely, so nothing was changed', DBML_FORMAT_STATUS_MS);
      return [];
    }
    if (!result.changed || token?.isCancellationRequested) return [];
    return minimalLineEdits(text, result.text).map((e) => vscode.TextEdit.replace(
      new vscode.Range(document.positionAt(e.start), document.positionAt(e.end)),
      e.text,
    ));
  }
}

/**
 * Register Format Document for every `.dbml` document, in any folder or none:
 * one provider for all four DBML language ids (`dbml` and the diagram, table
 * and relationships modes, `dbmlFileKinds.ts`).
 */
export function registerDbmlFormatting(context: vscode.ExtensionContext): void {
  context.subscriptions.push(vscode.languages.registerDocumentFormattingEditProvider(
    DBML_LANGUAGE_IDS.map((language) => ({ language })),
    new DbmlFormattingProvider(),
  ));
}
