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
 *   2. **Column-level handles** (col-{name}-left/right) — reserved for
 *      future column-specific routing (F109 ELK, F205 drag-to-connect).
 */

import { memo, type CSSProperties } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { ModelFlowNode } from '../../types/graph';
import './ModelNode.css';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LAYER_BADGE: Record<string, string> = {
  bronze: 'BRZ',
  silver: 'SLV',
  gold: 'GLD',
};

/** Sanitise a column name for use as a React Flow handle ID. */
function handleId(column: string, side: 'left' | 'right'): string {
  const safe = column.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `col-${safe}-${side}`;
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
  const { modelName, status, layer, columns } = data;

  return (
    <div className={`model-node model-node--${status}`}>
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
        <span className="model-node__badge">{LAYER_BADGE[layer] ?? layer}</span>
      </div>

      {/* Columns — ordered: built first, then planned/missing with separator */}
      <div className="model-node__columns">
        {(() => {
          const builtCols = columns.filter((c) => c.status === 'built');
          const plannedCols = columns.filter((c) => c.status !== 'built');
          const showSeparator = builtCols.length > 0 && plannedCols.length > 0;

          return (
            <>
              {builtCols.map((col) => (
                <div key={col.name} className="model-node__column model-node__column--built">
                  <Handle
                    type="target"
                    position={Position.Left}
                    id={handleId(col.name, 'left')}
                    className="model-node__handle"
                    style={HANDLE_STYLE}
                  />

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

                  <Handle
                    type="source"
                    position={Position.Right}
                    id={handleId(col.name, 'right')}
                    className="model-node__handle"
                    style={HANDLE_STYLE}
                  />
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
                  <Handle
                    type="target"
                    position={Position.Left}
                    id={handleId(col.name, 'left')}
                    className="model-node__handle"
                    style={HANDLE_STYLE}
                  />

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

                  <Handle
                    type="source"
                    position={Position.Right}
                    id={handleId(col.name, 'right')}
                    className="model-node__handle"
                    style={HANDLE_STYLE}
                  />
                </div>
              ))}
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
