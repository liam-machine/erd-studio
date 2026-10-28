/**
 * The editor side of the stable guard for projects stored as DBML by a newer
 * ERD Studio (see `src/services/dbmlStorageGuard.ts` for why, and for how the
 * 2.0 merge removes it).
 *
 * - `erdStudio.dbmlStorage` (context key): the Subject Areas and Table
 *   Library views show the update message instead of "No diagrams yet" /
 *   "No tables found", and their title buttons that write are hidden.
 * - {@link DbmlStorageGuard.refuse}: every command and canvas action that
 *   writes into the ERD Studio folder calls it first and stops when it
 *   returns true. Detection runs fresh on each call, so a git checkout of a
 *   converted branch is caught even before any watcher fires.
 * - One non-modal notification per session when such a project is open.
 *
 * Writes nothing, ever.
 */

import * as vscode from 'vscode';

import { DBML_STORAGE_MESSAGE, ERD_STUDIO_EXTENSION_ID, detectDbmlStorage } from '../services/dbmlStorageGuard';
import type { DbmlStorageEvidence } from '../services/dbmlStorageGuard';

export { DBML_STORAGE_MESSAGE } from '../services/dbmlStorageGuard';

/** True while the open project is stored as DBML (package.json `when` clauses). */
export const DBML_STORAGE_CONTEXT_KEY = 'erdStudio.dbmlStorage';

/** Code-only command behind the views' "Update ERD Studio" link: opens this extension's page. */
export const OPEN_EXTENSION_PAGE_COMMAND = 'erdStudio.openExtensionPage';

/** The button on the notification and on every refusal. */
export const UPDATE_ERD_STUDIO_BUTTON = 'Update ERD Studio';

/** How long the `.dbml` watcher waits for a burst (a checkout) to settle. */
const WATCH_DEBOUNCE_MS = 300;

let noticeShownThisSession = false;

/** Test seam: forget that the once-per-session notification was shown. */
export function _resetDbmlStorageNoticeForTests(): void {
  noticeShownThisSession = false;
}

/**
 * Open ERD Studio's page in the Extensions view, where **Update** or
 * **Switch to Pre-Release Version** is. `extension.open` is older than
 * VS Code 1.85; an editor without it gets the Extensions search instead.
 */
export async function openExtensionPage(): Promise<void> {
  try {
    await vscode.commands.executeCommand('extension.open', ERD_STUDIO_EXTENSION_ID);
    return;
  } catch {
    // Not every VS Code-based editor has it.
  }
  try {
    await vscode.commands.executeCommand('workbench.extensions.search', `@id:${ERD_STUDIO_EXTENSION_ID}`);
  } catch (err) {
    console.error('[ERD Studio] Could not open the Extensions view:', err);
  }
}

function showDbmlStorageMessage(): void {
  void Promise.resolve(vscode.window.showWarningMessage(DBML_STORAGE_MESSAGE, UPDATE_ERD_STUDIO_BUTTON)).then((choice) => {
    if (choice === UPDATE_ERD_STUDIO_BUTTON) { void openExtensionPage(); }
  });
}

export class DbmlStorageGuard implements vscode.Disposable {
  /** The value last published to the context key; undefined before the first check. */
  private published: boolean | undefined;
  private readonly changed = new vscode.EventEmitter<boolean>();
  /** Fires when the project starts or stops being stored as DBML (not on the first check). */
  readonly onDidChange = this.changed.event;
  private readonly disposables: vscode.Disposable[] = [this.changed];

  constructor(
    private readonly semanticRoot: string,
    private readonly detect: (semanticRoot: string) => DbmlStorageEvidence | null = detectDbmlStorage,
  ) {}

  /** Whether the project is stored as DBML right now (fresh look at the folder). */
  isActive(): boolean {
    const active = this.detect(this.semanticRoot) !== null;
    this.publish(active);
    return active;
  }

  /**
   * Call first in anything that writes into the ERD Studio folder: when the
   * project is stored as DBML, tells the user (with an **Update ERD Studio**
   * button) and returns true, and the caller stops.
   */
  refuse(): boolean {
    if (!this.isActive()) { return false; }
    showDbmlStorageMessage();
    return true;
  }

  /** Re-check whenever a `.dbml` file in the ERD Studio folder appears, changes or goes. */
  watch(): void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const recheck = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => { timer = undefined; this.isActive(); }, WATCH_DEBOUNCE_MS);
    };
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.semanticRoot, '**/*.dbml'));
    this.disposables.push(
      watcher,
      watcher.onDidCreate(recheck),
      watcher.onDidChange(recheck),
      watcher.onDidDelete(recheck),
      { dispose: () => clearTimeout(timer) },
    );
  }

  private publish(active: boolean): void {
    if (active === this.published) { return; }
    const first = this.published === undefined;
    this.published = active;
    void vscode.commands.executeCommand('setContext', DBML_STORAGE_CONTEXT_KEY, active);
    if (active && !noticeShownThisSession) {
      noticeShownThisSession = true;
      showDbmlStorageMessage();
    }
    if (!first) { this.changed.fire(active); }
  }

  dispose(): void {
    for (const d of this.disposables.splice(0)) { d.dispose(); }
  }
}
