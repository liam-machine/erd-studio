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

const ACTION_HINTS: Record<string, string> = {
  'add-to-logical':                        'Will add this model to your logical design',
  'remove-from-logical':                   'Will remove this model from your logical design',
  'add-to-physical':                       'Will add this model to dbt (requires compile)',
  'remove-from-physical':                  'Will remove this model from dbt',
  'add-column-to-logical':                 'Will add this column to your logical design',
  'remove-column-from-logical':            'Will remove this column from your logical design',
  'add-column-to-physical':                'Will add this column in dbt schema',
  'remove-column-from-physical':           'Will remove this column from dbt schema',
  'update-type-in-logical':                'Will update the data type in your logical design',
  'update-type-in-physical':               'Will update the data type in dbt schema',
  'add-relationship-to-logical':           'Will add this relationship to your logical design',
  'remove-relationship-from-logical':      'Will remove this relationship from your logical design',
  'add-relationship-test-to-physical':     'Will add a dbt relationship test',
  'remove-relationship-test-from-physical': 'Will remove the dbt relationship test',
  'update-cardinality-in-logical':         'Will update cardinality in your logical design',
  'update-cardinality-in-physical':        'Will update cardinality in dbt',
};

function actionToHint(action: string | null): string {
  return (action && ACTION_HINTS[action]) ?? 'No changes needed';
}

// ---------------------------------------------------------------------------
// Status badge text — maps discrepancy statuses to human labels
// ---------------------------------------------------------------------------

const ITEM_STATUS_TEXT: Record<string, string> = {
  extra:                  'New',
  missing:                'Missing',
  'type-mismatch':        'Type diff',
  'cardinality-mismatch': 'Cardinality diff',
};

function modelStatusText(status: string, sourceStage: string, targetStage: string): string {
  if (status === 'extra') return `Only in ${stageName(sourceStage)}`;
  if (status === 'missing') return `Only in ${stageName(targetStage)}`;
  return status;
}

function itemStatusText(status: string): string {
  return ITEM_STATUS_TEXT[status] ?? status;
}

// ---------------------------------------------------------------------------
// Type narrowing helpers — filter out 'matched' with proper type narrowing
// ---------------------------------------------------------------------------

type ConflictColumnStatus = 'extra' | 'missing' | 'type-mismatch';
type ConflictRelStatus = 'extra' | 'missing' | 'cardinality-mismatch';

function isConflictColumnStatus(s: string): s is ConflictColumnStatus {
  return s === 'extra' || s === 'missing' || s === 'type-mismatch';
}

function isConflictRelStatus(s: string): s is ConflictRelStatus {
  return s === 'extra' || s === 'missing' || s === 'cardinality-mismatch';
}

// ---------------------------------------------------------------------------
// splitByResolved — partitions an array into unresolved/resolved items
// ---------------------------------------------------------------------------

function splitByResolved<T>(items: T[], isResolved: (item: T) => boolean): { unresolved: T[]; resolved: T[] } {
  const unresolved: T[] = [];
  const resolved: T[] = [];
  for (const item of items) {
    (isResolved(item) ? resolved : unresolved).push(item);
  }
  return { unresolved, resolved };
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
    ? `✓ ${stageName(side)}`
    : stageName(side);

  return (
    <td className={`sync-modal__cell sync-modal__cell--stage${isSelected ? ' sync-modal__cell--selected' : ''}${isOtherSelected ? ' sync-modal__cell--rejected' : ''}`}>
      <div className="sync-modal__stage-content">
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
      </div>
    </td>
  );
}

// ---------------------------------------------------------------------------
// ModelRow
// ---------------------------------------------------------------------------

interface SelectionSummary {
  logical: number;
  physical: number;
  total: number;
}

interface ModelRowProps {
  model: ModelDiscrepancy;
  sourceStage: string;
  targetStage: string;
  isCollapsed: boolean;
  hasFoldableContent: boolean;
  onToggle: () => void;
  modelSyncKeys: string[];
  allResolved: boolean;
  selectionSummary: SelectionSummary | null;
}

