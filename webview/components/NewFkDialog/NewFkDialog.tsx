/**
 * NewFkDialog — dialog for creating or editing a relationship between models.
 *
 * Form fields:
 * - From model / column — the column that points (the "many" side, which
 *   stores the relationship)
 * - To model / column — the key it points at
 * - "How many <from> rows can share one <to>?" — Many (many-to-one), Only one
 *   (one-to-one), Many on both sides (many-to-many, with the bridge hint)
 * - Role (optional)
 *
 * Direction (issue #133) comes from the evidence, never from drag order: the
 * key flags the model files declare and dbt's tests, through core's
 * `resolveDirection` (see `webview/lib/relationshipDirection.ts`). A certain
 * verdict is prefilled and choosing against it warns ("Create anyway"); a
 * likely one is prefilled with its reason; an ambiguous one has no default —
 * two buttons named after the models, Create disabled until one is picked,
 * and an optional "Mark <col> as <model>'s key" tick (`markKey`, saved in the
 * same undo step). The read-back says what the relationship means from the
 * target's side and where it is saved (`DisplayDomain.relationshipHome`).
 *
 * Mode detection:
 * - Create mode: fkDialogEditData is null (sends addRelationship)
 * - Edit mode: fkDialogEditData is set (sends editRelationship with the drawn
 *   ends as the original key and the stored ends as `stored`)
 *
 * When editing, the approval status is preserved by the extension host.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Panel } from '@xyflow/react';
import { sameLink } from '@erd-studio/core';

import { useEditorStore } from '../../store/editorStore';
import { useSend } from '../../hooks/useMessageBus';
import { detectCircularFk, formatCyclePath } from '../../lib/validation';
import { directionFor } from '../../lib/relationshipDirection';
import {
  BRIDGE_HINT,
  DIALOG_CARDINALITIES,
  canOfferMarkKey,
  cardinalityQuestion,
  contradictionWarning,
  directionChoices,
  directionKey,
  directionQuestion,
  likelyReason,
  readBack,
  relationshipSentence,
  reversed,
  turnedRoundNote,
  type DialogEnds,
} from '../../lib/relationshipDialog';
import type { Cardinality } from '../../../src/types/semantic';
import './NewFkDialog.css';

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Validate the FK relationship form fields.
 * Returns a record of field name → error message.
 *
 * @param originalKey - When editing, the relationship being edited, excluded from the duplicate check
 */
