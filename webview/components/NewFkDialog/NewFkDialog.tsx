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
import { canonicalRelationship, keyEvidenceDetail, linkKey, sameLink } from '@erd-studio/core';
import type { LinkEnd } from '@erd-studio/core';

import { useEditorStore } from '../../store/editorStore';
import { useSend } from '../../hooks/useMessageBus';
import { detectCircularFk, formatCyclePath } from '../../lib/validation';
import { keysContradictionWarning, orientCanvasLink } from '../../lib/relationshipDirection';
import {
  ABSORB_HINT, ADD_PAIR_LABEL, COMPOSITE_MANY_TO_MANY_ERROR, COMPOSITE_MANY_TO_MANY_TITLE, DIRECTION_MISSING_HINT, DIRECTION_QUESTION,
  PAIR_INCOMPLETE, dialogTitle, directionChoice, directionSentence, markKeyLabel, pairColumnUsed,
} from '../../lib/relationshipDialog';
import { MAX_COMPOSITE_PAIRS } from '@erd-studio/core';
import type { Cardinality } from '../../../src/types/semantic';
import './NewFkDialog.css';

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/** A link as the dialog compares it with the ones already drawn. */
type ExistingLink = { fromModel: string; fromColumn: string; toModel: string; toColumn: string; compositeKey?: string };

/**
 * Validate the FK relationship form fields.
 * Returns a record of field name → error message; an extra column pair's
 * error is under `pairs.<i>` (#133 L2).
 *
 * @param originals - When editing, every pair of the relationship being edited (all members of a composite),
 *   excluded from the duplicate check.
 */
function validateForm(
  fromModel: string,
  fromColumn: string,
  toModel: string,
  toColumn: string,
  extraPairs: ReadonlyArray<{ fromColumn: string; toColumn: string }>,
  cardinality: Cardinality,
  existingRelationships: ExistingLink[],
  originals: ExistingLink[] = [],
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

  // A self-reference joins two columns of one model (#133 L3); a column can't point at itself.
  const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();
  const selfModel = !!fromModel && !!toModel && same(fromModel, toModel);
  if (selfModel && fromColumn.trim() && same(fromColumn, toColumn)) {
    errors.sameColumn = "A column can't point at itself";
  }

  // The other pairs of a composite foreign key (#133 L2).
  const composite = extraPairs.length > 0;
  extraPairs.forEach((pair, i) => {
    const earlier = [{ fromColumn, toColumn }, ...extraPairs.slice(0, i)];
    if (!pair.fromColumn.trim() || !pair.toColumn.trim()) {
      errors[`pairs.${i}`] = PAIR_INCOMPLETE;
    } else if (earlier.some((p) => same(p.fromColumn, pair.fromColumn))) {
      errors[`pairs.${i}`] = pairColumnUsed(pair.fromColumn.trim());
    } else if (earlier.some((p) => same(p.toColumn, pair.toColumn))) {
      errors[`pairs.${i}`] = pairColumnUsed(pair.toColumn.trim());
    } else if (selfModel && same(pair.fromColumn, pair.toColumn)) {
      errors[`pairs.${i}`] = "A column can't point at itself";
    }
  });
  if (composite && cardinality === 'many-to-many') {
    errors.cardinality = COMPOSITE_MANY_TO_MANY_ERROR;
  }

  // Check for duplicate relationship (same composite key)
  // When editing, skip the check if the key matches the original relationship
  if (fromModel && toModel) {
    const isOriginal = (rel: ExistingLink): boolean => originals.some((o) => sameLink(o, rel));
    const pairs = [{ fromColumn, toColumn }, ...extraPairs].filter((p) => p.fromColumn.trim() && p.toColumn.trim());
    const isDuplicate = pairs.some((p) => existingRelationships.some((rel) => {
      // If this is the relationship we're editing, don't count it as a duplicate
      if (isOriginal(rel)) return false;
      // The same two columns joined either way round is the same link.
      if (!sameLink(rel, { fromModel, fromColumn: p.fromColumn.trim(), toModel, toColumn: p.toColumn.trim() })) return false;
      // A single link between the same models is absorbed into a composite, not refused.
      return !(composite && isAbsorbable(rel, fromModel, toModel));
    }));
    if (isDuplicate) {
      errors.duplicate = 'This relationship already exists';
    }
  }

  return errors;
}

