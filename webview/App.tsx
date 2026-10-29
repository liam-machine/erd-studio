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
  type TableFlowNode,
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
import { NewTableDialog } from './components/NewModelDialog/NewModelDialog';
import { NewFkDialog } from './components/NewFkDialog/NewFkDialog';
import { AddExistingTableDialog } from './components/AddExistingModelDialog/AddExistingModelDialog';
import { Toast } from './components/Toast/Toast';
import { ContextMenu } from './components/ContextMenu/ContextMenu';
import { PhysicalSourceNotice } from './components/Canvas/PhysicalSourceNotice';
import { ManifestHint } from './components/Canvas/ManifestHint';
import { EmbeddedTablesBanner } from './components/Canvas/EmbeddedTablesBanner';
import { EmptyCanvas } from './components/EmptyCanvas/EmptyCanvas';
import { DiscrepancyPanel } from './components/DiscrepancyPanel/DiscrepancyPanel';
import { WelcomeModal } from './components/WelcomeModal/WelcomeModal';
import { FeedbackDialog } from './components/FeedbackDialog/FeedbackDialog';
import { SyncMergeModal } from './components/SyncMergeModal/SyncMergeModal';
import { ReconnectOverlay } from './components/ReconnectOverlay/ReconnectOverlay';
import { LOADING_STALL_MS, RECONNECT_GRACE_MS, useReconnectWatchdog } from './hooks/useReconnectWatchdog';
import { useCanvasShortcuts } from './hooks/useCanvasShortcuts';
import type { DisplaySubjectArea } from '../src/types/display';
import { redactPaths } from '../src/types/feedback';
import { orientDraggedRelationship } from './lib/relationshipDirection';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Load a display-domain payload into the store. Shared by `domainLoaded`
 * (initial load / host refresh) and `stageData` (stage switch reply).
 */
