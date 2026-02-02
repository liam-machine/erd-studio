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
import type { ManifestModelPreview, ReconciledDomain } from '../../src/types/reconciled';
import type { ModelFlowNode, FkFlowEdge, FkEdgeData } from '../types/graph';
import type { ModelTemplate } from '../../src/types/semantic';
import type { PaletteId } from '../lib/colorPalettes';

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
  modelStatus: 'built' | 'approved' | 'design' | 'missing';
  isApproved: boolean;
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
  /** Whether a delete confirmation is pending (triggered by Delete key). */
  pendingDeleteConfirmation: boolean;
  /** Whether the add existing model dialog is open. */
  addExistingModelDialogOpen: boolean;
  /** The loaded domain data from the extension host (already reconciled with manifest). */
  domain: ReconciledDomain | null;
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
  /** Current colour palette ID. */
  paletteId: PaletteId;
  /** Whether the legend panel is visible. */
  legendOpen: boolean;
  /** Whether the welcome modal is visible. */
  welcomeModalOpen: boolean;
}

export interface EditorActions {
  setSearchQuery: (query: string) => void;
  selectNode: (nodeName: string | null) => void;
  setSelectedEdges: (edgeIds: string[]) => void;
  setViewport: (viewport: Viewport) => void;
  setDetailPanelOpen: (open: boolean) => void;
  setNewModelDialogOpen: (open: boolean) => void;
  setNewFkDialogOpen: (open: boolean) => void;
  /** Open FK dialog with prefilled source/target from drag-to-connect. */
  openFkDialogWithPrefill: (prefill: FkDialogPrefill) => void;
  /** Clear FK dialog prefill (called on dialog close). */
  clearFkDialogPrefill: () => void;
  /** Set pending delete confirmation state (triggered by Delete key). */
  setPendingDeleteConfirmation: (pending: boolean) => void;
  /** Open/close the add existing model dialog. */
  setAddExistingModelDialogOpen: (open: boolean) => void;
  setDomain: (domain: ReconciledDomain) => void;
  setError: (error: string | null) => void;
  setNodes: (nodes: ModelFlowNode[]) => void;
  setEdges: (edges: FkFlowEdge[]) => void;
  setTemplates: (templates: ModelTemplate[]) => void;
  setManifestModels: (models: ManifestModelPreview[]) => void;
  /** Open context menu for an edge at the given position. */
  openEdgeContextMenu: (x: number, y: number, data: FkEdgeData) => void;
  /** Open context menu for a node at the given position. */
  openNodeContextMenu: (x: number, y: number, modelName: string, modelStatus: 'built' | 'approved' | 'design' | 'missing', isApproved: boolean) => void;
  /** Close the context menu. */
  closeContextMenu: () => void;
  /** Register a function to focus the search input (called by Toolbar on mount). */
  registerSearchFocus: (focusFn: (() => void) | null) => void;
  /** Focus the search input (called by keyboard handler). */
  focusSearchInput: () => void;
  /** Set the colour palette. */
  setPaletteId: (paletteId: PaletteId) => void;
  /** Toggle the legend panel visibility. */
  setLegendOpen: (open: boolean) => void;
  /** Toggle the welcome modal visibility. */
  setWelcomeModalOpen: (open: boolean) => void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useEditorStore = create<EditorState & EditorActions>()((set) => ({
  // Default state
  searchQuery: '',
  selectedNode: null,
  selectedEdges: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  detailPanelOpen: false,
  newModelDialogOpen: false,
  newFkDialogOpen: false,
  fkDialogPrefill: null,
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
  paletteId: 'coolWarm',
  legendOpen: false,
  welcomeModalOpen: false,

  // Actions
  setSearchQuery: (query) => set({ searchQuery: query }),
  selectNode: (nodeName) => set({ selectedNode: nodeName }),
  setSelectedEdges: (edgeIds) => set({ selectedEdges: edgeIds }),
  setViewport: (viewport) => set({ viewport }),
  setDetailPanelOpen: (open) => set({ detailPanelOpen: open }),
  setNewModelDialogOpen: (open) => set({ newModelDialogOpen: open }),
  setNewFkDialogOpen: (open) => set({ newFkDialogOpen: open }),
  openFkDialogWithPrefill: (prefill) =>
    set({ newFkDialogOpen: true, fkDialogPrefill: prefill }),
  clearFkDialogPrefill: () => set({ fkDialogPrefill: null }),
  setPendingDeleteConfirmation: (pending) => set({ pendingDeleteConfirmation: pending }),
  setAddExistingModelDialogOpen: (open) => set({ addExistingModelDialogOpen: open }),
  setDomain: (domain) => set({ domain, error: null }),
  setError: (error) => set({ error }),
  setNodes: (nodes) => set({ nodes }),
  setEdges: (edges) => set({ edges }),
  setTemplates: (templates) => set({ templates }),
  setManifestModels: (models) => set({ manifestModels: models }),
  openEdgeContextMenu: (x, y, data) => set({ contextMenu: { type: 'edge', x, y, data } }),
  openNodeContextMenu: (x, y, modelName, modelStatus, isApproved) => set({ contextMenu: { type: 'node', x, y, modelName, modelStatus, isApproved } }),
  closeContextMenu: () => set({ contextMenu: null }),
  registerSearchFocus: (focusFn) => set({ _searchFocusFn: focusFn }),
  focusSearchInput: () => {
    const { _searchFocusFn } = useEditorStore.getState();
    if (_searchFocusFn) _searchFocusFn();
  },
  setPaletteId: (paletteId) => set({ paletteId }),
  setLegendOpen: (open) => set({ legendOpen: open }),
  setWelcomeModalOpen: (open) => set({ welcomeModalOpen: open }),
}));
