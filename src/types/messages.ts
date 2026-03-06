/**
 * Message protocol types for extension ↔ webview communication.
 *
 * Messages are categorised by direction:
 *   Extension → Webview:  domainLoaded, domainUpdated, stageData, discrepancyReport, error
 *   Webview → Extension:  ready, addModel, addColumn, removeColumn, addRelationship,
 *                         removeModel, removeRelationship, editRelationship, updateViewConfig,
 *                         addExistingModel, updatePositions, runAutoLayout, switchStage,
 *                         toggleDiscrepancy
 *
 * All message types use a discriminated union pattern with a `type` field,
 * enabling exhaustive switch handling in message handlers.
 */

import type { DisplayDomain } from './display';
import type { DiscrepancyReport } from './discrepancy';
import type { Rationale, Cardinality, ColumnDef, DesignModel, LayoutOptions, ModelRole, Stage } from './semantic';

// ---------------------------------------------------------------------------
// Extension → Webview messages
// ---------------------------------------------------------------------------

/**
 * Sent when the domain is initially loaded or refreshed.
 * Contains the display-ready domain for rendering.
 */
export interface DomainLoadedMessage {
  type: 'domainLoaded';
  payload: DisplayDomain;
  /** Whether the user has already dismissed the welcome modal (persisted in globalState). */
  welcomeDismissed?: boolean;
}

/**
 * Sent when the domain is updated due to a mutation (add/remove model, etc.).
 * Contains the updated display domain.
 */
export interface DomainUpdatedMessage {
  type: 'domainUpdated';
  payload: DisplayDomain;
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

/**
 * Sent in response to a switchStage request.
 * Contains the display domain for the requested stage.
 */
export interface StageDataMessage {
  type: 'stageData';
  payload: DisplayDomain;
}

/**
 * Sent in response to a toggleDiscrepancy request.
 * Contains the cross-stage comparison report, or null when cleared.
 */
export interface DiscrepancyReportMessage {
  type: 'discrepancyReport';
  payload: DiscrepancyReport | null;
}

/** Union of all messages the extension can send to the webview. */
export type ExtensionMessage =
  | DomainLoadedMessage
  | DomainUpdatedMessage
  | StageDataMessage
  | DiscrepancyReportMessage
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
 * Request to add a new model to the domain.
 */
export interface AddModelMessage {
  type: 'addModel';
  payload: DesignModel;
}

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
 * Request to update an existing column in a model.
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

/**
 * Request to remove an FK relationship.
 * Identity is the composite key: (fromModel, fromColumn, toModel, toColumn).
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
 * Request to edit a relationship (change any field including the composite key).
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
 */
export interface RunAutoLayoutMessage {
  type: 'runAutoLayout';
}

/**
 * Request to refresh the manifest and update physical views.
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

/**
 * Request to switch the active stage in the editor.
 * The extension resolves the sibling domain data and sends a stageData response.
 */
export interface SwitchStageMessage {
  type: 'switchStage';
  payload: { stage: Stage };
}

/**
 * Request to toggle cross-stage discrepancy comparison.
 * When enabled, the extension runs DiscrepancyService.compare() and sends back
 * a discrepancyReport message. When disabled, sends null to clear the overlay.
 */
export interface ToggleDiscrepancyMessage {
  type: 'toggleDiscrepancy';
  payload: { enabled: boolean; compareAgainst?: Stage };
}

/**
 * Notification that the user dismissed the welcome modal.
 * Extension persists this in globalState so it never shows again.
 */
export interface DismissWelcomeMessage {
  type: 'dismissWelcome';
}

/** Union of all messages the webview can send to the extension. */
export type WebviewMessage =
  | ReadyMessage
  | DismissWelcomeMessage
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
  | ToggleColumnKeyMessage
  | UpdateModelRationaleMessage
  | UpdateModelGrainMessage
  | UpdateModelRoleMessage
  | SwitchStageMessage
  | ToggleDiscrepancyMessage;

// ---------------------------------------------------------------------------
// Utility types
// ---------------------------------------------------------------------------

/** Type guard helper: extracts message type literals from a message union. */
export type MessageType<T extends { type: string }> = T['type'];

/** Extension message type literals for exhaustive switch checking. */
export type ExtensionMessageType = MessageType<ExtensionMessage>;

/** Webview message type literals for exhaustive switch checking. */
export type WebviewMessageType = MessageType<WebviewMessage>;
