/**
 * DescriptionEditor — displays and edits the description for a model.
 *
 * Three states:
 * 1. Empty — a quiet "Add a description" row when no content exists
 * 2. Read — the text in an inset card; its pencil shows on hover or focus
 * 3. Edit — textarea with Cancel / Save (Escape cancels, Cmd/Ctrl+Enter saves)
 *
 * Follows the same add / read / edit pattern as the text fields in FieldsSection.tsx.
 */

import { useCallback, useEffect, useState } from 'react';
import { useCanvasHost } from '../../host/canvasEnvironment';
import { IconPencil, IconPlus } from './panelIcons';

interface DescriptionEditorProps {
  modelName: string;
  description?: string;
}

export function DescriptionEditor({ modelName, description }: DescriptionEditorProps) {
  const host = useCanvasHost();
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
    host.postMessage({
      type: 'updateModelDescription',
      payload: { modelName, description: trimmed },
    });
    setEditing(false);
  }, [host, modelName, value, description]);

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
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        handleSave();
      }
    },
    [handleCancel, handleSave],
  );

  // --- Empty state ---
  if (!hasContent && !editing) {
    return (
      <div className="detail-panel__description-section">
        <button
          className="detail-panel__rationale-add-btn detail-panel__description-add"
          onClick={() => setEditing(true)}
          title="Add table description"
        >
          <IconPlus size={12} />
          Add a description
        </button>
      </div>
    );
  }

  // --- Edit mode ---
  if (editing) {
    return (
      <div className="detail-panel__description-section">
        <div className="detail-panel__rationale-header">
          <h4 className="detail-panel__section-title">
            Description
          </h4>
        </div>
        <textarea
          className="detail-panel__rationale-textarea"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Describe this table..."
          aria-label="Table description"
          rows={3}
          autoFocus
        />
        <div className="detail-panel__rationale-actions">
          <button className="detail-panel__button" onClick={handleCancel}>
            Cancel
          </button>
          <button className="detail-panel__button detail-panel__button--primary" onClick={handleSave}>
            Save
          </button>
        </div>
      </div>
    );
  }

  // --- Read mode ---
  return (
    <div className="detail-panel__description-section">
      <div className="detail-panel__rationale-header">
        <h4 className="detail-panel__section-title">
          Description
        </h4>
        <button
          className="detail-panel__rationale-edit-btn"
          onClick={() => setEditing(true)}
          title="Edit description"
          aria-label="Edit description"
        >
          <IconPencil size={12} />
        </button>
      </div>
      <div
        className="detail-panel__rationale-field detail-panel__description-card"
        onDoubleClick={() => setEditing(true)}
        title="Double-click to edit"
      >
        <p className="detail-panel__rationale-text">{description}</p>
      </div>
    </div>
  );
}
