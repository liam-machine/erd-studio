/**
 * Edit messages the canvas components post to their host.
 *
 * These are the subset of the webview → extension protocol that the shared
 * canvas (model nodes, FK edges, annotations, the detail panel) can send. The
 * extension's full `WebviewMessage` union in `src/types/messages.ts` includes
 * every one of them and re-exports them from there.
 */

import type { AnnotationColor, Cardinality, ColumnDef, ModelRole, Rationale } from './semantic.js';

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
 * Request to update the model role for a model.
 * If the role is null/empty, the `modelRole` key is removed from the JSON entirely.
 */
export interface UpdateModelRoleMessage {
  type: 'updateModelRole';
  payload: {
    modelName: string;
    modelRole: ModelRole | null;
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
  | UpdateModelRoleMessage
  | ReorderColumnsMessage
  | UpdateAnnotationMessage
  | RemoveAnnotationMessage;
