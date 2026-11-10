/**
 * DragHint — a one-time tip that teaches drag-to-relate.
 *
 * Pressing and holding a column (~220 ms, the renderer's useLongPressDrag)
 * and dropping it on another table's column opens the New Relationship
 * dialog prefilled, but nothing on the canvas says so. This tip appears on a
 * logical, editable diagram with two or more tables and no relationships yet
 * — the moment the gesture is useful — and goes away for good once closed.
 *
 * The dismissal lives in the webview's own state (vscode.setState, written
 * by useStatePersistence); nothing is posted to the host. The persisted
 * state is also read here on mount, so a closed tip does not flash for the
 * frame before useStatePersistence restores it into the store.
 *
 * Never on the physical stage or a read-only diagram, and out of the way
 * while the New Relationship dialog is open.
 */

import React, { useState } from 'react';
import { Panel } from '@xyflow/react';

import { useVsCodeApi } from '../../hooks/useVsCodeApi';
import type { PersistedState } from '../../hooks/useStatePersistence';
import { useEditorStore } from '../../store/editorStore';
import './DragHint.css';

export const DRAG_HINT_TEXT = 'Tip: press and hold a column, then drag it onto a column of another table to relate them.';

export const DragHint: React.FC = () => {
  const domain = useEditorStore((s) => s.domain);
  const dismissed = useEditorStore((s) => s.dragHintDismissed);
  const setDismissed = useEditorStore((s) => s.setDragHintDismissed);
  const fkDialogOpen = useEditorStore((s) => s.newFkDialogOpen);
  const vscode = useVsCodeApi();
  const [dismissedBefore] = useState(() => {
    try {
      return (vscode.getState() as PersistedState | null | undefined)?.dragHintDismissed === true;
    } catch {
      return false;
    }
  });

  if (dismissed || dismissedBefore || fkDialogOpen) { return null; }
  if (!domain || domain.stage !== 'logical' || domain.readOnly) { return null; }
  if (domain.models.length < 2 || domain.relationships.length > 0) { return null; }

  return (
    <Panel position="bottom-center" className="drag-hint">
      <div className="drag-hint__body" role="status">
        <span className="drag-hint__text">{DRAG_HINT_TEXT}</span>
        <button
          type="button"
          className="drag-hint__dismiss"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss tip"
          title="Dismiss tip"
        >
          &times;
        </button>
      </div>
    </Panel>
  );
};
