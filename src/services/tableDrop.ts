/**
 * Dropping tables on a canvas (`dropTables`, `SemanticEditorProvider`): which
 * tables a drop names, and where they go.
 *
 * A drop brings whatever URIs its DataTransfer held — a table file dragged
 * from the Explorer, or the rows of a Table Library drag when VS Code passes
 * them on — and {@link tablesOfDroppedUris} keeps the ones that are table
 * files of the library (`.dbml` or `.yml`, never an ignored duplicate). The
 * new tables are placed by {@link dropGridPositions}: the first one under the
 * pointer, the rest beside and below it, {@link DROP_GRID_COLUMNS} to a row.
 *
 * Pure: no `vscode`, so it is unit-testable.
 */

import { fileURLToPath } from 'url';

import type { NodePosition } from '../types/semantic';
import { ADD_EXISTING_TABLES_LIMIT } from '../types/messages';
import { NODE_HEIGHT, NODE_WIDTH, PADDING } from './positionService';
import { samePath } from './projectDiscovery';
import { normaliseName } from './nameUtils';

/** How many dropped tables sit side by side before the next row starts. */
export const DROP_GRID_COLUMNS = 4;

/** How far above the pointer a dropped table's top edge sits: its header is under the pointer. */
const DROP_HEADER_OFFSET = 20;

/** A table file of the library, as `TableLibraryService.listTableFiles()` lists it. */
export interface DroppableTableFile {
  readonly name: string;
  readonly filePath: string;
  /** Set when another file of the same name is the one diagrams use: never dropped. */
  readonly shadowedBy?: string;
}

/**
 * The local path a `file:` URI names on `platform`, or undefined for any other
 * URI (or one that does not parse). On Windows that is `file:///c%3A/proj/a.dbml`
 * (as VS Code writes it) or `file:///C:/proj/a.dbml` → `c:\proj\a.dbml`, and
 * `file://server/share/a.dbml` → `\\server\share\a.dbml`.
 */
function filePathOf(uri: string, platform: NodeJS.Platform): string | undefined {
  const text = uri.trim();
  if (!/^file:/i.test(text)) return undefined;
  try {
    // `windows` is read by Node 20.13+ / 22.1+; an older runtime ignores it and
    // uses its own platform, which in the extension host is the same thing.
    return fileURLToPath(text, { windows: platform === 'win32' });
  } catch {
    return undefined;
  }
}

/**
 * The tables the dropped `uris` are the files of, in drop order, each once
 * (ignoring case), at most {@link ADD_EXISTING_TABLES_LIMIT}. Only `file:`
 * URIs count; one that is not a table file of the library (a README, a
 * folder, a file elsewhere) is skipped. Paths are compared as the file system
 * does (ignoring case on macOS and Windows).
 */
export function tablesOfDroppedUris(
  uris: readonly string[],
  files: readonly DroppableTableFile[],
  platform: NodeJS.Platform = process.platform,
): string[] {
  const candidates = files.filter((f) => !f.shadowedBy);
  const names: string[] = [];
  const seen = new Set<string>();
  for (const uri of uris) {
    const filePath = filePathOf(uri, platform);
    if (filePath === undefined) continue;
    const file = candidates.find((f) => samePath(f.filePath, filePath, platform));
    if (!file) continue;
    const key = normaliseName(file.name);
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(file.name);
    if (names.length >= ADD_EXISTING_TABLES_LIMIT) break;
  }
  return names;
}

/**
 * The table files the dropped `uris` are, in drop order, each file once, at
 * most {@link ADD_EXISTING_TABLES_LIMIT}: {@link tablesOfDroppedUris} by file
 * rather than by name, so two tables of one name in different schema folders
 * are two tables. Only `file:` URIs of listed, unshadowed table files count.
 */
export function tableFilesOfDroppedUris<T extends DroppableTableFile>(
  uris: readonly string[],
  files: readonly T[],
  platform: NodeJS.Platform = process.platform,
): T[] {
  const candidates = files.filter((f) => !f.shadowedBy);
  const out: T[] = [];
  for (const uri of uris) {
    const filePath = filePathOf(uri, platform);
    if (filePath === undefined) continue;
    const file = candidates.find((f) => samePath(f.filePath, filePath, platform));
    if (!file || out.includes(file)) continue;
    out.push(file);
    if (out.length >= ADD_EXISTING_TABLES_LIMIT) break;
  }
  return out;
}

/** The tables a drop on a diagram's row adds: names, and their files where they are added by file. */
export interface TreeDropTables {
  readonly names: string[];
  readonly files?: string[];
}

/**
 * Which tables Table Library rows dropped on a diagram's row in the Diagrams
 * view add: by their files (`uris`) where the library tells tables apart by
 * file (`byFile`: two schema folders share a name), else the dragged names;
 * when the drop's names could not be read, the tables its files are; and
 * when it carried neither, the drag the editor remembered (`remembered`).
 * Undefined when nothing names a table, so the caller can say so.
 */
export function tablesOfTreeDrop<T extends DroppableTableFile>(
  drop: { readonly tables: readonly string[]; readonly uris: readonly string[] },
  library: readonly T[],
  options: { readonly byFile: boolean; readonly remembered?: { readonly tables: readonly string[]; readonly files?: readonly string[] } },
  platform: NodeJS.Platform = process.platform,
): TreeDropTables | undefined {
  const dropped = tableFilesOfDroppedUris(drop.uris, library, platform);
  if (options.byFile && dropped.length > 0) return { names: dropped.map((f) => f.name), files: dropped.map((f) => f.filePath) };
  if (drop.tables.length > 0) return { names: [...drop.tables] };
  if (dropped.length > 0) return { names: tablesOfDroppedUris(drop.uris, library, platform) };
  const remembered = options.remembered;
  if (!remembered || remembered.tables.length === 0) return undefined;
  return options.byFile && remembered.files && remembered.files.length === remembered.tables.length
    ? { names: [...remembered.tables], files: [...remembered.files] }
    : { names: [...remembered.tables] };
}

/**
 * Where dropped tables go: the first centred under the drop point with its
 * header under the pointer, the others in a grid to its right and below,
 * {@link DROP_GRID_COLUMNS} to a row, one table width and height (plus the
 * usual padding) apart. Rounded to whole pixels.
 */
export function dropGridPositions(names: readonly string[], at: NodePosition): Record<string, NodePosition> {
  const left = Math.round(at.x - NODE_WIDTH / 2);
  const top = Math.round(at.y - DROP_HEADER_OFFSET);
  const positions: Record<string, NodePosition> = {};
  names.forEach((name, i) => {
    positions[name] = {
      x: left + (i % DROP_GRID_COLUMNS) * (NODE_WIDTH + PADDING),
      y: top + Math.floor(i / DROP_GRID_COLUMNS) * (NODE_HEIGHT + PADDING),
    };
  });
  return positions;
}
