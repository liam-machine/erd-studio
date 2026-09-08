/**
 * Message protocol types for extension ↔ webview communication.
 *
 * Messages are categorised by direction:
 *   Extension → Webview:  domainLoaded, stageData, discrepancyReport, error,
 *                         openFeedback, feedbackContext, feedbackAnalysis,
 *                         feedbackSubmitted
 *   Webview → Extension:  ready, addModel, addColumn, removeColumn, addRelationship,
 *                         removeModel(s), removeRelationship(s), editRelationship,
 *                         addExistingModel, updatePositions, switchStage,
 *                         toggleDiscrepancy, requestFeedbackContext,
 *                         analyzeFeedback, setFeedbackProvider, submitFeedback,
 *                         copyFeedbackReport, openFeedbackLink
 *
 * All message types use a discriminated union pattern with a `type` field,
 * enabling exhaustive switch handling in message handlers.
 *
 * Every message type in the `WebviewMessage` union has a `case` in
 * `SemanticEditorProvider`, and every `ExtensionMessage` type is posted by the
 * host — do not add a type without wiring both ends.
 *
 * The physical stage is read-only: every webview → extension type that does not
 * write a domain file is listed in `NON_MUTATION_TYPES` in
 * `SemanticEditorProvider`. The six feedback types above all belong there —
 * filing feedback is never a domain mutation, and choosing which model triages
 * it writes a user setting, not a domain file.
 */

import type { DisplayDomain } from './display';
import type { DiscrepancyReport } from './discrepancy';
import type { AnnotationColor, Rationale, Cardinality, ColumnDef, DesignModel, ModelRole, Stage } from './semantic';
import type { GroundTruth } from './syncPlan';
import type {
  FeedbackAiProviderChoice,
  FeedbackAnalysis,
  FeedbackCapabilities,
  FeedbackDiagnosticsView,
  FeedbackKind,
} from './feedback';

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
 * Ask the webview to open the Feedback dialog (command palette / sidebar /
 * error notification while a canvas is active). Optional prefill seeds the
 * kind and the two text fields.
 */
export interface OpenFeedbackMessage {
  type: 'openFeedback';
  payload?: {
    kind?: FeedbackKind;
    title?: string;
    description?: string;
  };
}

/**
 * Push the diagnostics view and capability snapshot into the open dialog.
 * Sent in reply to `requestFeedbackContext`, and again after a sign-in.
 */
export interface FeedbackContextMessage {
  type: 'feedbackContext';
  payload: {
    diagnostics: FeedbackDiagnosticsView;
    capabilities: FeedbackCapabilities;
  };
}

/**
 * Result of one AI analysis. `requestId` echoes `analyzeFeedback` so the
 * dialog can drop stale replies. `analysis` is null when the call failed or
 * no tier is configured; `error` is a short human sentence when it failed.
 */
export interface FeedbackAnalysisMessage {
  type: 'feedbackAnalysis';
  payload: {
    requestId: number;
    analysis: FeedbackAnalysis | null;
    error?: string;
  };
}

/**
 * Outcome of `submitFeedback`. The dialog stays open and re-enables its
 * primary button when `ok` is false — including when the host rejected the
 * payload, which is reported here rather than as a bare `error` message.
 */
export interface FeedbackSubmittedMessage {
  type: 'feedbackSubmitted';
  payload: {
    ok: boolean;
    /** Issue number when the flow commented on an existing thread. */
    commentedOn?: number;
    error?: string;
  };
}

/** Union of all messages the extension can send to the webview. */
export type ExtensionMessage =
  | OpenFeedbackMessage
  | FeedbackContextMessage
  | FeedbackAnalysisMessage
  | FeedbackSubmittedMessage
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
 * Summary of the domain shown on the canvas, carried on the feedback messages
 * so the host can build diagnostics without re-reading the document.
 */
export interface FeedbackDomainSummary {
  stage: string;
  modelCount: number;
  relationshipCount: number;
  schemaVersion?: number;
}

/**
 * Ask the host for the diagnostics view and capability snapshot. Sent by the
 * dialog on open; the host replies with `feedbackContext`.
 */
