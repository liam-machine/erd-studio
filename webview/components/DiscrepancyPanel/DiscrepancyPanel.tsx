/**
 * DiscrepancyPanel — collapsible summary of cross-stage differences.
 *
 * Shows when the discrepancy overlay is active. Displays summary counts
 * and a per-model breakdown. Clicking a model entry navigates to it on
 * the canvas (pan + zoom + select + open detail panel).
 */

import { useCallback, useMemo } from 'react';
import { Panel, useReactFlow } from '@xyflow/react';
import { useEditorStore } from '../../store/editorStore';
import { useVsCodeApi } from '../../hooks/useVsCodeApi';
import type { ModelDiscrepancy, RelationshipDiscrepancy } from '../../../src/types/discrepancy';
import type { WebviewMessage } from '../../hooks/useMessageBus';
import './DiscrepancyPanel.css';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Human-friendly stage name. */
function stageName(stage: string): string {
  return stage.charAt(0).toUpperCase() + stage.slice(1);
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface ModelEntryProps {
  model: ModelDiscrepancy;
  onNavigate: (modelName: string) => void;
}

function ModelEntry({ model, onNavigate }: ModelEntryProps) {
  const issues = model.columns.filter((c) => c.status !== 'matched');
  const hasIssues = issues.length > 0 || model.status !== 'matched';

  if (!hasIssues) return null;

  return (
    <div className="disc-panel__model">
      <button
        className="disc-panel__model-header"
        onClick={() => onNavigate(model.name)}
        title={`Navigate to ${model.name}`}
      >
        <span className={`disc-panel__model-status disc-panel__model-status--${model.status}`} />
        <span className="disc-panel__model-name">{model.name}</span>
        <span className="disc-panel__model-label">{model.status}</span>
      </button>
      {issues.length > 0 && (
        <div className="disc-panel__columns">
          {issues.map((col) => (
            <div key={col.name} className="disc-panel__column">
              <span className={`disc-panel__col-indicator disc-panel__col-indicator--${col.status}`} />
              <span className="disc-panel__col-name">{col.name}</span>
              {col.status === 'type-mismatch' ? (
                <span className="disc-panel__col-detail">
                  {col.sourceDataType} &rarr; {col.targetDataType}
                </span>
              ) : (
                <span className="disc-panel__col-detail">{col.status}</span>
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
  onNavigate: (modelName: string) => void;
}

function RelationshipEntry({ rel, onNavigate }: RelationshipEntryProps) {
  const statusClass = rel.status === 'cardinality-mismatch' ? 'mismatch' : rel.status;
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
        <span className="disc-panel__model-label">
          {rel.status === 'cardinality-mismatch' ? 'mismatch' : rel.status}
        </span>
      </button>
      {rel.status === 'cardinality-mismatch' && rel.sourceCardinality && rel.targetCardinality && (
        <div className="disc-panel__columns">
          <div className="disc-panel__column">
            <span className="disc-panel__col-indicator disc-panel__col-indicator--type-mismatch" />
            <span className="disc-panel__col-detail">
              {rel.sourceCardinality} &rarr; {rel.targetCardinality}
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

  // Guard: render nothing when overlay is inactive (after all hooks)
  if (!discrepancyVisible || !discrepancyReport || !summary) return null;

  const { sourceStage, targetStage } = discrepancyReport;

  const totalIssues = summary.extraModels + summary.missingModels
    + summary.extraColumns + summary.missingColumns + summary.dataTypeMismatches
    + relIssueCount;

  return (
    <Panel position="bottom-right" className="disc-panel">
      <div className="disc-panel__header">
        <span className="disc-panel__title">
          {stageName(sourceStage)} vs {stageName(targetStage)}
        </span>
        {totalIssues === 0 && (
          <span className="disc-panel__all-match">All matched</span>
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
              <span className="disc-panel__stat-label">extra</span>
            </div>
          )}
          {summary.missingModels > 0 && (
            <div className="disc-panel__stat disc-panel__stat--missing">
              <span className="disc-panel__stat-value">{summary.missingModels}</span>
              <span className="disc-panel__stat-label">missing</span>
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
              <ModelEntry key={m.name} model={m} onNavigate={handleNavigate} />
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
                onNavigate={handleNavigate}
              />
            ))}
          </div>
        )}
      </div>
    </Panel>
  );
}
