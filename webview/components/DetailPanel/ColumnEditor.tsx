/**
 * ColumnEditor — editable column list for the DetailPanel.
 *
 * Renders built columns (read-only) and planned columns (editable).
 * Supports adding new planned columns and inline editing.
 * Uses ColumnRowEditor for consistent column row rendering.
 */

import { useCallback, useMemo, useState } from 'react';

import { ColumnRowEditor } from '../common/ColumnRowEditor';
import { useMessageBus } from '../../hooks/useMessageBus';
import type { ModelStatus, ReconciledColumn } from '../../../src/types/reconciled';
import type { ColumnDef } from '../../../src/types/semantic';
import './ColumnEditor.css';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ColumnEditorProps {
  modelName: string;
  modelStatus: ModelStatus;
  columns: ReconciledColumn[];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ColumnEditor({ modelName, modelStatus, columns }: ColumnEditorProps) {
  const { send } = useMessageBus(() => {});

  // State for whether we're adding a new column
  const [isAddingColumn, setIsAddingColumn] = useState(false);

  // Split columns into built and planned
  const { builtColumns, plannedColumns } = useMemo(() => {
    const built: ReconciledColumn[] = [];
    const planned: ReconciledColumn[] = [];
    for (const col of columns) {
      if (col.status === 'built') {
        built.push(col);
      } else {
        planned.push(col);
      }
    }
    return { builtColumns: built, plannedColumns: planned };
  }, [columns]);

  // All column names (for duplicate validation)
  const existingColumnNames = useMemo(
    () => columns.map((c) => c.name),
    [columns],
  );

  // Determine if model is editable (design or repo with planned columns support)
  const isEditable = modelStatus === 'design' || modelStatus === 'built';

  // Handle adding a new column
  const handleAddColumn = useCallback(() => {
    if (isAddingColumn) return; // Already adding
    setIsAddingColumn(true);
  }, [isAddingColumn]);

  // Handle saving a column (add or update)
  const handleColumnUpdate = useCallback(
    (oldName: string, updated: ColumnDef, isNew: boolean) => {
      if (isNew) {
        // Adding new column
        send({
          type: 'addColumn',
          payload: { modelName, column: updated },
        });
        setIsAddingColumn(false);
      } else {
        // Updating existing column
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

  // --- Render ----------------------------------------------------------------

  const hasPlannedColumns = plannedColumns.length > 0 || isAddingColumn;

  // New column template for when user clicks "Add Column"
  const newColumnTemplate: ReconciledColumn = {
    name: '',
    dataType: 'STRING',
    description: '',
    status: 'planned',
    isPrimaryKey: false,
    isForeignKey: false,
  };

  return (
    <div className="column-editor">
      {/* Header */}
      <div className="column-editor__header">
        <h4 className="column-editor__title">
          Columns ({columns.length})
        </h4>
        {isEditable && (
          <button
            className="column-editor__add-btn"
            onClick={handleAddColumn}
            disabled={isAddingColumn}
            title="Add planned column"
          >
            + Add Column
          </button>
        )}
      </div>

      {/* Column list */}
      <div className="column-editor__list">
        {columns.length === 0 && !isAddingColumn && (
          <div className="column-editor__empty">No columns</div>
        )}

        {/* Built columns (read-only) */}
        {builtColumns.map((col) => (
          <ColumnRowEditor
            key={col.name}
            column={col}
            mode="readonly"
            existingColumnNames={existingColumnNames}
            showIndicators={true}
            showDelete={false}
          />
        ))}

        {/* Separator between built and planned */}
        {builtColumns.length > 0 && hasPlannedColumns && (
          <div className="column-editor__separator">
            <span className="column-editor__separator-text">PLANNED</span>
          </div>
        )}

        {/* Planned columns (editable) */}
        {plannedColumns.map((col) => (
          <ColumnRowEditor
            key={col.name}
            column={col}
            mode="editable"
            existingColumnNames={existingColumnNames}
            onUpdate={(updated) => handleColumnUpdate(col.name, updated, false)}
            onDelete={() => handleColumnDelete(col.name)}
            showIndicators={true}
            showDelete={true}
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
          />
        )}
      </div>

      {/* Bottom "Add Column" button for longer lists */}
      {isEditable && columns.length > 0 && (
        <button
          className="column-editor__add-btn column-editor__add-btn--bottom"
          onClick={handleAddColumn}
          disabled={isAddingColumn}
          title="Add planned column"
        >
          + Add Column
        </button>
      )}
    </div>
  );
}
