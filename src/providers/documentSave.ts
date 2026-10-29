/**
 * Save a text document by URI, re-fetched after the edit (#126).
 *
 * A `TextDocument` the extension opened and is not showing can be disposed by
 * VS Code at any time (it keeps only the most recent ~50 such documents), and
 * a `WorkspaceEdit` then dirties a fresh copy under the same URI — so saving
 * the handle held from before the edit rejects with "Document has been
 * closed" and leaves the edited copy open and unsaved. Re-fetching by URI
 * after `applyEdit` always finds the copy the edit landed in.
 *
 * `TextDocument.save()` also resolves `false` rather than throwing when it
 * cannot write (e.g. the file changed on disk since VS Code read it), so the
 * result must be checked. It also resolves `false` for a document that was not
 * dirty, which is not a failure — so a save counts as failed only when the
 * document is still dirty afterwards.
 *
 * `onFailure`, when given, is told why a failed save failed: `refused` (save()
 * resolved false and the document is still dirty, e.g. the file changed on
 * disk), `threw` (save() threw, e.g. a closed document) or `reopenFailed`
 * (re-opening the document by URI threw, e.g. a file system error).
 *
 * Every ERD Studio save goes through {@link saveWithoutFormatting}: VS Code
 * runs its save participants (format on save among them) for an extension's
 * `save()` as for the user's own, and ERD Studio is the `.dbml` formatter.
 * Its writes already end with the formatter, so its own saves skip it: a
 * layout-only move's undo anchor, or an Undo flushed to disk, must leave the
 * bytes exactly as they are, whatever `editor.formatOnSave` says.
 */

import * as vscode from 'vscode';
import type { SaveFailure } from '../services/telemetryPayload';
import { log } from '../services/logger';

/** URIs (as strings) ERD Studio is saving right now, with how many of its saves of each are in flight. */
const ownSaves = new Map<string, number>();

/** Whether ERD Studio itself is saving `uri` right now (Format Document then answers with no edits). */
export function isErdStudioSaving(uri: vscode.Uri): boolean {
  return ownSaves.has(uri.toString());
}

/**
 * `doc.save()`, with format on save skipped for this save (see above). The
 * caller handles the result exactly as it would `save()`'s.
 */
export async function saveWithoutFormatting(doc: vscode.TextDocument): Promise<boolean> {
  const key = doc.uri.toString();
  ownSaves.set(key, (ownSaves.get(key) ?? 0) + 1);
  try {
    return await doc.save();
  } finally {
    const left = (ownSaves.get(key) ?? 1) - 1;
    if (left > 0) ownSaves.set(key, left);
    else ownSaves.delete(key);
  }
}

export async function saveDocumentByUri(uri: vscode.Uri, onFailure?: (reason: SaveFailure) => void): Promise<boolean> {
  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(uri);
  } catch (err) {
    log.error(`[saveDocumentByUri] could not save ${uri.fsPath}:`, err);
    onFailure?.('reopenFailed');
    return false;
  }
  return saveDocument(doc, onFailure);
}

/** Save `doc`; true when its bytes are on disk afterwards (see above). Never throws. */
export async function saveDocument(doc: vscode.TextDocument, onFailure?: (reason: SaveFailure) => void): Promise<boolean> {
  try {
    const saved = await saveWithoutFormatting(doc);
    if (saved || !doc.isDirty) return true;
    onFailure?.('refused');
    return false;
  } catch (err) {
    log.error(`[saveDocument] could not save ${doc.uri.fsPath}:`, err);
    onFailure?.('threw');
    return false;
  }
}
