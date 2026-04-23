/**
 * Toolbar — main control bar for the graph editor.
 *
 * Renders at top-center of the canvas with:
 * - Domain info (name + layer badge)
 * - Zoom controls (in/out/level/fit)
 * - Auto Layout button
 * - New Model button (Phase 2)
 *
 * Stage tabs sit above the controls in a stacked two-row layout, all within
 * a single top-center Panel to avoid overlap when the sidebar narrows the editor.
 *
 * Uses React Flow's zoom/pan APIs and the editor store for domain data.
 */

import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { Panel, useReactFlow, useStore } from '@xyflow/react';

import { useVsCodeApi } from '../../hooks/useVsCodeApi';
import { useEditorStore } from '../../store/editorStore';
import {
  runElkLayout,
  detectLayerBound,
  detectStrategy,
  SPACING_PRESETS,
  type PartitionStrategy,
  type SpacingPreset,
  type LayoutDirection,
} from '../../lib/elkLayout';
import { StageTabs } from './StageTabs';
import type { ModelFlowNode, FkFlowEdge, AnnotationFlowNode, AnnotationFlowEdge } from '../../types/graph';
import type { Stage } from '../../../src/types/semantic';
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
  nodes: (ModelFlowNode | AnnotationFlowNode)[];
  edges: (FkFlowEdge | AnnotationFlowEdge)[];
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
  const reactFlowInstance = useReactFlow();
  const { zoomIn, zoomOut, fitView, getNode } = reactFlowInstance;
  const domain = useEditorStore((s) => s.domain);
  const setDomain = useEditorStore((s) => s.setDomain);
  const setNewModelDialogOpen = useEditorStore((s) => s.setNewModelDialogOpen);
  const setNewFkDialogOpen = useEditorStore((s) => s.setNewFkDialogOpen);
  const setAddExistingModelDialogOpen = useEditorStore((s) => s.setAddExistingModelDialogOpen);
  const searchQuery = useEditorStore((s) => s.searchQuery);
  const setSearchQuery = useEditorStore((s) => s.setSearchQuery);
  const selectNode = useEditorStore((s) => s.selectNode);
  const setDetailPanelOpen = useEditorStore((s) => s.setDetailPanelOpen);
  const canvasMode = useEditorStore((s) => s.canvasMode);
  const setCanvasMode = useEditorStore((s) => s.setCanvasMode);
  const registerSearchFocus = useEditorStore((s) => s.registerSearchFocus);
  const registerAutoLayout = useEditorStore((s) => s.registerAutoLayout);
  // Get current zoom level from React Flow store
  const zoom = useStore((s) => s.transform[2]);
  const [zoomPercent, setZoomPercent] = useState(100);

  // Auto layout state
  const [isLayouting, setIsLayouting] = useState(false);
  const [layoutOptionsOpen, setLayoutOptionsOpen] = useState(false);
  const [layoutDirty, setLayoutDirty] = useState(false);
  const [partitionStrategy, setPartitionStrategy] = useState<PartitionStrategy>('auto');
  const [layerBound, setLayerBound] = useState(5);
  const [layoutDirection, setLayoutDirection] = useState<LayoutDirection>('RIGHT');
  const [spacingPreset, setSpacingPreset] = useState<SpacingPreset>('M');
  const layoutGroupRef = useRef<HTMLDivElement>(null);

  // Refresh manifest state
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Discrepancy toggle state
  const discrepancyVisible = useEditorStore((s) => s.discrepancyVisible);
  const discrepancyCompareStage = useEditorStore((s) => s.discrepancyCompareStage);
  const setDiscrepancyVisible = useEditorStore((s) => s.setDiscrepancyVisible);
  const setDiscrepancyCompareStage = useEditorStore((s) => s.setDiscrepancyCompareStage);
  const [discrepancyDropdownOpen, setDiscrepancyDropdownOpen] = useState(false);
  const discrepancyDropdownRef = useRef<HTMLDivElement>(null);

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
      .filter((node) => node.type === 'model' && (node.data as ModelFlowNode['data']).modelName.toLowerCase().includes(query))
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

  // --- Layout options click-outside handler --------------------------------

  useEffect(() => {
    if (!layoutOptionsOpen) return;
    const handler = (e: MouseEvent) => {
      if (layoutGroupRef.current && !layoutGroupRef.current.contains(e.target as Node)) {
        setLayoutOptionsOpen(false);
      }
    };
    // Use capture phase so this fires before React Flow canvas handlers
    window.addEventListener('mousedown', handler, true);
    return () => window.removeEventListener('mousedown', handler, true);
  }, [layoutOptionsOpen]);

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

  // --- Discrepancy dropdown click-outside handler --------------------------

  useEffect(() => {
    if (!discrepancyDropdownOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (
        discrepancyDropdownRef.current &&
        !discrepancyDropdownRef.current.contains(e.target as Node)
      ) {
        setDiscrepancyDropdownOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [discrepancyDropdownOpen]);

  // --- Discrepancy toggle handlers -----------------------------------------

  /** Get comparison options for the active stage. */
  const discrepancyOptions = useMemo((): { stage: Stage; label: string }[] => {
    if (!domain) return [];
    switch (domain.stage) {
      case 'physical':
        return [{ stage: 'logical', label: 'Compare to Logical' }];
      case 'logical':
        return [{ stage: 'physical', label: 'Compare to Physical' }];
      default:
        return [];
    }
  }, [domain]);

  const handleDiscrepancySelect = useCallback(
    (compareAgainst: Stage) => {
      setDiscrepancyDropdownOpen(false);
      setDiscrepancyCompareStage(compareAgainst);
      setDiscrepancyVisible(true);
      const message: WebviewMessage = {
        type: 'toggleDiscrepancy',
        payload: { enabled: true, compareAgainst },
      };
      vscode.postMessage(message);
    },
    [vscode, setDiscrepancyCompareStage, setDiscrepancyVisible],
  );

  const handleDiscrepancyOff = useCallback(() => {
    setDiscrepancyDropdownOpen(false);
    setDiscrepancyVisible(false);
    setDiscrepancyCompareStage(null);
    const message: WebviewMessage = {
      type: 'toggleDiscrepancy',
      payload: { enabled: false },
    };
    vscode.postMessage(message);
  }, [vscode, setDiscrepancyVisible, setDiscrepancyCompareStage]);

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

  const setEditingAnnotationId = useEditorStore((s) => s.setEditingAnnotationId);
  const handleNewAnnotation = useCallback(() => {
    setModelDropdownOpen(false);
    // Place annotation near the center of the viewport
    const { x, y, zoom } = reactFlowInstance.getViewport();
    const viewportCenterX = (-x + window.innerWidth / 2) / zoom;
    const viewportCenterY = (-y + window.innerHeight / 2) / zoom;
    const id = crypto.randomUUID();
    vscode.postMessage({
      type: 'addAnnotation',
      payload: { id, text: '', x: Math.round(viewportCenterX), y: Math.round(viewportCenterY) },
    });
    setEditingAnnotationId(id);
  }, [vscode, setEditingAnnotationId]);

  // --- Auto Layout handlers ------------------------------------------------

  const runLayout = useCallback(async () => {
    if (!domain || nodes.length === 0 || isLayouting) {
      return;
    }

    setIsLayouting(true);

    try {
      const sp = SPACING_PRESETS[spacingPreset];
      // Filter to model nodes/FK edges only — annotations are exempt from auto-layout.
      const modelNodes = nodes.filter((n): n is import('../../types/graph').ModelFlowNode => n.type === 'model');
      const fkEdges = edges.filter((e): e is import('../../types/graph').FkFlowEdge => e.type === 'fk');
      const effectiveBound = partitionStrategy === 'auto'
        ? detectLayerBound(modelNodes.length)
        : layerBound;
      const positions = await runElkLayout(
        modelNodes,
        fkEdges,
        {
          ...domain.viewConfig.layoutOptions,
          'elk.direction': layoutDirection,
          ...sp,
          'elk.layered.layering.coffmanGraham.layerBound': String(effectiveBound),
        },
        partitionStrategy,
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
      setLayoutDirty(false);
    } catch (err) {
      console.error('[Toolbar] Auto layout failed:', err);
    } finally {
      setIsLayouting(false);
    }
  }, [domain, nodes, edges, isLayouting, partitionStrategy, layerBound, layoutDirection, spacingPreset, setDomain, fitView, vscode]);

  const handleAutoLayout = useCallback(() => {
    if (!domain || nodes.length === 0 || isLayouting) {
      return;
    }
    runLayout();
  }, [domain, nodes, isLayouting, runLayout]);

  /** Register auto-layout function for Shift+L shortcut */
  useEffect(() => {
    registerAutoLayout(handleAutoLayout);
    return () => registerAutoLayout(null);
  }, [registerAutoLayout, handleAutoLayout]);

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

  // --- View File handler ----------------------------------------------------

  const handleViewFile = useCallback(() => {
    const message: WebviewMessage = { type: 'viewFile' };
    vscode.postMessage(message);
  }, [vscode]);

  // --- Early return if no domain -------------------------------------------

  if (!domain) {
    return null;
  }

  const isReadOnly = domain.readOnly;

  // Use layerConfig for dynamic abbreviation and color, with fallbacks
  const layerAbbrev = domain.layerConfig?.abbreviation
    ?? LAYER_ABBREV_FALLBACK[domain.layer]
    ?? domain.layer.substring(0, 3).toUpperCase();
  const layerColor = domain.layerConfig?.color;

  // --- Render --------------------------------------------------------------

  return (
    <>
      <Panel position="top-center" className="toolbar-container">
        {/* Row 1: Controls */}
        <div className="toolbar toolbar--attached-bottom">
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

        {/* Undo/Redo — hidden in read-only mode */}
        {!isReadOnly && (
          <>
            <div className="toolbar__divider" />
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
          </>
        )}

        {/* Divider */}
        <div className="toolbar__divider" />

        {/* Auto Layout + options + Refresh Manifest */}
        <div className="toolbar__section">
          <div className="toolbar__split-group" ref={layoutGroupRef}>
            <button
              className={`toolbar__split-main${layoutDirty ? ' toolbar__split-main--dirty' : ''}`}
              onClick={handleAutoLayout}
              disabled={isLayouting || nodes.length === 0}
              title={layoutDirty ? 'Options changed — click to re-run layout (Shift+L)' : 'Auto-layout all models (Shift+L)'}
              aria-label="Auto-layout nodes"
            >
              {isLayouting ? <span className="toolbar__spinner" /> : (layoutDirty ? '↺' : '⊞')} Layout
            </button>
            <span className="toolbar__split-sep" aria-hidden="true" />
            <button
              className={`toolbar__split-caret${layoutOptionsOpen ? ' toolbar__split-caret--active' : ''}`}
              onClick={() => setLayoutOptionsOpen((o) => !o)}
              title="Layout settings"
              aria-label="Layout settings"
              aria-expanded={layoutOptionsOpen}
            >
              ▾
            </button>
            {layoutOptionsOpen && (
              <div
                className="toolbar__lp"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); handleAutoLayout(); }
                }}
              >
                {/* Header */}
                <div className="toolbar__lp-header">
                  <span className="toolbar__lp-title">Auto Layout</span>
                  <kbd className="toolbar__lp-kbd">Shift+L</kbd>
                </div>

                {/* Grouping */}
                <div className="toolbar__lp-section">
                  <span className="toolbar__lp-label">Grouping</span>
                  {(() => {
                    const modelOnly = nodes.filter((n): n is ModelFlowNode => n.type === 'model');
                    const fkOnly = edges.filter((e): e is FkFlowEdge => e.type === 'fk');
                    const resolved = partitionStrategy === 'auto' ? detectStrategy(modelOnly, fkOnly) : null;
                    return (
                      <div className="toolbar__lp-track">
                        {([
                          ['auto',  'Auto'],
                          ['role',  'Model type'],
                          ['depth', 'Join depth'],
                          ['none',  'None'],
                        ] as [PartitionStrategy, string][]).map(([s, label]) => (
                          <button
                            key={s}
                            className={[
                              'toolbar__lp-pill',
                              partitionStrategy === s ? 'toolbar__lp-pill--on' : '',
                              resolved && s === resolved ? 'toolbar__lp-pill--auto-resolved' : '',
                            ].filter(Boolean).join(' ')}
                            onClick={() => { setPartitionStrategy(s); setLayoutDirty(true); }}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    );
                  })()}
                  <span className="toolbar__lp-desc">
                    {partitionStrategy === 'auto' ? (() => {
                      const r = detectStrategy(nodes.filter((n): n is ModelFlowNode => n.type === 'model'), edges.filter((e): e is FkFlowEdge => e.type === 'fk'));
                      return r === 'role'
                        ? 'Using Model type — your models have roles assigned.'
                        : r === 'depth'
                        ? 'Using Join depth — no roles, but relationships exist.'
                        : 'Using None — no roles or relationships to group by.';
                    })()
                    : partitionStrategy === 'role'
                    ? 'Groups models by their assigned role: dimensions first, then reference tables, facts, bridge tables, and aggregates.'
                    : partitionStrategy === 'depth'
                    ? 'Arranges models so that relationship lines flow in one direction, reducing crossings.'
                    : 'No grouping. Models are placed freely to reduce line crossings.'}
                  </span>
                </div>

                {/* Direction + Spacing side by side */}
                <div className="toolbar__lp-columns">
                  <div className="toolbar__lp-section">
                    <span className="toolbar__lp-label">Direction</span>
                    <div className="toolbar__lp-track">
                      {(['RIGHT', 'DOWN'] as LayoutDirection[]).map((d) => (
                        <button
                          key={d}
                          className={`toolbar__lp-pill${layoutDirection === d ? ' toolbar__lp-pill--on' : ''}`}
                          onClick={() => { setLayoutDirection(d); setLayoutDirty(true); }}
                          title={d === 'RIGHT' ? 'Sources left, derived right' : 'Sources top, derived bottom'}
                        >
                          {d === 'RIGHT' ? '→' : '↓'}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="toolbar__lp-section">
                    <span className="toolbar__lp-label">Spacing</span>
                    <div className="toolbar__lp-track">
                      {(['S', 'M', 'L'] as SpacingPreset[]).map((p) => (
                        <button
                          key={p}
                          className={`toolbar__lp-pill${spacingPreset === p ? ' toolbar__lp-pill--on' : ''}`}
                          onClick={() => { setSpacingPreset(p); setLayoutDirty(true); }}
                          title={p === 'S' ? 'Compact' : p === 'M' ? 'Default' : 'Wide'}
                        >
                          {p}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Max per layer */}
                <div className="toolbar__lp-section">
                  <span className="toolbar__lp-label">Max per layer</span>
                  <div className="toolbar__lp-layer-row">
                    <input
                      type="number"
                      className={`toolbar__lp-input${partitionStrategy === 'auto' ? ' toolbar__lp-input--auto' : ''}`}
                      value={partitionStrategy === 'auto' ? detectLayerBound(nodes.filter((n) => n.type === 'model').length) : layerBound}
                      min={1}
                      max={20}
                      disabled={partitionStrategy === 'auto'}
                      onChange={(e) => { setLayerBound(Math.max(1, Math.min(20, Number(e.target.value)))); setLayoutDirty(true); }}
                    />
                    {partitionStrategy === 'auto' ? (
                      <span className="toolbar__lp-desc">auto — {detectLayerBound(nodes.filter((n) => n.type === 'model').length)} for {nodes.filter((n) => n.type === 'model').length} models</span>
                    ) : (
                      <span className="toolbar__lp-desc">lower = wider layout, higher = taller layout</span>
                    )}
                  </div>
                </div>

                {/* Apply */}
                <button
                  className={`toolbar__lp-apply${layoutDirty ? ' toolbar__lp-apply--dirty' : ''}`}
                  onClick={handleAutoLayout}
                  disabled={isLayouting || nodes.length === 0}
                >
                  {isLayouting ? 'Running...' : layoutDirty ? '↺ Re-apply Layout' : 'Apply Layout'}
                  <kbd className="toolbar__lp-apply-key">↵</kbd>
                </button>
              </div>
            )}
          </div>

          {/* Refresh Manifest */}
          <button
            className="toolbar__button toolbar__button--tooltip"
            onClick={handleRefreshManifest}
            disabled={isRefreshing}
            data-tooltip="Refresh"
            aria-label="Refresh manifest data"
          >
            {isRefreshing ? <span className="toolbar__spinner" /> : '↻'}
          </button>
        </div>

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
            className="toolbar__button toolbar__button--tooltip"
            onClick={allExpanded ? onCollapseAll : onExpandAll}
            data-tooltip={allExpanded ? 'Collapse All' : 'Expand All'}
            aria-label={allExpanded ? 'Collapse all columns' : 'Expand all columns'}
          >
            {allExpanded ? '⊟' : '⊞'}
          </button>
        </div>

        {/* Canvas mode — select vs pan */}
        {!domain?.readOnly && (
          <div className="toolbar__section">
            <button
              className={`toolbar__button toolbar__button--tooltip${canvasMode === 'select' ? ' toolbar__button--active' : ''}`}
              onClick={() => setCanvasMode(canvasMode === 'select' ? 'pan' : 'select')}
              data-tooltip={canvasMode === 'select' ? 'Pan Mode' : 'Select Mode'}
              aria-label="Toggle select mode"
              aria-pressed={canvasMode === 'select'}
            >
              ⬚
            </button>
          </div>
        )}

        {/* Discrepancy toggle */}
        {discrepancyOptions.length > 0 && (
          <>
            <div className="toolbar__divider" />
            <div className="toolbar__section">
              <div className="toolbar__dropdown" ref={discrepancyDropdownRef}>
                <button
                  className={`toolbar__dropdown-trigger${discrepancyVisible ? ' toolbar__dropdown-trigger--active' : ''}`}
                  onClick={() => {
                    if (discrepancyVisible) {
                      handleDiscrepancyOff();
                    } else if (discrepancyOptions.length === 1) {
                      handleDiscrepancySelect(discrepancyOptions[0].stage);
                    } else {
                      setDiscrepancyDropdownOpen(!discrepancyDropdownOpen);
                    }
                  }}
                  title={discrepancyVisible
                    ? `Comparing to ${discrepancyCompareStage ?? ''} — click to disable`
                    : 'Compare across stages'}
                  aria-label="Toggle cross-stage comparison"
                  aria-haspopup={discrepancyOptions.length > 1 ? 'menu' : undefined}
                  aria-expanded={discrepancyDropdownOpen}
                >
                  {discrepancyVisible ? '⊘ Diff' : '⊕ Diff'}
                  {!discrepancyVisible && discrepancyOptions.length > 1 && (
                    <span className="toolbar__dropdown-arrow">▾</span>
                  )}
                </button>
                {discrepancyDropdownOpen && !discrepancyVisible && (
                  <div className="toolbar__dropdown-menu" role="menu">
                    {discrepancyOptions.map(({ stage, label }) => (
                      <button
                        key={stage}
                        className="toolbar__dropdown-item"
                        onClick={() => handleDiscrepancySelect(stage)}
                        role="menuitem"
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        {/* Add Dropdown — hidden in read-only mode */}
        {!isReadOnly && (
          <>
            <div className="toolbar__divider" />
            <div className="toolbar__section">
              <div className="toolbar__dropdown" ref={modelDropdownRef}>
                <button
                  className="toolbar__dropdown-trigger"
                  onClick={() => setModelDropdownOpen(!modelDropdownOpen)}
                  title="Add model or relationship"
                  aria-label="Add model or relationship"
                  aria-haspopup="menu"
                  aria-expanded={modelDropdownOpen}
                >
                  + Add
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
                    <button
                      className="toolbar__dropdown-item"
                      onClick={() => { setModelDropdownOpen(false); handleNewRelationship(); }}
                      role="menuitem"
                    >
                      New Relationship
                    </button>
                    <div className="toolbar__dropdown-divider" />
                    <button
                      className="toolbar__dropdown-item"
                      onClick={handleNewAnnotation}
                      role="menuitem"
                      title="Create a note at the viewport centre (or double-click blank canvas)"
                    >
                      New Note
                    </button>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
        </div>

        {/* Row 2: Stage tabs (attached below toolbar) */}
        <StageTabs activeStage={domain.stage} readOnly={isReadOnly} />
      </Panel>

      {/* View File button — top-right corner */}
      <Panel position="top-right">
        <button
          className="toolbar__view-file"
          onClick={handleViewFile}
          title="Open as JaSON file"
          aria-label="Open underlying JSON file in text editor"
        >
          {'{ }'} View File
        </button>
      </Panel>
    </>
  );
}
