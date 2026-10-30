/**
 * **Move Table…** (`erdStudio.moveTable`) and **Move Diagram to Layer…**
 * (`erdStudio.moveDiagram`) in the layer-first DBML tree (ERD Studio 2.0,
 * §2.8): a table to another `<layer>/tables/<schema>/` folder, a diagram to
 * another layer's `diagrams/` folder, every reference following.
 *
 * Planned only by the lifecycle planners (`planDbmlTableMoves`, the one the
 * Organise command uses, and `planDbmlDiagramLayerMove`), never a second
 * planner; applied as ONE WorkspaceEdit through the host's `applyWrites`
 * (`applyLifecycleWrites`: saved, own writes recorded after the bytes land),
 * so a move is one undo step. A move ERD Studio makes is its own write, never
 * an outside change the watchers report.
 *
 * Each command resolves what it moves (a Table Library row, a Subject Areas
 * row, an Explorer file or a pick), asks where, then runs `moveDbmlTables` /
 * `moveDbmlDiagram`, which take no UI decision of their own beyond the one
 * question a table move asks when other files change, and can be reused by a
 * caller that already knows the destination.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { classifySemanticFile, dbmlTreePathOf, isDbmlLayerName } from '@erd-studio/core';

import { OPEN_IT_BUTTON, diagramNameTakenMessage, projectRelative, showErrorWithActions } from '../services/commandErrors';
import { isSchemaFolderName } from '../services/dbmlLibraryWrites';
import type { FileWrite } from '../services/fileWrites';
import type { TableFileEntry, TableLibraryService } from '../services/logicalModelService';
import { isRefusedWrite } from '../services/newSubjectAreaWriter';
import { log } from '../services/logger';
import { SUBJECT_AREA_EDITOR_VIEW_TYPE } from '../services/recoveryService';
import { dbmlMoveTouches, planDbmlDiagramLayerMove, planDbmlTableMoves } from './dbmlLifecycle';
import { showRefusedWrite } from './openModelFile';

export const MOVE_TABLE_COMMAND = 'erdStudio.moveTable';
export const MOVE_DIAGRAM_COMMAND = 'erdStudio.moveDiagram';
export const MOVE_TABLE_TITLE = 'Move Table';
export const MOVE_DIAGRAM_TITLE = 'Move Diagram to Layer';
export const MOVE_BUTTON = 'Move';

/** What the two commands need from the host; `activate()` passes the real services. */
export interface MoveDbmlDeps {
  workspaceRoot: string;
  /** The semantic dir, absolute. */
  semanticRoot: string;
  tableLibraryService: Pick<TableLibraryService,
    'listTableFiles' | 'planDbmlLibraryOps' | 'getTablesDir' | 'listDbmlDiagrams' | 'listDbmlLayerFolders'>;
  /** The layers `layers.json` lists, in its order. */
  layers(): ReadonlyArray<{ id: string; label: string }>;
  /** A file's text: an open document's, else the disk's. */
  readText(filePath: string): string | null;
  /** Those of `filePaths` open with unsaved edits. */
  dirtyFiles(filePaths: readonly string[]): string[];
  /** Apply the writes as one WorkspaceEdit, save and record own writes. */
  applyWrites(writes: readonly FileWrite[]): Promise<{ ok: boolean; unsaved: string[]; unrestored: string[] }>;
  /** After a table move landed: the views and open canvases refresh. */
  afterTablesMoved(writes: readonly FileWrite[]): Promise<void>;
  /** After a diagram move landed (before it is reopened): the views refresh. */
  afterDiagramMoved(oldPath: string, newPath: string): Promise<void>;
}

/** A layer's label from `layers.json`, else its folder name. */
function labelOf(deps: Pick<MoveDbmlDeps, 'layers'>, layer: string): string {
  return deps.layers().find((l) => l.id === layer)?.label ?? layer;
}

/** A path relative to the semantic dir, posix. */
function semanticRel(deps: Pick<MoveDbmlDeps, 'semanticRoot'>, filePath: string): string {
  return path.relative(deps.semanticRoot, filePath).split(path.sep).join('/');
}

/**
 * Every layer a move can go to, in order: the ones `layers.json` lists (in
 * its order), then every other DBML layer folder on disk (sorted). A layer
 * `layers.json` does not list is offered only when its folder exists.
 */
