/**
 * Toolbar — main control bar for the graph editor.
 *
 * Renders at top-center of the canvas with:
 * - Domain info (name + layer badge)
 * - Zoom controls (in/out/level/fit)
 * - Auto Layout button
 * - New Model button (Phase 2)
 *
 * Uses React Flow's zoom/pan APIs and the editor store for domain data.
 */

import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { Panel, useReactFlow, useStore } from '@xyflow/react';

import { useVsCodeApi } from '../../hooks/useVsCodeApi';
import { useEditorStore } from '../../store/editorStore';
import { runElkLayout } from '../../lib/elkLayout';
import type { ModelFlowNode, FkFlowEdge } from '../../types/graph';
import type { WebviewMessage } from '../../hooks/useMessageBus';
import './Toolbar.css';

// ---------------------------------------------------------------------------
// Layer badge display
// ---------------------------------------------------------------------------

// Fallback abbreviations for when layerConfig is not available
const LAYER_ABBREV_FALLBACK: Record<string, string> = {
  bronze: 'BRZ',
  silver: 'SLV',
  gold: 'GLD',
};

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ToolbarProps {
  nodes: ModelFlowNode[];
  edges: FkFlowEdge[];
  /** Whether all columns are currently expanded. */
  allExpanded: boolean;
  /** Expand all columns in all nodes. */
  onExpandAll: () => void;
  /** Collapse all columns in all nodes. */
  onCollapseAll: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function Toolbar({ nodes, edges, allExpanded, onExpandAll, onCollapseAll }: ToolbarProps) {
  const vscode = useVsCodeApi();
  const { zoomIn, zoomOut, fitView, getNode } = useReactFlow();
  const domain = useEditorStore((s) => s.domain);
  const setDomain = useEditorStore((s) => s.setDomain);
  const setNewModelDialogOpen = useEditorStore((s) => s.setNewModelDialogOpen);
  const setNewFkDialogOpen = useEditorStore((s) => s.setNewFkDialogOpen);
  const setAddExistingModelDialogOpen = useEditorStore((s) => s.setAddExistingModelDialogOpen);
  const searchQuery = useEditorStore((s) => s.searchQuery);
  const setSearchQuery = useEditorStore((s) => s.setSearchQuery);
  const selectNode = useEditorStore((s) => s.selectNode);
  const setDetailPanelOpen = useEditorStore((s) => s.setDetailPanelOpen);
  const registerSearchFocus = useEditorStore((s) => s.registerSearchFocus);

  // Get current zoom level from React Flow store
  const zoom = useStore((s) => s.transform[2]);
  const [zoomPercent, setZoomPercent] = useState(100);

  // Auto layout state
  const [isLayouting, setIsLayouting] = useState(false);

  // Refresh manifest state
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Model dropdown state
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const modelDropdownRef = useRef<HTMLDivElement>(null);

  // Search input ref (for Ctrl+F focus)
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Compute matching node IDs for search
  const matchingNodeIds = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const query = searchQuery.toLowerCase();
    return nodes
      .filter((node) => node.data.modelName.toLowerCase().includes(query))
      .map((node) => node.id);
  }, [searchQuery, nodes]);

  // Update zoom percentage display
  useEffect(() => {
    setZoomPercent(Math.round(zoom * 100));
  }, [zoom]);

  // --- Zoom handlers -------------------------------------------------------

  const handleZoomIn = useCallback(() => {
    zoomIn({ duration: 200 });
  }, [zoomIn]);

  const handleZoomOut = useCallback(() => {
    zoomOut({ duration: 200 });
  }, [zoomOut]);

  const handleFitView = useCallback(() => {
    fitView({ padding: 0.1, duration: 200 });
  }, [fitView]);

  // --- Model dropdown click-outside handler --------------------------------

  useEffect(() => {
    if (!modelDropdownOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        modelDropdownRef.current &&
        !modelDropdownRef.current.contains(e.target as Node)
      ) {
        setModelDropdownOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [modelDropdownOpen]);

  // --- Search handlers -----------------------------------------------------

  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' && matchingNodeIds.length > 0) {
        e.preventDefault();
        const firstMatchId = matchingNodeIds[0];
        const node = getNode(firstMatchId);
        if (node) {
          selectNode(firstMatchId);
          setDetailPanelOpen(true);
          // Pan to the matched node with animation
          fitView({ nodes: [{ id: firstMatchId }], duration: 300, padding: 0.3 });
        }
      } else if (e.key === 'Escape') {
        // Clear search on Escape
        setSearchQuery('');
        searchInputRef.current?.blur();
      }
    },
    [matchingNodeIds, getNode, selectNode, setDetailPanelOpen, fitView, setSearchQuery],
  );

  /** Register search focus function for Ctrl+F shortcut (F402) */
  useEffect(() => {
    const focusFn = () => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    };
    registerSearchFocus(focusFn);
    return () => registerSearchFocus(null);
  }, [registerSearchFocus]);

  // --- New Model handlers --------------------------------------------------

  const handleNewModel = useCallback(() => {
    setModelDropdownOpen(false);
    setNewModelDialogOpen(true);
  }, [setNewModelDialogOpen]);

  const handleAddExistingModel = useCallback(() => {
    setModelDropdownOpen(false);
    setAddExistingModelDialogOpen(true);
  }, [setAddExistingModelDialogOpen]);

  const handleNewRelationship = useCallback(() => {
    setNewFkDialogOpen(true);
  }, [setNewFkDialogOpen]);

  // --- Auto Layout handlers ------------------------------------------------

  const runLayout = useCallback(async () => {
    if (!domain || nodes.length === 0 || isLayouting) {
      return;
    }

    setIsLayouting(true);

    try {
      const positions = await runElkLayout(
        nodes,
        edges,
        domain.viewConfig.layoutOptions,
      );

      // Optimistic update: update domain in store so React Flow re-renders
      const updatedDomain = {
        ...domain,
        viewConfig: {
          ...domain.viewConfig,
          positions,
        },
      };
      setDomain(updatedDomain);

      // Wait one frame for React to flush, then fit viewport
      requestAnimationFrame(() => {
        fitView({ padding: 0.1 });
      });

      // Persist to extension host
      const message: WebviewMessage = {
        type: 'updatePositions',
        payload: { positions },
      };
      vscode.postMessage(message);
    } catch (err) {
      console.error('[Toolbar] Auto layout failed:', err);
    } finally {
      setIsLayouting(false);
    }
  }, [domain, nodes, edges, isLayouting, setDomain, fitView, vscode]);

  const handleAutoLayout = useCallback(() => {
    if (!domain || nodes.length === 0 || isLayouting) {
      return;
    }
    runLayout();
  }, [domain, nodes, isLayouting, runLayout]);

  // --- Undo/Redo handlers ----------------------------------------------------

  const handleUndo = useCallback(() => {
    const message: WebviewMessage = { type: 'undo' };
    vscode.postMessage(message);
  }, [vscode]);

  const handleRedo = useCallback(() => {
    const message: WebviewMessage = { type: 'redo' };
    vscode.postMessage(message);
  }, [vscode]);

  // --- Refresh Manifest handler ----------------------------------------------

  const handleRefreshManifest = useCallback(() => {
    if (isRefreshing) return;

    setIsRefreshing(true);
    const message: WebviewMessage = { type: 'refreshManifest' };
    vscode.postMessage(message);

    // Reset refreshing state after a timeout (the actual refresh is async)
    // The extension will show its own progress notification
    setTimeout(() => setIsRefreshing(false), 1000);
  }, [isRefreshing, vscode]);

  // --- Early return if no domain -------------------------------------------

  if (!domain) {
    return null;
  }

  // Use layerConfig for dynamic abbreviation and color, with fallbacks
  const layerAbbrev = domain.layerConfig?.abbreviation
    ?? LAYER_ABBREV_FALLBACK[domain.layer]
    ?? domain.layer.substring(0, 3).toUpperCase();
  const layerColor = domain.layerConfig?.color;

  // --- Render --------------------------------------------------------------

  return (
    <Panel position="top-center" className="toolbar">
      {/* Domain info */}
      <div className="toolbar__section toolbar__domain">
        <span className="toolbar__domain-name">{domain.domain}</span>
        <span
          className={`toolbar__layer-badge${layerColor ? '' : ` toolbar__layer-badge--${domain.layer}`}`}
          style={layerColor ? {
            backgroundColor: `${layerColor}33`, // 20% opacity
            color: layerColor,
          } : undefined}
        >
          {layerAbbrev}
        </span>
      </div>

      {/* Divider */}
      <div className="toolbar__divider" />

      {/* Zoom controls */}
      <div className="toolbar__section toolbar__zoom">
        <button
          className="toolbar__button"
          onClick={handleZoomOut}
          title="Zoom out"
          aria-label="Zoom out"
        >
          −
        </button>
        <span className="toolbar__zoom-level">{zoomPercent}%</span>
        <button
          className="toolbar__button"
          onClick={handleZoomIn}
          title="Zoom in"
          aria-label="Zoom in"
        >
          +
        </button>
        <button
          className="toolbar__button toolbar__button--text"
          onClick={handleFitView}
          title="Fit view to show all nodes"
          aria-label="Fit view to show all nodes"
        >
          Fit
        </button>
      </div>

      {/* Divider */}
      <div className="toolbar__divider" />

      {/* Undo/Redo */}
      <div className="toolbar__section toolbar__undo-redo">
        <button
          className="toolbar__button"
          onClick={handleUndo}
          title="Undo (Ctrl+Z)"
          aria-label="Undo"
        >
          ↶
        </button>
        <button
          className="toolbar__button"
          onClick={handleRedo}
          title="Redo (Ctrl+Shift+Z)"
          aria-label="Redo"
        >
          ↷
        </button>
      </div>

      {/* Divider */}
      <div className="toolbar__divider" />

      {/* Auto Layout */}
      <div className="toolbar__section">
        <button
          className="toolbar__button toolbar__button--text"
          onClick={handleAutoLayout}
          disabled={isLayouting || nodes.length === 0}
          title="Auto-layout nodes using ELK algorithm"
          aria-label="Auto-layout nodes using ELK algorithm"
        >
          {isLayouting && <span className="toolbar__spinner" />}
          {isLayouting ? 'Layouting…' : 'Auto Layout'}
        </button>
      </div>

      {/* Refresh Manifest (F305) */}
      <div className="toolbar__section">
        <button
          className="toolbar__button toolbar__button--text"
          onClick={handleRefreshManifest}
          disabled={isRefreshing}
          title="Refresh manifest and re-reconcile domains"
          aria-label="Refresh manifest and re-reconcile domains"
        >
          {isRefreshing && <span className="toolbar__spinner" />}
          {isRefreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {/* Divider */}
      <div className="toolbar__divider" />

      {/* Search (F402) */}
      <div className="toolbar__section toolbar__search">
        <input
          ref={searchInputRef}
          type="text"
          className="toolbar__search-input"
          placeholder="Search models…"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={handleSearchKeyDown}
          aria-label="Search models"
        />
        {searchQuery && (
          <span className="toolbar__search-count">
            {matchingNodeIds.length}
          </span>
        )}
      </div>

      {/* Divider */}
      <div className="toolbar__divider" />

      {/* Column Expansion Toggle (F405) */}
      <div className="toolbar__section">
        <button
          className="toolbar__button toolbar__button--text"
          onClick={allExpanded ? onCollapseAll : onExpandAll}
          title={allExpanded ? 'Collapse all columns to show fewer details' : 'Expand all columns to show full details'}
          aria-label={allExpanded ? 'Collapse all columns' : 'Expand all columns'}
        >
          {allExpanded ? 'Collapse All' : 'Expand All'}
        </button>
      </div>

      {/* Divider */}
      <div className="toolbar__divider" />

      {/* Model Dropdown */}
      <div className="toolbar__section">
        <div className="toolbar__dropdown" ref={modelDropdownRef}>
          <button
            className="toolbar__dropdown-trigger"
            onClick={() => setModelDropdownOpen(!modelDropdownOpen)}
            title="Add model to domain"
            aria-label="Add model to domain"
            aria-haspopup="menu"
            aria-expanded={modelDropdownOpen}
          >
            + Model
            <span className="toolbar__dropdown-arrow">▾</span>
          </button>
          {modelDropdownOpen && (
            <div className="toolbar__dropdown-menu" role="menu">
              <button
                className="toolbar__dropdown-item"
                onClick={handleNewModel}
                role="menuitem"
              >
                New Design Model
              </button>
              <button
                className="toolbar__dropdown-item"
                onClick={handleAddExistingModel}
                role="menuitem"
              >
                Add Existing Model
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Divider */}
      <div className="toolbar__divider" />

      {/* New Relationship */}
      <div className="toolbar__section">
        <button
          className="toolbar__button toolbar__button--text toolbar__button--primary"
          onClick={handleNewRelationship}
          title="Add FK relationship between models"
          aria-label="Add FK relationship between models"
        >
          + Relationship
        </button>
      </div>
    </Panel>
  );
}
