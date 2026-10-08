/**
 * Which files are open in VS Code with unsaved edits — the check every writer
 * runs before it replaces a file under the user's work in progress.
 *
 * Paths are compared the way the file system compares them. Windows and macOS
 * ignore case, and VS Code spells a Windows drive letter `c:` where
 * `path.resolve` gives `C:`, so an exact string comparison there would miss
 * the open tab and the write would go ahead.
 */

import * as path from 'path';
import * as vscode from 'vscode';

/** `filePath` as the file system compares it: resolved, and lower-cased where case is ignored. */
export function pathKey(filePath: string, platform: NodeJS.Platform = process.platform): string {
  const resolved = path.resolve(filePath);
  return platform === 'win32' || platform === 'darwin' ? resolved.toLowerCase() : resolved;
}

/** Those of `filePaths` open with unsaved edits, each once, in the order given. */
export function dirtyFiles(filePaths: Iterable<string>): string[] {
  const dirty = new Set(
    vscode.workspace.textDocuments.filter((doc) => doc.isDirty).map((doc) => pathKey(doc.uri.fsPath)),
  );
  const seen = new Set<string>();
  return [...filePaths].filter((filePath) => {
    const key = pathKey(filePath);
    if (seen.has(key) || !dirty.has(key)) return false;
    seen.add(key);
    return true;
  });
}
