/**
 * ColumnRowEditor — shared editable column row component.
 *
 * Renders a single column row with PK/FK indicators, column name, and data type.
 * Supports three modes: readonly, editable, and new (for adding columns).
 *
 * Uses useFocusWithinRow hook for robust focus tracking that eliminates
 * flicker when switching between fields within the same row.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { DataTypeSelect } from './DataTypeSelect';
import { KeyBadgeGroup } from './KeyBadgeGroup';
import { useFocusWithinRow } from '../../hooks/useFocusWithinRow';
import type { ColumnDef } from '../../../src/types/semantic';
import './ColumnRowEditor.css';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ColumnRowEditorColumn {
  name: string;
  dataType: string;
  description: string;
  isPrimaryKey?: boolean;
  isForeignKey?: boolean;
  isNaturalKey?: boolean;
  /** Column status for styling. */
  status?: 'built' | 'approved' | 'planned' | 'missing';
  /** Whether the column has been approved for build. */
  approved?: boolean;
}

export interface ColumnRowEditorProps {
  /** The column data to display/edit. */
  column: ColumnRowEditorColumn;
  /** Operating mode: readonly (built), editable (planned), or new (adding). */
  mode: 'readonly' | 'editable' | 'new';
  /** Existing column names for duplicate validation. */
  existingColumnNames?: string[];
  /** Callback when column is updated (saved). */
  onUpdate?: (updated: ColumnDef) => void;
  /** Callback when delete button is clicked. */
  onDelete?: () => void;
  /** Callback when new row is cancelled (Escape key). */
  onCancel?: () => void;
  /** Callback when approve button is clicked. */
  onApprove?: () => void;
  /** Callback when unapprove button is clicked. */
  onUnapprove?: () => void;
  /** Whether this column can be approved (model is approved or built). */
  canApprove?: boolean;
  /** Show PK/FK/NK indicator badges. Default true. */
  showIndicators?: boolean;
  /** Show delete button on hover. Default true for editable mode. */
  showDelete?: boolean;
  /** Callback when PK badge is toggled. */
  onTogglePK?: () => void;
  /** Callback when FK badge is toggled. */
  onToggleFK?: () => void;
  /** Callback when NK badge is toggled. */
  onToggleNK?: () => void;
  /** Show warning if multiple PKs exist in model. */
  showMultiplePKWarning?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validate a column name.
 * Returns error message or null if valid.
 */
function validateColumnName(
  name: string,
  existingNames: string[],
  currentName?: string
): string | null {
  const trimmed = name.trim();
  if (!trimmed) {
    return 'Name is required';
  }
  if (!/^[a-z0-9_]+$/.test(trimmed)) {
    return 'Use lowercase letters, numbers, underscores';
  }
  // Check duplicate (exclude current column name for edits)
  const otherNames = existingNames.filter((n) => n !== currentName);
  if (otherNames.includes(trimmed)) {
    return 'Column name already exists';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ColumnRowEditor({
  column,
  mode,
  existingColumnNames = [],
  onUpdate,
  onDelete,
  onCancel,
  onApprove,
  onUnapprove,
  canApprove = false,
  showIndicators = true,
  showDelete = true,
  onTogglePK,
  onToggleFK,
  onToggleNK,
  showMultiplePKWarning = false,
}: ColumnRowEditorProps) {
  // Local state for editing
  const [localColumn, setLocalColumn] = useState<ColumnDef>({
    name: column.name,
    dataType: column.dataType,
    description: column.description,
    isPrimaryKey: column.isPrimaryKey,
    isForeignKey: column.isForeignKey,
    isNaturalKey: column.isNaturalKey,
  });
  const [editingField, setEditingField] = useState<'name' | 'dataType' | null>(
    mode === 'new' ? 'name' : null
  );
  const [validationError, setValidationError] = useState<string | null>(null);

  // Refs for auto-focus
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Track if we're in the middle of saving (prevents double-save)
  const isSavingRef = useRef(false);

  // Track if we're switching between fields (prevents premature save on blur)
  const isSwitchingFieldRef = useRef(false);

  // Reset local state when column prop changes (e.g., after successful save)
  useEffect(() => {
    if (!isSavingRef.current) {
      setLocalColumn({
        name: column.name,
        dataType: column.dataType,
        description: column.description,
        isPrimaryKey: column.isPrimaryKey,
        isForeignKey: column.isForeignKey,
        isNaturalKey: column.isNaturalKey,
      });
    }
    isSavingRef.current = false;
  }, [
    column.name,
    column.dataType,
    column.description,
    column.isPrimaryKey,
    column.isForeignKey,
    column.isNaturalKey,
  ]);

  // Auto-focus when entering edit mode or when mode is 'new'
  useEffect(() => {
    if (editingField === 'name' && nameInputRef.current) {
      nameInputRef.current.focus();
      nameInputRef.current.select();
    }
  }, [editingField]);

  // Validate and save changes
  const handleSave = useCallback(() => {
    // Don't save in readonly mode
    if (mode === 'readonly') return;

    // Validate name
    const error = validateColumnName(
      localColumn.name,
      existingColumnNames,
      column.name
    );

    if (error) {
      setValidationError(error);
      return;
    }

    // Clear error and save
    setValidationError(null);
    isSavingRef.current = true;
    onUpdate?.({
      name: localColumn.name.trim(),
      dataType: localColumn.dataType,
      description: localColumn.description.trim(),
      isPrimaryKey: localColumn.isPrimaryKey,
      isForeignKey: localColumn.isForeignKey,
      isNaturalKey: localColumn.isNaturalKey,
    });
    setEditingField(null);
  }, [mode, localColumn, existingColumnNames, column.name, onUpdate]);

  // Focus management hook - triggers save when focus leaves the row
  const { rowProps } = useFocusWithinRow(() => {
    // Skip if we're in the middle of switching between fields
    if (isSwitchingFieldRef.current) {
      return;
    }
    if (mode === 'new' || mode === 'editable') {
      // Only save if we have a valid name
      if (localColumn.name.trim()) {
        handleSave();
      } else if (mode === 'new') {
        // Cancel empty new rows on blur
        onCancel?.();
      }
    }
  });

  // Handle clicking a field to start editing
  const handleFieldClick = useCallback(
    (field: 'name' | 'dataType') => {
      if (mode === 'readonly') return;
      // Mark that we're switching fields to prevent blur handler from saving
      isSwitchingFieldRef.current = true;
      setEditingField(field);
      setValidationError(null);
      // Clear the flag after React has had time to update
      requestAnimationFrame(() => {
        isSwitchingFieldRef.current = false;
      });
    },
    [mode]
  );

  // Handle keyboard events
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleSave();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setValidationError(null);
        if (mode === 'new') {
          onCancel?.();
        } else {
          // Revert to original values
          setLocalColumn({
            name: column.name,
            dataType: column.dataType,
            description: column.description,
            isPrimaryKey: column.isPrimaryKey,
            isForeignKey: column.isForeignKey,
            isNaturalKey: column.isNaturalKey,
          });
          setEditingField(null);
        }
      }
    },
    [mode, column, handleSave, onCancel]
  );

