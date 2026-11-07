/**
 * Which files are open in VS Code with unsaved edits — the check every writer
 * runs before it replaces a file under the user's work in progress. Paths are
 * compared the way the file system compares them (`pathKey`).
 */

import * as fs from 'fs';
import * as path from 'path';

import * as vscode from 'vscode';

import { pathKey } from '../services/pathKey';

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

/** A file's text: an open document's (unsaved edits included), else the disk's without a byte-order mark; null when there is none. */
export function openOrDiskText(filePath: string): string | null {
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && path.resolve(d.uri.fsPath) === path.resolve(filePath));
  if (doc) return doc.getText();
  try {
    return fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
}