function applySubjectAreaPayload(payload: DisplaySubjectArea): void {
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
  const errorMergeConflict = useEditorStore((s) => s.errorMergeConflict);
  const errorFileProblem = useEditorStore((s) => s.errorFileProblem);
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
        `Previously selected table "${invalidSelectedNode}" no longer exists.`,
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

  // The host's `loading` answer (and the table count it carries) until the
  // diagram or an error arrives: proof the host is connected.
  const [hostLoading, setHostLoading] = useState<{ tables?: number } | null>(null);

  const onMessage = useCallback(
    (msg: ExtensionMessage) => {
      switch (msg.type) {
        case 'loading':
          setHostLoading({ ...(typeof msg.payload?.tables === 'number' ? { tables: msg.payload.tables } : {}) });
          break;
        case 'existingTables':
          useEditorStore.getState().setManifestModels(msg.payload.manifestModels);
          useEditorStore.getState().setExistingModels(msg.payload.existingModels);
          break;
        case 'domainLoaded':
          setHostLoading(null);
          applySubjectAreaPayload(msg.payload);
          // Set on a fresh domain (no stored positions), cleared by every other
          // payload — a later load without the flag cancels a pending layout.
          useEditorStore.getState().setPendingAutoLayout(msg.autoLayout === true);
          // Follows every payload: one without the flag (dbt has since run)
          // hides the logical "Run dbt parse" hint.
          useEditorStore.getState().setManifestMissing(msg.manifestMissing === true);
          // The import banner follows the host: it re-sends it after each load that needs it.
          useEditorStore.getState().setEmbeddedTables(false);
          // No dbt project: no Physical tab, no Diff. Absent means today's
          // behaviour, so an older host keeps both.
          useEditorStore.getState().setLogicalOnly(msg.logicalOnly === true);
          // "The Two Stages" explains a tab the user cannot see, so it waits
          // (undismissed) until they open a dbt project.
          if (!msg.welcomeDismissed && msg.logicalOnly !== true) {
            useEditorStore.getState().setWelcomeModalOpen(true);
          }
          break;
        case 'stageData':
          // A reply for a stage the user has since switched away from — drop it
          // so the canvas never flips back to the wrong stage.
          if (isStaleStageReply(msg.requestId)) break;
          setHostLoading(null);
          applySubjectAreaPayload(msg.payload);
          // Stage replies never ask for the first-open layout.
          useEditorStore.getState().setPendingAutoLayout(false);
          useEditorStore.getState().setManifestMissing(msg.manifestMissing === true);
          useEditorStore.getState().setLogicalOnly(msg.logicalOnly === true);
          break;
        case 'dbmlEmbeddedTables':
          useEditorStore.getState().setEmbeddedTables(true);
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
          setHostLoading(null);
          useEditorStore.getState().recordError('extension', msg.payload.message);
          setError(
            msg.payload.message,
            msg.payload.kind,
            msg.payload.mergeConflict === true,
            msg.payload.fileProblem
              ? {
                problem: msg.payload.fileProblem,
                line: msg.payload.line,
                column: msg.payload.column,
                ...(msg.payload.fileType ? { fileType: msg.payload.fileType } : {}),
              }
              : null,
          );
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

  // Detect orphaned-canvas state: if neither `loading`, `domainLoaded` nor
  // `error` arrives within the boot grace period, the extension host probably
  // can't reach this panel. An error is an answer, so it stops the timer; Retry
  // clears it and starts a fresh grace period (see useReconnectWatchdog).
  // `loading` is an answer too: the host is reading a large diagram, so the
  // canvas waits much longer before it suspects the connection.
  const showReconnectOverlay = useReconnectWatchdog(!domain && !error, hostLoading ? LOADING_STALL_MS : RECONNECT_GRACE_MS);

  const handleReconnect = useCallback(() => {
    vscode.postMessage({ type: 'requestReload' });
  }, [vscode]);

  // Open the ERD Studio output channel: what the host was doing, and how long it took.
  const handleShowLogs = useCallback(() => {
    vscode.postMessage({ type: 'showLogs' });
  }, [vscode]);

  // Initial-load failure recovery: clear the error and ask the host for the
  // domain again (same handshake as first mount).
  const handleRetryLoad = useCallback(() => {
    setError(null);
    setHostLoading(null);
    vscode.postMessage({ type: 'ready' });
  }, [setError, vscode]);

  // Open the underlying JSON in VS Code's text editor — the only way to repair
  // a domain file the canvas cannot parse, and the right home for a template.
  const handleOpenFile = useCallback(() => {
    vscode.postMessage({ type: 'viewFile' });
  }, [vscode]);

  // Open it with the cursor on the JSON mistake the error screen names (#186).
  const handleOpenFileAt = useCallback((line: number, column?: number) => {
    vscode.postMessage({ type: 'viewFile', payload: { line, ...(column !== undefined ? { column } : {}) } });
  }, [vscode]);

  // The "deleted or renamed" screen's two ways on (#161): close this tab, or
  // pick another diagram — a renamed copy is one pick away.
  const handleCloseEditor = useCallback(() => {
    vscode.postMessage({ type: 'closeEditor' });
  }, [vscode]);
  const handleOpenAnotherDomain = useCallback(() => {
    vscode.postMessage({ type: 'openAnotherDomain' });
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
  // Listens for custom events dispatched by ColumnRow in TableNode.
  // Disabled in read-only mode (physical stage).
  useEffect(() => {
    if (domain?.readOnly) return;

    const handleColumnRelationshipDrop = (e: Event) => {
      const { fromModel, fromColumn, toModel, toColumn } = (e as CustomEvent).detail;
      // A drag that starts on a key is turned round, so the column pointing
      // at the key is "from" — the many side, which stores it (#133).
      const models = useEditorStore.getState().domain?.models ?? [];
      openFkDialogWithPrefill(orientDraggedRelationship({ fromModel, fromColumn, toModel, toColumn }, models));
    };

    const handleColumnRelationshipSelfDrop = () => {
      setToastMessage("A column can't point at itself — drop it on another column of the same table to draw a self-reference.");
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
    (event: React.MouseEvent, node: TableFlowNode | AnnotationFlowNode) => {
      event.preventDefault();
      if (node.type === 'annotation') {
        const annData = (node as AnnotationFlowNode).data;
        openAnnotationContextMenu(event.clientX, event.clientY, annData.annotationId);
      } else {
        const modelData = (node as TableFlowNode).data;
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
  //
  // The one exception is a domain file that no longer exists (#161): it was
  // deleted or renamed outside ERD Studio, so the loaded diagram is stale and
  // nothing drawn on it can be saved. That screen replaces the canvas too,
  // until the file comes back and a fresh domain arrives.

  if (error && errorKind === 'domain-missing') {
    return (
      <div className="editor-message editor-message--error" role="alert">
        <p className="editor-message__title">This diagram&apos;s file was deleted or renamed</p>
        <p className="editor-message__detail">
          It was removed or renamed outside ERD Studio — by an AI assistant, a git checkout, the file explorer or
          another tool — so there is nothing left to draw, and nothing changed here could be saved. If the file
          comes back, the diagram reloads by itself.
        </p>
        <p className="editor-message__detail editor-message__detail--dim">{error}</p>
        <button type="button" className="editor-message__button" onClick={handleOpenAnotherDomain}>
          Open Another Diagram…
        </button>
        <button type="button" className="editor-message__button" onClick={handleCloseEditor}>
          Close
        </button>
      </div>
    );
  }

  // A domain file that is empty or not valid JSON (#186) is the user's file
  // to fix, not an ERD Studio fault: say so, say where, and offer the way to
  // the mistake — never Report a Bug. Like the conflict screen, the host
  // reloads the canvas by itself on the save that fixes it.
  if (error && !domain && errorKind === 'domain-file' && errorFileProblem) {
    const { problem, line, column } = errorFileProblem;
    // The file's own format (a `.dbml` diagram says DBML); older hosts send none, which is JSON.
    const fileType = errorFileProblem.fileType ?? 'JSON';
    return (
      <div className="editor-message editor-message--error" role="alert">
        {problem === 'syntax' ? (
          <>
            <p className="editor-message__title">This diagram&apos;s file isn&apos;t valid {fileType}</p>
            <p className="editor-message__detail">{error}</p>
            <p className="editor-message__detail">
              This is a problem in the file, not in ERD Studio — it is often left by a hand edit or an AI
              assistant. Fix it and save, and the diagram reloads by itself.
            </p>
          </>
        ) : (
          <>
            <p className="editor-message__title">This diagram&apos;s file is empty</p>
            <p className="editor-message__detail">{error}</p>
            <p className="editor-message__detail">
              If a tool or a git operation just emptied it, restore it (for example with{' '}
              <code>git checkout -- &lt;file&gt;</code>), or delete the file if you no longer need the diagram.
              Once it has content again, the diagram reloads by itself.
            </p>
          </>
        )}
        {problem === 'syntax' && line !== undefined ? (
          <button type="button" className="editor-message__button" onClick={() => handleOpenFileAt(line, column)}>
            Open at Line {line}
          </button>
        ) : (
          <button type="button" className="editor-message__button" onClick={handleOpenFile}>
            Open as Text
          </button>
        )}
        <button type="button" className="editor-message__button" onClick={handleRetryLoad}>
          Retry
        </button>
      </div>
    );
  }

  if (error && !domain) {
    // `not-a-domain` is settled: this JSON is a template or lives in a
    // reserved directory, and no amount of retrying turns it into a domain.
    // Offering Retry there would be an invitation to press a button that
    // cannot work. Opening it as text is the action that does.
    // A domain file holding git conflict markers (#145) is not corrupt, and
    // re-reading it cannot help either: someone has to keep one side. Say so
    // plainly, and skip Retry — the host reloads the canvas by itself on the
    // save that resolves it (every change to the document is re-read).
    const mergeConflict = errorKind === 'domain-file' && errorMergeConflict;
    const canRetry = errorKind !== 'not-a-domain' && !mergeConflict;
    // The user is the only one who can repair a domain file, so give them a
    // way to see it. Issue #64 dead-ended precisely here: an unparseable file,
    // named in the message, with no route to it.
    const canOpenFile = errorKind === 'domain-file' || errorKind === 'not-a-domain';
    return (
      <div className="editor-message editor-message--error" role="alert">
        {mergeConflict ? (
          <>
            <p className="editor-message__title">This diagram has unresolved git merge conflicts</p>
            <p className="editor-message__detail">
              Git left conflict markers in the file when two changes to it were merged. Open it as text and keep
              one side of each conflict — if only positions conflict, either side is safe. The diagram reloads by
              itself as soon as the file is saved.
            </p>
            <p className="editor-message__detail editor-message__detail--dim">{error}</p>
          </>
        ) : (
          <p style={{ color: 'var(--error-fg)' }}>Error: {error}</p>
        )}
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
            {mergeConflict ? 'Open as Text to Resolve' : 'Open as Text'}
          </button>
        )}
        <button
          type="button"
          className="editor-message__button"
          onClick={() => setFeedbackDialogOpen(true, { kind: 'bug', description: `Error shown on canvas: ${redactPaths(error)}` })}
        >
          Report a Bug
        </button>
        <button type="button" className="editor-message__button" onClick={handleShowLogs}>
          Show Logs
        </button>
        <FeedbackDialog />
      </div>
    );
  }

  // --- Loading state ---------------------------------------------------------

  if (!domain) {
    const tables = hostLoading?.tables;
    return (
      <>
        <div className={`editor-message${hostLoading ? ' editor-message--loading' : ''}`} role="status" aria-live="polite">
          {hostLoading && <span className="editor-message__spinner" aria-hidden="true" />}
          <p>{tables !== undefined && tables > 0 ? `Loading ${tables.toLocaleString()} ${tables === 1 ? 'table' : 'tables'}…` : 'Loading subject area…'}</p>
        </div>
        {showReconnectOverlay && <ReconnectOverlay onReload={handleReconnect} onShowLogs={handleShowLogs} />}
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
      {/* Logical-stage "Run dbt parse" hint (#113) — no manifest.json yet. */}
      <ManifestHint />
      {/* A single-file DBML dropped into a layer folder (§2.5): offer Import DBML. */}
      <EmbeddedTablesBanner />

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
        {/* "This diagram is empty" card — logical stage, zero models only. */}
        <EmptyCanvas />
        <Toolbar
          nodes={nodes}
          edges={edges}
          allExpanded={allExpanded}
          onExpandAll={() => expandAll(nodes.filter((n) => n.type === 'model').map((n) => n.id))}
          onCollapseAll={collapseAll}
        />
        <StatusBar />
        <DetailPanel />
        <NewTableDialog />
        <NewFkDialog />
        <AddExistingTableDialog />
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
