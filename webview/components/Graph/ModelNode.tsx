/**
 * ModelNode — custom React Flow node for displaying a semantic model card.
 *
 * Shows model name with a layer badge, a list of columns with PK/FK
 * indicators and data types, and a footer with the total column count.
 * Border colour indicates model status: green (built), orange (design),
 * grey (missing).
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

import { memo, useCallback, useMemo, useEffect, useRef, type CSSProperties } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { ModelFlowNode, ColumnDisplay } from '../../types/graph';
import { COLLAPSED_COLUMN_LIMIT } from '../../hooks/useColumnExpansion';
import { useLongPressDrag } from '../../hooks/useLongPressDrag';
import { useEditorStore } from '../../store/editorStore';
import { groupColumnsByStatus } from '../../lib/columnGrouping';
import { KeyBadge } from '../common/KeyBadge';
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
  isBuilt: boolean;
}

function ColumnRow({ column, modelName, isBuilt }: ColumnRowProps) {
  // Store actions for drag line visualization
  const startDragLine = useEditorStore((s) => s.startDragLine);
  const updateDragLineMouse = useEditorStore((s) => s.updateDragLineMouse);
  const endDragLine = useEditorStore((s) => s.endDragLine);

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
      // Guard against unmounted component
      if (!mountedRef.current) return;

      // Find the element under the cursor
      const targetElement = document.elementFromPoint(e.clientX, e.clientY);
      if (!targetElement) {
        endDrag();
        endDragLine();
        return;
      }

      // Look for a column row element (has data-column-name attribute)
      const columnRow = targetElement.closest('[data-column-name]') as HTMLElement | null;
      const modelNode = targetElement.closest('[data-model-name]') as HTMLElement | null;

      if (columnRow && modelNode) {
        const targetColumnName = columnRow.dataset.columnName;
        const targetModelName = modelNode.dataset.modelName;

        if (targetColumnName && targetModelName && targetModelName !== modelName) {
          // Valid drop target — dispatch custom event for App to handle
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
          // Dropped on same model — show toast via event
          window.dispatchEvent(
            new CustomEvent('column-relationship-self-drop'),
          );
        }
      }

      endDrag();
      endDragLine();
    };

    // Also handle Escape key to cancel drag
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

  const statusClass = isBuilt
    ? 'model-node__column--built'
    : `model-node__column--${column.status}`;

  const pressClass = isPressing ? 'model-node__column--pressing' : '';
  const dragClass = isDragging ? 'model-node__column--dragging' : '';

  return (
    <div
      ref={elementRef}
      className={`model-node__column ${statusClass} ${pressClass} ${dragClass} nodrag`.trim()}
      data-column-name={column.name}
      {...handlers}
    >
      <span className="model-node__col-indicators">
        {column.isPrimaryKey && (
          <KeyBadge
            type="PK"
            active={true}
            mode="readonly"
            status={isBuilt ? 'built' : 'planned'}
          />
        )}
        {column.isForeignKey && (
          <KeyBadge
            type="FK"
            active={true}
            mode="readonly"
            status={isBuilt ? 'built' : 'planned'}
          />
        )}
        {column.isNaturalKey && (
          <KeyBadge
            type="NK"
            active={true}
            mode="readonly"
            status={isBuilt ? 'built' : 'planned'}
          />
        )}
      </span>
      <span className="model-node__col-name" title={column.name}>
        {column.name}
      </span>
      <span className="model-node__col-type">{column.dataType}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ModelNode Component
// ---------------------------------------------------------------------------

function ModelNodeComponent({ data }: NodeProps<ModelFlowNode>) {
  const { modelName, status, approved, layer, layerConfig, columns, dimmed, isExpanded = false, onToggleExpansion } = data;
  const openNodeContextMenu = useEditorStore((s) => s.openNodeContextMenu);

  // F405: Compute visible columns based on expansion state
  const { displayColumns, hiddenCount, isCollapsed } = useMemo(() => {
    const shouldCollapse = columns.length > COLLAPSED_COLUMN_LIMIT && !isExpanded;
    return {
      displayColumns: shouldCollapse ? columns.slice(0, COLLAPSED_COLUMN_LIMIT) : columns,
      hiddenCount: shouldCollapse ? columns.length - COLLAPSED_COLUMN_LIMIT : 0,
      isCollapsed: shouldCollapse,
    };
  }, [columns, isExpanded]);

  // Handler for expand/collapse button
  const handleToggleClick = (e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent node selection
    onToggleExpansion?.(modelName);
  };

  // Handler for right-click to open context menu
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      openNodeContextMenu(e.clientX, e.clientY, modelName, status, approved);
    },
    [openNodeContextMenu, modelName, status, approved],
  );

  // Group columns by status: built -> approved -> planned
  const { built: builtCols, approved: approvedCols, planned: plannedCols } = useMemo(
    () => groupColumnsByStatus(displayColumns),
    [displayColumns]
  );
  const showBuiltApprovedSeparator = builtCols.length > 0 && approvedCols.length > 0;
  const showApprovedPlannedSeparator = (builtCols.length > 0 || approvedCols.length > 0) && plannedCols.length > 0;

  return (
    <div
      className={`model-node model-node--${status}${dimmed ? ' model-node--dimmed' : ''}`}
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
        <span
          className="model-node__badge"
          style={layerConfig?.color ? {
            backgroundColor: `${layerConfig.color}33`, // 20% opacity
            color: layerConfig.color,
          } : undefined}
        >
          {layerConfig?.abbreviation ?? LAYER_BADGE_FALLBACK[layer] ?? layer.substring(0, 3).toUpperCase()}
        </span>
      </div>

      {/* Columns — ordered: built -> approved -> planned with separators */}
      <div className="model-node__columns">
        {/* Built columns */}
        {builtCols.map((col) => (
          <ColumnRow
            key={col.name}
            column={col}
            modelName={modelName}
            isBuilt={true}
          />
        ))}

        {/* Separator: built -> approved */}
        {showBuiltApprovedSeparator && (
          <div className="model-node__separator model-node__separator--subtle" />
        )}

        {/* Approved columns */}
        {approvedCols.map((col) => (
          <ColumnRow
            key={col.name}
            column={col}
            modelName={modelName}
            isBuilt={false}
          />
        ))}

        {/* Separator: approved -> planned */}
        {showApprovedPlannedSeparator && (
          <div className="model-node__separator model-node__separator--subtle" />
        )}

        {/* Planned columns */}
        {plannedCols.map((col) => (
          <ColumnRow
            key={col.name}
            column={col}
            modelName={modelName}
            isBuilt={false}
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

        {columns.length === 0 && (
          <div className="model-node__empty">No columns</div>
        )}
      </div>

      {/* Footer */}
      <div className="model-node__footer">
        {columns.length} {columns.length === 1 ? 'column' : 'columns'}
      </div>
    </div>
  );
}

export const ModelNode = memo(ModelNodeComponent);
