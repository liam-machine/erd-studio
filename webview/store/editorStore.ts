/**
 * Zustand store for the webview editor state.
 *
 * Manages UI state that is local to the webview: editor mode, selected node,
 * viewport (zoom/pan), and detail panel visibility. Domain data (models,
 * relationships) lives in the extension host — only UI-relevant slices are
 * stored here.
 *
 * The canvas part of the state (selection, nodes/edges, column expansion,
 * context menus, …) and its actions come from `createCanvasSlice` in
 * `@erd-studio/renderer/store`; this module adds the editor chrome on top and
 * overrides `setDomain` with the full reset. App.tsx hands this singleton to
 * `CanvasStoreProvider`, so the shared canvas components and the code here
 * (which calls `useEditorStore.getState()` directly) see the same store.
 */

import { create } from 'zustand';
import type { Viewport } from '@xyflow/react';
import { createCanvasSlice, type CanvasActions, type CanvasSet, type CanvasState, type CanvasStoreApi } from '@erd-studio/renderer/store';
import type { DisplaySubjectArea, ManifestModelPreview } from '../../src/types/display';
import type { DiscrepancyReport } from '../../src/types/discrepancy';
import type { TableTemplate, Stage } from '../../src/types/semantic';
import type { GroundTruth } from '../../src/types/syncPlan';
import type { ErrorMessage, RevealRelationshipMessage } from '../../src/types/messages';
import type {
  FeedbackAnalysis,
  FeedbackCapabilities,
  FeedbackDiagnosticsView,
  FeedbackKind,
} from '../../src/types/feedback';

export type {
  EdgeContextMenu,
  NodeContextMenu,
  AnnotationContextMenu,
  ContextMenuState,
} from '@erd-studio/renderer/store';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Prefill data for FK dialog when opened via drag-to-connect. */
export interface FkDialogPrefill {
  fromModel: string;
  fromColumn: string;
  toModel: string;
  /** Optional target column — set when user drags to a specific column handle. */
  toColumn?: string;
  /** The cardinality key evidence suggests (#133 L1). */
  cardinality?: 'many-to-one' | 'one-to-one' | 'many-to-many';
  /** Whether key evidence decided which end holds the foreign key; undecided, the dialog asks. */
  direction?: 'decided' | 'undecided';
  /** What decided it: the models' key flags, dbt's tests, or nothing. */
  basis?: 'keys' | 'dbt' | 'none';
}

/** Edit data for FK dialog when editing an existing relationship. */
export interface FkDialogEditData {
  fromModel: string;
  fromColumn: string;
  toModel: string;
  toColumn: string;
  cardinality: import('../../src/types/semantic').Cardinality;
  /** Optional label, e.g. `ship date`. */
  role?: string;
  /** A composite foreign key's column pairs, the first being fromColumn → toColumn (#133 L2). */
  pairs?: import('@erd-studio/core').ColumnPair[];
}

