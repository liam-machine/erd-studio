/**
 * **New Table…** (`erdStudio.newTable`) and **New Schema…**
 * (`erdStudio.newSchema`) from the Table Library (ERD Studio 2.0, the
 * layer-first DBML tree): a table file `<layer>/tables/<schema>/<name>.dbml`
 * declaring `Table <schema>.<name>`, on no diagram yet.
 *
 * A schema is the folder its tables sit in, and nothing else: Git keeps no
 * empty folder and the Table Library lists a schema from its table files. So
 * New Schema… asks for the schema's name and carries straight on into New
 * Table… in it; the folder is made with that first table, and cancelling
 * leaves nothing behind.
 *
 * Planned by the library's own planner (`planDbmlBatch`: the save the canvas's
 * New Table makes, plus the settle of any diagram that was waiting for the
 * name), never a second one, and applied as ONE WorkspaceEdit through the
 * host's `applyWrites`. A name the library already has, in any case, is
 * refused as the canvas refuses it (`findTableNameIgnoringCase`).
 */

import * as path from 'path';
import * as vscode from 'vscode';

import { isDbmlLayerName, type ProjectStorage } from '@erd-studio/core';

import { projectRelative } from '../services/commandErrors';
import { isSchemaFolderName } from '../services/dbmlLibraryWrites';
import type { FileWrite } from '../services/fileWrites';
import type { TableLibraryService } from '../services/logicalModelService';
import { isRefusedWrite } from '../services/newSubjectAreaWriter';
import { validateNewDbmlTableName, validateTableName } from '../providers/payloadValidation';
import { foldersMadeBy, moveLayersOf, removeFolders, validateNewSchemaName } from './moveDbml';
import { showRefusedWrite } from './openModelFile';

export const NEW_TABLE_COMMAND = 'erdStudio.newTable';
export const NEW_SCHEMA_COMMAND = 'erdStudio.newSchema';
export const NEW_TABLE_TITLE = 'New Table';
export const NEW_SCHEMA_TITLE = 'New Schema';

/** What the two commands need from the host; `activate()` passes the real services. */
export interface NewTableDeps {
  workspaceRoot: string;
  /** The semantic dir, absolute. */
  semanticRoot: string;
  tableLibraryService: Pick<TableLibraryService, 'listTableFiles' | 'listDbmlLayerFolders' | 'findTableNameIgnoringCase' | 'planDbmlBatch'>;
  /** How the project stores its tables: a YAML project is refused. */
  storage(): ProjectStorage;
  /** The layers `layers.json` lists, in its order. */
  layers(): ReadonlyArray<{ id: string; label: string }>;
  /** A file's text: an open document's, else the disk's. */
  readText(filePath: string): string | null;
  /** Those of `filePaths` open with unsaved edits. */
  dirtyFiles(filePaths: readonly string[]): string[];
  /** Apply the writes as one WorkspaceEdit, save and record own writes. */
  applyWrites(writes: readonly FileWrite[]): Promise<{ ok: boolean; unsaved: string[]; unrestored: string[] }>;
  /** After the table's file landed: the views and open canvases refresh. */
  afterCreated(writes: ReadonlyArray<{ path: string }>): Promise<void>;
  /** Show the new table: its row in the Table Library, and its file. */
  show(name: string, filePath: string): Promise<void>;
}

/** Where a new table goes. */
export interface NewTableHome {
  layer: string;
  schema: string;
}

/**
 * What a command's argument names: a Table Library layer row (its layer), a
 * DBML schema row (its layer and schema), or nothing (the title bar and the
 * palette). `invalid`: a row that is neither (a YAML folder, a table).
 */
export function newTableTarget(arg: unknown): { layer?: string; schema?: string } | 'invalid' {
  if (arg === undefined || arg === null) return {};
  if (typeof arg !== 'object') return 'invalid';
  const o = arg as { type?: unknown; layer?: unknown; folder?: unknown };
  if (o.type === 'layer' && typeof o.layer === 'string') return { layer: o.layer };
  if (o.type === 'folder' && typeof o.layer === 'string' && typeof o.folder === 'string') return { layer: o.layer, schema: o.folder };
  return 'invalid';
}

