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
 */

import * as vscode from 'vscode';

export async function saveDocumentByUri(uri: vscode.Uri): Promise<boolean> {
  try {
    return await saveDocument(await vscode.workspace.openTextDocument(uri));
  } catch (err) {
    console.error(`[saveDocumentByUri] could not save ${uri.fsPath}:`, err);
    return false;
  }
}

/** Save `doc`; true when its bytes are on disk afterwards (see above). Never throws. */
export async function saveDocument(doc: vscode.TextDocument): Promise<boolean> {
  try {
    const saved = await doc.save();
    return saved || !doc.isDirty;
  } catch (err) {
    console.error(`[saveDocument] could not save ${doc.uri.fsPath}:`, err);
    return false;
  }
}