export interface RequestFeedbackContextMessage {
  type: 'requestFeedbackContext';
  payload: {
    /** Recent errors the webview observed (oldest → newest). */
    webviewErrors?: string[];
    /** Summary of the domain shown on the canvas, for the diagnostics chips. */
    domain?: FeedbackDomainSummary;
  };
}

/**
 * Run one AI analysis. Only the description and the context field are sent —
 * diagnostics never reach the model.
 */
export interface AnalyzeFeedbackMessage {
  type: 'analyzeFeedback';
  payload: {
    /** Monotonic per-panel id; echoed on `feedbackAnalysis`. */
    requestId: number;
    kind: FeedbackKind;
    /**
     * True when `kind` is the user's own choice — a segment they pressed, or a
     * kind the command palette opened the dialog with — rather than the `bug`
     * the dialog merely starts on. The host states the kind to the model only
     * when this is true; stating the default as fact is what used to get "I
     * want a new ability to…" classified as a bug.
     */
    kindChosenByUser?: boolean;
    description: string;
    context?: string;
    /**
     * What asked for this run. `'user'` means the user pressed the panel's
     * "Analyse this for me" button; `'debounce'` (the default when omitted)
     * means they were typing. The host declines a `'debounce'` run on the
     * user's own language model until one `'user'` run has succeeded, because
     * VS Code's access dialog may not be raised out of the blue.
     */
    trigger?: 'debounce' | 'user';
  };
}

/**
 * Pin which model destination does the analysis — or `auto` to restore the
 * default precedence. The host writes `erdStudio.feedback.provider` globally
 * and replies with a fresh `feedbackContext`, so the dialog learns the new
 * label, the new availability and whether priming is needed again.
 *
 * On the physical-stage allowlist with the other feedback types: it writes a
 * user setting, never a domain file.
 */
export interface SetFeedbackProviderMessage {
  type: 'setFeedbackProvider';
  payload: {
    provider: FeedbackAiProviderChoice;
    /**
     * The same context `requestFeedbackContext` carries, because the reply is a
     * full `feedbackContext` — rebuilding it needs the diagnostics inputs, and
     * the host does not keep the dialog's copy of them.
     */
    webviewErrors?: string[];
    domain?: FeedbackDomainSummary;
  };
}

/**
 * Submit the report. The host opens the prefilled GitHub issue form (or the
 * existing thread, when `commentOnIssue` is set) and replies with
 * `feedbackSubmitted`. No image travels with it — the dialog attaches none.
 */
export interface SubmitFeedbackMessage {
  type: 'submitFeedback';
  payload: {
    kind: FeedbackKind;
    title: string;
    description: string;
    /** Steps to reproduce (bug) or rationale (feature). */
    steps?: string;
    includeDiagnostics: boolean;
    /** Recent errors the webview observed (oldest → newest). */
    webviewErrors?: string[];
    regressionOf?: number;
    commentOnIssue?: number;
    /** Summary of the domain shown on the canvas, for diagnostics. */
    domain?: FeedbackDomainSummary;
  };
}

/**
 * Copy the whole report to the clipboard as Markdown. Written by the host with
 * `vscode.env.clipboard.writeText` so it works without a secure-context
 * clipboard permission in the webview.
 */
export interface CopyFeedbackReportMessage {
  type: 'copyFeedbackReport';
  payload: {
    kind: FeedbackKind;
    title: string;
    description: string;
    steps?: string;
    includeDiagnostics: boolean;
    webviewErrors?: string[];
    domain?: FeedbackDomainSummary;
  };
}

/**
 * Open something outside the canvas on the user's behalf: a GitHub issue, or the
 * Extensions view so they can update. Never files anything.
 *
 * With `comment: true` the host puts the description on the clipboard first and
 * opens the issue's new-comment anchor, so the user pastes into an existing
 * thread instead of filing a second one.
 */
export interface OpenFeedbackLinkMessage {
  type: 'openFeedbackLink';
  payload:
    | { target: 'issue'; issue: number; comment?: boolean }
    | { target: 'extension' };
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
  | RequestFeedbackContextMessage
  | AnalyzeFeedbackMessage
  | SetFeedbackProviderMessage
  | SubmitFeedbackMessage
  | CopyFeedbackReportMessage
  | OpenFeedbackLinkMessage
  | RequestReloadMessage
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
