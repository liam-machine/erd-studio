/**
 * Root application component for the semantic domain editor webview.
 *
 * Renders a React Flow canvas inside the custom editor. Communicates with the
 * extension host via the message bus to receive domain data and send user
 * actions. UI state (mode, selection, viewport) is managed by the Zustand
 * editor store.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  Background,
  BackgroundVariant,
  MiniMap,
  SelectionMode,
  type Viewport,
  type NodeTypes,
  type EdgeTypes,
  type OnSelectionChangeFunc,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './App.css';

import { useMessageBus, type ExtensionMessage } from './hooks/useMessageBus';
import { usePositionPersistence } from './hooks/usePositionPersistence';
import { useStatePersistence } from './hooks/useStatePersistence';
import { useVsCodeApi } from './hooks/useVsCodeApi';
import { useColumnExpansion, NODE_THRESHOLD } from './hooks/useColumnExpansion';
import { isStaleStageReply } from './lib/stageRequest';
import { useEditorStore } from './store/editorStore';
import { ModelNode } from './components/Graph/ModelNode';
import { FkEdge } from './components/Graph/FkEdge';
import { AnnotationNode } from './components/Graph/AnnotationNode';
import { AnnotationEdge } from './components/Graph/AnnotationEdge';
import { DragLine } from './components/Graph/DragLine';
import { Toolbar } from './components/Toolbar/Toolbar';
import { StatusBar } from './components/Toolbar/StatusBar';
import { DetailPanel } from './components/DetailPanel/DetailPanel';
import { NewModelDialog } from './components/NewModelDialog/NewModelDialog';
import { NewFkDialog } from './components/NewFkDialog/NewFkDialog';
import { AddExistingModelDialog } from './components/AddExistingModelDialog/AddExistingModelDialog';
import { Toast } from './components/Toast/Toast';
import { ContextMenu } from './components/ContextMenu/ContextMenu';
import { Legend } from './components/Legend/Legend';
import { DiscrepancyPanel } from './components/DiscrepancyPanel/DiscrepancyPanel';
import { WelcomeModal } from './components/WelcomeModal/WelcomeModal';
import { BugReportDialog } from './components/BugReportDialog/BugReportDialog';
import { SyncMergeModal } from './components/SyncMergeModal/SyncMergeModal';
import { ReconnectOverlay } from './components/ReconnectOverlay/ReconnectOverlay';
import { transformDomain } from './lib/graphTransformer';
import { applyNodeOverlays } from './lib/nodeOverlays';
import { stageNodeColor } from './lib/stageColors';
import { useCanvasShortcuts } from './hooks/useCanvasShortcuts';
import type { ModelFlowNode, FkFlowEdge, AnnotationFlowNode, AnnotationFlowEdge } from './types/graph';
import type { DisplayDomain } from '../src/types/display';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Load a display-domain payload into the store. Shared by `domainLoaded`
 * (initial load / host refresh) and `stageData` (stage switch reply).
 */
function applyDomainPayload(payload: DisplayDomain): void {
  const s = useEditorStore.getState();
  s.setDomain(payload);
  if (payload.templates) {
    s.setTemplates(payload.templates);
  }
  if (payload.manifestModels) {
    s.setManifestModels(payload.manifestModels);
  }
  if (payload.existingModels) {
    s.setExistingModels(payload.existingModels);
  }
}

// ---------------------------------------------------------------------------
// Inner component (must be inside ReactFlowProvider)
// ---------------------------------------------------------------------------

/** Custom node types for React Flow — must be memoised or stable. */
const nodeTypes: NodeTypes = { model: ModelNode, annotation: AnnotationNode };

/** Custom edge types for React Flow — must be memoised or stable. */
const edgeTypes: EdgeTypes = { fk: FkEdge, annotationLink: AnnotationEdge };

