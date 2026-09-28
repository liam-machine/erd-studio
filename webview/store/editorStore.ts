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
import type { DisplayDomain, ManifestModelPreview } from '../../src/types/display';
import type { DiscrepancyReport } from '../../src/types/discrepancy';
import type { ModelTemplate, Stage } from '../../src/types/semantic';
import type { GroundTruth } from '../../src/types/syncPlan';
import type { ErrorMessage } from '../../src/types/messages';
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
}

/** Edit data for FK dialog when editing an existing relationship. */
export interface FkDialogEditData {
  fromModel: string;
  fromColumn: string;
  toModel: string;
  toColumn: string;
  cardinality: import('../../src/types/semantic').Cardinality;
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
  /** Error message from the extension host, if any. */
  error: string | null;
  /**
   * What kind of failure `error` describes, when the host said. Only the
   * initial-load error screen reads it — it decides which recovery actions
   * are worth offering (see App.tsx). Null for an unclassified error.
   */
  errorKind: ErrorMessage['payload']['kind'] | null;
  /** Available model templates loaded from semantic/templates/*.json. */
  templates: ModelTemplate[];
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
  /** Whether the welcome modal is visible. */
  welcomeModalOpen: boolean;
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
   * Whether the "no compiled dbt artifacts" strip has been dismissed.
   *
   * Session state only — deliberately not persisted. If dbt still has not been
   * compiled after a reload, the notice should come back.
   */
  physicalSourceNoticeDismissed: boolean;
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
  /** Open/close the add existing model dialog. */
  setAddExistingModelDialogOpen: (open: boolean) => void;
  /** Hide the physical-source notice for the rest of this session. */
  dismissPhysicalSourceNotice: () => void;
  setError: (error: string | null, kind?: ErrorMessage['payload']['kind']) => void;
  setTemplates: (templates: ModelTemplate[]) => void;
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
  /** Toggle the welcome modal visibility. */
  setWelcomeModalOpen: (open: boolean) => void;
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
  /** Set ground truth for multiple items at once (bulk). */
  setSyncSelectionBulk: (keys: string[], choice: GroundTruth) => void;
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
}

/**
 * Do two payloads report the same set of dbt artifacts behind the physical
 * stage? Absent on both sides (the logical stage, or an older host) counts as
 * unchanged, so nothing re-shows the notice on a stage the notice never
 * addresses.
 */
function samePhysicalSources(
  a: DisplayDomain['physicalSources'],
  b: DisplayDomain['physicalSources'],
): boolean {
  if (!a || !b) { return !a && !b; }
  return a.yml === b.yml && a.manifest === b.manifest && a.catalog === b.catalog;
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
  error: null,
  errorKind: null,
  templates: [],
  manifestModels: [],
  _searchFocusFn: null,
  _autoLayoutFn: null,
  pendingAutoLayout: false,
  welcomeModalOpen: false,
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
  manifestStale: false,
  syncPlanGenerated: null,
  canvasMode: 'pan',
  toastMessage: null,
  physicalSourceNoticeDismissed: false,

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
  setAddExistingModelDialogOpen: (open) => set({ addExistingModelDialogOpen: open }),
  dismissPhysicalSourceNotice: () => set({ physicalSourceNoticeDismissed: true }),
  setError: (error, kind) => set({ error, errorKind: error === null ? null : (kind ?? null) }),
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
  setWelcomeModalOpen: (open) => set({ welcomeModalOpen: open }),
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
    ...(!visible ? { syncMode: false, syncSelections: {}, manifestStale: false, syncPlanGenerated: null } : {}),
  }),
  setDiscrepancyCompareStage: (stage) => set({ discrepancyCompareStage: stage }),
  setDiscrepancyReport: (report) => set({ discrepancyReport: report }),
  setSyncMode: (active) => set({ syncMode: active, syncPlanGenerated: null }),
  setSyncSelection: (key, choice) =>
    set((state) => ({ syncSelections: { ...state.syncSelections, [key]: choice } })),
  setSyncSelectionBulk: (keys, choice) =>
    set((state) => {
      const next = { ...state.syncSelections };
      for (const key of keys) next[key] = choice;
      return { syncSelections: next };
    }),
  clearSyncSelections: () => set({ syncSelections: {}, syncPlanGenerated: null }),
  setManifestStale: (stale) => set({ manifestStale: stale }),
  setSyncPlanGenerated: (info) => set({ syncPlanGenerated: info }),

  setCanvasMode: (mode) => set({ canvasMode: mode }),
  setToastMessage: (message) => set({ toastMessage: message }),

  // Full editor reset on a new domain payload. Overrides the canvas slice's
  // setDomain (which only clears the column selection) and must stay last.
  setDomain: (domain) => set((state) => ({
    domain,
    error: null,
    errorKind: null,
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
          syncMode: false, syncSelections: {}, manifestStale: false, syncPlanGenerated: null,
          // Reset canvas mode to pan on stage switch; select mode is short-lived UI intent
          // and shouldn't persist across a stage change (physical is read-only).
          canvasMode: 'pan' as const,
        }
      : {}),
  })),
}));

/** The singleton typed as the canvas store, for `CanvasStoreProvider`. */
export const editorStoreApi = useEditorStore as unknown as CanvasStoreApi;
