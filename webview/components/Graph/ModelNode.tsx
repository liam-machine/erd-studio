/**
 * ModelNode — custom React Flow node for displaying a semantic model card.
 *
 * Shows model name with a layer badge, a list of columns with PK/FK
 * indicators and data types, and a footer with the total column count.
 * Border colour indicates model status: green (built), orange (design),
 * grey (missing).
 *
 * Provides two kinds of React Flow handles:
 *   1. **Node-level handles** (top/right/bottom/left) — used by FkEdge for
 *      Power BI-style connections that route to whichever side creates the
 *      least bends.
 *   2. **Column-level handles** (col-{name}-{side}-{type}) — bidirectional
 *      handles on both left and right sides for drag-to-connect relationships.
 *      Each side has both source and target handles to allow connections from
 *      any direction.
 */

import { memo, useCallback, useMemo, type CSSProperties } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { ModelFlowNode } from '../../types/graph';
import { COLLAPSED_COLUMN_LIMIT } from '../../hooks/useColumnExpansion';
import { useEditorStore } from '../../store/editorStore';
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

/** Sanitise a column name for use as a React Flow handle ID. */
function handleId(column: string, side: 'left' | 'right', type: 'src' | 'tgt'): string {
  const safe = column.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `col-${safe}-${side}-${type}`;
}

/** Shared inline style for per-column handles (avoids !important overrides). */
const HANDLE_STYLE: CSSProperties = {
  width: 14,
  height: 14,
  minWidth: 0,
  minHeight: 0,
  background: 'var(--focus-border)',
  border: '2px solid var(--editor-bg)',
  borderRadius: '50%',
  // opacity is controlled by CSS (.model-node__handle) so hover transitions work.
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
// Component
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

  return (
    <div
      className={`model-node model-node--${status}${dimmed ? ' model-node--dimmed' : ''}`}
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

      {/* Columns — ordered: built first, then planned/missing with separator */}
      <div className="model-node__columns">
        {(() => {
          const builtCols = displayColumns.filter((c) => c.status === 'built');
          const plannedCols = displayColumns.filter((c) => c.status !== 'built');
          const showSeparator = builtCols.length > 0 && plannedCols.length > 0;

          return (
            <>
              {builtCols.map((col) => (
                <div key={col.name} className="model-node__column model-node__column--built">
                  {/* F405: Only show column handles when expanded */}
                  {/* Bidirectional handles: both source and target on each side */}
                  {!isCollapsed && (
                    <>
                      <Handle
                        type="source"
                        position={Position.Left}
                        id={handleId(col.name, 'left', 'src')}
                        className="model-node__handle"
                        style={HANDLE_STYLE}
                      />
                      <Handle
                        type="target"
                        position={Position.Left}
                        id={handleId(col.name, 'left', 'tgt')}
                        className="model-node__handle"
                        style={HANDLE_STYLE}
                      />
                    </>
                  )}

                  <span className="model-node__col-indicators">
                    {col.isPrimaryKey && (
                      <span className="model-node__pk" title="Primary Key">
                        PK
                      </span>
                    )}
                    {col.isForeignKey && (
                      <span className="model-node__fk" title="Foreign Key">
                        FK
                      </span>
                    )}
                  </span>
                  <span className="model-node__col-name" title={col.name}>
                    {col.name}
                  </span>
                  <span className="model-node__col-type">{col.dataType}</span>

                  {!isCollapsed && (
                    <>
                      <Handle
                        type="source"
                        position={Position.Right}
                        id={handleId(col.name, 'right', 'src')}
                        className="model-node__handle"
                        style={HANDLE_STYLE}
                      />
                      <Handle
                        type="target"
                        position={Position.Right}
                        id={handleId(col.name, 'right', 'tgt')}
                        className="model-node__handle"
                        style={HANDLE_STYLE}
                      />
                    </>
                  )}
                </div>
              ))}

              {showSeparator && (
                <div className="model-node__separator">
                  <span className="model-node__separator-label">planned</span>
                </div>
              )}

              {plannedCols.map((col) => (
                <div
                  key={col.name}
                  className={`model-node__column model-node__column--${col.status}`}
                >
                  {/* Bidirectional handles: both source and target on each side */}
                  {!isCollapsed && (
                    <>
                      <Handle
                        type="source"
                        position={Position.Left}
                        id={handleId(col.name, 'left', 'src')}
                        className="model-node__handle"
                        style={HANDLE_STYLE}
                      />
                      <Handle
                        type="target"
                        position={Position.Left}
                        id={handleId(col.name, 'left', 'tgt')}
                        className="model-node__handle"
                        style={HANDLE_STYLE}
                      />
                    </>
                  )}

                  <span className="model-node__col-indicators">
                    {col.isPrimaryKey && (
                      <span className="model-node__pk model-node__pk--planned" title="Primary Key (planned)">
                        PK
                      </span>
                    )}
                    {col.isForeignKey && (
                      <span className="model-node__fk model-node__fk--planned" title="Foreign Key (planned)">
                        FK
                      </span>
                    )}
                  </span>
                  <span className="model-node__col-name" title={col.name}>
                    {col.name}
                  </span>
                  <span className="model-node__col-type">{col.dataType}</span>

                  {!isCollapsed && (
                    <>
                      <Handle
                        type="source"
                        position={Position.Right}
                        id={handleId(col.name, 'right', 'src')}
                        className="model-node__handle"
                        style={HANDLE_STYLE}
                      />
                      <Handle
                        type="target"
                        position={Position.Right}
                        id={handleId(col.name, 'right', 'tgt')}
                        className="model-node__handle"
                        style={HANDLE_STYLE}
                      />
                    </>
                  )}
                </div>
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
            </>
          );
        })()}

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
