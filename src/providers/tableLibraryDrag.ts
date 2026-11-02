/**
 * Dragging rows out of the sidebar's Table Library (`erdStudio.modelLibrary`)
 * onto a diagram.
 *
 * {@link TableLibraryDragController.handleDrag} collects the dragged tables —
 * a table row, every table of a schema row, every table of a layer row; never
 * an ignored duplicate — and puts their files in `text/uri-list` (so a drop
 * in a text editor or the Explorer behaves as for any file) and their names
 * under {@link TABLE_LIBRARY_DRAG_MIME}. It then reports the drag
 * (`onDragStarted`): the editor provider remembers it for a minute and tells
 * the open canvases, which show "Hold Shift and drop to add … to this
 * diagram".
 *
 * Why Shift: while a drag that started in the workbench is in progress, VS
 * Code turns off pointer events on every webview unless Shift is held, so a
 * drop reaches the canvas only with Shift down (without it the editor group
 * takes the drop and opens the file). And what the canvas's DataTransfer
 * holds is not guaranteed (`handleDrag` runs in the extension host, after the
 * drag has begun), so the canvas posts whatever URIs it finds and the host
 * falls back on the drag remembered here.
 */

import * as vscode from 'vscode';

import type { TableLibraryNode } from './ModelLibraryTreeProvider';
import { ADD_EXISTING_TABLES_LIMIT } from '../types/messages';
import { normaliseName } from '../services/nameUtils';

/** The Table Library's own drag mime type (`application/vnd.code.tree.<view id, lower case>`). */
export const TABLE_LIBRARY_DRAG_MIME = 'application/vnd.code.tree.erdstudio.modellibrary';

/** The tables a drag carries: names and their files, in the same order. */
export interface DraggedTables {
  readonly names: string[];
  readonly filePaths: string[];
}

/**
 * The tables of the dragged rows, in tree order, each once (ignoring case),
 * at most `limit` (the Add Existing Tables cap): a table row is itself, a
 * schema or YAML folder row its tables, a layer row the tables of all its
 * schemas. A duplicate that is ignored is never dragged.
 */
export function tablesOfDraggedRows(rows: readonly TableLibraryNode[], limit = ADD_EXISTING_TABLES_LIMIT): DraggedTables {
  const names: string[] = [];
  const filePaths: string[] = [];
  const seen = new Set<string>();
  const visit = (node: TableLibraryNode): void => {
    if (names.length >= limit) return;
    if (node.type !== 'model') {
      for (const child of node.children) visit(child);
      return;
    }
    if (node.shadowedBy) return;
    const key = normaliseName(node.name);
    if (seen.has(key)) return;
    seen.add(key);
    names.push(node.name);
    filePaths.push(node.filePath);
  };
  for (const row of rows) visit(row);
  return { names, filePaths };
}

/** The Table Library's drag source; it accepts no drops. */
export class TableLibraryDragController implements vscode.TreeDragAndDropController<TableLibraryNode> {
  readonly dragMimeTypes: readonly string[] = [TABLE_LIBRARY_DRAG_MIME, 'text/uri-list'];
  readonly dropMimeTypes: readonly string[] = [];

  constructor(
    /** Told the drag's table names once they are known (`SemanticEditorProvider.noteLibraryDrag`). */
    private readonly onDragStarted: (tables: string[]) => void,
  ) {}

  handleDrag(source: readonly TableLibraryNode[], dataTransfer: vscode.DataTransfer): void {
    const { names, filePaths } = tablesOfDraggedRows(source);
    if (names.length === 0) return;
    dataTransfer.set('text/uri-list', new vscode.DataTransferItem(filePaths.map((p) => vscode.Uri.file(p).toString()).join('\r\n')));
    dataTransfer.set(TABLE_LIBRARY_DRAG_MIME, new vscode.DataTransferItem(names));
    this.onDragStarted(names);
  }
}
