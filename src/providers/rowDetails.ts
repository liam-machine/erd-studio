/**
 * How much the sidebar's rows say beside their names: the
 * `erdStudio.sidebar.rowDetails` setting, shared by Diagrams, the Table
 * Library and Relationships.
 *
 * - `compact` (the default): quiet by default, details on demand. A row's
 *   description shows only what is unusual or identifying (an alias that
 *   differs, a table on no diagram, a cross-layer count, a problem); group
 *   rows say what they are (`Layer`, `Schema`) or, in Relationships, how many
 *   they hold (`2 · 1 problem`). Everything a row leaves out is in its hover.
 * - `full`: every count and owner beside every name, as before.
 *
 * Show Row Details / Hide Row Details (each view's … menu; the context key
 * {@link ROW_DETAILS_CONTEXT_KEY} picks which one shows) write the setting at
 * user scope; the trees list again whenever it changes. Never writes a
 * project file.
 */
import * as vscode from 'vscode';

import { getErdStudioSetting } from '../services/configService';

export type RowDetails = 'compact' | 'full';

/** The setting's key under `erdStudio.` (read through `getErdStudioSetting`). */
export const ROW_DETAILS_SETTING = 'sidebar.rowDetails';

export const DEFAULT_ROW_DETAILS: RowDetails = 'compact';

/** Show Row Details / Hide Row Details, in each view's … menu (`package.json`). */
export const ROW_DETAILS_COMMANDS = {
  show: 'erdStudio.showRowDetails',
  hide: 'erdStudio.hideRowDetails',
} as const;

/** `compact` or `full`: which of the two toggle commands the … menus show. */
export const ROW_DETAILS_CONTEXT_KEY = 'erdStudio.sidebarRowDetails';

/** The setting as it stands (anything but `full` is `compact`). */
export function readRowDetails(): RowDetails {
  return getErdStudioSetting<unknown>(ROW_DETAILS_SETTING, DEFAULT_ROW_DETAILS) === 'full' ? 'full' : 'compact';
}

/** A tree whose rows follow the setting: it lists again when told a new mode. */
export interface RowDetailsTree {
  setRowDetails(mode: RowDetails): void;
}

/**
 * Apply the setting to `trees` now and whenever it changes, keep the context
 * key in step, and register the two toggle commands.
 */
export function registerRowDetails(trees: readonly RowDetailsTree[]): vscode.Disposable[] {
  let current: RowDetails | undefined;
  const apply = (): void => {
    const mode = readRowDetails();
    if (mode === current) return;
    current = mode;
    for (const tree of trees) tree.setRowDetails(mode);
    void vscode.commands.executeCommand('setContext', ROW_DETAILS_CONTEXT_KEY, mode);
  };
  apply();
  const set = async (mode: RowDetails): Promise<void> => {
    await vscode.workspace.getConfiguration('erdStudio').update(ROW_DETAILS_SETTING, mode, vscode.ConfigurationTarget.Global);
    // At once: the configuration event that follows finds nothing left to change.
    apply();
  };
  return [
    vscode.commands.registerCommand(ROW_DETAILS_COMMANDS.show, () => set('full')),
    vscode.commands.registerCommand(ROW_DETAILS_COMMANDS.hide, () => set('compact')),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`erdStudio.${ROW_DETAILS_SETTING}`)) apply();
    }),
  ];
}
