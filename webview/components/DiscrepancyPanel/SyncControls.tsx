/**
 * SyncControls — UI components for the sync reconciliation workflow.
 *
 * Three sub-components:
 *   SyncRadio    — inline radio pair (Logical | Physical) for a single discrepancy item
 *   SyncBulkBar  — global "All Logical / All Physical" bulk selection bar
 *   SyncFooter   — sticky "Generate Sync Plan" button at the bottom
 */

import React, { useCallback, useMemo } from 'react';
import { useEditorStore } from '../../store/editorStore';
import { useVsCodeApi } from '../../hooks/useVsCodeApi';
import type { GroundTruth } from '../../../src/types/syncPlan';

// ---------------------------------------------------------------------------
// SyncRadio — inline ground truth selector for one discrepancy item
// ---------------------------------------------------------------------------

interface SyncRadioProps {
  /** Selection key (e.g. "model:dim_customer", "col:dim_customer:email"). */
  selectionKey: string;
}

export const SyncRadio: React.FC<SyncRadioProps> = ({ selectionKey }) => {
  const choice = useEditorStore((s) => s.syncSelections[selectionKey] ?? null);
  const setSyncSelection = useEditorStore((s) => s.setSyncSelection);

  const handleClick = useCallback(
    (gt: GroundTruth) => (e: React.MouseEvent) => {
      e.stopPropagation();
      setSyncSelection(selectionKey, gt);
    },
    [selectionKey, setSyncSelection],
  );

  return (
    <span className="disc-panel__sync-radio" onClick={(e) => e.stopPropagation()}>
      <button
        className={`disc-panel__sync-radio-btn${choice === 'logical' ? ' disc-panel__sync-radio-btn--selected' : ''}`}
        onClick={handleClick('logical')}
        title="Use logical model as ground truth"
      >
        Log
      </button>
      <button
        className={`disc-panel__sync-radio-btn${choice === 'physical' ? ' disc-panel__sync-radio-btn--selected' : ''}`}
        onClick={handleClick('physical')}
        title="Use physical model as ground truth"
      >
        Phys
      </button>
    </span>
  );
};

// ---------------------------------------------------------------------------
// SyncBulkBar — global bulk selection + counter
// ---------------------------------------------------------------------------

interface SyncBulkBarProps {
  /** All discrepancy keys that can be selected. */
  allKeys: string[];
}

export const SyncBulkBar: React.FC<SyncBulkBarProps> = ({ allKeys }) => {
  const syncSelections = useEditorStore((s) => s.syncSelections);
  const setSyncSelectionBulk = useEditorStore((s) => s.setSyncSelectionBulk);

  const selectedCount = useMemo(
    () => allKeys.filter((k) => syncSelections[k]).length,
    [allKeys, syncSelections],
  );

  const handleAll = useCallback(
    (gt: GroundTruth) => () => setSyncSelectionBulk(allKeys, gt),
    [allKeys, setSyncSelectionBulk],
  );

  return (
    <div className="disc-panel__sync-bulk">
      <button className="disc-panel__sync-bulk-btn" onClick={handleAll('logical')}>
        All Logical
      </button>
      <button className="disc-panel__sync-bulk-btn" onClick={handleAll('physical')}>
        All Physical
      </button>
      <span className="disc-panel__sync-bulk-count">
        {selectedCount} of {allKeys.length}
      </span>
    </div>
  );
};

// ---------------------------------------------------------------------------
// SyncFooter — generate sync plan button + status
// ---------------------------------------------------------------------------

interface SyncFooterProps {
  /** Total number of discrepancy keys available. */
  totalKeys: number;
}

export const SyncFooter: React.FC<SyncFooterProps> = ({ totalKeys }) => {
  const syncSelections = useEditorStore((s) => s.syncSelections);
  const syncPlanGenerated = useEditorStore((s) => s.syncPlanGenerated);
  const vscode = useVsCodeApi();

  const selectedCount = useMemo(
    () => Object.keys(syncSelections).length,
    [syncSelections],
  );

  const handleGenerate = useCallback(() => {
    if (selectedCount === 0) return;
    vscode.postMessage({ type: 'generateSyncPlan', payload: { selections: syncSelections } });
  }, [selectedCount, syncSelections, vscode]);

  const handleLaunchClaude = useCallback(() => {
    vscode.postMessage({ type: 'launchClaudeSync' });
  }, [vscode]);

  if (syncPlanGenerated) {
    return (
      <div className="disc-panel__sync-footer disc-panel__sync-footer--done">
        <div className="disc-panel__sync-footer-status">
          <span className="disc-panel__sync-footer-check">✓</span>
          <span>
            Sync plan written ({syncPlanGenerated.totalActions} action{syncPlanGenerated.totalActions !== 1 ? 's' : ''})
          </span>
        </div>
        <button
          className="disc-panel__sync-execute-btn"
          onClick={handleLaunchClaude}
          title="Launch Claude Code to execute the sync plan"
        >
          Execute with Claude
        </button>
      </div>
    );
  }

  return (
    <div className="disc-panel__sync-footer">
      <button
        className="disc-panel__sync-footer-btn"
        disabled={selectedCount === 0}
        onClick={handleGenerate}
      >
        Generate Sync Plan{selectedCount > 0 ? ` (${selectedCount})` : ''}
      </button>
      {totalKeys > 0 && selectedCount === 0 && (
        <span className="disc-panel__sync-footer-hint">
          Select ground truth for items above
        </span>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// StalenessWarning — manifest staleness banner
// ---------------------------------------------------------------------------

export const StalenessWarning: React.FC = () => {
  const manifestStale = useEditorStore((s) => s.manifestStale);
  const vscode = useVsCodeApi();

  const handleCompile = useCallback(() => {
    vscode.postMessage({ type: 'runDbtCompile' });
  }, [vscode]);

  if (!manifestStale) return null;

  return (
    <div className="disc-panel__staleness">
      <span className="disc-panel__staleness-icon">⚠</span>
      <span className="disc-panel__staleness-text">Manifest may be outdated</span>
      <button className="disc-panel__staleness-btn" onClick={handleCompile}>
        Run dbt compile
      </button>
    </div>
  );
};
