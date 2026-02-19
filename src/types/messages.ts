/**
 * Message protocol types for extension ↔ webview communication.
 *
 * Messages are categorised by direction:
 *   Extension → Webview:  domainLoaded, domainUpdated, manifestRefreshed, error
 *   Webview → Extension:  ready, addModel, addColumn, removeColumn, addRelationship,
 *                         removeModel, removeRelationship, editRelationship, updateViewConfig,
 *                         addExistingModel, updatePositions, runAutoLayout
 *
 * All message types use a discriminated union pattern with a `type` field,
 * enabling exhaustive switch handling in message handlers.
 */

import type { ReconciledDomain } from './reconciled';
import type { AiRationale, Cardinality, ColumnDef, DesignModel, LayoutOptions, ModelRole } from './semantic';

// ---------------------------------------------------------------------------
// Extension → Webview messages
// ---------------------------------------------------------------------------

/**
 * Sent when the domain is initially loaded or refreshed.
 * Contains the fully reconciled domain ready for rendering.
 */
export interface DomainLoadedMessage {
  type: 'domainLoaded';
  payload: ReconciledDomain;
}

/**
 * Sent when the domain is updated due to a mutation (add/remove model, etc.).
 * Contains the updated reconciled domain.
 */
export interface DomainUpdatedMessage {
  type: 'domainUpdated';
  payload: ReconciledDomain;
}

/**
 * Sent when the manifest is refreshed and design models/relationships may have transitioned.
 * Contains the updated domain and lists of newly built items.
 */
export interface ManifestRefreshedMessage {
  type: 'manifestRefreshed';
  payload: {
    domain: ReconciledDomain;
    newlyBuiltModels: string[];
    newlyBuiltRelationships: Array<{
      fromModel: string;
      fromColumn: string;
      toModel: string;
      toColumn: string;
    }>;
  };
}

/**
 * Sent when an error occurs during domain parsing or mutation.
 */
export interface ErrorMessage {
  type: 'error';
  payload: {
    message: string;
  };
}

/** Union of all messages the extension can send to the webview. */
export type ExtensionMessage =
  | DomainLoadedMessage
  | DomainUpdatedMessage
  | ManifestRefreshedMessage
  | ErrorMessage;

// ---------------------------------------------------------------------------
// Webview → Extension messages
// ---------------------------------------------------------------------------

/**
 * Sent when the webview mounts and is ready to receive domain data.
 */
export interface ReadyMessage {
  type: 'ready';
}

/**
 * Request to add a new design model to the domain.
 * Phase 2: Design Mode.
 */
export interface AddModelMessage {
  type: 'addModel';
  payload: DesignModel;
}

/**
 * Request to add a column to an existing design model.
 * Phase 2: Design Mode.
 */
export interface AddColumnMessage {
  type: 'addColumn';
  payload: {
    modelName: string;
    column: ColumnDef;
  };
}

/**
 * Request to remove a column from an existing design model.
 * Phase 2: Design Mode.
 */
export interface RemoveColumnMessage {
  type: 'removeColumn';
  payload: {
    modelName: string;
    columnName: string;
  };
}

/**
 * Request to update an existing column in a model.
 * For repo models, updates the plannedColumns array.
 * For design models, updates the columns array.
 * Phase 2: Design Mode.
 */
export interface UpdateColumnMessage {
  type: 'updateColumn';
  payload: {
    modelName: string;
    oldColumnName: string;
    column: ColumnDef;
  };
}

/**
 * Request to add an FK relationship between two models.
 * Phase 2: Design Mode.
 */
export interface AddRelationshipMessage {
  type: 'addRelationship';
  payload: {
    fromModel: string;
    fromColumn: string;
    toModel: string;
    toColumn: string;
    cardinality: Cardinality;
  };
}

/**
 * Request to rename a design model.
 * Cascades to update all relationship references and viewConfig positions.
 * Only allowed for design-status models (source === 'design').
 */
export interface RenameModelMessage {
  type: 'renameModel';
  payload: {
    oldName: string;
    newName: string;
  };
}

/**
 * Request to remove a design model from the domain.
 * Also cascades to remove relationships involving this model.
 * Phase 2: Design Mode.
 */
export interface RemoveModelMessage {
  type: 'removeModel';
  payload: {
    modelName: string;
  };
}

/**
 * Request to remove an FK relationship.
 * Identity is the composite key: (fromModel, fromColumn, toModel, toColumn).
 * Phase 2: Design Mode.
 */
