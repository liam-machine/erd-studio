/**
 * ModelNode — custom React Flow node for displaying a semantic model card.
 *
 * Shows model name with a layer badge, a list of columns with PK/FK
 * indicators and data types, and a footer with the total column count.
 *
 * Provides node-level handles (top/right/bottom/left) used by FkEdge for
 * Power BI-style connections that route to whichever side creates the
 * least bends.
 *
 * Relationships are created via long-press on column rows:
 *   1. Long-press (200-250ms) on a column to start drag mode
 *   2. Drag to a column in another model
 *   3. Release to open the relationship dialog with prefilled data
 */

import { memo, useCallback, useMemo, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { ModelFlowNode, ColumnDisplay } from '../../types/graph';
import type { ModelRole } from '../../../src/types/semantic';
import type { ColumnDiscrepancy } from '../../../src/types/discrepancy';
import { COLLAPSED_COLUMN_LIMIT } from '../../hooks/useColumnExpansion';
import { useLongPressDrag } from '../../hooks/useLongPressDrag';
import { useEditorStore } from '../../store/editorStore';
import { sortColumnsByKeyPriority } from '../../lib/columnSort';
import { KeyBadge } from '../common/KeyBadge';
import { ColumnTooltip, hasTooltipContent } from './ColumnTooltip';
import './ModelNode.css';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Fallback abbreviations for when layerConfig is not available
const LAYER_BADGE_FALLBACK: Record<string, string> = {
  bronze: 'BRZ',
  silver: 'SLV',
  gold: 'GLD',
};

/** Short abbreviations for model role badges. */
const ROLE_BADGE_LABEL: Record<ModelRole, string> = {
  'conformed-dim': 'CONF',
  'domain-dim': 'DIM',
  'transaction-fact': 'TXN',
  'periodic-snapshot': 'PER',
  'accumulating-snapshot': 'ACC',
  'factless-fact': 'BRG',
  'reference': 'REF',
  'gold-fact': 'GFCT',
  'gold-dim': 'GDIM',
};

/** Colour for each model role badge (text + background at 20% opacity). */
const ROLE_BADGE_COLOR: Record<ModelRole, string> = {
  'conformed-dim': '#6366f1',
  'domain-dim': '#6366f1',
  'transaction-fact': '#e11d48',
  'periodic-snapshot': '#e11d48',
  'accumulating-snapshot': '#e11d48',
  'factless-fact': '#a855f7',
  'reference': '#059669',
  'gold-fact': '#d97706',
  'gold-dim': '#d97706',
};

/** Unicode circled numbers for SCD type badges. */
const SCD_BADGE: Record<number, string> = {
  0: '\u24EA', // ⓪
  1: '\u2460', // ①
  2: '\u2461', // ②
};

/** Symbols for additive type badges. */
const ADDITIVE_BADGE: Record<string, string> = {
  'additive': '\u03A3',      // Σ
  'semi-additive': '~',
  'non-additive': '\u00F7',  // ÷
};

/**
 * Node-level handles — invisible connection points on each side of the card.
 * FkEdge connects to these for Power BI-style routing (least bends).
 */
const NODE_HANDLE_STYLE: CSSProperties = {
  width: 1,
  height: 1,
  minWidth: 0,
  minHeight: 0,
  opacity: 0,
  pointerEvents: 'none',
};

// ---------------------------------------------------------------------------
// ColumnRow — individual column with long-press drag support
// ---------------------------------------------------------------------------

interface ColumnRowProps {
  column: ColumnDisplay;
  modelName: string;
  /** Column-level discrepancy indicator (from cross-stage comparison). */
  discrepancy?: ColumnDiscrepancy;
}

function ColumnRow({ column, modelName, discrepancy }: ColumnRowProps) {
  // Highlight when this column is involved in a selected edge
  const isHighlighted = useEditorStore(
    (s) => s.highlightedColumns?.has?.(`${modelName}:${column.name}`) ?? false
  );

  // Store actions for drag line visualization
  const startDragLine = useEditorStore((s) => s.startDragLine);
  const updateDragLineMouse = useEditorStore((s) => s.updateDragLineMouse);
  const endDragLine = useEditorStore((s) => s.endDragLine);

  // Stable selector: only re-renders when drag starts/ends, not on every mouse move
  const dragSourceModel = useEditorStore((s) => s.dragLineState?.sourceModelName ?? null);

  // Track whether cursor is over this column during a cross-model drag
  const [isDropTarget, setIsDropTarget] = useState(false);

  // Tooltip hover state — delayed show, instant hide
  const [showTooltip, setShowTooltip] = useState(false);
  const tooltipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tooltipEligible = hasTooltipContent(column);

  // Reset drop target state when drag ends
  useEffect(() => {
    if (!dragSourceModel) setIsDropTarget(false);
  }, [dragSourceModel]);

  // Ref to the column element for position calculation
  const elementRef = useRef<HTMLDivElement>(null);

  const { isPressing, isDragging, endDrag, handlers } = useLongPressDrag({
    delay: 220,
    onLongPressStart: () => {
      // Calculate absolute position of the column element center
      if (elementRef.current) {
        const rect = elementRef.current.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        startDragLine(modelName, column.name, centerX, centerY);
      }
    },
  });

  // Track mounted state to prevent state updates after unmount
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // When drag starts, track mouse position and detect drop target
  useEffect(() => {
    if (!isDragging) return;

    const handleGlobalMouseMove = (e: MouseEvent) => {
      if (!mountedRef.current) return;
      updateDragLineMouse(e.clientX, e.clientY);
    };

    const handleGlobalMouseUp = (e: MouseEvent) => {
      if (!mountedRef.current) return;

      const targetElement = document.elementFromPoint(e.clientX, e.clientY);
      if (!targetElement) {
        endDrag();
        endDragLine();
        return;
      }

      const columnRow = targetElement.closest('[data-column-name]') as HTMLElement | null;
      const modelNode = targetElement.closest('[data-model-name]') as HTMLElement | null;

      if (columnRow && modelNode) {
        const targetColumnName = columnRow.dataset.columnName;
        const targetModelName = modelNode.dataset.modelName;

        if (targetColumnName && targetModelName && targetModelName !== modelName) {
          window.dispatchEvent(
            new CustomEvent('column-relationship-drop', {
              detail: {
                fromModel: modelName,
                fromColumn: column.name,
                toModel: targetModelName,
                toColumn: targetColumnName,
              },
            }),
          );
        } else if (targetModelName === modelName) {
          window.dispatchEvent(
            new CustomEvent('column-relationship-self-drop'),
          );
        }
      }

      endDrag();
      endDragLine();
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (!mountedRef.current) return;
        endDrag();
        endDragLine();
      }
    };

    window.addEventListener('mousemove', handleGlobalMouseMove);
    window.addEventListener('mouseup', handleGlobalMouseUp);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('mousemove', handleGlobalMouseMove);
      window.removeEventListener('mouseup', handleGlobalMouseUp);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isDragging, endDrag, endDragLine, updateDragLineMouse, modelName, column.name]);

  // Drop target: highlight when dragging from a different model and hovering this column
  const isValidDropTarget = dragSourceModel !== null && dragSourceModel !== modelName;

  // Hide tooltip when drag/press starts
  useEffect(() => {
    if (isPressing || isDragging) {
      if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
      setShowTooltip(false);
    }
  }, [isPressing, isDragging]);

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
    };
  }, []);

  const handleMouseEnter = useCallback(() => {
    if (isValidDropTarget) setIsDropTarget(true);
    if (tooltipEligible && !isDragging && !isPressing) {
      tooltipTimerRef.current = setTimeout(() => setShowTooltip(true), 450);
    }
  }, [isValidDropTarget, tooltipEligible, isDragging, isPressing]);

  const handleMouseLeave = useCallback(() => {
    setIsDropTarget(false);
    if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
    setShowTooltip(false);
    handlers.onMouseLeave();
  }, [handlers]);

  const pressClass = isPressing ? 'model-node__column--pressing' : '';
  const dragClass = isDragging ? 'model-node__column--dragging' : '';
  const dropTargetClass = isDropTarget ? 'model-node__column--drop-target' : '';
  const highlightClass = isHighlighted ? 'model-node__column--relationship-highlight' : '';
  const discrepancyClass = discrepancy?.status === 'extra' ? 'model-node__column--disc-extra'
    : discrepancy?.status === 'type-mismatch' ? 'model-node__column--disc-mismatch'
    : '';

  return (
    <div
      ref={elementRef}
      className={`model-node__column ${pressClass} ${dragClass} ${dropTargetClass} ${highlightClass} ${discrepancyClass} nodrag`.trim()}
      data-column-name={column.name}
      onMouseEnter={handleMouseEnter}
      {...handlers}
      onMouseLeave={handleMouseLeave}
    >
      <span className="model-node__col-indicators">
        {column.isPrimaryKey && (
          <KeyBadge type="PK" active={true} mode="readonly" />
        )}
        {column.isForeignKey && (
          <KeyBadge type="FK" active={true} mode="readonly" />
        )}
        {column.isNaturalKey && (
          <KeyBadge type="NK" active={true} mode="readonly" />
        )}
      </span>
      <span className="model-node__col-name" title={column.name}>
        {column.name}
      </span>
      {discrepancy?.status === 'type-mismatch' ? (
        <span className="model-node__col-type model-node__col-type--mismatch" title={`${discrepancy.sourceDataType} in this stage, ${discrepancy.targetDataType} in comparison`}>
          {discrepancy.sourceDataType} <span className="model-node__col-type-arrow">&rarr;</span> {discrepancy.targetDataType}
        </span>
      ) : (
        <span className="model-node__col-type">{column.dataType}</span>
      )}
      {discrepancy?.status === 'extra' && (
        <span className="model-node__col-disc-badge model-node__col-disc-badge--extra" title="Not in comparison stage">extra</span>
      )}
      {column.scdType != null && SCD_BADGE[column.scdType] && (
        <span
          className="model-node__col-badge model-node__col-badge--scd"
          title={`SCD Type ${column.scdType}`}
        >
          {SCD_BADGE[column.scdType]}
        </span>
      )}
      {column.additiveType && ADDITIVE_BADGE[column.additiveType] && (
        <span
          className="model-node__col-badge model-node__col-badge--additive"
          title={column.additiveType}
        >
          {ADDITIVE_BADGE[column.additiveType]}
        </span>
      )}
      <ColumnTooltip column={column} anchorRef={elementRef} visible={showTooltip} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// ModelNode Component
// ---------------------------------------------------------------------------

function ModelNodeComponent({ data }: NodeProps<ModelFlowNode>) {
  const { modelName, stage, layer, layerConfig, columns, hasRationale, grain, modelRole, dimmed, readOnly, isGhost, isExpanded = false, onToggleExpansion, discrepancy } = data;
  const openNodeContextMenu = useEditorStore((s) => s.openNodeContextMenu);

  // F405: Compute visible columns based on expansion state
  const { displayColumns, hiddenCount } = useMemo(() => {
    const shouldCollapse = columns.length > COLLAPSED_COLUMN_LIMIT && !isExpanded;
    return {
      displayColumns: shouldCollapse ? columns.slice(0, COLLAPSED_COLUMN_LIMIT) : columns,
      hiddenCount: shouldCollapse ? columns.length - COLLAPSED_COLUMN_LIMIT : 0,
    };
  }, [columns, isExpanded]);

  // Handler for expand/collapse button
  const handleToggleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onToggleExpansion?.(modelName);
  };

  // Handler for right-click to open context menu
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      openNodeContextMenu(e.clientX, e.clientY, modelName);
    },
    [openNodeContextMenu, modelName],
  );

  // Sort columns by key priority
  const sortedColumns = useMemo(
    () => sortColumnsByKeyPriority(displayColumns),
    [displayColumns]
  );

  // Build column discrepancy lookup (keyed by column name)
  const columnDiscrepancyMap = useMemo(() => {
    if (!discrepancy?.columns?.length) return undefined;
    const map = new Map<string, ColumnDiscrepancy>();
    for (const cd of discrepancy.columns) {
      map.set(cd.name, cd);
    }
    return map;
  }, [discrepancy]);

  // Missing columns (ghost rows) — only shown when expanded
  const missingColumns = useMemo(() => {
    if (!isExpanded || !columnDiscrepancyMap) return [];
    return (discrepancy?.columns ?? []).filter((cd) => cd.status === 'missing');
  }, [isExpanded, columnDiscrepancyMap, discrepancy]);

  // Determine CSS modifier for stage/ghost
  const isDiscExtra = discrepancy?.status === 'extra';
  const stageClass = isGhost ? 'ghost' : stage;

  return (
    <div
      className={`model-node model-node--${stageClass}${dimmed ? ' model-node--dimmed' : ''}${readOnly ? ' model-node--readonly' : ''}${isDiscExtra ? ' model-node--disc-extra' : ''}`}
      data-model-name={modelName}
      onContextMenu={handleContextMenu}
    >
      {/* Node-level handles — one source + one target per side */}
      <Handle type="source" position={Position.Top} id="node-top-src" style={NODE_HANDLE_STYLE} />
      <Handle type="target" position={Position.Top} id="node-top-tgt" style={NODE_HANDLE_STYLE} />
      <Handle type="source" position={Position.Right} id="node-right-src" style={NODE_HANDLE_STYLE} />
      <Handle type="target" position={Position.Right} id="node-right-tgt" style={NODE_HANDLE_STYLE} />
      <Handle type="source" position={Position.Bottom} id="node-bottom-src" style={NODE_HANDLE_STYLE} />
      <Handle type="target" position={Position.Bottom} id="node-bottom-tgt" style={NODE_HANDLE_STYLE} />
      <Handle type="source" position={Position.Left} id="node-left-src" style={NODE_HANDLE_STYLE} />
      <Handle type="target" position={Position.Left} id="node-left-tgt" style={NODE_HANDLE_STYLE} />

      {/* Header */}
      <div className="model-node__header">
        <span className="model-node__name" title={modelName}>
          {modelName}
        </span>
        {hasRationale && (
          <span className="model-node__rationale-badge" title="Design rationale available">R</span>
        )}
        {modelRole && ROLE_BADGE_LABEL[modelRole] && (
          <span
            className="model-node__role-badge"
            style={{
              backgroundColor: `${ROLE_BADGE_COLOR[modelRole]}33`,
              color: ROLE_BADGE_COLOR[modelRole],
            }}
            title={modelRole}
          >
            {ROLE_BADGE_LABEL[modelRole]}
          </span>
        )}
        <span
          className="model-node__badge"
          style={layerConfig?.color ? {
            backgroundColor: `${layerConfig.color}33`,
            color: layerConfig.color,
          } : undefined}
        >
          {layerConfig?.abbreviation ?? LAYER_BADGE_FALLBACK[layer] ?? layer.substring(0, 3).toUpperCase()}
        </span>
        {isDiscExtra && (
          <span className="model-node__discrepancy-badge" title="Model not in comparison stage">
            extra
          </span>
        )}
      </div>

      {/* Grain subtitle */}
      {grain && (
        <div className="model-node__grain" title={grain}>
          {grain}
        </div>
      )}

      {/* Columns — sorted by key priority */}
      <div className="model-node__columns">
        {sortedColumns.map((col) => (
          <ColumnRow
            key={col.name}
            column={col}
            modelName={modelName}
            discrepancy={columnDiscrepancyMap?.get(col.name)}
          />
        ))}

        {/* F405: Expansion button when columns are collapsed */}
        {hiddenCount > 0 && (
          <button
            className="model-node__expand-button"
            onClick={handleToggleClick}
            title={`Show ${hiddenCount} more column${hiddenCount !== 1 ? 's' : ''}`}
          >
            ...and {hiddenCount} more
          </button>
        )}

        {/* F405: Collapse button when expanded */}
        {isExpanded && columns.length > COLLAPSED_COLUMN_LIMIT && (
          <button
            className="model-node__expand-button"
            onClick={handleToggleClick}
            title="Show fewer columns"
          >
            Show less
          </button>
        )}

        {/* Ghost rows for missing columns (discrepancy overlay) */}
        {missingColumns.length > 0 && (
          <>
            <div className="model-node__separator model-node__separator--disc">
              <span className="model-node__separator-label model-node__separator-label--missing">missing in this stage</span>
            </div>
            {missingColumns.map((cd) => (
              <div key={`ghost-${cd.name}`} className="model-node__column model-node__column--disc-missing nodrag">
                <span className="model-node__col-name">{cd.name}</span>
                <span className="model-node__col-type">{cd.targetDataType ?? ''}</span>
                <span className="model-node__col-disc-badge model-node__col-disc-badge--missing">missing</span>
              </div>
            ))}
          </>
        )}

        {columns.length === 0 && !missingColumns.length && (
          <div className="model-node__empty">No columns</div>
        )}
      </div>

      {/* Footer */}
      <div className="model-node__footer">
        {columns.length} {columns.length === 1 ? 'column' : 'columns'}
        {discrepancy && discrepancy.columns.length > 0 && (() => {
          const issues = discrepancy.columns.filter((c) => c.status !== 'matched').length;
          return issues > 0 ? (
            <span className="model-node__footer-disc" title={`${issues} column discrepanc${issues === 1 ? 'y' : 'ies'}`}>
              {' '}&middot; {issues} diff{issues !== 1 ? 's' : ''}
            </span>
          ) : null;
        })()}
      </div>
    </div>
  );
}

export const ModelNode = memo(ModelNodeComponent);
