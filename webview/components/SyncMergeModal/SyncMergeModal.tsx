/**
 * SyncMergeModal — full-screen VS Code-style merge editor for sync reconciliation.
 *
 * Four-column layout: [chevron] | Logical | Item | Physical
 * Model section headers contain bulk accept buttons in their stage cells.
 * Column rows use AcceptCell for individual per-column resolution.
 *
 * UI/UX principles:
 * - Plain language: "Keep Logical" instead of arrows, "Apply Changes" instead of "Generate Sync Plan"
 * - Status badges: readable pills instead of tiny dots
 * - Action tooltips: each accept button explains what will happen
 * - Completion feedback: banner + green footer when all resolved
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEditorStore } from '../../store/editorStore';
import { STAGE_HEX } from '../../lib/stageColors';
import { stageName } from '../../lib/stageUtils';
import { SyncFooter, StalenessWarning } from '../DiscrepancyPanel/SyncControls';
import {
  modelKey,
  columnKey,
  relationshipKey,
  deriveColumnAction,
  deriveRelationshipAction,
} from '../../../src/types/syncPlan';
import type { ModelDiscrepancy, RelationshipDiscrepancy } from '../../../src/types/discrepancy';
import type { GroundTruth } from '../../../src/types/syncPlan';
import type { Stage } from '../../../src/types/semantic';
import './SyncMergeModal.css';

// ---------------------------------------------------------------------------
// actionToHint — maps action codes to user-friendly tooltip descriptions
// ---------------------------------------------------------------------------

function actionToHint(action: string | null): string {
  switch (action) {
    case 'add-to-logical':                       return 'Will add this model to your logical design';
    case 'remove-from-logical':                  return 'Will remove this model from your logical design';
    case 'add-to-physical':                      return 'Will add this model to dbt (requires compile)';
    case 'remove-from-physical':                 return 'Will remove this model from dbt';
    case 'add-column-to-logical':                return 'Will add this column to your logical design';
    case 'remove-column-from-logical':           return 'Will remove this column from your logical design';
    case 'add-column-to-physical':               return 'Will add this column in dbt schema';
    case 'remove-column-from-physical':          return 'Will remove this column from dbt schema';
    case 'update-type-in-logical':               return 'Will update the data type in your logical design';
    case 'update-type-in-physical':              return 'Will update the data type in dbt schema';
    case 'add-relationship-to-logical':          return 'Will add this relationship to your logical design';
    case 'remove-relationship-from-logical':     return 'Will remove this relationship from your logical design';
    case 'add-relationship-test-to-physical':    return 'Will add a dbt relationship test';
    case 'remove-relationship-test-from-physical': return 'Will remove the dbt relationship test';
    case 'update-cardinality-in-logical':        return 'Will update cardinality in your logical design';
    case 'update-cardinality-in-physical':       return 'Will update cardinality in dbt';
    default:                                     return 'No changes needed';
  }
}

// ---------------------------------------------------------------------------
// statusBadgeText helpers
// ---------------------------------------------------------------------------

function modelStatusText(status: string, sourceStage: string, targetStage: string): string {
  if (status === 'extra') return `Only in ${stageName(sourceStage)}`;
  if (status === 'missing') return `Only in ${stageName(targetStage)}`;
  return status;
}

function columnStatusText(status: string): string {
  if (status === 'extra') return 'New';
  if (status === 'missing') return 'Missing';
  if (status === 'type-mismatch') return 'Type diff';
  return status;
}

function relStatusText(status: string): string {
  if (status === 'extra') return 'New';
  if (status === 'missing') return 'Missing';
  if (status === 'cardinality-mismatch') return 'Cardinality diff';
  return status;
}

// ---------------------------------------------------------------------------
// AcceptCell — used only for column and relationship rows
// ---------------------------------------------------------------------------

interface AcceptCellProps {
  side: GroundTruth;
  selectionKey: string;
  children: React.ReactNode;
  valueColor?: string;
  hint?: string;
}

function AcceptCell({ side, selectionKey, children, valueColor, hint }: AcceptCellProps) {
  const choice = useEditorStore((s) => s.syncSelections[selectionKey] ?? null);
  const setSyncSelection = useEditorStore((s) => s.setSyncSelection);

  const isSelected = choice === side;
  const isOtherSelected = choice !== null && choice !== side;

  const label = isSelected
    ? `Keeping ${stageName(side)}`
    : `Keep ${stageName(side)}`;

  return (
    <td className={`sync-modal__cell sync-modal__cell--stage${isSelected ? ' sync-modal__cell--selected' : ''}${isOtherSelected ? ' sync-modal__cell--rejected' : ''}`}>
      <span className="sync-modal__cell-value" style={valueColor ? { color: valueColor } : undefined}>
        {children}
      </span>
      <button
        className={`sync-modal__accept-btn sync-modal__accept-btn--${side}${isSelected ? ' sync-modal__accept-btn--selected' : ''}`}
        onClick={() => setSyncSelection(selectionKey, side)}
        title={hint}
      >
        {label}
      </button>
    </td>
  );
}

// ---------------------------------------------------------------------------
// ModelRow
// ---------------------------------------------------------------------------

interface ModelRowProps {
  model: ModelDiscrepancy;
  sourceStage: string;
  targetStage: string;
  isCollapsed: boolean;
  hasFoldableContent: boolean;
  onToggle: () => void;
  modelSyncKeys: string[];
  allResolved: boolean;
}

function ModelRow({ model, sourceStage, targetStage, isCollapsed, hasFoldableContent, onToggle, modelSyncKeys, allResolved }: ModelRowProps) {
  const setSyncSelectionBulk = useEditorStore((s) => s.setSyncSelectionBulk);

  const handleBulk = useCallback(
    (gt: GroundTruth) => (e: React.MouseEvent) => {
      e.stopPropagation();
      setSyncSelectionBulk(modelSyncKeys, gt);
    },
    [modelSyncKeys, setSyncSelectionBulk],
  );

  // Left-edge accent colour on the chevron cell
  const accentColor = allResolved
    ? 'var(--stage-physical, #22c55e)'
    : model.status === 'extra' ? STAGE_HEX[sourceStage]
    : model.status === 'missing' ? STAGE_HEX[targetStage]
    : 'var(--stage-physical, #22c55e)';

  // Chevron cell
  const chevronCell = (
    <td
      className="sync-modal__cell sync-modal__cell--chevron"
      style={{ borderLeft: `4px solid ${accentColor}` }}
    >
      {hasFoldableContent && (
        <button
          className="sync-modal__chevron"
          onClick={(e) => { e.stopPropagation(); onToggle(); }}
          aria-label={isCollapsed ? 'Expand section' : 'Collapse section'}
        >
          {isCollapsed ? '▶' : '▼'}
        </button>
      )}
    </td>
  );

  // Item cell — model name, status badge, and resolved badge
  const itemCell = (
    <td className="sync-modal__cell sync-modal__cell--item">
      <div className="sync-modal__model-item-row">
        {model.status !== 'matched' && (
          <span className={`sync-modal__status-badge sync-modal__status-badge--${model.status}`}>
            {modelStatusText(model.status, sourceStage, targetStage)}
          </span>
        )}
        <span className="sync-modal__model-name">{model.name}</span>
        {allResolved && (
          <span className="sync-modal__resolved-badge">Resolved</span>
        )}
      </div>
    </td>
  );

  // Stage cells — contain existence info + bulk accept button
  const renderStageCell = (side: GroundTruth) => {
    const isSource = side === 'logical';
    const stageColor = STAGE_HEX[isSource ? sourceStage : targetStage];

    // Existence indicator for conflicted models only
    let existenceContent: React.ReactNode = null;
    if (model.status !== 'matched') {
      const inSource = model.status === 'extra';
      const presentOnThisSide = isSource ? inSource : !inSource;
      existenceContent = presentOnThisSide
        ? <span className="sync-modal__exists-dot" style={{ color: stageColor }}>● Exists</span>
        : <span className="sync-modal__missing-dash" style={{ color: STAGE_HEX.ghost }}>— Not present</span>;
    }

    return (
      <td className="sync-modal__cell sync-modal__cell--stage sync-modal__cell--model-stage">
        {existenceContent && <span className="sync-modal__cell-value">{existenceContent}</span>}
        {modelSyncKeys.length > 0 && (
          <button
            className="sync-modal__model-bulk-btn"
            onClick={handleBulk(side)}
            title={`Keep all ${stageName(side)} for ${model.name}`}
          >
            Keep all
          </button>
        )}
      </td>
    );
  };

  const rowClass = [
    'sync-modal__row',
    'sync-modal__row--model-header',
    model.status !== 'matched' ? `sync-modal__row--conflict sync-modal__row--${model.status}` : 'sync-modal__row--matched',
    allResolved ? 'sync-modal__row--all-resolved' : '',
  ].filter(Boolean).join(' ');

  return (
    <tr className={rowClass}>
      {chevronCell}
      {renderStageCell('logical')}
      {itemCell}
      {renderStageCell('physical')}
    </tr>
  );
}

// ---------------------------------------------------------------------------
// ColumnRow
// ---------------------------------------------------------------------------

interface ColumnRowProps {
  modelName: string;
  col: ModelDiscrepancy['columns'][number];
  sourceStage: string;
  targetStage: string;
}

function ColumnRow({ modelName, col, sourceStage, targetStage }: ColumnRowProps) {
  if (col.status === 'matched') return null;

  const key = columnKey(modelName, col.name);

  // Compute action hints for tooltips
  const logicalHint = actionToHint(deriveColumnAction(col.status as 'extra' | 'missing' | 'type-mismatch', 'logical', sourceStage as Stage));
  const physicalHint = actionToHint(deriveColumnAction(col.status as 'extra' | 'missing' | 'type-mismatch', 'physical', sourceStage as Stage));

  let sourceContent: React.ReactNode;
  let targetContent: React.ReactNode;
  let sourceColor: string | undefined;
  let targetColor: string | undefined;

  if (col.status === 'extra') {
    sourceContent = col.sourceDataType
      ? <span className="sync-modal__type-pill" style={{ color: STAGE_HEX[sourceStage], borderColor: STAGE_HEX[sourceStage] }}>{col.sourceDataType}</span>
      : <em className="sync-modal__no-type">no type</em>;
    sourceColor = STAGE_HEX[sourceStage];
    targetContent = <span className="sync-modal__missing-dash" style={{ color: STAGE_HEX.ghost }}>— Not present</span>;
  } else if (col.status === 'missing') {
    sourceContent = <span className="sync-modal__missing-dash" style={{ color: STAGE_HEX.ghost }}>— Not present</span>;
    targetContent = col.targetDataType
      ? <span className="sync-modal__type-pill" style={{ color: STAGE_HEX[targetStage], borderColor: STAGE_HEX[targetStage] }}>{col.targetDataType}</span>
      : <em className="sync-modal__no-type">no type</em>;
    targetColor = STAGE_HEX[targetStage];
  } else {
    // type-mismatch — show pills in both cells so the diff is obvious
    sourceContent = col.sourceDataType
      ? <span className="sync-modal__type-pill" style={{ color: STAGE_HEX[sourceStage], borderColor: STAGE_HEX[sourceStage] }}>{col.sourceDataType}</span>
      : <em className="sync-modal__no-type">no type</em>;
    sourceColor = STAGE_HEX[sourceStage];
    targetContent = col.targetDataType
      ? <span className="sync-modal__type-pill" style={{ color: STAGE_HEX[targetStage], borderColor: STAGE_HEX[targetStage] }}>{col.targetDataType}</span>
      : <em className="sync-modal__no-type">no type</em>;
    targetColor = STAGE_HEX[targetStage];
  }

  return (
    <tr className={`sync-modal__row sync-modal__row--column sync-modal__row--conflict sync-modal__row--${col.status}`}>
      <td className="sync-modal__cell sync-modal__cell--chevron" />
      <AcceptCell side="logical" selectionKey={key} valueColor={sourceColor} hint={logicalHint}>
        {sourceContent}
      </AcceptCell>
      <td className="sync-modal__cell sync-modal__cell--item sync-modal__cell--col-item">
        <span className={`sync-modal__status-badge sync-modal__status-badge--sm sync-modal__status-badge--${col.status}`}>
          {columnStatusText(col.status)}
        </span>
        <span className="sync-modal__col-name">{col.name}</span>
      </td>
      <AcceptCell side="physical" selectionKey={key} valueColor={targetColor} hint={physicalHint}>
        {targetContent}
      </AcceptCell>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// RelationshipRow
// ---------------------------------------------------------------------------

function RelationshipRow({ rel, sourceStage, targetStage }: { rel: RelationshipDiscrepancy; sourceStage: string; targetStage: string }) {
  const key = relationshipKey(rel.fromModel, rel.fromColumn, rel.toModel, rel.toColumn);

  // Compute action hints for tooltips
  const relStatus = rel.status === 'cardinality-mismatch' ? 'cardinality-mismatch' : rel.status;
  const logicalHint = actionToHint(deriveRelationshipAction(relStatus as 'extra' | 'missing' | 'cardinality-mismatch', 'logical', sourceStage as Stage));
  const physicalHint = actionToHint(deriveRelationshipAction(relStatus as 'extra' | 'missing' | 'cardinality-mismatch', 'physical', sourceStage as Stage));

  let sourceContent: React.ReactNode;
  let targetContent: React.ReactNode;

  if (rel.status === 'extra') {
    sourceContent = <span className="sync-modal__exists-dot" style={{ color: STAGE_HEX[sourceStage] }}>● Exists</span>;
    targetContent = <span className="sync-modal__missing-dash" style={{ color: STAGE_HEX.ghost }}>— Not present</span>;
  } else if (rel.status === 'missing') {
    sourceContent = <span className="sync-modal__missing-dash" style={{ color: STAGE_HEX.ghost }}>— Not present</span>;
    targetContent = <span className="sync-modal__exists-dot" style={{ color: STAGE_HEX[targetStage] }}>● Exists</span>;
  } else {
    sourceContent = <span style={{ color: STAGE_HEX[sourceStage] }}>{rel.sourceCardinality ?? '?'}</span>;
    targetContent = <span style={{ color: STAGE_HEX[targetStage] }}>{rel.targetCardinality ?? '?'}</span>;
  }

  return (
    <tr className={`sync-modal__row sync-modal__row--conflict sync-modal__row--${rel.status === 'cardinality-mismatch' ? 'mismatch' : rel.status}`}>
      <td className="sync-modal__cell sync-modal__cell--chevron" />
      <AcceptCell side="logical" selectionKey={key} hint={logicalHint}>{sourceContent}</AcceptCell>
      <td className="sync-modal__cell sync-modal__cell--item">
        <span className={`sync-modal__status-badge sync-modal__status-badge--sm sync-modal__status-badge--${rel.status === 'cardinality-mismatch' ? 'cardinality-mismatch' : rel.status}`}>
          {relStatusText(rel.status)}
        </span>
        <span className="sync-modal__rel-label">
          <span className="sync-modal__rel-model">{rel.fromModel}</span>
          <span className="sync-modal__rel-sep">.</span>
          <span className="sync-modal__rel-col">{rel.fromColumn}</span>
          <span className="sync-modal__rel-arrow">→</span>
          <span className="sync-modal__rel-model">{rel.toModel}</span>
          <span className="sync-modal__rel-sep">.</span>
          <span className="sync-modal__rel-col">{rel.toColumn}</span>
        </span>
      </td>
      <AcceptCell side="physical" selectionKey={key} hint={physicalHint}>{targetContent}</AcceptCell>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// ModelRowGroup — section header + collapsible column rows
// ---------------------------------------------------------------------------

interface ModelRowGroupProps {
  model: ModelDiscrepancy;
  conflictCols: ModelDiscrepancy['columns'];
  sourceStage: string;
  targetStage: string;
  isCollapsed: boolean;
  onToggle: () => void;
}

function ModelRowGroup({ model, conflictCols, sourceStage, targetStage, isCollapsed, onToggle }: ModelRowGroupProps) {
  const syncSelections = useEditorStore((s) => s.syncSelections);
  const setSyncSelection = useEditorStore((s) => s.setSyncSelection);
  const hasFoldableContent = conflictCols.length > 0;

  const mKey = model.status !== 'matched' ? modelKey(model.name) : null;

  const columnKeys = useMemo(
    () => conflictCols.map((col) => columnKey(model.name, col.name)),
    [model.name, conflictCols],
  );

  const modelSyncKeys = useMemo(() => {
    const keys: string[] = [];
    if (mKey) keys.push(mKey);
    keys.push(...columnKeys);
    return keys;
  }, [mKey, columnKeys]);

  const allResolved = useMemo(
    () => modelSyncKeys.length > 0 && modelSyncKeys.every((k) => syncSelections[k]),
    [modelSyncKeys, syncSelections],
  );

  // Auto-resolve the model key when all column keys are resolved.
  // When a model is extra/missing, it has both a model key and column keys.
  // Users resolve columns individually but never explicitly resolve the model key,
  // so we infer it: use the majority column selection direction, or default to the
  // side the model exists on.
  const setSyncSelectionRef = useRef(setSyncSelection);
  useEffect(() => { setSyncSelectionRef.current = setSyncSelection; });

  useEffect(() => {
    if (!mKey || columnKeys.length === 0) return;
    // Skip if model key is already set, or if not all columns are resolved yet
    if (syncSelections[mKey]) return;
    const allColsResolved = columnKeys.every((k) => syncSelections[k]);
    if (!allColsResolved) return;

    // Infer direction from column selections — majority wins
    let logCount = 0;
    let physCount = 0;
    for (const k of columnKeys) {
      if (syncSelections[k] === 'logical') logCount++;
      else if (syncSelections[k] === 'physical') physCount++;
    }
    const inferred: GroundTruth = logCount >= physCount ? 'logical' : 'physical';
    setSyncSelectionRef.current(mKey, inferred);
  }, [mKey, columnKeys, syncSelections]);

  // Auto-collapse after a short delay when all items in this model are resolved
  const prevAllResolvedRef = useRef(false);
  const onToggleRef = useRef(onToggle);
  useEffect(() => { onToggleRef.current = onToggle; });

  useEffect(() => {
    const wasResolved = prevAllResolvedRef.current;
    prevAllResolvedRef.current = allResolved;
    if (allResolved && !wasResolved && !isCollapsed && hasFoldableContent) {
      const timer = setTimeout(() => onToggleRef.current(), 500);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [allResolved, isCollapsed, hasFoldableContent]);

  return (
    <>
      <ModelRow
        model={model}
        sourceStage={sourceStage}
        targetStage={targetStage}
        isCollapsed={isCollapsed}
        hasFoldableContent={hasFoldableContent}
        onToggle={onToggle}
        modelSyncKeys={modelSyncKeys}
        allResolved={allResolved}
      />
      {!isCollapsed && conflictCols.map((col) => (
        <ColumnRow
          key={col.name}
          modelName={model.name}
          col={col}
          sourceStage={sourceStage}
          targetStage={targetStage}
        />
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// SyncMergeModal — main export
// ---------------------------------------------------------------------------

export function SyncMergeModal() {
  const syncMode = useEditorStore((s) => s.syncMode);
  const setSyncMode = useEditorStore((s) => s.setSyncMode);
  const discrepancyReport = useEditorStore((s) => s.discrepancyReport);
  const syncSelections = useEditorStore((s) => s.syncSelections);
  const setSyncSelectionBulk = useEditorStore((s) => s.setSyncSelectionBulk);

  const [collapsedModels, setCollapsedModels] = useState<Set<string>>(new Set());
  const [hideResolved, setHideResolved] = useState(true);
  const [resolvedSectionOpen, setResolvedSectionOpen] = useState(false);

  const toggleCollapsed = useCallback((modelName: string) => {
    setCollapsedModels((prev) => {
      const next = new Set(prev);
      if (next.has(modelName)) next.delete(modelName);
      else next.add(modelName);
      return next;
    });
  }, []);

  const models = discrepancyReport?.models ?? [];
  const relationships = discrepancyReport?.relationships ?? [];
  const sourceStage = discrepancyReport?.sourceStage ?? 'logical';
  const targetStage = discrepancyReport?.targetStage ?? 'physical';
  const domain = discrepancyReport?.domain ?? '';

  const relsWithIssues = useMemo(
    () => relationships.filter((r) => r.status !== 'matched'),
    [relationships],
  );

  const allSyncKeys = useMemo(() => {
    const keys: string[] = [];
    for (const m of models) {
      if (m.status !== 'matched') keys.push(modelKey(m.name));
      for (const c of m.columns) {
        if (c.status !== 'matched') keys.push(columnKey(m.name, c.name));
      }
    }
    for (const r of relsWithIssues) {
      keys.push(relationshipKey(r.fromModel, r.fromColumn, r.toModel, r.toColumn));
    }
    return keys;
  }, [models, relsWithIssues]);

  const resolvedCount = useMemo(
    () => allSyncKeys.filter((k) => syncSelections[k]).length,
    [allSyncKeys, syncSelections],
  );

  // Determine which models are fully resolved (all their sync keys have selections)
  const modelResolutionStatus = useMemo(() => {
    const status = new Map<string, boolean>();
    for (const m of models) {
      const keys: string[] = [];
      if (m.status !== 'matched') keys.push(modelKey(m.name));
      for (const c of m.columns) {
        if (c.status !== 'matched') keys.push(columnKey(m.name, c.name));
      }
      // A model is "resolved" if it has sync keys and all are selected
      status.set(m.name, keys.length > 0 && keys.every((k) => syncSelections[k]));
    }
    return status;
  }, [models, syncSelections]);

  // Determine which relationships are resolved
  const relResolutionStatus = useMemo(() => {
    const status = new Map<string, boolean>();
    for (const r of relsWithIssues) {
      const k = relationshipKey(r.fromModel, r.fromColumn, r.toModel, r.toColumn);
      status.set(k, !!syncSelections[k]);
    }
    return status;
  }, [relsWithIssues, syncSelections]);

  // Split models and relationships into unresolved / resolved when hiding
  const { unresolvedModels, resolvedModels } = useMemo(() => {
    if (!hideResolved) return { unresolvedModels: models, resolvedModels: [] as ModelDiscrepancy[] };
    const unresolved: ModelDiscrepancy[] = [];
    const resolved: ModelDiscrepancy[] = [];
    for (const m of models) {
      if (modelResolutionStatus.get(m.name)) resolved.push(m);
      else unresolved.push(m);
    }
    return { unresolvedModels: unresolved, resolvedModels: resolved };
  }, [models, hideResolved, modelResolutionStatus]);

  const { unresolvedRels, resolvedRels } = useMemo(() => {
    if (!hideResolved) return { unresolvedRels: relsWithIssues, resolvedRels: [] as RelationshipDiscrepancy[] };
    const unresolved: RelationshipDiscrepancy[] = [];
    const resolved: RelationshipDiscrepancy[] = [];
    for (const r of relsWithIssues) {
      const k = relationshipKey(r.fromModel, r.fromColumn, r.toModel, r.toColumn);
      if (relResolutionStatus.get(k)) resolved.push(r);
      else unresolved.push(r);
    }
    return { unresolvedRels: unresolved, resolvedRels: resolved };
  }, [relsWithIssues, hideResolved, relResolutionStatus]);

  const totalHiddenCount = resolvedModels.length + resolvedRels.length;

  const progressPct = allSyncKeys.length > 0 ? (resolvedCount / allSyncKeys.length) * 100 : 0;
  const allDone = resolvedCount === allSyncKeys.length && allSyncKeys.length > 0;

  const handleClose = useCallback(() => setSyncMode(false), [setSyncMode]);
  const handleBulk = useCallback(
    (gt: GroundTruth) => () => setSyncSelectionBulk(allSyncKeys, gt),
    [allSyncKeys, setSyncSelectionBulk],
  );

  const handleToggleHideResolved = useCallback(() => {
    setHideResolved((prev) => {
      if (!prev) setResolvedSectionOpen(false); // collapse the section when enabling hide
      return !prev;
    });
  }, []);

  if (!syncMode || !discrepancyReport) return null;

  const sourceName = stageName(sourceStage);
  const targetName = stageName(targetStage);

  return (
    <>
      <div className="sync-modal__backdrop" onClick={handleClose} />
      <div className="sync-modal" role="dialog" aria-modal="true" aria-label="Resolve differences">

        {/* Header — title + explanatory subtitle */}
        <div className="sync-modal__header">
          <div className="sync-modal__header-content">
            <div className="sync-modal__header-title-row">
              <span className="sync-modal__header-icon">⇄</span>
              <span className="sync-modal__header-domain">{domain}</span>
            </div>
            <p className="sync-modal__header-subtitle">
              Choose which version to keep for each difference between{' '}
              <strong style={{ color: STAGE_HEX[sourceStage] }}>{sourceName}</strong>
              {' '}and{' '}
              <strong style={{ color: STAGE_HEX[targetStage] }}>{targetName}</strong>.
            </p>
          </div>
          <button className="sync-modal__close" onClick={handleClose} aria-label="Exit sync mode">&times;</button>
        </div>

        <StalenessWarning />

        {/* Toolbar — plain-language bulk actions */}
        <div className="sync-modal__toolbar">
          <button className="sync-modal__bulk-btn sync-modal__bulk-btn--logical" onClick={handleBulk('logical')}>
            Keep all {sourceName}
          </button>
          <button className="sync-modal__bulk-btn sync-modal__bulk-btn--physical" onClick={handleBulk('physical')}>
            Keep all {targetName}
          </button>
          <span className="sync-modal__toolbar-sep" />
          <button
            className={`sync-modal__bulk-btn${hideResolved ? ' sync-modal__bulk-btn--active' : ''}`}
            onClick={handleToggleHideResolved}
            title={hideResolved ? 'Show all items including resolved' : 'Move resolved items to the bottom and collapse them'}
          >
            {hideResolved ? 'Show all' : 'Hide resolved'}
          </button>
          <span className="sync-modal__toolbar-count">
            {resolvedCount} of {allSyncKeys.length} resolved
          </span>
        </div>

        {/* Progress section — labeled bar with status */}
        <div className="sync-modal__progress-section">
          <div className="sync-modal__progress-label">
            <span className="sync-modal__progress-label-text">
              {resolvedCount} of {allSyncKeys.length} difference{allSyncKeys.length !== 1 ? 's' : ''} resolved
            </span>
            {allDone && <span className="sync-modal__progress-done-badge">Ready to apply</span>}
          </div>
          <div className="sync-modal__progress">
            <div
              className={`sync-modal__progress-fill${allDone ? ' sync-modal__progress-fill--done' : ''}`}
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>

        {/* Completion banner — appears when all resolved */}
        {allDone && (
          <div className="sync-modal__completion-banner">
            <span className="sync-modal__completion-icon">✓</span>
            <span className="sync-modal__completion-text">
              All differences resolved. Click <strong>Apply Changes</strong> below to continue.
            </span>
          </div>
        )}

        {/* Table */}
        <div className="sync-modal__table-wrap">
          <table className="sync-modal__table">
            <colgroup>
              <col className="sync-modal__col--chevron" />
              <col className="sync-modal__col--stage" />
              <col className="sync-modal__col--item" />
              <col className="sync-modal__col--stage" />
            </colgroup>
            <thead className="sync-modal__thead">
              <tr>
                <th className="sync-modal__th sync-modal__th--chevron" />
                <th className="sync-modal__th sync-modal__th--stage sync-modal__th--logical" style={{ color: STAGE_HEX[sourceStage] }}>
                  {sourceName}
                </th>
                <th className="sync-modal__th sync-modal__th--item">Difference</th>
                <th className="sync-modal__th sync-modal__th--stage sync-modal__th--physical" style={{ color: STAGE_HEX[targetStage] }}>
                  {targetName}
                </th>
              </tr>
            </thead>
            <tbody>
              {/* Unresolved models — always shown at top */}
              {unresolvedModels.map((model) => {
                const conflictCols = model.columns.filter((c) => c.status !== 'matched');
                return (
                  <ModelRowGroup
                    key={model.name}
                    model={model}
                    conflictCols={conflictCols}
                    sourceStage={sourceStage}
                    targetStage={targetStage}
                    isCollapsed={collapsedModels.has(model.name)}
                    onToggle={() => toggleCollapsed(model.name)}
                  />
                );
              })}

              {/* Unresolved relationships */}
              {unresolvedRels.length > 0 && (
                <>
                  <tr className="sync-modal__section-header-row">
                    <td colSpan={4} className="sync-modal__section-label">Relationships</td>
                  </tr>
                  {unresolvedRels.map((r) => (
                    <RelationshipRow
                      key={`${r.fromModel}.${r.fromColumn}-${r.toModel}.${r.toColumn}`}
                      rel={r}
                      sourceStage={sourceStage}
                      targetStage={targetStage}
                    />
                  ))}
                </>
              )}

              {/* Resolved section — collapsed summary at bottom when hideResolved is on */}
              {hideResolved && totalHiddenCount > 0 && (
                <>
                  <tr
                    className="sync-modal__resolved-section-header"
                    onClick={() => setResolvedSectionOpen((prev) => !prev)}
                  >
                    <td colSpan={4} className="sync-modal__resolved-section-cell">
                      <button className="sync-modal__resolved-section-toggle" aria-label={resolvedSectionOpen ? 'Collapse resolved items' : 'Expand resolved items'}>
                        {resolvedSectionOpen ? '▼' : '▶'}
                      </button>
                      <span className="sync-modal__resolved-section-badge">✓</span>
                      <span className="sync-modal__resolved-section-text">
                        {totalHiddenCount} resolved item{totalHiddenCount !== 1 ? 's' : ''}
                      </span>
                    </td>
                  </tr>
                  {resolvedSectionOpen && resolvedModels.map((model) => {
                    const conflictCols = model.columns.filter((c) => c.status !== 'matched');
                    return (
                      <ModelRowGroup
                        key={model.name}
                        model={model}
                        conflictCols={conflictCols}
                        sourceStage={sourceStage}
                        targetStage={targetStage}
                        isCollapsed={collapsedModels.has(model.name)}
                        onToggle={() => toggleCollapsed(model.name)}
                      />
                    );
                  })}
                  {resolvedSectionOpen && resolvedRels.length > 0 && resolvedRels.map((r) => (
                    <RelationshipRow
                      key={`resolved-${r.fromModel}.${r.fromColumn}-${r.toModel}.${r.toColumn}`}
                      rel={r}
                      sourceStage={sourceStage}
                      targetStage={targetStage}
                    />
                  ))}
                </>
              )}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div className={`sync-modal__footer${allDone ? ' sync-modal__footer--ready' : ''}`}>
          <SyncFooter totalKeys={allSyncKeys.length} />
        </div>
      </div>
    </>
  );
}
