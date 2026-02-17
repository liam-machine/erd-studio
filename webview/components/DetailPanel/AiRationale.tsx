/**
 * AiRationale — displays and edits AI-generated what/why metadata for a model.
 *
 * Three states:
 * 1. Empty — dashed "Add Rationale" button when no content exists
 * 2. Read — shows WHAT and WHY labels with text, pencil edit button on hover
 * 3. Edit — two textareas with Save/Cancel buttons
 */

import { useCallback, useEffect, useState } from 'react';
import { useVsCodeApi } from '../../hooks/useVsCodeApi';
import type { AiRationale as AiRationaleType } from '../../../src/types/semantic';

interface AiRationaleProps {
  modelName: string;
  ai?: AiRationaleType;
}

export function AiRationale({ modelName, ai }: AiRationaleProps) {
  const vscode = useVsCodeApi();
  const [editing, setEditing] = useState(false);
  const [what, setWhat] = useState(ai?.what ?? '');
  const [why, setWhy] = useState(ai?.why ?? '');

  // Sync from props when not editing (e.g. domain refresh from extension host)
  useEffect(() => {
    if (!editing) {
      setWhat(ai?.what ?? '');
      setWhy(ai?.why ?? '');
    }
  }, [ai?.what, ai?.why, editing]);

  const hasContent = !!(ai?.what || ai?.why);

  const handleSave = useCallback(() => {
    vscode.postMessage({
      type: 'updateModelAi',
      payload: { modelName, ai: { what: what.trim() || undefined, why: why.trim() || undefined } },
    });
    setEditing(false);
  }, [vscode, modelName, what, why]);

  const handleCancel = useCallback(() => {
    setWhat(ai?.what ?? '');
    setWhy(ai?.why ?? '');
    setEditing(false);
  }, [ai?.what, ai?.why]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleCancel();
      }
    },
    [handleCancel],
  );

  // --- Empty state ---
  if (!hasContent && !editing) {
    return (
      <div className="detail-panel__ai-section">
        <button
          className="detail-panel__ai-add-btn"
          onClick={() => setEditing(true)}
          title="Add AI rationale (what/why)"
        >
          + Add Rationale
        </button>
      </div>
    );
  }

  // --- Edit mode ---
  if (editing) {
    return (
      <div className="detail-panel__ai-section" onKeyDown={handleKeyDown}>
        <div className="detail-panel__ai-header">
          <h4 className="detail-panel__section-title" style={{ margin: 0 }}>
            AI Rationale
          </h4>
        </div>
        <div className="detail-panel__ai-field">
          <span className="detail-panel__ai-label">WHAT</span>
          <textarea
            className="detail-panel__ai-textarea"
            value={what}
            onChange={(e) => setWhat(e.target.value)}
            placeholder="What requirements does this model meet?"
            rows={2}
            autoFocus
          />
        </div>
        <div className="detail-panel__ai-field">
          <span className="detail-panel__ai-label">WHY</span>
          <textarea
            className="detail-panel__ai-textarea"
            value={why}
            onChange={(e) => setWhy(e.target.value)}
            placeholder="Why was this model designed this way?"
            rows={2}
          />
        </div>
        <div className="detail-panel__ai-actions">
          <button className="detail-panel__button" onClick={handleSave}>
            Save
          </button>
          <button className="detail-panel__button" onClick={handleCancel}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // --- Read mode ---
  return (
    <div className="detail-panel__ai-section">
      <div className="detail-panel__ai-header">
        <h4 className="detail-panel__section-title" style={{ margin: 0 }}>
          AI Rationale
        </h4>
        <button
          className="detail-panel__ai-edit-btn"
          onClick={() => setEditing(true)}
          title="Edit rationale"
          aria-label="Edit AI rationale"
        >
          ✎
        </button>
      </div>
      {ai?.what && (
        <div
          className="detail-panel__ai-field"
          onDoubleClick={() => setEditing(true)}
        >
          <span className="detail-panel__ai-label">WHAT</span>
          <p className="detail-panel__ai-text">{ai.what}</p>
        </div>
      )}
      {ai?.why && (
        <div
          className="detail-panel__ai-field"
          onDoubleClick={() => setEditing(true)}
        >
          <span className="detail-panel__ai-label">WHY</span>
          <p className="detail-panel__ai-text">{ai.why}</p>
        </div>
      )}
    </div>
  );
}
