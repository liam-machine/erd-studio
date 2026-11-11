/**
 * Recovery utilities for the "extension update orphaned a webview" case.
 *
 * VS Code 1.88+ restarts the extension host without a window reload when an
 * extension version changes. The new host has no message handler bound for
 * existing custom-editor webviews, so any open canvas becomes orphaned. The
 * only true fix is a window reload — these helpers do that gracefully without
 * losing the user's unsaved work.
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { RELOAD_ANYWAY_BUTTON, SHOW_FILES_BUTTON, unsavedFilesMessage } from './commandErrors';
import { log } from './logger';

/**
 * Custom editor viewType for the domain canvas. Single source of truth — keep
 * in sync with the `customEditors` contribution in package.json. Per CLAUDE.md
 * this identifier is part of the legacy public API and must not be renamed.
 */
export const SUBJECT_AREA_EDITOR_VIEW_TYPE = 'erdStudio.domainEditor';

/**
 * True when at least one editor tab is showing a domain canvas. Used to
 * decide whether a window reload is actually needed: if no canvas is open,
 * an extension update doesn't strand the user and we shouldn't bother them.
 */
export function hasOpenSubjectAreaCanvas(): boolean {
  return vscode.window.tabGroups.all.some(group =>
    group.tabs.some(tab =>
      tab.input instanceof vscode.TabInputCustom &&
      tab.input.viewType === SUBJECT_AREA_EDITOR_VIEW_TYPE,
    ),
  );
}

/**
 * Save all dirty editors, then reload the window. saveAll runs first so no
 * work is lost; if it fails the user is prompted to handle it manually rather
 * than silently risking data loss.
 *
 * @param reason — short user-facing phrase shown in the status bar before the
 *   reload, e.g. "ERD Studio updated to v0.6.33".
 * @returns true when a reload was requested; false when the user cancelled
 *   because files could not be saved (the caller should carry on as normal).
 */
export async function saveAllAndReload(reason: string): Promise<boolean> {
  void vscode.window.setStatusBarMessage(
    `$(sync~spin) ${reason} — saving your work and reloading…`,
    5000,
  );
  try {
    await vscode.commands.executeCommand('workbench.action.files.saveAll');
  } catch (err) {
    log.error('[ERD Studio] saveAll command threw:', err);
  }

  // saveAll returns void and won't surface per-file failures (read-only files,
  // save validators vetoing, etc.). Re-check dirty state and gate the reload
  // behind an explicit confirmation if anything is still unsaved.
  // A modal naming the files (#285): a toast that can lose work could be
  // clicked through or time out unseen. VS Code adds Cancel (and Escape).
  const stillDirty = vscode.workspace.textDocuments.filter(d => d.isDirty && !d.isUntitled);
  if (stillDirty.length > 0) {
    const choice = await vscode.window.showWarningMessage(
      unsavedFilesMessage(unsavedFileNames(stillDirty)),
      { modal: true },
      SHOW_FILES_BUTTON,
      RELOAD_ANYWAY_BUTTON,
    );
    if (choice === SHOW_FILES_BUTTON) {
      try {
        await vscode.window.showTextDocument(stillDirty[0], { preview: false });
      } catch (err) {
        log.error('[ERD Studio] Show Files failed:', err);
      }
    }
    if (choice !== RELOAD_ANYWAY_BUTTON) return false;
  }

  // Brief delay so the status bar message is visible before the reload kicks in.
  await new Promise(resolve => setTimeout(resolve, 600));
  await vscode.commands.executeCommand('workbench.action.reloadWindow');
  return true;
}

/**
 * The unsaved documents' names, as the user knows them: the base name, or the
 * workspace-relative path (with its folder's name in a multi-root workspace)
 * where two share a base name (two `schema.yml`).
 */
export function unsavedFileNames(docs: readonly vscode.TextDocument[]): string[] {
  const base = (d: vscode.TextDocument) => path.basename(d.uri.fsPath || d.uri.path);
  const counts = new Map<string, number>();
  for (const d of docs) counts.set(base(d), (counts.get(base(d)) ?? 0) + 1);
  // No `includeWorkspaceFolder`: VS Code's default adds the folder's name only in a multi-root workspace.
  return docs.map(d => ((counts.get(base(d)) ?? 0) > 1 ? vscode.workspace.asRelativePath(d.uri) : base(d)));
}
