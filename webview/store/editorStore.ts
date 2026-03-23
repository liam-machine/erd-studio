/**
 * Zustand store for the webview editor state.
 *
 * Manages UI state that is local to the webview: editor mode, selected node,
 * viewport (zoom/pan), and detail panel visibility. Domain data (models,
 * relationships) lives in the extension host — only UI-relevant slices are
 * stored here.
 */

import { create } from 'zustand';
import type { Viewport } from '@xyflow/react';
import type { DisplayDomain, ManifestModelPreview } from '../../src/types/display';
import type { DiscrepancyReport } from '../../src/types/discrepancy';
import type { ModelFlowNode, FkFlowEdge, FkEdgeData } from '../types/graph';
import type { ModelTemplate, Stage } from '../../src/types/semantic';

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

/** Context menu state for edge right-click. */
export interface EdgeContextMenu {
  type: 'edge';
  x: number;
  y: number;
  data: FkEdgeData;
}

/** Context menu state for node right-click. */
export interface NodeContextMenu {
  type: 'node';
  x: number;
  y: number;
  modelName: string;
}

/** Union of context menu states. */
export type ContextMenuState = EdgeContextMenu | NodeContextMenu | null;

export interface EditorState {
  /** Current search query for filtering/highlighting nodes. */
  searchQuery: string;
  /** Name of the currently selected model node, or null. */
  selectedNode: string | null;
  /** IDs of currently selected edges. */
  selectedEdges: string[];
  /** Edge ID selected for dimming (highlights endpoints, dims everything else). */
  selectedEdge: string | null;
  /** React Flow viewport (pan + zoom). */
  viewport: Viewport;
  /** Whether the detail panel is open. */
  detailPanelOpen: boolean;
  /** Whether the new model dialog is open. */
  newModelDialogOpen: boolean;
  /** Whether the new FK relationship dialog is open. */
  newFkDialogOpen: boolean;
  /** Prefill data for FK dialog when opened via drag-to-connect, or null. */
  fkDialogPrefill: FkDialogPrefill | null;
  /** Edit data for FK dialog when editing an existing relationship, or null. */
  fkDialogEditData: FkDialogEditData | null;
  /** Whether a delete confirmation is pending (triggered by Delete key). */
  pendingDeleteConfirmation: boolean;
  /** Whether the add existing model dialog is open. */
  addExistingModelDialogOpen: boolean;
  /** The loaded domain data from the extension host (already reconciled with manifest). */
  domain: DisplayDomain | null;
  /** Error message from the extension host, if any. */
  error: string | null;
  /** React Flow nodes (local state for selection/drag). */
  nodes: ModelFlowNode[];
  /** React Flow edges. */
  edges: FkFlowEdge[];
  /** Available model templates loaded from semantic/templates/*.json. */
  templates: ModelTemplate[];
  /** Manifest models available to add to this domain (not already in domain). */
  manifestModels: ManifestModelPreview[];
  /** Context menu state (position and target), or null if closed. */
  contextMenu: ContextMenuState;
  /** Internal: registered search focus function (not persisted). */
  _searchFocusFn: (() => void) | null;
  /** Internal: registered auto-layout function (not persisted). */
  _autoLayoutFn: (() => void) | null;
  /** Whether the legend panel is visible. */
  legendOpen: boolean;
  /** Whether the welcome modal is visible. */
  welcomeModalOpen: boolean;
  /** Active drag line state for creating relationships via column drag. */
  dragLineState: {
    sourceModelName: string;
    sourceColumnName: string;
    sourceX: number;
    sourceY: number;
    currentX: number;
    currentY: number;
  } | null;
  /** Whether the cross-stage discrepancy overlay is visible. */
  discrepancyVisible: boolean;
  /** The stage being compared against when discrepancy is active. */
  discrepancyCompareStage: Stage | null;
  /** The active discrepancy report from the extension, or null. */
  discrepancyReport: DiscrepancyReport | null;
  /** Set of "modelName:columnName" keys for columns involved in selected edges. */
  highlightedColumns: Set<string>;
  /** Set of model IDs with columns expanded. */
  expandedNodes: Set<string>;
  /** Whether columns are in global "all expanded" mode. */
  allExpanded: boolean;
}

