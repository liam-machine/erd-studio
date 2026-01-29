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
import type { ReconciledDomain } from '../../src/types/reconciled';
import type { ModelFlowNode, FkFlowEdge } from '../types/graph';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EditorState {
  /** Name of the currently selected model node, or null. */
  selectedNode: string | null;
  /** React Flow viewport (pan + zoom). */
  viewport: Viewport;
  /** Whether the detail panel is open. */
  detailPanelOpen: boolean;
  /** Whether the new model dialog is open. */
  newModelDialogOpen: boolean;
  /** The loaded domain data from the extension host (already reconciled with manifest). */
  domain: ReconciledDomain | null;
  /** Error message from the extension host, if any. */
  error: string | null;
  /** React Flow nodes (local state for selection/drag). */
  nodes: ModelFlowNode[];
  /** React Flow edges. */
  edges: FkFlowEdge[];
}

export interface EditorActions {
  selectNode: (nodeName: string | null) => void;
  setViewport: (viewport: Viewport) => void;
  setDetailPanelOpen: (open: boolean) => void;
  setNewModelDialogOpen: (open: boolean) => void;
  setDomain: (domain: ReconciledDomain) => void;
  setError: (error: string | null) => void;
  setNodes: (nodes: ModelFlowNode[]) => void;
  setEdges: (edges: FkFlowEdge[]) => void;
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
  domain: null,
  error: null,
  nodes: [],
  edges: [],

  // Actions
  selectNode: (nodeName) => set({ selectedNode: nodeName }),
  setViewport: (viewport) => set({ viewport }),
  setDetailPanelOpen: (open) => set({ detailPanelOpen: open }),
  setNewModelDialogOpen: (open) => set({ newModelDialogOpen: open }),
  setDomain: (domain) => set({ domain, error: null }),
  setError: (error) => set({ error }),
  setNodes: (nodes) => set({ nodes }),
  setEdges: (edges) => set({ edges }),
}));