function EditorCanvas() {
  const domain = useEditorStore((s) => s.domain);
  const error = useEditorStore((s) => s.error);
  const nodes = useEditorStore((s) => s.nodes);
  const edges = useEditorStore((s) => s.edges);
  const setError = useEditorStore((s) => s.setError);
  const setViewport = useEditorStore((s) => s.setViewport);
  const setNodes = useEditorStore((s) => s.setNodes);
  const setEdges = useEditorStore((s) => s.setEdges);
  const selectNode = useEditorStore((s) => s.selectNode);
  const setDetailPanelOpen = useEditorStore((s) => s.setDetailPanelOpen);
  const setBugReportDialogOpen = useEditorStore((s) => s.setBugReportDialogOpen);
  const openFkDialogWithPrefill = useEditorStore((s) => s.openFkDialogWithPrefill);
  const setSelectedEdges = useEditorStore((s) => s.setSelectedEdges);
  const setHighlightedColumns = useEditorStore((s) => s.setHighlightedColumns);
  const selectedEdge = useEditorStore((s) => s.selectedEdge);
  const setSelectedEdge = useEditorStore((s) => s.setSelectedEdge);
  // Context menu state
  const openEdgeContextMenu = useEditorStore((s) => s.openEdgeContextMenu);
  const openNodeContextMenu = useEditorStore((s) => s.openNodeContextMenu);
  const openAnnotationContextMenu = useEditorStore((s) => s.openAnnotationContextMenu);
  const closeContextMenu = useEditorStore((s) => s.closeContextMenu);
  const contextMenu = useEditorStore((s) => s.contextMenu);
  const setEditingAnnotationId = useEditorStore((s) => s.setEditingAnnotationId);
  const selectAnnotation = useEditorStore((s) => s.selectAnnotation);
  const canvasMode = useEditorStore((s) => s.canvasMode);
  const annotationLinkDrag = useEditorStore((s) => s.annotationLinkDrag);
  const updateAnnotationLinkDrag = useEditorStore((s) => s.updateAnnotationLinkDrag);
  const endAnnotationLinkDrag = useEditorStore((s) => s.endAnnotationLinkDrag);
  // Search state (F402)
  const searchQuery = useEditorStore((s) => s.searchQuery);

  // VS Code API for sending messages directly (edge deletion)
  const vscode = useVsCodeApi();

  // Track Shift key state for pan/selection mode switching.
  // React Flow's built-in selectionKeyCode uses useKeyPress which may not
  // receive keyboard events reliably inside VS Code webview iframes.
  const [shiftHeld, setShiftHeld] = useState(false);
  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.key === 'Shift') setShiftHeld(true); };
    const up = (e: KeyboardEvent) => { if (e.key === 'Shift') setShiftHeld(false); };
    // Also reset on blur (e.g. user Shift-tabs away from the webview)
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

  // F405: Column expansion state (persisted in Zustand store via useStatePersistence)
  const { isExpanded, toggleExpansion, collapseAll, expandAll, allExpanded } = useColumnExpansion();
  // Check synchronously on mount if we have persisted expansion state.
  // Used to distinguish "first ever load" from "returning after tab switch".
  const [hadPersistedExpansion] = useState(() => {
    const s = vscode.getState() as { expandedNodes?: string[] } | null | undefined;
    return s?.expandedNodes !== undefined;
  });

  // State persistence (zoom, pan, selection, mode, detail panel, expansion)
  const { shouldSkipFitView, invalidSelectedNode, persistedViewport } =
    useStatePersistence();
  const reactFlowInstance = useReactFlow();
  const { setViewport: setReactFlowViewport, screenToFlowPosition } = reactFlowInstance;

  // Toast notification for invalid selection after restore
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  // Store-level toast (raised by components such as the Toolbar on layout failure)
  const storeToastMessage = useEditorStore((s) => s.toastMessage);
  const setStoreToastMessage = useEditorStore((s) => s.setToastMessage);

  useEffect(() => {
    if (invalidSelectedNode) {
      setToastMessage(
        `Previously selected model "${invalidSelectedNode}" no longer exists.`,
      );
    }
  }, [invalidSelectedNode]);

  // Memoized callback for toast dismissal (prevents timer re-creation)
  const dismissToast = useCallback(() => {
    setToastMessage(null);
    setStoreToastMessage(null);
  }, [setStoreToastMessage]);
  const activeToastMessage = toastMessage ?? storeToastMessage;

  // F405: Auto-expand columns on first-ever domain load.
  // This effect runs AFTER useStatePersistence's restore effect (React guarantees
  // effects execute in declaration order within a component). On first-ever load
  // (no persisted state), expand all if below NODE_THRESHOLD. On restoration
  // (persisted state exists), skip auto-expand entirely — the persisted state
  // is the source of truth for which models are expanded.
  const hasAutoExpandedRef = useRef(false);
  useEffect(() => {
    if (!domain || hasAutoExpandedRef.current) return;
    hasAutoExpandedRef.current = true;

    // If we have persisted expansion state, trust it — don't auto-expand.
    // This preserves "Collapse All" intent across tab switches.
    if (hadPersistedExpansion) return;

    // First ever session: expand all if below node threshold for better UX.
    if (domain.models.length < NODE_THRESHOLD) {
      expandAll(domain.models.map((m) => m.name));
    }
  }, [domain, hadPersistedExpansion, expandAll]);

  // Discrepancy state
  const setDiscrepancyReport = useEditorStore((s) => s.setDiscrepancyReport);
  const discrepancyReport = useEditorStore((s) => s.discrepancyReport);
  const discrepancyVisible = useEditorStore((s) => s.discrepancyVisible);
  const setManifestStale = useEditorStore((s) => s.setManifestStale);
  const setSyncPlanGenerated = useEditorStore((s) => s.setSyncPlanGenerated);

  const onMessage = useCallback(
    (msg: ExtensionMessage) => {
      switch (msg.type) {
        case 'domainLoaded':
          applyDomainPayload(msg.payload);
          if (!msg.welcomeDismissed) {
            useEditorStore.getState().setWelcomeModalOpen(true);
          }
          break;
        case 'stageData':
          // A reply for a stage the user has since switched away from — drop it
          // so the canvas never flips back to the wrong stage.
          if (isStaleStageReply(msg.requestId)) break;
          applyDomainPayload(msg.payload);
          break;
        case 'discrepancyReport':
          setDiscrepancyReport(msg.payload);
          break;
        case 'manifestStaleness':
          setManifestStale(msg.payload.isStale);
          break;
        case 'syncPlanGenerated':
          setSyncPlanGenerated(msg.payload);
          break;
        case 'error':
          useEditorStore.getState().recordError('extension', msg.payload.message);
          setError(msg.payload.message);
          break;
        case 'openBugReport':
          useEditorStore.getState().setBugReportDialogOpen(true, msg.payload ?? null);
          break;
      }
    },
    [setError, setDiscrepancyReport, setManifestStale, setSyncPlanGenerated],
  );

  useMessageBus(onMessage, /* sendReadyOnMount */ true);

  // Detect orphaned-canvas state: if `domainLoaded` doesn't arrive within
  // the boot grace period, the extension host probably can't reach this
  // panel (typically because it was updated/restarted while the panel was
  // open). Activation-time auto-recovery in the host should usually fix
  // this before the overlay ever shows — this is a safety net for edge
  // cases like extension disable/enable mid-session.
  const [showReconnectOverlay, setShowReconnectOverlay] = useState(false);
  useEffect(() => {
    if (domain) return;
    const overlayTimer = window.setTimeout(() => {
      setShowReconnectOverlay(true);
    }, 5000);
    return () => clearTimeout(overlayTimer);
  }, [domain]);

  const handleReconnect = useCallback(() => {
    vscode.postMessage({ type: 'requestReload' });
  }, [vscode]);

  // Initial-load failure recovery: clear the error and ask the host for the
  // domain again (same handshake as first mount).
  const handleRetryLoad = useCallback(() => {
    setError(null);
    vscode.postMessage({ type: 'ready' });
  }, [setError, vscode]);

  // Host error toast dismissal (canvas stays mounted; see render below)
  const dismissError = useCallback(() => setError(null), [setError]);

  // Global keyboard shortcuts (Escape, Delete/Backspace, Ctrl+F, copy/paste
  // notes, F2, Shift+L, Shift+?, V/S, Alt+1/2). Registered once — the hook
  // reads store state via getState() rather than closing over selectors.
  useCanvasShortcuts();

  // Get current selectedNode from store to preserve selection across domain updates
  const currentSelectedNode = useEditorStore((s) => s.selectedNode);

  // Initialize nodes and edges when the domain (or discrepancy overlay) changes.
  // Preserve visual selection if the selected node still exists.
  // Clear stale edge selections that no longer exist.
  //
  // Selection / search / expansion are NOT dependencies here — they are
  // applied by the lightweight overlay effect below. Re-running the full
  // transform on every click used to rebuild every node/edge object (defeating
  // memo) and drop `measured`, forcing React Flow to re-measure all nodes.
  useEffect(() => {
    if (domain) {
      const state = useEditorStore.getState();
      const prevById = new Map(state.nodes.map((n) => [n.id, n]));

      // Measured sizes from the current React Flow state — used both for
      // centre-based handle side selection and to carry `measured` across
      // the rebuild so React Flow does not re-measure unchanged nodes.
      const nodeDimensions = new Map<string, { width: number; height: number }>();
      for (const n of state.nodes) {
        if (n.measured?.width != null && n.measured?.height != null) {
          nodeDimensions.set(n.id, { width: n.measured.width, height: n.measured.height });
        }
      }
      const isExpandedNow = (id: string) => state.allExpanded || state.expandedNodes.has(id);

      const transformOptions = {
        ...(discrepancyVisible && discrepancyReport ? { discrepancyReport } : {}),
        nodeDimensions,
        isExpanded: isExpandedNow,
      };
      let { nodes: newNodes, edges: newEdges } = transformDomain(domain, transformOptions);

      // Carry measured dimensions over from the previous nodes.
      newNodes = newNodes.map((n) => {
        const prev = prevById.get(n.id);
        return prev?.measured?.width != null && prev.measured.height != null
          ? { ...n, measured: prev.measured }
          : n;
      });

      // F402 search dimming, selection dimming, F405 column expansion.
      ({ nodes: newNodes, edges: newEdges } = applyNodeOverlays(newNodes, newEdges, {
        selectedNode: state.selectedNode,
        selectedEdge: state.selectedEdge,
        searchQuery: state.searchQuery,
        isExpanded: isExpandedNow,
        toggleExpansion,
      }));

      // Preserve React Flow's current selection across this rebuild.
      // Without this, any store change that re-triggers this effect wipes the
      // multi-selection React Flow just applied via applyNodeChanges. Read store
      // state directly to avoid adding `nodes` to the dep array (which would
      // cause an infinite loop since we call setNodes below).
      const preserveSelected = new Set<string>();
      if (state.selectedNode) preserveSelected.add(state.selectedNode);
      for (const n of state.nodes) {
        if (n.selected) preserveSelected.add(n.id);
      }
      if (preserveSelected.size > 0) {
        newNodes = newNodes.map((n) => preserveSelected.has(n.id) ? { ...n, selected: true } : n);
      }

      // Clear stale edge selections (edges that no longer exist after domain update)
      const newEdgeIds = new Set(newEdges.map((e) => e.id));
      const currentSelectedEdges = state.selectedEdges;
      if (currentSelectedEdges.length > 0) {
        const validEdges = currentSelectedEdges.filter((id) => newEdgeIds.has(id));
        if (validEdges.length !== currentSelectedEdges.length) {
          setSelectedEdges(validEdges);
        }
      }
      if (state.selectedEdge && !newEdgeIds.has(state.selectedEdge)) {
        setSelectedEdge(null);
      }

      setNodes(newNodes);
      setEdges(newEdges);
    }
  }, [domain, setNodes, setEdges, setSelectedEdges, setSelectedEdge, toggleExpansion, discrepancyVisible, discrepancyReport]);

  // Lightweight overlay pass: update only the `dimmed` / `isExpanded` flags on
  // the nodes and edges already in the store when selection, search or column
  // expansion changes. Unchanged nodes keep their object identity so memoised
  // components skip re-rendering and React Flow keeps its measurements.
  useEffect(() => {
    const { nodes: currentNodes, edges: currentEdges } = useEditorStore.getState();
    if (currentNodes.length === 0) return;
    const result = applyNodeOverlays(currentNodes, currentEdges, {
      selectedNode: currentSelectedNode,
      selectedEdge,
      searchQuery,
      isExpanded,
      toggleExpansion,
    });
    if (result.nodes !== currentNodes) setNodes(result.nodes);
    if (result.edges !== currentEdges) setEdges(result.edges);
  }, [currentSelectedNode, selectedEdge, searchQuery, isExpanded, toggleExpansion, setNodes, setEdges]);

  // Apply persisted viewport after nodes are loaded (React Flow needs nodes first)
  const hasAppliedViewportRef = useRef(false);
  useEffect(() => {
    if (nodes.length > 0 && persistedViewport && !hasAppliedViewportRef.current) {
      hasAppliedViewportRef.current = true;
      // Use setTimeout to ensure React Flow has finished rendering
      setTimeout(() => {
        setReactFlowViewport(persistedViewport);
      }, 0);
    }
  }, [nodes.length, persistedViewport, setReactFlowViewport]);

  // Position persistence and selection handling.
  const { onNodesChange } = usePositionPersistence();

  const onMoveEnd = useCallback(
    (_event: MouseEvent | TouchEvent | null, viewport: Viewport) => {
      setViewport(viewport);
    },
    [setViewport],
  );

  // Handle node clicks to open the detail panel (model nodes) or select (annotations).
  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: ModelFlowNode | AnnotationFlowNode) => {
      if (node.type === 'annotation') {
        const annData = (node as AnnotationFlowNode).data;
        selectAnnotation(annData.annotationId);
        return;
      }
      selectNode(node.id);
      setDetailPanelOpen(true);
      setHighlightedColumns(new Set());
      setSelectedEdge(null);
    },
    [selectNode, selectAnnotation, setDetailPanelOpen, setHighlightedColumns, setSelectedEdge],
  );

  // Handle edge clicks to highlight the FK columns involved and dim unrelated nodes/edges.
  const onEdgeClick = useCallback(
    (_event: React.MouseEvent, edge: FkFlowEdge | AnnotationFlowEdge) => {
      if (edge.type !== 'fk') return; // Annotation link edges are not interactive
      if (edge.data) {
        const cols = new Set<string>();
        cols.add(`${edge.data.fromModel}:${edge.data.fromColumn}`);
        cols.add(`${edge.data.toModel}:${edge.data.toColumn}`);
        setHighlightedColumns(cols);
        // Clear node selection and activate edge dimming
        selectNode(null);
        setDetailPanelOpen(false);
        setSelectedEdge(edge.id);
      }
    },
    [setHighlightedColumns, selectNode, setDetailPanelOpen, setSelectedEdge],
  );

  // Handle clicks on blank canvas to close the detail panel and clear selection.
  const onPaneClick = useCallback(() => {
    setDetailPanelOpen(false);
    selectNode(null);
    selectAnnotation(null);
    setHighlightedColumns(new Set());
    setSelectedEdge(null);
  }, [setDetailPanelOpen, selectNode, selectAnnotation, setHighlightedColumns, setSelectedEdge]);

  // Close detail panel when multi-selecting (selection mismatch with single-node panel).
  // But don't close if the selection reset was caused by a domain update (nodes recreated).
  // Also track edge selection for keyboard shortcuts.
  const onSelectionChange: OnSelectionChangeFunc = useCallback(
    ({ nodes: selectedNodes, edges: selectedEdgesInFlow }) => {
      // Track edge selection in store for keyboard shortcuts
      setSelectedEdges(selectedEdgesInFlow.map((e) => e.id));

      if (selectedNodes.length !== 1) {
        // Don't interfere if an edge dimming selection is active (onEdgeClick handles state)
        if (selectedEdge !== null) return;

        // Check if our stored selection still exists in the domain
        // If so, this is likely a domain update, not a user deselection
        if (currentSelectedNode && domain?.models.some((m) => m.name === currentSelectedNode)) {
          // Keep the panel open - the node still exists, selection was just reset by React Flow
          return;
        }
        setDetailPanelOpen(false);
        selectNode(null);
      }
    },
    [selectNode, setDetailPanelOpen, setSelectedEdges, currentSelectedNode, selectedEdge, domain],
  );

  // Handle long-press column drag to create relationships.
  // Listens for custom events dispatched by ColumnRow in ModelNode.
  // Disabled in read-only mode (physical stage).
  useEffect(() => {
    if (domain?.readOnly) return;

    const handleColumnRelationshipDrop = (e: Event) => {
      const { fromModel, fromColumn, toModel, toColumn } = (e as CustomEvent).detail;
      openFkDialogWithPrefill({ fromModel, fromColumn, toModel, toColumn });
    };

    const handleColumnRelationshipSelfDrop = () => {
      setToastMessage('Cannot create relationship from a model to itself');
    };

    window.addEventListener('column-relationship-drop', handleColumnRelationshipDrop);
    window.addEventListener('column-relationship-self-drop', handleColumnRelationshipSelfDrop);

    return () => {
      window.removeEventListener('column-relationship-drop', handleColumnRelationshipDrop);
      window.removeEventListener('column-relationship-self-drop', handleColumnRelationshipSelfDrop);
    };
  }, [openFkDialogWithPrefill, setToastMessage, domain?.readOnly]);

  // Handle annotation drag-to-link: mouse move updates the drag line,
  // mouse up on a model node completes the link.
  useEffect(() => {
    if (!annotationLinkDrag) return;

    const handleMouseMove = (e: MouseEvent) => {
      updateAnnotationLinkDrag(e.clientX, e.clientY);
    };

    const handleMouseUp = (e: MouseEvent) => {
      // Check if we dropped on a model node
      const target = document.elementFromPoint(e.clientX, e.clientY);
      const modelNode = target?.closest('.react-flow__node-model');
      if (modelNode) {
        const modelId = modelNode.getAttribute('data-id');
        if (modelId) {
          vscode.postMessage({
            type: 'updateAnnotation',
            payload: { id: annotationLinkDrag.annotationId, linkedModel: modelId },
          });
        }
      }
      endAnnotationLinkDrag();
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [annotationLinkDrag, updateAnnotationLinkDrag, endAnnotationLinkDrag, vscode]);

  // Handle double-click on blank canvas to create a new annotation.
  // Robust detection: accept dblclicks anywhere EXCEPT inside a node, edge, or
  // floating React Flow panel (MiniMap, Controls, Toolbar). This lets dblclicks
  // on the background dots/grid still create a note, which the stricter
  // `classList.contains('react-flow__pane')` check would drop.
  const onPaneDoubleClick = useCallback(
    (event: React.MouseEvent) => {
      if (domain?.readOnly) return;
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (
        target.closest(
          '.react-flow__node, .react-flow__edge, .react-flow__panel, .react-flow__minimap, .react-flow__controls',
        )
      ) {
        return;
      }

      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const id = crypto.randomUUID();
      vscode.postMessage({
        type: 'addAnnotation',
        payload: { id, text: '', x: Math.round(position.x), y: Math.round(position.y) },
      });
      setEditingAnnotationId(id);
    },
    [domain?.readOnly, screenToFlowPosition, vscode, setEditingAnnotationId],
  );

  // Handle right-click on nodes (model or annotation) to show context menu
  const onNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: ModelFlowNode | AnnotationFlowNode) => {
      event.preventDefault();
      if (node.type === 'annotation') {
        const annData = (node as AnnotationFlowNode).data;
        openAnnotationContextMenu(event.clientX, event.clientY, annData.annotationId);
      } else {
        const modelData = (node as ModelFlowNode).data;
        openNodeContextMenu(event.clientX, event.clientY, modelData.modelName);
      }
    },
    [openAnnotationContextMenu, openNodeContextMenu],
  );

  // Handle right-click on edges to show context menu (F401)
  const onEdgeContextMenu = useCallback(
    (event: React.MouseEvent, edge: FkFlowEdge | AnnotationFlowEdge) => {
      event.preventDefault();
      if (edge.type !== 'fk') return; // Annotation link edges don't have context menu
      const fkData = edge.data as NonNullable<FkFlowEdge['data']>;
      if (fkData) {
        openEdgeContextMenu(event.clientX, event.clientY, fkData);
      }
    },
    [openEdgeContextMenu],
  );

  // Close context menu on pane click
  const handlePaneClick = useCallback(() => {
    closeContextMenu();
    onPaneClick();
  }, [closeContextMenu, onPaneClick]);

  // --- Error state -----------------------------------------------------------
  // Only an error with no domain to fall back on (initial load failure) takes
  // over the whole editor. Once a domain has loaded, host errors are surfaced
  // as a dismissable toast over the live canvas (see below) and are cleared
  // automatically by the next domainLoaded / domainUpdated / stageData.

  if (error && !domain) {
    return (
      <div className="editor-message editor-message--error" role="alert">
        <p style={{ color: 'var(--error-fg)' }}>Error: {error}</p>
        <button
          type="button"
          className="editor-message__retry"
          onClick={handleRetryLoad}
        >
          Retry
        </button>
        <button
          type="button"
          className="editor-message__button"
          onClick={() => setBugReportDialogOpen(true, { description: `Error shown on canvas: ${error}` })}
        >
          Report a Bug
        </button>
        <BugReportDialog />
      </div>
    );
  }

  // --- Loading state ---------------------------------------------------------

  if (!domain) {
    return (
      <>
        <div className="editor-message">
          <p>Loading domain&hellip;</p>
        </div>
        {showReconnectOverlay && <ReconnectOverlay onReload={handleReconnect} />}
      </>
    );
  }

  // --- Graph canvas ----------------------------------------------------------

  const selectModeActive = canvasMode === 'select' && !domain.readOnly;
  return (
    <div
      className={`editor-canvas${selectModeActive ? ' editor-canvas--select-mode' : ''}`}
      style={{ width: '100%', height: '100%' }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={onNodeClick}
        onEdgeClick={onEdgeClick}
        onPaneClick={handlePaneClick}
        onDoubleClick={onPaneDoubleClick}
        onNodeContextMenu={onNodeContextMenu}
        onSelectionChange={onSelectionChange}
        onMoveEnd={onMoveEnd}
        onEdgeContextMenu={onEdgeContextMenu}
        fitView={!shouldSkipFitView}
        minZoom={0.05}
        selectionMode={SelectionMode.Partial}
        zoomOnDoubleClick={domain.readOnly}
        nodesDraggable={domain.positionDraggable ?? !domain.readOnly}
        panOnDrag={!selectModeActive && !shiftHeld}
        selectionOnDrag={(selectModeActive || shiftHeld) && !domain.readOnly}
        selectionKeyCode={null}
        multiSelectionKeyCode="Shift"
        deleteKeyCode={null}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        <MiniMap
          position="bottom-right"
          pannable
          zoomable
          nodeColor={(node) => {
            if (node.type === 'annotation') {
              const colorMap: Record<string, string> = {
                yellow: '#f59e0b', blue: '#3b82f6', green: '#22c55e',
                pink: '#ec4899', orange: '#f97316',
              };
              return colorMap[(node as AnnotationFlowNode).data.color] ?? '#f59e0b';
            }
            const d = (node as ModelFlowNode).data;
            return stageNodeColor(d.stage, d.isGhost);
          }}
          maskColor="rgba(0, 0, 0, 0.2)"
          style={{
            background: 'var(--panel-bg)',
            border: '1px solid var(--panel-border)',
            borderRadius: '4px',
          }}
        />
        <Toolbar
          nodes={nodes}
          edges={edges}
          allExpanded={allExpanded}
          onExpandAll={() => expandAll(nodes.filter((n) => n.type === 'model').map((n) => n.id))}
          onCollapseAll={collapseAll}
        />
        <StatusBar />
        <DetailPanel />
        <NewModelDialog />
        <NewFkDialog />
        <AddExistingModelDialog />
      </ReactFlow>

      {activeToastMessage && (
        <Toast message={activeToastMessage} variant="warning" onDismiss={dismissToast} />
      )}

      {/* Host error surfaced over the live canvas. Sticky until dismissed or the
          next domain payload clears it (setDomain resets error). */}
      {error && (
        <Toast message={error} variant="error" autoDismissMs={null} onDismiss={dismissError} />
      )}

      {/* Drag line for column relationship creation */}
      <DragLine />

      {/* Edge context menu (F401) */}
      {contextMenu && <ContextMenu />}

      {/* Discrepancy summary panel (bottom-right, avoids legend overlap) */}
      <DiscrepancyPanel />

      {/* Sync merge modal — full-screen takeover when sync mode is active */}
      <SyncMergeModal />

      {/* Legend panel (bottom-left) */}
      <Legend />

      {/* Welcome modal (first-time users) */}
      <WelcomeModal />

      {/* Report a Bug dialog */}
      <BugReportDialog />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root export
// ---------------------------------------------------------------------------

export function App() {
  // Capture uncaught webview errors so bug reports can include them.
  useEffect(() => {
    const record = useEditorStore.getState().recordError;
    const onError = (e: ErrorEvent) => record('window', e.message);
    const onRejection = (e: PromiseRejectionEvent) =>
      record('promise', e.reason instanceof Error ? e.reason.message : String(e.reason));
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);

  return (
    <ReactFlowProvider>
      <EditorCanvas />
    </ReactFlowProvider>
  );
}