export function moveLayersOf(deps: Pick<MoveDbmlDeps, 'layers' | 'tableLibraryService'>): Array<{ layer: string; label: string; schemas: readonly string[]; listed: boolean }> {
  const folders = deps.tableLibraryService.listDbmlLayerFolders();
  const listed = deps.layers().filter((l) => isDbmlLayerName(l.id));
  const out = listed.map((l) => {
    const folder = folders.find((f) => f.layer === l.id);
    return { layer: l.id, label: l.label, schemas: folder?.schemas ?? [], listed: true };
  });
  for (const f of folders) {
    if (!out.some((o) => o.layer === f.layer)) out.push({ layer: f.layer, label: f.layer, schemas: f.schemas, listed: false });
  }
  return out;
}

/** A tab showing a file that moves: the editor it shows it in (a canvas's view type, else the text editor) and where. */
interface OpenTab {
  tab: vscode.Tab;
  viewType: string;
  viewColumn: vscode.ViewColumn | undefined;
  /** The tab had the focus. */
  focused: boolean;
}

/** The tabs showing `filePath`. */
function tabsShowing(filePath: string): OpenTab[] {
  const out: OpenTab[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input as { uri?: { scheme?: string; fsPath?: string }; viewType?: unknown } | undefined;
      if (!input || typeof input !== 'object' || input.uri?.scheme !== 'file' || typeof input.uri.fsPath !== 'string') continue;
      if (path.resolve(input.uri.fsPath) !== path.resolve(filePath)) continue;
      out.push({
        tab,
        viewType: typeof input.viewType === 'string' ? input.viewType : 'default',
        viewColumn: group.viewColumn,
        focused: tab.isActive === true && group.isActive === true,
      });
    }
  }
  return out;
}