  // Handle data type change
  const handleDataTypeChange = useCallback(
    (newType: string) => {
      setLocalColumn((prev) => ({ ...prev, dataType: newType }));
      setEditingField(null);

      // Auto-save when data type is changed (for both new and existing columns)
      if ((mode === 'new' || mode === 'editable') && localColumn.name.trim()) {
        const error = validateColumnName(
          localColumn.name,
          existingColumnNames,
          column.name
        );
        if (!error) {
          isSavingRef.current = true;
          onUpdate?.({
            name: localColumn.name.trim(),
            dataType: newType,
            description: localColumn.description.trim(),
            isPrimaryKey: localColumn.isPrimaryKey,
            isForeignKey: localColumn.isForeignKey,
            isNaturalKey: localColumn.isNaturalKey,
          });
        }
      }
    },
    [mode, localColumn, existingColumnNames, column.name, onUpdate]
  );

  // Handle delete click
  const handleDeleteClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onDelete?.();
    },
    [onDelete]
  );

  // --- Render --------------------------------------------------------------

  const isEditing = editingField !== null;
  const status = column.status ?? (mode === 'readonly' ? 'built' : 'planned');

  const rowClasses = [
    'column-row-editor',
    `column-row-editor--${status}`,
    mode !== 'readonly' && 'column-row-editor--editable',
    isEditing && 'column-row-editor--editing',
    validationError && 'column-row-editor--has-error',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={rowClasses} {...rowProps}>
      {/* PK/FK/NK key badges — always pass toggles so built columns can edit keys */}
      {showIndicators && (
        <KeyBadgeGroup
          isPrimaryKey={column.isPrimaryKey ?? false}
          isForeignKey={column.isForeignKey ?? false}
          isNaturalKey={column.isNaturalKey ?? false}
          mode={onTogglePK || onToggleFK || onToggleNK ? 'editable' : 'readonly'}
          status={status}
          onTogglePK={onTogglePK}
          onToggleFK={onToggleFK}
          onToggleNK={onToggleNK}
          showMultiplePKWarning={showMultiplePKWarning}
        />
      )}

      {/* Column name */}
      {isEditing && editingField === 'name' ? (
        <input
          ref={nameInputRef}
          type="text"
          className={`column-row-editor__input ${validationError ? 'column-row-editor__input--error' : ''}`}
          value={localColumn.name}
          onChange={(e) =>
            setLocalColumn((prev) => ({ ...prev, name: e.target.value }))
          }
          onKeyDown={handleKeyDown}
          placeholder="column_name"
        />
      ) : (
        <span
          className="column-row-editor__name"
          onClick={() => handleFieldClick('name')}
          onMouseDown={(e) => e.preventDefault()} // Prevent blur before click registers
          title={mode !== 'readonly' ? 'Click to edit' : undefined}
        >
          {localColumn.name || (
            <em className="column-row-editor__placeholder">column_name</em>
          )}
        </span>
      )}

      {/* Data type */}
      {isEditing && editingField === 'dataType' ? (
        <DataTypeSelect
          value={localColumn.dataType}
          onChange={handleDataTypeChange}
          onBlur={() => setEditingField(null)}
          className="column-row-editor__type-select"
          autoOpen={true}
        />
      ) : (
        <span
          className="column-row-editor__type"
          onClick={() => handleFieldClick('dataType')}
          onMouseDown={(e) => e.preventDefault()} // Prevent blur before click registers
          title={mode !== 'readonly' ? 'Click to edit' : undefined}
        >
          {localColumn.dataType}
        </span>
      )}

      {/* Approval toggle (for planned columns when canApprove is true) */}
      {mode === 'editable' && canApprove && (
        <button
          className={`column-row-editor__approve ${column.approved ? 'column-row-editor__approve--approved' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            if (column.approved) {
              onUnapprove?.();
            } else {
              onApprove?.();
            }
          }}
          title={column.approved ? 'Remove approval' : 'Approve column for build'}
          aria-label={column.approved ? 'Unapprove column' : 'Approve column'}
        >
          {column.approved ? '✓' : '○'}
        </button>
      )}

      {/* Delete button */}
      {showDelete && mode !== 'readonly' && mode !== 'new' && (
        <button
          className="column-row-editor__delete"
          onClick={handleDeleteClick}
          title="Delete column"
          aria-label="Delete column"
        >
          ×
        </button>
      )}

      {/* Validation error */}
      {validationError && (
        <span className="column-row-editor__error">{validationError}</span>
      )}
    </div>
  );
}
