/**
 * SyncMergeModal — full-screen VS Code-style merge editor for sync reconciliation.
 *
 * Four-column layout: [chevron] | Logical | Item | Physical
 * Model section headers contain bulk accept buttons in their stage cells.
 * Column rows use AcceptCell for individual per-column resolution.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEditorStore } from '../../store/editorStore';
import { STAGE_HEX } from '../../lib/stageColors';
import { SyncFooter, StalenessWarning } from '../DiscrepancyPanel/SyncControls';
import {
  modelKey,
  columnKey,
  relationshipKey,
} from '../../../src/types/syncPlan';
import type { ModelDiscrepancy, RelationshipDiscrepancy } from '../../../src/types/discrepancy';
import type { GroundTruth } from '../../../src/types/syncPlan';
import './SyncMergeModal.css';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stageName(stage: string): string {
  return stage.charAt(0).toUpperCase() + stage.slice(1);
}

// ---------------------------------------------------------------------------
// AcceptCell — used only for column and relationship rows
// ---------------------------------------------------------------------------

interface AcceptCellProps {
  side: GroundTruth;
  selectionKey: string;
  children: React.ReactNode;
  valueColor?: string;
}

function AcceptCell({ side, selectionKey, children, valueColor }: AcceptCellProps) {
  const choice = useEditorStore((s) => s.syncSelections[selectionKey] ?? null);
  const setSyncSelection = useEditorStore((s) => s.setSyncSelection);

  const isSelected = choice === side;
  const isOtherSelected = choice !== null && choice !== side;

  return (
    <td className={`sync-modal__cell sync-modal__cell--stage${isSelected ? ' sync-modal__cell--selected' : ''}${isOtherSelected ? ' sync-modal__cell--rejected' : ''}`}>
      <span className="sync-modal__cell-value" style={valueColor ? { color: valueColor } : undefined}>
        {children}
      </span>
      <button
        className={`sync-modal__accept-btn sync-modal__accept-btn--${side}${isSelected ? ' sync-modal__accept-btn--selected' : ''}`}
        onClick={() => setSyncSelection(selectionKey, side)}
      >
        {side === 'logical' ? '← Logical' : 'Physical →'}
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
      style={{ borderLeft: `3px solid ${accentColor}` }}
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

  // Item cell — just the model name and resolved badge
  const itemCell = (
    <td className="sync-modal__cell sync-modal__cell--item">
      <div className="sync-modal__model-item-row">
        {model.status !== 'matched' && (
          <span className={`sync-modal__model-status-dot sync-modal__model-status-dot--${model.status}`} />
        )}
        <span className="sync-modal__model-name">{model.name}</span>
        {allResolved && (
          <span className="sync-modal__resolved-badge">✓ resolved</span>
        )}
      </div>
    </td>
  );

  // Stage cells — contain existence info + bulk accept button
  const renderStageCell = (side: GroundTruth) => {
    const isSource = side === 'logical';
    const stageColor = STAGE_HEX[isSource ? sourceStage : targetStage];

    if (allResolved) {
      return (
        <td className="sync-modal__cell sync-modal__cell--stage sync-modal__cell--model-stage">
          <span className="sync-modal__exists-check" style={{ color: stageColor }}>✓</span>
        </td>
      );
    }

    // Existence indicator for conflicted models
    let existenceContent: React.ReactNode;
    if (model.status !== 'matched') {
      const inSource = model.status === 'extra';
      const presentOnThisSide = isSource ? inSource : !inSource;
      existenceContent = presentOnThisSide
        ? <span className="sync-modal__exists-dot" style={{ color: stageColor }}>● Exists</span>
        : <span className="sync-modal__missing-dash" style={{ color: STAGE_HEX.ghost }}>— Not present</span>;
    } else {
      existenceContent = <span className="sync-modal__exists-check" style={{ color: stageColor }}>✓</span>;
    }

    return (
      <td className="sync-modal__cell sync-modal__cell--stage sync-modal__cell--model-stage">
        <span className="sync-modal__cell-value">{existenceContent}</span>
        {modelSyncKeys.length > 0 && (
          <button
            className="sync-modal__model-bulk-btn"
            onClick={handleBulk(side)}
            title={`Accept all ${side} for this model`}
          >
            {side === 'logical' ? '← All' : 'All →'}
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
  const isTypeMismatch = col.status === 'type-mismatch';

  let sourceContent: React.ReactNode;
  let targetContent: React.ReactNode;
  let sourceColor: string | undefined;
  let targetColor: string | undefined;

  if (col.status === 'extra') {
    sourceContent = isTypeMismatch
      ? null
      : col.sourceDataType
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
      <AcceptCell side="logical" selectionKey={key} valueColor={sourceColor}>
        {sourceContent}
      </AcceptCell>
      <td className="sync-modal__cell sync-modal__cell--item sync-modal__cell--col-item">
        <span className={`sync-modal__col-dot sync-modal__col-dot--${col.status}`} />
        <span className="sync-modal__col-name">{col.name}</span>
      </td>
      <AcceptCell side="physical" selectionKey={key} valueColor={targetColor}>
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
  const label = `${rel.fromModel}.${rel.fromColumn} → ${rel.toModel}.${rel.toColumn}`;

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
      <AcceptCell side="logical" selectionKey={key}>{sourceContent}</AcceptCell>
      <td className="sync-modal__cell sync-modal__cell--item">
        <span className={`sync-modal__col-dot sync-modal__col-dot--${rel.status === 'cardinality-mismatch' ? 'type-mismatch' : rel.status}`} />
        <span className="sync-modal__rel-label">{label}</span>
      </td>
      <AcceptCell side="physical" selectionKey={key}>{targetContent}</AcceptCell>
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
  const hasFoldableContent = conflictCols.length > 0;

  const modelSyncKeys = useMemo(() => {
    const keys: string[] = [];
    if (model.status !== 'matched') keys.push(modelKey(model.name));
    for (const col of conflictCols) keys.push(columnKey(model.name, col.name));
    return keys;
  }, [model, conflictCols]);

  const allResolved = useMemo(
    () => modelSyncKeys.length > 0 && modelSyncKeys.every((k) => syncSelections[k]),
    [modelSyncKeys, syncSelections],
  );

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

  const progressPct = allSyncKeys.length > 0 ? (resolvedCount / allSyncKeys.length) * 100 : 0;
  const allDone = resolvedCount === allSyncKeys.length && allSyncKeys.length > 0;

  const handleClose = useCallback(() => setSyncMode(false), [setSyncMode]);
  const handleBulk = useCallback(
    (gt: GroundTruth) => () => setSyncSelectionBulk(allSyncKeys, gt),
    [allSyncKeys, setSyncSelectionBulk],
  );

  // Collapse all models that are fully resolved
  const handleFoldResolved = useCallback(() => {
    setCollapsedModels((prev) => {
      const next = new Set(prev);
      for (const m of models) {
        const keys: string[] = [];
        if (m.status !== 'matched') keys.push(modelKey(m.name));
        for (const c of m.columns) {
          if (c.status !== 'matched') keys.push(columnKey(m.name, c.name));
        }
        if (keys.length > 0 && keys.every((k) => syncSelections[k])) {
          next.add(m.name);
        }
      }
      return next;
    });
  }, [models, syncSelections]);

  if (!syncMode || !discrepancyReport) return null;

  const sourceName = stageName(sourceStage);
  const targetName = stageName(targetStage);

  return (
    <>
      <div className="sync-modal__backdrop" onClick={handleClose} />
      <div className="sync-modal" role="dialog" aria-modal="true" aria-label="Sync reconciliation">

        {/* Header */}
        <div className="sync-modal__header">
          <span className="sync-modal__header-title">
            <span className="sync-modal__header-icon">⊕</span>
            <span className="sync-modal__header-domain">{domain}</span>
            <span className="sync-modal__header-sep">·</span>
            <span className="sync-modal__header-stage" style={{ color: STAGE_HEX[sourceStage] }}>{sourceName}</span>
            <span className="sync-modal__header-arrow">→</span>
            <span className="sync-modal__header-stage" style={{ color: STAGE_HEX[targetStage] }}>{targetName}</span>
          </span>
          <button className="sync-modal__close" onClick={handleClose} aria-label="Exit sync mode">&times;</button>
        </div>

        <StalenessWarning />

        {/* Bulk toolbar */}
        <div className="sync-modal__toolbar">
          <button className="sync-modal__bulk-btn" onClick={handleBulk('logical')}>← All {sourceName}</button>
          <button className="sync-modal__bulk-btn" onClick={handleBulk('physical')}>All {targetName} →</button>
          <button className="sync-modal__bulk-btn" onClick={handleFoldResolved} title="Collapse all fully resolved model sections">Fold resolved</button>
          <span className="sync-modal__toolbar-count">
            {resolvedCount} of {allSyncKeys.length} resolved
          </span>
        </div>

        {/* Progress bar */}
        <div className="sync-modal__progress">
          <div
            className={`sync-modal__progress-fill${allDone ? ' sync-modal__progress-fill--done' : ''}`}
            style={{ width: `${progressPct}%` }}
          />
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
                <th className="sync-modal__th sync-modal__th--stage" style={{ color: STAGE_HEX[sourceStage] }}>
                  {sourceName}
                  <span className="sync-modal__th-sub">(current)</span>
                </th>
                <th className="sync-modal__th sync-modal__th--item">Item</th>
                <th className="sync-modal__th sync-modal__th--stage" style={{ color: STAGE_HEX[targetStage] }}>
                  {targetName}
                  <span className="sync-modal__th-sub">(target)</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {models.map((model) => {
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
              {relsWithIssues.length > 0 && (
                <>
                  <tr className="sync-modal__section-header-row">
                    <td colSpan={4} className="sync-modal__section-label">Relationships</td>
                  </tr>
                  {relsWithIssues.map((r) => (
                    <RelationshipRow
                      key={`${r.fromModel}.${r.fromColumn}-${r.toModel}.${r.toColumn}`}
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
        <div className="sync-modal__footer">
          <SyncFooter totalKeys={allSyncKeys.length} />
        </div>
      </div>
    </>
  );
}