export interface EditorState extends CanvasState {
  /** React Flow viewport (pan + zoom). */
  viewport: Viewport;
  /** Whether the new model dialog is open. */
  newModelDialogOpen: boolean;
  /** Whether the new FK relationship dialog is open. */
  newFkDialogOpen: boolean;
  /** Prefill data for FK dialog when opened via drag-to-connect, or null. */
  fkDialogPrefill: FkDialogPrefill | null;
  /** Edit data for FK dialog when editing an existing relationship, or null. */
  fkDialogEditData: FkDialogEditData | null;
  /** Whether the add existing model dialog is open. */
  addExistingModelDialogOpen: boolean;
  /**
   * What the Add Existing Table dialog's search starts as when it opens: the
   * name the New Table dialog refused because the Table Library has it. Empty
   * for every other opening.
   */
  addExistingModelDialogSearch: string;
  /** Error message from the extension host, if any. */
  error: string | null;
  /**
   * What kind of failure `error` describes, when the host said. Only the
   * initial-load error screen reads it — it decides which recovery actions
   * are worth offering (see App.tsx). Null for an unclassified error.
   */
  errorKind: ErrorMessage['payload']['kind'] | null;
  /** The domain file holds unresolved git merge conflicts (#145); false unless the host said so. */
  errorMergeConflict: boolean;
  /**
   * The domain file is empty or not valid JSON (#186), with where the JSON
   * mistake is when the host located it; null unless the host said so.
   */
  errorFileProblem: { problem: 'empty' | 'syntax'; line?: number; column?: number; fileType?: 'JSON' | 'DBML' } | null;
  /** With `errorKind: 'invalid'` (#261): the diagram was saved by a newer ERD Studio; false unless the host said so. */
  errorNewerSchema: boolean;
  /** Available model templates loaded from semantic/templates/*.json. */
  templates: TableTemplate[];
  /** Manifest models available to add to this domain (not already in domain). @deprecated Use existingModels. */
  manifestModels: ManifestModelPreview[];
  /** Internal: registered search focus function (not persisted). */
  _searchFocusFn: (() => void) | null;
  /** Internal: registered auto-layout function (not persisted). */
  _autoLayoutFn: (() => void) | null;
  /**
   * The host asked for the first-open auto layout (`domainLoaded.autoLayout`):
   * no model in the domain has a stored position yet. The Toolbar's
   * `useFirstOpenAutoLayout` clears it and runs the ELK layout once the model
   * nodes are on the canvas. Every `domainLoaded` / `stageData` overwrites it,
   * so a later payload without the flag cancels a layout that has not started.
   */
  pendingAutoLayout: boolean;
  /** Whether the Feedback dialog is visible. */
  feedbackDialogOpen: boolean;
  /** Prefill for the Feedback dialog (from the command palette / error screens). */
  feedbackPrefill: { kind?: FeedbackKind; title?: string; description?: string } | null;
  /** Diagnostics view pushed by the host, or null before the first `feedbackContext`. */
  feedbackDiagnostics: FeedbackDiagnosticsView | null;
  /** Capability snapshot pushed by the host, or null before the first `feedbackContext`. */
  feedbackCapabilities: FeedbackCapabilities | null;
  /** Latest analysis reply, or null when none has arrived (or none was possible). */
  feedbackAnalysis: FeedbackAnalysis | null;
  /** Analysis lifecycle for the assist panel. */
  feedbackAnalysisState: 'idle' | 'thinking' | 'ready' | 'error';
  /** Error sentence from the last failed analysis or submit, or null. */
  feedbackError: string | null;
  /** Recent errors observed in the webview (oldest → newest, capped at 20). Sent with feedback reports. */
  recentErrors: string[];
  /** Whether the cross-stage discrepancy overlay is visible. */
  discrepancyVisible: boolean;
  /** The stage being compared against when discrepancy is active. */
  discrepancyCompareStage: Stage | null;
  /** The active discrepancy report from the extension, or null. */
  discrepancyReport: DiscrepancyReport | null;
  /** Whether the sync resolution UI is active (ground truth radios visible). */
  syncMode: boolean;
  /** Per-discrepancy ground truth selections (key → 'logical' | 'physical'). */
  syncSelections: Record<string, GroundTruth>;
  /**
   * Table keys whose decision the Sync modal inferred from the table's
   * columns, each with the side it set (lib/syncSelections). Kept here, not
   * in the modal, so closing and reopening Sync does not turn an inferred
   * decision into one the user made. Any user action on a key drops it.
   */
  syncInferredTableKeys: Record<string, GroundTruth>;
  /** Whether the manifest is stale (source files newer than manifest). */
  manifestStale: boolean;
  /** Info about the last generated sync plan, or null. */
  syncPlanGenerated: { filePath: string; totalActions: number } | null;
  /**
   * Canvas interaction mode.
   * - 'pan' (default): drag on empty canvas pans the viewport. Shift+drag still rubber-bands.
   * - 'select': drag on empty canvas draws a rubber-band selection box (no Shift needed) and the cursor is a crosshair.
   */
  canvasMode: 'pan' | 'select';
  /** Transient toast message raised from anywhere in the webview (null = none). */
  toastMessage: string | null;
  /**
   * A relationship the host asked to show (`revealRelationship`, the sidebar's
   * Open in Diagram). `useRevealRelationship` selects and centres its line
   * once the diagram has settled, then clears it. Not persisted.
   */
  pendingReveal: RevealRelationshipMessage['payload'] | null;
  /**
   * A table the host asked to show (`revealTable`: Open in Diagram or Go to
   * Table on a table, Add to Diagram…). `useRevealTable` selects and centres
   * it once the diagram has settled, then clears it. Not persisted.
   */
  pendingTableReveal: string | null;
  /**
   * Whether the "no compiled dbt artifacts" strip has been dismissed.
   *
   * Session state only — deliberately not persisted. If dbt still has not been
   * compiled after a reload, the notice should come back.
   */
  physicalSourceNoticeDismissed: boolean;
  /**
   * The last logical payload carried `manifestMissing` (#113): dbt has not
   * written a manifest.json and the workspace has not dismissed the hint.
   * Follows every `domainLoaded` / `stageData` — deliberately NOT touched by
   * `setDomain`, which also runs locally after a drag.
   */
  manifestMissing: boolean;
  /** The user closed the "Run dbt parse" hint; the host persists it too. */
  manifestHintDismissed: boolean;
  /**
   * The user closed the drag-to-relate tip (DragHint). Persisted per webview
   * by useStatePersistence (vscode.setState); never sent to the host.
   */
  dragHintDismissed: boolean;
  /**
   * The open project has no `dbt_project.yml`, so there is no Physical stage
   * to show (the host's `logicalOnly` envelope flag). The Toolbar hides the
   * stage tabs, Diff (and with it Sync) and the manifest refresh; Alt+2, the
   * first-open "Two Stages" modal and the dbt wording in the empty states go
   * too. Follows every `domainLoaded` / `stageData`, like `manifestMissing`,
   * and is deliberately NOT touched by `setDomain`.
   */
  logicalOnly: boolean;
  /**
   * The host said this DBML diagram declares Tables of its own and has no
   * table `use` line (`dbmlEmbeddedTables`, §2.5): a single-file DBML to
   * import. Cleared by every `domainLoaded`; the host re-sends it after one.
   */
  embeddedTables: boolean;
}

