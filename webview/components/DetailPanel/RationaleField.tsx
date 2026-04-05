/**
 * RationaleField — displays and edits a single design rationale field.
 *
 * Reusable component for contextual reasoning (e.g. grain reasoning below
 * the grain section, classification reasoning below the role section).
 *
 * Three states:
 * 1. Empty — dashed "Add {label}" button when no content exists
 * 2. Read — shows label with text, pencil edit button on hover
 * 3. Edit — textarea with Save/Cancel buttons
 *
 * On save, sends only the single edited field as a partial patch.
 * The extension host merges it into the on-disk rationale object, avoiding
 * stale-closure races when multiple fields are edited in quick succession.
 */

import { useCallback, useEffect, useState } from 'react';
import { useVsCodeApi } from '../../hooks/useVsCodeApi';
import type { Rationale } from '../../../src/types/semantic';

type RationaleKey = 'purpose' | 'design' | 'grainChoice' | 'roleChoice' | 'scdStrategy' | 'measures';

interface RationaleFieldProps {
  modelName: string;
  rationale?: Rationale;
  fieldKey: RationaleKey;
  label: string;
  placeholder: string;
  /** When true, opens in edit mode immediately (used when parent triggers "Add Rationale"). */
  autoEdit?: boolean;
}

export function RationaleField({ modelName, rationale, fieldKey, label, placeholder, autoEdit }: RationaleFieldProps) {
  const vscode = useVsCodeApi();
  const [editing, setEditing] = useState(autoEdit === true);
  const [value, setValue] = useState(rationale?.[fieldKey] ?? '');

  // Sync from props when not editing
  useEffect(() => {
    if (!editing) {
      setValue(rationale?.[fieldKey] ?? '');
    }
  }, [rationale?.[fieldKey], editing, fieldKey]);

  const hasContent = !!rationale?.[fieldKey];

  const handleSave = useCallback(() => {
    const trimmed = value.trim();
    // Skip no-op saves
    if (trimmed === (rationale?.[fieldKey]?.trim() ?? '')) {
      setEditing(false);
      return;
    }
    // Send only this field as a partial patch — extension host merges on disk
    vscode.postMessage({
      type: 'updateModelRationale',
      payload: {
        modelName,
        rationale: { [fieldKey]: trimmed || undefined },
      },
    });
    setEditing(false);
  }, [vscode, modelName, rationale?.[fieldKey], fieldKey, value]);

  const handleCancel = useCallback(() => {
    setValue(rationale?.[fieldKey] ?? '');
    setEditing(false);
  }, [rationale, fieldKey]);

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
      <div className="detail-panel__rationale-section">
        <button
          className="detail-panel__rationale-add-btn"
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
      <div className="detail-panel__rationale-section" onKeyDown={handleKeyDown}>
        <div className="detail-panel__rationale-header">
          <h4 className="detail-panel__section-title" style={{ margin: 0 }}>
            {label}
          </h4>
        </div>
        <textarea
          className="detail-panel__rationale-textarea"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          rows={2}
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
    <div className="detail-panel__rationale-section">
      <div className="detail-panel__rationale-header">
        <h4 className="detail-panel__section-title" style={{ margin: 0 }}>
          {label}
        </h4>
        <button
          className="detail-panel__rationale-edit-btn"
          onClick={() => setEditing(true)}
          title={`Edit ${label.toLowerCase()}`}
          aria-label={`Edit ${label.toLowerCase()}`}
        >
          ✎
        </button>
      </div>
      <div
        className="detail-panel__rationale-field"
        onDoubleClick={() => setEditing(true)}
      >
        <p className="detail-panel__rationale-text">{rationale?.[fieldKey]}</p>
      </div>
    </div>
  );
}
