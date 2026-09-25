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
  SelectionMode,
  type Viewport,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './App.css';

import { useMessageBus, type ExtensionMessage } from './hooks/useMessageBus';
import { usePositionPersistence } from './hooks/usePositionPersistence';
import { useStatePersistence } from './hooks/useStatePersistence';
import { useVsCodeApi } from './hooks/useVsCodeApi';
import {
  useColumnExpansion,
  NODE_THRESHOLD,
  useCanvasGraph,
  CanvasBackdrop,
  canvasNodeTypes,
  canvasEdgeTypes,
  CanvasStoreProvider,
  CanvasEnvironmentProvider,
  DetailPanel,
  Legend,
  type ModelFlowNode,
  type FkFlowEdge,
  type AnnotationFlowNode,
  type AnnotationFlowEdge,
} from '@erd-studio/renderer/editor';
import { isStaleStageReply } from './lib/stageRequest';
import { useEditorStore, editorStoreApi } from './store/editorStore';
import { vscodeCanvasHost } from './host/vscodeCanvasHost';
import { DragLine } from './components/Graph/DragLine';
import { Toolbar } from './components/Toolbar/Toolbar';
import { StatusBar } from './components/Toolbar/StatusBar';
import { NewModelDialog } from './components/NewModelDialog/NewModelDialog';
import { NewFkDialog } from './components/NewFkDialog/NewFkDialog';
import { AddExistingModelDialog } from './components/AddExistingModelDialog/AddExistingModelDialog';
import { Toast } from './components/Toast/Toast';
import { ContextMenu } from './components/ContextMenu/ContextMenu';
import { PhysicalSourceNotice } from './components/Canvas/PhysicalSourceNotice';
import { DiscrepancyPanel } from './components/DiscrepancyPanel/DiscrepancyPanel';
import { WelcomeModal } from './components/WelcomeModal/WelcomeModal';
import { FeedbackDialog } from './components/FeedbackDialog/FeedbackDialog';
import { SyncMergeModal } from './components/SyncMergeModal/SyncMergeModal';
import { ReconnectOverlay } from './components/ReconnectOverlay/ReconnectOverlay';
import { useCanvasShortcuts } from './hooks/useCanvasShortcuts';
import type { DisplayDomain } from '../src/types/display';
import { redactPaths } from '../src/types/feedback';

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

