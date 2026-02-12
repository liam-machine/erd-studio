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
import { groupColumnsByStatus } from '../../lib/columnGrouping';
import type { ModelStatus, ReconciledColumn, ReconciledModel } from '../../../src/types/reconciled';
import type { ColumnDef } from '../../../src/types/semantic';
import type { ColumnKeyType } from '../../../src/types/messages';
import './ColumnEditor.css';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ColumnEditorProps {
  modelName: string;
  modelStatus: ModelStatus;
  modelApproved: boolean;
  columns: ReconciledColumn[];
  /** Number of columns with unresolved discrepancies. */
  discrepancyCount?: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ColumnEditor({ modelName, modelStatus, modelApproved, columns, discrepancyCount }: ColumnEditorProps) {
  const { send } = useMessageBus(() => {});

  // State for whether we're adding a new column
  const [isAddingColumn, setIsAddingColumn] = useState(false);

  // State for tracking expanded columns (by column name)
  const [expandedColumns, setExpandedColumns] = useState<Set<string>>(new Set());

  // Group columns by status: built -> approved -> planned, sorted by key priority within each group
  const { built: builtColumns, approved: approvedColumns, planned: plannedColumns } = useMemo(
    () => groupColumnsByStatus(columns),
    [columns]
  );

  // All column names (for duplicate validation)
  const existingColumnNames = useMemo(
    () => columns.map((c) => c.name),
    [columns],
  );

  // Determine if model is editable (design, approved, or built models support adding columns)
  const isEditable = modelStatus === 'design' || modelStatus === 'approved' || modelStatus === 'built';

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

  // Handle approving a column
  const handleColumnApprove = useCallback(
    (columnName: string) => {
      send({
        type: 'approveColumn',
        payload: { modelName, columnName },
      });
    },
    [send, modelName],
  );

  // Handle unapproving a column
  const handleColumnUnapprove = useCallback(
    (columnName: string) => {
      send({
        type: 'unapproveColumn',
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
  const handleToggleExpand = useCallback((columnName: string) => {
    setExpandedColumns((prev) => {
      const next = new Set(prev);
      if (next.has(columnName)) {
        next.delete(columnName);
      } else {
        next.add(columnName);
      }
      return next;
    });
  }, []);

  // Expand all columns
  const handleExpandAll = useCallback(() => {
    setExpandedColumns(new Set(columns.map((c) => c.name)));
  }, [columns]);

  // Collapse all columns
  const handleCollapseAll = useCallback(() => {
    setExpandedColumns(new Set());
  }, []);

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

  // Handle accepting a discrepancy
  const handleAcceptDiscrepancy = useCallback(
    (columnName: string) => {
      send({
        type: 'acceptDiscrepancy',
        payload: { modelName, columnName },
      });
    },
    [send, modelName],
  );

  // Handle rejecting a discrepancy
  const handleRejectDiscrepancy = useCallback(
    (columnName: string) => {
      send({
        type: 'rejectDiscrepancy',
        payload: { modelName, columnName },
      });
    },
    [send, modelName],
  );

  // Handle un-rejecting a discrepancy
  const handleUnrejectDiscrepancy = useCallback(
    (columnName: string) => {
      send({
        type: 'unrejectDiscrepancy',
        payload: { modelName, columnName },
      });
    },
    [send, modelName],
  );

  // Handle accepting all discrepancies for this model
  const handleAcceptAllDiscrepancies = useCallback(() => {
    send({
      type: 'acceptAllDiscrepancies',
      payload: { modelName },
    });
  }, [send, modelName]);

  // Compute whether model has multiple PKs (for warning display)
  const pkColumnNames = useMemo(
    () => columns.filter((c) => c.isPrimaryKey).map((c) => c.name),
    [columns],
  );
  const hasMultiplePKs = pkColumnNames.length > 1;

  // Check expansion state for UI
  const allExpanded = columns.length > 0 && expandedColumns.size === columns.length;
  const anyExpanded = expandedColumns.size > 0;

  // --- Render ----------------------------------------------------------------

  const hasApprovedColumns = approvedColumns.length > 0;
  const hasPlannedColumns = plannedColumns.length > 0 || isAddingColumn;

  // New column template for when user clicks "Add Column"
  const newColumnTemplate: ReconciledColumn = {
    name: '',
    dataType: 'STRING',
    description: '',
    status: 'planned',
    isPrimaryKey: false,
    isForeignKey: false,
    isNaturalKey: false,
    approved: false,
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
          {discrepancyCount && discrepancyCount > 0 ? (
            <button
              className="column-editor__accept-all-btn"
              onClick={handleAcceptAllDiscrepancies}
              title={`Accept all ${discrepancyCount} discrepanc${discrepancyCount > 1 ? 'ies' : 'y'}`}
            >
              Accept All ({discrepancyCount})
            </button>
          ) : null}
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
      </div>

      {/* Column list */}
      <div className="column-editor__list">
        {columns.length === 0 && !isAddingColumn && (
          <div className="column-editor__empty">No columns</div>
        )}

        {/* Built columns — editable key types, readonly other fields */}
        {builtColumns.map((col) => (
          <ColumnRowEditor
            key={col.name}
            column={col}
            mode="readonly"
            existingColumnNames={existingColumnNames}
            showIndicators={true}
            showDelete={false}
            onTogglePK={() => handleToggleKey(col.name, 'PK', col.isPrimaryKey)}
            onToggleFK={() => handleToggleKey(col.name, 'FK', col.isForeignKey)}
            onToggleNK={() => handleToggleKey(col.name, 'NK', col.isNaturalKey)}
            showMultiplePKWarning={hasMultiplePKs && col.isPrimaryKey}
            expanded={expandedColumns.has(col.name)}
            onToggleExpand={() => handleToggleExpand(col.name)}
            onAcceptDiscrepancy={col.discrepancy ? () => handleAcceptDiscrepancy(col.name) : undefined}
            onRejectDiscrepancy={col.discrepancy && !col.discrepancy.rejected ? () => handleRejectDiscrepancy(col.name) : undefined}
            onUnrejectDiscrepancy={col.discrepancy?.rejected ? () => handleUnrejectDiscrepancy(col.name) : undefined}
          />
        ))}

        {/* Separator: built -> approved */}
        {builtColumns.length > 0 && hasApprovedColumns && (
          <div className="column-editor__separator column-editor__separator--approved">
            <span className="column-editor__separator-text">APPROVED</span>
          </div>
        )}

        {/* Approved columns (editable) */}
        {approvedColumns.map((col) => (
          <ColumnRowEditor
            key={col.name}
            column={col}
            mode="editable"
            existingColumnNames={existingColumnNames}
            onUpdate={(updated) => handleColumnUpdate(col.name, updated, false)}
            onDelete={() => handleColumnDelete(col.name)}
            onApprove={() => handleColumnApprove(col.name)}
            onUnapprove={() => handleColumnUnapprove(col.name)}
            canApprove={modelStatus === 'built' || modelApproved}
            showIndicators={true}
            showDelete={true}
            onTogglePK={() => handleToggleKey(col.name, 'PK', col.isPrimaryKey)}
            onToggleFK={() => handleToggleKey(col.name, 'FK', col.isForeignKey)}
            onToggleNK={() => handleToggleKey(col.name, 'NK', col.isNaturalKey)}
            showMultiplePKWarning={hasMultiplePKs && col.isPrimaryKey}
            expanded={expandedColumns.has(col.name)}
            onToggleExpand={() => handleToggleExpand(col.name)}
          />
        ))}

        {/* Separator: approved -> planned */}
        {(builtColumns.length > 0 || approvedColumns.length > 0) && hasPlannedColumns && (
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
            onApprove={() => handleColumnApprove(col.name)}
            onUnapprove={() => handleColumnUnapprove(col.name)}
            canApprove={modelStatus === 'built' || modelApproved}
            showIndicators={true}
            showDelete={true}
            onTogglePK={() => handleToggleKey(col.name, 'PK', col.isPrimaryKey)}
            onToggleFK={() => handleToggleKey(col.name, 'FK', col.isForeignKey)}
            onToggleNK={() => handleToggleKey(col.name, 'NK', col.isNaturalKey)}
            showMultiplePKWarning={hasMultiplePKs && col.isPrimaryKey}
            expanded={expandedColumns.has(col.name)}
            onToggleExpand={() => handleToggleExpand(col.name)}
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
          title="Add planned column"
        >
          + Add Column
        </button>
      )}
    </div>
  );
}