/**
 * The New Schema box's answer for a layer that holds `schemas`: an error, or
 * null. The schema-folder rule Move Table's box applies
 * (`validateNewSchemaName`), and a name the layer already has, in any case,
 * is refused too: a new schema is one the layer does not hold.
 */
export function validateNewSchema(value: string, layerLabel: string, schemas: readonly string[]): string | null {
  const error = validateNewSchemaName(value, layerLabel, schemas);
  if (error) return error;
  const name = value.trim();
  const existing = schemas.find((s) => s.toLowerCase() === name.toLowerCase());
  return existing !== undefined
    ? `${layerLabel} already has the schema "${existing}". To add a table to it, right-click it in the Table Library and choose New Table…`
    : null;
}

/** A layer's label from `layers.json`, else its folder name. */
function labelOf(deps: Pick<NewTableDeps, 'layers'>, layer: string): string {
  return deps.layers().find((l) => l.id === layer)?.label ?? layer;
}

/**
 * Why `value` cannot be a new table's name, or null: the table-name rule the
 * canvas's New Table holds a name to, and a name the library already has in
 * any case (names are unique across the whole project), naming that table's
 * file and the way to keep two warehouse tables of one name.
 */
export function validateNewTableName(
  deps: Pick<NewTableDeps, 'tableLibraryService' | 'workspaceRoot'>,
  value: string,
  schema: string,
): string | null {
  const name = value.trim();
  if (!name) return 'Enter a table name.';
  const rule = validateNewDbmlTableName(name) ?? validateTableName(name);
  if (rule) return rule;
  const taken = deps.tableLibraryService.findTableNameIgnoringCase(name);
  if (taken === null) return null;
  const file = deps.tableLibraryService.listTableFiles().find((e) => !e.shadowedBy && e.name.toLowerCase() === taken.toLowerCase());
  const where = file ? ` (${projectRelative(deps.workspaceRoot, file.filePath)})` : '';
  const prefix = schema.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  return `Table "${taken}" already exists in the Table Library${where}. Table names are unique across the project. ` +
    `For a separate table also called ${name}, name it ${prefix ? `${prefix}_${name}` : `${name}_2`} and set its warehouse name (alias) to ${name}.`;
}

/** Whether the project takes a DBML table; says why not, once, when it does not. */
function writesDbmlTables(deps: Pick<NewTableDeps, 'storage'>, title: string): boolean {
  if (deps.storage() !== 'yaml') return true;
  void vscode.window.showErrorMessage(`${title}: this project stores its tables as YAML files, and ${title} adds a DBML table file. ` +
    'Add the table from a diagram (New Table), or run "ERD Studio: Convert Project to DBML" first. Nothing was created.');
  return false;
}

/** The layer a command works in: the row's, else the only one, else a pick. Undefined: cancelled, or there is none (said). */
async function resolveLayer(deps: NewTableDeps, title: string, given: string | undefined, placeHolder: string): Promise<string | undefined> {
  if (given !== undefined) {
    if (isDbmlLayerName(given)) return given;
    void vscode.window.showErrorMessage(`${title}: "${given}" cannot be a layer folder. Nothing was created.`);
    return undefined;
  }
  const layers = moveLayersOf(deps);
  if (layers.length === 0) {
    void vscode.window.showInformationMessage(`${title}: this project has no layer yet. Add one first with "ERD Studio: New Layer…".`);
    return undefined;
  }
  if (layers.length === 1) return layers[0].layer;
  const picked = await vscode.window.showQuickPick(
    layers.map((l) => ({ label: l.label, description: `${l.layer}/tables/`, layer: l.layer })),
    { title, placeHolder },
  );
  return picked?.layer;
}

/** The schema folders `layer` holds (empty ones too), as listed. */
function schemasOf(deps: Pick<NewTableDeps, 'layers' | 'tableLibraryService'>, layer: string): readonly string[] {
  return moveLayersOf(deps).find((l) => l.layer === layer)?.schemas ?? [];
}

