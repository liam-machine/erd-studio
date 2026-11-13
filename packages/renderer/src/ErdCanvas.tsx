/**
 * ErdCanvas — the diagram as a self-contained, read-only React component.
 *
 * Renders a `DisplaySubjectArea` the way the VS Code extension's canvas shows a
 * read-only domain: model nodes, FK edges, annotations, the minimap, the
 * detail panel a click on a model opens, the legend (only the entries the
 * stage shown can draw) and, beside its button, the table and relationship
 * counts. A click on the empty canvas, or Escape, works in two steps: the
 * first closes the detail panel and keeps the table selected (its
 * relationships lit), as the panel's close button does; the second clears
 * the selection. There are no editing affordances (the canvas runs in
 * viewer mode) and nothing is ever sent anywhere.
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
 * Resting the pointer on a table previews what it connects to (the rest of
 * the diagram fades) and the relationship lines of the hovered or clicked
 * table carry moving direction arrows (`useHoverFocus`). Both are local,
 * ephemeral presentation: nothing is posted and no prop is needed.
 *
 * Relationship lines are routed around the tables in one of two styles,
 * `lineStyle` `curved` (the default) or `hops`; the reader cannot change it.
 * `tableDetail` (`name`, `keys` or `all`) sets how much of every table is
 * drawn; without it tables draw as they always have.
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
import type { DisplayColumn, DisplaySubjectArea, DisplayTable } from '@erd-studio/core';

import {
  CanvasStoreProvider,
  createCanvasStore,
  useEditorStore,
  useEditorStoreApi,
} from './store/editorStore';
import { CanvasEnvironmentProvider, NOOP_CANVAS_HOST } from './host/canvasEnvironment';
import { useCanvasGraph } from './canvas/useCanvasGraph';
import { useHoverFocus } from './canvas/useHoverFocus';
import { CanvasBackdrop } from './canvas/CanvasBackdrop';
import { canvasNodeTypes, canvasEdgeTypes } from './canvas/flowTypes';
import { useColumnExpansion, NODE_THRESHOLD } from './hooks/useColumnExpansion';
import { repickHandleSides } from './lib/dragHandleSides';
import type { GraphNode, GraphEdge } from './lib/nodeOverlays';
import { DetailPanel } from './components/DetailPanel/DetailPanel';
import { Legend } from './components/Legend/Legend';
import { StatusBar } from './components/StatusBar/StatusBar';
import { DEFAULT_LINE_STYLE, isLineStyle, type LineStyle } from './lib/edgeRouting/lineStyle';
import { isTableDetail, type TableDetail } from './lib/tableDetail';
import { applyClickAway } from './lib/clickAway';

/**
 * The canvas the reader last clicked, pointed at or focused. An Escape with
 * nothing focused clears only its selection, so with several canvases on a
 * page one Escape never clears them all.
 */