function EditorCanvas() {
  const domain = useEditorStore((s) => s.domain);
  const error = useEditorStore((s) => s.error);
  const errorKind = useEditorStore((s) => s.errorKind);
  const nodes = useEditorStore((s) => s.nodes);
  const edges = useEditorStore((s) => s.edges);
  const setError = useEditorStore((s) => s.setError);
  const setViewport = useEditorStore((s) => s.setViewport);
  const setFeedbackDialogOpen = useEditorStore((s) => s.setFeedbackDialogOpen);
  const openFkDialogWithPrefill = useEditorStore((s) => s.openFkDialogWithPrefill);
  // Context menu state
  const openEdgeContextMenu = useEditorStore((s) => s.openEdgeContextMenu);
  const openNodeContextMenu = useEditorStore((s) => s.openNodeContextMenu);
  const openAnnotationContextMenu = useEditorStore((s) => s.openAnnotationContextMenu);
  const closeContextMenu = useEditorStore((s) => s.closeContextMenu);
  const contextMenu = useEditorStore((s) => s.contextMenu);
  const setEditingAnnotationId = useEditorStore((s) => s.setEditingAnnotationId);
  const canvasMode = useEditorStore((s) => s.canvasMode);
  const annotationLinkDrag = useEditorStore((s) => s.annotationLinkDrag);
  const updateAnnotationLinkDrag = useEditorStore((s) => s.updateAnnotationLinkDrag);
  const endAnnotationLinkDrag = useEditorStore((s) => s.endAnnotationLinkDrag);

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
  const { collapseAll, expandAll, allExpanded } = useColumnExpansion();
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
          // Set on a fresh domain (no stored positions), cleared by every other
          // payload — a later load without the flag cancels a pending layout.
          useEditorStore.getState().setPendingAutoLayout(msg.autoLayout === true);
          if (!msg.welcomeDismissed) {
            useEditorStore.getState().setWelcomeModalOpen(true);
          }
          break;
        case 'stageData':
          // A reply for a stage the user has since switched away from — drop it
          // so the canvas never flips back to the wrong stage.
          if (isStaleStageReply(msg.requestId)) break;
          applyDomainPayload(msg.payload);
          // Stage replies never ask for the first-open layout.
          useEditorStore.getState().setPendingAutoLayout(false);
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
          setError(msg.payload.message, msg.payload.kind);
          break;
        case 'openFeedback':
          useEditorStore.getState().setFeedbackDialogOpen(true, msg.payload ?? null);
          break;
        case 'feedbackContext':
          useEditorStore
            .getState()
            .setFeedbackContext(msg.payload.diagnostics, msg.payload.capabilities);
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

  // Open the underlying JSON in VS Code's text editor — the only way to repair
  // a domain file the canvas cannot parse, and the right home for a template.
  const handleOpenFile = useCallback(() => {
    vscode.postMessage({ type: 'viewFile' });
  }, [vscode]);

  // Host error toast dismissal (canvas stays mounted; see render below)
  const dismissError = useCallback(() => setError(null), [setError]);

  // Global keyboard shortcuts (Escape, Delete/Backspace, Ctrl+F, copy/paste
  // notes, F2, Shift+L, Shift+?, V/S, Alt+1/2). Registered once — the hook
  // reads store state via getState() rather than closing over selectors.
  useCanvasShortcuts();

  // Nodes/edges from the domain (transform + overlay effects) and the
  // click/selection handlers — the shared canvas core in @erd-studio/renderer.
  const { onNodeClick, onEdgeClick, onPaneClick, onSelectionChange } = useCanvasGraph({ discrepancyVisible, discrepancyReport });

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
    // `not-a-domain` is settled: this JSON is a template or lives in a
    // reserved directory, and no amount of retrying turns it into a domain.
    // Offering Retry there would be an invitation to press a button that
    // cannot work. Opening it as text is the action that does.
    const canRetry = errorKind !== 'not-a-domain';
    // The user is the only one who can repair a domain file, so give them a
    // way to see it. Issue #64 dead-ended precisely here: an unparseable file,
    // named in the message, with no route to it.
    const canOpenFile = errorKind === 'domain-file' || errorKind === 'not-a-domain';
    return (
      <div className="editor-message editor-message--error" role="alert">
        <p style={{ color: 'var(--error-fg)' }}>Error: {error}</p>
        {canRetry && (
          <button
            type="button"
            className="editor-message__retry"
            onClick={handleRetryLoad}
          >
            Retry
          </button>
        )}
        {canOpenFile && (
          <button
            type="button"
            className="editor-message__button"
            onClick={handleOpenFile}
          >
            Open as Text
          </button>
        )}
        <button
          type="button"
          className="editor-message__button"
          onClick={() => setFeedbackDialogOpen(true, { kind: 'bug', description: `Error shown on canvas: ${redactPaths(error)}` })}
        >
          Report a Bug
        </button>
        <FeedbackDialog />
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
      // Column flex so the physical-source notice is a strip ABOVE the flow
      // area rather than an overlay on top of the nodes. With the notice
      // hidden this is a one-child flex container — i.e. unchanged.
      style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}
    >
      {/* "dbt has not been compiled" strip. Renders nothing on the logical
          stage or when any dbt artifact was found. */}
      <PhysicalSourceNotice />

      <ReactFlow
        // flex basis 0 rather than the default height:100%, so the notice's
        // height comes off the flow area instead of overflowing the editor.
        style={{ flex: '1 1 0', minHeight: 0 }}
        nodes={nodes}
        edges={edges}
        nodeTypes={canvasNodeTypes}
        edgeTypes={canvasEdgeTypes}
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
        <CanvasBackdrop />
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

      {/* Feedback dialog (bug reports and feature requests) */}
      <FeedbackDialog />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root export
// ---------------------------------------------------------------------------

export function App() {
  // Capture uncaught webview errors so feedback reports can include them.
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
    <CanvasStoreProvider store={editorStoreApi}>
      <CanvasEnvironmentProvider host={vscodeCanvasHost}>
        <ReactFlowProvider>
          <EditorCanvas />
        </ReactFlowProvider>
      </CanvasEnvironmentProvider>
    </CanvasStoreProvider>
  );
}
