/**
 * AiReasoningField — displays and edits a single AI reasoning field.
 *
 * Reusable component for contextual AI reasoning (e.g. grain reasoning below
 * the grain section, classification reasoning below the role section).
 *
 * Three states:
 * 1. Empty — dashed "Add {label}" button when no content exists
 * 2. Read — shows label with text, pencil edit button on hover
 * 3. Edit — textarea with Save/Cancel buttons
 *
 * On save, sends only the single edited field as a partial patch.
 * The extension host merges it into the on-disk ai object, avoiding
 * stale-closure races when multiple fields are edited in quick succession.
 */

import { useCallback, useEffect, useState } from 'react';
import { useVsCodeApi } from '../../hooks/useVsCodeApi';
import type { AiRationale } from '../../../src/types/semantic';

type AiReasoningKey = 'grain' | 'classification' | 'scd' | 'measures';

interface AiReasoningFieldProps {
  modelName: string;
  ai?: AiRationale;
  fieldKey: AiReasoningKey;
  label: string;
  placeholder: string;
}

export function AiReasoningField({ modelName, ai, fieldKey, label, placeholder }: AiReasoningFieldProps) {
  const vscode = useVsCodeApi();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(ai?.[fieldKey] ?? '');

  // Sync from props when not editing
  useEffect(() => {
    if (!editing) {
      setValue(ai?.[fieldKey] ?? '');
    }
  }, [ai?.[fieldKey], editing, fieldKey]);

  const hasContent = !!ai?.[fieldKey];

  const handleSave = useCallback(() => {
    const trimmed = value.trim();
    // Skip no-op saves
    if (trimmed === (ai?.[fieldKey]?.trim() ?? '')) {
      setEditing(false);
      return;
    }
    // Send only this field as a partial patch — extension host merges on disk
    vscode.postMessage({
      type: 'updateModelAi',
      payload: {
        modelName,
        ai: { [fieldKey]: trimmed || undefined },
      },
    });
    setEditing(false);
  }, [vscode, modelName, ai?.[fieldKey], fieldKey, value]);

  const handleCancel = useCallback(() => {
    setValue(ai?.[fieldKey] ?? '');
    setEditing(false);
  }, [ai, fieldKey]);

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
          title={`Add ${label.toLowerCase()}`}
        >
          + Add {label}
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
            {label}
          </h4>
        </div>
        <textarea
          className="detail-panel__ai-textarea"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
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
    <div className="detail-panel__ai-section">
      <div className="detail-panel__ai-header">
        <h4 className="detail-panel__section-title" style={{ margin: 0 }}>
          {label}
        </h4>
        <button
          className="detail-panel__ai-edit-btn"
          onClick={() => setEditing(true)}
          title={`Edit ${label.toLowerCase()}`}
          aria-label={`Edit ${label.toLowerCase()}`}
        >
          ✎
        </button>
      </div>
      <div
        className="detail-panel__ai-field"
        onDoubleClick={() => setEditing(true)}
      >
        <p className="detail-panel__ai-text">{ai?.[fieldKey]}</p>
      </div>
    </div>
  );
}
