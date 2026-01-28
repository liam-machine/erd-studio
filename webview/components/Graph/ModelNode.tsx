/**
 * ModelNode — custom React Flow node for displaying a semantic model card.
 *
 * Shows model name with a layer badge, a list of columns with PK/FK
 * indicators and data types, and a footer with the total column count.
 * Border colour indicates model status: green (built), orange (design),
 * grey (missing).
 *
 * Each column row has left (target) and right (source) React Flow handles
 * with IDs like `col-{columnName}-left` / `col-{columnName}-right` so that
 * FK edges (F107) and ELK layout (F109) can route to specific columns.
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
  width: 8,
  height: 8,
  minWidth: 0,
  minHeight: 0,
  background: 'var(--focus-border)',
  border: '1.5px solid var(--editor-bg)',
  // opacity is controlled by CSS (.model-node__handle) so hover transitions work.
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function ModelNodeComponent({ data }: NodeProps<ModelFlowNode>) {
  const { modelName, status, layer, columns } = data;

  return (
    <div className={`model-node model-node--${status}`}>
      {/* Header */}
      <div className="model-node__header">
        <span className="model-node__name" title={modelName}>
          {modelName}
        </span>
        <span className="model-node__badge">{LAYER_BADGE[layer] ?? layer}</span>
      </div>

      {/* Columns */}
      <div className="model-node__columns">
        {columns.map((col) => (
          <div key={col.name} className="model-node__column">
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
