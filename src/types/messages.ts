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
import type { AnnotationColor, Rationale, Cardinality, ColumnDef, DesignModel, LayoutOptions, ModelRole, Stage } from './semantic';
import type { GroundTruth } from './syncPlan';

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

/**
 * Sent alongside a discrepancy report to indicate whether the manifest is stale.
 */
export interface ManifestStalenessMessage {
  type: 'manifestStaleness';
  payload: {
    isStale: boolean;
    /** Epoch ms of manifest.json mtime, or null if missing. */
    manifestMtime: number | null;
    /** Epoch ms of newest source file mtime, or null if no sources found. */
    newestSourceMtime: number | null;
  };
}

/**
 * Sent after the extension writes a .sync-plan.json file.
 */
export interface SyncPlanGeneratedMessage {
  type: 'syncPlanGenerated';
  payload: {
    filePath: string;
    totalActions: number;
  };
}

/** Union of all messages the extension can send to the webview. */
export type ExtensionMessage =
  | DomainLoadedMessage
  | DomainUpdatedMessage
  | StageDataMessage
  | DiscrepancyReportMessage
  | ManifestStalenessMessage
  | SyncPlanGeneratedMessage
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
 * Toggle whether a model's physical-only columns are suppressed during
 * discrepancy comparison (stub column mode). Stored in the domain JSON.
 */
export interface ToggleStubColumnsMessage {
  type: 'toggleStubColumns';
  payload: {
    modelName: string;
    /** True = suppress physical-only columns for this model; false = remove from stub list. */
    stub: boolean;
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
 * Request to open the underlying JSON file in VS Code's default text editor.
 */
export interface ViewFileMessage {
  type: 'viewFile';
}

// ---------------------------------------------------------------------------
// Webview → Extension: Sync reconciliation messages
// ---------------------------------------------------------------------------

/**
 * Request the extension to check if the manifest is stale
 * (source files modified after last compile).
 */
export interface CheckManifestStalenessMessage {
  type: 'checkManifestStaleness';
}

/**
 * Request the extension to generate a .sync-plan.json file
 * from the user's ground truth selections.
 */
export interface GenerateSyncPlanMessage {
  type: 'generateSyncPlan';
  payload: {
    /** Map of selection key → ground truth choice. */
    selections: Record<string, GroundTruth>;
  };
}

/**
 * Request the extension to run `dbt compile` in a VS Code terminal.
 */
export interface RunDbtCompileMessage {
  type: 'runDbtCompile';
}

/**
 * Request the extension to launch Claude Code in a terminal to execute the sync plan.
 */
export interface LaunchClaudeSyncMessage {
  type: 'launchClaudeSync';
}

// ---------------------------------------------------------------------------
// Webview → Extension: Annotation messages (build notes)
// ---------------------------------------------------------------------------

/**
 * Request to add a new canvas annotation (post-it note).
 */
export interface AddAnnotationMessage {
  type: 'addAnnotation';
  payload: {
    id: string;
    text: string;
    x: number;
    y: number;
    color?: AnnotationColor;
    width?: number;
    height?: number;
    linkedModel?: string;
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
 * Request to update an annotation's position (sent on drag end).
 * Separate from updateAnnotation for high-frequency drag performance.
 */
export interface UpdateAnnotationPositionMessage {
  type: 'updateAnnotationPosition';
  payload: {
    id: string;
    x: number;
    y: number;
  };
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
  | UpdateModelDescriptionMessage
  | UpdateModelGrainMessage
  | UpdateModelRoleMessage
  | ToggleStubColumnsMessage
  | SwitchStageMessage
  | ToggleDiscrepancyMessage
  | ReorderColumnsMessage
  | ViewFileMessage
  | CheckManifestStalenessMessage
  | GenerateSyncPlanMessage
  | RunDbtCompileMessage
  | LaunchClaudeSyncMessage
  | AddAnnotationMessage
  | UpdateAnnotationMessage
  | RemoveAnnotationMessage
  | UpdateAnnotationPositionMessage;

// ---------------------------------------------------------------------------
// Utility types
// ---------------------------------------------------------------------------

/** Type guard helper: extracts message type literals from a message union. */
export type MessageType<T extends { type: string }> = T['type'];

/** Extension message type literals for exhaustive switch checking. */
export type ExtensionMessageType = MessageType<ExtensionMessage>;

/** Webview message type literals for exhaustive switch checking. */
export type WebviewMessageType = MessageType<WebviewMessage>;
