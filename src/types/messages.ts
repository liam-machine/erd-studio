/**
 * Message protocol types for extension ↔ webview communication.
 *
 * Messages are categorised by direction:
 *   Extension → Webview:  loading, domainLoaded, stageData, existingTables, newRelationshipFiles,
 *                         dbmlEmbeddedTables, discrepancyReport,
 *                         manifestStaleness, syncPlanGenerated, error,
 *                         openFeedback, feedbackContext, feedbackAnalysis,
 *                         feedbackSubmitted, revealRelationship, canvasContext,
 *                         revealTable, libraryDragStarted, filesNotShown
 *   Webview → Extension:  ready, requestExistingTables, requestNewRelationshipFiles, addModel, addColumn, removeColumn, addRelationship,
 *                         removeModel(s), removeRelationship(s), editRelationship,
 *                         addExistingModel(s), dropTables, updatePositions, switchStage,
 *                         toggleDiscrepancy, requestFeedbackContext,
 *                         analyzeFeedback, setFeedbackProvider, submitFeedback,
 *                         copyFeedbackReport, openFeedbackLink,
 *                         layoutFinished, webviewError (usage telemetry only),
 *                         crashFallback (the crash screen's two buttons),
 *                         openNotedFile, addRelationshipsImports, reloadFromDisk
 *                         (the "not shown" strip's file links and buttons)
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

import type { DisplaySubjectArea } from './display';
import type { DiscrepancyReport } from './discrepancy';
import type { AnnotationColor, Cardinality, DesignTable, Stage } from './semantic';
import type { ColumnPair } from '@erd-studio/core';
import type { GroundTruth } from './syncPlan';
import type { CanvasGuideStart, GuideActionPayload } from './onboardingGuide';
import type { CrashFallbackPayload, LayoutFailure, WebviewErrorPayload } from './webviewError';
import type { CanvasLineStyle } from './lineStyle';
import type { FilesNotShownPayload } from './filesNotShown';
import type {
  FeedbackAiProviderChoice,
  FeedbackAnalysis,
  FeedbackCapabilities,
  FeedbackDiagnosticsView,
  FeedbackKind,
} from './feedback';
import type {
  AddColumnMessage,
  RemoveColumnMessage,
  UpdateColumnMessage,
  RenameModelMessage,
  RemoveModelMessage,
  RelationshipKey,
  RemoveRelationshipMessage,
  UpdateRelationshipMessage,
  ToggleColumnKeyMessage,
  UpdateModelRationaleMessage,
  UpdateModelDescriptionMessage,
  UpdateModelGrainMessage,
  UpdateModelAliasMessage,
  UpdateMetaMessage,
  UpdateModelRoleMessage,
  ReorderColumnsMessage,
  UpdateAnnotationMessage,
  RemoveAnnotationMessage,
  OpenModelFileMessage,
  OpenFieldsFileMessage,
  AddExistingModelMessage,
  AddExistingModelsMessage,
  CanvasContext,
} from '@erd-studio/core';

// The edit messages the shared canvas components post live in
// `@erd-studio/core` (packages/core/src/types/canvasMessages.ts). They are
// re-exported here and stay members of `WebviewMessage` below.
export type {
  AddColumnMessage,
  RemoveColumnMessage,
  UpdateColumnPayloadColumn,
  UpdateColumnMessage,
  RenameModelMessage,
  RemoveModelMessage,
  RelationshipKey,
  RemoveRelationshipMessage,
  UpdateRelationshipMessage,
  ColumnKeyType,
  ToggleColumnKeyMessage,
  UpdateModelRationaleMessage,
  UpdateModelDescriptionMessage,
  UpdateModelGrainMessage,
  UpdateModelAliasMessage,
  UpdateMetaMessage,
  UpdateModelRoleMessage,
  ReorderColumnsMessage,
  UpdateAnnotationMessage,
  RemoveAnnotationMessage,
  OpenModelFileMessage,
  OpenFieldsFileMessage,
  AddExistingModelMessage,
  AddExistingModelsMessage,
  CanvasEditMessage,
  CanvasContext,
  OffDiagramRelationship,
} from '@erd-studio/core';

// ---------------------------------------------------------------------------
// Extension → Webview messages
// ---------------------------------------------------------------------------

/**
 * Sent when the domain is initially loaded or refreshed.
 * Contains the display-ready domain for rendering.
 */
