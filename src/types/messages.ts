/**
 * Message protocol types for extension ↔ webview communication.
 *
 * Messages are categorised by direction:
 *   Extension → Webview:  domainLoaded, domainUpdated, manifestRefreshed, error
 *   Webview → Extension:  ready, addModel, addColumn, removeColumn, addRelationship,
 *                         removeModel, removeRelationship, updateViewConfig,
 *                         addExistingModel, updatePositions, runAutoLayout
 *
 * All message types use a discriminated union pattern with a `type` field,
 * enabling exhaustive switch handling in message handlers.
 */

import type { ReconciledDomain } from './reconciled';
import type { Cardinality, ColumnDef, DesignModel, LayoutOptions } from './semantic';

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
 * Sent when the manifest is refreshed and design models may have transitioned.
 * Contains the updated domain and list of newly built model names.
 */
export interface ManifestRefreshedMessage {
  type: 'manifestRefreshed';
  payload: {
    domain: ReconciledDomain;
    newlyBuiltModels: string[];
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
 * The model is added with source: 'repo'.
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

/** Union of all messages the webview can send to the extension. */
export type WebviewMessage =
  | ReadyMessage
  | AddModelMessage
  | AddColumnMessage
  | RemoveColumnMessage
  | UpdateColumnMessage
  | AddRelationshipMessage
  | RemoveModelMessage
  | RemoveRelationshipMessage
  | UpdateViewConfigMessage
  | AddExistingModelMessage
  | UpdatePositionsMessage
  | RunAutoLayoutMessage;

// ---------------------------------------------------------------------------
// Utility types
// ---------------------------------------------------------------------------

/** Type guard helper: extracts message type literals from a message union. */
export type MessageType<T extends { type: string }> = T['type'];

/** Extension message type literals for exhaustive switch checking. */
export type ExtensionMessageType = MessageType<ExtensionMessage>;

/** Webview message type literals for exhaustive switch checking. */
export type WebviewMessageType = MessageType<WebviewMessage>;
