/**
 * AliasEditor — the "Table name" row of the detail panel's metadata.
 *
 * A model's name is its identity; its alias is the table dbt builds it as.
 * Setting one is how two layers can each have a `date` table: the models are
 * `silver_date` and `gold_date`, both with the alias `date`.
 *
 * Read mode shows the table name (the model name, dimmed, when there is no
 * alias). Edit mode is a single input: Enter saves, Escape cancels, and an
 * empty value clears the alias.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { MODEL_ALIAS_MAX_LENGTH, MODEL_ALIAS_RULE, isValidModelAlias } from '@erd-studio/core';
import { useCanvasHost } from '../../host/canvasEnvironment';

interface AliasEditorProps {
  modelName: string;
  alias?: string;
  /** Physical stage and the viewer: show the value, offer no edit. */
  readOnly: boolean;
}

export function AliasEditor({ modelName, alias, readOnly }: AliasEditorProps) {
  const host = useCanvasHost();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(alias ?? '');
  // Enter saves and closes the input, and the input's blur can follow it:
  // one edit must post once, or it costs the user a second undo step.
  const settled = useRef(false);

  // Sync from props when not editing (e.g. a domain refresh from the host).
  useEffect(() => {
    if (!editing) {
      setValue(alias ?? '');
    }
  }, [alias, editing]);

  const trimmed = value.trim();
  const error = trimmed && !isValidModelAlias(trimmed) ? MODEL_ALIAS_RULE : null;

  const handleSave = useCallback(() => {
    if (error || settled.current) return;
    settled.current = true;
    const next = trimmed === modelName ? '' : trimmed;
    // Skip no-op saves to avoid spurious undo entries.
    if (next !== (alias ?? '')) {
      host.postMessage({ type: 'updateModelAlias', payload: { modelName, alias: next } });
    }
    setEditing(false);
  }, [host, modelName, alias, trimmed, error]);

  const handleCancel = useCallback(() => {
    settled.current = true;
    setValue(alias ?? '');
    setEditing(false);
  }, [alias]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleSave();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleCancel();
      }
    },
    [handleSave, handleCancel],
  );

  const startEditing = useCallback(() => {
    settled.current = false;
    setEditing(true);
  }, []);

  if (editing) {
    return (
      <div className="detail-panel__metadata-row detail-panel__metadata-row--alias">
        <span className="detail-panel__label detail-panel__label--wide">Table name</span>
        <span className="detail-panel__alias-edit">
          <input
            className={`detail-panel__alias-input${error ? ' detail-panel__alias-input--error' : ''}`}
            value={value}
            placeholder={modelName}
            maxLength={MODEL_ALIAS_MAX_LENGTH}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={() => (error ? handleCancel() : handleSave())}
            aria-label="Table name (alias)"
            aria-invalid={error ? true : undefined}
            autoFocus
          />
          <span className={`detail-panel__alias-hint${error ? ' detail-panel__alias-hint--error' : ''}`}>
            {error ?? 'The table dbt builds (its alias). Leave blank to use the model name.'}
          </span>
        </span>
      </div>
    );
  }

  return (
    <div className="detail-panel__metadata-row detail-panel__metadata-row--alias">
      <span className="detail-panel__label detail-panel__label--wide">Table name</span>
      <span
        className={`detail-panel__value${alias ? '' : ' detail-panel__value--muted'}`}
        title={alias ? `Built as ${alias} (dbt alias); the model is ${modelName}` : 'Same as the model name'}
        onDoubleClick={readOnly ? undefined : startEditing}
      >
        {alias || modelName}
      </span>
      {!readOnly && (
        <button
          className="detail-panel__rationale-edit-btn detail-panel__alias-edit-btn"
          onClick={startEditing}
          title="Set the table name (alias)"
          aria-label="Edit table name"
        >
          ✎
        </button>
      )}
    </div>
  );
}
