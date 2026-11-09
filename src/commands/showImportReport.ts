/**
 * **Show Import Report** (`erdStudio.showImportReport`): the last import's
 * report in its read-only tab (`ImportReportPanel`), or a line saying no
 * import has run in this window yet. Writes nothing.
 *
 * The imports link to it from their draft's banner, the toast after a Keep
 * that left tables out ({@link partialImportMessage}) and their failure
 * messages ({@link importReportAction}).
 */

import * as path from 'path';
import * as vscode from 'vscode';

import { ImportReportPanel } from '../providers/ImportReportPanel';
import {
  IMPORT_REPORT_TITLE,
  NO_IMPORT_REPORT_MESSAGE,
  SHOW_IMPORT_REPORT_COMMAND,
  SHOW_IMPORT_REPORT_LABEL,
} from '../services/importReport';
import { latestImportReport } from '../services/importReportStore';
import { openTableFileAt } from './openModelFile';

export { SHOW_IMPORT_REPORT_COMMAND, SHOW_IMPORT_REPORT_LABEL };

/** Run the command: the report tab, or the no-import line. */
export function showImportReport(): void {
  if (!latestImportReport()) {
    void vscode.window.showInformationMessage(NO_IMPORT_REPORT_MESSAGE);
    return;
  }
  ImportReportPanel.createOrShow({
    openFileAt: (file, line) => openTableFileAt(file, line),
    couldNotOpen: (file) => {
      void vscode.window.showWarningMessage(
        `${IMPORT_REPORT_TITLE}: couldn't open ${path.basename(file)}. It may have been moved or deleted since the import.`,
      );
    },
  });
}

/** The button a toast or failure message adds: Show Import Report, running the command. */
export function importReportAction(): Record<string, () => unknown> {
  return { [SHOW_IMPORT_REPORT_LABEL]: () => vscode.commands.executeCommand(SHOW_IMPORT_REPORT_COMMAND) };
}
