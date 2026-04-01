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
import type { ColumnDef, ModelRole } from '../../../src/types/semantic';
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
  /** SCD type for dimension columns (0 = never changes, 1 = overwrite, 2 = track history). */
  scdType?: 0 | 1 | 2;
  /** Additive type for fact measure columns. */
  additiveType?: 'additive' | 'semi-additive' | 'non-additive';
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
  /** Parent model's role — determines whether SCD/additive dropdowns are shown. */
  modelRole?: ModelRole;
  /** Whether the description area is expanded. */
  expanded?: boolean;
  /** Callback when the expand/collapse chevron is clicked. */
  onToggleExpand?: (opts?: { altKey?: boolean }) => void;
  /** Props to spread onto a drag handle element for reordering. */
  dragHandleProps?: React.HTMLAttributes<HTMLSpanElement>;
  /** Whether a dragged row is currently hovering above this row. */
  isDragOver?: boolean;
  /** Whether this row is currently being dragged. */
  isBeingDragged?: boolean;
  /** Whether this column is selected (spreadsheet-style selection). */
  isSelected?: boolean;
  /** Callback when the row is clicked for selection (receives event for modifier key detection). */
  onSelect?: (e: React.MouseEvent) => void;
  /** Whether the store says this column should enter edit mode (F2). */
  isEditingActive?: boolean;
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
  showIndicators = true,
  showDelete = true,
  onTogglePK,
  onToggleFK,
  onToggleNK,
  showMultiplePKWarning = false,
  modelRole,
  expanded = false,
  onToggleExpand,
  dragHandleProps,
  isDragOver = false,
  isBeingDragged = false,
  isSelected = false,
  onSelect,
  isEditingActive = false,
}: ColumnRowEditorProps) {
  // Local state for editing
  const [localColumn, setLocalColumn] = useState<ColumnDef>({
    name: column.name,
    dataType: column.dataType,
    description: column.description,
    isPrimaryKey: column.isPrimaryKey,
    isForeignKey: column.isForeignKey,
    isNaturalKey: column.isNaturalKey,
    scdType: column.scdType,
    additiveType: column.additiveType,
  });
  const [editingField, setEditingField] = useState<'name' | 'dataType' | 'description' | null>(
    mode === 'new' ? 'name' : null
  );
  const [validationError, setValidationError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Ref for delete confirmation auto-dismiss timer
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Refs for auto-focus
  const nameInputRef = useRef<HTMLInputElement>(null);
  const descriptionInputRef = useRef<HTMLTextAreaElement>(null);

  // Track if we're in the middle of saving (prevents double-save)
  const isSavingRef = useRef(false);

  // Track if we're switching between fields (prevents premature save on blur)
  const isSwitchingFieldRef = useRef(false);

  // Track if a field handler (data type, SCD type) already saved — prevents
  // the blur-triggered handleSave from overwriting with stale closure data.
  // Unlike isSavingRef (which is reset by the column-prop useEffect on
  // round-trip), this ref is only cleared by the blur handler itself.
  const skipNextBlurSaveRef = useRef(false);

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
        scdType: column.scdType,
        additiveType: column.additiveType,
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
    column.scdType,
    column.additiveType,
  ]);

  // Cleanup delete confirmation timer on unmount
  useEffect(() => {
    return () => {
      if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
    };
  }, []);

  // Enter edit mode when store signals via isEditingActive (F2 key)
  useEffect(() => {
    if (isEditingActive && !editingField && mode !== 'readonly') {
      isSwitchingFieldRef.current = true;
      setEditingField('name');
      setValidationError(null);
      requestAnimationFrame(() => {
        isSwitchingFieldRef.current = false;
      });
    }
  }, [isEditingActive, editingField, mode]);

  // Auto-focus when entering edit mode or when mode is 'new'
  useEffect(() => {
    if (editingField === 'name' && nameInputRef.current) {
      nameInputRef.current.focus();
      nameInputRef.current.select();
    }
    if (editingField === 'description' && descriptionInputRef.current) {
      descriptionInputRef.current.focus();
      // Move cursor to end of text
      const len = descriptionInputRef.current.value.length;
      descriptionInputRef.current.setSelectionRange(len, len);
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
      ...(localColumn.scdType != null ? { scdType: localColumn.scdType } : {}),
      ...(localColumn.additiveType ? { additiveType: localColumn.additiveType } : {}),
    });
    setEditingField(null);
  }, [mode, localColumn, existingColumnNames, column.name, onUpdate]);

  // Focus management hook - triggers save when focus leaves the row
  const { rowProps } = useFocusWithinRow(() => {
    // Skip if we're in the middle of switching between fields
    if (isSwitchingFieldRef.current) {
      return;
    }
    // Skip if a field change handler (e.g. data type, SCD type) already saved.
    // We check skipNextBlurSaveRef (not isSavingRef) because isSavingRef gets
    // reset by the column-prop useEffect when the round-trip domainLoaded
    // arrives — which can happen before this rAF-deferred blur callback fires.
    if (skipNextBlurSaveRef.current) {
      skipNextBlurSaveRef.current = false;
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
    (field: 'name' | 'dataType' | 'description') => {
      if (mode === 'readonly') return;
      // Mark that we're switching fields to prevent blur handler from saving
      isSwitchingFieldRef.current = true;
      // DataTypeSelect renders via portal (outside the row DOM), so the row's
      // blur fires the moment the dropdown opens. Skip that blur save — the
      // data type handler will save directly when a value is selected.
      if (field === 'dataType') {
        skipNextBlurSaveRef.current = true;
      }
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
            scdType: column.scdType,
            additiveType: column.additiveType,
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
          skipNextBlurSaveRef.current = true;
          onUpdate?.({
            name: localColumn.name.trim(),
            dataType: newType,
            description: localColumn.description.trim(),
            isPrimaryKey: localColumn.isPrimaryKey,
            isForeignKey: localColumn.isForeignKey,
            isNaturalKey: localColumn.isNaturalKey,
            ...(localColumn.scdType != null ? { scdType: localColumn.scdType } : {}),
            ...(localColumn.additiveType ? { additiveType: localColumn.additiveType } : {}),
          });
        }
      }
    },
    [mode, localColumn, existingColumnNames, column.name, onUpdate]
  );

  // Handle delete click — two-click confirmation
  const handleDeleteClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (confirmingDelete) {
        // Second click confirms deletion
        if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
        setConfirmingDelete(false);
        onDelete?.();
      } else {
        // First click enters confirmation state
        setConfirmingDelete(true);
        // Auto-dismiss after 3 seconds
        deleteTimerRef.current = setTimeout(() => {
          setConfirmingDelete(false);
        }, 3000);
      }
    },
    [confirmingDelete, onDelete]
  );

  const handleCancelDelete = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current);
      setConfirmingDelete(false);
    },
    []
  );

  // Handle SCD type change — auto-saves immediately
  const handleScdTypeChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const raw = e.target.value;
      const value = raw === '' ? undefined : (Number(raw) as 0 | 1 | 2);
      setLocalColumn((prev) => ({ ...prev, scdType: value }));
      // Auto-save
      if (localColumn.name.trim() && mode !== 'readonly') {
        isSavingRef.current = true;
        skipNextBlurSaveRef.current = true;
        onUpdate?.({
          name: localColumn.name.trim(),
          dataType: localColumn.dataType,
          description: localColumn.description.trim(),
          isPrimaryKey: localColumn.isPrimaryKey,
          isForeignKey: localColumn.isForeignKey,
          isNaturalKey: localColumn.isNaturalKey,
          ...(value != null ? { scdType: value } : {}),
          ...(localColumn.additiveType ? { additiveType: localColumn.additiveType } : {}),
        });
      }
    },
    [mode, localColumn, onUpdate],
  );

  // Handle additive type change — auto-saves immediately
  const handleAdditiveTypeChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const value = (e.target.value || undefined) as ColumnDef['additiveType'];
      setLocalColumn((prev) => ({ ...prev, additiveType: value }));
      // Auto-save
      if (localColumn.name.trim() && mode !== 'readonly') {
        isSavingRef.current = true;
        skipNextBlurSaveRef.current = true;
        onUpdate?.({
          name: localColumn.name.trim(),
          dataType: localColumn.dataType,
          description: localColumn.description.trim(),
          isPrimaryKey: localColumn.isPrimaryKey,
          isForeignKey: localColumn.isForeignKey,
          isNaturalKey: localColumn.isNaturalKey,
          ...(localColumn.scdType != null ? { scdType: localColumn.scdType } : {}),
          ...(value ? { additiveType: value } : {}),
        });
      }
    },
    [mode, localColumn, onUpdate],
  );

  // Handle chevron toggle click
  const handleChevronClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onToggleExpand?.({ altKey: e.altKey });
    },
    [onToggleExpand]
  );

  // --- Render --------------------------------------------------------------

  const isEditing = editingField !== null;
  const statusClass = mode === 'readonly' ? 'built' : 'planned';

  // Check if description exists
  const hasDescription = Boolean(localColumn.description?.trim());

  // Determine which metadata dropdowns to show based on parent model role
  const isDimRole = modelRole?.includes('dim') || modelRole === 'reference';
  const isFactRole = modelRole?.includes('fact') || modelRole?.includes('snapshot');

  // Handle row click for selection (only when not in new-column mode)
  const handleRowClick = useCallback(
    (e: React.MouseEvent) => {
      // Don't select if clicking on interactive elements (buttons, inputs, selects)
      const target = e.target as HTMLElement;
      if (
        target.closest('button') ||
        target.closest('input') ||
        target.closest('select') ||
        target.closest('textarea') ||
        target.closest('.key-badge-group')
      ) {
        return;
      }
      onSelect?.(e);
    },
    [onSelect],
  );

  const rowClasses = [
    'column-row-editor',
    `column-row-editor--${statusClass}`,
    mode !== 'readonly' && 'column-row-editor--editable',
    isEditing && 'column-row-editor--editing',
    isSelected && 'column-row-editor--selected',
    validationError && 'column-row-editor--has-error',
    expanded && 'column-row-editor--expanded',
    isDragOver && 'column-row-editor--drag-over',
    isBeingDragged && 'column-row-editor--dragging',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={rowClasses} {...rowProps} onClick={mode !== 'new' ? handleRowClick : undefined}>
      {/* Main row content */}
      <div className="column-row-editor__main">
        {/* Drag handle for reordering — always rendered to reserve space, hidden when not editable */}
        <span
          className={`column-row-editor__drag-handle${!dragHandleProps ? ' column-row-editor__drag-handle--hidden' : ''}`}
          {...(dragHandleProps ?? {})}
        >⠿</span>
        {/* Expand/collapse chevron */}
        {onToggleExpand && (
          <button
            className="column-row-editor__chevron"
            onClick={handleChevronClick}
            title={expanded ? 'Collapse description (Alt+Click: all)' : 'Expand description (Alt+Click: all)'}
            aria-label={expanded ? 'Collapse description' : 'Expand description'}
            aria-expanded={expanded}
          >
            {expanded ? '▾' : '▸'}
          </button>
        )}

        {/* PK/FK/NK key badges — always pass toggles so built columns can edit keys */}
        {showIndicators && (
          <KeyBadgeGroup
            isPrimaryKey={column.isPrimaryKey ?? false}
            isForeignKey={column.isForeignKey ?? false}
            isNaturalKey={column.isNaturalKey ?? false}
            mode={onTogglePK || onToggleFK || onToggleNK ? 'editable' : 'readonly'}
            status={statusClass}
            onTogglePK={onTogglePK ? () => { skipNextBlurSaveRef.current = true; onTogglePK(); } : undefined}
            onToggleFK={onToggleFK ? () => { skipNextBlurSaveRef.current = true; onToggleFK(); } : undefined}
            onToggleNK={onToggleNK ? () => { skipNextBlurSaveRef.current = true; onToggleNK(); } : undefined}
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
            onDoubleClick={(e) => { e.stopPropagation(); handleFieldClick('name'); }}
            title={mode !== 'readonly' ? 'Double-click to edit' : undefined}
          >
            {localColumn.name || (
              <em className="column-row-editor__placeholder">column_name</em>
            )}
          </span>
        )}

        {/* Info indicator — shows when collapsed and has description */}
        {!expanded && hasDescription && (
          <span
            className="column-row-editor__info-badge"
            title={localColumn.description}
            onClick={handleChevronClick}
          >
            ⓘ
          </span>
        )}

        {/* Data type */}
        {isEditing && editingField === 'dataType' ? (
          <DataTypeSelect
            value={localColumn.dataType}
            onChange={handleDataTypeChange}
            onBlur={() => {
              // Dismissed without selecting — allow normal blur saves again
              skipNextBlurSaveRef.current = false;
              setEditingField(null);
            }}
            className="column-row-editor__type-select"
            autoOpen={true}
          />
        ) : (
          <span
            className="column-row-editor__type"
            onDoubleClick={(e) => { e.stopPropagation(); handleFieldClick('dataType'); }}
            title={mode !== 'readonly' ? 'Double-click to edit' : undefined}
          >
            {localColumn.dataType}
          </span>
        )}

        {/* Delete button */}
        {showDelete && mode !== 'readonly' && mode !== 'new' && (
          confirmingDelete ? (
            <span className="column-row-editor__delete-confirm">
              <button
                className="column-row-editor__delete-confirm-yes"
                onClick={handleDeleteClick}
                title="Confirm delete"
                aria-label="Confirm delete column"
              >
                Delete?
              </button>
              <button
                className="column-row-editor__delete-confirm-no"
                onClick={handleCancelDelete}
                title="Cancel"
                aria-label="Cancel delete"
              >
                ✕
              </button>
            </span>
          ) : (
            <button
              className="column-row-editor__delete"
              onClick={handleDeleteClick}
              title="Delete column"
              aria-label="Delete column"
            >
              ×
            </button>
          )
        )}
      </div>

      {/* Expanded description area */}
      {expanded && (
        <div className="column-row-editor__description-area">
          {editingField === 'description' ? (
            <textarea
              ref={descriptionInputRef}
              className="column-row-editor__description-input"
              value={localColumn.description}
              onChange={(e) =>
                setLocalColumn((prev) => ({ ...prev, description: e.target.value }))
              }
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setLocalColumn((prev) => ({ ...prev, description: column.description }));
                  setEditingField(null);
                }
                // Allow Enter for newlines in textarea, use Ctrl/Cmd+Enter to save
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  handleSave();
                }
              }}
              placeholder="Add a description for this column..."
              rows={2}
            />
          ) : (
            <div
              className={`column-row-editor__description-text ${!hasDescription ? 'column-row-editor__description-text--empty' : ''}`}
              onClick={() => handleFieldClick('description')}
              title={mode !== 'readonly' ? 'Click to edit description' : undefined}
            >
              {localColumn.description || (
                mode !== 'readonly' ? '✏ Add description...' : 'No description'
              )}
            </div>
          )}

          {/* SCD Type dropdown — shown for dimension-role models */}
          {isDimRole && (
            <div className="column-row-editor__metadata-row">
              <label className="column-row-editor__metadata-label">SCD Type</label>
              <select
                className="column-row-editor__metadata-select"
                value={localColumn.scdType != null ? String(localColumn.scdType) : ''}
                onChange={handleScdTypeChange}
                disabled={mode === 'readonly'}
              >
                <option value="">Not set</option>
                <option value="0">Type 0 — Never changes</option>
                <option value="1">Type 1 — Overwrite</option>
                <option value="2">Type 2 — Track history</option>
              </select>
            </div>
          )}

          {/* Additive Type dropdown — shown for fact-role models */}
          {isFactRole && (
            <div className="column-row-editor__metadata-row">
              <label className="column-row-editor__metadata-label">Additive</label>
              <select
                className="column-row-editor__metadata-select"
                value={localColumn.additiveType ?? ''}
                onChange={handleAdditiveTypeChange}
                disabled={mode === 'readonly'}
              >
                <option value="">Not set</option>
                <option value="additive">Additive — Sum across all dims</option>
                <option value="semi-additive">Semi-additive — Not across time</option>
                <option value="non-additive">Non-additive — Store components</option>
              </select>
            </div>
          )}
        </div>
      )}

      {/* Validation error */}
      {validationError && (
        <span className="column-row-editor__error">{validationError}</span>
      )}
    </div>
  );
}