/**
 * The host's first answer to `ready`, posted before it reads anything: the
 * canvas is connected and its diagram is being read. The webview stops its
 * "Canvas disconnected" timer and shows "Loading N tables…" until
 * `domainLoaded` or `error` arrives. Posted again with `tables` once the
 * diagram's own file has been counted (no table is read for that).
 */
export interface LoadingMessage {
  type: 'loading';
  payload: {
    /** How many tables the diagram shows, when known. */
    tables?: number;
  };
}

/**
 * The full Add Existing Table list, the answer to
 * {@link RequestExistingTablesMessage}: the same `existingModels` and
 * `manifestModels` a `domainLoaded` payload carries, with every Table
 * Library row read (no `detailsPending`).
 */
export interface ExistingTablesMessage {
  type: 'existingTables';
  payload: {
    existingModels: import('./display').ExistingTablePreview[];
    manifestModels: import('./display').ManifestModelPreview[];
  };
}

/**
 * The answer to {@link RequestNewRelationshipFilesMessage}: the relationships
 * file a new relationship of each of the diagram's DBML tables goes to when
 * that table holds the foreign key (`placeNewRef`), keyed by the table's
 * lower-case name, project-relative. Empty for a YAML project.
 */
export interface NewRelationshipFilesMessage {
  type: 'newRelationshipFiles';
  payload: {
    files: Record<string, string>;
    /**
     * Optional (2.0): for each of those tables (the same lower-case keys),
     * the relationships files a new relationship of it may be saved in, the
     * New Relationship dialog's "Stored in" choice: `placeNewRef`'s answer
     * first (the one in `files`, which may not exist yet), then every other
     * readable relationships file of the table's layer, in path byte order.
     * Absent when no table has a choice to offer (a YAML project); an older
     * webview ignores it.
     */
    choices?: Record<string, NewRelationshipFileChoice[]>;
  };
}

/** One relationships file a new relationship may be saved in ({@link NewRelationshipFilesMessage}). */
export interface NewRelationshipFileChoice {
  /** Relative to the semantic dir (`marts/relationships/marketing.dbml`): what `addRelationship`'s `relationshipsFile` sends. */
  path: string;
  /** Project-relative (`.erd-studio/marts/relationships/marketing.dbml`): what the dialog shows. */
  projectPath: string;
}

export interface DomainLoadedMessage {
  type: 'domainLoaded';
  payload: DisplaySubjectArea;
  /**
   * Set on a logical-stage load when the domain has at least one model and
   * NONE of them has a stored `viewConfig.positions` entry — typically a
   * domain an AI assistant has just written with `viewConfig: {}`. The
   * payload still carries fallback positions (so nothing paints at 0,0), but
   * the host has not persisted them: the webview runs the ELK auto layout
   * once and persists that through `updatePositions` instead. Absent means
   * "do nothing" — partially positioned domains keep the host's placement.
   */
  autoLayout?: boolean;
  /**
   * Logical stage only (#113): the dbt project has no `manifest.json` yet and
   * this workspace has not dismissed the hint. The webview shows the "Run dbt
   * parse" strip while a logical payload carries it; a payload without it
   * (the manifest watcher's refresh once dbt has run) hides it. Never set on a
   * physical payload — the physical stage has its own notice.
   */
  manifestMissing?: boolean;
  /** The open project has no dbt_project.yml: the webview hides the Physical tab, Diff and refresh (absent = Physical available). */
  logicalOnly?: true;
}

/**
 * Sent when an error occurs during domain parsing or mutation.
 */