let lastActiveCanvas: HTMLElement | null = null;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ErdCanvasProps {
  /** The domain to render. It is shown read-only whatever its `readOnly` flag says. */
  domain: DisplaySubjectArea;
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
  /**
   * Draw the diagram of a project with no dbt project: no stage colours on
   * tables, lines or the selection ring (the layer badge carries the colour)
   * and no Physical, ghost or comparison entries in the legend. Default
   * false: the stage colours, as before.
   */
  logicalOnly?: boolean;
  /**
   * How relationship lines are drawn. Both route the lines around the tables:
   * `curved` (the default) with soft curves, a halo where two lines cross and
   * a faint dashed "x-ray" where a line has to pass under a table; `hops`
   * with square corners and a small hop where two lines cross. Anything else
   * reads as `curved`.
   */
  lineStyle?: LineStyle;
  /**
   * How much of every table is drawn: `name` (the header only), `keys` (the
   * primary, foreign and natural key columns) or `all` (every column). A
   * reader can still open one table, and close it again; nothing is posted.
   * Unset, or any other value: as before this prop existed — every column on
   * a diagram under 30 tables, the first five columns on a larger one.
   */
  tableDetail?: TableDetail;
  /**
   * The URL of the host's copy of `@erd-studio/renderer/edge-routing-worker.js`,
   * served from the page's own origin. Diagrams over 100 lines route in that
   * worker. Without it the worker starts from a blob URL, which a CSP with no
   * `blob:` for workers (only `script-src 'self'`) refuses, so larger diagrams route
   * on the main thread and those over 150 lines keep simple lines. Read once,
   * when the canvas mounts.
   */
  routingWorkerUrl?: string;
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
export function toRenderableSubjectArea(domain: DisplaySubjectArea): DisplaySubjectArea {
  let modelsChanged = false;
  const models = (domain.models ?? []).map((model) => {
    const renderable = toRenderableTable(model);
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

function toRenderableTable(model: DisplayTable): DisplayTable {
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
  logicalOnly = false,
  lineStyle: lineStyleProp,
  tableDetail: tableDetailProp,
  className,
  style,
  handleRef,
}: ErdCanvasInnerProps) {
  const storeApi = useEditorStoreApi();
  const containerRef = useRef<HTMLDivElement>(null);
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

  // The logical-only look follows the prop (the legend reads it from the store).
  useEffect(() => {
    if (storeApi.getState().logicalOnly !== logicalOnly) {
      storeApi.setState({ logicalOnly });
    }
  }, [logicalOnly, storeApi]);

  // The line style follows the prop.
  const lineStyle = isLineStyle(lineStyleProp) ? lineStyleProp : DEFAULT_LINE_STYLE;
  useEffect(() => {
    storeApi.getState().setLineStyle(lineStyle);
  }, [lineStyle, storeApi]);

  // The table detail level follows the prop; unset leaves the store without one.
  const tableDetail = isTableDetail(tableDetailProp) ? tableDetailProp : null;
  useEffect(() => {
    if ((storeApi.getState().tableDetail ?? null) !== tableDetail) {
      storeApi.getState().setTableDetail(tableDetail);
    }
  }, [tableDetail, storeApi]);

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
  // enough. Not at a table detail level, which decides the columns itself.
  const { expandAll } = useColumnExpansion();
  const hasAutoExpandedRef = useRef(false);
  useEffect(() => {
    if (!domain || tableDetail !== null || hasAutoExpandedRef.current) return;
    hasAutoExpandedRef.current = true;
    if (domain.models.length < NODE_THRESHOLD) {
      expandAll(domain.models.map((m) => m.name));
    }
  }, [domain, expandAll, tableDetail]);

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

  const { onNodeClick, onEdgeClick, onPaneClick, onSelectionChange, keepSelection } = useCanvasGraph({ onTransformed });

  // Escape takes the same two steps as a click on the empty canvas: an open
  // panel closes (the table stays selected), then the selection clears. Only
  // when the key is pressed in the canvas, or with nothing focused (focus
  // fell back to the page) and this is the canvas the reader last used, so
  // it never takes Escape from the rest of the page or from another canvas.
  useEffect(() => {
    const container = containerRef.current;
    const markActive = () => {
      lastActiveCanvas = container;
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const target = e.target as Node | null;
      const inCanvas = target !== null && container?.contains(target) === true;
      const nowhere =
        (target === document.body || target === document.documentElement || target === document) &&
        lastActiveCanvas === container;
      if (!inCanvas && !nowhere) return;
      if (applyClickAway(storeApi) !== 'none') storeApi.getState().setHoverFocus(null);
    };
    const activity = ['pointerdown', 'click', 'focusin'] as const;
    for (const type of activity) container?.addEventListener(type, markActive, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      for (const type of activity) container?.removeEventListener(type, markActive, true);
      window.removeEventListener('keydown', onKeyDown);
      if (lastActiveCanvas === container) lastActiveCanvas = null;
    };
  }, [storeApi]);
  // Hover preview and relationship flow (ephemeral, no posts).
  const { hoverHandlers, flowClassName } = useHoverFocus();

  // Apply React Flow's node changes (selection, measurement, drags). A drag
  // re-picks the sides of the edges on the moved nodes; nothing is saved.
  const onNodesChange = useCallback(
    (changes: NodeChange<GraphNode>[]) => {
      const state = storeApi.getState();
      const updatedNodes = applyNodeChanges(keepSelection(changes), state.nodes);
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
    [storeApi, setNodes, setEdges, setModified, keepSelection],
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
      ref={containerRef}
      className={`editor-canvas${logicalOnly ? ' editor-canvas--neutral' : ''}${className ? ` ${className}` : ''}`}
      // The extension's canvas layout (a column flex box around the flow area),
      // positioned so the legend and panels anchor to the canvas. The chrome
      // sizes itself from React Flow's measured pane (lib/canvasChrome.ts).
      style={{ position: 'relative', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', ...style }}
    >
      <ReactFlow
        className={flowClassName}
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
        {...hoverHandlers}
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
        <StatusBar />
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
  const renderable = useMemo(() => toRenderableSubjectArea(props.domain), [props.domain]);
  const [store] = useState(() =>
    createCanvasStore({
      domain: renderable,
      logicalOnly: props.logicalOnly === true,
      lineStyle: isLineStyle(props.lineStyle) ? props.lineStyle : DEFAULT_LINE_STYLE,
      tableDetail: isTableDetail(props.tableDetail) ? props.tableDetail : null,
      routingWorkerUrl: typeof props.routingWorkerUrl === 'string' && props.routingWorkerUrl !== '' ? props.routingWorkerUrl : null,
    }),
  );

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
