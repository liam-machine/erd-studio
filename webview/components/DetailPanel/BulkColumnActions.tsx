/**
 * BulkColumnActions — toolbar for multi-select column operations.
 *
 * Shown when multiple columns are selected in the ColumnEditor.
 * Supports bulk delete, key type toggling, and data type setting.
 */

import { useCallback, useState } from 'react';

import { DataTypeSelect } from '../common/DataTypeSelect';
import { useMessageBus } from '../../hooks/useMessageBus';
import type { DisplayColumn } from '../../../src/types/display';
import type { ColumnKeyType } from '../../../src/types/messages';
import './BulkColumnActions.css';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface BulkColumnActionsProps {
  modelName: string;
  selectedColumns: string[];
  columns: DisplayColumn[];
  onClearSelection: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function BulkColumnActions({
  modelName,
  selectedColumns,
  columns,
  onClearSelection,
}: BulkColumnActionsProps) {
  const { send } = useMessageBus(() => {});
  const [showTypeSelect, setShowTypeSelect] = useState(false);

  // Get full column data for selected columns
  const selectedColumnData = columns.filter((c) => selectedColumns.includes(c.name));

  // Compute majority state for each key type
  const keyMajority = (key: 'isPrimaryKey' | 'isForeignKey' | 'isNaturalKey') => {
    const count = selectedColumnData.filter((c) => c[key]).length;
    return count > selectedColumnData.length / 2;
  };

  const majorityPK = keyMajority('isPrimaryKey');
  const majorityFK = keyMajority('isForeignKey');
  const majorityNK = keyMajority('isNaturalKey');

  // Bulk delete
  const handleBulkDelete = useCallback(() => {
    for (const colName of selectedColumns) {
      send({
        type: 'removeColumn',
        payload: { modelName, columnName: colName },
      });
    }
    onClearSelection();
  }, [selectedColumns, modelName, send, onClearSelection]);

  // Bulk toggle key type
  const handleBulkToggleKey = useCallback(
    (keyType: ColumnKeyType, currentMajority: boolean) => {
      const newValue = !currentMajority;
      for (const colName of selectedColumns) {
        send({
          type: 'toggleColumnKey',
          payload: { modelName, columnName: colName, keyType, value: newValue },
        });
      }
    },
    [selectedColumns, modelName, send],
  );

  // Bulk set data type
  const handleBulkSetType = useCallback(
    (newType: string) => {
      for (const col of selectedColumnData) {
        send({
          type: 'updateColumn',
          payload: {
            modelName,
            oldColumnName: col.name,
            column: {
              name: col.name,
              dataType: newType,
              description: col.description,
              isPrimaryKey: col.isPrimaryKey,
              isForeignKey: col.isForeignKey,
              isNaturalKey: col.isNaturalKey,
              ...(col.scdType != null ? { scdType: col.scdType } : {}),
              ...(col.additiveType ? { additiveType: col.additiveType } : {}),
            },
          },
        });
      }
      setShowTypeSelect(false);
    },
    [selectedColumnData, modelName, send],
  );

  return (
    <div className="bulk-column-actions">
      <span className="bulk-column-actions__count">{selectedColumns.length} selected</span>

      <button
        className="bulk-column-actions__btn bulk-column-actions__btn--danger"
        onClick={handleBulkDelete}
        title={`Delete ${selectedColumns.length} columns`}
      >
        Delete ({selectedColumns.length})
      </button>

      <div className="bulk-column-actions__divider" />

      <button
        className={`bulk-column-actions__key-btn ${majorityPK ? 'bulk-column-actions__key-btn--active' : ''}`}
        onClick={() => handleBulkToggleKey('PK', majorityPK)}
        title={majorityPK ? 'Remove PK from selected' : 'Set PK on selected'}
      >
        PK
      </button>
      <button
        className={`bulk-column-actions__key-btn ${majorityFK ? 'bulk-column-actions__key-btn--active' : ''}`}
        onClick={() => handleBulkToggleKey('FK', majorityFK)}
        title={majorityFK ? 'Remove FK from selected' : 'Set FK on selected'}
      >
        FK
      </button>
      <button
        className={`bulk-column-actions__key-btn ${majorityNK ? 'bulk-column-actions__key-btn--active' : ''}`}
        onClick={() => handleBulkToggleKey('NK', majorityNK)}
        title={majorityNK ? 'Remove NK from selected' : 'Set NK on selected'}
      >
        NK
      </button>

      <div className="bulk-column-actions__divider" />

      {showTypeSelect ? (
        <DataTypeSelect
          value=""
          onChange={handleBulkSetType}
          onBlur={() => setShowTypeSelect(false)}
          className="bulk-column-actions__type-select"
          autoOpen={true}
        />
      ) : (
        <button
          className="bulk-column-actions__btn"
          onClick={() => setShowTypeSelect(true)}
          title="Set data type for all selected columns"
        >
          Set Type
        </button>
      )}

      <button
        className="bulk-column-actions__btn bulk-column-actions__btn--clear"
        onClick={onClearSelection}
        title="Clear selection"
      >
        ×
      </button>
    </div>
  );
}
