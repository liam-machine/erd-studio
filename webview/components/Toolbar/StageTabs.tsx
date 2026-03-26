/**
 * StageTabs — stage tab switcher for the toolbar.
 *
 * Renders two tabs (Logical / Physical) with the active tab highlighted.
 * Clicking a tab sends a switchStage message to the extension host.
 *
 * Keyboard shortcuts: Alt+1 = Logical, Alt+2 = Physical
 * (handled in App.tsx keyboard handler).
 */

import { useCallback } from 'react';

import { useVsCodeApi } from '../../hooks/useVsCodeApi';
import type { Stage } from '../../../src/types/semantic';
import type { WebviewMessage } from '../../hooks/useMessageBus';
import './StageTabs.css';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STAGE_LABELS: { stage: Stage; label: string; shortcut: string; tooltip: string }[] = [
  { stage: 'logical', label: 'Logical', shortcut: 'Alt+1', tooltip: 'Your design blueprint \u2014 the ideal data model' },
  { stage: 'physical', label: 'Physical', shortcut: 'Alt+2', tooltip: "What's declared in your dbt .yml schema files \u2014 read-only" },
];

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface StageTabsProps {
  activeStage: Stage;
  readOnly: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function StageTabs({ activeStage, readOnly }: StageTabsProps) {
  const vscode = useVsCodeApi();

  const handleTabClick = useCallback(
    (stage: Stage) => {
      if (stage === activeStage) return;
      const message: WebviewMessage = {
        type: 'switchStage',
        payload: { stage },
      };
      vscode.postMessage(message);
    },
    [activeStage, vscode],
  );

  return (
    <div className="stage-tabs" role="tablist" aria-label="Design stage">
      {STAGE_LABELS.map(({ stage, label, shortcut, tooltip }) => {
        const isActive = stage === activeStage;
        const showLock = isActive && readOnly;
        return (
          <button
            key={stage}
            className={`stage-tabs__tab${isActive ? ' stage-tabs__tab--active' : ''}${showLock ? ' stage-tabs__tab--readonly' : ''}`}
            onClick={() => handleTabClick(stage)}
            role="tab"
            aria-selected={isActive}
            title={`${tooltip} (${shortcut})`}
          >
            {showLock && <span className="stage-tabs__lock" aria-hidden="true">🔒</span>}
            {label}
          </button>
        );
      })}
    </div>
  );
}