export interface EditorActions {
  setSearchQuery: (query: string) => void;
  selectNode: (nodeName: string | null) => void;
  setSelectedEdges: (edgeIds: string[]) => void;
  setSelectedEdge: (edgeId: string | null) => void;
  setViewport: (viewport: Viewport) => void;
  setDetailPanelOpen: (open: boolean) => void;
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
  /** Set pending delete confirmation state (triggered by Delete key). */
  setPendingDeleteConfirmation: (pending: boolean) => void;
  /** Open/close the add existing model dialog. */
  setAddExistingModelDialogOpen: (open: boolean) => void;
  setDomain: (domain: DisplayDomain) => void;
  setError: (error: string | null) => void;
  setNodes: (nodes: ModelFlowNode[]) => void;
  setEdges: (edges: FkFlowEdge[]) => void;
  setTemplates: (templates: ModelTemplate[]) => void;
  setManifestModels: (models: ManifestModelPreview[]) => void;
  /** Open context menu for an edge at the given position. */
  openEdgeContextMenu: (x: number, y: number, data: FkEdgeData) => void;
  /** Open context menu for a node at the given position. */
  openNodeContextMenu: (x: number, y: number, modelName: string) => void;
  /** Close the context menu. */
  closeContextMenu: () => void;
  /** Register a function to focus the search input (called by Toolbar on mount). */
  registerSearchFocus: (focusFn: (() => void) | null) => void;
  /** Focus the search input (called by keyboard handler). */
  focusSearchInput: () => void;
  /** Register a function to trigger auto-layout (called by Toolbar on mount). */
  registerAutoLayout: (layoutFn: (() => void) | null) => void;
  /** Trigger auto-layout (called by keyboard handler). */
  triggerAutoLayout: () => void;
  /** Toggle the legend panel visibility. */
  setLegendOpen: (open: boolean) => void;
  /** Toggle the welcome modal visibility. */
  setWelcomeModalOpen: (open: boolean) => void;
  /** Start drag line for column relationship creation. */
  startDragLine: (modelName: string, columnName: string, sourceX: number, sourceY: number) => void;
  /** Update drag line endpoint as mouse moves. */
  updateDragLineMouse: (mouseX: number, mouseY: number) => void;
  /** End drag line (on drop or cancel). */
  endDragLine: () => void;
  /** Toggle the discrepancy overlay visibility. */
  setDiscrepancyVisible: (visible: boolean) => void;
  /** Set the stage being compared against. */
  setDiscrepancyCompareStage: (stage: Stage | null) => void;
  /** Set the discrepancy report from the extension. */
  setDiscrepancyReport: (report: DiscrepancyReport | null) => void;
  /** Set highlighted columns (for edge click). */
  setHighlightedColumns: (columns: Set<string>) => void;
  /** Expand all listed model IDs (sets allExpanded mode). */
  expandAll: (modelIds: string[]) => void;
  /** Expand only new model IDs without resetting existing state. */
  expandNew: (modelIds: string[]) => void;
  /** Collapse all models. */
  collapseAll: () => void;
  /** Toggle expand/collapse for a single model. */
  toggleExpansion: (modelId: string) => void;
  /** Restore expansion state from persisted data. */
  setExpandedNodes: (nodes: string[], allExpanded: boolean) => void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useEditorStore = create<EditorState & EditorActions>()((set) => ({
  // Default state
  searchQuery: '',
  selectedNode: null,
  selectedEdges: [],
  selectedEdge: null,
  viewport: { x: 0, y: 0, zoom: 1 },
  detailPanelOpen: false,
  newModelDialogOpen: false,
  newFkDialogOpen: false,
  fkDialogPrefill: null,
  fkDialogEditData: null,
  pendingDeleteConfirmation: false,
  addExistingModelDialogOpen: false,
  domain: null,
  error: null,
  nodes: [],
  edges: [],
  templates: [],
  manifestModels: [],
  contextMenu: null,
  _searchFocusFn: null,
  _autoLayoutFn: null,
  legendOpen: false,
  welcomeModalOpen: false,
  dragLineState: null,
  discrepancyVisible: false,
  discrepancyCompareStage: null,
  discrepancyReport: null,
  highlightedColumns: new Set<string>(),
  expandedNodes: new Set<string>(),
  allExpanded: false,

  // Actions
  setSearchQuery: (query) => set({ searchQuery: query }),
  selectNode: (nodeName) => set({ selectedNode: nodeName }),
  setSelectedEdges: (edgeIds) => set({ selectedEdges: edgeIds }),
  setSelectedEdge: (edgeId) => set({ selectedEdge: edgeId }),
  setViewport: (viewport) => set({ viewport }),
  setDetailPanelOpen: (open) => set({ detailPanelOpen: open }),
  setNewModelDialogOpen: (open) => set({ newModelDialogOpen: open }),
  setNewFkDialogOpen: (open) => set({ newFkDialogOpen: open }),
  openFkDialogWithPrefill: (prefill) =>
    set({ newFkDialogOpen: true, fkDialogPrefill: prefill, fkDialogEditData: null }),
  clearFkDialogPrefill: () => set({ fkDialogPrefill: null }),
  openFkDialogForEdit: (editData) =>
    set({ newFkDialogOpen: true, fkDialogEditData: editData, fkDialogPrefill: null }),
  clearFkDialogEditData: () => set({ fkDialogEditData: null }),
  setPendingDeleteConfirmation: (pending) => set({ pendingDeleteConfirmation: pending }),
  setAddExistingModelDialogOpen: (open) => set({ addExistingModelDialogOpen: open }),
  setDomain: (domain) => set((state) => ({
    domain,
    error: null,
    // Clear discrepancy when switching stages (stage changed)
    ...(state.domain && state.domain.stage !== domain.stage
      ? { discrepancyVisible: false, discrepancyCompareStage: null, discrepancyReport: null }
      : {}),
  })),
  setError: (error) => set({ error }),
  setNodes: (nodes) => set({ nodes }),
  setEdges: (edges) => set({ edges }),
  setTemplates: (templates) => set({ templates }),
  setManifestModels: (models) => set({ manifestModels: models }),
  openEdgeContextMenu: (x, y, data) => set({ contextMenu: { type: 'edge', x, y, data } }),
  openNodeContextMenu: (x, y, modelName) => set({ contextMenu: { type: 'node', x, y, modelName } }),
  closeContextMenu: () => set({ contextMenu: null }),
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
  setLegendOpen: (open) => set({ legendOpen: open }),
  setWelcomeModalOpen: (open) => set({ welcomeModalOpen: open }),
  startDragLine: (modelName, columnName, sourceX, sourceY) =>
    set({
      dragLineState: {
        sourceModelName: modelName,
        sourceColumnName: columnName,
        sourceX,
        sourceY,
        currentX: sourceX,
        currentY: sourceY,
      },
    }),
  updateDragLineMouse: (mouseX, mouseY) =>
    set((state) =>
      state.dragLineState
        ? {
            dragLineState: {
              ...state.dragLineState,
              currentX: mouseX,
              currentY: mouseY,
            },
          }
        : {},
    ),
  endDragLine: () => set({ dragLineState: null }),
  setDiscrepancyVisible: (visible) => set({ discrepancyVisible: visible }),
  setDiscrepancyCompareStage: (stage) => set({ discrepancyCompareStage: stage }),
  setDiscrepancyReport: (report) => set({ discrepancyReport: report }),
  setHighlightedColumns: (columns) => set({ highlightedColumns: columns }),
  expandAll: (modelIds) => set({ expandedNodes: new Set(modelIds), allExpanded: true }),
  expandNew: (modelIds) =>
    set((state) => {
      const next = new Set(state.expandedNodes);
      modelIds.forEach((id) => next.add(id));
      return { expandedNodes: next };
    }),
  collapseAll: () => set({ expandedNodes: new Set(), allExpanded: false }),
  toggleExpansion: (modelId) =>
    set((state) => {
      const next = new Set(state.expandedNodes);
      if (next.has(modelId)) {
        next.delete(modelId);
      } else {
        next.add(modelId);
      }
      return { expandedNodes: next, allExpanded: false };
    }),
  setExpandedNodes: (nodes, allExpanded) =>
    set({ expandedNodes: new Set(nodes), allExpanded }),
}));
