/**
 * The `erdStudio.canvas.tableSubtitle` setting: what the one line under each
 * table's name shows on every canvas (`field:<key>`, `description` or
 * `none`; core's `tableSubtitle.ts` is the one reader of that value). The
 * toolbar's menu writes it through the webview's `setTableSubtitle`; each
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
 * Write the setting where the value in force lives: in the workspace when
 * the workspace sets one (a team's checked-in choice, which would otherwise
 * win over the write and leave the menu looking dead), else at user scope,
 * so the preference follows the reader to every project.
 */
export async function writeTableSubtitle(choice: string): Promise<void> {
  const config = vscode.workspace.getConfiguration('erdStudio');
  const inWorkspace = config.inspect<unknown>(TABLE_SUBTITLE_SETTING)?.workspaceValue !== undefined;
  await config.update(
    TABLE_SUBTITLE_SETTING,
    choice,
    inWorkspace ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global,
  );
}

/** Whether a configuration change touches the setting. */
export function affectsTableSubtitle(e: vscode.ConfigurationChangeEvent): boolean {
  return e.affectsConfiguration(`erdStudio.${TABLE_SUBTITLE_SETTING}`);
}
