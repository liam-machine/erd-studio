/**
 * NewFkDialog — dialog for creating or editing FK relationships between models.
 *
 * Form fields:
 * - Source model (dropdown)
 * - Source column (dropdown, filtered by source model)
 * - Target model (dropdown)
 * - Target column (dropdown, filtered by target model)
 * - Cardinality (many-to-one / one-to-one)
 *
 * Mode detection:
 * - Create mode: fkDialogEditData is null (sends addRelationship)
 * - Edit mode: fkDialogEditData is set (sends editRelationship)
 *
 * When editing, the approval status is preserved by the extension host.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Panel } from '@xyflow/react';

import { useEditorStore } from '../../store/editorStore';
import { useMessageBus } from '../../hooks/useMessageBus';
import { detectCircularFk, formatCyclePath } from '../../lib/validation';
import type { Cardinality } from '../../../src/types/semantic';
import './NewFkDialog.css';

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Validate the FK relationship form fields.
 * Returns a record of field name → error message.
 *
 * @param originalKey - When editing, the original composite key to exclude from duplicate check
 */
function validateForm(
  fromModel: string,
  fromColumn: string,
  toModel: string,
  toColumn: string,
  existingRelationships: Array<{
    fromModel: string;
    fromColumn: string;
    toModel: string;
    toColumn: string;
  }>,
  originalKey?: {
    fromModel: string;
    fromColumn: string;
    toModel: string;
    toColumn: string;
  },
): Record<string, string> {
  const errors: Record<string, string> = {};

  if (!fromModel) {
    errors.fromModel = 'Source model is required';
  }
  if (!fromColumn.trim()) {
    errors.fromColumn = 'Source column is required';
  }
  if (!toModel) {
    errors.toModel = 'Target model is required';
  }
  if (!toColumn.trim()) {
    errors.toColumn = 'Target column is required';
  }

  // Check for self-referential relationship
  if (fromModel && toModel && fromModel === toModel) {
    errors.selfReference = 'A model cannot have a relationship with itself';
  }

  // Check for duplicate relationship (same composite key)
  // When editing, skip the check if the key matches the original relationship
  if (fromModel && fromColumn && toModel && toColumn) {
    const isDuplicate = existingRelationships.some((rel) => {
      const isSameAsOriginal =
        originalKey &&
        rel.fromModel === originalKey.fromModel &&
        rel.fromColumn === originalKey.fromColumn &&
        rel.toModel === originalKey.toModel &&
        rel.toColumn === originalKey.toColumn;

      // If this is the relationship we're editing, don't count it as a duplicate
      if (isSameAsOriginal) {
        return false;
      }

      return (
        rel.fromModel === fromModel &&
        rel.fromColumn === fromColumn.trim() &&
        rel.toModel === toModel &&
        rel.toColumn === toColumn.trim()
      );
    });
    if (isDuplicate) {
      errors.duplicate = 'This relationship already exists';
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function NewFkDialog() {
  const isOpen = useEditorStore((s) => s.newFkDialogOpen);
  const setNewFkDialogOpen = useEditorStore((s) => s.setNewFkDialogOpen);
  const domain = useEditorStore((s) => s.domain);
  const fkDialogPrefill = useEditorStore((s) => s.fkDialogPrefill);
  const clearFkDialogPrefill = useEditorStore((s) => s.clearFkDialogPrefill);
  const fkDialogEditData = useEditorStore((s) => s.fkDialogEditData);
  const clearFkDialogEditData = useEditorStore((s) => s.clearFkDialogEditData);
  const { send } = useMessageBus(() => {});

  // Determine if we're in edit mode (editing an existing relationship)
  const isEditMode = fkDialogEditData !== null;

  // Form state
  const [fromModel, setFromModel] = useState('');
  const [fromColumn, setFromColumn] = useState('');
  const [toModel, setToModel] = useState('');
  const [toColumn, setToColumn] = useState('');
  const [cardinality, setCardinality] = useState<Cardinality>('many-to-one');
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  // Derive model names from domain
  const modelNames = useMemo(
    () => (domain?.models ?? []).map((m) => m.name),
    [domain],
  );

  // Derive columns for source model
  const sourceColumns = useMemo(() => {
    if (!fromModel || !domain) return [];
    const model = domain.models.find((m) => m.name === fromModel);
    if (!model) return [];
    return model.columns.map((c) => c.name);
  }, [fromModel, domain]);

  // Derive columns for target model
  const targetColumns = useMemo(() => {
    if (!toModel || !domain) return [];
    const model = domain.models.find((m) => m.name === toModel);
    if (!model) return [];
    return model.columns.map((c) => c.name);
  }, [toModel, domain]);

  // Existing relationships for duplicate check
  const existingRelationships = useMemo(
    () =>
      (domain?.relationships ?? []).map((r) => ({
        fromModel: r.fromModel,
        fromColumn: r.fromColumn,
        toModel: r.toModel,
        toColumn: r.toColumn,
      })),
    [domain],
  );

  // For circular detection in edit mode, exclude the relationship being edited
  // (otherwise changing endpoints could cause false positive cycle warnings)
  const relationshipsForCycleCheck = useMemo(() => {
    if (!fkDialogEditData) return existingRelationships;
    return existingRelationships.filter(
      (r) =>
        !(
          r.fromModel === fkDialogEditData.fromModel &&
          r.fromColumn === fkDialogEditData.fromColumn &&
          r.toModel === fkDialogEditData.toModel &&
          r.toColumn === fkDialogEditData.toColumn
        ),
    );
  }, [existingRelationships, fkDialogEditData]);

  // Circular FK detection (warning only, doesn't block submission)
  const circularWarning = useMemo(() => {
    if (!fromModel || !toModel || fromModel === toModel) {
      return null;
    }
    const cyclePath = detectCircularFk(relationshipsForCycleCheck, fromModel, toModel);
    if (cyclePath) {
      return `This will create a circular reference: ${formatCyclePath(cyclePath)}`;
    }
    return null;
  }, [fromModel, toModel, relationshipsForCycleCheck]);

  // Validation — pass original key when editing to skip self-duplicate check
  const errors = useMemo(
    () =>
      validateForm(
        fromModel,
        fromColumn,
        toModel,
        toColumn,
        existingRelationships,
        fkDialogEditData
          ? {
              fromModel: fkDialogEditData.fromModel,
              fromColumn: fkDialogEditData.fromColumn,
              toModel: fkDialogEditData.toModel,
              toColumn: fkDialogEditData.toColumn,
            }
          : undefined,
      ),
    [fromModel, fromColumn, toModel, toColumn, existingRelationships, fkDialogEditData],
  );

  const isValid =
    Object.keys(errors).length === 0 &&
    fromModel !== '' &&
    fromColumn.trim() !== '' &&
    toModel !== '' &&
    toColumn.trim() !== '';

  // Handlers
  const resetForm = useCallback(() => {
    setFromModel('');
    setFromColumn('');
    setToModel('');
    setToColumn('');
    setCardinality('many-to-one');
    setTouched({});
  }, []);

  const handleClose = useCallback(() => {
    setNewFkDialogOpen(false);
    clearFkDialogPrefill();
    clearFkDialogEditData();
    resetForm();
  }, [setNewFkDialogOpen, clearFkDialogPrefill, clearFkDialogEditData, resetForm]);

  const handleSubmit = useCallback(() => {
    if (!isValid) return;

    if (isEditMode && fkDialogEditData) {
      // Edit mode: send editRelationship with original key
      send({
        type: 'editRelationship',
        payload: {
          originalFromModel: fkDialogEditData.fromModel,
          originalFromColumn: fkDialogEditData.fromColumn,
          originalToModel: fkDialogEditData.toModel,
          originalToColumn: fkDialogEditData.toColumn,
          fromModel,
          fromColumn: fromColumn.trim(),
          toModel,
          toColumn: toColumn.trim(),
          cardinality,
        },
      });
    } else {
      // Create mode: send addRelationship
      send({
        type: 'addRelationship',
        payload: {
          fromModel,
          fromColumn: fromColumn.trim(),
          toModel,
          toColumn: toColumn.trim(),
          cardinality,
        },
      });
    }

    handleClose();
  }, [isValid, isEditMode, fkDialogEditData, fromModel, fromColumn, toModel, toColumn, cardinality, send, handleClose]);

  const handleBlur = useCallback((field: string) => {
    setTouched((prev) => ({ ...prev, [field]: true }));
  }, []);

  // Reset source column when source model changes
  const handleFromModelChange = useCallback((value: string) => {
    setFromModel(value);
    setFromColumn('');
  }, []);

  // Reset target column when target model changes
  const handleToModelChange = useCallback((value: string) => {
    setToModel(value);
    setToColumn('');
  }, []);

  // Apply prefill when dialog opens with prefill data (from drag-to-connect).
  // Reset form first to clear any stale state from previous sessions.
  useEffect(() => {
    if (isOpen && fkDialogPrefill) {
      // Reset non-prefilled form state
      setCardinality('many-to-one');
      setTouched({});
      // Apply prefilled values
      setFromModel(fkDialogPrefill.fromModel);
      setFromColumn(fkDialogPrefill.fromColumn);
      setToModel(fkDialogPrefill.toModel);
      // Apply target column if user dropped on a specific column handle
      setToColumn(fkDialogPrefill.toColumn ?? '');
    }
  }, [isOpen, fkDialogPrefill]);

  // Apply edit data when dialog opens for editing an existing relationship.
  useEffect(() => {
    if (isOpen && fkDialogEditData) {
      setTouched({});
      setFromModel(fkDialogEditData.fromModel);
      setFromColumn(fkDialogEditData.fromColumn);
      setToModel(fkDialogEditData.toModel);
      setToColumn(fkDialogEditData.toColumn);
      setCardinality(fkDialogEditData.cardinality);
    }
  }, [isOpen, fkDialogEditData]);

  if (!isOpen) {
    return null;
  }

  return (
    <Panel position="top-center" className="new-fk-dialog">
      {/* Header */}
      <div className="new-fk-dialog__header">
        <h3 className="new-fk-dialog__title">
          {isEditMode ? 'Edit Relationship' : 'New Relationship'}
        </h3>
        <button
          className="new-fk-dialog__close"
          onClick={handleClose}
          title="Close dialog"
          aria-label="Close dialog"
        >
          ×
        </button>
      </div>

      {/* Content */}
      <div className="new-fk-dialog__content">
        {/* Source Model */}
        <div className="new-fk-dialog__field">
          <label className="new-fk-dialog__label" htmlFor="fromModel">
            Source Model
          </label>
          <select
            id="fromModel"
            className={`new-fk-dialog__select ${touched.fromModel && errors.fromModel ? 'new-fk-dialog__select--error' : ''}`}
            value={fromModel}
            onChange={(e) => handleFromModelChange(e.target.value)}
            onBlur={() => handleBlur('fromModel')}
          >
            <option value="">Select model...</option>
            {modelNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          {touched.fromModel && errors.fromModel && (
            <span className="new-fk-dialog__error">{errors.fromModel}</span>
          )}
        </div>

        {/* Source Column */}
        <div className="new-fk-dialog__field">
          <label className="new-fk-dialog__label" htmlFor="fromColumn">
            Source Column (FK)
          </label>
          {sourceColumns.length > 0 ? (
            <select
              id="fromColumn"
              className={`new-fk-dialog__select ${touched.fromColumn && errors.fromColumn ? 'new-fk-dialog__select--error' : ''}`}
              value={fromColumn}
              onChange={(e) => setFromColumn(e.target.value)}
              onBlur={() => handleBlur('fromColumn')}
            >
              <option value="">Select column...</option>
              {sourceColumns.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          ) : (
            <input
              id="fromColumn"
              type="text"
              className={`new-fk-dialog__input ${touched.fromColumn && errors.fromColumn ? 'new-fk-dialog__input--error' : ''}`}
              value={fromColumn}
              onChange={(e) => setFromColumn(e.target.value)}
              onBlur={() => handleBlur('fromColumn')}
              placeholder={fromModel ? 'Enter column name...' : 'Select source model first'}
              disabled={!fromModel}
            />
          )}
          {touched.fromColumn && errors.fromColumn && (
            <span className="new-fk-dialog__error">{errors.fromColumn}</span>
          )}
        </div>

        {/* Target Model */}
        <div className="new-fk-dialog__field">
          <label className="new-fk-dialog__label" htmlFor="toModel">
            Target Model
          </label>
          <select
            id="toModel"
            className={`new-fk-dialog__select ${touched.toModel && errors.toModel ? 'new-fk-dialog__select--error' : ''}`}
            value={toModel}
            onChange={(e) => handleToModelChange(e.target.value)}
            onBlur={() => handleBlur('toModel')}
          >
            <option value="">Select model...</option>
            {modelNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          {touched.toModel && errors.toModel && (
            <span className="new-fk-dialog__error">{errors.toModel}</span>
          )}
        </div>

        {/* Target Column */}
        <div className="new-fk-dialog__field">
          <label className="new-fk-dialog__label" htmlFor="toColumn">
            Target Column (PK)
          </label>
          {targetColumns.length > 0 ? (
            <select
              id="toColumn"
              className={`new-fk-dialog__select ${touched.toColumn && errors.toColumn ? 'new-fk-dialog__select--error' : ''}`}
              value={toColumn}
              onChange={(e) => setToColumn(e.target.value)}
              onBlur={() => handleBlur('toColumn')}
            >
              <option value="">Select column...</option>
              {targetColumns.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          ) : (
            <input
              id="toColumn"
              type="text"
              className={`new-fk-dialog__input ${touched.toColumn && errors.toColumn ? 'new-fk-dialog__input--error' : ''}`}
              value={toColumn}
              onChange={(e) => setToColumn(e.target.value)}
              onBlur={() => handleBlur('toColumn')}
              placeholder={toModel ? 'Enter column name...' : 'Select target model first'}
              disabled={!toModel}
            />
          )}
          {touched.toColumn && errors.toColumn && (
            <span className="new-fk-dialog__error">{errors.toColumn}</span>
          )}
        </div>

        {/* Cardinality */}
        <div className="new-fk-dialog__field">
          <label className="new-fk-dialog__label" htmlFor="cardinality">
            Cardinality
          </label>
          <select
            id="cardinality"
            className="new-fk-dialog__select"
            value={cardinality}
            onChange={(e) => setCardinality(e.target.value as Cardinality)}
          >
            <option value="many-to-one">Many-to-One (*→1)</option>
            <option value="one-to-one">One-to-One (1→1)</option>
          </select>
        </div>

        {/* Global errors */}
        {errors.selfReference && (
          <div className="new-fk-dialog__error new-fk-dialog__error--global">
            {errors.selfReference}
          </div>
        )}
        {errors.duplicate && (
          <div className="new-fk-dialog__error new-fk-dialog__error--global">
            {errors.duplicate}
          </div>
        )}

        {/* Circular reference warning (doesn't block submission) */}
        {circularWarning && (
          <div className="new-fk-dialog__warning new-fk-dialog__warning--global">
            <span className="new-fk-dialog__warning-icon">⚠</span>
            {circularWarning}
          </div>
        )}

        {/* Preview */}
        {fromModel && toModel && (
          <div className="new-fk-dialog__preview">
            <span className="new-fk-dialog__preview-label">Preview:</span>
            <span className="new-fk-dialog__preview-text">
              {fromModel}.{fromColumn || '?'} → {toModel}.{toColumn || '?'}
              <span className="new-fk-dialog__preview-cardinality">
                ({cardinality === 'many-to-one' ? '*→1' : '1→1'})
              </span>
            </span>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="new-fk-dialog__footer">
        <button
          className="new-fk-dialog__button new-fk-dialog__button--secondary"
          onClick={handleClose}
        >
          Cancel
        </button>
        <button
          className="new-fk-dialog__button new-fk-dialog__button--primary"
          onClick={handleSubmit}
          disabled={!isValid}
        >
          {isEditMode ? 'Save Changes' : 'Create Relationship'}
        </button>
      </div>
    </Panel>
  );
}
