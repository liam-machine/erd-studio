/**
 * ErdCanvas — the diagram as a self-contained, read-only React component.
 *
 * Renders a `DisplayDomain` the way the VS Code extension's canvas shows a
 * read-only domain: model nodes, FK edges, annotations, the minimap, the
 * detail panel a click on a model opens, and the legend. There are no editing
 * affordances (the canvas runs in viewer mode) and nothing is ever sent
 * anywhere.
 *
 *   <ErdCanvas domain={domain} />
 *
 * Each instance has its own store, so several canvases can share a page. The
 * canvas fills its parent, which needs an explicit height, and reads the
 * `--vscode-*` CSS variables listed in the README.
 *
 * With `nodesDraggable`, readers can move nodes around. Moves stay local: the
 * edges attached to a moved node re-pick their sides live,
 * `onLayoutModifiedChange` reports whether the layout differs from the
 * domain's, and `resetLayout()` (through a ref) puts everything back.
 *
 * Derived from the extension webview's `EditorCanvas` (`webview/App.tsx`),
 * keeping its React Flow configuration.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ForwardedRef,
} from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  applyNodeChanges,
  useNodesInitialized,
  type NodeChange,
} from '@xyflow/react';
import type { DisplayColumn, DisplayDomain, DisplayModel } from '@erd-studio/core';

import {
  CanvasStoreProvider,
  createCanvasStore,
  useEditorStore,
  useEditorStoreApi,
} from './store/editorStore';
import { CanvasEnvironmentProvider, NOOP_CANVAS_HOST } from './host/canvasEnvironment';
import { useCanvasGraph } from './canvas/useCanvasGraph';
import { CanvasBackdrop } from './canvas/CanvasBackdrop';
import { canvasNodeTypes, canvasEdgeTypes } from './canvas/flowTypes';
import { useColumnExpansion, NODE_THRESHOLD } from './hooks/useColumnExpansion';
import { repickHandleSides } from './lib/dragHandleSides';
import type { GraphNode, GraphEdge } from './lib/nodeOverlays';
import { DetailPanel } from './components/DetailPanel/DetailPanel';
import { Legend } from './components/Legend/Legend';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ErdCanvasProps {
  /** The domain to render. It is shown read-only whatever its `readOnly` flag says. */
  domain: DisplayDomain;
  /** Let readers drag model and annotation nodes. Moves are never saved. Default false. */
  nodesDraggable?: boolean;
  /**
   * Called when the layout becomes modified (a node was moved away from its
   * position in the domain) or unmodified again (`resetLayout()`, a new domain,
   * or a node moved back).
   */
  onLayoutModifiedChange?: (modified: boolean) => void;
  /** Called once, when the first nodes have been measured and fitted into view. */
  onReady?: () => void;
  className?: string;
  style?: CSSProperties;
}

export interface ErdCanvasHandle {
  /** Put every node back at its position in the domain, with its original edge sides. */
  resetLayout(): void;
}

// ---------------------------------------------------------------------------
// Domain normalisation
// ---------------------------------------------------------------------------

/**
 * The domain as the canvas renders it: `readOnly` forced on, and the fields the
 * canvas code assumes are present filled in when a hand-built or partial
 * domain leaves them out (layer, stage, relationships, view config, each
 * model's columns, each column's data type). Objects with nothing missing are
 * reused as they are.
 */
export function toRenderableDomain(domain: DisplayDomain): DisplayDomain {
  let modelsChanged = false;
  const models = (domain.models ?? []).map((model) => {
    const renderable = toRenderableModel(model);
    if (renderable !== model) modelsChanged = true;
    return renderable;
  });

  const complete =
    domain.readOnly === true &&
    domain.layer != null &&
    domain.stage != null &&
    domain.models != null &&
    !modelsChanged &&
    domain.relationships != null &&
    domain.viewConfig != null;
  if (complete) return domain;

  return {
    ...domain,
    layer: domain.layer ?? '',
    stage: domain.stage ?? 'logical',
    models: modelsChanged || domain.models == null ? models : domain.models,
    relationships: domain.relationships ?? [],
    viewConfig: domain.viewConfig ?? {},
    readOnly: true,
  };
}

function toRenderableModel(model: DisplayModel): DisplayModel {
  if (model.columns == null) return { ...model, columns: [] };
  if (model.columns.every((col) => col.dataType != null)) return model;
  return { ...model, columns: model.columns.map(toRenderableColumn) };
}

