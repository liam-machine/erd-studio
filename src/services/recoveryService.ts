/**
 * Recovery utilities for the "extension update orphaned a webview" case.
 *
 * VS Code 1.88+ restarts the extension host without a window reload when an
 * extension version changes. The new host has no message handler bound for
 * existing custom-editor webviews, so any open canvas becomes orphaned. The
 * only true fix is a window reload — these helpers do that gracefully without
 * losing the user's unsaved work.
 */

import * as vscode from 'vscode';

/**
 * Custom editor viewType for the domain canvas. Single source of truth — keep
 * in sync with the `customEditors` contribution in package.json. Per CLAUDE.md
 * this identifier is part of the legacy public API and must not be renamed.
 */
export const DOMAIN_EDITOR_VIEW_TYPE = 'dbtSemantic.domainEditor';

/**
 * True when at least one editor tab is showing a domain canvas. Used to
 * decide whether a window reload is actually needed: if no canvas is open,
 * an extension update doesn't strand the user and we shouldn't bother them.
 */
export function hasOpenDomainCanvas(): boolean {
  return vscode.window.tabGroups.all.some(group =>
    group.tabs.some(tab =>
      tab.input instanceof vscode.TabInputCustom &&
      tab.input.viewType === DOMAIN_EDITOR_VIEW_TYPE,
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
 */
export async function saveAllAndReload(reason: string): Promise<void> {
  void vscode.window.setStatusBarMessage(
    `$(sync~spin) ${reason} — saving your work and reloading…`,
    5000,
  );
  try {
    await vscode.commands.executeCommand('workbench.action.files.saveAll');
  } catch (err) {
    console.error('[ERD Studio] saveAll command threw:', err);
  }

  // saveAll returns void and won't surface per-file failures (read-only files,
  // save validators vetoing, etc.). Re-check dirty state and gate the reload
  // behind an explicit confirmation if anything is still unsaved.
  const stillDirty = vscode.workspace.textDocuments.filter(d => d.isDirty && !d.isUntitled);
  if (stillDirty.length > 0) {
    const choice = await vscode.window.showWarningMessage(
      `${stillDirty.length} file(s) could not be saved. Reload anyway? Unsaved changes will be lost.`,
      'Reload Anyway',
      'Cancel',
    );
    if (choice !== 'Reload Anyway') return;
  }

  // Brief delay so the status bar message is visible before the reload kicks in.
  await new Promise(resolve => setTimeout(resolve, 600));
  await vscode.commands.executeCommand('workbench.action.reloadWindow');
}
