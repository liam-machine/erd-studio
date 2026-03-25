/**
 * DiscrepancyPanel — collapsible summary of cross-stage differences.
 *
 * Shows when the discrepancy overlay is active. Displays summary counts
 * and a per-model breakdown. Clicking a model entry navigates to it on
 * the canvas (pan + zoom + select + open detail panel).
 *
 * Uses stage-anchored labeling: instead of "extra" / "missing", the panel
 * says "Only in Logical" / "Only in Physical" (or vice versa) so users
 * always know which stage each item belongs to.
 *
 * Sync mode: adds ground truth radio buttons per discrepancy, bulk selection,
 * and a "Generate Sync Plan" footer.
 */

import { useCallback, useMemo } from 'react';
import { Panel, useReactFlow } from '@xyflow/react';
import { useEditorStore } from '../../store/editorStore';
import { useVsCodeApi } from '../../hooks/useVsCodeApi';
import { STAGE_HEX } from '../../lib/stageColors';
import { SyncRadio, SyncBulkBar, SyncFooter, StalenessWarning } from './SyncControls';
import {
  modelKey,
  columnKey,
  relationshipKey,
} from '../../../src/types/syncPlan';
import type { ModelDiscrepancy, RelationshipDiscrepancy } from '../../../src/types/discrepancy';
import type { WebviewMessage } from '../../hooks/useMessageBus';
import './DiscrepancyPanel.css';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Human-friendly stage name (capitalised). */
function stageName(stage: string): string {
  return stage.charAt(0).toUpperCase() + stage.slice(1);
}

/**
 * Map a discrepancy status to a user-friendly, stage-anchored label.
 *
 * "extra" → "Only in {source}" (exists in current stage, not in comparison)
 * "missing" → "Only in {target}" (exists in comparison, not in current)
 */