function toRenderableColumn(column: DisplayColumn): DisplayColumn {
  return column.dataType != null ? column : { ...column, dataType: '' };
}

// ---------------------------------------------------------------------------
// Layout baseline (for "modified" and resetLayout)
// ---------------------------------------------------------------------------

interface LayoutBaseline {
  positions: Map<string, { x: number; y: number }>;
  handles: Map<string, { sourceHandle: string | null | undefined; targetHandle: string | null | undefined }>;
}

const EMPTY_BASELINE: LayoutBaseline = { positions: new Map(), handles: new Map() };

/** Movement below this (in canvas pixels) does not count as a layout change. */
const MOVE_THRESHOLD = 0.5;

function captureBaseline(nodes: readonly GraphNode[], edges: readonly GraphEdge[]): LayoutBaseline {
  return {
    positions: new Map(nodes.map((n) => [n.id, { x: n.position.x, y: n.position.y }])),
    handles: new Map(edges.map((e) => [e.id, { sourceHandle: e.sourceHandle, targetHandle: e.targetHandle }])),
  };
}

function differsFromBaseline(nodes: readonly GraphNode[], baseline: LayoutBaseline): boolean {
  return nodes.some((n) => {
    const original = baseline.positions.get(n.id);
    return (
      original !== undefined &&
      (Math.abs(n.position.x - original.x) >= MOVE_THRESHOLD ||
        Math.abs(n.position.y - original.y) >= MOVE_THRESHOLD)
    );
  });
}

// ---------------------------------------------------------------------------
// Inner component (inside the providers)
// ---------------------------------------------------------------------------

interface ErdCanvasInnerProps extends ErdCanvasProps {
  handleRef: ForwardedRef<ErdCanvasHandle>;
}

