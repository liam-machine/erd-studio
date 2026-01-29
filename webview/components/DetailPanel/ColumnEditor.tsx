/**
 * ColumnEditor — editable column list for the DetailPanel.
 *
 * Renders built columns (read-only) and planned columns (editable).
 * Supports adding new planned columns and inline editing.
 */

import { useCallback, useMemo, useState } from 'react';

import { EditableColumnRow } from './EditableColumnRow';
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

  // State for pending new column (being added inline)
  const [pendingNewColumn, setPendingNewColumn] = useState<ReconciledColumn | null>(null);

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
    if (pendingNewColumn) return; // Already adding
    setPendingNewColumn({
      name: '',
      dataType: 'STRING',
      description: '',
      status: 'planned',
      isPrimaryKey: false,
      isForeignKey: false,
    });
  }, [pendingNewColumn]);

  // Handle saving a column (add or update)
  const handleColumnUpdate = useCallback(
    (oldName: string, updated: ColumnDef, isNew: boolean) => {
      if (isNew) {
        // Adding new column
        send({
          type: 'addColumn',
          payload: { modelName, column: updated },
        });
        setPendingNewColumn(null);
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
    setPendingNewColumn(null);
  }, []);

  // --- Render ----------------------------------------------------------------

  const hasPlannedColumns = plannedColumns.length > 0 || pendingNewColumn !== null;

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
            disabled={pendingNewColumn !== null}
            title="Add planned column"
          >
            + Add Column
          </button>
        )}
      </div>

      {/* Column list */}
      <div className="column-editor__list">
        {columns.length === 0 && !pendingNewColumn && (
          <div className="column-editor__empty">No columns</div>
        )}

        {/* Built columns (read-only) */}
        {builtColumns.map((col) => (
          <EditableColumnRow
            key={col.name}
            column={col}
            editable={false}
            existingColumnNames={existingColumnNames}
            onUpdate={() => {}}
            onDelete={() => {}}
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
          <EditableColumnRow
            key={col.name}
            column={col}
            editable={true}
            existingColumnNames={existingColumnNames}
            onUpdate={(updated) => handleColumnUpdate(col.name, updated, false)}
            onDelete={() => handleColumnDelete(col.name)}
          />
        ))}

        {/* Pending new column (inline add) */}
        {pendingNewColumn && (
          <EditableColumnRow
            key="__new__"
            column={pendingNewColumn}
            editable={true}
            isNew={true}
            existingColumnNames={existingColumnNames}
            onUpdate={(updated) => handleColumnUpdate('', updated, true)}
            onDelete={handleCancelNew}
            onCancelNew={handleCancelNew}
          />
        )}
      </div>
    </div>
  );
}
