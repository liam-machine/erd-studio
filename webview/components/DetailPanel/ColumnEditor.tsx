/**
 * ColumnEditor — editable column list for the DetailPanel.
 *
 * Renders columns in file order (user-controlled via drag-to-reorder).
 * Supports adding new columns and inline editing.
 * Uses ColumnRowEditor for consistent column row rendering.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { ColumnRowEditor } from '../common/ColumnRowEditor';
import { BulkColumnActions } from './BulkColumnActions';
import { useMessageBus } from '../../hooks/useMessageBus';
import { useColumnReorder } from '../../hooks/useColumnReorder';
import { useEditorStore } from '../../store/editorStore';
import type { DisplayColumn } from '../../../src/types/display';
import type { ColumnDef, ModelRole } from '../../../src/types/semantic';
import type { ColumnKeyType } from '../../../src/types/messages';
import './ColumnEditor.css';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ColumnEditorProps {
  modelName: string;
  columns: DisplayColumn[];
  /** Whether this model/stage is read-only. */
  readOnly?: boolean;
  /** Parent model's role — passed to column rows for conditional SCD/additive dropdowns. */
  modelRole?: ModelRole;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ColumnEditor({ modelName, columns, readOnly, modelRole }: ColumnEditorProps) {
  const { send } = useMessageBus(() => {});

  // Column selection state from store
  const selectedColumns = useEditorStore((s) => s.selectedColumns);
  const editingColumn = useEditorStore((s) => s.editingColumn);
  const selectColumn = useEditorStore((s) => s.selectColumn);
  const toggleColumnSelection = useEditorStore((s) => s.toggleColumnSelection);
  const selectColumnRange = useEditorStore((s) => s.selectColumnRange);
  const clearColumnSelection = useEditorStore((s) => s.clearColumnSelection);

  // State for whether we're adding a new column
  const [isAddingColumn, setIsAddingColumn] = useState(false);

  // State for tracking expanded columns (by column name)
  const [expandedColumns, setExpandedColumns] = useState<Set<string>>(new Set());

  // All column names (for duplicate validation)
  const existingColumnNames = useMemo(
    () => columns.map((c) => c.name),
    [columns],
  );

  const isEditable = !readOnly;

  // Column reorder via drag handle
  const handleReorder = useCallback(
    (orderedNames: string[]) => {
      send({
        type: 'reorderColumns',
        payload: { modelName, orderedNames },
      });
    },
    [send, modelName],
  );

  const { orderedColumns, dragIndex, dropIndex, getDragHandleProps } = useColumnReorder({
    columns,
    onReorder: handleReorder,
  });

  // Handle adding a new column
  const handleAddColumn = useCallback(() => {
    if (isAddingColumn) return;
    setIsAddingColumn(true);
  }, [isAddingColumn]);

  // Handle saving a column (add or update)
  const handleColumnUpdate = useCallback(
    (oldName: string, updated: ColumnDef, isNew: boolean) => {
      if (isNew) {
        send({
          type: 'addColumn',
          payload: { modelName, column: updated },
        });
        setIsAddingColumn(false);
      } else {
        send({
          type: 'updateColumn',
          payload: { modelName, oldColumnName: oldName, column: updated },
        });
      }
    },
    [send, modelName],
  );

  // Handle deleting a column
  const handleColumnDelete = useCallback(
    (columnName: string) => {
      send({
        type: 'removeColumn',
        payload: { modelName, columnName },
      });
    },
    [send, modelName],
  );

  // Handle cancelling new column add
  const handleCancelNew = useCallback(() => {
    setIsAddingColumn(false);
  }, []);

  // Handle toggling a single column's expanded state
  const handleToggleExpand = useCallback((columnName: string, opts?: { altKey?: boolean }) => {
    if (opts?.altKey) {
      // Alt+Click: expand all if this column was collapsed, collapse all if it was expanded
      setExpandedColumns((prev) => {
        if (prev.has(columnName)) {
          // Column was expanded → collapse all
          return new Set();
        } else {
          // Column was collapsed → expand all
          return new Set(columns.map((c) => c.name));
        }
      });
    } else {
      setExpandedColumns((prev) => {
        const next = new Set(prev);
        if (next.has(columnName)) {
          next.delete(columnName);
        } else {
          next.add(columnName);
        }
        return next;
      });
    }
  }, [columns]);

  // Expand all columns
  const handleExpandAll = useCallback(() => {
    setExpandedColumns(new Set(columns.map((c) => c.name)));
  }, [columns]);

  // Collapse all columns
  const handleCollapseAll = useCallback(() => {
    setExpandedColumns(new Set());
  }, []);

  // Prune stale selections when columns change (e.g. column deleted externally)
  useEffect(() => {
    const currentNames = new Set(columns.map((c) => c.name));
    const pruned = selectedColumns.filter((n) => currentNames.has(n));
    if (pruned.length !== selectedColumns.length) {
      // Some selected columns no longer exist — update store
      if (pruned.length === 0) {
        clearColumnSelection();
      } else {
        // Directly set to pruned list via selectColumn for single, or rebuild
        // We use a low-level approach: clear and re-select
        // Note: This is a rare edge case (column deleted while selected)
        clearColumnSelection();
      }
    }
  }, [columns, selectedColumns, clearColumnSelection]);

  // Build selection handler that checks modifier keys
  const handleColumnSelect = useCallback(
    (columnName: string, e: React.MouseEvent) => {
      const allNames = orderedColumns.map((c) => c.name);
      if (e.shiftKey) {
        selectColumnRange(columnName, allNames);
      } else if (e.ctrlKey || e.metaKey) {
        toggleColumnSelection(columnName);
      } else {
        selectColumn(columnName);
      }
    },
    [orderedColumns, selectColumn, toggleColumnSelection, selectColumnRange],
  );

  // Handle toggling key type (PK/FK/NK)
  const handleToggleKey = useCallback(
    (columnName: string, keyType: ColumnKeyType, currentValue: boolean) => {
      send({
        type: 'toggleColumnKey',
        payload: { modelName, columnName, keyType, value: !currentValue },
      });
    },
    [send, modelName],
  );

  // Compute whether model has multiple PKs (for warning display)
  const pkColumnNames = useMemo(
    () => columns.filter((c) => c.isPrimaryKey).map((c) => c.name),
    [columns],
  );
  const hasMultiplePKs = pkColumnNames.length > 1;

  // Check expansion state for UI
  const allExpanded = columns.length > 0 && expandedColumns.size === columns.length;
  const anyExpanded = expandedColumns.size > 0;

  // New column template for when user clicks "Add Column"
  const newColumnTemplate: DisplayColumn = {
    name: '',
    dataType: 'STRING',
    description: '',
    isPrimaryKey: false,
    isForeignKey: false,
    isNaturalKey: false,
  };

  return (
    <div className="column-editor">
      {/* Header */}
      <div className="column-editor__header">
        <h4 className="column-editor__title">
          Columns ({columns.length})
        </h4>
        <div className="column-editor__header-actions">
          {/* Expand/Collapse All buttons */}
          {columns.length > 0 && (
            <div className="column-editor__expand-controls">
              {!allExpanded && (
                <button
                  className="column-editor__expand-btn"
                  onClick={handleExpandAll}
                  data-tooltip="Expand all"
                  aria-label="Expand all descriptions"
                >
                  ⊞
                </button>
              )}
              {anyExpanded && (
                <button
                  className="column-editor__expand-btn"
                  onClick={handleCollapseAll}
                  data-tooltip="Collapse all"
                  aria-label="Collapse all descriptions"
                >
                  ⊟
                </button>
              )}
            </div>
          )}
          {isEditable && (
            <button
              className="column-editor__add-btn"
              onClick={handleAddColumn}
              disabled={isAddingColumn}
              title="Add column"
            >
              + Add Column
            </button>
          )}
        </div>
      </div>

      {/* Bulk actions toolbar — shown when multiple columns are selected */}
      {isEditable && selectedColumns.length > 1 && (
        <BulkColumnActions
          modelName={modelName}
          selectedColumns={selectedColumns}
          columns={columns}
          onClearSelection={clearColumnSelection}
        />
      )}

      {/* Column list */}
      <div className="column-editor__list">
        {columns.length === 0 && !isAddingColumn && (
          <div className="column-editor__empty">No columns</div>
        )}

        {orderedColumns.map((col, idx) => (
          <ColumnRowEditor
            key={col.name}
            column={col}
            mode={isEditable ? 'editable' : 'readonly'}
            existingColumnNames={existingColumnNames}
            onUpdate={isEditable ? (updated) => handleColumnUpdate(col.name, updated, false) : undefined}
            onDelete={isEditable ? () => handleColumnDelete(col.name) : undefined}
            showIndicators={true}
            showDelete={isEditable}
            onTogglePK={() => handleToggleKey(col.name, 'PK', col.isPrimaryKey)}
            onToggleFK={() => handleToggleKey(col.name, 'FK', col.isForeignKey)}
            onToggleNK={() => handleToggleKey(col.name, 'NK', col.isNaturalKey)}
            showMultiplePKWarning={hasMultiplePKs && col.isPrimaryKey}
            modelRole={modelRole}
            expanded={expandedColumns.has(col.name)}
            onToggleExpand={(opts) => handleToggleExpand(col.name, opts)}
            dragHandleProps={isEditable ? getDragHandleProps(idx) : undefined}
            isDragOver={dropIndex === idx && dragIndex !== idx}
            isBeingDragged={dragIndex === idx}
            isSelected={selectedColumns.includes(col.name)}
            onSelect={(e) => handleColumnSelect(col.name, e)}
            isEditingActive={editingColumn === col.name}
          />
        ))}

        {/* Pending new column (inline add) - at the bottom */}
        {isAddingColumn && (
          <ColumnRowEditor
            key="__new__"
            column={newColumnTemplate}
            mode="new"
            existingColumnNames={existingColumnNames}
            onUpdate={(updated) => handleColumnUpdate('', updated, true)}
            onCancel={handleCancelNew}
            showIndicators={true}
            showDelete={false}
            modelRole={modelRole}
            expanded={true}
            onToggleExpand={() => {}}
          />
        )}
      </div>

      {/* Bottom "Add Column" button for longer lists */}
      {isEditable && columns.length > 0 && (
        <button
          className="column-editor__add-btn column-editor__add-btn--bottom"
          onClick={handleAddColumn}
          disabled={isAddingColumn}
          title="Add column"
        >
          + Add Column
        </button>
      )}
    </div>
  );
}