export interface EditorActions extends CanvasActions {
  setViewport: (viewport: Viewport) => void;
  setNewModelDialogOpen: (open: boolean) => void;
  setNewFkDialogOpen: (open: boolean) => void;
  /** Open FK dialog with prefilled source/target from drag-to-connect. */
  openFkDialogWithPrefill: (prefill: FkDialogPrefill) => void;
  /** Clear FK dialog prefill (called on dialog close). */
  clearFkDialogPrefill: () => void;
  /** Open FK dialog for editing an existing relationship. */
  openFkDialogForEdit: (editData: FkDialogEditData) => void;
  /** Clear FK dialog edit data (called on dialog close). */
  clearFkDialogEditData: () => void;
  /** Open/close the add existing model dialog, optionally with its search filled in. */
  setAddExistingModelDialogOpen: (open: boolean, initialSearch?: string) => void;
  /** Hide (or, restoring persisted state, keep hidden) the drag-to-relate tip. */
  setDragHintDismissed: (dismissed: boolean) => void;
  /** Hide the physical-source notice for the rest of this session. */
  dismissPhysicalSourceNotice: () => void;
  /** Store the `manifestMissing` flag of the latest host payload. */
  setManifestMissing: (missing: boolean) => void;
  /** Show (or clear) the "This file holds its own tables" banner. */
  setEmbeddedTables: (embedded: boolean) => void;
  /** Hide the logical "Run dbt parse" hint at once (the host persists it). */
  dismissManifestHint: () => void;
  /**
   * Store the `logicalOnly` flag of the latest host payload. Turning it on
   * also drops any Diff / discrepancy and sync state (there is nothing to
   * compare against) and closes the "Two Stages" modal without dismissing it.
   */
  setLogicalOnly: (logicalOnly: boolean) => void;
  setError: (
    error: string | null,
    kind?: ErrorMessage['payload']['kind'],
    mergeConflict?: boolean,
    fileProblem?: EditorState['errorFileProblem'],
    newerSchema?: boolean,
  ) => void;
  setTemplates: (templates: TableTemplate[]) => void;
  setManifestModels: (models: ManifestModelPreview[]) => void;
  /** Register a function to focus the search input (called by Toolbar on mount). */
  registerSearchFocus: (focusFn: (() => void) | null) => void;
  /** Focus the search input (called by keyboard handler). */
  focusSearchInput: () => void;
  /** Register a function to trigger auto-layout (called by Toolbar on mount). */
  registerAutoLayout: (layoutFn: (() => void) | null) => void;
  /** Trigger auto-layout (called by keyboard handler). */
  triggerAutoLayout: () => void;
  /** Set / clear the first-open auto layout request (see `pendingAutoLayout`). */
  setPendingAutoLayout: (pending: boolean) => void;
  /** Open/close the Feedback dialog, optionally with prefilled fields. */
  setFeedbackDialogOpen: (
    open: boolean,
    prefill?: { kind?: FeedbackKind; title?: string; description?: string } | null,
  ) => void;
  /** Store the host's diagnostics + capability snapshot. */
  setFeedbackContext: (
    diagnostics: FeedbackDiagnosticsView,
    capabilities: FeedbackCapabilities,
  ) => void;
  /** Store an analysis reply, or the sentence explaining why it failed. */
  setFeedbackAnalysis: (analysis: FeedbackAnalysis | null, error?: string) => void;
  /** Move the analysis panel to 'thinking'. */
  setFeedbackAnalysisPending: () => void;
  /** Append an error to the recent-errors ring buffer. */
  recordError: (source: string, message: string) => void;
  /** Toggle the discrepancy overlay visibility. */
  setDiscrepancyVisible: (visible: boolean) => void;
  /** Set the stage being compared against. */
  setDiscrepancyCompareStage: (stage: Stage | null) => void;
  /** Set the discrepancy report from the extension. */
  setDiscrepancyReport: (report: DiscrepancyReport | null) => void;
  /** Toggle sync resolution mode (shows ground truth radios in discrepancy panel). */
  setSyncMode: (active: boolean) => void;
  /** Set ground truth for a single discrepancy item. */
  setSyncSelection: (key: string, choice: GroundTruth) => void;
  /**
   * Pick a side for one item, or clear the decision when that side is
   * already the chosen one (the Sync modal's click-again-to-undo).
   */
  toggleSyncSelection: (key: string, choice: GroundTruth) => void;
  /** Drop the decision for one item, leaving it undecided. */
  clearSyncSelection: (key: string) => void;
  /** Set ground truth for multiple items at once (bulk). */
  setSyncSelectionBulk: (keys: string[], choice: GroundTruth) => void;
  /** Drop the decisions for several items at once (clicking a table's Keep all again). */
  clearSyncSelectionBulk: (keys: string[]) => void;
  /**
   * The Sync modal's inferred table decision: set the table key to `choice`
   * and record it as inferred, or with null clear both.
   */
  setInferredTableChoice: (key: string, choice: GroundTruth | null) => void;
  /** Restore which table keys were inferred (webview state persistence), after their selections. */
  restoreSyncInferredTableKeys: (inferred: Record<string, GroundTruth>) => void;
  /** Clear all sync selections. */
  clearSyncSelections: () => void;
  /** Set manifest staleness flag. */
  setManifestStale: (stale: boolean) => void;
  /** Set sync plan generation result. */
  setSyncPlanGenerated: (info: { filePath: string; totalActions: number } | null) => void;
  /** Set the canvas interaction mode. */
  setCanvasMode: (mode: 'pan' | 'select') => void;
  /** Show (or clear with null) a transient toast notification. */
  setToastMessage: (message: string | null) => void;
  /** Set / clear the relationship to show (see `pendingReveal`). */
  setPendingReveal: (target: RevealRelationshipMessage['payload'] | null) => void;
  /** Set / clear the table to show (see `pendingTableReveal`). */
  setPendingTableReveal: (modelName: string | null) => void;
}

