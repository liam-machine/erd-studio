/**
 * StageTabs — stage tab switcher for the toolbar.
 *
 * Renders two tabs ("Logical · your design" / "Physical · read from dbt")
 * with the active tab highlighted.
 * Clicking a tab sends a switchStage message to the extension host.
 *
 * Keyboard shortcuts: Alt+1 = Logical, Alt+2 = Physical
 * (handled in App.tsx keyboard handler).
 */

import { useCallback } from 'react';

import { useVsCodeApi } from '../../hooks/useVsCodeApi';
import { nextStageRequestId } from '../../lib/stageRequest';
import type { Stage } from '../../../src/types/semantic';
import type { WebviewMessage } from '../../hooks/useMessageBus';
import { GUIDE_TARGETS } from '../../../src/types/onboardingGuide';
import './StageTabs.css';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Each tab says what it is, as the wording rules explain the tabs:
 * **Logical** (your design) · **Physical** (read from dbt).
 */
export const STAGE_LABELS: { stage: Stage; label: string; hint: string; shortcut: string; tooltip: string }[] = [
  { stage: 'logical', label: 'Logical', hint: 'your design', shortcut: 'Alt+1', tooltip: 'Your design: the tables, keys and relationships you mean to have' },
  { stage: 'physical', label: 'Physical', hint: 'read from dbt', shortcut: 'Alt+2', tooltip: 'Read from dbt: what your dbt project has. Read-only, never saved' },
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
        payload: { stage, requestId: nextStageRequestId() },
      };
      vscode.postMessage(message);
    },
    [activeStage, vscode],
  );

  return (
    <div className="stage-tabs" role="tablist" aria-label="Design stage" data-guide={GUIDE_TARGETS.canvasStages}>
      {STAGE_LABELS.map(({ stage, label, hint, shortcut, tooltip }) => {
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
            <span className="stage-tabs__hint">{`\u00b7 ${hint}`}</span>
          </button>
        );
      })}
    </div>
  );
}