export interface RemoveRelationshipMessage {
  type: 'removeRelationship';
  payload: {
    fromModel: string;
    fromColumn: string;
    toModel: string;
    toColumn: string;
  };
}

/**
 * Request to update a relationship's cardinality.
 * Identity is the composite key: (fromModel, fromColumn, toModel, toColumn).
 * Works for both design and built relationships.
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

/**
 * Request to update view configuration (layout options, etc.).
 */
export interface UpdateViewConfigMessage {
  type: 'updateViewConfig';
  payload: {
    layoutOptions?: LayoutOptions;
    showFkEdges?: boolean;
  };
}

/**
 * Request to add an existing model from the manifest to the domain.
 * The model is added with source: 'built'.
 * Phase 3: Domain Management.
 */
export interface AddExistingModelMessage {
  type: 'addExistingModel';
  payload: {
    modelName: string;
  };
}

/**
 * Request to update node positions on the canvas.
 * Positions are debounced and merged into viewConfig.positions.
 */
export interface UpdatePositionsMessage {
  type: 'updatePositions';
  payload: {
    positions: Record<string, { x: number; y: number }>;
  };
}

/**
 * Request to run ELK auto-layout on the graph.
 * Phase 1: F109 ELK Layout.
 */
export interface RunAutoLayoutMessage {
  type: 'runAutoLayout';
}

/**
 * Request to refresh the manifest and re-reconcile all open domains.
 * Useful when the file watcher misses a change or user wants to force refresh.
 * Phase 3: F305 Manual Refresh Manifest.
 */
export interface RefreshManifestMessage {
  type: 'refreshManifest';
}

/**
 * Request to undo the last edit operation.
 * Executes VS Code's native undo command on the document.
 */
export interface UndoMessage {
  type: 'undo';
}

/**
 * Request to redo the last undone operation.
 * Executes VS Code's native redo command on the document.
 */
export interface RedoMessage {
  type: 'redo';
}

/**
 * Request to approve a model and all its existing columns.
 * Sets model.approved = true and column.approved = true for all columns.
 */
export interface ApproveModelMessage {
  type: 'approveModel';
  payload: {
    modelName: string;
  };
}

/**
 * Request to unapprove a model.
 * Sets model.approved = false but leaves column approval states unchanged.
 */
export interface UnapproveModelMessage {
  type: 'unapproveModel';
  payload: {
    modelName: string;
  };
}

/**
 * Request to approve a single column.
 * Requires the model to be approved first.
 */
export interface ApproveColumnMessage {
  type: 'approveColumn';
  payload: {
    modelName: string;
    columnName: string;
  };
}

/**
 * Request to unapprove a single column.
 */
