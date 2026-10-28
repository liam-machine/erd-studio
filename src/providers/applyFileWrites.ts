/**
 * The one helper that applies a set of {@link FileWrite}s as ONE
 * WorkspaceEdit (D23, §5.3 steps 6–7 of docs/plans/native-dbml-storage.md).
 *
 * Order: the primary document's replace first (a text edit, so the custom
 * editor's undo groups the step under it), then every create (relationships
 * files before table files before layout files), then every other replace,
 * then every file rename (`renames`, bytes kept), then every delete.
 *
 * Nothing is sent that changes nothing: a replace whose text is what the
 * file (or its open document) already holds is left out — no edit, no save,
 * no watcher event. The primary is the exception, because it anchors the
 * undo step: VS Code's Undo on the canvas undoes the last edit of the
 * canvas's own document, so an edit that touched only other files (a drag
 * that wrote only the `.dbdiagram` layout, a column edit that wrote only a
 * table file) would otherwise not be undone from the canvas. When the
 * primary's text is unchanged its anchor is the smallest edit that is still
 * one ({@link undoAnchor}: one character replaced by itself), never a
 * full-range replace of the whole diagram.
 *
 * VS Code's `applyEdit` is all-or-nothing only for text edits: an edit with
 * file creations or deletions keeps the steps that ran before the one that
 * failed. So when it returns `false` this helper reconciles: a planned create
 * whose file holds exactly the planned bytes is deleted, a planned delete
 * whose file is gone is re-created from the text read before, and a replaced
 * document that holds the planned text is set back with a text edit (saved
 * only if it was saved before). When that fails too, a modal names every file
 * it could not put back ("Restore these from source control"); nothing is
 * retried.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import type { FileWrite } from '../services/fileWrites';
import { mergeFileWrites, orderFileWrites } from '../services/fileWrites';

/** What {@link applyFileWrites} did. */
export interface AppliedFileWrites {
  ok: boolean;
  /** Documents replaced (not the primary), to save by URI after a success. */
  replaced: vscode.Uri[];
  created: string[];
  deleted: string[];
  /** The `renames` the edit carried (each file moved byte for byte). */
  renamed: Array<{ from: string; to: string }>;
  /** After a failure: files the reconcile could not put back (listed in the modal). */
  unrestored: string[];
}

/** Every file an applied edit wrote, created, deleted or moved (both ends of a rename). */
export function writtenPaths(applied: Pick<AppliedFileWrites, 'replaced' | 'created' | 'deleted' | 'renamed'>): string[] {
  return [
    ...applied.replaced.map((uri) => uri.fsPath),
    ...applied.created,
    ...applied.deleted,
    ...applied.renamed.flatMap((r) => [r.from, r.to]),
  ];
}

export interface ApplyFileWritesOptions {
  /** The document whose full-range replace goes first (always, for undo grouping), and its new text. */
  primary?: { document: vscode.TextDocument; text: string };
  /** Called before each create (and each rename's target), to make its folder where only a plain mkdir is wrong (library paths). */
  ensureDir?(filePath: string): void;
  /**
   * Files moved as they are, in the same edit (after the creates and
   * replaces, before the deletes): a file rename keeps every byte, whatever
   * the file's encoding. The reconcile moves back any that landed.
   */
  renames?: ReadonlyArray<{ from: string; to: string }>;
}

const samePath = (a: string, b: string): boolean => path.resolve(a) === path.resolve(b);

/** An open document's text, else the file's, else null (absent). */
function currentText(filePath: string): { text: string | null; dirty: boolean } {
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && samePath(d.uri.fsPath, filePath));
  if (doc) return { text: doc.getText(), dirty: doc.isDirty };
  try {
    return { text: fs.readFileSync(filePath, 'utf-8'), dirty: false };
  } catch {
    return { text: null, dirty: false };
  }
}

function fullRange(doc: vscode.TextDocument): vscode.Range {
  return new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
}

/**
 * The undo anchor of a document whose text an edit leaves as it is: the
 * first character that is not a line break (nor half of a surrogate pair),
 * replaced by itself. It is a text edit, so VS Code records the step in the
 * document's undo stack, and it sends one character over IPC instead of the
 * whole file. A document with no such character gets the full-range replace.
 */
export function undoAnchor(doc: vscode.TextDocument): { range: vscode.Range; text: string } {
  const text = doc.getText();
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 0x0a || code === 0x0d || code === 0xfeff) continue;
    if (code >= 0xd800 && code <= 0xdfff) continue;
    return { range: new vscode.Range(doc.positionAt(i), doc.positionAt(i + 1)), text: text[i] };
  }
  return { range: fullRange(doc), text };
}