/** Open `target` in each closed tab's editor, in the tab's own group; focus follows only a tab that had it. */
async function reopen(tabs: readonly OpenTab[], target: string): Promise<void> {
  const seen = new Set<string>();
  for (const t of tabs) {
    const key = `${t.viewType}\u0000${t.viewColumn ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(target), t.viewType,
      { ...(t.viewColumn !== undefined ? { viewColumn: t.viewColumn } : {}), preserveFocus: !t.focused });
  }
}

/**
 * The folders applying `writes` would make (every missing folder on the way
 * to a created file), deepest first: removed again when VS Code rejects the
 * edit, so a rejected move leaves no empty folder behind.
 */
export function foldersMadeBy(writes: readonly FileWrite[]): string[] {
  const out = new Set<string>();
  for (const w of writes) {
    if (w.kind !== 'create') continue;
    for (let dir = path.dirname(w.path); !fs.existsSync(dir); dir = path.dirname(dir)) {
      if (path.dirname(dir) === dir) break;
      out.add(dir);
    }
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/** Remove `dirs` (deepest first), each only while it is empty. */
export function removeFolders(dirs: readonly string[]): void {
  for (const dir of dirs) {
    try { fs.rmdirSync(dir); } catch { /* not empty, or already gone */ }
  }
}

// ---------------------------------------------------------------------------
// Move Table
// ---------------------------------------------------------------------------

/** The file path an item names: a Table Library or Subject Areas row, an Explorer URI, or a path. */
function itemPath(item: unknown): string | undefined {
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object') return undefined;
  const o = item as { type?: unknown; filePath?: unknown; scheme?: unknown; fsPath?: unknown; summary?: { filePath?: unknown } };
  if (o.type === 'model' && typeof o.filePath === 'string') return o.filePath;
  if (o.type === 'domain' && typeof o.summary?.filePath === 'string') return o.summary.filePath;
  if (o.scheme === 'file' && typeof o.fsPath === 'string') return o.fsPath;
  return undefined;
}

/**
 * The file paths the command's arguments name: the right-clicked item, or
 * the whole selection when it holds that item (a view's or the Explorer's
 * multi-selection).
 */
function argPaths(arg: unknown, selection: unknown): string[] | undefined {
  const clicked = itemPath(arg);
  const selected = Array.isArray(selection) ? selection.map(itemPath).filter((p): p is string => p !== undefined) : [];
  if (selected.length > 0 && (arg === undefined || arg === null || (clicked !== undefined && selected.some((p) => path.resolve(p) === path.resolve(clicked))))) {
    return selected;
  }
  if (arg === undefined || arg === null) return undefined;
  return clicked === undefined ? [] : [clicked];
}

/** A DBML table entry the library uses (not an ignored duplicate). */
type MovableTable = TableFileEntry & { layer: string };

/** The entries for `paths`, or the sentence that says why one of them cannot move. */
function tablesAt(deps: MoveDbmlDeps, paths: readonly string[]): { tables: MovableTable[] } | { problem: string } {
  const entries = deps.tableLibraryService.listTableFiles();
  const tables: MovableTable[] = [];
  for (const filePath of paths) {
    const entry = entries.find((e) => path.resolve(e.filePath) === path.resolve(filePath));
    const shown = projectRelative(deps.workspaceRoot, filePath);
    if (!entry) {
      return { problem: `${shown} is not a table file of the Table Library. Move Table moves the .dbml files in <layer>/tables/<schema>/.` };
    }
    if (entry.storage !== 'dbml' || entry.layer === undefined) {
      return { problem: `"${entry.name}" is a YAML table: Move Table moves DBML tables. Organise Table Library by Layer moves YAML table files.` };
    }
    if (entry.shadowedBy) {
      return { problem: `${shown} is a duplicate of "${entry.name}" that diagrams ignore. Give it its own name first (Give Duplicate Table Its Own Name…).` };
    }
    if (!tables.some((t) => t.filePath === entry.filePath)) tables.push(entry as MovableTable);
  }
  return { tables };
}

/** Where a picked destination is: an existing schema folder, or a new one in `layer`. */
interface DestinationItem extends vscode.QuickPickItem {
  layer?: string;
  schema?: string;
  newSchemaIn?: string;
}

/**
 * The destinations Move Table offers, grouped by layer (a separator per
 * layer, in {@link moveLayersOf}'s order): each schema folder as
 * `<layer label> › <schema>`, then "New schema in <layer label>…". A folder
 * every moving table is already in is left out, and so is one whose name
 * cannot be a schema ({@link isSchemaFolderName}).
 */
export function tableDestinationItems(
  deps: Pick<MoveDbmlDeps, 'layers' | 'tableLibraryService'>,
  tables: ReadonlyArray<{ layer: string; folder: string }>,
): DestinationItem[] {
  const items: DestinationItem[] = [];
  for (const { layer, label, schemas } of moveLayersOf(deps)) {
    items.push({ label, kind: vscode.QuickPickItemKind.Separator });
    for (const schema of schemas) {
      if (tables.every((t) => t.layer === layer && t.folder === schema)) continue;
      // A folder name a new schema box would refuse (a quote, `{{ }}`, a trailing space…) would write `use` lines no parser reads.
      if (!isSchemaFolderName(schema)) continue;
      items.push({ label: `${label} › ${schema}`, description: `${layer}/tables/${schema}/`, layer, schema });
    }
    items.push({ label: `$(add) New schema in ${label}…`, newSchemaIn: layer });
  }
  return items;
}

/**
 * The input box's answer for a new schema folder in a layer that holds
 * `schemas`: an error, or null. A name that differs only in case from an
 * existing folder is refused, naming that folder; the same spelling is that
 * folder.
 */
export function validateNewSchemaName(value: string, layerLabel: string, schemas: readonly string[]): string | null {
  const name = value.trim();
  if (!name) return 'Enter a schema name.';
  if (!isSchemaFolderName(name)) {
    return `"${name}" cannot be a schema folder name. Leave out quotes, slashes, \\ : * ? < > |, {{ }} and a trailing dot or space.`;
  }
  const existing = schemas.find((s) => s.toLowerCase() === name.toLowerCase());
  if (existing !== undefined && existing !== name) {
    return `${layerLabel} already has the schema folder "${existing}". Type "${existing}", or pick ${layerLabel} › ${existing} from the list.`;
  }
  return null;
}

/** The first of `tables` whose file name the destination folder already holds (any case), with that file's name. */
function takenInDestination(deps: MoveDbmlDeps, tables: readonly MovableTable[], layer: string, schema: string): { table: MovableTable; file: string } | undefined {
  let names: string[];
  try {
    names = fs.readdirSync(path.join(deps.semanticRoot, layer, 'tables', schema));
  } catch {
    return undefined;
  }
  for (const table of tables) {
    const file = path.basename(table.filePath).toLowerCase();
    const taken = names.find((n) => n.toLowerCase() === file);
    if (taken !== undefined) return { table, file: taken };
  }
  return undefined;
}

/** "fct_order", or "3 tables". */
function tablesPhrase(tables: readonly { name: string }[]): string {
  return tables.length === 1 ? tables[0].name : `${tables.length} tables`;
}

/** "2 diagrams and 1 relationships file that use it are updated too." */
export function describeMoveTouches(touches: { diagrams: readonly string[]; relationships: readonly string[] }, tableCount: number): string {
  const parts: string[] = [];
  if (touches.diagrams.length > 0) parts.push(`${touches.diagrams.length} diagram${touches.diagrams.length === 1 ? '' : 's'}`);
  if (touches.relationships.length > 0) parts.push(`${touches.relationships.length} relationships file${touches.relationships.length === 1 ? '' : 's'}`);
  const total = touches.diagrams.length + touches.relationships.length;
  return `${parts.join(' and ')} that use${total === 1 ? 's' : ''} ${tableCount === 1 ? 'it' : 'them'} ${total === 1 ? 'is' : 'are'} updated too.`;
}

/**
 * Move `tables` to `<layer>/tables/<schema>/`: plan, refuse what cannot be
 * written (nothing changes), ask only when other files change, apply as one
 * edit and say what moved. Tables already there are left out; a tab showing
 * a moved table reopens on its new file. Returns whether anything moved.
 */
export async function moveDbmlTables(
  deps: MoveDbmlDeps,
  tables: readonly MovableTable[],
  to: { layer: string; schema: string },
): Promise<boolean> {
  const moving = tables.filter((t) => !(t.layer === to.layer && t.folder === to.schema));
  const destinationShown = `${to.layer}/tables/${to.schema}`;
  if (!isSchemaFolderName(to.schema)) {
    void vscode.window.showErrorMessage(`${MOVE_TABLE_TITLE}: "${to.schema}" cannot be a schema folder name, so no table can move to ${destinationShown}/. Rename the folder (leave out quotes, slashes, \\ : * ? < > |, {{ }} and a trailing dot or space). Nothing was moved.`);
    return false;
  }
  if (moving.length === 0) {
    void vscode.window.showInformationMessage(`${tablesPhrase(tables)} ${tables.length === 1 ? 'is' : 'are'} already in ${destinationShown}.`);
    return false;
  }
  const taken = takenInDestination(deps, moving, to.layer, to.schema);
  if (taken) {
    void vscode.window.showErrorMessage(`${MOVE_TABLE_TITLE}: ${destinationShown}/ already has a file named ${taken.file}, so "${taken.table.name}" cannot move there. Nothing was moved.`);
    return false;
  }

  let planned: ReturnType<typeof planDbmlTableMoves>;
  try {
    planned = planDbmlTableMoves({
      tableLibraryService: deps.tableLibraryService,
      moves: moving.map((t) => ({ name: t.name, toLayer: to.layer, toSchema: to.schema })),
      // Every DBML diagram, in a layer folder layers.json lists or not.
      diagrams: deps.tableLibraryService.listDbmlDiagrams(),
      readText: deps.readText,
    });
  } catch (err) {
    if (isRefusedWrite(err)) {
      showRefusedWrite(MOVE_TABLE_TITLE, err, { semanticRoot: deps.semanticRoot, workspaceRoot: deps.workspaceRoot, outcome: 'Nothing was moved.' });
    } else {
      void vscode.window.showErrorMessage(`${MOVE_TABLE_TITLE}: ${err instanceof Error ? err.message : String(err)} Nothing was moved.`);
    }
    return false;
  }
  const { writes, requalified } = planned;
  // The folder as the plan spells it (an existing folder's spelling wins).
  const created = writes.find((w) => w.kind === 'create' && classifySemanticFile(semanticRel(deps, w.path), { tablesDirIsLayer: false }).kind === 'table');
  const destination = created ? path.posix.dirname(semanticRel(deps, created.path)) : destinationShown;
  const schemaShown = created ? dbmlTreePathOf(semanticRel(deps, created.path))?.schema ?? to.schema : to.schema;

  const dirty = deps.dirtyFiles(writes.map((w) => w.path));
  if (dirty.length > 0) {
    void vscode.window.showErrorMessage(`${MOVE_TABLE_TITLE}: ${projectRelative(deps.workspaceRoot, dirty[0])} has unsaved changes. Save or revert it, then try again. Nothing was moved.`);
    return false;
  }

  // Only a move that changes other files asks first.
  const touches = dbmlMoveTouches({ semanticRoot: deps.semanticRoot, writes });
  if (touches.diagrams.length + touches.relationships.length > 0) {
    const requalifiedNote = requalified.length === 0
      ? ''
      : requalified.length === 1
        ? `\nIts file declares it as ${schemaShown}.${requalified[0]} from now on, and every Ref naming it is re-spelled.`
        : `\nTheir files declare them in schema ${schemaShown} from now on, and every Ref naming them is re-spelled: ${requalified.join(', ')}.`;
    const choice = await vscode.window.showInformationMessage(
      `Move ${tablesPhrase(moving)} to ${labelOf(deps, to.layer)} › ${schemaShown}?`,
      { modal: true, detail: `${describeMoveTouches(touches, moving.length)}${requalifiedNote}` },
      MOVE_BUTTON,
    );
    if (choice !== MOVE_BUTTON) return false;
  }

  // A tab showing a moving table's file is bound to its old path: close it,
  // and reopen the moved file in its place (as a move in the Explorer would).
  const open = moving.map((table) => ({ table, tabs: tabsShowing(table.filePath) })).filter((o) => o.tabs.length > 0);
  if (open.length > 0) await vscode.window.tabGroups.close(open.flatMap((o) => o.tabs.map((t) => t.tab)), true);
  const made = foldersMadeBy(writes);
  const result = await deps.applyWrites(writes);
  if (!result.ok) {
    // The reconcile's modal already named any file it could not put back.
    if (result.unrestored.length === 0) {
      removeFolders(made);
      void vscode.window.showErrorMessage(`${MOVE_TABLE_TITLE}: VS Code rejected the file moves; nothing was changed.`);
      for (const o of open) await reopen(o.tabs, o.table.filePath);
    }
    return false;
  }
  // A schema folder the move emptied is removed, as Organise does.
  for (const table of moving) {
    try {
      if (fs.readdirSync(path.dirname(table.filePath)).length === 0) fs.rmdirSync(path.dirname(table.filePath));
    } catch { /* already gone */ }
  }
  await deps.afterTablesMoved(writes);
  for (const o of open) {
    const file = path.basename(o.table.filePath).toLowerCase();
    const moved = writes.find((w) => w.kind === 'create' && path.basename(w.path).toLowerCase() === file);
    if (moved) await reopen(o.tabs, moved.path);
  }
  if (result.unsaved.length > 0) {
    void vscode.window.showErrorMessage(`Could not save ${result.unsaved.map((p) => projectRelative(deps.workspaceRoot, p)).join(', ')}. Save the file from its tab, or revert it.`);
  }
  void vscode.window.showInformationMessage(`Moved ${tablesPhrase(moving)} to ${destination}.`);
  return true;
}

/**
 * **Move Table…**: the tables `arg` / `selection` name (Table Library rows
 * or Explorer files), else one picked from the DBML tables; then where.
 */
export async function moveTableCommand(deps: MoveDbmlDeps, arg?: unknown, selection?: unknown): Promise<void> {
  const paths = argPaths(arg, selection);
  let tables: MovableTable[];
  if (paths === undefined) {
    const movable = deps.tableLibraryService.listTableFiles()
      .filter((e): e is MovableTable => e.storage === 'dbml' && e.layer !== undefined && !e.shadowedBy);
    if (movable.length === 0) {
      void vscode.window.showInformationMessage('There are no DBML tables to move.');
      return;
    }
    const pick = await vscode.window.showQuickPick(
      movable.map((t) => ({ label: t.name, description: `${labelOf(deps, t.layer)} › ${t.folder}`, table: t })),
      { title: MOVE_TABLE_TITLE, placeHolder: 'Which table do you want to move?', matchOnDescription: true },
    );
    if (!pick) return;
    tables = [pick.table];
  } else {
    if (paths.length === 0) {
      void vscode.window.showErrorMessage(`${MOVE_TABLE_TITLE}: no table selected. Right-click a table in the Table Library, or a .dbml table file in the Explorer.`);
      return;
    }
    const found = tablesAt(deps, paths);
    if ('problem' in found) {
      void vscode.window.showErrorMessage(`${MOVE_TABLE_TITLE}: ${found.problem} Nothing was moved.`);
      return;
    }
    tables = found.tables;
  }

  const items = tableDestinationItems(deps, tables);
  const where = tables.length === 1 ? ` (now in ${labelOf(deps, tables[0].layer)} › ${tables[0].folder})` : '';
  const picked = await vscode.window.showQuickPick(items, {
    title: `Move ${tablesPhrase(tables)}`,
    placeHolder: `Move ${tablesPhrase(tables)}${where} to which schema folder?`,
    matchOnDescription: true,
  });
  if (!picked) return;
  let to: { layer: string; schema: string };
  if (picked.newSchemaIn !== undefined) {
    const layer = picked.newSchemaIn;
    const label = labelOf(deps, layer);
    const schemas = moveLayersOf(deps).find((l) => l.layer === layer)?.schemas ?? [];
    const name = (await vscode.window.showInputBox({
      title: `New schema in ${label}`,
      prompt: `A folder in ${layer}/tables/. The table file declares the schema too (Table <schema>.<name>), and every Ref naming it follows.`,
      ignoreFocusOut: true,
      validateInput: (value) => validateNewSchemaName(value, label, schemas),
    }))?.trim();
    if (!name) return;
    to = { layer, schema: name };
  } else if (picked.layer !== undefined && picked.schema !== undefined) {
    to = { layer: picked.layer, schema: picked.schema };
  } else {
    return;
  }
  await moveDbmlTables(deps, tables, to);
}

// ---------------------------------------------------------------------------
// Move Diagram to Layer
// ---------------------------------------------------------------------------

/** Whether `dir` lists `fileName`, ignoring case. */
function listsIgnoringCase(dir: string, fileName: string): string | undefined {
  try {
    return fs.readdirSync(dir).find((n) => n.toLowerCase() === fileName.toLowerCase());
  } catch {
    return undefined;
  }
}

/**
 * Move the diagram at `filePath` (`<layer>/diagrams/<name>.dbml`) to
 * `toLayer`'s `diagrams/` folder (made when it is missing): every `use`
 * line re-derived from its new place, one edit. A tab showing it is closed
 * first and the moved file reopened in the same editor and group after. Returns the
 * new path, or undefined when nothing moved.
 */
export async function moveDbmlDiagram(deps: MoveDbmlDeps, filePath: string, toLayer: string): Promise<string | undefined> {
  const name = path.basename(filePath).replace(/\.dbml$/i, '');
  const label = labelOf(deps, toLayer);
  // One name per diagram in a layer, whatever its format (as Rename Subject Area holds it).
  const takenDbml = listsIgnoringCase(path.join(deps.semanticRoot, toLayer, 'diagrams'), `${name}.dbml`);
  const takenJson = listsIgnoringCase(path.join(deps.semanticRoot, toLayer), `${name}.json`);
  const taken = takenDbml !== undefined ? path.join(deps.semanticRoot, toLayer, 'diagrams', takenDbml)
    : takenJson !== undefined ? path.join(deps.semanticRoot, toLayer, takenJson) : undefined;
  if (taken !== undefined) {
    showErrorWithActions(
      (message, ...items) => vscode.window.showErrorMessage(message, ...items),
      `${MOVE_DIAGRAM_TITLE}: ${diagramNameTakenMessage(name, label)} Rename one of them first. Nothing was moved.`,
      { [OPEN_IT_BUTTON]: () => vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(taken), SUBJECT_AREA_EDITOR_VIEW_TYPE) },
      (choice, err) => log.error(`[ERD Studio] ${MOVE_DIAGRAM_TITLE}: "${choice}" failed:`, err),
    );
    return undefined;
  }
  if (deps.dirtyFiles([filePath]).length > 0) {
    void vscode.window.showErrorMessage(`${MOVE_DIAGRAM_TITLE}: ${projectRelative(deps.workspaceRoot, filePath)} has unsaved changes. Save or revert it, then try again. Nothing was moved.`);
    return undefined;
  }
  const text = deps.readText(filePath);
  if (text === null) {
    void vscode.window.showErrorMessage(`${MOVE_DIAGRAM_TITLE}: ${projectRelative(deps.workspaceRoot, filePath)} could not be read. Nothing was moved.`);
    return undefined;
  }
  let planned: ReturnType<typeof planDbmlDiagramLayerMove>;
  try {
    planned = planDbmlDiagramLayerMove({ semanticRoot: deps.semanticRoot, filePath, toLayer, text });
  } catch (err) {
    if (isRefusedWrite(err)) {
      showRefusedWrite(MOVE_DIAGRAM_TITLE, err, { semanticRoot: deps.semanticRoot, workspaceRoot: deps.workspaceRoot, outcome: 'Nothing was moved.' });
    } else {
      void vscode.window.showErrorMessage(`${MOVE_DIAGRAM_TITLE}: ${err instanceof Error ? err.message : String(err)} Nothing was moved.`);
    }
    return undefined;
  }

  // A canvas is bound to its file: close it, and reopen the moved file in the same editor.
  const open = tabsShowing(filePath);
  if (open.length > 0) await vscode.window.tabGroups.close(open.map((o) => o.tab), true);
  const made = foldersMadeBy(planned.writes);
  const result = await deps.applyWrites(planned.writes);
  if (!result.ok) {
    if (result.unrestored.length === 0) {
      removeFolders(made);
      void vscode.window.showErrorMessage(`${MOVE_DIAGRAM_TITLE}: VS Code rejected the move; nothing was changed.`);
      await reopen(open, filePath);
    }
    return undefined;
  }
  await deps.afterDiagramMoved(filePath, planned.newPath);
  await reopen(open, planned.newPath);
  if (result.unsaved.length > 0) {
    void vscode.window.showErrorMessage(`Could not save ${result.unsaved.map((p) => projectRelative(deps.workspaceRoot, p)).join(', ')}. Save the file from its tab, or revert it.`);
  }
  void vscode.window.showInformationMessage(`Moved ${name} to ${semanticRel(deps, path.dirname(planned.newPath))}.`);
  return planned.newPath;
}

/**
 * **Move Diagram to Layer…**: the diagram `arg` names (a Subject Areas row
 * or an Explorer file), else one picked from the DBML diagrams; then the
 * layer.
 */
export async function moveDiagramCommand(deps: MoveDbmlDeps, arg?: unknown): Promise<void> {
  let filePath = argPaths(arg, undefined)?.[0];
  if (arg !== undefined && filePath === undefined) {
    void vscode.window.showErrorMessage(`${MOVE_DIAGRAM_TITLE}: no diagram selected. Right-click a diagram in the ERD Studio view, or a .dbml diagram file in the Explorer.`);
    return;
  }
  if (filePath === undefined) {
    const diagrams = deps.tableLibraryService.listDbmlDiagrams();
    if (diagrams.length === 0) {
      void vscode.window.showInformationMessage('There are no DBML diagrams to move.');
      return;
    }
    const pick = await vscode.window.showQuickPick(
      diagrams.map((d) => {
        const layer = semanticRel(deps, d).split('/')[0];
        return { label: path.basename(d).replace(/\.dbml$/i, ''), description: labelOf(deps, layer), filePath: d };
      }),
      { title: MOVE_DIAGRAM_TITLE, placeHolder: 'Which diagram do you want to move?', matchOnDescription: true },
    );
    if (!pick) return;
    filePath = pick.filePath;
  }
  const rel = semanticRel(deps, filePath);
  const tree = dbmlTreePathOf(rel);
  if (!tree || tree.kind !== 'diagram') {
    const json = classifySemanticFile(rel, { tablesDirIsLayer: false }).kind === 'diagram';
    void vscode.window.showErrorMessage(json
      ? `${MOVE_DIAGRAM_TITLE}: "${path.basename(filePath)}" is a JSON diagram: Move Diagram to Layer moves DBML diagrams (<layer>/diagrams/*.dbml). Convert Project to DBML first, or move the file by hand.`
      : `${MOVE_DIAGRAM_TITLE}: ${projectRelative(deps.workspaceRoot, filePath)} is not a DBML diagram (<layer>/diagrams/*.dbml). Nothing was moved.`);
    return;
  }
  const layers = moveLayersOf(deps).filter((l) => l.layer !== tree.layer);
  if (layers.length === 0) {
    void vscode.window.showInformationMessage(`There is no other layer to move "${tree.name}" to. Add a layer first.`);
    return;
  }
  const picked = await vscode.window.showQuickPick(
    // A diagram opens only in a layer layers.json lists: say so before it goes to another.
    layers.map((l) => ({
      label: l.label,
      description: `${l.layer}/diagrams/`,
      ...(l.listed ? {} : { detail: 'Not in layers.json: add this layer to open its diagrams.' }),
      layer: l.layer,
    })),
    { title: `Move ${tree.name}`, placeHolder: `Move ${tree.name} (now in ${labelOf(deps, tree.layer)}) to which layer?` },
  );
  if (!picked) return;
  await moveDbmlDiagram(deps, filePath, picked.layer);
}
