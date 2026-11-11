/**
 * Edit messages the canvas components post to their host.
 *
 * These are the subset of the webview → extension protocol that the shared
 * canvas (model nodes, FK edges, annotations, the detail panel) can send. The
 * extension's full `WebviewMessage` union in `src/types/messages.ts` includes
 * every one of them and re-exports them from there.
 */

import type { AnnotationColor, Cardinality, ColumnDef, TableRole, Rationale } from './semantic.js';

/**
 * Request to add a column to an existing model.
 */
export interface AddColumnMessage {
  type: 'addColumn';
  payload: {
    modelName: string;
    column: ColumnDef;
  };
}

/**
 * Request to remove a column from an existing model.
 */
export interface RemoveColumnMessage {
  type: 'removeColumn';
  payload: {
    modelName: string;
    columnName: string;
  };
}

/**
 * Column shape accepted by `updateColumn`.
 *
 * `scdType` / `additiveType` are three-state so that edit surfaces which only
 * know part of a column (e.g. canvas inline rename) don't erase attributes they
 * never displayed:
 *   - `undefined` (omitted) — keep the existing value on disk
 *   - `null`                — explicitly clear the value
 *   - a value               — set it
 */
export type UpdateColumnPayloadColumn = Omit<ColumnDef, 'scdType' | 'additiveType'> & {
  scdType?: ColumnDef['scdType'] | null;
  additiveType?: ColumnDef['additiveType'] | null;
};

/**
 * Request to update an existing column in a model.
 */
export interface UpdateColumnMessage {
  type: 'updateColumn';
  payload: {
    modelName: string;
    oldColumnName: string;
    column: UpdateColumnPayloadColumn;
  };
}

/**
 * Request to rename a model.
 * Cascades to update all relationship references and viewConfig positions.
 */
export interface RenameModelMessage {
  type: 'renameModel';
  payload: {
    oldName: string;
    newName: string;
  };
}

/**
 * Request to remove a model from the domain.
 * Also cascades to remove relationships involving this model.
 */
export interface RemoveModelMessage {
  type: 'removeModel';
  payload: {
    modelName: string;
  };
}

/** Composite identity of an FK relationship: (fromModel, fromColumn, toModel, toColumn). */
export interface RelationshipKey {
  fromModel: string;
  fromColumn: string;
  toModel: string;
  toColumn: string;
}

/**
 * Request to remove an FK relationship.
 * Identity is the composite key: (fromModel, fromColumn, toModel, toColumn).
 */
export interface RemoveRelationshipMessage {
  type: 'removeRelationship';
  payload: RelationshipKey;
}

/**
 * Request to update a relationship's cardinality.
 * Identity is the composite key: (fromModel, fromColumn, toModel, toColumn).
 */
export interface UpdateRelationshipMessage {
  type: 'updateRelationship';
  payload: {
    fromModel: string;
    fromColumn: string;
    toModel: string;
    toColumn: string;
    cardinality: Cardinality;
  };
}

/** Key type for column key toggles. */
export type ColumnKeyType = 'PK' | 'FK' | 'NK';

/**
 * Request to toggle a column's key type (PK, FK, or NK).
 * Each key type is independent — a column can be any combination.
 */
export interface ToggleColumnKeyMessage {
  type: 'toggleColumnKey';
  payload: {
    modelName: string;
    columnName: string;
    keyType: ColumnKeyType;
    value: boolean;
  };
}

/**
 * Request to update design rationale fields on a model.
 *
 * Uses a field-patch pattern: each message carries one or more field updates
 * that are merged into the existing on-disk `rationale` object by the extension host.
 */
export interface UpdateModelRationaleMessage {
  type: 'updateModelRationale';
  payload: {
    modelName: string;
    /** Partial patch — only the fields being updated need to be present. */
    rationale: Partial<Rationale>;
  };
}

/**
 * Request to update the description for a model.
 * If the description is empty/cleared, the `description` key is removed from the JSON entirely.
 */
export interface UpdateModelDescriptionMessage {
  type: 'updateModelDescription';
  payload: {
    modelName: string;
    description: string;
  };
}

/**
 * Request to update the grain statement for a model.
 * If the grain is empty/cleared, the `grain` key is removed from the JSON entirely.
 */
export interface UpdateModelGrainMessage {
  type: 'updateModelGrain';
  payload: {
    modelName: string;
    grain: string;
  };
}

/**
 * Request to set or clear a model's alias — the table name dbt builds it as.
 * An empty alias removes the `alias` key from the model file.
 */
export interface UpdateModelAliasMessage {
  type: 'updateModelAlias';
  payload: {
    modelName: string;
    alias: string;
  };
}

/**
 * Request to change a model's or a column's `meta` — a patch, never the whole
 * map, so nested values the canvas only displays are never rewritten.
 * `set` writes top-level text values; `remove` deletes top-level keys.
 * `columnName` targets that column's `meta` instead of the model's.
 */
export interface UpdateMetaMessage {
  type: 'updateMeta';
  payload: {
    modelName: string;
    columnName?: string;
    set?: Record<string, string>;
    remove?: string[];
  };
}

/**
 * Request to update the model role for a model.
 * If the role is null/empty, the `modelRole` key is removed from the JSON entirely.
 */
export interface UpdateModelRoleMessage {
  type: 'updateModelRole';
  payload: {
    modelName: string;
    modelRole: TableRole | null;
  };
}

/**
 * Request to reorder columns within a model.
 * The orderedNames array defines the new column order.
 * All existing column names must be present (validated by the extension host).
 */
