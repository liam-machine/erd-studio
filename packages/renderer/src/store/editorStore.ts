/**
 * Zustand store for the canvas: the state the shared canvas components
 * (model and annotation nodes, FK edges, detail panel, legend) read and write.
 *
 * The store is provided through React context rather than imported as a
 * module singleton, so every canvas instance can have its own:
 *
 *   - `createCanvasStore()` makes a standalone store holding just this slice.
 *   - A host with more state (the VS Code extension) composes its own store
 *     from `createCanvasSlice(set)` and passes it to `CanvasStoreProvider`.
 *
 * Components keep the familiar `useEditorStore((s) => …)` selector call; it
 * reads whichever store the nearest `CanvasStoreProvider` supplies.
 */

import { createContext, createElement, useContext, type ReactNode } from 'react';
import { createStore, useStore, type StoreApi } from 'zustand';
import type { DisplayDomain, ExistingModelPreview } from '@erd-studio/core';
import type { ModelFlowNode, FkFlowEdge, FkEdgeData, AnnotationFlowNode, AnnotationFlowEdge } from '../types/graph';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

/** Context menu state for annotation right-click. */
export interface AnnotationContextMenu {
  type: 'annotation';
  x: number;
  y: number;
  annotationId: string;
}

/** Union of context menu states. */
export type ContextMenuState = EdgeContextMenu | NodeContextMenu | AnnotationContextMenu | null;

/** Active drag line state for creating relationships via column drag. */
export interface DragLineState {
  sourceModelName: string;
  sourceColumnName: string;
  sourceX: number;
  sourceY: number;
  currentX: number;
  currentY: number;
}

/** Active drag line state for linking an annotation to a model via drag. */
export interface AnnotationLinkDragState {
  annotationId: string;
  sourceX: number;
  sourceY: number;
  currentX: number;
  currentY: number;
}

export interface CanvasState {
  /** Current search query for filtering/highlighting nodes. */
  searchQuery: string;
  /** Name of the currently selected model node, or null. */
  selectedNode: string | null;
  /** IDs of currently selected edges. */
  selectedEdges: string[];
  /** Edge ID selected for dimming (highlights endpoints, dims everything else). */
  selectedEdge: string | null;
  /** Whether the detail panel is open. */
  detailPanelOpen: boolean;
  /** Whether a delete confirmation is pending (triggered by Delete key). */
  pendingDeleteConfirmation: boolean;
  /** The loaded domain data from the extension host (already reconciled with manifest). */
  domain: DisplayDomain | null;
  /** React Flow nodes (local state for selection/drag). */
  nodes: (ModelFlowNode | AnnotationFlowNode)[];
  /** React Flow edges. */
  edges: (FkFlowEdge | AnnotationFlowEdge)[];
  /** Annotation currently being edited (auto-focus textarea), or null. */
  editingAnnotationId: string | null;
  /** Models available to add from logical-models/ and manifest. */
  existingModels: ExistingModelPreview[];
  /** Context menu state (position and target), or null if closed. */
  contextMenu: ContextMenuState;
  /** Whether the legend panel is visible. */
  legendOpen: boolean;
  /** Active drag line state for creating relationships via column drag. */
  dragLineState: DragLineState | null;
  /** Active drag line state for linking an annotation to a model via drag. */
  annotationLinkDrag: AnnotationLinkDragState | null;
  /** Set of "modelName:columnName" keys for columns involved in selected edges. */
  highlightedColumns: Set<string>;
  /** Set of model IDs with columns expanded. */
  expandedNodes: Set<string>;
  /** Whether columns are in global "all expanded" mode. */
  allExpanded: boolean;
  /** Selected column names in the DetailPanel (scoped to current model). */
  selectedColumns: string[];
  /** Anchor column for Shift+click range selection. */
  lastSelectedColumn: string | null;
  /** Column currently in edit mode (name field), or null. */
  editingColumn: string | null;
  /** Currently selected annotation ID, or null. */
  selectedAnnotation: string | null;
}