export interface UnapproveColumnMessage {
  type: 'unapproveColumn';
  payload: {
    modelName: string;
    columnName: string;
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
 * Request to approve a relationship.
 * Sets relationship.approved = true.
 */
export interface ApproveRelationshipMessage {
  type: 'approveRelationship';
  payload: {
    fromModel: string;
    fromColumn: string;
    toModel: string;
    toColumn: string;
  };
}

/**
 * Request to unapprove a relationship.
 * Removes relationship.approved field.
 */
export interface UnapproveRelationshipMessage {
  type: 'unapproveRelationship';
  payload: {
    fromModel: string;
    fromColumn: string;
    toModel: string;
    toColumn: string;
  };
}

/**
 * Request to edit a relationship (change any field including the composite key).
 * Preserves source and approved status while allowing full modification.
 * Only works for design/approved relationships (not built).
 */
export interface EditRelationshipMessage {
  type: 'editRelationship';
  payload: {
    /** Original composite key to find the relationship */
    originalFromModel: string;
    originalFromColumn: string;
    originalToModel: string;
    originalToColumn: string;
    /** New values (may be same as original) */
    fromModel: string;
    fromColumn: string;
    toModel: string;
    toColumn: string;
    cardinality: Cardinality;
  };
}

/**
 * Request to accept a column dataType discrepancy.
 * Removes the expectedDataType from the plannedColumns override — manifest becomes truth.
 */
export interface AcceptDiscrepancyMessage {
  type: 'acceptDiscrepancy';
  payload: {
    modelName: string;
    columnName: string;
  };
}

/**
 * Request to reject a column dataType discrepancy.
 * Marks the override as rejected — the manifest value is non-conforming.
 */
export interface RejectDiscrepancyMessage {
  type: 'rejectDiscrepancy';
  payload: {
    modelName: string;
    columnName: string;
  };
}

/**
 * Request to unreject a previously rejected discrepancy.
 * Clears the rejected flag, returning it to unresolved state.
 */
export interface UnrejectDiscrepancyMessage {
  type: 'unrejectDiscrepancy';
  payload: {
    modelName: string;
    columnName: string;
  };
}

/**
 * Request to accept all column discrepancies for a model.
 * Removes all expectedDataType fields from plannedColumns overrides.
 * Also clears structural discrepancies: removes extras from designedColumns,
 * removes missing from both plannedColumns and designedColumns.
 */
export interface AcceptAllDiscrepanciesMessage {
  type: 'acceptAllDiscrepancies';
  payload: {
    modelName: string;
  };
}

/**
 * Request to accept a structural discrepancy (extra or missing column).
 * - Extra: removes column name from designedColumns (acknowledge the column exists)
 * - Missing: removes column from plannedColumns AND designedColumns (stop expecting it)
 */
export interface AcceptStructuralDiscrepancyMessage {
  type: 'acceptStructuralDiscrepancy';
  payload: {
    modelName: string;
    columnName: string;
    discrepancyType: 'extra' | 'missing';
  };
}

/**
 * Request to reject a structural discrepancy (extra or missing column).
 * - Extra: creates/updates plannedColumns override with structuralRejected: true
 * - Missing: sets structuralRejected: true on existing plannedColumns entry
 */
export interface RejectStructuralDiscrepancyMessage {
  type: 'rejectStructuralDiscrepancy';
  payload: {
    modelName: string;
    columnName: string;
    discrepancyType: 'extra' | 'missing';
  };
}

/**
 * Request to un-reject a structural discrepancy.
 * Clears structuralRejected flag and removes empty overrides.
 */
export interface UnrejectStructuralDiscrepancyMessage {
  type: 'unrejectStructuralDiscrepancy';
  payload: {
    modelName: string;
    columnName: string;
  };
}

/**
 * Request to update AI rationale fields on a model.
 *
 * Uses a field-patch pattern: each message carries one or more field updates
 * that are merged into the existing on-disk `ai` object by the extension host.
 * This avoids stale-closure races when multiple reasoning fields are edited
 * in quick succession. If all fields end up empty after the patch, the `ai`
 * key is removed entirely to keep the JSON clean.
 */
export interface UpdateModelAiMessage {
  type: 'updateModelAi';
  payload: {
    modelName: string;
    /** Partial patch — only the fields being updated need to be present. */
    ai: Partial<AiRationale>;
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

/** Union of all messages the webview can send to the extension. */
export type WebviewMessage =
  | ReadyMessage
  | AddModelMessage
  | AddColumnMessage
  | RemoveColumnMessage
  | UpdateColumnMessage
  | AddRelationshipMessage
  | RenameModelMessage
  | RemoveModelMessage
  | RemoveRelationshipMessage
  | UpdateRelationshipMessage
  | EditRelationshipMessage
  | UpdateViewConfigMessage
  | AddExistingModelMessage
  | UpdatePositionsMessage
  | RunAutoLayoutMessage
  | RefreshManifestMessage
  | UndoMessage
  | RedoMessage
  | ApproveModelMessage
  | UnapproveModelMessage
  | ApproveColumnMessage
  | UnapproveColumnMessage
  | ApproveRelationshipMessage
  | UnapproveRelationshipMessage
  | ToggleColumnKeyMessage
  | AcceptDiscrepancyMessage
  | RejectDiscrepancyMessage
  | UnrejectDiscrepancyMessage
  | AcceptAllDiscrepanciesMessage
  | AcceptStructuralDiscrepancyMessage
  | RejectStructuralDiscrepancyMessage
  | UnrejectStructuralDiscrepancyMessage
  | UpdateModelAiMessage
  | UpdateModelGrainMessage
  | UpdateModelRoleMessage;

// ---------------------------------------------------------------------------
// Utility types
// ---------------------------------------------------------------------------

/** Type guard helper: extracts message type literals from a message union. */
export type MessageType<T extends { type: string }> = T['type'];

/** Extension message type literals for exhaustive switch checking. */
export type ExtensionMessageType = MessageType<ExtensionMessage>;

/** Webview message type literals for exhaustive switch checking. */
export type WebviewMessageType = MessageType<WebviewMessage>;