export interface ErrorMessage {
  type: 'error';
  payload: {
    message: string;
    /**
     * What kind of failure this is, for the initial-load error screen. Absent
     * means an ordinary error — the screen offers Retry and nothing more.
     *
     * - `domain-file` — the domain file could not be read or parsed. Retrying
     *   is worth offering (the file may have been mid-write), and so is
     *   opening it, since the user is the one who can fix the JSON.
     * - `not-a-domain` — this JSON lives under the semantic dir but is not a
     *   domain file (a template, a reserved directory). Retrying can never
     *   help; opening it as text is the only sensible action.
     * - `domain-missing` — the domain file no longer exists: it was deleted or
     *   renamed outside ERD Studio (#161) while the canvas was open, or before
     *   VS Code restored the tab. Sent on load and as soon as the delete is
     *   seen, so it replaces a loaded canvas too. Retry and Open as Text cannot
     *   help; the screen offers Close and Open Another Diagram instead.
     * - `invalid` (#261) — the file parses, but ERD Studio can't accept it
     *   (a `SubjectAreaValidationError`: an unknown layer, a missing
     *   `schemaVersion`, a legacy format, a newer schema). The file is the
     *   user's to fix, so the screen says so and offers Open as Text and
     *   Retry, never Report a Bug. `message` is the reason, project-relative.
     * - `internal` (#261) — anything else: a problem in ERD Studio, not in the
     *   user's files. The screen says so and offers Retry and Send Feedback;
     *   `message` is the exception with every local path redacted, shown only
     *   as a dimmed detail line and in the feedback prefill.
     */
    kind?: 'domain-file' | 'not-a-domain' | 'domain-missing' | 'invalid' | 'internal';
    /**
     * With `kind: 'invalid'` (#261): the diagram was saved by a newer ERD
     * Studio. Editing the file is not the fix, so the screen offers Update
     * ERD Studio instead of Open as Text.
     */
    newerSchema?: true;
    /**
     * With `kind: 'domain-file'`: the file holds unresolved git merge
     * conflicts (#145). Retrying cannot help — the screen drops Retry and
     * offers to open the file as text, where VS Code shows the conflict. The
     * canvas loads by itself once the file is resolved and saved.
     */
    mergeConflict?: true;
    /**
     * With `kind: 'domain-file'` (#186): the file is the user's to fix, and
     * `message` already says so in plain words with a project-relative path.
     * `empty` — it has no content after the re-reads; `syntax` — it is not
     * valid JSON. Never set with `mergeConflict`, nor for an unreadable file.
     */
    fileProblem?: 'empty' | 'syntax';
    /** With `fileProblem: 'syntax'`: the 1-based line and column of the mistake, when it was located. */
    line?: number;
    column?: number;
    /** With `fileProblem: 'syntax'`: the diagram file's format, from its extension ("isn't valid JSON" / "isn't valid DBML"). Absent means JSON. */
    fileType?: 'JSON' | 'DBML';
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
  payload: DisplaySubjectArea;
  requestId?: number;
  /** Same contract as `DomainLoadedMessage.manifestMissing`. */
  manifestMissing?: boolean;
  /** Same contract as `DomainLoadedMessage.logicalOnly`. */
  logicalOnly?: true;
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
/**
 * Sent after a DBML diagram loads that declares Tables of its own and has no
 * table `use` line (§2.5): most likely a single-file DBML dropped into a
 * layer folder (a dbdiagram.io download or a rich export). The canvas shows
 * "This file holds its own tables. Import these tables…", whose button posts
 * {@link ImportEmbeddedTablesMessage}. No payload.
 */
export interface DbmlEmbeddedTablesMessage {
  type: 'dbmlEmbeddedTables';
}

/**
 * Select and centre one relationship line, as clicking it does (the sidebar's
 * Relationships view → Open in Diagram). Sent once the canvas has loaded its
 * diagram (`SemanticEditorProvider.revealRelationship` holds it until then).
 * The canvas matches each column pair by core's `linkKey`, so the order of the
 * two tables and the spelling's case do not matter; with no such line on the
 * diagram it says so in a toast.
 */
export interface RevealRelationshipMessage {
  type: 'revealRelationship';
  payload: {
    fromModel: string;
    toModel: string;
    /** Every column pair of the line (more than one for a composite key). */
    pairs: Array<{ fromColumn: string; toColumn: string }>;
  };
}

/**
 * What the host knows beyond the diagram (`CanvasContext`): each table's
 * file, its relationships to tables not on the diagram, and who reviews it.
 * Posted after each logical-stage `domainLoaded` / `stageData` (so after
 * every refresh of the diagram or the library), never on the physical stage.
 * Kept out of `DisplaySubjectArea`, so the goldens and the viewer contract
 * are unchanged; a canvas that never gets one shows none of what it feeds.
 */
export interface CanvasContextMessage {
  type: 'canvasContext';
  payload: CanvasContext;
}

/**
 * What the user's files hold that this canvas is not drawing (the "not
 * shown" strip above the diagram; `src/types/filesNotShown.ts`): a
 * relationships file the diagram does not import, a `Ref` written in a table
 * file, a relationships file that does not read, a `.dbml` saved where no
 * file is read, a diagram file that stopped reading over a live canvas, a
 * redraw that failed. Posted after each logical-stage `domainLoaded` /
 * `stageData`, and again whenever one of them starts or stops being true;
 * an empty list clears the strip. Like {@link CanvasContextMessage} it is
 * kept out of `DisplaySubjectArea`, so the viewer contract is unchanged.
 */
export interface FilesNotShownMessage {
  type: 'filesNotShown';
  payload: FilesNotShownPayload;
}

/**
 * Select and centre one table, with its detail panel open, as clicking it
 * does (Open in Diagram and Go to Table on a table, Add to Diagram…). Sent
 * once the canvas has loaded its diagram (`SemanticEditorProvider.revealTable`
 * holds it until then). The name is matched ignoring case; a table the
 * diagram does not show is named in a toast.
 */
export interface RevealTableMessage {
  type: 'revealTable';
  payload: {
    modelName: string;
  };
}

/**
 * A drag has started in the sidebar's Table Library (its drag controller's
 * `handleDrag`, `src/providers/tableLibraryDrag.ts`): posted to every open,
 * loaded canvas on the logical stage, which shows "Hold Shift and drop to add
 * … to this diagram" over an editable diagram. VS Code lets a drag that
 * started in the workbench reach a webview only while Shift is held. The
 * tables are the drag's, in order, at most {@link ADD_EXISTING_TABLES_LIMIT}.
 */
export interface LibraryDragStartedMessage {
  type: 'libraryDragStarted';
  payload: {
    tables: string[];
  };
}

/**
 * Start the onboarding guide's phase B on this canvas (**Show Me Around**,
 * `src/types/onboardingGuide.ts`): the first diagram opened after the guide's
 * draft part, or the open diagram when the command asks. The webview builds
 * the steps from the diagram it shows; the payload says only how the project
 * stores its files.
 */
export interface GuideStartMessage {
  type: 'guideStart';
  payload: CanvasGuideStart;
}

/**
 * How the canvas draws relationship lines: the `erdStudio.canvas.lineStyle`
 * setting (`src/types/lineStyle.ts`). Posted when the webview says `ready`
 * (before the diagram is read) and to every open canvas whenever the setting
 * changes, so a switch in one editor reaches them all.
 */
export interface LineStyleMessage {
  type: 'lineStyle';
  payload: {
    lineStyle: CanvasLineStyle;
  };
}

export type ExtensionMessage =
  | GuideStartMessage
  | LineStyleMessage
  | LoadingMessage
  | ExistingTablesMessage
  | NewRelationshipFilesMessage
  | DbmlEmbeddedTablesMessage
  | OpenFeedbackMessage
  | FeedbackContextMessage
  | FeedbackAnalysisMessage
  | FeedbackSubmittedMessage
  | DomainLoadedMessage
  | StageDataMessage
  | DiscrepancyReportMessage
  | ManifestStalenessMessage
  | SyncPlanGeneratedMessage
  | RevealRelationshipMessage
  | CanvasContextMessage
  | FilesNotShownMessage
  | RevealTableMessage
  | LibraryDragStartedMessage
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
 * Sent when the Add Existing Table dialog opens while some Table Library rows
 * still have `detailsPending` (a large library opened before its table files
 * were read). The host reads them and answers with
 * {@link ExistingTablesMessage}. No payload; reads only, so it is allowed on
 * the physical stage too.
 */
export interface RequestExistingTablesMessage {
  type: 'requestExistingTables';
}

/**
 * Sent when the New Relationship dialog opens to create one: asks where a
 * new relationship of each table would be stored, answered by
 * {@link NewRelationshipFilesMessage}. No payload; reads only.
 */
export interface RequestNewRelationshipFilesMessage {
  type: 'requestNewRelationshipFiles';
}

/**
 * Request to add a new model to the domain.
 */
export interface AddModelMessage {
  type: 'addModel';
  payload: DesignTable & {
    /**
     * DBML only: the schema folder the New Table dialog's Schema field names
     * (`<layer>/tables/<schemaFolder>/`), checked by `isSchemaFolderName`.
     * Absent (and ignored for a YAML table): the diagram's layer id, as before.
     */
    schemaFolder?: string;
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
    /** Optional label, e.g. `ship date`. Blank or absent means none. */
    role?: string;
    /**
     * Mark these columns of one end's model as its primary key in the same
     * edit (#133 L1) — the New Relationship dialog's "Mark … as primary key".
     * Refused when that model has a key flagged by then.
     */
    markKey?: MarkKeyPayload;
    /**
     * The other column pairs of a composite foreign key (#133 L2), in the
     * dialog's order; `fromColumn` / `toColumn` are its first pair. Absent or
     * [] is a single-column relationship.
     */
    extraPairs?: ColumnPair[];
    /**
     * DBML only, optional (2.0): the relationships file to save the new
     * relationship in, relative to the semantic dir
     * (`marts/relationships/marketing.dbml`), one of the dialog's
     * {@link NewRelationshipFilesMessage} choices. Sent only when the user
     * picked a file other than the default; absent = where `placeNewRef`
     * says, as before. It must be an existing, readable relationships file
     * inside the semantic dir (`validateRelationshipsFileChoice`, then the
     * host's checks), else the add is refused and nothing is written; a
     * YAML/JSON project refuses it. Every column pair goes there, and the
     * table's later relationships follow it (`placeNewRef`'s rule 1).
     * `editRelationship` takes none: an existing relationship stays where it is.
     */
    relationshipsFile?: string;
  };
}

/** A key the New / Edit Relationship dialog asks to mark with the relationship (#133 L1). */
export interface MarkKeyPayload {
  /** One end's model. */
  model: string;
  /** That end's columns. */
  columns: string[];
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
    /** The label after the edit; '' or absent clears it. */
    role?: string;
    /** As on `addRelationship`. */
    markKey?: MarkKeyPayload;
    /**
     * As on `addRelationship`: the pairs after the edit. The original ends
     * may name any member of a composite; the host edits the whole group.
     */
    extraPairs?: ColumnPair[];
  };
}

// `AddExistingModelMessage` and `AddExistingModelsMessage` live in
// `@erd-studio/core` (the detail panel posts them too) and are re-exported above.

/** Most models one `addExistingModels` request may add (the dialog's "Select all" stops here). */
export const ADD_EXISTING_TABLES_LIMIT = 200;

/** Most URIs one {@link DropTablesMessage} carries (the webview keeps the first ones). */
export const DROP_TABLES_URI_LIMIT = ADD_EXISTING_TABLES_LIMIT;

/** The longest URI a {@link DropTablesMessage} carries (the webview leaves longer ones out). */
export const DROP_TABLES_URI_MAX_LENGTH = 4096;

/**
 * Something was dropped on the canvas (a Shift-drag from the Table Library,
 * or a table file from the Explorer): `position` is the drop point in flow
 * coordinates, `uris` whatever URIs the drop's DataTransfer held (possibly
 * none). The host resolves each `file:` URI to a table file, else uses the
 * Table Library drag that started in the last minute, and adds the tables
 * not yet on the diagram through the Add Existing Tables edit with their
 * positions at the drop point: one edit, one undo step. Logical only — it is
 * not on the physical allowlist.
 */
export interface DropTablesMessage {
  type: 'dropTables';
  payload: {
    position: { x: number; y: number };
    /** At most {@link DROP_TABLES_URI_LIMIT}, each at most {@link DROP_TABLES_URI_MAX_LENGTH} characters. */
    uris: string[];
  };
}

/**
 * Add several models from the dbt project to the open domain in one step (the
 * empty canvas's "Add models from dbt"). No payload: the host asks which models
 * with a QuickPick, seeds the new ones from dbt's yml / manifest and writes
 * everything in one edit (one undo step). Logical stage only — it is not on
 * the physical allowlist.
 */
export interface AddModelsFromDbtMessage {
  type: 'addModelsFromDbt';
  payload?: Record<string, never>;
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
 * An auto layout finished (`ok: true`) or failed in the webview, after `ms`
 * milliseconds. `firstOpen` marks the layout the host asked for on a fresh
 * diagram (`domainLoaded.autoLayout`) rather than one the user started.
 * Usage telemetry only: the host buckets the time into a feature key and
 * writes nothing, so it is allowed on the physical stage.
 */
export interface LayoutFinishedMessage {
  type: 'layoutFinished';
  /**
   * `failure` (2.0, optional): why a failed layout failed, classified in the
   * webview (`LAYOUT_FAILURES`). `fallback` (2.0, optional): the layout
   * overflowed the worker's stack and was laid out again with the stack-safe
   * placement. An older webview sends neither.
   */
  payload: { ms: number; ok: boolean; firstOpen?: boolean; failure?: LayoutFailure; fallback?: true };
}

/**
 * The canvas crashed or hit an uncaught error (2.0 B13): its kind and the
 * area it started in, fixed enums only — never the error's text, which stays
 * in the webview (the Send Feedback dialog's recent errors). Usage telemetry
 * only: writes nothing, so it is on the physical allowlist.
 */
export interface WebviewErrorMessage {
  type: 'webviewError';
  payload: WebviewErrorPayload;
}

/**
 * A button on the canvas's crash screen (`CanvasCrashFallback`, shown after a
 * render crash instead of a blank panel): `reload` — the host reloads this
 * panel's page; `feedback` — the host opens Send Feedback without the canvas
 * (its in-page dialog went down with the tree), prefilled with `area` and
 * `detail` (the crash's first line, paths already redacted in the page and
 * again by the host) for the user to read before anything is sent. Telemetry
 * counts the button only (`crashFallbackReload` / `crashFallbackFeedback`).
 * Writes nothing, so it is on the physical allowlist.
 */
export interface CrashFallbackMessage {
  type: 'crashFallback';
  payload: CrashFallbackPayload;
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
 * The user closed the logical stage's "Run dbt parse" hint (#113). No payload.
 * The host persists it in workspaceState so the hint never returns for this
 * project; the webview hides it at once without waiting for a reply. Not on
 * the physical allowlist — the hint only renders on the logical stage.
 */
export interface DismissManifestHintMessage {
  type: 'dismissManifestHint';
}

/**
 * Request to open the underlying JSON file in VS Code's default text editor.
 * With a payload (#186), the cursor is placed at the 1-based line and column
 * of a JSON mistake; without one (the toolbar's View JSON) the file opens as
 * it always did.
 */
export interface ViewFileMessage {
  type: 'viewFile';
  payload?: { line: number; column?: number };
}

/**
 * Summary of the domain shown on the canvas, carried on the feedback messages
 * so the host can build diagnostics without re-reading the document.
 */
export interface FeedbackSubjectAreaSummary {
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
    domain?: FeedbackSubjectAreaSummary;
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
    domain?: FeedbackSubjectAreaSummary;
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
    /** Add the recent ERD Studio log (redacted) to the diagnostics; opt-in, absent = false. */
    includeLog?: boolean;
    /** Recent errors the webview observed (oldest → newest). */
    webviewErrors?: string[];
    regressionOf?: number;
    commentOnIssue?: number;
    /** Summary of the domain shown on the canvas, for diagnostics. */
    domain?: FeedbackSubjectAreaSummary;
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
    /** Add the recent ERD Studio log (redacted) to the diagnostics; opt-in, absent = false. */
    includeLog?: boolean;
    webviewErrors?: string[];
    domain?: FeedbackSubjectAreaSummary;
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

/**
 * Close this canvas tab. Sent by the "deleted or renamed" screen (#161), whose
 * file is gone, so the tab has nothing left to show. No payload; writes
 * nothing, so it is allowed on the physical stage.
 */
export interface CloseEditorMessage {
  type: 'closeEditor';
}

/**
 * Run Import DBML on this canvas's own file (§2.5): the button of the banner
 * {@link DbmlEmbeddedTablesMessage} shows. No payload. Writes only through
 * the Import DBML command, which asks before writing, so it is not on the
 * physical allowlist.
 */
export interface ImportEmbeddedTablesMessage {
  type: 'importEmbeddedTables';
}

/**
 * Open a file a "not shown" note names ({@link FilesNotShownMessage}), as
 * text, at its line. `file` is relative to the workspace folder; the host
 * opens it only when it is inside the project's ERD Studio folder. Writes
 * nothing, so it is allowed on the physical stage.
 */
export interface OpenNotedFileMessage {
  type: 'openNotedFile';
  payload: {
    file: string;
    /** 1-based. */
    line?: number;
  };
}

/**
 * Add to this DBML diagram the `use *` line of every relationships file
 * holding a relationship between two of its tables (the button of a
 * `relationshipsNotImported` note). No payload: the host works out the files
 * by the one import rule (`relationshipsImportsFor`). One edit through the
 * edit pipeline, one undo step; a mutation, so not on the physical allowlist.
 */
export interface AddRelationshipsImportsMessage {
  type: 'addRelationshipsImports';
}

/**
 * Read every file again and redraw (the button of a `refreshFailed` note;
 * the command **ERD Studio: Reload Diagrams from Disk**). No payload. Writes
 * nothing, so it is allowed on the physical stage.
 */
export interface ReloadFromDiskMessage {
  type: 'reloadFromDisk';
}

/**
 * Pick another diagram to open (`erdStudio.openDomain` with no file). Sent by
 * the "deleted or renamed" screen (#161) — the renamed copy is one pick away.
 * No payload; allowed on the physical stage.
 */
export interface OpenAnotherDomainMessage {
  type: 'openAnotherDomain';
}

/**
 * Open the "Welcome to ERD Studio" panel (the getting-started video). Sent by
 * the empty-diagram card's "set it up in the Welcome panel" link; the host runs
 * `erdStudio.showGettingStarted`. No payload; allowed on the physical stage.
 */
export interface OpenGettingStartedMessage {
  type: 'openGettingStarted';
}

/**
 * Open the ERD Studio output channel (`erdStudio.showLogs`). Sent by the
 * canvas's load-error screen and the "Canvas disconnected" overlay's
 * **Show Logs**. No payload; reads nothing and writes nothing, so it is on
 * the physical-stage allowlist.
 */
export interface ShowLogsMessage {
  type: 'showLogs';
}

/**
 * Request to export this diagram as Mermaid or DBML — the canvas toolbar's
 * **Export** button. No payload: the host runs `erdStudio.exportDiagram` with
 * the panel's document, which asks for the format and what to do with the
 * text. It always exports the logical (design) stage and writes no domain
 * data, so it is on the physical-stage allowlist.
 */
export interface ExportDiagramMessage {
  type: 'exportDiagram';
  payload?: Record<string, never>;
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
 * Request the extension to run `dbt parse` in a VS Code terminal — the
 * physical stage's "Run dbt parse" button when there is no manifest.json.
 * Writes no domain data, so it is on the physical-stage allowlist.
 */
export interface RunDbtParseMessage {
  type: 'runDbtParse';
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
 * Request to remove several canvas annotations in a single edit (multi-select
 * delete). Unknown ids are ignored. One WorkspaceEdit, one undo step.
 */
export interface RemoveAnnotationsMessage {
  type: 'removeAnnotations';
  payload: {
    ids: string[];
  };
}

/**
 * The onboarding guide on the canvas: a fixed action id (`GUIDE_ACTIONS`:
 * a step showed, Skip guide, Done, Star on GitHub, Set Up My AI Helper, the
 * sidebar step showed). The host maps each to its fixed effect
 * (`src/providers/guideWiring.ts`): never a command or URL from the page.
 * Writes no project file, so it is on the physical-stage allowlist.
 */
export interface GuideMessage {
  type: 'guide';
  payload: GuideActionPayload;
}

/**
 * The toolbar's Curved / Hops switch: write `erdStudio.canvas.lineStyle` at
 * user (Global) scope. The webview has already switched (optimistically); the
 * host's `lineStyle` broadcast that follows the setting change keeps every
 * open canvas in step. A view preference that writes no project file, so it
 * is on the physical-stage allowlist (`NON_MUTATION_TYPES`).
 */
export interface SetLineStyleMessage {
  type: 'setLineStyle';
  payload: {
    lineStyle: CanvasLineStyle;
  };
}

/** Union of all messages the webview can send to the extension. */
export type WebviewMessage =
  | ReadyMessage
  | SetLineStyleMessage
  | GuideMessage
  | RequestExistingTablesMessage
  | RequestNewRelationshipFilesMessage
  | DismissManifestHintMessage
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
  | AddExistingModelsMessage
  | AddModelsFromDbtMessage
  | DropTablesMessage
  | UpdatePositionsMessage
  | RefreshManifestMessage
  | UndoMessage
  | RedoMessage
  | ToggleColumnKeyMessage
  | UpdateModelRationaleMessage
  | UpdateModelDescriptionMessage
  | UpdateModelGrainMessage
  | UpdateModelAliasMessage
  | UpdateMetaMessage
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
  | CloseEditorMessage
  | ImportEmbeddedTablesMessage
  | OpenAnotherDomainMessage
  | OpenGettingStartedMessage
  | ShowLogsMessage
  | ExportDiagramMessage
  | GenerateSyncPlanMessage
  | RunDbtCompileMessage
  | RunDbtParseMessage
  | LaunchClaudeSyncMessage
  | AddAnnotationMessage
  | UpdateAnnotationMessage
  | RemoveAnnotationMessage
  | RemoveAnnotationsMessage
  | OpenModelFileMessage
  | OpenFieldsFileMessage
  | GoToTableMessage
  | ShowTableOnOtherDiagramsMessage
  | MoveTableMessage
  | CopyTablePathMessage
  | RevealTableInLibraryMessage
  | LayoutFinishedMessage
  | WebviewErrorMessage
  | CrashFallbackMessage
  | OpenNotedFileMessage
  | AddRelationshipsImportsMessage
  | ReloadFromDiskMessage;

// ---------------------------------------------------------------------------
// Finding a table across the project (the canvas's ways out of one diagram)
// ---------------------------------------------------------------------------

/**
 * Run **Go to Table…** with the toolbar search's text filled in: the hint
 * under a search that finds no table on this diagram but some in the project.
 * Writes nothing, so it is on the physical allowlist. `query` is at most
 * {@link GO_TO_TABLE_QUERY_MAX} characters.
 */
export interface GoToTableMessage {
  type: 'goToTable';
  payload: {
    query?: string;
  };
}

/** The longest search text {@link GoToTableMessage} carries. */
export const GO_TO_TABLE_QUERY_MAX = 200;

/**
 * A table's context menu → **Show on Other Diagrams…**: the other diagrams
 * that show it, picked when there are several, opened with it selected.
 * Writes nothing (physical allowlist).
 */
export interface ShowTableOnOtherDiagramsMessage {
  type: 'showTableOnOtherDiagrams';
  payload: {
    modelName: string;
  };
}

/**
 * A table's context menu → **Move Table…**: the sidebar's Move Table on the
 * table's file (a DBML table only). It moves files, so it is logical only:
 * not on the physical allowlist.
 */
export interface MoveTableMessage {
  type: 'moveTable';
  payload: {
    modelName: string;
  };
}

/**
 * A table's context menu → **Copy Path**: the table file's path from the
 * project folder (`.erd-studio/gold/tables/sales/fct_order.dbml`) on the
 * clipboard. Writes nothing (physical allowlist).
 */
export interface CopyTablePathMessage {
  type: 'copyTablePath';
  payload: {
    modelName: string;
  };
}

/**
 * A table's context menu → **Reveal in Table Library**: the table's row
 * selected in the sidebar's Table Library. Writes nothing (physical allowlist).
 */
export interface RevealTableInLibraryMessage {
  type: 'revealTableInLibrary';
  payload: {
    modelName: string;
  };
}

// ---------------------------------------------------------------------------
// Utility types
// ---------------------------------------------------------------------------

/** Type guard helper: extracts message type literals from a message union. */
export type MessageType<T extends { type: string }> = T['type'];

/** Extension message type literals for exhaustive switch checking. */
export type ExtensionMessageType = MessageType<ExtensionMessage>;

/** Webview message type literals for exhaustive switch checking. */
export type WebviewMessageType = MessageType<WebviewMessage>;