export interface CanvasActions {
  setSearchQuery: (query: string) => void;
  selectNode: (nodeName: string | null) => void;
  setSelectedEdges: (edgeIds: string[]) => void;
  setSelectedEdge: (edgeId: string | null) => void;
  setDetailPanelOpen: (open: boolean) => void;
  /** Set pending delete confirmation state (triggered by Delete key). */
  setPendingDeleteConfirmation: (pending: boolean) => void;
  setDomain: (domain: DisplayDomain) => void;
  setNodes: (nodes: (ModelFlowNode | AnnotationFlowNode)[]) => void;
  setEdges: (edges: (FkFlowEdge | AnnotationFlowEdge)[]) => void;
  /** Set the annotation currently being edited (auto-focus). */
  setEditingAnnotationId: (id: string | null) => void;
  setExistingModels: (models: ExistingModelPreview[]) => void;
  /** Open context menu for an edge at the given position. */
  openEdgeContextMenu: (x: number, y: number, data: FkEdgeData) => void;
  /** Open context menu for a node at the given position. */
  openNodeContextMenu: (x: number, y: number, modelName: string) => void;
  /** Open context menu for an annotation at the given position. */
  openAnnotationContextMenu: (x: number, y: number, annotationId: string) => void;
  /** Close the context menu. */
  closeContextMenu: () => void;
  /** Toggle the legend panel visibility. */
  setLegendOpen: (open: boolean) => void;
  /** Start drag line for column relationship creation. */
  startDragLine: (modelName: string, columnName: string, sourceX: number, sourceY: number) => void;
  /** Update drag line endpoint as mouse moves. */
  updateDragLineMouse: (mouseX: number, mouseY: number) => void;
  /** End drag line (on drop or cancel). */
  endDragLine: () => void;
  /** Start drag line for annotation-to-model linking. */
  startAnnotationLinkDrag: (annotationId: string, sourceX: number, sourceY: number) => void;
  /** Update annotation link drag endpoint. */
  updateAnnotationLinkDrag: (mouseX: number, mouseY: number) => void;
  /** End annotation link drag. */
  endAnnotationLinkDrag: () => void;
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
  /** Select a single column (replaces selection, sets anchor). */
  selectColumn: (name: string) => void;
  /** Toggle a column in/out of the selection (Ctrl+click). */
  toggleColumnSelection: (name: string) => void;
  /** Select a range of columns from anchor to target (Shift+click). */
  selectColumnRange: (name: string, allNames: string[]) => void;
  /** Clear all column selection. */
  clearColumnSelection: () => void;
  /** Set the column currently being edited (F2 / double-click). */
  setEditingColumn: (name: string | null) => void;
  /** Select an annotation (clears model selection). */
  selectAnnotation: (annotationId: string | null) => void;
}

export type CanvasStore = CanvasState & CanvasActions;
export type CanvasStoreApi = StoreApi<CanvasStore>;
export type CanvasSet = CanvasStoreApi['setState'];

// ---------------------------------------------------------------------------
// Slice
// ---------------------------------------------------------------------------

/**
 * The canvas state defaults and actions. A host that keeps more state spreads
 * this into its own zustand initialiser and adds its fields and actions after
 * it (overriding any action it needs to extend, such as `setDomain`).
 */