function statusLabel(status: string, sourceStage: string, targetStage: string): string {
  switch (status) {
    case 'extra': return `Only in ${stageName(sourceStage)}`;
    case 'missing': return `Only in ${stageName(targetStage)}`;
    case 'type-mismatch': return 'type mismatch';
    case 'cardinality-mismatch': return 'cardinality mismatch';
    default: return status;
  }
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface ModelEntryProps {
  model: ModelDiscrepancy;
  sourceStage: string;
  targetStage: string;
  onNavigate: (modelName: string) => void;
  syncMode: boolean;
}

function ModelEntry({ model, sourceStage, targetStage, onNavigate, syncMode }: ModelEntryProps) {
  const issues = model.columns.filter((c) => c.status !== 'matched');
  const hasIssues = issues.length > 0 || model.status !== 'matched';

  if (!hasIssues) return null;

  const modelStatusLabel = statusLabel(model.status, sourceStage, targetStage);

  return (
    <div className="disc-panel__model">
      <button
        className="disc-panel__model-header"
        onClick={() => onNavigate(model.name)}
        title={`Navigate to ${model.name}`}
      >
        <span className={`disc-panel__model-status disc-panel__model-status--${model.status}`} />
        <span className="disc-panel__model-name">{model.name}</span>
        {syncMode && model.status !== 'matched' && (
          <SyncRadio selectionKey={modelKey(model.name)} />
        )}
        <span className="disc-panel__model-label">{modelStatusLabel}</span>
      </button>
      {issues.length > 0 && (
        <div className="disc-panel__columns">
          {issues.map((col) => (
            <div key={col.name} className="disc-panel__column">
              <span className={`disc-panel__col-indicator disc-panel__col-indicator--${col.status}`} />
              <span className="disc-panel__col-name">{col.name}</span>
              {syncMode && (
                <SyncRadio selectionKey={columnKey(model.name, col.name)} />
              )}
              {col.status === 'type-mismatch' ? (
                <span className="disc-panel__col-detail disc-panel__col-detail--mismatch">
                  <span className="disc-panel__col-stage-type" style={{ color: STAGE_HEX[sourceStage] ?? 'inherit' }}>
                    {stageName(sourceStage).toLowerCase()}: {col.sourceDataType}
                  </span>
                  <span className="disc-panel__col-stage-type" style={{ color: STAGE_HEX[targetStage] ?? 'inherit' }}>
                    {stageName(targetStage).toLowerCase()}: {col.targetDataType}
                  </span>
                </span>
              ) : (
                <span className="disc-panel__col-detail">
                  {statusLabel(col.status, sourceStage, targetStage)}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface RelationshipEntryProps {
  rel: RelationshipDiscrepancy;
  sourceStage: string;
  targetStage: string;
  onNavigate: (modelName: string) => void;
  syncMode: boolean;
}

function RelationshipEntry({ rel, sourceStage, targetStage, onNavigate, syncMode }: RelationshipEntryProps) {
  const statusClass = rel.status === 'cardinality-mismatch' ? 'mismatch' : rel.status;
  const relStatusLabel = statusLabel(rel.status, sourceStage, targetStage);

  return (
    <div className="disc-panel__model">
      <button
        className="disc-panel__model-header"
        onClick={() => onNavigate(rel.fromModel)}
        title={`Navigate to ${rel.fromModel}`}
      >
        <span className={`disc-panel__model-status disc-panel__model-status--${statusClass}`} />
        <span className="disc-panel__model-name">
          {rel.fromModel}.{rel.fromColumn} &rarr; {rel.toModel}.{rel.toColumn}
        </span>
        {syncMode && (
          <SyncRadio
            selectionKey={relationshipKey(rel.fromModel, rel.fromColumn, rel.toModel, rel.toColumn)}
          />
        )}
        <span className="disc-panel__model-label">{relStatusLabel}</span>
      </button>
      {rel.status === 'cardinality-mismatch' && rel.sourceCardinality && rel.targetCardinality && (
        <div className="disc-panel__columns">
          <div className="disc-panel__column">
            <span className="disc-panel__col-indicator disc-panel__col-indicator--type-mismatch" />
            <span className="disc-panel__col-detail disc-panel__col-detail--mismatch">
              <span className="disc-panel__col-stage-type" style={{ color: STAGE_HEX[sourceStage] ?? 'inherit' }}>
                {stageName(sourceStage).toLowerCase()}: {rel.sourceCardinality}
              </span>
              <span className="disc-panel__col-stage-type" style={{ color: STAGE_HEX[targetStage] ?? 'inherit' }}>
                {stageName(targetStage).toLowerCase()}: {rel.targetCardinality}
              </span>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function DiscrepancyPanel() {
  const discrepancyVisible = useEditorStore((s) => s.discrepancyVisible);
  const discrepancyReport = useEditorStore((s) => s.discrepancyReport);
  const selectNode = useEditorStore((s) => s.selectNode);
  const setDetailPanelOpen = useEditorStore((s) => s.setDetailPanelOpen);
  const setDiscrepancyVisible = useEditorStore((s) => s.setDiscrepancyVisible);
  const setDiscrepancyCompareStage = useEditorStore((s) => s.setDiscrepancyCompareStage);
  const setDiscrepancyReport = useEditorStore((s) => s.setDiscrepancyReport);
  const syncMode = useEditorStore((s) => s.syncMode);
  const setSyncMode = useEditorStore((s) => s.setSyncMode);
  const { fitView } = useReactFlow();
  const vscode = useVsCodeApi();

  // Derive data from report (safe even when null — hooks stay above the guard)
  const models = discrepancyReport?.models ?? [];
  const relationships = discrepancyReport?.relationships ?? [];
  const summary = discrepancyReport?.summary;

  const modelsWithIssues = useMemo(
    () => models.filter((m) => m.status !== 'matched' || m.columns.some((c) => c.status !== 'matched')),
    [models],
  );

  const relsWithIssues = useMemo(
    () => relationships.filter((r) => r.status !== 'matched'),
    [relationships],
  );

  const relIssueCount = relsWithIssues.length;

  // Build all selectable keys for sync mode
  const allSyncKeys = useMemo(() => {
    const keys: string[] = [];
    for (const m of modelsWithIssues) {
      if (m.status !== 'matched') {
        keys.push(modelKey(m.name));
      }
      for (const c of m.columns) {
        if (c.status !== 'matched') {
          keys.push(columnKey(m.name, c.name));
        }
      }
    }
    for (const r of relsWithIssues) {
      keys.push(relationshipKey(r.fromModel, r.fromColumn, r.toModel, r.toColumn));
    }
    return keys;
  }, [modelsWithIssues, relsWithIssues]);

  const handleNavigate = useCallback(
    (modelName: string) => {
      selectNode(modelName);
      setDetailPanelOpen(true);
      fitView({ nodes: [{ id: modelName }], duration: 300, padding: 0.3 });
    },
    [selectNode, setDetailPanelOpen, fitView],
  );

  const handleClose = useCallback(() => {
    setDiscrepancyVisible(false);
    setDiscrepancyCompareStage(null);
    setDiscrepancyReport(null);
    const message: WebviewMessage = {
      type: 'toggleDiscrepancy',
      payload: { enabled: false },
    };
    vscode.postMessage(message);
  }, [setDiscrepancyVisible, setDiscrepancyCompareStage, setDiscrepancyReport, vscode]);

  const handleToggleSyncMode = useCallback(() => {
    setSyncMode(!syncMode);
  }, [syncMode, setSyncMode]);

  // Guard: render nothing when overlay is inactive (after all hooks)
  if (!discrepancyVisible || !discrepancyReport || !summary) return null;

  const { sourceStage, targetStage } = discrepancyReport;

  const totalIssues = summary.extraModels + summary.missingModels
    + summary.extraColumns + summary.missingColumns + summary.dataTypeMismatches
    + relIssueCount;

  return (
    <Panel position="bottom-right" className={`disc-panel${syncMode ? ' disc-panel--sync-mode' : ''}`}>
      <div className="disc-panel__header">
        <span className="disc-panel__title">
          <span className="disc-panel__stage-label" style={{ color: STAGE_HEX[sourceStage] ?? 'inherit' }}>
            {stageName(sourceStage)}
          </span>
          <span className="disc-panel__stage-annotation">(current)</span>
          <span className="disc-panel__stage-vs">vs</span>
          <span className="disc-panel__stage-label" style={{ color: STAGE_HEX[targetStage] ?? 'inherit' }}>
            {stageName(targetStage)}
          </span>
          <span className="disc-panel__stage-annotation">(target)</span>
        </span>
        {totalIssues === 0 && (
          <span className="disc-panel__all-match">All matched</span>
        )}
        {totalIssues > 0 && (
          <button
            className={`disc-panel__sync-toggle${syncMode ? ' disc-panel__sync-toggle--active' : ''}`}
            onClick={handleToggleSyncMode}
            title={syncMode ? 'Exit sync mode' : 'Enter sync mode to reconcile differences'}
          >
            {syncMode ? '⊘ Sync' : '⊕ Sync'}
          </button>
        )}
        <button
          className="disc-panel__close"
          onClick={handleClose}
          title="Close comparison"
          aria-label="Close comparison"
        >
          &times;
        </button>
      </div>

      {/* Staleness warning */}
      <StalenessWarning />

      {/* Sync bulk bar */}
      {syncMode && allSyncKeys.length > 0 && (
        <SyncBulkBar allKeys={allSyncKeys} />
      )}

      <div className="disc-panel__content">
        {/* Summary counts */}
        <div className="disc-panel__summary">
          <div className="disc-panel__stat">
            <span className="disc-panel__stat-value">{summary.matchedModels}</span>
            <span className="disc-panel__stat-label">matched</span>
          </div>
          {summary.extraModels > 0 && (
            <div className="disc-panel__stat disc-panel__stat--extra">
              <span className="disc-panel__stat-value">{summary.extraModels}</span>
              <span className="disc-panel__stat-label">{stageName(sourceStage)} only</span>
            </div>
          )}
          {summary.missingModels > 0 && (
            <div className="disc-panel__stat disc-panel__stat--missing">
              <span className="disc-panel__stat-value">{summary.missingModels}</span>
              <span className="disc-panel__stat-label">{stageName(targetStage)} only</span>
            </div>
          )}
          {summary.dataTypeMismatches > 0 && (
            <div className="disc-panel__stat disc-panel__stat--mismatch">
              <span className="disc-panel__stat-value">{summary.dataTypeMismatches}</span>
              <span className="disc-panel__stat-label">type diff{summary.dataTypeMismatches !== 1 ? 's' : ''}</span>
            </div>
          )}
          {(summary.extraColumns > 0 || summary.missingColumns > 0) && (
            <div className="disc-panel__stat disc-panel__stat--cols">
              <span className="disc-panel__stat-value">
                {summary.extraColumns + summary.missingColumns}
              </span>
              <span className="disc-panel__stat-label">col diff{(summary.extraColumns + summary.missingColumns) !== 1 ? 's' : ''}</span>
            </div>
          )}
          {relIssueCount > 0 && (
            <div className="disc-panel__stat disc-panel__stat--mismatch">
              <span className="disc-panel__stat-value">{relIssueCount}</span>
              <span className="disc-panel__stat-label">rel diff{relIssueCount !== 1 ? 's' : ''}</span>
            </div>
          )}
        </div>

        {/* Per-model breakdown */}
        {modelsWithIssues.length > 0 && (
          <div className="disc-panel__models">
            {modelsWithIssues.map((m) => (
              <ModelEntry
                key={m.name}
                model={m}
                sourceStage={sourceStage}
                targetStage={targetStage}
                onNavigate={handleNavigate}
                syncMode={syncMode}
              />
            ))}
          </div>
        )}

        {/* Relationship issues */}
        {relsWithIssues.length > 0 && (
          <div className="disc-panel__models">
            <div className="disc-panel__section-label">Relationships</div>
            {relsWithIssues.map((r) => (
              <RelationshipEntry
                key={`${r.fromModel}.${r.fromColumn}-${r.toModel}.${r.toColumn}`}
                rel={r}
                sourceStage={sourceStage}
                targetStage={targetStage}
                onNavigate={handleNavigate}
                syncMode={syncMode}
              />
            ))}
          </div>
        )}
      </div>

      {/* Sync footer */}
      {syncMode && <SyncFooter totalKeys={allSyncKeys.length} />}
    </Panel>
  );
}
