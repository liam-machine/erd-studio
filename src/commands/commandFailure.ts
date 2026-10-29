/**
 * Shows a diagram or layer command's failure (#229): the builders in
 * `services/diagramCommandErrors.ts` choose the words and the buttons, and
 * this gives each button its action.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import {
  ADD_LAYER_BUTTON,
  CHOOSE_ANOTHER_NAME_BUTTON,
  OPEN_FILE_BUTTON,
  OPEN_IT_BUTTON,
  SEND_FEEDBACK_BUTTON,
  SHOW_FILE_BUTTON,
  TRY_AGAIN_BUTTON,
  feedbackPrefill,
  oursMessage,
  showErrorWithActions,
  type ErrorActions,
} from '../services/commandErrors';
import { SHOW_FOLDER_BUTTON, type CommandFailure } from '../services/diagramCommandErrors';
import { openTableFileAt } from './openModelFile';

/** `p`, or the nearest folder above it that exists, so Show Folder always reveals something. */
export function nearestExisting(p: string): string {
  let at = p;
  while (!fs.existsSync(at)) {
    const up = path.dirname(at);
    if (up === at) break;
    at = up;
  }
  return at;
}

/**
 * Show a diagram or layer command's failure (#229): the builder in
 * `diagramCommandErrors.ts` chose the words and buttons, this gives each
 * button its action. Never awaited: the command resolves while the toast is
 * up. A button that fails says so, rather than seeming to do nothing.
 */
export function showCommandFailure(
  failure: CommandFailure,
  err: unknown,
  extra: { retry?: () => unknown; showTab?: () => unknown; chooseAnother?: () => unknown; openIt?: () => unknown } = {},
): void {
  const target = failure.target;
  const reveal = target ? () => vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(nearestExisting(target))) : undefined;
  const available: Record<string, (() => unknown) | undefined> = {
    [SEND_FEEDBACK_BUTTON]: () => vscode.commands.executeCommand('erdStudio.reportBug', feedbackPrefill(failure.title, failure.doing ?? '', err)),
    [TRY_AGAIN_BUTTON]: extra.retry,
    [SHOW_FOLDER_BUTTON]: reveal,
    [SHOW_FILE_BUTTON]: extra.showTab ?? reveal,
    [OPEN_FILE_BUTTON]: target ? () => openTableFileAt(target, failure.line, failure.column) : undefined,
    [OPEN_IT_BUTTON]: extra.openIt,
    [CHOOSE_ANOTHER_NAME_BUTTON]: extra.chooseAnother,
    [ADD_LAYER_BUTTON]: () => vscode.commands.executeCommand('erdStudio.addLayer'),
  };
  const actions: ErrorActions = Object.fromEntries(
    failure.buttons.flatMap((button) => (available[button] ? [[button, available[button]!]] : [])),
  );
  showErrorWithActions((m, ...items) => vscode.window.showErrorMessage(m, ...items), failure.message, actions, (choice, actionErr) => {
    console.error(`[ERD Studio] ${failure.title}: "${choice}" failed:`, actionErr);
    const doing = `while running ${choice}`;
    showCommandFailure(
      { title: failure.title, message: oursMessage(failure.title, doing, 'nothing more was changed'), buttons: [SEND_FEEDBACK_BUTTON], doing },
      actionErr,
    );
  });
}