/**
 * Do two payloads report the same set of dbt artifacts behind the physical
 * stage? Absent on both sides (the logical stage, or an older host) counts as
 * unchanged, so nothing re-shows the notice on a stage the notice never
 * addresses.
 */
function samePhysicalSources(
  a: DisplaySubjectArea['physicalSources'],
  b: DisplaySubjectArea['physicalSources'],
): boolean {
  if (!a || !b) { return !a && !b; }
  return a.yml === b.yml && a.manifest === b.manifest && a.catalog === b.catalog;
}

/** `inferred` without `keys`: the same object when none of them is in it. */
function withoutInferred(inferred: Record<string, GroundTruth>, keys: readonly string[]): Record<string, GroundTruth> {
  if (!keys.some((key) => key in inferred)) return inferred;
  const next = { ...inferred };
  for (const key of keys) delete next[key];
  return next;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useEditorStore = create<EditorState & EditorActions>()((set) => ({
  // Canvas state and actions (@erd-studio/renderer/store). Everything below
  // is the editor's own state; `setDomain` is overridden at the end.
  ...createCanvasSlice(set as unknown as CanvasSet),

  // Default state
  viewport: { x: 0, y: 0, zoom: 1 },
  newModelDialogOpen: false,
  newFkDialogOpen: false,
  fkDialogPrefill: null,
  fkDialogEditData: null,
  addExistingModelDialogOpen: false,
  addExistingModelDialogSearch: '',
  error: null,
  errorKind: null,
  errorMergeConflict: false,
  errorFileProblem: null,
  errorNewerSchema: false,
  templates: [],
  manifestModels: [],
  _searchFocusFn: null,
  _autoLayoutFn: null,
  pendingAutoLayout: false,
  feedbackDialogOpen: false,
  feedbackPrefill: null,
  feedbackDiagnostics: null,
  feedbackCapabilities: null,
  feedbackAnalysis: null,
  feedbackAnalysisState: 'idle',
  feedbackError: null,
  recentErrors: [],
  discrepancyVisible: false,
  discrepancyCompareStage: null,
  discrepancyReport: null,
  syncMode: false,
  syncSelections: {},
  syncInferredTableKeys: {},
  manifestStale: false,
  syncPlanGenerated: null,
  canvasMode: 'pan',
  toastMessage: null,
  pendingReveal: null,
  pendingTableReveal: null,
  physicalSourceNoticeDismissed: false,
  manifestMissing: false,
  manifestHintDismissed: false,
  dragHintDismissed: false,
  logicalOnly: false,
  embeddedTables: false,

  // Actions
  setViewport: (viewport) => set({ viewport }),
  setNewModelDialogOpen: (open) => set({ newModelDialogOpen: open }),
  setNewFkDialogOpen: (open) => set({ newFkDialogOpen: open }),
  openFkDialogWithPrefill: (prefill) =>
    set({ newFkDialogOpen: true, fkDialogPrefill: prefill, fkDialogEditData: null }),
  clearFkDialogPrefill: () => set({ fkDialogPrefill: null }),
  openFkDialogForEdit: (editData) =>
    set({ newFkDialogOpen: true, fkDialogEditData: editData, fkDialogPrefill: null }),
  clearFkDialogEditData: () => set({ fkDialogEditData: null }),
  setAddExistingModelDialogOpen: (open, initialSearch) =>
    set({ addExistingModelDialogOpen: open, addExistingModelDialogSearch: open ? (initialSearch ?? '') : '' }),
  setDragHintDismissed: (dismissed) => set({ dragHintDismissed: dismissed }),
  dismissPhysicalSourceNotice: () => set({ physicalSourceNoticeDismissed: true }),
  setManifestMissing: (missing) => set({ manifestMissing: missing }),
  setEmbeddedTables: (embedded) => set({ embeddedTables: embedded }),
  dismissManifestHint: () => set({ manifestHintDismissed: true }),
  setLogicalOnly: (logicalOnly) => set(
    logicalOnly
      ? {
          logicalOnly: true,
          discrepancyVisible: false, discrepancyCompareStage: null, discrepancyReport: null,
          syncMode: false, syncSelections: {}, syncInferredTableKeys: {}, manifestStale: false, syncPlanGenerated: null,
        }
      : { logicalOnly: false },
  ),
  setError: (error, kind, mergeConflict, fileProblem, newerSchema) => set((state) => {
    // The "deleted or renamed" screen (#161) stands until a fresh domain
    // arrives: a later host error (a refused edit, a failed physical refresh)
    // would otherwise turn it back into a toast over the stale canvas.
    if (state.errorKind === 'domain-missing' && error !== null && kind !== 'domain-missing') return {};
    return {
      error,
      errorKind: error === null ? null : (kind ?? null),
      errorMergeConflict: error !== null && mergeConflict === true,
      errorFileProblem: error === null ? null : (fileProblem ?? null),
      errorNewerSchema: error !== null && newerSchema === true,
    };
  }),
  setTemplates: (templates) => set({ templates }),
  setManifestModels: (models) => set({ manifestModels: models }),
  registerSearchFocus: (focusFn) => set({ _searchFocusFn: focusFn }),
  focusSearchInput: () => {
    const { _searchFocusFn } = useEditorStore.getState();
    if (_searchFocusFn) _searchFocusFn();
  },
  registerAutoLayout: (layoutFn) => set({ _autoLayoutFn: layoutFn }),
  triggerAutoLayout: () => {
    const { _autoLayoutFn } = useEditorStore.getState();
    if (_autoLayoutFn) _autoLayoutFn();
  },
  setPendingAutoLayout: (pending) => set({ pendingAutoLayout: pending }),
  setFeedbackDialogOpen: (open, prefill = null) =>
    set(
      open
        ? { feedbackDialogOpen: true, feedbackPrefill: prefill }
        : {
            // Closing throws the whole conversation away: a reopened dialog
            // re-requests its context and re-runs its own analysis, so a stale
            // verdict or error can never greet the next report.
            feedbackDialogOpen: false,
            feedbackPrefill: null,
            feedbackAnalysis: null,
            feedbackAnalysisState: 'idle' as const,
            feedbackError: null,
          },
    ),
  setFeedbackContext: (diagnostics, capabilities) =>
    set({ feedbackDiagnostics: diagnostics, feedbackCapabilities: capabilities }),
  setFeedbackAnalysis: (analysis, error) =>
    set({
      feedbackAnalysis: analysis,
      // No analysis and no error is the benign "no model configured" reply —
      // the panel goes back to its idle prose rather than showing a failure.
      feedbackAnalysisState: error ? 'error' : analysis ? 'ready' : 'idle',
      feedbackError: error ?? null,
    }),
  setFeedbackAnalysisPending: () => set({ feedbackAnalysisState: 'thinking', feedbackError: null }),
  recordError: (source, message) =>
    set((state) => ({
      recentErrors: [...state.recentErrors, `${new Date().toISOString()} [${source}] ${message}`].slice(-20),
    })),
  setDiscrepancyVisible: (visible) => set({
    discrepancyVisible: visible,
    // Clear sync state when discrepancy overlay is hidden
    ...(!visible ? { syncMode: false, syncSelections: {}, syncInferredTableKeys: {}, manifestStale: false, syncPlanGenerated: null } : {}),
  }),
  setDiscrepancyCompareStage: (stage) => set({ discrepancyCompareStage: stage }),
  setDiscrepancyReport: (report) => set({ discrepancyReport: report }),
  setSyncMode: (active) => set({ syncMode: active, syncPlanGenerated: null }),
  // Every change to the decisions discards a prepared plan: it was built
  // from the old ones, so "N actions ready" would no longer be true.
  // A user action on a key also makes its decision the user's own
  // (`withoutInferred`); only setInferredTableChoice records an inferred one.
  setSyncSelection: (key, choice) =>
    set((state) => ({
      syncSelections: { ...state.syncSelections, [key]: choice },
      syncInferredTableKeys: withoutInferred(state.syncInferredTableKeys, [key]),
      syncPlanGenerated: null,
    })),
  toggleSyncSelection: (key, choice) =>
    set((state) => {
      const next = { ...state.syncSelections };
      if (next[key] === choice) delete next[key];
      else next[key] = choice;
      return { syncSelections: next, syncInferredTableKeys: withoutInferred(state.syncInferredTableKeys, [key]), syncPlanGenerated: null };
    }),
  clearSyncSelection: (key) =>
    set((state) => {
      if (!(key in state.syncSelections)) return {};
      const next = { ...state.syncSelections };
      delete next[key];
      return { syncSelections: next, syncInferredTableKeys: withoutInferred(state.syncInferredTableKeys, [key]), syncPlanGenerated: null };
    }),
  setSyncSelectionBulk: (keys, choice) =>
    set((state) => {
      const next = { ...state.syncSelections };
      for (const key of keys) next[key] = choice;
      return { syncSelections: next, syncInferredTableKeys: withoutInferred(state.syncInferredTableKeys, keys), syncPlanGenerated: null };
    }),
  clearSyncSelectionBulk: (keys) =>
    set((state) => {
      if (!keys.some((key) => key in state.syncSelections)) return {};
      const next = { ...state.syncSelections };
      for (const key of keys) delete next[key];
      return { syncSelections: next, syncInferredTableKeys: withoutInferred(state.syncInferredTableKeys, keys), syncPlanGenerated: null };
    }),
  setInferredTableChoice: (key, choice) =>
    set((state) => {
      const selections = { ...state.syncSelections };
      const inferred = { ...state.syncInferredTableKeys };
      if (choice === null) {
        if (!(key in selections) && !(key in inferred)) return {};
        delete selections[key];
        delete inferred[key];
      } else {
        selections[key] = choice;
        inferred[key] = choice;
      }
      return { syncSelections: selections, syncInferredTableKeys: inferred, syncPlanGenerated: null };
    }),
  restoreSyncInferredTableKeys: (inferred) =>
    set((state) => {
      // Only entries whose selection still holds the inferred side.
      const kept: Record<string, GroundTruth> = {};
      for (const [key, choice] of Object.entries(inferred)) {
        if ((choice === 'logical' || choice === 'physical') && state.syncSelections[key] === choice) kept[key] = choice;
      }
      return { syncInferredTableKeys: kept };
    }),
  clearSyncSelections: () => set({ syncSelections: {}, syncInferredTableKeys: {}, syncPlanGenerated: null }),
  setManifestStale: (stale) => set({ manifestStale: stale }),
  setSyncPlanGenerated: (info) => set({ syncPlanGenerated: info }),

  setCanvasMode: (mode) => set({ canvasMode: mode }),
  setToastMessage: (message) => set({ toastMessage: message }),
  setPendingReveal: (target) => set({ pendingReveal: target }),
  setPendingTableReveal: (modelName) => set({ pendingTableReveal: modelName }),

  // Full editor reset on a new domain payload. Overrides the canvas slice's
  // setDomain (which only clears the column selection) and must stay last.
  setDomain: (domain) => set((state) => ({
    domain,
    error: null,
    errorKind: null,
    errorMergeConflict: false,
    errorFileProblem: null,
    errorNewerSchema: false,
    // The notice gets to speak again only when the artifacts behind the stage
    // actually changed. setDomain is NOT only a host payload — usePositionPersistence
    // calls it locally to merge optimistic positions after a drag — so resetting
    // unconditionally made "dismiss" survive about 300ms, until the user moved
    // a node. Comparing the sources means a real dbt run re-shows it and a drag
    // does not.
    physicalSourceNoticeDismissed:
      samePhysicalSources(state.domain?.physicalSources, domain.physicalSources)
        ? state.physicalSourceNoticeDismissed
        : false,
    // Clear column selection on domain reload
    selectedColumns: [], lastSelectedColumn: null, editingColumn: null,
    // Clear discrepancy + sync state when switching stages (stage changed)
    ...(state.domain && state.domain.stage !== domain.stage
      ? {
          discrepancyVisible: false, discrepancyCompareStage: null, discrepancyReport: null,
          syncMode: false, syncSelections: {}, syncInferredTableKeys: {}, manifestStale: false, syncPlanGenerated: null,
          // Reset canvas mode to pan on stage switch; select mode is short-lived UI intent
          // and shouldn't persist across a stage change (physical is read-only).
          canvasMode: 'pan' as const,
        }
      : {}),
  })),
}));

/** The singleton typed as the canvas store, for `CanvasStoreProvider`. */
export const editorStoreApi = useEditorStore as unknown as CanvasStoreApi;
