/**
 * ModelNode — read-only custom React Flow node for displaying a semantic model card.
 *
 * Simplified version for Confluence macro viewer. No editing, no drag-to-relate,
 * no context menus. Supports column expansion and badge display.
 */

import { memo, useMemo, type CSSProperties } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { ModelFlowNode, ColumnDisplay } from '../../types/graph';
import type { ModelRole } from '../../types/semantic';
import { STAGE_HEX } from '../../lib/stageColors';
import './ModelNode.css';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COLLAPSED_COLUMN_LIMIT = 8;

const LAYER_BADGE_FALLBACK: Record<string, string> = {
  bronze: 'BRZ',
  silver: 'SLV',
  gold: 'GLD',
};

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

const SCD_BADGE: Record<number, string> = {
  0: '\u24EA', // circled 0
  1: '\u2460', // circled 1
  2: '\u2461', // circled 2
};

const ADDITIVE_BADGE: Record<string, string> = {
  'additive': '\u03A3',      // Sigma
  'semi-additive': '~',
  'non-additive': '\u00F7',  // division sign
};

const NODE_HANDLE_STYLE: CSSProperties = {
  width: 1,
  height: 1,
  minWidth: 0,
  minHeight: 0,
  opacity: 0,
  pointerEvents: 'none',
};

// Simple data type color mapping for read-only display
function getDataTypeColor(dataType: string): string {
  const dt = dataType.toUpperCase();
  if (dt.includes('INT') || dt.includes('FLOAT') || dt.includes('DECIMAL') || dt.includes('NUMBER') || dt.includes('NUMERIC') || dt.includes('DOUBLE') || dt.includes('BIGINT')) return '#d19a66';
  if (dt.includes('DATE') || dt.includes('TIME') || dt.includes('TIMESTAMP')) return '#c678dd';
  if (dt.includes('BOOL')) return '#e06c75';
  if (dt.includes('JSON') || dt.includes('VARIANT') || dt.includes('OBJECT') || dt.includes('ARRAY')) return '#56b6c2';
  return '#6b778c';
}

// ---------------------------------------------------------------------------
// ColumnRow — read-only column display
// ---------------------------------------------------------------------------

interface ColumnRowProps {
  column: ColumnDisplay;
  modelName: string;
}

function ColumnRow({ column, modelName }: ColumnRowProps) {
  return (
    <div
      className="model-node__column nodrag"
      data-column-name={column.name}
    >
      <span className="model-node__col-indicators">
        {column.isPrimaryKey && (
          <span className="model-node__key-badge model-node__key-badge--pk" title="Primary Key">PK</span>
        )}
        {column.isForeignKey && (
          <span className="model-node__key-badge model-node__key-badge--fk" title="Foreign Key">FK</span>
        )}
        {column.isNaturalKey && (
          <span className="model-node__key-badge model-node__key-badge--nk" title="Natural Key">NK</span>
        )}
      </span>
      <span
        className="model-node__col-name"
        title={column.name}
      >
        {column.name}
      </span>
      <span
        className="model-node__col-type"
        style={{ color: getDataTypeColor(column.dataType) }}
      >
        {column.dataType}
      </span>
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// ModelNode Component
// ---------------------------------------------------------------------------

function ModelNodeComponent({ data }: NodeProps<ModelFlowNode>) {
  const {
    modelName, stage, layer, layerConfig, columns,
    hasRationale, grain, modelRole, dimmed, readOnly,
    isGhost, isExpanded = false, onToggleExpansion,
  } = data;

  const { displayColumns, hiddenCount } = useMemo(() => {
    const shouldCollapse = columns.length > COLLAPSED_COLUMN_LIMIT && !isExpanded;
    return {
      displayColumns: shouldCollapse ? columns.slice(0, COLLAPSED_COLUMN_LIMIT) : columns,
      hiddenCount: shouldCollapse ? columns.length - COLLAPSED_COLUMN_LIMIT : 0,
    };
  }, [columns, isExpanded]);

  const handleToggleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onToggleExpansion?.(modelName);
  };

  const stageClass = isGhost ? 'ghost' : stage;

  return (
    <div
      className={`model-node model-node--${stageClass}${dimmed ? ' model-node--dimmed' : ''}${readOnly ? ' model-node--readonly' : ''}`}
      data-model-name={modelName}
    >
      {/* Node-level handles */}
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
      </div>

      {/* Grain subtitle */}
      {grain && (
        <div className="model-node__grain" title={grain}>
          {grain}
        </div>
      )}

      {/* Columns */}
      <div className="model-node__columns">
        {displayColumns.map((col) => (
          <ColumnRow
            key={col.name}
            column={col}
            modelName={modelName}
          />
        ))}

        {hiddenCount > 0 && (
          <button
            className="model-node__expand-button"
            onClick={handleToggleClick}
            title={`Show ${hiddenCount} more column${hiddenCount !== 1 ? 's' : ''}`}
          >
            ...and {hiddenCount} more
          </button>
        )}

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
