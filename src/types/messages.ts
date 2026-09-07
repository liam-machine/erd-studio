/**
 * Message protocol types for extension ↔ webview communication.
 *
 * Messages are categorised by direction:
 *   Extension → Webview:  domainLoaded, stageData, discrepancyReport, error
 *   Webview → Extension:  ready, addModel, addColumn, removeColumn, addRelationship,
 *                         removeModel(s), removeRelationship(s), editRelationship,
 *                         addExistingModel, updatePositions, switchStage,
 *                         toggleDiscrepancy
 *
 * All message types use a discriminated union pattern with a `type` field,
 * enabling exhaustive switch handling in message handlers.
 *
 * Every message type in the `WebviewMessage` union has a `case` in
 * `SemanticEditorProvider`, and every `ExtensionMessage` type is posted by the
 * host — do not add a type without wiring both ends.
 */

import type { DisplayDomain } from './display';
import type { DiscrepancyReport } from './discrepancy';
import type { AnnotationColor, Rationale, Cardinality, ColumnDef, DesignModel, ModelRole, Stage } from './semantic';
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
 *
 * `requestId` echoes the token from the originating `switchStage` message so
 * the webview can discard a stale reply (a slow load for a stage the user has
 * since switched away from). Host-initiated switches carry no token.
 */
export interface StageDataMessage {
  type: 'stageData';
  payload: DisplayDomain;
  requestId?: number;
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

/**
 * Ask the webview to open the "Report a Bug" dialog (triggered from the
 * command palette / sidebar while a canvas is active). Optional prefill lets
 * error notifications seed the description.
 */
export interface OpenBugReportMessage {
  type: 'openBugReport';
  payload?: {
    title?: string;
    description?: string;
  };
}

/** Union of all messages the extension can send to the webview. */
export type ExtensionMessage =
  | OpenBugReportMessage
  | DomainLoadedMessage
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
 * Request to remove multiple models from the domain in a single edit.
 * Cascades all relationships referencing any of the listed models and
 * cleans up their viewConfig positions. One WorkspaceEdit, one undo step.
 */
export interface RemoveModelsMessage {
  type: 'removeModels';
  payload: {
    modelNames: string[];
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
 * Request to remove several FK relationships in a single edit (multi-select
 * delete). Keys that no longer exist are skipped; an error is reported only
 * when none of them matched. One WorkspaceEdit, one undo step.
 */
export interface RemoveRelationshipsMessage {
  type: 'removeRelationships';
  payload: {
    relationships: RelationshipKey[];
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
 *
 * `annotations` carries the final positions of any annotation nodes moved in
 * the same drag so a multi-drag of models and notes is one WorkspaceEdit and
 * one undo step. Unknown annotation ids are ignored.
 */
export interface UpdatePositionsMessage {
  type: 'updatePositions';
  payload: {
    positions: Record<string, { x: number; y: number }>;
    annotations?: Array<{ id: string; x: number; y: number }>;
  };
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
 * Request to switch the active stage in the editor.
 * The extension resolves the sibling domain data and sends a stageData response.
 *
 * `requestId` is a monotonically increasing token (see webview/lib/stageRequest.ts);
 * the host echoes it on the `stageData` reply so out-of-order replies can be ignored.
 */
export interface SwitchStageMessage {
  type: 'switchStage';
  payload: { stage: Stage; requestId?: number };
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

/**
 * Submit a bug report. The extension opens a prefilled GitHub issue form in
 * the browser; nothing is sent from the extension itself. The optional
 * screenshot is a PNG data URL captured from the canvas by the webview.
 */
export interface ReportBugMessage {
  type: 'reportBug';
  payload: {
    title: string;
    description: string;
    steps?: string;
    includeDiagnostics: boolean;
    screenshotDataUrl?: string;
    /** True when the webview successfully wrote the PNG to the clipboard. */
    screenshotOnClipboard?: boolean;
    /** Recent errors the webview observed (oldest → newest). */
    webviewErrors?: string[];
    /** Summary of the domain shown on the canvas, for diagnostics. */
    domain?: {
      name: string;
      layer: string;
      stage: string;
      modelCount: number;
      relationshipCount: number;
      schemaVersion?: number;
    };
  };
}

/**
 * Request the extension to save all dirty editors and reload the window.
 * Sent by the webview when it detects it has become orphaned (e.g. after an
 * extension update tore down the previous extension host instance and the new
 * one has no message handler bound for this panel).
 */
export interface RequestReloadMessage {
  type: 'requestReload';
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
 * Request to remove several canvas annotations in a single edit (multi-select
 * delete). Unknown ids are ignored. One WorkspaceEdit, one undo step.
 */
export interface RemoveAnnotationsMessage {
  type: 'removeAnnotations';
  payload: {
    ids: string[];
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
  | RemoveModelsMessage
  | RemoveRelationshipMessage
  | RemoveRelationshipsMessage
  | UpdateRelationshipMessage
  | EditRelationshipMessage
  | AddExistingModelMessage
  | UpdatePositionsMessage
  | RefreshManifestMessage
  | UndoMessage
  | RedoMessage
  | ToggleColumnKeyMessage
  | UpdateModelRationaleMessage
  | UpdateModelDescriptionMessage
  | UpdateModelGrainMessage
  | UpdateModelRoleMessage
  | SwitchStageMessage
  | ToggleDiscrepancyMessage
  | ReorderColumnsMessage
  | ViewFileMessage
  | ReportBugMessage
  | RequestReloadMessage
  | CheckManifestStalenessMessage
  | GenerateSyncPlanMessage
  | RunDbtCompileMessage
  | LaunchClaudeSyncMessage
  | AddAnnotationMessage
  | UpdateAnnotationMessage
  | RemoveAnnotationMessage
  | RemoveAnnotationsMessage;

// ---------------------------------------------------------------------------
// Utility types
// ---------------------------------------------------------------------------

/** Type guard helper: extracts message type literals from a message union. */
export type MessageType<T extends { type: string }> = T['type'];

/** Extension message type literals for exhaustive switch checking. */
export type ExtensionMessageType = MessageType<ExtensionMessage>;

/** Webview message type literals for exhaustive switch checking. */
export type WebviewMessageType = MessageType<WebviewMessage>;
