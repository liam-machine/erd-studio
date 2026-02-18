/**
 * GrainEditor — displays and edits the grain statement for a model.
 *
 * Three states:
 * 1. Empty — dashed "Add Grain" button when no content exists
 * 2. Read — shows grain text with pencil edit button on hover
 * 3. Edit — textarea with Save/Cancel buttons
 *
 * Follows the same pattern as AiRationale.tsx.
 */

import { useCallback, useEffect, useState } from 'react';
import { useVsCodeApi } from '../../hooks/useVsCodeApi';

interface GrainEditorProps {
  modelName: string;
  grain?: string;
}

export function GrainEditor({ modelName, grain }: GrainEditorProps) {
  const vscode = useVsCodeApi();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(grain ?? '');

  // Sync from props when not editing (e.g. domain refresh from extension host)
  useEffect(() => {
    if (!editing) {
      setValue(grain ?? '');
    }
  }, [grain, editing]);

  const hasContent = !!grain;

  const handleSave = useCallback(() => {
    const trimmed = value.trim();
    // Skip no-op saves to avoid spurious undo entries
    if (trimmed === (grain ?? '')) {
      setEditing(false);
      return;
    }
    vscode.postMessage({
      type: 'updateModelGrain',
      payload: { modelName, grain: trimmed },
    });
    setEditing(false);
  }, [vscode, modelName, value, grain]);

  const handleCancel = useCallback(() => {
    setValue(grain ?? '');
    setEditing(false);
  }, [grain]);

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
      <div className="detail-panel__grain-section">
        <button
          className="detail-panel__ai-add-btn"
          onClick={() => setEditing(true)}
          title="Add grain statement (One row per ___)"
        >
          + Add Grain
        </button>
      </div>
    );
  }

  // --- Edit mode ---
  if (editing) {
    return (
      <div className="detail-panel__grain-section">
        <div className="detail-panel__ai-header">
          <h4 className="detail-panel__section-title" style={{ margin: 0 }}>
            Grain
          </h4>
        </div>
        <textarea
          className="detail-panel__ai-textarea"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="One row per ___"
          rows={2}
          autoFocus
        />
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
    <div className="detail-panel__grain-section">
      <div className="detail-panel__ai-header">
        <h4 className="detail-panel__section-title" style={{ margin: 0 }}>
          Grain
        </h4>
        <button
          className="detail-panel__ai-edit-btn"
          onClick={() => setEditing(true)}
          title="Edit grain statement"
          aria-label="Edit grain statement"
        >
          ✎
        </button>
      </div>
      <div
        className="detail-panel__ai-field"
        onDoubleClick={() => setEditing(true)}
      >
        <p className="detail-panel__ai-text">{grain}</p>
      </div>
    </div>
  );
}
