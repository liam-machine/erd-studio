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

import { useMessageBus, type ExtensionMessage } from './hooks/useMessageBus';
import { usePositionPersistence } from './hooks/usePositionPersistence';
import { useStatePersistence } from './hooks/useStatePersistence';
import { useVsCodeApi } from './hooks/useVsCodeApi';
import { useColumnExpansion, NODE_THRESHOLD } from './hooks/useColumnExpansion';
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
import { SyncMergeModal } from './components/SyncMergeModal/SyncMergeModal';
import { transformDomain } from './lib/graphTransformer';
import { stageNodeColor } from './lib/stageColors';
import type { ModelFlowNode, FkFlowEdge, AnnotationFlowNode, AnnotationFlowEdge } from './types/graph';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  const setDomain = useEditorStore((s) => s.setDomain);
  const setError = useEditorStore((s) => s.setError);
  const setViewport = useEditorStore((s) => s.setViewport);
  const setNodes = useEditorStore((s) => s.setNodes);
  const setEdges = useEditorStore((s) => s.setEdges);
  const selectNode = useEditorStore((s) => s.selectNode);
  const setDetailPanelOpen = useEditorStore((s) => s.setDetailPanelOpen);
  const setTemplates = useEditorStore((s) => s.setTemplates);
  const setManifestModels = useEditorStore((s) => s.setManifestModels);
  const setExistingModels = useEditorStore((s) => s.setExistingModels);
  const openFkDialogWithPrefill = useEditorStore((s) => s.openFkDialogWithPrefill);
  const selectedNode = useEditorStore((s) => s.selectedNode);
  const detailPanelOpen = useEditorStore((s) => s.detailPanelOpen);
  const setPendingDeleteConfirmation = useEditorStore((s) => s.setPendingDeleteConfirmation);
  const selectedEdges = useEditorStore((s) => s.selectedEdges);
  const setSelectedEdges = useEditorStore((s) => s.setSelectedEdges);
  const setHighlightedColumns = useEditorStore((s) => s.setHighlightedColumns);
  const selectedEdge = useEditorStore((s) => s.selectedEdge);
  const setSelectedEdge = useEditorStore((s) => s.setSelectedEdge);
  // Dialog state for Escape key handling
  const newModelDialogOpen = useEditorStore((s) => s.newModelDialogOpen);
  const newFkDialogOpen = useEditorStore((s) => s.newFkDialogOpen);
  const addExistingModelDialogOpen = useEditorStore((s) => s.addExistingModelDialogOpen);
  const setNewModelDialogOpen = useEditorStore((s) => s.setNewModelDialogOpen);
  const setNewFkDialogOpen = useEditorStore((s) => s.setNewFkDialogOpen);
  const setAddExistingModelDialogOpen = useEditorStore((s) => s.setAddExistingModelDialogOpen);
  const clearFkDialogPrefill = useEditorStore((s) => s.clearFkDialogPrefill);
  const clearFkDialogEditData = useEditorStore((s) => s.clearFkDialogEditData);
  // Context menu state
  const openEdgeContextMenu = useEditorStore((s) => s.openEdgeContextMenu);
  const openNodeContextMenu = useEditorStore((s) => s.openNodeContextMenu);
  const openAnnotationContextMenu = useEditorStore((s) => s.openAnnotationContextMenu);
  const closeContextMenu = useEditorStore((s) => s.closeContextMenu);
  const contextMenu = useEditorStore((s) => s.contextMenu);
  const setEditingAnnotationId = useEditorStore((s) => s.setEditingAnnotationId);
  const annotationLinkDrag = useEditorStore((s) => s.annotationLinkDrag);
  const updateAnnotationLinkDrag = useEditorStore((s) => s.updateAnnotationLinkDrag);
  const endAnnotationLinkDrag = useEditorStore((s) => s.endAnnotationLinkDrag);
  // Search state (F402)
  const searchQuery = useEditorStore((s) => s.searchQuery);
  const focusSearchInput = useEditorStore((s) => s.focusSearchInput);
  const triggerAutoLayout = useEditorStore((s) => s.triggerAutoLayout);
  // Legend state
  const legendOpen = useEditorStore((s) => s.legendOpen);
  const setLegendOpen = useEditorStore((s) => s.setLegendOpen);

  // Column selection state
  const selectedColumns = useEditorStore((s) => s.selectedColumns);
  const clearColumnSelection = useEditorStore((s) => s.clearColumnSelection);
  const setEditingColumn = useEditorStore((s) => s.setEditingColumn);
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
  const { setViewport: setReactFlowViewport, screenToFlowPosition } = useReactFlow();

  // Toast notification for invalid selection after restore
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  useEffect(() => {
    if (invalidSelectedNode) {
      setToastMessage(
        `Previously selected model "${invalidSelectedNode}" no longer exists.`,
      );
    }
  }, [invalidSelectedNode]);

  // Memoized callback for toast dismissal (prevents timer re-creation)
  const dismissToast = useCallback(() => setToastMessage(null), []);

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
          setDomain(msg.payload);
          if (msg.payload.templates) {
            setTemplates(msg.payload.templates);
          }
          if (msg.payload.manifestModels) {
            setManifestModels(msg.payload.manifestModels);
          }
          if (msg.payload.existingModels) {
            setExistingModels(msg.payload.existingModels);
          }
          if (!msg.welcomeDismissed) {
            useEditorStore.getState().setWelcomeModalOpen(true);
          }
          break;
        case 'domainUpdated':
          setDomain(msg.payload);
          if (msg.payload.templates) {
            setTemplates(msg.payload.templates);
          }
          if (msg.payload.manifestModels) {
            setManifestModels(msg.payload.manifestModels);
          }
          if (msg.payload.existingModels) {
            setExistingModels(msg.payload.existingModels);
          }
          break;
        case 'stageData':
          setDomain(msg.payload);
          if (msg.payload.templates) {
            setTemplates(msg.payload.templates);
          }
          if (msg.payload.manifestModels) {
            setManifestModels(msg.payload.manifestModels);
          }
          if (msg.payload.existingModels) {
            setExistingModels(msg.payload.existingModels);
          }
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
          setError(msg.payload.message);
          break;
      }
    },
    [setDomain, setError, setTemplates, setManifestModels, setExistingModels, setDiscrepancyReport, setManifestStale, setSyncPlanGenerated],
  );

  useMessageBus(onMessage, /* sendReadyOnMount */ true);

  // Unified keyboard shortcut handler (Escape, Delete/Backspace, Ctrl+F)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+F / Cmd+F: Focus search input (F402)
      // This should work regardless of focus state
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        focusSearchInput();
        return;
      }

      // Shift+? : Toggle legend panel
      if (e.shiftKey && e.key === '?') {
        e.preventDefault();
        setLegendOpen(!legendOpen);
        return;
      }

      // Guard: Don't intercept if user is typing in an input field
      const activeElement = document.activeElement;
      if (
        activeElement instanceof HTMLInputElement ||
        activeElement instanceof HTMLTextAreaElement ||
        activeElement instanceof HTMLSelectElement
      ) {
        return;
      }

      // F2: Edit selected column (rename)
      if (e.key === 'F2' && selectedColumns.length === 1 && detailPanelOpen && domain && !domain.readOnly) {
        e.preventDefault();
        setEditingColumn(selectedColumns[0]);
        return;
      }

      // ESCAPE KEY: Close dialogs first, then deselect
      if (e.key === 'Escape') {
        e.preventDefault();

        // Close any open dialog (priority order)
        if (newModelDialogOpen) {
          setNewModelDialogOpen(false);
          return;
        }
        if (newFkDialogOpen) {
          setNewFkDialogOpen(false);
          clearFkDialogPrefill();
          clearFkDialogEditData();
          return;
        }
        if (addExistingModelDialogOpen) {
          setAddExistingModelDialogOpen(false);
          return;
        }

        // Clear column selection first (before deselecting model)
        if (selectedColumns.length > 0) {
          clearColumnSelection();
          return;
        }

        // No dialogs open — deselect nodes and edges
        if (selectedNode || selectedEdges.length > 0 || selectedEdge) {
          selectNode(null);
          setDetailPanelOpen(false);
          setSelectedEdges([]);
          setSelectedEdge(null);
          setHighlightedColumns(new Set());
        }
        return;
      }

      // Shift+L: Trigger auto-layout
      if (e.shiftKey && e.key === 'L') {
        e.preventDefault();
        triggerAutoLayout();
        return;
      }

      // Alt+1/2: Switch stage tabs
      if (e.altKey && (e.key === '1' || e.key === '2')) {
        e.preventDefault();
        const stageMap: Record<string, import('../src/types/semantic').Stage> = {
          '1': 'logical',
          '2': 'physical',
        };
        const targetStage = stageMap[e.key];
        if (targetStage && domain && domain.stage !== targetStage) {
          vscode.postMessage({ type: 'switchStage', payload: { stage: targetStage } });
        }
        return;
      }

      // DELETE KEY: Delete selected design models or edges
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (!domain || domain.readOnly) return;

        // Priority 1: Remove selected node (with confirmation)
        if (selectedNode) {
          const model = domain.models.find((m) => m.name === selectedNode);
          if (model) {
            e.preventDefault();
            if (!detailPanelOpen) {
              setDetailPanelOpen(true);
            }
            setPendingDeleteConfirmation(true);
            return;
          }
        }

        // Priority 1.5: Delete selected columns (immediate)
        if (selectedColumns.length > 0 && detailPanelOpen && selectedNode) {
          e.preventDefault();
          for (const colName of selectedColumns) {
            vscode.postMessage({
              type: 'removeColumn',
              payload: { modelName: selectedNode, columnName: colName },
            });
          }
          clearColumnSelection();
          return;
        }

        // Priority 2: Delete selected edges (no confirmation, immediate)
        if (selectedEdges.length > 0) {
          e.preventDefault();

          for (const edgeId of selectedEdges) {
            const rel = domain.relationships.find((r) => {
              const expectedId = `fk-${r.fromModel}-${r.fromColumn}-${r.toModel}-${r.toColumn}`;
              return expectedId === edgeId;
            });

            if (!rel) continue;

            vscode.postMessage({
              type: 'removeRelationship',
              payload: {
                fromModel: rel.fromModel,
                fromColumn: rel.fromColumn,
                toModel: rel.toModel,
                toColumn: rel.toColumn,
              },
            });
          }
          return;
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    selectedNode,
    selectedEdge,
    selectedEdges,
    domain,
    detailPanelOpen,
    newModelDialogOpen,
    newFkDialogOpen,
    addExistingModelDialogOpen,
    setDetailPanelOpen,
    setPendingDeleteConfirmation,
    setNewModelDialogOpen,
    setNewFkDialogOpen,
    setAddExistingModelDialogOpen,
    clearFkDialogPrefill,
    clearFkDialogEditData,
    selectNode,
    setSelectedEdge,
    setSelectedEdges,
    setHighlightedColumns,
    setToastMessage,
    focusSearchInput,
    triggerAutoLayout,
    legendOpen,
    setLegendOpen,
    selectedColumns,
    clearColumnSelection,
    setEditingColumn,
    // Note: vscode is omitted as it's a stable ref from useVsCodeApi
  ]);

  // Get current selectedNode from store to preserve selection across domain updates
  const currentSelectedNode = useEditorStore((s) => s.selectedNode);

  // Initialize nodes and edges when domain changes.
  // Preserve visual selection if the selected node still exists.
  // Clear stale edge selections that no longer exist.
  // Apply search dimming (F402), selection dimming, and column expansion (F405).
  useEffect(() => {
    if (domain) {
      const transformOptions = discrepancyVisible && discrepancyReport
        ? { discrepancyReport }
        : undefined;
      let { nodes: newNodes, edges: newEdges } = transformDomain(domain, transformOptions);

      // Compute connected nodes for selection dimming.
      // When a node is selected, the selected node and its direct neighbors stay bright.
      // When an edge is selected, only the two endpoint nodes stay bright.
      const connectedNodeIds = new Set<string>();
      if (currentSelectedNode) {
        connectedNodeIds.add(currentSelectedNode);
        // Find all nodes connected to the selected node via edges (FK edges only)
        newEdges.forEach((edge) => {
          if (edge.type === 'fk' && edge.data) {
            const fkData = edge.data as FkFlowEdge['data'];
            if (fkData && fkData.fromModel === currentSelectedNode) {
              connectedNodeIds.add(fkData.toModel);
            }
            if (fkData && fkData.toModel === currentSelectedNode) {
              connectedNodeIds.add(fkData.fromModel);
            }
          }
        });
      } else if (selectedEdge) {
        // Edge selection: only the two endpoint models stay bright
        const edge = newEdges.find((e) => e.id === selectedEdge);
        if (edge?.type === 'fk' && edge.data) {
          const fkData = edge.data as FkFlowEdge['data'];
          if (fkData) {
            connectedNodeIds.add(fkData.fromModel);
            connectedNodeIds.add(fkData.toModel);
          }
        }
      }

      // F402: Search dimming + selection dimming (additive)
      // F405: Inject column expansion state into node data
      const hasSelection = currentSelectedNode !== null || selectedEdge !== null;
      const query = searchQuery.trim() ? searchQuery.toLowerCase() : '';
      newNodes = newNodes.map((node) => {
        if (node.type === 'annotation') {
          // Annotations: not search-dimmable, not selection-dimmable
          return node;
        }
        const modelData = node.data as ModelFlowNode['data'];
        const searchDimmed = query ? !modelData.modelName.toLowerCase().includes(query) : false;
        const selectionDimmed = hasSelection && !connectedNodeIds.has(node.id);

        return {
          ...node,
          data: {
            ...node.data,
            // Node is dimmed if either search doesn't match OR it's not connected to selection
            dimmed: searchDimmed || selectionDimmed,
            // F405: Column expansion (ephemeral state)
            // Pass stable toggleExpansion reference — ModelNode calls it with its own modelName
            isExpanded: isExpanded(node.id),
            onToggleExpansion: toggleExpansion,
          },
        };
      });

      // Apply selection dimming to edges (FK edges only).
      // For node selection: an edge is bright only if both endpoints are in the connected set.
      // For edge selection: only the selected edge stays bright.
      newEdges = newEdges.map((edge) => {
        if (edge.type !== 'fk' || !edge.data) return edge;
        const fkData = edge.data as FkFlowEdge['data'];
        if (!fkData) return edge;
        return {
          ...edge,
          data: {
            ...fkData,
            dimmed: hasSelection && (selectedEdge
              ? edge.id !== selectedEdge
              : !connectedNodeIds.has(fkData.fromModel) || !connectedNodeIds.has(fkData.toModel)),
          },
        };
      });

      // If we have a selected node, preserve the selection in the new nodes
      if (currentSelectedNode) {
        const selectedIdx = newNodes.findIndex((n) => n.id === currentSelectedNode);
        if (selectedIdx !== -1) {
          newNodes[selectedIdx] = { ...newNodes[selectedIdx], selected: true };
        }
      }

      // Clear stale edge selections (edges that no longer exist after domain update)
      const newEdgeIds = new Set(newEdges.map((e) => e.id));
      if (selectedEdges.length > 0) {
        const validEdges = selectedEdges.filter((id) => newEdgeIds.has(id));
        if (validEdges.length !== selectedEdges.length) {
          setSelectedEdges(validEdges);
        }
      }
      if (selectedEdge && !newEdgeIds.has(selectedEdge)) {
        setSelectedEdge(null);
      }

      setNodes(newNodes);
      setEdges(newEdges);
    }
  }, [domain, setNodes, setEdges, setSelectedEdges, setSelectedEdge, selectedEdges, currentSelectedNode, selectedEdge, searchQuery, isExpanded, toggleExpansion, discrepancyVisible, discrepancyReport]);

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

  // Handle node clicks to open the detail panel (model nodes only).
  const onNodeClick = useCallback(
    (_event: React.MouseEvent, node: ModelFlowNode | AnnotationFlowNode) => {
      if (node.type === 'annotation') return; // Annotations don't open detail panel
      selectNode(node.id);
      setDetailPanelOpen(true);
      setHighlightedColumns(new Set());
      setSelectedEdge(null);
    },
    [selectNode, setDetailPanelOpen, setHighlightedColumns, setSelectedEdge],
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
    setHighlightedColumns(new Set());
    setSelectedEdge(null);
  }, [setDetailPanelOpen, selectNode, setHighlightedColumns, setSelectedEdge]);

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

  // Handle double-click on blank canvas to create a new annotation
  const onPaneDoubleClick = useCallback(
    (event: React.MouseEvent) => {
      if (domain?.readOnly) return;
      // Only trigger on actual pane clicks, not double-clicks that bubbled from nodes
      const target = event.target as HTMLElement;
      if (!target.classList.contains('react-flow__pane')) return;

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

  if (error) {
    return (
      <div className="editor-message">
        <p style={{ color: 'var(--error-fg)' }}>Error: {error}</p>
      </div>
    );
  }

  // --- Loading state ---------------------------------------------------------

  if (!domain) {
    return (
      <div className="editor-message">
        <p>Loading domain&hellip;</p>
      </div>
    );
  }

  // --- Graph canvas ----------------------------------------------------------

  return (
    <div style={{ width: '100%', height: '100%' }}>
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
        panOnDrag={!shiftHeld}
        selectionOnDrag={shiftHeld && !domain.readOnly}
        selectionKeyCode={null}
        multiSelectionKeyCode="Shift"
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

      {toastMessage && (
        <Toast message={toastMessage} variant="warning" onDismiss={dismissToast} />
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root export
// ---------------------------------------------------------------------------

export function App() {
  return (
    <ReactFlowProvider>
      <EditorCanvas />
    </ReactFlowProvider>
  );
}
