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
import { log } from '../services/logger';
import { isTelemetryErrorCode, writeFailureFeature } from '../services/runtimeTelemetry';
import { telemetry } from '../services/telemetryService';
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
 * The first of an edit's paths this account may not write, when one is the
 * known cause of VS Code not applying it (#335): an existing file that is
 * read-only, or the folder a file would be made in, moved from or deleted
 * from (the nearest one that exists). Undefined when all can be written.
 * Only a path in `root` (the project) counts: a folder above it says nothing
 * about this edit.
 */
export function firstUnwritable(paths: readonly string[], root: string): string | undefined {
  const inRoot = (p: string): boolean => {
    const rel = path.relative(root, p);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  const writable = (p: string): boolean => {
    try {
      fs.accessSync(p, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  };
  for (const p of paths) {
    if (!inRoot(p)) continue;
    if (fs.existsSync(p) && !writable(p)) return p;
    const folder = nearestExisting(path.dirname(p));
    if (inRoot(folder) && !writable(folder)) return folder;
  }
  return undefined;
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
  extra: {
    retry?: () => unknown;
    showTab?: () => unknown;
    chooseAnother?: () => unknown;
    openIt?: () => unknown;
    /** The command's own buttons, by label (an Explorer move's Move It Back). */
    actions?: ErrorActions;
  } = {},
): void {
  recordCommandFailure(failure, err);
  const target = failure.target;
  const reveal = target ? () => vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(nearestExisting(target))) : undefined;
  const available: Record<string, (() => unknown) | undefined> = {
    ...extra.actions,
    [SEND_FEEDBACK_BUTTON]: () => vscode.commands.executeCommand('erdStudio.reportBug', feedbackPrefill(failure.title, failure.doing ?? failure.reportDoing ?? '', err)),
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
    log.error(`[ERD Studio] ${failure.title}: "${choice}" failed:`, actionErr);
    telemetry.error('loggedErrorAtFailureAction');
    const doing = `while running ${choice}`;
    showCommandFailure(
      { title: failure.title, message: oursMessage(failure.title, doing, 'nothing more was changed'), buttons: [SEND_FEEDBACK_BUTTON], doing },
      actionErr,
    );
  });
}

/**
 * Usage telemetry for a failure shown (B10): the failure's own code, then
 * `commandFailedOurs` when it is ours (it says what it was doing), else the
 * write class of an error the user can fix (permissions, a full disk).
 * Fixed keys only; the exception's text never leaves the device.
 */
export function recordCommandFailure(failure: CommandFailure, err: unknown): void {
  try {
    if (failure.code !== undefined) {
      if (isTelemetryErrorCode(failure.code)) telemetry.error(failure.code);
      else telemetry.feature(failure.code);
    }
    if (failure.doing) {
      telemetry.error('commandFailedOurs');
      return;
    }
    const writeClass = writeFailureFeature(err);
    if (writeClass) telemetry.feature(writeClass);
  } catch {
    // Counting a failure never stops it being shown.
  }
}