export function createCanvasSlice(set: CanvasSet): CanvasStore {
  return {
    // Default state
    searchQuery: '',
    selectedNode: null,
    selectedEdges: [],
    selectedEdge: null,
    detailPanelOpen: false,
    pendingDeleteConfirmation: false,
    domain: null,
    nodes: [],
    edges: [],
    editingAnnotationId: null,
    existingModels: [],
    contextMenu: null,
    legendOpen: false,
    dragLineState: null,
    annotationLinkDrag: null,
    highlightedColumns: new Set<string>(),
    expandedNodes: new Set<string>(),
    allExpanded: false,
    selectedColumns: [],
    lastSelectedColumn: null,
    editingColumn: null,
    selectedAnnotation: null,

    // Actions
    setSearchQuery: (query) => set({ searchQuery: query }),
    selectNode: (nodeName) => set({ selectedNode: nodeName, selectedAnnotation: null, selectedColumns: [], lastSelectedColumn: null, editingColumn: null }),
    setSelectedEdges: (edgeIds) => set({ selectedEdges: edgeIds }),
    setSelectedEdge: (edgeId) => set({ selectedEdge: edgeId }),
    setDetailPanelOpen: (open) => set({ detailPanelOpen: open }),
    setPendingDeleteConfirmation: (pending) => set({ pendingDeleteConfirmation: pending }),
    // Clear column selection on domain reload
    setDomain: (domain) => set({ domain, selectedColumns: [], lastSelectedColumn: null, editingColumn: null }),
    setNodes: (nodes) => set({ nodes }),
    setEdges: (edges) => set({ edges }),
    setEditingAnnotationId: (id) => set({ editingAnnotationId: id }),
    setExistingModels: (models) => set({ existingModels: models }),
    openEdgeContextMenu: (x, y, data) => set({ contextMenu: { type: 'edge', x, y, data } }),
    openNodeContextMenu: (x, y, modelName) => set({ contextMenu: { type: 'node', x, y, modelName } }),
    openAnnotationContextMenu: (x, y, annotationId) => set({ contextMenu: { type: 'annotation', x, y, annotationId } }),
    closeContextMenu: () => set({ contextMenu: null }),
    setLegendOpen: (open) => set({ legendOpen: open }),
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
    startAnnotationLinkDrag: (annotationId, sourceX, sourceY) =>
      set({ annotationLinkDrag: { annotationId, sourceX, sourceY, currentX: sourceX, currentY: sourceY } }),
    updateAnnotationLinkDrag: (mouseX, mouseY) =>
      set((state) =>
        state.annotationLinkDrag
          ? { annotationLinkDrag: { ...state.annotationLinkDrag, currentX: mouseX, currentY: mouseY } }
          : {},
      ),
    endAnnotationLinkDrag: () => set({ annotationLinkDrag: null }),
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

    // Column selection actions
    selectColumn: (name) => set({ selectedColumns: [name], lastSelectedColumn: name, editingColumn: null }),
    toggleColumnSelection: (name) =>
      set((state) => {
        const idx = state.selectedColumns.indexOf(name);
        const next = idx >= 0
          ? state.selectedColumns.filter((n) => n !== name)
          : [...state.selectedColumns, name];
        return { selectedColumns: next, lastSelectedColumn: name, editingColumn: null };
      }),
    selectColumnRange: (name, allNames) =>
      set((state) => {
        const anchor = state.lastSelectedColumn;
        if (!anchor) return { selectedColumns: [name], lastSelectedColumn: name, editingColumn: null };
        const anchorIdx = allNames.indexOf(anchor);
        const targetIdx = allNames.indexOf(name);
        if (anchorIdx < 0 || targetIdx < 0) return { selectedColumns: [name], lastSelectedColumn: name, editingColumn: null };
        const start = Math.min(anchorIdx, targetIdx);
        const end = Math.max(anchorIdx, targetIdx);
        return { selectedColumns: allNames.slice(start, end + 1), editingColumn: null };
      }),
    clearColumnSelection: () => set({ selectedColumns: [], lastSelectedColumn: null, editingColumn: null }),
    setEditingColumn: (name) => set({ editingColumn: name }),

    // Annotation selection actions
    selectAnnotation: (annotationId) => set({
      selectedAnnotation: annotationId,
      selectedNode: null,
      detailPanelOpen: false,
      pendingDeleteConfirmation: false,
      selectedEdge: null,
      selectedEdges: [],
      highlightedColumns: new Set<string>(),
      selectedColumns: [],
      lastSelectedColumn: null,
      editingColumn: null,
    }),
  };
}

/** A standalone store holding just the canvas slice, optionally seeded. */
export function createCanvasStore(initial?: Partial<CanvasState>): CanvasStoreApi {
  return createStore<CanvasStore>()((set) => ({
    ...createCanvasSlice(set),
    ...initial,
  }));
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const CanvasStoreContext = createContext<CanvasStoreApi | null>(null);

/** Supplies the store that canvas components below it read and write. */
export function CanvasStoreProvider({ store, children }: { store: CanvasStoreApi; children: ReactNode }): JSX.Element {
  return createElement(CanvasStoreContext.Provider, { value: store }, children);
}

/** The store supplied by the nearest `CanvasStoreProvider`, for `getState()` in handlers. */
export function useEditorStoreApi(): CanvasStoreApi {
  const store = useContext(CanvasStoreContext);
  if (!store) {
    throw new Error('useEditorStore must be used inside a CanvasStoreProvider (or <ErdCanvas>).');
  }
  return store;
}

/** Select a value from the nearest canvas store; re-renders when it changes. */
export function useEditorStore<T>(selector: (s: CanvasStore) => T): T {
  return useStore(useEditorStoreApi(), selector);
}
