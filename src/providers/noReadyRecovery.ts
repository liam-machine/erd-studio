/**
 * What a canvas or the draft preview offers when its page never comes up
 * (ERD Studio 2.0 B13): `ReadyWatch` saw no `ready` 30 s after the panel was
 * shown, so the page threw before React mounted, or never loaded. The crash
 * screen lives in the page, so it cannot show; the host asks instead, in the
 * same plain words: a problem in ERD Studio, not in the user's files, with
 * Reload and Send Feedback. The caller acts on the choice and counts it with
 * the crash screen's keys (`crashFallbackReload` / `crashFallbackFeedback`).
 */

import * as vscode from 'vscode';

import { SEND_FEEDBACK_BUTTON } from '../services/commandErrors';
import type { CrashFallbackAction } from '../types/webviewError';

export const NO_READY_RELOAD_BUTTON = 'Reload';

/** The notification's words for each page. */
export function noReadyMessage(surface: 'canvas' | 'draft'): string {
  const what = surface === 'draft' ? 'The draft preview didn\'t open.' : 'This diagram didn\'t open.';
  return `${what} This is a problem in ERD Studio, not in your files.`;
}

/** Ask once; resolves the button pressed, or undefined when dismissed. Never rejects. */
export async function askNoReadyRecovery(surface: 'canvas' | 'draft'): Promise<CrashFallbackAction | undefined> {
  try {
    const choice = await vscode.window.showWarningMessage(noReadyMessage(surface), NO_READY_RELOAD_BUTTON, SEND_FEEDBACK_BUTTON);
    if (choice === NO_READY_RELOAD_BUTTON) return 'reload';
    if (choice === SEND_FEEDBACK_BUTTON) return 'feedback';
  } catch {
    // A notification that fails to show changes nothing.
  }
  return undefined;
}
