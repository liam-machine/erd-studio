/**
 * The `erdStudio.canvas.tableSubtitle` setting: what the one line under each
 * table's name shows on every canvas (`field:<key>`, `description` or
 * `none`; core's `tableSubtitle.ts` is the one reader of that value). The
 * toolbar's menu writes it at user (Global) scope through the webview's
 * `setTableSubtitle`; each
 * open canvas is told the value with `tableSubtitle` when it says `ready`
 * and whenever the setting changes. Never writes a project file.
 */
import * as vscode from 'vscode';
import { DEFAULT_TABLE_SUBTITLE, normaliseTableSubtitle } from '@erd-studio/core';

import { getErdStudioSetting } from '../services/configService';

/** The setting's key under `erdStudio.` (read through `getErdStudioSetting`). */
export const TABLE_SUBTITLE_SETTING = 'canvas.tableSubtitle';

/** The setting as it stands (anything that is not a choice reads as the grain). */
export function readTableSubtitle(): string {
  return normaliseTableSubtitle(getErdStudioSetting<unknown>(TABLE_SUBTITLE_SETTING, DEFAULT_TABLE_SUBTITLE));
}

/**
 * Write the setting at user scope: a view preference follows the reader to
 * every project, and a click on the canvas never edits a file a team checked
 * in. A workspace value still wins over it; the caller says so
 * ({@link TABLE_SUBTITLE_WORKSPACE_NOTE}) rather than leave the menu
 * snapping back in silence.
 */
export async function writeTableSubtitle(choice: string): Promise<void> {
  await vscode.workspace
    .getConfiguration('erdStudio')
    .update(TABLE_SUBTITLE_SETTING, choice, vscode.ConfigurationTarget.Global);
}

/** Said on the canvas when a pick was saved but the workspace's own value still decides what is drawn. */
export const TABLE_SUBTITLE_WORKSPACE_NOTE =
  "This workspace's settings choose the line under table names, so it stays as it is here. Your choice is saved for your other projects.";

/** Whether a configuration change touches the setting. */
export function affectsTableSubtitle(e: vscode.ConfigurationChangeEvent): boolean {
  return e.affectsConfiguration(`erdStudio.${TABLE_SUBTITLE_SETTING}`);
}
