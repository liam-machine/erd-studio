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
import { importReportById, importReportIdOf, latestImportReport } from '../services/importReportStore';
import { openTableFileAt } from './openModelFile';

export { SHOW_IMPORT_REPORT_COMMAND, SHOW_IMPORT_REPORT_LABEL };

/** Said when an import's own link asks for a report a long session no longer holds. */
export const IMPORT_REPORT_GONE_MESSAGE =
  'That import\'s report is no longer held: only the last few imports in this window keep one. Show Import Report shows the latest.';

/**
 * Run the command: the report of the import `arg` names (its draft's banner,
 * its toast or failure message pass its id), else the latest; or the
 * no-import line. Any other argument (the palette passes none) means the latest.
 */
export function showImportReport(arg?: unknown): void {
  if (!latestImportReport()) {
    void vscode.window.showInformationMessage(NO_IMPORT_REPORT_MESSAGE);
    return;
  }
  const reportId = importReportIdOf(arg);
  if (reportId !== undefined && !importReportById(reportId)) {
    // Never another import's report in its place.
    void vscode.window.showInformationMessage(IMPORT_REPORT_GONE_MESSAGE);
    return;
  }
  ImportReportPanel.createOrShow({
    openFileAt: (file, line) => openTableFileAt(file, line),
    couldNotOpen: (file) => {
      void vscode.window.showWarningMessage(
        `${IMPORT_REPORT_TITLE}: couldn't open ${path.basename(file)}. It may have been moved or deleted since the import.`,
      );
    },
  }, reportId);
}

/** The button a toast or failure message adds: Show Import Report for import `reportId`, running the command. */
export function importReportAction(reportId?: number): Record<string, () => unknown> {
  return {
    [SHOW_IMPORT_REPORT_LABEL]: () => (reportId === undefined
      ? vscode.commands.executeCommand(SHOW_IMPORT_REPORT_COMMAND)
      : vscode.commands.executeCommand(SHOW_IMPORT_REPORT_COMMAND, reportId)),
  };
}
