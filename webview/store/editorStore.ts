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
import type { ModelFlowNode, FkFlowEdge } from '../types/graph';
import type { ModelTemplate } from '../../src/types/semantic';

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

export interface EditorState {
  /** Name of the currently selected model node, or null. */
  selectedNode: string | null;
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
}

export interface EditorActions {
  selectNode: (nodeName: string | null) => void;
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
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useEditorStore = create<EditorState & EditorActions>()((set) => ({
  // Default state
  selectedNode: null,
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

  // Actions
  selectNode: (nodeName) => set({ selectedNode: nodeName }),
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
}));