export function validateForm(
  fromModel: string,
  fromColumn: string,
  toModel: string,
  toColumn: string,
  existingRelationships: ReadonlyArray<DialogEnds>,
  originalKey?: DialogEnds,
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

  // Duplicate check: the same two columns, either way round and in any case,
  // are the same link (#133). When editing, the link being edited is not a
  // duplicate of itself.
  if (fromModel && fromColumn && toModel && toColumn) {
    const ends = { fromModel, fromColumn: fromColumn.trim(), toModel, toColumn: toColumn.trim() };
    const isDuplicate = existingRelationships.some(
      (rel) => !(originalKey && sameLink(rel, originalKey)) && sameLink(rel, ends),
    );
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
  const send = useSend();

  // Determine if we're in edit mode (editing an existing relationship)
  const isEditMode = fkDialogEditData !== null;

  // Form state
  const [fromModel, setFromModel] = useState('');
  const [fromColumn, setFromColumn] = useState('');
  const [toModel, setToModel] = useState('');
  const [toColumn, setToColumn] = useState('');
  const [chosenCardinality, setChosenCardinality] = useState<Cardinality>('many-to-one');
  // Until the user answers the cardinality question, it follows the evidence.
  const [cardinalityTouched, setCardinalityTouched] = useState(false);
  const [role, setRole] = useState('');
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  // The direction the user picked when the evidence could not (directionKey).
  const [chosenDirection, setChosenDirection] = useState<string | null>(null);
  // The direction a drag was turned round to (directionKey), for the note.
  const [turnedFor, setTurnedFor] = useState<string | null>(null);
  const [markKey, setMarkKey] = useState(false);

  const models = useMemo(() => domain?.models ?? [], [domain]);

  // Derive model names from domain
  const modelNames = useMemo(() => models.map((m) => m.name), [models]);

  // Derive columns for source model
  const sourceColumns = useMemo(() => {
    if (!fromModel) return [];
    const model = models.find((m) => m.name === fromModel);
    if (!model) return [];
    return model.columns.map((c) => c.name);
  }, [fromModel, models]);

  // Derive columns for target model
  const targetColumns = useMemo(() => {
    if (!toModel) return [];
    const model = models.find((m) => m.name === toModel);
    if (!model) return [];
    return model.columns.map((c) => c.name);
  }, [toModel, models]);

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
    return existingRelationships.filter((r) => !sameLink(r, fkDialogEditData));
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
        fkDialogEditData ?? undefined,
      ),
    [fromModel, fromColumn, toModel, toColumn, existingRelationships, fkDialogEditData],
  );

  const isValid =
    Object.keys(errors).length === 0 &&
    fromModel !== '' &&
    fromColumn.trim() !== '' &&
    toModel !== '' &&
    toColumn.trim() !== '';

  // --- Direction (#133) ----------------------------------------------------

  const ends: DialogEnds = useMemo(
    () => ({ fromModel, fromColumn: fromColumn.trim(), toModel, toColumn: toColumn.trim() }),
    [fromModel, fromColumn, toModel, toColumn],
  );
  const endsComplete = ends.fromModel !== '' && ends.fromColumn !== '' && ends.toModel !== '' && ends.toColumn !== '';
  const verdict = useMemo(
    () => (endsComplete && !errors.selfReference ? directionFor(models, ends) : undefined),
    [endsComplete, errors.selfReference, models, ends],
  );
  // The verdict's cardinality prefills the choice — except an ambiguous
  // many-to-many (both ends look not unique): that is a guess with no "many"
  // side to pick, so prefilling it would let one click store a many-to-many,
  // in whichever model the drag started on. The default many-to-one then asks
  // for a direction; a many-to-many is always the user's own explicit pick.
  const suggested = verdict && !(verdict.confidence === 'ambiguous' && verdict.cardinality === 'many-to-many')
    ? verdict.cardinality
    : undefined;
  const cardinality: Cardinality = cardinalityTouched ? chosenCardinality : suggested ?? chosenCardinality;

  // An ambiguous verdict has no default direction: the user picks one. A
  // many-to-many the user chose has no "many" side to pick, so it needs no choice.
  const ambiguous = verdict?.confidence === 'ambiguous' && cardinality !== 'many-to-many';
  const needsDirection = ambiguous && chosenDirection !== directionKey(ends);
  const contradiction = contradictionWarning(verdict, ends, models, cardinality);
  const showTurned = turnedFor !== null && turnedFor === directionKey(ends);
  const offerMarkKey = ambiguous && !needsDirection && canOfferMarkKey(models, ends);
  const sendMarkKey = offerMarkKey && markKey;
  const canSubmit = isValid && !needsDirection;

  // Handlers
  const resetForm = useCallback(() => {
    setFromModel('');
    setFromColumn('');
    setToModel('');
    setToColumn('');
    setChosenCardinality('many-to-one');
    setCardinalityTouched(false);
    setRole('');
    setTouched({});
    setChosenDirection(null);
    setTurnedFor(null);
    setMarkKey(false);
  }, []);

  const handleClose = useCallback(() => {
    setNewFkDialogOpen(false);
    clearFkDialogPrefill();
    clearFkDialogEditData();
    resetForm();
  }, [setNewFkDialogOpen, clearFkDialogPrefill, clearFkDialogEditData, resetForm]);

  const handleSubmit = useCallback(() => {
    if (!canSubmit) return;
    const markKeyPayload = sendMarkKey ? { markKey: { model: ends.toModel, column: ends.toColumn } } : {};

    if (isEditMode && fkDialogEditData) {
      // Edit mode: the drawn ends are the original key; the stored ends let
      // the host find the record however it is written on disk.
      send({
        type: 'editRelationship',
        payload: {
          originalFromModel: fkDialogEditData.fromModel,
          originalFromColumn: fkDialogEditData.fromColumn,
          originalToModel: fkDialogEditData.toModel,
          originalToColumn: fkDialogEditData.toColumn,
          ...ends,
          cardinality,
          role: role.trim(),
          ...(fkDialogEditData.stored ? { stored: fkDialogEditData.stored } : {}),
          ...markKeyPayload,
        },
      });
    } else {
      // Create mode: send addRelationship
      send({
        type: 'addRelationship',
        payload: {
          ...ends,
          cardinality,
          ...(role.trim() ? { role: role.trim() } : {}),
          ...markKeyPayload,
        },
      });
    }

    handleClose();
  }, [canSubmit, sendMarkKey, isEditMode, fkDialogEditData, ends, cardinality, role, send, handleClose]);

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

  const handleCardinalityChange = useCallback((value: Cardinality) => {
    setChosenCardinality(value);
    setCardinalityTouched(true);
  }, []);

  /** Put the given ends in the form (Swap sides / Swap back / a direction button). */
  const applyEnds = useCallback((next: DialogEnds) => {
    setFromModel(next.fromModel);
    setFromColumn(next.fromColumn);
    setToModel(next.toModel);
    setToColumn(next.toColumn);
  }, []);

  const handleSwapSides = useCallback(() => applyEnds(reversed(ends)), [applyEnds, ends]);

  const handleChooseDirection = useCallback((next: DialogEnds) => {
    applyEnds(next);
    setChosenDirection(directionKey(next));
  }, [applyEnds]);

  // Every open with neither a drag's prefill nor an edit (the toolbar's New
  // Relationship) starts from an empty form. The dialog stays mounted while
  // closed, and Escape closes it through the store without `handleClose`, so
  // without this a cancelled direction choice, key tick or role would come
  // back, already counted as decided.
  const wasOpen = useRef(false);
  useLayoutEffect(() => {
    if (isOpen && !wasOpen.current && !fkDialogPrefill && !fkDialogEditData) resetForm();
    wasOpen.current = isOpen;
  }, [isOpen, fkDialogPrefill, fkDialogEditData, resetForm]);

  // Apply prefill when dialog opens with prefill data (from drag-to-connect).
  // Reset form first to clear any stale state from previous sessions.
  useEffect(() => {
    if (isOpen && fkDialogPrefill) {
      // Reset non-prefilled form state
      setChosenCardinality('many-to-one');
      setCardinalityTouched(false);
      setRole('');
      setTouched({});
      setChosenDirection(null);
      setMarkKey(false);
      // Apply prefilled values
      setFromModel(fkDialogPrefill.fromModel);
      setFromColumn(fkDialogPrefill.fromColumn);
      setToModel(fkDialogPrefill.toModel);
      // Apply target column if user dropped on a specific column handle
      setToColumn(fkDialogPrefill.toColumn ?? '');
      setTurnedFor(fkDialogPrefill.turnedRound && fkDialogPrefill.toColumn
        ? directionKey({ ...fkDialogPrefill, toColumn: fkDialogPrefill.toColumn })
        : null);
    }
  }, [isOpen, fkDialogPrefill]);

  // Apply edit data when dialog opens for editing an existing relationship.
  useEffect(() => {
    if (isOpen && fkDialogEditData) {
      setTouched({});
      // A one-to-many (stored before #133) opens turned round, as the many-to-one
      // it will be saved as — the dialog offers no one-to-many.
      const flip = fkDialogEditData.cardinality === 'one-to-many';
      const next = flip ? reversed(fkDialogEditData) : {
        fromModel: fkDialogEditData.fromModel,
        fromColumn: fkDialogEditData.fromColumn,
        toModel: fkDialogEditData.toModel,
        toColumn: fkDialogEditData.toColumn,
      };
      applyEnds(next);
      setChosenCardinality(fkDialogEditData.pickedCardinality ?? (flip ? 'many-to-one' : fkDialogEditData.cardinality));
      setCardinalityTouched(true);
      setRole(fkDialogEditData.role ?? '');
      // A saved many-to-one or one-to-one's direction is the user's earlier
      // choice. A many-to-many's ends never were — it has no "many" side, so
      // they are whichever model the drag started on — so changing it to one
      // of the others asks for the direction when the keys do not settle it,
      // exactly as a new relationship does (never broken by drag order).
      setChosenDirection(fkDialogEditData.cardinality === 'many-to-many' ? null : directionKey(next));
      setTurnedFor(null);
      setMarkKey(false);
    }
  }, [isOpen, fkDialogEditData, applyEnds]);

  if (!isOpen) {
    return null;
  }

  const home = domain?.relationshipHome;
  const back = readBack(ends, cardinality, home);
  const primaryLabel = contradiction
    ? (isEditMode ? 'Save anyway' : 'Create anyway')
    : (isEditMode ? 'Save Changes' : 'Create Relationship');

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
            From model
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
            From column (the one that points)
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
            To model
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
            To column (the key it points at)
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

        {/* Direction: settled by the evidence, or asked for (#133) */}
        {endsComplete && !errors.selfReference && (
          <div className="new-fk-dialog__direction">
            {needsDirection && verdict ? (
              <div className="new-fk-dialog__choice" role="group" aria-label="Direction">
                <span className="new-fk-dialog__choice-question">
                  {verdict.conflict
                    ? `The keys and dbt's tests disagree (${verdict.reasons.join('; ')}). Which way does it go?`
                    : directionQuestion(cardinality)}
                </span>
                {directionChoices(verdict, cardinality).map((choice) => (
                  <button
                    key={directionKey(choice.ends)}
                    type="button"
                    className="new-fk-dialog__choice-button"
                    onClick={() => handleChooseDirection(choice.ends)}
                  >
                    {choice.label}
                  </button>
                ))}
              </div>
            ) : (
              <>
                <span className="new-fk-dialog__sentence">{relationshipSentence(ends, cardinality)}</span>
                {showTurned && (
                  <span className="new-fk-dialog__note">
                    {turnedRoundNote(verdict)}{' '}
                    <button type="button" className="new-fk-dialog__link-button" onClick={handleSwapSides}>
                      Swap back
                    </button>
                  </span>
                )}
                {!showTurned && verdict?.confidence === 'likely' && (
                  <span className="new-fk-dialog__note">{likelyReason(verdict, ends)}</span>
                )}
              </>
            )}

            {/* Cardinality, as a question about the from side */}
            <fieldset className="new-fk-dialog__cardinality">
              <legend className="new-fk-dialog__label">{cardinalityQuestion(ends)}</legend>
              {DIALOG_CARDINALITIES.map((option) => (
                <label key={option.value} className="new-fk-dialog__radio">
                  <input
                    type="radio"
                    name="relationship-cardinality"
                    value={option.value}
                    checked={cardinality === option.value}
                    onChange={() => handleCardinalityChange(option.value)}
                  />
                  {option.label}
                </label>
              ))}
              {cardinality === 'many-to-many' && (
                <span className="new-fk-dialog__hint">{BRIDGE_HINT}</span>
              )}
            </fieldset>

            {offerMarkKey && (
              <label className="new-fk-dialog__radio">
                <input type="checkbox" checked={markKey} onChange={(e) => setMarkKey(e.target.checked)} />
                Mark {ends.toColumn} as {ends.toModel}&apos;s key
              </label>
            )}

            {contradiction && (
              <div className="new-fk-dialog__warning new-fk-dialog__warning--global" role="alert">
                <span className="new-fk-dialog__warning-icon">⚠</span>
                <span>
                  {contradiction}{' '}
                  <button type="button" className="new-fk-dialog__link-button" onClick={handleSwapSides}>
                    Swap sides
                  </button>
                </span>
              </div>
            )}

            {!needsDirection && (
              <div className="new-fk-dialog__readback">
                <span>{back.text}</span>
                {back.savedIn && (
                  <span className="new-fk-dialog__saved-in">
                    {back.savedIn}.{' '}
                    <span className="new-fk-dialog__why" title={back.why} tabIndex={0}>
                      Why here?
                    </span>
                  </span>
                )}
              </div>
            )}
          </div>
        )}

        {/* Role */}
        <div className="new-fk-dialog__field">
          <label className="new-fk-dialog__label" htmlFor="relationship-role">
            Role (optional)
          </label>
          <input
            id="relationship-role"
            className="new-fk-dialog__input"
            type="text"
            value={role}
            maxLength={60}
            placeholder="e.g. ship date"
            onChange={(e) => setRole(e.target.value)}
          />
          <span className="new-fk-dialog__hint">
            Names the link when a model points at the same one more than once.
          </span>
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
          disabled={!canSubmit}
          title={needsDirection ? 'Choose which side has many rows first' : undefined}
        >
          {primaryLabel}
        </button>
      </div>
    </Panel>
  );
}