/** A single link (no composite key) between the same two models, which a new composite takes in (#133 L2). */
function isAbsorbable(rel: ExistingLink, fromModel: string, toModel: string): boolean {
  const lower = (x: string): string => x.toLowerCase();
  const ends = [lower(rel.fromModel), lower(rel.toModel)].sort().join('\u0000');
  return !rel.compositeKey && ends === [lower(fromModel), lower(toModel)].sort().join('\u0000');
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
  // The other column pairs of a composite foreign key, after the first (#133 L2).
  const [extraPairs, setExtraPairs] = useState<Array<{ fromColumn: string; toColumn: string }>>([]);
  const [cardinality, setCardinality] = useState<Cardinality>('many-to-one');
  const [role, setRole] = useState('');
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  // Which side holds the foreign key, when the user had to pick it: the link and its from end.
  const [chosenDirection, setChosenDirection] = useState<string | null>(null);
  // The "mark as primary key" box, once the user has changed it for one link and model.
  const [markKeyChoice, setMarkKeyChoice] = useState<{ for: string; checked: boolean } | null>(null);

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

  // Existing relationships for duplicate check (each member of a composite is its own link)
  const existingRelationships = useMemo(
    () =>
      (domain?.relationships ?? []).map((r) => ({
        fromModel: r.fromModel,
        fromColumn: r.fromColumn,
        toModel: r.toModel,
        toColumn: r.toColumn,
        ...(r.compositeKey ? { compositeKey: r.compositeKey } : {}),
      })),
    [domain],
  );
  // Every pair of the relationship being edited: all members of a composite.
  const originalLinks = useMemo(() => (fkDialogEditData
    ? (fkDialogEditData.pairs ?? [fkDialogEditData]).map((p) => ({
      fromModel: fkDialogEditData.fromModel, fromColumn: p.fromColumn, toModel: fkDialogEditData.toModel, toColumn: p.toColumn,
    }))
    : []), [fkDialogEditData]);
  const pairCount = 1 + extraPairs.length;

  // For circular detection in edit mode, exclude the relationship being edited
  // (otherwise changing endpoints could cause false positive cycle warnings)
  const relationshipsForCycleCheck = useMemo(() => {
    if (!fkDialogEditData) return existingRelationships;
    return existingRelationships.filter((r) => !originalLinks.some((o) => sameLink(o, r)));
  }, [existingRelationships, fkDialogEditData, originalLinks]);

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

  // Which side holds the foreign key (#133 L1): key flags, else dbt's tests,
  // else the user picks — never the order the columns were picked or dragged in.
  const models = useMemo(() => domain?.models ?? [], [domain]);
  // Every pair, the first being fromColumn → toColumn; orientation reads each end's column SET (#133 L2).
  const allPairs = useMemo(
    () => [{ fromColumn, toColumn }, ...extraPairs].map((p) => ({ fromColumn: p.fromColumn.trim(), toColumn: p.toColumn.trim() })),
    [fromColumn, toColumn, extraPairs],
  );
  const pairsFilled = allPairs.every((p) => p.fromColumn && p.toColumn);
  const fromCols = useMemo(() => (pairsFilled ? allPairs.map((p) => p.fromColumn) : []), [pairsFilled, allPairs]);
  const toCols = useMemo(() => (pairsFilled ? allPairs.map((p) => p.toColumn) : []), [pairsFilled, allPairs]);
  // Both ends named, and not one column at both ends (refused below).
  const complete = !!fromModel && !!toModel && fromCols.length > 0 && toCols.length > 0
    && !(fromModel.toLowerCase() === toModel.toLowerCase() && allPairs.some((p) => p.fromColumn.toLowerCase() === p.toColumn.toLowerCase()));
  const orientation = useMemo(
    () => (complete ? orientCanvasLink(models, { model: fromModel, columns: fromCols }, { model: toModel, columns: toCols }) : null),
    [complete, models, fromModel, fromCols, toModel, toCols],
  );
  const linkId = complete
    ? allPairs.map((p) => linkKey({ fromModel, fromColumn: p.fromColumn, toModel, toColumn: p.toColumn })).sort().join('|')
    : '';
  const fromEndId = `${linkId}|${fromModel}.${fromCols.join('+')}`.toLowerCase();
  const sameEnd = (end: { model: string; columns: readonly string[] }, model: string, columns: readonly string[]): boolean =>
    end.model.toLowerCase() === model.toLowerCase()
    && end.columns.map((c) => c.toLowerCase()).join('+') === columns.map((c) => c.toLowerCase()).join('+');
  const editingSameLink = !!fkDialogEditData && complete && allPairs.length === originalLinks.length
    && allPairs.every((p) => originalLinks.some((o) => sameLink(o, { fromModel, fromColumn: p.fromColumn, toModel, toColumn: p.toColumn })));
  const direction: 'incomplete' | 'decided' | 'reversed' | 'chosen' | 'undecided' = !orientation
    ? 'incomplete'
    : orientation.decided
      ? (sameEnd(orientation.from, fromModel, fromCols) ? 'decided' : 'reversed')
      : (editingSameLink || chosenDirection === fromEndId ? 'chosen' : 'undecided');
  const keyKind = useCallback((end: LinkEnd): 'primary key' | 'natural key' => {
    const model = models.find((m) => m.name.toLowerCase() === end.model.toLowerCase());
    const pk = (model?.columns ?? []).filter((c) => c.isPrimaryKey).map((c) => c.name.toLowerCase());
    return pk.length === end.columns.length && end.columns.every((c) => pk.includes(c.toLowerCase())) ? 'primary key' : 'natural key';
  }, [models]);
  const choices = useMemo(() => {
    if (!orientation || orientation.decided) return null;
    const a = { model: orientation.from.model, columns: orientation.from.columns };
    const b = { model: orientation.to.model, columns: orientation.to.columns };
    return [{ from: a, to: b }, { from: b, to: a }].map((c) => ({ ...c, label: directionChoice(c.from, c.to, cardinality) }));
  }, [orientation, cardinality]);
  const pickDirection = useCallback((from: { model: string; columns: readonly string[] }, to: { model: string; columns: readonly string[] }) => {
    setFromModel(from.model);
    setFromColumn(from.columns[0]);
    setToModel(to.model);
    setToColumn(to.columns[0]);
    // The ends' columns line up pair by pair.
    setExtraPairs(from.columns.slice(1).map((c, i) => ({ fromColumn: c, toColumn: to.columns[i + 1] })));
    const id = from.columns.map((c, i) => linkKey({ fromModel: from.model, fromColumn: c, toModel: to.model, toColumn: to.columns[i] })).sort().join('|');
    setChosenDirection(`${id}|${from.model}.${from.columns.join('+')}`.toLowerCase());
  }, []);
  const turnRound = useCallback(() => {
    if (orientation) pickDirection(orientation.from, orientation.to);
  }, [orientation, pickDirection]);

  // "Mark as primary key" (#133 L1): offered when the "one" side's model
  // flags no key and nothing says the columns are not its key; ticked when
  // dbt says they are unique.
  const toModelDef = models.find((m) => m.name === toModel);
  const markKey = useMemo(() => {
    if (!complete || (direction !== 'decided' && direction !== 'chosen')) return null;
    if (cardinality !== 'many-to-one' && cardinality !== 'one-to-one') return null;
    if (!toModelDef || toModelDef.columns.some((c) => c.isPrimaryKey || c.isNaturalKey)) return null;
    const evidence = keyEvidenceDetail(toModelDef, toCols);
    if (evidence.evidence === 'not-key') return null;
    const id = `${linkId}|${toModel}`.toLowerCase();
    const checked = markKeyChoice?.for === id ? markKeyChoice.checked : evidence.source === 'dbt' && evidence.evidence === 'whole-key';
    return { id, checked, label: markKeyLabel(toModel, toCols) };
  }, [complete, direction, cardinality, toModelDef, toCols, linkId, toModel, markKeyChoice]);

  // Keys win (#133): warn, but allow, a many side that is its model's whole key.
  const keysWarning = useMemo(
    () => keysContradictionWarning(
      { fromModel, fromColumn: fromColumn.trim(), toModel, toColumn: toColumn.trim(), cardinality },
      domain?.models ?? [],
      pairsFilled && extraPairs.length > 0 ? allPairs : undefined,
    ),
    [fromModel, fromColumn, toModel, toColumn, cardinality, domain, pairsFilled, extraPairs.length, allPairs],
  );

  // Validation — pass original key when editing to skip self-duplicate check
  const errors = useMemo(
    () =>
      validateForm(fromModel, fromColumn, toModel, toColumn, extraPairs, cardinality, existingRelationships, originalLinks),
    [fromModel, fromColumn, toModel, toColumn, extraPairs, cardinality, existingRelationships, originalLinks],
  );
  // Rows whose pair is already a single link between the two models: taken into the composite (#133 L2).
  const absorbed = (pair: { fromColumn: string; toColumn: string }): boolean =>
    pairCount > 1 && !!fromModel && !!toModel && !!pair.fromColumn.trim() && !!pair.toColumn.trim()
    && existingRelationships.some((rel) => !originalLinks.some((o) => sameLink(o, rel)) && isAbsorbable(rel, fromModel, toModel)
      && sameLink(rel, { fromModel, fromColumn: pair.fromColumn.trim(), toModel, toColumn: pair.toColumn.trim() }));

  const isValid =
    Object.keys(errors).length === 0 &&
    fromModel !== '' &&
    fromColumn.trim() !== '' &&
    toModel !== '' &&
    toColumn.trim() !== '' &&
    pairsFilled &&
    direction !== 'undecided';
  const markKeyPayload = markKey?.checked ? { markKey: { model: toModel, columns: toCols } } : {};
  // Sent only for a composite: the pairs after the first.
  const extraPairsPayload = extraPairs.length > 0 ? { extraPairs: allPairs.slice(1) } : {};

  // Handlers
  const resetForm = useCallback(() => {
    setFromModel('');
    setFromColumn('');
    setToModel('');
    setToColumn('');
    setExtraPairs([]);
    setCardinality('many-to-one');
    setRole('');
    setTouched({});
    setChosenDirection(null);
    setMarkKeyChoice(null);
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
          role: role.trim(),
          ...markKeyPayload,
          ...extraPairsPayload,
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
          ...(role.trim() ? { role: role.trim() } : {}),
          ...markKeyPayload,
          ...extraPairsPayload,
        },
      });
    }

    handleClose();
  }, [isValid, isEditMode, fkDialogEditData, fromModel, fromColumn, toModel, toColumn, cardinality, role, markKeyPayload, extraPairsPayload, send, handleClose]);

  const handleBlur = useCallback((field: string) => {
    setTouched((prev) => ({ ...prev, [field]: true }));
  }, []);

  // Reset source column when source model changes
  const handleFromModelChange = useCallback((value: string) => {
    setFromModel(value);
    setFromColumn('');
    setExtraPairs((pairs) => pairs.map((p) => ({ ...p, fromColumn: '' })));
  }, []);

  // Reset target column when target model changes
  const handleToModelChange = useCallback((value: string) => {
    setToModel(value);
    setToColumn('');
    setExtraPairs((pairs) => pairs.map((p) => ({ ...p, toColumn: '' })));
  }, []);

  // "+ Add another column pair" and its rows (#133 L2).
  const addPair = useCallback(() => setExtraPairs((pairs) => [...pairs, { fromColumn: '', toColumn: '' }]), []);
  const setPair = useCallback((index: number, end: 'fromColumn' | 'toColumn', value: string) => {
    setExtraPairs((pairs) => pairs.map((p, i) => (i === index ? { ...p, [end]: value } : p)));
  }, []);
  const removePair = useCallback((index: number) => setExtraPairs((pairs) => pairs.filter((_, i) => i !== index)), []);

  // Apply prefill when dialog opens with prefill data (from drag-to-connect).
  // Reset form first to clear any stale state from previous sessions.
  useEffect(() => {
    if (isOpen && fkDialogPrefill) {
      // Reset non-prefilled form state; the cardinality key evidence suggests, if any.
      setCardinality(fkDialogPrefill.cardinality ?? 'many-to-one');
      setRole('');
      setTouched({});
      setChosenDirection(null);
      setMarkKeyChoice(null);
      setExtraPairs([]);
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
      setChosenDirection(null);
      setMarkKeyChoice(null);
      // A one-to-many (stored before #133) opens turned round, as the many-to-one
      // it will be saved as — the dialog offers no one-to-many.
      const shown = canonicalRelationship(fkDialogEditData);
      const turned = fkDialogEditData.cardinality === 'one-to-many';
      // A composite opens with every pair, read in the shown direction (#133 L2).
      const pairs = (fkDialogEditData.pairs ?? [fkDialogEditData])
        .map((p) => (turned ? { fromColumn: p.toColumn, toColumn: p.fromColumn } : { fromColumn: p.fromColumn, toColumn: p.toColumn }));
      setFromModel(shown.fromModel);
      setFromColumn(pairs[0].fromColumn);
      setToModel(shown.toModel);
      setToColumn(pairs[0].toColumn);
      setExtraPairs(pairs.slice(1));
      setCardinality(shown.cardinality);
      setRole(shown.role ?? '');
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
          {dialogTitle(isEditMode, pairCount)}
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
          {absorbed({ fromColumn, toColumn }) && <span className="new-fk-dialog__hint">{ABSORB_HINT}</span>}
        </div>

        {/* The other column pairs of a composite foreign key (#133 L2) */}
        {extraPairs.map((pair, i) => {
          const columnPicker = (end: 'fromColumn' | 'toColumn', columns: string[], label: string) => (columns.length > 0 ? (
            <select
              className="new-fk-dialog__select new-fk-dialog__pair-column"
              aria-label={`${label} ${i + 2}`}
              value={pair[end]}
              onChange={(e) => setPair(i, end, e.target.value)}
            >
              <option value="">Select column...</option>
              {columns.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          ) : (
            <input
              type="text"
              className="new-fk-dialog__input new-fk-dialog__pair-column"
              aria-label={`${label} ${i + 2}`}
              value={pair[end]}
              onChange={(e) => setPair(i, end, e.target.value)}
              placeholder="Enter column name..."
            />
          ));
          return (
            <div key={i} className="new-fk-dialog__field new-fk-dialog__pair">
              <div className="new-fk-dialog__pair-row">
                {columnPicker('fromColumn', sourceColumns, 'Source column')}
                <span className="new-fk-dialog__pair-arrow">→</span>
                {columnPicker('toColumn', targetColumns, 'Target column')}
                <button
                  type="button"
                  className="new-fk-dialog__pair-remove"
                  onClick={() => removePair(i)}
                  title="Remove this column pair"
                  aria-label={`Remove column pair ${i + 2}`}
                >
                  ×
                </button>
              </div>
              {errors[`pairs.${i}`] && (
                <span className="new-fk-dialog__error">{errors[`pairs.${i}`]}</span>
              )}
              {!errors[`pairs.${i}`] && absorbed(pair) && <span className="new-fk-dialog__hint">{ABSORB_HINT}</span>}
            </div>
          );
        })}
        {fromModel && toModel && pairCount < MAX_COMPOSITE_PAIRS && (
          <button type="button" className="new-fk-dialog__link-button new-fk-dialog__add-pair" onClick={addPair}>
            {ADD_PAIR_LABEL}
          </button>
        )}

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
            <option
              value="many-to-many"
              disabled={pairCount > 1}
              title={pairCount > 1 ? COMPOSITE_MANY_TO_MANY_TITLE : undefined}
            >
              Many-to-Many (*↔*)
            </option>
          </select>
          {errors.cardinality && <span className="new-fk-dialog__error">{errors.cardinality}</span>}
        </div>

        {/* Which side holds the foreign key (#133 L1) */}
        {orientation && (direction === 'decided' || direction === 'reversed') && (
          <div className={`new-fk-dialog__direction${direction === 'reversed' ? ' new-fk-dialog__direction--reversed' : ''}`}>
            {direction === 'reversed' && <span className="new-fk-dialog__direction-lead">The keys say it goes the other way: </span>}
            {directionSentence(orientation, keyKind)}
            {direction === 'reversed' && (
              <button type="button" className="new-fk-dialog__link-button" onClick={turnRound}>Turn round</button>
            )}
          </div>
        )}
        {choices && (
          <fieldset className="new-fk-dialog__direction-choice" aria-required="true">
            <legend className="new-fk-dialog__label">{DIRECTION_QUESTION}</legend>
            {choices.map((choice) => {
              const id = `${linkId}|${choice.from.model}.${choice.from.columns.join('+')}`.toLowerCase();
              const checked = direction === 'chosen' && sameEnd(choice.from, fromModel, fromCols);
              return (
                <label key={id} className="new-fk-dialog__radio">
                  <input
                    type="radio"
                    name="fk-direction"
                    checked={checked}
                    onChange={() => pickDirection(choice.from, choice.to)}
                  />
                  <span className="new-fk-dialog__radio-text">{choice.label.text}</span>
                  <span className="new-fk-dialog__hint">{choice.label.detail}</span>
                </label>
              );
            })}
            {direction === 'undecided' && <span className="new-fk-dialog__hint">{DIRECTION_MISSING_HINT}</span>}
          </fieldset>
        )}
        {markKey && (
          <label className="new-fk-dialog__checkbox">
            <input
              type="checkbox"
              checked={markKey.checked}
              onChange={(e) => setMarkKeyChoice({ for: markKey.id, checked: e.target.checked })}
            />
            {markKey.label}
          </label>
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
        {errors.sameColumn && (
          <div className="new-fk-dialog__error new-fk-dialog__error--global">
            {errors.sameColumn}
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

        {keysWarning && (
          <div className="new-fk-dialog__warning new-fk-dialog__warning--global" role="alert">
            <span className="new-fk-dialog__warning-icon">⚠</span>
            {keysWarning}
          </div>
        )}

        {/* Preview */}
        {fromModel && toModel && (
          <div className="new-fk-dialog__preview">
            <span className="new-fk-dialog__preview-label">Preview:</span>
            <span className="new-fk-dialog__preview-text">
              {pairCount > 1
                ? `${fromModel}.(${allPairs.map((p) => p.fromColumn || '?').join(', ')}) → ${toModel}.(${allPairs.map((p) => p.toColumn || '?').join(', ')})`
                : `${fromModel}.${fromColumn || '?'} → ${toModel}.${toColumn || '?'}`}
              <span className="new-fk-dialog__preview-cardinality">
                ({cardinality === 'many-to-one' ? '*→1' : cardinality === 'many-to-many' ? '*↔*' : '1→1'})
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
          {keysWarning ? (isEditMode ? 'Save anyway' : 'Create anyway') : (isEditMode ? 'Save Changes' : 'Create Relationship')}
        </button>
      </div>
    </Panel>
  );
}