export interface ReorderColumnsMessage {
  type: 'reorderColumns';
  payload: {
    modelName: string;
    orderedNames: string[];
  };
}

/**
 * Request to update an existing annotation's content or style.
 * Partial patch — only fields being changed need to be present.
 */
export interface UpdateAnnotationMessage {
  type: 'updateAnnotation';
  payload: {
    id: string;
    text?: string;
    color?: AnnotationColor;
    linkedModel?: string | null;
    width?: number;
    height?: number;
  };
}

/**
 * Request to remove a canvas annotation.
 */
export interface RemoveAnnotationMessage {
  type: 'removeAnnotation';
  payload: {
    id: string;
  };
}

/**
 * Request to open a model's `logical-models` file in a text editor, with the
 * cursor on its load error when it has one. Writes nothing — the node posts
 * it from the "Open file" button shown on a model whose file is broken, and
 * the detail panel from its File line's "Open".
 */
export interface OpenModelFileMessage {
  type: 'openModelFile';
  payload: {
    modelName: string;
  };
}

/**
 * Request to add an existing model (from the Table Library, or from dbt) to
 * the open diagram. Posted by the Add Existing Table dialog and by the detail
 * panel's "Not on this diagram" list ("+ Add").
 */
export interface AddExistingModelMessage {
  type: 'addExistingModel';
  payload: {
    modelName: string;
    /**
     * The file the row was listed from (`ExistingTablePreview.sourcePath`,
     * project-relative): a Table Library row names its table by its file,
     * so two tables of one name in different schema folders are told apart.
     * Optional: an older canvas sends the name alone, which means the table
     * the library finds by that name.
     */
    sourcePath?: string;
  };
}

/**
 * Add several picked models to the diagram in one edit (#160): the Add
 * Existing Table dialog with more than one row ticked, or the detail panel's
 * "Add all related". Library models are referenced; dbt-only ones are seeded
 * into the library, as with `addExistingModel`. Names already in the diagram
 * are skipped. One WorkspaceEdit, one undo step. v5 domains and later only;
 * the extension caps how many names one request may carry.
 */
export interface AddExistingModelsMessage {
  type: 'addExistingModels';
  payload: {
    modelNames: string[];
    /**
     * Each picked row's file, index for index with `modelNames`
     * (`ExistingTablePreview.sourcePath`, project-relative; `''` for a row
     * with none). Optional, as on `addExistingModel`.
     */
    sourcePaths?: string[];
  };
}

// ---------------------------------------------------------------------------
// Canvas context (host → canvas, editing hosts only)
// ---------------------------------------------------------------------------

/**
 * One relationship between a table on the open diagram and a table that is
 * not on it, read from the Table Library. Seen from the diagram's table:
 * `out` when it holds the foreign key, `in` when the other table does.
 */
export interface OffDiagramRelationship {
  /** The table that is not on the diagram. */
  otherTable: string;
  /**
   * The layer the other table lives in, as the user reads it (its
   * layers.json label), when that is not the diagram's own layer.
   */
  otherLayer?: string;
  /**
   * The joining columns as one line: `store_key`, `(region_code,
   * country_code)` for a composite, or `ship_date_key → date_key` when the
   * two ends are named differently. Foreign-key end first.
   */
  columns: string;
  /** As stored, read from the foreign-key end (as the panel's other rows show it). */
  cardinality: Cardinality;
  direction: 'out' | 'in';
  /**
   * The other table's file, project-relative with `/` separators: what "+ Add"
   * posts as `sourcePath`, so the table added is this one even when another
   * schema folder has a table of its name. Absent from an older host.
   */
  otherTablePath?: string;
}

/**
 * Request to open the project's field list (`<semanticDir>/fields.yml`) in a
 * text editor: the Detail panel's "Customise fields" link, editor only (never
 * a viewer, never the read-only physical stage). Writes nothing — with no
 * file the host opens an unsaved document holding the starting set.
 */
export interface OpenFieldsFileMessage {
  type: 'openFieldsFile';
}

/**
 * What an editing host knows about the project beyond the diagram itself,
 * sent beside (never inside) the `DisplaySubjectArea`, logical stage only.
 * Keyed by the diagram's table names. A viewer never gets one: the canvas
 * then shows none of what it feeds (the detail panel's File line and "Not on
 * this diagram" list, the node's "+n" chip).
 */
export interface CanvasContext {
  /** Each diagram table's file, project-relative with `/` separators. */
  tableFiles: Record<string, string>;
  /** Each diagram table's relationships to tables not on the diagram; a table with none is left out. */
  offDiagram: Record<string, OffDiagramRelationship[]>;
  /** Who reviews a change to each table's file (CODEOWNERS), as one line; a table with none is left out. */
  owners?: Record<string, string>;
}

/** Union of every edit message the canvas components can post to their host. */
export type CanvasEditMessage =
  | AddColumnMessage
  | RemoveColumnMessage
  | UpdateColumnMessage
  | RenameModelMessage
  | RemoveModelMessage
  | RemoveRelationshipMessage
  | UpdateRelationshipMessage
  | ToggleColumnKeyMessage
  | UpdateModelRationaleMessage
  | UpdateModelDescriptionMessage
  | UpdateModelGrainMessage
  | UpdateModelAliasMessage
  | UpdateMetaMessage
  | UpdateModelRoleMessage
  | ReorderColumnsMessage
  | UpdateAnnotationMessage
  | RemoveAnnotationMessage
  | OpenModelFileMessage
  | OpenFieldsFileMessage
  | AddExistingModelMessage
  | AddExistingModelsMessage;