/** Apply `writes` (absolute paths) as one WorkspaceEdit, reconciling a partial failure. */
export async function applyFileWrites(writes: readonly FileWrite[], options: ApplyFileWritesOptions = {}): Promise<AppliedFileWrites> {
  const primaryPath = options.primary?.document.uri.fsPath;
  const allWrites = orderFileWrites(mergeFileWrites(writes.filter((w) => !(primaryPath !== undefined && w.kind === 'replace' && samePath(w.path, primaryPath)))));

  // What each planned file held before (null: absent), to put back after a
  // failure. Creates too: a create that failed because its file was already
  // there must never have that file deleted by the reconcile.
  const prior = new Map<string, { text: string | null; dirty: boolean }>();
  if (options.primary) prior.set(options.primary.document.uri.fsPath, { text: options.primary.document.getText(), dirty: options.primary.document.isDirty });
  for (const w of allWrites) if (!prior.has(w.path)) prior.set(w.path, currentText(w.path));
  // A replace that leaves its file as it is: nothing to write, save, undo or put back.
  const ordered = allWrites.filter((w) => !(w.kind === 'replace' && prior.get(w.path)?.text === w.text));

  const edit = new vscode.WorkspaceEdit();
  if (options.primary) {
    const { document, text } = options.primary;
    if (text === document.getText()) {
      const anchor = undoAnchor(document);
      edit.replace(document.uri, anchor.range, anchor.text);
    } else {
      edit.replace(document.uri, fullRange(document), text);
    }
  }
  const replaced: vscode.Uri[] = [];
  const created: string[] = [];
  const deleted: string[] = [];
  const renames = options.renames ?? [];
  const renamed: Array<{ from: string; to: string }> = [];
  const addRenames = (): void => {
    for (const r of renames) {
      options.ensureDir?.(r.to);
      edit.renameFile(vscode.Uri.file(r.from), vscode.Uri.file(r.to), { overwrite: false });
      renamed.push({ from: r.from, to: r.to });
    }
  };
  for (const w of ordered) {
    const uri = vscode.Uri.file(w.path);
    if (w.kind === 'delete' && renamed.length < renames.length) addRenames();
    if (w.kind === 'create') {
      options.ensureDir?.(w.path);
      edit.createFile(uri, { overwrite: false, contents: Buffer.from(w.text, 'utf-8') });
      created.push(w.path);
    } else if (w.kind === 'replace') {
      const doc = await vscode.workspace.openTextDocument(uri);
      edit.replace(doc.uri, fullRange(doc), w.text);
      replaced.push(doc.uri);
    } else {
      edit.deleteFile(uri, { ignoreIfNotExists: true });
      deleted.push(w.path);
    }
  }

  if (renamed.length < renames.length) addRenames();

  if (await vscode.workspace.applyEdit(edit)) return { ok: true, replaced, created, deleted, renamed, unrestored: [] };

  // --- Reconcile: put back whatever landed --------------------------------------------
  const planned = new Map<string, FileWrite>();
  for (const w of ordered) planned.set(w.path, w);
  if (options.primary) planned.set(options.primary.document.uri.fsPath, { kind: 'replace', path: options.primary.document.uri.fsPath, text: options.primary.text });
  const undo = new vscode.WorkspaceEdit();
  const undoSaves: vscode.Uri[] = [];
  let anything = false;
  const isBack = (w: FileWrite): boolean => {
    const now = currentText(w.path).text;
    if (w.kind === 'create') return prior.get(w.path)?.text !== null || now === null || now !== w.text;
    if (w.kind === 'delete') return now !== null || prior.get(w.path)?.text === null;
    return now !== w.text;
  };
  for (const w of planned.values()) {
    const uri = vscode.Uri.file(w.path);
    const now = currentText(w.path).text;
    if (w.kind === 'create') {
      // Only a file this edit made: one that was there before is the user's.
      if (prior.get(w.path)?.text === null && now !== null && now === w.text) {
        undo.deleteFile(uri, { ignoreIfNotExists: true });
        anything = true;
      }
    } else if (w.kind === 'delete') {
      const before = prior.get(w.path)?.text ?? null;
      if (now === null && before !== null) {
        undo.createFile(uri, { overwrite: false, contents: Buffer.from(before, 'utf-8') });
        anything = true;
      }
    } else if (now !== null && now === w.text) {
      const before = prior.get(w.path);
      if (before?.text !== null && before?.text !== undefined) {
        const doc = await vscode.workspace.openTextDocument(uri);
        undo.replace(doc.uri, fullRange(doc), before.text);
        if (!before.dirty) undoSaves.push(doc.uri);
        anything = true;
      }
    }
  }
  const exists = (p: string): boolean => fs.existsSync(p);
  for (const r of renames) {
    // Moved: move it back.
    if (!exists(r.from) && exists(r.to)) {
      undo.renameFile(vscode.Uri.file(r.to), vscode.Uri.file(r.from), { overwrite: false });
      anything = true;
    }
  }
  let unrestored: string[] = [];
  if (anything) {
    const ok = await vscode.workspace.applyEdit(undo);
    if (ok) {
      for (const uri of undoSaves) {
        try {
          const doc = await vscode.workspace.openTextDocument(uri);
          await doc.save();
        } catch { /* left open and dirty: the user sees it */ }
      }
    } else {
      unrestored = [
        ...[...planned.values()].filter((w) => !isBack(w)).map((w) => w.path),
        ...renames.filter((r) => !exists(r.from)).map((r) => r.from),
      ];
      if (unrestored.length === 0) unrestored = [...planned.keys(), ...renames.map((r) => r.from)];
      const shown = unrestored.map((p) => vscode.workspace.asRelativePath?.(p) ?? p);
      void vscode.window.showErrorMessage(
        `ERD Studio could not apply the edit, and could not put back ${shown.join(', ')}. Restore these from source control.`,
        { modal: true },
      );
    }
  }
  return { ok: false, replaced, created, deleted, renamed, unrestored };
}
