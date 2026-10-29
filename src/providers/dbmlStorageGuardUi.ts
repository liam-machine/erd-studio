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

import * as crypto from 'crypto';
import * as vscode from 'vscode';

import { DBML_STORAGE_MESSAGE, ERD_STUDIO_EXTENSION_ID, detectDbmlStorage } from '../services/dbmlStorageGuard';
import type { DbmlStorageEvidence } from '../services/dbmlStorageGuard';

export { DBML_STORAGE_MESSAGE } from '../services/dbmlStorageGuard';

/** True while the open project is stored as DBML (package.json `when` clauses). */
export const DBML_STORAGE_CONTEXT_KEY = 'erdStudio.dbmlStorage';

/**
 * True once activation has decided both `erdStudio.hasDbtProject` and
 * `erdStudio.dbmlStorage`. Before activation every key is undefined, so a
 * welcome text that tests for a key's absence (`!erdStudio.dbmlStorage`)
 * would match and flash — "No dbt project in this folder yet" over a DBML
 * project — until the keys arrive. Every such welcome also requires this key.
 */
export const STORAGE_CHECKED_CONTEXT_KEY = 'erdStudio.storageChecked';

/** Code-only command behind the views' "Open ERD Studio in Extensions" link: opens this extension's page. */
export const OPEN_EXTENSION_PAGE_COMMAND = 'erdStudio.openExtensionPage';

/**
 * The button on the notification and on every refusal. Not "Update": while
 * 2.0 is unreleased the page it opens has no update for a stable user, only
 * **Switch to Pre-Release Version**.
 */
export const OPEN_EXTENSION_PAGE_BUTTON = 'Open ERD Studio in Extensions';

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
  void Promise.resolve(vscode.window.showWarningMessage(DBML_STORAGE_MESSAGE, OPEN_EXTENSION_PAGE_BUTTON)).then((choice) => {
    if (choice === OPEN_EXTENSION_PAGE_BUTTON) { void openExtensionPage(); }
  });
}

/**
 * The page a diagram gets instead of the canvas while its project is stored
 * as DBML: from the canvas editor, and from the no-project stub editor (a
 * `.dbml` diagram tab restored from a session with the newer version, in a
 * folder without dbt_project.yml). Its only script posts
 * `openExtensionPage`, handled here.
 */
export function showDbmlStoragePage(webviewPanel: vscode.WebviewPanel): void {
  const webview = webviewPanel.webview;
  const nonce = crypto.randomBytes(16).toString('base64');
  webview.options = { enableScripts: true, localResourceRoots: [] };
  webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>ERD Studio</title>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
</head>
<body style="font-family: var(--vscode-font-family, sans-serif); padding: 24px; color: var(--vscode-foreground); max-width: 44em; line-height: 1.5;">
  <h2 style="margin-top: 0;">This project needs a newer ERD Studio</h2>
  <p>${DBML_STORAGE_MESSAGE}</p>
  <p>Nothing has been changed. This version of ERD Studio won’t write into the project, so its files stay as the newer version left them.</p>
  <p><button id="update" style="padding: 6px 14px; border: none; border-radius: 2px; cursor: pointer; font: inherit;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);">${OPEN_EXTENSION_PAGE_BUTTON}</button></p>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('update').addEventListener('click', () => vscode.postMessage({ type: 'openExtensionPage' }));
  </script>
</body>
</html>`;
  const messages = webview.onDidReceiveMessage((message: unknown) => {
    if (typeof message === 'object' && message !== null && (message as { type?: unknown }).type === 'openExtensionPage') {
      void openExtensionPage();
    }
  });
  webviewPanel.onDidDispose(() => messages.dispose());
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
   * project is stored as DBML, tells the user (with an **Open ERD Studio in
   * Extensions** button) and returns true, and the caller stops.
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