/** Ask for a new schema's name in `layer`; undefined when cancelled. `value`: what the box starts with. */
async function askNewSchema(deps: NewTableDeps, layer: string, value?: string): Promise<string | undefined> {
  const label = labelOf(deps, layer);
  const schemas = schemasOf(deps, layer);
  const name = (await vscode.window.showInputBox({
    title: `New schema in ${label}`,
    prompt: `A folder in ${layer}/tables/, made with its first table: you name that table next. Each table in it is declared Table <schema>.<name>.`,
    ...(value !== undefined && validateNewSchema(value, label, schemas) === null ? { value } : {}),
    ignoreFocusOut: true,
    validateInput: (v) => validateNewSchema(v, label, schemas),
  }))?.trim();
  if (!name) return undefined;
  // The box's own rule again: a caller (or a test) may answer without it.
  const error = validateNewSchema(name, label, schemas);
  if (error) {
    void vscode.window.showErrorMessage(`${NEW_SCHEMA_TITLE}: ${error} Nothing was created.`);
    return undefined;
  }
  return name;
}

/**
 * Create the table `name` in `<layer>/tables/<schema>/`: refuse a name that
 * breaks the rule or that the library already has (nothing changes), plan,
 * apply as one edit, refresh and show the new table. Returns the file it
 * made, or undefined when nothing was created.
 */
export async function createDbmlTable(deps: NewTableDeps, home: NewTableHome, rawName: string): Promise<string | undefined> {
  const name = rawName.trim();
  if (!isDbmlLayerName(home.layer)) {
    void vscode.window.showErrorMessage(`${NEW_TABLE_TITLE}: "${home.layer}" cannot be a layer folder. Nothing was created.`);
    return undefined;
  }
  if (!isSchemaFolderName(home.schema)) {
    void vscode.window.showErrorMessage(`${NEW_TABLE_TITLE}: "${home.schema}" cannot be a schema folder name (leave out quotes, slashes, \\ : * ? < > |, {{ }} and a trailing dot or space). Nothing was created.`);
    return undefined;
  }
  const nameError = validateNewTableName(deps, name, home.schema);
  if (nameError) {
    void vscode.window.showErrorMessage(`${NEW_TABLE_TITLE}: ${nameError} Nothing was created.`);
    return undefined;
  }

  let writes: FileWrite[];
  let filePath: string | undefined;
  try {
    const planned = deps.tableLibraryService.planDbmlBatch({
      // A new table (D-4): never an edit of a table of that name in another schema folder.
      ops: { save: [{ model: { name, schema: home.schema, description: '', columns: [] }, home, create: true }] },
      dirtyFiles: deps.dirtyFiles,
      readText: deps.readText,
    });
    writes = planned.writes;
    // The file as the plan spells it (an existing schema folder's spelling wins).
    const rel = planned.plan.createdTablePaths?.[0] ?? planned.plan.resolveTable(name)?.path;
    filePath = rel !== undefined ? path.join(deps.semanticRoot, ...rel.split('/')) : undefined;
  } catch (err) {
    if (isRefusedWrite(err)) {
      showRefusedWrite(NEW_TABLE_TITLE, err, { semanticRoot: deps.semanticRoot, workspaceRoot: deps.workspaceRoot, outcome: 'Nothing was created.' });
    } else {
      void vscode.window.showErrorMessage(`${NEW_TABLE_TITLE}: ${err instanceof Error ? err.message : String(err)} Nothing was created.`);
    }
    return undefined;
  }
  if (filePath === undefined) {
    void vscode.window.showErrorMessage(`${NEW_TABLE_TITLE}: could not work out where "${name}" goes. Nothing was created.`);
    return undefined;
  }

  const made = foldersMadeBy(writes);
  const result = await deps.applyWrites(writes);
  if (!result.ok) {
    // The reconcile's modal already named any file it could not put back.
    if (result.unrestored.length === 0) {
      removeFolders(made);
      void vscode.window.showErrorMessage(`${NEW_TABLE_TITLE}: VS Code rejected the new file; nothing was created.`);
    }
    return undefined;
  }
  await deps.afterCreated(writes);
  if (result.unsaved.length > 0) {
    void vscode.window.showErrorMessage(`Could not save ${result.unsaved.map((p) => projectRelative(deps.workspaceRoot, p)).join(', ')}. Save the file from its tab, or revert it.`);
  }
  await deps.show(name, filePath);
  void vscode.window.showInformationMessage(
    `Created ${projectRelative(deps.workspaceRoot, filePath)}. It is on no diagram yet: right-click it in the Table Library and choose Add to Diagram…`,
  );
  return filePath;
}

