/**
 * Dragging rows out of the sidebar's Table Library (`erdStudio.modelLibrary`)
 * onto a diagram.
 *
 * {@link TableLibraryDragController.handleDrag} collects the dragged tables —
 * a table row, every table of a schema row, every table of a layer row; never
 * an ignored duplicate — and puts their files in `text/uri-list` (so a drop
 * in a text editor or the Explorer behaves as for any file) and their names
 * under {@link TABLE_LIBRARY_NAMES_MIME}. It then reports the drag
 * (`onDragStarted`, with each table's file where the extension asks for
 * them: two schema folders may each hold a table of one name, and only the
 * file says which): the editor provider remembers it for a minute and tells
 * the open canvases, which show "Hold Shift and drop to add … to this
 * diagram".
 *
 * The names never go under the view's own tree mime type
 * ({@link TABLE_LIBRARY_DRAG_MIME}): VS Code writes `{ id, itemHandles }`
 * there at dragstart, and a drop on a Diagrams row hands that over first, so
 * a drop that read the names from it found none and added nothing (2.0.4).
 *
 * Why the remembered drag: a drop on the canvas seldom arrives (VS Code turns
 * a webview's pointer events off during a workbench drag unless Shift is
 * held, and with Shift Chromium does not deliver the drag to the webview's
 * out-of-process frame), so a drag that ends over a diagram is finished from
 * what the extension can see: the file VS Code opens instead
 * (`missedCanvasDrop.ts`), or the canvas's first pointer event after the drag
 * (`afterDrag`). And what the canvas's DataTransfer holds, when a drop does
 * arrive, is not guaranteed (`handleDrag` runs in the extension host, after
 * the drag has begun), so the canvas posts whatever URIs it finds and the
 * host falls back on the drag remembered here.
 */

import * as vscode from 'vscode';

import type { TableLibraryNode } from './ModelLibraryTreeProvider';
import { ADD_EXISTING_TABLES_LIMIT, TABLE_LIBRARY_DRAG_MIME, TABLE_LIBRARY_NAMES_MIME } from '../types/messages';
import { log } from '../services/logger';
import { normaliseName } from '../services/nameUtils';
import { tableIdKey } from '../types/tableId';

export { TABLE_LIBRARY_DRAG_MIME, TABLE_LIBRARY_NAMES_MIME };

/** The tables a drag carries: names and their files, in the same order. */
export interface DraggedTables {
  readonly names: string[];
  readonly filePaths: string[];
}

/**
 * The tables of the dragged rows, in tree order, each once (ignoring case),
 * at most `limit` (the Add Existing Tables cap): a table row is itself, a
 * schema or YAML folder row its tables, a layer row the tables of all its
 * schemas. A duplicate that is ignored is never dragged. "Once" is per
 * table: a DBML row is its schema folder and name, so the tables of one name
 * in two schema folders are both dragged; a row selected with its own
 * schema or layer row is dragged once.
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
    const key = node.layer !== undefined ? tableIdKey({ schema: node.folder ?? '', name: node.name }) : normaliseName(node.name);
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
  readonly dragMimeTypes: readonly string[] = [TABLE_LIBRARY_NAMES_MIME, 'text/uri-list'];
  readonly dropMimeTypes: readonly string[] = [];

  constructor(
    /** Told the drag's table names once they are known (`SemanticEditorProvider.noteLibraryDrag`), and their files when `withFiles`. */
    private readonly onDragStarted: (tables: string[], files?: string[]) => void,
    /** `withFiles`: each dragged table's file (absolute) is reported too, index for index, so a drop adds that file. */
    private readonly options: { withFiles?: boolean } = {},
  ) {}

  handleDrag(source: readonly TableLibraryNode[], dataTransfer: vscode.DataTransfer): void {
    const { names, filePaths } = tablesOfDraggedRows(source);
    if (names.length === 0) return;
    dataTransfer.set('text/uri-list', new vscode.DataTransferItem(filePaths.map((p) => vscode.Uri.file(p).toString()).join('\r\n')));
    // JSON text, as VS Code would serialise it anyway on its way to another tree.
    dataTransfer.set(TABLE_LIBRARY_NAMES_MIME, new vscode.DataTransferItem(JSON.stringify(names)));
    // A failure to remember the drag must never cost the drag its DataTransfer (VS Code drops
    // the whole drag when handleDrag throws), and must say so in the ERD Studio log.
    try {
      if (this.options.withFiles) this.onDragStarted(names, filePaths);
      else this.onDragStarted(names);
    } catch (err) {
      log.warn(`[TableLibraryDrag] Could not note the drag of ${names.join(', ')}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
