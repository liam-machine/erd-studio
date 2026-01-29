/**
 * EditableColumnRow — inline editable row for a single column.
 *
 * Displays column in read-only mode for built columns or edit mode for
 * planned/design columns. Supports inline editing with click-to-edit,
 * auto-save on blur, and delete functionality.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { DataTypeSelect } from '../common/DataTypeSelect';
import type { ReconciledColumn } from '../../../src/types/reconciled';
import type { ColumnDef } from '../../../src/types/semantic';
import './EditableColumnRow.css';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface EditableColumnRowProps {
  column: ReconciledColumn;
  editable: boolean;
  existingColumnNames: string[];
  isNew?: boolean;
  onUpdate: (updated: ColumnDef) => void;
  onDelete: () => void;
  onCancelNew?: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function EditableColumnRow({
  column,
  editable,
  existingColumnNames,
  isNew = false,
  onUpdate,
  onDelete,
  onCancelNew,
}: EditableColumnRowProps) {
  // Local state for editing
  const [isEditing, setIsEditing] = useState(isNew);
  const [editingField, setEditingField] = useState<'name' | 'dataType' | 'description' | null>(
    isNew ? 'name' : null,
  );
  const [editValue, setEditValue] = useState<ColumnDef>({
    name: column.name,
    dataType: column.dataType,
    description: column.description,
    isPrimaryKey: column.isPrimaryKey,
  });
  const [validationError, setValidationError] = useState<string | null>(null);

  // Refs for auto-focus and timeout cleanup
  const nameInputRef = useRef<HTMLInputElement>(null);
  const descInputRef = useRef<HTMLInputElement>(null);
  const blurTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Cleanup blur timeout on unmount
  useEffect(() => {
    return () => {
      if (blurTimeoutRef.current) {
        clearTimeout(blurTimeoutRef.current);
      }
    };
  }, []);

  // Auto-focus when entering edit mode
  useEffect(() => {
    if (editingField === 'name' && nameInputRef.current) {
      nameInputRef.current.focus();
      nameInputRef.current.select();
    }
    if (editingField === 'description' && descInputRef.current) {
      descInputRef.current.focus();
      descInputRef.current.select();
    }
  }, [editingField]);

  // Validate column name
  const validateName = useCallback(
    (name: string): string | null => {
      const trimmed = name.trim();
      if (!trimmed) {
        return 'Name is required';
      }
      if (!/^[a-z0-9_]+$/.test(trimmed)) {
        return 'Use lowercase letters, numbers, underscores';
      }
      // Check duplicate (exclude current column name for edits)
      const otherNames = existingColumnNames.filter((n) => n !== column.name);
      if (otherNames.includes(trimmed)) {
        return 'Column name already exists';
      }
      return null;
    },
    [existingColumnNames, column.name],
  );

  // Handle clicking a field to start editing
  const handleFieldClick = useCallback(
    (field: 'name' | 'dataType' | 'description') => {
      if (!editable) return;
      setIsEditing(true);
      setEditingField(field);
      setValidationError(null);
    },
    [editable],
  );

  // Handle saving on blur
  const handleBlur = useCallback(() => {
    // Clear any existing timeout
    if (blurTimeoutRef.current) {
      clearTimeout(blurTimeoutRef.current);
    }

    // Don't save if we just clicked another field in the same row
    blurTimeoutRef.current = setTimeout(() => {
      const activeElement = document.activeElement;
      const rowElement = nameInputRef.current?.closest('.editable-column-row');
      if (rowElement?.contains(activeElement)) {
        return; // Still editing within the same row
      }

      // Validate before saving
      const nameError = validateName(editValue.name);
      if (nameError) {
        setValidationError(nameError);
        // Don't cancel new row on validation error - let user fix it
        // Only cancel on explicit Escape key (handled in handleKeyDown)
        return;
      }

      // Save changes
      setValidationError(null);
      setIsEditing(false);
      setEditingField(null);
      onUpdate({
        name: editValue.name.trim(),
        dataType: editValue.dataType,
        description: editValue.description.trim(),
        isPrimaryKey: editValue.isPrimaryKey,
      });

      blurTimeoutRef.current = null;
    }, 100);
  }, [editValue, validateName, onUpdate]);

  // Handle keyboard events
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        (e.target as HTMLElement).blur();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setValidationError(null);
        if (isNew && onCancelNew) {
          onCancelNew();
        } else {
          // Revert to original values
          setEditValue({
            name: column.name,
            dataType: column.dataType,
            description: column.description,
            isPrimaryKey: column.isPrimaryKey,
          });
          setIsEditing(false);
          setEditingField(null);
        }
      }
    },
    [isNew, onCancelNew, column],
  );

  // Handle data type change (immediate save for existing columns, deferred for new)
  const handleDataTypeChange = useCallback(
    (newType: string) => {
      setEditValue((prev) => ({ ...prev, dataType: newType }));

      // For new columns without a valid name, just update local state
      const finalName = editValue.name.trim() || column.name;
      if (!finalName) {
        setEditingField(null);
        return;
      }

      // Validate name before auto-saving
      const nameError = validateName(finalName);
      if (nameError) {
        setEditingField(null);
        return;
      }

      // Auto-save data type change
      onUpdate({
        name: finalName,
        dataType: newType,
        description: editValue.description.trim(),
        isPrimaryKey: editValue.isPrimaryKey,
      });
      setEditingField(null);
    },
    [editValue, column.name, validateName, onUpdate],
  );

  // Handle delete
  const handleDelete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onDelete();
    },
    [onDelete],
  );

  // --- Render ----------------------------------------------------------------

  const statusClass = column.status === 'built' ? 'built' : 'planned';
  const rowClasses = [
    'editable-column-row',
    `editable-column-row--${statusClass}`,
    editable ? 'editable-column-row--editable' : '',
    isEditing ? 'editable-column-row--editing' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={rowClasses}>
      {/* PK/FK indicators */}
      <span className="editable-column-row__indicators">
        {column.isPrimaryKey && (
          <span className="editable-column-row__pk" title="Primary Key">
            PK
          </span>
        )}
        {column.isForeignKey && (
          <span className="editable-column-row__fk" title="Foreign Key">
            FK
          </span>
        )}
      </span>

      {/* Column name */}
      {isEditing && editingField === 'name' ? (
        <input
          ref={nameInputRef}
          type="text"
          className={`editable-column-row__input ${validationError ? 'editable-column-row__input--error' : ''}`}
          value={editValue.name}
          onChange={(e) => setEditValue((prev) => ({ ...prev, name: e.target.value }))}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          placeholder="column_name"
        />
      ) : (
        <span
          className="editable-column-row__name"
          onClick={() => handleFieldClick('name')}
          title={editable ? 'Click to edit' : undefined}
        >
          {column.name || <em className="editable-column-row__placeholder">column_name</em>}
        </span>
      )}

      {/* Data type */}
      {isEditing && editingField === 'dataType' ? (
        <DataTypeSelect
          value={editValue.dataType}
          onChange={handleDataTypeChange}
          className="editable-column-row__type-select"
        />
      ) : (
        <span
          className="editable-column-row__type"
          onClick={() => handleFieldClick('dataType')}
          title={editable ? 'Click to edit' : undefined}
        >
          {column.dataType}
        </span>
      )}

      {/* Delete button (only for editable columns) */}
      {editable && !isNew && (
        <button
          className="editable-column-row__delete"
          onClick={handleDelete}
          title="Delete column"
          aria-label="Delete column"
        >
          ×
        </button>
      )}

      {/* Validation error */}
      {validationError && (
        <span className="editable-column-row__error">{validationError}</span>
      )}
    </div>
  );
}