/** Ask for the table's name in `home` and create it. */
async function askNameAndCreate(deps: NewTableDeps, home: NewTableHome): Promise<void> {
  const label = labelOf(deps, home.layer);
  const name = (await vscode.window.showInputBox({
    title: `New table in ${label} › ${home.schema}`,
    prompt: `Its file is ${home.layer}/tables/${home.schema}/<name>.dbml, declaring Table ${home.schema}.<name>. Table names are unique across the project.`,
    placeHolder: 'dim_customer',
    ignoreFocusOut: true,
    validateInput: (value) => validateNewTableName(deps, value, home.schema),
  }))?.trim();
  if (!name) return;
  await createDbmlTable(deps, home, name);
}

/** A schema pick's item: an existing schema folder, or a new one. */
interface SchemaItem extends vscode.QuickPickItem {
  schema?: string;
  newSchema?: true;
}

/**
 * **New Table…**: in the schema `arg` names (a Table Library schema row), in
 * a schema picked in the layer it names (a layer row), else in a layer and
 * schema picked (the title bar, the palette); then the table's name.
 */
export async function newTableCommand(deps: NewTableDeps, arg?: unknown): Promise<void> {
  if (!writesDbmlTables(deps, NEW_TABLE_TITLE)) return;
  const target = newTableTarget(arg);
  if (target === 'invalid') {
    void vscode.window.showErrorMessage(`${NEW_TABLE_TITLE}: right-click a layer or a schema in the Table Library, or run "ERD Studio: New Table…" from the Command Palette.`);
    return;
  }
  const layer = await resolveLayer(deps, NEW_TABLE_TITLE, target.layer, 'Which layer is the new table in?');
  if (layer === undefined) return;
  let schema = target.schema;
  if (schema === undefined) {
    const label = labelOf(deps, layer);
    // A folder name a new schema box would refuse would write a file no parser reads back.
    const schemas = schemasOf(deps, layer).filter(isSchemaFolderName);
    if (schemas.length === 0) {
      // A layer with no schema yet: its own name is the usual first one.
      schema = await askNewSchema(deps, layer, layer);
    } else {
      const items: SchemaItem[] = [
        ...schemas.map((s): SchemaItem => ({ label: s, description: `${layer}/tables/${s}/`, schema: s })),
        { label: `$(add) New schema in ${label}…`, newSchema: true },
      ];
      const picked = await vscode.window.showQuickPick(items, {
        title: `New table in ${label}`,
        placeHolder: `Which schema of ${label} is the new table in?`,
        matchOnDescription: true,
      });
      if (!picked) return;
      schema = picked.newSchema ? await askNewSchema(deps, layer) : picked.schema;
    }
    if (schema === undefined) return;
  }
  await askNameAndCreate(deps, { layer, schema });
}

/**
 * **New Schema…**: in the layer `arg` names (a Table Library layer row),
 * else one picked; the schema's name; then its first table (New Table… in
 * it), whose file makes the folder.
 */
export async function newSchemaCommand(deps: NewTableDeps, arg?: unknown): Promise<void> {
  if (!writesDbmlTables(deps, NEW_SCHEMA_TITLE)) return;
  const target = newTableTarget(arg);
  if (target === 'invalid') {
    void vscode.window.showErrorMessage(`${NEW_SCHEMA_TITLE}: right-click a layer in the Table Library, or run "ERD Studio: New Schema…" from the Command Palette.`);
    return;
  }
  const layer = await resolveLayer(deps, NEW_SCHEMA_TITLE, target.layer, 'Which layer is the new schema in?');
  if (layer === undefined) return;
  const schema = await askNewSchema(deps, layer);
  if (schema === undefined) return;
  await askNameAndCreate(deps, { layer, schema });
}
