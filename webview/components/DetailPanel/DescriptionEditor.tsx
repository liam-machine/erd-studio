/**
 * DescriptionEditor — displays and edits the description for a model.
 *
 * Three states:
 * 1. Empty — dashed "Add Description" button when no content exists
 * 2. Read — shows description text with pencil edit button on hover
 * 3. Edit — textarea with Save/Cancel buttons
 *
 * Follows the same pattern as GrainEditor.tsx.
 */

import { useCallback, useEffect, useState } from 'react';
import { useVsCodeApi } from '../../hooks/useVsCodeApi';

interface DescriptionEditorProps {
  modelName: string;
  description?: string;
}

export function DescriptionEditor({ modelName, description }: DescriptionEditorProps) {
  const vscode = useVsCodeApi();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(description ?? '');

  // Sync from props when not editing (e.g. domain refresh from extension host)
  useEffect(() => {
    if (!editing) {
      setValue(description ?? '');
    }
  }, [description, editing]);

  const hasContent = !!description;

  const handleSave = useCallback(() => {
    const trimmed = value.trim();
    // Skip no-op saves to avoid spurious undo entries
    if (trimmed === (description ?? '')) {
      setEditing(false);
      return;
    }
    vscode.postMessage({
      type: 'updateModelDescription',
      payload: { modelName, description: trimmed },
    });
    setEditing(false);
  }, [vscode, modelName, value, description]);

  const handleCancel = useCallback(() => {
    setValue(description ?? '');
    setEditing(false);
  }, [description]);

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
      <div className="detail-panel__description-section">
        <button
          className="detail-panel__rationale-add-btn"
          onClick={() => setEditing(true)}
          title="Add model description"
        >
          + Add Description
        </button>
      </div>
    );
  }

  // --- Edit mode ---
  if (editing) {
    return (
      <div className="detail-panel__description-section">
        <div className="detail-panel__rationale-header">
          <h4 className="detail-panel__section-title" style={{ margin: 0 }}>
            Description
          </h4>
        </div>
        <textarea
          className="detail-panel__rationale-textarea"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Describe this model..."
          rows={3}
          autoFocus
        />
        <div className="detail-panel__rationale-actions">
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
    <div className="detail-panel__description-section">
      <div className="detail-panel__rationale-header">
        <h4 className="detail-panel__section-title" style={{ margin: 0 }}>
          Description
        </h4>
        <button
          className="detail-panel__rationale-edit-btn"
          onClick={() => setEditing(true)}
          title="Edit description"
          aria-label="Edit description"
        >
          ✎
        </button>
      </div>
      <div
        className="detail-panel__rationale-field"
        onDoubleClick={() => setEditing(true)}
      >
        <p className="detail-panel__rationale-text">{description}</p>
      </div>
    </div>
  );
}