function ModelRow({ model, sourceStage, targetStage, isCollapsed, hasFoldableContent, onToggle, modelSyncKeys, allResolved, selectionSummary }: ModelRowProps) {
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
        {isCollapsed && selectionSummary && (selectionSummary.logical > 0 || selectionSummary.physical > 0) && (
          <span className="sync-modal__selection-summary">
            {selectionSummary.logical > 0 && (
              <span className="sync-modal__selection-chip sync-modal__selection-chip--logical">
                {selectionSummary.logical} {stageName(sourceStage).toLowerCase()}
              </span>
            )}
            {selectionSummary.physical > 0 && (
              <span className="sync-modal__selection-chip sync-modal__selection-chip--physical">
                {selectionSummary.physical} {stageName(targetStage).toLowerCase()}
              </span>
            )}
            {selectionSummary.total - selectionSummary.logical - selectionSummary.physical > 0 && (
              <span className="sync-modal__selection-chip sync-modal__selection-chip--pending">
                {selectionSummary.total - selectionSummary.logical - selectionSummary.physical} pending
              </span>
            )}
          </span>
        )}
      </div>
    </td>
  );

  // Stage cells — bulk accept button only (status badge handles existence)
  const renderStageCell = (side: GroundTruth) => (
    <td className="sync-modal__cell sync-modal__cell--stage sync-modal__cell--model-stage">
      {modelSyncKeys.length > 0 && (
        <button
          className={`sync-modal__model-bulk-btn sync-modal__model-bulk-btn--${side}`}
          onClick={handleBulk(side)}
          title={`Keep all ${stageName(side)} for ${model.name}`}
        >
          Keep all
        </button>
      )}
    </td>
  );

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

  // Compute action hints for tooltips (status is narrowed by the matched guard above)
  const colStatus = isConflictColumnStatus(col.status) ? col.status : 'extra';
  const logicalHint = actionToHint(deriveColumnAction(colStatus, 'logical', sourceStage as Stage));
  const physicalHint = actionToHint(deriveColumnAction(colStatus, 'physical', sourceStage as Stage));

  let sourceContent: React.ReactNode;
  let targetContent: React.ReactNode;
  let sourceColor: string | undefined;
  let targetColor: string | undefined;

  if (col.status === 'extra') {
    sourceContent = col.sourceDataType
      ? <span className="sync-modal__type-pill" style={{ color: STAGE_HEX[sourceStage], borderColor: STAGE_HEX[sourceStage] }}>{col.sourceDataType}</span>
      : <em className="sync-modal__no-type">no type</em>;
    sourceColor = STAGE_HEX[sourceStage];
    targetContent = <span className="sync-modal__missing-dash">—</span>;
  } else if (col.status === 'missing') {
    sourceContent = <span className="sync-modal__missing-dash">—</span>;
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
          {itemStatusText(col.status)}
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

  // Compute action hints for tooltips (only called for non-matched relationships)
  const relStatus = isConflictRelStatus(rel.status) ? rel.status : 'extra';
  const logicalHint = actionToHint(deriveRelationshipAction(relStatus, 'logical', sourceStage as Stage));
  const physicalHint = actionToHint(deriveRelationshipAction(relStatus, 'physical', sourceStage as Stage));

  let sourceContent: React.ReactNode;
  let targetContent: React.ReactNode;

  if (rel.status === 'extra') {
    sourceContent = <span className="sync-modal__exists-dot" style={{ color: STAGE_HEX[sourceStage] }}>●</span>;
    targetContent = <span className="sync-modal__missing-dash">—</span>;
  } else if (rel.status === 'missing') {
    sourceContent = <span className="sync-modal__missing-dash">—</span>;
    targetContent = <span className="sync-modal__exists-dot" style={{ color: STAGE_HEX[targetStage] }}>●</span>;
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
          {itemStatusText(rel.status)}
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

  const selectionSummary = useMemo<SelectionSummary | null>(() => {
    if (modelSyncKeys.length === 0) return null;
    let logical = 0;
    let physical = 0;
    for (const k of modelSyncKeys) {
      if (syncSelections[k] === 'logical') logical++;
      else if (syncSelections[k] === 'physical') physical++;
    }
    return { logical, physical, total: modelSyncKeys.length };
  }, [modelSyncKeys, syncSelections]);

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

    // Infer direction from column selections — majority wins, logical on tie
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
        selectionSummary={selectionSummary}
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
  const [relsCollapsed, setRelsCollapsed] = useState(false);
  const [modalSize, setModalSize] = useState<{ width: number; height: number } | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<{ startX: number; startY: number; startW: number; startH: number } | null>(null);

  const toggleCollapsed = useCallback((modelName: string) => {
    setCollapsedModels((prev) => {
      const next = new Set(prev);
      if (next.has(modelName)) next.delete(modelName);
      else next.add(modelName);
      return next;
    });
  }, []);

  const allModels = discrepancyReport?.models ?? [];
  const relationships = discrepancyReport?.relationships ?? [];
  const sourceStage = discrepancyReport?.sourceStage ?? 'logical';
  const targetStage = discrepancyReport?.targetStage ?? 'physical';
  const domain = discrepancyReport?.domain ?? '';

  const models = useMemo(
    () => allModels.filter((m) => m.status !== 'matched' || m.columns.some((c) => c.status !== 'matched')),
    [allModels],
  );

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

  const { resolvedCount, logicalResolvedCount, physicalResolvedCount } = useMemo(() => {
    let total = 0;
    let log = 0;
    let phys = 0;
    for (const k of allSyncKeys) {
      const sel = syncSelections[k];
      if (sel) {
        total++;
        if (sel === 'logical') log++;
        else phys++;
      }
    }
    return { resolvedCount: total, logicalResolvedCount: log, physicalResolvedCount: phys };
  }, [allSyncKeys, syncSelections]);

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
  const { unresolved: unresolvedModels, resolved: resolvedModels } = useMemo(() => {
    if (!hideResolved) return { unresolved: models, resolved: [] as ModelDiscrepancy[] };
    return splitByResolved(models, (m) => !!modelResolutionStatus.get(m.name));
  }, [models, hideResolved, modelResolutionStatus]);

  const { unresolved: unresolvedRels, resolved: resolvedRels } = useMemo(() => {
    if (!hideResolved) return { unresolved: relsWithIssues, resolved: [] as RelationshipDiscrepancy[] };
    return splitByResolved(relsWithIssues, (r) => {
      const k = relationshipKey(r.fromModel, r.fromColumn, r.toModel, r.toColumn);
      return !!relResolutionStatus.get(k);
    });
  }, [relsWithIssues, hideResolved, relResolutionStatus]);

  const totalHiddenCount = resolvedModels.length + resolvedRels.length;

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

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const modal = modalRef.current;
    if (!modal) return;
    const rect = modal.getBoundingClientRect();
    resizeRef.current = { startX: e.clientX, startY: e.clientY, startW: rect.width, startH: rect.height };

    const handleMouseMove = (ev: MouseEvent) => {
      if (!resizeRef.current) return;
      const { startX, startY, startW, startH } = resizeRef.current;
      const newW = Math.max(560, Math.min(window.innerWidth * 0.95, startW + (ev.clientX - startX) * 2));
      const newH = Math.max(400, Math.min(window.innerHeight * 0.95, startH + (ev.clientY - startY) * 2));
      setModalSize({ width: newW, height: newH });
    };

    const handleMouseUp = () => {
      resizeRef.current = null;
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, []);

  if (!syncMode || !discrepancyReport) return null;

  const sourceName = stageName(sourceStage);
  const targetName = stageName(targetStage);

  return (
    <>
      <div className="sync-modal__backdrop" onClick={handleClose} />
      <div
        ref={modalRef}
        className="sync-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Resolve differences"
        style={modalSize ? { width: modalSize.width, height: modalSize.height } : undefined}
      >

        {/* Header */}
        <div className="sync-modal__header">
          <span className="sync-modal__header-icon">⇄</span>
          <span className="sync-modal__header-domain">{domain}</span>
          <span className="sync-modal__header-stage" style={{ color: STAGE_HEX[sourceStage] }}>{sourceName}</span>
          <span className="sync-modal__header-vs">vs</span>
          <span className="sync-modal__header-stage" style={{ color: STAGE_HEX[targetStage] }}>{targetName}</span>
          <button className="sync-modal__close" onClick={handleClose} aria-label="Exit sync mode">&times;</button>
        </div>

        <StalenessWarning />

        {/* Toolbar — bulk actions + integrated progress */}
        <div className="sync-modal__toolbar">
          <div className="sync-modal__toolbar-grid">
            <span />
            <button className="sync-modal__bulk-btn sync-modal__bulk-btn--logical" onClick={handleBulk('logical')}>
              All {sourceName}
            </button>
            <div className="sync-modal__toolbar-center">
              <button
                className={`sync-modal__toolbar-toggle${hideResolved ? ' sync-modal__toolbar-toggle--active' : ''}`}
                onClick={handleToggleHideResolved}
                title={hideResolved ? 'Show all items including resolved' : 'Move resolved items to the bottom and collapse them'}
              >
                {hideResolved ? 'Show all' : 'Hide resolved'}
              </button>
              <span className="sync-modal__toolbar-count">
                {resolvedCount}/{allSyncKeys.length}
                {resolvedCount > 0 && (
                  <span className="sync-modal__toolbar-breakdown">
                    {logicalResolvedCount > 0 && <span className="sync-modal__toolbar-breakdown-dot sync-modal__toolbar-breakdown-dot--logical">{logicalResolvedCount}</span>}
                    {physicalResolvedCount > 0 && <span className="sync-modal__toolbar-breakdown-dot sync-modal__toolbar-breakdown-dot--physical">{physicalResolvedCount}</span>}
                  </span>
                )}
              </span>
            </div>
            <button className="sync-modal__bulk-btn sync-modal__bulk-btn--physical" onClick={handleBulk('physical')}>
              All {targetName}
            </button>
          </div>
          <div className="sync-modal__progress">
            <div
              className="sync-modal__progress-fill sync-modal__progress-fill--logical"
              style={{ width: allSyncKeys.length > 0 ? `${(logicalResolvedCount / allSyncKeys.length) * 100}%` : '0%' }}
            />
            <div
              className="sync-modal__progress-fill sync-modal__progress-fill--physical"
              style={{ width: allSyncKeys.length > 0 ? `${(physicalResolvedCount / allSyncKeys.length) * 100}%` : '0%' }}
            />
          </div>
        </div>

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

              {/* Relationships — collapsible section */}
              {unresolvedRels.length > 0 && (
                <>
                  <tr
                    className="sync-modal__section-header-row"
                    onClick={() => setRelsCollapsed((p) => !p)}
                  >
                    <td colSpan={4} className="sync-modal__section-label">
                      <button className="sync-modal__section-toggle" aria-label={relsCollapsed ? 'Expand relationships' : 'Collapse relationships'}>
                        {relsCollapsed ? '▶' : '▼'}
                      </button>
                      <span>Relationships</span>
                      <span className="sync-modal__section-count">{unresolvedRels.length}</span>
                    </td>
                  </tr>
                  {!relsCollapsed && unresolvedRels.map((r) => (
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
                  {resolvedSectionOpen && resolvedRels.length > 0 && (
                    <>
                      <tr className="sync-modal__section-header-row sync-modal__section-header-row--static">
                        <td colSpan={4} className="sync-modal__section-label">
                          <span>Relationships</span>
                          <span className="sync-modal__section-count">{resolvedRels.length}</span>
                        </td>
                      </tr>
                      {resolvedRels.map((r) => (
                        <RelationshipRow
                          key={`resolved-${r.fromModel}.${r.fromColumn}-${r.toModel}.${r.toColumn}`}
                          rel={r}
                          sourceStage={sourceStage}
                          targetStage={targetStage}
                        />
                      ))}
                    </>
                  )}
                </>
              )}
            </tbody>
          </table>
        </div>

        {/* Footer */}
        <div className={`sync-modal__footer${allDone ? ' sync-modal__footer--ready' : ''}`}>
          <SyncFooter totalKeys={allSyncKeys.length} />
        </div>

        <div
          className="sync-modal__resize-handle"
          onMouseDown={handleResizeStart}
          title="Drag to resize"
        />
      </div>
    </>
  );
}
