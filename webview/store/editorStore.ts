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
import type { SemanticDomain } from '../../src/types/semantic';
import type { ModelFlowNode, FkFlowEdge } from '../types/graph';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EditorMode = 'browse' | 'design';

export interface EditorState {
  /** Current editor mode. */
  mode: EditorMode;
  /** Name of the currently selected model node, or null. */
  selectedNode: string | null;
  /** React Flow viewport (pan + zoom). */
  viewport: Viewport;
  /** Whether the detail panel is open. */
  detailPanelOpen: boolean;
  /** The loaded domain data from the extension host. */
  domain: SemanticDomain | null;
  /** Error message from the extension host, if any. */
  error: string | null;
  /** React Flow nodes (local state for selection/drag). */
  nodes: ModelFlowNode[];
  /** React Flow edges. */
  edges: FkFlowEdge[];
}

export interface EditorActions {
  setMode: (mode: EditorMode) => void;
  selectNode: (nodeName: string | null) => void;
  setViewport: (viewport: Viewport) => void;
  setDetailPanelOpen: (open: boolean) => void;
  setDomain: (domain: SemanticDomain) => void;
  setError: (error: string | null) => void;
  setNodes: (nodes: ModelFlowNode[]) => void;
  setEdges: (edges: FkFlowEdge[]) => void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useEditorStore = create<EditorState & EditorActions>()((set) => ({
  // Default state
  mode: 'browse',
  selectedNode: null,
  viewport: { x: 0, y: 0, zoom: 1 },
  detailPanelOpen: false,
  domain: null,
  error: null,
  nodes: [],
  edges: [],

  // Actions
  setMode: (mode) => set({ mode }),
  selectNode: (nodeName) => set({ selectedNode: nodeName }),
  setViewport: (viewport) => set({ viewport }),
  setDetailPanelOpen: (open) => set({ detailPanelOpen: open }),
  setDomain: (domain) => set({ domain, error: null }),
  setError: (error) => set({ error }),
  setNodes: (nodes) => set({ nodes }),
  setEdges: (edges) => set({ edges }),
}));