function ErdCanvasInner({
  domain: domainProp,
  nodesDraggable = false,
  onLayoutModifiedChange,
  onReady,
  className,
  style,
  handleRef,
}: ErdCanvasInnerProps) {
  const storeApi = useEditorStoreApi();
  const domain = useEditorStore((s) => s.domain);
  const nodes = useEditorStore((s) => s.nodes);
  const edges = useEditorStore((s) => s.edges);
  const setNodes = useEditorStore((s) => s.setNodes);
  const setEdges = useEditorStore((s) => s.setEdges);

  // A new domain prop replaces the store's domain. The store starts out with
  // the first one, so mounting does not set it twice.
  useEffect(() => {
    if (storeApi.getState().domain !== domainProp) {
      storeApi.getState().setDomain(domainProp);
    }
  }, [domainProp, storeApi]);

  // Latest callbacks, so a parent passing new closures re-runs nothing.
  const onLayoutModifiedChangeRef = useRef(onLayoutModifiedChange);
  onLayoutModifiedChangeRef.current = onLayoutModifiedChange;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  // Track Shift key state for pan/selection mode switching (as the extension
  // does, rather than relying on React Flow's key tracking inside an iframe).
  const [shiftHeld, setShiftHeld] = useState(false);
  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.key === 'Shift') setShiftHeld(true); };
    const up = (e: KeyboardEvent) => { if (e.key === 'Shift') setShiftHeld(false); };
    const blur = () => setShiftHeld(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  // Expand every model's columns on first load when the domain is small
  // enough, as the extension does on a first-ever load.
  const { expandAll } = useColumnExpansion();
  const hasAutoExpandedRef = useRef(false);
  useEffect(() => {
    if (!domain || hasAutoExpandedRef.current) return;
    hasAutoExpandedRef.current = true;
    if (domain.models.length < NODE_THRESHOLD) {
      expandAll(domain.models.map((m) => m.name));
    }
  }, [domain, expandAll]);

  // Layout-modified tracking. Every rebuild from the domain is the new
  // baseline: nodes at the domain's positions, edges on their original sides.
  const baselineRef = useRef<LayoutBaseline>(EMPTY_BASELINE);
  const modifiedRef = useRef(false);
  const setModified = useCallback((modified: boolean) => {
    if (modifiedRef.current === modified) return;
    modifiedRef.current = modified;
    onLayoutModifiedChangeRef.current?.(modified);
  }, []);

  const [transformed, setTransformed] = useState(false);
  const onTransformed = useCallback(
    (newNodes: GraphNode[], newEdges: GraphEdge[]) => {
      baselineRef.current = captureBaseline(newNodes, newEdges);
      setModified(false);
      setTransformed(true);
    },
    [setModified],
  );

  const { onNodeClick, onEdgeClick, onPaneClick, onSelectionChange } = useCanvasGraph({ onTransformed });

  // Apply React Flow's node changes (selection, measurement, drags). A drag
  // re-picks the sides of the edges on the moved nodes; nothing is saved.
  const onNodesChange = useCallback(
    (changes: NodeChange<GraphNode>[]) => {
      const state = storeApi.getState();
      const updatedNodes = applyNodeChanges(changes, state.nodes);
      setNodes(updatedNodes);

      const moved = new Set<string>();
      for (const change of changes) {
        if (change.type === 'position' && change.position) moved.add(change.id);
      }
      if (moved.size === 0) return;

      const updatedEdges = repickHandleSides(updatedNodes, state.edges, moved);
      if (updatedEdges !== state.edges) setEdges(updatedEdges);
      setModified(differsFromBaseline(updatedNodes, baselineRef.current));
    },
    [storeApi, setNodes, setEdges, setModified],
  );

  const resetLayout = useCallback(() => {
    const baseline = baselineRef.current;
    const state = storeApi.getState();

    let nodesChanged = false;
    const resetNodes = state.nodes.map((n) => {
      const original = baseline.positions.get(n.id);
      if (!original || (original.x === n.position.x && original.y === n.position.y)) return n;
      nodesChanged = true;
      return { ...n, position: { ...original } };
    });
    let edgesChanged = false;
    const resetEdges = state.edges.map((e) => {
      const original = baseline.handles.get(e.id);
      if (!original || (original.sourceHandle === e.sourceHandle && original.targetHandle === e.targetHandle)) return e;
      edgesChanged = true;
      return { ...e, sourceHandle: original.sourceHandle, targetHandle: original.targetHandle };
    });

    if (nodesChanged) setNodes(resetNodes);
    if (edgesChanged) setEdges(resetEdges);
    setModified(false);
  }, [storeApi, setNodes, setEdges, setModified]);

  useImperativeHandle(handleRef, () => ({ resetLayout }), [resetLayout]);

  // onReady: once the first nodes are measured (React Flow then fits the view
  // on the next frame), or straight away for a domain with nothing to draw.
  const nodesInitialized = useNodesInitialized();
  const readyFiredRef = useRef(false);
  const canFireReady = transformed && (nodesInitialized || nodes.length === 0);
  useEffect(() => {
    if (!canFireReady || readyFiredRef.current) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        readyFiredRef.current = true;
        onReadyRef.current?.();
      });
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [canFireReady]);

  return (
    <div
      className={className ? `editor-canvas ${className}` : 'editor-canvas'}
      // The extension's canvas layout (a column flex box around the flow area),
      // positioned so the legend and panels anchor to the canvas.
      style={{ position: 'relative', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', ...style }}
    >
      <ReactFlow
        style={{ flex: '1 1 0', minHeight: 0 }}
        nodes={nodes}
        edges={edges}
        nodeTypes={canvasNodeTypes}
        edgeTypes={canvasEdgeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={onNodeClick}
        onEdgeClick={onEdgeClick}
        onPaneClick={onPaneClick}
        onSelectionChange={onSelectionChange}
        fitView
        minZoom={0.05}
        selectionMode={SelectionMode.Partial}
        zoomOnDoubleClick={domainProp.readOnly}
        nodesDraggable={nodesDraggable}
        nodesConnectable={false}
        // A click that moves a few pixels still counts as a click, so it
        // opens the detail panel even when nodes are draggable.
        nodeClickDistance={4}
        panOnDrag={!shiftHeld}
        selectionOnDrag={false}
        selectionKeyCode={null}
        multiSelectionKeyCode="Shift"
        deleteKeyCode={null}
        proOptions={{ hideAttribution: true }}
      >
        <CanvasBackdrop />
        <DetailPanel />
      </ReactFlow>
      <Legend />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root export
// ---------------------------------------------------------------------------

export const ErdCanvas = forwardRef<ErdCanvasHandle, ErdCanvasProps>(function ErdCanvas(props, ref) {
  const renderable = useMemo(() => toRenderableDomain(props.domain), [props.domain]);
  const [store] = useState(() => createCanvasStore({ domain: renderable }));

  return (
    <CanvasStoreProvider store={store}>
      <CanvasEnvironmentProvider host={NOOP_CANVAS_HOST} viewer>
        <ReactFlowProvider>
          <ErdCanvasInner {...props} domain={renderable} handleRef={ref} />
        </ReactFlowProvider>
      </CanvasEnvironmentProvider>
    </CanvasStoreProvider>
  );
});
